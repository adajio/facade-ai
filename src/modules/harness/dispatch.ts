import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getLockedGate, getQuestions, synchronize } from '../assessment/store.js';
import type { WorkQueue } from '../gateway/queue.js';
import { transaction, type Obligation } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { PageMap, ReaderUnit } from '../pdf/types.js';
import { ReaderError } from '../pdf/types.js';
import type { Place, PrimaryJob, Source, TargetQuestion } from './contracts.js';
import type { ResearchTask } from './contracts.js';
import { occurrenceScope, occurrenceScopeJoin } from './occurrence-scope.js';
import type { ResearchProfile } from './profile.js';
import { researchKind } from './runner.js';

export interface IntakeJob {
  id: string;
  projectId: string;
  receiptId: string;
  documentId: string;
  versionId: string;
  sha256: string;
  format: string;
}

type OnSeal = (tx: PoolClient, ref: Pick<ResearchTask, 'projectId' | 'generationId'> & { scopeId: string }, targets: (TargetQuestion | undefined)[]) => Promise<void>;

type Unit = { id: string; page?: number; box?: Place['box']; refusal?: string };
export const jobFields = `j.id,j.project_id AS "projectId",j.receipt_id AS "receiptId",
  j.document_id AS "documentId",j.version_id AS "versionId",o.sha256,v.media_type AS format`;
export const originalJoins = `JOIN intake_originals o ON o.id=j.original_id
  JOIN intake_document_versions v ON v.id=j.version_id`;

function unitPlaces(unit: ReaderUnit, format: string): Unit[] {
  const page = typeof unit.locator?.page === 'number' ? unit.locator.page : undefined;
  const { width, height } = unit;
  if (format !== 'pdf' || !width || !height || Math.max(width, height) <= 720) {
    return [{ id: unit.id, ...(page ? { page } : {}) }];
  }
  // Overlap keeps labels which straddle two geometric windows visible in both.
  const xCount = Math.ceil(width / 640);
  const yCount = Math.ceil(height / 640);
  return Array.from({ length: yCount }, (_, row) =>
    Array.from({ length: xCount }, (_, column) => {
      const x = Math.max(0, width * column / xCount - 18);
      const y = Math.max(0, height * row / yCount - 18);
      const right = Math.min(width, width * (column + 1) / xCount + 18);
      const bottom = Math.min(height, height * (row + 1) / yCount + 18);
      return { id: unit.id, ...(page ? { page } : {}), box: { x, y, width: right - x, height: bottom - y } };
    })).flat();
}

export async function buildMap(job: IntakeJob, map: (source: Source) => Promise<PageMap>) {
  const { projectId, documentId, versionId, sha256 } = job;
  try {
    const result = await map({ projectId, documentId, versionId, sha256 });
    const units = result.units.flatMap((unit) => unitPlaces(unit, result.format));
    return {
      units: units.length ? units : [{ id: 'original', refusal: 'reader_no_physical_units' }],
      format: result.format, readerVersion: result.readerVersion,
      physicalProof: result.format === 'pdf' && result.units.length > 0 &&
        result.units.every((unit, index) => unit.locator?.page === index + 1 && unit.width && unit.height),
    };
  } catch (error) {
    if (!(error instanceof ReaderError) || ![415, 422].includes(error.statusCode)) throw error;
    return { units: [{ id: 'original', refusal: error.code }], format: job.format, readerVersion: null, physicalProof: false };
  }
}

