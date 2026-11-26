import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Fastify from "fastify";
import pg from "pg";

const built = (path) => import(new URL(`../../../dist/src/modules/${path}.js`, import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const recipient = "Customer";

test("published readings resolve applicable catalog rows with addressed values and keep open neighbors visible", async (t) => {
  const { convertFact } = await built("assessment/facade-input");
  const { facadeReview, requirementsFor, unambiguousCatalogSubjects } = await built("assessment/facade-model");
  const { evaluate } = await built("assessment/domain");
  const { facadeVerdict } = await built("assessment/facade-semantic");
  const catalog = JSON.parse(readFileSync(new URL("../../../infra/catalogs/intake-stage-1.json", import.meta.url)));
  const context = { id: "common", kind: "common", facadeId: null, name: "Общий уровень" };
  const stage = "Стадия 1";
  const requirements = requirementsFor(catalog.requirements, context, stage);
  assert.equal(requirements.length, 16);
  const boundary = { complete: false, reason: "open", basisIds: [] };
  const coverage = { inventory: boundary, map: boundary, reading: boundary, subject: boundary };
  function reading(branch, { subject, text = subject, value, unit, format = "pdf", role = "drawing", name = format,
    line = 1, original, revision = "R1", revisionStatus = "current", versionId = name, variant = null, box } = {}) {
    const source = { projectId: "project", versionId, documentId: name, sha256: sha(name) };
    const address = { unitId: "1", locator: { line }, ...(box ? { box } : {}) };
    const lineId = "line-" + line;
    const id = [name, line, branch].join("-");
    const fact = {
      id, windowId: versionId, branch, attribute: subject, sourceRole: role, designStage: null,
      revision, revisionStatus, variant, basis: { role: "Document role", revision: revision + " current" },
      binding: { state: "common", candidates: [], quote: "Common material", version: 1, actorId: null }, materials: [],
      evidenceHref: "/sources/" + id, observation: { id, branch, source, address, lineId, quote: text, value, unit,
        evidenceId: id, readerVersion: "reader", receiptId: "intake", runId: "run-" + branch, grounding: "text" },
    };
    return convertFact(fact, new Map([[versionId, { id: versionId, label: name, documentId: name, sha256: source.sha256 }]]),
      new Map([[versionId, format]]), new Map(), new Map(),
      original === null ? undefined : original ?? [{ id: lineId, text, locator: address.locator }], true);
  }
  const both = (fixture) => ["A", "B"].map((branch) => reading(branch, fixture));
  function assess(key, facts, rows = requirements, reviewCoverage = coverage) {
    const requirement = rows.find(({ positionId }) => positionId === key);
    const review = facadeReview({ context, stage, questionId: key, requirement, facts, pairs: [], coverage: reviewCoverage,
      versionIds: ["intake"], supplementReceiptIds: [], legacyPresenceSubjects: unambiguousCatalogSubjects(rows) });
    return evaluate(requirement, review);
  }
  const facades = { subject: "Чертежи фасадов", format: "dxf" };
  await t.test("equivalent format and an unfinished neighboring place", () => {
    const local = assess("doc.facades", both(facades));
    assert.equal(local.outcome, "covered");
    assert.equal(local.citations.length, 2);
    assert.equal(assess("doc.facades", both({ ...facades, format: "pdf" })).outcome, "needs_review");
    assert.equal(facadeVerdict(coverage, [], [{ machine: local, semanticRemainder: { state: "open" } }]), "mixed");
    const unfinished = reading("A", { ...facades, line: 2, text: "Неразобранный соседний лист" });
    const mixed = assess("doc.facades", [...both(facades), unfinished]);
    assert.equal(mixed.outcome, "covered");
    const complete = Object.fromEntries(Object.keys(coverage).map((axis) => [axis, { complete: true }]));
    assert.equal(facadeVerdict(complete, [], [{ machine: mixed, semanticRemainder: { state: "complete" } }]), "mixed");
  });
  await t.test("different source occurrences or printed revisions do not corroborate one place", () => {
    assert.equal(assess("doc.facades", [reading("A", facades), reading("B", { ...facades, versionId: "different-occurrence" })])
      .outcome, "needs_review");
    assert.equal(assess("doc.facades", [reading("A", facades), reading("B", { ...facades, revision: "R2" })])
      .outcome, "needs_review");
  });
  await t.test("legacy facts can prove literal presence only using their own journal line and an unambiguous catalog subject", () => {
    const storedAsCurrent = { ...facades, original: [{id:"line-1", text:facades.subject + " (черновик) | Revision R1 current"}] };
    assert.equal(assess("doc.facades", both(storedAsCurrent)).outcome, "needs_review");
    const bare = { ...facades, subject: null, text: "Чертежи фасадов" };
    const titled = { ...bare, text: "Заголовок: Чертежи фасадов | Drawing" };
    assert.equal(assess("doc.facades", both(bare)).outcome, "covered");
    assert.equal(assess("doc.facades", both(titled)).outcome, "covered");
    const missingJournal = assess("doc.facades", both({ ...bare, original: null }));
    assert.equal(missingJournal.outcome, "needs_review");
    assert.equal(missingJournal.citations.length, 2);
    assert.equal(assess("doc.facades", both({ ...bare, original: [{ id: "line-1", text: "Чертежи фасадов не переданы" }] }))
      .outcome, "needs_review");
    assert.equal(assess("doc.facades", both({ ...bare, text: "Опись | Чертежи фасадов", role: "inventory" })).outcome, "needs_review");
    const other = { ...requirements.find(({ positionId }) => positionId === "doc.facades"), positionId: "other" };
    assert.equal(assess("doc.facades", both(bare), [...requirements, other]).outcome, "needs_review");
  });
  await t.test("a required signed or approved original needs an addressed act and named signer in both readings", () => {
    const key = "doc.facade_brief";
    const brief = { subject: "Техническое задание НВФ", role: "brief" };
    const full = Object.fromEntries(Object.keys(coverage).map((axis) => [axis, { complete: true }]));
    for (const marker of ["", " | Подпись: __________", " | Подписанное техническое задание", " | Не подписано",
      " | Подписано: ______", " | Подписано: Фамилия Имя Отчество", " | Подписано: Главный Инженер", " | Будет подписано: Иванов И.И.",
      " | Подписано: Иванов И.И. | Подпись аннулирована"]) {
      const incomplete = assess(key, both({ ...brief, text: brief.subject + marker }), requirements, full);
      assert.equal(incomplete.outcome, "needs_review", marker);
      assert.equal(incomplete.readability, "readable");
      assert.equal(incomplete.citations.length, 2);
    }
    const signed = { ...brief, text: brief.subject + " | Подписано: Иванов И.И." };
    assert.equal(assess(key, both(signed)).outcome, "covered");
    assert.equal(assess(key, both({ ...brief, text: brief.subject + " | Утверждено: Иванов Иван Иванович" })).outcome, "covered");
    assert.equal(assess(key, [reading("A", signed), reading("B", brief)]).outcome, "needs_review");
    assert.equal(assess(key, [reading("A", signed), reading("B", { ...signed, text: brief.subject + " | Подписано: Петров П.П." })])
      .outcome, "needs_review");
    assert.equal(assess(key, both({ ...signed, original: null })).outcome, "needs_review");
    assert.equal(assess(key, both({
      ...brief, original: [{ id: "line-1", text: brief.subject }, { id: "neighbor", text: "Подписано: Иванов И.И." }],
    })).outcome, "needs_review");
    const onSeparateLine = { ...brief, original: [
      { id: "line-1", text: brief.subject },
      { id: "signature", text: "Подписано: Иванов И.И.", locator: { line: 2 } },
    ] };
    const proven = assess(key, both(onSeparateLine));
    assert.equal(proven.outcome, "covered");
    assert.deepEqual(proven.citations.map(({ documentApproval }) => [documentApproval.address.locator.line, documentApproval.quote]),
      [[2, "Подписано: Иванов И.И."], [2, "Подписано: Иванов И.И."]]);
    const otherRevision = { ...onSeparateLine, original: [onSeparateLine.original[0],
      { ...onSeparateLine.original[1], text: "Подписано: Иванов И.И. | Редакция R2" }] };
    assert.equal(assess(key, both(otherRevision)).outcome, "needs_review");
    const draft = both({ ...brief, text: brief.subject + " (черновик)", revisionStatus: "unknown" });
    assert.equal(assess(key, draft).readability, "readable");
    const old = requirements.find(({ positionId }) => positionId === key);
    const review = facadeReview({ context, stage, questionId: key, requirement: old, facts: draft, pairs: [], coverage: full,
      versionIds: ["intake"], supplementReceiptIds: [], semanticBasisIds: ["A", "B"],
      clarification: { inventories: [{ receiptId: "receipt", number: "1", revision: "1" }], places: [], alternatives: [], semanticBasisIds: ["A", "B"] } });
    assert.equal(review.clarification, undefined);
    assert.equal(review.inventory, undefined);
    const legacyRows = [{ ...old, part: brief.subject, subject: brief.subject, completeness: "Проверить назначение задания." }];
    assert.equal(assess(key, both(brief), legacyRows).outcome, "covered");
  });
  await t.test("all categorical and numeric cladding parameters have their own addressed fields", () => {
    const material = { subject: "Материал облицовки", text: "Материал облицовки: керамогранит", value: "керамогранит", line: 1 };
    const thickness = { subject: "Толщина облицовки", text: "Толщина облицовки 12 мм", value: "12", unit: "мм", line: 2 };
    const zone = { subject: "Зона применения облицовки", text: "Зона применения облицовки — цоколь", value: "цоколь", line: 3 };
    const attachment = { subject: "Способ крепления облицовки", text: "Способ крепления облицовки = кляммеры", value: "кляммеры", line: 4 };
    const withoutMaterial = [thickness, zone, attachment].flatMap(both);
    assert.equal(assess("data.cladding", withoutMaterial).outcome, "needs_review");
    const covered = assess("data.cladding", [...both(material), ...withoutMaterial]);
    assert.equal(covered.outcome, "covered");
    assert.equal(covered.citations.length, 8);
    assert.equal(assess("data.cladding", [...both({ ...material, text: "Материал облицовки: неизвестен | Отделка пола: керамогранит" }),
      ...withoutMaterial]).outcome, "needs_review");
    assert.equal(assess("data.cladding", [...both({ ...material, text: "Материал облицовки упоминается в описании керамогранита" }),
      ...withoutMaterial]).outcome, "needs_review");
    assert.equal(assess("data.cladding", [...both({ ...material,
      text: "Материал облицовки: керамогранит или фиброцемент" }), ...withoutMaterial]).outcome, "needs_review");
    const parameters = [material, thickness, zone, attachment];
    const variant = (name, parameters) =>
      parameters.flatMap((fixture) => both({ ...fixture, name: "drawing-" + name, variant: name }));
    const assembly = variant("A1", parameters);
    assert.equal(assess("data.cladding", assembly).outcome, "covered");
    assert.equal(assess("data.cladding", [...variant("A1", parameters.slice(0, 2)), ...variant("B2", parameters.slice(2))])
      .outcome, "needs_review");
    assert.equal(assess("data.cladding", [...assembly, ...variant("B2", [material])]).outcome, "needs_review");
    assert.equal(assess("data.cladding", [...assembly, ...variant("B2", parameters)]).outcome, "covered");
  });
});

test("assessment applies an alias only to an unambiguous catalog position", async () => {
  const { requirementsFor } = await built("assessment/facade-model");
  const { matchesRequirementSubject } = await built("assessment/domain");
  const context = { id: "common", kind: "common", facadeId: null, name: "Общий уровень" };
  const row = { level: "common", applicability: "stage:P", formats: ["pdf"], equivalents: [], sourceRoles: ["drawing"],
    completenessCriterion: "Addressed", addressee: "Customer" };
  const [a, b] = requirementsFor([
    { ...row, key: "a", part: "Узлы крепления", aliases: ["Сборочный лист", "Схема X‐3"] },
    { ...row, key: "b", part: "Сборочные единицы", aliases: ["Сборочный лист", "Узлы крепления"] },
  ], context, "P");
  assert.equal(matchesRequirementSubject(a, "Сборочный лист"), false);
  assert.equal(matchesRequirementSubject(b, "Сборочный лист"), false);
  assert.equal(matchesRequirementSubject(b, "Узлы крепления"), false);
  assert.equal(matchesRequirementSubject(a, "Узлы крепления"), true);
  assert.equal(matchesRequirementSubject(a, "схема X‑3"), true);
});

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
      supplementReceiptIds, semanticBasisIds: ["verified-A", "verified-B"], ...options,
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
  assert.equal(decide([a, conflict], partial, pairs, [], { stage: "Стадия 1" }).outcome, "confirmed_conflict");
  assert.equal(decide([a, { ...conflict, stage: "RD" }], partial, pairs, [], { stage: "Стадия 1" }).outcome, "needs_review");
  assert.equal(decide([a, { ...conflict, membership: { kind: "facades", facadeIds: ["f1", "f2"] } }], partial, pairs)
    .outcome, "needs_review");
  const needsTitle = { ...conflict, printedRevision: null, variant: null, addressedValue: true,
    finding: { ...conflict.finding, applicability: "unknown" } };
  assert.equal(decide([a, needsTitle], partial, pairs).outcome, "confirmed_conflict");
  assert.equal(decide([a, { ...needsTitle, stage: null }], partial, pairs).outcome, "needs_review");
  assert.equal(decide([a, conflict], partial, pairs, ["supplement"]).outcome, "needs_review");
  const negative = ["A", "B"].map((branch) => fact(branch, { kind: "absence", role: "inventory", document: "inventory" }));
  assert.equal(decide(negative).outcome, "needs_review");
  assert.equal(decide(negative, covered).outcome, "confirmed_missing");
  assert.equal(decide(negative, covered, [], [], { semanticBasisIds: [] }).outcome, "needs_review");
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
  skip: !runDatabase, timeout: process.env.FACADE_PACKAGE_BROWSER === "1" ? 720_000 : 420_000,
}, async (t) => {
  const { bootstrapAdmin } = await built("access/bootstrap");
  const { createRuntimePdfService } = await built("pdf/index");
  const { createGateway, transaction } = await built("gateway/index");
  const { preparePackageMap, dispatchPackagePair } = await built("harness/package-dispatch");
  const { schedulePackageReview } = await built("harness/package-review");
  const { reconcileNextFacadeDiscovery } = await built("harness/facade-discovery");
  const { dispatchPackageFollowup, packageFollowupKind, packageStructure, savePackageBlocks, saveSemanticCheck,
    scanPackageStructure } = await built("harness/package-walk");
  const { pairSourceEvidence } = await built("harness/pair-evidence");
  const { publication } = await built("harness/publication");
  const { researchKind } = await built("harness/runner");
  const { passwordHash } = await built("access/auth");
  const withBrowser = process.env.FACADE_PACKAGE_BROWSER === "1";
  const withD8Browser = process.env.FACADE_D8_BROWSER === "1";
  let browserRoute;
  let origin = "http://localhost:3000";
  if (withBrowser || withD8Browser) {
    const { openPackageBrowser } = await import("../../../web/e2e/package-browser.mjs");
    browserRoute = await openPackageBrowser();
    t.after(() => browserRoute.close());
    origin = browserRoute.origin;
  }
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = Fastify();
  app.decorate("db", db);
  app.decorate("config", { dataDir: process.env.FACADE_DATA_DIR });
  for (const name of ["access", "intake", "pdf", "assessment", "letters", "questions", "supplements"]) {
    await app.register((await built(`${name}/index`)).register);
  }
  await app.register((await built("harness/stops")).register);
  const reader = createRuntimePdfService(db, app.config);
  t.after(async () => { await reader.close(); await app.close(); await db.end(); });
  const login = "package-assessment";
  const password = "synthetic-acceptance-only";
  const { userId, organizationId } = await bootstrapAdmin(db, { organization: "Synthetic", login, password });
  let session = {};
  const request = async (method, url, payload, options = {}) => {
    const headers = { origin, host: new URL(origin).host, ...session, "idempotency-key": randomUUID(), ...options.headers };
    if (options.version !== undefined) headers["if-match"] = `"${options.version}"`;
    const response = await app.inject({ method, url, payload, headers });
    assert.equal(response.statusCode, options.status ?? 200, `${method} ${url}: ${response.body}`);
    return response;
  };
  function credentials(response) {
    return { cookie: response.headers["set-cookie"].split(";")[0], "x-csrf-token": response.json().csrfToken };
  }
  session = credentials(await request("POST", "/api/sessions", { login, password }));
  const project = withBrowser
    ? await browserRoute.createProject(login, password, "Synthetic facades")
    : (await request("POST", "/api/projects", { mode: "intake", name: "Synthetic facades" }, { status: 201 })).json();
  const projectId = project.id;
  const base = `/api/v1/projects/${projectId}`;
  const assessment = () => request("GET", base + "/facade-assessment").then((response) => response.json());
  const pending = await assessment();
  assert.equal(pending.catalogVersionId, null);
  assert.equal(pending.profile.state, "no_approved_profile");
  assert.equal(pending.stage, "Стадия 1");
  assert.equal(project.stageStatus, "default");
  assert.deepEqual(pending.observations.counts, { common: 0, identified: 0, unclear: 0, unidentified: 0 });
  assert.equal((await request("GET", pending.observations.href)).json().items.length, 0);
  const scope = await db.query("SELECT count(*)::int AS count FROM project_scopes WHERE project_id=$1", [projectId]);
  assert.equal(scope.rows[0].count, 0);

  const fields = (key, part, level) => ({
    key, part, level, applicability: "stage:P", formats: ["pdf"], equivalents: [],
    sourceRoles: ["drawing"], completenessCriterion: "Addressed measure", addressee: recipient,
    evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "drawing" }] }] },
  });
  const thickness = { ...fields("thickness", "Thickness", "facade"), sourceRoles: ["drawing", "schedule"],
    comparison: { sources: ["drawing", "schedule"].map((sourceRole) => ({ sourceRole, valueRole: "design", priority: 5 })) },
    evidenceRule: { allOf: [{ anyOf: ["drawing", "schedule"].map((sourceRole) => ({ sourceRole, valueRole: "design" })) }] } };
  const catalog = (await request("POST", "/api/catalogs", {
    key: "synthetic", name: "Synthetic matrix",
    defaultProfile: { stage: "P", facadeKinds: ["panel"], approvalReference: "Synthetic rule" },
    requirements: [thickness, { ...thickness, key: "mount", part: "Mount spacing" }, fields("width", "Width", "facade"), fields("clearance", "Clearance", "common")],
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
  async function uploadReceipt(places, targetProjectId = projectId) {
    const manifest = places.map((place) => {
      const data = pdf(place.quote);
      const itemId = randomUUID();
      fixtures.set(sha(data), place);
      return { place, data, item: { itemId, kind: "file", relativePath: place.filename, size: data.length,
        mediaType: "application/pdf", sha256: sha(data), replacesVersionId: place.replacesVersionId } };
    });
    const { receiptId } = (await request("POST", `/api/projects/${targetProjectId}/receipts`, {
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
  async function finishReading(walk = false) {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (!await preparePackageMap(db, gateway, reader, [])) break;
    }
    const stops = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const worked = await dispatchPackagePair(db, gateway, profile, walk);
      if (walk) for (let scan = 0; scan < 25; scan++) if (!await scanPackageStructure(db, reader)) break;
      let work;
      while ((work = await gateway.claim({ workerId: `fixture-${randomUUID()}`, kinds: [researchKind], leaseMs: 60000 }))) {
        const { lease, projectId, scopeId, generationId, payload: job } = work;
        const task = { jobId: lease.jobId, projectId, scopeId, generationId, job };
        const { place, branch } = job;
        const fixture = fixtures.get(place.source.sha256);
        const readContext = { task, branch };
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
          ...(fixture.valueRole ? { valueRole: fixture.valueRole } : {}),
          stage: { value: fixture.stage ?? "P", quote: grounded.quote },
          revision: { value: fixture.revision, quote: grounded.quote, status: "current" },
          ...(fixture.register ? { subjectRegister: fixture.register } : {}),
          binding: fixture.facade ? {
            state: "identified", labels: [fixture.facade], quote: grounded.quote, reason: "Explicit address",
            projectIdentifiers: [{ label: fixture.facade, quote: grounded.quote }],
          } : { state: fixture.common ? "common" : "unidentified", labels: [], quote: grounded.quote, reason: "Printed scope" },
        };
        let blockChecks = [];
        if (job.packageWindow.walkProtocol) {
          const structure = await packageStructure(db, readContext);
          assert.equal(structure.limitation, null);
          const visual = structure.blocks.find(({ kind }) => kind === "visual");
          const render = visual && await reader.open(place.source, { runId: lease.jobId, branch, operationKey: "visual" }, {
            representation: "render", address: { unitId: place.unitId, box: visual.box },
          });
          blockChecks = structure.blocks.map(({ id, kind }) => ({ blockId: id,
            evidenceId: kind === "visual" ? render.evidence.id : evidence.id, reviewed: true,
            reason: "Reviewed the controlled addressed block" }));
        }
        await transaction(db, async (tx) => {
          await tx.query("INSERT INTO harness_research_events(job_id,sequence,event) VALUES ($1,1,$2)", [
            lease.jobId, { kind: "tool", reply: { evidence: { evidenceId: evidence.id }, body: { content: bytes.toString() } } },
          ]);
          const observation = await reader.pin(place.source, { runId: lease.jobId, branch, operationKey: "pin" }, grounded, tx);
          await publish.observation(tx, { task }, { ...grounded, package: details }, observation);
          if (blockChecks.length) await savePackageBlocks(tx, readContext, blockChecks);
          const outcome = { kind: "covered", observationIds: [observation.id] };
          assert.equal(await gateway.finish(lease, outcome, { state: "completed", evidenceRef: observation.id }, tx), true);
          await publish.outcome(tx, task, outcome);
        });
      }
      if (!worked) break;
    }
    for (let attempt = 0; attempt < 25; attempt++) if (!await reconcileNextFacadeDiscovery(db)) break;
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
  const drawing = (filename, attribute, value, revision, facade = "F1", role = "drawing") => {
    const roleQuote = role === "drawing" ? "Drawing" : "Schedule";
    return { filename, attribute, value, revision, facade, role, roleQuote,
      ...(["Thickness", "Mount spacing"].includes(attribute) ? { valueRole: { kind: "design", quote: "Design value" } } : {}),
      quote: `${roleQuote} ${attribute} ${value} mm | Design value | Stage P | Revision ${revision} current | Variant V1 | Scope: ${facade} | Project facade id: ${facade}` };
  };
  // A persisted result from the earlier publisher retained only the negative part of a contradictory line.
  const savedQuote = "Width not delivered | Stage P | Revision R9 current | Scope: F2 | Project facade id: F2 | Inventory";
  const initial = await uploadReceipt([
    drawing("first.pdf", "Thickness", "10", "R1"), drawing("second.pdf", "Thickness", "20", "R2", "F1", "schedule"),
    drawing("mount-plan.pdf", "Mount spacing", "11", "R1"), drawing("mount-schedule.pdf", "Mount spacing", "13", "R2", "F1", "schedule"),
    drawing("width.pdf", "Width", "100", "R3"),
    drawing("south.pdf", "Thickness", "200", "R4", "F2"),
    { filename: "common.pdf", attribute: "Clearance", value: "17", revision: "R5", common: true,
      quote: "Clearance 17 mm | Clearance | Drawing | Stage P | Revision R5 current | Applies to all facades",
      savedQuote: "17 mm | Clearance | Drawing | Stage P | Revision R5 current | Applies to all facades" },
    { ...drawing("later.pdf", "Other", "300", "R8", "F2"), deferred: true },
    { filename: "facade-type.pdf", attribute: "Facade type", facade: "F1", revision: "R10",
      quote: "Drawing | Facade type: panel | Stage P | Revision R10 current | Scope: F1 | Project facade id: F1" },
    { filename: "inventory.pdf", attribute: "Width", facade: "F2", revision: "R9", role: "inventory", roleQuote: "Inventory",
      quote: `Width delivered, ${savedQuote}`, savedQuote, statement: { status: "not_delivered", item: "Width" } },
  ]);
  if (withBrowser) await browserRoute.openInventory(projectId, initial);
  await finishReading();
  const observed = await assessment();
  assert.equal(observed.catalogVersionId, null);
  assert.equal(observed.contexts.filter(({ kind }) => kind === "facade").length, 2);
  assert.ok(observed.contexts.find(({ name }) => name === "F1").identity.sources.length >= 2);
  const kindBasis = (await request("GET", observed.observations.href + "?proposal=facadeKind")).json().items[0];
  assert.ok(kindBasis?.facadeKindSourceVerified);
  const firstFacade = observed.contexts.find(({ name }) => name === "F1");
  const secondFacade = observed.contexts.find(({ name }) => name === "F2");
  const stage = (await request("PUT", `/api/projects/${projectId}/stage`, {
    stage: "P", reason: "Stage P appears on the current drawing", evidenceIds: [kindBasis.evidenceId],
  }, { version: project.version })).json();
  const typeCommand = { kind: "panel", observationId: kindBasis.id, reason: "Exact project classification" };
  await request("PUT", base + `/facade-assessment/facades/${secondFacade.facadeId}/kind`, typeCommand,
    { version: stage.version, status: 422 });
  const assigned = (await request("PUT", base + `/facade-assessment/facades/${firstFacade.facadeId}/kind`, typeCommand,
    { version: stage.version })).json();
  assert.equal(assigned.facadeType.state, "confirmed");
  assert.equal(assigned.facadeType.basis.versionId, kindBasis.versionId);
  await request("PUT", base + "/facade-assessment/facade-kinds", {
    facadeKinds: ["panel"], reason: "Synthetic original",
  }, { version: assigned.version });
  const beforeVerification = await assessment();
  assert.equal(beforeVerification.profile.state, "active");
  assert.equal(beforeVerification.contexts.find(({ name }) => name === "F1").counts.confirmed_conflict, 0);
  const oldObservations = (await request("GET", beforeVerification.observations.href)).json().items;
  assert.ok(oldObservations.every(({ basis }) => basis.revisionEvidence === undefined));
  const schedule = oldObservations.filter(({ sourceRole, attribute }) => sourceRole === "schedule" && attribute === "Thickness");
  assert.equal(schedule.length, 2);
  const bind = (fact, state, version) => request("POST", `/api/projects/${projectId}/package-facts/${fact.id}/binding`, {
    state, candidateIds: [firstFacade.facadeId], reason: "Controlled check of the printed project identifier",
  }, { version });
  for (const fact of schedule) await bind(fact, "unclear", fact.binding.version);
  const unclear = await assessment();
  const gap = unclear.comparisonReview.items.find(({ reasons }) => reasons.includes("facade_link_unproven"));
  assert.ok(gap);
  assert.equal(gap.sources.length, 2);
  for (const source of gap.sources) await request("GET", source.citation.href);
  assert.equal(unclear.contexts.find(({ name }) => name === "F1").counts.confirmed_conflict, 0);
  for (const fact of schedule) await bind(fact, "identified", fact.binding.version + 1);
  const restored = await assessment();
  const restoredObservations = (await request("GET", restored.observations.href)).json().items;
  await verifyConflicts();
  const early = await assessment();
  assert.equal(early.catalogVersionId, catalog.id);
  assert.equal(early.coverage.inventory.complete, false);
  assert.equal(early.coverage.subject.complete, false);
  assert.equal(early.coverage.reading.complete, false);
  assert.equal(early.contexts.find(({ kind }) => kind === "common").questions[0].semanticRemainder.state, "open");
  const common = early.contexts.find(({ kind }) => kind === "common");
  assert.equal(common.counts.covered, 1, "Re-use the original numeric row from the legacy reader journal");
  assert.deepEqual(common.questions[0].machine.citations.map(({ branch, value }) => [branch, value]).sort(),
    [["A", "17"], ["B", "17"]]);
  const untypedFacade = early.contexts.find(({ name }) => name === "F2");
  assert.equal(untypedFacade.facadeType.state, "unconfirmed");
  assert.equal(untypedFacade.counts.covered, 1);
  assert.equal(untypedFacade.counts.needs_review, 2);
  const f2Width = early.contexts.find(({ name }) => name === "F2").questions.find(({ requirement }) => requirement.positionId === "width");
  assert.ok(f2Width.machine.citations.length > 0);
  assert.ok(f2Width.machine.citations.every(({ deliveryUncertainty }) => deliveryUncertainty === "contradictory_original"));
  assert.ok(f2Width.machine.limitations.includes("delivery_statement_conflict"));
  await request("POST", `/api/v1/questions/${f2Width.id}/decisions`, {
    action: "confirm", reason: "Contradictory inventory cannot enter a letter", requestExternal: true,
  }, { version: f2Width.version, status: 422 });
  assert.equal(early.contexts.find(({ name }) => name === "F1").counts.confirmed_conflict, 2);
  assert.ok(!early.comparisonReview.items.some(({ reasons }) => reasons.includes("facade_link_unproven")));
  const historicalGap = (await request("GET", base + `/facade-assessment/${unclear.version}`)).json();
  assert.deepEqual(historicalGap.comparisonReview, unclear.comparisonReview);
  const newObservations = (await request("GET", early.observations.href)).json().items;
  const titled = newObservations.find(({ basis }) => basis.revisionEvidence);
  assert.ok(titled);
  const historicalObservations = (await request("GET", beforeVerification.observations.href)).json().items;
  assert.deepEqual(historicalObservations, oldObservations);
  assert.equal(restoredObservations.find(({ id }) => id === titled.id).binding.version, titled.binding.version);
  const context = (summary) => summary.contexts.find(({ name }) => name === "F1");
  const question = (summary, key) => context(summary).questions.find(({ requirement }) => requirement.positionId === key);
  const decision = async (q, requestExternal = false) => (await request("POST", `/api/v1/questions/${q.id}/decisions`, {
    action: "confirm", reason: "Synthetic review", requestExternal,
  }, { version: q.version, status: 201 })).json();
  const conflict = question(early, "thickness");
  assert.ok(conflict.machine.citations.every(({ valueRoleBasis }) => valueRoleBasis?.kind === "design"));
  const confirmed = withBrowser ? await browserRoute.reviewConflict(projectId, context(early).assessmentContextId, conflict) : await decision(conflict, true);
  const mount = question(early, "mount");
  const mountDecision = withBrowser ? await browserRoute.reviewConflict(projectId, context(early).assessmentContextId, mount) : await decision(mount, true);
  const nearby = await decision(question(early, "width"));
  const decided = await assessment();
  const assessmentContextId = context(decided).assessmentContextId;
  if (withBrowser) await browserRoute.conclude(projectId, assessmentContextId, conflict.machine.citations[0].evidenceId);
  else await request("POST", base + "/conclusions", {
    assessmentContextId, startWork: "cannot_start", reason: "Synthetic start decision", basis: { kind: "citation", evidenceId: conflict.machine.citations[0].evidenceId },
  }, { version: context(decided).version, status: 201 });
  const savedConclusion = await assessment();
  assert.equal((await assessment()).version, savedConclusion.version, "Reading the saved conclusion must be side-effect free");
  const letter = withBrowser
    ? await browserRoute.createLetter(projectId, assessmentContextId, recipient, [conflict, mount], secondFacade.assessmentContextId)
    : (await request("POST", base + "/letters", {
        assessmentContextId, recipient, items: [{ questionId: conflict.id, questionVersion: confirmed.version, decisionId: confirmed.id },
          { questionId: mount.id, questionVersion: mountDecision.version, decisionId: mountDecision.id }],
      }, { status: 201 })).json();
  const letterPath = `/api/v1/letters/${letter.id}`;
  const saved = (await request("GET", letterPath + `/revisions/${letter.revisionId}`)).json();
  const text = (await request("GET", letterPath + "/current-text", undefined, { version: letter.version })).json();
  assert.match(text.text, /first.pdf/u);
  assert.match(text.text, /second.pdf/u);
  const exported = (await request("POST", letterPath + "/exports", { format: "txt" }, { status: 201, version: letter.version })).json();
  const sent = withBrowser ? await browserRoute.recordSending(projectId, assessmentContextId, letter, text.text) : (await request("POST", letterPath + "/sent", {
    revisionId: letter.revisionId, itemIds: saved.items.map(({ id }) => id), recipient, text: text.text,
    sentAt: new Date().toISOString(),
  }, { status: 201 })).json();
  await request("POST", `/api/receipts/${initial}/seal`, { manifestVersion: 1 });
  const supplement = await uploadReceipt([
    drawing("supplement-a.pdf", "Thickness", "15", "R6"), drawing("supplement-b.pdf", "Thickness", "15", "R7"),
  ]);
  await request("POST", base + "/supplements/links", {
    receiptId: supplement, letterId: letter.id, sentId: sent.id, itemId: saved.items.find(({questionId}) => questionId === conflict.id).id,
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
  if (withBrowser) await browserRoute.replaceSources(projectId, assessmentContextId, row, selected, old);
  else await request("POST", `/api/v1/questions/${row.id}/source-replacements`, { replacements: selected, replaced: old,
    reason: "Same project identifier and compatible new originals",
  }, { version: row.version, status: 201 });
  const updated = await assessment();
  assert.equal(question(updated, "thickness").machine.outcome, "covered");
  const eligibleAfter = (await request("GET", base + "/letters/eligible?assessmentContextId=" + assessmentContextId)).json();
  assert.deepEqual(eligibleAfter.items.map(({ questionId }) => questionId), [mount.id]);
  assert.deepEqual(saved.items.map(({ questionId }) => questionId).sort(), [conflict.id, mount.id].sort());
  assert.equal(question(updated, "width").decision.id, nearby.id);
  assert.equal(context(updated).questionHolds.length, 0);
  if (withBrowser) await browserRoute.checkHistory(projectId, assessmentContextId, letter, sent, text.text);
  assert.equal((await request("GET", sent.url)).json().text, text.text);
  assert.equal((await request("GET", exported.historicalUrl)).body, text.text);
  assert.equal((await request("GET", base + `/facade-assessment/${early.version}`)).json().outcome, early.outcome);
  assert.equal((await request("GET", early.observations.href + "?binding=common&limit=1")).json().items.length, 1);
  await request("POST", `/api/projects/${projectId}/package-facts/${kindBasis.id}/binding`, {
    state: "unidentified", candidateIds: [], reason: "Withdraw this facade attribution",
  }, { version: kindBasis.binding.version });
  const retracted = await assessment();
  assert.equal(context(retracted).facadeType.state, "stale");
  assert.equal(context(retracted).facadeType.basis.id, kindBasis.id);
  assert.equal(context((await request("GET", base + `/facade-assessment/${updated.version}`)).json()).facadeType.state, "confirmed");
  assert.equal(question(retracted, "width").decision.id, nearby.id);
  assert.equal((await request("GET", sent.url)).json().text, text.text);
  const { rows: [balance] } = await db.query("SELECT count(*)::int AS attempts FROM gateway_attempts WHERE project_id=$1", [projectId]);
  assert.equal(balance.attempts, 0);

  const currentProject = (await request("GET", `/api/projects/${projectId}`)).json();
  await request("PUT", base + "/facade-assessment/facade-kinds", {
    facadeKinds: ["masonry"], reason: "Not compatible with the selected matrix",
  }, { version: currentProject.project?.version ?? currentProject.version });
  const incompatible = await assessment();
  assert.ok(incompatible.limitations.includes("catalog_not_applicable"));
  assert.deepEqual((await request("GET", base + `/letters/eligible?assessmentContextId=${assessmentContextId}`)).json().items, []);

  await t.test("an individually evidenced facade selects its matrix and an independently proven omission enters a letter", async (omission) => {
    const next = (await request("POST", "/api/projects", { mode: "intake", name: "Synthetic non-delivery" }, { status: 201 })).json();
    const target = `/api/v1/projects/${next.id}`;
    const anchor = { ...fields("anchor", "Anchor plan", "facade"), applicability: "stage:RD", facadeKinds: ["panel"] };
    const inventory = { ...fields("inventory", "Package inventory", "facade"), applicability: "stage:RD",
      sourceRoles: ["inventory"], evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "inventory", mode: "presence" }] }] } };
    const variable = { ...fields("variable", "Variable profile clearance", "facade"), applicability: "stage:RD" };
    const expectedCatalog = (await request("POST", "/api/catalogs", {
      key: "synthetic-omission", name: "Synthetic RD matrix",
      defaultProfile: { stage: "RD", facadeKinds: ["panel"], approvalReference: "Synthetic rule" },
      requirements: [anchor, inventory, variable],
    }, { status: 201 })).json();
    await request("POST", "/api/catalogs", {
      key: "synthetic-mixed", name: "Synthetic mixed RD matrix",
      defaultProfile: { stage: "RD", facadeKinds: ["panel", "masonry"], approvalReference: "Synthetic alternative rule" },
      requirements: [anchor, inventory, { ...variable, completenessCriterion: "Separate check of the mixed layout" }],
    }, { status: 201 });
    for (const [branch, purpose] of [["A", "primary_a"], ["B", "primary_b"]]) {
      await gateway.grantRoute({ projectId: next.id, routeId: profile[branch].routeId, revision: "offline", purpose,
        dataClass: "synthetic", allowed: true });
    }
    const staged = (await request("PUT", `/api/projects/${next.id}/stage`, {
      stage: "RD", reason: "Owner confirms the design stage of the controlled receipt",
    }, { version: next.version })).json();
    const identity = "Stage: RD | Revision: RD1 current | Scope: E1 | Project facade id: E1";
    const commonQuote = "All common materials are listed";
    const register = "Complete list of facades: E1";
    const docs = await uploadReceipt([
      { filename: "register.pdf", attribute: "Package inventory", role: "inventory", roleQuote: "Inventory", stage: "RD",
        facade: "E1", revision: "RD1", quote: `Inventory | Package inventory | Facade type: panel | ${register} | ${commonQuote} | ${identity}`,
        register: { labels: ["E1"], quote: register, commonQuote } },
      { filename: "transmittal.pdf", attribute: "Anchor plan", role: "inventory", roleQuote: "Inventory", stage: "RD",
        facade: "E1", revision: "RD1", quote: `Inventory | Anchor plan not delivered | ${identity}`,
        statement: { status: "not_delivered", item: "Anchor plan" } },
    ], next.id);
    await request("POST", `/api/receipts/${docs}/seal`, { manifestVersion: 1 });
    await finishReading(true);
    const detected = (await request("GET", target + "/facade-assessment")).json();
    assert.equal(detected.profile.state, "facades_unconfirmed");
    const context = detected.contexts.find(({ name }) => name === "E1");
    const proposed = (await request("GET", detected.observations.href + "?proposal=facadeKind")).json().items[0];
    assert.ok(context && proposed.facadeKindSourceVerified);
    await request("PUT", target + `/facade-assessment/facades/${context.facadeId}/kind`, {
      kind: "panel", observationId: proposed.id, reason: "Verified type on the current register",
    }, { version: staged.version });
    const open = (await request("GET", target + "/facade-assessment")).json();
    assert.equal(open.catalogVersionId, expectedCatalog.id);
    assert.equal(open.profile.state, "active");
    const questionAt = (summary, key) => summary.contexts.find(({ facadeId }) => facadeId === context.facadeId)
      .questions.find(({ requirement }) => requirement.positionId === key);
    assert.equal(questionAt(open, "anchor").machine.outcome, "needs_review");
    const notYet = questionAt(open, "variable");
    const clarificationCommand = { action: "request_clarification", requestExternal: true, reason: "Engineer verified the package" };
    await request("POST", `/api/v1/questions/${notYet.id}/decisions`, clarificationCommand, { status: 422, version: notYet.version });
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!await dispatchPackageFollowup(db, gateway)) break;
      const work = await gateway.claim({ workerId: `proof-${randomUUID()}`, kinds: [packageFollowupKind], leaseMs: 60000 });
      assert.ok(work);
      const { lease, projectId, scopeId, generationId, payload: job } = work;
      const task = { jobId: lease.jobId, projectId, scopeId, generationId, job };
      const readContext = { task, branch: job.branch };
      const structure = await packageStructure(db, readContext);
      const basisIds = [...new Set(structure.earlierBranchChecks.map(({ evidenceId }) => evidenceId))];
      const outcome = { kind: "reviewed_no_match", evidenceIds: basisIds };
      await transaction(db, async (tx) => {
        for (const { positionId } of job.packageWindow.followup.semantic.positions) {
          await saveSemanticCheck(tx, readContext, { catalogVersionId: expectedCatalog.id, stage: "RD", facadeId: context.facadeId,
            positionId, basisIds, disposition: "alternatives_checked", reason: "Both addressed blocks checked for this requirement and alternatives" });
        }
        assert.ok(await gateway.finish(lease, outcome, { state: "completed", evidenceRef: basisIds[0] }, tx));
        await publish.outcome(tx, task, outcome);
      });
    }
    const proven = (await request("GET", target + "/facade-assessment")).json();
    assert.ok(Object.values(proven.coverage).every(({ complete }) => complete), JSON.stringify(proven.coverage));
    const q = questionAt(proven, "anchor");
    assert.equal(q.semanticRemainder.state, "complete");
    assert.equal(q.machine.outcome, "confirmed_missing");
    assert.ok(q.machine.citations.every(({ quote }) => quote.includes("Anchor plan not delivered")));
    const signed = await decision(q, true);
    const external = await request("POST", target + "/letters", { assessmentContextId: context.assessmentContextId,
      recipient, items: [{ questionId: q.id, questionVersion: signed.version, decisionId: signed.id }] }, { status: 201 });
    assert.ok(external.json().id);
    const silence = questionAt(proven, "variable");
    assert.equal(silence.machine.outcome, "needs_review");
    assert.equal(silence.clarification.inventories[0].receiptId, docs);
    assert.ok(silence.clarification.places.length >= 2);
    const clarification = (await request("POST", `/api/v1/questions/${silence.id}/decisions`, clarificationCommand,
      { version: silence.version, status: 201 })).json();
    const candidates = (await request("GET", target + "/letters/eligible?assessmentContextId=" + context.assessmentContextId)).json();
    const clarified = candidates.items.find(({ questionId }) => questionId === silence.id);
    assert.equal(clarified.kind, "clarification");
    assert.match(clarified.wording, /В проверенном комплекте по описи №\d+ сведения о «Variable profile clearance» найти не удалось\. Просим направить документ или указать, где приведены данные\./u);
    const clarificationLetter = (await request("POST", target + "/letters", { assessmentContextId: context.assessmentContextId,
      recipient, items: [{ questionId: silence.id, questionVersion: clarification.version, decisionId: clarification.id }] },
    { status: 201 })).json();
    const clarificationPath = "/api/v1/letters/" + clarificationLetter.id;
    const textExport = (await request("POST", clarificationPath + "/exports", { format: "txt" }, { status: 201, version: clarificationLetter.version })).json();
    const wordExport = (await request("POST", clarificationPath + "/exports", { format: "docx" }, { status: 201, version: clarificationLetter.version })).json();
    const beforeText = await request("GET", textExport.url);
    assert.match(beforeText.body, /Запрос на уточнение\./u);
    assert.match(beforeText.body, /Просим направить документ или указать, где приведены данные/u);
    const word = await request("GET", wordExport.url);
    assert.match(word.headers["content-type"], /officedocument/u);
    const xml = execFileSync("python3", ["-c", "import io,sys,zipfile; print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('word/document.xml').decode())"],
      { input: word.rawPayload, encoding: "utf8" });
    assert.match(xml, /Просим направить документ или указать, где приведены данные/u);
    const inventoryQuestion = questionAt(proven, "inventory");
    assert.equal(inventoryQuestion.machine.outcome, "covered");
    const inventoryDecision = await decision(inventoryQuestion);
    if (process.env.FACADE_FACT_REVIEW_BROWSER_SEED === "1") return;
    const beforeExclusion = (await request("GET", target + "/facade-assessment")).json();
    const address = questionAt(beforeExclusion, "anchor").machine.citations[0];
    const factPath = `${target}/package-facts/${address.observationId}/reviews`;
    const exclusion = { action: "exclude", reason: "Engineering review invalidates the saved nondelivery reading" };
    await request("POST", factPath, exclusion, { version: proven.version, status: 412 });
    const excluded = (await request("POST", factPath, exclusion, { version: beforeExclusion.version })).json();
    const afterExclusion = (await request("GET", target + "/facade-assessment")).json();
    const heldAnchor = questionAt(afterExclusion, "anchor");
    assert.equal(afterExclusion.version, excluded.version);
    assert.equal(heldAnchor.machine.outcome, "needs_review");
    assert.ok(heldAnchor.machine.limitations.includes("engineer_fact_review_required"));
    assert.equal(questionAt(afterExclusion, "inventory").decision.id, inventoryDecision.id);
    const remainingGrounds = (await request("GET", target + "/letters/eligible?assessmentContextId=" + context.assessmentContextId)).json();
    assert.equal(remainingGrounds.items.some(({ questionId }) => questionId === q.id), false);
    assert.equal(remainingGrounds.items.find(({ questionId }) => questionId === silence.id)?.kind, "clarification");
    const readObservation = async (snapshot) => (await request("GET", snapshot.observations.href)).json().items
      .find(({ id }) => id === address.observationId);
    const currentObservation = await readObservation(afterExclusion);
    const historicalObservation = await readObservation(beforeExclusion);
    assert.equal(currentObservation.engineeringReview.state, "review_required");
    assert.equal(currentObservation.engineeringReview.authorId, userId);
    assert.equal(currentObservation.engineeringReview.reason, exclusion.reason);
    assert.equal(historicalObservation.engineeringReview, undefined);
    assert.equal(currentObservation.quote, historicalObservation.quote);
    assert.deepEqual(currentObservation.address, historicalObservation.address);
    await omission.test("D8 accepts its first positive evidence from a linked supplement", async () => {
      const savedAnchor = external.json();
      const anchorPath = "/api/v1/letters/" + savedAnchor.id;
      const { items: [anchorItem], text: anchorText } = (await request("GET", anchorPath + "/revisions/" + savedAnchor.revisionId)).json();
      const { items: [d8Item], text: d8Text } = (await request("GET", clarificationPath + "/revisions/" + clarificationLetter.revisionId)).json();
      const sentAt = new Date().toISOString();
      const d8Sent = (await request("POST", clarificationPath + "/sent", {
        revisionId: clarificationLetter.revisionId, itemIds: [d8Item.id], recipient, text: d8Text, sentAt,
      }, { status: 201 })).json();
      const anchorSent = (await request("POST", anchorPath + "/sent", {
        revisionId: savedAnchor.revisionId, itemIds: [anchorItem.id], recipient, text: anchorText, sentAt,
      }, { status: 201 })).json();
      const d8Property = "Variable profile clearance";
      const corrected = await uploadReceipt([
        { filename: "clearance-E1.pdf", attribute: d8Property, stage: "RD", revision: "RD2", facade: "E1", value: "21",
          quote: `Drawing | ${d8Property} 21 mm | Stage: RD | Revision: RD2 current | Scope: E1 | Project facade id: E1` },
        { filename: "clearance-E9.pdf", attribute: d8Property, stage: "RD", revision: "RD2", facade: "E9", value: "21",
          quote: `Drawing | ${d8Property} 21 mm | Facade type: panel | Stage: RD | Revision: RD2 current | Scope: E9 | Project facade id: E9` },
      ], next.id);
      for (const [letterId, sentId, itemId] of [[clarificationLetter.id, d8Sent.id, d8Item.id],
        [savedAnchor.id, anchorSent.id, anchorItem.id]]) {
        await request("POST", target + "/supplements/links", { receiptId: corrected, letterId, sentId, itemId }, { status: 201 });
      }
      await request("POST", `/api/receipts/${corrected}/seal`, { manifestVersion: 1 });
      await finishReading(true);
      const otherFacade = (await request("GET", target + "/facade-assessment")).json();
      const other = otherFacade.contexts.find(({ name }) => name === "E9");
      assert.ok(other);
      const otherType = (await request("GET", otherFacade.observations.href + "?proposal=facadeKind&facadeId=" + other.facadeId)).json().items[0];
      assert.ok(otherType?.facadeKindSourceVerified);
      const { version: projectVersion } = (await request("GET", "/api/projects/" + next.id)).json();
      await request("PUT", target + `/facade-assessment/facades/${other.facadeId}/kind`, {
        kind: "panel", observationId: otherType.id, reason: "Verified type of the independent facade",
      }, { version: projectVersion });
      const openSupplement = (await request("GET", target + "/facade-assessment")).json();
      const current = questionAt(openSupplement, "variable");
      const unrelated = openSupplement.contexts.find(({ facadeId }) => facadeId === other.facadeId).questions
        .find(({ requirement }) => requirement.positionId === "variable");
      assert.ok(unrelated.machine.citations.some(({ label }) => label === "clearance-E9.pdf"));
      assert.equal(current.outcome, "needs_review");
      assert.equal(current.previousDecisionId, clarification.id);
      assert.equal(questionAt(openSupplement, "inventory").decision.id, inventoryDecision.id);
      const replacePath = `/api/v1/questions/${current.id}/source-replacements`;
      const optionPath = `/api/v1/questions/${current.id}/applicability?supplement=1`;
      const options = (await request("GET", optionPath)).json().supplement;
      assert.equal(options.mayAddFirst, true);
      assert.equal(options.previous.length, 0);
      assert.ok(options.incoming.every(({ firstEligible, citation }) => firstEligible && citation.label === "clearance-E1.pdf"));
      const refs = options.incoming.map(({ citation }) => refers(citation));
      assert.equal(refs.length, 2);
      const { rows: wrongScope } = await db.query(
        `SELECT o.id AS "observationId",o.evidence_id AS "evidenceId",o.version_id AS "versionId"
          FROM reader_observations o JOIN intake_occurrences material ON material.project_id=o.project_id AND material.version_id=o.version_id
          WHERE o.project_id=$1 AND material.receipt_id=$2 AND material.relative_path='clearance-E9.pdf'`, [next.id, corrected]);
      assert.equal(wrongScope.length, 2);
      const submit = (replacements, version, status) => request("POST", replacePath, {
        replacements, replaced: [], reason: "Verified both readings in the linked supplement",
      }, { version, status });
      assert.equal((await submit(wrongScope, current.version, 404)).json().code, "not_found");
      assert.equal((await submit(refs.slice(0, 1), current.version, 422)).json().code, "independent_support_required");
      const nonD8 = questionAt(openSupplement, "anchor");
      assert.equal((await request("POST", `/api/v1/questions/${nonD8.id}/source-replacements`, {
        replacements: refs, replaced: [], reason: "Only D8 can add first evidence",
      }, { version: nonD8.version, status: 422 })).json().code, "first_support_unavailable");
      assert.deepEqual((await request("GET", optionPath)).json().replacements, []);
      const afterFailures = (await request("GET", target + "/facade-assessment")).json();
      assert.equal(questionAt(afterFailures, "variable").version, current.version);
      assert.equal(questionAt(afterFailures, "inventory").decision.id, inventoryDecision.id);

      async function submitInBrowser() {
        const { chromium, expect: assertBrowser } = await import("../../../web/node_modules/@playwright/test/index.mjs");
        const expect = assertBrowser.configure({ timeout: 25_000 });
        const { existsSync } = await import("node:fs");
        const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        const browser = await chromium.launch({ executablePath: process.env.FACADE_CHROME_PATH ?? (existsSync(chrome) ? chrome : undefined) });
        try {
          const page = await browser.newPage({ baseURL: origin });
          const completeness = "/projects/" + next.id + "/completeness/";
          const path = completeness + current.id + "?context=" + context.assessmentContextId;
          await page.goto("/login?next=" + encodeURIComponent(path));
          await page.getByLabel("Логин").fill(login);
          await page.getByLabel("Пароль", { exact: true }).fill(password);
          await page.getByRole("button", { name: "Войти", exact: true }).click();
          await expect(page.getByRole("heading", { name: d8Property, exact: true })).toBeVisible();
          const review = page.getByRole("region", { name: "Сверка досылки по требованию" });
          const choices = review.getByRole("group", { name: "Адреса досылки обеих ветвей" });
          const confirm = review.getByRole("button", { name: "Подтвердить первую опору" });
          const consent = review.getByRole("checkbox", { name: "Подтверждаю выбранные опоры этого требования" });
          await expect(choices.getByRole("checkbox")).toHaveCount(2);
          await expect(choices.getByRole("checkbox", { name: /clearance-E9/ })).toHaveCount(0);
          await expect(review.getByRole("group", { name: "Прежние опоры для замены" })).toHaveCount(0);
          await choices.getByRole("checkbox", { name: /clearance-E1.*ветвь A/ }).check();
          const reason = "Verified both readings in the linked supplement";
          await review.getByLabel("Причина сверки").fill(reason);
          await expect(consent).toBeDisabled();
          await expect(confirm).toBeDisabled();
          await choices.getByRole("checkbox", { name: /clearance-E1.*ветвь B/ }).check();
          await consent.check();
          const [response] = await Promise.all([
            page.waitForResponse((result) => new URL(result.url()).pathname === replacePath && result.request().method() === "POST"),
            confirm.click(),
          ]);
          assert.equal(response.status(), 201, await response.text());
          assert.equal(await response.request().headerValue("if-match"), `"${current.version}"`);
          const payload = response.request().postDataJSON();
          assert.deepEqual(payload.replaced, []);
          assert.deepEqual(payload.replacements.map(({ observationId }) => observationId).sort(), refs.map(({ observationId }) => observationId).sort());
          assert.equal(payload.reason, reason);
          const saved = await response.json();
          await expect(review.getByRole("status")).toHaveText("Сверка сохранена. Квитанция " + saved.id);
          await page.reload();
          await review.getByText("История сверки досылок (1)", { exact: true }).click();
          await expect(review.getByText("Квитанция " + saved.id)).toBeVisible();
          await expect(review.getByText(reason, { exact: true })).toBeVisible();
          await expect(review.getByRole("button", { name: /^Опора досылки/ })).toHaveCount(2);
          await expect(confirm).toHaveCount(0);
          await review.getByRole("button", { name: /^Опора досылки/ }).first().click();
          const evidence = page.getByRole("region", { name: "Оригинал и основание" });
          await expect(evidence.getByText("clearance-E1.pdf", { exact: true })).toBeVisible();
          await evidence.getByRole("button", { name: "Закрыть просмотр оригинала" }).click();
          const artifacts = process.env.FACADE_D8_BROWSER_ARTIFACTS;
          if (artifacts) {
            const { mkdir } = await import("node:fs/promises");
            const { join } = await import("node:path");
            await mkdir(artifacts, { recursive: true });
            await page.screenshot({ path: join(artifacts, "d8-receipt.png") });
          }
          await page.goto(completeness + unrelated.id + "?context=" + other.assessmentContextId);
          await expect(page.getByRole("heading", { name: d8Property, exact: true })).toBeVisible();
          await expect(page.getByText("Квитанция " + saved.id)).toHaveCount(0);
          assert.equal(new URL(page.url()).searchParams.get("context"), other.assessmentContextId);
          return saved;
        } finally {
          await browser.close();
        }
      }

      const receipt = withD8Browser ? await submitInBrowser() : (await submit(refs, current.version, 201)).json();
      assert.deepEqual(receipt.receiptIds, [corrected]);
      const close = (await request("GET", target + "/facade-assessment")).json();
      assert.equal(questionAt(close, "variable").outcome, "covered");
      assert.equal(questionAt(close, "inventory").decision.id, inventoryDecision.id);
      assert.equal(questionAt(close, "anchor").version, nonD8.version);
      assert.equal(close.contexts.find(({ facadeId }) => facadeId === other.facadeId).questions
        .find(({ id }) => id === unrelated.id).version, unrelated.version);
      assert.equal((await request("GET", target + "/letters/eligible?assessmentContextId=" + context.assessmentContextId))
        .json().items.some(({ questionId }) => questionId === current.id), false);
      const { replacements: [history] } = (await request("GET", optionPath)).json();
      assert.equal(history.id, receipt.id);
      assert.deepEqual(history.replaced, []);
      assert.deepEqual(history.replacements.map(refers).sort((a, b) => a.observationId.localeCompare(b.observationId)),
        refs.sort((a, b) => a.observationId.localeCompare(b.observationId)));
      const historical = (await request("GET", d8Sent.url)).json();
      assert.equal(historical.text, d8Text);
      assert.equal(historical.items[0].decisionId, clarification.id);
      assert.deepEqual(historical.items[0].basis, d8Item.basis);
      assert.equal(historical.items[0].basis.clarification.inventories[0].receiptId, docs);
      assert.match((await request("GET", textExport.historicalUrl)).body, /по описи №\d+/u);
    });
    await uploadReceipt([{ filename: "new-facade.pdf", attribute: "Designation", stage: "RD", revision: "RD2", facade: "E2",
      quote: "Drawing | Designation | Stage: RD | Revision: RD2 current | Scope: E2 | Project facade id: E2" }], next.id);
    await finishReading(true);
    const partial = (await request("GET", target + "/facade-assessment")).json();
    assert.equal(partial.profile.state, "facade_profile_basis_stale");
    assert.equal(partial.contexts.find(({ name }) => name === "E2").facadeType.state, "unconfirmed");
    assert.equal(questionAt(partial, "inventory").version, inventoryDecision.version);
    assert.equal(questionAt(partial, "inventory").decision.id, inventoryDecision.id);
    assert.equal(questionAt(partial, "variable"), undefined);
    const heldExport = await request("GET", textExport.url, undefined, { status: 409 });
    assert.equal(heldExport.json().code, "scope_held");
    assert.match((await request("GET", textExport.historicalUrl)).body, /по описи №\d+/u);
    assert.equal(questionAt(partial, "anchor").machine.outcome, "needs_review");
    // New editions can temporarily remove all recognized sources of the former facade.
    const accepted = (await request("GET", target + "/confirmation-originals")).json().originals;
    const previousSources = accepted.filter(({ label }) => ["register.pdf", "transmittal.pdf", "clearance-E1.pdf"].includes(label));
    assert.equal(previousSources.length, 3);
    await uploadReceipt(previousSources.map(({ label, id }) => ({
      filename: label, replacesVersionId: id, quote: "Awaiting engineering review of revision RD3: " + label,
    })), next.id);
    const awaitingReading = (await request("GET", target + "/facade-assessment")).json();
    assert.ok(!awaitingReading.contexts.some(({ assessmentContextId }) => assessmentContextId === context.assessmentContextId));
    const formats = [[textExport, beforeText.rawPayload], [wordExport, word.rawPayload]];
    const waiting = (await request("GET", clarificationPath + "/current-text", undefined,
      { status: 409, version: clarificationLetter.version })).json();
    assert.equal(waiting.code, "scope_held");
    assert.ok(waiting.holds.length);
    await request("GET", target + "/letters/eligible?assessmentContextId=" + randomUUID(), undefined, { status: 404 });
    for (const [exported, bytes] of formats) {
      assert.equal((await request("GET", exported.url, undefined, { status: 409 })).json().code, "scope_held");
      assert.deepEqual((await request("GET", exported.historicalUrl)).rawPayload, bytes);
    }
    // Close intake holds through their domain service while the former facade still has no current source.
    const { resolveIntakeHold } = await built("intake/gate");
    await transaction(db, async (tx) => {
      for (const { id, version, generation } of waiting.holds) {
        await resolveIntakeHold(tx, { projectId: next.id, holdId: id, version, generation, scopeIds: null });
      }
    });
    for (const [exported, bytes] of formats) {
      assert.equal((await request("GET", exported.url, undefined, { status: 412 })).json().code, "letter_basis_stale");
      assert.deepEqual((await request("GET", exported.historicalUrl)).rawPayload, bytes);
    }
    const savedLetter = external.json();
    await request("GET", `/api/v1/letters/${savedLetter.id}/revisions/${savedLetter.revisionId}`);
    const { rows: [ledger] } = await db.query("SELECT count(*)::int AS attempts FROM gateway_attempts WHERE project_id=$1", [next.id]);
    assert.equal(ledger.attempts, 0);
  });

  await t.test("manual stage and facade type are pinned to an accepted address without a machine proposal", async () => {
    const now = (await request("GET", `/api/projects/${projectId}`)).json();
    const list = (await request("GET", base + "/confirmation-originals")).json();
    const original = list.originals.find(({ label }) => label === "south.pdf");
    assert.ok(original && list.kinds.includes("panel"));
    const snapshot = await assessment();
    const proposals = (await request("GET", snapshot.observations.href + `?proposal=facadeKind&facadeId=${secondFacade.facadeId}`)).json();
    assert.equal(proposals.items.length, 0);
    const manual = { provenanceKind: "engineer_override", documentVersionId: original.id, pageOrAnchor: "1",
      reason: "Verified on the synthetic original" };
    const stagePath = `/api/projects/${projectId}/stage`;
    await request("PUT", stagePath, { ...manual, stage: "P", pageOrAnchor: "999" }, { version: now.version, status: 422 });
    const confirmed = (await request("PUT", stagePath, { ...manual, stage: "P" }, { version: now.version })).json();
    assert.equal(confirmed.stageBasis.provenanceKind, "engineer_override");
    assert.equal(confirmed.stageBasis.address.locator.page, 1);
    const typePath = base + `/facade-assessment/facades/${secondFacade.facadeId}/kind`;
    await request("PUT", typePath, { ...manual, kind: "panel" }, { version: now.version, status: 412 });
    await request("PUT", typePath, { ...manual, documentVersionId: randomUUID(), kind: "panel" },
      { version: confirmed.version, status: 404 });
    const type = (await request("PUT", typePath, { ...manual, kind: "panel" }, { version: confirmed.version })).json();
    assert.equal(type.facadeType.state, "confirmed");
    assert.equal(type.facadeType.basis.provenanceKind, "engineer_override");
    assert.equal(type.facadeType.basis.versionId, original.id);
    const reloaded = await assessment();
    assert.equal(reloaded.contexts.find(({ facadeId }) => facadeId === secondFacade.facadeId).facadeType.basis.versionId, original.id);
  });

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
  await request("GET", base + `/facade-assessment/${unclear.version}`, undefined, { status: 404 });
  await request("GET", gap.sources[0].citation.href, undefined, { status: 404 });
  await request("GET", early.observations.href, undefined, { status: 404 });
  await request("GET", base + "/confirmation-originals", undefined, { status: 404 });
});
