import type { Unit } from "./model.js";
import { inventoryLimitation, matchInventory } from "./physical-inventory.js";
import type { PhysicalInventory } from "./physical-inventory.js";
import { attr, child, children, elements, relationships } from "./ooxml.js";
import type { Element } from "./ooxml.js";

const partPath = /^word\/(?:footnotes|endnotes|header\d+|footer\d+)\.xml$/;
const wordNamespace = /^(?:http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/wordprocessingml\/main)$/;
const sheetNamespace = /^(?:http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/spreadsheetml\/main)$/;
const relationshipNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeDocumentTypes = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const xlsxValueLimits = new Set(["xlsx_formula_cache_unverified", "xlsx_formula_value_missing", "xlsx_cell_error"]);
const key = (...parts: (string | number | undefined)[]) => JSON.stringify(parts);
const local = (node: Element) => node.name.split(":").at(-1)!;

function rootedAt(files: Map<string, Element>, name: string) {
  const root = files.get("_rels/.rels");
  if (root?.name !== "Relationships" || root.namespace !== relationshipNamespace) return false;
  const targets = [...relationships(root, "").values()].filter(({ type }) => officeDocumentTypes.has(type));
  return targets.length === 1 && !targets[0].external && targets[0].path === name;
}

function wordContentLoss(root: Element) {
  for (const node of elements(root)) {
    const name = local(node);
    if (["drawing", "pict", "object", "AlternateContent", "contentPart"].includes(name)) return "docx_graphics_unmapped";
    if (["altChunk", "sdt", "del", "ins", "moveFrom", "moveTo", "subDoc", "txbxContent", "sym",
      "oMath", "oMathPara"].includes(name)) return "docx_inline_content_partial";
  }
}

