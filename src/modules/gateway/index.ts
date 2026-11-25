import pg, { type Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { Gateway, type ReviewAdmission, type ResearchAdmission } from './gateway.js';
import { PostgresIntentJournal } from './journal.js';
import { cheaperInferenceTransport, type CheaperInferenceProfile } from './cheaperinference.js';
import { openRouterTransport, type Step15Approval } from './openrouter.js';
import { BUDGET_USD_NANOS, GatewayError, positiveInteger, type ModelTransport } from './types.js';
import { registerOperatorRoutes } from './operator.js';

export { Gateway } from './gateway.js';
export { PostgresIntentJournal, type ReconciliationInput, type OperatorAuthorization } from './journal.js';
export { terraModel, type CheaperInferenceProfile } from './cheaperinference.js';
export { qwen38Max, qwen4Max, estimateOpenRouterRequest, matchesKimiEndpoint, type OpenRouterCostBound, type OpenRouterInputEnvelope, type OpenRouterProfile, type QualifiedOpenRouterProfile, type Step15Approval } from './openrouter.js';
export { type LeasedJob } from './queue.js';
export * from './types.js';

export interface ResearchGatewayPolicy {
  researchAdmission?: ResearchAdmission;
  replayOnly?: boolean;
}

type ManagedTransport = ModelTransport & { kind: 'managed' };

export function createGateway(
  db: Pool, options?: ResearchGatewayPolicy & { journal?: PostgresIntentJournal; transport?: ManagedTransport; reviewAdmission?: ReviewAdmission },
): Gateway {
  if (options?.transport && options.transport.kind !== 'managed') throw new GatewayError('managed_transport_required');
  return new Gateway(db, options?.journal, options?.transport, options?.reviewAdmission, options?.researchAdmission, options?.replayOnly);
}

export function createStep15Gateway(
  db: Pool, journal: PostgresIntentJournal, approval: Step15Approval, reviewAdmission?: ReviewAdmission, policy?: ResearchGatewayPolicy,
): Gateway {
  return createLiveGateway(db, journal, { openRouter: approval }, reviewAdmission, policy);
}

export function createLiveGateway(
  db: Pool, journal: PostgresIntentJournal, approvals: {
    openRouter?: Step15Approval; cheaperInference?: { apiKey: string; profiles: readonly CheaperInferenceProfile[] };
  }, reviewAdmission?: ReviewAdmission, policy?: ResearchGatewayPolicy,
): Gateway {
  if (process.env.FACADE_GATEWAY_LIVE_MODE !== 'step-15') throw new GatewayError('step15_approval_required');
  const transports: ModelTransport[] = [];
  if (approvals.openRouter) transports.push(openRouterTransport(approvals.openRouter));
  if (approvals.cheaperInference) transports.push(cheaperInferenceTransport(approvals.cheaperInference));
  if (!transports.length) throw new GatewayError('step15_profile_required');
  return new Gateway(db, journal, transports, reviewAdmission, policy?.researchAdmission, policy?.replayOnly);
}

export function journalFromEnv(env: NodeJS.ProcessEnv = process.env): { journal: PostgresIntentJournal; close: () => Promise<void> } | null {
  const expectedLimit = env.FACADE_GATEWAY_EXPECTED_JOURNAL_LIMIT_USD_NANOS;
  if (!env.FACADE_GATEWAY_JOURNAL_URL && !env.FACADE_GATEWAY_LEDGER_ID && expectedLimit === undefined) return null;
  if (!env.FACADE_GATEWAY_JOURNAL_URL || !env.FACADE_GATEWAY_LEDGER_ID) throw new GatewayError('journal_config_incomplete');
  let expectedLimitUsdNanos: number | undefined;
  if (expectedLimit !== undefined) {
    expectedLimitUsdNanos = Number(expectedLimit);
    if (!/^[1-9]\d*$/.test(expectedLimit) || !positiveInteger(expectedLimitUsdNanos, BUDGET_USD_NANOS)) {
      throw new GatewayError('journal_config_invalid');
    }
  }
  let external: URL;
  try { external = new URL(env.FACADE_GATEWAY_JOURNAL_URL); }
  catch { throw new GatewayError('journal_config_invalid'); }
  if (!['postgres:','postgresql:'].includes(external.protocol)) throw new GatewayError('journal_config_invalid');
  const local = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  if (local && external.host === local.host && (
    external.pathname === local.pathname || env.FACADE_GATEWAY_LIVE_MODE === 'step-15'
  )) throw new GatewayError('journal_separation_required');
  const pool = new pg.Pool({
    connectionString: external.href, max: 4, connectionTimeoutMillis: 2000,
    query_timeout: 3500, statement_timeout: 3000,
  });
  pool.on('error', () => { /* Admission will fail closed on the next journal operation. */ });
  return { journal: new PostgresIntentJournal(pool, env.FACADE_GATEWAY_LEDGER_ID, expectedLimitUsdNanos), close: () => pool.end() };
}

export async function register(app: FastifyInstance): Promise<void> {
  const connection = journalFromEnv();
  const gateway = createGateway(app.db, connection ? { journal: connection.journal } : undefined);
  if (connection) app.addHook('onClose', () => connection.close());
  registerOperatorRoutes(app, gateway);
}
