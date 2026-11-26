import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const image = `sha256:${"6".repeat(64)}`;
const office = `sha256:${"8".repeat(64)}`;
const archive = `sha256:${"9".repeat(64)}`;
const odaBinary = "b".repeat(64);
const tests = [
  ["the binary pin is missing", {}, false],
  ["obsolete engine is configured", { FACADE_DWG_ENGINE: "legacy-engine", FACADE_ODA_BINARY_SHA256: odaBinary }, false],
  ["the probe finds a different binary digest", { FACADE_ODA_BINARY_SHA256: odaBinary }, true],
];

for (const [name, settings, probes] of tests) {
  test(`DWG is unavailable when ${name} and other profiles stay active`, { timeout: 10_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "oda-default-"));
    const socketPath = join(dir, "b.sock");
    const calls = join(dir, "docker-calls");
    await writeFile(join(dir, "docker"), `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> "$FACADE_TEST_CALL_LOG"
case "$1 $2" in
  'container ls') exit 0 ;;
  'image inspect') printf '%s\\n' "$5" ;;
  'run --rm') printf '%s\\n' '${"a".repeat(64)}' '${"c".repeat(64)}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const broker = spawn(process.execPath, [fileURLToPath(new URL("../../../../../infra/converters/broker.mjs", import.meta.url))], {
      env: { PATH: dir + delimiter + process.env.PATH, FACADE_CONVERTER_SOCKET: socketPath,
        FACADE_CONVERTER_SCRATCH: dir, FACADE_DWG_IMAGE: image, FACADE_OFFICE_IMAGE: office,
        FACADE_ARCHIVE_IMAGE: archive, FACADE_TEST_CALL_LOG: calls, FACADE_ODA_ROOT: join(dir, "distribution"),
        FACADE_ODA_RUNTIME: join(dir, "runtime"), ...settings },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(broker, "close");
    t.after(async () => {
      broker.kill();
      await closed;
      await rm(dir, { recursive: true, force: true });
    });
    const ready = await Promise.race([once(broker.stdout, "data").then(([data]) => data.toString()), closed]);
    assert.match(String(ready), /converter broker ready/);
    const profile = await new Promise((resolve, reject) => {
      get({ socketPath, path: "/v1/info" }, async (response) => {
        try {
          assert.equal(response.statusCode, 200);
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (error) {
          reject(error);
        }
      }).on("error", reject);
    });
    assert.deepEqual(profile, { archive, doc: office, xls: office, dwgEngine: "oda", dwgError: "oda_unavailable" });
    const result = await new Promise((resolve, reject) => {
      const job = request({ socketPath, path: "/v1/dwg", method: "POST",
        headers: { expect: "100-continue", "content-length": 6, "x-converter-image": image } }, response => {
        response.resume();
        resolve([response.statusCode, response.headers["x-converter-result"]]);
      }).on("continue", () => {
        job.destroy();
        reject(new Error("Unavailable DWG conversion admitted input"));
      }).on("error", reject);
      job.flushHeaders();
    });
    assert.deepEqual(result, [503, "oda_unavailable"]);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
      "image inspect", "image inspect", "container ls", ...(probes ? ["run --rm"] : []),
    ]);
  });
}
