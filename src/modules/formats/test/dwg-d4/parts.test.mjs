import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
const buildRoot = process.env.FACADE_STEP11_DIST ?? resolve('dist');
const load = (name) => import(pathToFileURL(join(buildRoot, 'src/modules/formats', name)).href);
const { buildDwgIndex, openDwgIndex } = await load('dwg-index.js');

function drawing(count) {
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (let i = 1; i <= count; i++) {
    const handle = i === 512 || i === 513 ? "FFF" : i.toString(16).toUpperCase();
    lines.push("0", i === 514 ? "HATCH" : "LINE", "5", handle, "410", i > 518 ? "Paper" : "Model",
      "10", String(i), "20", "1", "11", String(i + 1), "21", "2");
  }
  return lines.concat("0", "ENDSEC", "0", "EOF", "").join("\n");
}

test("DWG parts preserve unique coverage, duplicate-handle ordinals and immutable part pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-parts-"));
  const prior = process.env.FACADE_DATA_DIR;
  process.env.FACADE_DATA_DIR = root;
  const file = join(root, "source");
  const identity = { sha: "a".repeat(64), converter: "sha256:" + "b".repeat(64) };
  const pin = { source: { projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(),
    sha256: "c".repeat(64) }, converter: identity.converter, reserve: 0 };
  async function build(data, persist = true) {
    await writeFile(file, data);
    const fd = await open(file);
    try { return await buildDwgIndex(fd, identity.sha, identity.converter, persist ? pin : undefined); }
    finally { await fd.close(); }
  }
  function proof(index) {
    return [...index.units()].map(({ unit, digest }) => ({
      unit, pinned: { id: unit.id, locator: { derivativeSha256: identity.sha, partSha256: digest } },
    }));
  }
  try {
    const index = await build(drawing(520));
    const first = proof(index);
    assert.deepEqual(first.map(({ unit }) => [unit.locator.space, unit.rows.length]), [["Model", 512], ["Model", 6], ["Paper", 2]]);
    const rows = first.flatMap(({ unit }) => unit.rows);
    assert.deepEqual(rows.map(row => row.details.entityOrdinal), Array.from({ length: 520 }, (_, i) => i + 1));
    assert.deepEqual(rows.slice(511, 513).map(row => row.locator.entityOrdinal), [512, 513]);
    assert.ok(rows[513].details.limitations.includes("cad_hatch_boundary_invalid"));
    assert.ok(!rows[511].locator.derivativeHandle && !rows[512].locator.derivativeHandle);
    assert.throws(() => index.read({ ...first[0].pinned, locator: { ...first[0].pinned.locator, partSha256: "0" } }),
      { code: "dwg_index_identity_changed" });
    await index.close();
    const old = await openDwgIndex(pin);
    assert.deepEqual(proof(old), first);
    await old.close();

    const dir = join(root, "dwg-index");
    const [filename] = await readdir(dir);
    await rename(join(dir, filename), join(root, "retired-index"));
    assert.equal(await openDwgIndex(pin), undefined);
    const restored = await build(drawing(520));
    assert.deepEqual(proof(restored), first);
    await restored.close();
    await writeFile(join(dir, filename), "malformed working index");
    await assert.rejects(openDwgIndex(pin), { code: "dwg_index_invalid" });
    assert.deepEqual(await readdir(dir), [filename]);

    const small = await build(drawing(3), false);
    const [legacy] = proof(small);
    assert.match(legacy.unit.id, /^space:[a-f0-9]{24}$/);
    assert.equal(legacy.unit.label, "Model");
    assert.equal(legacy.unit.cad.length, 3);
    await small.close();
  } finally {
    if (prior === undefined) delete process.env.FACADE_DATA_DIR;
    else process.env.FACADE_DATA_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("DWG does not silently accept a temporary index when persistent storage is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-parts-batch-"));
  const { createHash } = await import("node:crypto");
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const { createFormatAdapters } = await load('index.js');
  const dataDir = process.env.FACADE_DATA_DIR;
  const oldSocket = process.env.FACADE_CONVERTER_SOCKET;
  const socket = join(root, "b.sock");
  const image = "sha256:" + "a".repeat(64);
  const original = join(root, "fixture.dwg");
  const blocked = join(root, "file-instead-of-directory");
  await writeFile(original, "AC1015A");
  await writeFile(blocked, "unavailable");
  process.env.FACADE_DATA_DIR = blocked;
  process.env.FACADE_CONVERTER_SOCKET = socket;
  let payload = Buffer.from(drawing(520));
  let calls = 0;
  const server = createServer((_req, res) => res.end(JSON.stringify({
    dwgEngine: "oda", dwg: image, dwgIdentity: "sha256:" + "c".repeat(64), dwgClientTimeoutMs: 4000, dwgReserveBytes: 1,
  })));
  server.on("checkContinue", (req, res) => {
    calls++;
    res.writeContinue();
    req.on("end", () => {
      const sha = createHash("sha256").update(payload).digest("hex");
      res.writeHead(200, { "x-converter-bytes": String(payload.length),
        trailer: "x-converter-result, x-converter-bytes, x-converter-sha256" });
      res.write(payload);
      res.addTrailers({ "x-converter-result": "ok", "x-converter-sha256": sha, "x-converter-bytes": String(payload.length) });
      res.end();
    });
    req.resume();
  });
  try {
    server.listen(socket);
    await once(server, "listening");
    const adapter = createFormatAdapters().find(candidate => candidate.format === "dwg");
    const source = { projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(), sha256: "b".repeat(64) };
    await assert.rejects(adapter.inspect(original, source));
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (dataDir === undefined) delete process.env.FACADE_DATA_DIR;
    else process.env.FACADE_DATA_DIR = dataDir;
    if (oldSocket === undefined) delete process.env.FACADE_CONVERTER_SOCKET;
    else process.env.FACADE_CONVERTER_SOCKET = oldSocket;
    await rm(root, { recursive: true, force: true });
  }
});

