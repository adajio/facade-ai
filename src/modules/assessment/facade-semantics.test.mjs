import assert from "node:assert/strict";
import { test } from "node:test";

const built = (path) => import(new URL(`../../../dist/src/modules/${path}.js`, import.meta.url));
const fixtureRow = {
  key: "spacing", part: "Anchor spacing", level: "facade", applicability: "stage:P",
  formats: ["pdf"], equivalents: ["xlsx"], sourceRoles: ["drawing", "schedule"],
  completenessCriterion: "Addressed spacing", addressee: "Customer",
  evidenceRule: { allOf: [{ anyOf: [{ sourceRole: "drawing" }] }, { anyOf: [{ sourceRole: "schedule" }] }] },
};
const context = { id: "context-f1", kind: "facade", facadeId: "f1", name: "F1" };

test("completed windows, missing semantic checks, and complete position proof remain distinct", async () => {
  const { assessSemanticRemainder, completedReaderJob, facadeVerdict, indexSemanticInput } = await built("assessment/facade-semantic");
  const { requirementsFor } = await built("assessment/facade-model");
  const [requirement] = requirementsFor([fixtureRow], context, "P");
  const typed = { ...context, facadeType: { state: "confirmed", kind: "panel" } };
  const proof = (windowId, branch) => ({
    windowId, branch, jobId: `${windowId}-${branch}`, primaryJobId: `${windowId}-${branch}`, readerVersion: "reader-1",
    facadeId: "f1", positionId: "spacing",
    catalogVersionId: "catalog-1", stage: "P", disposition: "alternatives_checked", basisIds: [`evidence-${windowId}-${branch}`],
  });
  const paired = (windowId) => ["A", "B"].map((branch) => proof(windowId, branch));
  const window = (id, format) => ({
    id, format, readerVersion: "reader-1",
    place: { source: { versionId: `doc-${id}` }, unitId: "1" },
    branches: Object.fromEntries(["A", "B"].map((branch) => [branch, {
      status: branch === "A" ? "covered" : "reviewed_no_match", jobId: `${id}-${branch}`,
    }])),
    structure: { branches: { A: { complete: true, remaining: [] }, B: { complete: true, remaining: [] } } },
  });
  const windows = [window("drawing", "pdf"), window("schedule", "xlsx"), window("unrelated", "txt")];
  function assess(checks, unmappedVersionIds = []) {
    return assessSemanticRemainder({ index: indexSemanticInput(windows, checks, unmappedVersionIds),
      requirement, context: typed, catalogVersionId: "catalog-1", stage: "P" });
  }
  assert.deepEqual(assess([]).remainder.items.map(({ reason }) => reason),
    ["semantic_check_missing", "semantic_check_missing"]);
  const local = assess([...paired("drawing"), ...paired("schedule").map((keep) => ({ ...keep, facadeId: "f2" }))]);
  assert.equal(local.remainder.totalWindows, 2);
  assert.equal(local.remainder.verifiedWindows, 1);
  assert.deepEqual(local.remainder.items.map(({ versionId }) => versionId), ["doc-schedule"]);
  const shared = paired("schedule").map((item) => ({ ...item, basisIds: ["same-read"] }));
  assert.equal(assess([...paired("drawing"), ...shared]).remainder.items[0].reason, "semantic_independence_unproven");
  const obsolete = paired("schedule").map((item) => ({ ...item, readerVersion: "reader-0" }));
  assert.equal(assess([...paired("drawing"), ...obsolete]).remainder.verifiedWindows, 1);
  for (const descriptor of [{ stage: "R" }, { catalogVersionId: "catalog-0" }, { primaryJobId: "older-job" }]) {
    assert.equal(assess([...paired("drawing"), ...paired("schedule").map((item) => ({ ...item, ...descriptor }))])
      .remainder.verifiedWindows, 1);
  }
  const followed = paired("schedule").map((item) => ({ ...item, primaryJobId: item.jobId, jobId: `followup-${item.jobId}` }));
  assert.equal(assess([...paired("drawing"), ...followed]).remainder.verifiedWindows, 2);
  windows[1].branches.B = { status: "held", reason: "turn_limit_final", jobId: "schedule-B" };
  windows[1].structure.branches.B.followup = { jobId: "refused-followup", status: "done" };
  assert.equal(assess([...paired("drawing"), ...followed]).remainder.items[0].reason, "reading_pending");
  windows[1].structure.branches.B.followup = { jobId: "newer-followup", status: "leased" };
  windows[1].structure.branches.B.completedFollowupId = "followup-schedule-B";
  assert.equal(completedReaderJob(windows[1], "B"), "followup-schedule-B");
  assert.equal(assess([...paired("drawing"), ...followed]).remainder.verifiedWindows, 2);
  const complete = assess([...paired("drawing"), ...paired("schedule")]);
  assert.equal(complete.remainder.state, "complete");
  assert.equal(complete.basisIds.length, 4);
  assert.equal(complete.remainder.alternativesVerified, true);
  const allChecks = [...paired("drawing"), ...paired("schedule")];
  assert.equal(assessSemanticRemainder({ index: indexSemanticInput(windows, allChecks, []),
    requirement, context, catalogVersionId: "catalog-1", stage: "P" }).remainder.state, "complete");
  assert.equal(assessSemanticRemainder({ index: indexSemanticInput(windows, allChecks, []),
    requirement: { ...requirement, facadeKinds: ["panel"] }, context, catalogVersionId: "catalog-1", stage: "P" })
    .remainder.reasons.includes("facade_type_unconfirmed"), true);
  assert.equal(assessSemanticRemainder({ index: indexSemanticInput(windows, allChecks, []),
    requirement: { ...requirement, evidenceRule: undefined }, context, catalogVersionId: "catalog-1", stage: "P" })
    .remainder.reasons.includes("catalog_evidence_rule_unset"), true);
  const localFacts = assess([...paired("drawing"), ...paired("schedule")]
    .map((check) => ({ ...check, disposition: "supported" })));
  assert.equal(localFacts.remainder.state, "open");
  assert.equal(localFacts.remainder.alternativesVerified, false);
  const narrow = assess([...paired("drawing"), ...paired("schedule").map((check) => ({ ...check, subject: "Anchor spacing" }))]);
  assert.equal(narrow.remainder.verifiedWindows, 1);
  const proven = { complete: true, reason: null, basisIds: ["separate-proof"] };
  const coverage = { inventory: proven, map: proven, reading: proven, subject: proven };
  const positions = ["f1", "f2", "common"].map(() => ({ machine: { outcome: "covered" }, semanticRemainder: complete.remainder }));
  assert.equal(facadeVerdict(coverage, [], positions), "sufficient");
  for (const axis of Object.keys(coverage)) {
    assert.equal(facadeVerdict({ ...coverage, [axis]: { complete: false } }, [], positions), "mixed");
  }
  assert.equal(facadeVerdict(coverage, [], [...positions.slice(0, 2), { ...positions[2], semanticRemainder: local.remainder }]), "mixed");
  assert.equal(facadeVerdict(coverage, [], [...positions, { machine: { outcome: "confirmed_missing" },
    semanticRemainder: complete.remainder }]), "confirmed_problems");
  assert.equal(assess([...paired("drawing"), ...paired("schedule")], ["unmapped-v"]).remainder.state, "open");
});

