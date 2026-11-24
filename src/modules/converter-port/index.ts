import { createHash } from "node:crypto";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Conversion = "doc" | "xls" | "dwg";
type Operation = Conversion | "archive";
type Office = Exclude<Conversion, "dwg">;
const imageId = /^sha256:[a-f0-9]{64}$/;
const formatLimit = 16 * 1024 ** 2;
const receiptLimit = 10 * 1024 ** 3;
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
    limit?: number;
    prepare?: (headers: IncomingMessage["headers"]) => Promise<number>;
    verify?: (size: number, trailers: IncomingMessage["trailers"]) => void;
    source?: Buffer | Readable;
    sourceSize?: number;
    headers?: Record<string, string>;
  },
): AsyncGenerator<Buffer> {
  const { source, signal } = options;
  const stream = Buffer.isBuffer(source) ? undefined : source;
  const deadline = AbortSignal.timeout(options.timeout);
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: IncomingMessage | undefined;
  let inputError: Error | undefined;
  async function* exact(input: Readable, expected: number): AsyncGenerator<Buffer> {
    let size = 0;
    for await (const chunk of input as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > expected) break;
      yield chunk;
    }
    if (size !== expected) {
      inputError = new ConverterPortError("invalid_request");
      throw inputError;
    }
  }
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
            if (stream) {
              const body = options.sourceSize === undefined ? stream : exact(stream, options.sourceSize);
              void pipeline(body, req).catch(error => req.destroy(error));
            } else req.end(source);
          });
          req.flushHeaders();
        }
      });
      if (response.statusCode !== 200) throw remoteError(response.headers["x-converter-result"]);
      const limit = options.prepare ? await options.prepare(response.headers) : options.limit;
      let size = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (limit !== undefined && size > limit) throw new ConverterPortError("resource_limit");
        yield chunk;
      }
      if (source !== undefined && response.trailers["x-converter-result"] !== "ok") {
        throw remoteError(response.trailers["x-converter-result"]);
      }
      options.verify?.(size, response.trailers);
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

async function converterInfo(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of responseBytes("/v1/info", { signal, timeout: 4000, limit: 4096 })) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    signal?.throwIfAborted();
  }
}

export async function converterImage(operation: Operation, signal?: AbortSignal): Promise<string | undefined> {
  const id = (await converterInfo(signal))?.[operation];
  if (typeof id === "string" && imageId.test(id)) return id;
}

export async function dwgProfile(signal?: AbortSignal): Promise<{ id: string; timeout: number; reserve: number } | undefined> {
  const info = await converterInfo(signal);
  const id = info?.dwg;
  const timeout = info?.dwgClientTimeoutMs;
  const reserve = info?.dwgReserveBytes;
  if (typeof id === "string" && imageId.test(id) && typeof timeout === "number"
      && Number.isInteger(timeout) && timeout > 0 && timeout <= 7_260_000
      && typeof reserve === "number" && Number.isSafeInteger(reserve) && reserve > 0) {
    return { id, timeout, reserve };
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
  operation: Office,
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


export async function convertDwg(
  source: Readable,
  output: Writable,
  options: {
    size: number; image: string; timeout: number; signal?: AbortSignal;
    checkSpace?: (size: number) => Promise<void>;
  },
): Promise<{ size: number; sha256: string }> {
  if (!imageId.test(options.image) || !Number.isSafeInteger(options.size)
      || options.size < 6 || options.size > receiptLimit) {
    source.destroy();
    output.destroy();
    throw new ConverterPortError("invalid_request");
  }

  const hash = createHash("sha256");
  let result: { size: number; sha256: string } | undefined;
  let declared: string;
  const bytes = responseBytes("/v1/dwg", {
    source, sourceSize: options.size, signal: options.signal, timeout: options.timeout,
    headers: { "content-length": String(options.size), "x-converter-image": options.image },
    async prepare(headers) {
      const length = headers["x-converter-bytes"];
      if (typeof length !== "string" || !/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(Number(length))) {
        throw new ConverterPortError("output_missing");
      }
      declared = length;
      await options.checkSpace?.(Number(length));
      return Number(length);
    },
    verify(size, trailers) {
      if (!size) throw new ConverterPortError("output_missing");
      const sha256 = hash.digest("hex");
      if (declared !== String(size) || trailers["x-converter-bytes"] !== declared
          || trailers["x-converter-sha256"] !== sha256) {
        throw new ConverterPortError("failed");
      }
      result = { size, sha256 };
    },
  });
  async function* verifiedBytes() {
    for await (const chunk of bytes) {
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    await pipeline(verifiedBytes(), output, { signal: options.signal });
    if (!result) throw new ConverterPortError("unavailable");
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    source.destroy();
  }
}
