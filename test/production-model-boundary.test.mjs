import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadResearchProfile } from '../dist/src/modules/harness/profile.js';
import { openRouterTransport } from '../dist/src/modules/gateway/openrouter.js';
import { startManagedTransport } from './acceptance/package-intake/managed-transport.mjs';

test('production invocation rejects managed environment and arguments before opening the database', () => {
  for (const role of ['api', 'worker']) {
    const main = fileURLToPath(new URL(`../dist/apps/${role}/src/main.js`, import.meta.url));
    const env = { PATH: process.env.PATH, FACADE_HARNESS_MANAGED_URL: 'http://127.0.0.1:1/replay' };
    const override = spawnSync(process.execPath, [main], { env, encoding: 'utf8' });
    assert.equal(override.status, 1);
    assert.match(override.stderr, /Managed model endpoints require the isolated test entrypoint/);
    for (const profile of [
      { FACADE_HARNESS_PROFILE: JSON.stringify({ lead: { model: 'managed/lead' } }) },
      { FACADE_COPILOT_PROFILE: JSON.stringify({ model: 'managed/copilot' }) },
    ]) {
      const profiles = spawnSync(process.execPath, [main], { env: { PATH: process.env.PATH, ...profile }, encoding: 'utf8' });
      assert.equal(profiles.status, 1);
      assert.match(profiles.stderr, /Managed model profiles require the isolated test entrypoint/);
    }
    const cli = spawnSync(process.execPath, [main, '--managed'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Unexpected runtime arguments/);
    const insecure = spawnSync(process.execPath, [main], {
      env: { PATH: process.env.PATH, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, encoding: 'utf8',
    });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /Runtime requires TLS certificate verification/);
  }
  assert.deepEqual(loadResearchProfile({}), { A: null, B: null, lead: null });
});

test('OpenRouter accepts exact official origins and refuses endpoint overrides without a network call', () => {
  const approval = { qualification: 'step-15', apiKey: 'test-key', profiles: [{
    routeId: 'a', revision: 'v1', model: 'moonshotai/kimi-k3.1-pro', provider: 'wafer/us',
    expectedResponseProvider: 'Wafer', mode: 'strict-zdr', zdrEvidenceRef: 'fixture:zdr',
    boundEvidenceRef: 'fixture:rates', validUntil: '2099-01-01T00:00:00Z', knownNoChargeStatuses: [],
    inputTokenUpperBound: 1000, outputTokenLimit: 500, maxImages: 0,
    maxImagePixels: 0, maxImageWidth: 0, maxImageHeight: 0, maxImageBytes: 0,
    promptNanosPerToken: 100, completionNanosPerToken: 200, cacheReadNanosPerToken: 15,
    cacheWriteNanosPerToken: 125, cacheBilling: 'replaces-input', reasoningNanosPerToken: 300,
    reasoningBilling: 'replaces-output', completionCapIncludesReasoning: true, completionParameter: 'max_tokens',
    requestNanos: 0, imageNanos: 0, additionalNanos: 0,
  }] };
  for (const endpoint of ['https://openrouter.ai', 'https://eu.openrouter.ai', 'https://us.openrouter.ai']) {
    assert.equal(openRouterTransport({ ...approval, endpoint }).kind, 'openrouter');
  }
  for (const endpoint of ['http://127.0.0.1:1', 'https://openrouter.ai.evil.test', 'https://openrouter.ai/',
    'https://openrouter.ai:443', 'https://openrouter.ai@127.0.0.1']) {
    assert.throws(() => openRouterTransport({ ...approval, endpoint }), /step15_approval_required/);
  }
});

test('managed transport continues past fifteen and exposes the remainder before closure', async (t) => {
  const projectId = randomUUID();
  const source = { projectId, versionId: randomUUID(), documentId: randomUUID(), sha256: 'b'.repeat(64) };
  const place = { source, unitId: 'window-1' };
  const lines = Array.from({ length: 17 }, (_, i) => ({ id: `${i + 1}`, text: `Thickness: ${i + 1} mm` }));
  const content = JSON.stringify({ lines });
  const evidence = { place, evidenceId: randomUUID(), sha256: createHash('sha256').update(content).digest('hex') };
  const trace = [];
  const errors = [];
  const server = startManagedTransport({ projects: new Set([projectId]), onExchange: (turn) => trace.push(turn),
    onError: (error) => errors.push(error) });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const calls = [{ id: 'extract', function: { name: 'extract', arguments: '{}' } }];
  const replies = [{ tool_call_id: 'extract', role: 'tool', content: JSON.stringify({ content, evidence }) }];
  const attempt = { projectId, jobId: randomUUID(), purpose: 'primary_a' };
  for (let turn = 0; turn <= lines.length; turn++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST', body: JSON.stringify({ attempt: { ...attempt, id: randomUUID() }, routeId: 'managed-a',
        request: { model: 'managed/a', messages: [{ role: 'system' },
          { role: 'user', content: JSON.stringify({ mode: 'primary', objective: 'package_primary', place }) },
          { role: 'assistant', tool_calls: calls }, ...replies],
        tools: ['save_observation', 'finish_reading'].map((name) => ({ function: { name } })) } }),
    });
    assert.deepEqual(errors, []);
    assert.equal(response.status, 200);
    const { output } = await response.json();
    const [call] = output.choices[0].message.tool_calls;
    if (turn < lines.length) {
      assert.equal(call.function.name, 'save_observation');
      assert.equal(JSON.parse(call.function.arguments).lineId, lines[turn].id);
      calls.push(call);
      replies.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ observationId: randomUUID(), qualified: true }) });
    } else {
      assert.equal(call.function.name, 'finish_reading');
      assert.equal(JSON.parse(call.function.arguments).status, 'covered');
    }
  }
  assert.deepEqual(trace.map(({ remainingCandidates }) => remainingCandidates),
    [...lines.map((_, i) => lines.length - i - 1), 0]);
});
