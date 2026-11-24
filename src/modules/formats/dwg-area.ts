import { cadBounds } from "./cad-bounds.js";
import type { CadArea, CadHatchLine, CadPath, CadPoint, CadShape } from "./model.js";
import { first, numeric } from "./spatial.js";
import type { Entity } from "./spatial.js";

const tau = 2 * Math.PI;
const angle = (x: number) => (x % 360) * Math.PI / 180;
const positive = (x: number) => (x % tau + tau) % tau;
const bounded = (x: number) => Number.isFinite(x) && Math.abs(x) <= 1e10;
const distance = (a: CadPoint, b: CadPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a: CadPoint, b: CadPoint) => distance(a, b) <= 1e-6
  + Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) * 1e-10;

export type CadDrawing = { shape?: CadShape; limits: string[] };
export const drawingBase = (record: Entity, handle: string) =>
  ({ handle, layer: first(record, 8) ?? "0", kind: record.type });

export function areaShape(record: Entity, handle: string, area: CadArea): CadShape {
  const boxes = area.loops.flatMap(loop => loop.map(([op, x, y, r = 0, start = 0, sweep = 0]) => {
    if (op !== "A") return { left: x, right: x, top: y, bottom: y };
    const angles = [start, start + sweep];
    for (const a of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      if (positive((a - start) * Math.sign(sweep)) <= Math.abs(sweep) + 1e-9) angles.push(a);
    }
    const points = angles.map(a => [x + r * Math.cos(a), y + r * Math.sin(a)]);
    return { left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])),
      top: Math.min(...points.map(p => p[1])), bottom: Math.max(...points.map(p => p[1])) };
  }));
  const bounds = cadBounds(boxes);
  return { ...drawingBase(record, handle), x: bounds.left, y: -bounds.top, bounds, area };
}

export function polygon(points: CadPoint[]): CadPath {
  return points.map(([x, y], i) => [i ? "L" : "M", x, y]);
}

function invalid(): never { throw new RangeError("DXF geometry"); }

export function readWipeout(record: Entity, handle: string): CadDrawing {
  if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
  const flags = numeric(record, 70) ?? 3;
  if (!(flags & 1)) return { limits: ["cad_entity_hidden"] };
  const x = numeric(record, 10), y = numeric(record, 20);
  const ux = numeric(record, 11), uy = numeric(record, 21);
  const vx = numeric(record, 12), vy = numeric(record, 22);
  const w = numeric(record, 13), h = numeric(record, 23);
  try {
    if (x === undefined || y === undefined || ux === undefined || uy === undefined || vx === undefined || vy === undefined
        || !w || !h || w < 0 || h < 0 || Math.abs(ux * vy - uy * vx) < 1e-15) invalid();
    const clip = Boolean(flags & 4) && numeric(record, 280) !== 0;
    if (clip && numeric(record, 290)) return { limits: ["cad_wipeout_inverse_clip_unsupported"] };
    const a = record.groups.filter(g => g.code === 14).map(g => Number(g.value));
    const b = record.groups.filter(g => g.code === 24).map(g => Number(g.value));
    let points: CadPoint[];
    if (!clip) points = [[-.5, .5], [w - .5, .5], [w - .5, .5 - h], [-.5, .5 - h]];
    else {
      if (a.length !== b.length || a.length !== numeric(record, 91) || a.length > 4096) invalid();
      if (numeric(record, 71) === 1 && a.length === 2) {
        points = [[a[0], b[0]], [a[1], b[0]], [a[1], b[1]], [a[0], b[1]]];
      } else if (numeric(record, 71) === 2 && a.length >= 3) points = a.map((u, i) => [u, b[i]]);
      else invalid();
    }
    // Clip coordinates are relative to pixel centers, with V increasing down in the clipping boundary.
    points = points.map(([u, v]) => [x + (u + .5) * ux + (.5 - v) * vx,
      -(y + (u + .5) * uy + (.5 - v) * vy)]);
    if (points.some(point => !point.every(bounded))) invalid();
    return { shape: areaShape(record, handle, { mode: "mask", loops: [polygon(points)] }), limits: [] };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { limits: ["cad_wipeout_boundary_invalid"] };
  }
}

