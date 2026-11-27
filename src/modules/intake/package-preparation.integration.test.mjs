import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';

const url = process.env.PACKAGE_PREPARATION_TEST_DATABASE_URL;
test('receipt preparation is atomic, replayable and admits only current readable inputs', { skip: !url }, async (t) => {
  assert.equal(new URL(url).pathname, '/fixture');
  assert.match(new URL(url).hostname, /^(127\.0\.0\.1|localhost)$/);
  const db = new pg.Pool({ connectionString: url });
  let client;
  t.after(async () => { client?.release(); await db.end(); });
  assert.equal((await db.query("SELECT to_regclass('public.projects') AS value")).rows[0].value, null);
  for (const name of (await readdir('db/migrations')).filter(x => x.endsWith('.sql')).sort())
    await db.query(await readFile(`db/migrations/${name}`, 'utf8'));
  const { capturePackagePreparation: capture, readPackagePreparation: view } = await import('../../../dist/src/modules/intake/package-preparation.js');
  client = await db.connect();
  const { rows: [owner] } = await client.query(`WITH org AS (INSERT INTO organizations(name) VALUES ('fixture') RETURNING id),
    actor AS (INSERT INTO users(organization_id,login) SELECT id,'fixture' FROM org RETURNING id),
    project AS (INSERT INTO projects(organization_id,name,intake_mode) SELECT id,'fixture',true FROM org RETURNING id),
    receipt AS (INSERT INTO intake_receipts(project_id,source,created_by) SELECT project.id,'upload',actor.id FROM project,actor RETURNING id)
    SELECT project.id AS project,actor.id AS actor,receipt.id AS receipt FROM project,actor,receipt`);
  const generation = randomUUID();
  await client.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,NULL,$2)', [owner.project, generation]);
  await client.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)', [owner.project, generation]);
  const input = { projectId: owner.project, receiptId: owner.receipt, expectedReaderVersions: {}, verifiedDerivatives: {} };
  async function tx(fn) { await client.query('BEGIN'); try { const result = await fn(); await client.query('COMMIT'); return result; } catch (e) { await client.query('ROLLBACK'); throw e; } }
  assert.equal((await tx(() => capture(client, input))).state, 'waiting');
  await client.query('UPDATE intake_receipts SET sealed_at=now() WHERE id=$1', [owner.receipt]);
  await client.query("INSERT INTO intake_receipts(project_id,source,created_by) VALUES($1,'upload',$2)", [owner.project,owner.actor]);
  const empty = await tx(() => capture(client, input));
  assert.equal(empty.state, 'ready'); assert.equal(empty.manifest.counts.available, 0);
  assert.equal((await tx(() => capture(client, input))).manifestId, empty.manifestId);
  async function add(label, media, parentId = null) {
    const ids = { document: randomUUID(), original: randomUUID(), version: randomUUID(), occurrence: randomUUID() };
    const sha = ids.original.replaceAll('-', '').padEnd(64, '0');
    await client.query('INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)', [ids.original, owner.project, ids.original, sha]);
    await client.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)', [ids.document, owner.project]);
    await client.query('INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,$5)', [ids.version,owner.project,ids.document,ids.original,media]);
    await client.query(`INSERT INTO intake_occurrences(id,project_id,receipt_id,parent_occurrence_id,relative_path,declared_media_type,version_id,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'accepted')`, [ids.occurrence,owner.project,owner.receipt,parentId,label,media,ids.version]);
    await client.query('INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)', [owner.project,owner.receipt,ids.document,ids.version,ids.original]);
    return { ...ids, sha };
  }
  async function map(a, format, version, units, opts = {}) {
    const fp = randomUUID();
    await client.query('UPDATE harness_package_maps SET active=false WHERE version_id=$1', [a.version]);
    await client.query(`INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format,refusal,physical_limitation)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7)`,[owner.project,a.version,fp,version,format,opts.refusal ?? null,opts.limitation ?? null]);
    if (units) await client.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(version_id,reader_version) DO UPDATE SET units=excluded.units`,[owner.project,a.document,a.version,version,owner.receipt,a.sha,format,JSON.stringify(units)]);
    if (units) await client.query(`INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place) VALUES($1,$2,$3,$4,1,jsonb_build_object('unitId',$5::text))`,[randomUUID(),owner.project,a.version,fp,units[0].id]);
    input.expectedReaderVersions[a.version] = version;
    return fp;
  }
  const pdf = await add('plan.pdf', 'application/pdf');
  assert.equal((await tx(() => capture(client, input))).state, 'waiting');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM intake_package_preparation_current')).rows[0].n, 0);
  const pdfFp = await map(pdf, 'pdf', 'pdf-v1', [{id:'1',locator:{page:1}}]);
  await client.query(`INSERT INTO intake_manifest_items(receipt_id,id,added_version,position,kind,relative_path,size,sha256,media_type,excluded_at,excluded_by,exclusion_reason)
    VALUES($1,$2,1,1,'file','excluded.pdf',1,$3,'application/pdf',now(),$4,'excluded_by_owner')`,[owner.receipt,randomUUID(),'b'.repeat(64),owner.actor]);
  const zip = await add('broken.zip', 'application/zip');
  await client.query("UPDATE intake_occurrences SET restriction='archive_corrupt' WHERE id=$1", [zip.occurrence]);
  const office = await add('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const child = await add('word/document.xml', 'application/xml', office.occurrence);
  await map(office, 'docx', 'doc-v1', [{id:'paragraph-1'}]);
  const ownerFile = await add('~$ec.docx', 'application/octet-stream');
  await map(ownerFile, 'docx', 'doc-v1', [{id:'original',locator:{coverage:'held',limitations:'docx_invalid_or_unreadable'}}]);
  const unsupported = await add('unknown.xyz', 'application/octet-stream');
  await map(unsupported, 'unknown', 'unknown-v1', [{id:'original',locator:{coverage:'original_only',limitations:'format_original_only'}}]);
  const disguisedZip = await add('archive.doc', 'application/zip');
  await map(disguisedZip, 'doc', 'doc-v1', [{id:'original',locator:{coverage:'held',limitations:'doc_signature_invalid'}}]);
  const zipChild = await add('drawing.pdf', 'application/pdf', disguisedZip.occurrence);
  await map(zipChild, 'pdf', 'pdf-v1', [{id:'1',locator:{page:1}}]);
  const dwg = await add('drawing.dwg', 'application/acad');
  const derivativeSha = 'a'.repeat(64);
  const dwgFp = await map(dwg, 'dwg', 'dwg-v1', [{id:'part',locator:{coverage:'partial',derivativeSha256:derivativeSha}},{id:'held',locator:{coverage:'held'}}], {limitation:'physical_inventory_unverified'});
  const heldWindow = randomUUID();
  await client.query(`INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place) VALUES($1,$2,$3,$4,2,'{"unitId":"held"}')`,[heldWindow,owner.project,dwg.version,dwgFp]);
  assert.equal((await tx(() => capture(client, input))).state, 'waiting');
  await client.query(`INSERT INTO dwg_derivatives(project_id,document_id,version_id,original_sha256,reader_version,converter_identity,derivative_sha256,byte_size,format,storage_key)
    VALUES($1,$2,$3,$4,'dwg-v1','fixture',$5,10,'dxf','fixture')`, [owner.project,dwg.document,dwg.version,dwg.sha,derivativeSha]);
  input.verifiedDerivatives[dwg.version] = { readerVersion:'dwg-v1',derivativeSha256:derivativeSha,byteSize:10 };
  const ready = await tx(() => capture(client,input));
  assert.equal(ready.state,'ready');
  assert.deepEqual(ready.manifest.counts,{total:5,available:4,unavailable:1,waiting:0,archives:2,technical:2,restrictions:2});
  assert.ok(ready.manifest.restrictions.some(x=>x.reason==='excluded_by_owner'));
  assert.equal(ready.manifest.items.find(x=>x.versionId===ownerFile.version).reason,'office_owner_file');
  assert.equal(ready.manifest.items.find(x=>x.versionId===child.version).kind, 'technical');
  assert.equal(ready.manifest.items.find(x=>x.versionId===disguisedZip.version).kind, 'archive');
  assert.equal(ready.manifest.items.find(x=>x.versionId===zipChild.version).kind, 'document');
  assert.equal(ready.manifest.items.find(x=>x.versionId===unsupported.version).reason, 'format_original_only');
  assert.equal(ready.manifest.items.find(x=>x.versionId===dwg.version).state, 'available');
  assert.equal(ready.manifest.items.find(x=>x.versionId===dwg.version).windowIds.length, 1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM intake_package_preparation_windows WHERE manifest_id=$1 AND window_id=$2',[ready.manifestId,heldWindow])).rows[0].n,0);
  assert.equal((await tx(() => capture(client,input))).manifestId, ready.manifestId);
  assert.equal((await view(client,input)).manifestId, ready.manifestId);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM intake_package_preparation_items WHERE manifest_id=$1 AND (version_id,map_fingerprint) IN (($2,$3),($4,$5))',[ready.manifestId,pdf.version,pdfFp,dwg.version,dwgFp])).rows[0].n,2);
  input.expectedReaderVersions[pdf.version] = 'pdf-v2';
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,attempt_key)
      VALUES($1,$2,$3,'saved_review','restored','restored-fixture')`,[owner.project,owner.receipt,ready.manifestId]);
    assert.equal((await capture(client,input)).state,'restored');
    assert.equal((await view(client,input)).manifestId,ready.manifestId);
    assert.equal((await client.query('SELECT manifest_id FROM intake_package_preparation_current WHERE receipt_id=$1',[owner.receipt])).rows[0].manifest_id,ready.manifestId);
  } finally {await client.query('ROLLBACK');}
  assert.equal((await view(client,input)).manifestId,null);
  assert.equal((await tx(() => capture(client,input))).state,'waiting');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM intake_package_preparation_current')).rows[0].n,0);
  await map(pdf,'pdf','pdf-v2',[{id:'1',locator:{page:1}}]);
  await client.query('BEGIN');
  const rolledBack = await capture(client,input);
  assert.equal(rolledBack.state,'ready');
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM intake_package_preparations WHERE id=$1',[rolledBack.manifestId])).rows[0].n,0);
  const newer = await tx(() => capture(client,input));
  assert.equal(newer.revision,ready.revision+1); assert.notEqual(newer.manifestId,ready.manifestId);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM gateway_jobs')).rows[0].n,0);

  const signature = await add('plan.pdf.sig', 'application/octet-stream');
  const onlyCopy = await add('drawing.pdf.sig', 'application/octet-stream', disguisedZip.occurrence);
  const detached = await add('detached.sig', 'application/octet-stream');
  const unknown = await add('unknown.sig', 'application/octet-stream');
  const page = (embeddedSha256) => ({ id: '1', locator: { page: 1, signatureKind: 'embedded_pdf', embeddedSha256 } });
  await map(signature, 'sig', 'cms-v1', [page(pdf.sha)]);
  await map(onlyCopy, 'sig', 'cms-v1', [page(onlyCopy.sha)]);
  await map(detached, 'sig', 'cms-v1', [{ id: 'original', locator: { signatureKind: 'signature_detached', coverage: 'original_only' } }]);
  await map(unknown, 'sig', 'cms-v1', null, { refusal: 'signature_format_unsupported' });
  const withSignatures = await tx(() => capture(client, input));
  const byVersion = new Map(withSignatures.manifest.items.map((item) => [item.versionId, item]));
  assert.equal(byVersion.get(signature.version).reason, 'signature_pdf_duplicate');
  assert.equal(byVersion.get(signature.version).kind, 'technical');
  assert.deepEqual(byVersion.get(signature.version).relatedPdf,
    { occurrenceId: pdf.occurrence, documentId: pdf.document, versionId: pdf.version, label: 'plan.pdf' });
  assert.equal(byVersion.get(onlyCopy.version).state, 'available');
  assert.equal(byVersion.get(detached.version).reason, 'signature_detached');
  assert.equal(byVersion.get(unknown.version).state, 'unavailable');
  assert.equal(byVersion.get(unknown.version).originalSha256, unknown.sha);
  const admitted = await client.query('SELECT version_id FROM intake_package_preparation_items WHERE manifest_id=$1 AND version_id=ANY($2::uuid[])',
    [withSignatures.manifestId, [signature.version, onlyCopy.version, detached.version, unknown.version]]);
  assert.deepEqual(admitted.rows.map(({ version_id }) => version_id), [onlyCopy.version]);
});
