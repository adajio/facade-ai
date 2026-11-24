import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { convertDwg, dwgProfile } from "../../../converter-port/index.ts";
import { sha256, stagePair } from "./pair.mjs";

assert.equal(process.argv.length, 3, "Supply a new directory for the run");
const output = resolve(process.argv[2]);
const { cases } = await stagePair(output);
const originals = new Map(cases.map((item) => [item.name, item]));
const profile = await dwgProfile();
assert.ok(profile, "The private DWG broker must be ready");
const image = profile.id;
assert.equal(image, process.env.FACADE_DWG_IMAGE, "Unexpected broker image");
const evidence = [];

async function convertCase(name, inputPath = originals.get(name).libreInput, runName = name) {
  const bytes = await readFile(inputPath);
  const originalSha256 = sha256(bytes);
  assert.equal(originalSha256, originals.get(name).sha256);
  const started = performance.now();
  const temporary = join(output, runName + ".wire");
  const result = await convertDwg(Readable.from([bytes]), createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    { size: bytes.length, image, timeout: profile.timeout });
  const elapsedMs = Math.round(performance.now() - started);
  const payload = await readFile(temporary);
  await unlink(temporary);
  assert.equal(result.sha256, sha256(payload));
  const derivative = payload.toString("latin1");
  const format = derivative.trimStart().startsWith("{") ? "json" : "dxf";
  if (format === "dxf") {
    assert.match(derivative, /(?:^|\r?\n)[ \t]*0\r?\nSECTION\r?\n[ \t]*2\r?\nENTITIES\r?\n/u);
    assert.match(derivative, /\r?\n[ \t]*0\r?\nEOF\s*$/u);
  }
  await writeFile(join(output, runName + "." + format), payload);
  evidence.push({ name: runName, image, originalSha256, inputBytes: bytes.length,
    format, derivativeSha256: result.sha256, outputBytes: payload.length, elapsedMs });
  return { derivative, format, bytes: payload };
}

const schedule = await convertCase("schedule");
assert.equal(schedule.format, "dxf");
for (const label of ["AX-17 rev B | 2 x 35 mm | 70 mm", "AX-17 rev C | 5 x 14 mm | 70 mm"]) {
  assert.ok(schedule.derivative.includes(label));
}

const recovery = await convertCase("recovery");
assert.equal(recovery.format, "json");
const decoded = JSON.parse(recovery.bytes.toString("utf8"));
assert.equal(decoded.created_by, "LibreDWG 0.13.4");
assert.ok(decoded.OBJECTS.some((object) => object.text_value === "Rib L2 | 13.25 mm" && object.entmode === 2));

const damaged = await readFile(originals.get("unreadable").libreInput);
await assert.rejects(convertDwg(Readable.from([damaged]),
  new Writable({ write(_chunk, _encoding, done) { done(); } }),
  { size: damaged.length, image, timeout: profile.timeout }), { code: "invalid_request" });
evidence.push({ name: "unreadable", image, originalSha256: sha256(damaged), code: "invalid_request" });

const references = {
  accepted: "W34 ACCEPTED REFERENCE | 42 mm",
  stale: "W34 STALE REFERENCE | 41 mm",
  foreign: "W34 FOREIGN REFERENCE | 99 mm",
};

const host = originals.get("xref-host");
const readerDist = resolve(process.env.FACADE_STEP11_DIST ?? "dist");
const { createFormatAdapters } = await import(pathToFileURL(join(readerDist, "src/modules/formats/index.js")));
const adapter = createFormatAdapters().find(({ format }) => format === "dwg");
assert.equal(await adapter.version(), `formats-1.1.1:dwg:${image}`);
const hostOutputs = [];

for (const state of ["missing", ...Object.keys(references)]) {
  const directory = join(dirname(host.libreInput), "xref-" + state);
  await mkdir(directory);
  const hostPath = join(directory, "xref-host.dwg");
  await copyFile(host.libreInput, hostPath);
  if (state !== "missing") {
    const target = originals.get("xref-" + state);
    const targetPath = join(directory, "xref-target.dwg");
    await copyFile(target.libreInput, targetPath);
    const positiveControl = await convertCase("xref-" + state, targetPath);
    assert.equal(positiveControl.format, "dxf");
    assert.ok(positiveControl.derivative.includes(references[state]));
  }
  const { derivative, format } = await convertCase("xref-host", hostPath, "xref-host-" + state);
  assert.equal(format, "dxf");
  assert.match(derivative, /\r?\n[ \t]*70\r?\n[ \t]*4\r?\n(?:[^\r\n]*\r?\n)*?[ \t]*1\r?\nxref-target\.dwg\r?\n/u);
  assert.ok(derivative.includes("W34 HOST | 70 mm"));
  for (const reference of Object.values(references)) assert.ok(!derivative.includes(reference));
  hostOutputs.push(evidence.at(-1).derivativeSha256);

  if (state === "accepted") {
    const units = await adapter.inspect(hostPath);
    const model = units.find((unit) => unit.locator.space === "Model");
    assert.ok(model);
    const presentation = await adapter.read(hostPath, { address: { unitId: model.id }, representation: "native" }, model);
    const details = JSON.parse(presentation.bytes);
    assert.equal(details.coverage, "partial");
    assert.ok(details.limitations.includes("cad_external_reference"));
    assert.ok(details.limitations.includes("cad_converted_handle_unverified"));
    assert.ok(details.lines.some(({ text }) => text === "W34 HOST | 70 mm"));
    for (const reference of Object.values(references)) assert.ok(!details.lines.some(({ text }) => text === reference));
    await writeFile(join(output, "xref-reader.json"), JSON.stringify(details, null, 2) + "\n");
  }
}

assert.equal(new Set(hostOutputs).size, 1);
await writeFile(join(output, "libredwg.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
