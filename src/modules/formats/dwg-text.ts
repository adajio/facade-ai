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

export async function* derivativeLines(source: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = "";
  let splitCrlf = false;
  for await (const chunk of source) {
    if (!chunk) continue;
    const text: string = pending + (splitCrlf && chunk[0] === "\n" ? chunk.slice(1) : chunk);
    splitCrlf = text.endsWith("\r");
    const lines = text.split(/\r\n|[\r\n]/u);
    pending = lines.pop()!;
    if (pending.length > 1024 ** 2) throw new FormatHold("dxf_line_limit");
    yield* lines;
  }
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