test("review compares drawing and schedule only for an approved equal value role and priority", async () => {
  const { facadeReview, requirementsFor } = await built("assessment/facade-model");
  const { evaluate, pairProofVersion } = await built("assessment/domain");
  const comparison = { sources: [
    { sourceRole: "drawing", valueRole: "design", priority: 5 },
    { sourceRole: "schedule", valueRole: "design", priority: 5 },
    { sourceRole: "schedule", valueRole: "as_built", priority: 5 },
    { sourceRole: "schedule", valueRole: "limit", priority: 5 },
  ] };
  const [requirement] = requirementsFor([{ ...fixtureRow, comparison }], context, "P");
  const boundary = { complete: false, reason: "open", basisIds: [] };
  const coverage = { inventory: boundary, map: boundary, reading: boundary, subject: boundary };
  const a = { membership: { kind: "facades", facadeIds: ["f1"] }, property: requirement.part,
    variant: "V1", printedRevision: "R1", stage: "P", runId: "run-a", addressedValue: true,
    finding: { applicability: "active", kind: "value", format: "pdf", sourceRole: "drawing", valueRole: "design", comparisonKey: "",
      citation: { observationId: "a", branch: "A", versionId: "v1", documentId: "d1", sha256: "raw-1", receiptId: "r",
        quote: "Anchor spacing 30 mm", address: { unitId: "1" }, value: "30", unit: "mm" } },
  };
  const b = { ...a, printedRevision: "R2", runId: "run-b",
    finding: { ...a.finding, sourceRole: "schedule", format: "xlsx",
      citation: { ...a.finding.citation, observationId: "b", branch: "B", versionId: "v2", documentId: "d2", sha256: "raw-2",
        quote: "Anchor spacing 4 cm", value: "4", unit: "cm" } },
  };
  const pairs = [{ a: "a", b: "b", proof: { version: pairProofVersion, variant: "V1", revisionA: "R1", revisionB: "R2", scope: "f1" } }];
  function run(facts, rule = requirement, verifiedPairs = pairs) {
    return evaluate(rule, facadeReview({ questionId: "q1", context, stage: "P", requirement: rule, facts, pairs: verifiedPairs,
      coverage, versionIds: ["v1", "v2"], supplementReceiptIds: [] }));
  }
  assert.equal(run([a, b], requirement, []).outcome, "needs_review");
  assert.equal(run([a, b]).outcome, "confirmed_conflict");
  const [typedRequirement] = requirementsFor([{ ...fixtureRow, comparison, facadeKinds: ["panel"] }],
    { ...context, facadeType: { state: "confirmed", kind: "panel" } }, "P");
  assert.equal(run([a, b], typedRequirement).outcome, "confirmed_conflict");
  for (const valueRole of ["as_built", "limit", undefined]) {
    assert.equal(run([a, { ...b, finding: { ...b.finding, valueRole } }]).outcome, "needs_review");
  }
  assert.equal(run([a, { ...b, variant: "V2" }]).outcome, "needs_review");
  assert.equal(run([a, { ...b, stage: "R" }]).outcome, "needs_review");
  const differentPriority = { ...requirement, comparison: { sources: [
    comparison.sources[0], { ...comparison.sources[1], priority: 4 },
  ] } };
  assert.equal(run([a, b], differentPriority).outcome, "needs_review");
  assert.equal(run([a, { ...b, finding: { ...b.finding, citation: { ...b.finding.citation, value: "3" } } }]).outcome, "needs_review");
  assert.equal(run([a, { ...b, finding: { ...b.finding, citation: { ...b.finding.citation, unit: "kg" } } }]).outcome, "needs_review");
});

