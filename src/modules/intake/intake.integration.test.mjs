import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  const [{ register, createIntakeStorage }, uploads, gate, receipts, { csrfToken }, { transaction }] = await Promise.all([
    compiled("src/modules/intake/index.js"),
    compiled("src/modules/intake/uploads.js"),
    compiled("src/modules/intake/gate.js"),
    compiled("src/modules/intake/receipts.js"),
    compiled("src/modules/access/auth.js"),
    compiled("src/modules/access/commands.js"),
  ]);
  const db = new pg.Pool({ connectionString });
  const storage = createIntakeStorage(process.env.FACADE_DATA_DIR);
  t.after(async () => { storage.objects.close(); await db.end(); });
  for (const file of ["02_access_schema.sql", "03_intake_schema.sql", "03_intake_z_prepare.sql", "10_imports_schema.sql"]) {
    await db.query(await readFile(new URL(`db/migrations/${file}`, root), "utf8"));
  }
  const { project, scopeA, scopeB, owner, outsider } = await fixture(db);
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
  await db.query("UPDATE intake_uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.uploadId]);
  await uploads.cleanIntakeUploads(db, storage);
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
  const prepared = await uploads.prepareOriginal(db, storage, coords);
  const blobKey = `originals/${project}/${upload.uploadId}`;
  assert.deepEqual(await storage.objects.head(blobKey), { size: pdf.length, sha256: sha(pdf) });
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
  await db.query("DELETE FROM project_memberships WHERE user_id=$1 AND project_id=$2", [owner.id, project]);
  await expectResponse(await get(content, { range: "bytes=0-3" }), 404);
  await expectResponse(await post(u + "/complete", {}, completionKey), 404);
});
