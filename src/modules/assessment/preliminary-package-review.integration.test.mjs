import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const url = process.env.PRELIMINARY_TEST_DATABASE_URL;
test('preliminary review publication and receipt-scoped reading progress', { skip: !url }, async () => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) && /^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname),
    'PRELIMINARY_TEST_DATABASE_URL must name a local disposable facade_test_* database');
  const schema = `preliminary_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  let db;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    const directory = resolve('db/migrations');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql') && !n.startsWith('01_')).sort()) {
      await db.query(await readFile(resolve(directory, name), 'utf8'));
    }
    const { publishPreliminaryPackageReview, readPreliminaryReadingProgress } = await import(pathToFileURL(resolve(
      process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/assessment/preliminary-package-review.js')).href);
    const [org,user,cat,project,receipt,foreignReceipt,original,document,version,occurrence] = Array.from({ length: 10 }, randomUUID);
    const hash = 'a'.repeat(64);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'fixture')", [org]);
    await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)", [user,org,`${user}@fixture`]);
    await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)", [cat,org,JSON.stringify([{ key:'doc', part:'Document' }]),user]);
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'fixture',$3,'Стадия 1')", [project,org,cat]);
    await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$3,'upload',$4,now()),($2,$3,'upload',$4,now())", [receipt,foreignReceipt,project,user]);
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)", [original,project,original,hash]);
    await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)", [document,project]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')", [version,project,document,original]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'fixture.pdf','application/pdf',$4,'accepted')", [occurrence,project,receipt,version]);
    const input = { projectId: project, receiptId: receipt, catalogVersionId: cat, model: 'gpt-6.1-terra',
      inventory: [{ versionId: version, originalSha256: hash }], scopeNote: 'Ограничения', draftText: 'Черновик',
      rows: [{ key:'doc', status:'present', finding:'Найден', sources:[{ versionId:version, originalSha256:hash, anchor:'стр. 1' }] }] };
    await assert.rejects(publishPreliminaryPackageReview(db, { ...input, receiptId: foreignReceipt }));
    await db.query('UPDATE intake_occurrences SET inventory_pending=true WHERE id=$1', [occurrence]);
    await assert.rejects(publishPreliminaryPackageReview(db, input));
    await db.query('UPDATE intake_occurrences SET inventory_pending=false WHERE id=$1', [occurrence]);
    await assert.rejects(publishPreliminaryPackageReview(db, { ...input, inventory:[{versionId:version,originalSha256:'b'.repeat(64)}] }));
    const report = await publishPreliminaryPackageReview(db, input);
    assert.deepEqual(await publishPreliminaryPackageReview(db, input), report);
    const zero = {totalWindows:0,mappedVersions:0,acceptedVersions:1,completed:0,covered:0,noMatch:0,refused:0,held:0,reading:0};
    assert.deepEqual(await readPreliminaryReadingProgress(db, project, report.id), zero);
    await assert.rejects(readPreliminaryReadingProgress(db, randomUUID(), report.id), { statusCode:404 });
    const [generation, windowId, jobId] = Array.from({length:3}, randomUUID);
    await db.query('INSERT INTO intake_reader_jobs(id,project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(),project,receipt,document,version,original]);
    await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)', [project]);
    await db.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,NULL,$2)', [project,generation]);
    await db.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)', [project,generation]);
    await db.query("INSERT INTO harness_package_maps(project_id,version_id,fingerprint,format) VALUES($1,$2,'fixture','pdf')", [project,version]);
    await db.query("INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place) VALUES($1,$2,$3,'fixture',1,'{}')", [windowId,project,version]);
    await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,'primary-a','A','fixture')", [generation]);
    await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority,state,result)
      VALUES($1,$2,NULL,$3,'fixture','fixture','primary_a','fixture','primary-a','fixture','{}',1,'done','{"kind":"covered"}')`, [jobId,project,generation]);
    await db.query("INSERT INTO harness_package_branches(window_id,branch,profile_hash,settings,job_id) VALUES($1,'A','fixture',$2,$3)", [windowId,JSON.stringify({model:'gpt-6.1-terra'}),jobId]);
    assert.deepEqual(await readPreliminaryReadingProgress(db, project, report.id), {...zero,totalWindows:1,mappedVersions:1,completed:1,covered:1});
  } finally {
    if (db) await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
