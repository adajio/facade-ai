import { createHash } from "node:crypto";
import { decodeText, FormatHold, unit } from "./model.js";
import { dxfLineEnding } from "./dwg-text.js";
import { projectLengthAssignment } from './ifc-units.js';
import type { CadShape, Locator, Parsed, Row, Unit } from "./model.js";
import { inventoryLimitation, matchInventory } from "./physical-inventory.js";
import type { PhysicalInventory } from "./physical-inventory.js";

type Group = { code: number; value: string };
export type Entity = { type: string; groups: Group[]; limitation?: string };
type CadRecord = { entity: boolean; block?: boolean; record: Entity;
  sort?: { owner: string; handle: string; order: string } };
export const first = (record: Entity, code: number): string | undefined =>
  record.groups.find((group) => group.code === code)?.value.trim();

function checkDxfValue(record: Entity, code: number, value: string) {
  // LibreDWG can emit raw newline bytes within CRLF-framed MTEXT chunks.
  // A stray delimiter in any other value cannot be accepted as a framing repair.
  if (/[\r\n]/u.test(value) && !(record.type === "MTEXT" && (code === 1 || code === 3) && !value.includes("\r"))) {
    throw new FormatHold("dxf_group_invalid");
  }
}

function dxfRecords(text: string): Entity[] {
  const ending = dxfLineEnding(text);
  const lines = ending ? text.split(ending) : [text];
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
    checkDxfValue(record, code, value);
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

export function numeric(entity: Entity, code: number) {
  const value = first(entity, code);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e9 ? number : undefined;
}

export function parseDxf(input: Buffer, checkInventory = false): Parsed {
  if (input.subarray(0, 20).toString().startsWith("AutoCAD Binary DXF")) {
    throw new FormatHold("dxf_binary_unsupported");
  }
  const records = dxfRecords(decodeText(input));
  const parsed = parseCadRecords(records);
  return checkInventory ? { ...parsed, inventory: dxfInventory(records, parsed.units) } : parsed;
}

const cadRowsPerSpace = 6000;
const cadShapesPerSpace = 15000;
const cadTextEntities = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);
const polylineGroups = new Set([10, 20, 40, 41, 42, 43]);
const cadEntityGroups = new Set([1, 3, 5, 7, 8, 10, 11, 20, 21, 30, 31, 40, 41, 42, 43, 50, 51, 60, 67, 70, 72, 73,
  210, 220, 230, 330, 410]);
const cadMetadataGroups = new Map<string, Set<number>>([
  ["SECTION", new Set([2])], ["ENDSEC", new Set()],
  ["LAYOUT", new Set([1, 330])], ["VIEW", new Set([2, 10, 11, 20, 21, 31, 40, 41, 50])],
  ["BLOCK", new Set([1, 2, 10, 20, 30, 70, 330])], ["STYLE", new Set([2, 3, 4, 40, 41, 50, 70, 71])],
  ["LAYER", new Set([2, 5, 62, 70])],
]);

const blockAddress = new Set([5, 8, 60, 67, 330, 410]);
const blockGeometry = new Set([...cadTextEntities, "LINE", "CIRCLE", "ARC", "LWPOLYLINE", "INSERT", "DIMENSION", "VIEWPORT", "ACAD_PROXY_ENTITY", "HATCH", "WIPEOUT"]);
const extraGeometryGroups = new Map<string, number[]>([
  ["INSERT", [2, 44, 45, 60, 71]], ["DIMENSION", [2, 60]], ["ARC", [51, 60]],
  ["LWPOLYLINE", [60]], ["LINE", [60]], ["CIRCLE", [60]],
  ["ACAD_PROXY_ENTITY", [60, 92, 93, 160, 161, 310]],
  ["HATCH", [2, 12, 13, 22, 23, 51, 52, 53, 60, 44, 45, 46, 49, 74, 75, 76, 77, 78, 79, 91, 92,
    93, 94, 95, 96, 97, 98, 450]],
  ["WIPEOUT", [12, 13, 14, 22, 23, 24, 32, 60, 71, 91, 280, 290]],
  ["VIEWPORT", [12, 16, 17, 22, 26, 27, 36, 37, 45, 51, 60, 68, 69, 90, 281, 331, 340]],
]);
const drawingGroups = new Map([...extraGeometryGroups].map(([type, groups]) =>
  [type, new Set([...cadEntityGroups, ...groups])]));

