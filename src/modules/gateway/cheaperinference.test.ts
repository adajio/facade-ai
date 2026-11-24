import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { cheaperInferenceTransport, terraModel, type CheaperInferenceProfile } from './cheaperinference.js';
import type { Attempt, ModelAuthorization, RoutePolicy } from './types.js';

const sha256 = 'a'.repeat(64);
const scope = { projectId: randomUUID(), scopeId: null, approvalRef: 'fixture', originalSha256s: [sha256] };
const profile: CheaperInferenceProfile = {
  transport: 'cheaperinference', routeId: 'terra', revision: 'fixture', mode: 'strict-zdr', model: terraModel,
  boundEvidenceRef: 'fixture:maker-rates', zdrEvidenceRef: 'fixture:zdr',
  validUntil: '2099-01-01T00:00:00Z', syntheticScopes: [scope],
  inputNanosPerToken: 2_500, outputNanosPerToken: 7_500, outputTokenLimit: 2_048,
  maxImages: 1, maxImageBytes: 1024, maxImageWidth: 32, maxImageHeight: 32, maxImagePixels: 1024,
};
const route: RoutePolicy = { id: profile.routeId, revision: profile.revision, transport: 'cheaperinference',
  enabled: true, maxRequestBytes: 20_000_000, ceilingUsdNanos: 3_000_000_000, timeoutMs: 5_000 };
const request = { model: terraModel, max_tokens: 2_048, stream: false, parallel_tool_calls: false, tool_choice: 'required',
  messages: [{ role: 'user', content: [{ type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRxoAAAAASUVORK5CYII=' } }] }],
  tools: [{ type: 'function', function: { name: 'extract', parameters: { type: 'object' } } }] };
const key = 'ci_' + 'live_' + 'local_fixture';
const transport = cheaperInferenceTransport({ apiKey: key, profiles: [profile] });

test('the direct transport bounds the request and verifies the approved originals and evidence', async () => {
  const quote = transport.quote!(route, request);
  assert.equal(quote?.ceilingUsdNanos, 2_640_361_000);
  assert.equal(transport.quote!({ ...route, ceilingUsdNanos: quote!.ceilingUsdNanos - 1 }, request), null);
  assert.equal(transport.quote!({ ...route, revision: 'other' }, request), null);
  assert.equal(transport.quote!(route, { ...request, model: 'gpt-6.2-sol' }), null);
  assert.equal(transport.quote!(route, { ...request, messages: [{ role: 'user', content: [{ type: 'image_url',
    image_url: { url: 'https://example.invalid/a.png' } }] }] }), null);
  assert.throws(() => cheaperInferenceTransport({ apiKey: 'wrong-provider-fixture', profiles: [profile] }),
    { code: 'cheaperinference_key_required' });
  const unsupportedProfile = { ...profile, reasoningEffort: 'low' };
  assert.throws(() => cheaperInferenceTransport({ apiKey: key, profiles: [unsupportedProfile] }),
    { code: 'invalid_cheaperinference_profile' });

  const source = { projectId: scope.projectId, versionId: randomUUID(), documentId: randomUUID(), sha256 };
  const context: ModelAuthorization = { projectId: scope.projectId, scopeId: null, jobId: randomUUID(),
    generationId: randomUUID(), dataClass: 'synthetic', payload: { mode: 'primary', branch: 'A', place: { source } },
    inputRefs: [randomUUID()] };
  let inspected = 0;
  const db = { query: async (_sql: string, args: unknown[]) => {
    inspected++;
    assert.deepEqual(args[1], [sha256]);
    assert.deepEqual(args[5], context.inputRefs);
    return { rows: [{ authorized: true }] };
  } } as unknown as PoolClient;
  assert.equal(await transport.authorize!(db, route, context), true);
  assert.equal(await transport.authorize!(db, route, { ...context, scopeId: randomUUID() }), false);
  assert.equal(await transport.authorize!(db, route, { ...context, dataClass: 'client' }), false);
  assert.equal(await transport.authorize!(db, route, { ...context,
    payload: { mode: 'primary', branch: 'A', place: { source: { ...source, sha256: 'b'.repeat(64) } } },
  }), false);
  assert.equal(inspected, 1);
});

test('direct HTTP verifies settled billing and model identity without retrying unknown outcomes', async t => {
  const quote = transport.quote!(route, request)!;
  const attempt: Attempt = { id: randomUUID(), projectId: scope.projectId, scopeId: scope.scopeId,
    generationId: randomUUID(), jobId: randomUUID(), purpose: 'primary_a', effectKey: 'fixture',
    requestHash: sha256, routeId: route.id, revision: route.revision, dataClass: 'synthetic',
    previousRejectedId: null, ...quote };
  const id = randomUUID();
  const receipt = { request_id: id, model: terraModel, usage: { prompt_tokens: 100, completion_tokens: 17 },
    billing: { status: 'settled', currency: 'USD', billed_cost_usd: '0.001234' }, choices: [{ message: { role: 'assistant' } }] };
  let next = Response.json(receipt, { headers: { 'x-ci-request-id': id } });
  const fetcher = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.cheaperinference.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { authorization: 'Bearer ' + key, 'content-type': 'application/json',
      'x-ci-model-lock': '1', 'x-ci-techniques': 'off' });
    const { parallel_tool_calls: _omitted, ...expected } = request;
    assert.deepEqual(JSON.parse(String(options.body)), { ...expected, zdr: true, min_discount_percent: 0 });
    return next;
  });
  const send = (a = attempt) => transport.send(a, route, request, new AbortController().signal);
  const paid = await send();
  assert.deepEqual(paid.receipt, { state: 'paid', model: terraModel, provider: 'CheaperInference',
    providerId: 'cheaperinference:' + id, evidenceRef: 'cheaperinference:' + id, costUsdNanos: 1_234_000,
    routeVerified: true, promptTokens: 100, completionTokens: 17 });
  assert.deepEqual(paid.output, { choices: receipt.choices });

  next = Response.json({ ...receipt, model: 'unapproved-model' });
  const mismatch = await send();
  assert.equal(mismatch.receipt.state, 'paid');
  assert.equal(mismatch.receipt.state === 'paid' && mismatch.receipt.routeVerified, false);
  assert.equal(mismatch.output, undefined);

  next = Response.json(receipt, { headers: { 'x-ci-request-id': randomUUID() } });
  assert.equal((await send()).receipt.state, 'unknown');

  next = Response.json({ error: { code: 'unknown' } }, { status: 503, headers: { 'x-ci-request-id': id } });
  assert.deepEqual((await send()).receipt,
    { state: 'unknown', code: 'cheaperinference_http_503', providerId: 'cheaperinference:' + id });
  next = Response.json({ error: { code: 'zdr_capacity_unavailable' } }, { status: 503 });
  assert.equal((await send()).receipt.state, 'rejected');

  assert.equal((await send({ ...attempt, pricingFingerprint: sha256 })).receipt.state, 'rejected');
  assert.equal(fetcher.mock.callCount(), 5);
});
