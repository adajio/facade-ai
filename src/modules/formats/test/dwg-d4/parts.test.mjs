import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDwgIndex, openDwgIndex } from "../../../../../dist/src/modules/formats/dwg-index.js";

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
    assert.ok(rows[513].details.limitations.includes("cad_entity_type_unsupported"));
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

test("DWG batch uses one conversion when the persistent index is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-parts-batch-"));
  const { createHash } = await import("node:crypto");
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const { createFormatAdapters } = await import("../../../../../dist/src/modules/formats/index.js");
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
    dwgEngine: "libredwg", dwg: image, dwgIdentity: image, dwgClientTimeoutMs: 4000, dwgReserveBytes: 1,
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
    const mapped = await adapter.inspect(original, source);
    assert.equal(mapped.length, 3);
    assert.equal(calls, 1);
    assert.equal(await adapter.readCachedNativeUnits(source, mapped), undefined);
    const ids = [];
    for await (const read of adapter.readNativeUnits(original, mapped, source)) ids.push(read.address.unitId);
    assert.deepEqual(ids, mapped.map(unit => unit.id));
    assert.equal(calls, 2);
    payload = Buffer.from(drawing(521));
    await assert.rejects(adapter.read(original, { representation: "native", address: { unitId: mapped[0].id } },
      mapped[0], undefined, source), { code: "dwg_index_identity_changed" });
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
