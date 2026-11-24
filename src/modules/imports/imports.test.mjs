import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import pg from "pg";

const build = process.env.IMPORTS_TEST_BUILD ?? fileURLToPath(new URL("../../../dist", import.meta.url));
const load = path => import(pathToFileURL(resolve(build, "src/modules", path)).href);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function response(statusCode, body, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

test("Яндекс.Диск: обход дерева, скачивание, отзыв, пароль, граница переходов", async () => {
  const { YandexDisk, publicShare, selectPublicIpv4 } = await load("imports/yandex.js");
  const key = publicShare("https://disk.yandex.ru/d/synthetic");
  assert.throws(() => publicShare("https://disk.yandex.ru.example/d/synthetic"), { code: "unsupported_public_url" });
  assert.throws(() => publicShare("https://user@disk.yandex.ru/d/synthetic"), { code: "unsupported_public_url" });
  const signal = new AbortController().signal;
  const send = async url => {
    if (url.hostname === "downloader.disk.yandex.ru") return response(200, "abc");
    if (url.pathname.endsWith("/download")) {
      assert.equal(url.searchParams.get("path"), "/sub/drawing.pdf");
      return response(200, JSON.stringify({
        href: "https://downloader.disk.yandex.ru/synthetic", method: "GET", templated: false,
      }));
    }
    if (url.searchParams.get("path") === "/sub") {
      return response(200, JSON.stringify({ _embedded: { total: 1,
        items: [{ name: "drawing.pdf", type: "file", size: 3, sha256: digest("abc") }] } }));
    }
    return response(200, JSON.stringify({ name: "Shared", type: "dir", _embedded: { total: 1,
      items: [{ name: "sub", type: "dir" }] } }));
  };
  const disk = new YandexDisk(send);
  const entries = await disk.manifest(key, signal);
  assert.deepEqual(entries.map(entry => [entry.path, entry.parent]), [
    ["Shared", null], ["Shared/sub", 0], ["Shared/sub/drawing.pdf", 1],
  ]);
  const input = await disk.download(key, entries[2], signal);
  assert.equal((await input.toArray()).join(""), "abc");

  for (const [status, error, code] of [
    [403, "PublicResourcePasswordRequiredError", "remote_password_required"],
    [410, "", "remote_revoked"],
    [404, "DiskNotFoundError", "remote_inaccessible"],
  ]) {
    const invalid = new YandexDisk(async () => response(status, JSON.stringify({ error })));
    await assert.rejects(invalid.manifest(key, signal), { code });
  }
  let requests = 0;
  const redirect = new YandexDisk(async () => {
    requests++;
    return response(302, "", { location: "https://127.0.0.1/sensitive" });
  });
  await assert.rejects(redirect.manifest(key, signal), { code: "remote_destination_rejected" });
  assert.equal(requests, 1);
  assert.equal(selectPublicIpv4([{ address: "77.88.55.88" }]), "77.88.55.88");
  for (const address of ["127.0.0.1", "169.254.169.254", "192.168.1.2", "100.64.7.2", "::ffff:127.0.0.1"]) {
    assert.throws(() => selectPublicIpv4([{ address: "77.88.55.88" }, { address }]), {
      code: "remote_destination_rejected",
    });
  }
});

test("Настроенный CONNECT-прокси получает только разрешённое назначение", async t => {
  const { YandexDisk } = await load("imports/yandex.js");
  const authorities = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    authorities.push(request.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  proxy.listen({ port: 0, host: "127.0.0.1" });
  await once(proxy, "listening");
  const previous = process.env.FACADE_IMPORT_HTTPS_PROXY;
  process.env.FACADE_IMPORT_HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.FACADE_IMPORT_HTTPS_PROXY;
    else process.env.FACADE_IMPORT_HTTPS_PROXY = previous;
    return new Promise(resolve => proxy.close(resolve));
  });
  await assert.rejects(new YandexDisk().manifest("https://disk.yandex.ru/d/synthetic", AbortSignal.timeout(3000)),
    { code: "remote_destination_rejected" });
  assert.deepEqual(authorities, ["cloud-api.yandex.net:443"]);
});

