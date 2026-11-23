import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { WorkQueue } from '../../dist/src/modules/gateway/queue.js';
import { sealManagedTestDatabase } from '../../dist/src/platform/runtime-boundary.js';

assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/test_model_boundary_[a-f0-9]+$/u);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, FACADE_DATA_DIR: process.env.FACADE_DATA_DIR,
  FACADE_S3_ENDPOINT: 'http://127.0.0.1:1', FACADE_S3_BUCKET: 'fixture-unused' };

function launch(role) {
  const processHandle = spawn(process.execPath, [`dist/apps/${role}/src/main.js`], { env });
  let output = '';
  processHandle.stdout.on('data', (bytes) => { output += bytes.toString(); });
  processHandle.stderr.on('data', (bytes) => { output += bytes.toString(); });
  return { processHandle, output: () => output, exited: once(processHandle, 'exit') };
}

const projectId = randomUUID();
const generation = { projectId, scopeId: randomUUID(), generationId: randomUUID() };
const queue = new WorkQueue(db);
let worker;
try {
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
  assert.deepEqual(job, { state: 'held', reason: 'research_profile_unavailable', payload }, worker.output());
  assert.match(worker.output(), /mode: 'disabled'/);
  assert.equal((await db.query('SELECT 1 FROM gateway_attempts WHERE job_id=$1', [jobId])).rowCount, 0);
  await assert.rejects(sealManagedTestDatabase(db), /already serves a runtime process/);
  worker.processHandle.kill('SIGTERM');
  assert.deepEqual(await worker.exited, [0, null], worker.output());

  const testConnection = await sealManagedTestDatabase(db);
  testConnection.release(true);
  for (const role of ['api', 'worker']) {
    const blocked = launch(role);
    assert.deepEqual(await blocked.exited, [1, null], blocked.output());
    assert.match(blocked.output(), /Managed test database is sealed for isolated tools/);
  }
  console.log(JSON.stringify({ mode: 'postgres-boundary-check', state: job.state, reason: job.reason, attempts: 0, seal: 'durable' }));
} finally {
  if (worker?.processHandle.exitCode === null) {
    worker.processHandle.kill('SIGTERM');
    await worker.exited;
  }
  await db.end();
}
