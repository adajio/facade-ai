import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PostgresIntentJournal, type OperatorAuthorization, type ReconciliationInput } from './journal.js';
import { WorkQueue, type LeasedJob } from './queue.js';
import {
  BUDGET_USD_NANOS, encode, GatewayError, hash, positiveInteger, transaction,
  type Attempt, type CallInput, type CallResult, type JournalEntry, type ModelPurpose,
  type ModelTransport, type ProviderOutcome, type Receipt, type RequestQuote, type RouteGrant, type RoutePolicy,
} from './types.js';

const actions: Record<string, string> = {
  lease_lost: 'claim_current_lease',
  stale_generation: 'load_current_generation',
  route_denied: 'check_project_route_permission',
  invalid_request: 'check_route_request_limits',
  route_bound_unavailable: 'verify_request_cost_ceiling',
  route_rate_limited: 'wait_for_route_interval',
  route_busy: 'wait_for_route_slot',
  primary_barrier: 'close_pending_primary_obligations',
  effect_conflict: 'inspect_original_effect',
  budget_exhausted: 'wait_for_reserve_settlement',
  budget_frozen: 'operator_review_ledger',
  journal_unavailable: 'restore_external_journal',
  journal_identity_mismatch: 'restore_pinned_journal',
  effect_already_claimed: 'inspect_attempt_status',
  route_reconciliation: 'operator_reconcile_route',
  unknown_charge: 'operator_reconcile_attempt',
  result_missing: 'recover_original_response',
  dispatch_not_started: 'retry_same_effect',
  recovery_required: 'recover_pinned_external_ledger',
  route_data_unapproved: 'verify_project_data_authorization',
  route_receipt_mismatch: 'operator_verify_provider_endpoint',
};

function held(code: string, attemptId?: string): CallResult {
  return { status: 'held', code, nextAction: actions[code] ?? 'inspect_attempt_status', ...(attemptId ? { attemptId } : {}) };
}

type Gate = {
  work: LeasedJob & { purpose: ModelPurpose };
  route: RoutePolicy;
  effect: string;
  requestHash: string;
  quote: RequestQuote | null;
};
const active = "('reserved','prepared','sending','unknown')";

function knownCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function shortRef(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 512;
}

function validReceipt(receipt: Receipt): boolean {
  switch (receipt?.state) {
    case 'paid':
      return knownCost(receipt.costUsdNanos) && shortRef(receipt.providerId) && shortRef(receipt.evidenceRef);
    case 'rejected':
      return shortRef(receipt.code) && shortRef(receipt.evidenceRef);
    case 'unknown':
      return shortRef(receipt.code) && (receipt.providerId === undefined || shortRef(receipt.providerId));
    default:
      return false;
  }
}

function durableReceipt(receipt: Receipt): Receipt {
  const diagnostic = receipt.routerDiagnostic ? { routerDiagnostic: receipt.routerDiagnostic } : {};
  switch (receipt.state) {
    case 'paid': return { ...diagnostic, state: 'paid', costUsdNanos: receipt.costUsdNanos, providerId: receipt.providerId,
      evidenceRef: receipt.evidenceRef, ...(knownCost(receipt.promptTokens) ? { promptTokens: receipt.promptTokens } : {}),
      ...(knownCost(receipt.completionTokens) ? { completionTokens: receipt.completionTokens } : {}),
      ...(shortRef(receipt.model) ? { model: receipt.model } : {}),
      ...(shortRef(receipt.provider) ? { provider: receipt.provider } : {}),
      ...(typeof receipt.routeVerified === 'boolean' ? { routeVerified: receipt.routeVerified } : {}) };
    case 'rejected': return { ...diagnostic, state: 'rejected', code: receipt.code, evidenceRef: receipt.evidenceRef };
    case 'unknown': return receipt.providerId
      ? { ...diagnostic, state: 'unknown', code: receipt.code, providerId: receipt.providerId }
      : { ...diagnostic, state: 'unknown', code: receipt.code };
  }
}

export class Gateway extends WorkQueue {
  private recovered = false;
  private pendingRecovery?: Promise<unknown>;

  constructor(db: Pool, private readonly journal?: PostgresIntentJournal, private readonly transport?: ModelTransport) {
    super(db);
  }

