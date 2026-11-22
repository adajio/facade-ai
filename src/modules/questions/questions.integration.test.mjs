import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const build = process.env.FACADE_TEST_BUILD ?? "dist";
const fromBuild = (path) => import(pathToFileURL(resolve(build, `src/${path}.js`)).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Real reader input, generated per address so byte deduplication cannot masquerade as an independent original.
function pdf(line) {
  const body = `BT /F1 18 Tf 30 165 Td (${line}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${body.length} >>\nstream\n${body}endstream`,
  ];
  let file = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = file.length;
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = file.length;
  file += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) file += `${String(offset).padStart(10, "0")} 00000 n \n`;
  file += `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file);
}

test("addressed publication, two facades, opened pair and empty inquiry", {
  skip: !process.env.DATABASE_URL || !process.env.FACADE_S3_ENDPOINT,
}, async () => {
  const { createApi } = await fromBuild("platform/api");
  const { readConfig } = await fromBuild("platform/config");
  const { passwordHash } = await fromBuild("modules/access/auth");
  const { transaction } = await fromBuild("modules/access/commands");
  const { createIntakeStorage } = await fromBuild("modules/intake/blob");
  const { createRuntimePdfService } = await fromBuild("modules/pdf/index");
  const { lockScopes } = await fromBuild("modules/supplements/index");
  const {
    createRuntimeInquiryPorts, processNextInquiry, publishReaderObservation,
  } = await fromBuild("modules/questions/index");

  const config = readConfig();
  const app = await createApi(config);
  app.db.options.connectionTimeoutMillis = 30_000;
  const storage = createIntakeStorage(config.dataDir);
  const reader = createRuntimePdfService(app.db, config, { storage });
  const ports = createRuntimeInquiryPorts(app.db, reader, storage.objects);
  const signal = new AbortController().signal;
  try {
    const login = `qa-step12-${randomUUID()}@example.invalid`;
    const password = `synthetic-${randomUUID()}`;
    const { rows: [{ id: organizationId }] } = await app.db.query(
      "INSERT INTO organizations(name) VALUES('Step 12 synthetic') RETURNING id",
    );
    const { rows: [{ id: userId }] } = await app.db.query(
      "INSERT INTO users(organization_id,login,password_hash,state) VALUES($1,$2,$3,'active') RETURNING id",
      [organizationId, login, await passwordHash(password)],
    );
    const requires = [{
      key: "D1_thickness", part: "D1 thickness", applicability: "all", formats: ["pdf"],
      equivalents: [], sourceRoles: ["design", "schedule"], completenessCriterion: "addressed overlap",
      addressee: "Synthetic design",
    }];
    const { rows: [{ id: catalogVersionId }] } = await app.db.query(
      `INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by)
       VALUES($1,'step12',1,'Step 12',$2,$3) RETURNING id`,
      [organizationId, JSON.stringify(requires), userId],
    );
    const { rows: [{ id: projectId }] } = await app.db.query(
      "INSERT INTO projects(organization_id,name,catalog_version_id) VALUES($1,'Two facades',$2) RETURNING id",
      [organizationId, catalogVersionId],
    );
    await app.db.query(
      "INSERT INTO project_memberships(project_id,organization_id,user_id,role) VALUES($1,$2,$3,'project_manager')",
      [projectId, organizationId, userId],
    );
    const { rows: [north, south] } = await app.db.query(
      `INSERT INTO project_scopes(project_id,stage,name) VALUES ($1,'design','North'),($1,'design','South')
       RETURNING id,name`, [projectId],
    );
    const session = await app.inject({
      method: "POST", url: "/api/sessions", headers: { host: "127.0.0.1", origin: "http://127.0.0.1" },
      payload: { login, password },
    });
    assert.equal(session.statusCode, 200);
    const auth = {
      cookie: session.headers["set-cookie"].split(";")[0], host: "127.0.0.1", origin: "http://127.0.0.1",
      "x-csrf-token": session.json().csrfToken,
    };
    async function request(method, url, payload, expected = 200, extra = {}) {
      const response = await app.inject({
        method, url, payload, headers: { ...auth, "Idempotency-Key": randomUUID(), ...extra },
      });
      assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body.slice(0, 350)}`);
      return response;
    }
    const json = async (...args) => (await request(...args)).json();
    const project = `/api/projects/${projectId}`;
    const list = (scopeId) => json("GET", `${project}/inquiries?scopeId=${scopeId}`);
    const assessment = (scopeId) => json("GET", `${project}/assessments/current?scopeId=${scopeId}`);
    const detail = (id, version) => json("GET", `/api/inquiries/${id}${version ? `?searchVersion=${version}` : ""}`);
    const drain = async () => {
      for (let index = 0; index < 30; index++) {
        if (!await processNextInquiry(app.db, ports, signal)) break;
      }
      const pending = await app.db.query(
        "SELECT 1 FROM inquiry_jobs j JOIN inquiries i ON i.id=j.inquiry_id WHERE i.project_id=$1", [projectId],
      );
      assert.equal(pending.rowCount, 0, "search worker drained jobs");
    };

    async function upload(scopeId, filename, line, replacesVersionId) {
      const bytes = pdf(line);
      const digest = sha256(bytes);
      const { receiptId } = await json("POST", `${project}/receipts`, {}, 201);
      const declaration = await json("POST", `/api/receipts/${receiptId}/uploads`, {
        relativePath: filename, mediaType: "application/pdf", size: bytes.length, sha256: digest,
        scopeIds: [scopeId], replacesVersionId,
      }, 201);
      const uploadPath = `/api/uploads/${declaration.uploadId}`;
      await request("PUT", `${uploadPath}/parts/1`, bytes, 200, {
        "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), "X-Part-SHA256": digest,
      });
      const published = await json("POST", `${uploadPath}/complete`, {}, 200);
      await json("POST", `/api/receipts/${receiptId}/seal`, {});
      return { ...published, receiptId, scopeId, sha256: digest, quote: line, replacesVersionId };
    }

    async function observe(input, { subject = "D1", aliases, variant, value, unit = "mm",
      branch = "A", role = "design", priority = "peer", revision = "effective", assessmentQuestionId } = {}) {
      const source = { projectId, documentId: input.documentId, versionId: input.versionId, sha256: input.sha256 };
      const read = { runId: randomUUID(), branch, operationKey: "native" };
      const { evidence } = await reader.open(source, read, { representation: "native", address: { unitId: "1" } });
      return transaction(app.db, async (tx) => {
        await lockScopes(tx, projectId, [input.scopeId]);
        const observation = await reader.pin(source, { ...read, operationKey: "pin" }, {
          evidenceId: evidence.id, scope: input.scopeId, quote: input.quote, value, unit,
        }, tx);
        const event = {
          observation, projectId, scopeId: input.scopeId, readerJobId: input.jobId,
          subject, aliases, property: "thickness", variant, role, priority, revision,
          comparableContext: "D1/rainscreen/thickness", assessmentQuestionId, replacesConfirmed: !!input.replacesVersionId,
        };
        await publishReaderObservation(tx, event);
        await publishReaderObservation(tx, event);
        return observation;
      });
    }

    const qNorth = (await assessment(north.id)).questions[0];
    assert.ok(qNorth);
    const left = await upload(north.id, "north-design.pdf", "D1 project thickness 1.5 mm");
    const right = await upload(north.id, "north-schedule.pdf", "Panel-A schedule thickness 0.0018 m");
    const other = await upload(south.id, "south-design.pdf", "D1 South thickness 9.0 mm");
    const variant = await upload(north.id, "north-variant.pdf", "D1 alternate thickness 7.0 mm");
    const unknown = await upload(north.id, "north-unknown.pdf", "D1 unclassified thickness 1.6 mm");
    const a = await observe(left, { value: "1.5", assessmentQuestionId: qNorth.id });
    const b = await observe(right, {
      subject: "Panel-A", aliases: ["D1"], value: "0.0018", unit: "m", branch: "B", role: "schedule",
      assessmentQuestionId: qNorth.id,
    });
    await observe(other, { value: "9.0" });
    await observe(variant, { value: "7.0", variant: "alternate" });
    await observe(unknown, { value: "1.6", priority: null, revision: "unknown" });
    assert.ok((await list(north.id)).inquiries.some(({ state }) => state === "queued"));
    await drain();

    const northInquiries = await list(north.id);
    const main = northInquiries.inquiries.find(({ subject, variant: variantName }) => !variantName && subject === "D1");
    assert.ok(main);
    assert.equal(northInquiries.inquiries.length, 2, "replays and alias deliveries create no extra inquiry");
    const current = await detail(main.id);
    assert.equal(current.pairs.length, 1);
    assert.equal(current.pairs[0].comparison, "conflict");
    assert.equal(current.candidates.find(({ source }) => source.observationId === b.id).reason, "registered_alias");
    assert.ok(current.candidates.some(({ applicability }) => applicability === "variant_mismatch"));
    assert.ok(current.candidates.some(({ applicability }) => applicability === "revision_unknown"));
    assert.equal(current.candidates.some(({ source }) => source.scopeId === south.id), false);
    assert.ok(current.limitations.includes("revision_unknown"));
    for (const support of [current.pairs[0].left, current.pairs[0].right]) {
      const evidence = await json("GET", support.evidenceHref);
      assert.equal(evidence.source.sha256, support.sha256);
      const bytes = await request("GET", support.contentHref);
      assert.equal(bytes.headers["cache-control"], "no-store");
      assert.equal(sha256(bytes.rawPayload), evidence.sha256);
      const original = await request("GET", support.originalHref);
      assert.equal(sha256(original.rawPayload), support.sha256);
    }

    const absent = await json("POST", `${project}/inquiries`, {
      scopeId: south.id, sliceId: (await list(south.id)).sliceId, catalogVersionId,
      subject: "Missing detail", property: "missing material",
    }, 201);
    await drain();
    const empty = await detail(absent.id);
    assert.equal(empty.state, "empty");
    assert.deepEqual(empty.candidates, []);
    const denied = await json("POST", `${project}/letters`, {
      scopeId: south.id, recipient: "Synthetic design", items: [],
    }, 422);
    assert.equal(denied.code, "no_eligible_items");

    const inquiryDecision = { action: "correct", reason: "Checked both source rows", answer: "Conflict", candidateIds: [a.id, b.id] };
    const decide = (inquiry, expected, body = inquiryDecision) => json(
      "POST", `/api/inquiries/${inquiry.id}/decisions`, body, expected, { "If-Match": `"${inquiry.version}"` },
    );
    assert.equal((await decide(current, 409)).code, "scope_held");

  } finally {
    storage.objects.close();
    await app.close();
  }
});

