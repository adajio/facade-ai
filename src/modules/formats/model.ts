import { open } from "node:fs/promises";
import { matchInventory } from "./physical-inventory.js";
import type { PhysicalInventory } from "./physical-inventory.js";

export const readerVersion = "formats-1.1.0";
export const inputLimit = 16 * 1024 * 1024;

export type Locator = Record<string, string | number>;
export type Coverage = "addressable" | "partial" | "held" | "original_only";
export type Row = {
  locator: Locator;
  text: string;
  details?: Record<string, unknown>;
  bounds?: { x: number; y: number; width: number; height: number };
};
export type Unit = {
  id: string;
  label: string;
  locator: Locator;
  rows: Row[];
  limitations: string[];
  coverage: Coverage;
  cad?: CadShape[];
  cadContext?: CadShape[];
  cadView?: { x: number; y: number; width: number; height: number };
  physicalRows?: number[];
};
export type CadBounds = { left: number; right: number; top: number; bottom: number };
// A block transform is expressed in SVG coordinates (CAD Y points up).
export type CadBlockUse = { digest: string; matrix: [number, number, number, number, number, number] };
// Points and circular arcs are expressed in SVG coordinates.
export type CadPath = (["M" | "L", number, number] | ["A", number, number, number, number, number])[];
export type CadPoint = [number, number];
export type CadHatchLine = { base: CadPoint; direction: CadPoint; step: CadPoint; dashes: number[] };
export type CadArea = { loops: CadPath[]; mode: "solid" | "pattern" | "mask"; pattern?: CadHatchLine[] };
export type CadDefinition = { shapes: CadShape[] };
export type CadFontUse = { name: string; sha256?: string; kind?: "ttf" | "shx";
  fallback?: "font" | "glyph" | "bigfont"; glyph?: string };
export type CadTextSpan = { text: string; sha256?: string; x: number; y: number; height: number; width: number;
  oblique: number; advance: number };
export type CadFontRequest = { name: string; bold?: boolean; italic?: boolean; width?: number; oblique?: number; bigfont?: string };
export type CadShape = {
  handle: string;
  layer: string;
  kind: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  height?: number;
  angle?: number;
  radius?: number;
  text?: string;
  textSpans?: CadTextSpan[];
  fontRequest?: CadFontRequest;
  path?: CadPath;
  bounds?: CadBounds;
  block?: CadBlockUse;
  clip?: CadBounds;
  area?: CadArea;
  pieces?: CadShape[];
  order?: string;
};
export type Parsed = {
  units: Unit[];
  converter?: string;
  representationSha256?: string;
  inventory?: PhysicalInventory;
  originalSha256?: string;
};

export class FormatHold extends Error {
  constructor(readonly code: string) { super(code); }
}

export function unit(
  id: string, label: string, locator: Locator, rows: Row[], limitations: string[] = [],
): Unit {
  return {
    id, label, locator, rows, limitations,
    coverage: limitations.length ? "partial" : "addressable",
  };
}

export function originalOnly(code: string, coverage: "held" | "original_only"): Parsed {
  return {
    inventory: { limitation: code },
    units: [{
      id: "original", label: "Оригинал", locator: { place: "original" },
      rows: [], limitations: [code], coverage,
    }],
  };
}

export async function readInput(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size > inputLimit) throw new FormatHold("format_input_limit");
    const data = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await file.read(data, offset, size - offset, offset);
      if (!bytesRead) throw new FormatHold("format_input_incomplete");
      offset += bytesRead;
    }
    return data;
  } finally {
    await file.close();
  }
}

export function decodeText(data: Buffer): string {
  const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
    : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(data);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/u.test(content)) throw new Error("control character");
    return content;
  } catch {
    throw new FormatHold("text_encoding_unconfirmed");
  }
}

export function parseText(data: Buffer, checkInventory = false): Parsed {
  const content = decodeText(data);
  const lineCount = content ? (content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1 : 0;
  if (lineCount > 50_000) throw new FormatHold("text_line_limit");
  const lines = lineCount ? content.split(/\r\n|\r|\n/u) : [];
  if (lines.some((line) => line.length > 16_384)) throw new FormatHold("text_line_limit");
  const units: Unit[] = [];
  for (let index = 0; index < lines.length; index += 100) {
    const window = lines.slice(index, index + 100);
    units.push(unit(
      `lines:${index + 1}`, `Строки ${index + 1}–${index + window.length}`,
      { firstLine: index + 1, lastLine: index + window.length },
      window.map((text, offset) => ({ text, locator: { line: index + offset + 1 } })),
    ));
  }
  if (!lineCount) units.push(unit("lines:1", "Строки", { line: 1 }, []));
  if (!checkInventory) return { units };
  // The source count is obtained from the delimiters, independently of window assembly.
  const source = Array.from({ length: lineCount }, (_, offset) => String(offset + 1));
  const mapped = units.flatMap(({ locator, rows }) => rows.map(({ locator: row }, offset) =>
    row.line === Number(locator.firstLine) + offset && Number(row.line) <= Number(locator.lastLine)
      ? String(row.line) : ""));
  const inventory = lineCount ? matchInventory(source, mapped, "text_line_inventory_mismatch")
    : { limitation: "text_no_physical_lines" };
  return { units, inventory };
}