test("named CAD view follows multiple Model parts and leaves physical coverage unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-view-parts-"));
  const path = join(root, "source");
  const view = ["0", "SECTION", "2", "TABLES", "0", "VIEW", "2", "Review",
    "10", "512", "20", "1", "40", "20", "41", "40", "0", "ENDSEC", ""].join("\n");
  await writeFile(path, view + drawing(520));
  const fd = await open(path);
  try {
    const index = await buildDwgIndex(fd, "a".repeat(64), "sha256:" + "b".repeat(64));
    try {
      const units = [...index.units()].map(({ unit }) => unit);
      assert.equal(units.filter(u => !u.locator.view).reduce((n, u) => n + u.rows.length, 0), 520);
      const overlay = units.filter(u => u.locator.view === "Review");
      assert.equal(overlay.length, 2);
      assert.deepEqual(overlay.map(u => u.locator.part), [1, 2]);
      assert.ok(overlay.every(u => u.cadView && u.cad.length && u.rows.length));
    } finally { await index.close(); }
  } finally { await fd.close(); await rm(root, { recursive: true, force: true }); }
});

test("layout names come from AcDbLayout and preserve empty sheets", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-layout-names-"));
  const path = join(root, "source");
  function layout(name, owner) {
    return ["0", "LAYOUT", "100", "AcDbPlotSettings", "1", "", "100", "AcDbLayout", "1", name, "330", owner];
  }
  const dxf = ["0", "SECTION", "2", "ENTITIES", "0", "LINE", "5", "C", "330", "AA", "67", "1", "0", "ENDSEC",
    "0", "SECTION", "2", "OBJECTS", ...layout("Detail", "AA"), ...layout("Empty sheet", "BB"), "0", "ENDSEC", "0", "EOF", ""].join("\n");
  await writeFile(path, dxf);
  const fd = await open(path);
  try {
    const index = await buildDwgIndex(fd, "a".repeat(64), "sha256:" + "b".repeat(64));
    try {
      assert.deepEqual([...index.units()].map(x => [x.unit.locator.space, x.unit.rows.length]),
        [["Model", 0], ["Detail", 1], ["Empty sheet", 0]]);
    } finally { await index.close(); }
  } finally { await fd.close(); await rm(root, { recursive: true, force: true }); }
});

