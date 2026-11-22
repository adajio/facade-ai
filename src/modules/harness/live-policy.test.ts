import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Branch, ResearchSettings, ResearchTask } from './contracts.js';
import { validateLivePolicy, type LiveRoute } from './live-policy.js';
import { loadResearchProfile } from './profile.js';

const projectId = randomUUID();
const scopeId = randomUUID();
const approvedHash = 'a'.repeat(64);
const testedScope = { projectId, scopeId, approvalRef: 'qualification/fixture', originalSha256s: [approvedHash] };
const kimi: LiveRoute = {
  syntheticScopes: [testedScope], routeId: 'kimi', model: 'moonshotai/kimi-fixture', provider: 'wafer/us',
  mode: 'synthetic-research', zdrEvidenceRef: 'qualification/zdr',
};
const qwen: LiveRoute = {
  syntheticScopes: [testedScope], routeId: 'qwen', model: 'qwen/qwen-fixture', provider: 'alibaba', mode: 'synthetic-research',
};
const settings = ({ routeId, model }: LiveRoute) =>
  ({ routeId, model, dataClass: 'synthetic', maxTokens: 600, maxTurns: 12, maxKnownRejections: 1 });
const profile = { A: settings(kimi), B: settings(qwen), lead: settings(kimi) };
const env = { FACADE_HARNESS_LIVE_POLICY: 'synthetic-research' };
function task(branch: Branch, assigned: ResearchSettings = profile[branch]): ResearchTask {
  return {
    jobId: randomUUID(), generationId: randomUUID(), projectId, scopeId,
    job: { mode: 'primary', branch, settings: assigned, place: {
      source: { projectId, documentId: randomUUID(), versionId: randomUUID(), sha256: approvedHash },
      unitId: '1', page: 1,
    } },
  };
}

test('the Decart endpoint requires the exact synthetic Kimi route, ZDR approval and auto', () => {
  const decart = { ...kimi, routeId: 'kimi-decart', model: 'moonshotai/kimi-k3.1-pro', provider: 'decart/mxfp4' };
  const assigned = { ...settings(decart), toolChoice: 'auto' as const };
  const selected = { ...profile, A: assigned };
  assert.equal(validateLivePolicy(selected, [decart, qwen], env).hold(task('A', assigned)), null);
  assert.deepEqual(validateLivePolicy(selected, [{ ...decart, zdrEvidenceRef: undefined }, qwen], env).approvals, [qwen]);
  assert.deepEqual(validateLivePolicy(selected, [{ ...decart, provider: 'decart' }, qwen], env).approvals, [qwen]);
  assert.deepEqual(validateLivePolicy(selected, [{ ...decart, mode: 'strict-zdr' }], {}).approvals, []);
  assert.deepEqual(validateLivePolicy({ ...selected, A: settings(decart) }, [decart, qwen], env).approvals, [qwen]);
  assert.equal(validateLivePolicy(selected, [decart], env).hold(task('A', settings(decart)))?.reason,
    'research_profile_changed');
  const wafer = { ...decart, routeId: 'kimi-wafer', provider: 'wafer/us' };
  const waferAuto = { ...settings(wafer), toolChoice: 'auto' as const };
  assert.deepEqual(validateLivePolicy({ ...profile, A: waferAuto }, [wafer], env).approvals, [wafer]);
  assert.deepEqual(loadResearchProfile({ FACADE_HARNESS_PROFILE: JSON.stringify({ A: waferAuto, B: assigned }) }),
    { A: null, B: null, lead: null });
});

test('synthetic authorization follows the exact approved project, scope, route and original', () => {
  const { hold } = validateLivePolicy(profile, [kimi, qwen], env);
  const job = task('B');
  assert.equal(hold(job), null);
  assert.equal(hold({ ...job, scopeId: randomUUID() })?.reason, 'synthetic_input_not_approved');
  assert.equal(hold({ ...job, projectId: randomUUID() })?.reason, 'synthetic_input_not_approved');
  if (job.job.mode !== 'primary') return assert.fail();
  const source = { ...job.job.place.source, sha256: 'b'.repeat(64) };
  assert.equal(hold({ ...job, job: { ...job.job, place: { ...job.job.place, source } } })?.reason,
    'synthetic_input_not_approved');
  assert.equal(hold({
    ...job, job: { ...job.job, settings: { ...job.job.settings, dataClass: 'unknown' } },
  })?.reason, 'research_profile_changed');
});

test('A-only, B-only and zero approvals never route an unavailable branch through a neighbor', () => {
  for (const [allowed, blocked, approved] of [['A', 'B', kimi], ['B', 'A', qwen]] as const) {
    const policy = validateLivePolicy(profile, [approved], env);
    assert.deepEqual(policy.approvals, [approved]);
    assert.equal(policy.hold(task(allowed)), null);
    assert.equal(policy.hold(task(blocked))?.reason, 'research_route_not_approved');
    const substitute = task(blocked);
    assert.equal(policy.hold({ ...substitute, job: { ...substitute.job, settings: profile[allowed] } })?.reason,
      'research_profile_changed');
  }
  const empty = validateLivePolicy(profile, [], env);
  assert.deepEqual(empty.approvals, []);
  assert.equal(empty.hold(task('A'))?.reason, 'research_route_not_approved');
  assert.equal(empty.hold(task('B'))?.reason, 'research_route_not_approved');
});

test('policy, envelope and configuration failures are isolated to the affected branch', () => {
  const strict = validateLivePolicy(profile, [kimi, qwen], {});
  assert.deepEqual(strict.approvals, []);
  const neither = validateLivePolicy(profile, [{ ...kimi, zdrEvidenceRef: undefined }, { ...qwen, provider: 'other' }], env);
  assert.deepEqual(neither.approvals, []);
  const damaged = validateLivePolicy(profile, [kimi, qwen], env, (route) => route !== kimi);
  assert.deepEqual(damaged.approvals, [qwen]);
  const liveEnv = { FACADE_GATEWAY_LIVE_MODE: 'step-15' };
  const half = loadResearchProfile({
    ...liveEnv, FACADE_HARNESS_PROFILE: JSON.stringify({ A: { routeId: 'broken' }, B: profile.B }),
  });
  assert.deepEqual(half, { A: null, B: profile.B, lead: null });
  assert.deepEqual(loadResearchProfile(liveEnv), { A: null, B: null, lead: null });
  assert.equal(validateLivePolicy(half, [qwen], env).hold(task('A'))?.reason, 'research_profile_unavailable');
  const duplicate = loadResearchProfile({ ...liveEnv, FACADE_HARNESS_PROFILE: JSON.stringify({ A: profile.B, B: profile.B }) });
  assert.deepEqual(duplicate, { A: null, B: null, lead: null });
});
