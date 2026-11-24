import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import Fastify from "fastify";
import pg from "pg";
import { verifyManagedLauncherTargets } from "../../../../test/fixtures/managed-worker-support.mjs";

const dist = process.env.FACADE_STEP11_DIST ?? resolve("dist");
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = (name) => import(pathToFileURL(join(dist, "src/modules", name)));

test("same reader API and harness port reopen historical mixed-format observations", {
  skip: process.env.FACADE_STEP11_STAND !== "1",
  timeout: 240_000,
}, async (t) => {
  const { DATABASE_URL: databaseUrl, FACADE_DATA_DIR: dataDir } = process.env;
  assert.ok(databaseUrl && dataDir, "use a fresh step11 stand database");
  const dwgWorker = process.env.FACADE_STEP11_WORKER_DWG === "1";
  if (dwgWorker) await verifyManagedLauncherTargets({
    loadBoundary: () => import(pathToFileURL(join(dist, "src/platform/runtime-boundary.js"))),
  });
  const { bootstrapAdmin } = await load("access/bootstrap.js");
  const { register: access } = await load("access/index.js");
  const { register: intake } = await load("intake/index.js");
  const { register: pdf, createRuntimePdfService } = await load("pdf/index.js");
  const { connectReader } = await load("harness/reader.js");
  const db = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  const webOrigin = "http://127.0.0.1:18081";
  process.env.FACADE_PUBLIC_ORIGIN = webOrigin;
  const config = { databaseUrl, dataDir, host: "127.0.0.1", port: 18081 };
  async function application() {
    const app = Fastify();
    app.decorate("db", db);
    app.decorate("config", config);
    app.addHook("onRequest", async (_, reply) => { reply.header("cache-control", "no-store"); });
    app.setErrorHandler((error, _, reply) => reply.code(error.statusCode ?? 500)
      .send({ code: error.code ?? "unexpected_error" }));
    await access(app);
    app.register(intake);
    app.register(pdf);
    await app.ready();
    return app;
  }
  let app = await application();
  t.after(() => app.close());

  const login = "step11-owner";
  const password = randomUUID() + randomUUID();
  await bootstrapAdmin(db, { organization: "Step 11 synthetic", login, password });
  const session = await app.inject({ method: "POST", url: "/api/sessions",
    headers: { origin: webOrigin }, payload: { login, password } });
  assert.equal(session.statusCode, 200, `owner login: ${session.json().code ?? ""}`);
  const headers = { cookie: session.headers["set-cookie"].split(";")[0],
    origin: webOrigin, "x-csrf-token": session.json().csrfToken };
  async function post(url, payload) {
    const reply = await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": randomUUID() }, payload });
    assert.ok(reply.statusCode >= 200 && reply.statusCode < 300, `${url}: ${reply.statusCode} ${reply.json().code ?? ""}`);
    return reply.json();
  }
  const requirements = dwgWorker ? [{
    key: "dwg-schedule", part: "Panel schedule", formats: ["dwg"], equivalents: [],
    applicability: "all", sourceRoles: ["design"], completenessCriterion: "Addressed assembly", addressee: "customer",
  }] : [];
  const catalog = await post("/api/catalogs", { key: "step11", name: "Synthetic", requirements });
  const project = await post("/api/projects", {
    name: dwgWorker ? "Step 11 synthetic drawing" : "Step 11 synthetic mixed package",
    catalogVersionId: catalog.id, stage: "detail", scopeName: "Wing M",
  });
  const [scope] = project.scopes;
  assert.ok(scope?.id);
  const receipt = await post(`/api/projects/${project.id}/receipts`, { source: "upload" });

  async function upload(name, mediaType = "application/octet-stream") {
    const bytes = await readFile(join(fixtures, name));
    const hash = sha256(bytes);
    const declaration = await post(`/api/receipts/${receipt.receiptId}/uploads`, {
      relativePath: name, size: bytes.length, sha256: hash, mediaType, scopeIds: [scope.id],
    });
    const path = `/api/uploads/${declaration.uploadId}`;
    const reply = await app.inject({ method: "PUT", url: `${path}/parts/1`, payload: bytes,
      headers: { ...headers, "content-type": "application/octet-stream",
        "content-length": bytes.length, "x-part-sha256": hash } });
    assert.equal(reply.statusCode, 200, `part upload: ${reply.body}`);
    const version = await post(path + "/complete", {});
    return { projectId: project.id, documentId: version.documentId, versionId: version.versionId, sha256: hash, bytes };
  }

  if (dwgWorker) {
    const { verifyOrdinaryDwg } = await import("./dwg-worker.mjs");
    await verifyOrdinaryDwg({ db, config, load, projectId: project.id, scopeId: scope.id, upload,
      seal: () => post(`/api/receipts/${receipt.receiptId}/seal`, {}),
      evidence: (id) => app.inject({ method: "GET", url: `/api/v1/evidence/${id}/content`, headers }),
    });
    return;
  }

  const uploaded = [
    ["schedule.docx", undefined, { table: 1, row: 2, column: 3 }, "2.40 mm"],
    ["schedule.xlsx", undefined, { cell: "B3" }, "2.400000000000003"],
    ["notes.txt", "text/plain", { line: 2 }, "AX-17 rev B — 2.40 мм"],
    ["schedule.dxf", undefined, { space: "Model", handle: "32" }, "AX-17 rev B | 2 x 35 mm | 70 mm"],
    ["structure.ifc", undefined, { step: "#42" }, "AX-17 rev B; Wing M"],
    ["presence-only.rvt", undefined, {}, null],
    ["presence-only.xyz", undefined, {}, null],
    ["unreadable.docx", undefined, {}, null],
  ];
  const inputs = [];
  for (const [name, mediaType, locator, quote] of uploaded) {
    inputs.push({ source: await upload(name, mediaType), locator, quote, name });
  }
  await post(`/api/receipts/${receipt.receiptId}/seal`, {});
  const service = createRuntimePdfService(db, config);
  t.after(() => service.close());
  const published = [];
  const port = connectReader(db, service, async (_tx, _context, _input, observation) => { published.push(observation); });
  const checks = [];

  for (const { source, locator, quote, name } of inputs) {
    const map = await service.map(source);
    const entry = map.units.find((unit) => locator.table ? unit.locator.table === locator.table : true);
    const runId = randomUUID();
    const context = { task: { jobId: runId, projectId: source.projectId, scopeId: scope.id,
      generationId: randomUUID(), job: { mode: "primary", branch: "A",
        place: { source, unitId: entry.id }, settings: {} } }, branch: "A", effectKey: "branch-A" };
    const inventory = await port.inventory(context);
    assert.ok(inventory.units.some((unit) => unit.id === entry.id), name);
    const view = await port.read(context, { kind: "extract" });
    assert.equal(sha256(view.bytes), view.sha256);
    const contents = JSON.parse(view.bytes);
    assert.ok(quote ? contents.lines.some((line) => line.text.includes(quote)) : contents.lines.length === 0, name);
    if (quote) {
      const tx = await db.connect();
      try {
        await tx.query("BEGIN");
        const recorded = await port.record(tx, { ...context, effectKey: "record-A" }, {
          evidence: view, quote, value: quote,
        });
        await tx.query("COMMIT");
        assert.equal(published.at(-1).id, recorded.observationId);
        assert.equal(published.at(-1).evidenceId, view.evidenceId);
        assert.equal(published.at(-1).branch, "A");
        for (const [key, value] of Object.entries(locator)) assert.equal(published.at(-1).address.locator[key], value);
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally {
        tx.release();
      }
    } else assert.ok(view.limitations.length > 0, name);

    const readScope = { runId, branch: "B", operationKey: "exact-B" };
    const output = await service.open(source, readScope, { address: { unitId: entry.id, locator }, representation: "native" });
    const exact = JSON.parse(output.bytes);
    assert.equal(output.evidence.source.sha256, source.sha256);
    assert.equal(output.evidence.address.unitId, entry.id);
    assert.equal(exact.coverage, entry.locator.coverage);
    if (quote) {
      const line = exact.lines.find((row) => row.text.includes(quote));
      assert.ok(line, name);
      const saved = await service.pin(source, { ...readScope, operationKey: "save-B" }, {
        evidenceId: output.evidence.id, scope: scope.id, lineId: line.id, quote, value: quote,
      });
      assert.equal(saved.grounding, "text");
      assert.equal(saved.branch, "B");
      const observation = await app.inject({ method: "GET", url: `/api/v1/observations/${saved.id}`, headers });
      assert.equal(observation.statusCode, 200);
      for (const [key, value] of Object.entries(locator)) assert.equal(observation.json().address.locator[key], value);
      await assert.rejects(service.pin(source, { ...readScope, branch: "A", operationKey: "wrong-branch" }, {
        evidenceId: output.evidence.id, scope: scope.id, quote, value: quote,
      }), { code: "reader_evidence_scope_mismatch" });
    }
    const unitsUrl = `/api/v1/documents/${source.documentId}/versions/${source.versionId}/reader/units`;
    const unitsReply = await app.inject({ method: "GET", url: unitsUrl, headers });
    assert.equal(unitsReply.statusCode, 200);
    assert.equal(unitsReply.json().source.versionId, source.versionId);
    const href = `/api/v1/evidence/${output.evidence.id}/content`;
    assert.equal((await app.inject({ method: "GET", url: href })).statusCode, 401);
    checks.push({ name, href, digest: output.evidence.sha256 });
  }

  await app.close();
  app = await application();
  for (const { name, href, digest } of checks) {
    const reply = await app.inject({ method: "GET", url: href, headers });
    assert.equal(reply.statusCode, 200, name);
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(sha256(reply.rawPayload), digest, name);
  }

  if (process.env.FACADE_STEP11_CHROME === "1") {
    const { chromium } = await import(new URL("../../../../web/node_modules/playwright/index.mjs", import.meta.url));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const browserContext = await browser.newContext();
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      await browserContext.addCookies([{ name: "facade_session", value: headers.cookie.split("=")[1],
        url: origin, httpOnly: true, sameSite: "Lax" }]);
      const page = await browserContext.newPage();
      const check = checks.find(({ name }) => name === "schedule.xlsx");
      await page.goto(origin + check.href);
      const displayed = await page.locator("body").innerText();
      assert.match(displayed, /2\.400000000000003/);
      assert.match(displayed, /"cell"\s*:\s*"B3"/);
    } finally {
      await browser.close();
    }
  }
});
