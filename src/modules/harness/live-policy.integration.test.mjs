import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';

const optIn = process.env.FACADE_HARNESS_LIVE_STUB_TEST === '1';
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const origin = 'http://127.0.0.1:3000';
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const fixture = {
  A: { routeId: 'fixture-kimi', model: 'moonshotai/kimi-fixture', provider: 'wafer/us', responseProvider: 'Wafer' },
  B: { routeId: 'fixture-qwen', model: 'qwen/qwen-fixture', provider: 'alibaba', responseProvider: 'Alibaba' },
};
const settings = ({ routeId, model }) => ({
  routeId, model, dataClass: 'synthetic', maxTokens: 512, maxTurns: 16, maxKnownRejections: 1,
});
const formatProfile = (source, authorized) => ({
  routeId: source.routeId, model: source.model, revision: 'local-test', provider: source.provider,
  expectedResponseProvider: source.responseProvider,
  mode: 'synthetic-research', zdrEvidenceRef: source === fixture.A ? 'fixture-zdr' : undefined,
  boundEvidenceRef: 'fixture-pricing', validUntil: '2099-01-01T00:00:00Z',
  inputTokenUpperBound: 10000, outputTokenLimit: 512,
  maxImages: 0, maxImagePixels: 0, maxImageWidth: 0, maxImageHeight: 0, maxImageBytes: 0,
  promptNanosPerToken: 0, completionNanosPerToken: 0, cacheReadNanosPerToken: 0, cacheWriteNanosPerToken: 0,
  reasoningNanosPerToken: 0, requestNanos: 0, imageNanos: 0, additionalNanos: 0,
  cacheBilling: 'replaces-input', reasoningBilling: 'replaces-output',
  completionCapIncludesReasoning: true, completionParameter: 'max_tokens', knownNoChargeStatuses: [429],
  syntheticScopes: [{ ...authorized, approvalRef: 'local-fixture' }],
});