// Keep only fields used by the reader, without accumulating the section in memory.
export async function* convertedDxfRecords(
  lines: AsyncIterable<string>, decodeValue = (line: string) => line,
): AsyncGenerator<CadRecord> {
  let section = "";
  let entities = false;
  let eof = false;
  let record: Entity = { type: "", groups: [] };
  let code: number | undefined;
  let characters = 0;
  let layoutSubclass = false;
  let sortOwner = "";
  let sortEntity = "";
  let sortSubclass = false;
  let sortFlag = false;
  const single = new Map<number, Group>();
  let keys: Set<number> | undefined;

  function finish() {
    const entity = section === "ENTITIES" && !["SECTION", "ENDSEC", "EOF"].includes(record.type);
    if (!record.type) return;
    if (eof) throw new FormatHold("dxf_group_invalid");
    if (record.type === "SECTION") {
      if (section) throw new FormatHold("dxf_section_inventory_invalid");
      section = first(record, 2) ?? "";
      if (!section || (section === "ENTITIES" && entities)) throw new FormatHold("dxf_section_inventory_invalid");
      if (section === "ENTITIES") entities = true;
    } else if (record.type === "ENDSEC") {
      if (!section) throw new FormatHold("dxf_section_inventory_invalid");
      section = "";
    } else if (record.type === "EOF") {
      if (section) throw new FormatHold("dxf_eof_missing");
      eof = true;
    } else if (section === "BLOCKS") return { entity: false, block: true, record };
    else if (entity || cadMetadataGroups.has(record.type)) return { entity, record };
  }

  for await (const line of lines) {
    if (code === undefined) {
      if (!/^[ \t]*\d{1,4}[ \t]*$/.test(line)) throw new FormatHold("dxf_group_invalid");
      code = Number(line);
      continue;
    }
    checkDxfValue(record, code, line);
    const header = section === "HEADER" || (record.type === "SECTION" && first(record, 2) === "HEADER");
    if (code === 0) {
      const previous = finish();
      if (previous) yield previous;
      record = { type: decodeValue(line).trim().toUpperCase() || "UNKNOWN", groups: [] };
      layoutSubclass = false;
      sortOwner = "";
      sortEntity = "";
      sortSubclass = false;
      const drawing = section === "ENTITIES" || (section === "BLOCKS" && blockGeometry.has(record.type));
      keys = cadMetadataGroups.get(record.type) ?? (drawing ? drawingGroups.get(record.type) ?? cadEntityGroups
        : section === "BLOCKS" ? blockAddress : undefined);
      single.clear();
      characters = 0;
    } else if (header && code === 9) {
      sortFlag = line.trim() === "$SORTENTS";
    } else if (header && sortFlag && code === 280) {
      sortFlag = false;
      yield { entity: false, record: { type: "SORTENTS_FLAG", groups: [{ code, value: line.trim() }] } };
    } else if (section === "OBJECTS" && record.type === "SORTENTSTABLE") {
      if (code === 100) sortSubclass = line.trim() === "AcDbSortentsTable";
      if (sortSubclass && code === 330) sortOwner = line.trim().toUpperCase();
      if (sortSubclass && code === 331) sortEntity = line.trim().toUpperCase();
      if (sortSubclass && code === 5 && sortOwner && sortEntity) {
        yield { entity: false, record: { type: "", groups: [] },
          sort: { owner: sortOwner, handle: sortEntity, order: line.trim().toUpperCase() } };
        sortEntity = "";
      }
    } else if (record.type === "LAYOUT" && code === 100) {
      layoutSubclass = line.trim() === "AcDbLayout";
    } else if (keys?.has(code)) {
      const address = [5, 67, 330, 410].includes(code);
      const repeated = (record.type === "LWPOLYLINE" && polylineGroups.has(code))
        || (cadTextEntities.has(record.type) && (code === 1 || code === 3))
        || (record.type === "VIEWPORT" && code === 331)
        || (record.type === "HATCH" && ![5, 8, 60, 67, 330, 410].includes(code))
        || (record.type === "WIPEOUT" && (code === 14 || code === 24))
        || (record.type === "ACAD_PROXY_ENTITY" && code === 310);
      const existing = repeated ? undefined : single.get(code);
      if (!existing || (record.type === "LAYOUT" && (code === 330 || (code === 1 && layoutSubclass)))) {
        characters += line.length;
        if (!address && (record.groups.length >= 8192 || characters > 256 * 1024)) {
          if (section === "ENTITIES" || section === "BLOCKS") record.limitation ??= "cad_entity_projection_limit";
          else throw new FormatHold("cad_metadata_limit");
        } else {
          try {
            const group = { code, value: decodeValue(line) };
            if (existing) existing.value = group.value;
            else {
              record.groups.push(group);
              if (!repeated) single.set(code, group);
            }
          } catch (error) {
            if (!(error instanceof FormatHold) || !(section === "ENTITIES" || section === "BLOCKS") || address) throw error;
            record.limitation ??= error.code;
          }
        }
      }
    }
    code = undefined;
  }
  if (code !== undefined) throw new FormatHold("dxf_group_limit_or_invalid");
  const last = finish();
  if (last) yield last;
  if (!eof) throw new FormatHold("dxf_eof_missing");
  if (!entities) throw new FormatHold("dxf_entities_section_missing");
}

