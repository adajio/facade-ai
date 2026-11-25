import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const BUDGET_USD_NANOS = 10_000_000_000;
export const MAX_BUDGET_USD_NANOS = 100_000_000_000;

export type BudgetAttribution = {
  initiatedBy: 'background' | 'copilot';
  packageId?: string;
};

export function sameBudget(left?: BudgetAttribution, right?: BudgetAttribution): boolean {
  return left?.initiatedBy === right?.initiatedBy && left?.packageId === right?.packageId;
}

export type Purpose = 'local' | 'primary_a' | 'primary_b' | 'review';
export type ModelPurpose = Exclude<Purpose, 'local'>;
export type GenerationRef<S extends string | null = string> = { projectId: string; scopeId: S; generationId: string };
export type QueueTarget = GenerationRef<string | null>;
export type Obligation = { id: string; branch: 'A' | 'B'; place: string };
export type PrimaryResult = { state: 'completed' | 'final_refusal'; evidenceRef: string };
export type Lease = { jobId: string; workerId: string; epoch: number };

export type EnqueueInput = QueueTarget & {
  key: string;
  kind: string;
  purpose: Purpose;
  subjectId: string;
  obligationId?: string;
  payload?: unknown;
  priority?: number;
};

export type RoutePolicy = {
  id: string;
  revision: string;
  transport: 'managed' | 'openrouter' | 'cheaperinference' | 'featherless';
  enabled: boolean;
  maxRequestBytes: number;
  ceilingUsdNanos: number;
  timeoutMs: number;
  minIntervalMs?: number;
};

export type RouteGrant = {
  projectId: string;
  routeId: string;
  dataClass: string;
  purpose: ModelPurpose;
  revision: string;
  allowed: boolean;
};

export type Attempt = QueueTarget & {
  id: string;
  jobId: string;
  purpose: ModelPurpose;
  effectKey: string;
  requestHash: string;
  routeId: string;
  revision: string;
  ceilingUsdNanos: number;
  previousRejectedId: string | null;
  budget?: BudgetAttribution;
  pricingFingerprint?: string;
  dataClass?: string;
};

export type RouterDiagnostic = {
  traceId: string;
  httpStatus: number;
  errorCode?: number;
  errorType?: string;
  failedRoutingStep?: string;
  routerAttempt?: number;
  requestId?: string;
  stage: 'before_provider' | 'provider_attempted' | 'undetermined';
};

export type Receipt = (
  | { state: 'paid'; costUsdNanos: number; providerId: string; evidenceRef: string; promptTokens?: number; completionTokens?: number; model?: string; provider?: string; routeVerified?: boolean }
  | { state: 'rejected'; code: string; evidenceRef: string }
  | { state: 'unknown'; code: string; providerId?: string }
) & { routerDiagnostic?: RouterDiagnostic };

export type ProviderOutcome = { receipt: Receipt; output?: unknown };
export type KnownReceipt = Exclude<Receipt, { state: 'unknown' }>;
export type JournalEntry = {
  attempt: Attempt;
  state: 'prepared' | 'sending' | 'unknown' | 'paid' | 'rejected' | 'cancelled';
  receipt: Receipt | null;
};

export type CallInput = {
  lease: Lease;
  effectKey: string;
  routeId: string;
  dataClass: string;
  request: unknown;
  inputRefs: readonly string[];
  retryRejectedAttemptId?: string;
  budget?: BudgetAttribution;
};

export type CallResult =
  | { status: 'paid'; attemptId: string; receipt: Extract<Receipt, { state: 'paid' }>; output: unknown; replay: boolean }
  | { status: 'rejected'; attemptId: string; receipt: Extract<Receipt, { state: 'rejected' }> }
  | { status: 'held'; code: string; nextAction: string; attemptId?: string; retryAt?: Date };

export type ModelAuthorization = QueueTarget & {
  jobId: string;
  payload: unknown;
  dataClass: string;
  inputRefs: readonly string[];
};

export type RequestQuote = { ceilingUsdNanos: number; pricingFingerprint: string };

export type ModelTransport = {
  kind: RoutePolicy['transport'];
  validate?(route: RoutePolicy, request: unknown): boolean;
  quote?(route: RoutePolicy, request: unknown): RequestQuote | null;
  requestBlock?(route: RoutePolicy, request: unknown): string | null;
  authorize?(tx: PoolClient, route: RoutePolicy, context: ModelAuthorization): Promise<boolean | string>;
  send(attempt: Attempt, route: RoutePolicy, request: unknown, signal: AbortSignal): Promise<ProviderOutcome>;
  // Return a known outcome only with evidence tied to this attempt or the observed provider ID.
  lookup?(attempt: Attempt, observed: { providerId?: string }): Promise<ProviderOutcome | null>;
};

export function encode(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, encode).join(',') + ']';
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const fields = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return '{' + fields.map(([k, v]) => JSON.stringify(k) + ':' + encode(v)).join(',') + '}';
  }
  throw new GatewayError('invalid_json');
}

export function hash(value: unknown): string {
  return createHash('sha256').update(encode(value)).digest('hex');
}

export class GatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function positiveInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

export async function transaction<T>(
  pool: Pool,
  operation: (tx: PoolClient) => Promise<T>,
  external?: PoolClient,
): Promise<T> {
  if (external) return operation(external);
  const tx = await pool.connect();
  let discard = false;
  // pg-pool handles idle clients. A checked-out client can emit a socket error even without a pending query.
  const onError = () => { discard = true; };
  tx.on('error', onError);
  try {
    await tx.query('BEGIN');
    const result = await operation(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    if (!discard) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    tx.removeListener('error', onError);
    tx.release(discard);
  }
}