  async configureRoute(policy: RoutePolicy): Promise<void> {
    if (!shortRef(policy.id) || !shortRef(policy.revision)
      || !positiveInteger(policy.maxRequestBytes, 32 * 1024 * 1024)
      || !positiveInteger(policy.ceilingUsdNanos, BUDGET_USD_NANOS)
      || !positiveInteger(policy.timeoutMs, 3_600_000)
      || (policy.minIntervalMs !== undefined && policy.minIntervalMs !== 0 && !positiveInteger(policy.minIntervalMs, 3_600_000))) {
      throw new GatewayError('invalid_route');
    }
    const result = await this.db.query(
      `INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET
          revision=EXCLUDED.revision,transport=EXCLUDED.transport,enabled=EXCLUDED.enabled,
          max_request_bytes=EXCLUDED.max_request_bytes,ceiling_usd_nanos=EXCLUDED.ceiling_usd_nanos,
          timeout_ms=EXCLUDED.timeout_ms,min_interval_ms=EXCLUDED.min_interval_ms
       WHERE gateway_routes.revision<>EXCLUDED.revision OR (
          gateway_routes.transport=EXCLUDED.transport AND gateway_routes.max_request_bytes=EXCLUDED.max_request_bytes
          AND gateway_routes.ceiling_usd_nanos=EXCLUDED.ceiling_usd_nanos AND gateway_routes.timeout_ms=EXCLUDED.timeout_ms
          AND gateway_routes.min_interval_ms=EXCLUDED.min_interval_ms
       )`,
      [policy.id, policy.revision, policy.transport, policy.enabled, policy.maxRequestBytes,
       policy.ceilingUsdNanos, policy.timeoutMs, policy.minIntervalMs ?? 0],
    );
    if (!result.rowCount) throw new GatewayError('route_revision_conflict');
  }

  async grantRoute(grant: RouteGrant): Promise<void> {
    await this.db.query(
      `INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,route_id,data_class,purpose)
       DO UPDATE SET revision=EXCLUDED.revision,allowed=EXCLUDED.allowed`,
      [grant.projectId, grant.routeId, grant.dataClass, grant.purpose, grant.revision, grant.allowed],
    );
  }

  private async bind(tx: PoolClient, journal: PostgresIntentJournal): Promise<void> {
    await tx.query('INSERT INTO gateway_journal_binding(ledger_id) VALUES($1) ON CONFLICT DO NOTHING', [journal.ledgerId]);
    const result = await tx.query('SELECT 1 FROM gateway_journal_binding WHERE singleton AND ledger_id=$1', [journal.ledgerId]);
    if (!result.rowCount) throw new GatewayError('journal_identity_mismatch');
  }

  private async gate(tx: PoolClient, input: CallInput, wire: string): Promise<Gate | string> {
    const work = await this.lockLease(tx, input.lease);
    if (!work) return 'lease_lost';
    if (work.purpose === 'local') return 'route_denied';

    const routeResult = await tx.query<RoutePolicy>(
      `SELECT r.id,r.revision,r.transport,r.enabled,r.max_request_bytes AS "maxRequestBytes",
         r.ceiling_usd_nanos::float8 AS "ceilingUsdNanos",r.timeout_ms AS "timeoutMs",r.min_interval_ms AS "minIntervalMs"
       FROM gateway_routes r JOIN gateway_grants g ON g.route_id=r.id AND g.revision=r.revision
       WHERE r.id=$1 AND g.project_id=$2 AND g.data_class=$3 AND g.purpose=$4 AND g.allowed AND r.enabled
       FOR SHARE OF r,g`,
      [input.routeId, work.projectId, input.dataClass, work.purpose],
    );
    const route = routeResult.rows[0];
    if (!route || route.transport !== this.transport?.kind) return 'route_denied';
    if (Buffer.byteLength(wire) > route.maxRequestBytes) return 'invalid_request';
    const quote = this.transport.quote?.(route, input.request) ?? null;
    if (this.transport.quote && (!quote || !positiveInteger(quote.ceilingUsdNanos, route.ceilingUsdNanos))) {
      return 'route_bound_unavailable';
    }
    if (!this.transport.quote && this.transport.validate?.(route, input.request) === false) return 'invalid_request';
    if (this.transport.authorize && !await this.transport.authorize(tx, route, {
      projectId: work.projectId, scopeId: work.scopeId, generationId: work.generationId,
      jobId: work.lease.jobId, payload: work.payload, dataClass: input.dataClass, inputRefs: input.inputRefs,
    })) return 'route_data_unapproved';
    if (work.purpose === 'review') {
      const barrier = await tx.query(
        `SELECT 1 FROM gateway_generations WHERE generation_id=$1 AND sealed
          AND NOT EXISTS (SELECT 1 FROM gateway_primary WHERE generation_id=$1 AND state='pending')
          AND NOT EXISTS (SELECT 1 FROM gateway_attempts WHERE generation_id=$1
            AND purpose IN ('primary_a','primary_b') AND state IN ${active})`,
        [work.generationId],
      );
      if (!barrier.rowCount) return 'primary_barrier';
    }
    return {
      work: { ...work, purpose: work.purpose }, route, quote,
      effect: hash([work.projectId, work.scopeId, work.generationId, work.key, input.effectKey]),
      requestHash: hash([route.id, route.revision, input.dataClass, input.inputRefs, wire, ...(quote ? [quote] : [])]),
    };
  }

