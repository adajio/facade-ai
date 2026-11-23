import { allowsCatalogPair } from "../access/catalog-comparison.js";
import type { Catalog } from "../access/project-state.js";
import { canonicalJson, compareCitationValues, requirementSubjectKey, type Citation } from "./domain.js";
import type { ComparisonRow } from "./facade-comparison-rows.js";
import type { ComparisonRead, FacadeObservation } from "./facade-input.js";
import { requirementsFor, type FacadeContext, type FacadeFact, type FacadeReadout } from "./facade-model.js";

export type ComparisonGap = "comparability_unproven" | "facade_link_unproven" | "facades_differ" | "variant_unproven" | "variants_differ" | "revisions_unproven" |
  "project_stage_unconfirmed" | "source_stage_unproven" | "source_stages_differ" | "source_role_unproven" |
  "value_role_unproven" | "comparison_rule_unproven" | "units_not_comparable" | "pair_verification_required";

type ComparisonSource = { citation: Citation; binding: FacadeObservation["binding"]; variant: string | null;
  stage: string | null; revision: string | null; revisionStatus: FacadeObservation["revisionStatus"];
  sourceRole: string; valueRole?: FacadeFact["finding"]["valueRole"]; clarification?: ComparisonRead[];
  row?: Pick<ComparisonRow, "value" | "context" | "canonical"> };
type ComparisonItem = { id: string; property: string; facadeId: string | null; reasons: ComparisonGap[];
  sources: [ComparisonSource, ComparisonSource] };
export type ComparisonReview = { items: ComparisonItem[]; limited: boolean };

const maxItems = 24;
const maxBranchWitnesses = 12;
const subjectKey = requirementSubjectKey;
const sourceAddress = ({ versionId, address, value, unit }: Citation) => canonicalJson([versionId, address, value, unit]);
const physicalPair = (a: Citation, b: Citation) => canonicalJson([sourceAddress(a), sourceAddress(b)].sort());
type AddressedFact = { fact: FacadeFact; observation: FacadeObservation; row?: ComparisonRow };

function placed({ fact: { membership } }: AddressedFact) {
  return membership.kind === "common" || membership.kind === "facades" && membership.facadeIds.length === 1;
}

function* comparisonGroups(groups: Iterable<Map<string, AddressedFact>>, plain: Iterable<Map<string, AddressedFact>>) {
  const byBranch = (group: Map<string, AddressedFact>) => Object.groupBy(group.values(), ({ fact }) => fact.finding.citation.branch);
  for (const group of groups) {
    const { A = [], B = [] } = byBranch(group);
    if (A.length && B.length) yield [A, B];
  }
  // An addressed property can be useful for review before its place has a facade.
  // This pairing is exploratory and is never passed to assessment or letters.
  const unidentified = ({ fact }: AddressedFact) => fact.membership.kind === "unidentified";
  for (const group of plain) {
    const { A = [], B = [] } = byBranch(group);
    if (!A.length || !B.length) continue;
    const left = A.filter(unidentified);
    const right = B.filter(unidentified);
    if (left.length) yield [left, B.filter(placed)];
    if (right.length) yield [A.filter(placed), right];
  }
}

