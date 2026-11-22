import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { type LeasedJob, WorkQueue } from '../gateway/queue.js';
import { GatewayError, transaction, type CallInput, type CallResult, type PrimaryResult } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import {
  jobSchema, settingsSchema, type ReaderPort, type ResearchOutcome, type ResearchSettings,
  type ResearchSuspension, type ResearchTask, type ScheduledResearchTask,
} from './contracts.js';
import { researchSlot, type ResearchSlot } from './profile.js';
import type { FlowState, ResearchEvent, SessionPorts } from './session.js';
import { runResearchWorkflow } from './workflow.js';

export const researchKind = 'harness_research';
const temporaryHolds = new Set(['primary_barrier', 'route_busy', 'route_rate_limited', 'rate_limited']);

class LostLease extends Error {}

export type ResearchGateway = Pick<WorkQueue, 'claim' | 'heartbeat' | 'checkpoint' | 'finish' | 'suspend'> & {
  call(input: CallInput): Promise<CallResult>;
};

export interface RunnerPorts {
  db: Pool;
  gateway: ResearchGateway;
  reader: ReaderPort;
  configured?(slot: ResearchSlot): ResearchSettings | null;
  admit?(task: ResearchTask): ResearchSuspension | null;
  localLimits?(task: ResearchTask): Pick<ResearchSettings, 'maxTurns' | 'maxKnownRejections'>;
  publishOutcome(tx: PoolClient, task: ScheduledResearchTask, outcome: ResearchOutcome): Promise<void>;
  loadPriorOutcome?(task: ScheduledResearchTask): Promise<ResearchOutcome | null>;
  unsettledPrior?(task: ScheduledResearchTask): Promise<string | null>;
}

function taskFromWork(work: LeasedJob): ScheduledResearchTask {
  const job = jobSchema.parse(work.payload);
  const purpose = job.mode === 'primary' ? (job.branch === 'A' ? 'primary_a' : 'primary_b') : 'review';
  const places = job.mode === 'primary' ? [job.place] : [job.dispute.a.place, job.dispute.b.place];
  if (purpose !== work.purpose || places.some((place) => place.source.projectId !== work.projectId)) {
    throw new Error('Research assignment does not match its lease');
  }
  return { jobId: work.lease.jobId, projectId: work.projectId, scopeId: work.scopeId, generationId: work.generationId, job };
}

function primaryResult(task: ScheduledResearchTask, outcome: ResearchOutcome): PrimaryResult | undefined {
  if (task.job.mode !== 'primary') return undefined;
  if (outcome.kind === 'covered') return { state: 'completed', evidenceRef: outcome.observationIds[0] };
  if (outcome.kind === 'reviewed_no_match') return { state: 'completed', evidenceRef: outcome.evidenceIds[0] };
  if (outcome.kind === 'final_refusal') return {
    state: 'final_refusal', evidenceRef: outcome.evidenceIds[0] ?? `harness:${task.jobId}:refusal`,
  };
  throw new Error('Primary research has no primary outcome');
}

// Older workers parked an in-flight sibling as manual route reconciliation.
export async function resumeInterruptedResearch(
  db: Pool, queue: Pick<WorkQueue, 'resume'>, signal: AbortSignal,
): Promise<void> {
  const { rows } = await db.query<{ id: string; reason: string }>(
    `SELECT j.id,j.reason FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
     LEFT JOIN harness_route_bindings b ON b.job_id=j.id
     WHERE g.current AND j.kind=$1 AND j.state='held'
       AND (j.reason IN ('journal_unavailable','research_profile_unavailable','research_route_not_approved',
                         'research_gateway_unconfigured','synthetic_input_not_approved')
         OR (j.reason='route_reconciliation' AND j.next_action='operator_reconcile_route'))
       AND NOT EXISTS (
         SELECT 1 FROM gateway_attempts a WHERE a.project_id=j.project_id
           AND a.route_id=coalesce(j.payload#>>'{settings,routeId}',b.settings->>'routeId') AND a.state='unknown'
       )
     ORDER BY j.created_at,j.id`, [researchKind]);
  for (const { id, reason } of rows) {
    if (signal.aborted) return;
    await queue.resume(id, [reason]);
  }
}

