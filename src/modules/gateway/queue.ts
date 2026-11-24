import type { Pool, PoolClient } from 'pg';
import {
  encode, GatewayError, hash, positiveInteger, transaction,
  type EnqueueInput, type QueueTarget, type Lease, type Obligation, type PrimaryResult, type Purpose,
} from './types.js';
import { currentPackagePrimary, lockPackagePrimarySlots, packagePrimaryGlobalLimit, packagePrimaryProjectLimit,
  packageResumeWaitingSlot, runnablePackagePrimary } from './package-slots.js';

const MAX_LEASE_MS = 3_600_000;

export type LeasedJob = QueueTarget & {
  lease: Lease;
  kind: string;
  purpose: Purpose;
  key: string;
  subjectId: string;
  obligationId: string | null;
  payload: unknown;
  cursor: unknown;
};

type JobRow = {
  id: string;
  project_id: string;
  scope_id: string | null;
  generation_id: string;
  job_key: string;
  kind: string;
  purpose: Purpose;
  subject_id: string;
  obligation_id: string | null;
  payload: unknown;
  cursor: unknown;
  lease_epoch: number;
  worker_id: string;
};

function job(row: JobRow): LeasedJob {
  return {
    projectId: row.project_id, scopeId: row.scope_id, generationId: row.generation_id,
    lease: { jobId: row.id, workerId: row.worker_id, epoch: row.lease_epoch },
    kind: row.kind, purpose: row.purpose, key: row.job_key, subjectId: row.subject_id,
    obligationId: row.obligation_id, payload: row.payload, cursor: row.cursor,
  };
}

async function publish(tx: PoolClient, jobId: string, epoch: number, kind: string): Promise<void> {
  await tx.query(
    `WITH next AS (
       UPDATE gateway_outbox_sequence SET cursor = cursor + 1 RETURNING cursor
     )
     INSERT INTO gateway_outbox (cursor, job_id, lease_epoch, event_type)
     SELECT cursor, $1, $2, $3 FROM next`, [jobId, epoch, kind],
  );
}

async function lockGeneration(tx: PoolClient, ref: QueueTarget): Promise<{ sealed: boolean }> {
  const result = await tx.query<{ sealed: boolean }>(
    `SELECT sealed FROM gateway_generations
     WHERE project_id=$1 AND scope_id IS NOT DISTINCT FROM $2::uuid AND generation_id=$3 AND current FOR UPDATE`,
    [ref.projectId, ref.scopeId, ref.generationId],
  );
  if (!result.rows[0]) throw new GatewayError('stale_generation');
  return result.rows[0];
}

async function putObligation(
  tx: PoolClient, generationId: string, obligation: Obligation, sealed: boolean,
): Promise<void> {
  if (!obligation.id || !obligation.place.trim() || !['A','B'].includes(obligation.branch)) {
    throw new GatewayError('invalid_obligation');
  }
  const original = await tx.query<{ branch: string; place: string }>(
    'SELECT branch, place FROM gateway_primary WHERE generation_id=$1 AND id=$2',
    [generationId, obligation.id],
  );
  const row = original.rows[0];
  if (row) {
    if (row.branch !== obligation.branch || row.place !== obligation.place) {
      throw new GatewayError('obligation_conflict');
    }
    return;
  }
  if (sealed) throw new GatewayError('manifest_sealed');
  await tx.query('INSERT INTO gateway_primary (generation_id,id,branch,place) VALUES ($1,$2,$3,$4)',
    [generationId, obligation.id, obligation.branch, obligation.place]);
}

export class WorkQueue {
  constructor(protected readonly db: Pool) {}

