import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson, evaluate, isInventoryRole, type Finding, type NonDeliveryStatement, type Requirement } from '../assessment/domain.js';
import { getLockedGate, getQuestions, normalizeFormat, synchronize } from '../assessment/store.js';
import { applyAssessmentUpdate, type AssessmentChange } from '../assessment/updates.js';
import type { WorkQueue } from '../gateway/queue.js';
import { transaction } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { Observation } from '../pdf/types.js';
import type { ObservationPublication } from '../questions/domain.js';
import { publishReaderObservation } from '../questions/reader.js';
import { deliveredLines, readAttributeAliases } from '../questions/attribute-aliases.js';
import { hasAddressedSubject } from '../questions/subject-evidence.js';
import type {
  Branch, Citation, ObservationInput, Place, ReaderContext, ResearchOutcome, ScheduledResearchTask, TargetQuestion,
} from './contracts.js';
import { occurrenceScope, occurrenceScopeJoin } from './occurrence-scope.js';
import type { ResearchProfile } from './profile.js';
import { researchKind } from './runner.js';

type Ref = Pick<ScheduledResearchTask, 'projectId' | 'scopeId' | 'generationId'>;

type FindingRow = {
  finding: Finding; subjectVerified: boolean | null; revision: ObservationPublication['revision'];
  observation: Observation; content: string | null;
};

function addressedSubject(target: TargetQuestion, observation: Observation, content: string | null, aliases?: string[]): boolean {
  return hasAddressedSubject({ ...target, aliases }, observation, deliveredLines(content));
}

const meaningfulRoles = new Set<string>(['design', 'schedule', 'approved_change', 'reference']);
const inquiryRoles = new Map<string, ObservationPublication['role']>([
  ['drawing', 'design'], ['model', 'design'], ['specification', 'design'], ['protocol', 'reference'],
]);

function qualifiedRole(role: string | undefined): ObservationPublication['role'] {
  if (!role) return 'unknown';
  return meaningfulRoles.has(role) ? role as ObservationPublication['role'] : inquiryRoles.get(role) ?? 'unknown';
}

function toCitation<B extends Branch>(task: Ref, finding: Finding, branch: B): Citation & { branch: B } {
  const { citation } = finding;
  const { unitId, locator, box } = citation.address as {
    unitId: string; locator?: { page?: number }; box?: Place['box'];
  };
  return {
    branch, observationId: citation.observationId, evidenceId: citation.evidenceId,
    quote: citation.quote, value: citation.value!, unit: citation.unit!,
    place: {
      source: {
        projectId: task.projectId, documentId: citation.documentId, versionId: citation.versionId, sha256: citation.sha256,
      },
      unitId, ...(locator?.page ? { page: locator.page } : {}), ...(box ? { box } : {}),
    },
  };
}

function disputeKey(a: Finding, b: Finding) {
  const address = ({ citation, comparisonKey }: Finding) => JSON.stringify([
    citation.versionId, citation.address.unitId, citation.address.box ?? null, citation.value, citation.unit, comparisonKey,
  ]);
  return JSON.stringify([address(a), address(b)].sort());
}