export function readHatch(record: Entity, handle: string): CadDrawing {
  if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
  const normal = numeric(record, 230) ?? 1;
  if (numeric(record, 210) || numeric(record, 220) || Math.abs(Math.abs(normal) - 1) > 1e-8) {
    return { limits: ["cad_nonplanar_projection", "cad_hatch_boundary_invalid"] };
  }
  const groups = record.groups;
  let at = groups.findIndex(g => g.code === 91);
  const limits = new Set<string>();
  function optional(code: number) {
    if (groups[at]?.code !== code) return;
    const raw = groups[at++].value.trim();
    const value = Number(raw);
    if (!raw || !bounded(value)) invalid();
    return value;
  }
  const take = (code: number) => optional(code) ?? invalid();
  function count(code: number, max = 4096) {
    const n = take(code);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) invalid();
    return n;
  }
  const xy = (x: number, y: number): CadPoint => [take(x), take(y)];
  const svgPoint = ([x, y]: CadPoint): CadPoint => [normal < 0 ? -x : x, -y];
  function joins(a: CadPoint, b: CadPoint) {
    if (near(a, b)) return true;
    if (distance(a,b) > .001) return false;
    limits.add("cad_hatch_boundary_join_approximate");
    return true;
  }
  const pathCommand = (op: "M" | "L", p: CadPoint): CadPath[number] => [op, ...svgPoint(p)];
  function arcCommand(center: CadPoint, radius: number, start: number, sweep: number): CadPath[number] {
    const a = normal < 0 ? Math.PI + start : -start;
    return ["A", ...svgPoint(center), radius, a, normal < 0 ? sweep : -sweep];
  }
  try {
    const total = count(91);
    const loops: { flags: number; path: CadPath }[] = [];
    for (let i = 0; i < total; i++) {
      const flags = count(92, 255);
      const path: CadPath = [];
      if (flags & 2) {
        const bulges = take(72), closed = take(73);
        const n = count(93);
        const points: CadPoint[] = [], bulge: number[] = [];
        for (let j = 0; j < n; j++) {
          points.push(xy(10, 20));
          bulge.push(bulges ? optional(42) ?? 0 : 0);
        }
        if (n < 2 || !closed && !near(points[0], points[n - 1])) invalid();
        path.push(pathCommand("M", points[0]));
        for (let j = 0; j < n; j++) {
          const a = points[j], b = points[(j + 1) % n], bulgeValue = bulge[j];
          if (near(a, b)) continue;
          if (Math.abs(bulgeValue) < 1e-10) path.push(pathCommand("L", b));
          else {
            const offset = (1 / bulgeValue - bulgeValue) / 4;
            const cx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * offset;
            const cy = (a[1] + b[1]) / 2 + (b[0] - a[0]) * offset;
            const radius = Math.hypot(a[0] - cx, a[1] - cy);
            if (![cx, cy, radius].every(bounded)) invalid();
            path.push(arcCommand([cx, cy], radius, Math.atan2(a[1] - cy, a[0] - cx), 4 * Math.atan(bulgeValue)));
          }
        }
      } else {
        const n = count(93);
        let previous: CadPoint | undefined, beginning: CadPoint | undefined;
        for (let j = 0; j < n; j++) {
          const type = take(72);
          let start: CadPoint, end: CadPoint, rest: CadPath;
          if (type === 1) {
            start = xy(10, 20); end = xy(11, 21);
            if (previous && !near(previous, start) && joins(previous, end)) [start, end] = [end, start];
            rest = [pathCommand("L", end)];
          } else if (type === 2 || type === 3) {
            const center = xy(10, 20), major = type === 3 ? xy(11, 21) : undefined;
            const r = take(40);
            if (!(r > 0)) invalid();
            let a = angle(take(50)), z = angle(take(51));
            // DXF stores complementary angles for edges traversed clockwise.
            const ccw = take(73);
            if (major) {
              if (r > 1) invalid();
              const parameter = (t: number) => Math.atan2(Math.sin(t) / r, Math.cos(t));
              a = parameter(a); z = parameter(z);
            }
            let sweep = positive(z - a) || tau;
            if (!ccw) { a = -a; sweep = -sweep; }
            const position = (t: number): CadPoint => major
              ? [center[0] + major[0] * Math.cos(t) - major[1] * r * Math.sin(t),
                center[1] + major[1] * Math.cos(t) + major[0] * r * Math.sin(t)]
              : [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)];
            start = position(a); end = position(a + sweep);
            if (previous && !near(previous, start) && joins(previous, end)) {
              [start, end] = [end, start]; a += sweep; sweep = -sweep;
            }
            if (major) {
              const sections = Math.max(6, Math.ceil(Math.abs(sweep) * 32));
              rest = Array.from({ length: sections }, (_, k) => pathCommand("L", position(a + sweep * (k + 1) / sections)));
              limits.add("cad_hatch_ellipse_tessellated");
            } else rest = [arcCommand(center, r, a, sweep)];
          } else return { limits: ["cad_hatch_edge_unsupported"] };
          if (!previous) { beginning = start; path.push(pathCommand("M", start)); }
          else if (!joins(previous, start)) invalid();
          path.push(...rest);
          previous = end;
        }
        if (!beginning || !previous || !joins(beginning, previous)) invalid();
      }
      optional(97);
      if (path.length < 2) invalid();
      loops.push({ flags, path });
    }
    const style = take(75);
    if (![0, 1, 2].includes(style)) invalid();
    const boundaries = loops.filter(({ flags }) => style === 0 || (flags & 1) || (style === 1 && (flags & 16)));
    if (!boundaries.length) invalid();
    const solid = first(record, 70) === "1";
    const pattern: CadHatchLine[] = [];
    if (!solid) {
      at = groups.findIndex((g, i) => i >= at && g.code === 78);
      const n = count(78, 128);
      if (!n) invalid();
      for (let i = 0; i < n; i++) {
        const a = angle(take(53)), base = xy(43, 44), step = xy(45, 46), m = count(79, 128);
        const dashes = Array.from({ length: m }, () => take(49));
        pattern.push({ base: svgPoint(base), direction: svgPoint([Math.cos(a), Math.sin(a)]), step: svgPoint(step), dashes });
      }
    }
    if (first(record, 450) === "1") limits.add("cad_hatch_gradient_approximate");
    return { shape: areaShape(record, handle, { mode: solid ? "solid" : "pattern",
      loops: boundaries.map(b => b.path), ...(pattern.length ? { pattern } : {}) }), limits: [...limits] };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { limits: ["cad_hatch_boundary_invalid"] };
  }
}