function sessionPorts(
  task: ResearchTask, work: LeasedJob, services: RunnerPorts, active: AbortSignal,
): SessionPorts {
  const { db, gateway } = services;
  const { lease } = work;
  let cached: ResearchEvent[] | undefined;
  return {
    reader: services.reader,
    continued: async (stopId) => Boolean((await db.query(
      'SELECT 1 FROM harness_research_stops WHERE id=$1 AND job_id=$2 AND resume_requested_at IS NOT NULL',
      [stopId, lease.jobId])).rowCount),
    load: async () => {
      if (cached) return cached;
      const { rows } = await db.query<{ event: ResearchEvent }>(
        'SELECT event FROM harness_research_events WHERE job_id=$1 ORDER BY sequence', [lease.jobId]);
      cached = rows.map(({ event }) => event);
      return cached;
    },
    append: async (expectedLength, create) => {
      const saved = await transaction(db, async (tx) => {
        active.throwIfAborted();
        await lockIntakeProject(tx, task.projectId);
        if (!await gateway.checkpoint(lease, { researchSequence: expectedLength + 1 }, tx)) throw new LostLease();
        const sequence = await tx.query<{ last: number }>(
          'SELECT coalesce(max(sequence),0) AS last FROM harness_research_events WHERE job_id=$1', [lease.jobId]);
        if (sequence.rows[0].last !== expectedLength) throw new LostLease();
        const event = await create(tx);
        if (!await gateway.checkpoint(lease, { researchSequence: expectedLength + 1 }, tx)) throw new LostLease();
        const { rows: [stored] } = await tx.query<{ event: typeof event }>(
          'INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,$2,$3) RETURNING event',
          [lease.jobId, expectedLength + 1, JSON.stringify(event)]);
        if (event.kind === 'tool' && event.stop) await tx.query(
          'INSERT INTO harness_research_stops(id,job_id,sequence) VALUES($1,$2,$3)',
          [event.stop.id, lease.jobId, expectedLength + 1]);
        return stored.event;
      });
      cached?.push(saved);
      return saved;
    },
    call: async (input) => {
      active.throwIfAborted();
      const hold = services.admit?.(task);
      if (hold) return { status: 'held', code: hold.reason, nextAction: hold.nextAction };
      const result = await gateway.call({
        ...input, lease, routeId: task.job.settings.routeId, dataClass: task.job.settings.dataClass,
      });
      if (result.status === 'rejected') {
        const retryable = /^(429|http_429|rate_limited|provider_rate_limit|provider_429)$/.test(result.receipt.code);
        return {
          status: result.status, attemptId: result.attemptId, code: result.receipt.code, retryable,
          ...(retryable ? { retryAt: new Date(Date.now() + 1_000) } : {}),
        };
      }
      if (result.status === 'held' && result.code === 'route_reconciliation') {
        // The gateway also uses this code while another request on the same
        // project route is still in flight. A known unknown charge stays held.
        const { rows: [unresolved] } = await db.query<{ id: string }>(
          `SELECT id FROM gateway_attempts WHERE project_id=$1 AND route_id=$2 AND state='unknown'
           ORDER BY created_at LIMIT 1`, [task.projectId, task.job.settings.routeId]);
        return unresolved ? { ...result, attemptId: unresolved.id }
          : { ...result, retryAt: new Date(Date.now() + 2_000) };
      }
      return result.status === 'held' && temporaryHolds.has(result.code)
        ? { ...result, retryAt: new Date(Date.now() + 1_000) }
        : result;
    },
  };
}

