import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { qwen4Max, terraModel } from '../gateway/index.js';
import type { Branch, Citation, ResearchSettings, ResearchTask } from './contracts.js';
import { validateLivePolicy, type LiveRoute } from './live-policy.js';
import { loadResearchProfile, profileHold } from './profile.js';

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
  assert.deepEqual(loadResearchProfile({ ...liveEnv, FACADE_HARNESS_PROFILE: '{}' }), { A: null, B: null, lead: null });
  assert.equal(validateLivePolicy(half, [qwen], env).hold(task('A'))?.reason, 'research_profile_unavailable');
  const duplicate = loadResearchProfile({ ...liveEnv, FACADE_HARNESS_PROFILE: JSON.stringify({ A: profile.B, B: profile.B }) });
  assert.deepEqual(duplicate, { A: null, B: null, lead: null });
});

test('the new defaults require independent approvals and leave saved pilot assignments and lead explicit', () => {
  const defaults = loadResearchProfile({});
  assert.deepEqual([defaults.A?.model, defaults.B?.model, defaults.lead], ['gpt-6.1-terra', qwen4Max, null]);
  assert.deepEqual(loadResearchProfile({ FACADE_HARNESS_PROFILE: JSON.stringify(profile) }), profile);
  assert.equal(profileHold(defaults, task('A'))?.reason, 'research_profile_changed');
  assert.equal(profileHold(defaults, task('B'))?.reason, 'research_profile_changed');
  assert.ok(defaults.A && defaults.B);
  assert.equal(defaults.B.routeId, 'openrouter-alibaba-qwen4-max-reader');
  const direct: LiveRoute = { transport: 'cheaperinference', routeId: defaults.A.routeId, model: 'gpt-6.1-terra',
    mode: 'strict-zdr', zdrEvidenceRef: 'fixture', syntheticScopes: [testedScope] };
  const pinned = { transport: 'openrouter', provider: 'alibaba', routeId: defaults.B.routeId, model: qwen4Max,
    mode: 'synthetic-research', syntheticScopes: [testedScope] } as const satisfies LiveRoute;
  const synthetic = validateLivePolicy(defaults, [direct, pinned], env);
  assert.equal(synthetic.hold(task('A', defaults.A)), null);
  assert.equal(synthetic.hold(task('B', defaults.B)), null);
  const withPilot = validateLivePolicy(defaults, [direct, pinned, kimi], env);
  assert.equal(withPilot.hold(task('A'))?.reason, 'research_profile_changed');
  assert.equal(withPilot.hold(task('A'), true), null);
  assert.equal(synthetic.hold(task('A'), true)?.reason, 'research_profile_changed');
  assert.deepEqual(validateLivePolicy(defaults, [direct, pinned], {}).approvals, [direct]);
  const strictQwen = { ...qwen, routeId: pinned.routeId, model: pinned.model, mode: 'strict-zdr' as const, zdrEvidenceRef: 'fixture' };
  assert.deepEqual(validateLivePolicy(defaults, [direct, strictQwen], {}).approvals, [direct]);
  const customer = { A: { ...defaults.A, dataClass: 'customer' }, B: { ...defaults.B, dataClass: 'customer' }, lead: null };
  assert.deepEqual(validateLivePolicy(customer, [direct, pinned], env).approvals, []);
  const previousQwen = { ...qwen, routeId: 'openrouter-alibaba-qwen38-max-reader', model: 'qwen/qwen3.8-max-0902' };
  const previousTask = task('B', settings(previousQwen));
  const withPrevious = validateLivePolicy(defaults, [direct, pinned, previousQwen], env);
  assert.equal(withPrevious.hold(previousTask)?.reason, 'research_profile_changed');
  assert.equal(withPrevious.hold(previousTask, true), null);
  const previousFeatherless = { transport: 'featherless', mode: 'synthetic-research', syntheticScopes: [testedScope], routeId: 'featherless-qwen38-2.4t-a95b-reader', model: 'Qwen/Qwen3.8-2.4T-A95B' } as const;
  const previousFeatherlessTask = task('B', { ...settings(previousFeatherless), toolChoice: 'auto' });
  assert.equal(validateLivePolicy(defaults, [direct, pinned, previousFeatherless], env).hold(previousFeatherlessTask, true), null);
  assert.equal(validateLivePolicy(defaults, [direct, pinned], env).hold(previousFeatherlessTask, true)?.reason,
    'research_profile_changed');
  assert.deepEqual(validateLivePolicy(defaults, [direct, { ...pinned, provider: 'novita' }], env).approvals, [direct]);
  assert.deepEqual(validateLivePolicy({ A: null, B: null, lead: defaults.A }, [direct], env).approvals, []);
});

test('a strict ZDR reference alone does not authorize customer data', () => {
  const customer = { ...settings(kimi), dataClass: 'customer' };
  const unqualified = { ...kimi, mode: 'strict-zdr' as const };
  const policy = validateLivePolicy({ A: customer, B: null, lead: null }, [unqualified], {});
  assert.deepEqual(policy.approvals, []);
  assert.equal(policy.hold(task('A', customer))?.reason, 'research_route_not_approved');
});

