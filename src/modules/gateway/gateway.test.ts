import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type {} from '../../platform/api.js';
import { accessConfig, csrfToken, digest, randomSecret } from '../access/auth.js';
import { register as registerAccess } from '../access/index.js';
import { resumeInterruptedResearch } from '../harness/runner.js';
import { registerOperatorRoutes } from './operator.js';
import { Gateway } from './gateway.js';
import { PostgresIntentJournal } from './journal.js';
import { estimateOpenRouterRequest, openRouterTransport, type OpenRouterProfile } from './openrouter.js';
import { BUDGET_USD_NANOS, type Attempt, type CallInput, type CallResult,
  type GenerationRef, type ModelTransport, type Obligation, type RoutePolicy } from './types.js';

const appUrl = process.env.DATABASE_URL;
const journalUrl = process.env.GATEWAY_TEST_JOURNAL_URL;
const providerUrl = process.env.GATEWAY_TEST_PROVIDER_URL;
const sqlCase = { skip: !(appUrl && journalUrl && providerUrl) };
const appSql = 'db/migrations/08_gateway_state.sql';
const journalSql = 'src/modules/gateway/journal.sql';
const baseRoute = {
  id: 'controlled-a', revision: 'v1', transport: 'managed', enabled: true,
  maxRequestBytes: 65536, timeoutMs: 15_000, ceilingUsdNanos: 1_000_000_000,
} satisfies RoutePolicy;
const fixtureRates = {
  inputTokenUpperBound: 1000, outputTokenLimit: 500, maxImages: 1,
  maxImagePixels: 4, maxImageWidth: 2, maxImageHeight: 2, maxImageBytes: 1024,
  promptNanosPerToken: 100, completionNanosPerToken: 200,
  cacheReadNanosPerToken: 15, cacheWriteNanosPerToken: 125, cacheBilling: 'replaces-input',
  reasoningNanosPerToken: 300, reasoningBilling: 'replaces-output', completionCapIncludesReasoning: true,
  completionParameter: 'max_tokens',
  requestNanos: 1000, imageNanos: 20_000, additionalNanos: 100,
} as const;
const onePixel = {
  type: 'image_url',
  image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRxoAAAAASUVORK5CYII=' },
};
const expectedDisabledPlugins = ['web', 'file-parser', 'response-healing', 'auto-router', 'pareto-router', 'armor']
  .map(id => ({ id, enabled: false }));
const actor = { authority: 'gateway:reconcile', actorId: 'synthetic-operator' } as const;
const obligationA = { id: 'a', branch: 'A', place: 'page-1' } as const;
const obligationB = { id: 'b', branch: 'B', place: 'page-1' } as const;
const manifest = [obligationA, obligationB] as const;

async function reached(signal: ReturnType<typeof gate>, operation: Promise<CallResult>) {
  await Promise.race([signal.promise, operation.then(result => assert.fail('Dispatch stalled before checkpoint: ' + JSON.stringify(result)))]);
}

