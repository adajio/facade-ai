import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReaderError } from "../pdf/types.js";
import type { ReaderUnit, SourceRef } from "../pdf/types.js";
import { blockKey, dwgGeometry, geometryDigest } from "./dwg-geometry.js";
import { dwgViewports } from "./dwg-viewport.js";
import { dwgFontAssets } from "./cad-font-assets.js";
import type { CadFontAssets } from "./cad-font-assets.js";
import { dwgCadText, mergeFontUses } from "./dwg-cad-text.js";
import { dwgMaskContext } from "./dwg-mask-context.js";
import { cadPaintOrder, cadShapeBounds } from "./cad-bounds.js";
import { derivativeLines, derivativeText, dxfBytes, dxfValue } from "./dwg-text.js";
import { recoveryObjects } from "./dwg-recovery.js";
import { FormatHold, unit } from "./model.js";
import type { CadDefinition, CadFontUse, Unit } from "./model.js";
import { appendCadEntity, cadMetadata, cadSpace, convertedDxfRecords, first, recoveryCadRecords } from "./spatial.js";
import type { Entity } from "./spatial.js";

export const dwgReaderProfile = "formats-1.1.8";
const rowsPerPart = 512;
const shapesPerPart = 6000;
const textPerPart = 2 * 1024 ** 2;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const short = (value: string) => hash(value).slice(0, 24);

type Pin = { source: SourceRef; converter: string; reserve: number };
type IndexedUnit = { unit: Unit; digest: string };
type IndexIdentity = { converter: string; derivative: string; kind: "dxf" | "dwg-json"; fonts?: string };

function location(pin: Pin, fonts: CadFontAssets) {
  if (!process.env.FACADE_DATA_DIR) return;
  return join(process.env.FACADE_DATA_DIR, "dwg-index", hash(JSON.stringify([
    dwgReaderProfile, pin.source.projectId, pin.source.sha256, pin.converter, fonts.identity,
  ])));
}

function cacheUnavailable(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOENT"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

function indexError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  const sqlite = (error as { errcode?: number })?.errcode;
  if (["ENOSPC", "EDQUOT"].includes(code ?? "") || sqlite === 13) {
    throw new ReaderError("dwg_index_scratch_unavailable", "Недостаточно места для индекса DWG", 503);
  }
  if (code === "ERR_SQLITE_ERROR" || error instanceof SyntaxError) {
    throw new ReaderError("dwg_index_invalid", "Индекс производной DWG не подтверждён", 424);
  }
  throw error;
}

export class DwgIndex {
  readonly identity: IndexIdentity;
  constructor(private readonly db: DatabaseSync, private readonly dispose?: () => Promise<void>) {
    const raw = db.prepare("SELECT data FROM identity").get()?.data;
    if (typeof raw !== "string") throw new ReaderError("dwg_index_invalid", "Индекс производной DWG не подтверждён", 424);
    this.identity = JSON.parse(raw) as IndexIdentity;
  }
  *units(): Iterable<IndexedUnit> {
    try {
      for (const row of this.db.prepare("SELECT data,digest FROM parts ORDER BY view,ordinal").iterate()) yield this.decode(row);
    } catch (error) {
      indexError(error);
    }
  }
  read(unit: ReaderUnit): IndexedUnit {
    try {
      const raw = this.db.prepare("SELECT data,digest FROM parts WHERE id=?").get(unit.id);
      if (!raw) throw new ReaderError("reader_address_invalid", "Часть отсутствует в индексе DWG", 422);
      const result = this.decode(raw);
      if (unit.locator?.derivativeSha256 !== this.identity.derivative || unit.locator.partSha256 !== result.digest) {
        throw new ReaderError("dwg_index_identity_changed", "Ожидаемая производная или часть DWG изменилась", 409);
      }
      return result;
    } catch (error) {
      return indexError(error);
    }
  }
  private decode(raw: Record<string, unknown>): IndexedUnit {
    const { data, digest } = raw;
    if (typeof data !== "string" || typeof digest !== "string" || hash(data) !== digest) {
      throw new ReaderError("dwg_index_invalid", "Контрольная сумма части DWG расходится", 424);
    }
    return { unit: JSON.parse(data) as Unit, digest };
  }
  definition(digest: string): CadDefinition {
    try {
      const raw = this.db.prepare("SELECT data FROM definitions WHERE digest=?").get(digest)?.data;
      if (typeof raw !== "string" || geometryDigest(raw) !== digest) {
        throw new ReaderError("dwg_index_invalid", "Контрольная сумма блока DWG расходится", 424);
      }
      return JSON.parse(raw) as CadDefinition;
    } catch (error) {
      return indexError(error);
    }
  }
  async close() {
    try { this.db.close(); } finally { await this.dispose?.(); }
  }
}

