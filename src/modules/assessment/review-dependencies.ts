import { canonicalJson, evaluate, isInventoryRole, matchesRequirementSubject, type Finding, type Review } from "./domain.js";
import type { Question } from "./store.js";

const pendingReview = new Set(["inventory_open", "primary_coverage_pending", "dispute_pending"]);

export function isPendingReview(review: Review): boolean {
  return review.remaining.some((reason) => pendingReview.has(reason));
}

function setOf(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function findingKey({ citation, ...finding }: Finding): string {
  const { observationId: _observationId, evidenceId: _evidenceId, href: _href, documentRevision: _revision, ...source } = citation;
  return canonicalJson({ ...finding, source });
}

function dependencies(question: Question, review: Review) {
  const { requirement } = question;
  const { outcome, delivery, readability, limitations } = evaluate(requirement, review);
  const proof = review.inventory;
  const supports = new Set(proof?.observationIds);
  const applicable = review.findings
    .filter(({ kind, applicability, sourceRole, format, citation }) =>
      applicability !== "superseded" && (
        (requirement.sourceRoles.includes(sourceRole) && (kind === "absence" || requirement.formats.includes(format))) ||
        (kind === "absence" && isInventoryRole(sourceRole)) ||
        (citation.deliveryStatement?.status === "delivered" &&
          matchesRequirementSubject(requirement, citation.deliveryStatement.item))
      ));
  return {
    outcome,
    delivery,
    readability,
    limitations: setOf(limitations),
    remaining: setOf(review.remaining),
    completenessChecked: review.completenessChecked,
    findings: setOf(applicable.map(findingKey)),
    inventory: proof && {
      kind: proof.kind,
      receiptIds: setOf(proof.receiptIds),
      materials: setOf(proof.materials ?? []),
      currentCompositionChecked: proof.currentCompositionChecked,
      alternativesChecked: proof.alternativesChecked,
      supports: setOf(applicable.filter(({ citation }) => supports.has(citation.observationId)).map(findingKey)),
    },
  };
}

export function hasSameReviewDependencies(question: Question, review: Review): boolean {
  return question.review !== null &&
    canonicalJson(dependencies(question, question.review)) === canonicalJson(dependencies(question, review));
}
