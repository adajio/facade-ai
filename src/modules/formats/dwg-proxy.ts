import { cadBounds, cadShapeBounds } from "./cad-bounds.js";
import { areaShape, drawingBase, polygon } from "./dwg-area.js";
import type { CadDrawing } from "./dwg-area.js";
import type { CadPath, CadPoint, CadShape } from "./model.js";
import { numeric } from "./spatial.js";
import type { Entity } from "./spatial.js";

type Vec = [number, number, number];
const tau = 2 * Math.PI;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e10;
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(v: Vec): Vec {
  const length = Math.hypot(...v);
  if (!length || !Number.isFinite(length)) throw new RangeError("proxy direction");
  return [v[0] / length, v[1] / length, v[2] / length];
}
function preview(record: Entity) {
  const at = record.groups.findIndex(g => g.code === 160 || g.code === 92);
  if (at < 0) return;
  const length = Number(record.groups[at].value);
  if (!Number.isSafeInteger(length) || length < 8 || length > 128 * 1024) return;
  const chunks: string[] = [];
  let chars = 0;
  for (let i = at + 1; i < record.groups.length; i++) {
    const group = record.groups[i];
    if (group.code === 161 || group.code === 93) break;
    if (group.code !== 310) continue;
    const chunk = group.value.trim();
    if (!/^(?:[a-f0-9]{2})+$/i.test(chunk)) return;
    chars += chunk.length;
    if (chars > length * 2) return;
    chunks.push(chunk);
    if (chars === length * 2) return Buffer.from(chunks.join(""), "hex");
  }
}

