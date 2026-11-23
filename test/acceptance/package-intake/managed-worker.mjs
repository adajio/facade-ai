import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '/app/dist/src/platform/api.js';
import { readConfig } from '/app/dist/src/platform/config.js';
import { createGateway, journalFromEnv } from '/app/dist/src/modules/gateway/index.js';
import { readPackageAnalysis, startWorker } from '/app/dist/src/modules/harness/index.js';
import { startManagedTransport } from './managed-transport.mjs';

const [output, ...inputReports] = process.argv.slice(2);
assert.equal(output, '/results');
assert.ok(inputReports.length && inputReports.every((path) => /^\/results\/[a-z0-9/-]+\.json$/u.test(path)));
const { pathname: database } = new URL(process.env.DATABASE_URL);
const journalUrl = new URL(process.env.FACADE_GATEWAY_JOURNAL_URL);
assert.match(database, /^\/test_pkgintake_[a-z_]+_[a-f0-9]{12}$/u);
assert.equal(journalUrl.hostname, 'postgres-journal');
assert.match(journalUrl.pathname, /^\/journal_[a-f0-9]{24}$/u);
assert.equal(process.env.FACADE_GATEWAY_LEDGER_ID, (await readFile(resolve(output, 'managed-ledger-id.txt'), 'utf8')).trim());
assert.ok(!Object.keys(process.env).some((name) => /(?:KEY|LIVE_MODE|PROVIDER_URL|PROXY|REPLAY_ONLY)$/u.test(name) &&
  name.startsWith('FACADE_GATEWAY_') && process.env[name]));
assert.equal(process.env.FACADE_HARNESS_PACKAGE_PRIMARY, undefined);
assert.equal(process.env.FACADE_HARNESS_PACKAGE_EFFECTS, 'enabled');
assert.ok(!process.env.FACADE_HARNESS_PROFILE && !process.env.FACADE_HARNESS_PACKAGE_PROJECTS &&
  !process.env.FACADE_HARNESS_REPLAY_ONLY);

