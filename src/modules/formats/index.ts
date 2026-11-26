import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { ReaderError } from "../pdf/types.js";
import type { ReaderAdapter, ReaderOutput, ReaderUnit, ReadRequest, SourceRef } from "../pdf/types.js";
import { persistDwgFile, verifyDwgFile } from "./dwg-durable.js";
import { dwgFontAssets } from "./cad-font-assets.js";
import type { CadFontAssets } from "./cad-font-assets.js";
import { cadFrame, renderCad } from "./cad-render.js";
import { convert, converterFor, withDwgDerivative } from "./conversion.js";
import type { Converter, Legacy } from "./conversion.js";
import { buildDwgIndex, dwgReaderProfile, openDwgIndex } from "./dwg-index.js";
import type { DwgIndex } from "./dwg-index.js";
import { dxfFramingRevision, dwgVersionPin } from "./dwg-profile.js";
import { FormatHold, originalOnly, parseText, readInput, readerVersion } from "./model.js";
import type { Locator, Parsed, Row, Unit } from "./model.js";
import { cellAddress, parseDocx, parseWordPackage, parseXlsx } from "./office.js";
import { stampPhysicalInventory } from "./physical-inventory.js";
import { createRasterAdapter } from "./raster.js";
import { createSignatureAdapter } from "./cms-signature.js";
import { isThumbsDbName, parseThumbsDb, thumbsDbFormat } from "./windows-thumbnail-cache.js";
import { parseDxf, parseIfc } from "./spatial.js";

const formats = ["docx", "xlsx", "txt", "csv", "tsv", "dxf", "ifc", "doc", "xls", "dwg", "rvt", "image", "sig", thumbsDbFormat, "unknown"] as const;
type Format = typeof formats[number];
const supports = new Set<string>(formats);
const converterFormats = ["doc", "xls", "dwg"] as const;
const rasterExtensions = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "avif", "heic"]);
const native = new Map<Format, (input: Buffer, checkInventory: boolean) => Parsed | Promise<Parsed>>([
  ["docx", parseDocx], ["xlsx", parseXlsx], ["txt", parseText], ["csv", parseText], ["tsv", parseText],
  ["dxf", parseDxf], ["ifc", parseIfc], [thumbsDbFormat, parseThumbsDb],
]);

export function resolveFormat(name: string): Format | "pdf" {
  if (isThumbsDbName(name)) return thumbsDbFormat;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension && rasterExtensions.has(extension)) return "image";
  return extension && extension !== thumbsDbFormat && supports.has(extension) ? extension as Format : "unknown";
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
    "derivativeHandle", "derivativeSection", "entityOrdinal", "step", "globalId", "merge"]);
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