  private async mirror(entry: JournalEntry, journal: PostgresIntentJournal, client?: PoolClient): Promise<void> {
    const { attempt, state, receipt } = entry;
    const tx = client ?? this.db;
    await tx.query(
      `INSERT INTO gateway_attempts(id,ledger_id,project_id,scope_id,generation_id,job_id,purpose,effect_key,
         request_hash,route_id,revision,ceiling_usd_nanos,previous_rejected_id,state,receipt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,receipt=EXCLUDED.receipt
       WHERE gateway_attempts.ledger_id=EXCLUDED.ledger_id
         AND gateway_attempts.state NOT IN ('paid','rejected')
         AND (gateway_attempts.state NOT IN ('sending','unknown') OR EXCLUDED.state NOT IN ('prepared','sending'))
         AND (gateway_attempts.state<>'cancelled' OR EXCLUDED.state IN ('paid','unknown','rejected'))`,
      [attempt.id, journal.ledgerId, attempt.projectId, attempt.scopeId, attempt.generationId, attempt.jobId,
       attempt.purpose, attempt.effectKey, attempt.requestHash, attempt.routeId, attempt.revision,
       attempt.ceilingUsdNanos, attempt.previousRejectedId, state, encode(receipt)],
    );
  }

  private async findOrReserve(
    tx: PoolClient, gate: Gate, input: CallInput, journal: PostgresIntentJournal,
  ): Promise<Attempt> {
    const result = await tx.query<{ id: string; request_hash: string; previous_rejected_id: string | null }>(
      `SELECT id,request_hash,previous_rejected_id FROM gateway_attempts
       WHERE effect_key=$1 AND state IN ('reserved','prepared') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [gate.effect],
    );
    const pending = result.rows[0];
    const previousRejectedId = input.retryRejectedAttemptId ?? null;
    if (pending && (pending.request_hash !== gate.requestHash || pending.previous_rejected_id !== previousRejectedId)) {
      throw new GatewayError('effect_conflict');
    }
    const { work, route } = gate;
    const attempt = {
      id: pending?.id ?? randomUUID(), projectId: work.projectId, scopeId: work.scopeId,
      generationId: work.generationId, jobId: work.lease.jobId, purpose: work.purpose,
      effectKey: gate.effect, requestHash: gate.requestHash, routeId: route.id, revision: route.revision,
      ceilingUsdNanos: gate.quote?.ceilingUsdNanos ?? route.ceilingUsdNanos, previousRejectedId,
      ...(gate.quote ? { pricingFingerprint: gate.quote.pricingFingerprint } : {}),
    };
    if (pending) return attempt;
    await tx.query(
      `INSERT INTO gateway_attempts(id,ledger_id,project_id,scope_id,generation_id,job_id,purpose,effect_key,
        request_hash,route_id,revision,ceiling_usd_nanos,previous_rejected_id,state,input_refs)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved',$14)`,
      [attempt.id, journal.ledgerId, attempt.projectId, attempt.scopeId, attempt.generationId, attempt.jobId, attempt.purpose,
       attempt.effectKey, attempt.requestHash, attempt.routeId, attempt.revision, attempt.ceilingUsdNanos, previousRejectedId,
       encode(input.inputRefs)],
    );
    return attempt;
  }

  private async terminal(input: CallInput, entry: JournalEntry, replay: boolean): Promise<CallResult> {
    const { receipt, attempt } = entry;
    return transaction(this.db, async tx => {
      if (!await this.lockLease(tx, input.lease)) return held('lease_lost', attempt.id);
      if (receipt?.state === 'rejected') return { status: 'rejected', attemptId: attempt.id, receipt };
      if (receipt?.state !== 'paid') return held('unknown_charge', attempt.id);
      if (receipt.routeVerified === false) return held('route_receipt_mismatch', attempt.id);
      const saved = await this.response(tx, attempt.id, receipt);
      if (!saved) return held('result_missing', attempt.id);
      return { status: 'paid', attemptId: attempt.id, receipt, output: saved.response, replay };
    });
  }

