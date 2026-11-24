import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sha256 } from "./pair.mjs";

const [planPath, caseName, ...outputs] = process.argv.slice(2);
assert.equal(outputs.length, 2, "Supply pair-plan.json, case name and two DXF output paths");
const plan = JSON.parse(await readFile(planPath, "utf8"));
const source = plan.cases.find(({ name }) => name === caseName);
assert.ok(source, "Unknown paired input");
for (const path of [source.libreInput, source.odaOriginal]) {
  assert.equal(sha256(await readFile(path)), source.sha256);
}

const dist = resolve(process.env.FACADE_STEP11_DIST ?? "dist");
const { parseDxf } = await import(pathToFileURL(join(dist, "src/modules/formats/spatial.js")));
const results = [];
for (const path of outputs) {
  const bytes = await readFile(path);
  const text = bytes.toString("latin1");
  assert.match(text, /(?:^|\r?\n)[ \t]*9\r?\n\$ACADVER\r?\n[ \t]*1\r?\nAC1015\r?\n/u, path);
  assert.match(text, /\r?\n[ \t]*0\r?\nEOF\s*$/u, path);
  const parsed = parseDxf(bytes);
  results.push({ path, bytes: bytes.length, sha256: sha256(bytes),
    units: parsed.units.map(({ label, limitations, locator, rows, cad }) => ({
      label, limitations, locator,
      rows: rows.map(({ text: value, bounds, locator: derivativeLocator, details }) => ({
        value, bounds, derivativeLocator, details,
      })),
      geometry: cad,
    })),
  });
}

console.log(JSON.stringify({ case: caseName, originalSha256: source.sha256, dxf: "ASCII AC1015", results }, null, 2));
