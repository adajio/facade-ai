import assert from 'node:assert/strict';
import { test } from 'node:test';
import { featherlessQwenModel, featherlessTransport, type FeatherlessProfile } from './featherless.js';
import type { Attempt, RoutePolicy } from './types.js';

const projectId = '12300000-0000-4000-8000-000000000001';
const scopeId = '12300000-0000-4000-8000-000000000002';
const profile = {
  transport: 'featherless', routeId: 'synthetic-featherless', revision: 'fixture-r1',
  model: featherlessQwenModel, mode: 'synthetic-research',
  syntheticScopes: [{ projectId, scopeId, originalSha256s: ['a'.repeat(64)], approvalRef: 'synthetic-fixture' }],
  boundEvidenceRef: 'fixture-catalog', validUntil: '2099-01-01T00:00:00Z',
  contextTokens: 262_144, outputTokenLimit: 32_768, inputNanosPerToken: 1_000, outputNanosPerToken: 4_000,
} satisfies FeatherlessProfile;
const route: RoutePolicy = {
  id: profile.routeId, revision: profile.revision, transport: 'featherless', enabled: true,
  ceilingUsdNanos: 400_000_000, maxRequestBytes: 65_536, timeoutMs: 100,
};
const request = {
  model: featherlessQwenModel, max_tokens: 1_000, stream: false, parallel_tool_calls: false, tool_choice: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic input' }] }],
  tools: [{ type: 'function', function: { name: 'read_source', parameters: { type: 'object' } } }],
};
const credential = { apiKey: 'fixture-inference-key', profiles: [profile] };

test('Featherless uses the direct text endpoint and settles only the reported and verified cost', async (t) => {
  const transport = featherlessTransport(credential);
  const quote = transport.quote!(route, request);
  assert.ok(quote);
  assert.equal(quote.ceilingUsdNanos, 266_145_000);
  const attempt: Attempt = {
    id: 'attempt', jobId: 'job', generationId: 'generation', projectId, scopeId, purpose: 'primary_b',
    effectKey: 'fixture', requestHash: 'sha', routeId: route.id, revision: route.revision,
    previousRejectedId: null, dataClass: 'synthetic', ...quote,
  };
  const choices = [{ message: { role: 'assistant', content: 'result' } }];
  const baseReceipt = { id: 'receipt-123', model: featherlessQwenModel, choices };
  const reply = t.mock.method(globalThis, 'fetch', async () => Response.json(baseReceipt));
  const signal = new AbortController().signal;
  for (const denied of [{ ...attempt, scopeId: 'other' }, { ...attempt, purpose: 'primary_a' as const },
    { ...attempt, dataClass: 'customer' }, { ...attempt, revision: 'different' }]) {
    assert.equal((await transport.send(denied, route, request, signal)).receipt.state, 'rejected');
  }
  assert.equal(reply.mock.callCount(), 0);
  assert.deepEqual(await transport.send(attempt, route, request, signal), {
    receipt: { state: 'unknown', code: 'featherless_billing_unconfirmed', providerId: 'featherless:receipt-123' },
  });
  const args = reply.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(args[0], 'https://api.featherless.ai/v1/chat/completions');
  assert.equal(args[1].redirect, 'error');
  assert.equal(new Headers(args[1].headers).get('authorization'), 'Bearer fixture-inference-key');
  const wire = JSON.parse(String(args[1].body));
  assert.equal(wire.model, featherlessQwenModel);
  assert.equal(wire.messages[0].content, 'synthetic input');
  assert.equal(wire.tool_choice, 'auto');
  assert.equal(Object.hasOwn(wire, 'parallel_tool_calls'), false);

  const usage = { cost: 0.0000125, prompt_tokens: 8, completion_tokens: 2 };
  reply.mock.mockImplementation(async () => Response.json({ ...baseReceipt, usage }));
  const result = await transport.send(attempt, route, request, signal);
  assert.deepEqual(result.output, { choices });
  assert.equal(result.receipt.state, 'paid');
  assert.equal(result.receipt.costUsdNanos, 12_500);
  assert.equal(result.receipt.routeVerified, true);
  reply.mock.mockImplementation(async () => Response.json({ ...baseReceipt, model: 'other', usage }));
  const mismatch = await transport.send(attempt, route, request, signal);
  assert.equal(mismatch.output, undefined);
  assert.equal(mismatch.receipt.state, 'paid');
  assert.equal(mismatch.receipt.routeVerified, false);
});

test('Featherless rejects image inputs, route mismatches and understated price before the request', () => {
  const transport = featherlessTransport(credential);
  assert.equal(transport.quote!(route, {
    ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
  }), null);
  assert.equal(transport.quote!(route, { ...request, tool_choice: 'required' }), null);
  assert.equal(transport.quote!({ ...route, transport: 'openrouter' }, request), null);
  assert.equal(transport.quote!({ ...route, ceilingUsdNanos: 10 }, request), null);
  assert.throws(() => featherlessTransport({ ...credential, profiles: [{ ...profile, inputNanosPerToken: 999 }] }),
    /invalid_featherless_profile/);
});