async function runAssignment(
  scheduled: ScheduledResearchTask, work: LeasedJob, services: RunnerPorts, signal: AbortSignal,
): Promise<FlowState> {
  const { db, gateway } = services;
  const slot = researchSlot(scheduled.job);
  const { rows: [binding] } = scheduled.job.settings ? { rows: [] } :
    await db.query<{ settings: unknown }>('SELECT settings FROM harness_route_bindings WHERE job_id=$1', [scheduled.jobId]);
  const settings = scheduled.job.settings ?? (binding ? settingsSchema.parse(binding.settings) : services.configured?.(slot));
  if (!settings) return {
    status: 'suspended', hold: { reason: 'research_profile_unavailable', nextAction: `Настроить профиль для ${slot}.` },
  };
  let task: ResearchTask = { ...scheduled, job: { ...scheduled.job, settings } };
  const hold = services.admit?.(task);
  if (hold) return { status: 'suspended', hold };
  if (!scheduled.job.settings && !binding) {
    const bound = await transaction(db, async (tx) => {
      signal.throwIfAborted();
      if (!await gateway.checkpoint(work.lease, work.cursor, tx)) throw new LostLease();
      const { rows: [row] } = await tx.query<{ settings: unknown }>(
        `INSERT INTO harness_route_bindings(job_id,settings) VALUES($1,$2)
         ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id RETURNING settings`,
        [scheduled.jobId, settings]);
      return settingsSchema.parse(row.settings);
    });
    task = { ...task, job: { ...task.job, settings: bound } };
  }
  const limits = services.localLimits?.(task);
  const workflowTask = limits ? { ...task, job: { ...task.job, settings: { ...task.job.settings, ...limits } } } : task;
  return runResearchWorkflow(workflowTask, sessionPorts(workflowTask, work, services, signal), signal);
}

export async function executeResearch(
  work: LeasedJob, services: RunnerPorts, signal: AbortSignal, leaseMs = 30_000,
) {
  const task = taskFromWork(work);
  const { db, gateway } = services;
  const { lease } = work;
  const local = new AbortController();
  const active = AbortSignal.any([signal, local.signal]);
  let heartbeatFailure: unknown;
  const heartbeat = (async () => {
    while (!active.aborted) {
      await delay(Math.floor(leaseMs / 3), undefined, { signal: active });
      if (!await gateway.heartbeat(lease, leaseMs)) throw new LostLease();
    }
  })().catch((error: unknown) => {
    if (!active.aborted) {
      heartbeatFailure = error;
      local.abort(error);
    }
  });
  try {
    const unresolved = await services.unsettledPrior?.(task);
    if (unresolved) {
      await gateway.suspend(lease, {
        reason: 'prior_attempt_unsettled', nextAction: `Сверить попытку ${unresolved} перед продолжением места.`,
      });
      return;
    }
    const prior = task.job.mode === 'primary' && task.job.localRefusal
      ? { kind: 'final_refusal' as const, reason: task.job.localRefusal, evidenceIds: [] }
      : task.job.settings ? await services.loadPriorOutcome?.(task) : undefined;
    const state: FlowState = prior ? { status: 'done', outcome: prior }
      : await runAssignment(task, work, services, active);
    active.throwIfAborted();
    switch (state.status) {
      case 'done':
        await transaction(db, async (tx) => {
          await lockIntakeProject(tx, task.projectId);
          if (!await gateway.finish(lease, state.outcome, primaryResult(task, state.outcome), tx)) return;
          await services.publishOutcome(tx, task, state.outcome);
        });
        break;
      case 'suspended':
        await gateway.suspend(lease, state.hold);
        break;
      case 'continue':
        await gateway.suspend(lease, {
          reason: 'yield', nextAction: 'Продолжить с сохранённого хода.', retryAt: new Date(),
        });
        break;
    }
  } catch (error) {
    if (signal.aborted || error instanceof LostLease || heartbeatFailure instanceof LostLease) return;
    if (error instanceof GatewayError && error.code === 'stale_generation') return;
    throw heartbeatFailure ?? error;
  } finally {
    local.abort();
    await heartbeat;
  }
}
