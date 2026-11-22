import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.ASSESSMENT_BUILD_ROOT ?? resolve("dist");
const fromBuild = (file) => import(pathToFileURL(resolve(root, file)).href);
const api = "/api";
const origin = "http://127.0.0.1";

function pdf(lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).map((line) => `(${line}) Tj`).join(" 0 -24 Td ");
  const contents = `BT /F1 12 Tf 30 130 Td ${text} ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const xref = ["0000000000 65535 f \n"];
  for (const [index, object] of objects.entries()) {
    xref.push(`${String(Buffer.byteLength(source)).padStart(10, "0")} 00000 n \n`);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const offset = Buffer.byteLength(source);
  return Buffer.from(`${source}xref\n0 ${xref.length}\n${xref.join("")}trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
}

test("assessment rules distinguish unit equivalence, versions, unreadable values, and proof of absence", async () => {
  const { evaluate, effectiveOutcome } = await fromBuild("src/modules/assessment/domain.js");
  const requirement = {
    positionId: "d1", partId: "thickness", subject: "D1", part: "Thickness",
    formats: ["pdf"], sourceRoles: ["design"], applicability: "applicable",
  };
  function finding(branch, value, unit, page, options = {}) {
    return {
      kind: "value", applicability: "active", sourceRole: "design", format: "pdf",
      comparisonKey: "D1:thickness:variant-1",
      citation: { branch, value, unit, sha256: "same-original", address: { page }, receiptId: "receipt" },
      ...options,
    };
  }
  const complete = { completenessChecked: true, remaining: [] };
  const a = finding("A", "1,5", "мм", 1);
  const same = finding("B", "0.0015", "m", 2);
  const different = finding("B", "0.0018", "m", 2);
  assert.equal(evaluate(requirement, null).outcome, "needs_review");
  assert.equal(evaluate(requirement, { ...complete, findings: [a, same] }).outcome, "covered");
  assert.deepEqual(evaluate(requirement, { ...complete, findings: [a, different] }).citations,
    [a.citation, different.citation]);
  assert.equal(evaluate(requirement, { ...complete, findings: [a, different] }).outcome, "confirmed_conflict");
  const crossBranch = evaluate(requirement, { ...complete, findings: [
    a, finding("A", "20", "mm", 2), finding("B", "1.5", "mm", 1),
  ] });
  assert.equal(crossBranch.outcome, "confirmed_conflict");
  assert.deepEqual(crossBranch.citations.map(({ branch }) => branch), ["A", "B"]);
  assert.equal(evaluate(requirement, { ...complete, findings: [a,
    finding("B", "20", "mm", 1)] }).outcome, "needs_review");
  assert.equal(evaluate(requirement, { ...complete, findings: [a,
    { ...different, comparisonKey: "D1:thickness:variant-2" }] }).outcome, "needs_review");
  assert.equal(evaluate(requirement, { ...complete, findings: [a,
    { ...different, applicability: "superseded" }] }).outcome, "needs_review");
  const source = (item, name, version, extras = {}) => ({
    ...item, citation: { ...item.citation, documentId: name, versionId: version, sha256: name, ...extras },
  });
  const pdfSupport = source(a, "drawing.pdf", "drawing-v1");
  const docxSupport = source(different, "log.docx", "docx-v1");
  const docSupport = source(finding("A", "1.8", "mm", 2), "log.doc", "doc-v2");
  const docRepeat = source(different, "log.doc", "doc-v2", { receiptId: "repeat", address: { page: 2, box: [1, 2] } });
  const outdated = { ...source(finding("A", "22", "mm", 2), "log.doc", "doc-v1"), applicability: "superseded" };
  const completeConflict = evaluate(requirement, {
    ...complete, findings: [pdfSupport, docxSupport, docSupport, docRepeat, outdated],
  });
  assert.equal(completeConflict.outcome, "confirmed_conflict");
  assert.deepEqual(completeConflict.citations, [pdfSupport.citation, docxSupport.citation, docSupport.citation]);
  const pending = { ...source(finding("B", "29", "mm", 3), "unverified.pdf", "guess"), applicability: "unknown" };
  assert.equal(evaluate(requirement, {
    ...complete, findings: [pdfSupport, docxSupport, docSupport, docRepeat, pending],
  }).outcome, "needs_review");
  const damaged = evaluate(requirement, { ...complete, findings: [{ ...a, kind: "delivery" }] });
  assert.equal(damaged.outcome, "needs_review");
  assert.equal(damaged.delivery, "received");
  assert.equal(damaged.readability, "unreadable");
  const wrongFormat = evaluate(requirement, { ...complete, findings: [{ ...a, format: "dwg" }] });
  assert.equal(wrongFormat.delivery, "received_in_other_format");
  assert.equal(wrongFormat.outcome, "needs_review");
  const inventory = {
    kind: "explicit_non_delivery", receiptIds: ["receipt"],
    currentCompositionChecked: true, alternativesChecked: true,
  };
  const missing = [a, same].map((item) => ({ ...item, kind: "absence", sourceRole: "inventory" }));
  assert.equal(evaluate(requirement, { ...complete, inventory, findings: [] }).outcome, "needs_review");
  assert.equal(evaluate(requirement, { ...complete, inventory, findings: missing }).outcome, "confirmed_missing");
  assert.equal(evaluate(requirement, { ...complete, inventory, findings: [...missing, a] }).outcome, "needs_review");
  const explicitDelivery = {
    ...missing[0], kind: "delivery",
    citation: { ...a.citation, deliveryStatement: { status: "delivered", item: "Thickness" } },
  };
  const contested = evaluate(requirement, { ...complete, inventory, findings: [...missing, explicitDelivery] });
  assert.equal(contested.outcome, "needs_review");
  assert.deepEqual(contested.limitations, ["non_delivery_contradicted"]);
  assert.equal(effectiveOutcome(damaged, { action: "exclude", outcome: "excluded",
    exclusion: { until: "2026-11-20T00:00:00Z" } }, new Date("2026-11-22T00:00:00Z")), "needs_review");
});