const dxfAddressLimits = new Set(["cad_entity_handle_unconfirmed"]);

function dxfInventory(records: Entity[], units: Unit[]): PhysicalInventory {
  if (units.some(({ limitations }) => limitations.includes("cad_external_reference"))) {
    return { limitation: "cad_external_reference" };
  }
  const limitation = inventoryLimitation(units, dxfAddressLimits);
  if (limitation) return { limitation };
  const sections = new Set<string>();
  const spaces = new Set(["Model"]);
  const owners = new Map<string, string>();
  const views: string[] = [];
  const entities: Entity[] = [];
  let section: string | undefined;
  for (const [offset, record] of records.entries()) {
    if (offset === 0 && record.type === "" && !record.groups.length) continue;
    if (record.type === "SECTION") {
      const name = first(record, 2);
      if (section || !name || sections.has(name)) return { limitation: "dxf_section_inventory_invalid" };
      section = name;
      sections.add(name);
    } else if (record.type === "ENDSEC") {
      if (!section) return { limitation: "dxf_section_inventory_invalid" };
      section = undefined;
    } else if (record.type === "EOF") {
      if (section || record.groups.length || offset !== records.length - 1) {
        return { limitation: "dxf_section_inventory_invalid" };
      }
    } else if (section === "ENTITIES") entities.push(record);
    else if (section === "BLOCKS") {
      if (record.type !== "BLOCK" && record.type !== "ENDBLK") return { limitation: "cad_block_geometry_unmapped" };
    } else if (section === "OBJECTS" && record.type === "LAYOUT") {
      const name = first(record, 1);
      const id = record.groups.filter(({ code }) => code === 330).at(-1)?.value.trim().toUpperCase();
      if (!name || !id || owners.has(id) || [...owners.values()].includes(name)) {
        return { limitation: "cad_layout_inventory_unconfirmed" };
      }
      spaces.add(name);
      owners.set(id, name);
    } else if (section === "TABLES" && record.type === "VIEW") {
      const name = first(record, 2);
      if (!name) return { limitation: "cad_named_view_unsupported" };
      views.push(name);
    } else if (!section || !["HEADER", "CLASSES", "TABLES", "OBJECTS"].includes(section)) {
      return { limitation: "dxf_section_inventory_unmapped" };
    }
  }

  const key = (...parts: (number | string | undefined)[]) => JSON.stringify(parts);
  const handles = new Map<string, number>();
  for (const entity of entities) {
    const handle = first(entity, 5)?.toUpperCase();
    if (handle) handles.set(handle, (handles.get(handle) ?? 0) + 1);
  }
  const source = entities.map((entity, offset) => {
    const name = first(entity, 410) || owners.get(first(entity, 330)?.toUpperCase() ?? "")
      || (first(entity, 67) === "1" ? "Paper" : "Model");
    spaces.add(name);
    const handle = first(entity, 5)?.toUpperCase();
    return handle && /^[0-9A-F]{1,16}$/.test(handle) && handles.get(handle) === 1
      ? key("handle", name, handle) : key("ordinal", name, offset + 1);
  });
  source.push(...[...spaces].map((name) => key("space", name)), ...views.map((name) => key("view", name)));
  const mapped = units.flatMap(({ locator, rows }) => locator.view ? [key("view", locator.view)] : [
    key("space", locator.space),
    ...rows.map(({ locator: row }) => row.space !== locator.space ? ""
      : row.handle ? key("handle", row.space, row.handle) : key("ordinal", row.space, row.entityOrdinal)),
  ]);
  return matchInventory(source, mapped, "dxf_structure_inventory_mismatch");
}