async function isOpen(tx: PoolClient, projectId: string, scopeId: string) {
  const result = await tx.query<{ open: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM intake_receipts r WHERE r.project_id=$1
       AND EXISTS (SELECT 1 FROM intake_holds h WHERE h.receipt_id=r.id
         AND (h.closed_at IS NULL OR EXISTS (
           SELECT 1 FROM intake_reader_jobs j WHERE j.receipt_id=r.id
         )) AND (h.scope_ids IS NULL OR $2=ANY(h.scope_ids)))
       AND (r.sealed_at IS NULL OR EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.receipt_id=r.id
           AND (o.state='declared' OR o.inventory_pending)
       ) OR EXISTS (
         SELECT 1 FROM intake_imports i WHERE i.receipt_id=r.id AND i.state IN ('queued','running','paused')
       ) OR EXISTS (
         SELECT 1 FROM intake_reader_jobs j WHERE j.receipt_id=r.id AND j.dispatched_at IS NULL
       ))
     ) AS open`, [projectId, scopeId]);
  return result.rows[0].open;
}

async function addPlaces(
  tx: PoolClient, queue: WorkQueue, ref: { projectId: string; scopeId: string; generationId: string },
  mapped: IntakeJob & { units: Unit[] }, questions: (TargetQuestion | undefined)[], profile: ResearchProfile,
) {
  const { versionId, projectId, documentId, sha256 } = mapped;
  for (const unit of mapped.units) {
    for (const question of questions) {
      const { id: unitId, refusal, ...address } = unit;
      const place = { source: { versionId, projectId, documentId, sha256 }, unitId, ...address };
      const key = JSON.stringify([versionId, unitId, unit.box ?? null, question?.id ?? null]);
      for (const branch of ['A', 'B'] as const) {
        const obligationId = randomUUID();
        const inserted = await tx.query(
          `INSERT INTO harness_primary_places(generation_id,obligation_id,version_id,unit_key,branch,place,question_id)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [ref.generationId, obligationId, versionId, key, branch, place, question?.id ?? null]);
        if (!inserted.rowCount) continue;
        await queue.declarePrimary(ref, { id: obligationId, branch, place: key }, tx);
        const payload: PrimaryJob = {
          mode: 'primary', branch, place, observationProtocol: 2, settings: profile[branch],
          ...(question ? { question } : {}), ...(refusal ? { localRefusal: refusal } : {}),
        };
        await queue.enqueue({
          ...ref, kind: researchKind, key: `primary:${obligationId}`, subjectId: versionId, obligationId,
          purpose: branch === 'A' ? 'primary_a' : 'primary_b', payload,
        }, tx);
      }
    }
  }
}

async function reconcile(
  tx: PoolClient, queue: WorkQueue, projectId: string, scopeId: string, profile: ResearchProfile, onSeal?: OnSeal,
) {
  const gate = await getLockedGate(tx, projectId, scopeId);
  const assessment = await synchronize(tx, projectId, scopeId, gate);
  const prior = await tx.query<{ id: string; sealed_at: Date | null }>(
    `SELECT h.id,h.sealed_at FROM harness_generations h
     JOIN gateway_generations g ON g.generation_id=h.id AND g.current
     WHERE h.project_id=$1 AND h.scope_id=$2 AND h.input_generation=$3 AND h.source_token=$4`,
    [projectId, scopeId, gate.generation, assessment.source_token]);
  if (prior.rows[0]?.sealed_at) return;
  const ref = { projectId, scopeId, generationId: prior.rows[0]?.id ?? randomUUID() };
  if (!prior.rowCount) {
    await tx.query(`INSERT INTO harness_generations(id,project_id,scope_id,input_generation,source_token)
      VALUES($1,$2,$3,$4,$5)`, [ref.generationId, projectId, scopeId, gate.generation, assessment.source_token]);
    await queue.openGeneration(ref, tx);
  }
  const applicable = await tx.query<IntakeJob & { units: Unit[] }>(
    `SELECT ${jobFields}, m.physical_units AS units FROM intake_reader_jobs j
     ${originalJoins} JOIN harness_document_maps m ON m.version_id=j.version_id
     WHERE j.project_id=$1
       AND EXISTS (
         SELECT 1 FROM intake_occurrences c
         ${occurrenceScopeJoin}
         WHERE c.version_id=j.version_id AND (${occurrenceScope} IS NULL OR $2=ANY(${occurrenceScope}))
       )
       AND NOT EXISTS (
         SELECT 1 FROM intake_document_versions successor
         JOIN intake_occurrences c ON c.version_id=successor.id
         ${occurrenceScopeJoin}
         WHERE successor.replaces_version_id=j.version_id AND $2=ANY(${occurrenceScope})
       )
       AND NOT EXISTS(SELECT 1 FROM harness_primary_places hp WHERE hp.generation_id=$3 AND hp.version_id=j.version_id)
     ORDER BY j.created_at,j.id`,
    [projectId, scopeId, ref.generationId]);
  const activeQuestions: (TargetQuestion | undefined)[] = (await getQuestions(tx, scopeId, assessment.version))
    .filter((question) => question.active)
    .map(({ id, requirement }) => ({ id, subject: requirement.subject, property: requirement.part, sourceRoles: requirement.sourceRoles }));
  for (const map of applicable.rows) {
    await addPlaces(tx, queue, ref, map, activeQuestions.length ? activeQuestions : [undefined], profile);
  }
  if (await isOpen(tx, projectId, scopeId)) return;
  const { rows } = await tx.query<Obligation>(
    'SELECT obligation_id AS id,branch,unit_key AS place FROM harness_primary_places WHERE generation_id=$1 ORDER BY unit_key,branch',
    [ref.generationId]);
  await queue.sealGeneration(ref, rows, tx);
  await tx.query('UPDATE harness_generations SET sealed_at=clock_timestamp() WHERE id=$1', [ref.generationId]);
  await onSeal?.(tx, ref, activeQuestions);
}