test("document revision survives repeated conversions of an original", async () => {
  const { createDocumentRevisionReader } = await fromBuild("src/modules/assessment/document-revision.js");
  const header = "Working document. Revision N05.";
  const bytes = (text, derivativeSha256) => Buffer.from(JSON.stringify({
    derivativeSha256, lines: [{ text, locator: { paragraph: 2 } }],
  }));
  const entries = Array.from({ length: 12 }, (_, index) => ({
    evidence: {
      id: String(index),
      size: bytes(header, index).length,
      format: "doc",
      address: { unitId: "paragraphs:1", locator: { firstParagraph: 1 } },
    },
  }));
  const tx = { query: async () => ({ rows: entries }) };
  const read = createDocumentRevisionReader({ content: async ({ id }) => bytes(header, id) });
  const resolve = (reader) => reader(tx, "project", "Design", {
    address: { locator: { table: 1, row: 2, column: 2 } },
  });
  assert.deepEqual(await resolve(read), {
    label: "N05", quote: header,
    address: { unitId: "paragraphs:1", locator: { firstParagraph: 1, paragraph: 2 } },
    evidenceId: "0",
  });
  const contradictory = createDocumentRevisionReader({
    content: async ({ id }) => bytes(id === "11" ? "Working document. Revision N06." : header, id),
  });
  assert.equal(await resolve(contradictory), undefined);
});

async function createScopedApi(config) {
  const { openPool } = await fromBuild("src/platform/db.js");
  const app = Fastify();
  app.decorate("db", openPool(config.databaseUrl));
  app.decorate("config", config);
  app.addHook("onClose", () => app.db.end());
  const access = await fromBuild("src/modules/access/index.js");
  await access.register(app);
  for (const name of ["intake", "pdf", "assessment", "supplements", "letters"]) {
    const module = await fromBuild(`src/modules/${name}/index.js`);
    app.register(module.register);
  }
  return app;
}

