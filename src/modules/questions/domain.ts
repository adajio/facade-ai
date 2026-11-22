export type SourceRole = "design" | "schedule" | "approved_change" | "reference" | "unknown";
export type RevisionState = "effective" | "superseded" | "unknown";

export interface Subject {
  subject: string;
  aliases?: readonly string[];
  property: string;
  variant?: string;
}

export interface ObservationPublication extends Subject {
  observationId: string;
  projectId: string;
  scopeId: string;
  stage: string;
  receiptId: string;
  readerJobId: string;
  originalId: string;
  documentId: string;
  evidenceId: string;
  versionId: string;
  sha256: string;
  address: Record<string, unknown>;
  role: SourceRole;
  revision: RevisionState;
  priority?: string;
  comparableContext?: string;
  branch?: "A" | "B";
  format?: string;
  quote?: string;
  measurement?: { value: string; unit: string };
  readable: boolean;
  assessmentQuestionId?: string;
  generationId?: string;
  supersedesVersionIds?: readonly string[];
}

export interface OpenSupport {
  observationId: string;
  versionId: string;
  sha256: string;
  content: { kind: "text"; text: string } | { kind: "image"; bytes: Uint8Array; mediaType: string };
}

export interface InquirySearchContext {
  inquiryId: string;
  projectId: string;
  scopeId: string;
  searchVersion: number;
  generationId: string | null;
}

export interface QuestionSearchPorts {
  openSupport(source: ObservationPublication, signal: AbortSignal): Promise<OpenSupport | null>;
  checkMeaning(
    question: Subject,
    candidate: ObservationPublication,
    support: OpenSupport,
    signal: AbortSignal,
    context: InquirySearchContext,
  ): Promise<"same" | "different" | "unclear">;
}

export interface Candidate {
  source: ObservationPublication;
  reason: "subject_match" | "registered_alias" | "same_property";
  applicability: "verified" | "unreadable" | "address_unavailable" | "variant_mismatch" |
    "revision_superseded" | "revision_unknown" | "role_unknown" | "reference_only" |
    "meaning_different" | "meaning_unclear";
}

export interface Pair {
  left: ObservationPublication;
  right: ObservationPublication;
  comparison: "agreement" | "conflict";
}

export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/ё/g, "е").trim().replace(/\s+/g, " ");
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function names(subject: Subject): string[] {
  return [...new Set([subject.subject, ...subject.aliases ?? []].map(normalize))].sort();
}

export function matchReason(question: Subject, source: Subject): Candidate["reason"] {
  if (normalize(question.subject) === normalize(source.subject)) return "subject_match";
  if (names(question).some((name) => names(source).includes(name))) return "registered_alias";
  return "same_property";
}

export function checkLocalApplicability(
  question: Subject,
  source: ObservationPublication,
): Candidate["applicability"] | undefined {
  if (normalize(question.variant ?? "") !== normalize(source.variant ?? "")) return "variant_mismatch";
  if (source.revision === "superseded") return "revision_superseded";
  if (source.revision === "unknown") return "revision_unknown";
  if (source.role === "unknown") return "role_unknown";
  if (source.role === "reference") return "reference_only";
  if (!source.readable) return "unreadable";
}

const lengthPowers = new Map([
  ["мм", 0], ["mm", 0], ["см", 1], ["cm", 1], ["м", 3], ["m", 3], ["км", 6], ["km", 6],
]);
const unitAliases = new Map([["кг", "kg"], ["г", "g"], ["шт", "piece"], ["шт.", "piece"]]);

function exactValue(measurement: NonNullable<ObservationPublication["measurement"]>) {
  const parts = /^([+-]?\d{1,30})(?:[,.](\d{1,20}))?$/.exec(measurement.value.trim());
  if (!parts) return undefined;
  const [, whole, fraction = ""] = parts;
  const unit = normalize(measurement.unit);
  const lengthPower = lengthPowers.get(unit);
  if (!unit) return undefined;
  return {
    value: BigInt(whole + fraction),
    decimalPlaces: fraction.length - (lengthPower ?? 0),
    unit: lengthPower === undefined ? unitAliases.get(unit) ?? unit : "mm",
  };
}

export function makePair(left: Candidate, right: Candidate): Pair | undefined {
  const a = left.source;
  const b = right.source;
  if (
    left.applicability !== "verified" || right.applicability !== "verified" ||
    a.projectId !== b.projectId || a.scopeId !== b.scopeId || a.stage !== b.stage ||
    normalize(a.property) !== normalize(b.property) || normalize(a.variant ?? "") !== normalize(b.variant ?? "") ||
    a.readerJobId === b.readerJobId || a.originalId === b.originalId || a.sha256 === b.sha256 ||
    !a.priority || a.priority !== b.priority ||
    !a.comparableContext || a.comparableContext !== b.comparableContext ||
    !a.measurement || !b.measurement
  ) return undefined;

  const comparison = compareMeasurements(a.measurement, b.measurement);
  return comparison ? { left: a, right: b, comparison } : undefined;
}

export function compareMeasurements(
  left: NonNullable<ObservationPublication["measurement"]>,
  right: NonNullable<ObservationPublication["measurement"]>,
): Pair["comparison"] | undefined {
  const lhs = exactValue(left);
  const rhs = exactValue(right);
  if (!lhs || !rhs || lhs.unit !== rhs.unit) return undefined;
  const places = Math.max(lhs.decimalPlaces, rhs.decimalPlaces);
  const sameValue = lhs.value * 10n ** BigInt(places - lhs.decimalPlaces) ===
    rhs.value * 10n ** BigInt(places - rhs.decimalPlaces);
  return sameValue ? "agreement" : "conflict";
}
