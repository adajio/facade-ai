import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ReaderError } from "../pdf/types.js";
import type { ReaderAdapter, ReaderOutput, ReaderUnit, ReadRequest } from "../pdf/types.js";
import { cadFrame, renderCad } from "./cad-render.js";
import { convert, converterFor } from "./conversion.js";
import type { Legacy } from "./conversion.js";
import { FormatHold, originalOnly, parseText, readInput, readerVersion } from "./model.js";
import type { Locator, Parsed, Row, Unit } from "./model.js";
import { cellAddress, parseDocx, parseXlsx } from "./office.js";
import { stampPhysicalInventory } from "./physical-inventory.js";
import { parseDwgRecovery, parseDxf, parseIfc } from "./spatial.js";

const formats = ["docx", "xlsx", "txt", "csv", "tsv", "dxf", "ifc", "doc", "xls", "dwg", "rvt", "image", "unknown"] as const;
type Format = typeof formats[number];
const supports = new Set<string>(formats);
const converterFormats = ["doc", "xls", "dwg"] as const;
const rasterExtensions = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "avif", "heic"]);
const native = new Map<Format, (input: Buffer, checkInventory: boolean) => Parsed | Promise<Parsed>>([
  ["docx", parseDocx], ["xlsx", parseXlsx], ["txt", parseText], ["csv", parseText], ["tsv", parseText],
  ["dxf", parseDxf], ["ifc", parseIfc],
]);

export function resolveFormat(name: string): Format | "pdf" {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension && rasterExtensions.has(extension)) return "image";
  return extension && supports.has(extension) ? extension as Format : "unknown";
}

function isLegacy(format: Format): format is Legacy {
  return (converterFormats as readonly string[]).includes(format);
}

function invalid(): never {
  throw new ReaderError("reader_address_invalid", "Место отсутствует в указанной единице оригинала", 422);
}

function select(current: Unit, request: Locator = {}): { rows: Row[]; locator: Locator; handle?: string } {
  const locator = { ...current.locator };
  const qualifiers = new Set(["line", "paragraph", "section", "row", "column", "cell", "range", "handle",
    "derivativeHandle", "entityOrdinal", "step", "globalId", "merge"]);
  for (const [key, value] of Object.entries(request)) {
    if (Object.hasOwn(locator, key) && locator[key] === value) continue;
    if (key === "coverage" && current.coverage === value) continue;
    if (!qualifiers.has(key)) invalid();
  }
  let rows = current.rows;
  for (const [key, value] of Object.entries(request)) {
    if (locator[key] === value || key === "coverage") continue;
    if (key === "range") {
      const parts = typeof value === "string" ? value.split(":") : [];
      const first = cellAddress(parts[0] ?? "");
      const last = cellAddress(parts[1] ?? "");
      if (parts.length !== 2 || !first || !last || first.row > last.row || first.column > last.column
          || typeof locator.sheetId !== "string" || first.row < Number(locator.firstRow)
          || last.row > Number(locator.lastRow)) invalid();
      rows = rows.filter((row) => Number(row.locator.row) >= first.row && Number(row.locator.row) <= last.row
        && Number(row.locator.column) >= first.column && Number(row.locator.column) <= last.column);
    } else {
      rows = rows.filter((row) => row.locator[key] === value);
      if (!rows.length) invalid();
      if ((key === "globalId" || key === "step") && rows.length !== 1) invalid();
    }
    locator[key] = value;
  }
  const handle = request.handle ?? request.derivativeHandle
    ?? (request.entityOrdinal === undefined ? undefined : `ordinal:${request.entityOrdinal}`);
  return { rows, locator, handle: handle === undefined ? undefined : String(handle) };
}

function mapUnit(current: Unit): ReaderUnit {
  const frame = cadFrame(current);
  return {
    id: current.id,
    label: current.label,
    ...(frame ? { width: frame.width, height: frame.height } : {}),
    locator: { ...current.locator, coverage: current.coverage,
      candidateCount: current.rows.reduce((count, row) => count + Number(Boolean(row.text.trim())), 0),
      ...(current.limitations.length ? { limitations: current.limitations.join(",").slice(0, 300) } : {}) },
  };
}

function rawOutput(parsed: Parsed, current: Unit, request: ReadRequest): ReaderOutput {
  const query = Object.fromEntries(Object.entries(request.address.locator ?? {}).filter(([key, value]) =>
    !["limitations", "candidateCount"].includes(key) || mapUnit(current).locator?.[key] !== value));
  const { rows, locator, handle } = select(current, query);
  const address = { ...request.address, locator };
  if (request.address.box && !current.cad) invalid();
  if (request.representation === "render") {
    const image = current.cad ? renderCad(current, address, handle) : undefined;
    if (!image) {
      throw new ReaderError(current.limitations[0] ?? "format_render_unavailable",
        "Для указанного места доступно текстовое открытие или исходное ограничение", 424);
    }
    return { address: { ...address, box: image.crop }, bytes: image.bytes, mediaType: "image/png",
      transform: image.transform, limitations: [...current.limitations, "cad_preview_schematic"] };
  }

  const limitation = request.representation === "ocr" ? ["format_ocr_unavailable"] : [];
  // CAD geometric windows are rendered. Native text can be selected by the same entity address.
  if (request.address.box) invalid();
  const selected = request.representation === "ocr" ? [] : rows;
  const lines = selected.map((row) => ({
    id: createHash("sha256").update(JSON.stringify([current.id, row.locator])).digest("hex").slice(0, 24),
    text: row.text, locator: row.locator, details: row.details, drawingBounds: row.bounds,
  }));
  const limitations = [...new Set([...current.limitations, ...limitation,
    ...(lines.some(({ text }) => text.trim()) ? [] : ["format_zero_text_candidates"])])];
  const bytes = Buffer.from(JSON.stringify({
    address, coverage: current.coverage, lines, limitations,
    converter: parsed.converter, derivativeSha256: parsed.representationSha256,
  }));
  if (bytes.length > 16 * 1024 * 1024) {
    throw new ReaderError("format_presentation_limit", "Выберите меньший адресный диапазон", 422);
  }
  return { address, lines, bytes, mediaType: "application/json", limitations };
}

