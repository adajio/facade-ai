import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { FacadeMention } from "../harness/facade-discovery.js";
import {
  catalogOptions, getCatalog, getProject, invariantProfileRequirements, isInitialStageProfile, matchesDefaultProfile,
} from "../access/project-state.js";
import { lockIntakeProject } from "../intake/gate.js";
import { publishProjectEvent } from "../supplements/events.js";
import { canonicalJson, evaluate, normalizeFactValue, requirementSubjectKey, type ClarificationBasis } from "./domain.js";
import { matchingDocumentFacadeLink, publicDocumentFacadeLink } from './document-facades.js';
import { comparisonReview, type ComparisonReview } from "./facade-comparison.js";
import { readFacadeInput, type FacadeObservation } from "./facade-input.js";
import { approvedEvidenceSubjects } from "./facade-rule.js";
import { assessSemanticRemainder, facadeVerdict, type SemanticRemainder } from "./facade-semantic.js";
import { factEquivalenceKey, holdReviewedEvidence, type FactReviewView } from "./fact-review.js";
import { conflictingFacadeTypes, facadeTypeView, readFacadeTypes, type FacadeType } from "./facade-types.js";
import {
  facadeReview, requirementsFor, type CoverageBoundary, type FacadeCandidate, type FacadeContext,
  type FacadeCoverage, type FacadeCoverageProof,
} from "./facade-model.js";
import {
  AssessmentError, getQuestions, getRevision, makeChange, snapshot, writeQuestion, writeRevision,
  type Gate, type Question,
} from "./store.js";

type FacadeInput = Awaited<ReturnType<typeof readFacadeInput>>;
type Catalog = Awaited<ReturnType<typeof getCatalog>>;
type ActiveContext = Awaited<ReturnType<typeof synchronizeContext>>;
type CheckedInventory = {
  inventories: ClarificationBasis["inventories"];
  originals: ReadonlyMap<string, FacadeInput["versions"][number]>;
};

function mentionSource(mention: FacadeMention, observations: Map<string, FacadeObservation>) {
  const { factId, evidenceId, versionId, branch, quote, address, kind, label, context } = mention;
  const observation = observations.get(factId);
  if (!observation || observation.versionId !== versionId) return [];
  return [{ label, kind, context, citation: { versionId, evidenceId, branch, quote, address,
    documentId: observation.documentId, sha256: observation.sha256,
    href: `/api/v1/evidence/${evidenceId}` } }];
}

type MentionSource = ReturnType<typeof mentionSource>[number];

export function facadeAssessmentHref(projectId: string) {
  return `/api/v1/projects/${projectId}/facade-assessment`;
}

function boundary(reason: string, proof: FacadeCoverageProof | null, versionIds: string[]): CoverageBoundary {
  const complete = Boolean(versionIds.length && proof?.basisIds.length &&
    canonicalJson([...new Set(proof.versionIds)].sort()) === canonicalJson(versionIds));
  return { complete, reason: complete ? null : reason, basisIds: complete ? proof!.basisIds : [] };
}

function assessCoverage(input: FacadeInput): FacadeCoverage {
  const { intake, evidence, versionIds } = input;
  const ids = evidence.facades.map(({ id }) => id).sort();
  const subject = evidence.subject?.commonChecked &&
    canonicalJson([...new Set(evidence.subject.facadeIds)].sort()) === canonicalJson(ids) ? evidence.subject : null;
  const inventoryReason = !intake.closed ? "inventory_open" : intake.excluded ? "inventory_items_excluded" :
    intake.unresolvedImports ? "inventory_import_incomplete" : null;
  return {
    inventory: { complete: inventoryReason === null, reason: inventoryReason, basisIds: intake.receiptIds },
    map: boundary("physical_map_unverified", evidence.map, versionIds),
    reading: boundary("reading_incomplete", evidence.reading, versionIds),
    subject: boundary("facade_boundary_unverified", subject, versionIds),
  };
}

