import { createHash } from "node:crypto";
import { decodeText, FormatHold, unit } from "./model.js";
import type { CadShape, Parsed, Row, Unit } from "./model.js";

type Group = { code: number; value: string };
type Entity = { type: string; groups: Group[] };
const first = (record: Entity, code: number): string | undefined =>
  record.groups.find((group) => group.code === code)?.value.trim();

function dxfRecords(text: string): Entity[] {
  const lines = text.split(/\r\n|\n|\r/u);
  // Preserve empty group values and consume only the physical final newline.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 || lines.length > 500_000) throw new FormatHold("dxf_group_limit_or_invalid");
  const records: Entity[] = [];
  let record: Entity = { type: "", groups: [] };
  for (let offset = 0; offset < lines.length; offset += 2) {
    const key = lines[offset].trim();
    if (!/^\d{1,4}$/.test(key)) throw new FormatHold("dxf_group_invalid");
    const code = Number(key);
    const value = lines[offset + 1];
    if (code === 0) {
      records.push(record);
      record = { type: value.trim().toUpperCase(), groups: [] };
    } else record.groups.push({ code, value });
  }
  records.push(record);
  if (records.at(-1)?.type !== "EOF") throw new FormatHold("dxf_eof_missing");
  return records;
}

function cadText(entity: Entity) {
  const parts = entity.groups.filter((group) => [1, 3].includes(group.code));
  const verbatim = parts.map((part) => part.value).join("");
  if (verbatim.length > 8192) throw new FormatHold("cad_text_limit");
  return verbatim.replace(/\\U\+([a-f0-9]{4})/gi, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16))).replace(/\\P/g, "\n");
}

function numeric(entity: Entity, code: number) {
  const value = first(entity, code);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e9 ? number : undefined;
}

