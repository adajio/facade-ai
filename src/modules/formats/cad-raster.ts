import { Resvg } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { ReaderError } from "../pdf/types.js";
import { cadShapeBounds, escapeXml } from "./cad-bounds.js";
import type { CadArea, CadBlockUse, CadBounds, CadDefinition, CadPath, CadShape } from "./model.js";

type Matrix = CadBlockUse["matrix"];
type Point = [number, number];

const fonts = [
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
  ["/System/Library/Fonts/Supplemental/Arial.ttf", "Arial"],
];
const systemFallback = fonts.find(([filename]) => existsSync(filename));
const font = systemFallback ? { loadSystemFonts: false,
  fontFiles: [systemFallback[0]], sansSerifFamily: systemFallback[1] } : undefined;
const color = [[255, 255, 255], [22, 38, 49], [160, 32, 32], [172, 179, 184], [214, 134, 134]];
const dot = ([ax, ay]: Point, [bx, by]: Point) => ax * bx + ay * by;
const emptyBounds = (b: CadBounds) => b.left > b.right || b.top > b.bottom;

function product([a, b, c, d, x, y]: Matrix, [e, f, g, h, u, v]: Matrix): Matrix {
  return [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * u + c * v + x, b * u + d * v + y];
}
function position([a, b, c, d, x, y]: Matrix, u: number, v: number): Point {
  return [a * u + c * v + x, b * u + d * v + y];
}

function intersect(a: CadBounds, b: CadBounds): CadBounds {
  return { left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) };
}

function mapped(matrix: Matrix, box: CadBounds): CadBounds {
  const { left, right, top, bottom } = box;
  const corners = [position(matrix, left, top), position(matrix, right, top),
    position(matrix, left, bottom), position(matrix, right, bottom)];
  return { left: Math.min(...corners.map(p => p[0])), right: Math.max(...corners.map(p => p[0])),
    top: Math.min(...corners.map(p => p[1])), bottom: Math.max(...corners.map(p => p[1])) };
}