function project(): GenerationRef {
  return { projectId: randomUUID(), scopeId: randomUUID(), generationId: randomUUID() };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function isolated(t: TestContext, url: string, file?: string): Promise<pg.Pool> {
  const schema = 'gateway_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema, connectionTimeoutMillis: 3000 });
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  if (file) await pool.query(await readFile(file, 'utf8'));
  if (file === appSql) await pool.query(await readFile('db/migrations/08_gateway_z_route_isolation.sql', 'utf8'));
  return pool;
}

async function setup(t: TestContext, policy: RoutePolicy = baseRoute, limit = BUDGET_USD_NANOS) {
  const [db, outside, provider] = await Promise.all([
    isolated(t, appUrl!, appSql), isolated(t, journalUrl!, journalSql), isolated(t, providerUrl!),
  ]);
  const ledgerId = randomUUID();
  await outside.query('INSERT INTO gateway_external_ledger(ledger_id,limit_usd_nanos) VALUES ($1,$2)', [ledgerId, limit]);
  await provider.query(`CREATE TABLE provider_log(
    id uuid PRIMARY KEY, state text NOT NULL, cost bigint NOT NULL, effect_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const journal = new PostgresIntentJournal(outside, ledgerId);
  let behavior: (attempt: Attempt) => Promise<'paid' | 'rejected' | 'disconnect'> = async () => 'paid';
  let cost = 300_000_000;
  const outcome = (id: string, spent: number) => ({
    receipt: { state: 'paid' as const, costUsdNanos: spent, providerId: 'controlled:' + id, evidenceRef: 'provider-ledger:' + id },
    output: { choices: [{ message: { role: 'assistant', content: 'synthetic' } }] },
  });
  const transport: ModelTransport = {
    kind: 'managed',
    async send(attempt) {
      await provider.query("INSERT INTO provider_log(id,state,cost,effect_key) VALUES($1,'accepted',0,$2)", [attempt.id, attempt.effectKey]);
      const state = await behavior(attempt);
      if (state === 'disconnect') throw new Error('simulated lost response before ID');
      if (state === 'rejected') {
        await provider.query("UPDATE provider_log SET state='rejected' WHERE id=$1", [attempt.id]);
        return { receipt: { state: 'rejected', code: 'http_429', evidenceRef: 'provider-ledger:' + attempt.id } };
      }
      await provider.query("UPDATE provider_log SET state='paid',cost=$2 WHERE id=$1", [attempt.id, cost]);
      return outcome(attempt.id, cost);
    },
    async lookup(attempt) {
      const result = await provider.query<{ state: string; cost: string }>('SELECT state,cost FROM provider_log WHERE id=$1', [attempt.id]);
      const record = result.rows[0];
      if (record?.state === 'rejected') {
        return { receipt: { state: 'rejected', code: 'http_429', evidenceRef: 'provider-ledger:' + attempt.id } };
      }
      return record?.state === 'paid' ? outcome(attempt.id, Number(record.cost)) : null;
    },
  };
  const gateway = new Gateway(db, journal, transport);
  await gateway.configureRoute(policy);
  const read = async () => ({
    app: (await db.query('SELECT id,state,receipt,input_refs AS "inputRefs" FROM gateway_attempts ORDER BY created_at')).rows,
    external: (await outside.query('SELECT id,state,receipt,metadata FROM gateway_external_attempts ORDER BY created_order')).rows,
    provider: (await provider.query('SELECT id,state,cost::float8 FROM provider_log ORDER BY created_at')).rows,
    budget: await journal.balance(),
  });
  return {
    db, journal, provider, outside, gateway, transport, policy, read,
    setBehavior(next: typeof behavior) { behavior = next; },
    setCost(next: number) { cost = next; },
  };
}

async function grant(gateway: Gateway, ref: GenerationRef, allowed = true, policy: RoutePolicy = baseRoute) {
  for (const purpose of ['primary_a','primary_b','review'] as const) {
    await gateway.grantRoute({ projectId: ref.projectId, routeId: policy.id,
      dataClass: 'synthetic', purpose, revision: policy.revision, allowed });
  }
}

async function lease(
  gateway: Gateway, ref: GenerationRef, kind: string, primary?: Obligation, workerId = kind, leaseMs = 120_000,
) {
  await gateway.enqueue({ ...ref, key: kind, kind, subjectId: 'document', obligationId: primary?.id,
    purpose: primary ? (primary.branch === 'A' ? 'primary_a' : 'primary_b') : 'review' });
  const claimed = await gateway.claim({ workerId, kinds: [kind], leaseMs });
  assert.ok(claimed);
  return claimed.lease;
}

function call(input: CallInput['lease'], routeId = baseRoute.id): CallInput {
  return { lease: input, effectKey: 'turn-1', routeId, dataClass: 'synthetic',
    request: { messages: ['synthetic-only'] }, inputRefs: ['fragment-a:sha256'] };
}

function isHeld(result: CallResult, code: string) {
  assert.equal(result.status, 'held', JSON.stringify(result));
  assert.equal(result.code, code);
  assert.ok(result.nextAction);
  return result;
}

test('OpenRouter requires an explicit qualification and rejects unbounded requests without network', () => {
  assert.throws(() => openRouterTransport({
    qualification: 'step-15', endpoint: 'https://openrouter.ai', apiKey: '', profiles: [],
  }), /step15_approval_required/);
  const transport = openRouterTransport({
    qualification: 'step-15', endpoint: 'https://openrouter.ai', apiKey: 'synthetic-key',
    profiles: [{ routeId: baseRoute.id, revision: 'v1', model: 'one/two', provider: 'fixture', expectedResponseProvider: 'Fixture',
      mode: 'strict-zdr', zdrEvidenceRef: 'synthetic-zdr',
      boundEvidenceRef: 'synthetic-qualification', validUntil: '2099-01-01T00:00:00Z',
      ...fixtureRates, knownNoChargeStatuses: [] }],
  });
  const valid = { model: 'one/two', messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 300 };
  assert.equal(transport.validate?.(baseRoute, valid), true);
  assert.equal(transport.validate?.(baseRoute, { ...valid, max_tokens: 501 }), false);
  assert.equal(transport.validate?.(baseRoute, { ...valid, models: ['auto'] }), false);
  assert.equal(transport.validate?.(baseRoute, { ...valid, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'https://example.invalid/unbounded.png' } },
  ] }] }), false);
  assert.equal(transport.validate?.({ ...baseRoute, ceilingUsdNanos: 1 }, valid), false);
});

test('both OpenRouter route families quote bounded synthetic image tool turns without a key', () => {
  const ref = project();
  const fixtures: OpenRouterProfile[] = [
    { routeId: 'fixture-kimi', revision: 'v1', model: 'moonshotai/kimi-k3.1-pro', provider: 'wafer/us',
      expectedResponseProvider: 'Wafer', mode: 'strict-zdr', zdrEvidenceRef: 'test:zdr', boundEvidenceRef: 'test:rates',
      validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [], ...fixtureRates },
    { routeId: 'fixture-qwen', revision: 'v1', model: 'qwen/qwen4-max', provider: 'alibaba',
      expectedResponseProvider: 'Alibaba', mode: 'synthetic-research', boundEvidenceRef: 'test:rates',
      syntheticScopes: [{ projectId: ref.projectId, scopeId: ref.scopeId, approvalRef: 'test:synthetic',
        originalSha256s: ['a'.repeat(64)] }],
      validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [],
      ...fixtureRates, cacheBilling: 'supplement', reasoningBilling: 'supplement' },
  ];
  const ceilings = [206_100, 366_100];
  for (const [i, profile] of fixtures.entries()) {
    const route = { ...baseRoute, id: profile.routeId, transport: 'openrouter' as const };
    const request = { model: profile.model, max_tokens: 200, messages: [
      { role: 'tool', tool_call_id: 'call-1', content: 'synthetic result' },
      { role: 'user', content: [{ type: 'text', text: 'one synthetic pixel' }, onePixel] },
    ] };
    const expected = { input: i === 0 ? 125_000 : 240_000, outputAndReasoning: i === 0 ? 60_000 : 105_000,
      images: 20_000, request: 1_000, additional: 100, ceilingUsdNanos: ceilings[i] };
    assert.deepEqual(estimateOpenRouterRequest(profile, { ...route, ceilingUsdNanos: ceilings[i] }, request), expected);
    assert.equal(estimateOpenRouterRequest(profile, { ...route, ceilingUsdNanos: ceilings[i] - 1 }, request), null);
    assert.equal(estimateOpenRouterRequest(profile, route, { ...request, max_tokens: 501 }), null);
    assert.equal(estimateOpenRouterRequest({ ...profile, maxImageBytes: 20 }, route, request), null);
    assert.equal(estimateOpenRouterRequest({ ...profile, imageNanos: NaN }, route, request), null);
    assert.equal(estimateOpenRouterRequest(profile, route, { ...request, messages: [
      { role: 'user', content: [onePixel, onePixel] },
    ] }), null);
  }
});

test('qualified short-request bounds price the serialized wire and fall back outside the certified shape', () => {
  const ref = project();
  const profiles: OpenRouterProfile[] = [
    { routeId: 'estimate-wafer', model: 'moonshotai/kimi-k3.1-pro', provider: 'wafer/us',
      expectedResponseProvider: 'Wafer', mode: 'strict-zdr', zdrEvidenceRef: 'fixture:zdr',
      revision: 'v1', boundEvidenceRef: 'fixture:price', validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [],
      ...fixtureRates, inputTokenUpperBound: 1_048_376 },
    { routeId: 'estimate-alibaba', model: 'qwen/qwen4-max', provider: 'alibaba',
      expectedResponseProvider: 'Alibaba', mode: 'synthetic-research', revision: 'v1',
      syntheticScopes: [{ projectId: ref.projectId, scopeId: ref.scopeId, approvalRef: 'fixture:scope',
        originalSha256s: ['a'.repeat(64)] }],
      boundEvidenceRef: 'fixture:price', validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [],
      ...fixtureRates, inputTokenUpperBound: 1_000_000 },
  ];
  const envelope = { evidenceRef: 'fixture:hard-transform-bound', maxWireBytes: 8192, maxMessages: 3,
    maxTools: 1, tokensPerWireByte: 2, templateOverheadTokens: 256 };
  for (const base of profiles) {
    const profile = { ...base, inputEnvelope: envelope };
    const route = { ...baseRoute, id: base.routeId, transport: 'openrouter' as const };
    const text = { role: 'user', content: 'Синтетический ввод, UTF-8' };
    const tool = { type: 'function', function: { name: 'find', parameters: { type: 'object' } } };
    const request = { model: base.model, messages: [text], tools: [tool], tool_choice: 'required', max_tokens: 200 };
    assert.equal(estimateOpenRouterRequest(profile, route, { ...request, parallel_tool_calls: true }), null);
    assert.equal(estimateOpenRouterRequest(profile, route, { ...request, tool_choice: 'unexpected' }), null);
    assert.equal(estimateOpenRouterRequest({ ...profile, completionParameter: 'max_completion_tokens' }, route, request), null);
    const full = estimateOpenRouterRequest(base, route, request);
    const quote = estimateOpenRouterRequest(profile, route, request);
    assert.ok(full && quote?.inputEnvelope);
    assert.deepEqual(estimateOpenRouterRequest(profile, route, { ...request, parallel_tool_calls: false }), quote);
    const { wireBytes, inputTokens } = quote.inputEnvelope;
    assert.equal(inputTokens, wireBytes * envelope.tokensPerWireByte + envelope.templateOverheadTokens);
    assert.equal(quote.input, inputTokens * 125);
    assert.equal(quote.outputAndReasoning, base.provider === 'alibaba' ? 63_000 : 60_000);
    assert.ok(quote.ceilingUsdNanos < full.ceilingUsdNanos);
    assert.equal(estimateOpenRouterRequest({ ...profile, inputEnvelope: { ...envelope, evidenceRef: '' } }, route, request), null);

    const tooManyTools = { ...request, tools: [tool, tool] };
    const tooManyMessages = { ...request, messages: [text, text, text, text] };
    const larger = { ...request, messages: [{ ...text, content: 'я'.repeat(5000) }] };
    for (const outside of [tooManyTools, tooManyMessages, larger]) {
      const protectedQuote = estimateOpenRouterRequest(profile, route, outside);
      assert.equal(protectedQuote?.inputEnvelope, undefined);
      assert.equal(protectedQuote?.input, full.input);
    }

    const visual = { ...request, messages: [{ role: 'user', content: [onePixel] }] };
    assert.equal(estimateOpenRouterRequest(profile, route, visual)?.inputEnvelope, undefined);
    const visualBound = estimateOpenRouterRequest({ ...profile, inputEnvelope: { ...envelope, maxTokensPerImage: 500 } }, route, visual);
    assert.equal(visualBound?.inputEnvelope?.images, 1);
    assert.equal(visualBound?.inputEnvelope?.inputTokens, visualBound!.inputEnvelope!.wireBytes * 2 + 256 + 500);
    assert.equal(visualBound?.images, profile.imageNanos);

    const separateImages = { ...envelope, maxTokensPerImage: 500, maxTextWireBytes: 2048 };
    const visualWithSeparateCharge = estimateOpenRouterRequest({ ...base, inputEnvelope: separateImages }, route, visual);
    assert.ok(visualWithSeparateCharge?.inputEnvelope?.textWireBytes);
    const { wireBytes: fullBytes, textWireBytes } = visualWithSeparateCharge.inputEnvelope;
    const base64Length = onePixel.image_url.url.split(',')[1].length;
    assert.equal(textWireBytes, fullBytes - base64Length);
    assert.equal(visualWithSeparateCharge.inputEnvelope.inputTokens, textWireBytes * 2 + 256 + 500);
    assert.equal(visualWithSeparateCharge.images, profile.imageNanos);
    const imageOutsideUserRole = { ...visual, messages: [{ role: 'assistant', content: [onePixel] }] };
    const protectedImage = estimateOpenRouterRequest({ ...base, inputEnvelope: separateImages }, route, imageOutsideUserRole);
    assert.ok(protectedImage?.inputEnvelope);
    assert.equal(protectedImage.inputEnvelope.textWireBytes, protectedImage.inputEnvelope.wireBytes);
    assert.equal(protectedImage.images, profile.imageNanos);
    const textWithVisualEnvelope = estimateOpenRouterRequest({ ...base, inputEnvelope: separateImages }, route, request);
    assert.ok(textWithVisualEnvelope?.inputEnvelope);
    assert.equal(textWithVisualEnvelope.inputEnvelope.textWireBytes, textWithVisualEnvelope.inputEnvelope.wireBytes);
    assert.equal(textWithVisualEnvelope.ceilingUsdNanos, quote.ceilingUsdNanos);
    for (const insufficient of [
      { maxWireBytes: fullBytes - 1, maxTextWireBytes: textWireBytes },
      { maxTextWireBytes: textWireBytes - 1 },
    ]) {
      const limited = { ...base, inputEnvelope: { ...separateImages, ...insufficient } };
      assert.equal(estimateOpenRouterRequest(limited, route, visual)?.inputEnvelope, undefined);
    }
    assert.equal(estimateOpenRouterRequest({ ...base, inputEnvelope: { ...envelope, maxTextWireBytes: 2048 } }, route, visual), null);

    if (base.provider === 'wafer/us') {
      const contextRisk = { ...base, inputTokenUpperBound: 1_048_377 };
      assert.equal(estimateOpenRouterRequest(contextRisk, route, request), null);
      const fallbackCost = (943_718 - request.max_tokens) * 300;
      assert.equal(estimateOpenRouterRequest({ ...contextRisk, additionalNanos: fallbackCost - 1 }, route, request), null);
      assert.equal(estimateOpenRouterRequest({ ...contextRisk, additionalNanos: fallbackCost }, route, request)?.additional,
        fallbackCost);
      const bounded = { ...contextRisk, inputEnvelope: envelope };
      assert.equal(estimateOpenRouterRequest(bounded, route, request)?.ceilingUsdNanos, quote.ceilingUsdNanos);
      assert.equal(estimateOpenRouterRequest(bounded, route, larger), null);
    }
  }
});

test('Decart is scoped to the qualified synthetic Kimi route and requires a supported tool choice', async t => {
  const ref = project();
  const route = { ...baseRoute, id: 'decart-comparison', transport: 'openrouter' } as const;
  const profile = {
    routeId: route.id, revision: route.revision, model: 'moonshotai/kimi-k3.1-pro',
    provider: 'decart/mxfp4', expectedResponseProvider: 'Decart', mode: 'synthetic-research',
    zdrEvidenceRef: 'fixture:decart-zdr', boundEvidenceRef: 'fixture:decart-rates', validUntil: '2099-01-01T00:00:00Z',
    syntheticScopes: [{ ...ref, approvalRef: 'fixture:decart-scope', originalSha256s: ['a'.repeat(64)] }],
    ...fixtureRates, knownNoChargeStatuses: [],
  } as const;
  const approval = { qualification: 'step-15', endpoint: 'https://openrouter.ai', apiKey: 'fixture-key' } as const;
  for (const excluded of [{ ...profile, mode: 'strict-zdr' as const }, { ...profile, zdrEvidenceRef: '' },
    { ...profile, provider: 'decart' }, { ...profile, model: 'moonshotai/kimi-other' }]) {
    assert.throws(() => openRouterTransport({ ...approval, profiles: [excluded] }), /invalid_openrouter_profile/);
  }
  const transport = openRouterTransport({ ...approval, profiles: [profile] });
  const tool = { type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object' } } };
  const request = { model: profile.model, messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 200,
    tools: [tool], tool_choice: 'auto', parallel_tool_calls: false };
  assert.equal(transport.requestBlock?.(route, { ...request, tool_choice: 'required' }), 'route_parameters_unsupported');
  assert.equal(transport.requestBlock?.(route, { ...request, parallel_tool_calls: true }), 'route_parameters_unsupported');
  assert.ok(transport.quote?.(route, { ...request, tool_choice: { type: 'function', function: { name: 'fixture_tool' } } }));
  const quote = transport.quote?.(route, request);
  assert.ok(quote);
  const attempt: Attempt = { ...ref, ...quote, id: randomUUID(), jobId: randomUUID(), purpose: 'primary_a',
    effectKey: 'fixture:decart', requestHash: 'fixture:request', routeId: route.id, revision: route.revision,
    dataClass: 'synthetic', previousRejectedId: null };
  const fetchSpy = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const wire = JSON.parse(options.body as string);
    assert.deepEqual(wire.provider.only, ['decart/mxfp4']);
    assert.deepEqual(wire.provider.order, ['decart/mxfp4']);
    assert.equal(wire.provider.allow_fallbacks, false);
    assert.equal(wire.provider.require_parameters, true);
    assert.equal(wire.provider.zdr, true);
    assert.equal(wire.provider.data_collection, 'deny');
    assert.deepEqual(wire.plugins, expectedDisabledPlugins);
    assert.equal(wire.parallel_tool_calls, undefined);
    assert.equal(wire.tool_choice, 'auto');
    assert.equal(wire.max_tokens, 200);
    assert.deepEqual(wire.tools, [tool]);
    return Response.json({ id: 'gen-fixture-decart', model: profile.model, provider: 'Decart', usage: { cost: 0 }, choices: [] });
  });
  const signal = new AbortController().signal;
  assert.equal((await transport.send({ ...attempt, dataClass: 'client' }, route, request, signal)).receipt.state, 'rejected');
  assert.equal((await transport.send({ ...attempt, scopeId: randomUUID() }, route, request, signal)).receipt.state, 'rejected');
  assert.equal((await transport.send(attempt, route, { ...request, tool_choice: 'required' }, signal)).receipt.state, 'rejected');
  assert.equal(fetchSpy.mock.callCount(), 0);
  assert.equal((await transport.send(attempt, route, request, signal)).receipt.state, 'paid');
  assert.equal(fetchSpy.mock.callCount(), 1);
});

test('journal failure after local reserve and permission revocation both prevent transmission', sqlCase, async t => {
  const s = await setup(t);
  const ref = project();
  await s.gateway.openGeneration(ref);
  await s.gateway.sealGeneration(ref, manifest);
  await grant(s.gateway, ref);
  const worker = await lease(s.gateway, ref, 'a', obligationA);
  const originalPrepare = s.journal.prepare.bind(s.journal);
  s.journal.prepare = async () => { throw new Error('journal disconnected before durable confirmation'); };
  const unavailable = isHeld(await s.gateway.call(call(worker)), 'journal_unavailable');
  assert.equal((await s.read()).app[0].state, 'reserved');
  assert.equal((await s.read()).external.length, 0);
  assert.equal((await s.read()).provider.length, 0);

  const prepared = gate();
  const continueAfterRevoke = gate();
  s.journal.prepare = async (attempt) => {
    const saved = await originalPrepare(attempt);
    prepared.release();
    await continueAfterRevoke.promise;
    return saved;
  };
  const invocation = s.gateway.call(call(worker));
  await reached(prepared, invocation);
  assert.equal((await s.read()).budget.reserveUsdNanos, baseRoute.ceilingUsdNanos);
  await grant(s.gateway, ref, false);
  continueAfterRevoke.release();
  assert.equal(isHeld(await invocation, 'route_denied').attemptId, unavailable.attemptId);
  const cancelled = await s.read();
  assert.equal(cancelled.app[0].state, 'cancelled');
  assert.equal(cancelled.external[0].state, 'cancelled');
  assert.equal(cancelled.provider.length, 0);
  assert.equal(cancelled.budget.reserveUsdNanos, 0);

  await grant(s.gateway, ref, true);
  s.journal.prepare = originalPrepare;
  assert.equal((await s.gateway.call(call(worker))).status, 'paid');
  const state = await s.read();
  assert.equal(state.app.at(-1).state, 'paid');
  assert.equal(state.external.at(-1).state, 'paid');
  assert.equal(state.provider.length, 1);
  assert.deepEqual(state.app.at(-1).inputRefs, ['fragment-a:sha256']);
  assert.equal('inputRefs' in state.external.at(-1).metadata, false);
  t.diagnostic('journal unavailable and revocation: 0 sends each, released reserve; regrant: 1 receipt in all three ledgers');
});

test('late receipt belongs to the original attempt and cannot publish with an expired lease', sqlCase, async t => {
  const s = await setup(t);
  const ref = project();
  await s.gateway.openGeneration(ref);
  await s.gateway.sealGeneration(ref, manifest);
  await grant(s.gateway, ref);
  const first = await lease(s.gateway, ref, 'a', obligationA, 'worker-1');
  assert.equal(await s.gateway.checkpoint(first, { address: 'page-1', saved: 'existing-reading' }), true);
  const entered = gate();
  const respond = gate();
  s.setBehavior(async () => { entered.release(); await respond.promise; return 'paid'; });
  const inFlight = s.gateway.call(call(first));
  await reached(entered, inFlight);
  await s.db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.jobId]);
  const second = await s.gateway.claim({ workerId: 'worker-2', kinds: ['a'], leaseMs: 15_000 });
  assert.ok(second);
  assert.equal(second.lease.epoch, first.epoch + 1);
  assert.deepEqual(second.cursor, { address: 'page-1', saved: 'existing-reading' });
  assert.equal(await s.gateway.heartbeat(first, 5000), false);
  assert.equal(await s.gateway.finish(first, { forbidden: true }, { state: 'completed', evidenceRef: 'late' }), false);
  const waiting = isHeld(await s.gateway.call(call(second.lease)), 'unknown_charge');
  assert.equal((await s.read()).provider.length, 1);
  respond.release();
  assert.equal(isHeld(await inFlight, 'lease_lost').attemptId, waiting.attemptId);
  const replay = await s.gateway.call(call(second.lease));
  assert.equal(replay.status, 'paid');
  assert.equal(replay.replay, true);
  assert.equal(replay.attemptId, waiting.attemptId);
  assert.equal(await s.gateway.finish(second.lease, { accepted: true }, { state: 'completed', evidenceRef: 'original-reading' }), true);
  const state = await s.read();
  assert.equal(state.app.length, 1);
  assert.equal(state.external.length, 1);
  assert.equal(state.provider.length, 1);
  assert.equal(state.budget.spentUsdNanos, 300_000_000);
  assert.equal(state.budget.reserveUsdNanos, 0);
  const events = await s.gateway.readOutbox('0');
  assert.deepEqual(events.map(event => event.eventType), ['queued','leased','leased','finished']);
  assert.deepEqual(events.map(event => event.cursor), ['1','2','3','4']);
  t.diagnostic('two lease generations: 1 send and 1 charge, prior reading preserved, only current worker published');
});

test('live primary, unfinished outcome, and open inventory gate review per generation', sqlCase, async t => {
  const s = await setup(t);
  const large = project();
  const small = project();
  for (const ref of [large, small]) {
    await s.gateway.openGeneration(ref);
    await s.gateway.declarePrimary(ref, obligationA);
    await s.gateway.declarePrimary(ref, obligationB);
    await grant(s.gateway, ref);
  }
  const review = await lease(s.gateway, large, 'review');
  isHeld(await s.gateway.call(call(review)), 'primary_barrier');
  await s.gateway.sealGeneration(large, manifest);
  await s.gateway.sealGeneration(small, manifest);
  const largeA = await lease(s.gateway, large, 'large-a', obligationA);
  const largeB = await lease(s.gateway, large, 'large-b', obligationB);
  const smallA = await lease(s.gateway, small, 'small-a', obligationA);
  const smallB = await lease(s.gateway, small, 'small-b', obligationB);
  const smallReview = await lease(s.gateway, small, 'small-review');
  const finish = (worker: typeof review, state: 'completed' | 'final_refusal' = 'completed') =>
    s.gateway.finish(worker, {}, { state, evidenceRef: 'source-address:page-1' });

  assert.equal((await s.gateway.call(call(largeA))).status, 'paid');
  assert.equal(await finish(largeA), true);
  const entered = gate();
  const respond = gate();
  s.setBehavior(async attempt => {
    if (attempt.jobId === largeB.jobId) { entered.release(); await respond.promise; }
    return 'paid';
  });
  const inFlight = s.gateway.call(call(largeB));
  await reached(entered, inFlight);
  const heldReview = isHeld(await s.gateway.call(call(review)), 'primary_barrier');
  assert.equal(await s.gateway.suspend(review, { reason: heldReview.code, nextAction: heldReview.nextAction }), true);
  for (let check = 0; check < 3; check++) isHeld(await s.gateway.call(call(smallA)), 'route_busy');
  const busy = await s.read();
  assert.equal(busy.provider.length, 2);
  assert.equal(busy.app.length, 2);
  assert.equal(busy.external.length, 2);
  respond.release();
  assert.equal((await inFlight).status, 'paid');

  assert.equal((await s.gateway.call(call(smallA))).status, 'paid');
  assert.equal(await finish(smallA), true);
  assert.equal((await s.gateway.call(call(smallB))).status, 'paid');
  assert.equal(await finish(smallB, 'final_refusal'), true);
  assert.equal((await s.gateway.call(call(smallReview))).status, 'paid');
  assert.equal(await s.gateway.finish(smallReview, { coverage: 'incomplete' }), true);
  assert.equal(await s.gateway.claim({ workerId: 'too-early', kinds: ['review'], leaseMs: 10_000 }), null);
  assert.equal((await s.read()).provider.length, 5);

  assert.equal(await finish(largeB), true);
  const ready = await s.gateway.claim({ workerId: 'review-after-barrier', kinds: ['review'], leaseMs: 10_000 });
  assert.ok(ready);
  assert.equal((await s.gateway.call(call(ready.lease))).status, 'paid');
  const state = await s.read();
  assert.equal(state.provider.length, 6);
  assert.equal(state.external.filter(row => row.state === 'paid').length, 6);
  assert.equal(state.app.filter(row => row.state === 'paid').length, 6);
  assert.equal(state.budget.spentUsdNanos, 1_800_000_000);
  await s.gateway.openGeneration({ ...large, generationId: randomUUID() });
  isHeld(await s.gateway.call({ ...call(ready.lease), effectKey: 'old-review-continuation' }), 'lease_lost');
  assert.equal((await s.read()).provider.length, 6);
  t.diagnostic('large review: 0 sends until B publishes; small project completes earlier; 6 receipts match across all ledgers');
});

test('recovery settles a locally saved reply without resending or looking up the effect', sqlCase, async t => {
  const s = await setup(t);
  const ref = project();
  await s.gateway.openGeneration(ref);
  await s.gateway.sealGeneration(ref, manifest);
  await grant(s.gateway, ref);
  const work = await lease(s.gateway, ref, 'saved-output', obligationA);
  const suppress = t.mock.method(s.journal, 'settle', async () => { throw new Error('fixture journal disruption'); });
  const interrupted = isHeld(await s.gateway.call(call(work)), 'journal_unavailable');
  assert.ok(interrupted.attemptId);
  assert.equal((await s.journal.balance()).reserveUsdNanos, baseRoute.ceilingUsdNanos);
  suppress.mock.restore();

  const restarted = new Gateway(s.db, s.journal, { kind: 'managed', async send() { assert.fail('duplicate send'); } });
  const recovered = await restarted.recover();
  assert.equal(recovered.unresolved, 0);
  assert.equal(recovered.reserveUsdNanos, 0);
  assert.equal(recovered.spentUsdNanos, 300_000_000);
  const replay = await restarted.call(call(work));
  assert.equal(replay.status, 'paid');
  assert.equal(replay.status === 'paid' && replay.replay, true);
  assert.equal(replay.attemptId, interrupted.attemptId);
  assert.equal((await s.read()).provider.length, 1);
});

test('restored database reconciles the original charge and repeats the operator receipt after restart', sqlCase, async t => {
  const s = await setup(t);
  const damaged = project();
  const independent = project();
  for (const ref of [damaged, independent]) {
    await s.gateway.openGeneration(ref);
    await s.gateway.sealGeneration(ref, manifest);
    await grant(s.gateway, ref);
  }
  const work = await lease(s.gateway, damaged, 'restored-a', obligationA);
  const next = await lease(s.gateway, independent, 'independent-a', obligationA);
  const cursor = { saved: 'reading-a', next: 'page-1' };
  await s.gateway.checkpoint(work, cursor);

  // Reconstitute the pre-dispatch durable state in another database schema first.
  const snapshot = await isolated(t, appUrl!, appSql);
  const restored = new Gateway(snapshot, s.journal, s.transport);
  await restored.configureRoute(s.policy);
  for (const ref of [damaged, independent]) {
    await restored.openGeneration(ref);
    await restored.sealGeneration(ref, manifest);
    await grant(restored, ref);
  }
  const restoredWork = await lease(restored, damaged, 'restored-a', obligationA);
  assert.equal(restoredWork.jobId, work.jobId);
  await restored.checkpoint(restoredWork, cursor);
  const restoredNext = await lease(restored, independent, 'independent-a', obligationA);
  assert.equal(restoredNext.jobId, next.jobId);

  s.setBehavior(async () => 'disconnect');
  const lost = isHeld(await s.gateway.call(call(work)), 'unknown_charge');
  assert.ok(lost.attemptId);
  assert.equal((await s.read()).provider[0].state, 'accepted');
  assert.equal((await snapshot.query('SELECT count(*)::int AS n FROM gateway_attempts')).rows[0].n, 0);
  const initial = await restored.recover();
  assert.equal(initial.unresolved, 1);
  assert.equal(initial.reserveUsdNanos, baseRoute.ceilingUsdNanos);
  assert.equal(isHeld(await restored.call(call(restoredWork)), 'unknown_charge').attemptId, lost.attemptId);
  assert.equal(await restored.suspend(restoredWork, { reason: 'unknown_charge', nextAction: lost.nextAction }), true);
  assert.equal(await restored.resume(work.jobId), false);

  const retain = await restored.reconcile(actor, {
    attemptId: lost.attemptId, operationKey: 'retain', reasonRef: 'provider:no-lookup-result',
    resolution: { state: 'unknown', code: 'pending_provider_statement' },
  });
  assert.equal(retain.reserveUsdNanos, baseRoute.ceilingUsdNanos);

  // The unknown old request retains its immediate slot until the configured deadline.
  isHeld(await restored.call(call(restoredNext)), 'route_busy');
  await s.outside.query("UPDATE gateway_external_attempts SET slot_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [lost.attemptId]);
  s.setBehavior(async () => 'paid');
  assert.equal((await restored.call(call(restoredNext))).status, 'paid');
  assert.equal((await s.read()).provider.length, 2);

  await s.provider.query("UPDATE provider_log SET state='paid',cost=100000000 WHERE id=$1", [lost.attemptId]);
  const operation = {
    attemptId: lost.attemptId, operationKey: 'confirm', reasonRef: 'synthetic:provider-statement',
    resolution: { state: 'paid' as const, costUsdNanos: 100_000_000, providerId: 'controlled:' + lost.attemptId,
      evidenceRef: 'statement:line-1' },
  };
  const verified = await restored.reconcile(actor, operation);
  assert.equal(verified.spentUsdNanos, 100_000_000);
  assert.equal(verified.reserveUsdNanos, 0);
  const restarted = new Gateway(snapshot, s.journal, s.transport);
  assert.deepEqual(await restarted.reconcile(actor, operation), verified);
  await assert.rejects(restarted.reconcile(actor, { ...operation, reasonRef: 'changed-reason' }), /operation_conflict/);
  await assert.rejects(restarted.reconcile({ ...actor, actorId: '' }, operation), /reconciliation_forbidden/);

  const resumed = await restarted.claim({ workerId: 'post-restore', kinds: ['restored-a'], leaseMs: 15000 });
  assert.ok(resumed);
  assert.deepEqual(resumed.cursor, cursor);
  assert.equal(isHeld(await restarted.call(call(resumed.lease)), 'result_missing').attemptId, lost.attemptId);
  await restarted.recover();
  const recoveredOutput = await restarted.call(call(resumed.lease));
  assert.equal(recoveredOutput.status, 'paid');
  assert.equal(recoveredOutput.replay, true);
  const state = await s.read();
  const local = (await snapshot.query('SELECT id,state FROM gateway_attempts')).rows;
  const audit = (await s.outside.query(
    'SELECT authority,actor_id,reason_ref,previous,outcome FROM gateway_external_reconciliation ORDER BY created_at',
  )).rows;
  assert.deepEqual(local.map(row => row.state), ['paid', 'paid']);
  assert.equal(state.provider.length, 2);
  assert.equal(state.external.length, 2);
  assert.equal(state.budget.spentUsdNanos, 400_000_000);
  assert.equal(state.budget.reserveUsdNanos, 0);
  assert.equal(audit.length, 2);
  assert.equal(audit[1].authority, 'gateway:reconcile');
  assert.equal(audit[1].actor_id, actor.actorId);
  assert.equal(audit[1].reason_ref, operation.reasonRef);
  assert.equal(audit[1].previous.reserveUsdNanos, baseRoute.ceilingUsdNanos);
  assert.deepEqual(audit[1].outcome, verified);
  t.diagnostic('restore before application dispatch: 2 total sends, original effect held and settled once, restored reading preserved');
});

test('unknown isolation preserves the effect and reserve across concurrent same-route work and restart', sqlCase, async t => {
  const s = await setup(t);
  await s.db.query(await readFile('db/migrations/09_harness_z_route_bindings.sql', 'utf8'));
  const ref = project();
  const sameProject = { ...project(), projectId: ref.projectId };
  await s.gateway.openGeneration(ref);
  await s.gateway.sealGeneration(ref, manifest);
  await grant(s.gateway, ref);
  await s.gateway.openGeneration(sameProject);
  await s.gateway.sealGeneration(sameProject, manifest);
  const original = await lease(s.gateway, ref, 'original', obligationA);
  const review = await lease(s.gateway, ref, 'review');
  async function otherJob(key: string, kind = 'harness_research', generation = ref) {
    await s.gateway.enqueue({ ...generation, key, kind, purpose: 'primary_b', subjectId: key,
      obligationId: obligationB.id, payload: { settings: { routeId: baseRoute.id } } });
    const work = await s.gateway.claim({ workerId: key, kinds: [kind], leaseMs: 120_000 });
    assert.ok(work);
    return work.lease;
  }
  const sibling = await otherJob('sibling');
  const competitor = await otherJob('competitor', 'competitor', sameProject);
  s.setBehavior(async () => 'disconnect');
  const lost = isHeld(await s.gateway.call(call(original)), 'unknown_charge');
  assert.ok(lost.attemptId);
  const blocked = isHeld(await s.gateway.call(call(sibling)), 'route_reconciliation');
  assert.ok(await s.gateway.suspend(sibling, { reason: blocked.code, nextAction: blocked.nextAction }));
  await resumeInterruptedResearch(s.db, s.gateway, new AbortController().signal);
  assert.equal(await s.gateway.claim({ workerId: 'old', kinds: ['harness_research'], leaseMs: 120_000 }), null);

  const operation = {
    attemptId: lost.attemptId, operationKey: 'isolate', reasonRef: 'synthetic:unattributed-key-delta',
    resolution: { state: 'isolate_unknown' as const },
  };
  // Commit the journal first and simulate a crash before the app receives the marker.
  const results = await Promise.all(Array.from({ length: 2 }, () => s.journal.reconcile(actor, operation)));
  const [receipt] = results;
  assert.deepEqual(results, [receipt, receipt]);
  assert.deepEqual(receipt, {
    state: 'unknown', routeIsolated: true, reserveUsdNanos: baseRoute.ceilingUsdNanos, spentUsdNanos: 0,
    receipt: { state: 'unknown', code: 'provider_connection_lost' },
  });
  assert.equal((await s.outside.query('SELECT count(*)::int AS n FROM gateway_external_reconciliation')).rows[0].n, 1);
  assert.equal((await s.db.query('SELECT route_isolated FROM gateway_attempts WHERE id=$1', [lost.attemptId])).rows[0].route_isolated, false);
  const restarted = new Gateway(s.db, new PostgresIntentJournal(s.outside, s.journal.ledgerId), s.transport);
  await restarted.syncRouteIsolations();
  await resumeInterruptedResearch(s.db, restarted, new AbortController().signal);
  const resumed = await restarted.claim({ workerId: 'resumed', kinds: ['harness_research'], leaseMs: 120_000 });
  assert.equal(resumed?.lease.jobId, sibling.jobId);
  assert.deepEqual(await restarted.reconcile(actor, operation), receipt);
  await assert.rejects(restarted.reconcile(actor, { ...operation, operationKey: 'separate-command' }), /attempt_already_isolated/);
  assert.equal(isHeld(await restarted.call(call(original)), 'unknown_charge').attemptId, lost.attemptId);
  isHeld(await restarted.call({ ...call(original), effectKey: 'another-turn' }), 'route_reconciliation');
  assert.ok(await restarted.suspend(original, { reason: lost.code, nextAction: lost.nextAction }));
  assert.equal(await restarted.resume(original.jobId), false);
  isHeld(await restarted.call(call(resumed!.lease)), 'route_busy');
  isHeld(await restarted.call(call(review)), 'primary_barrier');
  await s.outside.query("UPDATE gateway_external_attempts SET slot_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [lost.attemptId]);

  const largeRoute = { ...baseRoute, id: 'separate-bound-route', ceilingUsdNanos: BUDGET_USD_NANOS };
  await restarted.configureRoute(largeRoute);
  await grant(restarted, ref, true, largeRoute);
  isHeld(await restarted.call(call(resumed!.lease, largeRoute.id)), 'budget_exhausted');

  const dispatch = gate();
  const release = gate();
  t.after(release.release);
  s.setBehavior(async () => { dispatch.release(); await release.promise; return 'disconnect'; });
  const independent = restarted.call(call(resumed!.lease));
  await reached(dispatch, independent);
  isHeld(await restarted.call(call(competitor)), 'route_reconciliation');
  const inFlight = await s.journal.balance();
  assert.equal(inFlight.reserveUsdNanos, 2 * baseRoute.ceilingUsdNanos);
  assert.equal(inFlight.spentUsdNanos, 0);
  release.release();
  const secondUnknown = isHeld(await independent, 'unknown_charge');
  assert.notEqual(secondUnknown.attemptId, lost.attemptId);
  isHeld(await restarted.call(call(competitor)), 'route_reconciliation');
  let state = await s.read();
  assert.equal(state.provider.length, 2);
  assert.equal(state.budget.reserveUsdNanos, 2 * baseRoute.ceilingUsdNanos);
  assert.equal(state.app.find(row => row.id === lost.attemptId).state, 'unknown');

  await s.outside.query('UPDATE gateway_external_ledger SET frozen=true');
  isHeld(await restarted.call(call(competitor)), 'budget_frozen');
  const paid = await restarted.reconcile(actor, { ...operation, operationKey: 'later-real-receipt',
    resolution: { state: 'paid', providerId: 'controlled:' + lost.attemptId,
      evidenceRef: 'fixture:actual-receipt', costUsdNanos: 11_576_985 } });
  assert.equal(paid.state, 'paid');
  assert.equal(paid.reserveUsdNanos, 0);
  assert.equal(paid.spentUsdNanos, 11_576_985);
  const recoveredOriginal = await restarted.claim({ workerId: 'after-settlement', kinds: ['original'], leaseMs: 120_000 });
  assert.ok(recoveredOriginal);
  isHeld(await restarted.call(call(recoveredOriginal.lease)), 'result_missing');
  state = await s.read();
  assert.equal(state.provider.length, 2);
  assert.equal(state.budget.reserveUsdNanos, baseRoute.ceilingUsdNanos);
  assert.equal(state.budget.spentUsdNanos, 11_576_985);
});

test('known 429 permits one explicit retry and concurrent projects share the exact $10 limit', sqlCase, async t => {
  const policy = { ...baseRoute, ceilingUsdNanos: BUDGET_USD_NANOS };
  const s = await setup(t, policy);
  const one = project();
  const two = project();
  for (const ref of [one,two]) {
    await s.gateway.openGeneration(ref);
    await s.gateway.sealGeneration(ref, manifest);
    await grant(s.gateway, ref, true, policy);
  }
  const first = await lease(s.gateway, one, 'one', obligationA);
  const second = await lease(s.gateway, two, 'two', obligationA);
  s.setBehavior(async () => 'rejected');
  const rejected = await s.gateway.call(call(first));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.receipt.code, 'http_429');
  assert.deepEqual(await s.gateway.call(call(first)), rejected);
  assert.equal((await s.read()).provider.length, 1);
  assert.equal((await s.read()).budget.reserveUsdNanos, 0);
  isHeld(await s.gateway.call({ ...call(first), request: { changed: true }, retryRejectedAttemptId: rejected.attemptId }),
    'effect_conflict');

  const entered = gate();
  const respond = gate();
  s.setCost(BUDGET_USD_NANOS);
  s.setBehavior(async () => { entered.release(); await respond.promise; return 'paid'; });
  const retry = s.gateway.call({ ...call(first), retryRejectedAttemptId: rejected.attemptId });
  await reached(entered, retry);
  assert.ok(isHeld(await s.gateway.call(call(second)), 'budget_reserve_wait').retryAt);
  assert.equal((await s.read()).budget.reserveUsdNanos, BUDGET_USD_NANOS);
  respond.release();
  assert.equal((await retry).status, 'paid');
  isHeld(await s.gateway.call(call(second)), 'budget_exhausted');
  const state = await s.read();
  assert.deepEqual(state.provider.map(row => row.state), ['rejected','paid']);
  assert.deepEqual(state.external.map(row => row.state), ['rejected','paid']);
  assert.equal(state.budget.spentUsdNanos, BUDGET_USD_NANOS);
  t.diagnostic('one known 429 and one explicit retry; a concurrent project waits during a $10 reserve and is held at $10 spent');
  assert.equal(state.budget.reserveUsdNanos, 0);
});

test('an active reserve queues the same effect until settlement without a duplicate send', sqlCase, async t => {
  const limit = 5_000_000_000;
  const policy = { ...baseRoute, ceilingUsdNanos: 3_000_000_000 };
  const waitingRoute = { ...policy, id: 'independent-route' };
  const s = await setup(t, policy, limit);
  await s.gateway.configureRoute(waitingRoute);
  const one = project();
  const two = project();
  for (const [ref, route] of [[one, policy], [two, waitingRoute]] as const) {
    await s.gateway.openGeneration(ref);
    await s.gateway.sealGeneration(ref, manifest);
    await grant(s.gateway, ref, true, route);
  }
  const first = await lease(s.gateway, one, 'running-reserve', obligationA);
  const second = await lease(s.gateway, two, 'waiting-reserve', obligationA);
  const input = call(second, waitingRoute.id);
  const entered = gate();
  const release = gate();
  t.after(release.release);
  s.setBehavior(async attempt => {
    if (attempt.jobId === first.jobId) { entered.release(); await release.promise; }
    return 'paid';
  });
  const inFlight = s.gateway.call(call(first));
  await reached(entered, inFlight);
  const blocked = isHeld(await s.gateway.call(input), 'budget_reserve_wait');
  assert.ok(blocked.retryAt);
  assert.ok(await s.gateway.suspend(second, { reason: blocked.code, nextAction: blocked.nextAction, retryAt: blocked.retryAt }));
  const before = await s.read();
  assert.equal(before.provider.length, 1);
  assert.equal(before.external.length, 1);
  assert.equal(before.budget.reserveUsdNanos, policy.ceilingUsdNanos);
  const { rows: [queued] } = await s.db.query('SELECT state,reason FROM gateway_jobs WHERE id=$1', [second.jobId]);
  assert.deepEqual(queued, { state: 'ready', reason: 'budget_reserve_wait' });

  release.release();
  assert.equal((await inFlight).status, 'paid');
  await delay(Math.max(0, blocked.retryAt.getTime() - Date.now()) + 50);
  const ready = await s.gateway.claim({ workerId: 'after-reserve', kinds: ['waiting-reserve'], leaseMs: 120_000 });
  assert.equal(ready?.lease.jobId, second.jobId);
  assert.ok(ready);
  const resumed = await s.gateway.call({ ...input, lease: ready.lease });
  assert.equal(resumed.status, 'paid');
  const replay = await s.gateway.call({ ...input, lease: ready.lease });
  assert.deepEqual(replay, { ...resumed, replay: true });
  const after = await s.read();
  assert.equal(after.provider.length, 2);
  assert.equal(after.external.length, 2);
  assert.equal(after.budget.reserveUsdNanos, 0);
  assert.equal(after.budget.spentUsdNanos, 600_000_000);
});

test('a persisted $5 cap blocks dispatch and counts unknown effects after a gateway restart', sqlCase, async t => {
  const limit = 5_000_000_000;
  const policy = { ...baseRoute, ceilingUsdNanos: 3_000_000_000 };
  const s = await setup(t, policy, limit);
  const one = project();
  const two = project();
  for (const ref of [one, two]) {
    await s.gateway.openGeneration(ref);
    await s.gateway.sealGeneration(ref, manifest);
    await grant(s.gateway, ref, true, policy);
  }
  const first = await lease(s.gateway, one, 'reduced-one', obligationA);
  const second = await lease(s.gateway, two, 'reduced-two', obligationA);
  s.setBehavior(async () => 'disconnect');
  const unknown = isHeld(await s.gateway.call(call(first)), 'unknown_charge');
  const pinned = new PostgresIntentJournal(s.outside, s.journal.ledgerId, limit);
  const reopened = new Gateway(s.db, pinned, s.transport);
  const mismatch = new PostgresIntentJournal(s.outside, s.journal.ledgerId, BUDGET_USD_NANOS);
  await assert.rejects(mismatch.balance(), /journal_limit_mismatch/);
  assert.equal(isHeld(await reopened.call(call(first)), 'unknown_charge').attemptId, unknown.attemptId);
  assert.equal(isHeld(await reopened.call(call(second)), 'budget_exhausted').retryAt, undefined);
  await assert.rejects(s.outside.query(`INSERT INTO gateway_external_attempts
    (id,effect_key,project_id,generation_id,route_id,purpose,ceiling_usd_nanos,metadata,state)
    VALUES ($1,'old-gateway-attempt',$2,$3,$4,'primary_a',$5,'{}','prepared')`,
  [randomUUID(), two.projectId, two.generationId, policy.id, policy.ceilingUsdNanos]), /gateway budget exhausted/);
  assert.deepEqual(await pinned.balance(), {
    frozen: false, limitUsdNanos: limit, spentUsdNanos: 0,
    reserveUsdNanos: policy.ceilingUsdNanos, remainingUsdNanos: 2_000_000_000,
  });
  const small = { ...policy, id: 'reduced-small', ceilingUsdNanos: 2_000_000_000 };
  await reopened.configureRoute(small);
  await grant(reopened, two, true, small);
  s.setCost(small.ceilingUsdNanos);
  s.setBehavior(async () => 'paid');
  assert.equal((await reopened.call(call(second, small.id))).status, 'paid');
  assert.deepEqual(await pinned.balance(), {
    frozen: false, limitUsdNanos: limit, spentUsdNanos: small.ceilingUsdNanos,
    reserveUsdNanos: policy.ceilingUsdNanos, remainingUsdNanos: 0,
  });
  assert.equal((await s.read()).provider.length, 2);
});

test('a journal created before the cap column keeps $10 and rejects a pinned $5 expectation', sqlCase, async t => {
  const s = await setup(t);
  await s.outside.query(`DROP FUNCTION gateway_enforce_reduced_budget() CASCADE;
                         ALTER TABLE gateway_external_ledger DROP COLUMN limit_usd_nanos`);
  const expectedFive = new PostgresIntentJournal(s.outside, s.journal.ledgerId, 5_000_000_000);
  await assert.rejects(expectedFive.balance(), /journal_limit_mismatch/);
  assert.equal((await s.journal.balance()).limitUsdNanos, BUDGET_USD_NANOS);
  assert.equal((await s.journal.balance()).remainingUsdNanos, BUDGET_USD_NANOS);
});

test('compact visual reserves admit both primary branches against the shared ledger', sqlCase, async t => {
  const s = await setup(t);
  const prior = project();
  await s.gateway.openGeneration(prior);
  await s.gateway.sealGeneration(prior, manifest);
  await grant(s.gateway, prior);
  s.setCost(380_000_000);
  assert.equal((await s.gateway.call(call(await lease(s.gateway, prior, 'prior', obligationA)))).status, 'paid');

  const ref = project();
  const rates = { ...fixtureRates, additionalNanos: 250_000_000, inputTokenUpperBound: 1_000_000,
    outputTokenLimit: 2048, maxImages: 12, imageNanos: 0, requestNanos: 0, cacheWriteNanosPerToken: 0,
    cacheBilling: 'supplement' as const };
  const envelope = { evidenceRef: 'fixture:qualified-visual', maxWireBytes: baseRoute.maxRequestBytes,
    maxTextWireBytes: 8192, maxMessages: 128, maxTools: 16, tokensPerWireByte: 4, templateOverheadTokens: 16_384 };
  const pricing = {
    a: { routeId: 'a', revision: baseRoute.revision, model: 'moonshotai/kimi-k3.1-pro',
      mode: 'strict-zdr', provider: 'wafer/us', expectedResponseProvider: 'Wafer', zdrEvidenceRef: 'fixture:zdr',
      boundEvidenceRef: 'fixture:rates', validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [], ...rates,
      promptNanosPerToken: 253, cacheReadNanosPerToken: 180, completionNanosPerToken: 8800, reasoningNanosPerToken: 8800,
      inputEnvelope: { ...envelope, maxTokensPerImage: 32_768 } },
    b: { routeId: 'b', revision: baseRoute.revision, model: 'qwen/qwen4-max',
      mode: 'synthetic-research', provider: 'alibaba', expectedResponseProvider: 'Alibaba',
      syntheticScopes: [{ ...ref, approvalRef: 'fixture:scope', originalSha256s: ['a'.repeat(64)] }],
      boundEvidenceRef: 'fixture:rates', validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [], ...rates,
      promptNanosPerToken: 1500, cacheReadNanosPerToken: 75, cacheWriteNanosPerToken: 3000,
      completionNanosPerToken: 4500, reasoningNanosPerToken: 4500,
      inputEnvelope: { ...envelope, maxTokensPerImage: 20_480 } },
  } satisfies Record<string, OpenRouterProfile>;
  const policies = { a: { ...baseRoute, id: 'a', ceilingUsdNanos: 615_641_728 },
    b: { ...baseRoute, id: 'b', ceilingUsdNanos: 4_456_841_800 } };
  const gateway = new Gateway(s.db, s.journal, {
    ...s.transport,
    quote(policy, request) {
      const profile = pricing[policy.id as keyof typeof pricing];
      const quote = estimateOpenRouterRequest(profile, { ...policy, transport: 'openrouter' }, request);
      return quote ? { ceilingUsdNanos: quote.ceilingUsdNanos, pricingFingerprint: 'fixture:' + policy.id } : null;
    },
  });
  await gateway.openGeneration(ref);
  await gateway.sealGeneration(ref, manifest);
  for (const policy of Object.values(policies)) {
    await gateway.configureRoute(policy);
    await grant(gateway, ref, true, policy);
  }
  const bothEntered = gate();
  const responses = gate();
  t.after(responses.release);
  let sends = 0;
  s.setCost(2_000_000);
  s.setBehavior(async () => {
    if (++sends === 2) bothEntered.release();
    await responses.promise;
    return 'paid';
  });
  const attempts = await Promise.all([lease(gateway, ref, 'compact-a', obligationA), lease(gateway, ref, 'compact-b', obligationB)]);
  const calls = (['a', 'b'] as const).map((id, i) => gateway.call({
    ...call(attempts[i], id), request: { model: pricing[id].model, max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }, onePixel] }] },
  }));
  await reached(bothEntered, Promise.race(calls));
  const current = await s.read();
  const reserves = current.external.filter(row => row.state === 'sending');
  assert.equal(reserves.length, 2);
  assert.equal(current.budget.reserveUsdNanos, reserves.reduce((total, row) => total + row.metadata.ceilingUsdNanos, 0));
  assert.equal(current.budget.spentUsdNanos, 380_000_000);
  assert.ok(current.budget.reserveUsdNanos < 1_000_000_000);
  responses.release();
  for (const result of await Promise.all(calls)) assert.equal(result.status, 'paid');
  const balance = await s.journal.balance();
  assert.equal(balance.reserveUsdNanos, 0);
  assert.equal(balance.remainingUsdNanos, 9_616_000_000);
});

test('synthetic Alibaba applies explicit retention and no-training evidence to the exact wire request', sqlCase, async t => {
  const s = await setup(t);
  const ref = project();
  const source = { projectId: ref.projectId, documentId: randomUUID(), versionId: randomUUID(), sha256: 'a'.repeat(64) };
  const originalId = randomUUID();
  await s.db.query(`
    CREATE TABLE intake_originals(id uuid PRIMARY KEY, project_id uuid, sha256 text);
    CREATE TABLE intake_document_versions(id uuid PRIMARY KEY, project_id uuid, document_id uuid, original_id uuid);
    CREATE TABLE reader_maps(project_id uuid,version_id uuid,reader_version text,original_sha256 text);
    CREATE TABLE reader_evidence(id uuid PRIMARY KEY,project_id uuid,version_id uuid,reader_version text,run_id uuid);
  `);
  await s.db.query('INSERT INTO intake_originals VALUES($1,$2,$3)', [originalId, ref.projectId, source.sha256]);
  await s.db.query('INSERT INTO intake_document_versions VALUES($1,$2,$3,$4)',
    [source.versionId, ref.projectId, source.documentId, originalId]);

  const profile = {
    routeId: 'research-qwen', revision: 'v1', model: 'qwen/qwen4-max', provider: 'alibaba',
    expectedResponseProvider: 'Alibaba', mode: 'synthetic-research', boundEvidenceRef: 'synthetic-rate-attestation',
    validUntil: '2099-01-01T00:00:00Z', ...fixtureRates, knownNoChargeStatuses: [],
    syntheticScopes: [{ projectId: ref.projectId, scopeId: ref.scopeId,
      approvalRef: 'approval:synthetic-only', originalSha256s: [source.sha256],
      retentionApproval: { approvalRef: 'approval:synthetic-retention', noTrainingEvidenceRef: 'policy:exact-route-no-training',
        validUntil: '2099-01-01T00:00:00Z' } }],
  } as const;
  const approval = { qualification: 'step-15', endpoint: 'https://openrouter.ai', apiKey: 'synthetic-key' } as const;
  assert.throws(() => openRouterTransport({ ...approval, profiles: [{ ...profile, mode: 'strict-zdr' }] }),
    /invalid_openrouter_profile/);
  assert.throws(() => openRouterTransport({ ...approval, profiles: [{
    ...profile, model: 'moonshotai/kimi-test', zdrEvidenceRef: 'synthetic-zdr',
  }] }), /invalid_openrouter_profile/);
  const accounted = project();
  await s.gateway.openGeneration(accounted);
  await s.gateway.sealGeneration(accounted, manifest);
  const fullCostRoute = { ...baseRoute, ceilingUsdNanos: BUDGET_USD_NANOS, revision: 'fixture-accounted' };
  await s.gateway.configureRoute(fullCostRoute);
  await grant(s.gateway, accounted, true, fullCostRoute);
  const billed = await lease(s.gateway, accounted, 'prior-charge', obligationA);
  s.setCost(BUDGET_USD_NANOS - 350_000);
  assert.equal((await s.gateway.call(call(billed))).status, 'paid');

  const scope = profile.syntheticScopes[0];
  const blockedProfiles = [
    [{ ...profile, routeId: 'no-retention', syntheticScopes: [{ ...scope, retentionApproval: undefined }] },
      'synthetic_retention_not_approved'],
    [{ ...profile, routeId: 'expired-retention', syntheticScopes: [{ ...scope, retentionApproval: {
      ...scope.retentionApproval, validUntil: '2000-01-01T00:00:00Z',
    } }] }, 'synthetic_retention_not_approved'],
    [{ ...profile, routeId: 'no-training-evidence', syntheticScopes: [{ ...scope, retentionApproval: {
      ...scope.retentionApproval, noTrainingEvidenceRef: '',
    } }] }, 'route_training_policy_unverified'],
    [{ ...profile, routeId: 'strict-alibaba', mode: 'strict-zdr', zdrEvidenceRef: 'fixture:purported-zdr' },
      'route_zdr_unavailable'],
    [{ ...profile, routeId: 'unsupported-completion', completionParameter: 'max_completion_tokens' },
      'route_parameters_unsupported'],
  ] as const satisfies readonly [OpenRouterProfile, string][];
  // Omit absent approval from decoded JSON, as the worker does.
  const profiles = JSON.parse(JSON.stringify([profile, ...blockedProfiles.map(([candidate]) => candidate)])) as OpenRouterProfile[];
  const transport = openRouterTransport({ ...approval, profiles });
  const gateway = new Gateway(s.db, s.journal, transport);
  const route = { ...baseRoute, id: profile.routeId, transport: 'openrouter' } as const;
  await gateway.configureRoute(route);
  await gateway.openGeneration(ref);
  await gateway.sealGeneration(ref, manifest);
  await grant(gateway, ref, true, route);
  await gateway.grantRoute({ projectId: ref.projectId, routeId: route.id, dataClass: 'client',
    purpose: 'primary_a', revision: route.revision, allowed: true });
  await gateway.enqueue({ ...ref, key: 'live-mock', kind: 'live-mock', purpose: 'primary_a', subjectId: source.versionId,
    obligationId: obligationA.id, payload: { mode: 'primary', place: { source } } });
  const current = await gateway.claim({ workerId: 'controlled-live-adapter', kinds: ['live-mock'], leaseMs: 120_000 });
  assert.ok(current);

  let wireCalls = 0;
  const mockFetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const wire = JSON.parse(options.body as string);
    assert.deepEqual(wire.provider.only, ['alibaba']);
    assert.deepEqual(wire.provider.order, ['alibaba']);
    assert.equal(wire.provider.allow_fallbacks, false);
    assert.equal(wire.provider.zdr, false);
    assert.equal(wire.provider.data_collection, 'allow');
    assert.equal(wire.provider.require_parameters, true);
    assert.deepEqual(wire.plugins, expectedDisabledPlugins);
    assert.equal(wire.parallel_tool_calls, undefined);
    assert.equal(wire.tool_choice, 'required');
    assert.equal(wire.tools[0].function.name, 'fixture_tool');
    assert.equal(wire.max_tokens, 200);
    assert.equal(wire.max_completion_tokens, undefined);
    assert.deepEqual(wire.provider.max_price, { prompt: 0.1, completion: 0.2, request: 0.000001, image: 0.00002 });
    assert.deepEqual(wire.messages[1].content, [onePixel]);
    assert.equal(wire.messages[0].cache_control, undefined);
    assert.ok(wire.trace.trace_id);
    if (++wireCalls === 2) throw new Error('synthetic disconnect before generation ID');
    return Response.json({ id: 'gen-synthetic-test', model: profile.model, provider: 'Alibaba',
      usage: { cost: 0.0001, prompt_tokens: 12, completion_tokens: 3 }, choices: [] });
  });
  const input = { ...call(current.lease, route.id), inputRefs: [], request: {
    model: profile.model, messages: [
      { role: 'tool', tool_call_id: 'call-1', content: 'synthetic only', cache_control: { type: 'ephemeral' } }, { role: 'user', content: [onePixel] },
    ], max_tokens: 200, parallel_tool_calls: false, tool_choice: 'required',
    tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object' } } }],
  } };
  for (const [candidate, code] of blockedProfiles) {
    const alternate = { ...route, id: candidate.routeId };
    await gateway.configureRoute(alternate);
    await grant(gateway, ref, true, alternate);
    isHeld(await gateway.call({ ...input, routeId: alternate.id }), code);
  }
  const regional = new Gateway(s.db, s.journal, openRouterTransport({
    ...approval, endpoint: 'https://eu.openrouter.ai', profiles: [profile],
  }));
  isHeld(await regional.call(input), 'route_endpoint_unverified');
  isHeld(await gateway.call({ ...input, request: { ...input.request, plugins: [{ id: 'web', enabled: true }] } }),
    'route_bound_unavailable');
  isHeld(await gateway.call({ ...input, request: { ...input.request, parallel_tool_calls: true } }),
    'route_parameters_unsupported');
  isHeld(await gateway.call({ ...input, dataClass: 'client' }), 'route_data_unapproved');
  isHeld(await gateway.call({ ...input, inputRefs: [randomUUID()] }), 'route_data_unapproved');
  const foreign = project();
  await gateway.openGeneration(foreign);
  await gateway.sealGeneration(foreign, manifest);
  await grant(gateway, foreign, true, route);
  await gateway.enqueue({ ...foreign, key: 'foreign', kind: 'foreign', purpose: 'primary_a', subjectId: source.versionId,
    obligationId: obligationA.id, payload: { mode: 'primary', place: { source } } });
  const foreignWork = await gateway.claim({ workerId: 'foreign-worker', kinds: ['foreign'], leaseMs: 120_000 });
  assert.ok(foreignWork);
  isHeld(await gateway.call({ ...input, lease: foreignWork.lease }), 'route_data_unapproved');
  assert.equal(mockFetch.mock.callCount(), 0);
  assert.equal((await s.read()).external.length, 1);

  const accepted = await gateway.call(input);
  assert.equal(accepted.status, 'paid');
  assert.equal(accepted.receipt.provider, 'Alibaba');
  assert.equal(accepted.receipt.model, profile.model);
  assert.equal(accepted.receipt.routeVerified, true);
  isHeld(await gateway.call({ ...input, effectKey: 'too-expensive', request: { ...input.request, max_tokens: 500 } }),
    'budget_exhausted');
  assert.equal(mockFetch.mock.callCount(), 1);

  const unresolved = { ...input, effectKey: 'unknown-response' };
  const undecided = isHeld(await gateway.call(unresolved), 'unknown_charge');
  assert.equal(isHeld(await gateway.call(unresolved), 'unknown_charge').attemptId, undecided.attemptId);
  const state = await s.journal.balance();
  assert.equal(state.reserveUsdNanos, 209_100);
  assert.equal(state.remainingUsdNanos, 40_900);

  await s.db.query('INSERT INTO intake_originals VALUES($1,$2,$3)',
    [randomUUID(), ref.projectId, 'b'.repeat(64)]);
  isHeld(await gateway.call({ ...input, effectKey: 'after-unknown-input' }), 'route_data_unapproved');
  assert.equal(mockFetch.mock.callCount(), 2);
  assert.equal((await s.read()).external.length, 3);
  t.diagnostic('multimodal quote 209100 nUSD fits; 299100 nUSD refused against 250000 nUSD; unknown holds 209100 nUSD');
});

test('operator API authorizes organization and CSRF, stores an audit receipt and returns only diagnostics', sqlCase, async t => {
  const s = await setup(t);
  await s.db.query(await readFile('db/migrations/02_access_schema.sql', 'utf8'));
  const ref = project();
  const ownerOrg = randomUUID();
  const otherOrg = randomUUID();
  await s.db.query("INSERT INTO organizations(id,name) VALUES ($1,'fixture'),($2,'other')", [ownerOrg, otherOrg]);
  async function account(organizationId: string, login: string, technicalOperator: boolean) {
    const id = randomUUID();
    await s.db.query(
      `INSERT INTO users(id,organization_id,login,password_hash,state,technical_operator)
       VALUES($1,$2,$3,'$argon2id$synthetic','active',$4)`, [id, organizationId, login, technicalOperator],
    );
    const token = randomSecret();
    await s.db.query(
      "INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
      [id, digest(token)],
    );
    const origin = accessConfig().origins[0];
    return { id, headers: { cookie: 'facade_session=' + token, origin, host: new URL(origin).host,
      'x-csrf-token': csrfToken(token), 'idempotency-key': 'fixture-reconcile' } };
  }
  const allowed = await account(ownerOrg, 'fixture-ops', true);
  const noRole = await account(ownerOrg, 'fixture-user', false);
  const other = await account(otherOrg, 'other-ops', true);
  const catalog = randomUUID();
  await s.db.query(
    `INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by)
       VALUES($1,$2,'fixture',1,'synthetic','[]',$3)`, [catalog, ownerOrg, allowed.id],
  );
  await s.db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id) VALUES($1,$2,'private-title',$3)",
    [ref.projectId, ownerOrg, catalog]);
  await s.gateway.openGeneration(ref);
  await s.gateway.sealGeneration(ref, manifest);
  await grant(s.gateway, ref);
  const worker = await lease(s.gateway, ref, 'operator-a', obligationA);
  s.setBehavior(async () => 'disconnect');
  const result = isHeld(await s.gateway.call(call(worker)), 'unknown_charge');

  const app = Fastify();
  app.decorate('db', s.db);
  t.after(() => app.close());
  await registerAccess(app);
  registerOperatorRoutes(app, s.gateway);
  const prefix = '/api/operator/gateway/projects/' + ref.projectId;
  const url = prefix + '/attempts/' + result.attemptId + '/reconcile';
  const payload = { state: 'unknown', code: 'audit_wait', reasonRef: 'synthetic-statement:unavailable' };
  const request = { method: 'POST', url, payload } as const;
  assert.equal((await app.inject(request)).statusCode, 401);
  assert.equal((await app.inject({ ...request, headers: noRole.headers })).statusCode, 403);
  const denied = await app.inject({ ...request, headers: other.headers });
  assert.equal(denied.statusCode, 404, denied.body);
  assert.equal((await app.inject({ ...request, headers: { ...allowed.headers, 'x-csrf-token': 'invalid' } })).statusCode, 403);
  const first = await app.inject({ ...request, headers: allowed.headers });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().reserveUsdNanos, baseRoute.ceilingUsdNanos);
  const repeated = await app.inject({ ...request, headers: allowed.headers });
  assert.equal(repeated.statusCode, first.statusCode);
  assert.deepEqual(repeated.json(), first.json());
  const isolatePayload = { state: 'isolate_unknown', reasonRef: 'operator-evidence:key-delta' };
  const isolateRequest = { ...request, headers: { ...allowed.headers, 'idempotency-key': 'fixture-isolate' },
    payload: isolatePayload };
  assert.equal((await app.inject({ ...isolateRequest, payload: { ...isolatePayload, providerId: 'invented-id' } })).statusCode, 422);
  assert.equal((await app.inject({ ...isolateRequest, headers: other.headers })).statusCode, 404);
  const isolatedAttempt = await app.inject(isolateRequest);
  assert.equal(isolatedAttempt.statusCode, 200, isolatedAttempt.body);
  assert.deepEqual(isolatedAttempt.json(), { ...first.json(), routeIsolated: true });
  assert.deepEqual((await app.inject(isolateRequest)).json(), isolatedAttempt.json());
  const diagnostic = await app.inject({ method: 'GET', url: prefix, headers: allowed.headers });
  assert.equal(diagnostic.statusCode, 200);
  assert.equal(diagnostic.headers['cache-control'], 'no-store');
  assert.equal(diagnostic.json().attempts[0].nextAction, 'operator_reconcile_attempt');
  assert.equal(diagnostic.json().attempts[0].routeIsolated, true);
  for (const hidden of ['synthetic-only','private-title','fragment-a:sha256']) assert.equal(diagnostic.body.includes(hidden), false);
  await s.provider.query("UPDATE provider_log SET state='rejected' WHERE id=$1", [result.attemptId]);
  const settled = await app.inject({ ...request,
    headers: { ...allowed.headers, 'idempotency-key': 'fixture-reject' },
    payload: { state: 'rejected', code: 'http_429', evidenceRef: 'provider-log:429', reasonRef: 'confirmed-no-charge' },
  });
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json().reserveUsdNanos, 0);
  assert.equal(settled.json().state, 'rejected');
  const repeatedEffect = await s.gateway.call({ ...call(worker), retryRejectedAttemptId: result.attemptId });
  assert.equal(repeatedEffect.status, 'rejected');
  assert.equal(repeatedEffect.attemptId, result.attemptId);
  assert.equal((await s.read()).provider.length, 1);
  const audited = (await s.outside.query('SELECT actor_id, outcome FROM gateway_external_reconciliation ORDER BY created_at')).rows;
  assert.equal(audited.length, 3);
  assert.ok(audited.every(row => row.actor_id === allowed.id));
  assert.deepEqual(audited[1].outcome, isolatedAttempt.json());
  assert.deepEqual(audited[2].outcome, settled.json());
  t.diagnostic('real Fastify handlers and PostgreSQL sessions: 401, 403, 404, CSRF, repeat and private-content checks passed');
});

test('OpenRouter 404 diagnostics distinguish a pre-provider refusal from an unproven 404 without releasing a reserve', sqlCase, async t => {
  const s = await setup(t);
  const ref = project();
  const route = { ...baseRoute, id: 'openrouter-diagnostic', transport: 'openrouter' } as const;
  const secondRoute = { ...route, id: 'openrouter-unproven' };
  const profile = {
    routeId: route.id, revision: route.revision, model: 'moonshotai/kimi-k3.1-pro',
    provider: 'wafer/us', expectedResponseProvider: 'Wafer', mode: 'strict-zdr',
    zdrEvidenceRef: 'fixture:zdr', boundEvidenceRef: 'fixture:pricing', validUntil: '2099-01-01T00:00:00Z',
    ...fixtureRates, knownNoChargeStatuses: [],
  } as const;
  const transport = openRouterTransport({
    qualification: 'step-15', endpoint: 'https://openrouter.ai', apiKey: 'fixture-key',
    profiles: [profile, { ...profile, routeId: secondRoute.id }],
  });
  const gateway = new Gateway(s.db, s.journal, transport);
  await gateway.openGeneration(ref);
  await gateway.sealGeneration(ref, manifest);
  for (const policy of [route, secondRoute]) {
    await gateway.configureRoute(policy);
    await grant(gateway, ref, true, policy);
  }
  const firstWorker = await lease(gateway, ref, 'diagnostic-a', obligationA);
  const secondWorker = await lease(gateway, ref, 'diagnostic-b', obligationB);
  const traces: string[] = [];
  const secret = 'secret-fixture-value';
  const document = 'synthetic-document-text-never-in-diagnostic';
  const fetchSpy = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const wire = JSON.parse(options.body as string);
    traces.push(wire.trace.trace_id);
    assert.deepEqual(wire.provider.only, ['wafer/us']);
    assert.deepEqual(wire.plugins, expectedDisabledPlugins);
    assert.equal(wire.parallel_tool_calls, undefined);
    assert.equal(wire.tool_choice, 'required');
    assert.equal(wire.max_tokens, 200);
    assert.equal(wire.max_completion_tokens, undefined);
    assert.equal(wire.provider.require_parameters, true);
    assert.equal(wire.provider.zdr, true);
    assert.equal(wire.provider.data_collection, 'deny');
    assert.equal(wire.provider.allow_fallbacks, false);
    if (traces.length === 1) {
      // OpenRouter Router Metadata, No Providers Available (404).
      return Response.json({
        error: { code: 404, message: document, metadata: {
          error_type: 'not_found', failed_routing_step: 'Filter by Max Price', raw: { echo: document, api_key: secret },
        } },
        openrouter_metadata: {
          attempt: 0, endpoints: { total: 1, available: [{ selected: false }] },
          pipeline: [{ data: { matched: document } }],
        },
      }, { status: 404, headers: { 'X-Request-Id': 'req-1727282430-syntheticTest', 'Set-Cookie': secret } });
    }
    return Response.json({
      error: { code: 404, message: document, metadata: { error_type: secret, failed_routing_step: document } },
    }, { status: 404, headers: { 'X-Request-Id': secret } });
  });
  const request = { model: profile.model, messages: [{ role: 'user', content: document }], max_tokens: 200,
    tool_choice: 'required', parallel_tool_calls: false,
    tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object' } } }],
  };
  const firstInput = { ...call(firstWorker, route.id), inputRefs: [], request };
  const first = isHeld(await gateway.call(firstInput), 'unknown_charge');
  const second = isHeld(await gateway.call({ ...call(secondWorker, secondRoute.id), inputRefs: [], request }),
    'unknown_charge');
  assert.deepEqual(traces, [first.attemptId, second.attemptId]);

  const expected = {
    traceId: first.attemptId, httpStatus: 404, errorCode: 404, errorType: 'not_found', failedRoutingStep: 'max_price',
    routerAttempt: 0, requestId: 'req-1727282430-syntheticTest', stage: 'before_provider',
  };
  const unknown = { traceId: second.attemptId, httpStatus: 404, errorCode: 404, stage: 'undetermined' };
  const logs = await s.read();
  for (const ledger of [logs.app, logs.external]) {
    assert.deepEqual(ledger[0].receipt.routerDiagnostic, expected);
    assert.deepEqual(ledger[1].receipt.routerDiagnostic, unknown);
    assert.deepEqual(ledger.map(row => row.state), ['unknown','unknown']);
    assert.ok(!JSON.stringify(ledger).includes(secret) && !JSON.stringify(ledger).includes(document));
  }
  const diagnostic = await gateway.diagnostics(ref.projectId);
  assert.deepEqual(diagnostic.attempts.find(row => row.id === first.attemptId).routerDiagnostic, expected);
  assert.ok(!JSON.stringify(diagnostic).includes(secret) && !JSON.stringify(diagnostic).includes(document));
  assert.equal(logs.budget.spentUsdNanos, 0);
  assert.ok(logs.budget.reserveUsdNanos > 0);

  const restarted = new Gateway(s.db, s.journal, transport);
  assert.equal(isHeld(await restarted.call(firstInput), 'unknown_charge').attemptId, first.attemptId);
  const verified = await restarted.reconcile(actor, {
    attemptId: first.attemptId!, operationKey: 'fixture-verified-pre-provider', reasonRef: 'test:correlated-router-trace',
    resolution: { state: 'rejected', code: 'routing_refused', evidenceRef: 'test:no-provider-attempt' },
  });
  assert.equal(verified.state, 'rejected');
  assert.deepEqual(verified.receipt?.routerDiagnostic, expected);
  const final = await s.journal.balance();
  assert.ok(final.reserveUsdNanos < logs.budget.reserveUsdNanos && final.reserveUsdNanos > 0);
  assert.equal(fetchSpy.mock.callCount(), 2);
  t.diagnostic('documented 404 and generic 404 retained reserves; the operator settled only the correlated fixture');
});