  private async response(db: Pool | PoolClient, id: string, receipt: Extract<Receipt, { state: 'paid' }>) {
    const saved = await db.query<{ response: unknown }>(
      `SELECT response FROM gateway_attempts WHERE id=$1 AND response_receipt->>'providerId'=$2
       AND (response_receipt->>'costUsdNanos')::bigint=$3 AND response IS NOT NULL`,
      [id, receipt.providerId, receipt.costUsdNanos],
    );
    return saved.rows[0];
  }

  private async saveOutput(attemptId: string, outcome: ProviderOutcome): Promise<void> {
    if (outcome.receipt.state !== 'paid') {
      if (outcome.receipt.routerDiagnostic) {
        await this.db.query(
          'UPDATE gateway_attempts SET response_receipt=$2 WHERE id=$1 AND response_receipt IS NULL',
          [attemptId, encode(outcome.receipt)],
        );
      }
      return;
    }
    if (outcome.output === undefined) return;
    let output: string;
    try { output = encode(outcome.output); } catch { return; }
    await this.db.query(
      `UPDATE gateway_attempts SET response=$2,response_receipt=$3 WHERE id=$1 AND response IS NULL`,
      [attemptId, output, encode(outcome.receipt)],
    );
  }

  private dispatch(transport: ModelTransport, attempt: Attempt, route: RoutePolicy, request: unknown): Promise<ProviderOutcome> {
    const signal = AbortSignal.timeout(route.timeoutMs);
    return new Promise(resolve => {
      const timeout = () => resolve({ receipt: { state: 'unknown', code: 'provider_timeout' } });
      signal.addEventListener('abort', timeout, { once: true });
      try {
        void transport.send(attempt, route, request, signal).then(
          value => {
            signal.removeEventListener('abort', timeout);
            resolve(value);
          },
          () => {
            signal.removeEventListener('abort', timeout);
            resolve({ receipt: { state: 'unknown', code: 'provider_connection_lost' } });
          },
        );
      } catch {
        signal.removeEventListener('abort', timeout);
        resolve({ receipt: { state: 'unknown', code: 'provider_connection_lost' } });
      }
    });
  }

