import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
  const oldProfile = process.env.FACADE_HARNESS_PROFILE;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    const directory = resolve('db/migrations');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql') && !n.startsWith('01_')).sort()) {
      await db.query(await readFile(resolve(directory, name), 'utf8'));
    }
    const { publishPreliminaryPackageReview, readPreliminaryReadingProgress } = await import(pathToFileURL(resolve(
      process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/assessment/preliminary-package-review.js')).href);
    const { readTerraReading } = await import(pathToFileURL(resolve(process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/assessment/terra-reading.js')).href);
    const [org,user,cat,project,receipt,foreignReceipt,original,document,version,occurrence] = Array.from({ length: 10 }, randomUUID);
    const hash = 'a'.repeat(64);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'fixture')", [org]);
    await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)", [user,org,`${user}@fixture`]);
    await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)", [cat,org,JSON.stringify([{ key:'doc', part:'Document' }]),user]);
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'fixture',$3,'Стадия 1')", [project,org,cat]);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'codex-subscription-terra', model:'gpt-6.1-terra', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    await db.query('UPDATE projects SET intake_mode=true WHERE id=$1', [project]);
    const emptyProject = await readTerraReading(db, project);
    assert.equal(emptyProject.enabled, true);
    assert.equal(emptyProject.receipt, null);
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
    delete process.env.FACADE_HARNESS_PROFILE;
    assert.equal((await readTerraReading(db, project)).enabled, false);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'codex-subscription-terra', model:'gpt-6.1-terra', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    await db.query('UPDATE projects SET intake_mode=true WHERE id=$1', [project]);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'cheaperinference-terra-reader', model:'gpt-6.1-terra', dataClass:'customer', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    assert.equal((await readTerraReading(db, project)).enabled, false);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'codex-subscription-terra', model:'gpt-6.1-terra', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'codex-subscription-terra', model:'gpt-6.1-terra', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 }, B: { routeId:'qwen', model:'qwen', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    assert.equal((await readTerraReading(db, project)).enabled, false);
    process.env.FACADE_HARNESS_PROFILE = JSON.stringify({ A: { routeId:'codex-subscription-terra', model:'gpt-6.1-terra', dataClass:'synthetic', maxTokens:100, maxTurns:1, maxKnownRejections:0 } });
    const beforeReport = await readTerraReading(db, project);
    assert.equal(beforeReport.enabled, true);
    assert.equal(beforeReport.report, null);
    assert.equal(beforeReport.receipt.receiptId, foreignReceipt);
    assert.equal(beforeReport.progress.totalWindows, 0);
    await db.query('DELETE FROM intake_receipts WHERE id=$1', [foreignReceipt]);
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
    await db.query("INSERT INTO harness_package_branches(window_id,branch,profile_hash,settings,job_id) VALUES($1,'A','fixture',$2,$3)", [windowId,JSON.stringify({model:'gpt-6.1-terra',routeId:'codex-subscription-terra'}),jobId]);
    assert.deepEqual(await readPreliminaryReadingProgress(db, project, report.id), {...zero,totalWindows:1,mappedVersions:1,completed:1,covered:1});
    const evidence = randomUUID(), observation = randomUUID();
    await db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,'fixture',$4,$5,'pdf','[]')", [project,document,version,receipt,hash]);
    await db.query("INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload) VALUES($1,$2,$3,'fixture',$4,'A','read',$5,'{}')", [evidence,project,version,jobId,hash]);
    await db.query("INSERT INTO reader_observations(id,project_id,version_id,run_id,branch,operation_key,request_sha256,evidence_id,scope_id,payload) VALUES($1,$2,$3,$4,'A','pin',$5,$6,NULL,$7)", [observation,project,version,jobId,hash,evidence,JSON.stringify({address:{unitId:'page-1',locator:{page:1}},quote:'Окно',value:'1200',unit:'мм'})]);
    const overview = await readTerraReading(db, project);
    assert.equal(overview.receipt.receiptId, receipt);
    assert.equal(overview.receipt.rootFiles, 1);
    assert.equal(overview.report.id, report.id);
    assert.equal(overview.report.summary.present, 1);
    assert.equal(overview.progress.observations, 1);
    assert.equal(overview.activity[0].quote, 'Окно');
    assert.equal(overview.activity[0].anchor.locator.page, 1);
    await db.query("INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place) VALUES($1,$2,$3,'fixture',2,'{}')", [randomUUID(),project,version]);
    const pendingOverview = await readTerraReading(db, project);
    assert.equal(pendingOverview.progress.totalWindows, 2);
    assert.equal(pendingOverview.progress.queued, 0);
    assert.equal(pendingOverview.progress.unassigned, 1);
    const [zipVersion,docxVersion,xmlVersion,zipOcc,docxOcc,xmlOcc] = Array.from({length:6}, randomUUID);
    for (const id of [zipVersion,docxVersion,xmlVersion]) await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/octet-stream')", [id,project,document,original]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,parent_occurrence_id,relative_path,declared_media_type,version_id,state) VALUES($1,$4,$5,NULL,'source.zip','application/zip',$6,'accepted'),($2,$4,$5,$1,'part.docx','application/zip',$7,'accepted'),($3,$4,$5,$2,'word/document.xml','application/xml',$8,'accepted')", [zipOcc,docxOcc,xmlOcc,project,receipt,zipVersion,docxVersion,xmlVersion]);
    const markerVersion = randomUUID(), markerOccurrence = randomUUID();
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/xml')", [markerVersion,project,document,original]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,parent_occurrence_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,$4,'[Content_Types].xml','application/xml',$5,'accepted')", [markerOccurrence,project,receipt,docxOcc,markerVersion]);
    const nested = (await readTerraReading(db, project)).receipt;
    assert.deepEqual([nested.rootFiles,nested.rootArchives,nested.directChildren,nested.deeperChildren,nested.officeParts], [1,1,1,2,2]);
    await db.query('DELETE FROM preliminary_package_reviews WHERE id=$1', [report.id]);
    delete process.env.FACADE_HARNESS_PROFILE;
    assert.equal((await readTerraReading(db, project)).enabled, true);
    const bJob = randomUUID();
    await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,'primary-b','B','fixture')", [generation]);
    await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority,state)
      VALUES($1,$2,NULL,$3,'fixture-b','fixture','primary_b','fixture','primary-b','fixture','{}',1,'done')`, [bJob,project,generation]);
    await db.query("INSERT INTO harness_package_branches(window_id,branch,profile_hash,settings,job_id) VALUES($1,'B','fixture-b',$2,$3)", [windowId,JSON.stringify({model:'qwen',routeId:'qwen'}),bJob]);
    assert.equal((await readTerraReading(db, project)).enabled, false);
    await db.query("UPDATE harness_package_branches SET active=false WHERE window_id=$1 AND branch='B'", [windowId]);
    const leadJob = randomUUID();
    await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,spec_hash,payload,priority,state)
      VALUES($1,$2,NULL,$3,'fixture-lead','fixture','review','fixture','fixture','{}',1,'held')`, [leadJob,project,generation]);
    assert.equal((await readTerraReading(db, project)).enabled, false);
    // Real intake commands with an isolated in-memory object store and temporary staging.
    const { declareOriginal, writePart, finalizeOriginal } = await import(pathToFileURL(resolve(
      process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/intake/uploads.js')).href);
    const { transaction } = await import(pathToFileURL(resolve(
      process.env.ASSESSMENT_BUILD_ROOT ?? 'dist', 'src/modules/access/commands.js')).href);
    const temp = await mkdtemp(join(tmpdir(), 'facade-word-intake-'));
    const objects = new Map();
    const storage = { stagingDir:temp, partSize:8*1024*1024, ttlSeconds:3600, diskGuardBytes:0, objects: {
      async head(key) { const item=objects.get(key); return item && {size:item.bytes.length,sha256:item.sha256}; },
      async put(key, identity, stream) { const chunks=[]; for await (const chunk of stream) chunks.push(chunk); objects.set(key,{bytes:Buffer.concat(chunks),sha256:identity.sha256}); },
      async get(key) { return Readable.from([objects.get(key).bytes]); }, async remove(key) { objects.delete(key); }, close() {} } };
    try {
      const uploadReceipt = randomUUID();
      await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by) VALUES($1,$2,'upload',$3)",[uploadReceipt,project,user]);
      for (const [name, file, expectedArchive] of [['real-word.doc','schedule.docx',false],['real-zip.doc','schedule.xlsx',true],['ole.doc','schedule.doc',false]]) {
        const bytes = await readFile(new URL(`../formats/test/fixtures/${file}`, import.meta.url));
        const digest = createHash('sha256').update(bytes).digest('hex');
        const declaration = await transaction(db, tx => declareOriginal(tx, storage, {projectId:project,receiptId:uploadReceipt,relativePath:name,size:bytes.length,sha256:digest}));
        const coords = {projectId:project,uploadId:declaration.uploadId};
        await writePart(db,storage,{...coords,number:1,length:bytes.length,sha256:digest},Readable.from([bytes]));
        const published = await finalizeOriginal(db,storage,coords);
        const {rows:[result]} = await db.query('SELECT inventory_pending,EXISTS(SELECT 1 FROM import_jobs WHERE occurrence_id=$1) AS archive FROM intake_occurrences WHERE id=$1',[published.occurrenceId]);
        assert.equal(result.inventory_pending,expectedArchive, name);
        assert.equal(result.archive,expectedArchive, name);
        if (name==='real-word.doc') assert.equal(published.mediaType,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      }
    } finally { await rm(temp,{recursive:true,force:true}); }
  } finally {
    if (oldProfile === undefined) delete process.env.FACADE_HARNESS_PROFILE;
    else process.env.FACADE_HARNESS_PROFILE = oldProfile;
    if (db) await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
