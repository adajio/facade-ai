import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { verifyManagedLauncherTargets } from "../../../../../test/fixtures/managed-worker-support.mjs";
import { verifyOrdinaryDwg } from "../dwg-worker.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = (name) => import(new URL(`../../../../../dist/src/modules/${name}`, import.meta.url));
const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const image = "sha256:561a1a324440a155a295fd1aa7cab1719fdb9ebaf00b7261f591b22e8843b557";
const scheduleHash = "f2c9e2d20e11451d6fcb4bbcde16dc7d726358a4a7273cccda660c5ce86944be";
const scheduleDxfHash = "2b925bb26c32b15237eebac4612e54efe0bacd091d79fc3b2346cb3dbafac47f";

function cleanupServer(t, server) {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
}

async function storageFixture(t) {
  const objects = new Map();
  const server = createServer(async (request, reply) => {
    const target = new URL(request.url, "http://127.0.0.1").pathname;
    if (!target.startsWith("/dwg-fixture/")) return reply.writeHead(404).end();
    if (request.method === "PUT") {
      const bytes = Buffer.concat(await Array.fromAsync(request));
      const hash = sha256(bytes);
      if (request.headers["x-amz-meta-sha256"] !== hash) return reply.writeHead(400).end();
      if (objects.has(target)) return reply.writeHead(412).end();
      objects.set(target, { bytes, hash });
      return reply.writeHead(200, { etag: '"dwg-fixture"' }).end();
    }
    const object = objects.get(target);
    if (!object) return reply.writeHead(404).end();
    if (!["GET", "HEAD"].includes(request.method)) return reply.writeHead(405).end();
    reply.writeHead(200, { "content-length": object.bytes.length, "x-amz-meta-sha256": object.hash })
      .end(request.method === "HEAD" ? undefined : object.bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanupServer(t, server);
  Object.assign(process.env, {
    FACADE_S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`, FACADE_S3_BUCKET: "dwg-fixture",
    AWS_ACCESS_KEY_ID: "synthetic", AWS_SECRET_ACCESS_KEY: "synthetic", AWS_EC2_METADATA_DISABLED: "true",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED", FACADE_INTAKE_DISK_GUARD_BYTES: "0",
  });
}

async function converterFixture(t, path) {
  const derivative = await readFile(path);
  assert.equal(sha256(derivative), scheduleDxfHash);
  const root = await mkdtemp(join(tmpdir(), "dwg-card-"));
  const socket = join(root, "conv.sock");
  const server = createServer((request, reply) => {
    if (request.url !== "/v1/info") return reply.writeHead(400).end();
    reply.end(JSON.stringify({ dwg: image }));
  });
  server.on("checkContinue", async (request, reply) => {
    assert.equal(request.url, "/v1/dwg");
    assert.equal(request.headers["x-converter-image"], image);
    reply.writeContinue();
    const bytes = Buffer.concat(await Array.fromAsync(request));
    assert.equal(sha256(bytes), scheduleHash);
    reply.writeHead(200, { Trailer: "X-Converter-Result" });
    reply.write(derivative);
    reply.addTrailers({ "X-Converter-Result": "ok" });
    reply.end();
  });
  server.listen(socket);
  await once(server, "listening");
  cleanupServer(t, server);
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.FACADE_CONVERTER_SOCKET = socket;
}

test("DWG synthetic HTTP upload, worker, engineer card, original and invalid DWG hold", {
  skip: process.env.FACADE_DWG_CARD !== "1", timeout: 240_000,
}, async (t) => {
  await verifyManagedLauncherTargets();
  assert.ok(!process.env.FACADE_GATEWAY_LIVE_MODE && !process.env.FACADE_GATEWAY_OPENROUTER_KEY
    && !process.env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY);
  const { createApi } = await load("../platform/api.js");
  const { readConfig } = await load("../platform/config.js");
  const { bootstrapAdmin } = await load("access/bootstrap.js");
  const { createRuntimePdfService } = await load("pdf/index.js");
  const dir = resolve(process.env.FACADE_DWG_CARD_OUTPUT);
  const config = readConfig();
  assert.equal(config.host, "127.0.0.1");
  const origin = `http://127.0.0.1:${config.port}`;
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  await storageFixture(t);
  if (process.env.FACADE_DWG_REFERENCE_DXF) await converterFixture(t, process.env.FACADE_DWG_REFERENCE_DXF);
  const app = await createApi(config);
  t.after(() => app.close());
  await app.listen({ host: config.host, port: config.port });

  const httpLog = [];
  t.after(() => writeFile(join(dir, "http.json"), JSON.stringify(httpLog, null, 2) + "\n"));
  async function http(method, path, { payload, headers = {}, session = {} } = {}) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000),
      headers: { origin, "idempotency-key": randomUUID(), ...session,
        ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: Buffer.isBuffer(payload) || payload === undefined ? payload : JSON.stringify(payload) });
    const bytes = Buffer.from(await response.arrayBuffer());
    httpLog.push({ method, path, status: response.status });
    const json = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(bytes) : undefined;
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${json?.code ?? ""}`);
    return { response, bytes, json };
  }

  const loginSuffix = randomUUID().slice(0, 8);
  const ownerLogin = "d4owner_" + loginSuffix;
  const engineerLogin = "d4engineer_" + loginSuffix;
  const ownerPassword = randomUUID() + "-synthetic";
  const engineerPassword = randomUUID() + "-synthetic";
  await bootstrapAdmin(app.db, { organization: "DWG synthetic browser", login: ownerLogin, password: ownerPassword });
  async function session(login, password) {
    const { response, json } = await http("POST", "/api/sessions", { payload: { login, password } });
    return { cookie: response.headers.get("set-cookie").split(";")[0], "x-csrf-token": json.csrfToken };
  }
  const owner = await session(ownerLogin, ownerPassword);
  const command = (method, path, payload, options = {}) => http(method, path, { session: owner, payload, ...options });
  const { json: invitation } = await command("POST", "/api/users/invitations", { login: engineerLogin });
  await http("POST", "/api/invitations/complete", { payload: { token: invitation.token, password: engineerPassword } });
  const { json: catalog } = await command("POST", "/api/catalogs", {
    key: "dwg-" + loginSuffix, name: "DWG synthetic", requirements: [{ key: "dwg-schedule", part: "Panel schedule",
      formats: ["dwg"], equivalents: [], applicability: "all", sourceRoles: ["design"],
      completenessCriterion: "Addressed assembly", addressee: "customer" }],
  });
  const { json: project } = await command("POST", "/api/projects", {
    name: "DWG synthetic browser", catalogVersionId: catalog.id, stage: "detail", scopeName: "Wing M",
  });
  const projectPath = `/api/projects/${project.id}`;
  const scopeId = project.scopes[0].id;
  const { json: projectVersion } = await command("GET", projectPath);
  await command("PUT", projectPath + "/members/" + invitation.userId, { role: "engineer" }, {
    headers: { "if-match": `"${projectVersion.version}"` },
  });
  const engineer = await session(engineerLogin, engineerPassword);
  async function newReceipt() {
    const { json } = await command("POST", projectPath + "/receipts", { source: "upload" });
    return `/api/receipts/${json.receiptId}`;
  }
  async function upload(receipt, name) {
    const bytes = await readFile(fixture(name));
    const hash = sha256(bytes);
    const { json: upload } = await command("POST", receipt + "/uploads", {
      relativePath: name, size: bytes.length, sha256: hash, mediaType: "application/octet-stream", scopeIds: [scopeId],
    });
    const path = `/api/uploads/${upload.uploadId}`;
    await command("PUT", path + "/parts/1", bytes, { headers: {
      "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-part-sha256": hash,
    } });
    const { json: source } = await command("POST", path + "/complete", {});
    return { projectId: project.id, documentId: source.documentId, versionId: source.versionId, sha256: hash };
  }
  const receipt = await newReceipt();
  const { source, observations } = await verifyOrdinaryDwg({
    db: app.db, config, load, projectId: project.id, scopeId, expectedOutcome: "needs_review", reviewControl: true,
    upload: (name) => upload(receipt, name),
    seal: () => command("POST", receipt + "/seal", {}),
    evidence: async (id) => ({ body: (await http("GET", `/api/v1/evidence/${id}/content`, { session: engineer })).bytes.toString() }),
  });

  async function readerMap(item) {
    return (await http("GET", `/api/v1/documents/${item.documentId}/versions/${item.versionId}/reader/units`, {
      session: engineer,
    })).json;
  }
  const positiveMap = await readerMap(source);
  assert.equal(positiveMap.source.sha256, scheduleHash);
  assert.deepEqual(positiveMap.units.map((unit) => unit.label), ["Model", "Paper"]);
  const assessmentUrl = `/api/v1/projects/${project.id}/assessments/current?scopeId=${scopeId}`;
  const { json: snapshot } = await http("GET", assessmentUrl, { session: engineer });
  const cardinality = snapshot.questions.find(({ requirement }) => requirement.part === "Panel schedule");
  assert.equal(cardinality.machine.outcome, "needs_review");
  assert.ok(cardinality.machine.limitations.includes("review_incomplete"));
  assert.equal(cardinality.machine.citations.length, 2);
  const { rows: [reviewControl] } = await app.db.query(
    `SELECT count(*) FILTER (WHERE purpose='review')::int AS "reviewJobs",
      count(*) FILTER (WHERE purpose IN ('primary_a','primary_b') AND state='done')::int AS "completedPrimary"
      FROM gateway_jobs WHERE project_id=$1`, [project.id],
  );
  assert.equal(reviewControl.completedPrimary, 4);
  assert.equal(reviewControl.reviewJobs, 0);
  assert.equal(new Set(observations.map(({ source }) => source.versionId)).size, 1);
  assert.equal(new Set(observations.map(({ value }) => value)).size, 1);

  const { chromium } = await import(new URL("../../../../../web/node_modules/playwright/index.mjs", import.meta.url));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const [cookieName, cookieValue] = engineer.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true }]);
  const page = await context.newPage();
  await page.goto(`${origin}/projects/${project.id}/completeness?scope=${scopeId}`);
  await page.getByRole("button", { name: /Panel schedule/ }).click();
  const card = page.locator("section").filter({ has: page.locator("#assessment-row") });
  await card.getByRole("button", { name: /Основание|schedule\.dwg/ }).first().click();
  const evidence = page.getByRole("region", { name: "Оригинал и основание" });
  await evidence.getByText("AX-17 rev B | 2 x 35 mm | 70 mm", { exact: true }).waitFor();
  await evidence.getByText("2E", { exact: true }).waitFor();
  await evidence.getByText(source.versionId, { exact: true }).waitFor();
  const original = evidence.getByRole("link", { name: "Открыть оригинал", exact: true });
  await original.waitFor();
  const originalPath = await original.getAttribute("href");
  const bytes = (await http("GET", originalPath, { session: engineer })).bytes;
  assert.equal(sha256(bytes), source.sha256);
  await page.screenshot({ path: join(dir, "dwg-card.png") });

  const invalidReceipt = await newReceipt();
  const invalid = await upload(invalidReceipt, "unreadable.dwg");
  await command("POST", invalidReceipt + "/seal", {});
  const reader = createRuntimePdfService(app.db, config);
  try { await reader.map(invalid); } finally { await reader.close(); }
  const invalidMap = await readerMap(invalid);
  assert.equal(invalidMap.source.sha256, invalid.sha256);
  assert.equal(invalidMap.units[0].locator.coverage, "held");
  assert.ok(JSON.stringify(invalidMap).includes("dwg_signature_invalid"));
  const invalidPath = `/api/documents/${invalid.documentId}/versions/${invalid.versionId}/content`;
  assert.equal(sha256((await http("GET", invalidPath, { session: engineer })).bytes), invalid.sha256);
  await page.goto(`${origin}/projects/${project.id}/receipts/${invalidReceipt.split("/").at(-1)}?scope=${scopeId}&document=${invalid.versionId}`);
  await page.getByRole("link", { name: "Скачать оригинал" }).waitFor();
  await page.locator(".unit-list").getByText(/dwg.signature.invalid|сигнатур/i).waitFor();
  await page.screenshot({ path: join(dir, "dwg-held.png") });
  for (const observation of observations) {
    const reply = await http("GET", `/api/v1/evidence/${observation.evidenceId}/content`, { session: engineer });
    assert.ok(reply.bytes.includes(Buffer.from("AX-17 rev B | 2 x 35 mm | 70 mm")));
  }
  const eligible = (await http("GET", `${projectPath}/letters/eligible?scopeId=${scopeId}`, { session: engineer })).json;
  assert.deepEqual(eligible.items, []);
  const summary = {
    converterImage: image, derivative: process.env.FACADE_DWG_REFERENCE_DXF ? "recorded-linux-dxf" : "live-broker",
    source, positiveMap, card: cardinality, observations, reviewControl, invalid, invalidMap,
    originalSha256: sha256(bytes), eligibleLetterItems: eligible.items.length,
  };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
});
