// Trusted stand configuration and ledger observation for the single synthetic TXT probe.
import { setTimeout as delay } from 'node:timers/promises';

const [action, projectId, scopeId, originalSha256] = process.argv.slice(2);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
if (![projectId, scopeId].every(value => uuid.test(value ?? '')) || !/^[\da-f]{64}$/.test(originalSha256 ?? '')) {
  throw Error('Expected synthetic project UUID, scope UUID and original SHA-256');
}

const route = {
  id: 'step15-qwen-txt', revision: 'alibaba-20261115-txt-20261122', transport: 'openrouter', enabled: true,
  maxRequestBytes: 256 * 1024, ceilingUsdNanos: 9_084_216_000, timeoutMs: 75_000, minIntervalMs: 95_000,
};
const profile = {
  routeId: route.id, revision: route.revision, model: 'qwen/qwen4-max', provider: 'alibaba',
  expectedResponseProvider: 'Alibaba', mode: 'synthetic-research',
  syntheticScopes: [{ projectId, scopeId, originalSha256s: [originalSha256], approvalRef: 'step15:single-synthetic-txt' }],
  boundEvidenceRef: 'step15:qwen-txt-quote-and-endpoint-20261122', validUntil: '2026-11-23T00:00:00.000Z',
  inputTokenUpperBound: 1_000_000, outputTokenLimit: 2_048, completionParameter: 'max_tokens',
  completionCapIncludesReasoning: true, promptNanosPerToken: 1_500, completionNanosPerToken: 4_500,
  cacheReadNanosPerToken: 75, cacheWriteNanosPerToken: 3_000, cacheBilling: 'supplement',
  reasoningNanosPerToken: 4_500, reasoningBilling: 'replaces-output',
  maxImages: 0, maxImagePixels: 0, maxImageWidth: 0, maxImageHeight: 0, maxImageBytes: 0,
  // Reserve an entire output context independently of enforcement of the smaller wire cap.
  requestNanos: 0, imageNanos: 0, additionalNanos: 4_500_000_000, knownNoChargeStatuses: [],
};
const grant = {
  projectId, routeId: route.id, revision: route.revision, purpose: 'primary_b', dataClass: 'synthetic', allowed: true,
};

if (action === 'plan') {
  const harnessProfile = {
    A: { routeId: 'step15-kimi-held', model: 'moonshotai/kimi-k3.1-pro', dataClass: 'synthetic', maxTokens: 2048,
      maxTurns: 8, maxKnownRejections: 0 },
    B: { routeId: route.id, model: profile.model, dataClass: 'synthetic', maxTokens: 2048,
      maxTurns: 8, maxKnownRejections: 0 },
    lead: null,
  };
  console.log(JSON.stringify({ route, profile, grant, harnessProfile }, null, 2));
} else if (['grant', 'revoke', 'monitor', 'snapshot'].includes(action)) {
  const { createGateway, estimateOpenRouterRequest, journalFromEnv } = await import('file:///app/dist/src/modules/gateway/index.js');
  const { openPool } = await import('file:///app/dist/src/platform/db.js');
  const journalConnection = journalFromEnv();
  if (!journalConnection) throw Error('The external step-15 journal is required');
  const { journal } = journalConnection;
  const db = openPool(process.env.DATABASE_URL);
  const gateway = createGateway(db, { journal });
  const revoke = () => gateway.grantRoute({ ...grant, allowed: false });
  try {
    const proof = estimateOpenRouterRequest(profile, route, {
      model: profile.model, messages: [{ role: 'user', content: 'Synthetic accounting probe' }], max_tokens: 2048,
    });
    if (proof?.ceilingUsdNanos !== route.ceilingUsdNanos) throw Error('The compiled quote differs from the approved ceiling');
    if (action === 'grant') {
      const balance = await journal.balance();
      if (balance.frozen || balance.reserveUsdNanos !== 0 || balance.remainingUsdNanos < route.ceilingUsdNanos) {
        throw Error('External ledger has an unresolved reservation or insufficient budget');
      }
      const { rowCount } = await db.query(
        'SELECT 1 FROM project_scopes WHERE project_id=$1 AND id=$2', [projectId, scopeId],
      );
      if (rowCount !== 1) throw Error('No matching scope in the stand database');
      await gateway.configureRoute(route);
      await gateway.grantRoute(grant);
      console.log(JSON.stringify({ proof, balance, grant }));
    } else if (action === 'revoke') {
      await revoke();
      console.log(JSON.stringify({ balance: await journal.balance(), allowed: false }));
    } else if (action === 'snapshot') {
      const reader = await db.connect();
      const collected = {};
      try {
        await reader.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        for (const table of ['gateway_jobs', 'reader_maps', 'reader_evidence', 'reader_observations', 'harness_observations']) {
          collected[table] = (await reader.query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY 1`, [projectId])).rows;
        }
        await reader.query('COMMIT');
      } catch (error) {
        await reader.query('ROLLBACK');
        throw error;
      } finally {
        reader.release();
      }
      console.log(JSON.stringify({ balance: await journal.balance(), ...collected }, null, 2));
    } else {
      let previous;
      do {
        const entries = [];
        let cursor = '0';
        for (;;) {
          const page = await journal.entries(cursor);
          if (!page.length) break;
          entries.push(...page.filter(item => item.attempt.projectId === projectId && item.startedAt));
          cursor = page.at(-1).createdOrder;
        }
        const balance = await journal.balance();
        const attempts = entries.map(({ attempt, state, receipt, createdOrder, startedAt }) => ({
          id: attempt.id, purpose: attempt.purpose, routeId: attempt.routeId, reserve: attempt.ceilingUsdNanos,
          state, receipt, createdOrder, startedAt,
        }));
        const state = JSON.stringify({ balance, attempts });
        if (state !== previous) console.log(JSON.stringify({ observedAt: new Date(), balance, attempts }));
        previous = state;
        const unsafe = balance.frozen || attempts.some(({ purpose, routeId, state, receipt }) =>
          purpose !== grant.purpose || routeId !== route.id || state === 'unknown' || state === 'rejected'
          || (state === 'paid' && (receipt?.routeVerified !== true || receipt.model !== profile.model
            || receipt.provider !== profile.expectedResponseProvider)));
        if (unsafe || (balance.reserveUsdNanos === 0 && balance.remainingUsdNanos < route.ceilingUsdNanos)) {
          await revoke();
          console.log(JSON.stringify({ stopped: true, unsafe, balance }));
          break;
        }
        await delay(1000);
      } while (true);
    }
  } catch (error) {
    if (action === 'monitor') await revoke();
    throw error;
  } finally {
    await db.end();
    await journalConnection.close();
  }
} else {
  throw Error('Expected plan, grant, revoke, monitor or snapshot');
}
