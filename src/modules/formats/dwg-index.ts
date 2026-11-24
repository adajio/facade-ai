import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReaderError } from "../pdf/types.js";
import type { ReaderUnit, SourceRef } from "../pdf/types.js";
import { derivativeLines, derivativeText, dxfBytes, dxfValue } from "./dwg-text.js";
import { recoveryObjects } from "./dwg-recovery.js";
import { FormatHold, unit } from "./model.js";
import type { Unit } from "./model.js";
import { appendCadEntity, cadMetadata, cadSpace, convertedDxfRecords, first, recoveryCadRecords } from "./spatial.js";
import type { Entity } from "./spatial.js";

export const dwgReaderProfile = "formats-1.1.4";
const rowsPerPart = 512;
const shapesPerPart = 6000;
const textPerPart = 2 * 1024 ** 2;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const short = (value: string) => hash(value).slice(0, 24);

type Pin = { source: SourceRef; converter: string; reserve: number };
type IndexedUnit = { unit: Unit; digest: string };
type IndexIdentity = { converter: string; derivative: string; kind: "dxf" | "dwg-json" };

function location(pin: Pin) {
  if (!process.env.FACADE_DATA_DIR) return;
  return join(process.env.FACADE_DATA_DIR, "dwg-index", hash(JSON.stringify([
    dwgReaderProfile, pin.source.projectId, pin.source.sha256, pin.converter,
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
  async close() {
    try { this.db.close(); } finally { await this.dispose?.(); }
  }
}

export async function openDwgIndex(pin: Pin): Promise<DwgIndex | undefined> {
  const path = location(pin);
  if (!path) return;
  if (!(await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (!cacheUnavailable(error)) throw error;
  }))) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const index = new DwgIndex(db);
    if (index.identity.converter !== pin.converter) throw new ReaderError(
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

export async function buildDwgIndex(file: FileHandle, sha: string, converter: string, pin?: Pin): Promise<DwgIndex> {
  let path = pin && location(pin);
  let root = path ? join(path, "..") : tmpdir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!path || !cacheUnavailable(error)) return indexError(error);
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
    if (!path || !cacheUnavailable(error)) return indexError(error);
    path = undefined;
    const temporary = await statfs(tmpdir(), { bigint: true });
    capacity = temporary.bavail * temporary.bsize - BigInt(pin?.reserve ?? 0);
    if (capacity < 1024n * 1024n) {
      throw new ReaderError("dwg_index_scratch_unavailable", "Недостаточно места для временного индекса DWG", 503);
    }
    tmp = await mkdtemp(join(tmpdir(), ".dwg-"));
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
      CREATE TABLE entities (ordinal INTEGER PRIMARY KEY, data TEXT, handle TEXT, direct TEXT, owner TEXT, paper INTEGER, space TEXT);
      CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT);
    `);
    const metadata: Entity[] = [];
    let metadataBytes = 0;
    let ordinal = 0;
    const insert = records.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,NULL)");
    records.exec("BEGIN");
    for await (const { entity, record } of source) {
      const raw = JSON.stringify(record);
      if (entity) {
        const handle = first(record, 5)?.toUpperCase();
        insert.run(++ordinal, raw, handle && /^[0-9A-F]{1,16}$/.test(handle) ? handle : null,
          first(record, 410) || null, first(record, 330)?.toUpperCase() ?? null, Number(first(record, 67) === "1"));
      } else {
        metadataBytes += Buffer.byteLength(raw);
        if (metadataBytes > 8 * 1024 ** 2) throw new FormatHold("cad_metadata_limit");
        metadata.push(record);
      }
    }
    records.exec("COMMIT");
    const { layouts, ownerLayouts, views } = cadMetadata(metadata, issues);
    const owner = records.prepare("INSERT INTO owners VALUES (?,?)");
    for (const [id, name] of ownerLayouts) owner.run(id, name);
    records.exec(`
      UPDATE entities SET space=coalesce(direct, (SELECT name FROM owners WHERE id=entities.owner),
        CASE paper WHEN 1 THEN 'Paper' ELSE 'Model' END);
      CREATE INDEX entities_space ON entities(space,ordinal);
      CREATE INDEX entities_handle ON entities(handle);
      CREATE TABLE duplicates (handle TEXT PRIMARY KEY);
      INSERT INTO duplicates SELECT handle FROM entities WHERE handle IS NOT NULL GROUP BY handle HAVING count(*)>1;
    `);
    const diskFile = join(tmp, "index.sqlite");
    output = new DatabaseSync(diskFile);
    budget(output, capacity / 3n);
    output.exec(`CREATE TABLE identity (data TEXT); CREATE TABLE parts (
      ordinal INTEGER PRIMARY KEY, id TEXT UNIQUE, data TEXT, digest TEXT, view INTEGER);`);
    output.prepare("INSERT INTO identity VALUES (?)").run(JSON.stringify({ converter, derivative: sha, kind }));
    const publish = output.prepare("INSERT INTO parts(id,data,digest,view) VALUES (?,?,?,?)");
    function save(part: Unit) {
      part.coverage = "partial";
      part.locator.derivative = kind;
      part.limitations.push("cad_converted_handle_unverified");
      const data = JSON.stringify(part);
      publish.run(part.id, data, hash(data), Number(Boolean(part.locator.view)));
    }
    const select = records.prepare(`
      SELECT ordinal,data,CASE WHEN duplicates.handle IS NULL THEN entities.handle END AS handle
      FROM entities LEFT JOIN duplicates USING(handle) WHERE space=? ORDER BY ordinal
    `);
    function space(name: string) {
      if (name.length > 300) throw new FormatHold("cad_layout_name_limit");
      const base = "space:" + short(name);
      let current = cadSpace();
      let part = 0, from = 1, start = 0, last = 0, text = 0;
      function flush(split: boolean) {
        const size = current.rows.length;
        const label = split ? `${name} · объекты ${from}–${from + size - 1}` : name;
        const partUnit = unit(split ? `${base}:${++part}` : base, label, {
          space: name, entityCount: size, ...(split ? { part, firstEntity: start, lastEntity: last } : {}),
        }, current.rows, [...new Set([...issues, ...current.limitations])]);
        partUnit.cad = current.shapes;
        save(partUnit);
        from += size;
        current = cadSpace();
        text = 0;
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
          save(view);
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
        if (!["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "LINE", "CIRCLE", "LWPOLYLINE"].includes(record.type)) {
          next.limitations.add("cad_entity_type_unsupported");
        }
        const bytes = Buffer.byteLength(JSON.stringify(entity));
        if (current.rows.length && (current.rows.length >= rowsPerPart
            || current.shapes.length + next.shapes.length > shapesPerPart || text + bytes > textPerPart)) overlay(flush(true));
        if (!current.rows.length) start = number;
        last = number;
        if (handle) {
          delete entity.locator.handle;
          entity.locator.derivativeHandle = handle;
        }
        entity.details = { ...entity.details, entityOrdinal: number,
          ...(next.limitations.size ? { limitations: [...next.limitations] } : {}) };
        current.rows.push(entity);
        current.shapes.push(...next.shapes);
        for (const limit of next.limitations) current.limitations.add(limit);
        text += bytes;
      }
      overlay(flush(part > 0));
    }
    output.exec("BEGIN");
    for (const name of layouts) space(name);
    for (const row of records.prepare("SELECT space FROM entities GROUP BY space ORDER BY min(ordinal)").iterate()) {
      const name = String(row.space);
      if (!layouts.has(name)) space(name);
    }
    output.exec("COMMIT");
    records.close();
    records = undefined;
    output.close();
    output = undefined;
    if (!path) return new DwgIndex(new DatabaseSync(diskFile, { readOnly: true }), clean);
    try { await link(diskFile, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await clean();
    return (await openDwgIndex(pin!))!;
  } catch (error) {
    records?.close();
    output?.close();
    await clean();
    return indexError(error);
  }
}