test("per-facade verified type changes only the applicable set and expires with its binding", async () => {
  const { requirementsFor } = await built("assessment/facade-model");
  const { facadeTypeView } = await built("assessment/facade-types");
  const rows = [{ ...fixtureRow, key: "panel", facadeKinds: ["Panel"] },
    { ...fixtureRow, key: "masonry", facadeKinds: ["Masonry"] }, { ...fixtureRow, key: "generic" }];
  const fact = { id: "fact", evidenceId: "evidence", versionId: "version", designStage: "P", proposedFacadeKind: "Panel",
    facadeKindSourceVerified: true, revisionStatus: "current", revision: "R1",
    binding: { state: "identified", version: 1, candidates: [{ id: "f1" }] } };
  const assignment = { contextId: context.id, kind: "Panel", version: 1,
    basis: { ...fact, bindingVersion: 1 } };
  const ids = (facadeType) => requirementsFor(rows, { ...context, facadeType }, "P")
    .map(({ positionId, applicability }) => [positionId, applicability]);
  assert.deepEqual(ids(facadeTypeView(assignment, fact, "f1", "P")), [["panel", "applicable"], ["generic", "applicable"]]);
  const unconfirmed = facadeTypeView(undefined, undefined, "f1", "P");
  assert.deepEqual(ids(unconfirmed), [["panel", "unknown"], ["masonry", "unknown"], ["generic", "applicable"]]);
  const stale = facadeTypeView(assignment, { ...fact, binding: { ...fact.binding, version: 2 } }, "f1", "P");
  assert.equal(stale.state, "stale");
  assert.deepEqual(ids(stale), ids(unconfirmed));
  assert.equal(facadeTypeView(assignment, fact, "f2", "P").state, "stale");
  assert.equal(facadeTypeView(assignment, fact, "f1", "R").state, "stale");
  assert.equal(facadeTypeView(assignment, { ...fact, revision: "R2" }, "f1", "P").state, "stale");
});
