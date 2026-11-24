import type { CadFontAssets } from "./cad-font-assets.js";
import type { CadFontRequest, CadFontUse, CadShape, CadTextSpan } from "./model.js";
import { first, numeric } from "./spatial.js";
import type { Entity } from "./spatial.js";

type Request = CadFontRequest & { size: number };
const normalize = (value: string) => value.replace(/\\U\+([0-9a-f]{4})/gi, (_, code) =>
  String.fromCharCode(parseInt(code,16))).replace(/%%([dpcou])|%%(\d{3})/gi, (_token, letter, digit) =>
  digit ? String.fromCharCode(Number(digit)) : ({ d: "°", p: "±", c: "∅", o: "", u: "" })[String(letter).toLowerCase()]!);

export function mergeFontUses(target: Map<string,CadFontUse>, values: Iterable<CadFontUse>) {
  for (const use of values) if (target.size < 32) target.set(JSON.stringify(use),use);
}

export function dwgCadText(records: Entity[], assets: CadFontAssets) {
  const styles = new Map<string, CadFontRequest>();
  for (const record of records) {
    if (record.type !== "STYLE" || ((numeric(record,70) ?? 0) & 1)) continue;
    const name = first(record,2), file = first(record,3);
    if (!name) continue;
    styles.set(name.toUpperCase(), { name: file ?? name, width: numeric(record,41), oblique: numeric(record,50),
      bigfont: first(record,4) || undefined });
  }

  return function textPlan(shape: CadShape, record?: Entity) {
    const uses = new Map<string,CadFontUse>();
    const limits = new Set<string>();
    function visit(node: CadShape) {
      for (const piece of node.pieces ?? []) visit(piece);
      if (!node.text) return;
      const style = firstRecord(record,7) ?? "Standard";
      const defined = styles.get(style.toUpperCase());
      const defaultRequest = node.fontRequest ?? defined ?? { name: style };
      const mtext = record?.type === "MTEXT";
      const original = record && !node.fontRequest && !mtext ? first(record,1) ?? node.text : node.text;
      const content = normalize(original);
      const base = node.height ?? 1;
      const spans: CadTextSpan[] = [];
      const stack: Request[] = [];
      const entityWidth = record && !mtext ? numeric(record,41) : undefined;
      const entityOblique = record && !mtext ? numeric(record,51) : undefined;
      let request: Request = { ...defaultRequest, width: entityWidth || defaultRequest.width || 1,
        oblique: entityOblique ?? defaultRequest.oblique ?? 0, size: base };
      let x = 0, y = 0, lineHeight = base;
      function append(char: string) {
        if (char === "\n") { x = 0; y += lineHeight * 1.2; lineHeight = base; return; }
        const found = assets.select(request.name,request.bold,request.italic);
        const cp = char.codePointAt(0)!;
        const glyph = found?.font.glyph(cp);
        const asset = glyph ? found : undefined;
        const use: CadFontUse = asset
          ? { name: asset.key, sha256: asset.sha256, kind: asset.kind }
          : { name: request.name, fallback: found ? "glyph" : "font", ...(found ? { glyph: char } : {}) };
        if (!asset) limits.add(found ? "cad_font_glyph_substitution" : "cad_font_substitution");
        if (request.bigfont) {
          limits.add("cad_bigfont_unsupported");
          mergeFontUses(uses,[{ name: request.bigfont, fallback: "bigfont" }]);
        }
        mergeFontUses(uses,[use]);
        const advance = (glyph && asset ? glyph.advance / asset.font.capHeight : .62) * request.size * request.width!;
        const prev = spans.at(-1);
        if (prev && prev.sha256 === asset?.sha256 && prev.y === y && prev.height === request.size
            && prev.width === request.width && prev.oblique === request.oblique) {
          prev.text += char; prev.advance += advance;
        } else spans.push({ text: char, sha256: asset?.sha256, x, y,
          height: request.size, width: request.width!, oblique: request.oblique!, advance });
        x += advance;
        lineHeight = Math.max(lineHeight,request.size);
      }
      for (let i = 0; i < content.length;) {
        const cp = content.codePointAt(i)!;
        const char = String.fromCodePoint(cp);
        i += char.length;
        if (!mtext) { append(char); continue; }
        if (char === "{" && stack.length < 32) { stack.push({ ...request }); continue; }
        if (char === "}" && stack.length) { request = stack.pop()!; continue; }
        if (char !== "\\" || i >= content.length) { append(char); continue; }
        const code = content[i++];
        if ("\\{}".includes(code)) { append(code); continue; }
        if (code === "~") { append(" "); continue; }
        if (code === "P" || code === "X") { append("\n"); continue; }
        if ("LlOoKk".includes(code)) continue;
        const end = content.indexOf(";",i);
        if (!"fFHWQACcSTpq".includes(code) || end < 0 || end - i > 256) {
          limits.add("cad_text_render_approximate"); continue;
        }
        const raw = content.slice(i,end); i = end + 1;
        const amount = Number(raw.replace(/x$/i,""));
        if (code === "f" || code === "F") {
          const [name, ...flags] = raw.split("|");
          if (name) request = { ...request, name, bigfont: undefined,
            bold: flags.includes("b1"), italic: flags.includes("i1") };
        } else if (code === "H" && amount > 0 && amount <= 1e7) request.size = /x$/i.test(raw) ? request.size * amount : amount;
        else if (code === "W" && amount >= .01 && amount <= 100) request.width = amount;
        else if (code === "Q" && Math.abs(amount) < 85) request.oblique = amount;
        else if (code === "S") {
          limits.add("cad_text_render_approximate");
          for (const fragment of raw.replace(/[#^]/g,"/")) append(fragment);
        } else limits.add("cad_text_render_approximate");
        if (request.size > 1e8 || request.size < 1e-8) request.size = base;
        if (spans.length > 1024) { limits.add("cad_text_limit"); break; }
      }
      node.textSpans = spans;
    }
    visit(shape);
    return { fonts: [...uses.values()], limits: [...limits] };
  };
}

function firstRecord(record: Entity | undefined, code: number) {
  return record ? first(record,code) : undefined;
}
