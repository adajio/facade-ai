import type { Readable } from "node:stream";
import { archiveBytes, ConverterPortError } from "../converter-port/index.js";
import { ImportIssue, importLimits } from "./policy.js";

export type ArchiveFrame =
  | { type: "entry"; kind: "file" | "directory" | "special"; path: string }
  | { type: "data"; bytes: Buffer }
  | { type: "end" | "done"; result: string };

const results = new Set([
  "ok", "archive_encrypted", "archive_corrupt", "archive_empty", "archive_entry_limit",
  "archive_special_entry", "invalid_source_path", "archive_expanded_limit", "archive_io_error",
]);
const kinds = new Set(["file", "directory", "special"] as const);
const pathDecoder = new TextDecoder("utf-8", { fatal: true });

export async function* readArchiveFrames(stream: AsyncIterable<Buffer>): AsyncGenerator<ArchiveFrame> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let dataSize = 0;
  let insideEntry = false;
  let done = false;

  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length) {
      if (done) throw new ImportIssue("archive_protocol_error");
      if (dataSize) {
        if (buffer.length < dataSize) break;
        yield { type: "data", bytes: buffer.subarray(0, dataSize) };
        buffer = buffer.subarray(dataSize);
        dataSize = 0;
        continue;
      }
      const separator = buffer.indexOf(10);
      if (separator > 8224 || (separator === -1 && buffer.length > 8224)) {
        throw new ImportIssue("archive_protocol_error");
      }
      if (separator === -1) break;
      const [tag, arg, path, ...rest] = buffer.subarray(0, separator).toString("ascii").split(" ");
      buffer = buffer.subarray(separator + 1);
      if (rest.length || arg === undefined) throw new ImportIssue("archive_protocol_error");

      if (tag === "entry" && !insideEntry && path !== undefined && /^(?:[0-9a-f]{2})*$/.test(path)) {
        const kind = arg as "file" | "directory" | "special";
        if (!kinds.has(kind)) throw new ImportIssue("archive_protocol_error");
        let decoded = "";
        try { decoded = pathDecoder.decode(Buffer.from(path, "hex")); }
        catch { /* A non-UTF-8 name becomes an explicitly rejected inventory entry. */ }
        insideEntry = true;
        yield { type: "entry", path: decoded, kind };
      } else if (tag === "data" && insideEntry && path === undefined && /^[1-9][0-9]{0,4}$/.test(arg) && Number(arg) <= 65_536) {
        dataSize = Number(arg);
      } else if (path === undefined && results.has(arg) &&
        ((tag === "end" && insideEntry) || (tag === "done" && !insideEntry))) {
        insideEntry = false;
        done = tag === "done";
        yield { type: tag, result: arg };
      } else {
        throw new ImportIssue("archive_protocol_error");
      }
    }
  }
  if (!done || buffer.length || dataSize) throw new ImportIssue("archive_incomplete");
}

export async function* extractArchive(
  source: { stream: Readable; size: number },
  signal: AbortSignal,
  { bytes = importLimits.expandedBytes, entries = importLimits.archiveEntries } = {},
): AsyncGenerator<ArchiveFrame> {
  let reported: ArchiveFrame | undefined;
  try {
    const output = archiveBytes(source.stream, { size: source.size, bytes, entries, signal });
    for await (const frame of readArchiveFrames(output)) {
      signal.throwIfAborted();
      if (frame.type === "done") reported = frame;
      else yield frame;
    }
    // The broker confirms completion after the final frame and may still report an error.
    if (!reported) throw new ImportIssue("archive_incomplete");
    yield reported;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (!(error instanceof ConverterPortError)) throw error;
    switch (error.code) {
      case "busy": throw new ImportIssue("archive_busy", true);
      case "unavailable": throw new ImportIssue("archive_isolation_unavailable", true);
      case "scratch_unavailable": throw new ImportIssue("import_disk_reserve", true);
      case "timeout": throw new ImportIssue("archive_timeout");
      case "memory_limit": throw new ImportIssue("archive_memory_limit");
      case "resource_limit": throw new ImportIssue("archive_resource_limit");
      case "invalid_request": throw new ImportIssue("archive_protocol_error");
      default: throw new ImportIssue("archive_incomplete");
    }
  }
}
