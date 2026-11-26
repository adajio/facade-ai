import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.FACADE_WORK_SLICE_TEST_DB;
const dist = process.env.FACADE_WORK_SLICE_TEST_DIST ?? resolve('dist');
const compiled = (name) => import(pathToFileURL(resolve(dist, name)).href);

test('work-slice counts distinguish checked requirements from grounds admitted to a letter', async () => {
  const { countRequirements } = await compiled('src/modules/work-slice/store.js');
  const row = (outcome, letterEligible) => ({ outcome, letterEligible, machine: { outcome, citations: [] } });
  const output = countRequirements([...Array.from({length:5}, () => row('covered', false)), row('confirmed_missing', true),
    ...Array.from({length:10}, () => row('needs_review', false))]);
  assert.deepEqual([output.total, output.checked, output.review, output.letter, output.ready], [16,6,10,1,5]);
  const d8 = countRequirements([row('needs_review', true), row('needs_review', false)]);
  assert.deepEqual([d8.total, d8.checked, d8.review, d8.letter, d8.ready], [2,0,1,1,0]);
});

test('the work slice exposes local findings, an open remainder and independent letter grounds together', async () => {
  const { countRequirements } = await compiled('src/modules/work-slice/store.js');
  const row = (outcome, state, letterEligible = false, readable = false) => ({
    outcome, letterEligible, semanticRemainder: { state },
    machine: { outcome, citations: [], ...(readable && { delivery: 'received', readability: 'readable' }) },
  });
  const output = countRequirements([
    row('covered', 'complete'), row('covered', 'open'),
    row('confirmed_conflict', 'open', true), row('needs_review', 'open', false, true),
    ...Array.from({ length: 12 }, () => row('needs_review', 'open')),
  ]);
  assert.deepEqual(output.evidence, { proven: 2, partial: 2, remainder: 15 });
  assert.deepEqual([output.total, output.checked, output.review, output.letter, output.ready], [16, 2, 14, 1, 1]);
});

test('an engineering decision is kept alongside residual evidence and technical stops do not create engineering work', async () => {
  const { countRequirements } = await compiled('src/modules/work-slice/store.js');
  const technical = {
    outcome: 'needs_review',
    machine: { outcome: 'needs_review', citations: [] },
    semanticRemainder: { state: 'open', items: [{ reason: 'material_not_mapped' }, { reason: 'reading_pending' }] },
  };
  assert.equal(countRequirements([technical]).actionable, 0);
  const addressed = { ...technical, semanticRemainder: { state: 'open', items: [{ reason: 'semantic_check_missing' }] } };
  assert.equal(countRequirements([addressed]).actionable, 1);
  const local = { outcome: 'covered', machine: { outcome: 'covered' }, semanticRemainder: { state: 'open' } };
  const reviewed = countRequirements([{ ...local, decision: { action: 'confirm', outcome: 'covered' } }, technical]);
  assert.deepEqual([reviewed.checked, reviewed.ready, reviewed.review], [1, 1, 1]);
  assert.deepEqual(reviewed.evidence, { proven: 0, partial: 1, remainder: 2 });
  assert.equal(countRequirements([{ ...local, decision: { action: 'revoke', outcome: 'covered' } }]).ready, 0);
  const limited = countRequirements([{ ...local, semanticRemainder: { state: 'complete' },
    machine: { outcome: 'covered', limitations: ['structural_remainder_open'] } }]);
  assert.deepEqual(limited.evidence, { proven: 0, partial: 1, remainder: 1 });
});

