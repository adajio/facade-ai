import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { cadBounds, cadShapeBounds } from "./cad-bounds.js";
import type { CadBlockUse, CadBounds, CadDefinition, CadPath, CadShape } from "./model.js";
import { appendCadEntity, cadSpace, first, numeric } from "./spatial.js";
import { FormatHold } from "./model.js";
import type { Entity } from "./spatial.js";

const tau = 2 * Math.PI;
const radians = (degrees: number) => (degrees % 360) * Math.PI / 180;
const positiveAngle = (angle: number) => (angle % tau + tau) % tau;
const bound = 1e9;
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) <= bound;
const projection = "cad_block_projection_partial";
const unavailable = "cad_entity_geometry_unavailable";
const unsupported = "cad_entity_type_unsupported";
const limited = "cad_block_geometry_limit";
const maximumDepth = 16;
const maximumElements = 6000;
const maximumBytes = 2 * 1024 ** 2;

export const geometryDigest = (data: string) => createHash("sha256").update(data).digest("hex");
export const blockKey = (value?: string) => value && value.length <= 300 ? value.toUpperCase() : undefined;

type Result = { shape?: CadShape; limits: string[] };
type Point = [number, number];
type Matrix = CadBlockUse["matrix"];
type Block = { digest?: string; bounds?: CadBounds; x: number; y: number; limits: string[] };

const point = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y });
const quad = ({ left, right, top, bottom }: CadBounds): Point[] =>
  [[left, top], [left, bottom], [right, top], [right, bottom]];
const empty = (limits: string[]): Block => ({ x: 0, y: 0, limits });
const shapeBase = (record: Entity, handle: string) => ({ handle, layer: first(record, 8) ?? "0", kind: record.type });
const has = (record: Entity, code: number) => first(record, code) !== undefined;

function planar(record: Entity) {
  return [[210, 0], [220, 0], [230, 1]].every(([code, normal]) =>
    !has(record, code) || Math.abs((numeric(record, code) ?? Infinity) - normal) < 1e-10);
}

function arc(cx: number, cy: number, radius: number, start: number, sweep: number, end: Point) {
  const angles = [start, start + sweep];
  for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    if (positiveAngle((angle - start) * Math.sign(sweep)) <= Math.abs(sweep)) angles.push(angle);
  }
  const extrema = angles.map(a => point(cx + radius * Math.cos(a), -(cy + radius * Math.sin(a))));
  return { bounds: cadBounds([...extrema, point(end[0], -end[1])]),
    path: ["A", cx, -cy, radius, -start, -sweep] as const };
}

function polyline(record: Entity, handle: string): Result {
  const vertices: Array<{ x: number; y?: number; bulge: number }> = [];
  for (const { code, value } of record.groups) {
    const n = value.trim() === "" ? NaN : Number(value);
    const vertex = vertices.at(-1);
    if (code === 10) vertices.push({ x: n, bulge: 0 });
    if (code === 20 && vertex) vertex.y = n;
    if (code === 42 && vertex) vertex.bulge = n;
  }
  if (vertices.length < 2 || vertices.length > 1000 || !vertices.every(
    ({ x, y, bulge }) => finite(x) && y !== undefined && finite(y) && finite(bulge),
  )) return { limits: [unavailable] };
  const { x, y } = vertices[0];
  const bounds = [point(x, -y!)];
  const commands: CadPath = [["M", x, -y!]];
  if (Number(first(record, 70)) & 1) vertices.push(vertices[0]);
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1], b = vertices[i];
    const dx = b.x - a.x, dy = b.y! - a.y!;
    if (!dx && !dy) continue;
    if (Math.abs(a.bulge) < 1e-10) {
      bounds.push(point(b.x, -b.y!));
      commands.push(["L", b.x, -b.y!]);
      continue;
    }
    const offset = (1 / a.bulge - a.bulge) / 4;
    const cx = (a.x + b.x) / 2 - dy * offset;
    const cy = (a.y! + b.y!) / 2 + dx * offset;
    const radius = Math.hypot(a.x - cx, a.y! - cy);
    if (![cx, cy, radius].every(finite)) return { limits: [unavailable] };
    const segment = arc(cx, cy, radius, Math.atan2(a.y! - cy, a.x - cx), 4 * Math.atan(a.bulge), [b.x, b.y!]);
    bounds.push(segment.bounds);
    commands.push([...segment.path]);
  }
  if (commands.length === 1) return { limits: [unavailable] };
  const limits = record.groups.some(({ code, value }) => [40, 41, 43].includes(code) && Number(value))
    ? ["cad_polyline_segments_approximate"] : [];
  return { shape: { ...shapeBase(record, handle), x, y: y!, path: commands, bounds: cadBounds(bounds) }, limits };
}