  async openGeneration(ref: QueueTarget, client?: PoolClient): Promise<void> {
    await transaction(this.db, async (tx) => {
      const { projectId, scopeId, generationId } = ref;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8))', [projectId + '/' + scopeId]);
      const previous = await tx.query<{ current: boolean }>(
        'SELECT current FROM gateway_generations WHERE project_id=$1 AND scope_id IS NOT DISTINCT FROM $2::uuid AND generation_id=$3',
        [projectId, scopeId, generationId],
      );
      if (previous.rows[0]?.current) return;
      if (previous.rowCount) throw new GatewayError('stale_generation');
      await tx.query('UPDATE gateway_generations SET current=false WHERE project_id=$1 AND scope_id IS NOT DISTINCT FROM $2::uuid AND current',
        [projectId, scopeId]);
      await tx.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,$2,$3)',
        [projectId, scopeId, generationId]);
    }, client);
  }

  async declarePrimary(ref: QueueTarget, obligation: Obligation, client?: PoolClient): Promise<void> {
    await transaction(this.db, async (tx) => {
      const generation = await lockGeneration(tx, ref);
      await putObligation(tx, ref.generationId, obligation, generation.sealed);
    }, client);
  }

  async sealGeneration(ref: QueueTarget, manifest: readonly Obligation[], client?: PoolClient): Promise<void> {
    const ids = new Set(manifest.map(item => item.id));
    if (ids.size !== manifest.length) throw new GatewayError('manifest_mismatch');
    await transaction(this.db, async (tx) => {
      const generation = await lockGeneration(tx, ref);
      for (const obligation of manifest) await putObligation(tx, ref.generationId, obligation, generation.sealed);
      const state = await tx.query<{ count: number; paired: boolean }>(
        `SELECT coalesce(sum(n),0)::int AS count, coalesce(bool_and(n=2),true) AS paired
         FROM (SELECT count(*) AS n FROM gateway_primary WHERE generation_id=$1 GROUP BY place) places`,
        [ref.generationId],
      );
      if (state.rows[0].count !== ids.size || !state.rows[0].paired) throw new GatewayError('manifest_mismatch');
      await tx.query('UPDATE gateway_generations SET sealed=true WHERE generation_id=$1', [ref.generationId]);
      const released = await this.releaseReviews(tx, ref.generationId);
      for (const row of released) await publish(tx, row.id, row.lease_epoch, 'resumed');
    }, client);
  }

  async enqueue(input: EnqueueInput, client?: PoolClient): Promise<string> {
    const payload = encode(input.payload ?? null);
    const priority = input.priority ?? 0;
    if (!input.key || !input.kind || !input.subjectId || !Number.isInteger(priority)) {
      throw new GatewayError('invalid_job');
    }
    const fingerprint = hash([input.kind, input.purpose, input.subjectId, input.obligationId ?? null, payload, priority]);
    return transaction(this.db, async (tx) => {
      await lockGeneration(tx, input);
      const previous = await tx.query<{ id: string; spec_hash: string }>(
        'SELECT id, spec_hash FROM gateway_jobs WHERE generation_id=$1 AND job_key=$2',
        [input.generationId, input.key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].spec_hash !== fingerprint) throw new GatewayError('job_conflict');
        return previous.rows[0].id;
      }

      if (input.purpose === 'primary_a' || input.purpose === 'primary_b') {
        const branch = input.purpose === 'primary_a' ? 'A' : 'B';
        const result = await tx.query(
          `SELECT 1 FROM gateway_primary WHERE generation_id=$1 AND id=$2 AND branch=$3 AND state='pending'`,
          [input.generationId, input.obligationId, branch],
        );
        if (!result.rowCount) throw new GatewayError('primary_obligation_required');
      }
      await tx.query('INSERT INTO gateway_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING', [input.projectId]);
      // A restored database can recreate the same logical job before the external receipt is recovered.
      const digest = hash([input.projectId, input.scopeId, input.generationId, input.key]);
      const id = [digest.slice(0,8), digest.slice(8,12), '8' + digest.slice(13,16),
        'a' + digest.slice(17,20), digest.slice(20,32)].join('-');
      await tx.query(
        `INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,
           obligation_id,spec_hash,payload,priority)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, input.projectId, input.scopeId, input.generationId, input.key, input.kind, input.purpose,
         input.subjectId, input.obligationId ?? null, fingerprint, payload, priority],
      );
      await publish(tx, id, 0, 'queued');
      return id;
    }, client);
  }

  async claim(input: { workerId: string; kinds: readonly string[]; leaseMs: number }): Promise<LeasedJob | null> {
    if (!input.workerId || !positiveInteger(input.leaseMs, MAX_LEASE_MS)) throw new GatewayError('invalid_lease');
    return transaction(this.db, async (tx) => {
      const eligible = `j.kind=ANY($1::text[]) AND (j.state='ready' AND j.available_at<=clock_timestamp()
        OR j.state='leased' AND j.lease_until<=clock_timestamp())
        AND EXISTS (SELECT 1 FROM gateway_generations g WHERE g.generation_id=j.generation_id AND g.current)`;
      const projects = await tx.query<{ project_id: string; last_subject: string | null; last_purpose: Purpose | null }>(
        `SELECT p.project_id,p.last_subject,p.last_purpose FROM gateway_projects p
         WHERE EXISTS (SELECT 1 FROM gateway_jobs j WHERE j.project_id=p.project_id AND ${eligible})
         ORDER BY p.last_turn,p.project_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [input.kinds],
      );
      const project = projects.rows[0];
      if (!project) return null;
      const result = await tx.query<JobRow>(
        `WITH next AS (
           SELECT j.id FROM gateway_jobs j WHERE ${eligible} AND j.project_id=$2
           ORDER BY j.subject_id IS NOT DISTINCT FROM $3,
           j.purpose IS NOT DISTINCT FROM $6, j.priority DESC, j.created_at, j.id
           LIMIT 1 FOR UPDATE OF j SKIP LOCKED
         )
         UPDATE gateway_jobs j SET state='leased', lease_epoch=lease_epoch+1, worker_id=$4,
           lease_until=clock_timestamp()+$5::int*interval '1 millisecond', reason=NULL, next_action=NULL
         FROM next WHERE j.id=next.id RETURNING j.*`,
        [input.kinds, project.project_id, project.last_subject, input.workerId, input.leaseMs, project.last_purpose],
      );
      const row = result.rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE gateway_projects SET last_turn=nextval('gateway_project_turn'), last_subject=$2, last_purpose=$3 WHERE project_id=$1`,
        [row.project_id, row.subject_id, row.purpose],
      );
      await publish(tx, row.id, row.lease_epoch, 'leased');
      return job(row);
    });
  }

  protected async lockLease(tx: PoolClient, lease: Lease): Promise<LeasedJob | null> {
    const generation = await tx.query(
      `SELECT g.generation_id FROM gateway_generations g JOIN gateway_jobs j USING(generation_id)
       WHERE j.id=$1 AND g.current FOR UPDATE OF g`, [lease.jobId],
    );
    if (!generation.rowCount) return null;
    const result = await tx.query<JobRow>(
      `SELECT * FROM gateway_jobs WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3
       AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE`,
      [lease.jobId, lease.workerId, lease.epoch],
    );
    return result.rows[0] ? job(result.rows[0]) : null;
  }

  async heartbeat(lease: Lease, leaseMs: number): Promise<boolean> {
    if (!positiveInteger(leaseMs, MAX_LEASE_MS)) throw new GatewayError('invalid_lease');
    return transaction(this.db, async (tx) => {
      if (!await this.lockLease(tx, lease)) return false;
      const result = await tx.query(
        `UPDATE gateway_jobs SET lease_until=clock_timestamp()+$2::int*interval '1 millisecond'
         WHERE id=$1 AND lease_until>clock_timestamp()`, [lease.jobId, leaseMs],
      );
      return result.rowCount === 1;
    });
  }

  async checkpoint(lease: Lease, cursor: unknown, client?: PoolClient): Promise<boolean> {
    return transaction(this.db, async (tx) => {
      if (!await this.lockLease(tx, lease)) return false;
      const result = await tx.query(
        'UPDATE gateway_jobs SET cursor=$2 WHERE id=$1 AND lease_until>clock_timestamp()',
        [lease.jobId, encode(cursor)],
      );
      return result.rowCount === 1;
    }, client);
  }

  async finish(lease: Lease, result: unknown, primary?: PrimaryResult, client?: PoolClient): Promise<boolean> {
    return transaction(this.db, async (tx) => {
      const work = await this.lockLease(tx, lease);
      if (!work) return false;
      if (Boolean(work.obligationId) !== Boolean(primary) || (primary && !primary.evidenceRef.trim())) {
        throw new GatewayError('primary_result_required');
      }
      const done = await tx.query(
        `UPDATE gateway_jobs SET state='done',result=$2,worker_id=NULL,lease_until=NULL
         WHERE id=$1 AND lease_until>clock_timestamp() AND NOT EXISTS (
           SELECT 1 FROM gateway_attempts WHERE job_id=$1 AND state IN ('reserved','prepared','sending','unknown')
         )`,
        [lease.jobId, encode(result)],
      );
      if (!done.rowCount) return false;
      if (primary) {
        await tx.query(
          'UPDATE gateway_primary SET state=$3,evidence_ref=$4 WHERE generation_id=$1 AND id=$2',
          [work.generationId, work.obligationId, primary.state, primary.evidenceRef],
        );
      }
      const released = primary ? await this.releaseReviews(tx, work.generationId) : [];
      await publish(tx, lease.jobId, lease.epoch, 'finished');
      for (const row of released) await publish(tx, row.id, row.lease_epoch, 'resumed');
      return true;
    }, client);
  }

  async suspend(lease: Lease, input: { reason: string; nextAction: string; retryAt?: Date }): Promise<boolean> {
    if (!input.reason.trim() || !input.nextAction.trim()) throw new GatewayError('invalid_suspension');
    return transaction(this.db, async (tx) => {
      if (!await this.lockLease(tx, lease)) return false;
      const result = await tx.query(
        `UPDATE gateway_jobs SET state=CASE WHEN $4::timestamptz IS NULL THEN 'held' ELSE 'ready' END,
           available_at=coalesce($4,available_at), reason=$2,next_action=$3,worker_id=NULL,lease_until=NULL
         WHERE id=$1 AND lease_until>clock_timestamp()`,
        [lease.jobId, input.reason, input.nextAction, input.retryAt ?? null],
      );
      if (!result.rowCount) return false;
      await publish(tx, lease.jobId, lease.epoch, 'suspended');
      return true;
    });
  }

  private async releaseReviews(tx: PoolClient, generationId: string) {
    const released = await tx.query<{ id: string; lease_epoch: number }>(
      `UPDATE gateway_jobs SET state='ready',available_at=clock_timestamp(),reason=NULL,next_action=NULL
       WHERE generation_id=$1 AND purpose='review' AND state='held' AND reason='primary_barrier'
       AND EXISTS (SELECT 1 FROM gateway_generations WHERE generation_id=$1 AND current AND sealed)
       AND NOT EXISTS (SELECT 1 FROM gateway_primary WHERE generation_id=$1 AND state='pending')
       AND NOT EXISTS (SELECT 1 FROM gateway_attempts WHERE generation_id=$1
         AND purpose IN ('primary_a','primary_b') AND state IN ('reserved','prepared','sending','unknown'))
       RETURNING id,lease_epoch`, [generationId],
    );
    return released.rows;
  }

  async resume(jobId: string, reasons?: readonly string[], client?: PoolClient): Promise<boolean> {
    return transaction(this.db, async (tx) => {
      const { rows: [candidate] } = await tx.query<{ packagePrimary: boolean }>(
        `SELECT scope_id IS NULL AND kind='harness_research' AND purpose IN ('primary_a','primary_b') AS "packagePrimary"
         FROM gateway_jobs WHERE id=$1`, [jobId]);
      if (!candidate) return false;
      if (candidate.packagePrimary) await lockPackagePrimarySlots(tx);
      const generation = await tx.query(
        `SELECT 1 FROM gateway_generations g JOIN gateway_jobs j USING(generation_id)
         WHERE j.id=$1 AND g.current FOR UPDATE OF g`, [jobId],
      );
      if (!generation.rowCount) return false;
      if (candidate.packagePrimary) {
        const { rows: [admission] } = await tx.query<{ leaseEpoch: number; slot: boolean; waiting: boolean }>(
          `SELECT target.lease_epoch AS "leaseEpoch",
             (SELECT count(*) FROM ${runnablePackagePrimary})<$3 AND
             (SELECT count(*) FROM ${runnablePackagePrimary} AND w.project_id=target.project_id)<$4 AS slot,
             EXISTS(SELECT 1 FROM gateway_outbox e WHERE e.job_id=target.id AND e.lease_epoch=target.lease_epoch AND e.event_type=$5) AS waiting
           FROM (SELECT j.id,j.project_id,j.lease_epoch FROM ${currentPackagePrimary}
             AND j.id=$1 AND j.state='held' AND ($2::text[] IS NULL OR j.reason=ANY($2))
             AND NOT EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
           ) target`, [jobId, reasons ?? null, packagePrimaryGlobalLimit, packagePrimaryProjectLimit, packageResumeWaitingSlot]);
        if (!admission) return false;
        if (!admission.slot) {
          if (!admission.waiting) await publish(tx, jobId, admission.leaseEpoch, packageResumeWaitingSlot);
          return false;
        }
      }
      const result = await tx.query<{ lease_epoch: number }>(
        `UPDATE gateway_jobs SET state='ready',available_at=clock_timestamp(),reason=NULL,next_action=NULL
         WHERE id=$1 AND state='held' AND ($2::text[] IS NULL OR reason=ANY($2)) AND NOT EXISTS (
           SELECT 1 FROM gateway_attempts WHERE job_id=$1 AND state IN ('sending','unknown')
         ) RETURNING lease_epoch`, [jobId, reasons ?? null],
      );
      if (!result.rows[0]) return false;
      await publish(tx, jobId, result.rows[0].lease_epoch, 'resumed');
      return true;
    }, client);
  }

  async readOutbox(after: string, limit = 100) {
    if (!/^\d+$/.test(after) || !positiveInteger(limit, 1000)) throw new GatewayError('invalid_cursor');
    const result = await this.db.query<{ cursor: string; jobId: string; leaseEpoch: number; eventType: string; createdAt: Date }>(
      `SELECT cursor::text,job_id AS "jobId",lease_epoch AS "leaseEpoch",event_type AS "eventType",created_at AS "createdAt"
       FROM gateway_outbox WHERE cursor>$1 ORDER BY cursor LIMIT $2`, [after, limit],
    );
    return result.rows;
  }
}