async function registerContexts(tx: PoolClient, projectId: string, candidates: FacadeCandidate[]): Promise<FacadeContext[]> {
  const contexts = [
    { kind: "common" as const, facadeId: null, name: "Общий уровень" },
    ...candidates.map(({ id, label }) => ({ kind: "facade" as const, facadeId: id, name: label })),
  ];
  await tx.query(
    `INSERT INTO facade_assessment_contexts (project_id,kind,facade_id)
     SELECT $1, kind, "facadeId" FROM jsonb_to_recordset($2::jsonb) t(kind text,"facadeId" uuid)
     ON CONFLICT (project_id,kind,facade_id) DO NOTHING`,
    [projectId, JSON.stringify(contexts)],
  );
  const ids = await tx.query<Omit<FacadeContext, "name">>(
    `SELECT id,kind,facade_id AS "facadeId" FROM facade_assessment_contexts WHERE project_id=$1`, [projectId],
  );
  const byFacade = new Map(ids.rows.map((context) => [context.facadeId, context.id]));
  return contexts.map((context) => ({ ...context, id: byFacade.get(context.facadeId)! }));
}

async function synchronizeContext(tx: PoolClient, projectId: string, context: FacadeContext, stage: string | null,
  catalog: Catalog | null, input: FacadeInput, coverage: FacadeCoverage, gate: Gate, limitations: string[],
  knownSubjectKeys?: ReadonlySet<string>, checkedInventory?: CheckedInventory) {
  const existing = await getRevision(tx, projectId, context.id);
  await tx.query(`INSERT INTO assessment_series(project_id,scope_id,assessment_context_id) VALUES($1,$2,$2)
    ON CONFLICT (scope_id) DO NOTHING`, [projectId, context.id]);
  const previous = existing ? await getQuestions(tx, context.id, existing.version) : [];
  const oldById = new Map(previous.map((question) => [question.id, question]));
  const rows = requirementsFor(catalog?.requirements ?? [], context, stage);
  const semanticByQuestion = new Map<string, SemanticRemainder>();
  const positionKeys = rows.map(({ positionId }) => positionId);
  const instanceKey = canonicalJson(stage);
  const { rows: identities } = await tx.query<{ id: string; positionId: string }>(
    `INSERT INTO assessment_questions AS q(scope_id,position_id,part_id)
     SELECT $1,key,$3 FROM unnest($2::text[]) key
     ON CONFLICT (scope_id,position_id,part_id) DO NOTHING
     RETURNING id,position_id AS "positionId"`, [context.id, positionKeys, instanceKey],
  );
  const byKey = new Map(identities.map(({ id, positionId }) => [positionId, id]));
  if (byKey.size !== rows.length) {
    const retained = await tx.query<{ id: string; positionId: string }>(
      `SELECT id,position_id AS "positionId" FROM assessment_questions
       WHERE scope_id=$1 AND position_id=ANY($2::text[]) AND part_id=$3`, [context.id, positionKeys, instanceKey],
    );
    for (const { id, positionId } of retained.rows) byKey.set(positionId, id);
  }

  const change = makeChange("facade_assessment_changed", []);
  const changed: Question[] = [];
  const now = Date.now();
  const replaceByQuestion = Map.groupBy(input.replacements.filter(({ catalogVersionId }) =>
    catalogVersionId === catalog?.id), ({ questionId }) => questionId);
  const impactsByQuestion = Map.groupBy(input.impacts, ({ questionId }) => questionId);
  for (const requirement of rows) {
    const id = byKey.get(requirement.positionId)!;
    const old = oldById.get(id);
    oldById.delete(id);
    const replacements = replaceByQuestion.get(id) ?? [];
    const retired = new Set(replacements.flatMap(({ replaced }) =>
      replaced.map(({ versionId, address }) => canonicalJson([versionId, address]))));
    const reviewedReceipts = new Set(replacements.flatMap(({ receiptIds }) => receiptIds));
    const supplementReceiptIds = [...new Set((impactsByQuestion.get(id) ?? [])
      .map(({ receiptId }) => receiptId).filter((receiptId) => !reviewedReceipts.has(receiptId)))];
    const facts = retired.size ? input.evidence.facts.filter(({ finding: { citation } }) =>
      !retired.has(canonicalJson([citation.versionId, citation.address]))) : input.evidence.facts;
    const semantic = assessSemanticRemainder({ index: input.semantic, requirement, context, stage, catalogVersionId: catalog?.id ?? null });
    semanticByQuestion.set(id, semantic.remainder);
    const clarification = checkedInventory?.inventories.length && semantic.basisIds.length && requirement.recipient ? {
      inventories: checkedInventory.inventories, semanticBasisIds: semantic.basisIds,
      alternatives: [...new Set([...requirement.formats, ...approvedEvidenceSubjects(requirement)])].sort(),
      places: semantic.verifiedWindows.map(({ place }) => ({
        ...place.source, label: checkedInventory.originals.get(place.source.versionId)!.label,
        address: { unitId: place.unitId, ...(place.box ? { box: place.box } : {}) },
      })),
    } : undefined;
    const review = holdReviewedEvidence(facadeReview({ questionId: id, context, stage, requirement, facts,
      pairs: input.evidence.pairs, coverage, versionIds: input.versionIds, supplementReceiptIds,
      knownSubjectKeys, semanticBasisIds: semantic.basisIds, clarification }), input.factReviews);
    const machine = evaluate(requirement, review);
    const expired = old?.decision?.exclusion?.until && Date.parse(old.decision.exclusion.until) <= now;
    if (old?.active && !expired && existing?.catalog_version_id === catalog?.id &&
        canonicalJson([old.requirement, old.review, old.machine]) === canonicalJson([requirement, review, machine])) continue;
    changed.push({
      id, active: true, version: (old?.version ?? 0) + 1, dependency_version: (old?.dependency_version ?? 0) + 1,
      requirement, review, machine, decision: null, previous_decision_id: old?.decision?.id ?? old?.previous_decision_id ?? null,
    });
    if (old?.active) change.affectedQuestionIds.push(id);
    else change.addedQuestionIds.push(id);
    if (old?.decision) change.previousDecisionIds.push(old.decision.id);
  }
  for (const old of oldById.values()) {
    if (!old.active) continue;
    changed.push({ ...old, active: false, version: old.version + 1, dependency_version: old.dependency_version + 1,
      decision: null, previous_decision_id: old.decision?.id ?? old.previous_decision_id });
    change.removedQuestionIds.push(old.id);
    if (old.decision) change.previousDecisionIds.push(old.decision.id);
  }

  const scope = { id: context.id, name: context.name, stage: stage ?? "" };
  const typeBasis = context.facadeType?.version ? [context.facadeType.version, context.facadeType.state] : [];
  const documentScope = context.facadeId ? input.links.filter(({ facadeId }) => facadeId === context.facadeId)
    .map(({ versionId, version }) => [versionId, version]) : [];
  const token = canonicalJson([scope, catalog?.id ?? null, limitations, ...typeBasis,
    ...(documentScope.length ? [documentScope] : [])]);
  const revision = existing && !changed.length && existing.source_token === token ? existing :
    await writeRevision(tx, { scope_id: context.id, catalog_version_id: catalog?.id ?? null,
      source_token: token, scope, limitations }, (existing?.version ?? 0) + 1, gate, change);
  for (const question of changed) await writeQuestion(tx, revision, question);
  const questions = await getQuestions(tx, context.id, revision.version);
  return { context, revision, questions, semanticByQuestion };
}

