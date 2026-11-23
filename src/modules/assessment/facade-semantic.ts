import type { PackageWindow } from "../harness/package-analysis.js";
import type { Box } from "../pdf/types.js";
import { requirementSubjectKey, type Machine, type Requirement } from "./domain.js";
import type { FacadeContext, FacadeCoverage } from "./facade-model.js";
import { normalizeFormat } from "./store.js";

export interface FacadeSemanticCheck {
  windowId: string;
  branch: "A" | "B";
  jobId: string;
  primaryJobId?: string;
  readerVersion: string;
  facadeId: string | null;
  facadeKind?: string;
  positionId: string;
  catalogVersionId: string;
  stage: string;
  basisIds: string[];
  disposition?: "supported" | "alternatives_checked";
  subject?: string | null;
}

const resumeReading = "Открыть адрес и продолжить чтение нужной ветвью.";
const checkContent = "Проверить применимые блоки, оговорки и допустимые альтернативы по этому вопросу.";
type SemanticItem = {
  windowId: string | null;
  versionId: string;
  unitId: string | null;
  box?: Box;
  pendingBranches: ("A" | "B")[];
  blockIds?: string[];
  reason: "material_not_mapped" | "reading_pending" | "structural_remainder_open" |
    "semantic_check_missing" | "semantic_independence_unproven";
  nextAction: string;
};

export type SemanticRemainder = {
  state: "complete" | "open";
  totalWindows: number;
  verifiedWindows: number;
  alternativesVerified: boolean;
  reasons: string[];
  items: SemanticItem[];
  omittedItems: number;
};

export function facadeVerdict(coverage: FacadeCoverage, limitations: readonly string[],
  questions: { machine: Pick<Machine, "outcome">; semanticRemainder: Pick<SemanticRemainder, "state"> }[]) {
  const unresolved = !questions.length || limitations.length > 0 || Object.values(coverage).some(({ complete }) => !complete) ||
    questions.some(({ machine, semanticRemainder }) => machine.outcome === "needs_review" || semanticRemainder.state !== "complete");
  const known = questions.some(({ machine }) => machine.outcome === "covered");
  const problem = questions.some(({ machine }) => machine.outcome === "confirmed_missing" || machine.outcome === "confirmed_conflict");
  return unresolved ? known || problem ? "mixed" : "needs_review" : problem ? "confirmed_problems" : "sufficient";
}

const branches = ["A", "B"] as const;
const terminal = new Set(["covered", "reviewed_no_match"]);
const maxItems = 25;

const identity = (catalog: string | null, facade: string | null, position: string, stage: string) =>
  JSON.stringify([catalog, facade, position, requirementSubjectKey(stage)]);

export function indexSemanticInput(windows: PackageWindow[], checks: readonly FacadeSemanticCheck[], unmappedVersionIds: string[]) {
  return {
    windows,
    byWindow: new Map(windows.map((window) => [window.id, window])),
    byFormat: Map.groupBy(windows, ({ format }) => normalizeFormat(format)),
    checks: Map.groupBy(checks, (check) => identity(check.catalogVersionId, check.facadeId, check.positionId, check.stage)),
    unmappedVersionIds,
  };
}

