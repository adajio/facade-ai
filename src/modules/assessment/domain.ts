import type { DeliveryStatement, ReaderObservationComponent } from "../pdf/types.js";

export type Outcome =
  | "covered"
  | "confirmed_missing"
  | "confirmed_conflict"
  | "needs_review"
  | "excluded";

export type Scope = {
  id: string;
  name: string;
  stage: string;
};

export type Requirement = {
  positionId: string;
  partId: string;
  subject: string;
  part: string;
  formats: string[];
  requiredFormats: string[];
  equivalentFormats: string[];
  sourceRoles: string[];
  completeness: string;
  recipient: string | null;
  requestedAction: string;
  applicability: "applicable" | "unknown";
};

export type DocumentRevision = {
  label: string;
  quote: string;
  address: Record<string, unknown>;
  evidenceId: string;
};

export type Citation = {
  observationId: string;
  evidenceId: string;
  receiptId: string;
  documentId: string;
  versionId: string;
  sha256: string;
  address: Record<string, unknown>;
  label?: string;
  quote: string;
  value: string | null;
  unit: string | null;
  branch: "A" | "B";
  href: string;
  deliveryStatement?: DeliveryStatement;
  documentRevision?: DocumentRevision;
  components?: ReaderObservationComponent[];
};

export type NonDeliveryStatement = {
  kind: "explicit_non_delivery";
  subjectQuote: string;
  questionId: string;
  receiptId: string;
};

export type Finding = {
  citation: Citation;
  kind: "value" | "delivery" | "absence";
  applicability: "active" | "superseded" | "unknown";
  sourceRole: string;
  format: string;
  comparisonKey: string;
  nonDelivery?: NonDeliveryStatement;
};

export type InventoryProof = {
  assessmentId: string;
  kind: "explicit_non_delivery" | "exhaustive_inventory";
  receiptIds: string[];
  currentCompositionChecked: boolean;
  alternativesChecked: boolean;
  observationIds?: string[];
  researchInputGeneration?: string;
  materials?: string[];
};

export const pairProofVersion = 2;
export const pairRevalidationRequired = "pair_review_revalidation_required";
export type VerifiedPairEvidence = {
  version: typeof pairProofVersion;
  variant: string;
  revisionA: string;
  revisionB: string;
  scope: string;
};

export type Review = {
  findings: Finding[];
  remaining: string[];
  completenessChecked: boolean;
  inventory?: InventoryProof;
  confirmedPairs?: { a: string; b: string; proofVersion?: number }[];
};

export type Machine = {
  outcome: Exclude<Outcome, "excluded">;
  citations: Citation[];
  receiptIds: string[];
  delivery: "received" | "received_in_other_format" | "not_demonstrated";
  readability: "readable" | "unreadable" | "unknown";
  limitations: string[];
  inventory?: InventoryProof;
};

export type Exclusion = {
  kind: "not_required" | "work_without_data";
  until: string | null;
};

export type Decision = {
  id: string;
  action: "confirm" | "correct" | "exclude" | "revoke";
  outcome: Outcome;
  reason: string;
  requestExternal: boolean;
  catalogVersionId: string;
  authorId: string;
  createdAt: string;
  basis: Machine;
  startWorkCritical: boolean | null;
  exclusion?: Exclusion;
};

type Value = { magnitude: bigint; exponent: number; dimension: string };

const measurementUnits: ReadonlyMap<string, readonly [string, number]> = new Map([
  ["mm", ["length", 0]], ["мм", ["length", 0]],
  ["cm", ["length", 1]], ["см", ["length", 1]],
  ["m", ["length", 3]], ["м", ["length", 3]],
  ["km", ["length", 6]], ["км", ["length", 6]],
  ["g", ["mass", 0]], ["г", ["mass", 0]],
  ["kg", ["mass", 3]], ["кг", ["mass", 3]],
  ["piece", ["count", 0]], ["pcs", ["count", 0]], ["шт", ["count", 0]], ["шт.", ["count", 0]],
]);

