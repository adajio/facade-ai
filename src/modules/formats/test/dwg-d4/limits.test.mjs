import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createFormatAdapters } from "../../../../../dist/src/modules/formats/index.js";
import { convertDwg, dwgProfile } from "../../../converter-port/index.ts";

const limit = 16 * 1024 ** 2;
const image = `sha256:${"6".repeat(64)}`;

function fixture(inputBytes, outputBytes, mode = ".") {
  const bytes = Buffer.alloc(inputBytes);
  bytes.write("AC1015");
  bytes.writeUInt32LE(outputBytes, 6);
  bytes.write(mode, 10);
  return bytes;
}

test("DWG adapter streams both legs above the old limit and broker releases aborted jobs", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dwg-d4-"));
  const socket = join(root, "b.sock");
  const bin = join(root, "bin");
  await mkdir(bin);
  const fakeDocker = join(bin, "docker");
  await copyFile(new URL("./docker-fixture.mjs", import.meta.url), fakeDocker);
  await chmod(fakeDocker, 0o700);
  const state = join(root, "fixture-state");
  const scope = createHash("sha256").update(socket).digest("hex").slice(0, 24);
  const scratch = join(root, `broker-${scope}`);
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(join(scratch, "job-ABC123"));
  const broker = spawn(process.execPath, [fileURLToPath(new URL("../../../../../infra/converters/broker.mjs", import.meta.url))], {
    env: { PATH: bin + delimiter + process.env.PATH, FACADE_DWG_IMAGE: image, FACADE_DWG_ENGINE: "libredwg",
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

  assert.deepEqual(await readdir(scratch), []);
  const profile = await dwgProfile();
  assert.equal(profile.id, image);
  assert.ok(profile.timeout > 420_000);
  const convert = (data, options = {}, sink = new Writable({ write(_chunk, _encoding, done) { done(); } })) =>
    convertDwg(Readable.from([data]), sink, { size: data.length, image, timeout: profile.timeout, ...options });

  const source = join(root, "size.dwg");
  await writeFile(source, fixture(limit + 1, limit + 1));
  const adapter = createFormatAdapters().find(entry => entry.format === "dwg");
  const [unit] = await adapter.inspect(source);
  assert.equal(unit.locator.derivative, "dxf");
  assert.equal(unit.locator.coverage, "partial");
  const output = await adapter.read(source, { address: { unitId: unit.id }, representation: "native" }, unit);
  const doc = JSON.parse(output.bytes);
  assert.equal(doc.lines[0].text, "DWG test | 23 mm");
  assert.equal(doc.lines[0].locator.derivativeHandle, "AFF");
  assert.equal(doc.lines[0].locator.handle, undefined);
  assert.match(doc.derivativeSha256, /^[a-f0-9]{64}$/);

  const small = fixture(11, 256);
  await assert.rejects(convert(fixture(11, 0, "m")), { code: "output_missing" });
  await assert.rejects(convert(fixture(11, 0, "t")), { code: "failed" });
  await assert.rejects(convert(fixture(11, 0, "d")), { code: "scratch_unavailable" });
  await assert.rejects(convert(fixture(11, 0, "o")), { code: "memory_limit" });
  await assert.rejects(convert(small, { size: 12 }), { code: "invalid_request" });
  await assert.rejects(retry(() => convert(small, { size: 10 })), { code: "invalid_request" });
  await assert.rejects(convert(small, { size: 10 * 1024 ** 3 + 1 }), { code: "invalid_request" });

  const controller = new AbortController();
  const reason = new Error("abort derivative download");
  await assert.rejects(retry(() => convert(fixture(11, limit + 1), { signal: controller.signal },
    new Writable({ write(_chunk, _encoding, done) { controller.abort(reason); done(); } }))),
  error => error === reason);
  assert.equal((await retry(() => convert(small))).size, 256);

  const sinkError = Object.assign(new Error("synthetic ENOSPC"), { code: "ENOSPC", syscall: "write" });
  await assert.rejects(convert(small, {},
    new Writable({ write(_chunk, _encoding, done) { done(sinkError); } })), error => error === sinkError);
  assert.equal((await retry(() => convert(small))).size, 256);
  assert.deepEqual(await readdir(scratch), []);
  const launches = (await readFile(state + ".log", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(launches.slice(0, 2).map(({ size, outputSize }) => [size, outputSize]), [
    [limit + 1, limit + 1], [limit + 1, limit + 1],
  ]);
  assert.equal(launches.length, 10);
});

async function retry(run) {
  for (let attempts = 0; ; attempts++) {
    try {
      return await run();
    } catch (error) {
      if (error.code !== "busy" || attempts >= 40) throw error;
      await delay(50);
    }
  }
}

test("DWG output requires the result trailer and matching size and digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "dwg-trailer-"));
  const socket = join(root, "b.sock");
  const old = process.env.FACADE_CONVERTER_SOCKET;
  const server = createServer();
  const bytes = Buffer.from("derivative");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let mode;
  server.on("checkContinue", (input, output) => {
    output.writeContinue();
    input.on("end", () => {
      output.writeHead(200, {
        "x-converter-bytes": String(bytes.length + Number(mode === "too-short")),
        trailer: "x-converter-result, x-converter-sha256, x-converter-bytes",
      });
      output.write(bytes);
      if (mode !== "no-trailer") output.addTrailers({
        "x-converter-result": "ok",
        "x-converter-sha256": mode === "bad-hash" ? "0".repeat(64) : sha256,
        "x-converter-bytes": String(bytes.length),
      });
      output.end();
    });
    input.resume();
  });
  try {
    server.listen(socket);
    await once(server, "listening");
    process.env.FACADE_CONVERTER_SOCKET = socket;
    const convert = () => convertDwg(Readable.from([Buffer.from("AC1015")]),
      new Writable({ write(_chunk, _encoding, done) { done(); } }), { size: 6, image, timeout: 4000 });
    mode = "no-trailer";
    await assert.rejects(convert(), { code: "unavailable" });
    mode = "bad-hash";
    await assert.rejects(convert(), { code: "failed" });
    mode = "too-short";
    await assert.rejects(convert(), { code: "failed" });
    mode = "ok";
    assert.deepEqual(await convert(), { size: bytes.length, sha256 });
  } finally {
    if (old === undefined) delete process.env.FACADE_CONVERTER_SOCKET;
    else process.env.FACADE_CONVERTER_SOCKET = old;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