test("assessment through real HTTP, PostgreSQL, reader and letter modules", {
  skip: process.env.ASSESSMENT_TEST_DB !== "1" || !process.env.DATABASE_URL || !process.env.FACADE_DATA_DIR,
}, async (t) => {
  const [{ bootstrapAdmin }, { createRuntimePdfService }, { transaction }, assessment] =
    await Promise.all([
      fromBuild("src/modules/access/bootstrap.js"),
      fromBuild("src/modules/pdf/index.js"),
      fromBuild("src/modules/access/commands.js"),
      fromBuild("src/modules/assessment/index.js"),
    ]);

  process.env.FACADE_PUBLIC_ORIGIN = origin;
  const config = { databaseUrl: process.env.DATABASE_URL, dataDir: process.env.FACADE_DATA_DIR,
    host: "127.0.0.1", port: 0 };
  const createApi = process.env.ASSESSMENT_TEST_MODULES_ONLY === "1" ? createScopedApi :
    (await fromBuild("src/platform/api.js")).createApi;
  const app = await createApi(config);
  t.after(() => app.close());
  const url = await app.listen({ host: config.host, port: 0 });
  const reader = createRuntimePdfService(app.db, config);
  t.after(() => reader.close());
  const login = "assessment@example.test";
  const password = `Assessment-${randomUUID()}`;
  await bootstrapAdmin(app.db, { organization: "Assessment fixtures", login, password });
  const auth = await fetch(`${url}${api}/sessions`, {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ login, password }),
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await auth.json();

  async function http(method, path, status, payload, version, options = {}) {
    const headers = { cookie, origin, "x-csrf-token": csrfToken,
      "idempotency-key": options.key ?? randomUUID(), ...options.headers };
    let body;
    if (payload !== undefined) {
      headers["content-type"] = Buffer.isBuffer(payload) ? "application/octet-stream" : "application/json";
      body = Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    }
    if (version !== undefined) headers["if-match"] = `"${version}"`;
    const pathname = path.startsWith("/api/") ? path : `${api}${path}`;
    const response = await fetch(`${url}${pathname}`, { method, headers, body });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return data;
  }

  const catalog = (requirements) => http("POST", "/catalogs", 201, {
    key: "assessment", name: "Assessment fixture", requirements,
  });
  const empty = await catalog([]);
  const project = await http("POST", "/projects", 201, { name: "Office building", catalogVersionId: empty.id });
  const p = `/projects/${project.id}`;
  const north = await http("POST", `${p}/scopes`, 201, { name: "North", stage: "Design" });
  const south = await http("POST", `${p}/scopes`, 201, { name: "South", stage: "Design" });
  const current = (scope) => http("GET", `${p}/assessments/current?scopeId=${scope.id}`, 200);
  const first = await current(north);
  assert.deepEqual(first.limitations, ["catalog_empty"]);
  assert.equal(first.outcome, "needs_review");
  assert.equal(first.questions.length, 0);
  await http("GET", `${p}/assessments/current`, 422);
  await http("GET", `${p}/assessments/current?scopeId=${north.id}`, 401, undefined, undefined,
    { headers: { cookie: "" } });
  const emptyConclusion = await http("POST", `${p}/conclusions`, 201, {
    scopeId: north.id, startWork: "cannot_start", reason: "Awaiting the catalogue.",
  }, first.version);
  assert.equal((await current(north)).conclusion.id, emptyConclusion.id);

  const base = {
    applicability: "all", formats: ["pdf"], equivalents: [], sourceRoles: ["design"],
    completenessCriterion: "Exact original data for the selected facade", addressee: "Fixture owner",
  };
  const thickness = { ...base, key: "d1-thickness", part: "D1 thickness" };
  const schedule = { ...base, key: "schedule", part: "Finish schedule" };
  const rules = await catalog([thickness, schedule]);
  const beforePin = await http("GET", p, 200);
  const pinned = await http("PUT", `${p}/catalog`, 200, { catalogVersionId: rules.id }, beforePin.version);
  const tracked = await current(north);
  const southStart = await current(south);
  const conflictQuestion = tracked.questions.find(({ requirement }) => requirement.partId === thickness.key);
  const absenceQuestion = tracked.questions.find(({ requirement }) => requirement.partId === schedule.key);
  assert.equal(tracked.catalogVersionId, rules.id);
  assert.equal(tracked.change.reason, "catalog_changed");
  assert.equal(conflictQuestion.machine.outcome, "needs_review");
  assert.equal(southStart.questions.every(({ outcome }) => outcome === "needs_review"), true);

  const { receiptId } = await http("POST", `${p}/receipts`, 201, {});
  assert.equal((await current(north)).holds.length, 0);
  const upload = async (line, relativePath, scopeIds, complete = true, id = receiptId, replacesVersionId) => {
    const plain = relativePath.endsWith(".txt");
    const bytes = plain ? Buffer.from(line + "\n") : pdf(line);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { uploadId } = await http("POST", `/receipts/${id}/uploads`, 201, {
      relativePath, size: bytes.length, sha256, mediaType: plain ? "text/plain" : "application/pdf", scopeIds, replacesVersionId,
    });
    if (!complete) return { uploadId };
    await http("PUT", `/uploads/${uploadId}/parts/1`, 200, bytes, undefined,
      { headers: { "x-part-sha256": sha256 } });
    return { ...await http("POST", `/uploads/${uploadId}/complete`, 200, {}), sha256, plain };
  };

  const a = await upload(["Revision N04", "Thickness D1 1.5 mm"], "A-current.pdf", [north.id]);
  const b = await upload(["Revision N06", "Thickness D1 0.0018 m"], "B-current.pdf", [north.id]);
  const inventory = await upload("Shipment register · Design · N05\nFinish schedule excluded from this delivery", "Inventory.txt", [north.id]);
  const restriction = await upload("Finish schedule must not be issued before approval", "Restriction.pdf", [north.id]);
  const related = await upload("Receipt copy not included in this delivery", "Related-item.pdf", [north.id]);
  await http("POST", `/receipts/${receiptId}/seal`, 200, {});
  const held = await current(north);
  assert.equal(held.holds.length, 5);
  assert.equal((await current(south)).holds.length, 0);
  const confirmPath = `/questions/${conflictQuestion.id}/decisions`;
  const blocked = await http("POST", confirmPath, 409, { action: "confirm", reason: "checked" }, conflictQuestion.version);
  assert.equal(blocked.code, "scope_held");

  async function read(file, branch, quote, value, unit, deliveryStatement, compound = false) {
    const source = { projectId: project.id, documentId: file.documentId,
      versionId: file.versionId, sha256: file.sha256 };
    const run = { runId: randomUUID(), branch };
    await reader.map(source);
    const nativeScope = { ...run, operationKey: "native" };
    const { evidence } = file.plain
      ? await reader.open(source, nativeScope, { representation: "native", address: { unitId: "lines:1" } })
      : await reader.native(source, nativeScope, { page: 1 });
    const href = `/api/v1/evidence/${evidence.id}`;
    const rendered = await http("GET", `${href}/content`, 200);
    const { id: lineId } = rendered.lines.find(({ text }) => text.includes(quote));
    const parts = compound ? [
      { role: "value", literal: value, quote, lineId, evidenceId: evidence.id, link: { kind: "anchor" } },
      { role: "unit", literal: unit, quote, lineId, evidenceId: evidence.id, link: { kind: "source_context", to: 0 } },
    ] : undefined;
    const observation = await reader.pin(source, { ...run, operationKey: "pin" }, {
      evidenceId: evidence.id, scope: north.id, quote, value, unit, deliveryStatement, ...(compound ? { lineId } : {}),
    }, undefined, parts);
    const citation = await http("GET", href, 200);
    assert.equal(rendered.lines.some(({ text }) => text.includes(quote)), true);
    if (compound) {
      const saved = await http("GET", `/api/v1/observations/${observation.id}`, 200);
      assert.deepEqual(saved.components, observation.components);
      assert.equal(saved.components.length, 2);
      for (const part of saved.components) {
        assert.equal(part.source.sha256, source.sha256);
        assert.equal(part.address.locator.page, 1);
        assert.equal((await http("GET", part.evidenceHref, 200)).source.versionId, source.versionId);
      }
    }
    return { observation, citation };
  }

  const left = await read(a, "A", "Thickness D1 1.5 mm", "1.5", "mm", undefined, true);
  const right = await read(b, "B", "Thickness D1 0.0018 m", "0.0018", "m");
  const absentQuote = "Finish schedule excluded from this delivery";
  const ordinaryAbsence = await read(inventory, "A", absentQuote, "excluded");
  const delivery = (item) => ({ status: "not_delivered", item });
  const absentA = await read(inventory, "A", absentQuote, undefined, undefined, delivery("Finish schedule"));
  const absentB = await read(inventory, "B", absentQuote, undefined, undefined, delivery("Finish schedule"));
  const rule = await read(restriction, "A", "Finish schedule must not be issued before approval", "not");
  const wrongSubject = await read(related, "B", "Receipt copy not included in this delivery",
    undefined, undefined, delivery("Receipt copy"));
  const finding = (item, kind = "value") => ({
    observationId: item.observation.id, kind, sourceRole: kind === "absence" ? "inventory" : "design",
    comparisonKey: kind === "absence" ? "schedule" : "D1:thickness:design", applicability: "active",
  });
  const review = { inputGeneration: held.inputGeneration, completenessChecked: true, remaining: [] };
  const generation = randomUUID();
  const statement = (item, subjectQuote = "Finish schedule") => ({
    ...finding(item, "absence"),
    nonDelivery: { kind: "explicit_non_delivery", subjectQuote, questionId: absenceQuestion.id, receiptId },
  });
  const positive = [statement(absentA), statement(absentB)];
  const unrelated = statement(wrongSubject, "Receipt copy");
  const apply = (input) => transaction(app.db, (tx) => assessment.applyAssessmentUpdate(tx, input));
  const receiptVersions = [a, b, inventory, restriction, related];
  let alternateObligation;
  await transaction(app.db, async (tx) => {
    const { rows: [revision] } = await tx.query(
      "SELECT source_token FROM assessment_revisions WHERE scope_id=$1 AND version=$2",
      [north.id, held.version],
    );
    await tx.query(
      `INSERT INTO harness_generations(id,project_id,scope_id,input_generation,source_token,sealed_at)
       VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
      [generation, project.id, north.id, held.inputGeneration, revision.source_token],
    );
    await tx.query(
      "INSERT INTO gateway_generations(project_id,scope_id,generation_id,sealed) VALUES($1,$2,$3,true)",
      [project.id, north.id, generation],
    );
    for (const file of receiptVersions) {
      for (const branch of ["A", "B"]) {
        const place = JSON.stringify([file.versionId, "1", absenceQuestion.id]);
        const id = randomUUID();
        await tx.query(
          `INSERT INTO harness_primary_places(generation_id,obligation_id,version_id,unit_key,branch,place,question_id)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [generation, id, file.versionId, place, branch, { unitId: "1" }, absenceQuestion.id],
        );
        await tx.query(
          `INSERT INTO gateway_primary(generation_id,id,branch,place,state,evidence_ref)
           VALUES($1,$2,$3,$4,'completed',$5)`,
          [generation, id, branch, place, file.versionId],
        );
        if (file === related && branch === "B") alternateObligation = id;
      }
    }
    for (const item of [...positive, unrelated]) {
      await tx.query(
        `INSERT INTO harness_observations(observation_id,project_id,scope_id,generation_id,question_id,job_id,finding)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [item.observationId, project.id, north.id, generation, absenceQuestion.id, randomUUID(), item],
      );
    }
  });
  const reviewAbsence = (findings) => ({ ...review, researchGenerationId: generation, findings });
  async function control(findings) {
    const snapshot = await current(north);
    const question = snapshot.questions.find(({ id }) => id === absenceQuestion.id);
    await apply({
      projectId: project.id, scopeId: north.id, eventId: randomUUID(), reason: "non-delivery control",
      changes: [{ questionId: question.id, expectedDependencyVersion: question.dependencyVersion,
        review: reviewAbsence(findings) }],
    });
    const next = (await current(north)).questions.find(({ id }) => id === question.id);
    assert.equal(next.outcome, "needs_review");
    assert.equal(next.machine.inventory, undefined);
    return next.dependencyVersion;
  }
  await control([]);
  await control([rule, ordinaryAbsence].map((item) => ({ ...finding(item), sourceRole: "reference" })));
  await control([positive[0]]);
  await control([positive[0], unrelated]);
  await app.db.query("UPDATE gateway_primary SET state='final_refusal' WHERE generation_id=$1 AND id=$2",
    [generation, alternateObligation]);
  const absenceDependency = await control(positive);
  await app.db.query("UPDATE gateway_primary SET state='completed' WHERE generation_id=$1 AND id=$2",
    [generation, alternateObligation]);
  const update = {
    projectId: project.id, scopeId: north.id, eventId: randomUUID(), reason: "independent address review",
    changes: [
      { questionId: conflictQuestion.id, expectedDependencyVersion: conflictQuestion.dependencyVersion,
        review: { ...review, findings: [finding(left), finding(right)] } },
      { questionId: absenceQuestion.id, expectedDependencyVersion: absenceDependency, review: reviewAbsence(positive) },
    ],
  };
  const applied = await apply(update);
  assert.deepEqual(await apply(update), { assessmentVersion: applied.assessmentVersion, replayed: true });
  await assert.rejects(apply({ ...update, reason: "changed replay" }), { code: "assessment_event_reused" });
  await assert.rejects(apply({ ...update, eventId: randomUUID() }), { code: "assessment_input_stale" });

  for (const [index, hold] of held.holds.entries()) {
    const request = {
      generation: hold.generation, reason: "Reviewed all applicable PDF originals.",
      impacts: [{ scopeId: north.id, assessmentVersion: applied.assessmentVersion, questionIds: [] }],
    };
    const resolvePath = `${p}/supplements/holds/${hold.id}/resolve`;
    if (index === 0) {
      const stale = { ...request, impacts: [{ ...request.impacts[0], assessmentVersion: held.version }] };
      assert.equal((await http("POST", resolvePath, 412, stale, hold.version)).code, "assessment_input_stale");
    }
    await http("POST", resolvePath, 200, request, hold.version);
    assert.equal((await current(north)).holds.length, held.holds.length - index - 1);
  }
  const evaluated = await current(north);
  const conflict = evaluated.questions.find(({ id }) => id === conflictQuestion.id);
  const absence = evaluated.questions.find(({ id }) => id === absenceQuestion.id);
  assert.equal(conflict.outcome, "confirmed_conflict");
  assert.equal(absence.outcome, "confirmed_missing");
  assert.equal(absence.machine.inventory.assessmentId, generation);
  assert.deepEqual(absence.machine.citations.map(({ href }) => href), [
    `/api/v1/evidence/${absentA.observation.evidenceId}`, `/api/v1/evidence/${absentB.observation.evidenceId}`,
  ]);
  assert.deepEqual(conflict.machine.citations.map(({ value, unit }) => [value, unit]),
    [["1.5", "mm"], ["0.0018", "m"]]);
  assert.equal(conflict.machine.citations[0].evidenceId, left.observation.evidenceId);
  assert.equal(conflict.machine.citations[1].evidenceId, right.observation.evidenceId);
  assert.equal((await current(south)).version, southStart.version);

  const beforeConfirm = await http("POST", `${p}/letters`, 422, {
    scopeId: north.id, recipient: base.addressee, items: [],
  });
  assert.equal(beforeConfirm.code, "no_eligible_items");
  await http("POST", confirmPath, 403, { action: "confirm", reason: "checked" }, conflict.version,
    { headers: { "x-csrf-token": "" } });
  const key = randomUUID();
  const decisionInput = { action: "confirm", reason: "Opened both physical sources.", requestExternal: true,
    startWorkCritical: true };
  const decision = await http("POST", confirmPath, 201, decisionInput, conflict.version, { key });
  assert.deepEqual(await http("POST", confirmPath, 201, decisionInput, conflict.version, { key }), decision);
  const stale = await http("POST", confirmPath, 412, decisionInput, conflict.version);
  assert.equal(stale.currentVersion, decision.version);
  const absenceDecision = await http("POST", `/questions/${absence.id}/decisions`, 201, {
    action: "confirm", reason: "Checked the delivery manifest and alternative sources.", requestExternal: true,
  }, absence.version);
  const sameReview = { ...update, eventId: randomUUID(), reason: "primary_research_update", changes: [
    { ...update.changes[0], expectedDependencyVersion: conflict.dependencyVersion },
  ] };
  assert.deepEqual(await apply(sameReview), { assessmentVersion: absenceDecision.assessmentVersion, replayed: false });
  assert.deepEqual(await apply(sameReview), { assessmentVersion: absenceDecision.assessmentVersion, replayed: true });
  const reread = await read(a, "A", "Thickness D1 1.5 mm", "1.5", "mm", undefined, true);
  assert.notEqual(reread.observation.id, left.observation.id);
  const repeated = await apply({ ...sameReview, eventId: randomUUID(), changes: [{
    ...sameReview.changes[0],
    review: { ...review, findings: [finding(right), finding(ordinaryAbsence), finding(reread)] },
  }] });
  assert.equal(repeated.assessmentVersion, absenceDecision.assessmentVersion);
  const repeatedQuestion = (await current(north)).questions.find(({ id }) => id === conflict.id);
  assert.deepEqual([repeatedQuestion.version, repeatedQuestion.dependencyVersion, repeatedQuestion.decision.id],
    [decision.version, conflict.dependencyVersion, decision.id]);
  assert.deepEqual(repeatedQuestion.machine.citations, conflict.machine.citations);
  const raw = await transaction(app.db, (tx) =>
    assessment.selectConfirmedGrounds(tx, { projectId: project.id, scopeId: north.id }));
  const withRevisions = await transaction(app.db, (tx) => assessment.selectConfirmedGrounds(tx, {
    projectId: project.id, scopeId: north.id, readDocumentRevision: assessment.createDocumentRevisionReader(reader),
  }));
  const conflictSource = withRevisions.items.find(({ kind }) => kind === "confirmed_conflict").citations;
  const absenceSource = withRevisions.items.find(({ kind }) => kind === "confirmed_missing").citations;
  assert.deepEqual(conflictSource.map(({ documentRevision }) => documentRevision.label), ["N04", "N06"]);
  assert.deepEqual(absenceSource.map(({ address, versionId, documentRevision }) => [
    address.locator.line, versionId, documentRevision.label, documentRevision.address.locator.line,
  ]), [[2, inventory.versionId, "N05", 1], [2, inventory.versionId, "N05", 1]]);
  for (const [index, { citations }] of raw.items.entries()) {
    const enriched = withRevisions.items[index].citations;
    assert.deepEqual(enriched.map(({ documentRevision, ...citation }) => citation), citations);
    assert.equal(citations.some(({ documentRevision }) => documentRevision), false);
  }
  const northNow = await current(north);
  const conclusion = await http("POST", `${p}/conclusions`, 201, {
    scopeId: north.id, startWork: "can_start_with_limitations",
    reason: "The perimeter can be designed while the finish thickness remains open.",
  }, northNow.version);
  assert.equal((await current(north)).conclusion.startWork, "can_start_with_limitations");

  const southQuestion = southStart.questions.find(({ requirement }) => requirement.partId === schedule.key);
  const southPath = `/questions/${southQuestion.id}/decisions`;
  await http("POST", southPath, 422, { action: "confirm", reason: "Empty search", requestExternal: true },
    southQuestion.version);
  await http("POST", southPath, 422, { action: "correct", outcome: "covered", reason: "No addressable evidence" },
    southQuestion.version);
  const corrected = await http("POST", southPath, 201, {
    action: "correct", outcome: "needs_review", reason: "The selected facade needs more reading.",
  }, southQuestion.version);
  const southDecision = await http("POST", southPath, 201, {
    action: "exclude", reason: "Delayed work package.", exclusion: { kind: "work_without_data", until: null },
  }, corrected.version);
  assert.equal(southDecision.outcome, "excluded");
  const southRevoked = await http("POST", `/questions/${southQuestion.id}/decisions`, 201, {
    action: "revoke", reason: "Work package resumed.",
  }, southDecision.version);
  assert.equal(southRevoked.outcome, "needs_review");

  const letter = await http("POST", `${p}/letters`, 201, {
    scopeId: north.id, recipient: base.addressee,
    items: [{ questionId: conflict.id, questionVersion: decision.version, decisionId: decision.id }],
  });
  const missingLetter = await http("POST", `${p}/letters`, 201, {
    scopeId: north.id, recipient: base.addressee,
    items: [{ questionId: absence.id, questionVersion: absenceDecision.version, decisionId: absenceDecision.id }],
  });
  const missingText = await http("GET", `/letters/${missingLetter.id}/current-text`, 200, undefined, missingLetter.version);
  assert.match(missingText.text, /Inventory\.txt/u);
  assert.match(missingText.text, /строка 2/u);
  assert.match(missingText.text, /N05/u);
  const missingSnapshot = await http("GET", `/letters/${missingLetter.id}/revisions/${missingLetter.revisionId}`, 200);
  assert.deepEqual(missingSnapshot.items[0].sources.map(({ address }) => address), absenceSource);
  assert.doesNotMatch(missingText.text, /Restriction\.pdf|Related-item\.pdf/u);
  const text = await http("GET", `/letters/${letter.id}/current-text`, 200, undefined, letter.version);
  assert.match(text.text, /A-current\.pdf[\s\S]*1\.5 mm/u);
  assert.match(text.text, /B-current\.pdf[\s\S]*0\.0018 m/u);
  assert.match(text.text, /N04/u);
  assert.match(text.text, /N06/u);
  const conflictSnapshot = await http("GET", `/letters/${letter.id}/revisions/${letter.revisionId}`, 200);
  assert.deepEqual(conflictSnapshot.items[0].sources.map(({ address }) => address), conflictSource);
  const assembled = conflictSnapshot.items[0].sources.find(({ address }) => address.observationId === left.observation.id);
  assert.deepEqual(assembled.address.components, left.observation.components);
  assert.equal(conflictSnapshot.items[0].sources.some(({ address }) =>
    address.observationId === right.observation.id && address.components === undefined), true);

  const recorded = await http("POST", `/letters/${letter.id}/sent`, 201, {
    revisionId: letter.revisionId,
    itemIds: conflictSnapshot.items.map(({ id }) => id),
    recipient: base.addressee,
    text: text.text,
    sentAt: new Date().toISOString(),
  });
  const oldSentPath = `/letters/${letter.id}/sent/${recorded.id}`;
  const oldSent = await http("GET", oldSentPath, 200);
  assert.equal(oldSent.items[0].sources.length, 2);
  const pendingReceipt = await http("POST", `${p}/receipts`, 201, {});
  const pending = await upload("Pending new data", "North revision.pdf", [north.id], false, pendingReceipt.receiptId);
  await http("GET", `/letters/${letter.id}/current-text`, 409, undefined, letter.version);
  assert.equal((await current(south)).holds.length, 0);
  const duringHold = await current(north);
  const interim = await apply({
    ...sameReview, eventId: randomUUID(),
    changes: duringHold.questions.map((question) => ({
      questionId: question.id,
      expectedDependencyVersion: question.dependencyVersion,
      review: { inputGeneration: duringHold.inputGeneration,
        completenessChecked: false, remaining: ["primary_coverage_pending"], findings: [] },
    })),
  });
  assert.equal(interim.assessmentVersion, duringHold.version);
  const decisionsDuringHold = await current(north);
  assert.deepEqual(decisionsDuringHold.questions, duringHold.questions);
  assert.equal(decisionsDuringHold.conclusion.id, conclusion.id);
  await http("POST", `/uploads/${pending.uploadId}/cancel`, 200, {});
  assert.equal((await current(north)).holds.length, 0);
  assert.equal((await http("GET", `/letters/${letter.id}/current-text`, 200, undefined, letter.version)).text, text.text);

  const changed = await catalog([{ ...thickness, formats: ["dwg"] }, schedule]);
  const projectBeforeRepin = await http("GET", p, 200);
  assert.equal(projectBeforeRepin.version, pinned.version);
  await http("PUT", `${p}/catalog`, 200, { catalogVersionId: changed.id }, projectBeforeRepin.version);
  const after = await current(north);
  assert.equal(after.catalogVersionId, changed.id);
  assert.deepEqual(after.change.affectedQuestionIds, [conflict.id]);
  assert.deepEqual(after.change.previousDecisionIds, [decision.id]);
  assert.equal(after.questions.find(({ id }) => id === conflict.id).outcome, "needs_review");
  assert.equal(after.questions.find(({ id }) => id === absence.id).version, absenceDecision.version);
  await http("GET", `/letters/${letter.id}/current-text`, 412, undefined, letter.version);
  const past = await http("GET", `${p}/assessments/${conclusion.version}?scopeId=${north.id}`, 200);
  assert.equal(past.catalogVersionId, rules.id);
  assert.equal(past.historical, true);
  assert.equal(past.questions.find(({ id }) => id === conflict.id).decision.id, decision.id);
  assert.equal(past.questions.find(({ id }) => id === conflict.id).machine.citations.length, 2);

  const nextReceipt = await http("POST", `${p}/receipts`, 201, {});
  await upload("Finish schedule included in this delivery", "Schedule.pdf", [north.id], true, nextReceipt.receiptId);
  await http("POST", `/receipts/${nextReceipt.receiptId}/seal`, 200, {});
  const revised = await current(north);
  assert.equal(revised.change.reason, "research_inventory_changed");
  assert.deepEqual(revised.change.affectedQuestionIds, [absence.id]);
  assert.deepEqual(revised.change.previousDecisionIds, [absenceDecision.id]);
  assert.equal(revised.questions.find(({ id }) => id === absence.id).outcome, "needs_review");
  assert.equal((await current(south)).questions.find(({ id }) => id === southQuestion.id).version, southRevoked.version);
  const lateHold = revised.holds.find((hold) => hold.receiptId === nextReceipt.receiptId);
  await http("POST", `${p}/supplements/holds/${lateHold.id}/resolve`, 200, {
    generation: lateHold.generation, reason: "Late applicable material recorded.",
    impacts: [{ scopeId: north.id, assessmentVersion: revised.version, questionIds: [] }],
  }, lateHold.version);
  await http("GET", `/letters/${missingLetter.id}/current-text`, 412, undefined, missingLetter.version);

  // Re-establish the conflict under the original formats, then replace only its schedule source.
  const currentProject = await http("GET", p, 200);
  await http("PUT", `${p}/catalog`, 200, { catalogVersionId: rules.id }, currentProject.version);
  const beforeReplacement = await current(north);
  const target = beforeReplacement.questions.find(({ id }) => id === conflict.id);
  const independent = beforeReplacement.questions.find(({ id }) => id === absence.id);
  const publishValues = (assessmentSnapshot, question, findings) => apply({
    projectId: project.id, scopeId: north.id, eventId: randomUUID(), reason: "primary_research_update",
    changes: [{ questionId: question.id, expectedDependencyVersion: question.dependencyVersion,
      review: { ...review, inputGeneration: assessmentSnapshot.inputGeneration, findings } }],
  });
  await publishValues(beforeReplacement, target, [finding(left), finding(right)]);
  const newConflict = (await current(north)).questions.find(({ id }) => id === target.id);
  const priorDecision = await http("POST", confirmPath, 201, decisionInput, newConflict.version);
  const independentDecision = await http("POST", `/questions/${independent.id}/decisions`, 201,
    { action: "confirm", reason: "Continue investigating the unrelated finish schedule." }, independent.version);

  const replacementReceipt = await http("POST", `${p}/receipts`, 201, {});
  const replacementFile = await upload(["Revision N07", "Thickness D1 1.5 mm"], "B-revised.pdf",
    [north.id], true, replacementReceipt.receiptId, b.versionId);
  assert.equal(replacementFile.documentId, b.documentId);
  await http("POST", `/receipts/${replacementReceipt.receiptId}/seal`, 200, {});
  const replacement = await read(replacementFile, "B", "Thickness D1 1.5 mm", "1.5", "mm");
  const { publishReaderObservation } = await fromBuild("src/modules/questions/reader.js");
  await transaction(app.db, (tx) => publishReaderObservation(tx, {
    observation: replacement.observation, projectId: project.id, scopeId: north.id, readerJobId: randomUUID(),
    subject: "D1 thickness", property: thickness.part, role: "design", revision: "effective",
    assessmentQuestionId: target.id, replacesConfirmed: true,
  }));
  const replacementPending = await current(north);
  const affected = replacementPending.questions.find(({ id }) => id === target.id);
  assert.deepEqual(replacementPending.change.affectedQuestionIds, [target.id]);
  assert.equal(affected.decision, null);
  assert.equal(affected.previousDecisionId, priorDecision.id);
  assert.equal(affected.outcome, "needs_review");
  assert.deepEqual(affected.machine.citations.map(({ observationId }) => observationId), [left.observation.id]);
  assert.equal(replacementPending.questions.find(({ id }) => id === independent.id).decision.id, independentDecision.id);
  await assert.rejects(publishValues(replacementPending, newConflict, [finding(left), finding(replacement)]),
    { code: "assessment_input_stale" });
  await publishValues(replacementPending, affected, [finding(left), finding(replacement)]);
  const replaced = await current(north);
  const settled = replaced.questions.find(({ id }) => id === target.id);
  assert.equal(settled.outcome, "covered");
  assert.deepEqual(settled.machine.citations.map(({ versionId }) => versionId), [a.versionId, replacementFile.versionId]);
  const retained = replaced.questions.find(({ id }) => id === independent.id);
  assert.deepEqual([retained.version, retained.decision.id], [independentDecision.version, independentDecision.id]);
  const earlier = await http("GET", `${p}/assessments/${priorDecision.assessmentVersion}?scopeId=${north.id}`, 200);
  const preserved = earlier.questions.find(({ id }) => id === target.id);
  assert.deepEqual(preserved.decision.basis.citations.map(({ versionId }) => versionId), [a.versionId, b.versionId]);


  // A third reviewed original introduces a conflict against two independent agreeing originals.
  const furtherReceipt = await http("POST", `${p}/receipts`, 201, {});
  const furtherFile = await upload(["Revision N08", "Thickness D1 0.0018 m"], "Third original.pdf",
    [north.id], true, furtherReceipt.receiptId);
  await http("POST", `/receipts/${furtherReceipt.receiptId}/seal`, 200, {});
  const thirdA = await read(furtherFile, "A", "Thickness D1 0.0018 m", "0.0018", "m");
  const thirdB = await read(furtherFile, "B", "Thickness D1 0.0018 m", "0.0018", "m");
  const withThirdInput = await current(north);
  await publishValues(withThirdInput, settled, [finding(left), finding(replacement), finding(thirdA), finding(thirdB)]);
  const allSupports = await current(north);
  const conflictWithThree = allSupports.questions.find(({ id }) => id === target.id);
  assert.equal(conflictWithThree.outcome, "confirmed_conflict");
  const versionIds = [a.versionId, replacementFile.versionId, furtherFile.versionId].sort();
  assert.deepEqual(conflictWithThree.machine.citations.map(({ versionId }) => versionId).sort(), versionIds);
  for (const hold of allSupports.holds) {
    await http("POST", `${p}/supplements/holds/${hold.id}/resolve`, 200, {
      generation: hold.generation, reason: "Verified this contribution before opening the letter.",
      impacts: [{ scopeId: north.id, assessmentVersion: allSupports.version, questionIds: [] }],
    }, hold.version);
  }
  const decisionWithThree = await http("POST", confirmPath, 201, decisionInput, conflictWithThree.version);
  const newLetter = await http("POST", `${p}/letters`, 201, {
    scopeId: north.id, recipient: base.addressee,
    items: [{ questionId: target.id, questionVersion: decisionWithThree.version, decisionId: decisionWithThree.id }],
  });
  const newSnapshot = await http("GET", `/letters/${newLetter.id}/revisions/${newLetter.revisionId}`, 200);
  assert.deepEqual(newSnapshot.items[0].sources.map(({ address }) => address.versionId).sort(), versionIds);
  const newText = await http("GET", `/letters/${newLetter.id}/current-text`, 200, undefined, newLetter.version);
  assert.match(newText.text, /Third original\.pdf/u);
  assert.deepEqual(await http("GET", oldSentPath, 200), oldSent);

});