function numericValue(value: string, unit: string | null): Value | null {
  const match = /^([+-]?)([0-9]{1,48})(?:[.,]([0-9]{1,48}))?$/.exec(value.trim());
  if (!match) return null;
  const normalizedUnit = unit?.trim() ?? "";
  const [dimension, scale] = measurementUnits.get(normalizedUnit) ?? [normalizedUnit, 0];
  const fraction = match[3] ?? "";
  return {
    magnitude: BigInt(`${match[1]}${match[2]}${fraction}`),
    exponent: scale - fraction.length,
    dimension,
  };
}

function compare(a: Citation, b: Citation): "equal" | "different" | "unknown" {
  if (a.value === null || b.value === null) return "unknown";
  const left = numericValue(a.value, a.unit);
  const right = numericValue(b.value, b.unit);
  if (left && right && left.dimension === right.dimension) {
    const exponent = Math.min(left.exponent, right.exponent);
    const leftNumber = left.magnitude * 10n ** BigInt(left.exponent - exponent);
    const rightNumber = right.magnitude * 10n ** BigInt(right.exponent - exponent);
    return leftNumber === rightNumber ? "equal" : "different";
  }
  // Categorical values require a common representation without measurement units.
  if (!left && !right && !a.unit && !b.unit) {
    const normalize = (value: string) => value.trim().normalize("NFC");
    return normalize(a.value) === normalize(b.value) ? "equal" : "different";
  }
  return "unknown";
}