async function scheduleDisputes(
  tx: PoolClient, task: Ref, question: TargetQuestion,
  requirement: Parameters<typeof evaluate>[0], findings: Finding[],
) {
  const values = findings.filter((item) => item.kind === 'value' && item.applicability === 'active');
  const as = values.filter(({ citation }) => citation.branch === 'A');
  const bs = values.filter(({ citation }) => citation.branch === 'B');
  if (as.length === 0 || bs.length === 0) return;
  const { rows: existing } = await tx.query<{ a: Finding; b: Finding }>(
    `SELECT a.finding AS a,b.finding AS b FROM harness_disputes d
     JOIN harness_observations a ON a.generation_id=d.generation_id AND a.observation_id=d.a_observation_id
     JOIN harness_observations b ON b.generation_id=d.generation_id AND b.observation_id=d.b_observation_id
     WHERE d.generation_id=$1 AND d.question_id=$2`, [task.generationId, question.id]);
  const scheduled = new Set(existing.map(({ a, b }) => disputeKey(a, b)));
  for (const a of as) {
    for (const b of bs) {
      const key = disputeKey(a, b);
      if (scheduled.has(key)) continue;
      const comparison = evaluate(requirement, { findings: [a, b], remaining: [], completenessChecked: true });
      if (comparison.outcome !== 'confirmed_conflict' && !comparison.limitations.includes('readers_disagree_at_same_place')) continue;
      await tx.query(
        `INSERT INTO harness_disputes(generation_id,question_id,id,a_observation_id,b_observation_id)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [task.generationId, question.id, randomUUID(), a.citation.observationId, b.citation.observationId]);
      scheduled.add(key);
    }
  }
}

async function findingsFor(tx: PoolClient, ref: Ref, target: TargetQuestion, requirement: Requirement) {
  const { rows } = await tx.query<FindingRow>(
    `SELECT h.finding, (i.source->>'subjectVerified')::boolean AS "subjectVerified", i.source->>'revision' AS revision,
       o.payload AS observation, delivered.content
     FROM harness_observations h
     JOIN inquiry_observations i ON i.id=h.observation_id
     JOIN reader_observations o ON o.id=h.observation_id
     JOIN project_scopes s ON s.id=h.scope_id
     JOIN projects p ON p.id=s.project_id
     LEFT JOIN LATERAL (
       SELECT e.event#>>'{reply,body,content}' AS content FROM harness_research_events e
       WHERE e.job_id=o.run_id AND e.event#>>'{reply,evidence,evidenceId}'=o.evidence_id::text
       ORDER BY e.sequence LIMIT 1
     ) delivered ON h.finding->>'kind'='value' AND i.source->>'subjectVerified' IS DISTINCT FROM 'true'
     WHERE h.generation_id=$1 AND h.question_id=$2 AND NOT i.superseded
       AND NOT EXISTS (
         SELECT 1 FROM inquiry_replaced_places x WHERE x.question_id=h.question_id
         AND x.catalog_version_id=p.catalog_version_id AND x.scope_version=s.version
         AND x.version_id=i.version_id AND x.address=i.source->'address'
       )
     ORDER BY h.observation_id LIMIT 501`, [ref.generationId, target.id]);
  const aliases = rows.some(({ finding, subjectVerified }) => finding.kind === 'value' && subjectVerified !== true)
    ? await readAttributeAliases(tx, target.id) : [];
  return rows.flatMap(({ finding, revision, subjectVerified, observation, content }) => {
    if (finding.kind !== 'value' || subjectVerified) return [finding];
    if (addressedSubject(target, observation, content, aliases)) {
      return [{ ...finding, applicability: revision === 'effective' ? 'active' as const : finding.applicability }];
    }
    // An unresolved value of an inadmissible format remains available by address in the inquiry.
    if (!requirement.formats.includes(finding.format) && finding.sourceRole !== 'approved_change') return [];
    return [{ ...finding, applicability: 'unknown' as const }];
  });
}

async function updateQuestion(
  tx: PoolClient, ref: Ref, target: TargetQuestion, eventId: string,
) {
  const gate = await getLockedGate(tx, ref.projectId, ref.scopeId);
  const revision = await synchronize(tx, ref.projectId, ref.scopeId, gate);
  const question = (await getQuestions(tx, ref.scopeId, revision.version))
    .find(({ id, active }) => id === target.id && active);
  if (!question) return;
  const { rows: [coverage] } = await tx.query<{
    sealed: boolean; pending: boolean; refused: boolean; input_generation: string;
  }>(
    `SELECT g.sealed,h.input_generation,
       coalesce(bool_or(p.state='pending'),true) AS pending,
       coalesce(bool_or(p.state='final_refusal'),false) AS refused
     FROM harness_generations h JOIN gateway_generations g ON g.generation_id=h.id
     LEFT JOIN harness_primary_places hp ON hp.generation_id=h.id AND hp.question_id=$2
     LEFT JOIN gateway_primary p ON p.generation_id=h.id AND p.id=hp.obligation_id::text
     WHERE h.id=$1 AND g.current AND h.source_token=$3
     GROUP BY g.sealed,h.input_generation`,
    [ref.generationId, target.id, revision.source_token]);
  if (!coverage || coverage.input_generation !== gate.generation) return;
  // The intake gate already protects the old decision while independent readers are still running.
  const heldDecision = question.decision && gate.holds.length > 0;
  if (heldDecision && (!coverage.sealed || coverage.pending)) return;
  const all = await findingsFor(tx, ref, target, question.requirement);
  const findings = all.slice(0, 500);
  await scheduleDisputes(tx, ref, target, question.requirement, findings);
  const { rows: [review] } = await tx.query<{ pending: boolean; unclear: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM harness_disputes d
       WHERE d.generation_id=$1 AND d.question_id=$2
         AND d.a_observation_id=ANY($3::uuid[]) AND d.b_observation_id=ANY($3::uuid[]) AND (
         NOT EXISTS (SELECT 1 FROM harness_review_results r WHERE r.generation_id=$1 AND r.dispute_id=d.id AND r.stage='A')
         OR NOT EXISTS (SELECT 1 FROM harness_review_results r WHERE r.generation_id=$1 AND r.dispute_id=d.id AND r.stage='B')
       )
     ) AS pending, EXISTS(
       SELECT 1 FROM harness_disputes d JOIN harness_review_results r ON r.dispute_id=d.id AND r.generation_id=d.generation_id
       WHERE d.generation_id=$1 AND d.question_id=$2 AND r.result->>'verdict'='unclear'
         AND d.a_observation_id=ANY($3::uuid[]) AND d.b_observation_id=ANY($3::uuid[])
     ) AS unclear`, [ref.generationId, question.id, findings.map(({ citation }) => citation.observationId)]);
  if (heldDecision && review.pending) return;
  const remaining = [
    ...(!coverage.sealed ? ['inventory_open'] : []),
    ...(coverage.pending ? ['primary_coverage_pending'] : []),
    ...(coverage.refused ? ['primary_place_unreadable'] : []),
    ...(review.pending ? ['dispute_pending'] : []),
    ...(review.unclear ? ['dispute_unresolved'] : []),
    ...(all.length > 500 ? ['review_finding_limit'] : []),
  ];
  if (question.review && canonicalJson(question.review.remaining) === canonicalJson(remaining) &&
    canonicalJson(question.review.findings.map(({ citation, applicability }) => [citation.observationId, applicability])) ===
      canonicalJson(findings.map(({ citation, applicability }) => [citation.observationId, applicability]))) return;
  const change: AssessmentChange = {
    questionId: question.id, expectedDependencyVersion: question.dependency_version,
    review: {
      inputGeneration: gate.generation,
      completenessChecked: remaining.length === 0,
      remaining,
      ...(findings.some(({ nonDelivery }) => nonDelivery) ? { researchGenerationId: ref.generationId } : {}),
      findings: findings.map(({ kind, sourceRole, comparisonKey, applicability, citation, nonDelivery }) => ({
        kind, sourceRole, comparisonKey, applicability, observationId: citation.observationId,
        ...(nonDelivery ? { nonDelivery } : {}),
      })),
    },
  };
  await applyAssessmentUpdate(tx, {
    projectId: ref.projectId, scopeId: ref.scopeId, eventId, reason: 'primary_research_update', changes: [change],
  });
}

export function publication(db: Pool, queue: WorkQueue, profile: ResearchProfile) {
  return {
    async readyReview(): Promise<boolean> {
      const { rows: [candidate] } = await db.query<{
        id: string; generationId: string; projectId: string; scopeId: string; questionId: string; a: Finding; b: Finding;
      }>(
        `SELECT d.id,d.generation_id AS "generationId",g.project_id AS "projectId",g.scope_id AS "scopeId",
           d.question_id AS "questionId",a.finding AS a,b.finding AS b
         FROM harness_disputes d JOIN gateway_generations g ON g.generation_id=d.generation_id
         JOIN harness_observations a ON a.generation_id=d.generation_id AND a.observation_id=d.a_observation_id
         JOIN harness_observations b ON b.generation_id=d.generation_id AND b.observation_id=d.b_observation_id
         WHERE g.current AND g.sealed
           AND NOT EXISTS (SELECT 1 FROM gateway_primary p WHERE p.generation_id=g.generation_id AND p.state='pending')
           AND NOT EXISTS (
             SELECT 1 FROM gateway_attempts r WHERE r.generation_id=g.generation_id
             AND r.purpose IN ('primary_a','primary_b') AND r.state IN ('reserved','prepared','sending','unknown')
           )
           AND NOT EXISTS (SELECT 1 FROM gateway_jobs j WHERE j.generation_id=g.generation_id AND j.job_key='lead:'||d.id)
         ORDER BY g.project_id,d.id LIMIT 1`);
      if (!candidate) return false;
      await transaction(db, async (tx) => {
        const { id, generationId, projectId, scopeId, questionId, a, b } = candidate;
        await lockIntakeProject(tx, projectId);
        const gate = await getLockedGate(tx, projectId, scopeId);
        const revision = await synchronize(tx, projectId, scopeId, gate);
        const question = (await getQuestions(tx, scopeId, revision.version)).find((row) => row.id === questionId && row.active);
        if (!question) return;
        const ref = { generationId, projectId, scopeId };
        await queue.enqueue({
          ...ref, key: `lead:${id}`, kind: researchKind, purpose: 'review', subjectId: questionId,
          payload: { mode: 'lead', dispute: {
            id, question: { id: questionId, subject: question.requirement.subject, property: question.requirement.part,
              sourceRoles: question.requirement.sourceRoles },
            a: toCitation(ref, a, 'A'), b: toCitation(ref, b, 'B'),
          }, settings: profile.lead },
        }, tx);
      });
      return true;
    },
    async observation(tx: PoolClient, context: ReaderContext, input: ObservationInput, observation: Observation) {
      const { task } = context;
      if (task.job.mode !== 'primary' || !task.job.question) return;
      const target = task.job.question;
      await getLockedGate(tx, task.projectId, task.scopeId);
      const { rows: [metadata] } = await tx.query<{ applicable: boolean; format: string }>(
        `SELECT m.format,EXISTS(
           SELECT 1 FROM intake_occurrences c
           ${occurrenceScopeJoin}
           WHERE c.version_id=m.version_id AND $2=ANY(${occurrenceScope})
         ) AS applicable
         FROM harness_document_maps m WHERE m.version_id=$1`,
        [observation.source.versionId, task.scopeId]);
      if (!metadata) throw new Error('Observation has no dispatch manifest');
      const role = qualifiedRole(input.sourceRole);
      const statement = observation.deliveryStatement;
      const assignmentRole = input.sourceRole && target.sourceRoles?.includes(input.sourceRole) ? input.sourceRole : undefined;
      const assessmentRole = statement && input.sourceRole && isInventoryRole(input.sourceRole)
        ? input.sourceRole : assignmentRole ?? 'unknown';
      const nonDelivery: NonDeliveryStatement | undefined = statement?.status === 'not_delivered' ? {
        kind: 'explicit_non_delivery', subjectQuote: statement.item, questionId: target.id, receiptId: observation.receiptId,
      } : undefined;
      const activeStatement = !statement || (statement.status === 'not_delivered' && observation.grounding === 'text');
      let subjectVerified: boolean | undefined;
      if (!statement && !input.limitation && observation.value !== undefined) {
        const addressed = await tx.query<{ content: string | null }>(
          `SELECT event#>>'{reply,body,content}' AS content FROM harness_research_events
           WHERE job_id=$1 AND event#>>'{reply,evidence,evidenceId}'=$2 ORDER BY sequence LIMIT 1`,
          [task.jobId, observation.evidenceId]);
        subjectVerified = addressedSubject(target, observation, addressed.rows[0]?.content ?? null);
      }
      const sourceInScope = assessmentRole !== 'unknown' && metadata.applicable && activeStatement;
      const active = sourceInScope && (observation.components ? subjectVerified === true : subjectVerified !== false);
      const variant = target.variant ?? observation.components?.find(({ role: componentRole }) => componentRole === 'variant')?.literal;
      const comparisonKey = JSON.stringify([task.scopeId, target.id, variant ?? '']);
      await publishReaderObservation(tx, {
        observation, projectId: task.projectId, scopeId: task.scopeId, readerJobId: task.jobId,
        subject: target.subject, property: target.property, variant,
        role, revision: sourceInScope ? 'effective' : 'unknown', priority: role, comparableContext: comparisonKey, subjectVerified,
        assessmentQuestionId: target.id, replacesConfirmed: metadata.applicable,
      });
      const finding: Finding = {
        kind: statement?.status === 'not_delivered' ? 'absence' :
          statement || input.limitation || observation.grounding === 'limited' ? 'delivery' : 'value',
        applicability: active ? 'active' : 'unknown',
        sourceRole: assessmentRole, format: normalizeFormat(metadata.format), comparisonKey,
        ...(nonDelivery ? { nonDelivery } : {}),
        citation: {
          observationId: observation.id, evidenceId: observation.evidenceId, branch: observation.branch,
          receiptId: observation.receiptId, documentId: observation.source.documentId, versionId: observation.source.versionId,
          sha256: observation.source.sha256, address: { ...observation.address }, quote: observation.quote ?? '',
          value: observation.value ?? null, unit: observation.unit ?? null, href: `/api/v1/evidence/${observation.evidenceId}`,
          ...(observation.components ? { components: observation.components } : {}),
        },
      };
      await tx.query(
        `INSERT INTO harness_observations(observation_id,project_id,scope_id,generation_id,question_id,job_id,finding)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [observation.id, task.projectId, task.scopeId, task.generationId, target.id, task.jobId, finding]);
      await updateQuestion(tx, task, target, observation.id);
    },
    async outcome(tx: PoolClient, task: ScheduledResearchTask, outcome: ResearchOutcome) {
      if (task.job.mode === 'primary') {
        if (!task.job.question) return;
        if (outcome.kind === 'covered') {
          await tx.query(
            `INSERT INTO harness_observations(observation_id,project_id,scope_id,generation_id,question_id,job_id,finding)
             SELECT DISTINCT ON (o.observation_id)
               o.observation_id,o.project_id,o.scope_id,$1,o.question_id,$2,o.finding
             FROM harness_observations o WHERE o.project_id=$3 AND o.scope_id=$4 AND o.question_id=$5
               AND o.observation_id=ANY($6::uuid[])
             ORDER BY o.observation_id,o.generation_id ON CONFLICT DO NOTHING`,
            [task.generationId, task.jobId, task.projectId, task.scopeId, task.job.question.id, outcome.observationIds]);
        }
        await updateQuestion(tx, task, task.job.question, task.jobId);
        return;
      }
      const { dispute } = task.job;
      const stage = task.job.mode === 'lead' ? 'lead' : task.job.branch;
      await tx.query(
        `INSERT INTO harness_review_results(generation_id,dispute_id,stage,result)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [task.generationId, dispute.id, stage, outcome]);
      if (outcome.kind === 'proposal') {
        const { aObservationId, bObservationId, explanation } = outcome;
        for (const branch of ['A', 'B'] as const) {
          await queue.enqueue({
            ...task, key: `verify:${dispute.id}:${branch}`, kind: researchKind, purpose: 'review',
            subjectId: dispute.question.id, payload: {
              mode: 'verify', branch, dispute, proposal: { aObservationId, bObservationId, explanation }, settings: profile[branch],
            },
          }, tx);
        }
      }
      await updateQuestion(tx, task, dispute.question, task.jobId);
    },
    async onSeal(tx: PoolClient, ref: Ref, targets: (TargetQuestion | undefined)[]) {
      for (const target of targets) {
        if (target) await updateQuestion(tx, ref, target, randomUUID());
      }
    },
    async unsettledPrior(task: ScheduledResearchTask): Promise<string | null> {
      const { rows: [prior] } = await db.query<{ id: string }>(
        `SELECT a.id FROM gateway_attempts a JOIN gateway_jobs old ON old.id=a.job_id
         WHERE old.project_id=$2 AND old.scope_id=$3 AND old.generation_id<>$1 AND old.payload=$4::jsonb
           AND a.state IN ('reserved','prepared','sending','unknown') ORDER BY a.created_at LIMIT 1`,
        [task.generationId, task.projectId, task.scopeId, task.job]);
      return prior?.id ?? null;
    },
    async loadPriorOutcome(task: ScheduledResearchTask): Promise<ResearchOutcome | null> {
      if (task.job.mode !== 'primary') return null;
      const { rows: [prior] } = await db.query<{ result: ResearchOutcome }>(
        `SELECT old.result FROM gateway_jobs old
         JOIN harness_generations prev ON prev.id=old.generation_id
         JOIN harness_generations now ON now.id=$1 AND now.source_token=prev.source_token
         WHERE old.project_id=$2 AND old.scope_id=$3 AND old.state='done' AND old.generation_id<>$1
           AND old.payload=$4::jsonb AND old.result->>'kind' IN ('covered','reviewed_no_match')
         ORDER BY prev.input_generation DESC, old.created_at DESC LIMIT 1`,
        [task.generationId, task.projectId, task.scopeId, task.job]);
      return prior?.result ?? null;
    },
  };
}
