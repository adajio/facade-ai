import { Resvg } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { ReaderError } from "../pdf/types.js";
import { cadShapeBounds, escapeXml } from "./cad-bounds.js";
import type { CadBlockUse, CadBounds, CadDefinition, CadShape } from "./model.js";

type Matrix = CadBlockUse["matrix"];
type Point = [number, number];

const fonts = [
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
  ["/System/Library/Fonts/Supplemental/Arial.ttf", "Arial"],
];
const systemFallback = fonts.find(([filename]) => existsSync(filename));
const font = systemFallback ? { loadSystemFonts: false,
  fontFiles: [systemFallback[0]], sansSerifFamily: systemFallback[1] } : undefined;
const color = [[255, 255, 255], [22, 38, 49], [160, 32, 32]];

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

function png(width: number, height: number, pixels: Uint8Array, glyphs?: Buffer) {
  const stride = width * 3 + 1;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const rgb = color[pixels[index]];
    const textAlpha = (glyphs?.[index * 4 + 3] ?? 0) / 255;
    const destination = y * stride + x * 3 + 1;
    for (let c = 0; c < 3; c++) {
      data[destination + c] = Math.round(rgb[c] * (1 - textAlpha) + (glyphs?.[index * 4 + c] ?? 0));
    }
  }
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
  const pixels = new Uint8Array(width * height);
  const canvas = { left: 0, right: width - 1, top: 0, bottom: height - 1 };
  const screen: Matrix = [scale, 0, 0, scale, -originX, -originY];
  const definitions = new Map<string, CadShape[]>();
  const text = new Map<CadBounds, string[]>();
  let textCount = 0;
  let visits = 0, work = 0, definitionBytes = 0, glyphsBytes = 0, ink = 0;

  function limit(): never {
    throw new ReaderError("cad_block_render_limit", "Графика части слишком сложна, выберите объект или область", 424);
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
      const index = y * width + x;
      pixels[index] = Math.max(tint, pixels[index]);
      ink++;
    }
  }

  function curve(matrix: Matrix, box: CadBounds, tint: number, cx: number, cy: number, radius: number,
    start: number, sweep: number) {
    const pixelsRadius = radius * Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]));
    const segments = Math.max(1, Math.min(512, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(1, pixelsRadius)))));
    const at = (t: number) => position(matrix, cx + radius * Math.cos(t), cy + radius * Math.sin(t));
    let previous = at(start);
    for (let i = 1; i <= segments; i++) {
      const point = at(start + sweep * i / segments);
      drawLine(previous, point, box, tint);
      previous = point;
    }
    return previous;
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
    if (shape.block) {
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

  for (const shape of shapes) draw(shape, screen, canvas, shape.handle === selected ? 2 : 1, 0);
  const clips: string[] = [];
  const glyphRuns = Array.from(text, ([box, runs], id) => {
    if (box === canvas) return runs.join("");
    clips.push(`<clipPath id="clip${id}"><rect x="${box.left}" y="${box.top}" width="${box.right - box.left + 1}" height="${box.bottom - box.top + 1}"/></clipPath>`);
    return `<g clip-path="url(#clip${id})">${runs.join("")}</g>`;
  });
  const glyphs = text.size ? new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
    font-family="sans-serif"><defs>${clips.join("")}</defs>${glyphRuns.join("")}</svg>`, { font }).render().pixels : undefined;
  if (!ink && !glyphs?.some((value, i) => i % 4 === 3 && Boolean(value))) {
    throw new ReaderError("cad_entity_geometry_unavailable", "В области схемы нет отображаемой геометрии", 424);
  }
  return png(width, height, pixels, glyphs);
}
