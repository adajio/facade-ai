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

// R2004 and earlier carry this code page in the text DXF header. Later
// versions are UTF-8 and cannot use the legacy declaration to reinterpret bytes.
const legacyDxfVersions = new Set(["AC1006", "AC1009", "AC1012", "AC1014", "AC1015", "AC1018"]);
export async function declaresLegacyDxfCodePage(file: FileHandle): Promise<boolean> {
  const prefix = Buffer.alloc(64 * 1024);
  const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
  const header = prefix.toString("latin1", 0, bytesRead);
  if (dxfLineEnding(header) !== "\r\n") return false;
  const lines = header.split("\r\n");
  let inHeader = false;
  let version: string | undefined;
  let codePage: string | undefined;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (!inHeader) {
      if (code === "999") continue;
      if (code !== "0" || value !== "SECTION" || lines[i + 2]?.trim() !== "2" || lines[i + 3]?.trim() !== "HEADER") return false;
      inHeader = true;
      i += 2;
    } else if (code === "0") {
      return value === "ENDSEC" && legacyDxfVersions.has(version ?? "") && codePage === "ANSI_1251";
    } else if (code === "9" && (value === "$ACADVER" || value === "$DWGCODEPAGE")) {
      const valueCode = lines[i + 2]?.trim();
      const declaration = lines[i + 3]?.trim();
      if (value === "$ACADVER" && version === undefined && valueCode === "1") version = declaration;
      else if (value === "$DWGCODEPAGE" && codePage === undefined && valueCode === "3") codePage = declaration;
      else return false;
      i += 2;
    }
  }
  return false;
}

const cp1251 = new TextDecoder("windows-1251", { fatal: true, ignoreBOM: true });
export function legacyDxfValue(line: string): string {
  if (/^[ -~\t]*$/u.test(line)) return line;
  const text = cp1251.decode(Buffer.from(line, "latin1"));
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u.test(text) || text.includes("\uFFFD")) {
    throw new FormatHold("text_encoding_unconfirmed");
  }
  return text;
}

/** The physical framing has already been verified as CRLF. Opaque XRECORD
 * values are outside the geometry/projection reader and may carry bare LF. */
export async function* isolateLegacyOpaqueValues(lines: AsyncIterable<string>, issues: Set<string>): AsyncGenerator<string> {
  let code: string | undefined;
  let record = "";
  let section = "";
  for await (const line of lines) {
    if (code === undefined) {
      code = line.trim();
      yield line;
      continue;
    }
    if (code === "0") {
      record = line.trim();
      if (record === "ENDSEC") section = "";
    } else if (code === "2" && record === "SECTION") {
      section = line.trim();
    }
    if (section === "OBJECTS" && record === "XRECORD" && (code === "1" || code === "3")
        && line.includes("\n") && !line.includes("\r")) {
      issues.add("cad_dxf_opaque_metadata_ignored");
      yield "";
    } else yield line;
    code = undefined;
  }
}
