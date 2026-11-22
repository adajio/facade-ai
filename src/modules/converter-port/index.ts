import { createHash } from "node:crypto";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Conversion = "doc" | "xls" | "dwg";
type Operation = Conversion | "archive";
const imageId = /^sha256:[a-f0-9]{64}$/;
const formatLimit = 16 * 1024 ** 2;
const errorCodes = [
  "unavailable", "busy", "timeout", "memory_limit", "resource_limit", "failed",
  "output_missing", "invalid_request", "scratch_unavailable",
] as const;
type ErrorCode = typeof errorCodes[number];

export class ConverterPortError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "ConverterPortError";
    this.code = code;
  }
}

function remoteError(value: unknown): ConverterPortError {
  return new ConverterPortError(errorCodes.find(code => code === value) ?? "unavailable");
}

async function* responseBytes(
  path: string,
  options: {
    signal?: AbortSignal;
    timeout: number;
    limit: number;
    source?: Buffer | Readable;
    headers?: Record<string, string>;
  },
): AsyncGenerator<Buffer> {
  const { source, signal } = options;
  const stream = Buffer.isBuffer(source) ? undefined : source;
  const deadline = AbortSignal.timeout(options.timeout);
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: IncomingMessage | undefined;
  let inputError: Error | undefined;
  try {
    runSignal.throwIfAborted();
    const socketPath = process.env.FACADE_CONVERTER_SOCKET;
    if (!socketPath) throw new ConverterPortError("unavailable");
    const req = request({
      socketPath, path, method: source === undefined ? "GET" : "POST", agent: false, signal: runSignal,
      headers: source === undefined ? undefined : { expect: "100-continue", ...options.headers },
    });
    const onInputError = (error: Error) => {
      if (!req.destroyed) inputError = error;
      req.destroy(error);
    };
    stream?.on("error", onInputError);
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        req.once("response", resolve);
        req.on("error", reject);
        if (source === undefined) {
          req.end();
        } else {
          req.once("continue", () => {
            if (stream) void pipeline(stream, req).catch(error => req.destroy(error));
            else req.end(source);
          });
          req.flushHeaders();
        }
      });
      if (response.statusCode !== 200) throw remoteError(response.headers["x-converter-result"]);
      let size = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > options.limit) throw new ConverterPortError("resource_limit");
        yield chunk;
      }
      if (source !== undefined && response.trailers["x-converter-result"] !== "ok") {
        throw remoteError(response.trailers["x-converter-result"]);
      }
    } finally {
      response?.destroy();
      req.destroy();
      stream?.off("error", onInputError);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted) throw new ConverterPortError("timeout");
    if (inputError) throw inputError;
    if (error instanceof ConverterPortError) throw error;
    throw new ConverterPortError("unavailable");
  } finally {
    stream?.destroy();
  }
}

export async function converterImage(operation: Operation, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of responseBytes("/v1/info", { signal, timeout: 4000, limit: 4096 })) {
      chunks.push(chunk);
    }
    const id: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))[operation];
    if (typeof id === "string" && imageId.test(id)) return id;
  } catch {
    signal?.throwIfAborted();
  }
}

export function archiveBytes(source: Buffer | Readable, options: {
  size: number;
  bytes: number;
  entries: number;
  signal?: AbortSignal;
}): AsyncGenerator<Buffer> {
  return responseBytes("/v1/archive", {
    source, signal: options.signal, timeout: 3_670_000,
    // Entry headers contain up to twice the path length plus command framing.
    limit: options.bytes + options.entries * 8256 + Math.ceil(options.bytes / 65_536) * 16 + 64 * 1024 ** 2,
    headers: {
      "content-length": String(options.size),
      "x-expanded-bytes": String(options.bytes),
      "x-archive-entries": String(options.entries),
    },
  });
}

export async function convertBytes(
  operation: Conversion,
  input: Buffer,
  options: { image: string; signal?: AbortSignal },
): Promise<{ bytes: Buffer; sha256: string }> {
  if (!imageId.test(options.image)) throw new ConverterPortError("invalid_request");
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  for await (const chunk of responseBytes(`/v1/${operation}`, {
    source: input, signal: options.signal, timeout: 120_000, limit: formatLimit,
    headers: { "content-length": String(input.length), "x-converter-image": options.image },
  })) {
    chunks.push(chunk);
    hash.update(chunk);
  }
  if (!chunks.length) throw new ConverterPortError("output_missing");
  return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
}