type ContextSnapshot = Awaited<ReturnType<typeof snapshot>>;
type FacadeSummary = Omit<ContextSnapshot, "scope" | "questions"> & {
  assessmentContextId: string;
  kind: FacadeContext["kind"];
  facadeId: string | null;
  facadeType?: FacadeType;
  documentFacadeLinks?: ReturnType<typeof publicDocumentFacadeLink>[];
  previousConclusion?: { assessmentVersion: number; startWork: string; basedOnVersion: number; reason: string };
  conflictingTypes?: { kind: string; citation: Pick<FacadeObservation, "evidenceId" | "versionId" | "documentId" | "sha256" | "address"> &
    { quote?: string } }[];
  identity?: { state: "independent" | "one_branch" | "engineer"; sources: MentionSource[] };
  name: string;
  counts: Record<string, number>;
  questionHolds: { questionId: string; receiptIds: string[] }[];
  questions: (ContextSnapshot["questions"][number] & { semanticRemainder: SemanticRemainder })[];
};

async function summarize(tx: PoolClient, active: ActiveContext, gate: Gate): Promise<FacadeSummary> {
  const { context, revision, questions, semanticByQuestion } = active;
  const { scope: _scope, questions: current, ...result } = await snapshot(tx, revision, gate);
  const withRemainder = current.map((question) => ({ ...question, semanticRemainder: semanticByQuestion.get(question.id)! }));
  const open = withRemainder.some(({ semanticRemainder }) => semanticRemainder.state === "open");
  const known = withRemainder.some(({ outcome }) => outcome !== "needs_review");
  const outcome = open ? known ? "mixed" : "needs_review" : result.outcome;
  const counts: Record<string, number> = { covered: 0, confirmed_missing: 0, confirmed_conflict: 0, needs_review: 0, excluded: 0 };
  for (const { outcome } of withRemainder) counts[outcome]++;
  return {
    ...result, assessmentContextId: context.id, kind: context.kind, facadeId: context.facadeId, name: context.name, counts,
    ...(context.facadeType ? { facadeType: context.facadeType } : {}), questions: withRemainder, outcome,
    limitations: open ? [...result.limitations, "semantic_remainder_open"] : result.limitations,
    questionHolds: questions.flatMap(({ id, active, review }) => active && review?.supplementReceiptIds?.length ?
      [{ questionId: id, receiptIds: review.supplementReceiptIds }] : []),
  };
}

