import { FormatHold, unit } from "./model.js";
import type { Parsed, Row, Unit } from "./model.js";
import { docxInventory, xlsxInventory } from "./office-inventory.js";
import { attr, child, children, elements, relationships, unpackXml } from "./ooxml.js";
import type { Element } from "./ooxml.js";

function wordText(node: Element): string {
  let result = "";
  for (const element of elements(node)) {
    if (element.name === "t") result += element.value;
    else if (element.name === "tab") result += "\t";
    else if (element.name === "br" || element.name === "cr") result += "\n";
  }
  return result;
}

export async function parseDocx(input: Buffer, checkInventory = false): Promise<Parsed> {
  const paths = new Set<string>();
  const files = await unpackXml(input, (name) =>
    /^word\/(?:document|styles|comments|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(name)
    || name === "word/_rels/document.xml.rels" || (checkInventory && name === "_rels/.rels"),
    checkInventory ? paths : undefined);
  const root = files.get("word/document.xml");
  const body = child(root, "body");
  if (!body || root?.name !== "document") throw new FormatHold("docx_main_part_missing");

  const styles = new Map(children(files.get("word/styles.xml"), "style").map((style) => [
    attr(style, "styleId"), style,
  ]));
  const comments = new Map(children(files.get("word/comments.xml"), "comment").map((comment) => [
    attr(comment, "id"), wordText(comment),
  ]));
  const limitations = new Set<string>();
  for (const relation of relationships(files.get("word/_rels/document.xml.rels"), "word/document.xml").values()) {
    if (relation.external && !relation.type.endsWith("/hyperlink")) limitations.add("docx_external_content");
  }
  for (const node of elements(body)) {
    if (["drawing", "pict", "object", "altChunk", "del", "ins", "sdt", "mc:AlternateContent"].includes(node.name)) {
      limitations.add("docx_inline_content_partial");
    }
  }

  const units: Unit[] = [];
  const headings: string[] = [];
  let paragraph = 0;
  let table = 0;
  let pending: Row[] = [];
  const flush = () => {
    if (!pending.length) return;
    const first = pending[0].locator.paragraph;
    const last = pending.at(-1)!.locator.paragraph;
    units.push(unit(`paragraphs:${first}`, `Абзацы ${first}–${last}`,
      { firstParagraph: first, lastParagraph: last }, pending, [...limitations]));
    pending = [];
  };

  for (const block of body.children) {
    if (block.name === "p") {
      paragraph++;
      const properties = child(block, "pPr");
      const styleId = attr(child(properties, "pStyle"), "val");
      const style = styles.get(styleId);
      const styleLevel = attr(child(child(style, "pPr"), "outlineLvl"), "val");
      const heading = /^Heading([1-9])$/i.exec(styleId ?? "");
      const level = Number(attr(child(properties, "outlineLvl"), "val")
        ?? styleLevel ?? (heading ? Number(heading[1]) - 1 : NaN));
      const text = wordText(block);
      if (Number.isInteger(level) && level >= 0 && level < 9 && text) {
        headings.length = Math.min(headings.length, level);
        headings[level] = text;
      }
      const notes = [...elements(block)].filter((node) => node.name === "commentReference")
        .map((node) => ({ id: attr(node, "id"), text: comments.get(attr(node, "id")) ?? null }));
      pending.push({
        locator: { paragraph, section: headings.filter(Boolean).join(" / ") },
        text,
        details: { style: styleId ?? null, headingLevel: level < 9 ? level + 1 : null, comments: notes },
      });
      if (pending.length === 50) flush();
    } else if (block.name === "tbl") {
      flush();
      table++;
      const rows = children(block, "tr");
      const tableLimitations = new Set(limitations);
      const section = headings.filter(Boolean).join(" / ");
      const parsedRows: Row[][] = [];
      rows.forEach((row, offset) => {
        const properties = child(row, "trPr");
        const header = !!child(properties, "tblHeader") && !/^(?:0|false|off)$/.test(
          attr(child(properties, "tblHeader"), "val") ?? "",
        );
        let column = Number(attr(child(properties, "gridBefore"), "val") ?? 0) + 1;
        const cells: Row[] = [];
        for (const cell of children(row, "tc")) {
          const tcPr = child(cell, "tcPr");
          const merge = child(tcPr, "vMerge");
          const span = Number(attr(child(tcPr, "gridSpan"), "val") ?? 1);
          if (!Number.isInteger(span) || span < 1 || span > 16384
              || !Number.isInteger(column) || column < 1 || column + span > 16385) {
            throw new FormatHold("docx_grid_invalid");
          }
          const containsTable = !!child(cell, "tbl");
          if (containsTable) tableLimitations.add("docx_nested_table_partial");
          const paragraphs = children(cell, "p");
          const notes = paragraphs.flatMap((p) => [...elements(p)].filter((node) =>
            node.name === "commentReference").map((node) => ({
            id: attr(node, "id"), text: comments.get(attr(node, "id")) ?? null,
          })));
          cells.push({
            locator: { table, row: offset + 1, column, section },
            text: paragraphs.map(wordText).join("\n"),
            details: { header, columnSpan: span,
              verticalMerge: merge ? attr(merge, "val") ?? "continue" : null, comments: notes },
          });
          column += span;
        }
        parsedRows.push(cells);
      });
      for (let offset = 0; offset < Math.max(1, rows.length); offset += 25) {
        const lastRow = Math.min(offset + 25, rows.length);
        units.push({ ...unit(`table:${table}:${offset + 1}`, `Таблица ${table}, строки ${offset + 1}–${lastRow}`,
          { table, firstRow: offset + 1, lastRow, section },
          parsedRows.slice(offset, lastRow).flat(), [...tableLimitations]),
          physicalRows: parsedRows.slice(offset, lastRow).map((_, index) => offset + index + 1) });
      }
    }
  }
  flush();

  for (const [file, part] of files) {
    if (!/^word\/(?:footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(file)) continue;
    const name = file.slice(5, -4);
    const rows = [...elements(part)].filter((entry) => entry.name === "p").map((entry, index) => ({
      locator: { part: name, paragraph: index + 1 }, text: wordText(entry),
    }));
    if (rows.length > 50) limitations.add("docx_auxiliary_windowed");
    for (let index = 0; index < Math.max(1, rows.length); index += 50) {
      units.push(unit(`part:${name}:${index + 1}`, name, { part: name, firstParagraph: index + 1 },
        rows.slice(index, index + 50)));
    }
  }
  if (!units.length) units.push(unit("body", "Основной текст", { part: "body" }, [], [...limitations]));
  return { units, ...(checkInventory ? { inventory: docxInventory(body, files, paths, units) } : {}) };
}

const cellPattern = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

export function cellAddress(value: string) {
  const match = cellPattern.exec(value);
  if (!match) return undefined;
  const column = [...match[1]].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (column <= 16384 && row <= 1048576) return { column, row };
}

function richString(el: Element | undefined): string {
  return children(el, "t").map((part) => part.value).join("")
    + children(el, "r").map((part) => child(part, "t")?.value ?? "").join("");
}

export async function parseXlsx(input: Buffer, checkInventory = false): Promise<Parsed> {
  const paths = new Set<string>();
  const files = await unpackXml(input, (name) =>
    /^xl\/(?:workbook|sharedStrings|styles|worksheets\/[\w.-]+)\.xml$/.test(name)
    || name === "xl/_rels/workbook.xml.rels" || (checkInventory && name === "_rels/.rels"),
    checkInventory ? paths : undefined);
  const workbook = files.get("xl/workbook.xml");
  if (workbook?.name !== "workbook") throw new FormatHold("xlsx_workbook_missing");
  const relations = relationships(files.get("xl/_rels/workbook.xml.rels"), "xl/workbook.xml");
  const sharedPath = [...relations.values()].find((entry) => entry.type.endsWith("/sharedStrings"))?.path;
  const stylePath = [...relations.values()].find((entry) => entry.type.endsWith("/styles"))?.path;
  const shared = children(files.get(sharedPath ?? "xl/sharedStrings.xml"), "si").map(richString);
  const styles = files.get(stylePath ?? "xl/styles.xml");
  const customFormats = new Map(children(child(styles, "numFmts"), "numFmt").map((format) => [
    attr(format, "numFmtId"), attr(format, "formatCode"),
  ]));
  const cellFormats = children(child(styles, "cellXfs"), "xf").map((xf) => attr(xf, "numFmtId"));
  const external = [...relations.values()].some((entry) => entry.external || entry.type.endsWith("/externalLink"));
  const calc = child(workbook, "calcPr");
  const calculation = calc ? { ...calc.attributes } : null;

  const units: Unit[] = [];
  const seen = new Set<string>();
  for (const sheet of children(child(workbook, "sheets"), "sheet")) {
    const name = attr(sheet, "name");
    const id = attr(sheet, "sheetId");
    const relation = relations.get(attr(sheet, "id") ?? "");
    if (!id || !name || !/^\d{1,10}$/.test(id) || seen.has(id)) {
      throw new FormatHold("xlsx_sheet_identity_invalid");
    }
    seen.add(id);
    const content = relation && !relation.external ? files.get(relation.path) : undefined;
    if (!relation?.type.endsWith("/worksheet") || content?.name !== "worksheet") {
      units.push({
        ...unit(`sheet:${id}:1`, name, { sheet: name, sheetId: id }, [], ["xlsx_sheet_unavailable"]),
        coverage: "held",
      });
      continue;
    }
    const limitations = new Set<string>();
    if (external) limitations.add("xlsx_external_links");
    if (content.children.some((node) => ["drawing", "legacyDrawing", "oleObjects", "tableParts",
      "conditionalFormatting", "pivotTableParts"].includes(node.name))) limitations.add("xlsx_sheet_features_partial");
    const merges = children(child(content, "mergeCells"), "mergeCell").map((merge) => attr(merge, "ref"));
    const validMerges = merges.filter((ref): ref is string => {
      const parts = ref?.split(":");
      if (parts?.length !== 2) return false;
      const first = cellAddress(parts[0]);
      const last = cellAddress(parts[1]);
      return !!first && !!last && first.row <= last.row && first.column <= last.column;
    });
    if (validMerges.length !== merges.length) limitations.add("xlsx_merge_invalid");
    const rows = new Map<number, Row[]>();
    const cellsSeen = new Set<string>();
    for (const row of children(child(content, "sheetData"), "row")) {
      const rowNumber = Number(attr(row, "r"));
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1048576 || rows.has(rowNumber)) {
        throw new FormatHold("xlsx_row_address_invalid");
      }
      const entries: Row[] = [];
      for (const cell of children(row, "c")) {
        const ref = attr(cell, "r");
        const address = ref && cellAddress(ref);
        if (!ref || !address || address.row !== rowNumber || cellsSeen.has(ref)) {
          throw new FormatHold("xlsx_cell_address_invalid");
        }
        cellsSeen.add(ref);
        const type = attr(cell, "t") ?? "n";
        const formula = child(cell, "f");
        const raw = child(cell, "v")?.value;
        const rawValue = raw === "" && formula ? undefined : raw;
        let value: string | undefined;
        if (type === "s") {
          const index = rawValue && /^\d+$/.test(rawValue) ? Number(rawValue) : -1;
          value = shared[index];
          if (value === undefined) limitations.add("xlsx_shared_string_unavailable");
        } else if (type === "inlineStr") value = richString(child(cell, "is"));
        else value = rawValue;

        if (formula) limitations.add(value === undefined ? "xlsx_formula_value_missing" : "xlsx_formula_cache_unverified");
        if (type === "e") limitations.add("xlsx_cell_error");
        const format = cellFormats[Number(attr(cell, "s") ?? 0)] ?? "0";
        const rowDetails = { hidden: attr(row, "hidden") === "1", outlineLevel: attr(row, "outlineLevel") ?? "0" };
        entries.push({
          locator: { sheet: name, sheetId: id, cell: ref, row: rowNumber, column: address.column },
          text: value ?? "",
          details: {
            value: formula ? null : value ?? null, cellType: type,
            formula: formula?.value || null, formulaAttributes: formula ? { ...formula.attributes } : null,
            cachedValue: formula ? value ?? null : null, cacheSource: formula ? "workbook" : null,
            numberFormatId: format, numberFormat: customFormats.get(format) ?? null,
            ...rowDetails,
          },
        });
      }
      rows.set(rowNumber, entries);
    }
    const windows = new Map<number, { entries: Row[]; physicalRows: number[] }>();
    const ensure = (index: number) => {
      const first = Math.floor((index - 1) / 25) * 25 + 1;
      if (!windows.has(first)) windows.set(first, { entries: [], physicalRows: [] });
      return windows.get(first)!;
    };
    for (const [index, entries] of rows) {
      const window = ensure(index);
      window.physicalRows.push(index);
      window.entries.push(...entries);
    }
    for (const ref of validMerges) {
      const [firstRef, lastRef] = ref.split(":");
      const first = cellAddress(firstRef)!;
      const last = cellAddress(lastRef)!;
      ensure(first.row).entries.push({
        locator: { sheet: name, sheetId: id, cell: firstRef, row: first.row, column: first.column, merge: ref },
        text: "",
        details: { merge: ref, lastRow: last.row, lastColumn: last.column },
      });
    }
    if (!windows.size) ensure(1);
    for (const [first, { entries, physicalRows }] of [...windows].sort(([a], [b]) => a - b)) {
      entries.sort((a, b) => Number(a.locator.row) - Number(b.locator.row)
        || Number(a.locator.column) - Number(b.locator.column));
      const last = Math.min(first + 24, 1048576);
      if (entries.length > 2500) {
        units.push({ ...unit(`sheet:${id}:${first}`, name,
          { sheet: name, sheetId: id, firstRow: first, lastRow: last }, [], ["xlsx_window_cell_limit"]),
          coverage: "held" });
        continue;
      }
      units.push({ ...unit(`sheet:${id}:${first}`, name,
        { sheet: name, sheetId: id, firstRow: first, lastRow: last, state: attr(sheet, "state") ?? "visible" },
        entries.map((entry) => ({ ...entry, details: { ...entry.details, calculation } })), [...limitations]),
        physicalRows });
    }
  }
  if (!units.length) throw new FormatHold("xlsx_no_sheets");
  return { units, ...(checkInventory ? { inventory: xlsxInventory(workbook, files, paths, units) } : {}) };
}
