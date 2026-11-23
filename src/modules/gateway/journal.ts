import type { Pool, PoolClient } from 'pg';
import {
  BUDGET_USD_NANOS, GatewayError, encode, hash, positiveInteger, transaction,
  type Attempt, type JournalEntry, type KnownReceipt, type Receipt, type RoutePolicy,
} from './types.js';

export type OperatorAuthorization = { actorId: string; authority: 'gateway:reconcile' };
export type ReconciliationInput = {
  attemptId: string;
  operationKey: string;
  reasonRef: string;
  resolution: KnownReceipt | { state: 'unknown'; code: string } | { state: 'isolate_unknown' };
};

type JournalRow = JournalEntry & {
  createdOrder: string;
  startedAt: Date | null;
};

const columns = 'metadata AS attempt,state,receipt,created_order::text AS "createdOrder",started_at AS "startedAt"';
const reserved = "state IN ('prepared','sending','unknown')";
const isolated = `EXISTS (
  SELECT 1 FROM gateway_external_reconciliation r
  WHERE r.attempt_id=gateway_external_attempts.id AND r.outcome->>'routeIsolated'='true'
)`;

function balanceOf(entry: JournalEntry, routeIsolated?: true) {
  return {
    state: entry.state,
    reserveUsdNanos: ['prepared','sending','unknown'].includes(entry.state) ? entry.attempt.ceilingUsdNanos : 0,
    spentUsdNanos: entry.receipt?.state === 'paid' ? entry.receipt.costUsdNanos : 0,
    receipt: entry.receipt,
    ...(routeIsolated ? { routeIsolated } : {}),
  };
}

function sameSettlement(left: Receipt | null, right: Receipt): boolean {
  if (left?.state === 'paid' && right.state === 'paid') {
    return left.providerId === right.providerId && left.costUsdNanos === right.costUsdNanos;
  }
  return left?.state === 'rejected' && right.state === 'rejected';
}

export class PostgresIntentJournal {
  constructor(private readonly pool: Pool, readonly ledgerId: string, private readonly expectedLimitUsdNanos?: number) {}

  private async bound(tx: PoolClient) {
    await tx.query('SET LOCAL synchronous_commit=on');
    // Deployed journals without the limit column keep their original ten-dollar cap.
    const result = await tx.query<{ frozen: boolean; limitUsdNanos: string }>(
      `SELECT frozen, coalesce((to_jsonb(ledger)->>'limit_usd_nanos')::bigint,$2::bigint)::text AS "limitUsdNanos"
       FROM gateway_external_ledger ledger WHERE singleton AND ledger_id=$1 FOR UPDATE`,
      [this.ledgerId, BUDGET_USD_NANOS],
    );
    if (!result.rows[0]) throw new GatewayError('journal_identity_mismatch');
    const { frozen } = result.rows[0];
    const limitUsdNanos = Number(result.rows[0].limitUsdNanos);
    if (!positiveInteger(limitUsdNanos, BUDGET_USD_NANOS) ||
        (this.expectedLimitUsdNanos !== undefined && this.expectedLimitUsdNanos !== limitUsdNanos)) {
      throw new GatewayError('journal_limit_mismatch');
    }
    return { frozen, limitUsdNanos };
  }

  private async byId(tx: PoolClient, id: string): Promise<JournalRow> {
    const result = await tx.query<JournalRow>('SELECT ' + columns + ' FROM gateway_external_attempts WHERE id=$1', [id]);
    if (!result.rows[0]) throw new GatewayError('attempt_not_found');
    return result.rows[0];
  }

  private async latest(tx: PoolClient, effectKey: string): Promise<JournalRow | null> {
    const result = await tx.query<JournalRow>(
      'SELECT ' + columns + " FROM gateway_external_attempts WHERE effect_key=$1 AND state<>'cancelled' ORDER BY created_order DESC LIMIT 1",
      [effectKey],
    );
    return result.rows[0] ?? null;
  }

  private async hasRouteIsolation(tx: PoolClient, attemptId: string): Promise<boolean> {
    const found = await tx.query(`SELECT 1 FROM gateway_external_attempts WHERE id=$1 AND ${isolated}`, [attemptId]);
    return Boolean(found.rowCount);
  }