test("DWG draws shared nested blocks and clips layout viewports without changing entity addresses", async () => {
  const { renderCad } = await load('cad-render.js');
  const root = await mkdtemp(join(tmpdir(), "dwg-geometry-"));
  const path = join(root, "source");
  const line = (handle, layer, x, y, x2, y2) => [
    0, "LINE", 5, handle, 8, layer, 10, x, 20, y, 11, x2, 21, y2,
  ];
  const insert = (handle, name, x, y, sx = 1, sy = 1, rotation = 0) => [
    0, "INSERT", 5, handle, 2, name, 10, x, 20, y, 41, sx, 42, sy, 50, rotation,
  ];
  const block = (name, owner, ...entities) =>
    [0, "BLOCK", 2, name, 330, owner, 70, 0, 10, 1, 20, 2, ...entities.flat(), 0, "ENDBLK"];
  const dxf = [
    0, "SECTION", 2, "TABLES", 0, "LAYER", 5, "FF", 2, "frozen", 70, 0, 62, 7, 0, "ENDSEC",
    0, "SECTION", 2, "BLOCKS",
    ...block("A", "10", line("11", "0", 1, 2, 4, 2), line("12", "frozen", 1, 2, 1, 4)),
    ...block("B", "20", insert("21", "a", 1, 2)),
    ...block("loop", "30", insert("31", "loop", 0, 0)),
    ...block("*Paper_Space0", "40", [
      0, "VIEWPORT", 5, "41", 10, 20, 20, 10, 40, 16, 41, 12, 12, 6, 22, 9, 16, 0, 26, 0, 36, 1,
      45, 12, 68, 2, 69, 2, 331, "FF",
    ], line("A1", "0", 5, 2, 6, 3)), 0, "ENDSEC",
    0, "SECTION", 2, "ENTITIES",
    ...insert("A1", "b", 5, 7, 2, 3, 90), ...insert("A2", "a", 9, 10),
    0, "DIMENSION", 5, "A3", 2, "A", 10, 123, 20, 456,
    ...insert("A4", "loop", 15, 7), 0, "ENDSEC",
    0, "SECTION", 2, "OBJECTS", 0, "LAYOUT", 100, "AcDbLayout", 1, "Sheet", 330, "40", 0, "ENDSEC",
    0, "EOF", "",
  ].join("\n");
  await writeFile(path, dxf);
  const fd = await open(path);
  try {
    const index = await buildDwgIndex(fd, "a".repeat(64), "sha256:" + "b".repeat(64));
    try {
      const [model, sheet] = [...index.units()].map(({ unit }) => unit);
      assert.deepEqual(model.rows.map(r => r.locator.derivativeHandle), ["A1", "A2", "A3", "A4"]);
      assert.ok(model.rows[3].details.limitations.includes("cad_block_cycle"));
      assert.deepEqual(Object.fromEntries(Object.entries(model.cad[0].bounds).map(([k, v]) => [k, Math.round(v)])), { left: -1, right: 5, top: -13, bottom: -7 });
      assert.equal(model.cad[2].bounds.left, 1);
      assert.equal(sheet.rows[0].locator.derivativeSection, "BLOCKS");
      assert.equal(sheet.rows[0].locator.derivativeHandle, "41");
      assert.equal(sheet.rows[1].locator.entityOrdinal, 6);
      assert.equal(sheet.rows[1].locator.derivativeHandle, undefined);
      assert.equal(sheet.cad[0].kind, "VIEWPORT");
      assert.deepEqual(sheet.cad[0].clip, { left: 12, right: 28, top: -16, bottom: -4 });
      const definition = digest => index.definition(digest);
      const layers = shapes => shapes.flatMap(s => [s.layer, ...s.block ? layers(definition(s.block.digest).shapes) : []]);
      assert.ok(layers(model.cad).includes("frozen"));
      assert.ok(!layers(sheet.cad).includes("frozen"));
      for (const [unit, address] of [[model, "A1"], [sheet, "41"], [sheet, undefined]]) {
        const result = renderCad(unit, { unitId: unit.id }, address, definition);
        assert.equal(result.bytes.subarray(1, 4).toString(), "PNG");
      }
      assert.equal(renderCad(model, { unitId: model.id }, "A4", definition), undefined);
      assert.throws(() => renderCad(model, { unitId: model.id }, "A1", () => index.definition("0".repeat(64))),
        { code: "dwg_index_invalid" });
    } finally { await index.close(); }
  } finally { await fd.close(); await rm(root, { recursive: true, force: true }); }
});