export function assessSemanticRemainder(input: {
  index: ReturnType<typeof indexSemanticInput>;
  requirement: Requirement;
  context: FacadeContext;
  catalogVersionId: string | null;
  stage: string | null;
}): { remainder: SemanticRemainder; basisIds: string[] } {
  const { index, requirement, context, catalogVersionId, stage } = input;
  const formats = new Set([...requirement.formats, "unknown"]);
  const admitted = [...formats].flatMap((format) => index.byFormat.get(format) ? [index.byFormat.get(format)!] : []);
  const applicable = admitted.length ? admitted : [index.windows];
  const totalWindows = applicable.reduce((sum, windows) => sum + windows.length, 0);
  const contextCurrent = !requirement.facadeKinds?.length || context.facadeType?.state === "confirmed";
  const relevant = (stage && contextCurrent
    ? index.checks.get(identity(catalogVersionId, context.facadeId, requirement.positionId, stage)) ?? [] : []).filter((check) =>
    check.disposition === "alternatives_checked" && !check.subject &&
    (!check.facadeKind || (context.facadeType?.state === "confirmed" &&
      requirementSubjectKey(check.facadeKind) === requirementSubjectKey(context.facadeType.kind))));
  const byWindow = Map.groupBy(relevant, ({ windowId }) => windowId);
  const basisIds = new Set<string>();
  const items: SemanticItem[] = index.unmappedVersionIds.slice(0, maxItems).map((versionId) => ({
    windowId: null, versionId, unitId: null, pendingBranches: [...branches], reason: "material_not_mapped",
    nextAction: "Подготовить карту оригинала и назначить адресное чтение.",
  }));
  const verified = new Set<string>();
  const attempted = new Map<string, ("A" | "B")[]>();
  for (const [windowId, proofs] of byWindow) {
    const window = index.byWindow.get(windowId);
    if (!window || (admitted.length && !formats.has(normalizeFormat(window.format))) ||
        branches.some((branch) => !terminal.has(window.branches[branch].status) || !window.structure?.branches[branch].complete)) continue;
    const options = (branch: "A" | "B") => proofs.filter((check) =>
      check.branch === branch && check.readerVersion === window.readerVersion && check.basisIds.length &&
      (check.primaryJobId ? check.primaryJobId === window.branches[branch].jobId :
        check.jobId === window.branches[branch].jobId || check.jobId === window.structure?.branches[branch].followup?.jobId));
    const right = options("B");
    const left = options("A");
    const a = left.find((candidate) => right.some((b) => candidate.jobId !== b.jobId &&
       candidate.basisIds.every((id) => !b.basisIds.includes(id))));
    const b = a && right.find((candidate) => a.jobId !== candidate.jobId && a.basisIds.every((id) => !candidate.basisIds.includes(id)));
    const pair = a && b ? [a, b] : [];
    if (pair.length) {
      verified.add(windowId);
      for (const { basisIds: ids } of pair) for (const id of ids) basisIds.add(id);
      continue;
    }
    attempted.set(windowId, [...(!left.length ? ["A" as const] : []), ...(!right.length ? ["B" as const] : [])]);
  }
  const outstanding = totalWindows - verified.size + index.unmappedVersionIds.length;
  if (items.length < maxItems && verified.size < totalWindows) {
    collect: for (const windows of applicable) for (const window of windows) {
      if (verified.has(window.id)) continue;
      const at = { windowId: window.id, versionId: window.place.source.versionId, unitId: window.place.unitId,
        ...(window.place.box ? { box: window.place.box } : {}) };
      const pending = branches.filter((branch) => !terminal.has(window.branches[branch].status));
      const structural = branches.filter((branch) => !window.structure?.branches[branch].complete);
      const attemptsMissing = attempted.get(window.id) ?? [...branches];
      const blockIds = structural.flatMap((branch) => window.structure?.branches[branch].remaining.map(({ blockId }) => blockId) ?? []);
      items.push({ ...at, pendingBranches: pending.length ? pending : structural.length ? structural :
          attemptsMissing.length ? attemptsMissing : [...branches],
        ...(blockIds.length ? { blockIds: [...new Set(blockIds)].slice(0, maxItems) } : {}),
        reason: pending.length ? "reading_pending" : structural.length ? "structural_remainder_open" :
          attemptsMissing.length ? "semantic_check_missing" : "semantic_independence_unproven",
        nextAction: pending.length || structural.length ? resumeReading : checkContent });
      if (items.length >= maxItems) break collect;
    }
  }
  const reasons: string[] = [...new Set(items.map(({ reason }) => reason))];
  if (!totalWindows) reasons.push("semantic_no_mapped_material");
  if (!contextCurrent) reasons.push("facade_type_unconfirmed");
  if (requirement.applicability !== "applicable") reasons.push("applicability_unknown");
  const alternativesVerified = !reasons.length && verified.size === totalWindows;
  return {
    remainder: { state: reasons.length ? "open" : "complete", totalWindows, verifiedWindows: verified.size, alternativesVerified, reasons,
      items, omittedItems: Math.max(0, outstanding - items.length) },
    basisIds: alternativesVerified ? [...basisIds].sort() : [],
  };
}
