import {
  canonicalJson, compareCitationValues, matchesRequirementSubject, requirementSubjectKey, requiresDocumentApproval, type EvidenceOption,
  type Finding, type Requirement,
} from "./domain.js";
import { comparisonSource } from "../access/catalog-comparison.js";
import type { FacadeFact } from "./facade-model.js";
import { normalizeFormat } from "./store.js";

type Candidate = { original: string; ids: [string, string]; priority: number; comparisonKey: string | null; variant: string | null };
const labelKey = (value: string | null) => value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ") || null;

function place({ citation }: Finding) {
  return canonicalJson([citation.versionId, citation.sha256, citation.address]);
}

function independentPair(a: FacadeFact, b: FacadeFact) {
  return a.runId !== b.runId && a.finding.format === b.finding.format &&
    labelKey(a.printedRevision) === labelKey(b.printedRevision) &&
    (!a.stage || !b.stage || labelKey(a.stage) === labelKey(b.stage));
}

function approvalKey(fact: FacadeFact) {
  const approval = fact.documentApproval;
  return approval ? canonicalJson([approval.address, labelKey(approval.quote)]) : null;
}

function eligible(requirement: Requirement, option: EvidenceOption, fact: FacadeFact, finding: Finding) {
  const { sourceRole, format, applicability, citation, representation, kind } = finding;
  const subject = option.subject && requirementSubjectKey(option.subject);
  return applicability === "active" && !citation.deliveryStatement &&
    sourceRole === option.sourceRole.trim().toLowerCase() && requirement.sourceRoles.includes(sourceRole) &&
    requirement.formats.includes(format) && (!option.formats || option.formats.some((item) => normalizeFormat(item) === format)) &&
    (!option.representations || (representation != null && option.representations.includes(representation))) &&
    (!option.valueRole || finding.valueRole === option.valueRole) &&
    (kind === "value" || (option.mode === "presence" && kind === "delivery")) && fact.property != null &&
    (subject && subject !== requirementSubjectKey(requirement.part) ? requirementSubjectKey(fact.property) === subject :
      matchesRequirementSubject(requirement, fact.property));
}

export function facadeEvidenceGroups(requirement: Requirement, fact: FacadeFact, finding: Finding, valuesOnly = false) {
  return requirement.evidenceRule?.allOf.flatMap(({ anyOf }, index) =>
    anyOf.some((option) => (!valuesOnly || option.mode !== "presence") && eligible(requirement, option, fact, finding)) ? [index] : []) ?? [];
}

export function approvedEvidenceSubjects(requirement: Requirement) {
  return requirement.evidenceRule?.allOf.flatMap(({ anyOf }) => anyOf.flatMap(({ subject }) => subject ? [subject] : [])) ?? [];
}

export function proveFacadeRule(requirement: Requirement, facts: Map<string, FacadeFact>, findings: Finding[]): string[] {
  const rule = requirement.evidenceRule;
  if (!rule?.allOf.length) return [];
  const requireApproval = requiresDocumentApproval(requirement);
  const priorityOf = (finding: Finding) => comparisonSource(requirement.comparison, finding)?.priority ?? 0;
  const qualified = new Set<Finding>();
  const candidates = rule.allOf.map(({ anyOf }) => {
    const highest = new Map<string, number>();
    const options = anyOf.flatMap((option) => {
      const presence = option.mode === "presence";
      const eligibleFindings = findings.filter((finding) => {
        const fact = facts.get(finding.citation.observationId);
        return fact && (!requireApproval || fact.documentApproval) && eligible(requirement, option, fact, finding);
      });
      if (!presence) {
        for (const finding of eligibleFindings) {
          qualified.add(finding);
          highest.set(finding.comparisonKey, Math.max(highest.get(finding.comparisonKey) ?? 0, priorityOf(finding)));
        }
      }
      const places = Map.groupBy(eligibleFindings, place);
      const supports: Candidate[] = [];
      for (const group of places.values()) {
        for (const left of group.filter(({ citation }) => citation.branch === "A")) {
          const a = left.citation;
          const leftFact = facts.get(a.observationId)!;
          const right = group.find(({ citation: b, comparisonKey }) => {
            const rightFact = facts.get(b.observationId)!;
            return b.branch === "B" && comparisonKey === left.comparisonKey &&
              independentPair(leftFact, rightFact) &&
              (!requireApproval || approvalKey(leftFact) === approvalKey(rightFact)) &&
              (presence || compareCitationValues(a, b) === "equal");
          });
          if (right) supports.push({ original: a.sha256, ids: [a.observationId, right.citation.observationId],
            priority: presence ? 0 : priorityOf(left), comparisonKey: presence ? null : left.comparisonKey,
            variant: labelKey(leftFact.variant) });
        }
      }
      return supports;
    });
    return options.filter(({ priority, comparisonKey }) => comparisonKey === null || priority === highest.get(comparisonKey));
  });
  if (candidates.some((group) => !group.length)) return [];
  const measured = Map.groupBy([...qualified],
    (finding) => canonicalJson([finding.comparisonKey, priorityOf(finding)]));
  for (const group of measured.values()) {
    if (group.some(({ citation }) => compareCitationValues(group[0].citation, citation) !== "equal")) return [];
  }
  const variants = [...new Set([...qualified].map(({ citation }) => labelKey(facts.get(citation.observationId)!.variant))
    .filter((variant) => variant !== null))];
  const proofs = variants.length ? variants.map((variant) => selectProof(candidates.map((group) =>
    group.filter((candidate) => candidate.variant === variant || candidate.comparisonKey === null && candidate.variant === null)),
    rule.distinctOriginals)) : [selectProof(candidates, rule.distinctOriginals)];
  return proofs.some((proof) => !proof.length) ? [] : [...new Set(proofs.flat())];
}

function selectProof(candidates: Candidate[][], distinctOriginals?: boolean): string[] {
  if (candidates.some((group) => !group.length)) return [];
  if (!distinctOriginals) return candidates.flatMap(([first]) => first.ids);
  const selected = new Map<string, { group: number; pair: Candidate }>();
  function assign(group: number, visited: Set<string>): boolean {
    for (const pair of candidates[group]) {
      if (visited.has(pair.original)) continue;
      visited.add(pair.original);
      const prior = selected.get(pair.original);
      if (!prior || assign(prior.group, visited)) {
        selected.set(pair.original, { group, pair });
        return true;
      }
    }
    return false;
  }
  if (candidates.some((_, group) => !assign(group, new Set()))) return [];
  return [...selected.values()].flatMap(({ pair }) => pair.ids);
}
