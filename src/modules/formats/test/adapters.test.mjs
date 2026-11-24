import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = process.env.FACADE_STEP11_DIST ?? resolve("dist");
const load = (module) => import(pathToFileURL(join(dist, "src/modules", module)));
const { createFormatAdapters, resolveFormat } = await load("formats/index.js");
const { createPdfAdapter } = await load("pdf/pdf-adapter.js");
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const expected = JSON.parse(await readFile(new URL("./gold/expected.json", import.meta.url), "utf8"));
const adapters = new Map(createFormatAdapters().map((adapter) => [adapter.format, adapter]));

async function read(name, { select, locator, box, representation = "native", adapter } = {}) {
  adapter ??= adapters.get(resolveFormat(name));
  const path = join(fixtures, name);
  const units = await adapter.inspect(path);
  const unit = select ? units.find(select) : units[0];
  assert.ok(unit, `missing physical unit: ${name} ${JSON.stringify(units)}`);
  const output = await adapter.read(path, { address: { unitId: unit.id, locator, box }, representation }, unit);
  return { units, unit, output, json: output.mediaType === "application/json" ? JSON.parse(output.bytes) : undefined };
}

test("DOCX preserves heading, comment, vertical continuation and table address", async () => {
  const { units, output, json } = await read("schedule.docx", {
    select: (entry) => entry.locator.table === expected.docx.table,
    locator: { table: expected.docx.table, row: expected.docx.row, column: expected.docx.column },
  });
  assert.match(units[0].id, /^paragraphs:/);
  assert.equal(json.lines.length, 1);
  assert.equal(json.lines[0].text, expected.docx.text);
  assert.equal(json.lines[0].locator.section, "Wing M");
  assert.equal(output.address.locator.row, 2);

  const table = await read("schedule.docx", { select: (entry) => entry.locator.table === 1 });
  assert.equal(table.json.lines.find((line) => line.locator.row === 1 && line.locator.column === 1).details.header, true);
  assert.equal(table.json.lines.find((line) => line.locator.row === 1 && line.locator.column === 1).details.columnSpan, 2);
  assert.equal(table.json.lines.find((line) => line.locator.row === 3 && line.locator.column === 1).details.verticalMerge, "continue");
  assert.equal((await read("schedule.docx", { locator: { paragraph: 3 } })).json.lines[0].details.comments[0].text,
    "Finish requires sample.");
});

test("XLSX preserves exact decimal, format units, range, hidden row, merge and two formula cache states", async () => {
  const { units, json } = await read("schedule.xlsx", {
    locator: { sheet: expected.xlsx.sheet, range: "A1:C4" },
  });
  const at = (cell) => json.lines.find((line) => line.locator.cell === cell && !line.locator.merge);
  assert.equal(at("B2").text, "Thickness, mm");
  assert.equal(at("B3").details.value, "2.400000000000003");
  assert.equal(at("B3").details.numberFormat, '0.00 "mm"');
  assert.equal(at(expected.xlsx.cell).details.cachedValue, expected.xlsx.cachedValue);
  assert.equal(at(expected.xlsx.cell).details.formula, expected.xlsx.formula);
  assert.equal(at(expected.xlsx.cell).details.calculation.fullCalcOnLoad, "1");
  assert.equal(at("C4").details.cachedValue, null);
  assert.equal(at("B4").details.hidden, true);
  assert.ok(json.lines.find((line) => line.locator.merge === "A1:C1"));
  assert.ok(json.limitations.includes("xlsx_formula_cache_unverified"));
  assert.ok(json.limitations.includes("xlsx_formula_value_missing"));
  assert.equal(units.find((entry) => entry.label === "Empty sheet").locator.candidateCount, 0);
  const empty = await read("schedule.xlsx", { select: (entry) => entry.label === "Empty sheet" });
  assert.ok(empty.json.limitations.includes("format_zero_text_candidates"));
  await assert.rejects(read("schedule.xlsx", { locator: { sheet: "Another", cell: "C3" } }),
    { code: "reader_address_invalid" });
  await assert.rejects(read("schedule.xlsx", { locator: { range: "A1:C30" } }), { code: "reader_address_invalid" });
});

test("text keeps physical lines and reports unknown encoding", async () => {
  const notes = await read("notes.txt", { locator: { line: 2 } });
  assert.equal(notes.json.lines[0].text, "AX-17 rev B — 2.40 мм");
  assert.equal(notes.output.address.locator.line, 2);
  assert.equal((await read("utf16.txt")).json.lines[1].text, "Тест — 2.4 мм");
  assert.equal((await read("unreadable.txt")).json.limitations[0], "text_encoding_unconfirmed");
});

