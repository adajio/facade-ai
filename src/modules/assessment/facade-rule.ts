import {
  canonicalJson, compareCitationValues, matchesRequirementSubject, requirementSubjectKey, type EvidenceOption,
  type Finding, type Requirement,
} from "./domain.js";
import { comparisonSource } from "../access/catalog-comparison.js";
import type { FacadeFact } from "./facade-model.js";
import { normalizeFormat } from "./store.js";

type Candidate = { original: string; ids: [string, string]; priority: number };

function place({ citation }: Finding) {
  return canonicalJson([citation.sha256, citation.address]);
}

function eligible(requirement: Requirement, option: EvidenceOption, fact: FacadeFact, finding: Finding) {
  const { sourceRole, format, applicability, citation, representation, kind } = finding;
  return applicability === "active" && !citation.deliveryStatement &&
    sourceRole === option.sourceRole.trim().toLowerCase() && requirement.sourceRoles.includes(sourceRole) &&
    requirement.formats.includes(format) && (!option.formats || option.formats.some((item) => normalizeFormat(item) === format)) &&
    (!option.representations || (representation != null && option.representations.includes(representation))) &&
    (!option.valueRole || finding.valueRole === option.valueRole) &&
    (kind === "value" || (option.mode === "presence" && kind === "delivery")) && fact.property != null &&
    (option.subject ? requirementSubjectKey(fact.property) === requirementSubjectKey(option.subject) :
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
  const priorityOf = (finding: Finding) => comparisonSource(requirement.comparison, finding)?.priority ?? 0;
  const qualified = new Set<Finding>();
  const candidates = rule.allOf.map(({ anyOf }) => {
    let highest = 0;
    const options = anyOf.flatMap((option) => {
    const eligibleFindings = findings.filter((finding) => {
      const fact = facts.get(finding.citation.observationId);
      return fact && eligible(requirement, option, fact, finding);
    });
    if (option.mode !== "presence") {
      for (const finding of eligibleFindings) {
        qualified.add(finding);
        highest = Math.max(highest, priorityOf(finding));
      }
    }
    const places = Map.groupBy(eligibleFindings, place);
    const supports: Candidate[] = [];
    for (const group of places.values()) {
      for (const left of group.filter(({ citation }) => citation.branch === "A")) {
        const a = left.citation;
        const right = group.find(({ citation: b, comparisonKey }) =>
          b.branch === "B" && comparisonKey === left.comparisonKey &&
          facts.get(a.observationId)?.runId !== facts.get(b.observationId)?.runId &&
          (option.mode === "presence" || compareCitationValues(a, b) === "equal"));
        if (right) supports.push({ original: a.sha256, ids: [a.observationId, right.citation.observationId],
          priority: option.mode === "presence" ? 0 : priorityOf(left) });
      }
    }
    return supports;
    });
    return options.filter(({ priority }) => priority === highest);
  });
  if (candidates.some((group) => !group.length)) return [];
  const measured = Map.groupBy([...qualified].filter(({ kind }) => kind === "value"),
    (finding) => canonicalJson([finding.comparisonKey, priorityOf(finding)]));
  for (const group of measured.values()) {
    if (group.some(({ citation }) => compareCitationValues(group[0].citation, citation) !== "equal")) return [];
  }
  if (!rule.distinctOriginals) return [...new Set(candidates.flatMap(([first]) => first.ids))];

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
  return [...new Set([...selected.values()].flatMap(({ pair }) => pair.ids))];
}
