import type { CatalogRequirement } from "../access/input.js";
import {
  canonicalJson, isInventoryRole, matchesRequirementSubject, pairProofVersion, requirementSubjectKey,
  type Finding, type Requirement, type Review, type VerifiedPairEvidence,
} from "./domain.js";
import { approvedEvidenceSubjects, facadeEvidenceGroups, proveFacadeRule } from "./facade-rule.js";
import { catalogRequirement, normalizeFormat } from "./store.js";

export type FacadeCandidate = { id: string; label: string };
export type FacadeMembership =
  | { kind: "facades"; facadeIds: string[] }
  | { kind: "common" }
  | { kind: "ambiguous" | "unidentified" };

export type FacadeFact = {
  membership: FacadeMembership;
  property: string | null;
  materials?: string[];
  variant: string | null;
  printedRevision: string | null;
  addressedValue?: boolean;
  stage: string | null;
  runId: string;
  finding: Finding;
};

export type FacadeCoverageProof = { versionIds: string[]; basisIds: string[] };
export type FacadeReadout = {
  facades: FacadeCandidate[];
  facts: FacadeFact[];
  map: FacadeCoverageProof | null;
  reading: FacadeCoverageProof | null;
  subject: (FacadeCoverageProof & { facadeIds: string[]; commonChecked: boolean }) | null;
  pairs: { a: string; b: string; proof: VerifiedPairEvidence }[];
};

export type CoverageBoundary = { complete: boolean; reason: string | null; basisIds: string[] };
export type FacadeCoverage = {
  inventory: CoverageBoundary;
  map: CoverageBoundary;
  reading: CoverageBoundary;
  subject: CoverageBoundary;
};

export type FacadeContext = {
  id: string;
  kind: "facade" | "common";
  facadeId: string | null;
  name: string;
};

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");

/** Accept an explicit statement whose predicate applies to the named item in the same clause. */
export function exactDeliveryStatement(quote: string, item: string, status: "delivered" | "not_delivered"): boolean {
  const escaped = normalize(item).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!escaped) return false;
  const subject = `(?:the )?(?:(?:document|file|item|материал|документ|файл|позиция) )?[«"“]?${escaped}[»"”]?`;
  const englishVerb = "(?:supplied|provided|delivered|included|sent|transmitted)";
  const russianVerb = "(?:передан[аоы]?|предоставлен[аоы]?|поставлен[аоы]?|направлен[аоы]?|приложен[аоы]?|включ[её]н[аоы]?)";
  const negative = status === "not_delivered";
  const english = "(?:(?:was|is|has been) )?" + (negative ? "not " : "") + englishVerb;
  const russian = negative ? "(?:не " + russianVerb + "|отсутствует)" : russianVerb;
  const inPackage = "(?: in (?:this|the|current) (?:package|submission|delivery)| в (?:текущем )?(?:пакете|комплекте|составе))?";
  const pattern = new RegExp("^(?:" + subject + "(?: [–—-] |: | )(?:" + english + "|" + russian + ")" + inPackage +
    "|(?:" + russian + "|" + (negative ? "not " : "") + englishVerb + ")(?:[: ]+)" + subject + ")[.!]?$", "u");
  return quote.split(/[|·;,\n]|(?<=[.!?])\s+/u).some((clause) => pattern.test(normalize(clause)));
}

export function nonDeliveryFromOriginal(quote: string, originalLine: string | undefined, item: string): boolean {
  return Boolean(originalLine?.includes(quote) && exactDeliveryStatement(quote, item, "not_delivered") &&
    exactDeliveryStatement(originalLine, item, "not_delivered") && !exactDeliveryStatement(originalLine, item, "delivered"));
}

export function requirementsFor(rows: CatalogRequirement[], context: FacadeContext, stage: string | null) {
  return rows.flatMap((row) => {
    if (row.level !== context.kind) return [];
    const rule = normalize(row.applicability);
    const expectedStage = rule.startsWith("stage:") ? rule.slice("stage:".length).trim() : null;
    if (stage && expectedStage && normalize(stage) !== expectedStage) return [];
    const unconditional = ["all", "applicable", "*", "все", "для всех", "все фасады"].includes(rule);
    return [catalogRequirement(row, stage && (unconditional || expectedStage) ? "applicable" : "unknown")];
  });
}

