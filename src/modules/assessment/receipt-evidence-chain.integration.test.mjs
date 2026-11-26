import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';

const url = process.env.PRELIMINARY_TEST_DATABASE_URL;
const built = file => import(pathToFileURL(resolve(process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/assessment', file)).href);

test('receipt chain keeps render, OCR, visual delivery, citations and authorization distinct', { skip: !url }, async t => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) && /^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
  const schema = `chain_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  for (const name of (await readdir('db/migrations')).filter(n => n.endsWith('.sql') && !n.startsWith('01_')).sort()) {
    await db.query(await readFile(resolve('db/migrations', name), 'utf8'));
  }

  const [org, user, outsider, cat, project, receipt, otherReceipt, original, document, version, occurrence] = Array.from({ length: 11 }, randomUUID);
  const hash = 'a'.repeat(64);
  const source = { projectId: project, documentId: document, versionId: version, sha256: hash };
  const receiptRoute = `/api/v1/projects/${project}/receipts/${receipt}/evidence-chain`;
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'fixture')", [org]);
  await db.query("INSERT INTO users(id,organization_id,login,state,password_hash) VALUES($1,$3,'viewer','active',$4),($2,$3,'outsider','active',$4)", [user,outsider,org,'$argon2id$synthetic']);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)",
    [cat,org,JSON.stringify([{ key:'doc', part:'Document' }]),user]);
  await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'fixture',$3,'Стадия 1')", [project,org,cat]);
  await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')", [org,project,user]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())", [receipt,project,user]);
  await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)", [original,project,original,hash]);
  await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)", [document,project]);
  await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')", [version,project,document,original]);
  await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'fixture.pdf','application/pdf',$4,'accepted')", [occurrence,project,receipt,version]);
  const { register } = await built('index.js');
  app.decorate('db', db);
  app.register(register);
  const headers = {};
  for (const member of [user, outsider]) {
    const cookie = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(cookie).digest();
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [member,digest]);
    headers[member] = { cookie: 'facade_session=' + cookie };
  }
  async function read(path = receiptRoute, status = 200, who = user) {
    const response = await app.inject({ url:path, headers:headers[who] });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json();
  }
  await read(receiptRoute, 401, 'unauthenticated');
  await read(receiptRoute, 404, outsider);
  await db.query(`INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,reason,fields,attempt_key)
    VALUES($1,$2,'primary_review','rejected','primary_request_limit',$3,'primary-limit')`, [project,receipt,
    JSON.stringify({requestBytes:201, selectedFiles:1, totalFiles:1, totalLines:3, selectedLines:2, debug:'private-marker'})]);
  await db.query(`INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,fields,attempt_key)
    VALUES($1,$2,'review_saved','published',$3,'older-review')`, [project,receipt,JSON.stringify({reviewId:randomUUID()})]);
  const waiting = await read();
  assert.equal(waiting.reviewId, null);
  assert.deepEqual(waiting.request, {status:'rejected',requestBytes:201,selectedFiles:1,totalFiles:1,totalLines:3,selectedLines:2});
  assert.equal(waiting.latest.reason, 'primary_request_limit');
  assert.equal(waiting.items[0].pixels, null);
  assert.equal(JSON.stringify(waiting).includes('private-marker'), false);

  const [generation, job] = Array.from({length:2}, randomUUID);
  await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)', [project]);
  await db.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,NULL,$2)', [project,generation]);
  await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,'primary-a','A','fixture')", [generation]);
  await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority,state)
    VALUES($1,$2,NULL,$3,'fixture','fixture','primary_a','fixture','primary-a','fixture','{}',1,'done')`, [job,project,generation]);
  await db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,'fixture',$4,$5,'pdf','[{},{}]')",
    [project,document,version,receipt,hash]);
  const first = randomUUID(), second = randomUUID(), third = randomUUID(), ocr = randomUUID();
  async function evidence(id, representation, page, extra = {}) {
    const payload = { id,source, receiptId:receipt,format:'pdf',representation,
      mediaType:representation === 'render' ? 'image/png' : 'application/json',
      sha256:hash,address:{unitId:'page-'+page,locator:{page}}, ...extra };
    await db.query(`INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload)
      VALUES($1,$2,$3,'fixture',$4,'A',$5,$6,$7)`, [id,project,version,job,'read-'+id,hash,JSON.stringify(payload)]);
  }
  await evidence(first,'render',1);
  await evidence(second,'render',2);
  await evidence(third,'render',1);
  await evidence(ocr,'ocr',2,{inputImage:{sha256:hash}});
  async function event(sequence, payload) {
    await db.query('INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,$2,$3)', [job,sequence,JSON.stringify(payload)]);
  }
  const local = randomUUID(), paid = randomUUID();
  await event(1,{kind:'tool',reply:{evidence:{evidenceId:first,sha256:hash},image:{mediaType:'image/png',data:'iVBORw0KGgo-fixture'}}});
  await event(2,{kind:'model',attemptId:local,requestHash:hash,inputRefs:[first,second]});
  await event(3,{kind:'model',attemptId:paid,requestHash:hash,inputRefs:[third],
    visualReceipts:[{evidenceId:third,part:1,total:2}]});
  await db.query(`INSERT INTO gateway_attempts(id,ledger_id,project_id,scope_id,generation_id,job_id,purpose,effect_key,request_hash,
    route_id,revision,ceiling_usd_nanos,state,input_refs)
    VALUES($1,$2,$3,NULL,$4,$5,'primary_a','fixture',$6,'fixture','fixture',1,'paid',$7)`,
    [paid,randomUUID(),project,generation,job,hash,JSON.stringify([third])]);
  const noLocalLedger = await read();
  assert.equal(noLocalLedger.items[0].pixels.confirmedImages, 0);
  assert.equal(noLocalLedger.items[0].pixels.partialImages, 1);
  assert.equal(noLocalLedger.items[0].openings.latestOcrInputId, ocr);

  await db.query(`CREATE TABLE local_terra_calls (id uuid PRIMARY KEY,project_id uuid,job_id uuid,request_hash text,
    model text,state text,finished_at timestamptz DEFAULT clock_timestamp())`);
  await db.query("INSERT INTO local_terra_calls(id,project_id,job_id,request_hash,model,state) VALUES($1,$2,$3,$4,'gpt-6.1-terra','unknown')",
    [local,project,job,hash]);
  assert.equal((await read()).items[0].pixels.confirmedImages, 0);
  await db.query("UPDATE local_terra_calls SET state='completed' WHERE id=$1", [local]);
  const active = (await read()).items[0];
  assert.equal(active.pixels.confirmedImages, 1);
  assert.equal(active.pixels.partialImages, 1);
  assert.equal(active.openings.rendered, 2);
  assert.equal(active.openings.ocr, 1);
  assert.equal(active.mapUnits, 2);

  const { publishPreliminaryPackageReview } = await built('preliminary-package-review.js');
  const report = await publishPreliminaryPackageReview(db, { projectId:project,receiptId:receipt,catalogVersionId:cat,model:'gpt-6.1-terra',
    inventory:[{versionId:version,originalSha256:hash}],scopeNote:'Ограничения',draftText:'Черновик',
    rows:[{key:'doc',status:'present',finding:'Найден',sources:[{versionId:version,originalSha256:hash,anchor:'стр. 2'}]}] });
  const reportPath = receiptRoute + '?reviewId=' + report.id;
  const cited = await read(reportPath);
  assert.equal(cited.historical, false);
  assert.deepEqual(cited.items[0].citations, {count:1,examples:[{key:'doc',title:'Document',anchor:'стр. 2'}]});
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[otherReceipt,project,user]);
  const later = randomUUID();
  await evidence(later,'ocr',3,{inputImage:{sha256:hash}});
  const historical = await read(reportPath);
  assert.equal(historical.historical, true);
  assert.equal(historical.items[0].openings.latestOcrId, ocr);
  assert.equal(historical.items[0].citations.count, 1);
  await read(`/api/v1/projects/${project}/receipts/${otherReceipt}/evidence-chain?reviewId=${report.id}`,404);
  await read(receiptRoute+'?versionId='+randomUUID(),404);
  await db.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [project,user]);
  await read(reportPath,404);
});