test("semantic check uses only an assigned gateway lease and repeats the effect key", async () => {
  const { createGatewayMeaningChecker } = await fromBuild("modules/questions/index");
  const attempts = [];
  const lease = { jobId: randomUUID(), workerId: "synthetic", epoch: 1 };
  const checker = createGatewayMeaningChecker({
    async call(input) {
      attempts.push(input);
      return attempts.length === 1
        ? { status: "paid", output: { choices: [{ message: { content: "same" } }] } }
        : { status: "held", code: "unknown_outcome" };
    },
  }, async () => ({ lease, routeId: "synthetic", dataClass: "synthetic", model: "controlled" }));

  const question = { subject: "D1", property: "thickness" };
  const candidate = { ...question, observationId: randomUUID(), evidenceId: randomUUID(), address: { unitId: "1" } };
  const support = { content: { kind: "text", text: "D1 project thickness 1.5 mm" } };
  const context = { inquiryId: randomUUID(), projectId: randomUUID(), scopeId: randomUUID(), searchVersion: 2 };
  const signal = new AbortController().signal;
  assert.equal(await checker(question, candidate, support, signal, { ...context, generationId: null }), "unclear");
  assert.deepEqual(attempts, []);
  const generation = { ...context, generationId: randomUUID() };
  assert.equal(await checker(question, candidate, support, signal, generation), "same");
  assert.equal(await checker(question, candidate, support, signal, generation), "unclear");
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[0].inputRefs, [candidate.evidenceId]);
  assert.equal(attempts[0].lease, lease);
});