const fixtures = `
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_STORED
import io, stat, struct, sys
from zlib import crc32

root = Path(sys.argv[1])
inner = io.BytesIO()
with ZipFile(inner, "w") as z:
    z.writestr("глубже/лист.pdf", b"%PDF-1.4\\nduplicate synthetic\\n")
with ZipFile(root / "mixed.zip", "w") as z:
    z.writestr("I/лист.pdf", b"%PDF-1.4\\nduplicate synthetic\\n")
    z.writestr("I/broken.zip", b"synthetic damaged container")
    z.writestr("II/лист.pdf", b"%PDF-1.4\\ndifferent synthetic\\n")
    z.writestr("inner.zip", inner.getvalue())
    z.writestr("../outside.pdf", b"must be rejected")
    info = ZipInfo("alias.pdf")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    z.writestr(info, "I/лист.pdf")
with ZipFile(root / "empty.zip", "w"):
    pass
with ZipFile(root / "damaged-entry.zip", "w", compression=ZIP_STORED) as z:
    z.writestr("bad.txt", b"damaged-content")
    z.writestr("after.txt", b"still legitimate")
broken = root / "damaged-entry.zip"
broken.write_bytes(broken.read_bytes().replace(b"damaged-content", b"Damaged-Content", 1))

# A single uncompressed file, generated from the RAR 4 block layout.
def rar_block(kind, flags, body):
    header = struct.pack("<BHH", kind, flags, 7 + len(body)) + body
    return struct.pack("<H", crc32(header) & 0xffff) + header

name = b"rar.txt"
contents = b"RAR fixture"
rar = bytes.fromhex("526172211a0700")
rar += rar_block(0x73, 0, bytes(6))
description = struct.pack("<IIBIIBBHI", len(contents), len(contents), 3,
                          crc32(contents), 0, 20, 0x30, len(name), 0o100644)
rar += rar_block(0x74, 0x8000, description + name) + contents
rar += rar_block(0x7b, 0, b"")
(root / "stored.rar").write_bytes(rar)

`;

async function fixtureDirectory(t) {
  const workspace = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "import-fixtures-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync("python3", ["-c", fixtures, workspace]);
  await writeFile(join(workspace, "synthetic.txt"), "7z fixture");
  execFileSync("bsdtar", ["--format", "7zip", "-cf", "seven.7z", "synthetic.txt"], { cwd: workspace });
  execFileSync("zip", ["-q", "-P", "synthetic-fixture", "protected.zip", "synthetic.txt"], { cwd: workspace });
  return workspace;
}

test("Распаковщик: ZIP, 7z, RAR, шифрование, CRC и точные пределы", {
  skip: !process.env.FACADE_CONVERTER_SOCKET, timeout: 240_000,
}, async t => {
  const { extractArchive } = await load("imports/archive.js");
  const workspace = await fixtureDirectory(t);
  async function frames(name, limits) {
    const observed = [];
    const file = join(workspace, name);
    const source = { stream: createReadStream(file), size: (await stat(file)).size };
    for await (const frame of extractArchive(source, AbortSignal.timeout(60_000), limits)) {
      observed.push(frame);
    }
    return observed;
  }
  const exact = await frames("seven.7z", { bytes: 10, entries: 1 });
  assert.deepEqual(exact.at(-1), { type: "done", result: "ok" });
  assert.equal(Buffer.concat(exact.filter(frame => frame.type === "data").map(frame => frame.bytes)).toString(), "7z fixture");
  assert.deepEqual((await frames("seven.7z", { bytes: 9, entries: 1 })).at(-1),
    { type: "done", result: "archive_expanded_limit" });
  assert.deepEqual((await frames("seven.7z", { bytes: 20, entries: 0 })).at(-1),
    { type: "done", result: "archive_entry_limit" });
  const rar = await frames("stored.rar");
  assert.deepEqual(rar.at(-1), { type: "done", result: "ok" });
  assert.equal(Buffer.concat(rar.filter(frame => frame.type === "data").map(frame => frame.bytes)).toString(), "RAR fixture");
  assert.deepEqual((await frames("empty.zip")).at(-1), { type: "done", result: "archive_empty" });
  assert.ok((await frames("protected.zip")).some(frame => frame.result === "archive_encrypted"));
  const corrupted = await frames("damaged-entry.zip");
  assert.ok(corrupted.some(frame => frame.type === "end" && frame.result === "archive_corrupt"));
  assert.ok(corrupted.some(frame => frame.type === "entry" && frame.path === "after.txt"));
});

