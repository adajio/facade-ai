import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkQueue } from '../gateway/queue.js';
import { hash, transaction } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import { type Branch, type Citation, type ResearchOutcome, type ResearchSettings,
  type ScheduledResearchJob, type ScheduledResearchTask } from './contracts.js';
import { readPackageAnalysis, type PackageFact } from './package-analysis.js';
import type { ResearchProfile } from './profile.js';
import { researchKind } from './runner.js';

type PairJob = Extract<ScheduledResearchJob, { mode: 'lead' | 'verify' }>;
type LeadJob = Extract<PairJob, { mode: 'lead' }>;
type PinnedRoute = { settings: ResearchSettings; revision: string };

function citation<B extends Branch>(fact: PackageFact, branch: B): Citation & { branch: B } {
  const { observation } = fact;
  const { address, source, quote, evidenceId, value, unit } = observation;
  return { branch, observationId: fact.id, evidenceId, quote: quote!, value: value!,
    unit: unit ?? '', place: { source, unitId: address.unitId,
      ...(typeof address.locator?.page === 'number' ? { page: address.locator.page } : {}),
      ...(address.box ? { box: address.box } : {}) } };
}

export async function schedulePackageReview(db: Pool, queue: WorkQueue, profile: ResearchProfile) {
  if (!profile.A || !profile.B || !profile.lead || new Set([profile.A.model, profile.B.model, profile.lead.model]).size !== 3) return false;
  const { rows: projects } = await db.query<{ projectId: string; generationId: string }>(
    `SELECT p.project_id AS "projectId",p.generation_id AS "generationId" FROM harness_package_projects p
     WHERE EXISTS (SELECT 1 FROM harness_package_facts f WHERE f.project_id=p.project_id)
       AND NOT EXISTS (
         SELECT 1 FROM harness_package_review_pairs r JOIN gateway_jobs lead ON lead.id=r.lead_job_id
         LEFT JOIN gateway_jobs a ON a.id=r.a_job_id LEFT JOIN gateway_jobs b ON b.id=r.b_job_id
         WHERE r.project_id=p.project_id AND (lead.state<>'done' OR a.state<>'done' OR b.state<>'done')
       )
     ORDER BY p.last_turn,p.project_id`);
  for (const project of projects) {
    const scheduled = await transaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('facade/package-review-dispatch',0))");
      await lockIntakeProject(tx, project.projectId);
      const { rows: [{ total, sameProject }] } = await tx.query<{ total: number; sameProject: number }>(
        `SELECT count(*)::int AS total,count(*) FILTER (WHERE p.project_id=$1)::int AS "sameProject"
         FROM harness_package_review_pairs p JOIN gateway_jobs j ON j.id IN (p.lead_job_id,p.a_job_id,p.b_job_id)
         WHERE j.state<>'done'`, [project.projectId]);
      if (total >= 24 || sameProject > 0) return false;
      const pinned = {} as Record<'lead' | Branch, PinnedRoute>;
      for (const slot of ['lead', 'A', 'B'] as const) {
        const settings = profile[slot]!;
        const { rows: [route] } = await tx.query<{ revision: string }>(
          `SELECT r.revision FROM gateway_routes r JOIN gateway_grants g ON g.route_id=r.id AND g.revision=r.revision
           WHERE g.project_id=$1 AND g.route_id=$2 AND g.data_class=$3 AND g.purpose='review' AND g.allowed AND r.enabled`,
          [project.projectId, settings.routeId, settings.dataClass]);
        if (!route) return false;
        pinned[slot] = { settings, revision: route.revision };
      }
      const analysis = await readPackageAnalysis(tx, project.projectId);
      const byId = new Map(analysis.facts.map((fact) => [fact.id, fact]));
      for (const { a, b, scope } of analysis.reviewCandidates) {
        const left = byId.get(a)!;
        const right = byId.get(b)!;
        const { label } = scope;
        const variant = left.variant ?? right.variant;
        const id = randomUUID();
        const job: LeadJob = { mode: 'lead', settings: pinned.lead.settings, dispute: {
          id, question: { subject: label, property: left.attribute!, ...(variant ? { variant } : {}) },
          a: citation(left, 'A'), b: citation(right, 'B'),
        }, packageReview: { scopeId: scope.id, scopeLabel: label, routeRevision: pinned.lead.revision,
          readerVersions: { A: left.observation.readerVersion, B: right.observation.readerVersion } } };
        const sources = [job.dispute.a, job.dispute.b].map(({ place, value, unit }) => hash([place, value, unit])).sort();
        const signature = hash([scope.id, variant, left.attribute, sources]);
        const result = await tx.query(
          `INSERT INTO harness_package_review_pairs(id,project_id,generation_id,a_fact_id,b_fact_id,a_binding_version,b_binding_version,
            assignment,verification_profiles,signature)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [id, project.projectId, project.generationId, a, b, left.binding.version, right.binding.version,
           job, { A: pinned.A, B: pinned.B }, signature]);
        if (!result.rowCount) continue;
        const lead = await queue.enqueue({ ...project, scopeId: null, kind: researchKind, purpose: 'review',
          key: 'package-lead:' + id, subjectId: id, payload: job, priority: 1 }, tx);
        await tx.query('UPDATE harness_package_review_pairs SET lead_job_id=$2 WHERE id=$1', [id, lead]);
        return true;
      }
      return false;
    });
    if (scheduled) return true;
  }
  return false;
}

export async function authorizedPackageReview(db: Pool | PoolClient, projectId: string, generationId: string, job: PairJob, jobId: string) {
  if (!job.packageReview || job.dispute.question.id !== undefined) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM harness_package_review_pairs p
     JOIN harness_package_projects h ON h.project_id=p.project_id AND h.generation_id=p.generation_id
     JOIN gateway_generations g ON g.generation_id=p.generation_id AND g.current AND g.scope_id IS NULL
     JOIN gateway_jobs j ON j.id=$4 AND j.project_id=p.project_id AND j.generation_id=p.generation_id
       AND j.scope_id IS NULL AND j.purpose='review' AND j.subject_id=p.id::text AND j.payload=$5
     WHERE p.project_id=$1 AND p.generation_id=$2 AND p.id=$3
       AND $4::uuid=CASE $5::jsonb->>'mode' WHEN 'lead' THEN p.lead_job_id
         ELSE CASE $5::jsonb->>'branch' WHEN 'A' THEN p.a_job_id ELSE p.b_job_id END END
       AND p.assignment->'dispute'=$5::jsonb->'dispute'
       AND NOT EXISTS (
         SELECT 1 FROM harness_package_bindings x WHERE
         (x.fact_id=p.a_fact_id AND x.version>p.a_binding_version) OR (x.fact_id=p.b_fact_id AND x.version>p.b_binding_version)
       )
       AND (SELECT count(*) FROM harness_package_facts f
         JOIN harness_package_branches b ON b.job_id=f.job_id AND b.active
         JOIN harness_package_windows w ON w.id=f.window_id AND w.project_id=p.project_id
         JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
         WHERE f.id IN (p.a_fact_id,p.b_fact_id) AND EXISTS (
           SELECT 1 FROM intake_occurrences o WHERE o.version_id=w.version_id AND o.project_id=p.project_id AND o.state='accepted')
         AND NOT EXISTS (
           SELECT 1 FROM intake_document_versions v JOIN intake_occurrences o ON o.version_id=v.id AND o.state='accepted'
           WHERE v.project_id=p.project_id AND v.replaces_version_id=w.version_id)
       )=2`,
    [projectId, generationId, job.dispute.id, jobId, job]);
  return rows.length === 1;
}

export async function publishPackageReviewOutcome(tx: PoolClient, queue: WorkQueue, task: ScheduledResearchTask, outcome: ResearchOutcome) {
  if (task.job.mode !== 'lead' || !task.job.packageReview || outcome.kind !== 'proposal' || !outcome.verifiedPair) return;
  const { job } = task;
  const { rows: [pair] } = await tx.query<{ profiles: Record<Branch, PinnedRoute>; revisionA: string | null; revisionB: string | null }>(
    `SELECT verification_profiles AS profiles,a.revision AS "revisionA",b.revision AS "revisionB" FROM harness_package_review_pairs p
     JOIN harness_package_facts a ON a.id=p.a_fact_id JOIN harness_package_facts b ON b.id=p.b_fact_id
     WHERE p.id=$1 AND lead_job_id=$2 AND p.project_id=$3`,
    [job.dispute.id, task.jobId, task.projectId]);
  if (!pair || !await authorizedPackageReview(tx, task.projectId, task.generationId, job, task.jobId)) return;
  const wireProof = outcome.verifiedPair;
  if ((pair.revisionA && pair.revisionA.toLowerCase() !== wireProof.revisionA) ||
    (pair.revisionB && pair.revisionB.toLowerCase() !== wireProof.revisionB)) return;
  const proof = { ...wireProof, scope: job.packageReview.scopeId,
    revisionA: pair.revisionA ?? wireProof.revisionA, revisionB: pair.revisionB ?? wireProof.revisionB };
  await tx.query('UPDATE harness_package_review_pairs SET proof=$2,wire_proof=$3 WHERE id=$1',
    [job.dispute.id, proof, wireProof]);
  const verifyJobs = [];
  for (const branch of ['A', 'B'] as const) {
    const { settings, revision } = pair.profiles[branch];
    const payload = { mode: 'verify', branch, dispute: job.dispute, settings,
      packageReview: { ...job.packageReview, routeRevision: revision },
      proposal: { aObservationId: outcome.aObservationId, bObservationId: outcome.bObservationId, explanation: outcome.explanation },
    };
    verifyJobs.push(await queue.enqueue({ ...task, kind: researchKind, purpose: 'review',
      key: 'package-verify:' + job.dispute.id + ':' + branch, subjectId: job.dispute.id, payload, priority: 1 }, tx));
  }
  await tx.query('UPDATE harness_package_review_pairs SET a_job_id=$2,b_job_id=$3 WHERE id=$1',
    [job.dispute.id, ...verifyJobs]);
}