type CadSpace = { rows: Row[]; shapes: CadShape[]; limitations: Set<string> };

export function cadSpace(): CadSpace {
  return { rows: [], shapes: [], limitations: new Set() };
}

export function cadMetadata(records: Entity[], issues = new Set<string>()) {
  const layouts = new Set(["Model"]);
  const ownerLayouts = new Map<string, string>();
  const views = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const record of records) {
    if (record.type === "LAYOUT") {
      const name = first(record, 1);
      const owner = record.groups.filter((group) => group.code === 330).at(-1)?.value.trim().toUpperCase();
      if (name) {
        layouts.add(name);
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

  if (views.size > 200) throw new FormatHold("cad_view_limit");
  return { layouts, ownerLayouts, views, issues };
}

function parseCadRecords(records: Entity[], issues = new Set<string>()): Parsed {
  const { layouts, ownerLayouts, views } = cadMetadata(records, issues);
  const spaces = new Map([...layouts].map((name) => [name, cadSpace()]));
  const space = (name: string) => {
    if (!spaces.has(name)) spaces.set(name, cadSpace());
    return spaces.get(name)!;
  };

  let section = "";
  let entities = false;
  const sourceEntities: Entity[] = [];
  const handleCounts = new Map<string, number>();
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
    sourceEntities.push(record);
    const handle = first(record, 5)?.toUpperCase();
    if (handle) handleCounts.set(handle, (handleCounts.get(handle) ?? 0) + 1);
  }
  if (!entities) throw new FormatHold("dxf_entities_section_missing");

  for (const [index, record] of sourceEntities.entries()) {
    const name = first(record, 410) || ownerLayouts.get(first(record, 330)?.toUpperCase() ?? "")
      || (first(record, 67) === "1" ? "Paper" : "Model");
    const layout = space(name);
    if (layout.rows.length >= cadRowsPerSpace || layout.shapes.length > cadShapesPerSpace) throw new FormatHold("cad_entity_limit");
    const candidate = first(record, 5)?.toUpperCase();
    const handle = candidate && /^[0-9A-F]{1,16}$/.test(candidate) && handleCounts.get(candidate) === 1
      ? candidate : undefined;
    const entityOrdinal = index + 1;
    appendCadEntity(layout, record, name, entityOrdinal, handle);
  }
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

export function appendCadEntity(layout: CadSpace, record: Entity, name: string, entityOrdinal: number, handle?: string) {
  if (!handle) layout.limitations.add("cad_entity_handle_unconfirmed");
  const type = record.type;
  const text = cadTextEntities.has(type) && !record.limitation ? cadText(record) : "";
  const x = numeric(record, 10);
  const y = numeric(record, 20);
  const layer = first(record, 8) ?? "0";
  const locator: Locator = handle ? { space: name, handle } : { space: name, entityOrdinal };
  const row: Row = { locator, text, details: { layer, entity: type } };
  layout.rows.push(row);
  if (record.limitation) {
    layout.limitations.add(record.limitation);
    return;
  }
  if (x === undefined || y === undefined) {
    layout.limitations.add("cad_entity_geometry_unavailable");
    return;
  }
  const shape = { handle: handle ?? `ordinal:${entityOrdinal}`, layer, kind: type, x, y };
  const extrusion = numeric(record, 230);
  if (numeric(record, 30) || (type === "LINE" && numeric(record, 31)) || numeric(record, 210) || numeric(record, 220)
      || (extrusion !== undefined && extrusion !== 1)) layout.limitations.add("cad_nonplanar_projection");
  if (text) {
    const height = numeric(record, 40) ?? 1;
    if (height <= 0) {
      layout.limitations.add("cad_entity_geometry_unavailable");
      return;
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
      return;
    }
    layout.shapes.push({ ...shape, x2, y2 });
    row.bounds = { x: Math.min(x, x2), y: Math.min(y, y2), width: Math.abs(x2 - x), height: Math.abs(y2 - y) };
  } else if (type === "CIRCLE") {
    const radius = numeric(record, 40);
    if (!radius || radius <= 0) {
      layout.limitations.add("cad_entity_geometry_unavailable");
      return;
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
      return;
    }
    if (Number(first(record, 70)) & 1) { xs.push(xs[0]); ys.push(ys[0]); }
    for (let index = 1; index < xs.length; index++) {
      layout.shapes.push({ ...shape, x: xs[index - 1], y: ys[index - 1], x2: xs[index], y2: ys[index] });
    }
  } else {
    layout.limitations.add("cad_entity_type_unsupported");
  }
}

export async function* recoveryCadRecords(
  objects: AsyncIterable<unknown>, issues: Set<string>,
): AsyncGenerator<CadRecord> {
  issues.add("cad_dwg_json_recovery");
  let found = false;
  for await (const value of objects) {
    if (value === null || typeof value !== "object") continue;
    const object = value as Record<string, unknown>;
    const { entity, entmode, ins_pt: point, height, rotation, handle } = object;
    if (typeof entity !== "string") continue;
    if (entmode !== 1 && entmode !== 2) {
      issues.add("cad_dwg_entity_space_unconfirmed");
      continue;
    }
    const text = entity === "MTEXT" ? object.text : object.text_value;
    if (!cadTextEntities.has(entity) || typeof text !== "string") {
      issues.add("cad_dwg_recovery_text_only");
      continue;
    }
    const groups: Group[] = [
      { code: 67, value: entmode === 1 ? "1" : "0" },
      { code: 8, value: "?" },
      { code: 1, value: text.length <= 8192 ? text : "" },
    ];
    const handleValue = Array.isArray(handle) ? handle[2] : undefined;
    if (typeof handleValue === "number" && Number.isSafeInteger(handleValue) && handleValue > 0) {
      groups.push({ code: 5, value: handleValue.toString(16) });
    }
    if (Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)) {
      groups.push({ code: 10, value: String(point[0]) }, { code: 20, value: String(point[1]) });
    }
    if (Number.isFinite(height)) groups.push({ code: 40, value: String(height) });
    if (typeof rotation === "number" && Number.isFinite(rotation)) {
      groups.push({ code: 50, value: String(rotation * 180 / Math.PI) });
    }
    found = true;
    yield { entity: true, record: { type: entity, groups, ...(text.length > 8192 ? { limitation: "cad_text_limit" } : {}) } };
  }
  if (!found) throw new FormatHold("dwg_recovery_no_addressable_text");
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
  const projectUnits = end === records.length - 2 ? projectLengthAssignment(records.slice(start + 1, end)) : undefined;
  for (let offset = 0; offset < Math.max(1, objects.length); offset += 100) {
    units.push(unit(`entities:${offset + 1}`, `Объекты IFC ${offset + 1}`,
      { firstObject: offset + 1, schema, ...projectUnits }, objects.slice(offset, offset + 100), [...limitations]));
  }
  const limitation = ["ifc_multiple_data_sections_partial", "ifc_entity_attributes_truncated"]
    .find((code) => limitations.has(code)) ?? "ifc_geometry_not_rendered";
  return { units, inventory: { limitation } };
}
