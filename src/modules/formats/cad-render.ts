import { Resvg } from "@resvg/resvg-js";
import { rasterCad } from "./cad-raster.js";
import { cadFrame, cadShapeBounds, envelopeOf, escapeXml } from "./cad-bounds.js";
export { cadFrame } from "./cad-bounds.js";
import { contains, ReaderError, validBox } from "../pdf/types.js";
import type { Box, ReaderAddress } from "../pdf/types.js";
import type { CadDefinition, CadShape, Unit } from "./model.js";

function invalid(): never {
  throw new ReaderError("reader_address_invalid", "Рамка CAD выходит за видимые границы", 422);
}

export function renderCad(
  unit: Unit, address: ReaderAddress, handle?: string, load?: (digest: string) => CadDefinition,
) {
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
        const bounds = cadShapeBounds(neighbor);
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
  const bytes = load && unit.cad.some(shape => shape.block || shape.path || shape.area || shape.pieces)
    ? rasterCad(unit.cad, width, height, scale, originX + entire.x * scale, originY + entire.y * scale, load, handle)
    : legacyPng(unit.cad, width, height, scale, originX, originY, entire.x, entire.y, handle);
  return { bytes, crop, transform: { width, height, pixelsPerPoint: scale,
    pixelOriginX: originX, pixelOriginY: originY } };
}

function legacyPng(shapes: CadShape[], width: number, height: number, scale: number,
  originX: number, originY: number, x: number, y: number, handle?: string) {
  const content = shapes.map(shape => {
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
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
    <g transform="translate(${-originX} ${-originY}) scale(${scale}) translate(${-x} ${-y})"
      font-family="sans-serif" stroke-width="${1 / scale}">${content}</g></svg>`).render().asPng();
}