function distinctConflictSources(citations: readonly Citation[]): Citation[] {
  const byVersion = new Map<string, Citation[]>();
  const distinct: Citation[] = [];
  for (const citation of citations) {
    const key = canonicalJson([citation.documentId, citation.versionId, citation.sha256]);
    const measurements = byVersion.get(key) ?? [];
    if (measurements.some((other) => compare(other, citation) === "equal")) continue;
    measurements.push(citation);
    byVersion.set(key, measurements);
    distinct.push(citation);
  }
  return distinct;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function matchesRequirementSubject(requirement: Requirement, item: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim();
  return [requirement.subject, requirement.part].some((name) => normalize(item) === normalize(name));
}

export function isInventoryRole(sourceRole: string): boolean {
  return ["inventory", "receipt_inventory", "transmittal", "опись", "сопроводительное письмо"].includes(sourceRole);
}

export function evaluate(
  requirement: Requirement,
  review: Review | null,
  manual = false,
): Machine {
  const findings = review?.findings ?? [];
  const receiptIds = [...new Set([
    ...findings.map((finding) => finding.citation.receiptId),
    ...(review?.inventory?.receiptIds ?? []),
  ])].sort();
  const deliveryCounterevidence = new Set(findings.filter(({ applicability, citation }) =>
    applicability !== "superseded" && citation.deliveryStatement?.status === "delivered" &&
    matchesRequirementSubject(requirement, citation.deliveryStatement.item)));
  const scoped = findings.filter((finding) => finding.applicability !== "superseded" &&
    (requirement.sourceRoles.includes(finding.sourceRole) ||
      (finding.kind === "absence" && isInventoryRole(finding.sourceRole)) ||
      deliveryCounterevidence.has(finding)));
  const active = scoped.filter((finding) => finding.applicability === "active");
  const supplied = active.filter((finding) => finding.kind !== "absence" && !deliveryCounterevidence.has(finding));
  const received = supplied.filter((finding) => requirement.formats.includes(finding.format));
  const values = received.filter((finding) =>
    finding.kind === "value" && finding.citation.value !== null);
  const base: Machine = {
    outcome: "needs_review",
    citations: scoped.map(({ citation }) => citation),
    receiptIds,
    delivery: received.length ? "received" : supplied.length ? "received_in_other_format" : "not_demonstrated",
    readability: values.length ? "readable" : received.length ? "unreadable" : "unknown",
    limitations: [],
  };
  if (requirement.applicability !== "applicable") {
    return { ...base, limitations: ["applicability_unknown"] };
  }
  if (review?.confirmedPairs?.length) {
    const byId = new Map(values.map((value) => [value.citation.observationId, value]));
    const supported = review.confirmedPairs.flatMap(({ a, b, proofVersion }) => {
      if (proofVersion !== pairProofVersion) return [];
      const left = byId.get(a);
      const right = byId.get(b);
      if (!left || !right || left.citation.branch !== "A" || right.citation.branch !== "B" ||
          left.citation.versionId === right.citation.versionId || left.citation.sha256 === right.citation.sha256 ||
          left.comparisonKey !== right.comparisonKey || compare(left.citation, right.citation) !== "different") return [];
      return [left.citation, right.citation];
    });
    if (supported.length) return { ...base, outcome: "confirmed_conflict",
      citations: distinctConflictSources(supported), limitations: review.remaining };
    if (review.confirmedPairs.some(({ proofVersion }) => proofVersion !== pairProofVersion)) {
      return { ...base, limitations: [...new Set([...review.remaining, pairRevalidationRequired])] };
    }
  }
  if (!review || !review.completenessChecked || review.remaining.length ||
      findings.some((finding) => finding.applicability === "unknown" ||
        (finding.applicability === "active" && finding.sourceRole === "unknown"))) {
    const limitations = review?.remaining.length ? review.remaining : ["review_incomplete"];
    return { ...base, limitations };
  }

  let conflict: [Citation, Citation] | null = null;
  let crossBranchConflict: [Citation, Citation] | null = null;
  const variants = new Set(values.map((item) => item.comparisonKey));
  const first = values[0];
  if (first && variants.size === 1) {
    const places = new Map<string, Citation>();
    for (const { citation } of values) {
      const place = canonicalJson([citation.sha256, citation.address]);
      const seen = places.get(place);
      if (seen && compare(seen, citation) !== "equal") {
        return { ...base, limitations: ["readers_disagree_at_same_place"] };
      }
      places.set(place, citation);
      const relation = compare(first.citation, citation);
      if (relation === "unknown") return { ...base, limitations: ["comparison_unresolved"] };
      if (relation === "different") {
        conflict ??= [first.citation, citation];
        if (first.citation.branch !== citation.branch) crossBranchConflict ??= [first.citation, citation];
      }
    }
  }

  const independent = (items: Finding[]) =>
    new Set(items.map((item) => item.citation.branch)).size === 2;
  if (conflict && !crossBranchConflict) {
    const [anchor, alternate] = conflict;
    const opposite = values.find(({ citation }) => citation.branch !== anchor.branch)?.citation;
    if (opposite && compare(alternate, opposite) === "different") {
      crossBranchConflict = [alternate, opposite];
    }
  }
  const pair = crossBranchConflict ?? (manual ? conflict : null);
  if (pair) {
    // A pair establishes the conflict. Include other active sources of the same compared assertion.
    const citations = distinctConflictSources([...pair, ...values.map(({ citation }) => citation)]);
    return { ...base, outcome: "confirmed_conflict", citations };
  }
  if (values.length) {
    if (variants.size !== 1 || conflict || (!manual && !independent(values))) {
      return { ...base, limitations: ["comparison_unresolved"] };
    }
    return { ...base, outcome: "covered", citations: values.map(({ citation }) => citation) };
  }
  if (received.length) return { ...base, limitations: ["required_value_unreadable"] };

  if (deliveryCounterevidence.size) return { ...base, limitations: ["non_delivery_contradicted"] };

  const inventory = review.inventory;
  const absence = active.filter((item) => item.kind === "absence" &&
    inventory?.receiptIds.includes(item.citation.receiptId) &&
    (inventory.observationIds
      ? inventory.observationIds.includes(item.citation.observationId)
      : !item.nonDelivery));
  if (inventory?.currentCompositionChecked && inventory.alternativesChecked &&
      inventory.receiptIds.length && absence.length &&
      (independent(absence) || (manual && !inventory.observationIds))) {
    return {
      ...base,
      outcome: "confirmed_missing",
      citations: absence.map(({ citation }) => citation),
      inventory,
    };
  }
  return { ...base, limitations: ["non_delivery_not_established"] };
}

export function effectiveOutcome(machine: Machine, decision: Decision | null, at: Date): Outcome {
  if (!decision || decision.action === "revoke") return machine.outcome;
  if (decision.exclusion?.until && Date.parse(decision.exclusion.until) <= at.getTime()) {
    return machine.outcome;
  }
  return decision.outcome;
}