  async call(source: CallInput): Promise<CallResult> {
    const journal = this.journal;
    const transport = this.transport;
    if (!journal || !transport) return held('journal_unavailable');
    if (transport.kind === 'openrouter' && !this.recovered) {
      try {
        this.pendingRecovery ??= this.recover().finally(() => { this.pendingRecovery = undefined; });
        await this.pendingRecovery;
      } catch { return held('recovery_required'); }
    }
    if (!shortRef(source.effectKey) || !shortRef(source.routeId) || !shortRef(source.dataClass)
      || !Array.isArray(source.inputRefs) || source.inputRefs.length > 1024 || !source.inputRefs.every(shortRef)) {
      return held('invalid_request');
    }
    let wire: string;
    try { wire = encode(source.request); } catch { return held('invalid_request'); }
    const input = { ...source, lease: { ...source.lease }, inputRefs: [...source.inputRefs], request: JSON.parse(wire) as unknown };
    let attemptId: string | undefined;
    try {
      const first = await transaction(this.db, async tx => {
        await this.bind(tx, journal);
        return this.gate(tx, input, wire);
      });
      if (typeof first === 'string') return held(first);
      const previous = await journal.head(first.effect);
      if (previous) {
        attemptId = previous.attempt.id;
        if (previous.attempt.requestHash !== first.requestHash) return held('effect_conflict', attemptId);
        await this.mirror(previous, journal);
        if (previous.state === 'paid' || previous.state === 'sending' || previous.state === 'unknown'
          || (previous.state === 'rejected' && previous.attempt.id !== input.retryRejectedAttemptId)) {
          return this.terminal(input, previous, true);
        }
      }
      if ((input.retryRejectedAttemptId && !previous)
        || (previous?.state === 'prepared' && previous.attempt.previousRejectedId !== (input.retryRejectedAttemptId ?? null))) {
        return held('effect_conflict', attemptId);
      }

      const reserved = await transaction(this.db, async tx => {
        const current = await this.gate(tx, input, wire);
        if (typeof current === 'string') return current;
        if (current.requestHash !== first.requestHash) return 'effect_conflict';
        if (previous?.state === 'prepared') return previous.attempt;
        return this.findOrReserve(tx, current, input, journal);
      });
      if (typeof reserved === 'string') return held(reserved, attemptId);
      attemptId = reserved.id;
      const prepared = await journal.prepare(reserved);
      if (typeof prepared === 'string' || prepared.attempt.id !== reserved.id) {
        await this.db.query("UPDATE gateway_attempts SET state='cancelled' WHERE id=$1 AND state='reserved'", [attemptId]);
        if (typeof prepared === 'string') return held(prepared, attemptId);
        await this.mirror(prepared, journal);
        if (prepared.attempt.requestHash !== first.requestHash) return held('effect_conflict', prepared.attempt.id);
        return this.terminal(input, prepared, true);
      }
      await this.mirror(prepared, journal);
      if (prepared.state === 'cancelled') return held('dispatch_not_started', prepared.attempt.id);
      if (prepared.state !== 'prepared') return this.terminal(input, prepared, true);

      let started: Promise<ProviderOutcome> | undefined;
      let denied = 'journal_unavailable';
      try {
        denied = await transaction(this.db, async tx => {
          const current = await this.gate(tx, input, wire);
          if (typeof current === 'string' || current.requestHash !== reserved.requestHash
            || (current.quote?.ceilingUsdNanos ?? current.route.ceilingUsdNanos) !== reserved.ceilingUsdNanos) {
            return typeof current === 'string' ? current : 'effect_conflict';
          }
          const claimStartedAt = performance.now();
          const permission = await journal.claim(reserved.id, current.route);
          if (permission !== 'claimed') return permission;

          // After the external commit no sibling may send this attempt. Recheck the lease before calling fetch.
          const stillLeased = await this.lockLease(tx, input.lease);
          if (!stillLeased || performance.now() - claimStartedAt >= 5_000) {
            started = Promise.resolve({ receipt: { state: 'rejected', code: 'not_dispatched', evidenceRef: 'gateway:no-network' } });
            return 'dispatch_not_started';
          }
          started = this.dispatch(transport, reserved, current.route, input.request);
          await tx.query("UPDATE gateway_attempts SET state='sending' WHERE id=$1 AND state='prepared'", [reserved.id]);
          return 'sent';
        });
      } catch (error) {
        if (!started && error instanceof GatewayError) denied = error.code;
      }
      if (!started) {
        if (['route_denied','route_data_unapproved','invalid_request','route_bound_unavailable','primary_barrier','effect_conflict','route_busy','route_rate_limited',
          'route_reconciliation','budget_frozen','budget_exhausted'].includes(denied)) {
          // Cancellation is conditional in the journal because a concurrent caller may already own the attempt.
          await this.mirror(await journal.cancelPrepared(reserved.id), journal);
        }
        return held(denied, reserved.id);
      }

      const outcome = await started;
      const receipt = validReceipt(outcome.receipt)
        ? durableReceipt(outcome.receipt)
        : { state: 'unknown' as const, code: 'invalid_provider_receipt' };
      let saveFailed = false;
      try { await this.saveOutput(reserved.id, { receipt, output: outcome.output }); } catch { saveFailed = true; }
      const settled = await journal.settle(reserved.id, receipt);
      await this.mirror(settled, journal);
      if (saveFailed && receipt.state === 'paid') return held('result_missing', reserved.id);
      return this.terminal(input, settled, false);
    } catch (error) {
      return held(error instanceof GatewayError ? error.code : 'journal_unavailable', attemptId);
    }
  }

