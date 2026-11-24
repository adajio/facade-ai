import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the default DWG engine reports unavailable without a pinned ODA distribution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oda-default-"));
  const socketPath = join(dir, "b.sock");
  // Recovery can list the broker's containers. No other Docker command may run.
  await writeFile(join(dir, "docker"), '#!/bin/sh\n[ "$1 $2" = "container ls" ]\n', { mode: 0o700 });
  const image = `sha256:${"6".repeat(64)}`;
  const broker = spawn(process.execPath, [fileURLToPath(new URL("../../../../../infra/converters/broker.mjs", import.meta.url))], {
    env: { PATH: dir + delimiter + process.env.PATH, FACADE_CONVERTER_SOCKET: socketPath,
      FACADE_CONVERTER_SCRATCH: dir, FACADE_DWG_IMAGE: image },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = once(broker, "close");
  try {
    const ready = await Promise.race([once(broker.stdout, "data").then(([data]) => data.toString()), closed]);
    assert.match(String(ready), /converter broker ready/);
    const body = await new Promise((resolve, reject) => {
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
    assert.deepEqual(body, { dwgEngine: "oda", dwgError: "oda_unavailable" });
  } finally {
    broker.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
});