type FacadeSnapshot = {
  acceptedVersions?: number;
  projectId: string;
  catalogVersionId: string | null;
  catalog: Pick<Catalog, "id" | "key" | "name" | "revision"> | null;
  profile?: { state: string; confirmedKinds: string[] };
  comparisonReview?: ComparisonReview;
  unresolvedMentions?: { items: MentionSource[]; limited: boolean };
  stage: string | null;
  coverage: FacadeCoverage;
  activeWindows: number;
  completedWindows: number;
  structurallyReviewedWindows: number;
  limitations: string[];
  contexts: FacadeSummary[];
  observations: {
    counts: Record<FacadeObservation["binding"]["state"], number>;
    proposalCounts: Record<"stage" | "facadeKind", number>;
    refs: string[];
  };
  outcome: "sufficient" | "confirmed_problems" | "mixed" | "needs_review";
};

export async function synchronizeFacadeAssessment(tx: PoolClient, projectId: string) {
  await lockIntakeProject(tx, projectId);
  const project = await getProject(tx, projectId);
  const pinned = project.catalogVersionId ? await getCatalog(tx, project.organizationId, project.catalogVersionId) : null;
  const input = await readFacadeInput(tx, projectId);
  const latest = await readFacadeSnapshot(tx, projectId);
  const coverage = assessCoverage(input);
  const gate: Gate = { generation: input.intake.generation, holds: input.holds };
  const contexts = await registerContexts(tx, projectId, input.evidence.facades);
  const assignments = await readFacadeTypes(tx, projectId);
  const currentVersions = new Set(input.versionIds);
  const observationsById = new Map(input.observations.map((fact) => [fact.id, fact]));
  const typesByFacade = Map.groupBy(input.observations.filter(({ facadeKindSourceVerified, binding }) =>
    facadeKindSourceVerified && binding.candidates.length === 1), ({ binding }) => binding.candidates[0].id);
  const conflicted = new Map<string, FacadeObservation[]>();
  for (const context of contexts) {
    if (!context.facadeId) continue;
    const assignment = assignments.get(context.id);
    const conflicts = conflictingFacadeTypes(typesByFacade.get(context.facadeId) ?? [], context.facadeId, project.stage);
    if (conflicts.length) conflicted.set(context.facadeId, conflicts);
    const basis = assignment?.basis;
    const originalLink = basis?.provenanceKind === 'engineer_override' ?
      matchingDocumentFacadeLink(input.linksByVersion.get(basis.versionId), basis.address) : undefined;
    const currentOriginal = basis && currentVersions.has(basis.versionId) && (!originalLink || originalLink.facadeId === context.facadeId);
    const machineBasis = basis && "id" in basis && input.factReviews.get(basis.id)?.state !== "review_required" ?
      observationsById.get(basis.id) : undefined;
    context.facadeType = facadeTypeView(assignment, machineBasis, context.facadeId, project.stage, Boolean(conflicts.length), currentOriginal);
  }
  const types = contexts.flatMap(({ facadeId, facadeType }) => facadeId ? [facadeType?.state === "confirmed" ? facadeType.kind : null] : []);
  const knownKinds = [...new Set(types.filter((type): type is string => type !== null))].sort();
  const staleProfile = !isInitialStageProfile(pinned?.defaultProfile) && project.facadeKindsFromAssignments && (types.includes(null) ||
    canonicalJson(knownKinds) !== canonicalJson(project.confirmedFacadeKinds));
  const retained = staleProfile && pinned ? await invariantProfileRequirements(tx, project, pinned, knownKinds) : [];
  const catalog = pinned && (!project.intakeMode || !staleProfile && matchesDefaultProfile(project, pinned)) ? pinned :
    pinned && retained.length ? { ...pinned, requirements: retained } : null;
  const checkedInventory: CheckedInventory | undefined = catalog && !gate.holds.length &&
    Object.values(coverage).every(({ complete }) => complete) ? {
      inventories: (await tx.query<ClarificationBasis["inventories"][number]>(`
        SELECT r.id AS "receiptId",r.number::text AS number,
               (SELECT concat(coalesce(max(e.id),0),':',count(*)) FROM intake_events e WHERE e.receipt_id=r.id) AS revision
          FROM intake_receipts r WHERE r.project_id=$1 AND r.sealed_at IS NOT NULL ORDER BY r.number,r.id`, [projectId])).rows,
      originals: new Map(input.versions.map((version) => [version.id, version])),
    } : undefined;
  const profileState = !project.stage ? "stage_unknown" : staleProfile ? "facade_profile_basis_stale" :
    catalog?.requirements.length ? "active" : catalog ? "catalog_empty" : pinned ? "catalog_not_applicable" :
      (await catalogOptions(tx, project)).reason;
  const catalogLimitations = staleProfile ? ["facade_profile_basis_stale"] : !catalog ? [pinned ? "catalog_not_applicable" : "catalog_unassigned"] :
    !catalog.requirements.length ? ["catalog_empty"] :
    catalog.requirements.some((row) => !("level" in row) || !["facade", "common"].includes(String(row.level))) ?
      ["catalog_scope_undeclared"] : [];
  if (!project.stage) catalogLimitations.push("stage_unknown");
  const limitations = [...catalogLimitations, ...Object.values(coverage).flatMap(({ reason }) => reason ? [reason] : [])];
  if (gate.holds.length) limitations.push("supplement_membership_unknown");
  const activeIds = new Set(contexts.map(({ id }) => id));
  for (const retired of latest?.payload.contexts ?? []) {
    if (activeIds.has(retired.assessmentContextId)) continue;
    await synchronizeContext(tx, projectId, {
      id: retired.assessmentContextId, kind: retired.kind, facadeId: retired.facadeId, name: retired.name,
    }, project.stage, null, input, coverage, gate, ["facade_context_retired"]);
  }
  const active = [];
  const summaries = [];
  const knownSubjectKeys = new Set(pinned?.requirements.flatMap((row) => [
    row.part, ...row.aliases ?? [],
    ...row.evidenceRule?.allOf.flatMap(({ anyOf }) => anyOf.flatMap(({ subject }) => subject ? [subject] : [])) ?? [],
  ]).map(requirementSubjectKey));
  const documentLinks = Map.groupBy(input.links, ({ facadeId }) => facadeId);
  const previousByContext = new Map(latest?.payload.contexts.map((item) => [item.assessmentContextId, item]));
  for (const context of contexts) {
    const result = await synchronizeContext(tx, projectId, context, project.stage, catalog, input, coverage, gate,
      catalogLimitations, knownSubjectKeys, checkedInventory);
    active.push(result);
    const summary = await summarize(tx, result, gate);
    const previous = previousByContext.get(context.id);
    if (!summary.conclusion && previous?.conclusion && latest) {
      const { basis, startWork, basedOnVersion } = previous.conclusion;
      const basisVersion = basis?.kind === 'original' ? basis.original.versionId : basis?.kind === 'citation' ? basis.citation.versionId : basis?.versionId;
      const sourceChanged = basisVersion && !currentVersions.has(basisVersion);
      const reassigned = basis?.kind === 'original' && context.facadeId && matchingDocumentFacadeLink(
        input.linksByVersion.get(basis.original.versionId), basis.original.address,
      );
      const reason = sourceChanged ? 'Редакция исходного документа выбыла из действующего комплекта.' :
        reassigned && reassigned.facadeId !== context.facadeId ? 'Место исходного решения связано с другим фасадом.' :
        result.revision.change.reason === 'engineer_decision' ? 'Инженерское решение по одному из требований изменилось.' :
        'Основания или применимость изменились при обновлении оценки.';
      summary.previousConclusion = { assessmentVersion: latest.version, startWork, basedOnVersion, reason };
    } else if (!summary.conclusion && previous?.previousConclusion) {
      summary.previousConclusion = previous.previousConclusion;
    }
    const links = context.facadeId ? documentLinks.get(context.facadeId) : undefined;
    if (links?.length) summary.documentFacadeLinks = links.map(publicDocumentFacadeLink);
    const identity = context.facadeId ? input.discovery.identity.get(context.facadeId) : undefined;
    if (identity && identity.identity !== "unresolved") summary.identity = {
      state: identity.identity, sources: identity.mentions.slice(0, 8).flatMap((mention) => mentionSource(mention, observationsById)),
    };
    if (context.facadeId && conflicted.has(context.facadeId)) summary.conflictingTypes = conflicted.get(context.facadeId)!.slice(0, 8)
      .map(({ proposedFacadeKind, evidenceId, versionId, documentId, sha256, address, quote }) => ({
        kind: proposedFacadeKind!, citation: { evidenceId, versionId, documentId, sha256, address, ...(quote ? { quote } : {}) },
      }));
    summaries.push(summary);
  }
  const questions = summaries.flatMap(({ questions }) => questions);
  if (questions.some(({ semanticRemainder }) => semanticRemainder.state === "open")) limitations.push("semantic_remainder_open");
  if (catalog && project.stage && !questions.length) limitations.push("no_applicable_requirements");
  const observations = input.observations.map((fact) => {
    const engineeringReview = input.factReviews.get(fact.id);
    const payload = { ...fact, equivalenceKey: factEquivalenceKey(fact), ...(engineeringReview ? { engineeringReview } : {}) };
    return { ref: `${fact.id}:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`, id: fact.id, payload };
  });
  const counts = { identified: 0, common: 0, unclear: 0, unidentified: 0 };
  const proposalCounts = { stage: 0, facadeKind: 0 };
  for (const observation of input.observations) {
    counts[observation.binding.state]++;
    if (observation.designStage && observation.basis.stage && observation.revisionStatus !== "superseded") proposalCounts.stage++;
    if (observation.proposedFacadeKind) proposalCounts.facadeKind++;
  }
  const catalogView = catalog ? { id: catalog.id, key: catalog.key, name: catalog.name, revision: catalog.revision } : null;
  const payload: FacadeSnapshot = {
    acceptedVersions: input.versions.length,
    projectId, catalogVersionId: project.catalogVersionId, catalog: catalogView, stage: project.stage, coverage, limitations, contexts: summaries,
    profile: { state: profileState, confirmedKinds: staleProfile ? knownKinds : project.confirmedFacadeKinds },
    comparisonReview: comparisonReview(input.evidence.facts, input.observations, contexts, catalog, project, input.evidence.pairs,
      input.discovery.unresolved, input.comparisonReads, input.comparisonRows),
    unresolvedMentions: { limited: input.discovery.unresolved.length > 24,
      items: input.discovery.unresolved.slice(0, 24).flatMap((mention) => mentionSource(mention, observationsById)) },
    activeWindows: input.activeWindows, completedWindows: input.completedWindows,
    structurallyReviewedWindows: input.structurallyReviewedWindows,
    observations: { counts, proposalCounts, refs: observations.map(({ ref }) => ref).sort() },
    outcome: facadeVerdict(coverage, limitations, questions),
  };
  // PostgreSQL JSONB drops undefined object members. Compare the same serialized
  // representation that is stored, otherwise every read can publish an identical version.
  if (latest && canonicalJson(latest.payload) === canonicalJson(JSON.parse(JSON.stringify(payload)))) return { ...latest, gate, active, input, conflicted };
  const previous = new Set(latest?.payload.observations.refs);
  const newObservations = observations.filter(({ ref }) => !previous.has(ref));
  if (newObservations.length) {
    await tx.query(
      `INSERT INTO facade_assessment_observations(project_id,ref,observation_id,payload)
       SELECT $1,ref,id,payload FROM jsonb_to_recordset($2::jsonb) p(ref text,id uuid,payload jsonb)
       ON CONFLICT (project_id,ref) DO NOTHING`,
      [projectId, JSON.stringify(newObservations)],
    );
  }
  const version = (latest?.version ?? 0) + 1;
  await tx.query(`INSERT INTO facade_assessment_snapshots(project_id,version,payload) VALUES($1,$2,$3)`,
    [projectId, version, payload]);
  await publishProjectEvent(tx, projectId, { type: "facade-assessment.changed", payload: { version } });
  return { version, payload, gate, active, input, conflicted };
}

