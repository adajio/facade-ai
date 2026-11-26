import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const enabled = process.env.FACADE_PACKAGE_SLOTS_TEST === '1';
const built = (file) => process.env.FACADE_HARNESS_TEST_DIST
  ? pathToFileURL(join(process.env.FACADE_HARNESS_TEST_DIST, file)).href
  : new URL(`../../../dist/${file}`, import.meta.url).href;

test('held package jobs retain their effects while independent windows and supplements acquire bounded slots', { skip: !enabled }, async (t) => {
  const targets = [process.env.DATABASE_URL, process.env.GATEWAY_TEST_JOURNAL_URL];
  const names = targets.map((url) => new URL(url).pathname.slice(1));
  assert.ok(names.every((name) => /^test_package_slots_[a-z0-9_]+$/u.test(name)) && names[0] !== names[1]);
  const [db, outside] = targets.map((connectionString) => new pg.Pool({ connectionString }));
  t.after(async () => { await Promise.all([db.end(), outside.end()]); });
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, names[0]);
  assert.equal((await outside.query('SELECT current_database() AS name')).rows[0].name, names[1]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n, 0);
  await outside.query(await readFile(new URL('../gateway/journal.sql', import.meta.url), 'utf8'));
  const ledgerId = randomUUID();
  await outside.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES($1)', [ledgerId]);
  const { Gateway, PostgresIntentJournal } = await import(built('src/modules/gateway/index.js'));
  const { packageModelAdmission, dispatchPackagePair, preparePackageMap } = await import(built('src/modules/harness/package-dispatch.js'));
  const journal = new PostgresIntentJournal(outside, ledgerId);
  const sends = [];
  const transport = { kind: 'managed', async send(attempt) {
    sends.push(attempt);
    return attempt.purpose === 'primary_b' ? { receipt: { state: 'unknown', code: 'mock_lost_reply' } }
      : { receipt: { state: 'paid', costUsdNanos: 0, providerId: attempt.id, evidenceRef: 'synthetic:paid' }, output: {} };
  } };
  const gateway = new Gateway(db, journal, transport, undefined, packageModelAdmission(true, [], true, () => reader));
  const passive = new Gateway(db, journal, transport, undefined, packageModelAdmission(true, [], false, () => reader));
  const profile = Object.fromEntries(['A','B'].map((branch) => [branch, {
    routeId: `fixture-${branch}`, model: `fixture/${branch}`, dataClass: 'synthetic', maxTokens: 256, maxTurns: 4, maxKnownRejections: 1,
  }]));
  for (const { routeId } of Object.values(profile)) await gateway.configureRoute({ id: routeId, revision: 'r1', transport: 'managed',
    enabled: true, maxRequestBytes: 65536, timeoutMs: 5000, ceilingUsdNanos: 1 });
  const { rows: [{ org, user }] } = await db.query(`WITH org AS (INSERT INTO organizations(name) VALUES('slots') RETURNING id),
    owner AS (INSERT INTO users(organization_id,login) SELECT id,'fixture-slots' FROM org RETURNING id)
    SELECT org.id AS org,owner.id AS "user" FROM org,owner`);
  async function project(name) {
    const { rows: [{ id }] } = await db.query('INSERT INTO projects(organization_id,name,intake_mode) VALUES($1,$2,true) RETURNING id', [org,name]);
    for (const branch of ['A','B']) await gateway.grantRoute({ projectId: id, routeId: profile[branch].routeId,
      revision: 'r1', purpose: branch === 'A' ? 'primary_a' : 'primary_b', dataClass: 'synthetic', allowed: true });
    return id;
  }
  const counts = new Map();
  async function accept(projectId, filename, pages) {
    const hash = createHash('sha256').update(filename).digest('hex');
    const { rows: [{ version_id: id }] } = await db.query(`WITH receipt AS (
        INSERT INTO intake_receipts(project_id,source,created_by,sealed_at) VALUES($1,'upload',$2,now()) RETURNING id),
      doc AS (INSERT INTO intake_documents(project_id) VALUES($1) RETURNING id),
      original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
        VALUES(gen_random_uuid(),$1,$3,1,$4) RETURNING id),
      ver AS (INSERT INTO intake_document_versions(project_id,document_id,original_id,media_type)
        SELECT $1,doc.id,original.id,'application/pdf' FROM doc,original RETURNING id,document_id,original_id),
      occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
        SELECT $1,receipt.id,$3,'application/pdf',ver.id,'accepted' FROM receipt,ver RETURNING id)
      INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      SELECT $1,receipt.id,ver.document_id,ver.id,ver.original_id FROM receipt,ver,occurrence RETURNING version_id`, [projectId,user,filename,hash]);
    counts.set(id, pages);
    return id;
  }
  let readerVersion = 'fixture';
  let waitReader; let readerEntered;
  const reader = { formatFor: () => 'pdf', readerVersion: async () => {
    if (waitReader) { readerEntered?.(); await waitReader; }
    return readerVersion;
  }, async map(source) {
    const units = Array.from({ length: counts.get(source.versionId) }, (_, index) => ({
      id: String(index + 1), width: 640, height: 270, locator: { page: index + 1 },
    }));
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      SELECT project_id,document_id,version_id,'fixture',receipt_id,$2,'pdf',$3::jsonb FROM intake_reader_jobs
      WHERE version_id=$1 ON CONFLICT(version_id,reader_version) DO NOTHING`,[source.versionId,source.sha256,JSON.stringify(units)]);
    return { format: 'pdf', source, readerVersion: 'fixture', units };
  } };
  const step = () => dispatchPackagePair(db, gateway, profile, undefined, reader);
  const first = await project('first');
  const original = await accept(first, 'first.pdf', 6);
  const { rows: [{ receipt_id: firstReceipt }] } = await db.query('SELECT receipt_id FROM intake_reader_jobs WHERE version_id=$1',[original]);
  await db.query('UPDATE intake_receipts SET sealed_at=NULL WHERE id=$1',[firstReceipt]);
  assert.equal(await preparePackageMap(db, gateway, reader, []), true);
  // A physical-inventory limitation is not a total refusal when usable units exist.
  await db.query("UPDATE harness_package_maps SET refusal='physical_inventory_unverified' WHERE version_id=$1 AND active",[original]);
  const previousProfile = process.env.FACADE_HARNESS_PROFILE;
  process.env.FACADE_HARNESS_PROFILE = JSON.stringify({A:{routeId:'codex-subscription-terra',model:'gpt-6.1-terra',dataClass:'synthetic',maxTokens:100,maxTurns:1,maxKnownRejections:0}});
  try {
    const { readTerraReading } = await import(built('src/modules/assessment/terra-reading.js'));
    assert.equal((await readTerraReading(db,first)).progress.totalWindows,0);
  } finally {
    if (previousProfile === undefined) delete process.env.FACADE_HARNESS_PROFILE; else process.env.FACADE_HARNESS_PROFILE = previousProfile;
  }
  while (await step()) {}
  assert.equal((await db.query("SELECT count(*)::int AS n FROM gateway_jobs WHERE kind='harness_research'")).rows[0].n,0);
  await db.query('UPDATE intake_receipts SET sealed_at=clock_timestamp() WHERE id=$1',[firstReceipt]);
  const { packagePreparationSweep } = await import(built('src/modules/harness/package-preparation.js'));
  await db.query("UPDATE harness_package_maps SET refusal='format_unavailable' WHERE version_id=$1 AND active",[original]);
  await packagePreparationSweep(db,reader)();
  while (await step()) {}
  assert.equal((await db.query("SELECT count(*)::int AS n FROM gateway_jobs WHERE kind='harness_research'")).rows[0].n,0);
  await db.query("UPDATE harness_package_maps SET refusal='physical_inventory_unverified' WHERE version_id=$1 AND active",[original]);
  await packagePreparationSweep(db,reader)();
  let releaseReader;
  waitReader = new Promise(resolve => { releaseReader = resolve; });
  const entered = new Promise(resolve => { readerEntered = resolve; });
  const delayedStep = step();
  await entered;
  const lockProbe = await db.connect();
  try {
    await lockProbe.query('BEGIN');
    assert.equal((await lockProbe.query("SELECT pg_try_advisory_xact_lock(hashtextextended('facade/package-dispatch',0)) AS ok")).rows[0].ok,true);
    await lockProbe.query('ROLLBACK');
  } finally { lockProbe.release(); }
  waitReader = undefined; releaseReader(); readerEntered = undefined;
  assert.equal(await delayedStep,true);
  while (await step()) {}
  assert.ok((await db.query("SELECT payload#>>'{packageWindow,preparationId}' AS pin FROM gateway_jobs WHERE kind='harness_research' LIMIT 1")).rows[0]?.pin);

  const claim = () => gateway.claim({ workerId: 'fixture', kinds: ['harness_research'], leaseMs: 20_000 });
  const call = (job) => ({ lease: job.lease, routeId: job.payload.settings.routeId, dataClass: 'synthetic',
    effectKey: 'fixture-turn', request: { fixture: true }, inputRefs: [] });
  const probe = await claim();
  assert.ok(probe);
  readerVersion = 'fixture-v2';
  const stale = await gateway.call(call(probe));
  assert.equal(stale.status, 'held');
  assert.equal(stale.code, 'preparation_changed');
  assert.equal(sends.length, 0);
  // Waiting after an earlier preparation shows assigned legacy work, not all mapped windows.
  const { rows: [legacyBranch] } = await db.query(`SELECT b.window_id,b.profile_hash,b.settings FROM harness_package_branches b
    JOIN harness_package_windows w ON w.id=b.window_id WHERE w.project_id=$1 AND b.branch='A' AND b.active LIMIT 1`,[first]);
  const priorProfile = process.env.FACADE_HARNESS_PROFILE;
  process.env.FACADE_HARNESS_PROFILE = JSON.stringify({A:{routeId:'codex-subscription-terra',model:'gpt-6.1-terra',dataClass:'synthetic',maxTokens:100,maxTurns:1,maxKnownRejections:0}});
  try {
    await db.query(`UPDATE harness_package_branches SET settings=$3 WHERE window_id=$1 AND branch='A' AND profile_hash=$2`,
      [legacyBranch.window_id,legacyBranch.profile_hash,JSON.stringify({model:'gpt-6.1-terra',routeId:'codex-subscription-terra'})]);
    const { readTerraReading } = await import(built('src/modules/assessment/terra-reading.js'));
    const overview = await readTerraReading(db,first);
    assert.equal(overview.progress.totalWindows,1);
    assert.equal(overview.progress.unassigned,0);
  } finally {
    await db.query(`UPDATE harness_package_branches SET settings=$3 WHERE window_id=$1 AND branch='A' AND profile_hash=$2`,
      [legacyBranch.window_id,legacyBranch.profile_hash,JSON.stringify(legacyBranch.settings)]);
    if (priorProfile === undefined) delete process.env.FACADE_HARNESS_PROFILE; else process.env.FACADE_HARNESS_PROFILE = priorProfile;
  }
  readerVersion = 'fixture';
  const held = [];
  for (let i = 0; i < 8; i++) {
    const job = i === 0 ? probe : await claim();
    assert.ok(job);
    const hasEffect = job.payload.place.unitId === '1';
    const model = hasEffect ? await gateway.call(call(job)) : null;
    if (hasEffect) assert.equal(model.status, job.purpose === 'primary_b' ? 'held' : 'paid');
    if (model?.status === 'paid') {
      readerVersion = 'fixture-v2';
      assert.equal((await gateway.call(call(job))).replay, true);
      // A replaced map must not hide the already-paid journal result or resend it.
      const {rows:[activeMap]} = await db.query('UPDATE harness_package_maps SET active=false WHERE version_id=$1 AND active RETURNING fingerprint',[original]);
      try { assert.equal((await gateway.call(call(job))).replay, true); }
      finally { await db.query('UPDATE harness_package_maps SET active=true WHERE version_id=$1 AND fingerprint=$2',[original,activeMap.fingerprint]); }
      readerVersion = 'fixture';
    }
    if (model?.status === 'held') {
      readerVersion = 'fixture-v2';
      assert.equal((await gateway.call(call(job))).code, 'unknown_charge');
      readerVersion = 'fixture';
    }
    assert.equal(await gateway.suspend(job.lease, { reason: model?.status === 'held' ? 'unknown_charge' : 'repeated_rejected_action',
      nextAction: 'fixture' }), true);
    held.push(job);
  }
  assert.equal(held.length, 8);
  assert.equal(await claim(), null);
  assert.equal(sends.length, 2);
  const effects = async () => (await outside.query(`SELECT id,effect_key,state,ceiling_usd_nanos
    FROM gateway_external_attempts ORDER BY created_order`)).rows;
  const before = await effects();
  assert.deepEqual(new Set(before.map(({ state }) => state)), new Set(['paid','unknown']));
  assert.equal(await step(), true, 'held jobs must leave slots for the fifth independent pair');
  assert.equal(await step(), true, 'the sixth original window must also get its pair');
  const supplement = await accept(first, 'supplement.pdf', 1);
  assert.equal(await preparePackageMap(db, gateway, reader, []), true);
  assert.equal(await step(), true);
  assert.equal(await step(), false);
  const { rows: assigned } = await db.query(`SELECT subject_id,state,count(*)::int AS n FROM gateway_jobs
    WHERE project_id=$1 GROUP BY 1,2`, [first]);
  assert.deepEqual(assigned.find(({ subject_id }) => subject_id === supplement), { subject_id: supplement, state: 'ready', n: 2 });
  assert.equal(assigned.find(({ subject_id, state }) => subject_id === original && state === 'held').n, 8);
  const opened = await claim();
  assert.ok(opened);
  assert.equal(opened.subjectId, supplement);
  assert.equal((await passive.call(call(opened))).code, 'analysis_replay_only');
  assert.deepEqual(await effects(), before);
  assert.equal(sends.length, 2);
  assert.equal((await journal.balance()).reserveUsdNanos, 1);

  const unknown = held.find((job) => job.purpose === 'primary_b' && job.payload.place.unitId === '1');
  assert.equal(await gateway.resume(unknown.lease.jobId), false);
  const resumable = held.filter((job) => job !== unknown);
  const resumed = await Promise.all(resumable.map(({ lease }) => gateway.resume(lease.jobId)));
  assert.equal(resumed.filter(Boolean).length, 2, 'six runnable jobs leave exactly two project slots');
  const running = async () => (await db.query(`SELECT project_id,count(*)::int AS n FROM gateway_jobs
    WHERE state IN ('ready','leased') GROUP BY project_id`)).rows;
  const waiting = async () => (await db.query(`SELECT count(*)::int AS n FROM gateway_outbox e
    JOIN gateway_jobs j ON j.id=e.job_id AND j.lease_epoch=e.lease_epoch AND j.state='held'
    WHERE e.event_type='package_resume_waiting_slot'`)).rows[0].n;
  const finish = (job) => gateway.finish(job.lease, { kind: 'fixture' }, { state: 'completed', evidenceRef: 'fixture' });
  assert.equal(await waiting(), 5);
  assert.equal(await gateway.resume(resumable[resumed.indexOf(false)].lease.jobId), false);
  assert.equal(await waiting(), 5, 'repeated resume preserves one deferred request per lease');
  assert.equal(await step(), false);
  let done = opened;
  for (let i = 0; i < 5; i++) {
    assert.equal(await finish(done), true);
    assert.equal(await step(), true);
    assert.equal((await running())[0].n, 8);
    if (i < 4) done = await claim();
  }
  assert.equal(await waiting(), 0);

  const deferred = [];
  for (let i = 0; i < 2; i++) {
    const job = await claim();
    assert.ok(job);
    assert.equal(await gateway.suspend(job.lease, { reason: 'repeated_rejected_action', nextAction: 'fixture' }), true);
    deferred.push(job.lease.jobId);
  }
  for (let i = 0; i < 13; i++) {
    const id = await project(`competing ${i}`);
    await accept(id, `competing-${i}.pdf`, 5);
    assert.equal(await preparePackageMap(db, gateway, reader, []), true);
  }
  while (await step()) {}
  const atCap = await running();
  assert.equal(atCap.reduce((sum, { n }) => sum+n, 0), 96);
  assert.ok(atCap.every(({ n }) => n<=8));
  assert.deepEqual(await Promise.all(deferred.map((id) => gateway.resume(id))), [false,false]);
  assert.equal(await waiting(), 2);
  assert.equal(await finish(await claim()), true);
  assert.equal(await step(), true, 'one freed global slot resumes one waiting primary');
  assert.equal((await running()).reduce((sum, { n }) => sum+n, 0), 96);
  assert.equal(await waiting(), 1);
  assert.equal(await dispatchPackagePair(db, passive, {}), false);
  assert.deepEqual(await effects(), before);
  assert.equal(sends.length, 2);
});