  async recover() {
    const journal = this.requireJournal();
    await transaction(this.db, tx => this.bind(tx, journal));
    let cursor = '0';
    let recovered = 0;
    let unresolved = 0;
    for (;;) {
      const page = await journal.entries(cursor);
      if (!page.length) break;
      for (const entry of page) {
        let final: JournalEntry = entry;
        await this.mirror(entry, journal);
        const unsettled = entry.state === 'sending' || entry.state === 'unknown';
        const paid = entry.receipt?.state === 'paid' ? entry.receipt : null;
        const missing = this.transport?.lookup && paid && paid.routeVerified !== false
          && !await this.response(this.db, entry.attempt.id, paid);
        if (unsettled || missing) {
          const outcome = await this.transport?.lookup?.(entry.attempt).catch(() => null);
          if (outcome && validReceipt(outcome.receipt) && outcome.receipt.state !== 'unknown') {
            const receipt = durableReceipt(outcome.receipt);
            final = await journal.settle(entry.attempt.id, receipt);
            await this.mirror(final, journal);
            if (final.receipt?.state === 'paid' && receipt.state === 'paid'
              && final.receipt.providerId === receipt.providerId
              && final.receipt.costUsdNanos === receipt.costUsdNanos
              && final.receipt.routeVerified !== false) {
              await this.saveOutput(entry.attempt.id, { receipt, output: outcome.output });
            }
          }
          if (final.state === 'sending' || final.state === 'unknown') unresolved++;
        }
        recovered++;
        cursor = entry.createdOrder;
      }
    }
    const balance = await journal.balance();
    this.recovered = true;
    return { recovered, unresolved, ...balance };
  }

  private requireJournal(): PostgresIntentJournal {
    if (!this.journal) throw new GatewayError('journal_unavailable');
    return this.journal;
  }

  async reconcile(operator: OperatorAuthorization, input: ReconciliationInput) {
    if (operator.authority !== 'gateway:reconcile' || !shortRef(operator.actorId)) {
      throw new GatewayError('reconciliation_forbidden');
    }
    if (!shortRef(input.operationKey) || !shortRef(input.reasonRef) || !validReceipt(input.resolution)) {
      throw new GatewayError('invalid_reconciliation');
    }
    const journal = this.requireJournal();
    await transaction(this.db, tx => this.bind(tx, journal));
    const outcome = await journal.reconcile(operator, { ...input, resolution: durableReceipt(input.resolution) });
    const entry = await journal.attempt(input.attemptId);
    await this.mirror(entry, journal);
    if (outcome.state === 'paid' || outcome.state === 'rejected') await this.resume(entry.attempt.jobId,
      ['unknown_charge','route_reconciliation','effect_already_claimed','journal_unavailable']);
    return outcome;
  }

  async diagnosticAttemptProject(attemptId: string): Promise<string | null> {
    if (this.journal) {
      try { return (await this.journal.attempt(attemptId)).attempt.projectId; }
      catch (error) { if (!(error instanceof GatewayError) || error.code !== 'attempt_not_found') throw error; }
    }
    const result = await this.db.query<{ project_id: string }>('SELECT project_id FROM gateway_attempts WHERE id=$1', [attemptId]);
    return result.rows[0]?.project_id ?? null;
  }

  async diagnostics(projectId: string) {
    const [jobs, attempts] = await Promise.all([
      this.db.query(
        `SELECT j.id,j.kind,j.purpose,j.state,j.lease_epoch AS "leaseEpoch",j.lease_until AS "leaseUntil",
           j.reason,j.next_action AS "nextAction",j.available_at AS "availableAt",g.current
         FROM gateway_jobs j JOIN gateway_generations g USING(generation_id) WHERE j.project_id=$1
         ORDER BY j.created_at DESC LIMIT 200`, [projectId],
      ),
      this.db.query(
        `SELECT id,job_id AS "jobId",route_id AS "routeId",state,
         CASE WHEN state IN ${active} THEN ceiling_usd_nanos::float8 ELSE 0 END AS "reserveUsdNanos",
         coalesce((receipt->>'costUsdNanos')::float8,0) AS "spentUsdNanos",
         coalesce(receipt->>'code', CASE WHEN state='sending' THEN 'awaiting_provider_receipt' END) AS reason,
         CASE WHEN state IN ('sending','unknown') THEN 'operator_reconcile_attempt'
           WHEN state IN ('reserved','prepared') THEN 'retry_same_effect' END AS "nextAction",
         coalesce(receipt->>'providerId',response_receipt->>'providerId') AS "providerId",receipt->>'model' AS "model",receipt->>'provider' AS "provider",
         (receipt->>'routeVerified')::boolean AS "routeVerified",coalesce(receipt->'routerDiagnostic',response_receipt->'routerDiagnostic') AS "routerDiagnostic",
         (receipt->>'promptTokens')::float8 AS "promptTokens",(receipt->>'completionTokens')::float8 AS "completionTokens",
         created_at AS "createdAt"
         FROM gateway_attempts WHERE project_id=$1 ORDER BY created_at DESC LIMIT 200`, [projectId],
      ),
    ]);
    return { jobs: jobs.rows, attempts: attempts.rows };
  }
}
