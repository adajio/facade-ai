import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

export const toolHash = (file) => createHash('sha256').update(readFileSync(new URL(file))).digest('hex');

export async function verifyManagedLauncherTargets({ requireJournal = true, loadBoundary } = {}) {
  const { verifyManagedTestTarget } = await (loadBoundary?.() ?? import('../../dist/src/platform/runtime-boundary.js'));
  const targets = [['app', process.env.DATABASE_URL], ['journal', process.env.FACADE_GATEWAY_JOURNAL_URL]];
  for (const [kind, connectionString] of targets) {
    if (!connectionString && kind === 'journal' && !requireJournal) continue;
    if (!connectionString) throw new Error(`Managed model test ${kind} database URL is required`);
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    try {
      await client.connect();
      await verifyManagedTestTarget(client, kind);
    } finally {
      await client.end();
    }
  }
}

export function managedProfile() {
  const slot = (role) => ({
    routeId: `managed-${role}`, model: `managed/${role}`, dataClass: 'synthetic',
    maxTurns: 24, maxTokens: 2_048, maxKnownRejections: 2,
  });
  return { A: slot('a'), B: slot('b'), lead: slot('lead') };
}

export function managedWorkerOptions(endpoint, entrypoint) {
  const address = new URL(endpoint);
  if (address.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(address.hostname)
      || address.username || address.password || address.hash) {
    throw new Error('Managed tests require a loopback HTTP endpoint');
  }
  return {
    profile: managedProfile(),
    toolSha256: toolHash(entrypoint),
    transport: {
      kind: 'managed',
      async send(attempt, route, request, signal) {
        const response = await fetch(address, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attempt, routeId: route.id, request }),
        });
        if (!response.ok) return { receipt: { state: 'unknown', code: 'managed_response_unavailable' } };
        return response.json();
      },
    },
  };
}
