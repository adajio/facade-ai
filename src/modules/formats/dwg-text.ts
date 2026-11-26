import type { FileHandle } from "node:fs/promises";
import { FormatHold } from "./model.js";

async function* readChunks(file: FileHandle): AsyncGenerator<Buffer> {
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) return;
    yield buffer.subarray(0, bytesRead);
    offset += bytesRead;
  }
}

export async function* derivativeText(file: FileHandle): AsyncGenerator<string> {
  function validate(text: string): string {
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/u.test(text)) throw new FormatHold("text_encoding_unconfirmed");
    return text;
  }
  function decode(decoder: TextDecoder, bytes?: Buffer): string {
    try {
      return validate(decoder.decode(bytes, { stream: bytes !== undefined }));
    } catch {
      throw new FormatHold("text_encoding_unconfirmed");
    }
  }
  let decoder: TextDecoder | undefined;
  for await (const chunk of readChunks(file)) {
    decoder ??= new TextDecoder(chunk[0] === 0xff && chunk[1] === 0xfe ? "utf-16le"
      : chunk[0] === 0xfe && chunk[1] === 0xff ? "utf-16be" : "utf-8", { fatal: true });
    yield decode(decoder, chunk);
  }
  if (decoder) yield decode(decoder);
}

export function dxfLineEnding(text: string) {
  return text.match(/\r\n|[\r\n]/u)?.[0];
}

const maxDxfLine = 1024 ** 2;
export async function* derivativeLines(source: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = "";
  let ending: string | undefined;
  for await (const chunk of source) {
    if (!chunk) continue;
    pending += chunk;
    if (!ending) {
      // The first separator establishes framing. A CR at the end of a chunk may belong to CRLF.
      ending = dxfLineEnding(pending);
      if (ending === "\r" && pending.indexOf("\r") === pending.length - 1) ending = undefined;
      if (!ending) {
        if (pending.length > maxDxfLine) throw new FormatHold("dxf_line_limit");
        continue;
      }
    }
    const lines = pending.split(ending);
    pending = lines.pop()!;
    for (const line of lines) {
      if (line.length > maxDxfLine) throw new FormatHold("dxf_line_limit");
      yield line;
    }
    if (pending.length > maxDxfLine) throw new FormatHold("dxf_line_limit");
  }
  if (!ending && pending.endsWith("\r")) pending = pending.slice(0, -1);
  if (pending) yield pending;
}

export async function* dxfBytes(file: FileHandle): AsyncGenerator<string> {
  let first = true;
  for await (const chunk of readChunks(file)) {
    const bom = first && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf;
    yield chunk.toString("latin1", bom ? 3 : 0);
    first = false;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function dxfValue(line: string): string {
  if (/^[ -~\t]*$/u.test(line)) return line;
  try {
    const text = utf8.decode(Buffer.from(line, "latin1"));
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/u.test(text)) throw new Error();
    return text;
  } catch {
    throw new FormatHold("text_encoding_unconfirmed");
  }
}
