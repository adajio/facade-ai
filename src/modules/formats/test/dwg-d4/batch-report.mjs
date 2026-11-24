import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./pair.mjs";

const [planPath, rawPath, auditPath, controlPath] = process.argv.slice(2);
assert.ok(planPath && rawPath, "Supply pair-plan.json and the extracted raw output directory");
const read = (path) => readFile(path).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const plan = JSON.parse(await readFile(planPath, "utf8"));
const dist = resolve(process.env.FACADE_STEP11_DIST ?? "dist");
const { createFormatAdapters } = await import(pathToFileURL(join(dist, "src/modules/formats/index.js")));
const { parseDxf } = await import(pathToFileURL(join(dist, "src/modules/formats/spatial.js")));
const runtime = await readFile(join(rawPath, "runtime.txt"), "utf8");
assert.match(runtime, /^Linux x86_64$/mu);
assert.match(runtime, /^dwg2dxf 0\.13\.4$/mu);
assert.match(runtime, /^d546f27ddd72473b162c303391e6d095fd249666161239bf638ce0ec434d6c02  \/libredwg\/bin\/dwg2dxf$/mu);

const expected = {
  schedule: [["Model", "AX-17 rev B | 2 x 35 mm | 70 mm"], ["Model", "AX-17 rev C | 5 x 14 mm | 70 mm"],
    ["Paper", "Wing M: Sheet title"]],
  recovery: [["Model", "Rib L2 | 13.25 mm"], ["Model", "Rib L7 | 28.5 mm"]],
  unreadable: [],
  "xref-host": [["Model", "W34 HOST | 70 mm"]],
  "xref-accepted": [["Model", "W34 ACCEPTED REFERENCE | 42 mm"]],
  "xref-stale": [["Model", "W34 STALE REFERENCE | 41 mm"]],
  "xref-foreign": [["Model", "W34 FOREIGN REFERENCE | 99 mm"]],
  cyrillic: [["Model", "Панель AX-17 | 2 x 35 мм"], ["Model", "Панель AX-18 | 70 мм"], ["Paper", "Лист 1"]],
};

function inspectStructure(bytes) {
  const text = bytes.toString("latin1");
  const groups = text.split(/\r\n|\r|\n/u);
  if (groups.at(-1) === "") groups.pop();
  let openSection = false;
  let hasEntities = false;
  let balanced = groups.length % 2 === 0;
  for (let i = 0; i + 1 < groups.length; i += 2) {
    if (groups[i].trim() !== "0") continue;
    const value = groups[i + 1].trim();
    if (value === "SECTION") {
      if (openSection || groups[i + 2]?.trim() !== "2") balanced = false;
      openSection = true;
      if (groups[i + 3]?.trim() === "ENTITIES") hasEntities = true;
    } else if (value === "ENDSEC") {
      if (!openSection) balanced = false;
      openSection = false;
    }
  }
  const eof = groups.at(-2)?.trim() === "0" && groups.at(-1)?.trim() === "EOF";
  const version = /(?:^|\r?\n)[ \t]*9\r?\n\$ACADVER\r?\n[ \t]*1\r?\n(AC\d{4})\r?\n/u.exec(text)?.[1] ?? null;
  return { hasEntities, eof, balanced: balanced && !openSection, version };
}

async function readAttempt(directory, kind) {
  const status = await read(join(directory, kind + ".status"));
  if (!status) return null;
  const [exitCode, elapsedMs] = status.toString().trim().split("\t").map(Number);
  const rss = (await read(join(directory, kind + ".rss-kib")))?.toString().trim();
  const stderr = (await readFile(join(directory, kind + ".stderr"), "utf8")).trim();
  const diagnostic = await read(join(directory, "original.dxf.err"));
  return { exitCode, elapsedMs, rssKiB: rss && /^\d+$/.test(rss) ? Number(rss) : null, stderr,
    ...(diagnostic ? { diagnostic: diagnostic.toString().trim() } : {}) };
}

