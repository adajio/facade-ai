import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { managedWorkerOptions, verifyManagedLauncherTargets } from "../../../test/fixtures/managed-worker-support.mjs";

const build = process.env.FACADE_TEST_BUILD ?? "dist";
const fromBuild = (path) => import(pathToFileURL(resolve(build, `src/${path}.js`)).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const managedWorkerRun = Boolean(process.env.FACADE_QUESTIONS_WORKER_INTEGRATION && process.env.FACADE_GATEWAY_JOURNAL_URL);
if (managedWorkerRun) await verifyManagedLauncherTargets({ loadBoundary: () => fromBuild("platform/runtime-boundary") });

// Real reader input, generated per address so byte deduplication cannot masquerade as an independent original.
function pdf(...lines) {
  const body = `BT /F1 18 Tf 30 165 Td ${lines.map((line) => `(${line}) Tj`).join(" 0 -22 Td ")} ET\n`;
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

test("independent supports, scoped revision and opened pairs before and after a supplement", {
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
    async function assertOpenPair(pair) {
      for (const support of [pair.left, pair.right]) {
        const evidence = await json("GET", support.evidenceHref);
        assert.equal(evidence.source.sha256, support.sha256);
        const bytes = await request("GET", support.contentHref);
        assert.equal(bytes.headers["cache-control"], "no-store");
        assert.equal(sha256(bytes.rawPayload), evidence.sha256);
        const original = await request("GET", support.originalHref);
        assert.equal(sha256(original.rawPayload), support.sha256);
      }
    }
    await assertOpenPair(current.pairs[0]);

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

    const later = await upload(north.id, "later-note.pdf", "D1 revision 2 names both sources: use 1.5 mm");
    await observe(later, { value: "1.5", branch: "B", role: "schedule", assessmentQuestionId: qNorth.id });
    await drain();
    const withNote = await detail(main.id);
    const oldPair = withNote.pairs.find(({ left, right }) =>
      [left.versionId, right.versionId].includes(a.source.versionId) &&
      [left.versionId, right.versionId].includes(b.source.versionId));
    assert.equal(oldPair?.comparison, "conflict", "a newer document naming both sources preserves both existing grounds");
    assert.ok(withNote.pairs.some(({ comparison, right }) => comparison === "agreement" && right.versionId === later.versionId));
    await assertOpenPair(oldPair);

    const revised = await upload(north.id, "north-schedule-revision.pdf", "Panel-A revision 2 thickness 0.0015 m",
      b.source.versionId);
    const replacement = await observe(revised, {
      subject: "Panel-A", aliases: ["D1"], value: "0.0015", unit: "m", branch: "B", role: "schedule",
      assessmentQuestionId: qNorth.id,
    });
    assert.equal(revised.documentId, b.source.documentId);
    await drain();
    const updated = await detail(main.id);
    assert.equal(updated.candidates.find(({ source }) => source.observationId === b.id)?.applicability, "revision_superseded");
    assert.equal(updated.candidates.find(({ source }) => source.observationId === a.id)?.applicability, "verified");
    assert.equal(updated.pairs.some(({ comparison }) => comparison === "conflict"), false);
    const revisedPair = updated.pairs.find(({ right }) => right.observationId === replacement.id);
    assert.equal(revisedPair?.comparison, "agreement");
    assert.equal(revisedPair.left.observationId, a.id);
    await assertOpenPair(revisedPair);
    const history = await detail(main.id, current.searchVersion);
    assert.equal(history.pairs[0].comparison, "conflict");
    assert.equal(history.pairs[0].right.observationId, b.id);
    await assertOpenPair(history.pairs[0]);

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
  skip: !managedWorkerRun,
  timeout: 240_000,
}, async (t) => {
  const { createApi } = await fromBuild("platform/api");
  const { readConfig } = await fromBuild("platform/config");
  const { bootstrapAdmin } = await fromBuild("modules/access/bootstrap");
  const { createGateway, journalFromEnv } = await fromBuild("modules/gateway/index");
  const { startWorker } = await fromBuild("modules/harness/index");
  const { publication } = await fromBuild("modules/harness/publication");
  const { loadResearchProfile } = await fromBuild("modules/harness/profile");
  const { transaction } = await fromBuild("modules/access/commands");

  const controller = new AbortController();
  const providerErrors = [];
  const calls = [];
  const warnings = new Set();
  const inputs = new Map();
  const mainSubject = "R1 thickness";
  const independentParts = ["R1 overall length", "R1 offset", "R1 bracket", "R1 anchor spacing"];
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
        const subject = assignment.question?.subject;
        const wrongAttribute = subject === independentParts[0] && fixture.text.includes("gauge");
        if (subject === mainSubject || wrongAttribute) {
          [name, args] = ["save_observation", {
            evidenceId: replies[1].evidence.evidenceId, lineId: line.id,
            quote: fixture.text.includes("gauge") ? "Panel-A gauge 1.5" : line.text,
            value: fixture.value, unit: "mm", sourceRole: "design",
          }];
        } else {
          [name, args] = ["finish_reading", { status: "no_match", explanation: "Inspected; other attribute." }];
        }
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
  const options = managedWorkerOptions(`http://127.0.0.1:${provider.address().port}`, import.meta.url);
  const priorProfile = process.env.FACADE_HARNESS_PROFILE;
  process.env.FACADE_HARNESS_PROFILE = JSON.stringify(options.profile);
  t.after(async () => {
    controller.abort();
    await worker;
    await new Promise((resolve) => provider.close(resolve));
    if (priorProfile === undefined) delete process.env.FACADE_HARNESS_PROFILE;
    else process.env.FACADE_HARNESS_PROFILE = priorProfile;
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
    requirements: [
      { key: "thickness", part: mainSubject, formats: ["pdf"] },
      ...independentParts.map((part, index) => ({ key: `independent-${index}`, part, formats: ["docx"] })),
    ].map((requirement) => ({ ...requirement, applicability: "all", equivalents: [], sourceRoles: ["design"],
      completenessCriterion: "Addressed value", addressee: "Customer" })),
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
  } }, options);
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
  const mainQuestion = (card) => card.questions.find(({ requirement }) => requirement.positionId === "thickness");
  const assessed = (outcome) => until(() => assessment(north),
    (card) => card.holds.length === 0 && mainQuestion(card)?.machine.outcome === outcome, outcome);

  const initial = await declare(north, "design.pdf", "R1 thickness 1.5", "1.5");
  await initial.complete();
  await assessed("covered");
  const conflict = await declare(north, "schedule.pdf", "R1 thickness 1.8", "1.8");
  const { versionId } = await conflict.complete();
  const baseline = await assessed("confirmed_conflict");
  const before = mainQuestion(baseline);
  const independentDecisions = new Map();
  for (const question of baseline.questions.filter(({ id }) => id !== before.id)) {
    const saved = await json("POST", `/api/questions/${question.id}/decisions`, {
      action: "correct", outcome: "needs_review", reason: "Retain independent internal review.",
    }, 201, { "If-Match": `"${question.version}"` });
    independentDecisions.set(question.id, { id: saved.id, version: saved.version, dependencyVersion: question.dependencyVersion });
  }
  assert.equal(independentDecisions.size, 4);
  function assertIndependent(card) {
    for (const [id, expected] of independentDecisions) {
      const actual = card.questions.find((question) => question.id === id);
      assert.deepEqual({ id: actual.decision?.id, version: actual.version, dependencyVersion: actual.dependencyVersion }, expected,
        `dependency changed for ${actual.requirement.positionId}`);
    }
  }
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
  const supplement = await declare(north, "schedule-rev2.pdf", "R1 thickness - Panel-A gauge 1.5", "1.5", versionId);
  assert.equal((await json("GET", textPath, undefined, 409, ifMatch)).code, "scope_held");
  const replacement = await supplement.complete();
  const settled = await assessed("covered");
  assertIndependent(settled);
  const { rows: replayJobs } = await app.db.query(`
    SELECT j.id AS "jobId", j.project_id AS "projectId", j.scope_id AS "scopeId",
      j.generation_id AS "generationId", j.payload AS job, j.result
    FROM gateway_jobs j JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
    WHERE j.project_id=$1 AND j.scope_id=$2 AND j.purpose IN ('primary_a','primary_b')
      AND j.state='done' AND j.payload#>>'{question,id}'=ANY($3::text[])
  `, [projectId, north, [...independentDecisions.keys()]]);
  assert.ok(replayJobs.length >= 4);
  const publish = publication(app.db, gateway, loadResearchProfile());
  for (const { result, ...task } of replayJobs) await transaction(app.db, (tx) => publish.outcome(tx, task, result));
  assertIndependent(await assessment(north));
  const { rows: wrongAttribute } = await app.db.query(`
    SELECT o.source->>'subjectVerified' AS verified, h.finding->>'applicability' AS applicability
    FROM harness_observations h JOIN inquiry_observations o ON o.id=h.observation_id
    WHERE o.version_id=$1 AND h.question_id=ANY($2::uuid[])
  `, [replacement.versionId, [...independentDecisions.keys()]]);
  assert.equal(wrongAttribute.length, 2, "each branch attempts the same false attachment");
  assert.ok(wrongAttribute.every(({ verified, applicability }) => verified === "false" && applicability === "unknown"));
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

test("addressed subject requires the measured attribute, including two attributes of one item", async () => {
  const { hasAddressedSubject } = await fromBuild("modules/questions/subject-evidence");
  const task = (property) => ({ subject: "P-16", property });
  const value = (lineId, quote, measure) => ({ lineId, quote, value: measure, unit: "mm", grounding: "text" });
  const cells = [
    ["key", "Mark", 1, 1], ["gap", "Gap", 1, 2], ["length", "Length", 1, 3],
    ["item", "P-16", 2, 1], ["gap-value", "12", 2, 2], ["length-value", "38", 2, 3],
  ].map(([id, text, row, column]) => ({ id, text, locator: { table: 1, row, column } }));
  assert.equal(hasAddressedSubject(task("gap"), value("gap-value", "12", "12"), cells), true);
  assert.equal(hasAddressedSubject(task("length"), value("length-value", "38", "38"), cells), true);
  assert.equal(hasAddressedSubject(task("length"), value("gap-value", "12", "12"), cells), false);
  assert.equal(hasAddressedSubject(task("gap"), value("length-value", "38", "38"), cells), false);

  const text = "P-16 gap 12 mm; P-16 length 38 mm";
  const inline = [{ id: "values", text }];
  assert.equal(hasAddressedSubject(task("length"), value("values", text, "12"), inline), false);
  assert.equal(hasAddressedSubject(task("length"), value("values", text, "38"), inline), true);
  const adjacent = [
    { id: "heading", text: "This revision concerns only gap P-16.", locator: { line: 1 } },
    { id: "value", text: "Use 12 mm for P-16.", locator: { line: 2 } },
  ];
  // The disambiguating identifier must be in the addressed sentence before the value.
  assert.equal(hasAddressedSubject(task("gap"), value("value", adjacent[1].text, "12"), adjacent), false);
  const bound = [adjacent[0], { ...adjacent[1], text: "For P-16 use 12 mm." }];
  assert.equal(hasAddressedSubject(task("gap"), value("value", bound[1].text, "12"), bound), true);
  assert.equal(hasAddressedSubject(task("length"), value("value", bound[1].text, "12"), bound), false);
});

test("engineer confirms a CAD alias and replaces only the selected question's addressed grounds", {
  skip: !process.env.DATABASE_URL || !process.env.FACADE_S3_ENDPOINT,
  timeout: 90_000,
}, async (t) => {
  const { createApi } = await fromBuild("platform/api");
  const { readConfig } = await fromBuild("platform/config");
  const { passwordHash } = await fromBuild("modules/access/auth");
  const { transaction } = await fromBuild("modules/access/commands");
  const { getLockedGate } = await fromBuild("modules/assessment/store");
  const { applyAssessmentUpdate } = await fromBuild("modules/assessment/updates");
  const { createIntakeStorage } = await fromBuild("modules/intake/blob");
  const { createRuntimePdfService } = await fromBuild("modules/pdf/index");
  const { createFormatAdapters } = await fromBuild("modules/formats/index");
  const { createRuntimeInquiryPorts, processNextInquiry, publishReaderObservation } = await fromBuild("modules/questions/index");

  const config = readConfig();
  const app = await createApi(config);
  const storage = createIntakeStorage(config.dataDir);
  const reader = createRuntimePdfService(app.db, config, { storage, adapters: createFormatAdapters() });
  t.after(async () => { storage.objects.close(); await app.close(); });

  async function insertId(sql, args) {
    const { rows: [{ id }] } = await app.db.query(sql, args);
    return id;
  }
  const organizationId = await insertId("INSERT INTO organizations(name) VALUES('Question applicability') RETURNING id");
  const baseRequirements = [
    { key: "gap", part: "Clearance P-16", formats: ["pdf"] },
    { key: "span", part: "Span P-16", formats: ["pdf"] },
    { key: "bracket", part: "Кронштейн P-22", formats: ["dxf"] },
    { key: "length", part: "Длина P-22", formats: ["dxf"] },
  ].map((requirement) => ({ ...requirement, applicability: "all", equivalents: [], sourceRoles: ["design"],
    completenessCriterion: "Addressed measure", addressee: "Customer" }));
  const password = `synthetic-${randomUUID()}`;
  const engineerLogin = `engineer-${randomUUID()}`;
  const viewerLogin = `viewer-${randomUUID()}`;
  const hash = await passwordHash(password);
  const addUser = (login) => insertId(
    "INSERT INTO users(organization_id,login,password_hash,state) VALUES($1,$2,$3,'active') RETURNING id",
    [organizationId, login, hash],
  );
  const engineer = await addUser(engineerLogin);
  const viewer = await addUser(viewerLogin);
  const catalog = await insertId(`INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by)
    VALUES($1,'applicability',1,'Controlled',$2,$3) RETURNING id`, [organizationId, JSON.stringify(baseRequirements), engineer]);
  const projectId = await insertId(
    "INSERT INTO projects(organization_id,name,catalog_version_id) VALUES($1,'Scoped replacement',$2) RETURNING id",
    [organizationId, catalog],
  );
  const scopeId = await insertId(
    "INSERT INTO project_scopes(project_id,stage,name) VALUES($1,'design','Test') RETURNING id", [projectId],
  );
  await app.db.query(`INSERT INTO project_memberships(project_id,organization_id,user_id,role)
    VALUES($1,$2,$3,'engineer'),($1,$2,$4,'viewer')`, [projectId, organizationId, engineer, viewer]);

  const headers = { host: "127.0.0.1", origin: "http://127.0.0.1" };
  async function login(name) {
    const response = await app.inject({ method: "POST", url: "/api/sessions", headers, payload: { login: name, password } });
    assert.equal(response.statusCode, 200);
    return { cookie: response.headers["set-cookie"].split(";")[0], "x-csrf-token": response.json().csrfToken };
  }
  const auth = await login(engineerLogin);
  const readOnly = await login(viewerLogin);
  async function request(method, url, payload, expected, extra = {}, actor = auth) {
    const response = await app.inject({ method, url, payload, headers: { ...headers, ...actor,
      "idempotency-key": randomUUID(), ...extra } });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body.slice(0, 350)}`);
    return response;
  }
  const json = async (...args) => (await request(...args)).json();
  const project = `/api/projects/${projectId}`;
  const assessment = () => json("GET", `${project}/assessments/current?scopeId=${scopeId}`, undefined, 200);
  const byKey = (card, key) => card.questions.find(({ requirement }) => requirement.positionId === key);
  const etag = (version) => ({ "If-Match": `"${version}"` });
  const ports = createRuntimeInquiryPorts(app.db, reader, storage.objects);
  const signal = new AbortController().signal;
  async function searchCandidates(questionId) {
    for (let count = 0; count < 40; count++) {
      if (!await processNextInquiry(app.db, ports, signal)) break;
    }
    const { rows: [result] } = await app.db.query(
      `SELECT r.candidates FROM inquiries i JOIN inquiry_search_results r ON r.inquiry_id=i.id
       AND i.search_version=r.search_version WHERE i.assessment_question_id=$1`, [questionId],
    );
    assert.ok(result, "current worker search published");
    return new Map(result.candidates.map((candidate) => [candidate.source.observationId, candidate]));
  }

  async function upload(name, bytes) {
    const { receiptId } = await json("POST", `${project}/receipts`, {}, 201);
    const digest = sha256(bytes);
    const { uploadId } = await json("POST", `/api/receipts/${receiptId}/uploads`, {
      relativePath: name, size: bytes.length, sha256: digest, scopeIds: [scopeId],
    }, 201);
    await request("PUT", `/api/uploads/${uploadId}/parts/1`, bytes, 200, {
      "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-part-sha256": digest,
    });
    const published = await json("POST", `/api/uploads/${uploadId}/complete`, {}, 200);
    await json("POST", `/api/receipts/${receiptId}/seal`, {}, 200);
    return { projectId, documentId: published.documentId, versionId: published.versionId, sha256: digest };
  }

  async function observe(source, question, quote, value, subjectVerified) {
    const { units } = await reader.map(source);
    return Promise.all(["A", "B"].map(async (branch) => {
      const runId = randomUUID();
      const read = { runId, branch, operationKey: "address" };
      const { evidence, bytes } = await reader.open(source, read, { representation: "native", address: { unitId: units[0].id } });
      const line = JSON.parse(bytes.toString("utf8")).lines.find(({ text }) => text.includes(quote));
      assert.ok(line);
      const pin = await transaction(app.db, async (tx) => {
        await getLockedGate(tx, projectId, scopeId);
        const observation = await reader.pin(source, { ...read, operationKey: "pin" }, {
          scope: scopeId, evidenceId: evidence.id, lineId: line.id, quote, value, unit: "mm",
        }, tx);
        await publishReaderObservation(tx, {
          observation, projectId, scopeId, readerJobId: runId, subject: question.requirement.subject,
          property: question.requirement.part, role: "design", revision: "effective", priority: "peer",
          comparableContext: question.id, assessmentQuestionId: question.id, subjectVerified,
        });
        return observation;
      });
      return { observationId: pin.id, evidenceId: evidence.id, versionId: source.versionId };
    }));
  }

  // Prepare a completed test review using the production assessment port and the real stored reader pins.
  async function report(question, findings) {
    await transaction(app.db, async (tx) => {
      const gate = await getLockedGate(tx, projectId, scopeId);
      await applyAssessmentUpdate(tx, { projectId, scopeId, eventId: randomUUID(), reason: "Completed fixture review",
        changes: [{ questionId: question.id, expectedDependencyVersion: question.dependencyVersion,
          review: { inputGeneration: gate.generation, remaining: [], completenessChecked: true,
            findings: findings.map(({ observationId, applicability }) => ({
              observationId, applicability, kind: "value", sourceRole: "design", comparisonKey: question.id,
            })) } }],
      });
    });
  }
  const findings = (refs, applicability = "active") => refs.map((ref) => ({ ...ref, applicability }));
  const initial = await assessment();
  const bracket = byKey(initial, "bracket");
  const length = byKey(initial, "length");
  const dxfText = "P-22 bracket width 46 mm";
  const cad = await upload("detail.dxf", Buffer.from([
    "0", "SECTION", "2", "ENTITIES", "0", "TEXT", "5", "2A", "8", "Dimensions", "10", "0", "20", "0",
    "40", "2", "1", dxfText, "0", "ENDSEC", "0", "EOF", "",
  ].join("\n")));
  const cadProof = await observe(cad, bracket, dxfText, "46", false);
  const lengthProof = await observe(cad, length, dxfText, "46", false);
  await report(bracket, findings(cadProof, "unknown"));
  await report(length, findings(lengthProof, "unknown"));
  const beforeAlias = await assessment();
  const bracketPath = `/api/questions/${bracket.id}`;
  const aliasPayload = { alias: "P-22 bracket width", reason: "Verified same detail at the recorded CAD handle.", proof: cadProof };
  const aliasVersion = byKey(beforeAlias, "bracket").version;
  assert.equal(byKey(beforeAlias, "bracket").machine.outcome, "needs_review");
  assert.equal((await json("POST", `${bracketPath}/attribute-aliases`, { ...aliasPayload, alias: "P-22 mm" },
    422, etag(aliasVersion))).code, "attribute_alias_unverified");
  await request("POST", `${bracketPath}/attribute-aliases`, aliasPayload, 403, etag(aliasVersion), readOnly);
  await json("POST", `${bracketPath}/attribute-aliases`, aliasPayload, 201, etag(aliasVersion));
  const afterAlias = await assessment();
  assert.equal(byKey(afterAlias, "bracket").machine.outcome, "covered");
  assert.deepEqual(byKey(afterAlias, "length"), byKey(beforeAlias, "length"));
  const approvedCandidates = await searchCandidates(bracket.id);
  for (const { observationId } of cadProof) {
    assert.equal(approvedCandidates.get(observationId)?.applicability, "verified");
    assert.equal(approvedCandidates.get(observationId)?.reason, "registered_alias");
  }
  const { source: approvedCad } = approvedCandidates.get(cadProof[0].observationId);
  const openedCad = await ports.openSupport(approvedCad, signal);
  assert.ok(openedCad);
  assert.equal(await ports.checkMeaning(approvedCad, approvedCad, openedCad, signal, {
    inquiryId: randomUUID(), assessmentQuestionId: length.id, scopeId, projectId, searchVersion: 1, generationId: null,
  }), "unclear", "an approved alias cannot transfer to another assessment question");
  const unapprovedCandidates = await searchCandidates(length.id);
  for (const { observationId } of lengthProof) {
    assert.equal(unapprovedCandidates.get(observationId)?.applicability, "meaning_unclear");
  }

  const gap = byKey(afterAlias, "gap");
  const span = byKey(afterAlias, "span");
  const measure = (value) => `Clearance P-16 ${value} mm`;
  const spanMeasure = "Span P-16 90 mm";
  const a = await upload("design.pdf", pdf(measure("12"), spanMeasure));
  const b = await upload("schedule.pdf", pdf(measure("15"), spanMeasure));
  const update = await upload("revision.txt", Buffer.from(measure("12") + "\n"));
  const first = await observe(a, gap, measure("12"), "12", true);
  const second = await observe(b, gap, measure("15"), "15", true);
  const next = await observe(update, gap, measure("12"), "12", true);
  const spanProof = [...await observe(a, span, spanMeasure, "90", true),
    ...await observe(b, span, spanMeasure, "90", true)];
  const group = [...first, ...second, ...next];
  await report(gap, findings(group));
  const replacePath = `/api/questions/${gap.id}/source-replacements`;
  const payload = { replaced: [first[0], second[0]], replacements: next,
    reason: "The accepted correction replaces the clearance at these two specific addresses." };
  const preAdmission = byKey(await assessment(), "gap");
  assert.equal(preAdmission.machine.outcome, "confirmed_conflict");
  const held = await json("POST", replacePath, payload, 422, etag(preAdmission.version));
  assert.equal(held.code, "support_format_not_admitted");

  const scopeRoute = `${project}/scopes/${scopeId}`;
  const scope = await json("GET", scopeRoute, undefined, 200);
  await json("PUT", scopeRoute + "/requirements", {
    requirements: baseRequirements.map((item) => item.key === "gap" ? { ...item, equivalents: ["txt"] } : item),
  }, 200, etag(scope.version));
  await report(byKey(await assessment(), "gap"), findings(group));
  await report(byKey(await assessment(), "span"), findings(spanProof));
  const ready = await assessment();
  const current = byKey(ready, "gap");
  const idem = { ...etag(current.version), "Idempotency-Key": randomUUID() };
  await request("POST", replacePath, { ...payload, replaced: [lengthProof[0], first[0]] }, 404, etag(current.version));
  const approved = await json("POST", replacePath, payload, 201, idem);
  const retry = await request("POST", replacePath, payload, 201, idem);
  assert.equal(retry.headers["idempotency-replayed"], "true");
  assert.deepEqual(retry.json(), approved);
  assert.equal((await json("POST", replacePath, payload, 412, etag(current.version))).code, "version_conflict");

  const final = await assessment();
  const affected = byKey(final, "gap");
  assert.equal(affected.machine.outcome, "covered");
  assert.deepEqual([...new Set(affected.machine.citations.map(({ versionId }) => versionId))], [update.versionId]);
  assert.deepEqual(byKey(final, "length"), byKey(ready, "length"));
  assert.deepEqual(byKey(final, "bracket"), byKey(ready, "bracket"));
  assert.deepEqual(byKey(final, "span"), byKey(ready, "span"));
  assert.deepEqual(new Set(byKey(final, "span").machine.citations.map(({ versionId }) => versionId)),
    new Set([a.versionId, b.versionId]));
  const republished = await observe(a, gap, measure("12"), "12", true);
  const addressed = await searchCandidates(gap.id);
  for (const { observationId } of [...first, ...second, ...republished]) {
    assert.equal(addressed.get(observationId)?.applicability, "revision_superseded");
  }
  const unaffected = await searchCandidates(span.id);
  for (const { observationId } of spanProof) {
    assert.equal(unaffected.get(observationId)?.applicability, "verified");
  }
  const history = await json("GET", `/api/questions/${gap.id}/applicability`, undefined, 200);
  assert.equal(history.replacements.length, 1);
  assert.equal(history.replacements[0].authorId, engineer);
  assert.deepEqual(history.replacements[0].replaced.sort((left, right) => left.versionId.localeCompare(right.versionId)),
    [...payload.replaced].sort((left, right) => left.versionId.localeCompare(right.versionId)));
  for (const support of [...first, ...second, ...next]) {
    await request("GET", `/api/v1/evidence/${support.evidenceId}/content`, undefined, 200);
  }
});

test("package inquiry preserves its address and engineering decisions outside assessment and letters", {
  skip: !process.env.DATABASE_URL || !process.env.FACADE_S3_ENDPOINT,
}, async (t) => {
  const { createApi } = await fromBuild("platform/api");
  const { readConfig } = await fromBuild("platform/config");
  const { passwordHash } = await fromBuild("modules/access/auth");
  const { createRuntimePdfService } = await fromBuild("modules/pdf/index");
  const { createIntakeStorage } = await fromBuild("modules/intake/blob");
  const { createRuntimeInquiryPorts, processNextInquiry } = await fromBuild("modules/questions/index");
  const { transaction } = await fromBuild("modules/access/commands");
  const config = readConfig();
  const app = await createApi(config);
  const storage = createIntakeStorage(config.dataDir);
  const reader = createRuntimePdfService(app.db, config, { storage });
  const ports = createRuntimeInquiryPorts(app.db, reader, storage.objects);
  const signal = new AbortController().signal;
  t.after(async () => { await reader.close(); await app.close(); });

  const login = `inquiry-${randomUUID()}`;
  const password = `synthetic-${randomUUID()}`;
  const userId = await transaction(app.db, async (tx) => {
    const { rows: [{ id: organizationId }] } = await tx.query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [login]);
    const { rows: [{ id }] } = await tx.query(
      `INSERT INTO users(organization_id,login,password_hash,state,org_admin,can_create_project)
       VALUES($1,$2,$3,'active',true,true) RETURNING id`, [organizationId, login, await passwordHash(password)]);
    return id;
  });
  const origin = process.env.FACADE_PUBLIC_ORIGIN ?? "http://127.0.0.1";
  const host = new URL(origin).host;
  let auth = {};
  async function request(method, url, payload, { status = 200, version, headers = {} } = {}) {
    const result = await app.inject({ method, url, payload, headers: {
      origin, host, ...auth, "idempotency-key": randomUUID(), ...(version ? { "if-match": `"${version}"` } : {}), ...headers,
    } });
    assert.equal(result.statusCode, status, `${method} ${url}: ${result.body}`);
    return result;
  }
  const json = async (...args) => (await request(...args)).json();
  const session = await request("POST", "/api/sessions", { login, password });
  auth = { cookie: session.headers["set-cookie"].split(";")[0], "x-csrf-token": session.json().csrfToken };
  const { id: projectId } = await json("POST", "/api/projects", { mode: "intake", name: "Unconfirmed facade inquiry" }, { status: 201 });
  const { id: otherProjectId } = await json("POST", "/api/projects", { mode: "intake", name: "Other package" }, { status: 201 });
  const base = `/api/v1/projects/${projectId}`;
  const assess = (project = projectId) => json("GET", `/api/v1/projects/${project}/facade-assessment`);
  const originalText = "Panel B damage inspect flashing";
  async function upload(filename, quote, replacesVersionId) {
    const bytes = pdf(quote);
    const digest = sha256(bytes);
    const { receiptId } = await json("POST", "/api/projects/" + projectId + "/receipts", {}, { status: 201 });
    const { uploadId } = await json("POST", `/api/receipts/${receiptId}/uploads`, {
      relativePath: filename, mediaType: "application/pdf", size: bytes.length, sha256: digest, replacesVersionId,
    }, { status: 201 });
    await request("PUT", `/api/uploads/${uploadId}/parts/1`, bytes, { headers: {
      "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-part-sha256": digest,
    } });
    const completed = await json("POST", `/api/uploads/${uploadId}/complete`, {});
    await json("POST", `/api/receipts/${receiptId}/seal`, {});
    const source = { projectId, documentId: completed.documentId, versionId: completed.versionId, sha256: digest };
    const run = { runId: randomUUID(), branch: "A", operationKey: "native" };
    const { evidence, bytes: evidenceBytes } = await reader.open(source, run, { representation: "native", address: { unitId: "1" } });
    const [line] = JSON.parse(evidenceBytes.toString()).lines;
    // Seed the pin from the ordinary reader's returned evidence, without leasing a model job.
    const pin = { id: randomUUID(), source, receiptId, readerVersion: evidence.readerVersion, runId: run.runId,
      branch: run.branch, scope: null, evidenceId: evidence.id, lineId: line.id, quote: line.text, grounding: "text",
      address: { ...evidence.address, box: line.box, locator: { ...evidence.address.locator, ...line.locator } } };
    await app.db.query(
      `INSERT INTO reader_observations(id,project_id,version_id,run_id,branch,operation_key,request_sha256,evidence_id,scope_id,payload)
       VALUES($1,$2,$3,$4,$5,'fixture-pin',$6,$7,NULL,$8)`,
      [pin.id, projectId, source.versionId, run.runId, run.branch, digest, evidence.id, pin]);
    return pin;
  }

  const pin = await upload("damage-r1.pdf", originalText);
  const assessment = await assess();
  const [common] = assessment.contexts;
  assert.equal(common.kind, "common");
  assert.equal(assessment.contexts.length, 1);
  assert.equal((await app.db.query("SELECT 1 FROM project_scopes WHERE project_id=$1", [projectId])).rowCount, 0);
  const { contexts: [other] } = await assess(otherProjectId);
  const eligibleUrl = base + "/letters/eligible?assessmentContextId=" + common.assessmentContextId;
  const letter = await json("GET", eligibleUrl);
  assert.deepEqual(letter.items, []);
  const { rows: [head] } = await app.db.query(
    "SELECT version,payload FROM facade_assessment_snapshots WHERE project_id=$1 ORDER BY version DESC LIMIT 1", [projectId]);
  assert.equal(head.version, assessment.version);

  // Pin one prepared branch observation into a synthetic assessment slice. Intake, original and reader evidence use ordinary API paths.
  async function snapshot(version, pins, readingComplete) {
    const refs = pins.map(({ id }) => id + ":question-fixture");
    await transaction(app.db, async (tx) => {
      for (const [index, observation] of pins.entries()) await tx.query(
        `INSERT INTO facade_assessment_observations(project_id,ref,observation_id,payload) VALUES($1,$2,$3,$4)
         ON CONFLICT (project_id,ref) DO NOTHING`,
        [projectId, refs[index], observation.id,
          { sourceRole: "drawing", revisionStatus: "current", address: observation.address, versionId: observation.source.versionId,
            binding: { state: "unidentified", candidates: [] } }],
      );
      await tx.query("INSERT INTO facade_assessment_snapshots(project_id,version,payload) VALUES($1,$2,$3)", [
        projectId, version, { ...head.payload, observations: { ...head.payload.observations, refs },
          coverage: { ...head.payload.coverage, reading: { ...head.payload.coverage.reading, complete: readingComplete } } },
      ]);
    });
  }
  const assessmentVersion = head.version + 1;
  await snapshot(assessmentVersion, [pin], false);
  const body = {
    assessmentContextId: common.assessmentContextId, assessmentVersion,
    versionId: pin.source.versionId, anchor: "1", subject: "Panel B", property: "damage",
  };
  await request("POST", base + "/inquiries", { ...body, anchor: "2" }, { status: 422 });
  await request("POST", base + "/inquiries", { ...body, assessmentContextId: other.assessmentContextId }, { status: 404 });
  await request("POST", base + "/inquiries", { ...body, assessmentVersion: head.version }, { status: 409 });
  const create = { status: 201, headers: { "idempotency-key": randomUUID() } };
  const created = await json("POST", base + "/inquiries", body, create);
  assert.deepEqual(await json("POST", base + "/inquiries", body, create), created);
  const detailPath = "/api/v1/inquiries/" + created.id;
  const listUrl = base + "/inquiries?assessmentContextId=" + common.assessmentContextId;
  assert.equal((await json("GET", listUrl)).inquiries.length, 1);
  await request("GET", detailPath + "?assessmentContextId=" + other.assessmentContextId, undefined, { status: 404 });
  const queued = await json("GET", detailPath);
  assert.equal(queued.state, "queued");
  assert.equal(queued.internalOnly, true);
  assert.equal(queued.scopeId, null);
  assert.equal(queued.source.address.locator.page, 1);
  assert.equal(await processNextInquiry(app.db, ports, signal), true);
  const partial = await json("GET", detailPath);
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.limitations, ["package_reading_incomplete"]);
  assert.deepEqual(partial.candidates.map(({ source }) => [source.quote, source.evidenceId]), [[originalText, pin.evidenceId]]);
  await request("POST", detailPath + "/decisions", { action: "accept", reason: "wrong support", candidateIds: [randomUUID()] },
    { status: 422, version: partial.version });
  const accepted = await json("POST", detailPath + "/decisions",
    { action: "accept", reason: "Original read", candidateIds: [pin.id] }, { version: partial.version });
  const corrected = await json("POST", detailPath + "/decisions",
    { action: "correct", reason: "Checked literally", answer: "Damage at flashing", candidateIds: [pin.id] }, { version: accepted.version });
  const detail = await json("GET", detailPath);
  assert.equal(detail.decision.version, corrected.version);
  assert.equal(detail.decision.authorId, userId);
  assert.equal(detail.decision.answer, "Damage at flashing");
  assert.deepEqual((await json("GET", eligibleUrl)).items, []);
  assert.deepEqual((await json("GET", base + "/facade-assessment/" + assessmentVersion)).contexts[0].questions, common.questions);

  const newPin = await upload("damage-r2.pdf", "Panel B new status not legible", pin.source.versionId);
  const stale = await json("GET", detailPath);
  assert.equal(stale.needsReview, true);
  assert.equal(stale.sourceReplaced, true);
  await request("POST", detailPath + "/decisions", { action: "reject", reason: "Obsolete" }, { status: 409, version: stale.version });
  const { rows: [{ nextVersion }] } = await app.db.query(
    'SELECT max(version)+1 AS "nextVersion" FROM facade_assessment_snapshots WHERE project_id=$1', [projectId]);
  await snapshot(nextVersion, [newPin], true);
  await json("POST", detailPath + "/searches", { assessmentVersion: nextVersion, versionId: newPin.source.versionId, anchor: "1" },
    { version: stale.version });
  assert.equal(await processNextInquiry(app.db, ports, signal), true);
  const repeated = await json("GET", detailPath);
  assert.equal(repeated.state, "empty");
  assert.equal(repeated.needsReview, true);
  assert.equal(repeated.source.versionId, newPin.source.versionId);
  const historical = await json("GET", detailPath + "?searchVersion=1");
  assert.equal(historical.assessmentVersion, assessmentVersion);
  assert.equal(historical.source.versionId, pin.source.versionId);
  assert.equal(historical.candidates[0].source.quote, originalText);
  assert.equal(historical.decision.answer, "Damage at flashing");
  const rejected = await json("POST", detailPath + "/decisions", { action: "reject", reason: "No answer in the new revision" },
    { version: repeated.version });
  assert.equal((await json("GET", detailPath)).decision.version, rejected.version);
  assert.equal((await json("GET", detailPath)).needsReview, false);
  assert.deepEqual((await json("GET", eligibleUrl)).items, []);
  await app.db.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [projectId, userId]);
  await request("GET", detailPath + "?searchVersion=1", undefined, { status: 404 });
});