export function docxInventory(
  body: Element, files: Map<string, Element>, paths: ReadonlySet<string>, units: Unit[],
): PhysicalInventory {
  const document = files.get("word/document.xml")!;
  if (!wordNamespace.test(body.namespace) || !wordNamespace.test(document.namespace) ||
      children(document, "body").length !== 1 || !rootedAt(files, "word/document.xml")) {
    return { limitation: "docx_source_root_unverified" };
  }
  for (const [path, part] of files) {
    if (!partPath.test(path) && path !== "word/document.xml" && path !== "word/comments.xml") continue;
    const loss = wordContentLoss(part);
    if (loss) return { limitation: loss };
    if (path !== "word/document.xml" && [...elements(part)].some((node) => node.name === "tbl")) {
      return { limitation: "docx_auxiliary_table_unmapped" };
    }
  }
  if ([...paths].some((path) => /^word\/(?:media|drawings|charts|diagrams|embeddings)\//i.test(path))) {
    return { limitation: "docx_graphics_unmapped" };
  }
  const limitation = inventoryLimitation(units);
  if (limitation) return { limitation };
  const parts = relationships(files.get("word/_rels/document.xml.rels"), "word/document.xml");
  const unmappedPart = [...parts.values()].find(({ path, type, external }) => {
    const kind = type.split("/").at(-1);
    if (kind === "hyperlink") return false;
    if (["numbering", "theme", "fontTable", "settings", "webSettings"].includes(kind ?? "")) return external;
    return !["styles", "comments", "header", "footer", "footnotes", "endnotes"].includes(kind ?? "") ||
      external || !files.has(path);
  });
  if (unmappedPart) return { limitation: "docx_related_part_unmapped" };

  const source: string[] = [];
  let paragraph = 0;
  let table = 0;
  for (const block of body.children) {
    if (!wordNamespace.test(block.namespace)) return { limitation: "docx_body_structure_unmapped" };
    if (block.name === "p") source.push(key("paragraph", ++paragraph));
    else if (block.name === "tbl") {
      source.push(key("table", ++table));
      const rows = children(block, "tr");
      if (block.children.some(({ name }) => !["tr", "tblPr", "tblGrid"].includes(name))) {
        return { limitation: "docx_table_structure_unmapped" };
      }
      for (const [offset, row] of rows.entries()) {
        source.push(key("table-row", table, offset + 1));
        let column = Number(attr(child(child(row, "trPr"), "gridBefore"), "val") ?? 0) + 1;
        for (const entry of row.children) {
          if (entry.name === "trPr" || entry.name === "tblPrEx") continue;
          if (entry.name !== "tc" || entry.children.some(({ name }) => !["tcPr", "p"].includes(name))) {
            return { limitation: "docx_table_structure_unmapped" };
          }
          source.push(key("cell", table, offset + 1, column));
          column += Number(attr(child(child(entry, "tcPr"), "gridSpan"), "val") ?? 1);
        }
      }
    } else if (block.name !== "sectPr") return { limitation: "docx_body_structure_unmapped" };
  }
  for (const [path, part] of files) {
    if (!partPath.test(path)) continue;
    const name = path.slice(5, -4);
    source.push(key("part", name));
    const paragraphs = [...elements(part)].filter((node) => wordNamespace.test(node.namespace) && node.name === "p");
    paragraphs.forEach((_, offset) => source.push(key("part-paragraph", name, offset + 1)));
  }
  const comments = children(files.get("word/comments.xml"), "comment");
  const commentIds = new Set(comments.map((node) => attr(node, "id")));
  if (commentIds.has(undefined) || commentIds.size !== comments.length) return { limitation: "docx_comment_unavailable" };
  const seenComments = new Set<string | undefined>();
  for (const node of elements(body)) {
    const id = attr(node, "id");
    if (node.name === "commentReference") {
      if (!commentIds.has(id)) return { limitation: "docx_comment_unavailable" };
      seenComments.add(id);
    }
    if (node.name === "headerReference" || node.name === "footerReference") {
      const relation = parts.get(id ?? "");
      if (!relation || !relation.type.endsWith("/" + node.name.slice(0, -9))) {
        return { limitation: "docx_related_part_unmapped" };
      }
    }
    if (node.name === "footnoteReference" || node.name === "endnoteReference") {
      const kind = node.name.slice(0, -9);
      const relation = [...parts.values()].find(({ type }) => type.endsWith("/" + kind + "s"));
      if (!relation || !children(files.get(relation.path), kind).some((entry) => attr(entry, "id") === id)) {
        return { limitation: "docx_related_part_unmapped" };
      }
    }
  }
  if (commentIds.size !== seenComments.size) return { limitation: "docx_comment_unmapped" };
  if (!source.length) source.push(key("body"));

  const mapped = new Set<string>();
  const places: string[] = [];
  for (const { locator, rows, physicalRows } of units) {
    const { table, part, firstRow, lastRow, firstParagraph, lastParagraph } = locator;
    if (typeof table === "number") {
      mapped.add(key("table", table));
      for (const row of physicalRows ?? []) {
        places.push(row >= Number(firstRow) && row <= Number(lastRow) ? key("table-row", table, row) : "");
      }
      for (const { locator: row } of rows) {
        places.push(row.table === table && Number(row.row) >= Number(firstRow) && Number(row.row) <= Number(lastRow)
          ? key("cell", table, row.row, row.column) : "");
      }
    } else if (part === "body") {
      places.push(key("body"));
    } else if (typeof part === "string") {
      mapped.add(key("part", part));
      rows.forEach(({ locator: row }, offset) => places.push(row.part === part && row.paragraph === Number(firstParagraph) + offset
        ? key("part-paragraph", part, row.paragraph) : ""));
    } else {
      rows.forEach(({ locator: row }, offset) => places.push(
        row.paragraph === Number(firstParagraph) + offset && Number(row.paragraph) <= Number(lastParagraph)
          ? key("paragraph", row.paragraph) : ""));
    }
  }
  return matchInventory(source, [...mapped, ...places], "docx_structure_inventory_mismatch");
}

export function xlsxInventory(
  workbook: Element, files: Map<string, Element>, paths: ReadonlySet<string>, units: Unit[],
): PhysicalInventory {
  if (!sheetNamespace.test(workbook.namespace) || !rootedAt(files, "xl/workbook.xml")) {
    return { limitation: "xlsx_source_root_unverified" };
  }
  if ([...paths].some((path) => /^xl\/(?:drawings|media|charts|chartsheets|macrosheets|diagrams|embeddings)\//i.test(path))) {
    return { limitation: "xlsx_graphics_or_sheet_part_unmapped" };
  }
  const limitation = inventoryLimitation(units, xlsxValueLimits);
  if (limitation) return { limitation };
  const relations = relationships(files.get("xl/_rels/workbook.xml.rels"), "xl/workbook.xml");
  const source: string[] = [];
  const targets = new Set<string>();
  const sheets = children(workbook, "sheets");
  if (sheets.length !== 1 || sheets[0].children.some((node) => node.name !== "sheet" || !sheetNamespace.test(node.namespace)) ||
      workbook.children.some((node) => ["AlternateContent", "extLst"].includes(local(node)))) {
    return { limitation: "xlsx_sheet_structure_unmapped" };
  }
  for (const sheet of sheets[0].children) {
    const id = attr(sheet, "sheetId");
    const name = attr(sheet, "name");
    const relation = relations.get(attr(sheet, "id") ?? "");
    const part = relation && files.get(relation.path);
    if (!relation || !part || !sheetNamespace.test(part.namespace) || targets.has(relation.path)) {
      return { limitation: "xlsx_sheet_part_unverified" };
    }
    targets.add(relation.path);
    source.push(key("sheet", id, name));
    const data = children(part, "sheetData");
    if (data.length !== 1 || data[0].children.some((node) => node.name !== "row" || !sheetNamespace.test(node.namespace))) {
      return { limitation: "xlsx_row_structure_unmapped" };
    }
    if ([...elements(part)].some((node) => ["AlternateContent", "drawing", "legacyDrawing", "legacyDrawingHF",
      "picture", "controls", "oleObjects", "extLst"].includes(local(node)))) {
      return { limitation: "xlsx_sheet_features_partial" };
    }
    if (child(part, "headerFooter")?.children.some(({ value }) => value.trim())) {
      return { limitation: "xlsx_header_footer_unmapped" };
    }
    for (const row of data[0].children) {
      const number = Number(attr(row, "r"));
      source.push(key("row", id, name, number));
      for (const cell of row.children) {
        if (cell.name !== "c" || !sheetNamespace.test(cell.namespace)) return { limitation: "xlsx_row_structure_unmapped" };
        source.push(key("cell", id, name, attr(cell, "r")));
      }
    }
    for (const merge of children(child(part, "mergeCells"), "mergeCell")) {
      source.push(key("merge", id, name, attr(merge, "ref")));
    }
  }
  if ([...paths].some((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path) && !targets.has(path))) {
    return { limitation: "xlsx_worksheet_undeclared" };
  }
  const mapped = new Set<string>();
  const places: string[] = [];
  for (const { locator, rows, physicalRows } of units) {
    const id = locator.sheetId;
    const name = locator.sheet;
    mapped.add(key("sheet", id, name));
    const inWindow = (row: number) => row >= Number(locator.firstRow) && row <= Number(locator.lastRow);
    for (const row of physicalRows ?? []) places.push(inWindow(row) ? key("row", id, name, row) : "");
    for (const { locator: row } of rows) {
      places.push(row.sheetId === id && row.sheet === name && inWindow(Number(row.row))
        ? row.merge ? key("merge", id, name, row.merge) : key("cell", id, name, row.cell) : "");
    }
  }
  return matchInventory(source, [...mapped, ...places], "xlsx_structure_inventory_mismatch");
}
