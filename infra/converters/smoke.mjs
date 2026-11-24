import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { archiveBytes, convertBytes, convertDwg, converterImage, dwgProfile } from "../../src/modules/converter-port/index.ts";

function storedZip(name, payload) {
  const path = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(payload), 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12);
  end.writeUInt32LE(local.length + path.length + payload.length, 16);
  return Buffer.concat([local, path, payload, central, path, end]);
}

async function collect(frames) {
  const chunks = [];
  for await (const chunk of frames) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function checkArchive() {
  const image = await converterImage("archive");
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
  const payload = Buffer.from("synthetic\n");
  const zip = storedZip("spec.txt", payload);
  const options = { size: zip.length, bytes: payload.length, entries: 1 };
  const expected = `entry file ${Buffer.from("spec.txt").toString("hex")}\ndata 10\nsynthetic\nend ok\ndone ok\n`;
  assert.equal(await collect(archiveBytes(Readable.from([zip.subarray(0, 17), zip.subarray(17)]), options)), expected);
  assert.match(await collect(archiveBytes(zip, { ...options, bytes: 3 })), /data 3\nsynend archive_expanded_limit\ndone archive_expanded_limit\n$/);
  await assert.rejects(collect(archiveBytes(zip, { ...options, entries: 10_001 })), { code: "invalid_request" });

  const source = new PassThrough();
  const resumed = once(source, "resume");
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  const aborted = assert.rejects(collect(archiveBytes(source, { ...options, signal: controller.signal })), error => error === reason);
  await resumed;
  source.write(zip.subarray(0, 17));
  await assert.rejects(collect(archiveBytes(zip, options)), { code: "busy" });
  controller.abort(reason);
  await aborted;
  const inputError = new Error("synthetic verification failure");
  await retryWhenBusy(async () => {
    const broken = Readable.from((async function* () {
      yield zip.subarray(0, 17);
      throw inputError;
    })());
    await assert.rejects(collect(archiveBytes(broken, options)), error => {
      if (error.code === "busy") throw error;
      return error === inputError;
    });
  });
  await retryWhenBusy(async () => assert.equal(await collect(archiveBytes(zip, options)), expected));
  console.log(`archive ${image} passed: streamed ZIP, expanded limit, invalid request, busy, source error and abort recovery`);
}

async function retryWhenBusy(run) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (error.code !== "busy" || attempt === 49) throw error;
      await delay(100);
    }
  }
}

async function checkDwg() {
  const profile = await dwgProfile();
  assert.ok(profile);
  const path = process.env.FACADE_SMOKE_DWG ??
    new URL("../../src/modules/formats/test/fixtures/schedule.dwg", import.meta.url);
  const size = (await stat(path)).size;
  const badImage = `sha256:${"0".repeat(64)}`;
  const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
  const run = (source, length, image = profile.id) =>
    convertDwg(source, sink(), { size: length, image, identity: profile.identity, timeout: profile.timeout });
  await assert.rejects(run(createReadStream(path), size, badImage), { code: "unavailable" });
  const result = await run(createReadStream(path), size);
  assert.ok(result.size > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(run(Readable.from([Buffer.from("INVALID")]), 7), { code: "invalid_request" });
  console.log(`dwg ${profile.id} passed: pinned image, verified derivative, incorrect image, wrong input signature`);
}

async function checkConversion(operation) {
  const image = await converterImage(operation);
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
  const input = await readFile(new URL(`../../src/modules/formats/test/fixtures/schedule.${operation}`, import.meta.url));
  await assert.rejects(convertBytes(operation, input, { image: `sha256:${"0".repeat(64)}` }), { code: "unavailable" });
  const output = await convertBytes(operation, input, { image });
  assert.equal(output.sha256, createHash("sha256").update(output.bytes).digest("hex"));
  assert.equal(output.bytes.readUInt32LE(), 0x04034b50);
  assert.ok(output.bytes.includes(operation === "doc" ? "word/document.xml" : "xl/workbook.xml"));
  await assert.rejects(convertBytes(operation, Buffer.from("synthetic wrong format"), { image }), { code: "invalid_request" });
  console.log(`${operation} ${image} passed: pinned image, valid derivative, incorrect image, wrong input signature`);
}

for (const operation of process.argv.slice(2)) {
  if (operation === "archive") await checkArchive();
  else if (operation === "dwg") await checkDwg();
  else if (["doc", "xls"].includes(operation)) await checkConversion(operation);
  else throw new Error("Use archive, doc, xls or dwg");
}
if (process.argv.length < 3) throw new Error("Supply at least one operation to check");
