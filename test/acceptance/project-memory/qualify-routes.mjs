import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const [{ createGateway, journalFromEnv }, { openRouterTransport }, { initialMessages, request },
  { validateLivePolicy }] = await Promise.all([
  import('/app/dist/src/modules/gateway/index.js'),
  import('/app/dist/src/modules/gateway/openrouter.js'),
  import('/app/dist/src/modules/harness/openrouter.js'),
  import('/app/dist/src/modules/harness/live-policy.js'),
]);
const { Pool } = createRequire('/app/package.json')('pg');
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { projectId, initialSha256s, policies } = plan;
assert.match(projectId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
assert.equal(initialSha256s.length, 3);
assert.ok(initialSha256s.every((id) => /^[a-f0-9]{64}$/u.test(id)));
assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/test_project_memory_live_[a-f0-9]{12}$/u);
assert.equal(process.env.FACADE_GATEWAY_EXPECTED_JOURNAL_LIMIT_USD_NANOS, '5000000000');
assert.equal(process.env.FACADE_HARNESS_LIVE_POLICY, 'synthetic-research');
assert.ok(!process.env.FACADE_GATEWAY_LIVE_MODE && !process.env.FACADE_HARNESS_MANAGED_URL);
const interfaces = (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1);
assert.ok(!interfaces.some((line) => line.split(/\s+/)[1] === '00000000'));

const profiles = JSON.parse(process.env.FACADE_GATEWAY_STEP15_PROFILES);
const settings = JSON.parse(process.env.FACADE_HARNESS_PROFILE);
assert.equal(profiles.length, 2);
assert.deepEqual(profiles.map(({ provider }) => provider), ['wafer/us', 'alibaba']);
const transport = openRouterTransport({
  qualification: 'step-15', endpoint: 'https://openrouter.ai', profiles,
  apiKey: process.env.FACADE_GATEWAY_OPENROUTER_KEY,
});
const validated = validateLivePolicy(settings, profiles, process.env);
assert.equal(validated.approvals.length, 2);
const storage = journalFromEnv();
assert.ok(storage);
const db = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 1 });
try {
  const budget = await storage.journal.balance();
  assert.equal(budget.limitUsdNanos, 5_000_000_000);
  assert.equal(budget.remainingUsdNanos, 5_000_000_000);
  assert.equal(budget.frozen, false);
  assert.deepEqual(await storage.journal.entries('0'), []);
  assert.deepEqual((await db.query('SELECT id FROM projects WHERE intake_mode')).rows, [{ id: projectId }]);
  const originals = (await db.query('SELECT sha256 FROM intake_originals WHERE project_id=$1 ORDER BY sha256', [projectId])).rows;
  assert.deepEqual(originals.map(({ sha256 }) => sha256), [...initialSha256s].sort());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM gateway_attempts')).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM gateway_routes WHERE transport='managed'")).rows[0].n, 0);
  const windows = (await db.query(`SELECT w.id,w.place,m.reader_version,m.format FROM harness_package_windows w
    JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint
    WHERE w.project_id=$1 AND m.active AND m.refusal IS NULL ORDER BY w.id`, [projectId])).rows;
  assert.deepEqual([...new Set(windows.map(({ place }) => place.source.sha256))].sort(), [...initialSha256s].sort());
  const quote = {};
  for (const [index, branch] of ['A', 'B'].entries()) {
    const route = policies[index];
    const ceilings = [];
    for (const window of windows) {
      const job = { mode: 'primary', place: window.place, branch, settings: settings[branch], observationProtocol: 2,
        packageWindow: { id: window.id, readerVersion: window.reader_version, routeRevision: route.revision, walkProtocol: 1 } };
      assert.equal(validated.hold({ projectId, scopeId: null, job }), null);
      assert.equal(await transport.authorize(db, route, { projectId, scopeId: null, jobId: window.id,
        payload: job, dataClass: 'synthetic', inputRefs: [] }), true);
      const approval = transport.quote(route, request(job, initialMessages(job)));
      assert.ok(approval && approval.ceilingUsdNanos <= budget.remainingUsdNanos);
      ceilings.push(approval.ceilingUsdNanos);
    }
    quote[branch] = { provider: profiles[index].provider, windows: ceilings.length,
      minFirstTurnUsdNanos: Math.min(...ceilings), maxFirstTurnUsdNanos: Math.max(...ceilings) };
  }
  const gateway = createGateway(db, { journal: storage.journal });
  for (const [index, route] of policies.entries()) {
    await gateway.configureRoute(route);
    for (const purpose of [index === 0 ? 'primary_a' : 'primary_b', 'review']) {
      await gateway.grantRoute({ projectId, routeId: route.id, revision: route.revision, dataClass: 'synthetic',
        purpose, allowed: true });
    }
  }
  console.log(JSON.stringify({ budget, quote, providerPosts: 0 }));
} catch (error) {
  console.error('Route qualification failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await db.end();
  await storage.close();
}
