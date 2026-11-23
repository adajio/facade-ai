import type { Pool, PoolClient } from 'pg';
import { AccessError, transaction } from '../access/index.js';
import { accountColumns, accessConfig, authorize, type SessionAccount } from '../access/auth.js';
import { lockOrganization, lockSession } from '../access/commands.js';
import { GatewayError, type Gateway, type LeasedJob } from '../gateway/index.js';
import { hash } from '../gateway/types.js';
import type { ResearchAdmission } from '../gateway/gateway.js';
import {
  copilotJournalLimit, copilotOcrLimit, copilotReadsPerSlice, copilotSearchResultLimit, copilotTurnLimit,
  type CopilotMemory, type MemorySource, type SourceIdentity, type StoredAnswer,
} from './contracts.js';
import { copilotKind, verifyCopilotInputs } from './admission.js';
import { decodeTurn, isReadCall, messagesFor, requestFor, recentTranscript, type Message, type ReadBatch } from './protocol.js';

export { copilotKind } from './admission.js';
const leaseMs = 30_000;
const turnsPerLease = 8;
const maxStagnantTurns = 4;
const retryable = new Set(['route_busy', 'route_rate_limited', 'primary_barrier', 'dispatch_not_started', 'recovery_required']);

export type CopilotRoute = {
  routeId: string; model: string; dataClass: string; maxTokens: number; toolChoice?: 'auto' | 'required';
};

type Question = {
  id: string; projectId: string; organizationId: string; userId: string; sessionId: string; question: string;
};

type Queue = Pick<Gateway, 'enqueue' | 'claim' | 'call' | 'heartbeat' | 'checkpoint' | 'finish' | 'suspend' | 'resume'>;

export type CopilotRuntime = {
  db: Pool;
  gateway: Queue;
  memory: CopilotMemory;
  workerId: string;
  route: CopilotRoute | null;
  enqueue?(tx: PoolClient, question: Pick<Question, 'id' | 'projectId'>, route: CopilotRoute): Promise<string | null>;
  research?(session: SessionAccount, projectId: string, source: MemorySource, jobId: string, addressKey?: string): Promise<MemorySource | null>;
};

type Progress = {
  turn: number;
  messages: Message[];
  found: SourceIdentity[];
  opened: string[];
  limitations: string[];
  readBatch?: ReadBatch;
  research?: { sourceId: string; reason: string; callId: string; finished: boolean; addressKey?: string };
  attemptedAddresses?: string[];
  stagnantTurns?: number;
};

const questionFields = `id,question,project_id AS "projectId",organization_id AS "organizationId",
  user_id AS "userId",session_id AS "sessionId"`;