export function comparisonReview(facts: FacadeFact[], observations: FacadeObservation[], contexts: FacadeContext[],
  catalog: Catalog | null, stage: string | null, verifiedPairs: FacadeReadout["pairs"],
  unresolved: { factId: string; label: string }[] = [],
  reads: ReadonlyMap<string, ComparisonRead[]> = new Map(),
  rows: ReadonlyMap<string, ComparisonRow> = new Map()): ComparisonReview {
  const byObservation = new Map(observations.map((observation) => [observation.id, observation]));
  const byFact = new Map(facts.map((fact) => [fact.finding.citation.observationId, fact]));
  const requirementsByFacade = new Map(contexts.map((context) =>
    [context.facadeId, requirementsFor(catalog?.requirements ?? [], context, stage)]));
  const names = new Map<string, Set<string>>();
  for (const row of catalog?.requirements ?? []) for (const name of [row.part, ...row.aliases ?? []]) {
    const key = subjectKey(name);
    const parts = names.get(key) ?? new Set();
    parts.add(subjectKey(row.part));
    names.set(key, parts);
  }
  const canonicalSubject = (name: string) => {
    const key = subjectKey(name);
    const synonyms = names.get(key);
    return synonyms?.size === 1 ? synonyms.values().next().value! : key;
  };
  const knownPairs = new Set(verifiedPairs.flatMap(({ a, b, proof }) => {
    const left = byFact.get(a);
    const right = byFact.get(b);
    return left?.property && right?.property ? [canonicalJson([canonicalSubject(left.property), proof.scope,
      physicalPair(left.finding.citation, right.finding.citation)])] : [];
  }));
  const groups = new Map<string, Map<string, AddressedFact>>();
  const byProperty = new Map<string, Map<string, AddressedFact>>();
  const rowGroups = new Map<string, Map<string, AddressedFact>>();
  const unresolvedByFact = Map.groupBy(unresolved, ({ factId }) => factId);
  let limited = false;
  for (const fact of facts) {
    const { citation, kind, applicability } = fact.finding;
    const observation = byObservation.get(citation.observationId);
    const row = rows.get(citation.observationId);
    if (observation && row && kind === "value" && applicability !== "superseded") {
      const facadeIds = row.binding.candidates.map(({ id }) => id);
      const groupKey = canonicalJson([canonicalSubject(row.property), row.scopeKey]);
      const group = rowGroups.get(groupKey) ?? new Map();
      const key = canonicalJson([citation.branch, row.key]);
      if (!group.has(key) || group.get(key)?.row?.composed && !row.composed) group.set(key, {
        fact: { ...fact, property: row.property, membership: { kind: "facades", facadeIds },
          finding: { ...fact.finding, sourceRole: row.role } },
        observation: { ...observation, binding: row.binding }, row,
      });
      rowGroups.set(groupKey, group);
    }
    if (!observation || !fact.property || kind !== "value" || !fact.addressedValue || applicability === "superseded" ||
        fact.finding.sourceRole === "other") continue;
    const property = canonicalSubject(fact.property);
    const address = canonicalJson([citation.branch, sourceAddress(citation)]);
    const byAddress = byProperty.get(property) ?? new Map();
    const entry = { fact, observation };
    const prior = byAddress.get(address);
    if (!prior || !placed(prior) && placed(entry)) byAddress.set(address, entry);
    byProperty.set(property, byAddress);
    const hints = new Set(observation.binding.candidates.flatMap(({ id, label }) => [`id:${id}`, `label:${subjectKey(label)}`]));
    for (const { label } of unresolvedByFact.get(fact.finding.citation.observationId) ?? []) hints.add(`label:${subjectKey(label)}`);
    if (observation.binding.state === "common") hints.add("common");
    for (const hint of hints) {
      const groupKey = canonicalJson([property, hint]);
      const group = groups.get(groupKey) ?? new Map();
      if (!group.has(address)) group.set(address, entry);
      groups.set(groupKey, group);
    }
  }
  const items = new Map<string, ComparisonItem>();
  const rowPairs = new Set<string>();
  const conventionalPairs = new Set<string>();
  const candidates = [
    ...comparisonGroups(rowGroups.values(), []),
    ...comparisonGroups(groups.values(), byProperty.values()),
  ];
  for (const [A, B] of candidates) {
    if (!A.length || !B.length) continue;
    if (Math.max(A.length, B.length) > maxBranchWitnesses) limited = true;
    for (const left of A.slice(0, maxBranchWitnesses)) for (const right of B.slice(0, maxBranchWitnesses)) {
      const { fact: a, observation: oa } = left;
      const { fact: b, observation: ob } = right;
      const ca = a.finding.citation;
      const cb = b.finding.citation;
      const composed = Boolean(left.row?.composed || right.row?.composed);
      if (left.row && right.row && !composed) continue;
      if (a.runId === b.runId || ca.documentId === cb.documentId || ca.sha256 === cb.sha256) continue;
      const values = compareCitationValues(ca, cb);
      if (values === "equal") continue;
      const id = canonicalJson([ca.observationId, cb.observationId]);
      const physical = physicalPair(ca, cb);
      const property = canonicalSubject(a.property!);
      const common = a.membership.kind === "common" && b.membership.kind === "common";
      const facadeId = a.membership.kind === "facades" && a.membership.facadeIds.length === 1 &&
        b.membership.kind === "facades" && b.membership.facadeIds.length === 1 &&
        a.membership.facadeIds[0] === b.membership.facadeIds[0] ? a.membership.facadeIds[0] : null;
      const comparisonKey = canonicalJson([property, common ? "common" : facadeId, physical]);
      const rowPair = left.row && right.row ? canonicalJson([left.row.key, right.row.key].sort()) : null;
      if (items.has(comparisonKey) || rowPair && rowPairs.has(rowPair) || conventionalPairs.has(physical)) continue;
      if (composed && knownPairs.has(comparisonKey)) continue;
      const requirements = common || facadeId !== null ? requirementsByFacade.get(facadeId) : undefined;
      const reasons: ComparisonGap[] = [];
      if (!common && facadeId === null) reasons.push(a.membership.kind === "facades" && a.membership.facadeIds.length === 1 &&
        b.membership.kind === "facades" && b.membership.facadeIds.length === 1 ? "facades_differ" : "facade_link_unproven");
      if (!a.variant || !b.variant) reasons.push("variant_unproven");
      else if (subjectKey(a.variant) !== subjectKey(b.variant)) reasons.push("variants_differ");
      if ([oa, ob].some(({ revision, revisionStatus }) => !revision || revisionStatus !== "current")) reasons.push("revisions_unproven");
      if (!stage) reasons.push("project_stage_unconfirmed");
      if (!a.stage || !b.stage) reasons.push("source_stage_unproven");
      else if (stage && [a.stage, b.stage].some((value) => subjectKey(value) !== subjectKey(stage))) reasons.push("source_stages_differ");
      if ([a, b].some(({ finding }) => finding.sourceRole === "unknown")) reasons.push("source_role_unproven");
      else if (requirements && catalog) {
        const allowed = requirements.some((requirement) =>
          requirement.applicability === "applicable" && [a, b].every(({ property, finding }) =>
            [requirement.part, ...requirement.aliases ?? []].some((name) => subjectKey(name) === subjectKey(property!)) &&
            requirement.sourceRoles.includes(finding.sourceRole) && requirement.formats.includes(finding.format)) &&
          allowsCatalogPair(requirement.comparison, a.finding, b.finding));
        if (!allowed) reasons.push("comparison_rule_unproven");
      } else if (!catalog || a.finding.sourceRole !== b.finding.sourceRole) reasons.push("comparison_rule_unproven");
      if (a.finding.sourceRole !== b.finding.sourceRole && (!a.finding.valueRole || !b.finding.valueRole)) reasons.push("value_role_unproven");
      if (values === "unknown") reasons.push("units_not_comparable");
      if (!reasons.length) {
        if (knownPairs.has(comparisonKey)) continue;
        reasons.push("pair_verification_required");
      }
      if (composed) reasons.unshift("comparability_unproven");
      if (items.size === maxItems) return { items: [...items.values()], limited: true };
      const source = ({ fact, observation, row }: AddressedFact): ComparisonSource => ({
        citation: fact.finding.citation, binding: observation.binding, variant: fact.variant, stage: fact.stage,
        revision: observation.revision, revisionStatus: observation.revisionStatus, sourceRole: fact.finding.sourceRole,
        ...(fact.finding.valueRole ? { valueRole: fact.finding.valueRole } : {}),
        ...(reads.has(observation.id) ? { clarification: reads.get(observation.id) } : {}),
        ...(row ? { row: { value: row.value, context: row.context, ...(row.canonical ? { canonical: row.canonical } : {}) } } : {}),
      });
      if (rowPair) {
        rowPairs.add(rowPair);
        conventionalPairs.add(physical);
      }
      items.set(comparisonKey, { id, property: a.property!, facadeId, reasons, sources: [source(left), source(right)] });
    }
  }
  return { items: [...items.values()], limited };
}
