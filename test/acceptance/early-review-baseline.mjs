import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from '/app/node_modules/pg/lib/index.js';
import { publication } from '/app/dist/src/modules/harness/publication.js';
import { loadResearchProfile } from '/app/dist/src/modules/harness/profile.js';
import { WorkQueue } from '/app/dist/src/modules/gateway/queue.js';

const frozen = JSON.parse(await readFile('/frozen/machine-final-live.json', 'utf8')).main;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on' });
try {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/test_early_review_[a-f0-9]{12}$/u);
  const { rows: pairs } = await db.query(
    `SELECT d.id,d.generation_id AS generation,g.scope_id AS scope,g.current,g.sealed,
            a.finding->'citation' AS a,b.finding->'citation' AS b,
            (SELECT count(*)::int FROM gateway_primary p WHERE p.generation_id=g.generation_id AND p.state='pending') AS pending,
            (SELECT count(*)::int FROM gateway_attempts p WHERE p.generation_id=g.generation_id
             AND p.purpose IN ('primary_a','primary_b') AND p.state IN ('reserved','prepared','sending','unknown')) AS unsettled,
            (SELECT count(*)::int FROM gateway_jobs j WHERE j.generation_id=g.generation_id AND j.purpose='review') AS enqueued
       FROM harness_disputes d JOIN gateway_generations g USING(generation_id)
       JOIN harness_observations a ON a.generation_id=d.generation_id AND a.observation_id=d.a_observation_id
       JOIN harness_observations b ON b.generation_id=d.generation_id AND b.observation_id=d.b_observation_id
       WHERE g.project_id=$1 AND g.current ORDER BY d.id`, [frozen.projectId]);
  assert.equal(pairs.length, 2);
  for (const pair of pairs) {
    assert.ok(pair.current && pair.sealed && pair.pending > 0 && pair.unsettled > 0);
    assert.equal(pair.enqueued, 0);
    const origin = frozen.disputes.find(({ id }) => id === pair.id);
    assert.ok(origin);
    assert.equal(pair.a.observationId, origin.a_observation_id);
    assert.equal(pair.b.observationId, origin.b_observation_id);
    assert.equal(pair.scope, origin.scope_id);
    assert.equal(pair.a.value, '37');
    assert.equal(pair.b.value, '44');
  }
  const scheduled = await publication(db, new WorkQueue(db), loadResearchProfile()).readyReview();
  assert.equal(scheduled, false);
  console.log(JSON.stringify({ oldPublicationEnqueued: scheduled, readOnly: true,
    pairs: pairs.map(({ a, b, ...pair }) => ({ ...pair, a: a.observationId, b: b.observationId })) }, null, 2));
} finally {
  await db.end();
}
