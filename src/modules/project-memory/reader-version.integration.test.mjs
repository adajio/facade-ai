import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import pg from 'pg';
const url=process.env.FACADE_MEMORY_UPGRADE_DB;
const root=process.env.FACADE_MEMORY_TEST_DIST ?? resolve('dist');
const load=name=>import(pathToFileURL(join(root,'src/modules',name)));
test('reader version upgrade indexes the active map and preserves old snapshot and proof', {skip:!url,timeout:120000}, async()=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname) && /^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
 const schema=`mem_${randomUUID().replaceAll('-','')}`, admin=new pg.Pool({connectionString:url}); let db;
 try {
  await admin.query(`CREATE SCHEMA "${schema}"`); db=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`});
  for(const f of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')&&!n.startsWith('01_')&&!n.startsWith('38_')).sort()) await db.query(await readFile(join('db/migrations',f),'utf8'));
  const {indexNextProjectMemory,searchProjectMemory,readProjectMemory}=await load('project-memory/index.js');
  const {blockId,fingerprint}=await load('project-memory/contracts.js');
  const [org,user,sessionId,cat,project,receipt,original,document,version]=Array.from({length:9},randomUUID);
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login,password_hash,state) VALUES($1,$2,$3,'$argon2id$fixture','active')",[user,org,`${user}@test`]);
  await db.query("INSERT INTO access_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[sessionId,user,randomBytes(32)]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'test',1,'test','[]',$3)",[cat,org,user]);
  await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id) VALUES($1,$2,'fixture',$3)",[project,org,cat]);
  await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'engineer')",[org,project,user]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receipt,project,user]);
  await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,'fixture',1,$3)",[original,project,'a'.repeat(64)]);
  await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[document,project]);
  await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'text/plain')",[version,project,document,original]);
  await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,'fixture.txt','text/plain',$3,'accepted')",[project,receipt,version]);
  await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)",[project,receipt,document,version,original]);
  const source={projectId:project,documentId:document,versionId:version,sha256:'a'.repeat(64)};
  const unit={id:'unit',locator:{coverage:'addressable'}}; let active='v1';
  const putMap=async readerVersion=>db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,$4,$5,$6,'txt',$7)",[project,document,version,readerVersion,receipt,source.sha256,JSON.stringify([unit])]);
  await putMap('v1');
  const presentations=new Map(); let materializations=0, failV2=true;
  const reader={async map(){return {source,receiptId:receipt,readerVersion:active,format:'txt',units:[unit]}},
    async materializeNative(_source,readerVersion,start,_count,publish){materializations++;assert.equal(readerVersion,active);if(readerVersion==='v2' && failV2){failV2=false;throw new Error('fixture interruption')}const presentation={address:{unitId:'unit',locator:unit.locator},lines:[{id:'line',text:`content ${readerVersion}`,locator:{line:1}}],limitations:[]};const sha256=readerVersion==='v1'?'b'.repeat(64):'c'.repeat(64);presentations.set(sha256,presentation);await publish({ordinal:start,unit,presentation,artifact:{sha256,size:1}})},
    async readMaterializedNative(_project,artifact){return presentations.get(artifact.sha256)}};
  // Seed an actually pre-migration v1 index and snapshot, then migrate in place.
  const previousId=blockId(source,'v1',unit.id), previousSha='b'.repeat(64);
  const previousPresentation={address:{unitId:'unit',locator:unit.locator},lines:[{id:'line',text:'content v1',locator:{line:1}}],limitations:[]};
  presentations.set(previousSha,previousPresentation);
  await db.query("INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal) VALUES($1,$2,1,'v1','txt',1,1)",[project,version]);
  await db.query("INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining) VALUES($1,$2,$3,1,0,'unit',$4,$5,1,'{}','{}')",[previousId,project,version,JSON.stringify(previousPresentation.address),previousSha]);
  await db.query("INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address) VALUES($1,0,'line','content v1','content v1',$2)",[previousId,JSON.stringify({unitId:'unit',locator:{...unit.locator,line:1}})]);
  const oldManifest={version:1,versions:[{versionId:version,documentId:document,sha256:source.sha256,readerVersion:'v1',total:1,indexed:1,limitation:null}]};
  const oldSnapshot=fingerprint([project,oldManifest]);
  await db.query('INSERT INTO project_memory_snapshots(project_id,fingerprint,manifest) VALUES($1,$2,$3)',[project,oldSnapshot,JSON.stringify(oldManifest)]);
  await db.query(await readFile('db/migrations/38_project_memory_reader_versions.sql','utf8'));
  const session={id:user,organizationId:org,sessionId};
  const before=await searchProjectMemory(db,session,{projectId:project,query:'content v1',snapshot:oldSnapshot});
  assert.equal(before.hits.length,1);
  const generation=randomUUID();
  await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)',[project]);
  await db.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,NULL,$2)',[project,generation]);
  await db.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)',[project,generation]);
  await db.query("INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,format) VALUES($1,$2,'map-v1','v1','txt')",[project,version]);
  await putMap('v2');
  await db.query("INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,format,active) VALUES($1,$2,'map-v2','v2','txt',false)",[project,version]);
  assert.equal(await indexNextProjectMemory(db,reader),false,'an inactive map must not replace the active package');
  await db.query("UPDATE harness_package_maps SET active=false WHERE version_id=$1 AND fingerprint='map-v1'",[version]);
  await db.query("UPDATE harness_package_maps SET active=true WHERE version_id=$1 AND fingerprint='map-v2'",[version]); active='v2';
  assert.equal(await indexNextProjectMemory(db,reader),true,'v2 must be queued even when v1 was completed');
  assert.equal(await indexNextProjectMemory(db,reader),true); // expected interruption, cursor stays at zero
  assert.equal((await db.query('SELECT next_ordinal FROM project_memory_versions WHERE version_id=$1',[version])).rows[0].next_ordinal,0);
  await db.query('UPDATE project_memory_versions SET retry_at=clock_timestamp() WHERE version_id=$1',[version]);
  assert.equal(await indexNextProjectMemory(db,reader),true);
  const after=await searchProjectMemory(db,session,{projectId:project,query:'content v2'});
  assert.equal(after.hits.length,1);
  const old=await searchProjectMemory(db,session,{projectId:project,query:'content v1',snapshot:before.snapshot});
  assert.equal(old.hits[0].blockId,before.hits[0].blockId);
  const reopened=await readProjectMemory(db,reader,session,{projectId:project,snapshot:before.snapshot,blockId:before.hits[0].blockId});
  assert.equal(reopened.lines[0].text,'content v1');
  // The compatibility view exposes only v2, but a previously pinned Copilot input remains valid.
  const visible=await db.query('SELECT id FROM project_memory_blocks WHERE version_id=$1',[version]);
  assert.deepEqual(visible.rows.map(row=>row.id),[after.hits[0].blockId]);
  const existingJoin=await db.query(`SELECT b.id FROM project_memory_blocks b
    JOIN project_memory_versions v USING(project_id,version_id,contract)
    JOIN reader_maps r USING(project_id,version_id,reader_version) WHERE b.version_id=$1`,[version]);
  assert.deepEqual(existingJoin.rows.map(row=>row.id),[after.hits[0].blockId]);
  const {verifyCopilotInputs}=await load('copilot/admission.js');
  const [job,question]=Array.from({length:2},randomUUID);
  const ref={id:'old-proof',documentId:document,versionId:version,sha256:source.sha256,proof:{kind:'memory',blockId:before.hits[0].blockId}};
  await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,spec_hash,payload,priority,cursor)
    VALUES($1,$2,NULL,$3,'copilot','copilot_question','review',$4,'fixture','{"mode":"copilot"}',1,$5)`,[job,project,generation,question,JSON.stringify({found:[ref]})]);
  await db.query("INSERT INTO copilot_questions(id,organization_id,project_id,user_id,session_id,question,job_id) VALUES($1,$2,$3,$4,$5,'fixture',$6)",[question,org,project,user,sessionId,job]);
  assert.equal(await verifyCopilotInputs(db,{projectId:project,scopeId:null,jobId:job,inputRefs:['old-proof']}),true);
  // Existing insert callers omit reader_version; the compatibility view fills the current value.
  const extra='d'.repeat(64);
  await db.query(`INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,limitations,remaining)
    VALUES($1,$2,$3,1,1,'fixture-extra','{}','{}','{}')`,[extra,project,version]);
  assert.equal((await db.query('SELECT reader_version FROM project_memory_blocks_all WHERE id=$1',[extra])).rows[0].reader_version,'v2');
  await db.query('DELETE FROM project_memory_blocks WHERE id=$1',[extra]);
  // Switching back restores the previous cursor rather than inserting conflicting blocks or rereading.
  await db.query("UPDATE harness_package_maps SET active=false WHERE version_id=$1 AND fingerprint='map-v2'",[version]);
  await db.query("UPDATE harness_package_maps SET active=true WHERE version_id=$1 AND fingerprint='map-v1'",[version]); active='v1';
  assert.equal(await indexNextProjectMemory(db,reader),true);
  assert.equal((await db.query('SELECT next_ordinal FROM project_memory_versions WHERE version_id=$1',[version])).rows[0].next_ordinal,1);
  assert.equal(await indexNextProjectMemory(db,reader),false);
  await db.query("UPDATE harness_package_maps SET active=false WHERE version_id=$1 AND fingerprint='map-v1'",[version]);
  await db.query("UPDATE harness_package_maps SET active=true WHERE version_id=$1 AND fingerprint='map-v2'",[version]); active='v2';
  assert.equal(await indexNextProjectMemory(db,reader),true);
  assert.equal(await indexNextProjectMemory(db,reader),false);
  assert.equal(materializations,2);
 } finally {if(db) await db.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
