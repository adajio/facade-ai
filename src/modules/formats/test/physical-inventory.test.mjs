import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = process.env.FACADE_STEP11_DIST ?? resolve("dist");
const load = (path) => import(pathToFileURL(join(dist, "src/modules", path)));
const { createFormatAdapters, resolveFormat } = await load("formats/index.js");
const { verifyPhysicalInventory } = await load("formats/physical-inventory.js");
const { buildMap } = await load("harness/dispatch.js");
const { createPdfAdapter } = await load("pdf/pdf-adapter.js");
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const adapters = new Map(createFormatAdapters().map((adapter) => [adapter.format, adapter]));

async function inspect(path) {
  const format = resolveFormat(path);
  const adapter = format === "pdf" ? createPdfAdapter() : adapters.get(format);
  const source = {
    projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(),
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  };
  return { source, receiptId: randomUUID(), format, readerVersion: await adapter.version(), units: await adapter.inspect(path) };
}

function persisted(map) {
  // JSONB does not preserve member order within the locator.
  return JSON.parse(JSON.stringify(map, (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value));
}

function basisIds(maps) {
  const proofs = maps.map(verifyPhysicalInventory);
  return proofs.every((proof) => "basisId" in proof) ? proofs.map(({ basisId }) => basisId) : null;
}

async function dispatch(map) {
  return buildMap({ ...map.source, receiptId: map.receiptId, id: randomUUID(), format: map.format }, async (source) => {
    assert.deepEqual(source, map.source);
    return persisted(map);
  });
}

test("a mixed package proves checked places and revalidates each basis against the stored map", async () => {
  const maps = await Promise.all(["schedule.xlsx", "schedule.docx", "notes.txt", "schedule.dxf"].map((name) =>
    inspect(fixture(name))));
  const proofs = basisIds(maps);
  assert.ok(proofs, JSON.stringify(maps.map(verifyPhysicalInventory)));
  assert.equal(new Set(proofs).size, 4);
  for (const basisId of proofs) assert.match(basisId, /^inventory-v1:[a-f0-9]{64}$/);
  assert.deepEqual(basisIds(maps.map(persisted)), proofs);
  assert.deepEqual(maps[0].units.map(({ locator }) => locator.sheet), ["Schedule M", "Empty sheet"]);
  assert.deepEqual(maps[1].units.map(({ id }) => id), ["paragraphs:1", "table:1:1"]);
  assert.deepEqual(maps[3].units.map(({ locator }) => locator.space), ["Model", "Layout 1"]);

  for (const index of [0, 1, 3]) {
    const omitted = { ...maps[index], units: maps[index].units.slice(0, -1) };
    assert.deepEqual(verifyPhysicalInventory(omitted), { limitation: "physical_inventory_map_mismatch" });
    assert.equal(basisIds(maps.with(index, omitted)), null);
  }
  const text = maps[2];
  for (const change of [
    { readerVersion: "changed" },
    { source: { ...text.source, sha256: "a".repeat(64) } },
    { units: [{ ...text.units[0], locator: { ...text.units[0].locator, lastLine: 1 } }] },
  ]) assert.deepEqual(verifyPhysicalInventory({ ...text, ...change }), { limitation: "physical_inventory_map_mismatch" });
  const sameBytesNewVersion = { ...text, source: { ...text.source, versionId: randomUUID() } };
  assert.notEqual(verifyPhysicalInventory(sameBytesNewVersion).basisId, proofs[2]);
});

test("an unpublished map proof and a missing worksheet preserve the mapped places", async () => {
  const map = await inspect(fixture("schedule.xlsx"));
  const units = map.units.map(({ physicalInventory: _, ...unit }) => unit);
  assert.deepEqual(verifyPhysicalInventory({ ...map, units }), { limitation: "physical_inventory_unavailable" });
  const missing = await inspect(fixture("unreadable.xlsx"));
  assert.deepEqual(verifyPhysicalInventory(missing), { limitation: "xlsx_sheet_unavailable" });
  assert.equal(missing.units.find(({ locator }) => locator.sheet === "Empty sheet").locator.coverage, "addressable");
});

test("package dispatch receives a basis for PDF and other originals, and holds an omitted place", async () => {
  const maps = await Promise.all(["mixed-raster.pdf", "schedule.xlsx", "schedule.docx", "notes.txt", "schedule.dxf"]
    .map((name) => inspect(fixture(name))));
  const results = await Promise.all(maps.map(dispatch));
  assert.equal(new Set(results.map(({ physical }) => physical.basisId)).size, 5);
  for (const { physical } of results) assert.match(physical.basisId, /^inventory-v1:[a-f0-9]{64}$/);
  assert.deepEqual(results.slice(1).map(({ physical }) => physical.basisId), basisIds(maps.slice(1)));
  const omitted = await dispatch({ ...maps[1], units: maps[1].units.slice(0, -1) });
  assert.deepEqual(omitted.physical, { limitation: "physical_inventory_map_mismatch" });
  assert.equal(omitted.units[0].id, "sheet:1:1");
  const missing = await dispatch(await inspect(fixture("unreadable.xlsx")));
  assert.deepEqual(missing.physical, { limitation: "xlsx_sheet_unavailable" });
});

function editOffice(original, result, entry, before, after) {
  execFileSync("python3", ["-c", `
import sys
from zipfile import ZipFile
source, result, part, before, after = sys.argv[1:]
with ZipFile(source) as original, ZipFile(result, "w") as out:
    for entry in original.infolist():
        data = original.read(entry)
        if entry.filename == part:
            assert before.encode() in data
            data = data.replace(before.encode(), after.encode(), 1)
        out.writestr(entry, data)
`, original, result, entry, before, after]);
}

test("unmapped graphics and nested structure preserve explicit format limitations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facade-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docx = join(directory, "with-image.docx");
  editOffice(fixture("schedule.docx"), docx, "word/document.xml", "</w:body>", "<w:p><w:r><w:drawing/></w:r></w:p></w:body>");
  const withImage = await inspect(docx);
  assert.deepEqual(verifyPhysicalInventory(withImage), { limitation: "docx_graphics_unmapped" });
  assert.ok(withImage.units.some(({ id }) => id.startsWith("table:")));

  const nested = join(directory, "nested.docx");
  editOffice(fixture("schedule.docx"), nested, "word/document.xml", "</w:tc>", "<w:tbl/><w:p/></w:tc>");
  assert.deepEqual(verifyPhysicalInventory(await inspect(nested)), { limitation: "docx_nested_table_partial" });

  const xlsx = join(directory, "with-sheet-graphic.xlsx");
  editOffice(fixture("schedule.xlsx"), xlsx, "xl/worksheets/empty.xml", "</worksheet>", "<drawing/></worksheet>");
  assert.deepEqual(verifyPhysicalInventory(await inspect(xlsx)), { limitation: "xlsx_sheet_features_partial" });

  const dxf = join(directory, "lost-geometry.dxf");
  await writeFile(dxf, (await readFile(fixture("schedule.dxf"), "utf8")).replace("\nLINE\n", "\nSPLINE\n"));
  assert.deepEqual(verifyPhysicalInventory(await inspect(dxf)), { limitation: "cad_entity_type_unsupported" });
  assert.deepEqual(verifyPhysicalInventory(await inspect(fixture("partial.dxf"))), { limitation: "cad_external_reference" });
  assert.deepEqual(verifyPhysicalInventory(await inspect(fixture("structure.ifc"))), { limitation: "ifc_geometry_not_rendered" });

  const raster = join(directory, "elevation.png");
  await writeFile(raster, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64"));
  assert.deepEqual(verifyPhysicalInventory(await inspect(raster)), { limitation: "image_reader_unsupported" });
  assert.deepEqual(verifyPhysicalInventory(await inspect(fixture("presence-only.rvt"))), { limitation: "rvt_original_only" });
});

test("physical TXT lines include blank lines and cross the window boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facade-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "notes.txt");
  await writeFile(path, `${"ряд\r\n".repeat(100)}\nпоследний\r`);
  const map = await inspect(path);
  assert.deepEqual(map.units.map(({ locator }) => [locator.firstLine, locator.lastLine]), [[1, 100], [101, 103]]);
  assert.ok(verifyPhysicalInventory(map).basisId);
  assert.deepEqual(verifyPhysicalInventory({ ...map, units: map.units.slice(0, 1) }),
    { limitation: "physical_inventory_map_mismatch" });
  await writeFile(path, "");
  assert.deepEqual(verifyPhysicalInventory(await inspect(path)), { limitation: "text_no_physical_lines" });
});
