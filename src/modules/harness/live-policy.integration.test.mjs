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
const directEndpoint = 'https://api.cheaperinference.com/v1/chat/completions';
const directKey = 'ci_' + 'live_' + 'local_fixture';
const featherlessEndpoint = 'https://api.featherless.ai/v1/chat/completions';
const featherlessKey = 'featherless-test-fixture';
const fixture = {
  A: { routeId: 'fixture-kimi', model: 'moonshotai/kimi-fixture', provider: 'wafer/us', responseProvider: 'Wafer' },
  B: { routeId: 'fixture-qwen', model: 'qwen/qwen-fixture', provider: 'alibaba', responseProvider: 'Alibaba' },
};
const wafer = { ...fixture.A, model: 'moonshotai/kimi-k3.1-pro', routeId: 'fixture-wafer-comparison', toolChoice: 'auto' };
const decart = { ...wafer, routeId: 'fixture-decart-comparison', provider: 'decart/mxfp4', responseProvider: 'Decart' };
const lead = { ...wafer, routeId: 'fixture-lead', toolChoice: 'required' };
const readers = ['A', 'B'];
const settings = ({ routeId, model, toolChoice }) => ({
  routeId, model, dataClass: 'synthetic', maxTokens: 512, maxTurns: 16, maxKnownRejections: 1,
  ...(toolChoice && { toolChoice }),
});
const formatProfile = (source, authorized) => ({
  routeId: source.routeId, model: source.model, revision: 'local-test', provider: source.provider,
  expectedResponseProvider: source.responseProvider,
  mode: 'synthetic-research', zdrEvidenceRef: source.model.startsWith('qwen/') ? undefined : 'fixture-zdr-wafer-r1',
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
  skip: !optIn, timeout: 480_000,
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
  const { createGateway, Gateway, PostgresIntentJournal } = await import('../../../dist/src/modules/gateway/index.js');
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
      sourceRoles: ['design', 'specification'], completenessCriterion: 'Addressed value', addressee: 'customer' }],
  });
  const gateway = createGateway(app.db);
  for (const { routeId } of [...Object.values(fixture), wafer, decart, lead]) {
    await gateway.configureRoute({
      id: routeId, revision: 'local-test', transport: 'openrouter', enabled: true,
      maxRequestBytes: 2 * 1024 * 1024, ceilingUsdNanos: 1, timeoutMs: 8000,
    });
  }
  const { loadResearchProfile } = await import('../../../dist/src/modules/harness/profile.js');
  const defaults = loadResearchProfile({});
  const terra = { ...defaults.A, direct: true };
  const defaultQwen = { ...fixture.B, ...defaults.B };
  const visualQwen = { ...defaults.B, routeId: 'fixture-featherless-qwen38-27b', model: 'Qwen/Qwen3.8-27B', toolChoice: 'required', featherless: true };
  for (const [cfg, transport, ceilingUsdNanos] of [[terra, 'cheaperinference', 3_000_000_000], [defaultQwen, 'openrouter', 2_000_000_000], [visualQwen, 'featherless', 2_000_000_000]]) {
    await gateway.configureRoute({
      id: cfg.routeId, revision: 'local-test', transport, enabled: true,
      maxRequestBytes: 2 * 1024 * 1024, ceilingUsdNanos, timeoutMs: 8000,
    });
  }
  let selectedA = fixture.A;
  let selectedB = fixture.B;
  async function grant(projectId, branch, allowed) {
    await gateway.grantRoute({ projectId, routeId: (branch === 'A' ? selectedA : selectedB).routeId, revision: 'local-test',
      dataClass: 'synthetic', purpose: branch === 'A' ? 'primary_a' : 'primary_b', allowed });
  }

  const calls = [];
  const errors = [];
  const warnings = [];
  const unsolicitedClaim = JSON.stringify({ lastToolCall: 'finish_reading', claim: 'Thickness 999 mm' });
  const compoundTexts = ['Valve RY-804 Thickness 2 mm variant P', 'Record RY-804 revision G7'];
  const compoundHashes = compoundTexts.map(checksum);
  let compoundProject;
  let revoke;
  let activeCase;
  globalThis.fetch = async (url, options) => {
    try {
      const input = JSON.parse(options.body);
      const assignment = JSON.parse(input.messages[1].content);
      const branch = assignment.mode === 'lead' ? 'lead' : input.model === selectedB.model ? 'B' : 'A';
      const selected = branch === 'lead' ? lead : branch === 'A' ? selectedA : selectedB;
      const role = assignment.mode === 'verify' ? `verify-${branch}` : branch;
      assert.equal(input.model, selected.model);
      assert.equal(options.redirect, 'error');
      if (selected.direct) {
        assert.equal(String(url), directEndpoint);
        assert.equal(options.headers.authorization, 'Bearer ' + directKey);
        assert.equal(options.headers['x-ci-model-lock'], '1');
        assert.equal(input.zdr, true);
        assert.equal(input.max_tokens, defaults.A.maxTokens);
        assert.equal(input.provider, undefined);
      } else if (selected.featherless) {
        assert.equal(String(url), featherlessEndpoint);
        assert.equal(options.headers.authorization, 'Bearer ' + featherlessKey);
        assert.equal(input.provider, undefined);
        assert.equal(input.max_tokens, activeCase.review ? 512 : defaults.B.maxTokens);
      } else {
        assert.equal(String(url), endpoint);
        assert.equal(options.headers.authorization, 'Bearer local-fixture-key');
        assert.deepEqual(input.provider.only, [selected.provider]);
        assert.deepEqual(input.provider.order, [selected.provider]);
        assert.equal(input.provider.allow_fallbacks, false);
        assert.equal(input.provider.require_parameters, true);
        assert.equal(input.provider.data_collection, 'deny');
        assert.equal(input.provider.zdr, branch !== 'B');
      }
      if (selected.featherless) {
        assert.equal(input.tools, undefined);
        assert.equal(input.tool_choice, undefined);
        assert.match(input.messages[0].content, /Available tools:/);
      } else {
        assert.equal(input.tool_choice, selected.toolChoice ?? 'required');
      }
      const projectId = (assignment.place ?? assignment.dispute.a.place).source.projectId;
      const image = input.messages.flatMap(({ content }) => Array.isArray(content) ? content : [])
        .find(({ type }) => type === 'image_url');
      calls.push({ projectId, branch, role, image: Boolean(image) });
      if (role === 'lead' && activeCase.unavailableLead) {
        return Response.json({ error: { code: 404, metadata: { error_type: 'not_found' } },
          openrouter_metadata: { attempt: 0 } }, { status: 404 });
      }
      const outputs = selected.featherless
        ? input.messages.filter(({ role, content }) => role === 'user' && typeof content === 'string' && content.startsWith('Local tool result for '))
          .map(({ content }) => JSON.parse(content.slice(content.indexOf('\n') + 1)))
        : input.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
      if (revoke?.projectId === projectId && revoke.branch === branch && outputs.length === 0) {
        await grant(projectId, branch, false);
      }
      const receipt = selected.direct ? {
        request_id: randomUUID(), model: selected.model,
        usage: { prompt_tokens: 1024, completion_tokens: 128 },
        billing: { status: 'settled', currency: 'USD', billed_cost_usd: '0.000000' },
      } : { id: `gen-${randomUUID()}`, model: selected.model, provider: selected.responseProvider, usage: { cost: 0, prompt_tokens: 1024, completion_tokens: 128 } };
      if (selected.toolChoice === 'auto' && !selected.featherless && input.messages.length === 2) {
        return Response.json({ ...receipt, choices: [{ finish_reason: 'stop',
          message: { role: 'assistant', content: unsolicitedClaim } }] });
      }
      if (selected.toolChoice === 'auto' && !selected.featherless && outputs.length === 0) {
        assert.equal(input.messages.at(-2)?.content, unsolicitedClaim);
        assert.match(input.messages.at(-1)?.content, /Продолжите с помощью доступных инструментов/);
      }
      let name = 'extract';
      let args = {};
      if (assignment.mode !== 'primary') {
        if (outputs.length < 2) {
          args = { support: readers[outputs.length] };
        } else {
          const sources = outputs.map(({ content, evidence }) => ({
            evidenceId: evidence.evidenceId,
            quote: JSON.parse(content).lines[0].text,
          }));
          const check = { status: 'confirmed', reason: 'The fixture identifies the same scope and variant.', sources };
          if (role === 'lead' && activeCase.revokeReview) {
            await grantReview(projectId, activeCase.revokeReview, false);
          }
          name = role === 'lead' ? 'propose_resolution' : 'verify_resolution';
          args = {
            ...(role === 'lead'
              ? { aObservationId: assignment.dispute.a.observationId, bObservationId: assignment.dispute.b.observationId }
              : { verdict: 'supported' }),
            explanation: 'Both original lines were checked.',
            evidenceIds: sources.map(({ evidenceId }) => evidenceId),
            checks: { variant: check, revision: check, applicability: check, comparability: check },
          };
        }
      } else if (activeCase.visual) {
        if (!outputs.length) name = 'survey';
        else {
          assert.ok(image);
          assert.equal(checksum(Buffer.from(image.image_url.url.split(',')[1], 'base64')), outputs[0].evidence.sha256);
          name = 'finish_reading';
          args = { status: 'no_match', explanation: 'The synthetic page has no matching text.' };
        }
      } else if (projectId === compoundProject) {
        if (assignment.place.source.sha256 === compoundHashes[1]) {
          if (outputs.length) {
            name = 'finish_reading'; args = { status: 'no_match', explanation: 'Revision record carries no measurement.' };
          }
        } else if (outputs.length) {
          const first = outputs[0];
          const own = JSON.parse(first.content).lines[0];
          if (outputs.length <= 2) {
            name = 'save_observation';
            args = { evidenceId: first.evidence.evidenceId, quote: own.text, lineId: own.id, value: '2', sourceRole: 'design' };
          } else if (outputs.length === 3) {
            assert.equal(outputs[2].code, 'repeated_rejected_action');
            name = 'context_inventory';
          } else if (outputs.length === 4) {
            name = 'open_context';
            args = { contextId: outputs[3].items.find(({ place }) => place.source.sha256 === compoundHashes[1]).id };
          } else if (outputs.length === 5) {
            const extra = outputs[4];
            const external = JSON.parse(extra.content).lines[0];
            const component = (evidenceId, line, role, literal, link) =>
              ({ evidenceId, lineId: line.id, quote: line.text, role, literal, link });
            const local = (role, literal, link) => component(first.evidence.evidenceId, own, role, literal, link);
            const other = (role, literal, link) => component(extra.evidence.evidenceId, external, role, literal, link);
            name = 'save_compound_observation';
            args = { sourceRole: 'specification', components: [local('value', '2', { kind: 'anchor' }),
              local('unit', 'mm', { kind: 'source_context', to: 0 }), local('variant', 'P', { kind: 'source_context', to: 0 }),
              local('identifier', 'RY-804', { kind: 'source_context', to: 0 }),
              other('identifier', 'RY-804', { kind: 'shared_identifier', to: 3 }),
              other('revision', 'G7', { kind: 'source_context', to: 4 })] };
          } else {
            assert.ok(outputs[5].observationId, JSON.stringify(outputs.at(-1)));
            name = 'finish_reading'; args = { status: 'covered', explanation: 'Anchors confirmed.' };
          }
        }
      } else if (outputs.length === 1) {
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
      if (selected.featherless) {
        return Response.json({ ...receipt, choices: [{ finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ name, arguments: args }) } }] });
      }
      return Response.json({ ...receipt, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
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

  async function grantReview(projectId, slot, allowed) {
    const route = { A: selectedA, B: selectedB, lead }[slot];
    await gateway.grantRoute({ projectId, routeId: route.routeId, revision: 'local-test',
      dataClass: 'synthetic', purpose: 'review', allowed });
  }

  async function runCase(testCase) {
    activeCase = testCase;
    const strict = testCase.customer || testCase.extraOriginal;
    process.env.FACADE_HARNESS_LIVE_POLICY = strict ? 'strict-zdr' : 'synthetic-research';
    selectedA = testCase.mixed || testCase.review ? terra : testCase.comparison ?? fixture.A;
    selectedB = testCase.review ? visualQwen : testCase.mixed ? defaultQwen : fixture.B;
    const sources = { A: selectedA, B: selectedB };
    const project = await post('/api/projects', { name: testCase.name, catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P' });
    const scopeId = project.scopes[0].id;
    const files = testCase.visual
      ? [await readFile(new URL('../../../test/fixtures/input/facade-supplement.pdf', import.meta.url))]
      : testCase.compound ? compoundTexts
      : testCase.review ? ['Current Revision R1 | Scope: F-A | Variant A | Thickness 2 mm',
        'Current Revision R1 | Scope: F-A | Variant A | Thickness 3 mm']
      : testCase.dispute || testCase.extraOriginal ? ['Thickness 2 mm', 'Thickness 3 mm'] : ['Thickness 2 mm'];
    if (testCase.compound) compoundProject = project.id;
    const authorized = { projectId: project.id, scopeId, originalSha256s: (testCase.extraOriginal ? files.slice(0, 1) : files).map(checksum) };
    const approvals = testCase.approvals.filter(branch => !sources[branch].direct && !sources[branch].featherless).map(branch => {
      const source = sources[branch];
      const profile = formatProfile(source, {
        ...authorized, ...(testCase.wrongScope === branch && { scopeId: randomUUID() }),
      });
      if (strict) return { ...profile, mode: 'strict-zdr' };
      if (testCase.mixed && branch === 'B') return { ...profile, outputTokenLimit: defaults.B.maxTokens,
        syntheticScopes: profile.syntheticScopes.map(scope => ({ ...scope, retentionApproval: {
          approvalRef: 'fixture-retention', noTrainingEvidenceRef: 'fixture-no-training', validUntil: '2099-01-01T00:00:00Z',
        } })),
      };
      if (testCase.visual && branch === 'A') return { ...profile,
        maxImages: 1, maxImagePixels: 16_000_000, maxImageWidth: 4_000, maxImageHeight: 4_000, maxImageBytes: 1_000_000 };
      return profile;
    });
    for (const branch of readers) await grant(project.id, branch, true);
    if (testCase.customer) {
      await gateway.grantRoute({ projectId: project.id, routeId: selectedA.routeId, revision: 'local-test',
        dataClass: 'customer', purpose: 'primary_a', allowed: true });
    }
    if (testCase.review) {
      approvals.push({ ...formatProfile(lead, {
        ...authorized, ...(testCase.wrongScope === 'lead' && { scopeId: randomUUID() }),
      }), mode: 'strict-zdr', zdrEvidenceRef: 'fixture-zdr-wafer-r1', knownNoChargeStatuses: [404, 429] });
      for (const slot of [...readers, 'lead']) await grantReview(project.id, slot, true);
    }
    if (testCase.mixed || testCase.review) {
      if (testCase.review) {
        process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: defaults.A, B: settings(visualQwen), lead: settings(lead) });
      } else {
        delete process.env.FACADE_HARNESS_PROFILE;
      }
      process.env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY = directKey;
      process.env.FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES = JSON.stringify([{
        transport: 'cheaperinference', routeId: terra.routeId, model: terra.model,
        revision: 'local-test', mode: 'strict-zdr', zdrEvidenceRef: 'fixture-zdr-terra-r1',
        boundEvidenceRef: 'fixture-rates', validUntil: '2099-01-01T00:00:00Z',
        syntheticScopes: [{...authorized, approvalRef: 'fixture'}],
        inputNanosPerToken: 2500, outputNanosPerToken: 7500, outputTokenLimit: defaults.A.maxTokens,
        maxImages: 0, maxImageWidth: 1, maxImageHeight: 1, maxImagePixels: 1, maxImageBytes: 1,
      }]);
      if (testCase.review) {
        process.env.FACADE_GATEWAY_FEATHERLESS_KEY = featherlessKey;
        process.env.FACADE_GATEWAY_FEATHERLESS_PROFILES = JSON.stringify([{
          transport: 'featherless', routeId: selectedB.routeId, model: selectedB.model,
          revision: 'local-test', mode: 'synthetic-research', contextTokens: 262_144,
          boundEvidenceRef: 'fixture-featherless-rates', validUntil: '2099-01-01T00:00:00Z',
          syntheticScopes: [{ ...authorized, approvalRef: 'fixture' }],
          inputNanosPerToken: 400, outputNanosPerToken: 3000,
          outputTokenLimit: 512,
        }]);
      } else {
        delete process.env.FACADE_GATEWAY_FEATHERLESS_KEY;
        delete process.env.FACADE_GATEWAY_FEATHERLESS_PROFILES;
      }
    } else {
      delete process.env.FACADE_GATEWAY_FEATHERLESS_KEY;
      delete process.env.FACADE_GATEWAY_FEATHERLESS_PROFILES;
      delete process.env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY;
      delete process.env.FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES;
      process.env.FACADE_HARNESS_PROFILE = JSON.stringify({
        A: settings(sources.A), B: settings(sources.B), ...(testCase.settings ?? {}),
      });
    }
    process.env.FACADE_GATEWAY_STEP15_PROFILES = JSON.stringify([
      ...approvals,
      ...(testCase.malformed ? [{ ...formatProfile(fixture[testCase.malformed], authorized), promptNanosPerToken: 'broken' }] : []),
    ]);
    revoke = testCase.revoke ? { projectId: project.id, branch: testCase.revoke } : undefined;
    const receipt = await post(`/api/projects/${project.id}/receipts`, {});
    for (const [index, content] of files.entries()) {
      const bytes = Buffer.from(content);
      const upload = await post(`/api/receipts/${receipt.receiptId}/uploads`, {
        relativePath: `drawing-${index}.${testCase.visual ? 'pdf' : 'txt'}`, size: bytes.length, sha256: checksum(bytes),
        mediaType: testCase.visual ? 'application/pdf' : 'text/plain', scopeIds: [scopeId],
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
      `SELECT purpose,state,reason,payload->>'mode' AS mode,payload->>'branch' AS branch
       FROM gateway_jobs WHERE project_id=$1 ORDER BY purpose,mode,branch,state,reason`, [project.id])).rows,
    (rows) => rows.length === testCase.expected.length && rows.every(({ state }) => ['done', 'held'].includes(state)));
    assert.deepEqual(rows.map(({ purpose, mode, branch, state, reason }) =>
      [testCase.review && purpose === 'review' ? (branch ? `verify-${branch}` : mode) : purpose, state, reason]), testCase.expected);
    const obligations = (await app.db.query(
      `SELECT p.branch,p.state FROM gateway_primary p JOIN gateway_generations g USING(generation_id)
       WHERE g.project_id=$1 AND g.current ORDER BY p.branch,p.state`, [project.id])).rows;
    assert.deepEqual(obligations.map(({ branch, state }) => [branch, state]), testCase.expected
      .filter(([purpose]) => purpose.startsWith('primary_'))
      .map(([purpose, state]) => [purpose.endsWith('_a') ? 'A' : 'B', state === 'done' ? 'completed' : 'pending']));
    const projectCalls = calls.filter(({ projectId }) => project.id === projectId);
    assert.deepEqual(projectCalls.map(({ role }) => role).sort(), testCase.calls);
    if (testCase.visual) {
      assert.deepEqual(projectCalls.filter(({ image }) => image).map(({ role }) => role), ['A']);
    }
    if (testCase.review) {
      const { rows: receipts } = await app.db.query(
        `SELECT DISTINCT j.payload->>'mode' AS mode, j.payload->>'branch' AS step, a.route_id, a.revision AS route_revision,
         a.receipt->>'model' AS model, a.receipt->>'provider' AS provider
         FROM gateway_attempts a JOIN gateway_jobs j ON j.id=a.job_id
         WHERE a.project_id=$1 AND j.purpose='review' AND a.state='paid' ORDER BY mode,step`, [project.id]);
      const expected = [
        { mode: 'lead', step: null, route_id: lead.routeId, route_revision: 'local-test', model: lead.model, provider: 'Wafer' },
        { mode: 'verify', step: 'A', route_id: terra.routeId, route_revision: 'local-test', model: terra.model, provider: 'CheaperInference' },
        { mode: 'verify', step: 'B', route_id: selectedB.routeId, route_revision: 'local-test', model: selectedB.model, provider: 'Featherless' },
      ].filter(({ mode, step }) => testCase.calls.includes(step ? `verify-${step}` : mode)
        && !(mode === 'lead' && testCase.unavailableLead));
      assert.deepEqual(receipts, expected);
    }
    if (testCase.review || testCase.visual || strict || testCase.wrongScope || testCase.revoke) {
      const { rows: attempts } = await app.db.query(
        `SELECT j.payload->>'mode' AS mode, j.payload->>'branch' AS branch, a.route_id, a.revision AS route_revision, a.state,
            a.receipt->>'model' AS model, a.receipt->>'provider' AS provider, count(*)::int AS count
         FROM gateway_attempts a JOIN gateway_jobs j ON j.id=a.job_id
         WHERE a.project_id=$1 GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,5`, [project.id]);
      const profileEvidence = [...approvals];
      if (testCase.review) profileEvidence.push(...JSON.parse(process.env.FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES),
        ...JSON.parse(process.env.FACADE_GATEWAY_FEATHERLESS_PROFILES));
      t.diagnostic(JSON.stringify({ scenario: testCase.name, projectId: project.id, scopeId, rows, attempts,
        profiles: profileEvidence.map(({ routeId, model, revision, mode, provider, zdrEvidenceRef, maxImages, syntheticScopes }) =>
          ({ routeId, model, revision, mode, provider, zdrEvidenceRef, maxImages, syntheticScopes })),
        posts: projectCalls.map(({ role, image }) => ({ role, modality: image ? 'png' : 'text' })),
      }));
    }
    if (testCase.mixed) {
      const { rows: bindings } = await app.db.query(
        `SELECT j.purpose, coalesce(nullif(j.payload->'settings','null'::jsonb),b.settings) AS settings
         FROM gateway_jobs j LEFT JOIN harness_route_bindings b ON b.job_id=j.id
         WHERE j.project_id=$1 ORDER BY j.purpose`, [project.id]);
      assert.deepEqual(bindings, [{ purpose: 'primary_a', settings: defaults.A }, { purpose: 'primary_b', settings: defaults.B }]);
      const { rows: receipts } = await app.db.query(
        `SELECT DISTINCT purpose, receipt->>'provider' AS provider, receipt->>'model' AS model
         FROM gateway_attempts WHERE project_id=$1 AND state='paid' ORDER BY purpose`, [project.id]);
      assert.deepEqual(receipts, [
        { purpose: 'primary_a', model: terra.model, provider: 'CheaperInference' },
        { purpose: 'primary_b', model: defaultQwen.model, provider: 'Alibaba' },
      ]);
    }
    if (testCase.comparison) {
      const { rows: trail } = await app.db.query(
        `SELECT e.event FROM harness_research_events e JOIN gateway_jobs j ON j.id=e.job_id
         WHERE j.project_id=$1 AND j.purpose='primary_a' ORDER BY e.sequence`, [project.id]);
      const events = trail.map(({ event }) => event);
      assert.deepEqual(events.map(({ kind }) => kind), ['model', 'model', 'intent', 'tool', 'model', 'intent', 'tool', 'model', 'intent', 'tool']);
      assert.equal(events[0].message.content, unsolicitedClaim);
      assert.equal(events[0].message.tool_calls, undefined);
      for (const i of [1, 4, 7]) assert.equal(events[i].message.tool_calls[0].id, events[i+1].callId);
      assert.deepEqual(events.slice(1).filter(({ kind }) => kind === 'model')
        .map(({ message }) => message.tool_calls[0].function.name), ['extract', 'save_observation', 'finish_reading']);
      const { rows: observations } = await app.db.query(
        'SELECT id,evidence_id,branch FROM reader_observations WHERE project_id=$1', [project.id]);
      const observationId = events[6].reply.body.observationId;
      const evidenceId = events[3].reply.evidence.evidenceId;
      assert.deepEqual(observations, [{ id: observationId, evidence_id: evidenceId, branch: 'A' }]);
      const claim = (await http('GET', `/api/v1/observations/${observationId}`)).json();
      assert.equal(claim.quote, 'Thickness 2 mm');
      assert.equal(claim.evidenceHref, `/api/v1/evidence/${evidenceId}`);
      const evidence = (await http('GET', `${claim.evidenceHref}/content`)).json();
      assert.ok(evidence.lines.some(({ text }) => text === claim.quote));
    }
    const response = (await http('GET', `/api/projects/${project.id}/assessments/current?scopeId=${scopeId}`)).json();
    if (!testCase.review && !testCase.visual) {
      assert.equal(response.questions[0].machine.outcome, testCase.mixed ? 'covered' : 'needs_review');
    }
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

    if (testCase.compound) {
      const path = `/api/projects/${project.id}/research-stops`;
      const { items: [stopped] } = (await http('GET', `${path}?scopeId=${scopeId}`)).json();
      assert.equal(stopped.reason, 'repeated_rejected_action');
      assert.equal(stopped.status, 'held');
      assert.equal(stopped.lastRequest.tool, 'save_observation');
      assert.ok(stopped.evidence[0].href);
      const observationRows = () => app.db.query('SELECT id FROM reader_observations WHERE project_id=$1', [project.id]);
      assert.equal((await observationRows()).rowCount, 0);
      await http('POST', `/api/projects/${randomUUID()}/research-stops/${stopped.id}/resume`, {}, {}, [404]);
      stop = new AbortController();
      worker = startWorker({ db: app.db, config, signal: stop.signal, logger: {
        info() {}, warn(message) { warnings.push(message); }, error(message) { warnings.push(message); },
      } });
      await delay(1000);
      assert.equal(calls.filter(({ projectId }) => projectId === project.id).length, testCase.calls.length);
      await post(`${path}/${stopped.id}/resume`, {});
      await until(async () => (await app.db.query('SELECT state FROM gateway_jobs WHERE id=$1', [stopped.jobId])).rows[0]?.state,
        (state) => state === 'done');
      assert.equal(calls.filter(({ projectId }) => projectId === project.id).length, testCase.calls.length + 4);
      const { rows: [saved], rowCount } = await observationRows();
      assert.equal(rowCount, 1);
      const observation = (await http('GET', `/api/v1/observations/${saved.id}`)).json();
      assert.deepEqual(observation.components.map(({ role }) => role), ['value', 'unit', 'variant', 'identifier', 'identifier', 'revision']);
      assert.equal(new Set(observation.components.map(({ evidenceId }) => evidenceId)).size, 2);
      for (const part of observation.components) {
        const representation = (await http('GET', `${part.evidenceHref}/content`)).json();
        assert.ok(representation.lines.some(({ id, text }) => id === part.lineId && text.includes(part.quote)));
      }
      const { rows: [finding] } = await app.db.query('SELECT finding FROM harness_observations WHERE observation_id=$1', [saved.id]);
      assert.deepEqual(finding.finding.citation.components, observation.components);
      assert.equal(finding.finding.sourceRole, 'specification');
      assert.ok(!finding.finding.comparisonKey.includes('specification'));
      const { items: [continued] } = (await http('GET', `${path}?scopeId=${scopeId}`)).json();
      assert.equal(continued.status, 'continued');
      stop.abort();
      await worker;
      worker = undefined;
    }

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
  if (process.env.FACADE_HARNESS_COMPOUND_ONLY !== '1') {
    const primary = [done('a'), done('a'), done('b'), done('b')];
    const posts = [...Array(6).fill('A'), ...Array(6).fill('B')];
    const review = { review: true, approvals: ['A', 'B'] };
    await runCase({ ...review, name: 'Third model and both rechecks', calls: [...posts, ...Array(3).fill('lead'),
      ...Array(3).fill('verify-A'), ...Array(3).fill('verify-B')],
      expected: [...primary, ['lead', 'done', null], ['verify-A', 'done', null], ['verify-B', 'done', null]] });
    await runCase({ ...review, name: 'Third model outside approved scope', wrongScope: 'lead', calls: posts,
      expected: [...primary, ['lead', 'held', 'synthetic_input_not_approved']] });
    await runCase({ ...review, name: 'Third model unavailable at fixed endpoint', unavailableLead: true, calls: [...posts, 'lead'],
      expected: [...primary, ['lead', 'held', 'http_404']] });
    await runCase({ ...review, name: 'B recheck grant revoked', revokeReview: 'B',
      calls: [...posts, ...Array(3).fill('lead'), ...Array(3).fill('verify-A')],
      expected: [...primary, ['lead', 'done', null], ['verify-A', 'done', null], ['verify-B', 'held', 'route_denied']] });
    await runCase({ name: 'B outside approved scope', approvals: ['A', 'B'], wrongScope: 'B',
      calls: Array(3).fill('A'), expected: [done('a'), held('b', 'synthetic_input_not_approved')] });
    await runCase({ name: 'Unverified customer ZDR is held despite an explicit route grant', customer: true, approvals: ['A'],
      settings: { A: { ...settings(fixture.A), dataClass: 'customer' } }, calls: [],
      expected: [held('a', 'research_route_not_approved'), held('b', 'research_route_not_approved')] });
    await runCase({ name: 'An extra original blocks strict synthetic authorization', extraOriginal: true, approvals: ['A'],
      calls: [], expected: [held('a', 'route_data_unapproved'), held('a', 'synthetic_input_not_approved'),
        held('b', 'research_route_not_approved'), held('b', 'research_route_not_approved')] });
    await runCase({ name: 'PNG allowed for A and held for B', approvals: ['A', 'B'], visual: true,
      calls: ['A', 'A', 'B'], expected: [done('a'), held('b', 'route_bound_unavailable')] });
    await runCase({ name: 'Default Terra and Qwen4 Max through Alibaba', mixed: true, approvals: ['A', 'B'],
      calls: ['A', 'A', 'A', 'B', 'B', 'B'], expected: [done('a'), done('b')] });
    await runCase({ name: 'Only A', approvals: ['A'], malformed: 'B', calls: ['A', 'A', 'A'],
      expected: [done('a'), held('b', 'research_route_not_approved')] });
    await runCase({ name: 'Only B', approvals: ['B'], recoverA: true, settings: { A: { routeId: 'broken' } }, calls: ['B', 'B', 'B'],
      expected: [held('a', 'research_profile_unavailable'), done('b')] });
    await runCase({ name: 'No routes', approvals: [], calls: [],
      expected: [held('a', 'research_route_not_approved'), held('b', 'research_route_not_approved')] });
    for (const comparison of [wafer, decart]) {
      await runCase({ name: `Compare ${comparison.provider}`, comparison, approvals: ['A'], calls: ['A', 'A', 'A', 'A'],
        expected: [done('a'), held('b', 'research_route_not_approved')] });
    }
    await runCase({ name: 'Revoke A', approvals: ['A', 'B'], revoke: 'A', calls: ['A', 'B', 'B', 'B'],
      expected: [held('a', 'route_denied'), done('b')] });
    await runCase({ name: 'Leader unavailable', approvals: ['A', 'B'], dispute: true,
      calls: [...Array(6).fill('A'), ...Array(6).fill('B')],
      expected: [done('a'), done('a'), done('b'), done('b'), ['review', 'held', 'research_profile_unavailable']] });

  }
  await runCase({ name: 'Compound after repeated error', compound: true, approvals: ['A'], calls: Array(5).fill('A'),
    expected: [done('a'), held('a', 'repeated_rejected_action'),
      held('b', 'research_route_not_approved'), held('b', 'research_route_not_approved')] });
  const { rows: [ledger] } = await ledgerPool.query(
    `SELECT count(*) FILTER(WHERE state IN ('prepared','sending','unknown'))::int AS open,
            coalesce(sum(spent_usd_nanos),0)::text AS spent FROM gateway_external_attempts`);
  assert.deepEqual(ledger, { open: 0, spent: '0' });
  if (process.env.FACADE_HARNESS_COMPOUND_ONLY !== '1') await t.test('profile switch preserves ready and unknown window assignments', async () => {
    const { activatePackageProjects, authorizedPackageWindow, dispatchPackagePair, preparePackageMap } =
      await import('../../../dist/src/modules/harness/package-dispatch.js');
    const project = await post('/api/projects', { name: 'Pinned package', catalogVersionId: catalog.id, scopeName: 'F-1', stage: 'P' });
    const projectId = project.id;
    const bytes = Buffer.from('Thickness 2 mm\nThickness 3 mm');
    const receipt = await post(`/api/projects/${projectId}/receipts`, {});
    const upload = await post(`/api/receipts/${receipt.receiptId}/uploads`, {
      relativePath: 'map.txt', size: bytes.length, sha256: checksum(bytes), mediaType: 'text/plain', scopeIds: [project.scopes[0].id],
    });
    await http('PUT', `/api/uploads/${upload.uploadId}/parts/1`, bytes, {
      'content-type': 'application/octet-stream', 'x-part-sha256': checksum(bytes), 'content-length': String(bytes.length),
    });
    await post(`/api/uploads/${upload.uploadId}/complete`, {});
    await post(`/api/receipts/${receipt.receiptId}/seal`, {});
    const readerVersion = 'fixture-window-map';
    await activatePackageProjects(app.db, gateway, [projectId]);
    assert.equal(await preparePackageMap(app.db, gateway, {
      formatFor: () => 'txt', readerVersion: async () => readerVersion,
      map: async source => ({ source, format: 'txt', readerVersion, units: [{ id: 'first' }, { id: 'second' }] }),
    }, [projectId]), true);
    const prior = { A: settings(fixture.A), B: settings(fixture.B), lead: null };
    for (const profile of [prior, defaults]) {
      for (const [slot, purpose] of [['A', 'primary_a'], ['B', 'primary_b']]) {
        await gateway.grantRoute({ projectId, routeId: profile[slot].routeId, revision: 'local-test', dataClass: 'synthetic',
          purpose, allowed: true });
      }
    }
    assert.equal(await dispatchPackagePair(app.db, gateway, prior), true);
    assert.equal(await dispatchPackagePair(app.db, gateway, prior), true);
    const journal = new PostgresIntentJournal(ledgerPool, process.env.FACADE_GATEWAY_LEDGER_ID);
    let sends = 0;
    const fixtureGateway = new Gateway(app.db, journal, { kind: 'openrouter', async send() {
      sends++;
      return { receipt: { state: 'unknown', code: 'fixture_unknown_charge' } };
    } });
    const work = await fixtureGateway.claim({ workerId: 'fixture-profile-switch', kinds: ['harness_research'], leaseMs: 60_000 });
    assert.equal(work.projectId, projectId);
    const savedSettings = work.payload.settings;
    const call = { lease: work.lease, effectKey: 'fixture-first-step', routeId: savedSettings.routeId,
      dataClass: savedSettings.dataClass, inputRefs: [], request: { text: 'synthetic' } };
    const lost = await fixtureGateway.call(call);
    assert.equal(lost.code, 'unknown_charge');
    await fixtureGateway.checkpoint(work.lease, { researchSequence: 1 });
    await app.db.query('INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,1,$2)',
      [work.lease.jobId, { kind: 'fixture-marker' }]);
    await fixtureGateway.suspend(work.lease, { reason: lost.code, nextAction: lost.nextAction });
    const assignments = () => app.db.query(
      `SELECT w.ordinal,b.active,b.branch,b.profile_hash,b.job_id,j.payload,j.state,j.cursor,j.generation_id
       FROM harness_package_branches b JOIN harness_package_windows w ON w.id=b.window_id
       JOIN gateway_jobs j ON j.id=b.job_id WHERE w.project_id=$1 ORDER BY w.ordinal,b.branch`, [projectId]);
    const before = (await assignments()).rows;
    assert.equal(before.length, 2);
    assert.deepEqual(before.map(({ state }) => state).sort(), ['held', 'ready']);
    const balance = await journal.balance();
    assert.equal(balance.reserveUsdNanos, 1);
    assert.equal(await dispatchPackagePair(app.db, gateway, defaults), true);
    assert.equal(await dispatchPackagePair(app.db, gateway, defaults), true);
    const after = (await assignments()).rows;
    assert.deepEqual(after.slice(0, 2), before);
    assert.deepEqual(after.slice(2).map(({ active, payload }) => [active, payload.settings]), [[true, defaults.A], [true, defaults.B]]);
    for (const { job_id, generation_id, branch, payload } of before) {
      assert.equal(await authorizedPackageWindow(app.db, { id: job_id, projectId, generationId: generation_id, branch,
        place: payload.place, windowId: payload.packageWindow.id, readerVersion }), true);
    }
    assert.deepEqual((await app.db.query('SELECT event FROM harness_research_events WHERE job_id=$1', [work.lease.jobId])).rows,
      [{ event: { kind: 'fixture-marker' } }]);
    assert.deepEqual((await app.db.query('SELECT state,route_id FROM gateway_attempts WHERE id=$1', [lost.attemptId])).rows,
      [{ state: 'unknown', route_id: savedSettings.routeId }]);
    assert.deepEqual(await journal.balance(), balance);
    assert.equal(sends, 1);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