async function replay(candidate, token, records) {
  const root = await mkdtemp(join(tmpdir(), "d4-pair-"));
  const socket = join(root, "b.sock");
  const server = createServer((request, reply) => {
    if (request.url !== "/v1/info") return reply.writeHead(404).end();
    reply.end(JSON.stringify({ dwg: token }));
  });
  server.on("checkContinue", async (request, reply) => {
    if (request.url !== "/v1/dwg" || request.headers["x-converter-image"] !== token) {
      return reply.writeHead(400, { "X-Converter-Result": "invalid_request" }).end();
    }
    reply.writeContinue();
    const input = Buffer.concat(await Array.fromAsync(request));
    const record = records.get(sha256(input));
    if (!record?.derivative) return reply.writeHead(422, { "X-Converter-Result": record?.failure ?? "failed" }).end();
    reply.writeHead(200, { Trailer: "X-Converter-Result" });
    reply.write(record.derivative);
    reply.addTrailers({ "X-Converter-Result": "ok" });
    reply.end();
  });
  server.listen(socket);
  await once(server, "listening");
  const previous = process.env.FACADE_CONVERTER_SOCKET;
  process.env.FACADE_CONVERTER_SOCKET = socket;
  try {
    const adapter = createFormatAdapters().find(({ format }) => format === "dwg");
    for (const record of records.values()) {
      const { row, original } = record;
      if (row.state === "not_run") continue;
      const units = await adapter.inspect(original);
      assert.ok(units.length, candidate);
      row.reader = [];
      for (const unit of units) {
        const read = await adapter.read(original, { address: { unitId: unit.id }, representation: "native" }, unit);
        const { coverage, lines, limitations } = JSON.parse(read.bytes);
        row.reader.push({ space: unit.locator.space ?? unit.label, coverage, limitations,
          lines: lines.map(({ text, locator }) => ({ text, locator })) });
      }
      row.controls = expected[row.name].map(([space, text]) => {
        const matches = row.reader.filter((unit) => unit.space === space).flatMap((unit) => unit.lines)
          .filter((line) => line.text === text);
        const otherSpaces = row.reader.filter((unit) => unit.space !== space && unit.lines.some((line) => line.text === text))
          .map((unit) => unit.space);
        return { space, text, matched: matches.length === 1, addresses: matches.map(({ locator }) => locator), otherSpaces };
      });
    }
  } finally {
    if (previous === undefined) delete process.env.FACADE_CONVERTER_SOCKET;
    else process.env.FACADE_CONVERTER_SOCKET = previous;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

const results = Object.fromEntries(plan.cases.map(({ name, sha256 }) => [name, { sha256 }]));
const tokens = {
  libredwg: "sha256:521216527b73f953c26c6202e972676ad14c8ad812fc15f9c4af31ae2681f0b4",
  oda: "sha256:c432002cc688f89ddf6a68ad68e877cd16da1d99ab8729386009c552cf73beb5",
};

for (const candidate of Object.keys(tokens)) {
  const records = new Map();
  for (const item of plan.cases) {
    const { name, sha256: inputHash } = item;
    const original = candidate === "libredwg" ? item.libreInput : item.odaOriginal;
    assert.equal(sha256(await readFile(original)), inputHash);
    const hashes = (await readFile(join(rawPath, name, "inputs.sha256"), "utf8")).trim().split("\n");
    assert.deepEqual(hashes.map((line) => line.split(" ")[0]), [inputHash, inputHash]);
    const directory = join(rawPath, name, candidate);
    const conversion = await readAttempt(directory, "convert");
    if (candidate === "oda" && conversion) {
      assert.match(runtime, /^bda7c79a901be17d4e0a76ea6e9dfddb24b83601e98cf41d66c158a9c428ca24  \/oda\/ODAFileConverter$/mu);
    }
    const recovery = await readAttempt(directory, "recovery");
    const files = (await readdir(directory)).filter((file) => /\.dxf$/iu.test(file));
    assert.ok(files.length <= 1, directory);
    const dxf = files[0] ? await readFile(join(directory, files[0])) : null;
    const json = recovery?.exitCode === 0 ? await read(join(directory, "result.json")) : null;
    const structure = dxf && inspectStructure(dxf);
    const full = conversion?.exitCode === 0 && structure?.version === "AC1015" &&
      structure.balanced && structure.hasEntities && structure.eof;
    const row = { name, conversion, dxf: dxf && { file: files[0], bytes: dxf.length, sha256: sha256(dxf), structure },
      recovery: recovery && { ...recovery, ...(json ? { bytes: json.length, sha256: sha256(json) } : {}) },
      state: !conversion ? "not_run" : full ? "full_dxf" : json ? "fallback_json" : "held",
    };
    results[name][candidate] = row;
    records.set(inputHash, { row, original, derivative: full ? dxf : json ?? (dxf && conversion?.exitCode === 0 ? dxf : null),
      failure: conversion?.exitCode === 0 ? "output_missing" : "failed" });
  }
  await replay(candidate, tokens[candidate], records);
  for (const item of Object.values(results)) {
    const row = item[candidate];
    if (row.state === "full_dxf" && !row.reader.some((unit) => unit.coverage !== "held" && unit.lines.length)) {
      row.state = "held";
    }
  }
}
const xref = {};
const targets = ["accepted", "stale", "foreign"];
for (const state of ["missing", ...targets]) {
  const directory = state === "missing" ? join(rawPath, "xref-host") : join(rawPath, "xref-context", state);
  const digests = await read(join(directory, "inputs.sha256"));
  if (!digests) continue;
  assert.deepEqual(digests.toString().trim().split("\n").map((line) => line.split(" ")[0]),
    [results["xref-host"].sha256, results[state === "missing" ? "xref-host" : "xref-" + state].sha256]);
  xref[state] = {};
  for (const candidate of Object.keys(tokens)) {
    const root = join(directory, candidate);
    const conversion = await readAttempt(root, "convert");
    const bytes = await read(join(root, candidate === "libredwg" ? "result.dxf" : "original.dxf"));
    if (!bytes) { xref[state][candidate] = { conversion, dxf: null }; continue; }
    const structure = inspectStructure(bytes);
    const parsed = structure.hasEntities && structure.eof ? parseDxf(bytes) : null;
    const text = parsed?.units.flatMap((unit) => unit.rows.map((row) => row.text)) ?? [];
    const limitations = [...new Set(parsed?.units.flatMap((unit) => unit.limitations) ?? [])];
    xref[state][candidate] = { conversion, sha256: sha256(bytes), structure,
      referencePath: bytes.includes(Buffer.from("xref-target.dwg")),
      host: text.includes(expected["xref-host"][0][1]), limitations,
      childTexts: targets.map((target) => expected["xref-" + target][0][1]).filter((line) => text.includes(line)) };
  }
}

const odaAudit = {};
if (auditPath) {
  for (const { name, sha256: hash, signature } of plan.cases) {
    const directory = join(auditPath, name);
    const conversion = await readAttempt(join(directory, "oda"), "convert");
    if (!conversion) continue;
    assert.match(signature, /^AC10\d{2}$/u);
    assert.equal(results[name].oda.state, "held");
    const inputs = (await readFile(join(directory, "inputs.sha256"), "utf8")).trim().split("\n");
    assert.deepEqual(inputs.map((line) => line.split(" ")[0]), [hash, hash]);
    const bytes = await read(join(directory, "oda", "original.dxf"));
    odaAudit[name] = { conversion, dxf: bytes ? { sha256: sha256(bytes), structure: inspectStructure(bytes) } : null };
  }
}

let odaControl;
if (controlPath) {
  const seed = await readFile(new URL("./fixtures/oda-positive-r12.dxf", import.meta.url));
  const [seedHash] = (await readFile(join(controlPath, "seed.sha256"), "utf8")).split(" ");
  assert.equal(sha256(seed), seedHash);
  const dwg = await readFile(join(controlPath, "to-dwg", "control.dwg"));
  assert.equal(dwg.subarray(0, 6).toString("ascii"), "AC1015");
  const dxf = await readFile(join(controlPath, "to-dxf", "control.dxf"));
  const structure = inspectStructure(dxf);
  assert.deepEqual(structure, { hasEntities: true, eof: true, balanced: true, version: "AC1015" });
  const text = "D4 POSITIVE | gap 37 mm";
  const stages = [seed, dxf].map((bytes) => {
    const { units } = parseDxf(bytes);
    const model = units.find((unit) => unit.label === "Model");
    assert.ok(model);
    const line = model.cad.find(({ kind }) => kind === "LINE");
    assert.deepEqual([line.x, line.y, line.x2, line.y2], [1, 2, 11, 2]);
    const annotation = model.rows.find((row) => row.text === text);
    assert.ok(annotation);
    return { line, annotation: { text, locator: annotation.locator } };
  });
  const toDwg = await readAttempt(join(controlPath, "to-dwg"), "convert");
  const toDxf = await readAttempt(join(controlPath, "to-dxf"), "convert");
  assert.equal(toDwg.exitCode, 0);
  assert.equal(toDxf.exitCode, 0);
  odaControl = { seedHash, dwgHash: sha256(dwg), dxfHash: sha256(dxf), structure, stages, toDwg, toDxf };
}

console.log(JSON.stringify({
  runtime,
  reader: "DWG adapter from local build; recorded bytes replayed over Unix socket; package SHA-256 identifies each replay",
  cases: results, xref, odaAudit, odaControl,
}, null, 2));
