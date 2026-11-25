import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createGateway, journalFromEnv } from '../../dist/src/modules/gateway/index.js';

const route = { id: 'w33-controlled', revision: 'v1', transport: 'managed', enabled: true,
  maxRequestBytes: 4096, timeoutMs: 30_000, ceilingUsdNanos: 500_000_000 };
const paidAmount = 100_000_000;

async function dispatchAndLoseWorker(gatewayEnv, appConnection, input) {
  const child = fork(new URL(import.meta.url), ['dispatch'], {
    signal: AbortSignal.timeout(60_000), stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  const accepted = once(child, 'message');
  child.send({ gatewayEnv, appConnection, input });
  try {
    const [message] = await Promise.race([
      accepted,
      exited.then(([code, signal]) => assert.fail(`Worker exited before provider accepted: ${code ?? signal}`)),
    ]);
    assert.equal(message.status, 'accepted');
    assert.ok(message.attemptId);
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    return message.attemptId;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

if (process.argv[2] === 'dispatch') {
  process.once('message', async ({ gatewayEnv, appConnection, input }) => {
    const app = new pg.Pool({ ...appConnection, database: 'app' });
    const provider = new pg.Pool({ ...appConnection, database: 'provider' });
    const external = journalFromEnv(gatewayEnv);
    try {
      const gateway = createGateway(app, { journal: external.journal, transport: {
        kind: 'managed',
        async send(attempt) {
          await provider.query('INSERT INTO effects(id,cost) VALUES ($1,$2)', [attempt.id, paidAmount]);
          process.send({ status: 'accepted', attemptId: attempt.id });
          // The provider has accepted the effect and withholds the entire response.
          return new Promise(() => {});
        },
      } });
      const result = await gateway.call(input);
      assert.fail('Worker returned before fault injection: ' + JSON.stringify(result));
    } finally {
      await Promise.all([app.end(), provider.end(), external.close()]);
    }
  });
}

export async function verifyGateway({ gatewayEnv, appConnection, journalAdminConnection, startJournal, stopJournal }) {
  const admin = new pg.Client({ ...appConnection, database: 'postgres' });
  const provider = new pg.Client({ ...appConnection, database: 'provider' });
  const connectApp = () => new pg.Pool({ ...appConnection, database: 'app' });
  const openJournal = () => journalFromEnv(gatewayEnv);
  let app;
  let external;
  let unexpectedSends = 0;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE app');
    await admin.query('CREATE DATABASE provider');
    await provider.connect();
    await provider.query(`CREATE TABLE effects(id uuid NOT NULL, cost bigint NOT NULL,
      receipt_visible boolean NOT NULL DEFAULT false)`);
    const readProvider = async () => (await provider.query('SELECT id, cost::int, receipt_visible FROM effects')).rows;
    const transport = {
      kind: 'managed',
      async send() {
        unexpectedSends++;
        throw new Error('Unexpected managed transport call');
      },
      async lookup(attempt) {
        const row = (await readProvider()).find(row => row.id === attempt.id);
        if (!row?.receipt_visible) return null;
        return { receipt: { state: 'paid', costUsdNanos: row.cost, providerId: 'controlled:' + attempt.id,
          evidenceRef: 'synthetic-provider-ledger:' + attempt.id }, output: { reading: 'synthetic result' } };
      },
    };
    app = connectApp();
    external = openJournal();
    for (const file of ['08_gateway_state.sql', '08_gateway_z_route_isolation.sql', '25_gateway_budget_attribution.sql', '34_gateway_route_ceiling_multiplier.sql']) {
      await app.query(await readFile('db/migrations/' + file, 'utf8'));
    }
    const ref = { projectId: randomUUID(), scopeId: randomUUID(), generationId: randomUUID() };
    const budget = { packageId: randomUUID(), initiatedBy: 'copilot' };
    const journalAdmin = new pg.Client(journalAdminConnection);
    try {
      await journalAdmin.connect();
      await journalAdmin.query('INSERT INTO gateway_external_project_budgets(project_id,limit_usd_nanos) VALUES ($1,$2)',
        [ref.projectId, 6_000_000_000]);
    } finally {
      await journalAdmin.end();
    }
    const gateway = createGateway(app, { journal: external.journal, transport });
    await gateway.configureRoute(route);
    await gateway.openGeneration(ref);
    await gateway.sealGeneration(ref, [{ id: 'a', branch: 'A', place: 'page-1' },
      { id: 'b', branch: 'B', place: 'page-1' }]);
    await gateway.grantRoute({ projectId: ref.projectId, routeId: route.id, dataClass: 'synthetic',
      purpose: 'primary_a', revision: route.revision, allowed: true });
    await gateway.enqueue({ ...ref, key: 'a', kind: 'a', subjectId: 'fixture', obligationId: 'a', purpose: 'primary_a' });
    const work = await gateway.claim({ workerId: 'before-crash', kinds: ['a'], leaseMs: 120_000 });
    assert.ok(work);
    const cursor = { sourceRef: 'synthetic:page-1', reading: 'saved before dispatch' };
    await gateway.checkpoint(work.lease, cursor);
    const input = { lease: work.lease, routeId: route.id, effectKey: 'synthetic-turn', dataClass: 'synthetic',
      inputRefs: [cursor.sourceRef], request: { messages: ['synthetic only'] }, budget };

    await app.end();
    app = undefined;
    await admin.query('CREATE DATABASE app_before TEMPLATE app');
    app = connectApp();
    const ready = createGateway(app, { journal: external.journal, transport });
    stopJournal('fast');
    const hold = await ready.call(input);
    assert.equal(hold.status, 'held');
    assert.equal(hold.code, 'journal_unavailable');
    assert.equal(unexpectedSends, 0);
    assert.deepEqual(await readProvider(), []);
    console.log(JSON.stringify({ check: 'journal-down', result: hold.code, sends: 0 }));

    await app.end();
    app = undefined;
    await external.close();
    external = undefined;
    startJournal();
    const attemptId = await dispatchAndLoseWorker(gatewayEnv, appConnection, input);
    const crashAt = performance.now();
    stopJournal('immediate');
    assert.deepEqual(await readProvider(), [{ id: attemptId, cost: paidAmount, receipt_visible: false }]);
    await admin.query('DROP DATABASE app');
    await admin.query('CREATE DATABASE app TEMPLATE app_before');
    app = connectApp();
    assert.equal((await app.query('SELECT count(*)::int AS n FROM gateway_attempts')).rows[0].n, 0);
    startJournal();
    external = openJournal();
    const restored = createGateway(app, { journal: external.journal, transport });
    const retained = await restored.recover();
    assert.equal(retained.unresolved, 1);
    assert.equal(retained.reserveUsdNanos, route.ceilingUsdNanos);
    assert.equal(retained.spentUsdNanos, 0);
    const buckets = await external.journal.budgetBalances(ref.projectId, budget);
    assert.deepEqual(buckets.map(row => row.scope).sort(), ['copilot', 'installation', 'package', 'project']);
    for (const row of buckets) assert.equal(row.reserveUsdNanos, route.ceilingUsdNanos);
    const unknown = await restored.call(input);
    assert.equal(unknown.status, 'held');
    assert.equal(unknown.code, 'unknown_charge');
    assert.equal(unknown.attemptId, attemptId);
    assert.equal(unexpectedSends, 0);
    const recoveryToHoldMs = Math.round(performance.now() - crashAt);
    const saved = await app.query('SELECT cursor FROM gateway_jobs WHERE id=$1', [work.lease.jobId]);
    assert.deepEqual(saved.rows[0].cursor, cursor);
    console.log(JSON.stringify({ check: 'after-crash-and-app-restore', attemptId,
      result: unknown.code, retained, buckets, cursor, sends: 1, recoveryToHoldMs }));

    await provider.query('UPDATE effects SET receipt_visible=true WHERE id=$1', [attemptId]);
    const settled = await restored.recover();
    assert.equal(settled.unresolved, 0);
    assert.equal(settled.reserveUsdNanos, 0);
    assert.equal(settled.spentUsdNanos, paidAmount);
    for (const row of await external.journal.budgetBalances(ref.projectId, budget)) {
      assert.equal(row.spentUsdNanos, paidAmount);
      assert.equal(row.reserveUsdNanos, 0);
    }
    const replay = await restored.call(input);
    assert.equal(replay.status, 'paid');
    assert.equal(replay.replay, true);
    assert.equal(replay.attemptId, attemptId);
    assert.deepEqual(replay.output, { reading: 'synthetic result' });
    assert.equal(unexpectedSends, 0);
    assert.deepEqual(await readProvider(), [{ id: attemptId, cost: paidAmount, receipt_visible: true }]);
    console.log(JSON.stringify({ check: 'late-receipt', attemptId, settled, replay: replay.replay,
      sends: 1, recoveryToReplayMs: Math.round(performance.now() - crashAt) }));
  } finally {
    await Promise.all([app?.end(), external?.close(), admin.end(), provider.end()]);
  }
}