async function until(read, done) {
  const deadline = Date.now() + 50_000;
  let current;
  do {
    current = await read();
    if (done(current)) return current;
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(JSON.stringify(current));
}

test('partial live configuration uses only independently admitted routes with the outbound fetch stubbed', {
  skip: !optIn, timeout: 210_000,
}, async (t) => {
  const priorEnv = { ...process.env };
  const priorFetch = globalThis.fetch;
  const ledgerPool = new pg.Pool({ connectionString: process.env.FACADE_GATEWAY_JOURNAL_URL });
  let app, worker, stop;
  t.after(async () => {
    stop?.abort();
    await worker;
    globalThis.fetch = priorFetch;
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(priorEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, priorEnv);
    await app?.close();
    await ledgerPool.end();
  });
  const { createApi } = await import('../../../dist/src/platform/api.js');
  const { readConfig } = await import('../../../dist/src/platform/config.js');
  const { bootstrapAdmin } = await import('../../../dist/src/modules/access/bootstrap.js');
  const { createGateway } = await import('../../../dist/src/modules/gateway/index.js');
  const { startWorker } = await import('../../../dist/src/modules/harness/index.js');
  await ledgerPool.query(await readFile(new URL('../gateway/journal.sql', import.meta.url), 'utf8'));
  await ledgerPool.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES($1)', [process.env.FACADE_GATEWAY_LEDGER_ID]);

  const config = readConfig();
  app = await createApi(config);
  const password = `fixture-${randomUUID()}-password`;
  await bootstrapAdmin(app.db, { organization: 'Harness admission fixture', login: 'partial', password });
  let credentials = {};
  async function http(method, url, payload, extra = {}, expected) {
    const response = await app.inject({ method, url, payload, headers: { origin, host: '127.0.0.1:3000',
      ...credentials, ...extra, 'idempotency-key': randomUUID() } });
    assert.ok(expected ? expected.includes(response.statusCode) : response.statusCode < 300,
      `${method} ${url}: ${response.statusCode} ${response.body}`);
    return response;
  }
  async function post(url, payload) { return (await http('POST', url, payload)).json(); }
  const login = await http('POST', '/api/sessions', { login: 'partial', password });
  credentials = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrfToken };
  const catalog = await post('/api/catalogs', {
    key: 'fixture-thickness', name: 'Fixture',
    requirements: [{ key: 'thickness', part: 'Thickness', formats: ['txt'], equivalents: [], applicability: 'all',
      sourceRoles: ['design'], completenessCriterion: 'Addressed value', addressee: 'customer' }],
  });
  const gateway = createGateway(app.db);
  for (const { routeId } of Object.values(fixture)) {
    await gateway.configureRoute({
      id: routeId, revision: 'local-test', transport: 'openrouter', enabled: true,
      maxRequestBytes: 2 * 1024 * 1024, ceilingUsdNanos: 1, timeoutMs: 8000,
    });
  }
  async function grant(projectId, branch, allowed) {
    await gateway.grantRoute({ projectId, routeId: fixture[branch].routeId, revision: 'local-test',
      dataClass: 'synthetic', purpose: branch === 'A' ? 'primary_a' : 'primary_b', allowed });
  }

  const calls = [];
  const errors = [];
  const warnings = [];
  let revoke;
  globalThis.fetch = async (url, options) => {
    try {
      assert.equal(String(url), endpoint);
      const input = JSON.parse(options.body);
      const branch = input.model === fixture.A.model ? 'A' : 'B';
      const selected = fixture[branch];
      assert.equal(input.model, selected.model);
      assert.deepEqual(input.provider.only, [selected.provider]);
      assert.equal(input.provider.allow_fallbacks, false);
      assert.equal(input.provider.zdr, branch === 'A');
      const assignment = JSON.parse(input.messages[1].content);
      const projectId = assignment.place.source.projectId;
      calls.push({ projectId, branch });
      const outputs = input.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
      if (revoke?.projectId === projectId && revoke.branch === branch && outputs.length === 0) {
        await grant(projectId, branch, false);
      }
      let name = 'extract';
      let args = {};
      if (outputs.length === 1) {
        const source = outputs[0];
        const line = JSON.parse(source.content).lines[0];
        name = 'save_observation';
        args = { evidenceId: source.evidence.evidenceId, lineId: line.id, quote: line.text,
          value: /[23]/.exec(line.text)[0], unit: 'mm', sourceRole: 'design' };
      } else if (outputs.length === 2) {
        assert.ok(outputs[1].observationId);
        name = 'finish_reading';
        args = { status: 'covered', explanation: 'Checked a synthetic line.' };
      }
      return Response.json({ id: `gen-${randomUUID()}`, model: selected.model, provider: selected.responseProvider,
        usage: { cost: 0 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    } catch (error) {
      errors.push(error.message);
      throw error;
    }
  };

  // The fixture has two named local databases. The live code and outbound route are under test;
  // physical failure-domain separation is outside this in-process transport test.
  const journalUrl = new URL(process.env.FACADE_GATEWAY_JOURNAL_URL);
  const appUrl = new URL(process.env.DATABASE_URL);
  assert.notEqual(journalUrl.pathname, appUrl.pathname);
  if (journalUrl.host === appUrl.host) journalUrl.hostname = appUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  process.env.FACADE_GATEWAY_JOURNAL_URL = journalUrl.href;
  process.env.FACADE_GATEWAY_LIVE_MODE = 'step-15';
  process.env.FACADE_HARNESS_LIVE_POLICY = 'synthetic-research';
  process.env.FACADE_GATEWAY_OPENROUTER_KEY = 'local-fixture-key';
  delete process.env.FACADE_HARNESS_MANAGED_URL;
  delete process.env.FACADE_GATEWAY_OPENROUTER_ENDPOINT;

  async function runCase(testCase) {
    const project = await post('/api/projects', { name: testCase.name, catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P' });
    const scopeId = project.scopes[0].id;
    const files = testCase.dispute ? ['Thickness 2 mm', 'Thickness 3 mm'] : ['Thickness 2 mm'];
    const authorized = { projectId: project.id, scopeId, originalSha256s: files.map(checksum) };
    const approvals = testCase.approvals.map((branch) => formatProfile(fixture[branch], authorized));
    for (const branch of ['A', 'B']) await grant(project.id, branch, true);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({
      A: settings(fixture.A), B: settings(fixture.B),
      ...(testCase.settings ?? {}),
    });
    process.env.FACADE_GATEWAY_STEP15_PROFILES = JSON.stringify([
      ...approvals,
      ...(testCase.malformed ? [{ ...formatProfile(fixture[testCase.malformed], authorized), promptNanosPerToken: 'broken' }] : []),
    ]);
    revoke = testCase.revoke ? { projectId: project.id, branch: testCase.revoke } : undefined;
    const receipt = await post(`/api/projects/${project.id}/receipts`, {});
    for (const [index, content] of files.entries()) {
      const bytes = Buffer.from(content);
      const upload = await post(`/api/receipts/${receipt.receiptId}/uploads`, {
        relativePath: `drawing-${index}.txt`, size: bytes.length, sha256: checksum(bytes),
        mediaType: 'text/plain', scopeIds: [scopeId],
      });
      await http('PUT', `/api/uploads/${upload.uploadId}/parts/1`, bytes, {
        'content-type': 'application/octet-stream', 'x-part-sha256': checksum(bytes), 'content-length': String(bytes.length),
      });
      await post(`/api/uploads/${upload.uploadId}/complete`, {});
    }
    await post(`/api/receipts/${receipt.receiptId}/seal`, {});
    stop = new AbortController();
    worker = startWorker({ db: app.db, config, signal: stop.signal, logger: {
      info() {}, warn(message) { warnings.push(message); }, error(message) { warnings.push(message); },
    } });
    const rows = await until(async () => (await app.db.query(
      'SELECT purpose,state,reason FROM gateway_jobs WHERE project_id=$1 ORDER BY purpose', [project.id])).rows,
    (rows) => rows.length === testCase.expected.length && rows.every(({ state }) => ['done', 'held'].includes(state)));
    assert.deepEqual(rows.map(({ purpose, state, reason }) => [purpose, state, reason]), testCase.expected);
    const obligations = (await app.db.query(
      `SELECT p.branch,p.state FROM gateway_primary p JOIN gateway_generations g USING(generation_id)
       WHERE g.project_id=$1 AND g.current ORDER BY p.branch,p.state`, [project.id])).rows;
    assert.deepEqual(obligations.map(({ branch, state }) => [branch, state]), testCase.expected
      .filter(([purpose]) => purpose !== 'review')
      .map(([purpose, state]) => [purpose.endsWith('_a') ? 'A' : 'B', state === 'done' ? 'completed' : 'pending']));
    assert.deepEqual(calls.filter(({ projectId }) => project.id === projectId).map(({ branch }) => branch).sort(), testCase.calls);
    const response = (await http('GET', `/api/projects/${project.id}/assessments/current?scopeId=${scopeId}`)).json();
    assert.equal(response.questions[0].machine.outcome, 'needs_review');
    if (testCase.dispute) {
      const [question] = response.questions;
      assert.ok(question.machine.limitations.includes('dispute_pending'));
      await http('POST', `/api/questions/${question.id}/decisions`, {
        action: 'confirm', requestExternal: true, reason: 'Attempt to confirm an unverified disagreement.',
      }, { 'if-match': `"${question.version}"` }, [409, 422]);
    }
    const eligible = (await http('GET', `/api/projects/${project.id}/letters/eligible?scopeId=${scopeId}`)).json();
    assert.deepEqual(eligible.items, []);
    await http('POST', `/api/projects/${project.id}/letters`, { scopeId, recipient: 'customer', items: [] }, {}, [409, 422]);
    stop.abort();
    await worker;
    worker = undefined;

    if (testCase.recoverA) {
      process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: settings(fixture.A), B: settings(fixture.B) });
      process.env.FACADE_GATEWAY_STEP15_PROFILES = JSON.stringify([
        formatProfile(fixture.A, authorized), formatProfile(fixture.B, authorized),
      ]);
      stop = new AbortController();
      worker = startWorker({ db: app.db, config, signal: stop.signal, logger: {
        info() {}, warn(message) { warnings.push(message); }, error(message) { warnings.push(message); },
      } });
      await until(async () => (await app.db.query(
        'SELECT state FROM gateway_jobs WHERE project_id=$1', [project.id])).rows,
      (items) => items.length === 2 && items.every(({ state }) => state === 'done'));
      const { rows: [binding] } = await app.db.query(
        `SELECT j.payload->'settings' AS original,b.settings FROM gateway_jobs j
         JOIN harness_route_bindings b ON b.job_id=j.id WHERE j.project_id=$1 AND j.purpose='primary_a'`, [project.id]);
      assert.equal(binding.original, null);
      assert.deepEqual(binding.settings, settings(fixture.A));
      assert.equal(calls.filter(({ projectId, branch }) => projectId === project.id && branch === 'A').length, 3);
      stop.abort();
      await worker;
      worker = undefined;
    }
  }
  const done = (branch) => [`primary_${branch}`, 'done', null];
  const held = (branch, reason) => [`primary_${branch}`, 'held', reason];
  await runCase({ name: 'Only A', approvals: ['A'], malformed: 'B', calls: ['A', 'A', 'A'],
    expected: [done('a'), held('b', 'research_route_not_approved')] });
  await runCase({ name: 'Only B', approvals: ['B'], recoverA: true, settings: { A: { routeId: 'broken' } }, calls: ['B', 'B', 'B'],
    expected: [held('a', 'research_profile_unavailable'), done('b')] });
  await runCase({ name: 'No routes', approvals: [], calls: [],
    expected: [held('a', 'research_route_not_approved'), held('b', 'research_route_not_approved')] });
  await runCase({ name: 'Revoke A', approvals: ['A', 'B'], revoke: 'A', calls: ['A', 'B', 'B', 'B'],
    expected: [held('a', 'route_denied'), done('b')] });
  await runCase({ name: 'Leader unavailable', approvals: ['A', 'B'], dispute: true,
    calls: [...Array(6).fill('A'), ...Array(6).fill('B')],
    expected: [done('a'), done('a'), done('b'), done('b'), ['review', 'held', 'research_profile_unavailable']] });
  const { rows: [ledger] } = await ledgerPool.query(
    `SELECT count(*) FILTER(WHERE state IN ('prepared','sending','unknown'))::int AS open,
            coalesce(sum(spent_usd_nanos),0)::text AS spent FROM gateway_external_attempts`);
  assert.deepEqual(ledger, { open: 0, spent: '0' });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
