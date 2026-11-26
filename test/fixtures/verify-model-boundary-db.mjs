import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { WorkQueue } from '../../dist/src/modules/gateway/queue.js';
import { releaseManagedTestDatabase, sealManagedTestDatabase } from '../../dist/src/platform/runtime-boundary.js';

assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/test_model_boundary_[a-f0-9]+$/u);
assert.match(new URL(process.env.FACADE_GATEWAY_JOURNAL_URL).pathname, /^\/journal_model_boundary_[a-f0-9]+$/u);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const runId = randomUUID();
const reservePort = createServer();
reservePort.listen(0, '127.0.0.1');
await once(reservePort, 'listening');
const port = reservePort.address().port;
await new Promise((resolve) => reservePort.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, FACADE_DATA_DIR: process.env.FACADE_DATA_DIR,
  FACADE_S3_ENDPOINT: 'http://127.0.0.1:1', FACADE_S3_BUCKET: 'fixture-unused', HOST: '127.0.0.1', PORT: String(port),
  FACADE_PUBLIC_ORIGIN: origin };
const managedEnv = { ...env, FACADE_GATEWAY_JOURNAL_URL: process.env.FACADE_GATEWAY_JOURNAL_URL,
  FACADE_GATEWAY_LEDGER_ID: runId, FACADE_MANAGED_TEST_RUN_ID: runId };

function launchScript(file, settings, args = []) {
  const processHandle = spawn(process.execPath, [file, ...args], { env: settings });
  let output = '';
  processHandle.stdout.on('data', (bytes) => { output += bytes.toString(); });
  processHandle.stderr.on('data', (bytes) => { output += bytes.toString(); });
  return { processHandle, output: () => output, exited: once(processHandle, 'exit') };
}
const launch = (role) => launchScript(`dist/apps/${role}/src/main.js`, env);

