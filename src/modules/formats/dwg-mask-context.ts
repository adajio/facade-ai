import type { DatabaseSync } from "node:sqlite";
import { ReaderError } from "../pdf/types.js";
import { cadBounds, cadPaintOrder, cadShapeBounds, transformCadBounds } from "./cad-bounds.js";
import { geometryDigest } from "./dwg-geometry.js";
import type { CadBounds, CadDefinition, CadShape, Unit } from "./model.js";

type Filtered = { digest: string; bounds: CadBounds };
const limit = "cad_mask_context_limit";

/** Keep cross-part masks in the drawing plane and out of the address inventory. */
export function dwgMaskContext(scratch: DatabaseSync, output: DatabaseSync) {
  scratch.exec(`
    CREATE TABLE mask_definitions (source TEXT PRIMARY KEY, filtered TEXT);
    CREATE TABLE mask_placements (
      part TEXT, space TEXT, sortkey TEXT, left REAL, right REAL, top REAL, bottom REAL, data TEXT
    );
    CREATE INDEX mask_placements_space ON mask_placements(space,sortkey);
  `);
  const find = output.prepare("SELECT data FROM definitions WHERE digest=?");
  const save = output.prepare("INSERT OR IGNORE INTO definitions VALUES (?,?)");
  const cached = scratch.prepare("SELECT filtered FROM mask_definitions WHERE source=?");
  const remember = scratch.prepare("INSERT INTO mask_definitions VALUES (?,?)");
  const add = scratch.prepare("INSERT INTO mask_placements VALUES (?,?,?,?,?,?,?,?)");
  const maskCount = scratch.prepare("SELECT 1 FROM mask_placements LIMIT 1");
  const related = scratch.prepare(`
    SELECT data FROM mask_placements WHERE space=? AND part<>? AND sortkey>?
      AND right>=? AND left<=? AND bottom>=? AND top<=?
    ORDER BY sortkey
  `);

  function filtered(digest: string, depth: number): Filtered | undefined {
    const existing = cached.get(digest);
    if (existing) return existing.filtered ? JSON.parse(String(existing.filtered)) as Filtered : undefined;
    const raw = find.get(digest)?.data;
    if (depth > 18 || typeof raw !== "string" || geometryDigest(raw) !== digest) {
      throw new ReaderError("dwg_index_invalid", "Определение блока маски DWG не подтверждено", 424);
    }
    const { shapes } = JSON.parse(raw) as CadDefinition;
    const masked = shapes.map(shape => onlyMask(shape, depth + 1)).filter(shape => shape !== undefined);
    if (!masked.length) {
      remember.run(digest, null);
      return;
    }
    const data = JSON.stringify({ shapes: masked } satisfies CadDefinition);
    const result = { digest: geometryDigest(data), bounds: cadBounds(masked.map(cadShapeBounds)) };
    save.run(result.digest, data);
    remember.run(digest, JSON.stringify(result));
    return result;
  }

  function onlyMask(shape: CadShape, depth = 0): CadShape | undefined {
    if (shape.area?.mode === "mask") return shape;
    // A viewport already composes the corresponding Model window together.
    if (!shape.block || shape.kind === "VIEWPORT") return;
    const { digest, matrix } = shape.block;
    const mask = filtered(digest, depth);
    if (!mask) return;
    return { ...shape, block: { matrix, digest: mask.digest }, bounds: transformCadBounds(matrix, mask.bounds) };
  }

  function record(unit: Unit) {
    for (const shape of unit.cad ?? []) {
      const mask = onlyMask(shape);
      if (!mask) continue;
      const { left, right, top, bottom } = cadShapeBounds(mask);
      add.run(unit.id, unit.locator.space, shape.order!, left, right, top, bottom, JSON.stringify(mask));
    }
  }

  function attach() {
    if (!maskCount.get()) return;
    const next = output.prepare("SELECT ordinal,data,mask_source FROM parts WHERE ordinal>? ORDER BY ordinal LIMIT 1");
    const set = output.prepare("UPDATE parts SET data=?,digest=? WHERE ordinal=?");
    let ordinal = 0;
    for (;;) {
      const row = next.get(ordinal);
      if (!row) break;
      ordinal = Number(row.ordinal);
      const unit = JSON.parse(String(row.data)) as Unit;
      if (!unit.cad?.length) continue;
      const bounds = cadBounds(unit.cad.map(cadShapeBounds));
      const first = unit.cad.reduce((a, b) => cadPaintOrder(a, b) <= 0 ? a : b);
      const context: CadShape[] = [];
      let size = 0;
      for (const { data } of related.iterate(unit.locator.space, row.mask_source!, first.order!,
        bounds.left, bounds.right, bounds.top, bounds.bottom)) {
        const raw = String(data);
        size += Buffer.byteLength(raw);
        if (size > 2 * 1024 ** 2 || context.length >= 4096) {
          unit.limitations.push(limit);
          break;
        }
        context.push(JSON.parse(raw) as CadShape);
      }
      if (unit.limitations.includes(limit)) unit.cadContext = [];
      else if (context.length) unit.cadContext = context;
      else continue;
      const data = JSON.stringify(unit);
      set.run(data, geometryDigest(data), ordinal);
    }
  }

  return { record, attach };
}
