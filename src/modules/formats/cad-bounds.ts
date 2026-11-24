import type { CadBlockUse, CadBounds, CadShape, Unit } from "./model.js";

export const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

export function cadShapeBounds(shape: CadShape): CadBounds {
  if (shape.bounds) return shape.bounds;
  const { x, y, x2 = x, y2 = y, radius = 0, text = "", height = 0, angle = 0 } = shape;
  if (text) {
    const radians = angle * Math.PI / 180;
    const plan = shape.textSpans;
    const span = plan?.length ? Math.max(...plan.map(run => run.x + run.advance + run.height * .6))
      : Math.max(...text.split("\n").map((line) => [...line].length)) * height * 0.72;
    const tall = plan?.length ? Math.max(...plan.map(run => run.y + run.height * 1.2))
      : Math.max(1, text.split("\n").length) * height * 1.2;
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

export function cadBounds(boxes: Iterable<CadBounds>): CadBounds {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }
  return { left, right, top, bottom };
}

export const envelopeOf = (shapes: CadShape[]) => cadBounds(shapes.map(cadShapeBounds));

export function cadFrame(unit: Unit) {
  if (!unit.cad?.length) return;
  if (unit.cadView) return unit.cadView;
  const { left, right, top, bottom } = envelopeOf(unit.cad);
  const border = Math.max((right - left) * .035, (bottom - top) * .035, 1);
  return { x: left - border, y: top - border,
    width: right - left + 2 * border, height: bottom - top + 2 * border };
}

export function transformCadBounds([a, b, c, d, x, y]: CadBlockUse["matrix"], box: CadBounds): CadBounds {
  const { left, right, top, bottom } = box;
  const xs = [a * left + c * top + x, a * right + c * top + x,
    a * left + c * bottom + x, a * right + c * bottom + x];
  const ys = [b * left + d * top + y, b * right + d * top + y,
    b * left + d * bottom + y, b * right + d * bottom + y];
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

export function cadPaintOrder(a: CadShape, b: CadShape) {
  const left = a.order ?? "", right = b.order ?? "";
  return left < right ? -1 : Number(left > right);
}

export function composeCadTransform(
  [a, b, c, d, x, y]: CadBlockUse["matrix"], [e, f, g, h, u, v]: CadBlockUse["matrix"],
): CadBlockUse["matrix"] {
  return [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * u + c * v + x, b * u + d * v + y];
}
