import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

const connectionString = process.env.PACKAGE_MAP_SCHEDULING_TEST_DATABASE_URL;
const hash = value => createHash('sha256').update(value).digest('hex');

test('unattempted intake maps before historical retries, which run in deadline order', {
  skip: !connectionString,
}, async t => {
  const url = new URL(connectionString);
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.pathname,'/test_facade_package_map_fair');
  const [{WorkQueue},{activatePackageProjects,preparePackageMap}] = await Promise.all([
    import('../../../dist/src/modules/gateway/queue.js'),import('../../../dist/src/modules/harness/package-dispatch.js'),
  ]);
  const db = new pg.Pool({connectionString});
  t.after(()=>db.end());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n,0);
  const {rows:[owner]} = await db.query(`WITH org AS (INSERT INTO organizations(name) VALUES('Fixture') RETURNING id),
    actor AS (INSERT INTO users(organization_id,login) SELECT id,'map-fixture' FROM org RETURNING id),
    projects AS (INSERT INTO projects(organization_id,name,intake_mode)
      SELECT org.id,label,true FROM org CROSS JOIN (VALUES('Previous'),('New')) p(label) RETURNING id,name)
    SELECT actor.id AS actor,older.id AS previous,newer.id AS fresh FROM actor,projects older,projects newer
    WHERE older.name='Previous' AND newer.name='New'`);
  const queue = new WorkQueue(db);
  await activatePackageProjects(db,queue,[owner.previous]);
  async function accept(projectId,name,ageSeconds) {
    const versionId = randomUUID();
    const {rows:[target]} = await db.query(`WITH receipt AS (INSERT INTO intake_receipts(project_id,source,created_by,sealed_at)
        VALUES($1,'upload',$2,clock_timestamp()) RETURNING id),
      original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
        VALUES(gen_random_uuid(),$1,$3,1,$4) RETURNING id),
      document AS (INSERT INTO intake_documents(project_id) VALUES($1) RETURNING id),
      version_row AS (INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type)
        SELECT $5,$1,document.id,original.id,'application/pdf' FROM original,document RETURNING id,document_id,original_id),
      occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
        SELECT $1,receipt.id,$3,'application/pdf',version_row.id,'accepted' FROM receipt,version_row RETURNING id)
      INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id,created_at)
      SELECT $1,receipt.id,version_row.document_id,version_row.id,version_row.original_id,clock_timestamp()-make_interval(secs=>$6)
      FROM receipt,version_row,occurrence RETURNING receipt_id`,[projectId,owner.actor,name,hash(name),versionId,ageSeconds]);
    return {versionId,receiptId:target.receipt_id};
  }
  const previousOldest = await accept(owner.previous,'historical-1.pdf',120);
  const retryLongest = await accept(owner.previous,'historical-2.pdf',90);
  const previousRemap = await accept(owner.previous,'historical-remap.pdf',70);
  const previousWaiting = await accept(owner.previous,'historical-wait.pdf',60);
  const fresh = await accept(owner.fresh,'new-receipt.pdf',0);
  for (const {versionId} of [previousOldest,retryLongest,previousRemap,previousWaiting]) {
    await db.query(`INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,
      requested_reader_version,format,physical_limitation) VALUES($1,$2,$3,'stale-profile','stale-profile','pdf','fixture')`,
    [owner.previous,versionId,hash(versionId)]);
  }
  await db.query(`INSERT INTO harness_package_map_retries(version_id,reason,retry_at) VALUES
    ($1,'reader_resource_wait',clock_timestamp()-interval '10 seconds'),
    ($2,'dwg_index_identity_changed',clock_timestamp()-interval '30 seconds'),
    ($3,'reader_resource_wait',clock_timestamp()+interval '1 hour')`,
  [previousOldest.versionId,retryLongest.versionId,previousWaiting.versionId]);
  const attempts = [];
  const readerVersion = 'fixture-current';
  const reader = {
    formatFor:()=> 'pdf',readerVersion:()=>readerVersion,
    async map(source) {
      attempts.push(source.versionId);
      const units = [{id:'1',width:200,height:200,locator:{page:1}}];
      await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
        SELECT project_id,document_id,version_id,$2,receipt_id,$3,'pdf',$4 FROM intake_reader_jobs WHERE version_id=$1`,
      [source.versionId,readerVersion,source.sha256,JSON.stringify(units)]);
      return {source,readerVersion,format:'pdf',units};
    },
  };
  const next = ()=>preparePackageMap(db,queue,reader,[]);
  assert.equal(await next(),true);
  assert.deepEqual(attempts,[fresh.versionId]);
  const {rows:[published]} = await db.query(`SELECT j.dispatched_at IS NOT NULL AS dispatched,
    m.reader_version,cur.manifest_id IS NOT NULL AS manifest FROM intake_reader_jobs j
    JOIN harness_package_maps m ON m.project_id=j.project_id AND m.version_id=j.version_id AND m.active
    JOIN intake_package_preparation_current cur ON cur.project_id=j.project_id AND cur.receipt_id=j.receipt_id
    WHERE j.project_id=$1 AND j.receipt_id=$2`,[owner.fresh,fresh.receiptId]);
  assert.deepEqual(published,{dispatched:true,reader_version:readerVersion,manifest:true});
  assert.equal(await next(),true);
  assert.equal(await next(),true);
  assert.equal(await next(),true);
  assert.equal(await next(),false);
  assert.deepEqual(attempts,[fresh.versionId,previousRemap.versionId,retryLongest.versionId,previousOldest.versionId]);
  assert.deepEqual((await db.query('SELECT version_id FROM harness_package_map_retries')).rows,
    [{version_id:previousWaiting.versionId}]);
});