export async function readFacadeSnapshot(tx: PoolClient, projectId: string, version?: number) {
  const { rows: [row] } = await tx.query<{ version: number; payload: FacadeSnapshot }>(
    `SELECT version,payload FROM facade_assessment_snapshots
     WHERE project_id=$1 AND ($2::integer IS NULL OR version=$2) ORDER BY version DESC LIMIT 1`, [projectId, version ?? null],
  );
  return row;
}

export async function readFacadeObservationPage(tx: PoolClient, projectId: string, version: number, options: {
  binding?: FacadeObservation["binding"]["state"]; facadeId?: string; after?: string; limit: number;
  proposal?: "stage" | "facadeKind"; grouped?: boolean; observationId?: string;
}) {
  const current = await readFacadeSnapshot(tx, projectId, version);
  if (!current) throw new AssessmentError(404, "assessment_not_found", "Версия оценки недоступна.");
  const { rows } = await tx.query<{ payload: FacadeObservation & { engineeringReview?: FactReviewView } }>(
    `SELECT o.payload FROM facade_assessment_observations o
     WHERE o.project_id=$1 AND o.ref=ANY($2::text[])
       AND ($3::text IS NULL OR o.payload#>>'{binding,state}'=$3)
       AND ($4::uuid IS NULL OR o.payload#>'{binding,candidates}' @> jsonb_build_array(jsonb_build_object('id',$4::text)))
       AND ($9::uuid IS NULL OR o.observation_id=$9)
       AND ($5::uuid IS NULL OR o.observation_id>$5)
       AND ($9::uuid IS NOT NULL OR NOT $8::boolean OR o.payload#>>'{engineeringReview,mergedInto}' IS NULL)
       AND ($7::text IS NULL OR ($7='stage' AND o.payload->>'designStage' IS NOT NULL AND o.payload#>>'{basis,stage}' IS NOT NULL
          AND o.payload->>'revisionStatus'<>'superseded')
         OR ($7='facadeKind' AND o.payload->>'proposedFacadeKind' IS NOT NULL))
     ORDER BY o.observation_id LIMIT $6`,
    [projectId, current.payload.observations.refs, options.binding ?? null, options.facadeId ?? null,
      options.after ?? null, options.limit + 1, options.proposal ?? null, options.grouped ?? false, options.observationId ?? null],
  );
  const items = rows.slice(0, options.limit).map(({ payload }) => payload.normalized === undefined ?
    { ...payload, normalized: normalizeFactValue(payload.value, payload.unit) } : payload);
  return { version, items, nextCursor: rows.length > options.limit ? items.at(-1)!.id : null };
}

export async function getLockedFacadeContext(tx: PoolClient, projectId: string, contextId: string) {
  const current = await synchronizeFacadeAssessment(tx, projectId);
  const context = current.active.find(({ context }) => context.id === contextId);
  if (!context) throw new AssessmentError(404, "assessment_not_found", "Контекст оценки недоступен.");
  return { ...current, ...context };
}
