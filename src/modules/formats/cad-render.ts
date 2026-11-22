import { Resvg } from "@resvg/resvg-js";
import { contains, ReaderError, validBox } from "../pdf/types.js";
import type { Box, ReaderAddress } from "../pdf/types.js";
import type { CadShape, Unit } from "./model.js";

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

function envelope(shape: CadShape) {
  const { x, y, x2 = x, y2 = y, radius = 0, text = "", height = 0, angle = 0 } = shape;
  if (text) {
    const radians = angle * Math.PI / 180;
    const span = Math.max(...text.split("\n").map((line) => [...line].length)) * height * 0.72;
    const tall = Math.max(1, text.split("\n").length) * height * 1.2;
    const corners = [[0, 0], [span, 0], [span, tall], [0, tall]].map(([cx, cy]) => [
      x + cx * Math.cos(radians) - cy * Math.sin(radians),
      -y - cx * Math.sin(radians) - cy * Math.cos(radians),
    ]);
    const xs = corners.map(([cx]) => cx);
    const ys = corners.map(([, cy]) => cy);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys),
      bottom: Math.max(...ys, -y + tall - height) };
  }
  return { left: Math.min(x, x2) - radius, right: Math.max(x, x2) + radius,
    top: Math.min(-y, -y2) - radius, bottom: Math.max(-y, -y2) + radius };
}

function envelopeOf(shapes: CadShape[]) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const shape of shapes) {
    const box = envelope(shape);
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }
  return { left, right, top, bottom };
}

export function cadFrame(unit: Unit) {
  if (!unit.cad?.length) return;
  if (unit.cadView) return unit.cadView;
  const { left, right, top, bottom } = envelopeOf(unit.cad);
  const border = Math.max((right - left) * .035, (bottom - top) * .035, 1);
  return { x: left - border, y: top - border,
    width: right - left + 2 * border, height: bottom - top + 2 * border };
}

function invalid(): never {
  throw new ReaderError("reader_address_invalid", "Рамка CAD выходит за видимые границы", 422);
}

export function renderCad(unit: Unit, address: ReaderAddress, handle?: string) {
  const entire = cadFrame(unit);
  if (!entire || !unit.cad) return;
  const outer = { ...entire, x: 0, y: 0 };
  let crop: Box = address.box ?? outer;
  if (address.box && (!validBox(crop) || !contains(outer, crop)
      || Math.max(crop.width, crop.height) < Math.max(outer.width, outer.height) * 1e-7)) invalid();
  if (handle) {
    const shapes = unit.cad.filter((shape) => shape.handle === handle);
    if (!shapes.length) return;
    const focus = envelopeOf(shapes);
    const target = { x: focus.left - entire.x, y: focus.top - entire.y,
      width: focus.right - focus.left, height: focus.bottom - focus.top };
    if (address.box) {
      if (!contains(crop, target)) invalid();
    } else {
      const padding = Math.max(target.height * 4, target.width * .15, Math.min(entire.width, entire.height) / 14);
      const x = Math.max(0, target.x - padding);
      const y = Math.max(0, target.y - padding);
      const right = Math.min(entire.width, target.x + target.width + padding);
      const bottom = Math.min(entire.height, target.y + target.height + padding);
      let top = y;
      let end = bottom;
      for (const neighbor of unit.cad) {
        if (!neighbor.text) continue;
        const bounds = envelope(neighbor);
        if (bounds.right - entire.x < x || bounds.left - entire.x > right
            || bounds.bottom - entire.y < y || bounds.top - entire.y > bottom) continue;
        top = Math.min(top, bounds.top - entire.y - 1);
        end = Math.max(end, bounds.bottom - entire.y + 1);
      }
      top = Math.max(0, top);
      crop = { x, y: top, width: right - x, height: Math.min(entire.height, end) - top };
    }
  }
  const width = Math.ceil(Math.min(1600, Math.max(1, 1600 * crop.width / Math.max(crop.width, crop.height))));
  const height = Math.ceil(Math.min(1600, Math.max(1, 1600 * crop.height / Math.max(crop.width, crop.height))));
  const scale = Math.min(width / crop.width, height / crop.height);
  const originX = crop.x * scale - (width - crop.width * scale) / 2;
  const originY = crop.y * scale - (height - crop.height * scale) / 2;
  const shapes = unit.cad.map((shape) => {
    const { x, y, x2, y2, radius, text, height: font = 1, angle = 0 } = shape;
    const color = shape.handle === handle ? "#a02020" : "#162631";
    if (radius) return `<circle cx="${x}" cy="${-y}" r="${radius}" stroke="${color}" fill="none"/>`;
    if (x2 !== undefined && y2 !== undefined) {
      return `<line x1="${x}" y1="${-y}" x2="${x2}" y2="${-y2}" stroke="${color}"/>`;
    }
    return `<text transform="translate(${x} ${-y}) rotate(${-angle})" font-size="${font}" fill="${color}">${(text ?? "")
      .split("\n").map((line, index) => `<tspan x="0" y="${index * font * 1.2}">${escapeXml(line)}</tspan>`)
      .join("")}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
    <g transform="translate(${-originX} ${-originY}) scale(${scale}) translate(${-entire.x} ${-entire.y})"
      font-family="sans-serif" stroke-width="${1 / scale}">${shapes}</g></svg>`;
  const bytes = new Resvg(svg).render().asPng();
  return { bytes, crop, transform: { width, height, pixelsPerPoint: scale,
    pixelOriginX: originX, pixelOriginY: originY } };
}