function png(width: number, height: number, pixels: Buffer) {
  const stride = width * 3;
  const data = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(data, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  function chunk(name: string, bytes: Buffer) {
    const result = Buffer.allocUnsafe(12 + bytes.length);
    result.writeUInt32BE(bytes.length);
    result.write(name, 4, "ascii");
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(data, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}

export function rasterCad(
  shapes: CadShape[], width: number, height: number, scale: number, originX: number, originY: number,
  load: (digest: string) => CadDefinition, selected?: string,
): Buffer {
  const pixels = Buffer.alloc(3 * width * height, 255);
  const canvas = { left: 0, right: width - 1, top: 0, bottom: height - 1 };
  const screen: Matrix = [scale, 0, 0, scale, -originX, -originY];
  const definitions = new Map<string, CadShape[]>();
  const text = new Map<CadBounds, string[]>();
  let textCount = 0;
  let visits = 0, work = 0, areaWork = 0, definitionBytes = 0, glyphsBytes = 0, glyphPasses = 0;

  function limit(): never {
    throw new ReaderError("cad_block_render_limit", "Графика части слишком сложна, выберите объект или область", 424);
  }
  function paint(x: number, y: number, tint: number) {
    const index = (y * width + x) * 3;
    const [r, g, b] = color[tint];
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b;
  }

  function drawLine(p1: Point, p2: Point, box: CadBounds, tint: number) {
    if (++work > 12_000_000) limit();
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    let from = 0, to = 1;
    for (const [d, gap] of [[-dx, p1[0] - box.left], [dx, box.right - p1[0]],
      [-dy, p1[1] - box.top], [dy, box.bottom - p1[1]]]) {
      if (!d && gap < 0) return;
      if (d < 0) from = Math.max(from, gap / d);
      if (d > 0) to = Math.min(to, gap / d);
    }
    if (from > to) return;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * (to - from)));
    work += steps;
    if (work > 12_000_000) limit();
    for (let i = 0; i <= steps; i++) {
      const t = from + (to - from) * i / steps;
      const x = Math.round(p1[0] + t * dx), y = Math.round(p1[1] + t * dy);
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      paint(x, y, tint);
    }
  }

  function arcPoints(matrix: Matrix, cx: number, cy: number, radius: number, start: number, sweep: number) {
    const pixelsRadius = radius * Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]));
    const segments = Math.max(1, Math.min(512, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(1, pixelsRadius)))));
    return Array.from({ length: segments + 1 }, (_, i) => {
      const t = start + sweep * i / segments;
      return position(matrix, cx + radius * Math.cos(t), cy + radius * Math.sin(t));
    });
  }

  function curve(matrix: Matrix, box: CadBounds, tint: number, cx: number, cy: number, radius: number,
    start: number, sweep: number) {
    const points = arcPoints(matrix, cx, cy, radius, start, sweep);
    for (let i = 1; i < points.length; i++) drawLine(points[i - 1], points[i], box, tint);
    return points.at(-1)!;
  }

  function edges(loops: CadPath[], matrix: Matrix): [Point, Point][] {
    const pairs: [Point, Point][] = [];
    for (const loop of loops) {
      let first: Point | undefined, last: Point | undefined;
      for (const part of loop) {
        const [op,x,y] = part;
        const points = op === "A" ? arcPoints(matrix, x, y, part[3], part[4], part[5]) : [position(matrix, x, y)];
        for (const point of points) {
          if (last) pairs.push([last, point]);
          first ??= point;
          last = point;
        }
        if (pairs.length > 32768) limit();
      }
      if (first && last) pairs.push([last, first]);
    }
    return pairs;
  }

  function charge(n: number) {
    areaWork += n;
    if (areaWork > 48_000_000) limit();
  }

  function intersections(pairs: [Point, Point][], tangent: Point, normal: Point, offset: number) {
    charge(pairs.length);
    const cuts: number[] = [];
    for (const [a, b] of pairs) {
      const u = dot(a, normal), v = dot(b, normal);
      if (u <= offset && offset < v || v <= offset && offset < u) {
        cuts.push(dot(a, tangent) + (dot(b, tangent) - dot(a, tangent)) * (offset - u) / (v - u));
      }
    }
    return cuts.sort((a,b) => a - b);
  }

  function solid(pairs: [Point, Point][], box: CadBounds, tint: number) {
    for (let y = Math.max(0, Math.ceil(box.top)); y <= Math.floor(box.bottom); y++) {
      const cuts = intersections(pairs, [1, 0], [0, 1], y + .5);
      for (let i = 0; i + 1 < cuts.length; i += 2) {
        const from = Math.max(Math.ceil(box.left), Math.ceil(cuts[i] - .5));
        const to = Math.min(Math.floor(box.right), Math.floor(cuts[i + 1] - .5));
        charge(Math.max(0, to - from + 1));
        if (tint === 0 && to >= from) pixels.fill(255, (y * width + from) * 3, (y * width + to + 1) * 3);
        else for (let x = from; x <= to; x++) paint(x,y,tint);
      }
    }
  }

  function drawArea(area: CadArea, matrix: Matrix, clip: CadBounds, visible: CadBounds, tint: number) {
    if (emptyBounds(visible)) return;
    const pairs = edges(area.loops, matrix);
    if (!pairs.length) return;
    if (area.mode === "mask") {
      paintText();
      solid(pairs, visible, 0);
      return;
    }
    const fill = tint === 2 ? 4 : 3;
    if (area.mode === "solid") {
      solid(pairs, visible, fill);
      return;
    }
    const corners: Point[] = [[visible.left, visible.top], [visible.left, visible.bottom],
      [visible.right, visible.top], [visible.right, visible.bottom]];
    let dense = false;
    const tintDense = () => {
      if (!dense) { solid(pairs, visible, fill); dense = true; }
    };
    const families = [...area.pattern ?? []].reverse();
    function drawFamily(line: NonNullable<CadArea["pattern"]>[number], toneOnly: boolean) {
      const origin = position(matrix, ...line.base);
      const delta = (vec: Point): Point => [matrix[0] * vec[0] + matrix[2] * vec[1],
        matrix[1] * vec[0] + matrix[3] * vec[1]];
      const move = delta(line.step);
      const along = delta(line.direction);
      const length = Math.hypot(...along);
      if (!length) return;
      const tangent: Point = [along[0] / length, along[1] / length];
      let normal: Point = [-tangent[1], tangent[0]];
      let spacing = dot(move, normal);
      if (spacing < 0) { spacing = -spacing; normal = [-normal[0], -normal[1]]; }
      const originOffset = dot(origin, normal);
      const range = corners.map(point => dot(point, normal));
      if (spacing < .65 && spacing > 1e-9) { if (toneOnly) tintDense(); return; }
      const first = spacing > 1e-9 ? Math.ceil((Math.min(...range) - originOffset) / spacing) : 0;
      const last = spacing > 1e-9 ? Math.floor((Math.max(...range) - originOffset) / spacing) : 0;
      const pattern = line.dashes.map(d => d * length);
      const period = pattern.reduce((sum, d) => sum + Math.abs(d), 0);
      if (period > 1e-9 && period < .65) { if (toneOnly) tintDense(); return; }
      if (toneOnly) return;
      const screenRange = corners.map(p => dot(p,tangent));
      const low = Math.min(...screenRange), high = Math.max(...screenRange);
      for (let i = first; i <= last; i++) {
        const offset = originOffset + spacing * i;
        const cuts = intersections(pairs,tangent,normal,offset);
        const phase = dot(origin, tangent) + dot(move, tangent) * i;
        const pos = (t: number): Point =>
          [tangent[0] * t + normal[0] * offset, tangent[1] * t + normal[1] * offset];
        for (let j = 0; j + 1 < cuts.length; j += 2) {
          const start = Math.max(cuts[j], low), end = Math.min(cuts[j+1], high);
          if (start > end) continue;
          if (!pattern.length || period <= 1e-9) { drawLine(pos(start), pos(end), clip, tint); continue; }
          let point = phase + Math.floor((start - phase) / period) * period;
          while (point <= end) for (const dash of pattern) {
            charge(1);
            const stop = point + Math.abs(dash);
            if (dash >= 0 && stop >= start && point <= end) {
              drawLine(pos(Math.max(start, point)), pos(Math.min(end, stop)), clip, tint);
            }
            point = stop;
          }
        }
      }
    }
    // Subpixel repeats are represented by their clipped tone at this zoom.
    for (const family of families) drawFamily(family, true);
    for (const family of families) drawFamily(family, false);
  }

  function label(shape: CadShape, matrix: Matrix, box: CadBounds, tint: number) {
    if (!shape.text || (shape.height ?? 1) * Math.hypot(matrix[2], matrix[3]) < 1) return;
    const font = shape.height ?? 1;
    const content = shape.text.split("\n").map((line, i) =>
      `<tspan x="0" y="${i * font * 1.2}">${escapeXml(line)}</tspan>`).join("");
    const item = `<text transform="matrix(${matrix.join(" ")}) translate(${shape.x} ${-shape.y}) rotate(${-(shape.angle ?? 0)})" font-size="${font}" fill="rgb(${color[tint].join(",")})">${content}</text>`;
    glyphsBytes += item.length;
    if (glyphsBytes > 2 * 1024 ** 2 || ++textCount > 4000) limit();
    if (!text.has(box)) text.set(box, []);
    text.get(box)!.push(item);
  }

  function draw(shape: CadShape, matrix: Matrix, box: CadBounds, tint: number, depth: number) {
    if (++visits > 800_000 || depth >= 19) limit();
    const visible = intersect(mapped(matrix, cadShapeBounds(shape)), box);
    if (visible.left > visible.right + 1 || visible.top > visible.bottom + 1) return;
    if (shape.area) {
      drawArea(shape.area, matrix, box, visible, tint);
    } else if (shape.pieces) {
      for (const piece of shape.pieces) draw(piece, matrix, box, tint, depth + 1);
    } else if (shape.block) {
      const { digest, matrix: local } = shape.block;
      let items = definitions.get(digest);
      if (!items) {
        if (!/^[a-f0-9]{64}$/.test(digest)) {
          throw new ReaderError("dwg_index_invalid", "Определение блока DWG не подтверждено", 424);
        }
        items = load(digest).shapes;
        definitionBytes += Buffer.byteLength(JSON.stringify(items));
        if (definitions.size >= 8192 || definitionBytes > 12 * 1024 ** 2) limit();
        definitions.set(digest, items);
      }
      const nested = product(matrix, local);
      const clip = shape.clip ? intersect(box, mapped(matrix, shape.clip)) : box;
      for (const item of items) draw(item, nested, clip, tint, depth + 1);
    } else if (shape.path) {
      let previous: Point | undefined;
      for (const command of shape.path) {
        const [kind, x, y] = command;
        if (kind === "A") {
          previous = curve(matrix, box, tint, x, y, command[3], command[4], command[5]);
        } else {
          const point = position(matrix, x, y);
          if (kind === "L" && previous) drawLine(previous, point, box, tint);
          previous = point;
        }
      }
    } else if (shape.radius) {
      curve(matrix, box, tint, shape.x, -shape.y, shape.radius, 0, 2 * Math.PI);
    } else if (shape.x2 !== undefined && shape.y2 !== undefined) {
      drawLine(position(matrix, shape.x, -shape.y), position(matrix, shape.x2, -shape.y2), box, tint);
    } else label(shape, matrix, box, tint);
  }

  function paintText() {
    if (!text.size) return;
    if (++glyphPasses > 120) limit();
    const clips: string[] = [];
    const glyphRuns = Array.from(text, ([box, runs], id) => {
      if (box === canvas) return runs.join("");
      clips.push(`<clipPath id="clip${id}"><rect x="${box.left}" y="${box.top}" width="${box.right - box.left + 1}" height="${box.bottom - box.top + 1}"/></clipPath>`);
      return `<g clip-path="url(#clip${id})">${runs.join("")}</g>`;
    });
    const glyphs = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
      font-family="sans-serif"><defs>${clips.join("")}</defs>${glyphRuns.join("")}</svg>`, { font }).render().pixels;
    for (let i = 0, j = 0; i < glyphs.length; i += 4, j += 3) {
      if (!glyphs[i+3]) continue;
      const ratio = 1 - glyphs[i+3] / 255;
      for (let c = 0; c < 3; c++) pixels[j+c] = Math.round(pixels[j+c] * ratio + glyphs[i+c]);
    }
    text.clear();
  }

  for (const shape of shapes) draw(shape, screen, canvas, shape.handle === selected ? 2 : 1, 0);
  paintText();
  if (!pixels.some(value => value < 250)) {
    throw new ReaderError("cad_entity_geometry_unavailable", "В области схемы нет отображаемой геометрии", 424);
  }
  return png(width, height, pixels);
}