export function dwgCurve(record: Entity, handle: string): Result {
  if (record.limitation) return { limits: [record.limitation] };
  if (!planar(record)) return { limits: ["cad_nonplanar_projection", unavailable] };
  if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
  if (record.type === "LWPOLYLINE") return polyline(record, handle);
  const x = numeric(record, 10), y = numeric(record, 20), radius = numeric(record, 40);
  const start = numeric(record, 50), end = numeric(record, 51);
  if (x === undefined || y === undefined || !radius || radius <= 0 || start === undefined || end === undefined) {
    return { limits: [unavailable] };
  }
  const angle = radians(start), stop = radians(end);
  const sweep = positiveAngle(stop - angle);
  if (sweep < 1e-10) return { limits: [unavailable] };
  const p1: Point = [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
  const p2: Point = [x + radius * Math.cos(stop), y + radius * Math.sin(stop)];
  const shot = arc(x, y, radius, angle, sweep, p2);
  return { limits: [], shape: { ...shapeBase(record, handle), x, y, bounds: shot.bounds,
    path: [["M", p1[0], -p1[1]], [...shot.path]] } };
}

function matrix(record: Entity, block: Block): Matrix | undefined {
  if (record.type === "DIMENSION") return [1, 0, 0, 1, 0, 0]; // DXF stores the dimension picture at its drawn coordinates.
  const x = numeric(record, 10), y = numeric(record, 20);
  if (x === undefined || y === undefined || [41, 42, 50, 70, 71].some(code =>
    has(record, code) && numeric(record, code) === undefined)) return;
  const sx = numeric(record, 41) ?? 1, sy = numeric(record, 42) ?? 1;
  if (Math.abs(sx) < 1e-12 || Math.abs(sy) < 1e-12 || (numeric(record, 70) ?? 1) > 1
      || (numeric(record, 71) ?? 1) > 1) return;
  const angle = radians(numeric(record, 50) ?? 0);
  const a = sx * Math.cos(angle), b = -sx * Math.sin(angle);
  const c = sy * Math.sin(angle), d = sy * Math.cos(angle);
  return [a, b, c, d, x - a * block.x + c * block.y, -y - b * block.x + d * block.y];
}

/** Store each referenced definition once. Child definitions are authenticated by their digest. */
export function dwgGeometry(source: DatabaseSync, output: DatabaseSync) {
  const find = source.prepare("SELECT data,ambiguous FROM block_headers WHERE name=?");
  const children = Array.from({ length: maximumDepth }, () =>
    source.prepare("SELECT data FROM block_entities WHERE name=? ORDER BY ordinal"));
  const cached = source.prepare("SELECT data FROM block_compiled WHERE name=?");
  const cache = source.prepare("INSERT INTO block_compiled VALUES (?,?)");
  const publish = output.prepare("INSERT OR IGNORE INTO definitions VALUES (?,?)");
  const recent = new Map<string, Block>();
  const active = new Set<string>();
  let visited = 0;

  function definition(key: string): Block {
    if (active.has(key)) return empty(["cad_block_cycle"]);
    if (active.size >= maximumDepth || ++visited > maximumElements) return empty([limited]);
    const memory = recent.get(key);
    if (memory) return memory;
    const stored = cached.get(key);
    if (stored) return JSON.parse(String(stored.data)) as Block;
    const row = find.get(key);
    if (!row || row.ambiguous) return empty(["cad_block_definition_unavailable"]);
    const record = JSON.parse(String(row.data)) as Entity;
    if ((Number(first(record, 70)) & 12) || first(record, 1)) return empty(["cad_external_reference"]);
    if (record.limitation) return empty([record.limitation]);
    active.add(key);
    const shapes: CadShape[] = [];
    const limits = new Set<string>();
    let count = 0, bytes = 0;
    try {
      for (const child of children[active.size - 1].iterate(key)) {
        if (++count > maximumElements) { limits.add(limited); break; }
        const entity = JSON.parse(String(child.data)) as Entity;
        const { shape, limits: issues } = leaf(entity, String(count));
        for (const issue of issues) limits.add(issue);
        if (shape) {
          bytes += Buffer.byteLength(JSON.stringify(shape));
          if (bytes > maximumBytes) { limits.add(limited); break; }
          shapes.push(shape);
        }
      }
    } finally {
      active.delete(key);
    }
    const block: Block = { x: numeric(record, 10) ?? 0, y: numeric(record, 20) ?? 0, limits: [...limits] };
    if (shapes.length) {
      const definition: CadDefinition = { shapes };
      const data = JSON.stringify(definition);
      block.digest = geometryDigest(data);
      block.bounds = cadBounds(shapes.map(cadShapeBounds));
      publish.run(block.digest, data);
    }
    // These limits can depend on the traversal's parent. Try the same block independently as a root.
    if (!limits.has(limited) && !limits.has("cad_block_cycle")) {
      cache.run(key, JSON.stringify(block));
      if (recent.size >= 1024) recent.delete(recent.keys().next().value!);
      recent.set(key, block);
    }
    return block;
  }

  function reference(record: Entity, handle: string): Result {
    if (record.limitation) return { limits: [record.limitation] };
    if (!planar(record)) return { limits: ["cad_nonplanar_projection", unavailable] };
    if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
    const key = blockKey(first(record, 2));
    if (!key) return { limits: ["cad_block_definition_unavailable"] };
    const block = definition(key);
    if (!block.digest || !block.bounds) return { limits: block.limits.length ? block.limits : [unavailable] };
    const transform = matrix(record, block);
    if (!transform?.every(finite)) return { limits: ["cad_block_transform_unsupported"] };
    const [a, b, c, d, x, y] = transform;
    const bounds = cadBounds(quad(block.bounds).map(([u, v]) => point(a * u + c * v + x, b * u + d * v + y)));
    if (!Object.values(bounds).every(finite)) return { limits: ["cad_block_transform_unsupported"] };
    return {
      shape: { ...shapeBase(record, handle), x, y: -y, bounds, block: { digest: block.digest, matrix: transform } },
      limits: block.limits.length ? [projection, ...block.limits] : [],
    };
  }

  function leaf(record: Entity, handle: string): Result {
    if (record.type === "INSERT" || record.type === "DIMENSION") return reference(record, handle);
    if (record.type === "ARC" || record.type === "LWPOLYLINE") return dwgCurve(record, handle);
    if (record.type === "SEQEND") return { limits: [] };
    // Points, attribute templates, and unsupported entity data are not a substitute for a drawing.
    if (!["LINE", "CIRCLE", "TEXT", "MTEXT", "ATTRIB"].includes(record.type)) return { limits: [unsupported] };
    if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
    if (record.type !== "LINE" && !planar(record)) return { limits: ["cad_nonplanar_projection", unavailable] };
    const local = cadSpace();
    try { appendCadEntity(local, record, "", 0, handle); }
    catch (error) {
      if (!(error instanceof FormatHold)) throw error;
      return { limits: [error.code] };
    }
    const shape = local.shapes[0];
    if (shape && shape.x2 === shape.x && shape.y2 === shape.y) return { limits: [unavailable] };
    return { shape, limits: [...local.limitations] };
  }

  return (record: Entity, handle: string) => {
    visited = 0;
    return leaf(record, handle);
  };
}
