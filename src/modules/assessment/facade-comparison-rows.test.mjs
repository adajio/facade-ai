import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { comparisonRows } from "../../../dist/src/modules/assessment/facade-comparison-rows.js";
import { comparisonReview } from "../../../dist/src/modules/assessment/facade-comparison.js";
import { convertFact, facadeObservation } from "../../../dist/src/modules/assessment/facade-input.js";
import { blockId } from "../../../dist/src/modules/project-memory/contracts.js";

const property = "Bracket reach";
const mark = "K-29";
const box = (x, width, y = 12) => ({ x, y, width, height: 10 });
const page = { unitId: "1", locator: { page: 1, rotation: 0 } };
const sheet = { unitId: "sheet:2:1", locator: { sheet: "Records", sheetId: "2", state: "visible" } };
const left = `Drawing | Facade: ${mark} | Building: West | Axes: C-E | ${property}:`;
const right = `${property}: 17 mm`;

function fixture() {
  const evidence = new Map();
  const formats = new Map();
  const facts = [];
  const issued = [];
  const profiles = new Map();
  const accepted = new Map();
  const native = [];
  function add({ id, format = "pdf", branch = "A", runId = id, lineId = "1.0.5.0", quote, text = quote, value, unit = "mm",
    lineBox, frame, locator, binding: mark, building = "West", attribute = null, role = "unknown", revision = null,
    revisionStatus = "unknown", limitation, sourceSuffix = "", readerVersion = "fixture-v1", variant = null, stage = null }) {
    const source = { projectId: "p", versionId: format + "-v1" + sourceSuffix, documentId: format + "-doc",
      sha256: createHash("sha256").update(format + sourceSuffix).digest("hex") };
    const receiptId = "receipt";
    const parent = format === "pdf" ? page : sheet;
    const evidenceAddress = { ...parent, ...(frame ? { box: frame } : {}) };
    const address = { ...parent, ...(lineBox ? { box: lineBox } : {}),
      ...(locator ? { locator: { ...parent.locator, ...locator } } : {}) };
    const line = { id: lineId, text, ...(lineBox ? { box: lineBox } : {}), ...(locator ? { locator: address.locator } : {}) };
    const content = JSON.stringify({ address: evidenceAddress, lines: [line], limitations: [] });
    const evidenceId = "e-" + id;
    const evidenceHref = "/api/v1/evidence/" + evidenceId;
    const observation = { id, branch, runId, source, receiptId, readerVersion, lineId, address, quote, grounding: "text",
      evidenceId, ...(value ? { value, unit } : {}), ...(limitation ? { limitation } : {}) };
    const identityQuote = mark ? `Facade: ${mark}` : null;
    const binding = { state: mark ? "identified" : "unidentified", candidates: mark ? [{ id: mark, label: mark }] : [],
      quote: identityQuote, actorId: null };
    const basis = { ...(role === "drawing" ? { role: "Drawing" } : {}), ...(stage ? { stage: `Stage: ${stage}` } : {}) };
    const fact = { id, windowId: source.versionId, branch, observation, evidenceHref, attribute, sourceRole: role, designStage: stage,
      variant, revision, revisionStatus, basis, binding, materials: [] };
    if (mark) {
      const profile = profiles.get(mark) ?? { facadeId: mark, identity: "independent", mentions: [] };
      profile.mentions.push({ factId: id, label: mark, branch, evidenceId, lineId, versionId: source.versionId, readerVersion,
        address, kind: "context", quote: identityQuote, context: { building, axes: "C-E" } });
      profiles.set(mark, profile);
    }
    evidence.set(evidenceId, { id: evidenceId, runId, branch, source, receiptId, readerVersion, address: evidenceAddress,
      format, mediaType: "application/json", representation: "native", limitations: [], size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex") });
    issued.push({ evidenceId, runId, content });
    formats.set(source.versionId, format);
    accepted.set(source.versionId, { documentId: source.documentId, sha256: source.sha256, label: format + "-fixture" });
    facts.push(fact);
  }
  const pdfContext = (overrides = {}) => add({ id: "drawing-context", quote: left, lineBox: box(0, 85),
    frame: { ...box(0, 85, 0), height: 40 },
    attribute: property, binding: mark, role: "drawing", limitation: "The value is outside this crop.", ...overrides });
  const pdfValue = (overrides = {}) => add({ id: "drawing-value", quote: "17", text: right, value: "17",
    lineBox: box(65, 40), frame: { ...box(65, 50, 0), height: 40 }, ...overrides });
  function cell(id, cellName, branch, facade, building, loc, overrides = {}) {
    const quote = `Schedule | Facade: ${facade} | Building: ${building} | Axes: C-E | Revision: U2 current | ${property}: 26 mm`;
    add({ id, format: "xlsx", branch, quote, lineId: cellName, attribute: property, binding: facade, building,
      locator: { row: loc[0], column: loc[1], cell: cellName }, value: "26", revision: "U2", revisionStatus: "current", ...overrides });
  }
  function view() {
    const rows = comparisonRows(facts, formats, evidence, issued, [...profiles.values()], native);
    const observations = facts.map((fact) => facadeObservation(fact));
    const values = facts.map((fact) => convertFact(fact, accepted, formats, new Map(), evidence, undefined, true));
    const original = comparisonReview(values, observations, [], null, null, []);
    return { rows, original, items: comparisonReview(values, observations, [], null, null, [], [], new Map(), rows).items, values };
  }
  function canonical(overrides = {}) {
    const { source, readerVersion, lineId } = facts.find(({ id }) => id === "drawing-value").observation;
    native.push({ blockId: blockId(source, readerVersion, page.unitId), artifactSha256: "a".repeat(64), lineId,
      text: left + " 17 mm", address: { ...page, box: box(0, 105) }, ...overrides });
  }
  return { context: pdfContext, value: pdfValue, cell, canonical, evidence, facts, issued, view };
}

test("a native row composes a card with source proof, excluding equal numbers in independent cells", () => {
  const f = fixture();
  f.context();
  f.value();
  f.canonical();
  f.value({ id: "duplicate", runId: "repeat-drawing" });
  f.cell("matched", "F3", "B", mark, "West", [3, 6]);
  f.cell("in-other-building", "F4", "B", "K-82", "East", [4, 6]);
  f.cell("same-mark-other-building", "F5", "B", mark, "East", [5, 6]);
  f.cell("separate-number", "E3", "B", undefined, "West", [3, 5], { quote: `${property}: 26 mm` });
  const { rows, original, items, values } = f.view();
  assert.equal(original.items.length, 0);
  assert.ok(rows.has("in-other-building"), "the distinct facade has its own valid typed support");
  assert.ok(rows.has("same-mark-other-building"), "a reused mark does not cancel independent row evidence");
  assert.ok(!rows.has("separate-number"));
  assert.ok(values.find(({ finding }) => finding.citation.observationId === "separate-number").addressedValue);
  assert.equal(items.length, 1);
  const [{ facadeId, reasons, sources }] = items;
  assert.equal(facadeId, mark);
  assert.equal(reasons[0], "comparability_unproven");
  assert.ok(reasons.includes("value_role_unproven"));
  assert.deepEqual(sources.map(({ citation, sourceRole, row }) => [citation.value, sourceRole, row.value.lineId, row.value.quote]),
    [["17", "drawing", "1.0.5.0", right], ["26", "schedule", "F3", `${property}: 26 mm`]]);
  assert.equal(sources[0].row.context.runId, "drawing-context");
  assert.notEqual(sources[0].row.value.runId, sources[0].row.context.runId);
  assert.equal(sources[0].row.context.href, "/api/v1/evidence/e-drawing-context");
  assert.equal(sources[0].row.canonical.lineId, "1.0.5.0");
  assert.equal(sources[1].citation.address.locator.cell, "F3");
  assert.ok(values.filter(({ finding }) => finding.citation.versionId === "pdf-v1" && finding.kind === "value")
    .every(({ property }) => property === null), "row composition stays out of assessment inputs");
});

test("native row composition refuses unrelated, contradictory or unverified fragments", async (t) => {
  const cases = [
    ["different branch", {}, { branch: "B" }],
    ["different original", {}, { sourceSuffix: "-other" }],
    ["different reader version", {}, { readerVersion: "fixture-v2" }],
    ["different line", {}, { lineId: "1.0.6.0" }],
    ["different coordinate band", {}, { lineBox: box(65, 40, 20) }],
    ["gapped crops", {}, { lineBox: box(86, 20), frame: { ...box(86, 40, 0), height: 40 } }],
    ["wrong value", {}, { value: "170" }],
    ["wrong unit", {}, { unit: "cm" }],
    ["unrelated label", {}, { quote: "17", text: "Bracket width: 17 mm" }],
    ["conflicting source roles", {}, { role: "specification" }],
    ["generic heading", { quote: `Document role: drawing | Facade: ${mark} | Building: West | Axes: C-E | ${property}:` }, {}],
    ["multiple facade fields", { quote: left.replace(" | Building:", " | Facade: K-82 | Building:") }, {}],
    ["superseded context", { revisionStatus: "superseded" }, {}],
  ];
  for (const [name, context, value] of cases) await t.test(name, () => {
    const f = fixture();
    f.context(context);
    f.value(value);
    f.canonical();
    f.cell("matched", "F3", "B", mark, "West", [3, 6]);
    assert.deepEqual(f.view().items, []);
  });
  await t.test("run ownership and committed representation hash", () => {
    const f = fixture();
    f.context();
    f.value();
    f.canonical();
    f.cell("matched", "F3", "B", mark, "West", [3, 6]);
    f.evidence.get("e-drawing-context").runId = "unrelated-run";
    assert.deepEqual(f.view().items, []);
    f.evidence.get("e-drawing-context").runId = "drawing-context";
    f.issued[0].runId = "unrelated-run";
    assert.deepEqual(f.view().items, []);
    f.issued[0].runId = "drawing-context";
    f.issued[0].content += " ";
    assert.deepEqual(f.view().items, []);
  });
  await t.test("conflicting same-row revision and wrong cell locator", () => {
    const f = fixture();
    f.context({ revision: "U1" });
    f.context({ id: "competing-revision", revision: "U2" });
    f.value();
    f.canonical();
    f.cell("matched", "F3", "B", mark, "West", [3, 6]);
    assert.deepEqual(f.view().items, []);
    f.facts.splice(1, 1);
    f.facts.at(-1).observation.address.locator.cell = "F4";
    assert.deepEqual(f.view().items, []);
  });
  await t.test("a full indexed row is required and hidden repeated measures block the card", () => {
    const f = fixture();
    f.context();
    f.value();
    f.cell("matched", "F3", "B", mark, "West", [3, 6]);
    assert.deepEqual(f.view().items, []);
    f.canonical({ text: left + ` 17 mm | ${property}: 28 mm`, address: { ...page, box: box(0, 160) } });
    assert.deepEqual(f.view().items, []);
  });
  await t.test("duplicate canonical line IDs block composition", () => {
    const f = fixture();
    f.context();
    f.value();
    f.canonical();
    f.canonical();
    f.cell("matched", "F3", "B", mark, "West", [3, 6]);
    assert.deepEqual(f.view().items, []);
  });
});

test("the composed card cites the sole local mark and printed sheet revision without qualifying the pair", () => {
  const f = drawingView();
  const [item] = f.view().items;
  const [source] = item.sources;
  const proof = source.row.drawingView;
  assert.equal(proof.variant.value, "V7");
  assert.equal(proof.variant.mark, "LK-29");
  assert.equal(proof.variant.citation.lineId, "1.0.3.0");
  assert.equal(proof.revision.value, "M3");
  assert.equal(proof.stage, "RD");
  assert.equal(proof.revision.citation.lineId, "1.0.1.0");
  assert.equal(proof.scope.quote, "Facade: K-29 | Building: West | Axes: C-E");
  assert.equal(proof.title.quote, "Elevation and detail / west sector");
  assert.equal(proof.variant.citation.evidenceId, "e-drawing-context");
  assert.equal(source.variant, null);
  assert.equal(source.revision, null);
  assert.equal(source.stage, null);
  assert.ok(item.reasons.includes("comparability_unproven"));
  assert.ok(!item.reasons.includes("variant_unproven"));
  assert.ok(!item.reasons.includes("revisions_unproven"));
  assert.ok(!item.reasons.includes("source_stage_unproven"));
  assert.ok(item.reasons.includes("project_stage_unconfirmed"));
});

test("drawing metadata follows semantic fields despite a different title, field order and annotations", () => {
  const title = "View: Bracket arrangement, west wing";
  const f = drawingView({ title, header: "Revision: U4 | Stage: P | current | Document role: drawing",
    identity: "Axes: C-E | Facade: K-29 | Building: West", item: "Variant: N3 | Mark: BR-29",
    extra: ["Scale: 1:20", "Dimensions in mm"] });
  const [{ sources: [{ row: { drawingView: proof } }] }] = f.view().items;
  assert.equal(proof.title.quote, title);
  assert.equal(proof.variant.value, "N3");
  assert.equal(proof.variant.mark, "BR-29");
  assert.equal(proof.revision.value, "U4");
  assert.equal(proof.stage, "P");
});

test("different printed variants and revisions remain gaps in the candidate card", () => {
  const f = drawingView({ sheetVariant: "V8", sheetRevision: "M4" });
  const [{ reasons }] = f.view().items;
  assert.ok(reasons.includes("variants_differ"));
  assert.ok(reasons.includes("revision_applicability_unproven"));
});

test("local drawing metadata is held when the view, scope, revision, or evidence is ambiguous", async (t) => {
  const cases = [
    ["unbounded page", { completePage: false }],
    ["other view", { extra: "Elevation / east sector" }],
    ["other facade", { identity: "Facade: K-82 | Building: West | Axes: C-E" }],
    ["other mark", { extra: "Mark: LK-82" }],
    ["other variant", { item: "Mark: LK-29 | Variant: V7 | Variant: V8" }],
    ["explicit local override", { extra: "Override: use variant V8 for bracket reach" }],
    ["other revision", { header: "Document role: drawing | Stage: RD | Revision: M3 | Revision: M4 | current" }],
    ["superseded revision", { header: "Document role: drawing | Stage: RD | Revision: M3 | superseded" }],
    ["inactive sheet heading", { title: "Superseded drawing" }],
    ["bare metadata in place of a title", { title: "Variant V8" }],
    ["missing scope identity", { identity: "Facade: K-29 | Building: West" }],
    ["metadata outside the issued native bytes", { omitIssued: "1.0.3.0" }],
  ];
  for (const [name, options] of cases) await t.test(name, () => {
    const f = drawingView(options);
    const [item] = f.view().items;
    assert.ok(item);
    assert.equal(item.sources[0].row.drawingView, undefined);
  });
});

function drawingView({ completePage = true, extra, omitIssued,
  title = "Elevation and detail / west sector",
  header = "Document role: drawing | Stage: RD | Revision: M3 | current",
  identity = "Facade: K-29 | Building: West | Axes: C-E", item = "Mark: LK-29 | Variant: V7",
  sheetVariant = "V7", sheetRevision = "M3" } = {}) {
  const f = fixture();
  const metadata = [title, header, identity, item].map((text, index) => ({
    text, id: `1.0.${index}.0`, box: box(0, 45, 4 + index * 20),
  }));
  f.context({ lineBox: box(0, 85, 90), frame: { ...box(0, 85, 0), height: 120 } });
  f.value({ lineBox: box(65, 40, 90), frame: { ...box(65, 50, 0), height: 120 } });
  f.canonical({ completePage, address: { ...page, box: box(0, 105, 90) } });
  for (const row of metadata) f.canonical({ completePage, lineId: row.id, text: row.text, address: { ...page, box: row.box } });
  for (const [index, text] of (extra ? [extra].flat() : []).entries()) {
    f.canonical({ completePage, lineId: `1.0.${6 + index}.0`, text, address: { ...page, box: box(0, 70, 110 + index * 20) } });
  }
  const body = JSON.parse(f.issued[0].content);
  body.lines.unshift(...metadata.filter(({ id }) => id !== omitIssued));
  const content = f.issued[0].content = JSON.stringify(body);
  const issued = f.evidence.get("e-drawing-context");
  issued.sha256 = createHash("sha256").update(content).digest("hex");
  issued.size = Buffer.byteLength(content);
  f.cell("matched", "F3", "B", mark, "West", [3, 6], {
    quote: `Schedule | Facade: ${mark} | Building: West | Axes: C-E | Stage: RD | Variant: ${sheetVariant} | Revision: ${sheetRevision} current | ${property}: 26 mm`,
    variant: sheetVariant, revision: sheetRevision, stage: "RD",
  });
  return f;
}
