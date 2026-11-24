import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { advance } from '/app/dist/src/modules/harness/session.js';

const { jobs, events } = JSON.parse(await readFile('/managed-review-evidence.json', 'utf8'));
assert.equal(jobs.length, 2);
const results = [];
for (const job of jobs) {
  const entries = events.filter(({ job_id }) => job_id === job.id).map(({ event }) => event);
  const saved = entries.pop();
  assert.equal(saved.kind, 'tool');
  assert.equal(saved.outcome.kind, 'proposal');
  const task = { jobId: job.id, projectId: job.payload.dispute.a.place.source.projectId,
    scopeId: job.scope_id, generationId: job.generation_id, job: job.payload, earlyPair: true, pairScopeName: 'Северный берег' };
  const ports = {
    reader: {},
    load: async () => entries.slice(),
    append: async (expectedLength, write) => {
      assert.equal(expectedLength, entries.length);
      const event = await write();
      entries.push(event);
      return event;
    },
    call: async () => assert.fail('Recorded terminal response should use only saved answers and evidence'),
  };
  const applied = await advance(task, ports);
  assert.equal(applied.status, 'continue');
  const state = await advance(task, ports);
  assert.equal(state.status, 'done');
  assert.deepEqual(state.outcome, saved.outcome);
  const { revision, variant, applicability, comparability } = state.outcome.checks;
  assert.equal(revision.status, 'confirmed');
  assert.ok(revision.sources.every(({ quote }) => /редакция N05/iu.test(quote)));
  assert.ok([variant, applicability, comparability].every(({ status }) => status === 'unclear'));
  results.push({ dispute: job.dispute, checks: state.outcome.checks, paidCalls: 0 });
}
console.log(JSON.stringify(results, null, 2));