test("DWG draws proxy shell topology, hatch holes and ordered wipeout occlusion", async () => {
  const { inflateSync } = await import("node:zlib");
  const { cadFrame, renderCad } = await load('cad-render.js');
  const root = await mkdtemp(join(tmpdir(), "dwg-special-"));
  const path = join(root, "source");
  const line = (handle, y) => [0, "LINE", 5, handle, 10, 0, 20, y, 11, 20, 21, y];
  function hatchLoop(points, flags) {
    return [92, flags | 2, 72, 0, 73, 1, 93, points.length, ...points.flatMap(([x, y]) => [10, x, 20, y]), 97, 0];
  }
  const hatch = [0, "HATCH", 5, "D4", 10, 0, 20, 0, 70, 1, 91, 2,
    ...hatchLoop([[0, 20], [10, 20], [10, 30], [0, 30]], 1),
    ...hatchLoop([[3, 23], [7, 23], [7, 27], [3, 27]], 16), 75, 0];
  const pattern = [0, "HATCH", 5, "D5", 10, 0, 20, 0, 70, 0, 91, 1,
    ...hatchLoop([[0, 40], [10, 40], [10, 50], [0, 50]], 1),
    75, 1, 76, 1, 78, 1, 53, 0, 43, 0, 44, 40, 45, 0, 46, 2, 79, 2, 49, 1, 49, -1];
  const wipeout = [0, "WIPEOUT", 5, "D2", 10, 5, 20, 0, 11, 10, 21, 0, 12, 0, 22, 16,
    13, 1, 23, 1, 70, 7, 280, 1, 71, 2, 91, 4,
    14, -.5, 24, .5, 14, .5, 24, .5, 14, .5, 24, -.5, 14, -.5, 24, -.5];
  const shell = Buffer.alloc(116);
  shell.writeUInt32LE(shell.length, 0);
  shell.writeUInt32LE(1, 4);
  shell.writeUInt32LE(shell.length - 8, 8);
  shell.writeUInt32LE(9, 12);
  shell.writeUInt32LE(3, 16);
  [20, 20, 0, 30, 20, 0, 25, 30, 1].forEach((n, i) => shell.writeDoubleLE(n, 20 + i * 8));
  [4, 3, 0, 1, 2, 1].forEach((n, i) => shell.writeInt32LE(n, 92 + i * 4));
  const proxy = [0, "ACAD_PROXY_ENTITY", 5, "D6", 92, shell.length, 310, shell.toString("hex"),
    93, 8, 310, "FF"];
  const text = (handle, y) => [0, "TEXT", 5, handle, 10, 8, 20, y, 40, 1, 1, "TEXT"];
  const nestedMask = [0, "WIPEOUT", 5, "E2", 8, "cut", ...wipeout.slice(4)];
  const dxf = [
    0, "SECTION", 2, "HEADER", 9, "$SORTENTS", 280, 127, 0, "ENDSEC",
    0, "SECTION", 2, "BLOCKS", 0, "BLOCK", 2, "MASKED", 330, "90", 10, 0, 20, 0,
    ...nestedMask, ...line("E1", 8), ...line("E3", 11), 0, "ENDBLK", 0, "ENDSEC",
    0, "SECTION", 2, "ENTITIES", ...wipeout, ...line("D1", 8), ...line("D3", 11), ...hatch, ...pattern, ...proxy,
    ...text("D7", 3), ...text("D8", 5), 0, "INSERT", 5, "E5", 2, "MASKED", 10, 40, 20, 0, 0, "ENDSEC",
    0, "SECTION", 2, "OBJECTS", 0, "SORTENTSTABLE", 5, "21", 100, "AcDbSortentsTable", 330, "1F",
    331, "D2", 5, "50", 331, "D1", 5, "40", 331, "D3", 5, "51",
    331, "D7", 5, "49", 331, "D8", 5, "52",
    0, "SORTENTSTABLE", 5, "22", 100, "AcDbSortentsTable", 330, "90",
    331, "E1", 5, "70", 331, "E2", 5, "80", 331, "E3", 5, "85",
    0, "ENDSEC", 0, "EOF", "",
  ].join("\n");
  await writeFile(path, dxf);
  const fd = await open(path);
  try {
    const index = await buildDwgIndex(fd, "a".repeat(64), "sha256:" + "b".repeat(64));
    try {
      const [{ unit }] = [...index.units()];
      assert.deepEqual(unit.rows.map(r => r.locator.derivativeHandle), ["D2", "D1", "D3", "D4", "D5", "D6", "D7", "D8", "E5"]);
      assert.deepEqual(unit.cad.slice(0,5).map(s => s.handle), ["D1", "D7", "D2", "D3", "D8"]);
      assert.ok(unit.rows[5].details.limitations.includes("cad_proxy_shell_traits_approximate"));
      const frame = cadFrame(unit);
      const picture = renderCad(unit, { unitId: unit.id }, undefined, h => index.definition(h));
      const chunks = [];
      for (let at=8; at<picture.bytes.length;) {
        const n = picture.bytes.readUInt32BE(at);
        if (picture.bytes.toString("ascii", at+4, at+8) === "IDAT") chunks.push(picture.bytes.subarray(at+8, at+8+n));
        at += n + 12;
      }
      const pixels = inflateSync(Buffer.concat(chunks));
      const { width, pixelsPerPoint, pixelOriginX, pixelOriginY } = picture.transform;
      const pos = (x, y) => {
        const px = Math.round((x - frame.x) * pixelsPerPoint - pixelOriginX);
        const py = Math.round((-y - frame.y) * pixelsPerPoint - pixelOriginY);
        return pixels[py * (width * 3 + 1) + px * 3 + 1];
      };
      assert.equal(pos(11, 8), 255, "mask erases earlier stroke");
      assert.equal(pos(3, 8), 22, "stroke survives outside mask");
      assert.equal(pos(11, 11), 22, "later stroke remains above mask");
      assert.equal(pos(51, 8), 255, "nested mask uses its block's sort table");
      assert.equal(pos(43, 8), 22, "nested stroke remains outside its mask");
      assert.equal(pos(51, 11), 22, "later nested stroke remains above mask");
      assert.equal(pos(1, 25), 172, "solid hatch is filled");
      assert.equal(pos(5, 25), 255, "inner loop is a real hole");
      assert.equal(pos(.5, 44), 22, "pattern draws the on stroke");
      assert.equal(pos(1.5, 44), 255, "pattern keeps the dash gap");
      assert.equal(pos(25, 20), 22, "proxy uses fallback shell topology");
      const wordInk = y => {
        for (let dx = 0; dx < 4; dx += .03) for (let dy = -.05; dy < 1.1; dy += .03) {
          if (pos(8 + dx, y + dy) < 210) return true;
        }
        return false;
      };
      assert.equal(wordInk(3), false, "mask erases the earlier glyphs");
      assert.equal(wordInk(5), true, "later glyphs remain above the mask");
    } finally { await index.close(); }
  } finally { await fd.close(); await rm(root, { recursive: true, force: true }); }
});

