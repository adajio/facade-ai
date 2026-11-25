import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import Fastify from "fastify";
import pg from "pg";

const dist = process.env.INTAKE_TEST_DIST || resolve("dist");
const compiled = (name) => import(pathToFileURL(resolve(dist, name)).href);
const root = new URL("../../../", import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = () => randomBytes(32).toString("base64url");

async function fixture(db) {
  const { rows: [{ id: organization }] } = await db.query("INSERT INTO organizations(name) VALUES ('Intake test') RETURNING id");
  const users = [];
  for (const login of ["intake-owner", "intake-outsider"]) {
    const { rows: [{ id }] } = await db.query(
      "INSERT INTO users(organization_id,login,password_hash,state) VALUES ($1,$2,$3,'active') RETURNING id",
      [organization, login, "$argon2id$fixture"],
    );
    const session = token();
    await db.query(
      "INSERT INTO access_sessions(user_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [id, Buffer.from(sha(session), "hex")],
    );
    users.push({ id, session });
  }
  const [owner, outsider] = users;
  const { rows: [{ id: catalog }] } = await db.query(
    `INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by)
     VALUES ($1,'test',1,'Test','[]',$2) RETURNING id`, [organization, owner.id],
  );
  const { rows: [{ id: project }] } = await db.query(
    "INSERT INTO projects(organization_id,name,catalog_version_id) VALUES ($1,'Test',$2) RETURNING id",
    [organization, catalog],
  );
  await db.query(
    `INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES ($1,$2,$3,'project_manager')`,
    [organization, project, owner.id],
  );
  const { rows: [{ id: scopeA }, { id: scopeB }] } = await db.query(
    "INSERT INTO project_scopes(project_id,stage,name) VALUES ($1,'test','A'),($1,'test','B') RETURNING id", [project],
  );
  return { project, scopeA, scopeB, owner, outsider };
}

async function expectResponse(response, status) {
  if (response.status !== status) assert.fail(`Expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
}

test("durable intake, replay, project holds and private Range over HTTP", { timeout: 300_000 }, async (t) => {
  const connectionString = process.env.DATABASE_URL;
  assert.match(new URL(connectionString).pathname, /^\/test_step3[a-z0-9_]*$/, "Use a fresh isolated step3 database");
  assert.ok(process.env.FACADE_DATA_DIR && process.env.FACADE_S3_BUCKET);
  const [{ register, createIntakeStorage }, uploads, gate, receipts, { csrfToken }, { transaction }, imports, { partPath }] = await Promise.all([
    compiled("src/modules/intake/index.js"),
    compiled("src/modules/intake/uploads.js"),
    compiled("src/modules/intake/gate.js"),
    compiled("src/modules/intake/receipts.js"),
    compiled("src/modules/access/auth.js"),
    compiled("src/modules/access/commands.js"),
    compiled("src/modules/imports/index.js"),
    compiled("src/modules/intake/blob.js"),
  ]);
  const db = new pg.Pool({ connectionString });
  const storage = createIntakeStorage(process.env.FACADE_DATA_DIR);
  t.after(async () => { storage.objects.close(); await db.end(); });
  for (const file of ["02_access_schema.sql", "03_intake_schema.sql", "03_intake_z_prepare.sql", "10_imports_schema.sql"]) {
    await db.query(await readFile(new URL(`db/migrations/${file}`, root), "utf8"));
  }
  const { project, scopeA, scopeB, owner, outsider } = await fixture(db);
  const old = await db.query(
    "INSERT INTO intake_receipts(project_id,created_by,source) VALUES ($1,$2,'upload') RETURNING id",
    [project, owner.id],
  );
  for (const file of ["03_intake_zz_manifest.sql", "04_pdf_evidence.sql", "13_access_intake_projects.sql"]) {
    await db.query(await readFile(new URL(`db/migrations/${file}`, root), "utf8"));
  }
  let origin;
  async function startApi() {
    const app = Fastify();
    app.decorate("db", db);
    app.decorate("config", { dataDir: process.env.FACADE_DATA_DIR });
    app.setErrorHandler((error, _request, reply) => {
      const status = error.statusCode ?? 500;
      return reply.code(status).send({ code: error.code, message: status >= 500 ? "Internal error" : error.message });
    });
    await app.register(register);
    await app.register(imports.register);
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    t.after(() => app.close());
    return app;
  }

  const app = await startApi();
  const cookies = (actor) => ({ cookie: `facade_session=${actor.session}` });
  const mutationHeaders = (actor = owner) => ({ ...cookies(actor), origin, "x-csrf-token": csrfToken(actor.session) });
  const get = (path, headers, actor = owner) => fetch(origin + "/api" + path, { headers: { ...cookies(actor), ...headers } });
  const post = (path, body = {}, key = randomUUID(), actor = owner) => fetch(origin + "/api" + path, {
    method: "POST", headers: { ...mutationHeaders(actor), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  const postJson = async (path, data, status = 200, key) => {
    const response = await post(path, data, key);
    await expectResponse(response, status);
    return await response.json();
  };
  const snapshot = (scope) => transaction(db, async (tx) => {
    await gate.lockIntakeProject(tx, project);
    return gate.getIntakeGate(tx, project, scope);
  });

  const legacy = await (await get(`/receipts/${old.rows[0].id}/inventory`)).json();
  assert.equal(legacy.manifest, null);
  assert.equal(legacy.sealed, false);
  await postJson(`/receipts/${old.rows[0].id}/seal`);

  const key = randomUUID();
  const newReceipt = () => postJson(`/projects/${project}/receipts`, {}, 201);
  const receipt = await postJson(`/projects/${project}/receipts`, {}, 201, key);
  assert.deepEqual(await postJson(`/projects/${project}/receipts`, {}, 201, key), receipt);
  await expectResponse(await post(`/projects/${project}/receipts`, { source: "import" }, key), 409);
  assert.deepEqual(await snapshot(scopeA), { generation: 0, projectGeneration: 0, holds: [] });
  const inventoryEndpoint = `/receipts/${receipt.receiptId}/inventory`;
  const sourcePdf = await readFile(new URL("test/fixtures/input/facade-package.pdf", root));
  const partSize = storage.partSize;
  assert.ok(sourcePdf.length < partSize);
  const pdf = Buffer.concat([sourcePdf, Buffer.alloc(partSize)]);
  const data = { relativePath: "фасад/чертёж.pdf", size: pdf.length, sha256: sha(pdf), scopeIds: [scopeA] };
  const declare = (r, body = data) => postJson(`/receipts/${r.receiptId}/uploads`, body, 201);
  const upload = await declare(receipt);
  const u = `/uploads/${upload.uploadId}`;
  assert.equal((await snapshot(scopeA)).holds.length, 1);
  assert.equal((await snapshot(scopeB)).generation, 0);
  await expectResponse(await post(u + "/complete"), 409);
  const cancelled = await declare(await newReceipt());
  const { holds: overlapping } = await snapshot(scopeA);
  assert.equal(overlapping.length, 2);
  await postJson(`/uploads/${cancelled.uploadId}/cancel`);
  assert.deepEqual((await snapshot(scopeA)).holds.map((hold) => hold.id), [upload.holdId]);
  const expired = await declare(await newReceipt(), { ...data, scopeIds: undefined });
  assert.equal((await snapshot(scopeB)).holds[0].id, expired.holdId);
  const firstPart = pdf.subarray(0, partSize);
  const part = { number: 1, length: partSize, sha256: sha(firstPart) };
  await uploads.writePart(db, storage, { projectId: project, uploadId: expired.uploadId, ...part },
    Readable.from([firstPart]));
  const expiredPath = partPath(storage, expired.uploadId, part);
  await access(expiredPath);
  await db.query("UPDATE intake_uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.uploadId]);
  await uploads.cleanIntakeUploads(db, storage);
  await assert.rejects(access(expiredPath), { code: "ENOENT" });
  assert.deepEqual((await snapshot(scopeB)).holds, []);
  assert.equal((await (await get(`/uploads/${expired.uploadId}`)).json()).status, "expired");

  const importReceipt = await newReceipt();
  const firstImport = await transaction(db, (tx) => receipts.declareImport(tx, { projectId: project, receiptId: importReceipt.receiptId }));
  const secondImport = await transaction(db, (tx) => receipts.declareImport(tx, { projectId: project, receiptId: importReceipt.receiptId }));
  assert.equal((await snapshot(scopeB)).holds.length, 2);
  await transaction(db, (tx) => receipts.cancelImport(tx, { projectId: project, receiptId: importReceipt.receiptId, importId: firstImport.importId }));
  assert.deepEqual((await snapshot(scopeB)).holds.map((hold) => hold.id), [secondImport.holdId]);

  const chunks = [pdf.subarray(0, partSize), pdf.subarray(partSize)];
  const put = async (number, bytes, hash = sha(bytes)) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(origin + "/api" + u + "/parts/" + number, {
        method: "PUT", headers: { ...mutationHeaders(), "content-type": "application/octet-stream", "x-part-sha256": hash },
        body: bytes,
      });
      if (response.status !== 409 || (await response.clone().json()).code !== "upload_busy") return response;
      await response.arrayBuffer();
      await delay(200);
    }
    assert.fail("Upload did not become available");
  };
  await new Promise((done) => {
    const interrupted = httpRequest(origin + "/api" + u + "/parts/1", {
      method: "PUT", headers: { ...mutationHeaders(), "content-type": "application/octet-stream",
        "x-part-sha256": sha(chunks[0]), "content-length": chunks[0].length },
    });
    interrupted.once("error", done);
    interrupted.write(chunks[0].subarray(0, 2048), () => interrupted.destroy());
  });
  assert.deepEqual((await (await get(u)).json()).parts, []);
  await expectResponse(await put(1, chunks[0], "0".repeat(64)), 422);
  assert.deepEqual((await (await get(u)).json()).parts, []);

  for (const [i, chunk] of chunks.entries()) {
    const x = await put(i + 1, chunk);
    await expectResponse(x, 200);
    assert.deepEqual(await x.json(), { number: i + 1, offset: i * partSize, length: chunk.length, sha256: sha(chunk) });
  }
  await expectResponse(await put(1, chunks[0]), 200);
  await expectResponse(await put(1, Buffer.alloc(partSize)), 409);
  assert.equal((await (await get(u)).json()).confirmedBytes, pdf.length);

  const coords = { projectId: project, uploadId: upload.uploadId };
  const blobKey = `originals/${project}/${upload.uploadId}`;
  // The write reaches S3 while the application sees an interrupted response.
  const interruptedStore = { ...storage, objects: {
    ...storage.objects,
    async put(...args) {
      await storage.objects.put(...args);
      throw new Error("simulated lost S3 acknowledgement");
    },
  } };
  await assert.rejects(uploads.prepareOriginal(db, interruptedStore, coords), /simulated lost S3 acknowledgement/);
  assert.deepEqual(await storage.objects.head(blobKey), { size: pdf.length, sha256: sha(pdf) });
  const prepared = await uploads.prepareOriginal(db, interruptedStore, coords);
  assert.equal(prepared.objectKey, blobKey);
  await assert.rejects(transaction(db, async (tx) => {
    await uploads.publishPreparedOriginal(tx, coords, prepared);
    throw new Error("simulated abort before commit");
  }), /simulated abort/);
  const counts = await db.query("SELECT (SELECT count(*) FROM intake_originals) AS blobs, (SELECT count(*) FROM intake_reader_jobs) AS jobs");
  assert.deepEqual(counts.rows[0], { blobs: "0", jobs: "0" });
  // Reproduce an interruption before recording even the private confirmation.
  await db.query("UPDATE intake_uploads SET prepared_object_key=NULL, prepared_media_type=NULL WHERE id=$1", [upload.uploadId]);
  await app.close();
  await startApi();
  assert.equal((await (await get(u)).json()).parts.length, 2);

  const completionKey = randomUUID();
  async function complete(key) {
    for (let n = 0; n < 20; n++) {
      const response = await post(u + "/complete", {}, key);
      const result = await response.json();
      if (result.code === "upload_busy") { await delay(30); continue; }
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    }
    assert.fail("Concurrent finalize did not become available");
  }
  const [published, concurrent] = await Promise.all([complete(completionKey), complete(randomUUID())]);
  assert.deepEqual(published, concurrent);
  assert.deepEqual(await complete(completionKey), published);
  assert.equal((await db.query("SELECT count(*) FROM intake_reader_jobs")).rows[0].count, "1");
  const openInventory = await (await get(inventoryEndpoint)).json();
  assert.equal(openInventory.inventoryOpen, true);
  assert.equal(openInventory.occurrences[0].versionId, published.versionId);
  await postJson(`/receipts/${receipt.receiptId}/seal`);
  assert.equal((await (await get(inventoryEndpoint)).json()).inventoryOpen, false);

  const content = `/documents/${published.documentId}/versions/${published.versionId}/content`;
  const range = await get(content, { range: "bytes=4-29" });
  await expectResponse(range, 206);
  assert.equal(range.headers.get("content-range"), `bytes 4-29/${pdf.length}`);
  assert.equal(range.headers.get("cache-control"), "no-store");
  assert.equal(range.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(4, 30));
  const suffix = await get(content, { range: "bytes=-16" });
  await expectResponse(suffix, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), pdf.subarray(-16));
  const unsatisfiable = await get(content, { range: `bytes=${pdf.length}-` });
  await expectResponse(unsatisfiable, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${pdf.length}`);
  const whole = await get(content, { range: "bytes=0-3", "if-range": '"older-version"' });
  await expectResponse(whole, 200);
  assert.equal(sha(Buffer.from(await whole.arrayBuffer())), sha(pdf));
  const head = await fetch(origin + "/api" + content, { method: "HEAD", headers: cookies(owner) });
  await expectResponse(head, 200);
  assert.equal(head.headers.get("content-length"), String(pdf.length));
  const publicBlob = await fetch(`${process.env.FACADE_S3_ENDPOINT}/${process.env.FACADE_S3_BUCKET}/${blobKey}`);
  assert.ok([401, 403, 404].includes(publicBlob.status), "Bucket must reject unsigned reads");
  await publicBlob.arrayBuffer();

  const importCoords = { projectId: project, receiptId: importReceipt.receiptId, importId: secondImport.importId };
  await postJson(`/receipts/${importReceipt.receiptId}/seal`);
  await transaction(db, (tx) => receipts.updateImport(tx, { ...importCoords, status: "running" }));
  const supplement = await readFile(new URL("test/fixtures/input/facade-supplement.pdf", root));
  const declaration = {
    ...importCoords, uploadId: randomUUID(), relativePath: "досылка.pdf", sha256: sha(supplement),
    size: supplement.length, replacesVersionId: published.versionId,
  };
  const child = await transaction(db, (tx) => uploads.declareOriginal(tx, storage, declaration));
  assert.equal(child.holdId, null);
  assert.equal((await transaction(db, (tx) => uploads.declareOriginal(tx, storage, declaration))).uploadId, child.uploadId);
  const childCoords = { projectId: project, uploadId: child.uploadId };
  await uploads.writePart(db, storage, { ...childCoords, number: 1, length: supplement.length, sha256: sha(supplement) },
    Readable.from([supplement], { objectMode: false }));
  const newVersion = await uploads.finalizeOriginal(db, storage, childCoords);
  assert.equal(newVersion.documentId, published.documentId);
  assert.notEqual(newVersion.versionId, published.versionId);
  await transaction(db, (tx) => receipts.updateImport(tx, { ...importCoords, status: "completed" }));
  await assert.rejects(transaction(db, (tx) => receipts.cancelImport(tx, importCoords)), { code: "import_not_empty" });
  const historic = await get(content, { range: "bytes=4-29" });
  await expectResponse(historic, 206);
  assert.deepEqual(Buffer.from(await historic.arrayBuffer()), pdf.subarray(4, 30));

  await expectResponse(await get(content, { range: "bytes=0-3" }, outsider), 404);


  await t.test("batch manifest survives interruption, separates seal from inventory, and records exclusions", async () => {
    const receiptId = randomUUID();
    const projectReceipts = `/projects/${project}/receipts`;
    const base = `/receipts/${receiptId}`;
    const pdfItem = { ...data, scopeIds: undefined, kind: "file", itemId: randomUUID(), size: sourcePdf.length, sha256: sha(sourcePdf) };
    const zip = Buffer.from("504b0506" + "00".repeat(18), "hex");
    const archive = { kind: "file", itemId: randomUUID(), relativePath: "folder/source.zip", size: zip.length, sha256: sha(zip) };
    const link = { kind: "link", itemId: randomUUID(), url: "https://disk.yandex.ru/d/synthetic-expired-share" };
    const declaration = { receiptId, mode: "once", items: [pdfItem, archive, link] };
    const first = await post(projectReceipts, declaration, receiptId);
    await expectResponse(first, 201);
    await first.body.cancel(); // A lost creation response after the transaction.
    assert.equal((await postJson(projectReceipts, declaration, 201, receiptId)).receiptId, receiptId);

    const inventory = async (path = base) => (await get(path + "/inventory")).json();
    const itemUrl = (item, path = base) => path + "/manifest/" + item.itemId;
    const part = (file, bytes) => fetch(origin + "/api/uploads/" + file.uploadId + "/parts/1", {
      method: "PUT", headers: { ...mutationHeaders(), "content-type": "application/octet-stream", "x-part-sha256": sha(bytes) },
      body: bytes,
    });
    const publish = async (item, bytes) => {
      const upload = await postJson(itemUrl(item) + "/upload", {}, 201);
      const response = await part(upload, bytes);
      await expectResponse(response, 200);
      await response.json();
      return await postJson(`/uploads/${upload.uploadId}/complete`);
    };

    let view = await inventory();
    assert.equal(view.manifest.version, 1);
    assert.deepEqual(view.manifest.items.map(({ kind, status }) => [kind, status]),
      [["file", "declared"], ["archive", "declared"], ["link", "queued"]]);
    assert.equal(JSON.stringify(view).includes(link.url), false);
    await expectResponse(await get(base + "/inventory", {}, outsider), 404);
    await expectResponse(await post(base + "/uploads", pdfItem), 409);
    await expectResponse(await post(base + "/imports", { url: link.url }), 409);
    await expectResponse(await post(base + "/seal", { manifestVersion: 1 }), 409);

    const publishedPdf = await publish(pdfItem, sourcePdf);
    const archivePath = itemUrl(archive) + "/upload";
    const originalAttempt = await postJson(archivePath, {}, 201);
    const storedPart = await part(originalAttempt, zip);
    await expectResponse(storedPart, 200);
    await storedPart.body.cancel(); // Confirmed bytes recovered from GET.
    view = await inventory();
    assert.equal(view.sealed, false);
    assert.equal(view.manifest.items[1].confirmedBytes, zip.length);
    assert.equal(view.occurrences.find(item => item.versionId === publishedPdf.versionId).status, "accepted");

    await db.query("UPDATE intake_uploads SET expires_at=now()-interval '1 second' WHERE id=$1", [originalAttempt.uploadId]);
    view = await inventory();
    assert.equal(view.manifest.items[1].status, "expired");
    assert.equal(view.manifest.items[1].confirmedBytes, 0);
    const restartKey = randomUUID();
    const restart = { restartUploadId: originalAttempt.uploadId };
    const renewed = await postJson(archivePath, restart, 201, restartKey);
    assert.notEqual(renewed.uploadId, originalAttempt.uploadId);
    assert.equal((await postJson(archivePath, restart, 201, restartKey)).uploadId, renewed.uploadId);
    assert.equal((await postJson(archivePath, restart, 201)).uploadId, renewed.uploadId);
    await expectResponse(await post(`/uploads/${renewed.uploadId}/cancel`), 409);
    await expectResponse(await part(renewed, zip), 200);
    const archived = await postJson(`/uploads/${renewed.uploadId}/complete`);

    const importId = view.manifest.items[2].importId;
    const coords = { projectId: project, receiptId, importId };
    const failShare = () => transaction(db, async (tx) => {
      await receipts.updateImport(tx, { ...coords, status: "failed", reason: "remote_not_found" });
      await tx.query("UPDATE import_jobs SET status='failed',reason='remote_not_found' WHERE id=$1", [importId]);
    });
    await failShare();
    assert.equal((await inventory()).manifest.items[2].canRetry, true);
    assert.equal((await postJson(itemUrl(link) + "/retry", { importId })).status, "queued");
    await failShare();
    assert.equal((await inventory()).sealed, false);
    await expectResponse(await post(itemUrl(link) + "/exclude", { importId, manifestVersion: 1 }), 422);
    const exclusionKey = randomUUID();
    const exclusion = { importId, manifestVersion: 1, reason: "Истёк срок действия синтетической ссылки" };
    const response = await post(itemUrl(link) + "/exclude", exclusion, exclusionKey);
    await expectResponse(response, 200);
    await response.body.cancel(); // The automatic seal committed before the response was read.
    view = await inventory();
    assert.equal(view.sealed, true);
    assert.equal(view.inventoryOpen, true);
    assert.equal(view.manifest.items[2].status, "excluded");
    assert.equal(view.manifest.items[2].reason, exclusion.reason);
    assert.equal(view.occurrences.filter(item => item.status === "accepted").length, 2);
    assert.equal((await postJson(itemUrl(link) + "/exclude", exclusion, 200, exclusionKey)).sealed, true);
    assert.deepEqual(await postJson(base + "/seal", { manifestVersion: 1 }), { receiptId, sealed: true });
    const sealEvents = await db.query("SELECT count(*)::int AS count FROM intake_events WHERE receipt_id=$1 AND type='intake.receipt_sealed'", [receiptId]);
    assert.equal(sealEvents.rows[0].count, 1);
    await transaction(db, (tx) => receipts.completeOccurrenceInventory(tx, {
      projectId: project, receiptId, occurrenceId: archived.occurrenceId,
    }));
    assert.equal((await inventory()).inventoryOpen, false);

    const open = await postJson(projectReceipts, { mode: "open", items: [pdfItem] }, 201);
    const openPath = `/receipts/${open.receiptId}`;
    const start = await postJson(itemUrl(pdfItem, openPath) + "/upload", {}, 201);
    await expectResponse(await part(start, sourcePdf), 200);
    await postJson(`/uploads/${start.uploadId}/complete`);
    assert.equal((await inventory(openPath)).sealed, false);
    const append = { manifestVersion: 1, items: [archive] };
    const appendKey = randomUUID();
    assert.equal((await postJson(openPath + "/manifest", append, 200, appendKey)).manifestVersion, 2);
    assert.equal((await postJson(openPath + "/manifest", append, 200, appendKey)).manifestVersion, 2);
    await expectResponse(await post(openPath + "/seal", { manifestVersion: 1 }), 409);
    const dropped = { manifestVersion: 2, reason: "Проверка исключения входа до передачи" };
    await postJson(itemUrl(archive, openPath) + "/exclude", dropped);
    assert.equal((await inventory(openPath)).sealed, false);
    assert.equal((await postJson(openPath + "/seal", { manifestVersion: 2 })).sealed, true);
    assert.equal((await inventory(openPath)).inventoryOpen, false);

    const source = await postJson(projectReceipts, { mode: "once", items: [link] }, 201);
    const sourcePath = `/receipts/${source.receiptId}`;
    const remoteId = (await inventory(sourcePath)).manifest.items[0].importId;
    const sourceCoords = { projectId: project, receiptId: source.receiptId, importId: remoteId };
    await transaction(db, async (tx) => {
      await receipts.updateImport(tx, { ...sourceCoords, status: "running" });
      await receipts.updateImport(tx, { ...sourceCoords, status: "completed" });
    });
    const remote = await inventory(sourcePath);
    assert.equal(remote.sealed, true);
    assert.equal(remote.manifest.items[0].status, "accepted");
  });

  await db.query("DELETE FROM project_memberships WHERE user_id=$1 AND project_id=$2", [owner.id, project]);
  await expectResponse(await get(content, { range: "bytes=0-3" }), 404);
  await expectResponse(await post(u + "/complete", {}, completionKey), 404);
});