export function parseDxf(input: Buffer): Parsed {
  if (input.subarray(0, 20).toString().startsWith("AutoCAD Binary DXF")) {
    throw new FormatHold("dxf_binary_unsupported");
  }
  const content = decodeText(input);
  const records = dxfRecords(content);
  const issues = new Set<string>();
  const spaces = new Map<string, { rows: Row[]; shapes: CadShape[]; limitations: Set<string> }>();
  const space = (name: string) => {
    if (!spaces.has(name)) spaces.set(name, { rows: [], shapes: [], limitations: new Set() });
    return spaces.get(name)!;
  };
  space("Model");
  const ownerLayouts = new Map<string, string>();
  const views = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const record of records) {
    if (record.type === "LAYOUT") {
      const name = first(record, 1);
      const owner = record.groups.filter((group) => group.code === 330).at(-1)?.value.trim().toUpperCase();
      if (name) {
        space(name);
        if (owner) ownerLayouts.set(owner, name);
      }
    }
    if (record.type === "VIEW") {
      const name = first(record, 2);
      const centerX = numeric(record, 10);
      const centerY = numeric(record, 20);
      const height = numeric(record, 40);
      const width = numeric(record, 41);
      const direction = numeric(record, 31);
      if (name && name.length <= 300 && !views.has(name) && width && height && width > 0 && height > 0
          && centerX !== undefined && centerY !== undefined && !numeric(record, 50)
          && !numeric(record, 11) && !numeric(record, 21) && (direction === undefined || direction === 1)) {
        views.set(name, { x: centerX - width / 2, y: -centerY - height / 2, width, height });
      } else issues.add("cad_named_view_unsupported");
    }
    if (record.type === "BLOCK" && (Number(first(record, 70)) & 12)) issues.add("cad_external_reference");
    if (record.type === "STYLE") {
      const font = first(record, 3);
      if ((font && !/^(?:txt\.shx|simplex\.shx)$/i.test(font)) || first(record, 4)) {
        issues.add("cad_font_substitution");
      }
    }
  }

  let section = "";
  let entities = false;
  const handles = new Set<string>();
  for (const record of records) {
    if (record.type === "SECTION") {
      section = first(record, 2) ?? "";
      if (section === "ENTITIES") entities = true;
      continue;
    }
    if (record.type === "ENDSEC") {
      section = "";
      continue;
    }
    if (section !== "ENTITIES") continue;
    const name = first(record, 410) || ownerLayouts.get(first(record, 330)?.toUpperCase() ?? "")
      || (first(record, 67) === "1" ? "Paper" : "Model");
    const layout = space(name);
    if (layout.rows.length >= 6000 || layout.shapes.length > 15000) throw new FormatHold("cad_entity_limit");
    const handle = first(record, 5)?.toUpperCase();
    if (!handle || !/^[0-9A-F]{1,16}$/.test(handle) || handles.has(handle)) {
      layout.limitations.add("cad_entity_handle_unconfirmed");
      continue;
    }
    handles.add(handle);
    const type = record.type;
    const text = ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(type) ? cadText(record) : "";
    const x = numeric(record, 10);
    const y = numeric(record, 20);
    const layer = first(record, 8) ?? "0";
    const locator = { space: name, handle };
    const row: Row = { locator, text, details: { layer, entity: type } };
    layout.rows.push(row);
    if (x === undefined || y === undefined) {
      layout.limitations.add("cad_entity_geometry_unavailable");
      continue;
    }
    const shape = { handle, layer, kind: type, x, y };
    const extrusion = numeric(record, 230);
    if (numeric(record, 30) || numeric(record, 210) || numeric(record, 220)
        || (extrusion !== undefined && extrusion !== 1)) layout.limitations.add("cad_nonplanar_projection");
    if (text) {
      const height = numeric(record, 40) ?? 1;
      if (height <= 0) {
        layout.limitations.add("cad_entity_geometry_unavailable");
        continue;
      }
      if (/(?:\\[A-Za-z]|%%)/u.test(text) || numeric(record, 72) || numeric(record, 73)
          || type === "MTEXT") layout.limitations.add("cad_text_render_approximate");
      layout.shapes.push({ ...shape, text, height, angle: numeric(record, 50) ?? 0 });
      row.bounds = { x, y, width: Math.max(height, text.length * height * 0.62), height };
    } else if (type === "LINE") {
      const x2 = numeric(record, 11);
      const y2 = numeric(record, 21);
      if (x2 === undefined || y2 === undefined) {
        layout.limitations.add("cad_entity_geometry_unavailable");
        continue;
      }
      layout.shapes.push({ ...shape, x2, y2 });
      row.bounds = { x: Math.min(x, x2), y: Math.min(y, y2), width: Math.abs(x2 - x), height: Math.abs(y2 - y) };
    } else if (type === "CIRCLE") {
      const radius = numeric(record, 40);
      if (!radius || radius <= 0) {
        layout.limitations.add("cad_entity_geometry_unavailable");
        continue;
      }
      layout.shapes.push({ ...shape, radius });
      row.bounds = { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
    } else if (type === "LWPOLYLINE") {
      if (record.groups.some((group) => [40, 41, 42, 43].includes(group.code) && Number(group.value))) {
        layout.limitations.add("cad_polyline_segments_approximate");
      }
      const xs = record.groups.filter((group) => group.code === 10).map((group) => Number(group.value));
      const ys = record.groups.filter((group) => group.code === 20).map((group) => Number(group.value));
      if (xs.length < 2 || xs.length !== ys.length || xs.length > 1000 || [...xs, ...ys].some(
        (coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 1e9,
      )) {
        layout.limitations.add("cad_entity_geometry_unavailable");
        continue;
      }
      if (Number(first(record, 70)) & 1) { xs.push(xs[0]); ys.push(ys[0]); }
      for (let index = 1; index < xs.length; index++) {
        layout.shapes.push({ ...shape, x: xs[index - 1], y: ys[index - 1], x2: xs[index], y2: ys[index] });
      }
    } else {
      layout.limitations.add("cad_entity_type_unsupported");
    }
  }
  if (!entities) throw new FormatHold("dxf_entities_section_missing");

  const units: Unit[] = [...spaces].map(([name, { rows, shapes, limitations }]) => {
    if (name.length > 300) throw new FormatHold("cad_layout_name_limit");
    const id = `space:${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
    return { ...unit(id, name, { space: name }, rows, [...new Set([...issues, ...limitations])]), cad: shapes };
  });
  const model = space("Model");
  if (views.size > 200) throw new FormatHold("cad_view_limit");
  for (const [name, frame] of views) {
    const visible = model.rows.filter(({ bounds }) => bounds && bounds.x + bounds.width >= frame.x
      && bounds.x <= frame.x + frame.width && -bounds.y >= frame.y
      && -bounds.y - bounds.height <= frame.y + frame.height);
    const id = `view:${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
    units.push({ ...unit(id, name, { space: "Model", view: name }, visible,
      [...new Set([...issues, ...model.limitations, "cad_view_projection_approximate"])]),
      cad: model.shapes, cadView: frame });
  }
  return { units };
}

const ifcRoot = /^IFC(?:PROJECT|SITE|BUILDING|BUILDINGSTOREY|SPACE|WALL|WALLSTANDARDCASE|SLAB|BEAM|COLUMN|MEMBER|PLATE|DOOR|WINDOW|CURTAINWALL|ROOF|OPENINGELEMENT|PROPERTYSET|ELEMENTQUANTITY|REL[A-Z0-9]+|PROXY|BUILDINGELEMENTPROXY|FURNISHINGELEMENT|FLOWTERMINAL)$/;

function parseStepRecords(content: string): string[] {
  const result: string[] = [];
  let index = 0;
  let start = 0;
  let quoted = false;
  while (index < content.length) {
    const character = content[index];
    if (character === "'" && quoted && content[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (character === "'") quoted = !quoted;
    if (!quoted && content.startsWith("/*", index)) {
      const end = content.indexOf("*/", index + 2);
      if (end === -1) throw new FormatHold("ifc_step_comment_invalid");
      result.push(content.slice(start, index));
      index = end + 2;
      start = index;
      continue;
    }
    if (!quoted && character === ";") {
      result.push(content.slice(start, index + 1));
      start = index + 1;
      if (result.length > 100_000) throw new FormatHold("ifc_record_limit");
    }
    index++;
  }
  if (quoted || content.slice(start).trim()) throw new FormatHold("ifc_step_invalid");
  // Comments can bisect an entity. Rejoin those fragments before interpreting records.
  const records: string[] = [];
  let record = "";
  for (const fragment of result) {
    record += fragment;
    if (fragment.endsWith(";")) { records.push(record.trim()); record = ""; }
  }
  return records;
}

export function parseIfc(input: Buffer): Parsed {
  const records = parseStepRecords(decodeText(input));
  if (records[0] !== "ISO-10303-21;" || records[1] !== "HEADER;" || records.at(-1) !== "END-ISO-10303-21;") {
    throw new FormatHold("ifc_step_header_invalid");
  }
  const schema = records.find((record) => record.startsWith("FILE_SCHEMA"))?.match(/'([^']+)'/)?.[1];
  if (!schema || !/^IFC(?:2X3|4(?:X3(?:_ADD[12])?)?)$/i.test(schema)) throw new FormatHold("ifc_schema_unsupported");
  const start = records.indexOf("DATA;");
  const end = records.indexOf("ENDSEC;", start + 1);
  if (start < 0 || end < 0) throw new FormatHold("ifc_step_data_missing");

  const objects: Row[] = [];
  const ids = new Set<string>();
  const guids = new Set<string>();
  const limitations = new Set(["ifc_geometry_not_rendered"]);
  if (end !== records.length - 2) limitations.add("ifc_multiple_data_sections_partial");
  for (const record of records.slice(start + 1, end)) {
    const match = /^#([1-9]\d{0,14})\s*=\s*(IFC[A-Z0-9]+)\s*\(([\s\S]*)\)\s*;$/i.exec(record);
    if (!match || ids.has(match[1])) throw new FormatHold("ifc_step_entity_invalid");
    const [, id, entity, attributes] = match;
    ids.add(id);
    const type = entity.toUpperCase();
    const guid = ifcRoot.test(type) ? /^\s*'([0-3][A-Za-z0-9_$]{21})'/.exec(attributes)?.[1] : undefined;
    if (guid && guids.has(guid)) limitations.add("ifc_global_id_ambiguous");
    if (guid) guids.add(guid);
    if (record.length > 8192) {
      limitations.add("ifc_entity_attributes_truncated");
    }
    objects.push({
      locator: { step: `#${id}`, ...(guid ? { globalId: guid } : {}) },
      text: record.slice(0, 8192),
      details: { entity: type, globalId: guid ?? null, truncated: record.length > 8192 },
    });
  }
  const units = [];
  for (let offset = 0; offset < Math.max(1, objects.length); offset += 100) {
    units.push(unit(`entities:${offset + 1}`, `Объекты IFC ${offset + 1}`,
      { firstObject: offset + 1, schema }, objects.slice(offset, offset + 100), [...limitations]));
  }
  return { units };
}
