import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, evaluate, normalizeFactValue } from "../../../dist/src/modules/assessment/domain.js";
import { equivalentFacts, holdReviewedEvidence, readFactReviews } from "../../../dist/src/modules/assessment/fact-review.js";

const area = (id) => ({ state: "identified", candidates: [{ id }], reason: "addressed" });
const a = {
  id: "a", evidenceId: "evidence-a", binding: area("facade-a"), attribute: "Толщина",
  revisionStatus: "current", revision: "R2", variant: "v1", sourceRole: "drawing", designStage: "РД",
  value: "0,003", unit: "м", branch: "A", quote: "Толщина 0,003 м", versionId: "version-a",
  sha256: "sha-a", documentId: "doc-a", address: { unitId: "1", locator: { page: 1 } },
};
const b = { ...a, id: "b", evidenceId: "evidence-b", value: "3", unit: "мм", branch: "B",
  quote: "Толщина 3 мм", versionId: "version-b", sha256: "sha-b", documentId: "doc-b", address: { unitId: "2", locator: { page: 2 } } };
const bindingKey = (fact) => canonicalJson([fact.binding.state, fact.binding.candidates.map(({ id }) => id).sort(),
  fact.revisionStatus, fact.versionId, fact.sha256, fact.address]);

test("fact review equivalence preserves exact units, variant and facade boundaries", () => {
  assert.deepEqual(normalizeFactValue(a.value, a.unit), { value: "3", unit: "мм", numeric: true });
  assert.deepEqual(normalizeFactValue("-0,00002", "кг"), { value: "-0.02", unit: "г", numeric: true });
  assert.deepEqual(normalizeFactValue("0", "км"), { value: "0", unit: "мм", numeric: true });
  assert.equal(normalizeFactValue("99999999999999999999999", "мм").value, "99999999999999999999999");
  assert.equal(equivalentFacts(a, b), true);
  assert.deepEqual(normalizeFactValue("3", "length"), { value: "3", unit: "length", numeric: true });
  assert.equal(equivalentFacts(a, { ...b, unit: "length" }), false);
  assert.equal(equivalentFacts(a, { ...b, binding: area("facade-b") }), false);
  assert.equal(equivalentFacts(a, { ...b, binding: { state: "unidentified", candidates: [] } }), false);
  assert.equal(equivalentFacts(a, { ...b, variant: "v2" }), false);
  assert.equal(equivalentFacts(a, { ...b, revisionStatus: "superseded" }), false);
});

test("merged view retains every original address and dissolves if a member leaves its area", async () => {
  const reason = "Та же величина в эквивалентных единицах";
  const rows = [a, b].map((fact) => ({
    id: "review", decision: { action: "merge", primaryId: a.id }, reason, authorId: "engineer",
    createdAt: new Date("2026-11-25"), assessmentVersion: 7, memberCount: 2,
    observationId: fact.id, bindingKey: bindingKey(fact),
  }));
  const tx = { async query(_sql, params) { assert.deepEqual(params, ["project", ["a", "b"]]); return { rows }; } };
  const reviews = await readFactReviews(tx, "project", [a, b]);
  assert.equal(reviews.get(a.id).state, "applied");
  assert.equal(reviews.get(b.id).mergedInto, a.id);
  assert.deepEqual(reviews.get(a.id).places.map(({ quote, address, evidenceId }) => [quote, address.locator.page, evidenceId]),
    [["Толщина 0,003 м", 1, "evidence-a"], ["Толщина 3 мм", 2, "evidence-b"]]);
  const stale = await readFactReviews(tx, "project", [a, { ...b, binding: area("facade-b") }]);
  assert.equal(stale.get(a.id).state, "stale");
  assert.equal(stale.get(b.id).mergedInto, undefined);
});

test("corrections never overwrite a literal and exclusion holds only dependent machine proof", async () => {
  const saved = { id: "review", reason: "Сверено вручную", authorId: "engineer", createdAt: "2026-11-25T10:00:00Z", assessmentVersion: 7 };
  const tx = { async query() { return { rows: [
    { ...saved, decision: { action: "correct", value: "4,0", unit: "мм" }, observationId: a.id, memberCount: 1, bindingKey: bindingKey(a) },
    { ...saved, id: "another-review", decision: { action: "exclude" }, observationId: b.id, memberCount: 1, bindingKey: bindingKey(b) },
  ] }; } };
  const reviews = await readFactReviews(tx, "project", [a, b]);
  const corrected = reviews.get(a.id);
  assert.equal(corrected.state, "review_required");
  assert.deepEqual(corrected.normalized, { value: "4", unit: "мм", numeric: true });
  assert.equal(corrected.places[0].quote, a.quote);
  assert.equal(corrected.places[0].value, "0,003");
  assert.deepEqual(corrected.places[0].address, a.address);
  function finding(fact) {
    return { kind: "value", applicability: "active", sourceRole: "drawing", format: "pdf",
      comparisonKey: "specific-context+variant", citation: { ...fact, observationId: fact.id, receiptId: "receipt" } };
  }
  const requirement = { applicability: "applicable", formats: ["pdf"], sourceRoles: ["drawing"] };
  const dependent = { findings: [finding(a), finding(b)], packageCoverageIds: [a.id, b.id],
    completenessChecked: true, remaining: [] };
  const independent = { ...dependent, findings: [finding({ ...a, id: "other-facade" })], packageCoverageIds: ["other-facade"] };
  assert.equal(evaluate(requirement, dependent).outcome, "covered");
  const held = holdReviewedEvidence(dependent, reviews);
  assert.deepEqual(held.remaining, ["engineer_fact_review_required"]);
  assert.equal(evaluate(requirement, held).outcome, "needs_review");
  assert.deepEqual(held.findings, []);
  assert.equal(evaluate(requirement, holdReviewedEvidence(independent, reviews)).outcome, "covered");
});

test("a chosen variant is recorded separately from the immutable reading", async () => {
  const tx = { async query() { return { rows: [{
    id: "variant-decision", decision: { action: "select_variant", variant: "v2" },
    reason: "Сопоставлена маркировка", authorId: "engineer", createdAt: "2026-11-25T10:00:00Z",
    assessmentVersion: 7, observationId: a.id, memberCount: 1, bindingKey: bindingKey(a),
  }] }; } };
  const [review] = (await readFactReviews(tx, "project", [a])).values();
  assert.equal(review.state, "review_required");
  assert.equal(review.variant, "v2");
  assert.equal(review.places[0].variant, "v1");
  assert.equal(review.places[0].quote, a.quote);
});
