import type { DatabaseSync } from "node:sqlite";
import { cadShapeBounds } from "./cad-bounds.js";
import { geometryDigest } from "./dwg-geometry.js";
import type { CadBounds, CadDefinition, CadShape } from "./model.js";
import { first, numeric } from "./spatial.js";
import type { Entity } from "./spatial.js";

const unsupported = "cad_viewport_projection_unsupported";
const limited = "cad_viewport_geometry_limit";
const schematic = "cad_viewport_projection_partial";

export function dwgViewports(scratch: DatabaseSync, index: DatabaseSync, layers: Entity[]) {
  const names = new Map<string, string>();
  const globallyHidden = new Set<string>();
  for (const layer of layers) {
    const handle = first(layer, 5)?.toUpperCase(), name = first(layer, 2)?.toUpperCase();
    if (!handle || !name) continue;
    names.set(handle, name);
    if ((Number(first(layer, 70)) & 1) || (numeric(layer, 62) ?? 0) < 0) globallyHidden.add(name);
  }
  scratch.exec(`CREATE TABLE model_geometry (
    id INTEGER PRIMARY KEY, left REAL, right REAL, top REAL, bottom REAL, data TEXT
  ); CREATE TABLE viewport_defs (params TEXT PRIMARY KEY, digest TEXT);`);
  const collect = scratch.prepare("INSERT INTO model_geometry(left,right,top,bottom,data) VALUES (?,?,?,?,?)");
  const candidates = scratch.prepare(`
    SELECT data FROM model_geometry WHERE right>=? AND left<=? AND bottom>=? AND top<=? ORDER BY id
  `);
  const find = index.prepare("SELECT data FROM definitions WHERE digest=?");
  const store = index.prepare("INSERT OR IGNORE INTO definitions VALUES (?,?)");
  const cached = scratch.prepare("SELECT digest FROM viewport_defs WHERE params=?");
  const cache = scratch.prepare("INSERT INTO viewport_defs VALUES (?,?)");

  function save(shapes: CadShape[]) {
    const data = JSON.stringify({ shapes } satisfies CadDefinition);
    const digest = geometryDigest(data);
    store.run(digest, data);
    return digest;
  }

  function project(record: Entity, handle: string) {
    if (record.limitation) return { limits: [record.limitation] };
    const id = numeric(record, 69), status = numeric(record, 68);
    if (id === 1 || status === 0 || (Number(first(record, 90)) & 0x20000)) return { limits: ["cad_viewport_inactive"] };
    const blocked = 0x1 | 0x2 | 0x4 | 0x10 | 0x800 | 0x10000;
    const direction = [[16, 0], [26, 0], [36, 1], [51, 0], [281, 0]];
    if (!id || !status || status < 0 || (Number(first(record, 90)) & blocked) || first(record, 340)
        || direction.some(([key, v]) => (numeric(record, key) ?? (key === 36 ? 1 : 0)) !== v)) {
      return { limits: [unsupported] };
    }
    const ox = numeric(record, 10), oy = numeric(record, 20);
    const width = numeric(record, 40), height = numeric(record, 41);
    const mx = numeric(record, 12), my = numeric(record, 22), modelHeight = numeric(record, 45);
    if (ox === undefined || oy === undefined || mx === undefined || my === undefined
        || !width || !height || !modelHeight || width < 0 || height < 0 || modelHeight < 0) return { limits: [unsupported] };
    const scale = height / modelHeight;
    const centerX = mx + (numeric(record, 17) ?? 0), centerY = my + (numeric(record, 27) ?? 0);
    if (!Number.isFinite(width / scale) || scale < 1e-9 || scale > 1e9 || width / scale > 2e9) return { limits: [unsupported] };
    const frozen = new Set(globallyHidden);
    for (const group of record.groups) {
      if (group.code !== 331) continue;
      const name = names.get(group.value.trim().toUpperCase());
      if (!name) return { limits: ["cad_viewport_layer_unconfirmed"] };
      frozen.add(name);
    }
    const params = geometryDigest(JSON.stringify([...frozen].sort()));
    const clip: CadBounds = { left: ox - width / 2, right: ox + width / 2, top: -oy - height / 2, bottom: -oy + height / 2 };
    const halfWidth = width / scale / 2, halfHeight = modelHeight / 2;
    const shapes: CadShape[] = [];
    let bytes = 0, examined = 0, definitions = 0;
    const recent = new Map<string, string>();
    function allowed(shape: CadShape, parent = "0"): CadShape | undefined {
      const layer = shape.layer === "0" ? parent : shape.layer.toUpperCase();
      if (frozen.has(layer)) return;
      if (!shape.block) return shape;
      const { digest } = shape.block;
      const key = JSON.stringify([params, digest, layer]);
      let filtered = recent.get(key) ?? cached.get(key)?.digest;
      if (filtered === undefined) {
        if (++definitions > 8192) return;
        const start = find.get(digest)?.data;
        if (typeof start !== "string" || geometryDigest(start) !== digest) return;
        const original = (JSON.parse(start) as CadDefinition).shapes;
        const kept = original.map(child => allowed(child, layer)).filter(child => child !== undefined);
        filtered = kept.length === original.length && kept.every((child, i) => child === original[i]) ? digest
          : kept.length ? save(kept) : "";
        cache.run(key, filtered);
        if (recent.size <= 1024) recent.set(key, filtered);
      }
      if (typeof filtered !== "string" || !filtered) return;
      return digest === filtered ? shape : { ...shape, block: { ...shape.block, digest: filtered } };
    }
    for (const { data } of candidates.iterate(centerX - halfWidth, centerX + halfWidth, -centerY - halfHeight, -centerY + halfHeight)) {
      if (++examined > 16000 || definitions > 8192) return { limits: [limited] };
      const shape = allowed(JSON.parse(String(data)) as CadShape);
      if (!shape) continue;
      bytes += Buffer.byteLength(String(data));
      if (bytes > 8 * 1024 ** 2) return { limits: [limited] };
      shapes.push(shape);
    }
    if (!shapes.length) return { limits: ["cad_viewport_geometry_unavailable"] };
    const shape: CadShape = { handle, kind: record.type, layer: first(record, 8) ?? "0", x: ox, y: oy,
      block: { digest: save(shapes), matrix: [scale, 0, 0, scale, ox - scale * centerX, -oy + scale * centerY] },
      bounds: clip, clip };
    return { shape, limits: [schematic] };
  }

  return {
    project,
    collect(shape: CadShape) {
      const { left, right, top, bottom } = cadShapeBounds(shape);
      collect.run(left, right, top, bottom, JSON.stringify(shape));
    },
  };
}