test('the lead needs a third model and route without disabling the readers', () => {
  const sharedModel = { ...kimi, routeId: 'same-model' };
  const sharedRoute = { ...kimi, model: 'moonshotai/kimi-another' };
  for (const reused of [kimi, sharedModel, sharedRoute]) {
    const approvals: LiveRoute[] = reused === kimi ? [kimi, qwen] : [kimi, qwen, reused];
    const policy = validateLivePolicy({ ...profile, lead: settings(reused) }, approvals, env);
    assert.deepEqual(policy.approvals.map(({ routeId, model }) => [routeId, model]),
      [[kimi.routeId, kimi.model], [qwen.routeId, qwen.model]]);
    assert.equal(policy.hold(task('A')), null);
    assert.equal(policy.hold(task('B')), null);
  }
});

test('lead and both verifiers require the approved scope and both originals', () => {
  const third = { ...kimi, routeId: 'lead', model: 'moonshotai/kimi-third-fixture' };
  const configuration = { ...profile, lead: settings(third) };
  const { hold } = validateLivePolicy(configuration, [kimi, qwen, third], env);
  const primary = task('A');
  assert.ok(primary.job.mode === 'primary');
  const { place } = primary.job;
  const citation = <T extends Branch>(branch: T): Citation & { branch: T } => ({
    branch, place,
    observationId: randomUUID(), evidenceId: randomUUID(), quote: 'Thickness 2 mm', value: '2', unit: 'mm',
  });
  const dispute = { id: randomUUID(), question: { subject: 'F-A', property: 'Thickness' }, a: citation('A'), b: citation('B') };
  const proposal = { aObservationId: dispute.a.observationId, bObservationId: dispute.b.observationId, explanation: 'Fixture' };
  const jobs = [
    { mode: 'lead', settings: configuration.lead, dispute },
    { mode: 'verify', branch: 'A', settings: configuration.A, dispute, proposal },
    { mode: 'verify', branch: 'B', settings: configuration.B, dispute, proposal },
  ] as const;
  const b = { ...dispute.b, place: { ...dispute.b.place, source: { ...dispute.b.place.source, sha256: 'b'.repeat(64) } } };
  for (const job of jobs) {
    const review: ResearchTask = { ...primary, job };
    assert.equal(hold(review), null);
    assert.equal(hold({ ...review, scopeId: randomUUID() })?.reason, 'synthetic_input_not_approved');
    assert.equal(hold({ ...review, job: { ...job, dispute: { ...dispute, b } } })?.reason, 'synthetic_input_not_approved');
    assert.equal(hold({ ...review, job: { ...job, settings: { ...job.settings, dataClass: 'customer' } } }, true)?.reason,
      'research_profile_changed');
  }
});

test('customer admission is explicit for Terra, Qwen4 Max and the Wafer lead and pins original identity', () => {
  const customerAccess = {
    keyFingerprint: 'f'.repeat(64), evidenceRef: 'qualification/fixture', validUntil: '2099-01-01T00:00:00Z',
    scopes: [{ ...testedScope, allowImages: true }],
  };
  const A = { transport: 'cheaperinference', routeId: 'customer-a', model: terraModel,
    mode: 'strict-zdr', zdrEvidenceRef: 'qualification/zdr', customerAccess } satisfies LiveRoute;
  const B = { transport: 'openrouter', routeId: 'customer-b', model: qwen4Max, provider: 'alibaba',
    mode: 'customer-retention-approved', customerAccess: { ...customerAccess, retentionApproved: true } } satisfies LiveRoute;
  const leader = { ...kimi, routeId: 'customer-lead', model: 'moonshotai/kimi-k3.1-pro', mode: 'strict-zdr',
    customerAccess: { ...customerAccess, guardrailId: randomUUID(), excludesSafetyRetention: true } } satisfies LiveRoute;
  const setting = (route: LiveRoute) => ({ ...settings(route), dataClass: 'customer' });
  const configured = { A: setting(A), B: { ...setting(B), toolChoice: 'required' as const }, lead: setting(leader) };
  const all = [A, B, leader];
  assert.deepEqual(validateLivePolicy(configured, all, env).approvals, []);
  const customerEnv = { FACADE_HARNESS_LIVE_POLICY: 'customer' };
  const admitted = validateLivePolicy(configured, all, customerEnv);
  assert.deepEqual(admitted.approvals, all);
  assert.deepEqual(validateLivePolicy(configured, [A, { ...B, customerAccess: undefined }, leader], customerEnv).approvals, [A, leader]);
  const job = task('B', configured.B);
  assert.equal(admitted.hold(job), null);
  assert.equal(admitted.hold({ ...job, projectId: randomUUID() })?.reason, 'customer_input_not_approved');
  assert.equal(admitted.hold({ ...job, scopeId: randomUUID() })?.reason, 'customer_input_not_approved');
  assert.deepEqual(validateLivePolicy(configured, [A, B, { ...leader, customerAccess: undefined }], customerEnv).approvals, [A, B]);
  assert.deepEqual(validateLivePolicy(configured, [A, { ...B, customerAccess: {
    ...B.customerAccess, validUntil: '2000-01-01T00:00:00Z',
  } }, leader], customerEnv).approvals, [A, leader]);
});