export async function dispatchNext(
  db: Pool, queue: WorkQueue, map: (source: Source) => Promise<PageMap>, profile: ResearchProfile, onSeal?: OnSeal, packageProjects: readonly string[] = [],
): Promise<boolean> {
  const { rows: [pending] } = await db.query<IntakeJob>(
    `SELECT ${jobFields} FROM intake_reader_jobs j ${originalJoins}
     JOIN projects p ON p.id=j.project_id
     WHERE NOT p.intake_mode AND j.project_id<>ALL($1::uuid[]) AND j.dispatched_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM harness_package_projects h WHERE h.project_id=j.project_id
     ) AND NOT EXISTS (
       SELECT 1 FROM harness_map_retries f WHERE f.job_id=j.id AND f.retry_at>clock_timestamp()
     ) ORDER BY j.created_at,j.id LIMIT 1`, [[...packageProjects]]);
  if (pending) {
    let prepared;
    try {
      prepared = await buildMap(pending, map);
    } catch (error) {
      const code = error instanceof ReaderError ? error.code : 'reader_map_retry';
      await db.query(
        `INSERT INTO harness_map_retries(job_id,reason,retry_at)
         VALUES($1,$2,clock_timestamp()+interval '5 seconds')
         ON CONFLICT(job_id) DO UPDATE SET reason=EXCLUDED.reason,retry_at=EXCLUDED.retry_at`,
        [pending.id, code]);
      return true;
    }
    await transaction(db, async (tx) => {
      await lockIntakeProject(tx, pending.projectId);
      const job = await tx.query(
        'SELECT 1 FROM intake_reader_jobs WHERE id=$1 AND dispatched_at IS NULL FOR UPDATE', [pending.id]);
      if (!job.rowCount) return;
      await tx.query(
        `INSERT INTO harness_document_maps(version_id,project_id,physical_units,format)
         VALUES($1,$2,$3,$4)`, [pending.versionId, pending.projectId, JSON.stringify(prepared.units), prepared.format]);
      await tx.query('DELETE FROM harness_map_retries WHERE job_id=$1', [pending.id]);
      await tx.query('UPDATE intake_reader_jobs SET dispatched_at=clock_timestamp() WHERE id=$1', [pending.id]);
      if ((await tx.query('SELECT 1 FROM harness_package_projects WHERE project_id=$1', [pending.projectId])).rowCount) {
        return;
      }
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM project_scopes WHERE project_id=$1 ORDER BY id', [pending.projectId]);
      for (const scope of rows) await reconcile(tx, queue, pending.projectId, scope.id, profile, onSeal);
    });
    return true;
  }
  const { rows: scopes } = await db.query<{ projectId: string; scopeId: string }>(
    `SELECT s.project_id AS "projectId",s.id AS "scopeId"
     FROM project_scopes s
     WHERE s.project_id<>ALL($1::uuid[])
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id=s.project_id AND NOT p.intake_mode)
       AND NOT EXISTS (SELECT 1 FROM harness_package_projects p WHERE p.project_id=s.project_id)
       AND EXISTS(SELECT 1 FROM harness_document_maps m WHERE m.project_id=s.project_id)
       AND NOT EXISTS (
         SELECT 1 FROM harness_generations h JOIN gateway_generations g ON g.generation_id=h.id
         WHERE h.scope_id=s.id AND g.current AND h.sealed_at IS NOT NULL
       ) ORDER BY s.id`, [[...packageProjects]]);
  for (const scope of scopes) {
    await transaction(db, async (tx) => {
      await reconcile(tx, queue, scope.projectId, scope.scopeId, profile, onSeal);
    });
  }
  return false;
}