const reports = await Promise.all(inputReports.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
assert.ok(reports.every(({ projectId, receiptId, complete, mode, documents }) => mode === 'candidate' && complete &&
  /^[a-f0-9-]{36}$/u.test(projectId) && /^[a-f0-9-]{36}$/u.test(receiptId) && documents?.length));
const projects = new Set(reports.map(({ projectId }) => projectId));
assert.equal(projects.size, reports.length);
const previousFile = process.env.FACADE_ACCEPTANCE_PREVIOUS_TRACE;
assert.ok(!previousFile || previousFile === '/results/previous-trace.ndjson');
const previous = previousFile ? (await readFile(previousFile, 'utf8')).trim().split('\n').map(JSON.parse) : [];
assert.ok(previous.every(({ projectId }) => projects.has(projectId)));
const config = readConfig();
const app = await createApi(config);
const external = journalFromEnv();
assert.ok(external);
const gateway = createGateway(app.db, { journal: external.journal });
const controller = new AbortController();
const errors = [];
const calls = [];
const tracePath = resolve(output, 'managed-trace.ndjson');
await writeFile(tracePath, '', { flag: 'wx', mode: 0o600 });
let serialized = Promise.resolve();
const server = startManagedTransport({
  projects,
  onExchange(exchange) {
    assert.ok(!previous.some(({ jobId }) => exchange.jobId === jobId), 'a persisted job was sent again');
    calls.push(exchange);
    serialized = serialized.then(() => appendFile(tracePath, JSON.stringify(exchange) + '\n'));
    return serialized;
  },
  onError(error) {
    errors.push({ name: error.name, message: String(error.message).split('\n')[0] });
  },
});
let worker;
let readings;
let reviews;
let startingBalance;

try {
  startingBalance = await external.journal.balance();
  assert.equal(startingBalance.spentUsdNanos, 0);
  assert.equal(startingBalance.reserveUsdNanos, 0);
  assert.equal(startingBalance.frozen, false);
  const { rows: projectRows } = await app.db.query(
    'SELECT id FROM projects WHERE intake_mode ORDER BY id');
  assert.deepEqual(projectRows.map(({ id }) => id), [...projects].sort());
  for (const report of reports) {
    const { rows: [{ checks }] } = await app.db.query(
      `SELECT jsonb_agg(version_id ORDER BY version_id) AS checks
       FROM intake_occurrences WHERE receipt_id=$1 AND project_id=$2 AND state='accepted'`,
      [report.receiptId, report.projectId]);
    assert.deepEqual(checks, report.documents.map(({ versionId }) => versionId).sort());
  }
  for (const [branch, purposes] of [['a', ['primary_a', 'review']], ['b', ['primary_b', 'review']], ['lead', ['review']]]) {
    const id = 'managed-' + branch;
    const revision = 'package-intake-offline-1';
    await gateway.configureRoute({ id, revision, transport: 'managed', enabled: true, timeoutMs: 8_000,
      ceilingUsdNanos: 1, maxRequestBytes: 16 * 1024 * 1024 });
    for (const projectId of projects) for (const purpose of purposes) {
      await gateway.grantRoute({ projectId, routeId: id, revision, purpose, dataClass: 'synthetic', allowed: true });
    }
  }
  await new Promise((listen) => server.listen(0, '127.0.0.1', listen));
  process.env.FACADE_HARNESS_MANAGED_URL = 'http://127.0.0.1:' + server.address().port + '/managed';
  worker = startWorker({ db: app.db, config, logger: app.log, signal: controller.signal })
    .catch((error) => errors.push({ name: error.name }));
  const deadline = Date.now() + 360_000;
  let stable = 0;
  let lastExchangeCount = 0;
  while (Date.now() < deadline) {
    readings = await Promise.all([...projects].map(async (projectId) => ({
      projectId, ...(await readPackageAnalysis(app.db, projectId)),
    })));
    reviews = (await app.db.query(`SELECT review.project_id AS "projectId", review.id AS pair,
      lead.id AS "leadJob", lead.state AS "leadState", lead.reason AS "leadReason", lead.result AS "leadResult",
      a.id AS "aJob", a.state AS "aState", a.result AS "aResult", b.id AS "bJob", b.state AS "bState", b.result AS "bResult"
      FROM harness_package_review_pairs review
      JOIN gateway_jobs lead ON lead.id=review.lead_job_id
      LEFT JOIN gateway_jobs a ON a.id=review.a_job_id LEFT JOIN gateway_jobs b ON b.id=review.b_job_id
      ORDER BY review.id`)).rows;
    if (errors.length) break;
    const terminal = readings.every(({ windows, coverage }) => windows.length > 0 && coverage.pendingVersions === 0 &&
      windows.every(({ branches }) => Object.values(branches).every(({ status }) =>
        ['covered', 'refused', 'reviewed_no_match', 'held'].includes(status)))) &&
      reviews.every(({ leadState, aState, bState }) => [leadState, aState, bState].every((state) =>
        state === null || ['done', 'held'].includes(state)));
    stable = terminal && lastExchangeCount === calls.length ? stable + 1 : 0;
    if (stable === 6) break;
    lastExchangeCount = calls.length;
    await delay(500);
  }
  assert.deepEqual(errors, []);
  assert.equal(stable, 6, 'reading or review remained runnable or without a map at deadline');
  for (const reading of readings) {
    for (const fact of reading.facts) {
      const { source, runId, evidenceId } = fact.observation;
      const exchanges = [...previous, ...calls].filter(({ jobId, branch }) => jobId === runId && branch === fact.branch.toLowerCase());
      assert.ok(exchanges.some(({ assignedSource, submittedEvidenceId }) =>
        assignedSource.versionId === source.versionId && assignedSource.sha256 === source.sha256 && submittedEvidenceId === evidenceId),
      'published fact lacks a tool action from the same job, branch, and immutable source');
    }
  }
  const positiveCases = reports.filter(({ case: name }) => !name || ['review_control', 'letter_control'].includes(name));
  assert.ok(positiveCases.every(({ projectId }) =>
    new Set(readings.find((reading) => reading.projectId === projectId).facts.map(({ branch }) => branch)).size === 2),
    'both branches must independently publish an addressable fact in each positive case');
  for (const pair of reviews.filter(({ aResult, bResult }) => aResult?.verdict === 'supported' && bResult?.verdict === 'supported')) {
    assert.equal(new Set([pair.leadJob, pair.aJob, pair.bJob]).size, 3);
    for (const [jobId, mode] of [[pair.leadJob, 'lead'], [pair.aJob, 'verify'], [pair.bJob, 'verify']]) {
      const run = calls.filter((call) => call.jobId === jobId && call.reviewMode === mode);
      assert.ok(run.some(({ opened }) => new Set(opened.map(({ place }) => place.source.versionId)).size === 2));
    }
  }
  for (const { projectId, case: name } of reports.filter(({ case: name }) => name?.startsWith('review_'))) {
    const readout = readings.find((reading) => reading.projectId === projectId);
    const pairs = reviews.filter((review) => review.projectId === projectId);
    if (name === 'review_control') {
      assert.ok(readout.verifiedPairs.length > 0 && pairs.some(({ leadResult, aResult, bResult }) =>
        leadResult?.verifiedPair && aResult?.verdict === 'supported' && bResult?.verdict === 'supported'),
      'printed same-variant control did not complete with lead plus two independent verifications');
    } else {
      assert.deepEqual(readout.verifiedPairs, []);
      assert.deepEqual(pairs, [], 'comparison across different printed variants entered the review queue');
    }
  }
} finally {
  controller.abort();
  await worker?.catch((error) => errors.push({ name: error.name }));
  if (server.listening) await new Promise((closed) => server.close(closed));
  await serialized;
  const balance = await external.journal.balance();
  await writeFile(resolve(output, 'managed-machine.json'), JSON.stringify({
    input: 'ordinary intake; managed model transport; scored on a separate closed oracle',
    calls: calls.length, archivedCalls: previous.length, startingBalance, balance, errors, readings, reviews,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await app.close();
  await external.close();
  assert.deepEqual(balance, startingBalance, 'controlled transport changed the isolated financial balance');
}