test("DXF separates Model from Layout and keeps rendered schedule context and exact entity text", async () => {
  const { output, json, units } = await read("schedule.dxf", {
    locator: { space: expected.dxf.space, handle: expected.dxf.handle },
  });
  assert.deepEqual(units.map((entry) => entry.label), ["Model", "Layout 1"]);
  assert.equal(json.lines[0].text, expected.dxf.text);
  assert.equal(output.address.locator.handle, "32");
  const neighbor = await read("schedule.dxf", { locator: { handle: "33" } });
  assert.equal(neighbor.json.lines[0].text, "AX-17 rev C | 5 x 14 mm | 70 mm");
  const image = await read("schedule.dxf", { representation: "render", locator: { handle: "32" } });
  assert.equal(image.output.mediaType, "image/png");
  assert.equal(image.output.bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(image.output.bytes.length > 4_000);
  assert.equal(image.output.address.locator.handle, "32");
  assert.ok(image.output.address.box.height < image.unit.height);
  await assert.rejects(read("schedule.dxf", { locator: { handle: "40" } }), { code: "reader_address_invalid" });
});

test("DXF exposes addressable ordinals for entities without unique handles", async () => {
  const result = await read("dxf-handleless.dxf");
  assert.deepEqual(result.json.lines.map(({ text }) => text), [
    "Flange F8 | 26 mm", "Flange F7 | 29 mm", "Flange F9 | 32 mm", "Elevation",
  ]);
  assert.deepEqual(result.json.lines.map(({ locator }) => locator.entityOrdinal ?? locator.handle), [1, 2, 3, "A8"]);
  assert.ok(result.json.limitations.includes("cad_entity_handle_unconfirmed"));
  const exact = await read("dxf-handleless.dxf", { locator: { space: "Model", entityOrdinal: 2 } });
  assert.equal(exact.json.lines[0].text, "Flange F7 | 29 mm");
  const zoom = await read("dxf-handleless.dxf", { representation: "render", locator: { space: "Model", entityOrdinal: 2 } });
  assert.equal(zoom.output.address.locator.entityOrdinal, 2);
  assert.equal(zoom.output.mediaType, "image/png");
});

test("DXF keeps useful lines when font and external reference are unavailable", async () => {
  const partial = await read("partial.dxf", { locator: { handle: "32" } });
  assert.equal(partial.json.coverage, "partial");
  assert.ok(partial.json.limitations.includes("cad_external_reference"));
  assert.ok(partial.json.limitations.includes("cad_font_substitution"));
  assert.equal(partial.json.lines[0].text, expected.dxf.text);
});

test("IFC STEP identity and GUID survive multiline-safe record parsing", async () => {
  const { step, globalId } = expected.ifc;
  const { json, output } = await read("structure.ifc", { locator: { step, globalId } });
  assert.equal(output.address.locator.step, "#42");
  assert.equal(json.lines[0].details.globalId, globalId);
  assert.match(json.lines[0].text, /AX-17 rev B; Wing M/);
  await assert.rejects(read("structure.ifc", { locator: { step: "#42", globalId: globalId.slice(0, -1) + "8" } }),
    { code: "reader_address_invalid" });
});

test("explicit controls keep readable siblings and distinguish original-only from failed extraction", async () => {
  const controls = {
    "unreadable.docx": "ooxml_dtd_forbidden",
    "unreadable.xlsx": "xlsx_sheet_unavailable",
    "unreadable.dxf": "dxf_eof_missing",
    "unreadable.ifc": "ifc_step_entity_invalid",
  };
  for (const [name, code] of Object.entries(controls)) {
    const { json } = await read(name);
    assert.equal(json.coverage, "held", name);
    assert.equal(json.limitations[0], code, name);
  }
  const missingSheet = await read("unreadable.xlsx");
  assert.equal(missingSheet.units[1].locator.coverage, "addressable");
  for (const name of ["presence-only.rvt", "presence-only.xyz"]) {
    const { json, unit } = await read(name);
    assert.equal(json.coverage, "original_only");
    assert.equal(unit.id, "original");
    assert.deepEqual(json.lines, []);
  }
  await assert.rejects(read("presence-only.rvt", { representation: "render" }), { code: "rvt_original_only" });
});

test("disabled converters retain DOC, XLS, DWG as addressable holds", async () => {
  const keys = ["FACADE_CONVERTER_SOCKET"];
  const configured = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const extension of ["doc", "xls", "dwg"]) {
      const adapter = createFormatAdapters().find((entry) => entry.format === extension);
      const { unit, json } = await read(`unreadable.${extension}`, { adapter });
      assert.equal(unit.id, "original");
      assert.equal(json.coverage, "held");
      assert.equal(json.limitations[0], `${extension}_converter_unavailable`);
    }
  } finally {
    for (const key of keys) if (configured[key]) process.env[key] = configured[key];
  }
});

test("Linux LibreOffice produces versioned derivatives and marks conversion precision", {
  skip: !process.env.FACADE_CONVERTER_SOCKET || process.env.FACADE_STEP11_OFFICE !== "1",
}, async () => {
  const doc = await read("schedule.doc", { select: (entry) => entry.locator.table === 1 });
  assert.match(doc.json.converter, /^sha256:[a-f0-9]{64}$/);
  assert.match(doc.json.derivativeSha256, /^[a-f0-9]{64}$/);
  assert.ok(doc.json.limitations.includes("doc_converted_address_approximate"));
  assert.ok(doc.json.lines.some((line) => line.text === "2.40 mm"));
  const xls = await read("schedule.xls");
  assert.ok(xls.json.limitations.includes("xls_conversion_recalculation_unverified"));
  assert.equal(xls.json.lines.find((line) => line.locator.cell === "C3").details.cacheSource, "converter");
  assert.equal((await read("unreadable.doc")).json.limitations[0], "doc_signature_invalid");
  assert.equal((await read("unreadable.xls")).json.limitations[0], "xls_signature_invalid");
});

