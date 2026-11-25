import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';

const connectionString = process.env.FACADE_DOCUMENT_WORK_TEST_DB;
const dist = process.env.FACADE_DOCUMENT_WORK_TEST_DIST ?? resolve('dist');
const compiled = (name) => import(pathToFileURL(resolve(dist, name)).href);

test('document work verifies source pairing, role, job revision and unknown effects', { skip: !connectionString }, async (t) => {
  const database = new URL(connectionString);
  assert.match(database.pathname, /^\/(?:test_document_work_[a-z0-9_]+|facade_doc_fixture)$/);
  assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));

  const [{ createApi }, { csrfToken, digest, randomSecret }] = await Promise.all([
    compiled('src/platform/api.js'), compiled('src/modules/access/auth.js'),
  ]);
  const db = new pg.Pool({ connectionString });
  t.after(() => db.end());
  const organization = randomUUID();
  const project = randomUUID();
  const document = randomUUID();
  const version = randomUUID();
  const receipt = randomUUID();
  const generation = randomUUID();
  const sha = 'a'.repeat(64);
  const jobId = randomUUID();
  const stopId = randomUUID();
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [organization, 'Synthetic document work']);
  async function actor(role) {
    const id = randomUUID();
    const token = randomSecret();
    await db.query(
      "INSERT INTO users(id,organization_id,login,password_hash,state) VALUES($1,$2,$3,'$argon2id$fixture','active')",
      [id, organization, role + '-' + id],
    );
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minute')",
      [id, digest(token)]);
    return { id, token };
  }
  const engineer = await actor('engineer');
  const viewer = await actor('viewer');
  const foreign = await actor('foreign');

  await db.query("INSERT INTO projects(id,organization_id,name,intake_mode) VALUES($1,$2,'Synthetic',true)", [project, organization]);
  await db.query(
    `INSERT INTO project_memberships(organization_id,project_id,user_id,role)
     VALUES($1,$2,$3,'engineer'),($1,$2,$4,'viewer')`, [organization, project, engineer.id, viewer.id]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by) VALUES($1,$2,'upload',$3)", [receipt, project, engineer.id]);
  const { rows: [blob] } = await db.query(
    "INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES(gen_random_uuid(),$1,$2,123,$3) RETURNING id", [project, version, sha]);
  await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)', [document, project]);
  await db.query(
    "INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",
    [version, project, document, blob.id]);
  await db.query(
    `INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,state,version_id)
     VALUES(gen_random_uuid(),$1,$2,'synthetic.pdf','application/pdf','accepted',$3)`, [project, receipt, version]);
  await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)', [project]);
  await db.query('INSERT INTO gateway_generations(project_id,generation_id) VALUES($1,$2)', [project, generation]);
  await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,'a','A','page 1')", [generation]);
  await db.query(
    `INSERT INTO gateway_jobs(id,project_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority)
     VALUES($1,$2,$3,'primary:a','harness_research','primary_a',$4,'a',$5,$6,0)`,
    [jobId, project, generation, version, sha, { place: { unitId: '1', page: 1 } }]);

  const app = await createApi({ databaseUrl: connectionString, dataDir: process.env.TMPDIR ?? '/tmp', host: '127.0.0.1', port: 19480 });
  t.after(() => app.close());
  const work = '/api/documents/' + document + '/versions/' + version + '/work';
  const priority = work + '/' + jobId + '/priority';
  const origin = process.env.FACADE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:19480';
  const get = (url, actor = engineer) => app.inject({ url, headers: { cookie: 'facade_session=' + actor.token } });
  const command = (url, method, actor, v, payload, key = randomUUID()) => app.inject({
    url, method, payload,
    headers: { host: new URL(origin).host, origin, cookie: 'facade_session=' + actor.token,
      'x-csrf-token': csrfToken(actor.token), 'if-match': JSON.stringify(String(v)), 'idempotency-key': key },
  });

  const response = await get(work);
  assert.equal(response.statusCode, 200, response.payload);
  const { branches, jobs } = response.json();
  assert.deepEqual(branches, [{ branch: 'A', total: 1, completed: 0, outcome: 'waiting_route' }]);
  const first = jobs[0];
  assert.equal(first.id, jobId);
  assert.equal(first.actions.priority.version, first.version);
  assert.equal(first.reason, 'waiting_route');
  assert.equal((await get(work, foreign)).statusCode, 404);
  assert.equal((await get(work.replace(document, randomUUID()))).statusCode, 404);
  assert.equal((await command(priority, 'PATCH', viewer, first.version, { priority: 3 })).statusCode, 403);

  const key = randomUUID();
  const changed = await command(priority, 'PATCH', engineer, first.version, { priority: 3 }, key);
  assert.equal(changed.statusCode, 200, changed.payload);
  assert.notEqual(changed.json().version, first.version);
  const repeated = await command(priority, 'PATCH', engineer, first.version, { priority: 3 }, key);
  assert.equal(repeated.statusCode, 200, repeated.payload);
  assert.equal(repeated.headers['idempotency-replayed'], 'true');
  assert.equal((await command(priority, 'PATCH', engineer, first.version, { priority: 5 })).statusCode, 412);
  assert.equal((await db.query("SELECT 1 FROM access_audit WHERE object_id=$1 AND action='document.work.priority'", [jobId])).rowCount, 1);

  await db.query("UPDATE gateway_jobs SET state='held', reason='repeated_rejected_action' WHERE id=$1", [jobId]);
  await db.query("INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,1,'{}')", [jobId]);
  await db.query("INSERT INTO harness_research_stops(id,job_id,sequence) VALUES($1,$2,1)", [stopId, jobId]);
  const target = (await get(work)).json().jobs[0].actions.resume;
  assert.equal(target.version, 1);
  assert.equal((await command(target.href, 'POST', engineer, 2, {})).statusCode, 412);
  const attemptId = randomUUID();
  await db.query(
    `INSERT INTO gateway_attempts(id,ledger_id,project_id,generation_id,job_id,purpose,effect_key,request_hash,route_id,revision,
      ceiling_usd_nanos,state) VALUES($1,$2,$3,$4,$5,'primary_a','synthetic',$6,'disabled','test',1,'sending')`,
    [attemptId, randomUUID(), project, generation, jobId, sha]);
  assert.equal((await get(work)).json().jobs[0].actions.resume.reason, 'response_pending');
  await db.query("UPDATE gateway_attempts SET state='unknown' WHERE id=$1", [attemptId]);
  const blocked = (await get(work)).json().jobs[0];
  assert.equal(blocked.actions.resume.reason, 'operator_reconcile_attempt');
  assert.equal((await command(target.href, 'POST', engineer, 1, {})).statusCode, 409);
  assert.equal((await db.query('SELECT resume_requested_at FROM harness_research_stops WHERE id=$1', [stopId])).rows[0].resume_requested_at, null);
  async function heldStop(reason) {
    const id = randomUUID();
    const stop = randomUUID();
    await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,$2,'B',$2)", [generation, id]);
    await db.query(
      `INSERT INTO gateway_jobs(id,project_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority,state,reason)
       VALUES($1::uuid,$2,$3,$1::uuid::text,'harness_research','primary_b',$4,$1::uuid::text,$5,$6,0,'held',$7)`,
      [id, project, generation, version, sha, { place: { unitId: '1', page: 1 } }, reason]);
    await db.query("INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,1,'{}')", [id]);
    await db.query('INSERT INTO harness_research_stops(id,job_id,sequence) VALUES($1,$2,1)', [stop, id]);
    return { id, stop };
  }
  const turnLimited = await heldStop('turn_limit');
  const alsoReady = await heldStop('repeated_rejected_action');
  const terminal = await heldStop('turn_limit_final');
  const queued = await heldStop('route_bound_unavailable');
  await db.query(`WITH next AS (UPDATE gateway_outbox_sequence SET cursor=cursor+1 RETURNING cursor)
    INSERT INTO gateway_outbox(cursor,job_id,lease_epoch,event_type)
    SELECT cursor,$1,0,'package_resume_waiting_slot' FROM next`, [queued.id]);
  const bulkUrl = '/api/projects/' + project + '/research-stops/resume';
  const before = (await get('/api/projects/' + project + '/work-slices/current')).json();
  assert.deepEqual(before.continuation, { available: 2, queued: 1, needsAction: 2 });
  assert.deepEqual(before.readings.filter(row => row.branch === 'B'), [
    { state: 'held', branch: 'B', total: 3 }, { state: 'ready', branch: 'B', total: 1 },
  ]);
  assert.ok(!before.stops.some(stop => stop.jobId === queued.id));
  const limitedCard = (await get(work)).json().jobs.find(({ id }) => id === turnLimited.id);
  assert.equal(limitedCard.actions.resume.version, 1);

  const batchKey = randomUUID();
  assert.equal((await command(bulkUrl, 'POST', viewer, 1, {})).statusCode, 403);
  assert.equal((await command(bulkUrl, 'POST', foreign, 1, {})).statusCode, 404);
  const accepted = await command(bulkUrl, 'POST', engineer, 1, {}, batchKey);
  assert.equal(accepted.statusCode, 202, accepted.payload);
  assert.deepEqual(accepted.json(), { requested: 2, continuation: { available: 0, queued: 3, needsAction: 2 } });
  const retry = await command(bulkUrl, 'POST', engineer, 1, {}, batchKey);
  assert.equal(retry.headers['idempotency-replayed'], 'true');
  assert.deepEqual(retry.json(), accepted.json());
  const secondClick = await command(bulkUrl, 'POST', engineer, 1, {});
  assert.equal(secondClick.json().requested, 0);
  const requests = await db.query(
    'SELECT id,resume_requested_by FROM harness_research_stops WHERE id=ANY($1::uuid[]) AND resume_requested_at IS NOT NULL',
    [[stopId, turnLimited.stop, alsoReady.stop, terminal.stop, queued.stop]]);
  assert.deepEqual(requests.rows.map(row => row.id).sort(), [turnLimited.stop, alsoReady.stop].sort());
  assert.ok(requests.rows.every(row => row.resume_requested_by === engineer.id));
  assert.equal((await db.query('SELECT state FROM gateway_jobs WHERE id=$1', [turnLimited.id])).rows[0].state, 'held');
  assert.equal((await db.query("SELECT count(*)::int n FROM gateway_attempts WHERE project_id=$1", [project])).rows[0].n, 1);

  await db.query("UPDATE gateway_attempts SET state='rejected' WHERE id=$1", [attemptId]);
  const continued = await command(target.href, 'POST', engineer, 1, {});
  assert.equal(continued.statusCode, 202, continued.payload);
  assert.equal((await get(work)).json().jobs[0].actions.resume.reason, 'continuation_requested');
});