function adapter(format: Format): ReaderAdapter {
  const legacy = isLegacy(format) ? format : undefined;
  const profile = native.has(format) || format === "image" ? "formats-1.1.3"
    : format === "doc" || format === "dwg" ? "formats-1.1.1" : readerVersion;
  let configured: ReturnType<typeof converterFor> | undefined;
  const resolve = () => legacy ? configured ??= converterFor(legacy).catch((error) => {
    configured = undefined;
    throw error;
  }) : undefined;
  const version = async () => legacy ? `${profile}:${format}:${(await resolve())?.id ?? "unavailable"}`
    : `${profile}:${format}`;

  async function parse(path: string, checkInventory = false): Promise<Parsed> {
    if (format === "rvt") return originalOnly("rvt_original_only", "original_only");
    if (format === "image") return originalOnly("image_reader_unsupported", "original_only");
    if (format === "unknown") return originalOnly("format_original_only", "original_only");
    const converter = await resolve();
    try {
      if (legacy && !converter) throw new FormatHold(`${legacy}_converter_unavailable`);
      const input = await readInput(path);
      if (!converter) {
        const parsed = await native.get(format)!(input, checkInventory);
        return {
          ...parsed,
          ...(parsed.inventory && !("limitation" in parsed.inventory)
            ? { originalSha256: createHash("sha256").update(input).digest("hex") } : {}),
        };
      }
      const magic = input.subarray(0, 8).toString("hex");
      const valid = legacy === "dwg" ? /^AC10\d{2}$/.test(input.subarray(0, 6).toString("ascii"))
        : magic === "d0cf11e0a1b11ae1";
      if (!valid) throw new FormatHold(`${legacy}_signature_invalid`);
      const derivative = await convert(converter, input);
      const dwgRecovery = legacy === "dwg" && /^\s*\{/.test(derivative.bytes.subarray(0, 128).toString("utf8"));
      const derived = legacy === "doc" ? await parseDocx(derivative.bytes)
        : legacy === "xls" ? await parseXlsx(derivative.bytes)
        : dwgRecovery ? parseDwgRecovery(derivative.bytes) : parseDxf(derivative.bytes);
      // Coordinates assigned by a converter describe the derivative. Preserve that distinction in every line.
      for (const current of derived.units) {
        current.locator.derivative = legacy === "doc" ? "docx" : legacy === "xls" ? "xlsx" : dwgRecovery ? "dwg-json" : "dxf";
        current.coverage = current.coverage === "held" ? "held" : "partial";
        current.limitations.push(legacy === "dwg" ? "cad_converted_handle_unverified"
          : legacy === "xls" ? "xls_conversion_recalculation_unverified" : "doc_converted_address_approximate");
        for (const row of current.rows) {
          if (legacy === "dwg" && typeof row.locator.handle === "string") {
            row.locator.derivativeHandle = row.locator.handle;
            delete row.locator.handle;
          }
          if (legacy === "xls" && row.details?.formulaAttributes) row.details.cacheSource = "converter";
        }
      }
      return { ...derived, converter: converter.id, representationSha256: derivative.sha256,
        inventory: { limitation: `${legacy}_original_inventory_unverified` } };
    } catch (error) {
      if (error instanceof ReaderError || (!(error instanceof FormatHold) && (error as NodeJS.ErrnoException).syscall)) {
        throw error;
      }
      const code = error instanceof FormatHold ? error.code : `${format}_invalid_or_unreadable`;
      return originalOnly(code, "held");
    }
  }

  return {
    format,
    version,
    async inspect(path) {
      const parsed = await parse(path, true);
      return stampPhysicalInventory(parsed.units.map(mapUnit), parsed, format, await version());
    },
    async read(path, request, unit) {
      const parsed = await parse(path);
      const current = parsed.units.find(({ id }) => id === unit.id);
      if (!current) {
        throw new ReaderError(parsed.units[0]?.limitations[0] ?? "format_unit_unavailable",
          "Не удалось повторно открыть закреплённую единицу reader", 424);
      }
      return rawOutput(parsed, current, request);
    },
    async *readNativeUnits(path, units) {
      const parsed = await parse(path);
      const byId = new Map(parsed.units.map((current) => [current.id, current]));
      for (const { id } of units) {
        try {
          const current = byId.get(id);
          if (!current) throw new ReaderError(parsed.units[0]?.limitations[0] ?? "format_unit_unavailable",
            "Не удалось повторно открыть закреплённую единицу reader", 424);
          yield rawOutput(parsed, current, { address: { unitId: id }, representation: "native" });
        } catch (error) {
          if (!(error instanceof ReaderError)) throw error;
          yield error;
        }
      }
    },
  };
}

export function createFormatAdapters(): ReaderAdapter[] {
  return formats.map(adapter);
}

// API endpoints are implemented by the shared reader and registered once.
export async function register(_app: FastifyInstance): Promise<void> {}
