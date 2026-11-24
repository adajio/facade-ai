import type { CadPath } from "./model.js";

type Glyph = { path: CadPath; advance: number };
const signature = Buffer.from("AutoCAD-86 unifont 1.0\r\n\x1a", "ascii");
const octant = Math.PI / 4;
const dx = [1, 1, 1, .5, 0, -.5, -1, -1, -1, -1, -1, -.5, 0, .5, 1, 1];
const dy = [0, .5, 1, 1, 1, 1, 1, .5, 0, -.5, -1, -1, -1, -1, -1, -.5];
const invalid = (): never => { throw new RangeError("SHX structure"); };

// Binary record layout checked against ezdxf 1.4.3 (MIT), fonts/shapefile.py.
// Vector and special codes follow Autodesk's Shape Descriptions reference.
export function shxFont(data: Buffer) {
  if (!data.subarray(0, signature.length).equals(signature)) invalid();
  let cursor = signature.length;
  const count = data.readUInt16LE(cursor);
  const length = data.readUInt16LE(cursor + 4);
  cursor += 6;
  const end = cursor + length;
  const nameEnd = data.indexOf(0, cursor);
  if (nameEnd < cursor || nameEnd + 7 !== end || end > data.length || count < 2 || count > 16384
      || data[nameEnd + 4] !== 0 || data[end - 1] !== 0) invalid();
  const name = data.toString("latin1", cursor, nameEnd);
  const capHeight = data[nameEnd + 1];
  if (!capHeight) invalid();
  cursor = end;
  const programs = new Map<number, Buffer>();
  for (let i = 1; i < count; i++) {
    const code = data.readUInt16LE(cursor), bytes = data.readUInt16LE(cursor + 2);
    cursor += 4;
    const next = cursor + bytes;
    if (next > data.length || bytes > 4096 || programs.has(code)) invalid();
    const body = data.subarray(cursor, next);
    const start = body.indexOf(0) + 1;
    if (!start || start >= body.length) invalid();
    programs.set(code, body.subarray(start));
    cursor = next;
  }
  if (cursor !== data.length) invalid();

  const cache = new Map<number, Glyph | undefined>();
  function glyph(codepoint: number) {
    if (cache.has(codepoint)) return cache.get(codepoint);
    if (!programs.has(codepoint)) return;
    const path: CadPath = [];
    let x = 0, y = 0, scale = 1, pen = true, work = 0;
    const locations: [number, number][] = [];
    const active = new Set<number>();

    function move(a: number, b: number) {
      const u = x + a * scale, v = y + b * scale;
      if (![u,v].every(n => Number.isFinite(n) && Math.abs(n) <= 100_000)) invalid();
      if (pen && (u !== x || v !== y)) path.push(["M", x, -y], ["L", u, -v]);
      x = u; y = v;
    }
    function arc(radius: number, start: number, sweep: number) {
      if (!radius || Math.abs(sweep) < 1e-12 || Math.abs(sweep) > Math.PI * 2 + 1e-9) invalid();
      const cx = x - radius * Math.cos(start), cy = y - radius * Math.sin(start);
      if (pen) path.push(["M", x, -y], ["A", cx, -cy, radius, -start, -sweep]);
      x = cx + radius * Math.cos(start + sweep); y = cy + radius * Math.sin(start + sweep);
      if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) invalid();
    }
    function bulge(a: number, b: number, sag: number) {
      if (!pen || !sag) { move(a,b); return; }
      const ratio = sag / 127;
      const offset = (1 / ratio - ratio) / 4;
      const u = a * scale, v = b * scale;
      const cx = x + u / 2 - v * offset, cy = y + v / 2 + u * offset;
      arc(Math.hypot(x - cx, y - cy), Math.atan2(y - cy, x - cx), 4 * Math.atan(ratio));
    }
    function run(code: number) {
      const body = programs.get(code);
      if (!body || active.has(code) || active.size >= 16) invalid();
      active.add(code);
      let i = 0, skip = false;
      const next = () => body!.readUInt8(i++);
      const signed = () => body!.readInt8(i++);
      for (;;) {
        if (++work > 8192) invalid();
        const op = next();
        if (!op) break;
        const enabled: boolean = !skip;
        skip = false;
        if (op > 15) {
          if (enabled) move(dx[op & 15] * (op >> 4), dy[op & 15] * (op >> 4));
        } else switch (op) {
          case 1: case 2: if (enabled) pen = op === 1; break;
          case 3: case 4: {
            const factor = next();
            if (!factor) invalid();
            if (enabled) scale *= op === 3 ? 1 / factor : factor;
            if (scale < 1e-6 || scale > 1e4) invalid();
            break;
          }
          case 5:
            if (enabled) {
              if (locations.length >= 64) invalid();
              locations.push([x,y]);
            }
            break;
          case 6:
            if (enabled) [x,y] = locations.pop() ?? invalid();
            break;
          case 7: {
            const child = next() | (next() << 8);
            if (enabled) run(child);
            break;
          }
          case 8: case 9: case 12: case 13: {
            do {
              const a = signed(), b = signed();
              if ((op === 9 || op === 13) && !a && !b) break;
              const sag = op >= 12 ? signed() : 0;
              if (enabled) bulge(a,b,sag);
              if (++work > 8192) invalid();
            } while (op === 9 || op === 13);
            break;
          }
          case 10: case 11: {
            const first = op === 11 ? next() / 256 : 0;
            const last = op === 11 ? (next() || 256) / 256 : 1;
            const hi = op === 11 ? next() : 0;
            const radius = (hi * 256 + next()) * scale;
            const bits = next();
            const sign = bits & 128 ? -1 : 1;
            const start = ((bits >> 4) & 7) * octant + first * octant * sign;
            const span = ((bits & 15 || 8) - 1 + last - first) * octant * sign;
            if (enabled) arc(radius, start, span);
            break;
          }
          case 14: skip = enabled; break; // horizontal rendering only
          default: invalid();
        }
      }
      active.delete(code);
    }
    let result: Glyph | undefined;
    try {
      run(codepoint);
      if (locations.length || x < 0) invalid();
      result = { path, advance: x };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    cache.set(codepoint, result);
    return result;
  }
  return { name, capHeight, glyph };
}