test("ordinary worker closes only verified input holds and runs a semantic review through the gateway", {
  skip: !process.env.FACADE_QUESTIONS_WORKER_INTEGRATION || !process.env.FACADE_GATEWAY_JOURNAL_URL,
  timeout: 240_000,
}, async (t) => {
  const { createApi } = await fromBuild("platform/api");
  const { readConfig } = await fromBuild("platform/config");
  const { bootstrapAdmin } = await fromBuild("modules/access/bootstrap");
  const { createGateway, journalFromEnv } = await fromBuild("modules/gateway/index");
  const { startWorker } = await fromBuild("modules/harness/index");

  const controller = new AbortController();
  const providerErrors = [];
  const calls = [];
  const warnings = new Set();
  const inputs = new Map();
  const provider = createServer(async (req, res) => {
    try {
      const { attempt, request } = await new Response(req).json();
      const assignment = JSON.parse(request.messages[1].content);
      const replies = request.messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content));
      calls.push({ attempt, assignment });
      let name, args;
      if (assignment.mode === "lead") {
        [name, args] = ["propose_resolution", {
          aObservationId: assignment.dispute.a.observationId, bObservationId: assignment.dispute.b.observationId,
          explanation: "The excerpts refer to the same assigned technical property.",
        }];
      } else if (assignment.mode === "verify") {
        if (replies.length < 2) [name, args] = ["extract", { support: replies.length ? "B" : "A" }];
        else {
          assert.ok(replies.every(({ evidence, content }) => evidence?.evidenceId && typeof content === "string"));
          [name, args] = ["verify_resolution", {
            verdict: "supported", evidenceIds: replies.map(({ evidence }) => evidence.evidenceId),
            explanation: "Both coordinates and the shared subject were checked.",
          }];
        }
      } else if (!replies.length) [name, args] = ["survey", {}];
      else if (replies.length === 1) [name, args] = ["extract", {}];
      else if (replies.length === 2) {
        const fixture = inputs.get(assignment.place.source.sha256);
        assert.ok(fixture, "provider received an approved synthetic original");
        const { lines } = JSON.parse(replies[1].content);
        const line = lines.find(({ text }) => text === fixture.text);
        assert.ok(line, "addressed fixture row delivered by reader");
        [name, args] = ["save_observation", {
          evidenceId: replies[1].evidence.evidenceId, lineId: line.id, quote: line.text,
          value: fixture.value, unit: "mm", sourceRole: "design",
        }];
      } else {
        assert.ok(replies[2].observationId, "observation was saved");
        [name, args] = ["finish_reading", { status: "covered", explanation: "Addressed value." }];
      }
      res.end(JSON.stringify({
        receipt: { state: "paid", providerId: `managed:${attempt.id}`, evidenceRef: "fixture", costUsdNanos: 0 },
        output: { choices: [{ finish_reason: "tool_calls", message: {
          role: "assistant", content: null,
          tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
        } }] },
      }));
    } catch (error) {
      providerErrors.push(error.message);
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  let worker, app, journal;
  const priorManagedUrl = process.env.FACADE_HARNESS_MANAGED_URL;
  process.env.FACADE_HARNESS_MANAGED_URL = `http://127.0.0.1:${provider.address().port}`;
  t.after(async () => {
    controller.abort();
    await worker;
    await new Promise((resolve) => provider.close(resolve));
    if (priorManagedUrl === undefined) delete process.env.FACADE_HARNESS_MANAGED_URL;
    else process.env.FACADE_HARNESS_MANAGED_URL = priorManagedUrl;
    await journal?.close();
    await app?.close();
  });
  const config = readConfig();
  app = await createApi(config);
  app.db.options.connectionTimeoutMillis = 30_000;
  journal = journalFromEnv();
  const gateway = createGateway(app.db, { journal: journal.journal });
  const password = `synthetic-${randomUUID()}`;
  const login = `step12-${randomUUID()}`;
  await bootstrapAdmin(app.db, { organization: "Verified supplements", login, password });

  let auth = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" };
  async function request(method, url, payload, expected, headers) {
    const response = await app.inject({ method, url, payload, headers: { ...auth, "idempotency-key": randomUUID(), ...headers } });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body.slice(0, 350)}`);
    return response;
  }
  const json = async (...input) => (await request(...input)).json();
  const session = await request("POST", "/api/sessions", { login, password }, 200);
  auth = { ...auth, cookie: session.headers["set-cookie"].split(";")[0], "x-csrf-token": session.json().csrfToken };
  const catalog = await json("POST", "/api/catalogs", {
    key: "step12-catalog", name: "Step 12",
    requirements: [{ key: "thickness", part: "R1 thickness", applicability: "all", formats: ["pdf"],
      equivalents: [], sourceRoles: ["design"], completenessCriterion: "Addressed value", addressee: "Customer" }],
  }, 201);
  const project = await json("POST", "/api/projects", {
    name: "Two facades", catalogVersionId: catalog.id, scopeName: "North", stage: "design",
  }, 201);
  const projectId = project.id;
  const path = `/api/projects/${projectId}`;
  const north = project.scopes[0].id;
  const south = (await json("POST", `${path}/scopes`, { name: "South", stage: "design" }, 201)).id;
  for (const branch of ["a", "b", "lead"]) {
    const routeId = `managed-${branch}`;
    await gateway.configureRoute({
      id: routeId, revision: "controlled", transport: "managed", enabled: true,
      maxRequestBytes: 16 * 1024 ** 2, ceilingUsdNanos: 1, timeoutMs: 25_000,
    });
    const purposes = branch === "lead" ? ["review"] : [`primary_${branch}`, "review"];
    for (const purpose of purposes) await gateway.grantRoute({
      projectId, routeId, revision: "controlled", dataClass: "synthetic", purpose, allowed: true,
    });
  }
  worker = startWorker({ db: app.db, config, signal: controller.signal, logger: {
    warn(message) { warnings.add(message); }, info() {}, error(message) { warnings.add(message); },
  } });
  async function declare(scopeId, filename, text, value, replacesVersionId) {
    const bytes = pdf(text);
    const digest = sha256(bytes);
    inputs.set(digest, { text, value });
    const { receiptId } = await json("POST", `${path}/receipts`, {}, 201);
    const { uploadId } = await json("POST", `/api/receipts/${receiptId}/uploads`, {
      relativePath: filename, mediaType: "application/pdf", size: bytes.length,
      sha256: digest, scopeIds: [scopeId], replacesVersionId,
    }, 201);
    return { receiptId, async complete() {
      await request("PUT", `/api/uploads/${uploadId}/parts/1`, bytes, 200, {
        "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-part-sha256": digest,
      });
      const published = await json("POST", `/api/uploads/${uploadId}/complete`, {}, 200);
      await json("POST", `/api/receipts/${receiptId}/seal`, {}, 200);
      return published;
    } };
  }
  const assessment = (scopeId) => json("GET", `${path}/assessments/current?scopeId=${scopeId}`, undefined, 200);
  async function until(read, matches, label) {
    const deadline = Date.now() + 70_000;
    let state;
    do {
      state = await read();
      if (matches(state)) return state;
      await delay(200);
    } while (Date.now() < deadline && providerErrors.length === 0);
    assert.fail(`${label}: ${JSON.stringify({ state, warnings: [...warnings], providerErrors }).slice(0, 2200)}`);
  }
  const assessed = (outcome) => until(() => assessment(north),
    (card) => card.holds.length === 0 && card.questions[0]?.machine.outcome === outcome, outcome);

  const initial = await declare(north, "design.pdf", "R1 thickness 1.5", "1.5");
  await initial.complete();
  await assessed("covered");
  const conflict = await declare(north, "schedule.pdf", "R1 thickness 1.8", "1.8");
  const { versionId } = await conflict.complete();
  const before = (await assessed("confirmed_conflict")).questions[0];
  const confirmed = await json("POST", `/api/questions/${before.id}/decisions`, {
    action: "confirm", reason: "Checked both source values", requestExternal: true,
  }, 201, { "If-Match": `"${before.version}"` });
  const letter = await json("POST", `${path}/letters`, {
    scopeId: north, recipient: "Customer",
    items: [{ questionId: before.id, questionVersion: confirmed.version, decisionId: confirmed.id }],
  }, 201);
  const letterPath = `/api/letters/${letter.id}`;
  const ifMatch = { "If-Match": `"${letter.version}"` };
  const textPath = `${letterPath}/current-text`;
  const current = await json("GET", textPath, undefined, 200, ifMatch);
  assert.match(current.text, /1\.8 mm/);
  const revision = await json("GET", `${letterPath}/revisions/${current.revisionId}`, undefined, 200);
  const sent = await json("POST", `${letterPath}/sent`, {
    revisionId: current.revisionId, itemIds: revision.items.map(({ id }) => id),
    recipient: "Customer", text: current.text, sentAt: new Date().toISOString(),
  }, 201);
  const originalSent = await json("GET", sent.url, undefined, 200);

  const independent = await declare(south, "south.pdf", "R1 thickness 9.0", "9.0");
  const supplement = await declare(north, "schedule-rev2.pdf", "Panel-A gauge 1.5", "1.5", versionId);
  assert.equal((await json("GET", textPath, undefined, 409, ifMatch)).code, "scope_held");
  const replacement = await supplement.complete();
  await assessed("covered");
  const stale = await app.inject({ method: "GET", url: textPath, headers: { ...auth, ...ifMatch } });
  assert.ok([409, 412].includes(stale.statusCode));
  assert.notEqual(stale.json().code, "scope_held");
  assert.equal((await json("POST", `${path}/letters`, { scopeId: north, recipient: "Customer", items: [] }, 422)).code,
    "no_eligible_items");
  assert.deepEqual(await json("GET", sent.url, undefined, 200), originalSent);
  assert.ok((await assessment(south)).holds.some(({ receiptId }) => receiptId === independent.receiptId));

  const review = calls.find(({ attempt, assignment }) => attempt.purpose === "review" && assignment.mode === "lead" &&
    [assignment.dispute.a.place.source.versionId, assignment.dispute.b.place.source.versionId].includes(replacement.versionId));
  assert.ok(review, "the agreement needed a model comparison through the real gateway review queue");
  const { rows: [proof] } = await app.db.query(`
    SELECT count(*)::int AS n FROM harness_review_results
    WHERE dispute_id=$1 AND stage IN ('A','B') AND result->>'verdict'='supported'`,
  [review.assignment.dispute.id]);
  assert.equal(proof.n, 2);
  assert.equal((await journal.journal.balance()).spentUsdNanos, 0);
  assert.deepEqual(providerErrors, []);
});