test("DWG composites later direct and nested masks across parts without moving addresses or the frame", async () => {
  const { inflateSync } = await import("node:zlib");
  const { cadFrame, renderCad } = await load('cad-render.js');
  const root = await mkdtemp(join(tmpdir(), "dwg-cross-mask-"));
  const path = join(root, "source");
  const line = (handle, y) => [0, "LINE", 5, handle, 10, 0, 20, y, 11, 20, 21, y];
  const wipe = (handle, x, w) => [0, "WIPEOUT", 5, handle, 10, x, 20, 0, 11, w, 21, 0, 12, 0, 22, 7,
    13, 1, 23, 1, 70, 7, 280, 1, 71, 2, 91, 4,
    14, -.5, 24, .5, 14, .5, 24, .5, 14, .5, 24, -.5, 14, -.5, 24, -.5];
  const word = (handle, y) => [0, "TEXT", 5, handle, 10, 7, 20, y, 40, 1, 1, "TEXT"];
  const fill = Array.from({ length: 508 }, (_, i) => line((0x1000 + i).toString(16), 20)).flat();
  const dxf = [
    0, "SECTION", 2, "HEADER", 9, "$SORTENTS", 280, 127, 0, "ENDSEC",
    0, "SECTION", 2, "BLOCKS", 0, "BLOCK", 2, "CUT", 330, "B0", 10, 0, 20, 0,
    ...wipe("B1", 0, 300), 0, "ENDBLK", 0, "ENDSEC",
    0, "SECTION", 2, "ENTITIES", ...line("10", 2), ...word("20", .5), ...line("90", 4), ...word("91", 5), ...fill,
    ...wipe("30", 5, 7), 0, "INSERT", 5, "40", 2, "CUT", 10, 12, 20, 0,
    ...wipe("50", 0, 20), 410, "Different sheet", 0, "ENDSEC", 0, "EOF", "",
  ].join("\n");
  await writeFile(path, dxf);
  const fd = await open(path);
  try {
    const index = await buildDwgIndex(fd, "9".repeat(64), "sha256:" + "8".repeat(64));
    try {
      const [main, cut, sheet] = [...index.units()].map(({ unit }) => unit);
      assert.equal(main.rows.length, 512);
      assert.deepEqual(cut.rows.map(r => r.locator.derivativeHandle), ["30", "40"]);
      assert.equal(sheet.rows[0].locator.derivativeHandle, "50");
      assert.deepEqual(main.cadContext.map(s => s.handle), ["30", "40"]);
      assert.ok(!main.rows.some(r => ["30", "40", "50"].includes(r.locator.derivativeHandle)));
      assert.ok(main.cadContext[1].bounds.right > 20);
      const frame = cadFrame(main);
      const without = { ...main, cadContext: [] };
      assert.deepEqual(frame, cadFrame(without));
      const load = d => index.definition(d);
      const result = renderCad(main, { unitId: main.id }, undefined, load);
      assert.equal(renderCad(main, { unitId: main.id }, "30", load), undefined);
      const chunks = [];
      for (let at = 8; at < result.bytes.length;) {
        const n = result.bytes.readUInt32BE(at);
        if (result.bytes.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(result.bytes.subarray(at + 8, at + 8 + n));
        at += n + 12;
      }
      const bytes = inflateSync(Buffer.concat(chunks));
      const t = result.transform;
      function pixel(x, y) {
        const px = Math.round((x - frame.x) * t.pixelsPerPoint - t.pixelOriginX);
        const py = Math.round((-y - frame.y) * t.pixelsPerPoint - t.pixelOriginY);
        return bytes[py * (t.width * 3 + 1) + px * 3 + 1];
      }
      assert.equal(pixel(2, 2), 22, "different sheet cannot mask Model");
      assert.equal(pixel(7, 2), 255, "later mask from another part");
      assert.equal(pixel(17, 2), 255, "nested mask from another part uses INSERT placement");
      assert.equal(pixel(7, 4), 22, "later line remains visible");
      assert.equal(pixel(17, 4), 22, "nested mask also leaves later line visible");
      const wordInk = y => {
        for (let dx = 0; dx < 4; dx += .03) for (let dy = -.03; dy < 1.1; dy += .03) {
          if (pixel(7 + dx, y + dy) < 210) return true;
        }
        return false;
      };
      assert.equal(wordInk(.5), false, "cross-part mask erases earlier text");
      assert.equal(wordInk(5), true, "cross-part mask preserves later text");
    } finally { await index.close(); }
  } finally { await fd.close(); await rm(root, { recursive: true, force: true }); }
});

test("DWG pins SHX strokes, reports missing glyphs and ignores font paths outside the configured assets", async () => {
  const { symlink, mkdir } = await import("node:fs/promises");
  const { dwgFontAssets } = await load('cad-font-assets.js');
  const { renderCad } = await load('cad-render.js');
  const root = await mkdtemp(join(tmpdir(), "dwg-font-"));
  const fontDir = join(root, "fonts");
  const input = join(root, "source");
  await mkdir(fontDir);
  const previous = process.env.FACADE_DWG_FONT_DIR;
  process.env.FACADE_DWG_FONT_DIR = fontDir;
  const header = Buffer.from("AutoCAD-86 unifont 1.0\r\n\x1a","ascii");
  const definition = Buffer.concat([Buffer.from("Test\0"),Buffer.from([10,3,0,0,0,0])]);
  const glyph = Buffer.from([0,8,3,10,8,3,246,2,8,2,0,0]);
  const structure = Buffer.alloc(6), record = Buffer.alloc(4);
  structure.writeUInt16LE(2,0);
  structure.writeUInt16LE(definition.length,4);
  record.writeUInt16LE(0x410,0);
  record.writeUInt16LE(glyph.length,2);
  await writeFile(join(fontDir,"quoted.shx"),Buffer.concat([header,structure,definition,record,glyph]));
  await symlink(join(fontDir,"quoted.shx"),join(fontDir,"link.shx"));
  const document = [
    0,"SECTION",2,"TABLES",0,"STYLE",2,"Active",3,"quoted.shx",40,0,41,1,50,0,
    0,"STYLE",2,"Escaped",3,"../quoted.shx",0,"ENDSEC",
    0,"SECTION",2,"ENTITIES",
    0,"TEXT",5,"A1",7,"Active",10,0,20,0,40,10,1,"АЖ",
    0,"TEXT",5,"A2",7,"Escaped",10,0,20,20,40,10,1,"А",
    0,"ENDSEC",0,"EOF","",
  ].join("\n");
  await writeFile(input,document);
  const file = await open(input);
  try {
    const assets = dwgFontAssets();
    const font = assets.select("quoted.shx");
    assert.equal(font.kind,"shx");
    assert.equal(assets.select("link.shx"),undefined);
    assert.equal(assets.select("../quoted.shx"),undefined);
    const index = await buildDwgIndex(file,"a".repeat(64),"p",undefined,assets);
    try {
      const [{ unit }] = [...index.units()];
      assert.equal(index.identity.fonts,assets.identity);
      assert.deepEqual(unit.rows[0].details.fonts,[
        { name:"quoted.shx",sha256:font.sha256,kind:"shx" },
        { name:"quoted.shx",fallback:"glyph",glyph:"Ж" },
      ]);
      assert.deepEqual(unit.rows[1].details.fonts,[{ name:"../quoted.shx",fallback:"font" }]);
      const shape = unit.cad[0];
      assert.deepEqual(font.font.glyph(0x410).path,[["M",0,-0],["L",3,-10],["M",3,-10],["L",6,-0]]);
      assert.equal(shape.textSpans[0].advance,8);
      const one = { ...unit,cad:[{ ...shape, textSpans:shape.textSpans.slice(0,1) }] };
      const png = renderCad(one,{unitId:unit.id},"A1",d=>index.definition(d),assets);
      assert.equal(png.bytes.subarray(1,4).toString(),"PNG");
      const focused = renderCad(one,{unitId:unit.id},"A1",d=>index.definition(d),assets,font.sha256);
      assert.equal(focused.bytes.subarray(1,4).toString(),"PNG");
      assert.ok(focused.transform.pixelsPerPoint >= png.transform.pixelsPerPoint);
      assert.throws(()=>renderCad(one,{unitId:unit.id},"A1",d=>index.definition(d),assets,"0".repeat(64)),
        {code:"cad_font_text_unavailable"});
      process.env.FACADE_DWG_FONT_DIR = join(root,"unmounted");
      assert.notEqual(dwgFontAssets().identity,assets.identity);
      assert.throws(()=>renderCad(one,{unitId:unit.id},"A1",d=>index.definition(d),dwgFontAssets()),
        {code:"cad_font_assets_changed"});
    } finally { await index.close(); }
  } finally {
    await file.close();
    if (previous === undefined) delete process.env.FACADE_DWG_FONT_DIR;
    else process.env.FACADE_DWG_FONT_DIR = previous;
    await rm(root,{recursive:true,force:true});
  }
});

test("DWG renders the full viewport with over 4000 short glyph runs in paint order", async () => {
  const { inflateSync } = await import("node:zlib");
  const { cadFrame, renderCad } = await load('cad-render.js');
  const clip = { left: 0, right: 1600, top: 0, bottom: 800 };
  const digest = "a".repeat(64);
  const viewport = { kind: "VIEWPORT", handle: "1", layer: "0", x: 800, y: -400, bounds: clip, clip,
    block: { digest, matrix: [1, 0, 0, 1, 0, 0] } };
  const line = (y) => ({ kind: "LINE", layer: "0", x: 20, y: -y, x2: 1550, y2: -y });
  const mask = { kind: "WIPEOUT", layer: "0", x: 500, y: -680,
    bounds: { left: 500, right: 1100, top: 680, bottom: 740 },
    area: { mode: "mask", loops: [[["M", 500, 680], ["L", 1100, 680], ["L", 1100, 740], ["L", 500, 740]]] } };
  const labels = Array.from({ length: 4100 }, (_, i) => ({
    kind: "TEXT", layer: "0", x: 20 + i % 100 * 15, y: -60 - Math.floor(i / 100) * 12, text: "К4", height: 3,
    textSpans: [{ text: "К4", x: 0, y: 0, height: 3, width: 1, oblique: 0, advance: 4 }],
  }));
  const unit = { id: "paper", cad: [viewport], limitations: [] };
  const result = renderCad(unit, { unitId: unit.id }, undefined, key => {
    assert.equal(key, digest);
    return { shapes: [...labels, line(700), mask, line(730)] };
  });
  const frame = cadFrame(unit);
  assert.deepEqual(result.crop, { x: 0, y: 0, width: frame.width, height: frame.height });
  const chunks = [];
  for (let offset = 8; offset < result.bytes.length;) {
    const length = result.bytes.readUInt32BE(offset);
    if (result.bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(result.bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const { width, pixelsPerPoint, pixelOriginX, pixelOriginY } = result.transform;
  function pixel(x, y) {
    const px = Math.round((x - frame.x) * pixelsPerPoint - pixelOriginX);
    const py = Math.round((y - frame.y) * pixelsPerPoint - pixelOriginY);
    return pixels[py * (width * 3 + 1) + px * 3 + 1];
  }
  assert.equal(pixel(30, 700), 22, "left side of the full viewport");
  assert.equal(pixel(1540, 700), 22, "right side of the full viewport");
  assert.equal(pixel(800, 700), 255, "the intervening mask covers the earlier stroke");
  assert.equal(pixel(800, 730), 22, "the later stroke survives the mask");
});

test("DWG retains a UTF-8 glyph markup limit for large text", async () => {
  const { rasterCad } = await load('cad-raster.js');
  const label = { kind: "TEXT", layer: "0", x: 1, y: -10, height: 4, text: "Ж".repeat(1024) };
  assert.throws(() => rasterCad(Array(1100).fill(label), 100, 100, 1, 0, 0, () => ({ shapes: [] })),
    { code: "cad_block_render_limit" });
});
