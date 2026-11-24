import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const corpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function stagePair(destination) {
  const root = resolve(destination);
  await mkdir(root);
  const cases = [];
  for (const { name, source, expectedSha256 } of corpus) {
    const bytes = await readFile(new URL(source, import.meta.url));
    assert.equal(sha256(bytes), expectedSha256, name);
    const caseDir = join(root, name);
    const libre = join(caseDir, "libredwg");
    const odaInput = join(caseDir, "oda-in");
    const odaOutput = join(caseDir, "oda-out");
    await mkdir(caseDir);
    for (const directory of [libre, odaInput, odaOutput]) await mkdir(directory);
    const libreInput = join(libre, "original.dwg");
    const odaOriginal = join(odaInput, "original.dwg");
    await writeFile(libreInput, bytes);
    await writeFile(odaOriginal, bytes);
    assert.equal(sha256(await readFile(libreInput)), expectedSha256);
    assert.equal(sha256(await readFile(odaOriginal)), expectedSha256);
    cases.push({
      name, sha256: expectedSha256, bytes: bytes.length, signature: bytes.subarray(0, 6).toString("ascii"),
      libreInput, odaOriginal,
      // The public product page describes the fields. Check positional grammar with the exact package before execution.
      odaArgs: [odaInput, odaOutput, "ACAD2000", "DXF", "0", "0", "original.dwg"],
    });
  }
  const plan = {
    odaExecution: "not_run",
    sharedProfile: { os: "linux", architecture: "x86_64", dxf: "ASCII AC1015", audit: false, recursive: false },
    cases,
  };
  await writeFile(join(root, "pair-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "Supply a new directory for the pair");
  console.log(JSON.stringify(await stagePair(process.argv[2]), null, 2));
}