test("Linux LibreDWG reads model schedule and marks converted handle", {
  skip: !process.env.FACADE_CONVERTER_SOCKET || process.env.FACADE_STEP11_DWG !== "1",
}, async () => {
  const survey = await read("schedule.dwg");
  assert.ok(survey.json.limitations.includes("cad_converted_handle_unverified"));
  const target = survey.json.lines.find((line) => line.text === expected.dxf.text);
  assert.match(target.locator.derivativeHandle, /^[0-9A-F]+$/);
  assert.equal(target.locator.handle, undefined);
  assert.equal((await read("unreadable.dwg")).json.limitations[0], "dwg_signature_invalid");
});

test("Linux legacy DOC recovery preserves separate cells from a flattened import", {
  skip: process.env.FACADE_STEP11_RECOVERY !== "1" || process.env.FACADE_STEP11_OFFICE !== "1"
    || !process.env.FACADE_CONVERTER_SOCKET,
}, async () => {
  const { json } = await read("doc-recovery.doc", {
    select: (unit) => unit.locator.table === 1,
    locator: { table: 1, row: 2 },
  });
  assert.deepEqual(json.lines.map(({ text, locator }) => [locator.column, text]), [
    [1, "AX-725"], [2, "63"], [3, "mm"],
  ]);
});

test("Linux DWG recovery exposes decoder text when the DXF export is incomplete", {
  skip: process.env.FACADE_STEP11_RECOVERY !== "1" || process.env.FACADE_STEP11_DWG !== "1"
    || !process.env.FACADE_CONVERTER_SOCKET,
}, async () => {
  const { unit, json } = await read("dwg-recovery.dwg");
  assert.equal(unit.locator.space, "Model");
  assert.equal(unit.locator.derivative, "dwg-json");
  assert.ok(json.limitations.includes("cad_dwg_json_recovery"));
  const line = json.lines.find((row) => row.text === "Rib L2 | 13.25 mm");
  assert.ok(line);
  assert.ok(json.lines.some((row) => row.text === "Rib L7 | 28.5 mm"));
  const address = line.locator;
  const reopened = await read("dwg-recovery.dwg", { locator: address });
  assert.equal(reopened.json.lines[0].text, line.text);
  const rendered = await read("dwg-recovery.dwg", { locator: address, representation: "render" });
  assert.equal(rendered.output.mediaType, "image/png");
});

test("mixed, rotated and unreadable PDF distinguish native layer, raster and OCR", async () => {
  const adapter = createPdfAdapter({ ocrLanguages: "eng" });
  const { page, box, text, value, rotatedPage, unreadablePage } = expected.pdf;
  const options = { adapter, select: (unit) => unit.id === String(page), box };
  const first = await read("mixed-raster.pdf", options);
  assert.equal(first.units.length, 3);
  assert.equal(first.json.lines.length, 0);
  assert.ok(first.json.limitations.includes("pdf_native_empty"));
  const full = await read("mixed-raster.pdf", { adapter });
  assert.ok(full.json.lines.some((line) => line.text.includes("mixed construction sheet")));
  const window = await read("mixed-raster.pdf", { ...options, representation: "render" });
  assert.equal(window.output.mediaType, "image/png");
  assert.deepEqual(window.output.address.box, box);
  assert.equal(window.output.transform.pixelOriginX, Math.floor(box.x * window.output.transform.pixelsPerPoint));
  const ocr = await read("mixed-raster.pdf", { ...options, representation: "ocr" });
  assert.ok(ocr.output.inputImage.bytes.length > 0);
  const ocrText = ocr.json.lines.map((line) => line.text).join(" ");
  assert.ok(ocrText.includes(text) && ocrText.includes(value), ocrText);
  const rotated = await read("mixed-raster.pdf", { adapter, select: (unit) => unit.id === String(rotatedPage),
    representation: "ocr" });
  assert.equal(rotated.unit.locator.rotation, 90);
  const readRotated = rotated.json.lines.map((line) => line.text).join(" ");
  assert.ok(readRotated.includes(text) && readRotated.includes(value), readRotated);
  const unreadable = await read("mixed-raster.pdf", { adapter, select: (unit) => unit.id === String(unreadablePage),
    box, representation: "ocr" });
  assert.ok(unreadable.json.limitations.includes("pdf_ocr_empty"));
  assert.ok(unreadable.output.inputImage.bytes.length > 0);
  const toolVersion = await adapter.version();
  assert.match(toolVersion, /poppler=.*ocr=/);
  assert.match(execFileSync("tesseract", ["--version"], { encoding: "utf8" }), /tesseract /);
});
