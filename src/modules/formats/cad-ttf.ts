const invalid = (): never => { throw new RangeError("SFNT structure"); };

// Read the Unicode mapping and advance widths. Outline shaping stays in Resvg.
export function ttfFont(data: Buffer) {
  if (data.readUInt32BE(0) !== 0x00010000) invalid();
  const tables = new Map<string, Buffer>();
  const count = data.readUInt16BE(4);
  if (!count || count > 128) invalid();
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    const id = data.toString("ascii", at, at + 4);
    const offset = data.readUInt32BE(at + 8), bytes = data.readUInt32BE(at + 12);
    if (offset + bytes > data.length || tables.has(id)) invalid();
    tables.set(id, data.subarray(offset, offset + bytes));
  }
  const table = (id: string) => tables.get(id) ?? invalid();
  const name = table("name"), strings = name.readUInt16BE(4);
  const names = new Map<number, { value: string; priority: number }>();
  for (let i = 0; i < name.readUInt16BE(2); i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at), language = name.readUInt16BE(at + 4), id = name.readUInt16BE(at + 6);
    if (![1, 2, 4, 6, 16, 17].includes(id) || ![0, 1, 3].includes(platform)) continue;
    const size = name.readUInt16BE(at + 8), start = strings + name.readUInt16BE(at + 10);
    if (start + size > name.length || size > 512 || platform !== 1 && size % 2) invalid();
    const bytes = name.subarray(start,start + size);
    const value = platform === 1 ? bytes.toString("latin1") : Buffer.from(bytes).swap16().toString("utf16le");
    const priority = platform === 3 && language === 0x409 ? 4 : platform === 0 ? 3 : platform === 3 ? 2 : 1;
    if (value && priority > (names.get(id)?.priority ?? 0)) names.set(id,{value,priority});
  }
  const family = names.get(16)?.value ?? names.get(1)?.value ?? invalid();
  const subfamily = names.get(17)?.value ?? names.get(2)?.value ?? "";
  const flags = table("head").readUInt16BE(44);
  const metrics = table("OS/2");
  const bold = (flags & 1) !== 0 || metrics.readUInt16BE(4) >= 650 || /bold/i.test(subfamily);
  const italic = (flags & 2) !== 0 || /italic|oblique/i.test(subfamily);
  const em = table("head").readUInt16BE(18);
  const cap = metrics.length >= 90 && metrics.readUInt16BE(0) >= 2 ? metrics.readInt16BE(88) : 0;
  const hmtx = table("hmtx");
  const nmetrics = table("hhea").readUInt16BE(34);
  if (em < 16 || !nmetrics || hmtx.length < 4 * nmetrics) invalid();

  const cmap = table("cmap"), maps: Buffer[] = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const at = 4 + 8 * i, platform = cmap.readUInt16BE(at), encoding = cmap.readUInt16BE(at + 2);
    if (!(platform === 0 || platform === 3 && [1,10].includes(encoding))) continue;
    const start = cmap.readUInt32BE(at + 4), format = cmap.readUInt16BE(start);
    if (format !== 4 && format !== 12) continue;
    const n = format === 4 ? cmap.readUInt16BE(start+2) : cmap.readUInt32BE(start+4);
    if (start+n > cmap.length) invalid();
    maps.push(cmap.subarray(start,start+n));
  }
  maps.sort((a,b) => b.readUInt16BE(0) - a.readUInt16BE(0));
  if (!maps.length) invalid();
  function lookup(map: Buffer, code: number): number {
    if (map.readUInt16BE(0) === 12) {
      let low = 0, high = map.readUInt32BE(12) - 1;
      while (low <= high) {
        const mid = (low+high) >>> 1, at = 16 + mid*12;
        const first = map.readUInt32BE(at), last = map.readUInt32BE(at+4);
        if (code < first) high = mid-1;
        else if (code > last) low = mid+1;
        else return map.readUInt32BE(at+8) + code - first;
      }
      return 0;
    }
    if (code > 0xffff) return 0;
    const parts = map.readUInt16BE(6) / 2;
    let low = 0, high = parts - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (map.readUInt16BE(14 + mid*2) < code) low = mid+1;
      else high = mid;
    }
    const start = map.readUInt16BE(16 + parts*2 + low*2);
    if (code < start || code > map.readUInt16BE(14 + low*2)) return 0;
    const delta = map.readInt16BE(16 + parts*4 + low*2), at = 16 + parts*6 + low*2;
    const offset = map.readUInt16BE(at);
    if (!offset) return (code + delta) & 0xffff;
    const glyph = map.readUInt16BE(at + offset + (code - start)*2);
    return glyph ? (glyph + delta) & 0xffff : 0;
  }
  function glyph(code: number) {
    try {
      for (const map of maps) {
        const id = lookup(map, code);
        if (id) return { advance: hmtx.readUInt16BE(Math.min(nmetrics - 1,id) * 4) };
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return { family, aliases: [1, 4, 6, 16].flatMap(id => names.has(id) ? [names.get(id)!.value] : []), bold, italic, glyph, em, capHeight: cap > 0 && cap <= em ? cap : em };
}