export async function openDwgIndex(pin: Pin, fonts = dwgFontAssets()): Promise<DwgIndex | undefined> {
  const path = location(pin, fonts);
  if (!path) return;
  if (!(await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (!cacheUnavailable(error)) throw error;
  }))) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const index = new DwgIndex(db);
    if (index.identity.converter !== pin.converter || index.identity.fonts !== fonts.identity) throw new ReaderError(
      "dwg_index_identity_changed", "Профиль сохранённой производной DWG изменился", 409);
    return index;
  } catch (error) {
    db?.close();
    return indexError(error);
  }
}

function budget(db: DatabaseSync, bytes: bigint) {
  // SQLite uses 4096-byte pages here. Leave room for the spool and transient sorting.
  db.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;
    PRAGMA max_page_count=${bytes / 4096n};`);
}

export async function buildDwgIndex(
  file: FileHandle, sha: string, converter: string, pin?: Pin, fonts = dwgFontAssets(),
): Promise<DwgIndex> {
  let path = pin && location(pin, fonts);
  if (pin && !path) throw new ReaderError("dwg_storage_unavailable", "Не настроено постоянное хранилище DWG", 503);
  let root = path ? join(path, "..") : tmpdir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (pin || !path || !cacheUnavailable(error)) return indexError(error);
    path = undefined;
    root = tmpdir();
  }
  const free = await statfs(root, { bigint: true });
  let capacity = free.bavail * free.bsize - BigInt(pin?.reserve ?? 0);
  if (capacity < 1024n * 1024n) throw new ReaderError("dwg_index_scratch_unavailable", "Недостаточно места для индекса DWG", 503);
  let tmp: string;
  try {
    tmp = await mkdtemp(join(root, ".dwg-"));
  } catch (error) {
    return indexError(error);
  }
  const clean = () => rm(tmp, { recursive: true, force: true });
  let records: DatabaseSync | undefined;
  let output: DatabaseSync | undefined;
  try {
    const head = Buffer.alloc(128);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    const recovery = /^\s*\{/.test(head.toString("utf8", 0, bytesRead));
    const kind = recovery ? "dwg-json" : "dxf";
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    const issues = new Set<string>();
    const source = recovery ? recoveryCadRecords(recoveryObjects(derivativeText(file)), issues)
      : utf16 ? convertedDxfRecords(derivativeLines(derivativeText(file)))
        : convertedDxfRecords(derivativeLines(dxfBytes(file)), dxfValue);
    records = new DatabaseSync(join(tmp, "records"));
    budget(records, capacity / 3n);
    records.exec(`
      CREATE TABLE entities (ordinal INTEGER PRIMARY KEY, data TEXT, handle TEXT, direct TEXT, owner TEXT, paper INTEGER, space TEXT, paper_block INTEGER NOT NULL);
      CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE block_headers (name TEXT PRIMARY KEY, data TEXT, owner TEXT, paper INTEGER, ambiguous INTEGER DEFAULT 0);
      CREATE TABLE block_entities (ordinal INTEGER PRIMARY KEY, name TEXT, data TEXT, handle TEXT);
      CREATE TABLE block_compiled (name TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE redraw (handle TEXT PRIMARY KEY, owner TEXT, sortkey TEXT);
    `);
    const metadata: Entity[] = [];
    let metadataBytes = 0;
    let ordinal = 0;
    const insert = records.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,NULL,0)");
    const saveHeader = records.prepare(`INSERT INTO block_headers(name,data,owner,paper) VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET ambiguous=1`);
    const saveChild = records.prepare("INSERT INTO block_entities(name,data,handle) VALUES (?,?,?)");
    let activeBlock: string | undefined;
    let sortEnabled = false;
    const sort = records.prepare("INSERT OR IGNORE INTO redraw VALUES (?,?,?)");
    const addressHandle = (record: Entity) => {
      const handle = first(record, 5)?.toUpperCase();
      return handle && /^[0-9A-F]{1,16}$/.test(handle) ? handle : null;
    };
    records.exec("BEGIN");
    for await (const { entity, block, record, sort: redraw } of source) {
      if (redraw) {
        if ([redraw.handle, redraw.owner, redraw.order].every(value => /^[0-9A-F]{1,16}$/.test(value))) {
          sort.run(redraw.handle, redraw.owner, /^0+$/.test(redraw.order) ? "~" : redraw.order.padStart(16, "0"));
        }
        continue;
      }
      if (record.type === "SORTENTS_FLAG") {
        sortEnabled = Boolean(Number(first(record, 280)) & 16);
        continue;
      }
      const raw = JSON.stringify(record);
      if (entity) {
        insert.run(++ordinal, raw, addressHandle(record),
          first(record, 410) || null, first(record, 330)?.toUpperCase() ?? null, Number(first(record, 67) === "1"));
      } else if (block) {
        if (record.type === "BLOCK") {
          activeBlock = blockKey(first(record, 2));
          if ((Number(first(record, 70)) & 12) || first(record, 1)) issues.add("cad_external_reference");
          if (activeBlock) saveHeader.run(activeBlock, raw, first(record, 330)?.toUpperCase() ?? null,
            Number(/^\*PAPER_SPACE\d*$/.test(activeBlock)));
        } else if (record.type === "ENDBLK") activeBlock = undefined;
        else if (activeBlock) saveChild.run(activeBlock, raw, addressHandle(record));
      } else {
        metadataBytes += Buffer.byteLength(raw);
        if (metadataBytes > 8 * 1024 ** 2) throw new FormatHold("cad_metadata_limit");
        metadata.push(record);
      }
    }
    records.exec("COMMIT");
    const { layouts, ownerLayouts, views } = cadMetadata(metadata, issues);
    issues.delete("cad_font_substitution"); // Report actual runs, not unreferenced STYLE declarations.
    const textPlan = dwgCadText(metadata, fonts);
    const owner = records.prepare("INSERT INTO owners VALUES (?,?)");
    for (const [id, name] of ownerLayouts) owner.run(id, name);
    records.exec(`
      UPDATE entities SET space=coalesce(direct, (SELECT name FROM owners WHERE id=entities.owner),
        CASE paper WHEN 1 THEN 'Paper' ELSE 'Model' END);
      CREATE INDEX block_entities_name ON block_entities(name,ordinal);
      INSERT INTO entities
        SELECT (SELECT coalesce(max(ordinal),0) FROM entities) + row_number() OVER (ORDER BY b.ordinal),
          b.data,b.handle,NULL,h.owner,1,o.name,1
        FROM block_entities b JOIN block_headers h USING(name) JOIN owners o ON o.id=h.owner
        WHERE h.paper=1 AND h.ambiguous=0 AND o.name<>'Model';
      CREATE INDEX entities_space ON entities(space,ordinal);
      CREATE INDEX entities_handle ON entities(handle);
      CREATE TABLE duplicates (handle TEXT PRIMARY KEY);
      INSERT INTO duplicates SELECT handle FROM entities WHERE handle IS NOT NULL AND paper_block=0
        GROUP BY handle HAVING count(*)>1;
      CREATE TABLE duplicates_with_paper (handle TEXT PRIMARY KEY);
      INSERT INTO duplicates_with_paper SELECT handle FROM entities WHERE handle IS NOT NULL
        GROUP BY handle HAVING count(*)>1;
    `);
    const diskFile = join(tmp, "index.sqlite");
    output = new DatabaseSync(diskFile);
    budget(output, capacity / 3n);
    output.exec(`CREATE TABLE identity (data TEXT); CREATE TABLE parts (
      ordinal INTEGER PRIMARY KEY, id TEXT UNIQUE, data TEXT, digest TEXT, view INTEGER, mask_source TEXT);
      CREATE TABLE definitions (digest TEXT PRIMARY KEY, data TEXT);`);
    output.prepare("INSERT INTO identity VALUES (?)").run(JSON.stringify({ converter, derivative: sha, kind, fonts: fonts.identity }));
    const publish = output.prepare("INSERT INTO parts(id,data,digest,view,mask_source) VALUES (?,?,?,?,?)");
    const masks = dwgMaskContext(records, output);
    function save(part: Unit, maskSource = part.id) {
      part.coverage = "partial";
      part.locator.derivative = kind;
      part.limitations.push("cad_converted_handle_unverified");
      const data = JSON.stringify(part);
      publish.run(part.id, data, hash(data), Number(Boolean(part.locator.view)), maskSource);
      if (!part.locator.view) masks.record(part);
    }
    const geometry = dwgGeometry(records, output, sortEnabled, textPlan);
    const viewport = !recovery && (records.prepare(`SELECT 1 AS present FROM entities WHERE
      space<>'Model' AND json_extract(data,'$.type')='VIEWPORT' LIMIT 1`).get()
      ? dwgViewports(records, output, metadata.filter(r => r.type === "LAYER")) : undefined);
    const select = records.prepare(`
      SELECT ordinal,data,paper_block,redraw.sortkey,CASE WHEN duplicates.handle IS NULL AND
        (paper_block=0 OR duplicates_with_paper.handle IS NULL) THEN entities.handle END AS handle
      FROM entities LEFT JOIN duplicates USING(handle) LEFT JOIN duplicates_with_paper USING(handle)
        LEFT JOIN redraw USING(handle) WHERE space=? ORDER BY ordinal
    `);
    const historical = records.prepare("SELECT 1 FROM entities WHERE space=? AND paper_block=0 LIMIT 1");
    function space(name: string) {
      if (name.length > 300) throw new FormatHold("cad_layout_name_limit");
      const base = "space:" + short(name);
      const newSheetRows = !historical.get(name);
      let current = cadSpace();
      let part = 0, from = 1, start = 0, last = 0, text = 0, legacyShapes = 0;
      function flush(split: boolean) {
        const size = current.rows.length;
        const label = split ? `${name} · объекты ${from}–${from + size - 1}` : name;
        if (split) part++;
        // Older maps already exposed the empty sheet's ID. Keep it as the first part's link.
        const partId = !split || (newSheetRows && part === 1) ? base : `${base}:${part}`;
        const partUnit = unit(partId, label, {
          space: name, entityCount: size, ...(split ? { part, firstEntity: start, lastEntity: last } : {}),
        }, current.rows, [...new Set([...issues, ...current.limitations])]);
        partUnit.cad = sortEnabled ? current.shapes.sort(cadPaintOrder) : current.shapes;
        save(partUnit);
        from += size;
        current = cadSpace();
        text = 0;
        legacyShapes = 0;
        return partUnit;
      }
      function overlay(partUnit: Unit) {
        if (name !== "Model") return;
        for (const [name, frame] of views) {
          const rows = partUnit.rows.filter(({ bounds }) => bounds && bounds.x + bounds.width >= frame.x
            && bounds.x <= frame.x + frame.width && -bounds.y >= frame.y && -bounds.y - bounds.height <= frame.y + frame.height);
          if (!rows.length && part) continue;
          const id = "view:" + short(name) + (part ? ":" + part : "");
          const view = unit(id, part ? `${name} · часть ${part}` : name, {
            ...partUnit.locator, view: name, entityCount: rows.length,
          }, rows, [...partUnit.limitations.filter(code => code !== "cad_converted_handle_unverified"), "cad_view_projection_approximate"]);
          view.cad = partUnit.cad;
          view.cadView = frame;
          save(view, partUnit.id);
        }
      }
      for (const row of select.iterate(name)) {
        const number = Number(row.ordinal);
        const record = JSON.parse(String(row.data)) as Entity;
        const next = cadSpace();
        const handle = typeof row.handle === "string" ? row.handle : undefined;
        try {
          appendCadEntity(next, record, name, number, handle);
        } catch (error) {
          if (!(error instanceof FormatHold)) throw error;
          appendCadEntity(next, { ...record, limitation: error.code }, name, number, handle);
        }
        const [entity] = next.rows;
        const previousShapes = next.shapes.length;
        // Keep existing part boundaries and entity locators. Supplemental graphics
        // never participate in the legacy partition sizing.
        const bytes = Buffer.byteLength(JSON.stringify(entity));
        if (current.rows.length && (current.rows.length >= rowsPerPart
            || legacyShapes + previousShapes > shapesPerPart || text + bytes > textPerPart)) overlay(flush(true));
        const onPaper = record.type === "VIEWPORT" && name !== "Model" && viewport;
        const usedFonts = new Map<string, CadFontUse>();
        const specialized = ["HATCH", "WIPEOUT", "ACAD_PROXY_ENTITY"].includes(record.type);
        const enhanced = onPaper || specialized || ["INSERT", "DIMENSION", "ARC", "LWPOLYLINE"].includes(record.type);
        if (specialized) next.limitations.delete("cad_entity_type_unsupported");
        if (enhanced) {
          const address = handle ?? `ordinal:${number}`;
          const result = onPaper ? viewport.project(record, address) : geometry(record, address);
          if (result.shape) {
            next.shapes = [result.shape];
            next.limitations.delete("cad_entity_geometry_unavailable");
            next.limitations.delete("cad_entity_type_unsupported");
            next.limitations.delete("cad_polyline_segments_approximate");
            const { left, top, right, bottom } = cadShapeBounds(result.shape);
            entity.bounds = { x: left, y: -bottom, width: right - left, height: bottom - top };
          }
          for (const issue of result.limits) next.limitations.add(issue);
          if ("fonts" in result && result.fonts) mergeFontUses(usedFonts, result.fonts);
        } else if (!["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "LINE", "CIRCLE", "SEQEND"].includes(record.type)) {
          next.limitations.add("cad_entity_type_unsupported");
        }
        if (!enhanced) for (const shape of next.shapes) {
          if (!shape.text) continue;
          const plan = textPlan(shape,record);
          mergeFontUses(usedFonts,plan.fonts);
          for (const issue of plan.limits) next.limitations.add(issue);
        }
        if (row.paper_block) entity.locator.derivativeSection = "BLOCKS";
        if (!current.rows.length) start = number;
        last = number;
        if (handle) {
          delete entity.locator.handle;
          entity.locator.derivativeHandle = handle;
        }
        entity.details = { ...entity.details, entityOrdinal: number,
          ...(usedFonts.size ? { fonts: [...usedFonts.values()] } : {}),
          ...(next.limitations.size ? { limitations: [...next.limitations] } : {}) };
        current.rows.push(entity);
        const ordinal = String(number).padStart(16, "0");
        const baseOrder = sortEnabled && handle
          ? (typeof row.sortkey === "string" ? row.sortkey : handle.padStart(16, "0"))
          : sortEnabled ? "~~" : "";
        for (const shape of next.shapes) shape.order = `${baseOrder}:${ordinal}`;
        current.shapes.push(...next.shapes);
        if (name === "Model" && viewport) for (const shape of next.shapes) viewport.collect(shape);
        for (const limit of next.limitations) current.limitations.add(limit);
        text += bytes;
        legacyShapes += previousShapes;
      }
      overlay(flush(part > 0));
    }
    output.exec("BEGIN");
    records.exec("BEGIN");
    for (const name of layouts) space(name);
    for (const row of records.prepare("SELECT space FROM entities GROUP BY space ORDER BY min(ordinal)").iterate()) {
      const name = String(row.space);
      if (!layouts.has(name)) space(name);
    }
    masks.attach();
    output.exec("COMMIT");
    records.exec("COMMIT");
    records.close();
    records = undefined;
    output.close();
    output = undefined;
    if (!path) return new DwgIndex(new DatabaseSync(diskFile, { readOnly: true }), clean);
    try { await link(diskFile, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await clean();
    return (await openDwgIndex(pin!, fonts))!;
  } catch (error) {
    records?.close();
    output?.close();
    await clean();
    return indexError(error);
  }
}