  async head(effectKey: string): Promise<JournalEntry | null> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      return this.latest(tx, effectKey);
    });
  }

  async entries(after: string): Promise<JournalRow[]> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      const result = await tx.query<JournalRow>(
        'SELECT ' + columns + ' FROM gateway_external_attempts WHERE created_order>$1 ORDER BY created_order LIMIT 500', [after],
      );
      return result.rows;
    });
  }

  private async budget(tx: PoolClient) {
    const result = await tx.query<{ reserveUsdNanos: string; spentUsdNanos: string }>(
      `SELECT coalesce(sum(ceiling_usd_nanos) FILTER (WHERE ${reserved}),0) AS "reserveUsdNanos",
              coalesce(sum(spent_usd_nanos),0) AS "spentUsdNanos" FROM gateway_external_attempts`,
    );
    return {
      reserveUsdNanos: Number(result.rows[0].reserveUsdNanos),
      spentUsdNanos: Number(result.rows[0].spentUsdNanos),
    };
  }

  async balance() {
    return transaction(this.pool, async tx => {
      const { frozen, limitUsdNanos } = await this.bound(tx);
      const budget = await this.budget(tx);
      return { limitUsdNanos, frozen, ...budget,
        remainingUsdNanos: Math.max(0, limitUsdNanos - budget.reserveUsdNanos - budget.spentUsdNanos) };
    });
  }

  async prepare(attempt: Attempt): Promise<JournalEntry | string> {
    return transaction(this.pool, async tx => {
      const { frozen, limitUsdNanos } = await this.bound(tx);
      const current = await this.latest(tx, attempt.effectKey);
      if (current?.attempt.id === attempt.id) return current;
      if (current && current.attempt.requestHash !== attempt.requestHash) return 'effect_conflict';
      if (current && (current.state !== 'rejected' || current.attempt.id !== attempt.previousRejectedId
        || await this.hasRouteIsolation(tx, current.attempt.id))) return current;
      if (frozen) return 'budget_frozen';
      const budget = await this.budget(tx);
      if (budget.spentUsdNanos + budget.reserveUsdNanos + attempt.ceilingUsdNanos > limitUsdNanos) {
        return 'budget_exhausted';
      }
      const result = await tx.query<JournalRow>(
        `INSERT INTO gateway_external_attempts(id,effect_key,project_id,generation_id,route_id,purpose,
             ceiling_usd_nanos,metadata,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared') ON CONFLICT (id) DO NOTHING RETURNING ${columns}`,
        [attempt.id, attempt.effectKey, attempt.projectId, attempt.generationId, attempt.routeId,
         attempt.purpose, attempt.ceilingUsdNanos, encode(attempt)],
      );
      return result.rows[0] ?? this.byId(tx, attempt.id);
    });
  }

  async claim(id: string, route: RoutePolicy, earlyReview = false): Promise<'claimed' | string> {
    return transaction(this.pool, async tx => {
      const { frozen, limitUsdNanos } = await this.bound(tx);
      const entry = await this.byId(tx, id);
      if (entry.state !== 'prepared') return 'effect_already_claimed';
      if (frozen) return 'budget_frozen';

      const gates = await tx.query<{ route_busy: boolean; unresolved: boolean; active_primary: boolean; rate_limited: boolean }>(
        `SELECT
          EXISTS (SELECT 1 FROM gateway_external_attempts WHERE route_id=$1 AND slot_until>clock_timestamp()
            AND state IN ('sending','unknown')) AS route_busy,
          EXISTS (SELECT 1 FROM gateway_external_attempts WHERE project_id=$2 AND route_id=$1
            AND (state='sending' OR (state='unknown'
              AND (coalesce(metadata->>'jobId',$5)=$5 OR receipt->>'providerId' IS NOT NULL OR NOT ${isolated})))) AS unresolved,
          EXISTS (SELECT 1 FROM gateway_external_attempts WHERE generation_id=$3
            AND purpose IN ('primary_a','primary_b') AND state IN ('sending','unknown')) AS active_primary,
          EXISTS (SELECT 1 FROM gateway_external_attempts WHERE route_id=$1
            AND started_at>clock_timestamp()-$4::int*interval '1 millisecond') AS rate_limited`,
        [route.id, entry.attempt.projectId, entry.attempt.generationId, route.minIntervalMs ?? 0, entry.attempt.jobId],
      );
      const gate = gates.rows[0];
      if (entry.attempt.purpose === 'review' && !earlyReview && gate.active_primary) return 'primary_barrier';
      if (gate.unresolved) return 'route_reconciliation';
      if (gate.route_busy) return 'route_busy';
      if (gate.rate_limited) return 'route_rate_limited';
      const budget = await this.budget(tx);
      if (budget.reserveUsdNanos + budget.spentUsdNanos > limitUsdNanos) return 'budget_exhausted';
      await tx.query(
        `UPDATE gateway_external_attempts SET state='sending', started_at=clock_timestamp(),
         slot_until=clock_timestamp()+$2::int*interval '1 millisecond' WHERE id=$1`,
        [id, route.timeoutMs + 5_000],
      );
      return 'claimed';
    });
  }

  async cancelPrepared(id: string): Promise<JournalEntry> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      await tx.query("UPDATE gateway_external_attempts SET state='cancelled' WHERE id=$1 AND state='prepared'", [id]);
      return this.byId(tx, id);
    });
  }

  async settle(id: string, receipt: Receipt): Promise<JournalEntry> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      const entry = await this.byId(tx, id);
      return this.settlement(tx, entry, receipt);
    });
  }

  private async settlement(tx: PoolClient, entry: JournalRow, receipt: Receipt): Promise<JournalEntry> {
    if (entry.state === 'paid' || entry.state === 'rejected') {
      if (receipt.state !== 'unknown' && !sameSettlement(entry.receipt, receipt)) {
        await tx.query('UPDATE gateway_external_ledger SET frozen=true WHERE singleton');
      }
      return entry;
    }
    const rejectedBeforeSend = entry.state === 'prepared' && receipt.state === 'rejected';
    if (entry.state !== 'sending' && entry.state !== 'unknown' && !rejectedBeforeSend) {
      throw new GatewayError('attempt_not_sent');
    }
    const id = entry.attempt.id;
    const cost = receipt.state === 'paid' ? receipt.costUsdNanos : 0;
    if (receipt.state === 'paid') {
      const billed = await tx.query(
        "SELECT 1 FROM gateway_external_attempts WHERE state='paid' AND receipt->>'providerId'=$1 AND id<>$2",
        [receipt.providerId, id],
      );
      if (billed.rowCount || cost > entry.attempt.ceilingUsdNanos || receipt.routeVerified === false) {
        await tx.query('UPDATE gateway_external_ledger SET frozen=true WHERE singleton');
      }
      if (billed.rowCount) receipt = { state: 'unknown', code: 'provider_receipt_conflict', providerId: receipt.providerId };
    }
    if (entry.receipt?.state === 'unknown' && entry.receipt.providerId && receipt.state === 'unknown' && !receipt.providerId) {
      receipt = { ...receipt, providerId: entry.receipt.providerId };
    }
    if (entry.receipt?.routerDiagnostic) receipt = { ...receipt, routerDiagnostic: entry.receipt.routerDiagnostic };
    const result = await tx.query<JournalRow>(
      `UPDATE gateway_external_attempts SET state=$2,receipt=$3,spent_usd_nanos=$4,
        slot_until=CASE WHEN $2='unknown' THEN slot_until ELSE NULL END WHERE id=$1 RETURNING ${columns}`,
      [id, receipt.state, encode(receipt), receipt.state === 'paid' ? cost : 0],
    );
    return result.rows[0];
  }

  async reconcile(operator: OperatorAuthorization, input: ReconciliationInput) {
    const fingerprint = hash(input);
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      const saved = await tx.query<{ fingerprint: string; outcome: ReturnType<typeof balanceOf> }>(
        'SELECT fingerprint,outcome FROM gateway_external_reconciliation WHERE actor_id=$1 AND operation_key=$2',
        [operator.actorId, input.operationKey],
      );
      if (saved.rows[0]) {
        if (saved.rows[0].fingerprint !== fingerprint) throw new GatewayError('operation_conflict');
        return saved.rows[0].outcome;
      }
      const entry = await this.byId(tx, input.attemptId);
      let outcome: ReturnType<typeof balanceOf>;
      if (input.resolution.state === 'isolate_unknown') {
        if (entry.state !== 'unknown' || entry.receipt?.state !== 'unknown' || entry.receipt.providerId) {
          throw new GatewayError('attempt_not_isolatable');
        }
        if (await this.hasRouteIsolation(tx, input.attemptId)) throw new GatewayError('attempt_already_isolated');
        outcome = balanceOf(entry, true);
      } else {
        const active = await tx.query(
          "SELECT 1 FROM gateway_external_attempts WHERE id=$1 AND state='sending' AND slot_until>clock_timestamp()",
          [input.attemptId],
        );
        if (active.rowCount) throw new GatewayError('attempt_in_flight');
        if ((entry.state === 'paid' || entry.state === 'rejected') && !sameSettlement(entry.receipt, input.resolution)) {
          throw new GatewayError('attempt_already_settled');
        }
        outcome = balanceOf(await this.settlement(tx, entry, input.resolution));
      }
      await tx.query(
        `INSERT INTO gateway_external_reconciliation(actor_id,operation_key,attempt_id,authority,reason_ref,
         fingerprint,previous,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [operator.actorId, input.operationKey, input.attemptId, operator.authority, input.reasonRef,
         fingerprint, encode(balanceOf(entry)), encode(outcome)],
      );
      return outcome;
    });
  }

  async routeIsolations(): Promise<JournalEntry[]> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      const result = await tx.query<JournalRow>(
        `SELECT ${columns} FROM gateway_external_attempts WHERE ${isolated}`,
      );
      return result.rows;
    });
  }

  async attempt(id: string): Promise<JournalEntry> {
    return transaction(this.pool, async tx => {
      await this.bound(tx);
      return this.byId(tx, id);
    });
  }
}