export function inFacadeContext(fact: FacadeFact, context: FacadeContext) {
  const { membership } = fact;
  return context.kind === "common" ? membership.kind === "common" :
    membership.kind === "facades" && membership.facadeIds.includes(context.facadeId!);
}

export function facadeReview(options: {
  questionId: string;
  context: FacadeContext;
  stage: string | null;
  requirement: Requirement;
  facts: FacadeFact[];
  pairs: FacadeReadout["pairs"];
  coverage: FacadeCoverage;
  versionIds: string[];
  supplementReceiptIds: string[];
  knownSubjectKeys?: ReadonlySet<string>;
  unclassifiedFormats?: ReadonlySet<string>;
}): Review {
  const { questionId, context, stage, requirement, facts, pairs, coverage, versionIds, supplementReceiptIds } = options;
  const sameStage = facts.filter((fact) => !(stage && fact.stage && normalize(stage) !== normalize(fact.stage)));
  const approvedSubjects = new Set(approvedEvidenceSubjects(requirement).map(requirementSubjectKey));
  const related = (subject: string) =>
    matchesRequirementSubject(requirement, subject) || approvedSubjects.has(requirementSubjectKey(subject));
  const relevant = sameStage.filter((fact) =>
    (fact.property && related(fact.property)) ||
      fact.materials?.some(related) ||
      (fact.finding.citation.deliveryStatement && related(fact.finding.citation.deliveryStatement.item)));
  const scoped = relevant.filter((fact) => inFacadeContext(fact, context) &&
    (fact.finding.sourceRole === "unknown" || requirement.sourceRoles.includes(fact.finding.sourceRole) ||
      isInventoryRole(fact.finding.sourceRole) && Boolean(fact.finding.citation.deliveryStatement)));
  const comparisonKey = (property: string | null, variant: string | null) => canonicalJson([context.id, requirement.positionId,
    variant && normalize(variant), property && matchesRequirementSubject(requirement, property) ? requirementSubjectKey(requirement.part) :
      requirementSubjectKey(property ?? "")]);
  let findings: Finding[] = scoped.map(({ finding, variant, stage: sourceStage, property }) => ({
    ...finding,
    ...(finding.nonDelivery ? { nonDelivery: { ...finding.nonDelivery, questionId } } : {}),
    format: normalizeFormat(finding.format),
    comparisonKey: comparisonKey(property, variant),
    applicability: finding.applicability === "active" && sourceStage != null && stage != null &&
      normalize(sourceStage) === normalize(stage) ? "active" as const :
      finding.applicability === "superseded" ? "superseded" as const : "unknown" as const,
  }));
  if (supplementReceiptIds.length) {
    return { findings, completenessChecked: false, remaining: ["supplement_review_required"],
      requireVerifiedPairs: true, supplementReceiptIds };
  }

  const positiveOrUncertain = relevant.some((fact) =>
    fact.finding.applicability !== "superseded" && fact.finding.kind !== "absence" &&
    (inFacadeContext(fact, context) || ["ambiguous", "unidentified"].includes(fact.membership.kind)) &&
    (fact.finding.sourceRole === "unknown" || requirement.sourceRoles.includes(fact.finding.sourceRole) ||
      fact.finding.citation.deliveryStatement?.status === "delivered"));
  const plausibleUnknown = sameStage.some((fact) => {
    const { sourceRole, format, applicability, kind } = fact.finding;
    return applicability !== "superseded" && kind !== "absence" &&
      (inFacadeContext(fact, context) || fact.membership.kind === "ambiguous" || fact.membership.kind === "unidentified") &&
      requirement.formats.includes(normalizeFormat(format)) &&
      (sourceRole === "unknown" || requirement.sourceRoles.includes(sourceRole)) &&
      (!fact.property || [fact.property, ...fact.materials ?? []]
        .some((subject) => !options.knownSubjectKeys?.has(requirementSubjectKey(subject))));
  });
  const alternativesOpen = positiveOrUncertain || plausibleUnknown ||
    requirement.formats.some((format) => options.unclassifiedFormats?.has(format));
  const complete = Object.values(coverage).every(({ complete }) => complete);
  const absence = findings.filter(({ kind, applicability, sourceRole, citation, nonDelivery }) =>
    kind === "absence" && applicability === "active" && isInventoryRole(sourceRole) &&
    nonDelivery?.kind === "explicit_non_delivery" && citation.deliveryStatement?.status === "not_delivered" &&
    exactDeliveryStatement(citation.quote, citation.deliveryStatement.item, "not_delivered") &&
    matchesRequirementSubject(requirement, citation.deliveryStatement.item));
  const byId = new Map(scoped.map((fact) => [fact.finding.citation.observationId, fact]));
  const findingById = new Map(findings.map((finding) => [finding.citation.observationId, finding]));
  const sameStatement = ({ citation }: Finding) => canonicalJson([
    citation.versionId, citation.sha256, citation.receiptId, citation.address, citation.quote, citation.deliveryStatement?.item,
  ]);
  const negativeByPlace = Map.groupBy(absence, sameStatement);
  const verifiedAbsences = [...negativeByPlace.values()].flatMap((group) => group.some(({ citation: a }) => a.branch === "A" &&
    group.some(({ citation: b }) => b.branch === "B" && byId.get(a.observationId)?.runId !== byId.get(b.observationId)?.runId))
    ? group : []);
  const inventory = complete && requirement.evidenceRule && !alternativesOpen && verifiedAbsences.length ? {
    assessmentId: questionId,
    kind: "explicit_non_delivery" as const,
    receiptIds: [...new Set(verifiedAbsences.map(({ citation }) => citation.receiptId))].sort(),
    observationIds: verifiedAbsences.map(({ citation }) => citation.observationId).sort(),
    materials: [...versionIds].sort(),
    currentCompositionChecked: true,
    alternativesChecked: true,
  } : undefined;

  const activated = new Map<string, Finding>();
  const confirmedPairs = pairs.flatMap(({ a, b, proof }) => {
    const left = byId.get(a);
    const right = byId.get(b);
    if (!left || !right || left.runId === right.runId || proof.version !== pairProofVersion ||
        proof.scope !== (context.facadeId ?? "common") || !proof.variant ||
        (left.variant && normalize(left.variant) !== normalize(proof.variant)) ||
        (right.variant && normalize(right.variant) !== normalize(proof.variant)) ||
        !proof.revisionA || !proof.revisionB ||
        (left.printedRevision && normalize(left.printedRevision) !== normalize(proof.revisionA)) ||
        (right.printedRevision && normalize(right.printedRevision) !== normalize(proof.revisionB)) ||
        !stage || !left.stage || !right.stage || normalize(stage) !== normalize(left.stage) ||
        normalize(stage) !== normalize(right.stage)) return [];
    const prepare = (fact: FacadeFact, id: string, revision: string): Finding | undefined => {
      const finding = findingById.get(id);
      if (!finding || finding.kind !== "value" || finding.applicability === "superseded" ||
          (finding.applicability !== "active" && !fact.addressedValue) ||
          !requirement.sourceRoles.includes(finding.sourceRole) || !requirement.formats.includes(finding.format)) return;
      return { ...finding, applicability: "active", comparisonKey: comparisonKey(fact.property, proof.variant),
        citation: { ...finding.citation, verifiedRevision: revision } };
    };
    const leftFinding = prepare(left, a, proof.revisionA);
    const rightFinding = prepare(right, b, proof.revisionB);
    if (!leftFinding || !rightFinding || leftFinding.comparisonKey !== rightFinding.comparisonKey) return [];
    if (requirement.evidenceRule) {
      const leftGroups = facadeEvidenceGroups(requirement, left, leftFinding, true);
      const rightGroups = facadeEvidenceGroups(requirement, right, rightFinding, true);
      if (!leftGroups.some((group) => rightGroups.includes(group))) return [];
    }
    activated.set(a, leftFinding);
    activated.set(b, rightFinding);
    return [{ a, b, proofVersion: pairProofVersion }];
  });
  findings = findings.map((finding) => activated.get(finding.citation.observationId) ?? finding);

  // A verified local value may be known while the package has unread places.
  // Missing data, in contrast, needs a current negative proof over the package.
  const packageCoverageIds = proveFacadeRule(requirement, byId, findings);
  const localChecked = Boolean(inventory) || packageCoverageIds.length > 0;
  return {
    findings,
    completenessChecked: localChecked,
    remaining: localChecked ? [] : [!requirement.evidenceRule ? "catalog_evidence_rule_unset" :
      verifiedAbsences.length && alternativesOpen ? "alternatives_unverified" : "required_evidence_incomplete"],
    ...(inventory ? { inventory } : {}),
    confirmedPairs,
    requireVerifiedPairs: true,
    packageCoverageIds,
  };
}