// Command formats are documented by ezdxf's ProxyGraphic reader (MIT,
// https://github.com/mozman/ezdxf/blob/v1.4.3/src/ezdxf/proxygraphic.py).
// Decode the primitive stream directly: mesh topology remains useful even
// when optional SHELL facet traits are incomplete.
export function readProxy(record: Entity, handle: string): CadDrawing {
  if (numeric(record, 60) === 1) return { limits: ["cad_entity_hidden"] };
  const data = preview(record);
  if (!data) return { limits: ["cad_proxy_preview_missing_or_invalid"] };
  const limits = new Set(["cad_proxy_graphics_schematic"]);
  const pieces: CadShape[] = [];
  const matrices = [identity];
  const base = drawingBase(record, handle);
  let fill = false;

  function map([x, y, z]: Vec): CadPoint {
    const m = matrices.at(-1)!;
    const result: CadPoint = [m[0] * x + m[1] * y + m[2] * z + m[3],
      -(m[4] * x + m[5] * y + m[6] * z + m[7])];
    if (!result.every(finite)) throw new RangeError("proxy coordinate");
    return result;
  }

  function stroke(points: CadPoint[], closed = false) {
    if (points.length < 2) return;
    const all = closed ? [...points, points[0]] : points;
    if (all.every(p => p[0] === all[0][0] && p[1] === all[0][1])) return;
    const path = polygon(all);
    const bounds = cadBounds(points.map(([x, y]) => ({ left: x, top: y, right: x, bottom: y })));
    pieces.push({ ...base, x: bounds.left, y: -bounds.top, path, bounds });
  }

  function filled(loops: CadPoint[][]) {
    if (!loops.length || loops[0].length < 3) return;
    pieces.push(areaShape(record, handle, { mode: "solid", loops: loops.map(polygon) }));
  }

  let cursor = 8, work = 0;
  while (cursor < data.length) {
    if (cursor + 8 > data.length || ++work > 4096) {
      limits.add("cad_proxy_command_invalid");
      break;
    }
    const size = data.readUInt32LE(cursor), operation = data.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > data.length) {
      limits.add("cad_proxy_command_invalid");
      break;
    }
    const bytes = data.subarray(cursor + 8, cursor + size);
    cursor += size;
    let at = 0;
    const count = () => { const value = bytes.readUInt32LE(at); at += 4; return value; };
    const number = () => {
      const value = bytes.readDoubleLE(at); at += 8;
      if (!finite(value)) throw new RangeError("proxy number");
      return value;
    };
    const xyz = (): Vec => [number(), number(), number()];
    const vertices = () => {
      const n = count();
      if (n > 4096 || n > (bytes.length - at) / 24) throw new RangeError("proxy vertices");
      return Array.from({ length: n }, xyz);
    };
    try {
      switch (operation) {
        case 2:
        case 4: {
          const c = xyz(), r = number(), axis = unit(xyz());
          if (r <= 0) throw new RangeError("proxy radius");
          const initial = operation === 4 ? xyz() : Math.abs(axis[0]) < 1 / 64 && Math.abs(axis[1]) < 1 / 64
            ? cross([0, 1, 0], axis) : cross([0, 0, 1], axis);
          const u = unit(initial), v = unit(cross(axis, u));
          if (Math.abs(dot(axis, u)) > 1e-6) throw new RangeError("proxy arc axes");
          const sweep = operation === 4 ? number() : tau;
          if (!sweep || Math.abs(sweep) > tau + 1e-8) throw new RangeError("proxy arc sweep");
          const segments = Math.max(8, Math.ceil(Math.abs(sweep) * 32));
          const points = Array.from({ length: segments + 1 }, (_, i) => {
            const a = sweep * i / segments;
            return map([c[0] + r * (u[0] * Math.cos(a) + v[0] * Math.sin(a)),
              c[1] + r * (u[1] * Math.cos(a) + v[1] * Math.sin(a)),
              c[2] + r * (u[2] * Math.cos(a) + v[2] * Math.sin(a))]);
          });
          stroke(points);
          fill = false;
          break;
        }
        case 6:
        case 7: {
          const points = vertices().map(map);
          if (operation === 7 && fill) filled([points]);
          else stroke(points, operation === 7);
          fill = false;
          break;
        }
        case 9: {
          const points = vertices().map(map), n = count();
          if (n > 16384 || n > (bytes.length - at) / 4) throw new RangeError("proxy shell");
          const faces: CadPoint[][][] = [];
          const end = at + n * 4;
          while (at < end) {
            const signed = bytes.readInt32LE(at); at += 4;
            const size = Math.abs(signed);
            if (size < 3 || at + size * 4 > end) throw new RangeError("proxy face");
            const face = Array.from({ length: size }, () => {
              const index = count();
              if (index >= points.length) throw new RangeError("proxy index");
              return points[index];
            });
            if (signed < 0) {
              if (!faces.length) throw new RangeError("proxy hole");
              faces.at(-1)!.push(face);
            } else faces.push([face]);
          }
          for (const face of faces) {
            if (fill) filled(face);
            for (const outline of face) stroke(outline, true);
          }
          if (at < bytes.length) limits.add("cad_proxy_shell_traits_approximate");
          fill = false;
          break;
        }
        case 20:
          fill = Boolean(count());
          break;
        case 29:
        case 30: {
          if (matrices.length >= 16 || bytes.length !== 128) throw new RangeError("proxy matrix");
          const matrix = Array.from({ length: 16 }, number);
          if (matrix[12] || matrix[13] || matrix[14] || matrix[15] !== 1) throw new RangeError("proxy perspective");
          matrices.push(matrix);
          break;
        }
        case 31:
          if (matrices.length === 1) throw new RangeError("proxy matrix stack");
          matrices.pop();
          break;
        case 38: {
          const anchor = xyz(), axis = xyz(), direction = xyz();
          let end = at;
          while (end + 2 <= bytes.length && bytes.readUInt16LE(end)) end += 2;
          if (end + 2 > bytes.length || end - at > 8192) throw new RangeError("proxy text");
          const text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(at, end));
          at = ((end + 2 + 3) & ~3) + 8;
          const origin = map(anchor), along = map([anchor[0] + direction[0], anchor[1] + direction[1], anchor[2] + direction[2]]);
          const height = number() * Math.hypot(along[0] - origin[0], along[1] - origin[1]) / Math.hypot(...direction);
          if (text && finite(height) && height > 0) {
            pieces.push({ ...base, x: origin[0], y: -origin[1], text, height,
              angle: -Math.atan2(along[1] - origin[1], along[0] - origin[0]) * 180 / Math.PI });
            limits.add("cad_text_render_approximate");
            if (Math.abs(axis[2]) < 1 - 1e-8) limits.add("cad_nonplanar_projection");
          }
          fill = false;
          break;
        }
        case 1: case 14: case 16: case 18: case 19: case 22: case 23: case 24: case 25:
          // Extents and appearance traits do not add visible strokes to the monochrome scheme.
          break;
        default:
          limits.add("cad_proxy_command_unsupported");
      }
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
      limits.add("cad_proxy_command_invalid");
      // A failed matrix command makes subsequent positions ambiguous.
      if ([29, 30, 31].includes(operation)) break;
    }
    if (pieces.length > 1024) return { limits: ["cad_proxy_graphics_limit"] };
  }
  if (matrices.length !== 1) limits.add("cad_proxy_command_invalid");
  if (!pieces.length) return { limits: [...limits, "cad_proxy_geometry_unavailable"] };
  const bounds = cadBounds(pieces.map(cadShapeBounds));
  return { shape: { ...base, x: bounds.left, y: -bounds.top, pieces, bounds }, limits: [...limits] };
}
