import pg, { type Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { Gateway } from './gateway.js';
import { PostgresIntentJournal } from './journal.js';
import { openRouterTransport, type Step15Approval } from './openrouter.js';
import { GatewayError, type ModelTransport } from './types.js';
import { registerOperatorRoutes } from './operator.js';

export { Gateway } from './gateway.js';
export { PostgresIntentJournal, type ReconciliationInput, type OperatorAuthorization } from './journal.js';
export { estimateOpenRouterRequest, matchesKimiEndpoint, type OpenRouterCostBound, type OpenRouterInputEnvelope, type OpenRouterProfile, type QualifiedOpenRouterProfile, type Step15Approval } from './openrouter.js';
export { type LeasedJob } from './queue.js';
export * from './types.js';

type ManagedTransport = ModelTransport & { kind: 'managed' };

export function createGateway(
  db: Pool, options?: { journal: PostgresIntentJournal; transport?: ManagedTransport },
): Gateway {
  if (options?.transport && options.transport.kind !== 'managed') throw new GatewayError('managed_transport_required');
  return new Gateway(db, options?.journal, options?.transport);
}

export function createStep15Gateway(
  db: Pool, journal: PostgresIntentJournal, approval: Step15Approval,
): Gateway {
  if (process.env.FACADE_GATEWAY_LIVE_MODE !== 'step-15') throw new GatewayError('step15_approval_required');
  return new Gateway(db, journal, openRouterTransport(approval));
}

export function journalFromEnv(env: NodeJS.ProcessEnv = process.env): { journal: PostgresIntentJournal; close: () => Promise<void> } | null {
  if (!env.FACADE_GATEWAY_JOURNAL_URL && !env.FACADE_GATEWAY_LEDGER_ID) return null;
  if (!env.FACADE_GATEWAY_JOURNAL_URL || !env.FACADE_GATEWAY_LEDGER_ID) throw new GatewayError('journal_config_incomplete');
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
  return { journal: new PostgresIntentJournal(pool, env.FACADE_GATEWAY_LEDGER_ID), close: () => pool.end() };
}

export async function register(app: FastifyInstance): Promise<void> {
  const connection = journalFromEnv();
  const gateway = createGateway(app.db, connection ? { journal: connection.journal } : undefined);
  if (connection) app.addHook('onClose', () => connection.close());
  registerOperatorRoutes(app, gateway);
}
