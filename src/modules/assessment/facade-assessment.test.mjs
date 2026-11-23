import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import pg from "pg";

const built = (path) => import(new URL(`../../../dist/src/modules/${path}.js`, import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const recipient = "Customer";

function pdf(line) {
  const stream = `BT /F1 8 Tf 20 120 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 250] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  return Buffer.from(data + `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) =>
    `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(data)}\n%%EOF\n`);
}

test("facade requirements retain partial local cover and demand a proven pair or explicit non-delivery", async () => {
  const { exactDeliveryStatement, facadeReview, nonDeliveryFromOriginal, requirementsFor } = await built("assessment/facade-model");
  const { evaluate, pairProofVersion } = await built("assessment/domain");
  const context = { id: "f1", facadeId: "f1", kind: "facade", name: "F1" };
  const [requirement] = requirementsFor([{
    key: "thickness", part: "Thickness", applicability: "stage:P", level: "facade",
    formats: ["pdf"], equivalents: [], sourceRoles: ["drawing"], completenessCriterion: "Addressed",
    evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "drawing" }] }] },
    addressee: recipient,
  }], context, "P");
  const boundary = (complete) => ({ complete, reason: null, basisIds: [] });
  const covered = { inventory: boundary(true), map: boundary(true), reading: boundary(true), subject: boundary(true) };
  const partial = { ...covered, subject: boundary(false), inventory: boundary(false) };
  function fact(branch, options = {}) {
    const { facadeId = "f1", value = "10", document = branch, role = "drawing", kind = "value" } = options;
    const receiptId = "synthetic-receipt";
    const nonDelivery = kind === "absence" ? {
      kind: "explicit_non_delivery", subjectQuote: "Thickness", questionId: "", receiptId,
    } : undefined;
    return {
      membership: { kind: "facades", facadeIds: [facadeId] }, property: "Thickness", stage: "P",
      variant: "v1", printedRevision: `R-${document}`, runId: `run-${branch}`,
      finding: { kind, format: "pdf", comparisonKey: "", sourceRole: role, applicability: "active", nonDelivery,
        citation: { branch, observationId: branch, documentId: document, versionId: document, sha256: document, receiptId,
          address: { unitId: "1" }, value, unit: "mm", quote: kind === "absence" ? "Thickness was not provided" : "Synthetic source",
          ...(nonDelivery ? { deliveryStatement: { status: "not_delivered", item: "Thickness" } } : {}) },
      },
    };
  }
  function decide(facts, coverage = partial, pairs = [], supplementReceiptIds = [], extra = {}) {
    const { rule = requirement, ...options } = extra;
    return evaluate(rule, facadeReview({
      context, stage: "P", questionId: "test-question", facts, requirement: rule, pairs, coverage, versionIds: ["v1"],
      supplementReceiptIds, ...options,
    }));
  }
  const a = fact("A");
  const b = fact("B", { document: "A" });
  assert.equal(decide([a, b]).outcome, "covered");
  assert.equal(decide([a, fact("B", { facadeId: "f2" })]).outcome, "needs_review");
  assert.equal(decide([a, fact("B", { role: "other" })]).outcome, "needs_review");
  assert.equal(decide([a, b, fact("B", { role: "other", value: "30" })]).outcome, "covered");
  const conflict = fact("B", { value: "12" });
  assert.equal(decide([a, conflict], covered).outcome, "needs_review");
  const pairs = [{ a: "A", b: "B", proof: { version: pairProofVersion, variant: "v1",
    revisionA: "r-a", revisionB: "r-b", scope: "f1" } }];
  assert.equal(decide([a, conflict], partial, pairs).outcome, "confirmed_conflict");
  const needsTitle = { ...conflict, printedRevision: null, variant: null, addressedValue: true,
    finding: { ...conflict.finding, applicability: "unknown" } };
  assert.equal(decide([a, needsTitle], partial, pairs).outcome, "confirmed_conflict");
  assert.equal(decide([a, { ...needsTitle, stage: null }], partial, pairs).outcome, "needs_review");
  assert.equal(decide([a, conflict], partial, pairs, ["supplement"]).outcome, "needs_review");
  const negative = ["A", "B"].map((branch) => fact(branch, { kind: "absence", role: "inventory", document: "inventory" }));
  assert.equal(decide(negative).outcome, "needs_review");
  assert.equal(decide(negative, covered).outcome, "confirmed_missing");
  assert.equal(decide([negative[0], { ...negative[1], runId: negative[0].runId }], covered).outcome, "needs_review");
  assert.equal(decide([...negative, { ...a, membership: { kind: "ambiguous" } }], covered).outcome, "needs_review");
  assert.equal(decide([], covered).outcome, "needs_review");
  const misleading = "Опись | Теплотехнический расчёт передан | Паспорт не передан";
  assert.equal(exactDeliveryStatement(misleading, "Теплотехнический расчёт", "not_delivered"), false);
  assert.equal(exactDeliveryStatement(misleading, "Теплотехнический расчёт", "delivered"), true);
  assert.equal(exactDeliveryStatement(misleading, "Паспорт", "not_delivered"), true);
  const absenceQuote = "Паспорт не передан";
  assert.equal(nonDeliveryFromOriginal(absenceQuote, misleading, "Паспорт"), true);
  assert.equal(nonDeliveryFromOriginal(absenceQuote, "Паспорт передан, Паспорт не передан", "Паспорт"), false);
  assert.equal(nonDeliveryFromOriginal(absenceQuote, undefined, "Паспорт"), false);
  assert.equal(exactDeliveryStatement("Thickness was delivered, Width not provided.", "Thickness", "not_delivered"), false);
  const strayNegative = negative.map((fact) => ({ ...fact, finding: { ...fact.finding, citation: {
    ...fact.finding.citation, quote: "Thickness was delivered, Width not provided.",
  } } }));
  assert.equal(decide(strayNegative, covered).outcome, "needs_review");
  const alias = { ...fact("A"), property: "Plate gauge" };
  assert.equal(decide([...negative, alias], covered, [], [], { rule: { ...requirement, aliases: ["Plate gauge"] } }).outcome, "needs_review");
  assert.equal(decide(negative, covered, [], [], { unclassifiedFormats: new Set(["pdf"]) }).limitations[0], "alternatives_unverified");
  assert.equal(decide([a, b], covered, [], [], { rule: { ...requirement, evidenceRule: undefined } }).outcome, "needs_review");
  const multi = { ...requirement, sourceRoles: ["drawing", "calculation"], evidenceRule: { distinctOriginals: true, allOf: [
    { anyOf: [{ sourceRole: "drawing" }] }, { anyOf: [{ sourceRole: "calculation", subject: "Heat load" }] },
  ] } };
  const extra = ["A", "B"].map((branch) => {
    const item = fact(branch, { document: "separate", role: "calculation", value: "95" });
    return { ...item, property: "Heat load", finding: { ...item.finding, citation: {
      ...item.finding.citation, observationId: `heat-${branch}`,
    } } };
  });
  assert.equal(decide([a, b], covered, [], [], { rule: multi }).outcome, "needs_review");
  assert.equal(decide([a, b, ...extra], covered, [], [], { rule: multi }).outcome, "covered");
  const onOneOriginal = extra.map((item) => ({ ...item, finding: { ...item.finding,
    citation: { ...item.finding.citation, sha256: a.finding.citation.sha256 },
  } }));
  assert.equal(decide([a, b, ...onOneOriginal], covered, [], [], { rule: multi }).outcome, "needs_review");
  const presence = { ...requirement, evidenceRule: { allOf: [{ anyOf: [
    { sourceRole: "drawing", mode: "presence", representations: ["native"] },
  ] }] } };
  const presenceFacts = ["A", "B"].map((branch) => {
    const item = fact(branch, { document: "presence", kind: "delivery", value: null });
    return { ...item, finding: { ...item.finding, representation: "native" } };
  });
  assert.equal(decide(presenceFacts, partial, [], [], { rule: presence }).outcome, "covered");
  assert.equal(decide(presenceFacts.map((item) => ({ ...item, finding: { ...item.finding, representation: "render" } })),
    partial, [], [], { rule: presence }).outcome, "needs_review");
});

