import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { advance } from '/app/dist/src/modules/harness/session.js';

const sha = (content) => createHash('sha256').update(content).digest('hex');
const projectId = randomUUID();
const citation = (branch, value) => ({
  branch, observationId: randomUUID(), evidenceId: randomUUID(), quote: `Thickness ${value} mm`,
  value, unit: 'mm', place: { unitId: '1', page: 1, source: {
    projectId, documentId: randomUUID(), versionId: randomUUID(), sha256: sha(branch),
  } },
});
const a = citation('A', '2');
const b = citation('B', '3');
const dispute = { id: randomUUID(), question: { id: randomUUID(), subject: 'F-A', property: 'Thickness' }, a, b };
const labels = {
  both: { A: 'Revision R1 F-A Variant A', B: 'Revision R2 F-A Variant B' },
  revision: { A: 'Revision R1 F-A Variant A', B: 'Revision R2 F-A Variant A' },
  variant: { A: 'Revision R1 F-A Variant A', B: 'Revision R1 F-A Variant B' },
  scope: { A: 'Revision R1 Variant A | Scope: F-A', B: 'Revision R1 Variant A | Scope: F-B' },
  inactive: { A: 'Revision R1 Variant A | Scope: F-A', B: 'Revision R1 Variant A | Scope: F-A | obsolete' },
  matching: { A: 'Revision R1 F-A Variant A', B: 'Revision R1 F-A Variant A' },
  differentCurrent: { A: 'Current Revision R1 | Scope: F-A | Variant A', B: 'Current Revision R2 | Scope: F-A | Variant A' },
};

async function verification(lines, status) {
  const task = {
    projectId, scopeId: randomUUID(), generationId: randomUUID(), jobId: randomUUID(), earlyPair: true, pairScopeName: 'F-A',
    job: { mode: 'verify', branch: 'B', dispute,
      proposal: { aObservationId: a.observationId, bObservationId: b.observationId, explanation: 'Controlled hypothesis' },
      settings: { routeId: 'managed-b', model: 'managed/b', dataClass: 'synthetic', maxTurns: 8,
        maxTokens: 2048, maxKnownRejections: 0 } },
  };
  const evidenceIds = { A: randomUUID(), B: randomUUID() };
  const events = [];
  let turn = 0;
  const ports = {
    reader: {
      read: async (_context, { support }) => {
        const source = support === 'A' ? a : b;
        const bytes = Buffer.from(JSON.stringify({ lines: [{ text: source.quote }, { text: lines[support] }] }));
        return { evidenceId: evidenceIds[support], place: source.place, readerVersion: 'test', mediaType: 'application/json',
          bytes, sha256: sha(bytes) };
      },
    },
    load: async () => events.slice(),
    append: async (version, make) => {
      assert.equal(version, events.length);
      const event = await make();
      events.push(event);
      return event;
    },
    call: async () => {
      turn++;
      const name = turn < 3 ? 'extract' : 'verify_resolution';
      const sources = Object.entries(lines).map(([support, quote]) => ({ evidenceId: evidenceIds[support], quote }));
      const check = { status: turn > 3 ? 'unclear' : status, sources, reason: 'Controlled assertion of applicability' };
      const args = turn < 3 ? { support: turn === 1 ? 'A' : 'B' } :
        { verdict: turn === 3 ? 'supported' : 'unclear', explanation: 'Controlled independent reviewer', evidenceIds: Object.values(evidenceIds),
          checks: { variant: check, revision: check, applicability: check, comparability: check } };
      return { status: 'paid', attemptId: randomUUID(), output: { choices: [{
        finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
          id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
        }] },
      }] } };
    },
  };
  let state;
  for (let n = 0; n < 25; n++) {
    state = await advance(task, ports);
    if (state.status !== 'continue') break;
  }
  assert.equal(state?.status, 'done');
  return { verdict: state.outcome.verdict, checks: state.outcome.checks,
    refusals: events.flatMap(({ reply }) => reply?.body?.code ? [reply.body.code] : []) };
}

const explicit = await verification(labels.both, 'incompatible');
assert.equal(explicit.verdict, 'unclear');
assert.deepEqual(explicit.refusals, ['pair_check_unresolved']);
const objections = {};
for (const key of ['both', 'revision', 'variant', 'scope', 'inactive']) {
  objections[key] = await verification(labels[key], 'confirmed');
}
const matching = await verification(labels.matching, 'confirmed');
const differentCurrent = await verification(labels.differentCurrent, 'confirmed');
assert.equal(matching.verdict, 'supported');
assert.equal(differentCurrent.verdict, 'supported');
const unsafe = Object.entries(objections).filter(([, { verdict }]) => verdict === 'supported').map(([key]) => key);
console.log(JSON.stringify({ labels, explicit, objections, matching, differentCurrent, unsafe }, null, 2));
if (!process.argv.includes('--diagnostic')) assert.deepEqual(unsafe, [], 'A conflicting literal label admitted supported');
