import assert from "node:assert/strict";
import { test } from "node:test";

const built = (path) => import(new URL(`../../../dist/src/modules/${path}.js`, import.meta.url));
const item = "Torsion report";
const statement = `${item} not supplied`;
const quote = `Inventory | ${statement}`;
const source = { projectId: "project", versionId: "version", documentId: "pdf", sha256: "a".repeat(64) };
const locator = { page: 1, rotation: 0 };
const box = (x, width) => ({ x, y: 20, width, height: 12 });
const context = { kind: "facade", id: "context", facadeId: "facade", name: "F1" };

function written(branch, { body, mode = "legacy", frame = true, claimContext = false, wrongRun = false, old = false } = {}) {
  const full = { id: "line-1", text: body ?? `${quote} | Passport supplied`, box: box(0, 200) };
  const leftId = `left-${branch}${old ? "-old" : ""}`;
  const rightId = `right-${branch}`;
  const chosenQuote = claimContext ? "Inventory |" : quote;
  const legacyCrop = { ...full, box: box(0, 100), text: chosenQuote };
  const issued = frame ? legacyCrop : full;
  const address = { unitId: "1", locator, box: issued.box };
  const observation = { id: `obs-${branch}${old ? "-old" : ""}`, source, branch, address, runId: `run-${branch}`, receiptId: "r", readerVersion: "reader-1",
    evidenceId: leftId, lineId: issued.id, grounding: "text", quote: chosenQuote, deliveryStatement: { status: "not_delivered", item,
      ...(claimContext ? { context: { lineId: issued.id, quote: statement } } : {}) } };
  const metadata = { source, branch, runId: observation.runId, receiptId: "r", readerVersion: "reader-1",
    format: "pdf", representation: "native", mediaType: "application/json", limitations: [] };
  const evidence = new Map([[leftId, { ...metadata, address: { unitId: "1", locator, box: frame ? box(0, 100) : undefined } }],
    [rightId, { ...metadata, address: { unitId: "1", locator, box: box(100, 100) } }]]);
  const fact = { id: observation.id, branch, windowId: "window", observation, evidenceHref: `evidence/${leftId}`, attribute: item,
    sourceRole: "inventory", designStage: "RD", revision: "R1", revisionStatus: "current", variant: null, materials: [],
    basis: { role: "Inventory", stage: "RD", revision: "R1" },
    binding: { state: "identified", candidates: [{ id: "facade", label: "F1" }] } };
  if (mode !== "legacy") {
    fact.basis.deliveryLine = { source, runId: wrongRun ? "another-run" : observation.runId, branch, readerVersion: "reader-1",
      unitId: "1", lineId: full.id, box: full.box, canonicalSha256: "b".repeat(64), text: full.text,
      anchorEvidenceId: leftId, submittedEvidenceId: leftId, crops: [{ evidenceId: leftId, frame: box(0, 100), box: issued.box,
        text: issued.text }, ...(mode === "pair" ? [{ evidenceId: rightId, frame: box(100, 100), box: box(100, 100),
        text: full.text.slice(issued.text.length).trim() }] : [])] };
  }
  return { fact, evidence, issued };
}

test("only checked full PDF lines can turn already stored text into external non-delivery grounds", async () => {
  const { convertFact } = await built("assessment/facade-input");
  const { facadeReview, nonDeliveryFromOriginal, requirementsFor } = await built("assessment/facade-model");
  const { evaluate } = await built("assessment/domain");
  const [requirement] = requirementsFor([{ key: "torsion", part: item, applicability: "all", level: "facade", formats: ["pdf"],
    sourceRoles: ["inventory"], equivalents: [], completenessCriterion: item, addressee: "Customer",
    evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "inventory" }] }] } }], context, "RD");
  const complete = { complete: true, reason: null, basisIds: ["proof"] };
  const coverage = { inventory: complete, map: complete, reading: complete, subject: complete };
  const accepted = new Map([[source.versionId, { id: source.versionId, documentId: source.documentId, sha256: source.sha256, label: "Inventory" }]]);
  function assess(left, right = left, prior = []) {
    const observations = [written("A", left), written("B", right), ...prior];
    const facts = observations.map(({ fact, evidence, issued }) => convertFact(fact, accepted, new Map([["window", "pdf"]]),
      new Map(), evidence, [issued], true));
    const review = facadeReview({ questionId: "q", context, stage: "RD", requirement, facts, pairs: [], coverage,
      versionIds: [source.versionId], supplementReceiptIds: [], semanticBasisIds: ["A-reviewed", "B-reviewed"] });
    return evaluate(requirement, review);
  }
  const contradiction = `${quote} | ${item} supplied`;
  // The old evaluator took the issued crop for the full line and closed this question.
  assert.equal(nonDeliveryFromOriginal(quote, quote, item), true);
  const oldCrop = assess({ body: contradiction });
  assert.equal(oldCrop.outcome, "needs_review");
  assert.ok(oldCrop.citations.every(({ deliveryUncertainty }) => deliveryUncertainty === "original_statement_unverified"));
  for (const options of [{ frame: false }, { mode: "single" }, { mode: "pair", claimContext: true }]) {
    const held = assess({ ...options, body: contradiction });
    assert.equal(held.outcome, "needs_review");
    assert.ok(held.citations.every(({ deliveryUncertainty }) => deliveryUncertainty === "contradictory_original"));
    assert.equal(assess({ ...options, body: `${quote} | it was supplied` }).outcome, "needs_review");
    assert.equal(assess({ ...options, body: `${quote}. ${item} supplied` }).outcome, "needs_review");
    assert.equal(assess({ ...options, body: `${quote}, but ${item} supplied` }).outcome, "needs_review");
    assert.equal(assess({ ...options, body: `${quote} | Passport supplied` }).outcome, "confirmed_missing");
    assert.equal(assess({ ...options, body: `${quote}. Passport supplied` }).outcome, "confirmed_missing");
  }
  const mixed = assess({ frame: false }, { mode: "pair", claimContext: true });
  assert.equal(mixed.outcome, "confirmed_missing");
  assert.equal(mixed.citations.find(({ branch }) => branch === "B").deliveryBasis.evidenceId, "right-B");
  assert.equal(assess({ mode: "pair", claimContext: true, wrongRun: true }).outcome, "needs_review");
  assert.equal(assess({ mode: "single" }, { mode: "pair", claimContext: true }, [written("A", { old: true })]).outcome,
    "confirmed_missing");
  assert.equal(assess({ mode: "single" }, { mode: "pair", claimContext: true }, [written("A", { old: true, frame: false, body: contradiction })])
    .outcome, "needs_review");
});