const runDatabase = process.env.FACADE_ASSESSMENT_PACKAGE_TEST === "1" && process.env.DATABASE_URL &&
  process.env.FACADE_DATA_DIR && process.env.FACADE_S3_ENDPOINT && process.env.FACADE_S3_BUCKET;

test("ordinary intake publishes a local conflict, then keeps sent history after point replacement", {
  skip: !runDatabase, timeout: 240_000,
}, async (t) => {
  const { bootstrapAdmin } = await built("access/bootstrap");
  const { createRuntimePdfService } = await built("pdf/index");
  const { createGateway, transaction } = await built("gateway/index");
  const { preparePackageMap, dispatchPackagePair } = await built("harness/package-dispatch");
  const { schedulePackageReview } = await built("harness/package-review");
  const { pairSourceEvidence } = await built("harness/pair-evidence");
  const { publication } = await built("harness/publication");
  const { researchKind } = await built("harness/runner");
  const { passwordHash } = await built("access/auth");
  const origin = "http://localhost:3000";
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = Fastify();
  app.decorate("db", db);
  app.decorate("config", { dataDir: process.env.FACADE_DATA_DIR });
  for (const name of ["access", "intake", "pdf", "assessment", "letters", "questions", "supplements"]) {
    await app.register((await built(`${name}/index`)).register);
  }
  const reader = createRuntimePdfService(db, app.config);
  t.after(async () => { await reader.close(); await app.close(); await db.end(); });
  const login = "package-assessment";
  const password = "synthetic-acceptance-only";
  const { userId, organizationId } = await bootstrapAdmin(db, { organization: "Synthetic", login, password });
  let session = {};
  const request = async (method, url, payload, options = {}) => {
    const headers = { origin, host: "localhost:3000", ...session, "idempotency-key": randomUUID(), ...options.headers };
    if (options.version !== undefined) headers["if-match"] = `"${options.version}"`;
    const response = await app.inject({ method, url, payload, headers });
    assert.equal(response.statusCode, options.status ?? 200, `${method} ${url}: ${response.body}`);
    return response;
  };
  function credentials(response) {
    return { cookie: response.headers["set-cookie"].split(";")[0], "x-csrf-token": response.json().csrfToken };
  }
  session = credentials(await request("POST", "/api/sessions", { login, password }));
  const project = (await request("POST", "/api/projects", { mode: "intake", name: "Synthetic facades" }, { status: 201 })).json();
  const projectId = project.id;
  const base = `/api/v1/projects/${projectId}`;
  const assessment = () => request("GET", base + "/facade-assessment").then((response) => response.json());
  const pending = await assessment();
  assert.equal(pending.catalogVersionId, null);
  assert.equal(pending.stage, null);
  assert.deepEqual(pending.observations.counts, { common: 0, identified: 0, unclear: 0, unidentified: 0 });
  assert.equal((await request("GET", pending.observations.href)).json().items.length, 0);
  const scope = await db.query("SELECT count(*)::int AS count FROM project_scopes WHERE project_id=$1", [projectId]);
  assert.equal(scope.rows[0].count, 0);

  const fields = (key, part, level) => ({
    key, part, level, applicability: "stage:P", formats: ["pdf"], equivalents: [],
    sourceRoles: ["drawing"], completenessCriterion: "Addressed measure", addressee: recipient,
    evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "drawing" }] }] },
  });
  const catalog = (await request("POST", "/api/catalogs", {
    key: "synthetic", name: "Synthetic matrix",
    defaultProfile: { stage: "P", facadeKinds: ["panel"], approvalReference: "Synthetic rule" },
    requirements: [fields("thickness", "Thickness", "facade"), fields("width", "Width", "facade"), fields("clearance", "Clearance", "common")],
  }, { status: 201 })).json();
  const gateway = createGateway(db, { replayOnly: true });
  const profile = { lead: null };
  for (const [branch, purpose] of [["A", "primary_a"], ["B", "primary_b"], ["lead", "review"]]) {
    const routeId = `synthetic-package-${branch}`;
    await gateway.configureRoute({ id: routeId, revision: "offline", transport: "managed", enabled: true, maxRequestBytes: 10000,
      ceilingUsdNanos: 1, timeoutMs: 1000 });
    await gateway.grantRoute({ projectId, routeId, revision: "offline", purpose, dataClass: "synthetic", allowed: true });
    if (purpose !== "review") await gateway.grantRoute({ projectId, routeId, revision: "offline", purpose: "review",
      dataClass: "synthetic", allowed: true });
    profile[branch] = { routeId, model: routeId, dataClass: "synthetic", maxTokens: 500, maxTurns: 5, maxKnownRejections: 0 };
  }
  const publish = publication(db, gateway, profile);
  const fixtures = new Map();
  async function uploadReceipt(places) {
    const manifest = places.map((place) => {
      const data = pdf(place.quote);
      const itemId = randomUUID();
      fixtures.set(sha(data), place);
      return { place, data, item: { itemId, kind: "file", relativePath: place.filename, size: data.length,
        mediaType: "application/pdf", sha256: sha(data) } };
    });
    const { receiptId } = (await request("POST", `/api/projects/${projectId}/receipts`, {
      mode: "open", items: manifest.map(({ item }) => item),
    }, { status: 201 })).json();
    for (const { item, data } of manifest) {
      const { uploadId } = (await request("POST", `/api/receipts/${receiptId}/manifest/${item.itemId}/upload`, {}, { status: 201 })).json();
      await request("PUT", `/api/uploads/${uploadId}/parts/1`, data, { headers: {
        "content-type": "application/octet-stream", "content-length": String(data.length), "x-part-sha256": item.sha256,
      } });
      await request("POST", `/api/uploads/${uploadId}/complete`, {});
    }
    return receiptId;
  }
  async function finishReading() {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (!await preparePackageMap(db, gateway, reader, [])) break;
    }
    const stops = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const worked = await dispatchPackagePair(db, gateway, profile);
      let work;
      while ((work = await gateway.claim({ workerId: `fixture-${randomUUID()}`, kinds: [researchKind], leaseMs: 60000 }))) {
        const { lease, projectId, scopeId, generationId, payload: job } = work;
        const task = { jobId: lease.jobId, projectId, scopeId, generationId, job };
        const { place, branch } = job;
        const fixture = fixtures.get(place.source.sha256);
        const { evidence, bytes } = await reader.open(place.source, { runId: lease.jobId, branch, operationKey: "source" }, {
          representation: "native", address: { unitId: place.unitId, box: place.box },
        });
        const line = JSON.parse(bytes.toString()).lines[0];
        if (fixture.deferred) {
          assert.equal(await gateway.suspend(lease, { reason: "synthetic_pending", nextAction: "Synthetic continuation" }), true);
          stops.push(lease.jobId);
          continue;
        }
        const grounded = { evidenceId: evidence.id, scope: null, lineId: line.id, quote: fixture.savedQuote ?? line.text,
          ...(fixture.value ? { value: fixture.value, unit: "mm" } : {}),
          ...(fixture.statement ? { deliveryStatement: fixture.statement } : {}) };
        const details = {
          attribute: fixture.attribute, role: { value: fixture.role ?? "drawing", quote: fixture.roleQuote ?? "Drawing" },
          stage: { value: "P", quote: grounded.quote },
          revision: { value: fixture.revision, quote: grounded.quote, status: "current" },
          binding: fixture.facade ? {
            state: "identified", labels: [fixture.facade], quote: grounded.quote, reason: "Explicit address",
            projectIdentifiers: [{ label: fixture.facade, quote: grounded.quote }],
          } : { state: fixture.common ? "common" : "unidentified", labels: [], quote: grounded.quote, reason: "Printed scope" },
        };
        await transaction(db, async (tx) => {
          await tx.query("INSERT INTO harness_research_events(job_id,sequence,event) VALUES ($1,1,$2)", [
            lease.jobId, { kind: "tool", reply: { evidence: { evidenceId: evidence.id }, body: { content: bytes.toString() } } },
          ]);
          const observation = await reader.pin(place.source, { runId: lease.jobId, branch, operationKey: "pin" }, grounded, tx);
          await publish.observation(tx, { task }, { ...grounded, package: details }, observation);
          const outcome = { kind: "covered", observationIds: [observation.id] };
          assert.equal(await gateway.finish(lease, outcome, { state: "completed", evidenceRef: observation.id }, tx), true);
          await publish.outcome(tx, task, outcome);
        });
      }
      if (!worked) break;
    }
    return stops;
  }
  async function verifyConflicts() {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!await schedulePackageReview(db, gateway, profile)) break;
      let work;
      while ((work = await gateway.claim({ workerId: `verify-${randomUUID()}`, kinds: [researchKind], leaseMs: 60000 }))) {
        const { lease, projectId, scopeId, generationId, payload: job } = work;
        const task = { jobId: lease.jobId, projectId, scopeId, generationId, job };
        assert.ok(job.mode === "lead" || job.mode === "verify");
        const quotes = [];
        for (const citation of [job.dispute.a, job.dispute.b]) {
          const opened = await reader.open(citation.place.source, {
            runId: lease.jobId, branch: citation.branch, operationKey: `review-${citation.branch}`,
          }, { representation: "native", address: { unitId: citation.place.unitId } });
          const line = JSON.parse(opened.bytes.toString()).lines.find(({ text }) => text.includes(citation.quote));
          assert.ok(line);
          quotes.push({ support: citation.branch, evidenceId: opened.evidence.id, quote: citation.quote, line: line.text });
        }
        const { proof } = pairSourceEvidence({ variants: quotes, revisions: quotes, applicability: quotes,
          anchors: { A: [quotes[0].quote], B: [quotes[1].quote] }, scopeName: job.packageReview.scopeLabel,
          confirmVariant: true, confirmRevision: true, confirmApplicability: true });
        assert.ok(proof);
        const revision = { status: "confirmed", reason: "Reopened the original revision lines",
          sources: quotes.map(({ evidenceId, quote }) => ({ evidenceId, quote })) };
        const outcome = job.mode === "lead" ? { kind: "proposal", aObservationId: job.dispute.a.observationId,
          bObservationId: job.dispute.b.observationId, explanation: "Synthetic verified comparison", verifiedPair: proof, checks: { revision } } :
          { kind: "verification", verdict: "supported", verifiedPair: proof };
        await transaction(db, async (tx) => {
          assert.equal(await gateway.finish(lease, outcome, undefined, tx), true);
          await publish.outcome(tx, task, outcome);
        });
      }
    }
  }
  const drawing = (filename, attribute, value, revision, facade = "F1") => ({
    filename, attribute, value, revision, facade,
    quote: `Drawing ${attribute} ${value} mm | Stage P | Revision ${revision} current | Variant V1 | Scope: ${facade} | Project facade id: ${facade}`,
  });
  // A persisted result from the earlier publisher retained only the negative part of a contradictory line.
  const savedQuote = "Width not delivered | Stage P | Revision R9 current | Scope: F2 | Project facade id: F2 | Inventory";
  const initial = await uploadReceipt([
    drawing("first.pdf", "Thickness", "10", "R1"), drawing("second.pdf", "Thickness", "20", "R2"),
    drawing("width.pdf", "Width", "100", "R3"),
    { ...drawing("south.pdf", "Other", "200", "R4", "F2") },
    { filename: "common.pdf", attribute: "Clearance", value: "17", revision: "R5", common: true,
      quote: "Drawing Clearance 17 mm | Stage P | Revision R5 current | Applies to all facades" },
    { ...drawing("later.pdf", "Other", "300", "R8", "F2"), deferred: true },
    { filename: "inventory.pdf", attribute: "Width", facade: "F2", revision: "R9", role: "inventory", roleQuote: "Inventory",
      quote: `Width delivered, ${savedQuote}`, savedQuote, statement: { status: "not_delivered", item: "Width" } },
  ]);
  await finishReading();
  const observed = await assessment();
  assert.equal(observed.catalogVersionId, null);
  assert.equal(observed.contexts.filter(({ kind }) => kind === "facade").length, 2);
  const kinds = (await request("PUT", base + "/facade-assessment/facade-kinds", {
    facadeKinds: ["panel"], reason: "Synthetic original",
  }, { version: project.version })).json();
  await request("PUT", `/api/projects/${projectId}/stage`, { stage: "P", reason: "Synthetic title" }, { version: kinds.version });
  const beforeVerification = await assessment();
  assert.equal(beforeVerification.contexts.find(({ name }) => name === "F1").counts.confirmed_conflict, 0);
  const oldObservations = (await request("GET", beforeVerification.observations.href)).json().items;
  assert.ok(oldObservations.every(({ basis }) => basis.revisionEvidence === undefined));
  await verifyConflicts();
  const early = await assessment();
  assert.equal(early.catalogVersionId, catalog.id);
  assert.equal(early.coverage.inventory.complete, false);
  assert.equal(early.coverage.subject.complete, false);
  assert.equal(early.coverage.reading.complete, false);
  assert.equal(early.contexts.find(({ kind }) => kind === "common").counts.covered, 1);
  assert.equal(early.contexts.find(({ name }) => name === "F2").counts.needs_review, 2);
  const f2Width = early.contexts.find(({ name }) => name === "F2").questions.find(({ requirement }) => requirement.positionId === "width");
  assert.ok(f2Width.machine.citations.length > 0);
  assert.ok(f2Width.machine.citations.every(({ deliveryStatement }) => deliveryStatement?.status === "delivered"));
  assert.equal(early.contexts.find(({ name }) => name === "F1").counts.confirmed_conflict, 1);
  const newObservations = (await request("GET", early.observations.href)).json().items;
  const titled = newObservations.find(({ basis }) => basis.revisionEvidence);
  assert.ok(titled);
  const historicalObservations = (await request("GET", beforeVerification.observations.href)).json().items;
  assert.deepEqual(historicalObservations, oldObservations);
  assert.equal(historicalObservations.find(({ id }) => id === titled.id).binding.version, titled.binding.version);
  const context = (summary) => summary.contexts.find(({ name }) => name === "F1");
  const question = (summary, key) => context(summary).questions.find(({ requirement }) => requirement.positionId === key);
  const decision = async (q, requestExternal = false) => (await request("POST", `/api/v1/questions/${q.id}/decisions`, {
    action: "confirm", reason: "Synthetic review", requestExternal,
  }, { version: q.version, status: 201 })).json();
  const conflict = question(early, "thickness");
  const confirmed = await decision(conflict, true);
  const nearby = await decision(question(early, "width"));
  const decided = await assessment();
  const assessmentContextId = context(decided).assessmentContextId;
  await request("POST", base + "/conclusions", {
    assessmentContextId, startWork: "cannot_start", reason: "Synthetic start decision",
  }, { version: context(decided).version, status: 201 });
  const letter = (await request("POST", base + "/letters", {
    assessmentContextId, recipient, items: [{ questionId: conflict.id, questionVersion: confirmed.version, decisionId: confirmed.id }],
  }, { status: 201 })).json();
  const letterPath = `/api/v1/letters/${letter.id}`;
  const saved = (await request("GET", letterPath + `/revisions/${letter.revisionId}`)).json();
  const text = (await request("GET", letterPath + "/current-text", undefined, { version: letter.version })).json();
  assert.match(text.text, /first.pdf/u);
  assert.match(text.text, /second.pdf/u);
  const exported = (await request("POST", letterPath + "/exports", { format: "txt" }, { status: 201, version: letter.version })).json();
  const sent = (await request("POST", letterPath + "/sent", {
    revisionId: letter.revisionId, itemIds: saved.items.map(({ id }) => id), recipient, text: text.text,
    sentAt: new Date().toISOString(),
  }, { status: 201 })).json();
  await request("POST", `/api/receipts/${initial}/seal`, { manifestVersion: 1 });
  const supplement = await uploadReceipt([
    drawing("supplement-a.pdf", "Thickness", "15", "R6"), drawing("supplement-b.pdf", "Thickness", "15", "R7"),
  ]);
  await request("POST", base + "/supplements/links", {
    receiptId: supplement, letterId: letter.id, sentId: sent.id, itemId: saved.items[0].id,
  }, { status: 201 });
  await request("POST", `/api/receipts/${supplement}/seal`, { manifestVersion: 1 });
  await finishReading();
  const held = await assessment();
  assert.equal(question(held, "width").decision.id, nearby.id);
  assert.deepEqual(context(held).questionHolds, [{ questionId: conflict.id, receiptIds: [supplement] }]);
  await request("GET", letterPath + "/current-text", undefined, { version: letter.version, status: 409 });
  const refers = ({ observationId, evidenceId, versionId }) => ({ observationId, evidenceId, versionId });
  const row = question(held, "thickness");
  const candidates = row.machine.citations.filter(({ receiptId }) => receiptId === supplement);
  const old = conflict.machine.citations.map(refers);
  const selected = [candidates.find(({ branch }) => branch === "A"), candidates.find(({ branch }) => branch === "B")].map(refers);
  await request("POST", `/api/v1/questions/${row.id}/source-replacements`, { replacements: selected, replaced: old,
    reason: "Same project identifier and compatible new originals",
  }, { version: row.version, status: 201 });
  const updated = await assessment();
  assert.equal(question(updated, "thickness").machine.outcome, "covered");
  assert.equal(question(updated, "width").decision.id, nearby.id);
  assert.equal(context(updated).questionHolds.length, 0);
  assert.equal((await request("GET", sent.url)).json().text, text.text);
  assert.equal((await request("GET", exported.historicalUrl)).body, text.text);
  assert.equal((await request("GET", base + `/facade-assessment/${early.version}`)).json().outcome, early.outcome);
  assert.equal((await request("GET", early.observations.href + "?binding=common&limit=1")).json().items.length, 1);
  const { rows: [balance] } = await db.query("SELECT count(*)::int AS attempts FROM gateway_attempts WHERE project_id=$1", [projectId]);
  assert.equal(balance.attempts, 0);

  const currentProject = (await request("GET", `/api/projects/${projectId}`)).json();
  await request("PUT", base + "/facade-assessment/facade-kinds", {
    facadeKinds: ["masonry"], reason: "Not compatible with the selected matrix",
  }, { version: currentProject.project?.version ?? currentProject.version });
  const incompatible = await assessment();
  assert.ok(incompatible.limitations.includes("catalog_not_applicable"));
  assert.deepEqual((await request("GET", base + `/letters/eligible?assessmentContextId=${assessmentContextId}`)).json().items, []);
  const { rows: [scopeViewer] } = await db.query(
    "INSERT INTO users(organization_id,login,password_hash,state) VALUES($1,'scope-viewer',$2,'active') RETURNING id",
    [organizationId, await passwordHash(password)]);
  const { rows: [accessScope] } = await db.query("INSERT INTO project_scopes(project_id,stage,name) VALUES($1,'P','ACL only') RETURNING id",
    [projectId]);
  await db.query(`INSERT INTO project_memberships(organization_id, project_id, user_id, role, scope_id, expires_at, reason)
    VALUES($1,$2,$3,'viewer',$4,now()+interval '1 day','Synthetic limited role')`, [organizationId, projectId, scopeViewer.id, accessScope.id]);
  assert.notEqual(userId, scopeViewer.id);
  session = credentials(await request("POST", "/api/sessions", { login: "scope-viewer", password }));
  await request("GET", base + "/facade-assessment", undefined, { status: 404 });
  await request("GET", early.observations.href, undefined, { status: 404 });
});