function rawOutput(parsed: Parsed, current: Unit, request: ReadRequest,
  load?: Parameters<typeof renderCad>[3], fonts?: CadFontAssets): ReaderOutput {
  const { textFont, ...requested } = request.address.locator ?? {};
  const query = Object.fromEntries(Object.entries(requested).filter(([key, value]) =>
    !["limitations", "candidateCount"].includes(key) || mapUnit(current).locator?.[key] !== value));
  const { rows, locator, handle } = select(current, query);
  if (textFont !== undefined && (!fonts || !handle || request.representation !== "render" || request.address.box
      || typeof textFont !== "string" || !/^[a-f0-9]{64}$/.test(textFont)
      || !rows.some(row => Array.isArray(row.details?.fonts) && row.details.fonts.some((font) => font.sha256 === textFont)))) invalid();
  const address = { ...request.address, locator: textFont ? { ...locator, textFont } : locator };
  if (request.address.box && !current.cad) invalid();
  if (request.representation === "render") {
    const image = current.cad ? renderCad(current, address, handle, load, fonts, typeof textFont === "string" ? textFont : undefined) : undefined;
    if (!image) {
      throw new ReaderError(handle ? "cad_entity_geometry_unavailable" : current.limitations[0] ?? "format_render_unavailable",
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

function converted(derived: Parsed, converter: Converter, hash: string, kind: string): Parsed {
  const { id, format } = converter;
  // An address produced by a converter belongs to the derivative. Preserve this in every line.
  for (const current of derived.units) {
    current.locator.derivative = kind;
    current.coverage = current.coverage === "held" ? "held" : "partial";
    current.limitations.push(format === "dwg" ? "cad_converted_handle_unverified"
      : format === "xls" ? "xls_conversion_recalculation_unverified" : "doc_converted_address_approximate");
    for (const row of current.rows) {
      if (format === "dwg" && typeof row.locator.handle === "string") {
        row.locator.derivativeHandle = row.locator.handle;
        delete row.locator.handle;
      }
      if (format === "xls" && row.details?.formulaAttributes) row.details.cacheSource = "converter";
    }
  }
  return { ...derived, converter: format === "dwg" ? converter.identity : id, representationSha256: hash,
    inventory: { limitation: `${format}_original_inventory_unverified` } };
}

function adapter(format: Format): ReaderAdapter {
  const legacy = isLegacy(format) ? format : undefined;
  const profile = native.has(format) ? "formats-1.1.3"
    : format === "dwg" ? dwgReaderProfile : format === "doc" ? "formats-1.1.4" : readerVersion;
  const fonts = format === "dwg" ? dwgFontAssets() : undefined;
  let configured: ReturnType<typeof converterFor> | undefined;
  const resolve = () => legacy ? configured ??= converterFor(legacy).catch((error) => {
    configured = undefined;
    throw error;
  }) : undefined;
  const version = async () => {
    const converter = await resolve();
    const identity = converter?.format === "dwg" ? converter.identity : converter?.id;
    return legacy ? `${profile}:${format}:${identity ?? "unavailable"}${fonts ? `:fonts:sha256:${fonts.identity}` : ""}`
      : `${profile}:${format}`;
  };

  async function parse(path: string, checkInventory = false): Promise<Parsed> {
    if (format === "rvt") return originalOnly("rvt_original_only", "original_only");
    if (format === "unknown") return originalOnly("format_original_only", "original_only");
    const converter = await resolve();
    try {
      if (converter?.format === "dwg") throw new Error("DWG must use its part index");
      if (legacy && legacy !== "doc" && !converter) throw new FormatHold(`${legacy}_converter_unavailable`);
      const input = await readInput(path);
      if (format === "doc" && input.subarray(0,2).toString("hex") === "504b") {
        const parsed = await parseWordPackage(input, checkInventory);
        return { ...parsed, ...(parsed.inventory && !("limitation" in parsed.inventory)
          ? { originalSha256: createHash("sha256").update(input).digest("hex") } : {}) };
      }
      if (legacy && !converter) throw new FormatHold(`${legacy}_converter_unavailable`);
      if (!converter) {
        const parsed = await native.get(format)!(input, checkInventory);
        return {
          ...parsed,
          ...(parsed.inventory && !("limitation" in parsed.inventory)
            ? { originalSha256: createHash("sha256").update(input).digest("hex") } : {}),
        };
      }
      if (input.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1") {
        throw new FormatHold(`${legacy}_signature_invalid`);
      }
      const derivative = await convert(converter, input);
      const derived = converter.format === "doc" ? await parseDocx(derivative.bytes) : await parseXlsx(derivative.bytes);
      return converted(derived, converter, derivative.sha256, converter.format === "doc" ? "docx" : "xlsx");
    } catch (error) {
      if (error instanceof ReaderError || (!(error instanceof FormatHold) && (error as NodeJS.ErrnoException).syscall)) {
        throw error;
      }
      const code = error instanceof FormatHold ? error.code : `${format}_invalid_or_unreadable`;
      return originalOnly(code, "held");
    }
  }

  async function index(path?: string, source?: SourceRef, expected?: string | number, readerVersion?: string) {
    const match = readerVersion?.match(dwgVersionPin);
    if (match && fonts?.identity !== match[2]) throw new ReaderError("dwg_index_identity_changed", "Шрифты сохранённого DWG изменились", 409);
    const pinnedConverter = match?.[1];
    const cachedPin = source && pinnedConverter && { source, converter: pinnedConverter, reserve: 0 };
    if (cachedPin) {
      const cached = await openDwgIndex(cachedPin, fonts);
      if (cached && (!expected || expected === cached.identity.derivative)) return cached;
      if (cached) { await cached.close(); throw new ReaderError("dwg_index_identity_changed", "Производная DWG изменилась", 409); }
      if (source && typeof expected === "string") {
        const saved = await verifyDwgFile(source, expected);
        if (saved) {
          const file = await open(saved.path, "r");
          try { return await buildDwgIndex(file, expected, pinnedConverter!, cachedPin, fonts); }
          finally { await file.close(); }
        }
      }
    }
    const converter = await resolve();
    if (converter?.format !== "dwg" || (pinnedConverter && pinnedConverter !== converter.identity)) throw new FormatHold("dwg_converter_unavailable");
    const pin = source && { source, converter: converter.identity, reserve: converter.reserve };
    const cached = pin && await openDwgIndex(pin, fonts);
    if (cached) {
      if (expected !== undefined && expected !== cached.identity.derivative) { await cached.close(); throw new ReaderError("dwg_index_identity_changed", "Производная DWG изменилась", 409); }
      if (!path || !source || await verifyDwgFile(source, cached.identity.derivative)) return cached;
      expected = cached.identity.derivative;
      await cached.close();
    }
    if (!path) return;
    return withDwgDerivative(path, converter, async (file, sha) => {
      if (expected !== undefined && expected !== sha) throw new ReaderError("dwg_index_identity_changed", "Повторная конвертация вернула другую производную DWG", 409);
      const built = await buildDwgIndex(file, sha, converter.identity, pin, fonts);
      try { if (source) await persistDwgFile(source, file, sha); }
      catch (error) { await built.close(); throw error; }
      return built;
    });
  }

  function pinned(index: DwgIndex, unit: Unit, digest: string): Unit {
    return { ...unit, locator: { ...unit.locator, derivativeSha256: index.identity.derivative, derivativeFormat: index.identity.kind, converterIdentity: index.identity.converter, partSha256: digest } };
  }

  function output(index: DwgIndex, request: ReadRequest, selected: ReaderUnit) {
    const { unit, digest } = index.read(selected);
    const current = pinned(index, unit, digest);
    return rawOutput({ units: [], converter: index.identity.converter, representationSha256: index.identity.derivative },
      current, request, block => index.definition(block), fonts);
  }

  async function inspectDwg(path: string, source?: SourceRef): Promise<ReaderUnit[]> {
    let units: ReaderUnit[];
    try {
      const stored = (await index(path, source))!;
      try {
        units = Array.from(stored.units(), ({ unit, digest }) => mapUnit(pinned(stored, unit, digest)));
      } finally {
        await stored.close();
      }
    } catch (error) {
      if (!(error instanceof FormatHold)) throw error;
      units = originalOnly(error.code, "held").units.map(mapUnit);
      if (error.code === "dxf_group_invalid") {
        units[0].locator = { ...units[0].locator, dxfFraming: dxfFramingRevision };
      }
    }
    return stampPhysicalInventory(units, { units: [], inventory: { limitation: "dwg_original_inventory_unverified" } },
      format, await version());
  }

  async function readDwg(path: string | undefined, request: ReadRequest, unit: ReaderUnit, source?: SourceRef, readerVersion?: string) {
    try {
      const stored = await index(path, source, unit.locator?.derivativeSha256, readerVersion);
      if (!stored) return;
      try {
        return output(stored, request, unit);
      } finally {
        await stored.close();
      }
    } catch (error) {
      if (!(error instanceof FormatHold)) throw error;
      if (!path) return;
      if (unit.id !== "original") throw new ReaderError(error.code, "Часть DWG временно недоступна", 424);
      const held = originalOnly(error.code, "held");
      return rawOutput(held, held.units[0], request);
    }
  }

  async function* nativeDwg(stored: DwgIndex, units: readonly ReaderUnit[]) {
    try {
      for (const unit of units) {
        try { yield output(stored, { address: { unitId: unit.id }, representation: "native" }, unit); }
        catch (error) { if (!(error instanceof ReaderError)) throw error; yield error; }
      }
    } finally { await stored.close(); }
  }

  return {
    format,
    version,
    ...(format === "dwg" ? { async durableInfo(source: SourceRef, units: readonly ReaderUnit[], readerVersion: string) {
      const sha = units[0]?.locator?.derivativeSha256;
      const kind = units[0]?.locator?.derivativeFormat;
      const converter = units[0]?.locator?.converterIdentity;
      if (typeof sha !== "string" || (kind !== "dxf" && kind !== "dwg-json") || typeof converter !== "string" || !readerVersion.includes(converter)) return;
      const stored = await verifyDwgFile(source, sha);
      return stored && { storageKey: stored.storageKey, sha256: sha, size: stored.size, format: kind, converter };
    } } : {}),
    async inspect(path, source) {
      if (format === "dwg") return inspectDwg(path, source);
      const parsed = await parse(path, true);
      return stampPhysicalInventory(parsed.units.map(mapUnit), parsed, format, await version());
    },
    ...(format === "dwg" ? {
      readCached: (source: SourceRef, request: ReadRequest, unit: ReaderUnit, readerVersion?: string) => readDwg(undefined, request, unit, source, readerVersion),
      async readCachedNativeUnits(source: SourceRef, units: readonly ReaderUnit[], readerVersion?: string) {
        try {
          const stored = await index(undefined, source, units[0]?.locator?.derivativeSha256, readerVersion);
          return stored && nativeDwg(stored, units);
        } catch (error) {
          if (!(error instanceof FormatHold)) throw error;
          return undefined;
        }
      },
    } : {}),
    async read(path, request, unit, _containedWords, source) {
      if (format === "dwg") return (await readDwg(path, request, unit, source))!;
      const parsed = await parse(path);
      const current = parsed.units.find(({ id }) => id === unit.id);
      if (!current) {
        throw new ReaderError(parsed.units[0]?.limitations[0] ?? "format_unit_unavailable",
          "Не удалось повторно открыть закреплённую единицу reader", 424);
      }
      return rawOutput(parsed, current, request);
    },
    async *readNativeUnits(path, units, source) {
      if (format === "dwg") {
        try {
          const stored = (await index(path, source, units[0]?.locator?.derivativeSha256))!;
          yield* nativeDwg(stored, units);
        } catch (error) {
          if (!(error instanceof FormatHold)) throw error;
          const held = originalOnly(error.code, "held");
          for (const unit of units) {
            if (unit.id === "original") yield rawOutput(held, held.units[0], {
              address: { unitId: unit.id }, representation: "native",
            });
            else yield new ReaderError(error.code, "Часть DWG временно недоступна", 424);
          }
        }
        return;
      }
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
  return formats.map((format) => {
    if (format === "image") return createRasterAdapter();
    if (format === "sig") return createSignatureAdapter();
    return adapter(format);
  });
}

// API endpoints are implemented by the shared reader and registered once.
export async function register(_app: FastifyInstance): Promise<void> {}
