import type { PoolClient } from 'pg';
import type { LeasedJob } from '../gateway/queue.js';
import { canonicalJson, type Finding } from '../assessment/domain.js';
import { authorizedPackageReview } from './package-review.js';
import { jobSchema, type Citation } from './contracts.js';

function matches(citation: Citation, { citation: saved }: Finding): boolean {
  const { versionId, documentId, sha256 } = citation.place.source;
  return citation.observationId === saved.observationId && citation.evidenceId === saved.evidenceId
    && versionId === saved.versionId && documentId === saved.documentId && sha256 === saved.sha256
    && citation.place.unitId === saved.address.unitId
    && canonicalJson(citation.place.box ?? null) === canonicalJson(saved.address.box ?? null)
    && citation.value === saved.value && citation.unit === saved.unit && citation.quote === saved.quote;
}

export async function reviewPairAdmission(tx: PoolClient, work: LeasedJob) {
  if (work.kind !== 'harness_research' || work.purpose !== 'review') return 'standard';
  const parsed = jobSchema.safeParse(work.payload);
  if (!parsed.success || parsed.data.mode === 'primary') return 'stale';
  const job = parsed.data;
  const { dispute } = job;
  if (work.scopeId === null) return await authorizedPackageReview(tx, work.projectId, work.generationId, job, work.lease.jobId)
    ? 'early' : 'stale';
  const key = job.mode === 'lead' ? `lead:${dispute.id}` : `verify:${dispute.id}:${job.branch}`;
  if (key !== work.key || work.subjectId !== dispute.question.id
    || [dispute.a, dispute.b].some(({ place }) => place.source.projectId !== work.projectId)) return 'stale';
  const { rows: [pair] } = await tx.query<{ independent_sources: boolean; a: Finding; b: Finding }>(
    `SELECT independent_sources,a,b FROM harness_live_review_pairs
     WHERE generation_id=$1 AND id=$2 AND question_id=$3 AND project_id=$4 AND scope_id=$5`,
    [work.generationId, dispute.id, dispute.question.id, work.projectId, work.scopeId],
  );
  if (!pair || !matches(dispute.a, pair.a) || !matches(dispute.b, pair.b)) return 'stale';
  return pair.independent_sources ? 'early' : 'standard';
}