async function fingerprint(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM organizations o) AS organizations,
    (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u) AS users,
    (SELECT jsonb_agg(to_jsonb(b)) FROM access_bootstrap b) AS bootstrap,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id,user_id) FROM project_memberships m) AS memberships,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM gateway_routes r) AS routes,
    to_regclass('public.facade_managed_test_seal') IS NOT NULL AS sealed`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const projectId = randomUUID();
const generation = { projectId, scopeId: randomUUID(), generationId: randomUUID() };
const queue = new WorkQueue(db);
let worker;
let api;
try {
  await db.query("INSERT INTO organizations(name) VALUES ('ordinary-runtime sentinel')");
  const original = await fingerprint(db);
  for (const [file, flags] of [
    ['test/acceptance/managed.mjs', {}],
    ['test/fixtures/managed-test-api.mjs', {}],
    ['src/modules/harness/worker.integration.test.mjs', { FACADE_HARNESS_INTEGRATION: '1' }],
    ['src/modules/harness/package-worker.integration.test.mjs', { FACADE_PACKAGE_INTEGRATION: '1' }],
    ['src/modules/questions/questions.integration.test.mjs', { FACADE_QUESTIONS_WORKER_INTEGRATION: '1' }],
    ['src/modules/formats/test/stand.test.mjs', { FACADE_STEP11_STAND: '1', FACADE_STEP11_WORKER_DWG: '1' }],
  ]) {
    const rejected = launchScript(file, { ...managedEnv, ...flags });
    assert.deepEqual(await rejected.exited, [1, null], rejected.output());
    assert.match(rejected.output(), /Managed model tests require a marked app database/);
    assert.equal(await fingerprint(db), original);
  }
  await queue.openGeneration(generation);
  await queue.declarePrimary(generation, { id: 'A', branch: 'A', place: 'fixture' });
  const versionId = randomUUID();
  const payload = { mode: 'primary', branch: 'A', settings: null,
    place: { unitId: '1', source: { projectId, documentId: randomUUID(), versionId, sha256: 'a'.repeat(64) } } };
  const jobId = await queue.enqueue({ ...generation, key: 'fixture', kind: 'harness_research', purpose: 'primary_a',
    subjectId: versionId, obligationId: 'A', payload });
  worker = launch('worker');
  const deadline = Date.now() + 15_000;
  let job;
  while (Date.now() < deadline && worker.processHandle.exitCode === null) {
    ({ rows: [job] } = await db.query('SELECT state, reason, payload FROM gateway_jobs WHERE id=$1', [jobId]));
    if (job.state === 'held') break;
    await delay(100);
  }
  // The default reader profile is available even on a stand with no model transport.
  assert.deepEqual(job, { state: 'held', reason: 'research_gateway_unconfigured', payload }, worker.output());
  assert.match(worker.output(), /mode: 'disabled'/);
  assert.equal((await db.query('SELECT 1 FROM gateway_attempts WHERE job_id=$1', [jobId])).rowCount, 0);
  const appName = new URL(env.DATABASE_URL).pathname.slice(1);
  const journalName = new URL(managedEnv.FACADE_GATEWAY_JOURNAL_URL).pathname.slice(1);
  const provision = () => launchScript('test/fixtures/provision-managed-test.mjs', managedEnv, [appName, journalName, runId]);
  const busy = provision();
  assert.deepEqual(await busy.exited, [1, null], busy.output());
  assert.match(busy.output(), /Stop the runtime on the confirmed test database/);
  assert.equal(await fingerprint(db), original);
  worker.processHandle.kill('SIGTERM');
  assert.deepEqual(await worker.exited, [0, null], worker.output());

  const password = `synthetic-${randomUUID()}`;
  const bootstrap = launchScript('dist/src/modules/access/bootstrap.js', env, ['Ordinary synthetic stand', 'boundary_owner']);
  bootstrap.processHandle.stdin.end(password + '\n');
  assert.deepEqual(await bootstrap.exited, [0, null], bootstrap.output());
  assert.equal((await db.query('SELECT 1 FROM access_bootstrap')).rowCount, 1);

  const prepared = provision();
  assert.deepEqual(await prepared.exited, [0, null], prepared.output());
  process.env.FACADE_MANAGED_TEST_RUN_ID = runId;
  const testConnection = await sealManagedTestDatabase(db);
  await releaseManagedTestDatabase(testConnection);
  process.env.FACADE_GATEWAY_JOURNAL_URL = env.DATABASE_URL;
  try {
    await assert.rejects(sealManagedTestDatabase(db), /Managed model test journal database identity differs/);
  } finally {
    process.env.FACADE_GATEWAY_JOURNAL_URL = managedEnv.FACADE_GATEWAY_JOURNAL_URL;
  }
  for (const role of ['api', 'worker']) {
    const blocked = launch(role);
    assert.deepEqual(await blocked.exited, [1, null], blocked.output());
    assert.match(blocked.output(), /Managed test database is sealed for isolated tools/);
  }
  const marked = await fingerprint(db);
  const wrongJournal = launchScript('test/acceptance/managed.mjs', { ...managedEnv, FACADE_GATEWAY_JOURNAL_URL: env.DATABASE_URL });
  assert.deepEqual(await wrongJournal.exited, [1, null], wrongJournal.output());
  assert.match(wrongJournal.output(), /Managed model test journal database identity differs/);
  assert.equal(await fingerprint(db), marked);
  api = launchScript('test/fixtures/managed-test-api.mjs', managedEnv);
  let ready;
  const apiDeadline = Date.now() + 15_000;
  while (!ready && Date.now() < apiDeadline && api.processHandle.exitCode === null) {
    ready = (await fetch(origin + '/readyz').catch(() => null))?.ok;
    if (!ready) await delay(100);
  }
  assert.ok(ready, api.output());
  const login = await fetch(origin + '/api/sessions', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'boundary_owner', password }),
  });
  assert.equal(login.status, 200, await login.text());
  assert.ok(login.headers.get('set-cookie'));
  console.log(JSON.stringify({ mode: 'postgres-boundary-check', state: job.state, reason: job.reason, attempts: 0,
    seal: 'durable', sentinelFingerprint: original, wrongAppUnchanged: true, wrongJournalUnchanged: true,
    ordinaryBootstrap: true, managedLogin: true }));
} finally {
  if (api?.processHandle.exitCode === null) {
    api.processHandle.kill('SIGTERM');
    await api.exited;
  }
  if (worker?.processHandle.exitCode === null) {
    worker.processHandle.kill('SIGTERM');
    await worker.exited;
  }
  await db.end();
}