async function currentOwner(tx: Pool | PoolClient, question: Question) {
  const { rows: [session] } = await tx.query<SessionAccount>(
    `SELECT ${accountColumns},s.id AS "sessionId",s.last_seen_at AS "lastSeenAt"
     FROM access_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=$1 AND u.id=$2 AND u.organization_id=$3 AND s.revoked_at IS NULL
       AND u.state='active' AND s.expires_at>statement_timestamp()
       AND s.last_seen_at>statement_timestamp()-make_interval(secs=>$4)`,
    [question.sessionId, question.userId, question.organizationId, accessConfig().idleSeconds],
  );
  if (!session) return null;
  try {
    await authorize(tx, session, { action: 'project:engineer', projectId: question.projectId });
    return session;
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

async function withOwner<T>(db: Pool, question: Question, work: (session: SessionAccount) => Promise<T>) {
  const owner = await currentOwner(db, question);
  return owner ? work(owner) : null;
}

const identity = ({ id, documentId, versionId, sha256, proof }: MemorySource): SourceIdentity =>
  ({ id, documentId, versionId, sha256, proof });
function unchanged(pin: SourceIdentity, source: MemorySource | null): source is MemorySource {
  return Boolean(source && pin.id === source.id && pin.versionId === source.versionId &&
    pin.documentId === source.documentId && pin.sha256 === source.sha256);
}

// Gateway runs this in both admission phases. Try locks respect its existing intake/generation lock order.
export function copilotModelAdmission(): ResearchAdmission {
  return async (tx, work, route, input) => {
    if (work.kind !== copilotKind) return {};
    const { rows: [question] } = await tx.query<Question>(
      `SELECT ${questionFields} FROM copilot_questions WHERE job_id=$1 AND project_id=$2 AND id::text=$3`,
      [work.lease.jobId, work.projectId, work.subjectId],
    );
    const profile = routeFrom(work.payload);
    if (!question || !profile || profile.routeId !== route.id || profile.dataClass !== input.dataClass) {
      return { deny: 'analysis_input_denied' };
    }
    const { rows: [locks] } = await tx.query<{ organization: boolean; session: boolean }>(
      `SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS organization,
              pg_try_advisory_xact_lock_shared(hashtextextended($2,0)) AS session`,
      [`facade:access:org:${question.organizationId}`, `facade:access:session:${question.sessionId}`],
    );
    if (!locks.organization || !locks.session) return { deny: 'route_busy' };
    if (!await currentOwner(tx, question)) return { deny: 'access_changed' };
    if (!await verifyCopilotInputs(tx, { ...work, jobId: work.lease.jobId, inputRefs: input.inputRefs })) {
      return { deny: 'analysis_input_denied' };
    }
    return {};
  };
}

function routeFrom(payload: unknown): CopilotRoute | undefined {
  if (!payload || typeof payload !== 'object') return;
  const route = (payload as { route?: CopilotRoute }).route;
  if (!route?.routeId || !route.model || !route.dataClass || !Number.isInteger(route.maxTokens) || route.maxTokens <= 0) return;
  return route;
}

function sameRoute(a: CopilotRoute | null, b: CopilotRoute) {
  return a?.routeId === b.routeId && a.model === b.model && a.dataClass === b.dataClass &&
    a.maxTokens === b.maxTokens && (a.toolChoice ?? 'required') === (b.toolChoice ?? 'required');
}

export async function enqueueCopilot(
  tx: PoolClient, gateway: Pick<Gateway, 'enqueue'>, question: Pick<Question, 'id' | 'projectId'>, route: CopilotRoute,
) {
  const { rows: [generation] } = await tx.query<{ id: string; scopeId: string | null }>(
    `SELECT generation_id AS id,scope_id AS "scopeId" FROM gateway_generations
     WHERE project_id=$1 AND current ORDER BY (scope_id IS NOT NULL),scope_id LIMIT 1 FOR UPDATE`, [question.projectId],
  );
  if (!generation) return null;
  try {
    return await gateway.enqueue({
      projectId: question.projectId, scopeId: generation.scopeId, generationId: generation.id,
      key: 'copilot/' + question.id, kind: copilotKind, purpose: 'review', subjectId: question.id,
      payload: { mode: 'copilot', route: { ...route, toolChoice: route.toolChoice ?? 'required' } }, priority: -20,
    }, tx);
  } catch (error) {
    if (error instanceof GatewayError && error.code === 'stale_generation') return null;
    throw error;
  }
}

async function dispatchPending(runtime: CopilotRuntime) {
  const { db, route } = runtime;
  return transaction(db, async (tx) => {
    const { rows: [question] } = await tx.query<Question>(
      `SELECT ${questionFields} FROM copilot_questions
       WHERE job_id IS NULL AND (state='pending' OR ($1 AND state='held' AND reason IN ('model_unavailable','no_generation')))
         AND (retry_at IS NULL OR retry_at<=clock_timestamp())
       ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [Boolean(route)],
    );
    if (!question) return false;
    const allowed = await currentOwner(tx, question);
    const jobId = allowed && route
      ? await (runtime.enqueue ? runtime.enqueue(tx, question, route) : enqueueCopilot(tx, runtime.gateway, question, route))
      : null;
    const reason = !allowed ? 'access_changed' : !route ? 'model_unavailable' : jobId ? null : 'no_generation';
    await tx.query(`UPDATE copilot_questions SET job_id=$2,state=$3,reason=$4,
                   retry_at=CASE WHEN $4='no_generation' THEN clock_timestamp()+interval '5 seconds' END WHERE id=$1`,
      [question.id, jobId, jobId ? 'queued' : 'held', reason]);
    return true;
  });
}

function include(progress: Progress, source: MemorySource) {
  if (!progress.found.some((item) => item.id === source.id)) progress.found.push(identity(source));
}

const searchLimits = (progress: Progress, limitations: string[]) => {
  progress.limitations = [...new Set([...progress.limitations, ...limitations])].slice(0, 14);
};

const addressKeyFor = (source: MemorySource) => hash([source.versionId, source.address.unitId, source.address.box ?? null]);

function advance(progress: Progress, madeProgress: boolean) {
  progress.stagnantTurns = madeProgress ? 0 : (progress.stagnantTurns ?? 0) + 1;
}

function metadata(source: MemorySource) {
  return {
    sourceId: source.id, document: source.label, documentId: source.documentId, versionId: source.versionId,
    address: source.address, version: source.version, representation: source.representation, window: source.window ?? false,
  };
}

function opened(source: MemorySource) {
  return { ...metadata(source), text: source.text.slice(0, 1800), context: source.context?.slice(0, 6) ?? [],
    limitations: source.limitations };
}

function reply(progress: Progress, callId: string, output: unknown) {
  progress.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(output) });
}

async function run(work: LeasedJob, runtime: CopilotRuntime, signal: AbortSignal) {
  const { db, gateway, memory } = runtime;
  const { lease } = work;
  const { rows: [question] } = await db.query<Question>(
    `SELECT ${questionFields} FROM copilot_questions WHERE job_id=$1 AND project_id=$2 AND id::text=$3`,
    [lease.jobId, work.projectId, work.subjectId],
  );
  const route = routeFrom(work.payload);
  async function suspend(reason: string, retryAt?: Date) {
    return gateway.suspend(lease, { reason, nextAction: 'inspect_copilot_question', retryAt });
  }
  if (!question || !route) { await suspend('analysis_input_denied'); return; }
  if (!sameRoute(runtime.route, route)) { await suspend('model_unavailable'); return; }

  const progress: Progress = (work.cursor as Progress | null) ?? {
    turn: 0, messages: messagesFor(question.question), found: [], opened: [], limitations: [],
  };
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const heartbeat = setInterval(() => {
    void gateway.heartbeat(lease, leaseMs).then((alive) => { if (!alive) controller.abort(); }).catch(() => controller.abort());
  }, leaseMs / 3);

  async function save(researchSourceId?: string, researchPending = false) {
    if (active.aborted) return false;
    return transaction(db, async (tx) => {
      if (!await gateway.checkpoint(lease, progress, tx)) return false;
      if (researchSourceId) {
        await tx.query('UPDATE copilot_questions SET state=$2,research_source_id=$3 WHERE id=$1',
          [question.id, researchPending ? 'research_queued' : 'queued', researchSourceId]);
      }
      return true;
    });
  }

  async function finish(claims: StoredAnswer['claims'], limitations: string[], reason: string | null) {
    if (active.aborted) return;
    const result: StoredAnswer = {
      claims, cited: [...new Set(claims.flatMap((claim) => claim.sources))], exposed: progress.found,
      limitations: [...new Set([...limitations, ...progress.limitations,
        'Ответ охватывает открытые места и зависит от применимости их редакций.'])],
    };
    const state = claims.length ? 'answered' : 'limited';
    await transaction(db, async (tx) => {
      await lockOrganization(tx, question.organizationId, false);
      await lockSession(tx, question.sessionId, false);
      if (!await currentOwner(tx, question) || !await gateway.finish(lease, { state }, undefined, tx)) return;
      await tx.query('UPDATE copilot_questions SET state=$2,result=$3,reason=$4 WHERE id=$1',
        [question.id, state, result, reason]);
    });
  }

  async function authorizedSource(sourceId: string) {
    const pin = progress.found.find(({ id }) => id === sourceId);
    if (!pin) return null;
    return withOwner(db, question, async (session) => {
      const source = await memory.open(session, work.projectId, sourceId);
      return unchanged(pin, source) ? { source, session } : null;
    });
  }

  async function readSource({ action, callId }: ReadBatch['calls'][number], availableSources: Set<string>) {
    if (action.name === 'search_sources') {
      const found = await withOwner(db, question, (session) => memory.search(session, work.projectId, action.args.query));
      if (!found) return 'access_changed';
      const selected = [...found.sources.slice(0, copilotSearchResultLimit - 2), ...found.windows.slice(0, 2)];
      const newIds = new Set(selected.map(({ id }) => id));
      for (const { id } of progress.found) newIds.delete(id);
      if (progress.found.length + newIds.size > copilotJournalLimit) return 'copilot_address_budget';
      for (const source of selected) include(progress, source);
      searchLimits(progress, found.limitations);
      reply(progress, callId, { sources: selected.filter(({ window }) => !window).map(metadata),
        unresolvedWindows: selected.filter(({ window }) => window).map(metadata), limitations: found.limitations });
    } else {
      const key = action.args.sourceId;
      const original = availableSources.has(key) ? await authorizedSource(key) : null;
      if (original) {
        if (original.source.text && !progress.opened.includes(key)) progress.opened.push(key);
        reply(progress, callId, { source: opened(original.source) });
      } else {
        reply(progress, callId, { code: 'source_unavailable' });
      }
    }
  }

  async function continueReads(batch: ReadBatch) {
    if (!await currentOwner(db, question)) { await suspend('access_changed'); return false; }
    if (!await verifyCopilotInputs(db, {
      projectId: work.projectId, scopeId: work.scopeId, jobId: lease.jobId, inputRefs: progress.found.map(({ id }) => id),
    })) { await suspend('sources_unavailable'); return false; }
    const available = new Set(progress.found.slice(0, batch.foundBefore).map(({ id }) => id));
    const end = Math.min(batch.next + copilotReadsPerSlice, batch.calls.length);
    while (!active.aborted && batch.next < end) {
      const held = await readSource(batch.calls[batch.next], available);
      if (held) { await suspend(held); return false; }
      batch.next++;
      if (batch.next === batch.calls.length) {
        advance(progress, progress.found.length > batch.foundBefore || progress.opened.length > batch.openedBefore);
      }
      if (!await save()) return false;
    }
    if (active.aborted) return false;
    if (batch.next === batch.calls.length) return true;
    await suspend('copilot_read_quantum', new Date());
    return false;
  }

  try {
    const research = progress.research;
    const attempted = progress.attemptedAddresses ??= [];
    if (research && !research.addressKey && research.finished && !attempted.length) {
      // An earlier version used one job-wide OCR key. Remember its address when resuming its cursor.
      const legacy = await authorizedSource(research.sourceId);
      if (!legacy) { await suspend('sources_unavailable'); return; }
      attempted.push(addressKeyFor(legacy.source));
    }
    if (research && !research.finished) {
      if (!runtime.research) { await suspend('research_unavailable'); return; }
      if (attempted.length >= copilotOcrLimit || progress.found.length >= copilotJournalLimit) {
        await suspend('copilot_research_budget');
        return;
      }
      const original = await authorizedSource(research.sourceId);
      if (!original) { await suspend('sources_unavailable'); return; }
      const addressKey = addressKeyFor(original.source);
      if (research.addressKey && research.addressKey !== addressKey) {
        await suspend('sources_unavailable');
        return;
      }
      if (active.aborted) return;
      const result = await runtime.research(original.session, work.projectId, original.source, lease.jobId, research.addressKey);
      if (result) {
        include(progress, result);
        if (!progress.opened.includes(result.id)) progress.opened.push(result.id);
        reply(progress, research.callId, { source: opened(result) });
      } else {
        searchLimits(progress, ['Адресное дочитывание не дало доступного текстового представления.']);
        reply(progress, research.callId, { code: 'research_unavailable' });
      }
      attempted.push(addressKey);
      advance(progress, Boolean(result));
      research.finished = true;
      if (!await save(research.sourceId)) return;
    }
    if (progress.readBatch && progress.readBatch.next < progress.readBatch.calls.length &&
        !await continueReads(progress.readBatch)) return;
    const leaseEndsAt = Math.min(progress.turn + turnsPerLease, copilotTurnLimit);
    while (!active.aborted && progress.turn < leaseEndsAt) {
      if ((progress.stagnantTurns ?? 0) >= maxStagnantTurns) { await suspend('copilot_no_progress'); return; }
      const allowed = await withOwner(db, question, async () => true);
      if (!allowed) { await suspend('access_changed'); return; }
      if (active.aborted) return;
      const outcome = await gateway.call({
        lease, effectKey: `copilot/turn/${progress.turn}`, routeId: route.routeId, dataClass: route.dataClass,
        request: requestFor(route, recentTranscript(progress.messages, (turnsPerLease - 1) * 2), Boolean(runtime.research)), inputRefs: progress.found.map(({ id }) => id),
      });
      if (active.aborted) return;
      if (outcome.status === 'held') {
        const routeRetryAt = 'retryAt' in outcome && outcome.retryAt instanceof Date ? outcome.retryAt : undefined;
        await suspend(outcome.code, routeRetryAt ?? (retryable.has(outcome.code) ? new Date(Date.now() + 2500) : undefined));
        return;
      }
      const decoded = outcome.status === 'paid' ? decodeTurn(outcome.output) : null;
      if (!decoded) {
        await finish([], [], outcome.status === 'rejected' ? 'model_rejected' : 'model_response_invalid');
        return;
      }
      const { actions, message } = decoded;
      progress.turn += 1;
      progress.messages.push(message);
      const searchCount = actions.filter(({ action }) => action.name === 'search_sources').length;
      if (actions.every(isReadCall) && (actions.length > copilotReadsPerSlice ||
          progress.found.length + searchCount * copilotSearchResultLimit > copilotJournalLimit)) {
        const batch = { calls: actions, next: 0, foundBefore: progress.found.length, openedBefore: progress.opened.length };
        progress.readBatch = batch;
        if (!await save() || !await continueReads(batch)) return;
        continue;
      }
      const before = progress.found.length + progress.opened.length;
      let lastResearchSource: string | undefined;
      const availableSources = new Set(progress.found.map(({ id }) => id));
      for (const { action, callId } of actions) {
        if (active.aborted) return;
        switch (action.name) {
          case 'search_sources':
          case 'open_source': {
            const held = await readSource({ action, callId }, availableSources);
            if (held) { await suspend(held); return; }
            break;
          }
          case 'research_source': {
            const key = action.args.sourceId;
            const original = runtime.research ? await authorizedSource(key) : null;
            if (!original || original.source.representation !== 'native' || typeof original.source.address.locator?.page !== 'number') {
              reply(progress, callId, { code: 'research_unavailable' });
              break;
            }
            const addressKey = addressKeyFor(original.source);
            if (attempted.includes(addressKey)) {
              lastResearchSource = key;
              reply(progress, callId, { code: 'research_already_attempted' });
              break;
            }
            progress.research = { sourceId: key, reason: action.args.reason, callId, finished: false, addressKey };
            if (await save(key, true)) await suspend('addressed_research', new Date());
            return;
          }
          case 'submit_answer': {
            const { claims, limitations } = action.args;
            if (claims.every(({ sources }) => sources.every((key) => progress.opened.includes(key)))) {
              await finish(claims, limitations, null);
              return;
            }
            reply(progress, callId, { code: 'unopened_citation' });
            break;
          }
        }
      }
      advance(progress, progress.found.length + progress.opened.length > before);
      if (!await save(lastResearchSource)) return;
    }
    if (!active.aborted) {
      if ((progress.stagnantTurns ?? 0) >= maxStagnantTurns) await suspend('copilot_no_progress');
      else if (progress.turn >= copilotTurnLimit) await suspend('copilot_turn_budget');
      else await suspend('copilot_quantum', new Date());
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function processNextCopilot(runtime: CopilotRuntime, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const work = await runtime.gateway.claim({ workerId: runtime.workerId, kinds: [copilotKind], leaseMs });
  if (work) {
    await run(work, runtime, signal);
    return true;
  }
  if (await dispatchPending(runtime)) return true;
  if (!runtime.route) return false;
  const { rows } = await runtime.db.query<{ id: string; payload: unknown }>(
    `SELECT j.id,j.payload FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
     WHERE j.kind=$1 AND g.current AND j.state='held' AND j.reason='model_unavailable'
       AND j.payload#>>'{route,routeId}'=$2 ORDER BY j.created_at,j.id LIMIT 20`, [copilotKind, runtime.route.routeId],
  );
  const candidate = rows.find(({ payload }) => {
    const pinned = routeFrom(payload);
    return pinned && sameRoute(runtime.route, pinned);
  });
  return candidate ? runtime.gateway.resume(candidate.id, ['model_unavailable']) : false;
}