function asyncReader(bytes, breakAfter) {
  return Object.assign(Readable.from((async function* () {
    if (breakAfter === undefined) yield bytes;
    else {
      yield bytes.subarray(0, breakAfter);
      const error = new Error("synthetic interruption");
      error.code = "ECONNRESET";
      throw error;
    }
  })()), { statusCode: 200, headers: {} });
}

async function eventually(check, timeoutMs = 80_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  assert.fail("Expected state was not reached before the deadline");
}

test("AC02/R04 и удержания R01 через маршруты, PostgreSQL и S3", {
  skip: process.env.IMPORTS_TEST_DB !== "1", timeout: 240_000,
}, async t => {
  const databaseUrl = process.env.DATABASE_URL;
  const dataDir = process.env.FACADE_DATA_DIR;
  assert.ok(databaseUrl && dataDir && process.env.FACADE_S3_ENDPOINT && process.env.FACADE_CONVERTER_SOCKET);
  const origin = "http://localhost:3000";
  const previousOrigin = process.env.FACADE_PUBLIC_ORIGIN;
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.FACADE_PUBLIC_ORIGIN;
    else process.env.FACADE_PUBLIC_ORIGIN = previousOrigin;
  });
  const db = new pg.Pool({ connectionString: databaseUrl });
  const app = Fastify();
  app.decorate("db", db);
  app.decorate("config", { databaseUrl, dataDir, host: "127.0.0.1", port: 3000 });
  app.setErrorHandler((error, _, reply) => {
    const code = error.statusCode ?? 500;
    reply.code(code).send({ code: error.code ?? "internal_error" });
  });
  const [auth, access, intake, imports, letters, supplements] = await Promise.all([
    load("access/auth.js"), load("access/index.js"), load("intake/index.js"), load("imports/index.js"),
    load("letters/routes.js"), load("supplements/holds.js"),
  ]);
  const syntheticItems = new Map();
  await app.register(access.register);
  await app.register(intake.register);
  await app.register(imports.register);
  await app.register(async scope => {
    letters.registerLetterRoutes(scope, {
      lockScopes: supplements.lockScopes,
      async getHolds(tx, projectId, scopeId) { return (await intake.getIntakeGate(tx, projectId, scopeId)).holds; },
      async getGrounds(_tx, { scopeId }) { return syntheticItems.get(scopeId) ?? []; },
    }, "/api");
  });
  await app.ready();
  let stopWorker;
  t.after(async () => {
    await stopWorker?.();
    await app.close();
    await db.end();
  });

  async function insert(sql, args) { return (await db.query(sql, args)).rows[0].id; }
  const org = await insert("INSERT INTO organizations(name) VALUES('Синтетический импорт') RETURNING id");
  const password = randomUUID();
  const suffix = randomUUID().slice(0, 12);
  const login = `imports-${suffix}`;
  const outsiderLogin = `imports-outsider-${suffix}`;
  const hash = await auth.passwordHash(password);
  const user = await insert("INSERT INTO users(organization_id,login,password_hash,state) VALUES($1,$2,$3,'active') RETURNING id", [org, login, hash]);
  await insert("INSERT INTO users(organization_id,login,password_hash,state) VALUES($1,$2,$3,'active') RETURNING id", [org, outsiderLogin, hash]);
  const catalog = await insert("INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,1,'Синтетический','[]',$3) RETURNING id", [org, suffix, user]);
  const project = await insert("INSERT INTO projects(organization_id,name,catalog_version_id) VALUES($1,'Импорт',$2) RETURNING id", [org, catalog]);
  const scope = await insert("INSERT INTO project_scopes(project_id,stage,name) VALUES($1,'test','Область') RETURNING id", [project]);
  await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'engineer')",
    [org, project, user]);
  async function credentials(login) {
    const signed = await app.inject({ method: "POST", url: "/api/sessions", headers: { origin }, payload: { login, password } });
    assert.equal(signed.statusCode, 200, signed.body);
    return { origin, cookie: signed.headers["set-cookie"].split(";")[0], "x-csrf-token": signed.json().csrfToken };
  }
  const authorized = await credentials(login);
  const unauthorized = await credentials(outsiderLogin);
  const send = (method, url, payload, headers, key = randomUUID()) =>
    app.inject({ method, url: `/api${url}`, payload,
      headers: { ...authorized, "idempotency-key": key, ...headers } });
  async function json(status, method, url, payload, headers, key) {
    const result = await send(method, url, payload, headers, key);
    assert.equal(result.statusCode, status, result.body);
    assert.equal(result.headers["cache-control"], "no-store");
    return result.json();
  }
  const receipt = async () => (await json(201, "POST", `/projects/${project}/receipts`, { source: "import" })).receiptId;
  const getGate = () => access.transaction(db, tx => intake.getIntakeGate(tx, project, scope));
  const importLink = (id, payload, key) => json(202, "POST", `/receipts/${id}/imports`, {
    url: `https://disk.yandex.ru/d/${payload}`, scopeIds: [scope],
  }, undefined, key);
  const cancelLink = (status, id, ref) => json(status, "POST", `/receipts/${id}/imports/${ref}/cancel`, {});
  const item = { id: randomUUID(), questionId: randomUUID(), decisionId: randomUUID(),
    questionVersion: 1, scopeId: scope, wording: "Синтетическая просьба" };
  syntheticItems.set(scope, [item]);
  const letter = await insert(
    "INSERT INTO letters(project_id,scope_id,number,created_by) VALUES($1,$2,1,$3) RETURNING id",
    [project, scope, user],
  );
  const text = "Синтетический текст письма";
  const revision = await insert(
    `INSERT INTO letter_revisions(letter_id,version,status,recipient,layout,items,text,text_sha256,created_by)
     VALUES($1,1,'confirmed','Тестовый адресат','formal',$2,$3,$4,$5) RETURNING id`,
    [letter, JSON.stringify([item]), text, digest(text), user],
  );
  const historical = await insert(
    `INSERT INTO letter_sends(letter_id,revision_id,recipient,items,text,text_sha256,sent_at,registered_by)
     VALUES($1,$2,'Тестовый адресат',$3,$4,$5,now(),$6) RETURNING id`,
    [letter, revision, JSON.stringify([item]), text, digest(text), user],
  );
  const currentExport = await json(201, "POST", `/letters/${letter}/exports`, { format: "txt" }, { "if-match": '"1"' });
  const exportUrl = currentExport.url.slice(4);
  const historicUrl = `/letters/${letter}/sent/${historical}`;
  assert.equal((await send("GET", exportUrl)).body, text);

  const first = await receipt(), second = await receipt();
  const replayKey = randomUUID();
  const queuedA = await importLink(first, "cancel-a", replayKey);
  assert.deepEqual(await importLink(first, "cancel-a", replayKey), queuedA);
  const queuedB = await importLink(second, "cancel-b");
  assert.equal((await getGate()).holds.length, 2);
  assert.equal((await json(409, "GET", exportUrl)).code, "scope_held");
  assert.equal((await json(200, "GET", historicUrl)).text, text);
  assert.equal((await json(200, "GET", `/receipts/${first}/inventory`)).occurrences.length, 0);
  assert.equal((await json(404, "GET", `/receipts/${first}/imports`, undefined, unauthorized)).code, "not_found");
  assert.equal((await send("POST", `/receipts/${first}/imports`, { url: "https://disk.yandex.ru/d/another" },
    { "x-csrf-token": "invalid" })).statusCode, 403);
  await cancelLink(200, first, queuedA.importId);
  assert.equal((await getGate()).holds.length, 1);
  assert.equal((await json(409, "GET", exportUrl)).code, "scope_held");
  await cancelLink(200, second, queuedB.importId);
  assert.equal((await getGate()).holds.length, 0);
  assert.equal((await send("GET", exportUrl)).body, text);

  const workspace = await fixtureDirectory(t);
  const mixed = await readFile(join(workspace, "mixed.zip"));
  const large = Buffer.alloc(1024 ** 2 + 19, 65);
  large.write("%PDF-1.4\n");
  const ready = Buffer.from("%PDF-1.4\nreadable original before sealing the inventory\n");
  const sources = [
    { path: "Ready/ready.pdf", kind: "file", remotePath: "/ready.pdf", parent: null,
      sha256: digest(ready), size: ready.length, mediaType: "application/pdf", data: ready },
    { path: "First/early.pdf", kind: "file", remotePath: "/early.pdf", parent: null,
      sha256: digest(large), size: large.length, mediaType: "application/pdf", data: large },
    { path: "Second/mixed.zip", kind: "file", remotePath: "/mixed.zip", parent: null,
      sha256: null, size: mixed.length, mediaType: "application/zip", data: mixed },
  ];
  let interrupted = false;
  let settleArchive;
  const archiveWaiting = new Promise(resolve => { settleArchive = resolve; });
  let archiveStarted = false;
  const controller = new AbortController();
  process.env.FACADE_INTAKE_PART_BYTES = String(1024 ** 2);
  const storage = intake.createIntakeStorage(dataDir);
  const worker = imports.startImports({
    db, config: app.config, signal: controller.signal, logger: console,
  }, { storage, transport: {
    async manifest() { return sources; },
    async download(_url, source, signal) {
      const item = sources.find(candidate => candidate.remotePath === source.remotePath);
      if (item === sources[1] && !interrupted) {
        interrupted = true;
        return asyncReader(item.data, 1024 ** 2);
      }
      if (item === sources[2] && !archiveStarted) {
        archiveStarted = true;
        await Promise.race([archiveWaiting, new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      }
      return asyncReader(item.data);
    },
  } });
  stopWorker = async () => { controller.abort(); settleArchive(); await worker; storage.objects.close(); };

  const target = await receipt();
  const queued = await importLink(target, "mixed");
  await json(200, "POST", `/receipts/${target}/seal`, {});
  const partial = await eventually(async () => {
    const view = await json(200, "GET", `/receipts/${target}/inventory`);
    return view.uploads.find(item => item.confirmedBytes === 1024 ** 2);
  });
  const part = await json(200, "GET", `/uploads/${partial.uploadId}`);
  assert.equal(part.parts.length, 1);
  assert.equal(part.parts[0].sha256, digest(large.subarray(0, 1024 ** 2)));
  const openInventory = await json(200, "GET", `/receipts/${target}/inventory`);
  assert.equal(openInventory.inventoryOpen, true);
  const readyOriginal = openInventory.occurrences.find(item => item.relativePath === "Ready/ready.pdf");
  assert.equal(readyOriginal.status, "accepted");
  assert.equal((await db.query("SELECT count(*)::int AS jobs FROM intake_reader_jobs WHERE version_id=$1",
    [readyOriginal.versionId])).rows[0].jobs, 1);
  assert.deepEqual((await send("GET", `/documents/${readyOriginal.documentId}/versions/${readyOriginal.versionId}/content`)).rawPayload, ready);
  await cancelLink(409, target, queued.importId);
  settleArchive();
  await eventually(async () => {
    const result = await json(200, "GET", `/receipts/${target}/imports`);
    return result.imports[0].status === "completed";
  });
  const inventory = await eventually(async () => {
    const result = await json(200, "GET", `/receipts/${target}/inventory`);
    return !result.inventoryOpen && result;
  });
  const early = inventory.occurrences.find(item => item.relativePath === "First/early.pdf");
  assert.equal(early.status, "accepted");
  assert.equal(early.sha256, digest(large));
  assert.equal(inventory.uploads.find(item => item.uploadId === partial.uploadId).status, "complete");
  const archive = inventory.occurrences.find(item => item.relativePath === "Second/mixed.zip");
  const nested = inventory.occurrences.find(item => item.relativePath === "inner.zip");
  assert.equal(nested.parentOccurrenceId, archive.occurrenceId);
  const duplicates = inventory.occurrences.filter(item => item.sha256 === digest("%PDF-1.4\nduplicate synthetic\n"));
  assert.equal(duplicates.length, 2);
  assert.equal(new Set(duplicates.map(item => item.originalId)).size, 1);
  assert.equal(new Set(duplicates.map(item => item.occurrenceId)).size, 2);
  assert.deepEqual(new Set(duplicates.map(item => item.parentOccurrenceId)),
    new Set([archive.occurrenceId, nested.occurrenceId]));
  assert.equal(inventory.occurrences.find(item => item.relativePath === "I/broken.zip").restriction, "archive_corrupt");
  const listing = await json(200, "GET", `/receipts/${target}/import-inventory`);
  assert.ok(listing.entries.some(item => item.originalPath === "../outside.pdf" && item.reason === "invalid_source_path"));
  assert.ok(listing.entries.some(item => item.originalPath === "alias.pdf" && item.reason === "archive_special_entry"));
  assert.equal((await send("GET", `/documents/${early.documentId}/versions/${early.versionId}/content`,
    undefined, { range: "bytes=0-7" })).body, "%PDF-1.4");
  await cancelLink(409, target, queued.importId);
  assert.equal((await getGate()).holds.length, 1);

  const direct = (await json(201, "POST", `/projects/${project}/receipts`, { source: "upload" })).receiptId;
  const seven = await readFile(join(workspace, "seven.7z"));
  const declared = await json(201, "POST", `/receipts/${direct}/uploads`, {
    relativePath: "Selected folder/nested/seven.7z", size: seven.length, sha256: digest(seven),
  });
  const written = await send("PUT", `/uploads/${declared.uploadId}/parts/1`, seven, {
    "content-type": "application/octet-stream", "content-length": String(seven.length), "x-part-sha256": digest(seven),
  });
  assert.equal(written.statusCode, 200, written.body);
  const directOriginal = await json(200, "POST", `/uploads/${declared.uploadId}/complete`, {});
  assert.deepEqual(await json(200, "POST", `/uploads/${declared.uploadId}/complete`, {}), directOriginal);
  await json(200, "POST", `/receipts/${direct}/seal`, {});
  const completeDirect = await eventually(async () => {
    const view = await json(200, "GET", `/receipts/${direct}/inventory`);
    return !view.inventoryOpen && view;
  });
  const directChild = completeDirect.occurrences.find(item => item.relativePath === "synthetic.txt");
  assert.equal(directChild.parentOccurrenceId, directOriginal.occurrenceId);
  assert.equal(directChild.sha256, digest("7z fixture"));
});
