import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { convertBytes, converterImage } from "../../../converter-port/index.ts";

const limit = 16 * 1024 ** 2;
const image = `sha256:${"6".repeat(64)}`;

function fixture(inputBytes, outputBytes) {
  const bytes = Buffer.alloc(inputBytes);
  bytes.write("AC1015");
  bytes.writeUInt32LE(outputBytes, 6);
  return bytes;
}

test("DWG v1 broker accepts 16 MiB inclusive on each leg and recovers after rejection", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dwg-d4-"));
  const socket = join(root, "b.sock");
  const bin = join(root, "bin");
  await mkdir(bin);
  const fakeDocker = join(bin, "docker");
  await copyFile(new URL("./docker-fixture.mjs", import.meta.url), fakeDocker);
  await chmod(fakeDocker, 0o700);
  const state = join(root, "fixture-state");
  const broker = spawn(process.execPath, [fileURLToPath(new URL("../../../../../infra/converters/broker.mjs", import.meta.url))], {
    env: { PATH: bin + delimiter + process.env.PATH, FACADE_DWG_IMAGE: image,
      FACADE_DWG_TEST_STATE: state, FACADE_CONVERTER_SOCKET: socket, FACADE_CONVERTER_SCRATCH: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(broker, "close");
  broker.stderr.on("data", (chunk) => t.diagnostic(chunk.toString().trim()));
  t.after(async () => {
    broker.kill();
    await exited;
    const fixtureLog = await readFile(state + ".errors", "utf8").catch(() => "");
    if (fixtureLog) t.diagnostic(fixtureLog);
    await rm(root, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    once(broker.stdout, "data").then(([chunk]) => chunk.toString()),
    once(broker.stderr, "data").then(([chunk]) => chunk.toString()),
    exited.then(([code]) => `broker exited: ${code}`),
  ]);
  assert.match(ready, /converter broker ready/u);
  const previous = process.env.FACADE_CONVERTER_SOCKET;
  process.env.FACADE_CONVERTER_SOCKET = socket;
  t.after(() => {
    if (previous === undefined) delete process.env.FACADE_CONVERTER_SOCKET;
    else process.env.FACADE_CONVERTER_SOCKET = previous;
  });

  assert.equal(await converterImage("dwg"), image);
  const convert = (input, output) => convertBytes("dwg", fixture(input, output), { image });
  assert.equal((await convert(limit - 1, 1)).bytes.length, 1);
  assert.equal((await convert(limit, 1)).bytes.length, 1);
  await assert.rejects(convert(limit + 1, 1), { code: "invalid_request" });
  assert.equal((await convert(10, limit - 1)).bytes.length, limit - 1);
  assert.equal((await convert(10, limit)).bytes.length, limit);
  await assert.rejects(convert(10, limit + 1), { code: "resource_limit" });
  assert.equal((await convert(10, 1)).bytes.length, 1);

  const launches = (await readFile(state + ".log", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(launches.map(({ size, stdoutBytes }) => [size, stdoutBytes]), [
    [limit - 1, 1], [limit, 1], [10, limit - 1], [10, limit], [10, limit + 1], [10, 1],
  ]);
  const scratch = (await readdir(root)).find((name) => name.startsWith("broker-"));
  assert.ok(scratch);
  assert.deepEqual(await readdir(join(root, scratch)), []);
  t.diagnostic(JSON.stringify({ limit, launches, aboveInput: "invalid_request", aboveOutput: "resource_limit", scratchEmpty: true }));
});