test('the authorized work slice freezes totals, receipt pages and sealed inventory coordinates', { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/test_work_slice_[a-z0-9_]+$/);
  const db = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  const [{ createApi }, { digest, randomSecret }] = await Promise.all([
    compiled('src/platform/api.js'), compiled('src/modules/access/auth.js'),
  ]);
  const organization = (await db.query("INSERT INTO organizations(name) VALUES('Synthetic work slice') RETURNING id")).rows[0].id;

  async function user(role) {
    const id = randomUUID();
    const token = randomSecret();
    await db.query("INSERT INTO users(id,organization_id,login,password_hash,state) VALUES($1,$2,$3,'$argon2id$fixture','active')",
      [id, organization, role + '-' + id]);
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [id, digest(token)]);
    return { id, token };
  }
  const owner = await user('engineer');
  const viewer = await user('viewer');
  const outsider = await user('outsider');
  const project = (await db.query(
    "INSERT INTO projects(organization_id,name,intake_mode) VALUES($1,'Synthetic work slice',true) RETURNING id", [organization],
  )).rows[0].id;
  await db.query(`INSERT INTO project_memberships(organization_id,project_id,user_id,role)
    VALUES($1,$2,$3,'engineer'),($1,$2,$4,'viewer')`, [organization, project, owner.id, viewer.id]);
  const generation = randomUUID();
  await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)', [project]);
  await db.query('INSERT INTO gateway_generations(project_id,generation_id) VALUES($1,$2)', [project, generation]);
  const { rows: receipts } = await db.query(
    `INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at)
     SELECT gen_random_uuid(),$1,'upload',$2,CASE WHEN i>90 THEN now() END
     FROM generate_series(1,135) i ORDER BY i RETURNING id,number`, [project, owner.id]);
  const mapped = receipts.slice(49, 120).map(({ id }, index) => ({
    receipt: id, document: randomUUID(), version: randomUUID(), blob: randomUUID(),
    job: randomUUID(), hash: index.toString(16).padStart(64, '0'), state: index === 70 ? 'held' : 'ready',
  }));
  const input = JSON.stringify(mapped);
  const values = `jsonb_to_recordset($2::jsonb) AS value(receipt uuid,document uuid,
    version uuid,blob uuid,job uuid,hash text,state text)`;
  await db.query(`INSERT INTO intake_documents(id,project_id) SELECT document,$1 FROM ${values}`, [project, input]);
  await db.query(`INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
    SELECT blob,$1,blob::text,100,hash FROM ${values}`, [project, input]);
  await db.query(`INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type)
    SELECT version,$1,document,blob,'application/pdf' FROM ${values}`, [project, input]);
  await db.query(`INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,state,version_id)
    SELECT gen_random_uuid(),$1,receipt,'synthetic.pdf','application/pdf','accepted',version FROM ${values}`, [project, input]);
  await db.query(`INSERT INTO gateway_primary(generation_id,id,branch,place)
    SELECT $1,job::text,'A',version::text FROM ${values}`, [generation, input]);
  await db.query(`INSERT INTO gateway_jobs(id,project_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,
    payload,priority,state) SELECT job,$1,$3,job::text,'harness_research','primary_a',version::text,job::text,hash,
    jsonb_build_object('place',jsonb_build_object('source',jsonb_build_object('versionId',version))),0,state FROM ${values}`,
    [project, input, generation]);

  const app = await createApi({ databaseUrl, dataDir: process.env.FACADE_DATA_DIR ?? '/tmp', host: '127.0.0.1', port: 19482 });
  t.after(() => app.close());
  const base = '/api/projects/' + project + '/work-slices';
  const get = (path, actor = owner) => app.inject({ url: base + path, headers: { cookie: 'facade_session=' + actor.token } });
  const success = async (path, actor) => {
    const response = await get(path, actor);
    assert.equal(response.statusCode, 200, response.payload);
    return response.json();
  };
  const list = (slice, search) => '/' + slice.workSliceId + '/receipts' + (search ? '?' + search : '');
  const closed = receipts[117].id;
  const openOnly = receipts[8].id;
  const heldOnly = receipts[119].id;

  // A physical page counts as a prepared map. A saved original-only placeholder does not.
  for (const [entry, unit] of [[mapped[0], { id: '1', locator: { page: 1 } }],
    [mapped[1], { id: 'original', locator: { coverage: 'original_only', place: 'original' } }]]) {
    await db.query(`INSERT INTO reader_maps(project_id, document_id, version_id, reader_version, receipt_id,
      original_sha256, format, units) VALUES($1,$2,$3,'test-map',$4,$5,'pdf',$6)`,
      [project, entry.document, entry.version, entry.receipt, entry.hash, JSON.stringify([unit])]);
  }
  await db.query("UPDATE gateway_jobs SET reason='unknown_charge',next_action='operator_reconcile_attempt' WHERE id=$1", [mapped[70].job]);
  const guard = await db.connect();
  let requests;
  try {
    await guard.query('BEGIN');
    await guard.query("SELECT pg_advisory_xact_lock(hashtextextended('intake/project/' || $1::text, 0))", [project]);
    requests = Promise.all([success('/current'), success('/current', viewer)]);
    // Wait until both repeatable-read snapshots have reached the locked project.
    for (let i = 0; ; i++) {
      const { rows: [locks] } = await guard.query(`SELECT count(*)::int AS waiters FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      if (locks.waiters >= 2) break;
      assert.ok(i < 100, 'Both readers reached the protected snapshot');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    await guard.query('ROLLBACK');
    guard.release();
  }
  const [initial, concurrent] = await requests;
  assert.equal(concurrent.workSliceId, initial.workSliceId);
  assert.deepEqual(initial.files, { accepted: 71, prepared: 1 });
  assert.deepEqual(initial.stops, [{ jobId: mapped[70].job, branch: 'A', reason: 'unknown_charge',
    nextAction: 'operator_reconcile_attempt', receiptId: mapped[70].receipt, versionId: mapped[70].version, label: 'synthetic.pdf' }]);
  assert.deepEqual(initial.totals, { all: 135, open: 90, processing: 70 });
  assert.ok(Number(initial.cursor) > 0, 'The assessment publication is inside the same slice');
  assert.equal(initial.confirmedBytes, 7_100);
  assert.equal(initial.assessment.kind, 'facade');
  assert.deepEqual(initial.readings, [{ state: 'held', branch: 'A', total: 1 }, { state: 'ready', branch: 'A', total: 70 }]);
  assert.ok(initial.activeReceipt.receiptId !== heldOnly);
  assert.equal((await success('/current', viewer)).workSliceId, initial.workSliceId);

  const page1 = await success(list(initial, 'filter=processing'), viewer);
  assert.equal(page1.total, 70);
  assert.equal(page1.receipts.length, 50);
  assert.ok(page1.receipts.some((row) => row.receiptId === closed && !row.inventoryOpen && row.processing));
  assert.ok(!page1.receipts.some((row) => row.receiptId === heldOnly));
  const selected = await success(list(initial, 'filter=processing&receiptId=' + mapped[0].receipt));
  assert.equal(selected.selection, 'present');
  assert.equal(selected.receipts.length, 20);
  const filtered = await success(list(initial, 'filter=processing&receiptId=' + openOnly));
  assert.equal(filtered.selection, 'filtered');
  assert.equal(filtered.selectedReceipt.inventoryOpen, true);

  await db.query("UPDATE gateway_jobs SET state='done' WHERE id=$1", [mapped[67].job]);
  const fresh = await success('/current');
  assert.notEqual(fresh.workSliceId, initial.workSliceId);
  assert.equal(fresh.totals.processing, 69);
  const page2 = await success(list(initial, 'filter=processing&cursor=' + page1.nextCursor));
  assert.equal(page2.total, 70);
  assert.equal(page2.receipts.length, 20);
  assert.equal(new Set([...page1.receipts, ...page2.receipts].map((row) => row.receiptId)).size, 70);
  for (const [slice, filter] of [[initial, 'open'], [fresh, 'processing']]) {
    const response = await get(list(slice, 'filter=' + filter + '&cursor=' + page1.nextCursor));
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'snapshot_required');
  }

  const historical = await success(list(initial) + '/' + closed + '/inventory', viewer);
  assert.equal(historical.historical, true);
  assert.equal(historical.receiptId, closed);
  assert.equal(historical.occurrences.length, 1);
  const live = await get(list(initial) + '/' + openOnly + '/inventory');
  assert.equal(live.statusCode, 409);
  assert.equal(live.json().code, 'inventory_snapshot_unavailable');
  await db.query("INSERT INTO intake_events(project_id,receipt_id,type,data) VALUES($1,$2,'intake.synthetic_change','{}')",
    [project, closed]);
  assert.equal((await get(list(initial) + '/' + closed + '/inventory')).json().code, 'inventory_snapshot_unavailable');

  const earlier = await db.connect();
  try {
    await earlier.query('BEGIN');
    const event = "INSERT INTO intake_events(project_id,receipt_id,type,data) VALUES($1,$2,'intake.synthetic_change','{}')";
    await earlier.query(event, [project, closed]);
    await db.query(event, [project, closed]);
    const beforeLateCommit = await success('/current');
    await success(list(beforeLateCommit) + '/' + closed + '/inventory');
    await earlier.query('COMMIT');
    assert.equal((await get(list(beforeLateCommit) + '/' + closed + '/inventory')).json().code, 'inventory_snapshot_unavailable');
  } finally {
    await earlier.query('ROLLBACK');
    earlier.release();
  }

  assert.equal((await get(list(initial), outsider)).statusCode, 404);
  await db.query('DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2', [project, viewer.id]);
  assert.equal((await get(list(initial), viewer)).statusCode, 404);
  assert.equal((await get(list(initial) + '/' + closed + '/inventory', viewer)).statusCode, 404);

  const beforeExpiry = await success('/current');
  await db.query("UPDATE work_slices SET expires_at=now()-interval '1 second' WHERE id=$1", [beforeExpiry.workSliceId]);
  const expired = await get(list(beforeExpiry));
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().code, 'snapshot_required');
  const replacement = await success('/current');
  assert.notEqual(replacement.workSliceId, beforeExpiry.workSliceId);
  assert.equal(replacement.totals.processing, beforeExpiry.totals.processing);
});
