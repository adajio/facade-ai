import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const enabled=process.env.FACADE_FIRST_LOOK_INTEGRATION==='1';
const built=(file)=>process.env.FACADE_HARNESS_TEST_DIST
  ?pathToFileURL(join(process.env.FACADE_HARNESS_TEST_DIST,file)).href:new URL(`../../../dist/${file}`,import.meta.url).href;
const hash=(text)=>createHash('sha256').update(text).digest('hex');

test('first overview gives independent branches the indexed register before repeating an original', {skip:!enabled}, async(t)=>{
  const connectionString=process.env.DATABASE_URL;
  assert.match(new URL(connectionString).pathname,/^\/test_facade_first_look_[a-z0-9_]+$/u);
  const db=new pg.Pool({connectionString});
  t.after(()=>db.end());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n,0);
  const { WorkQueue }=await import(built('src/modules/gateway/queue.js'));
  const { dispatchPackagePair,preparePackageMap }=await import(built('src/modules/harness/package-dispatch.js'));
  const { dispatchPackageFollowup,packageFollowupKind,packageStructure }=await import(built('src/modules/harness/package-walk.js'));
  const { readPackageAnalysis }=await import(built('src/modules/harness/package-analysis.js'));
  const queue=new WorkQueue(db);
  const {rows:[owner]}=await db.query(`WITH org AS (INSERT INTO organizations(name) VALUES('Fixture') RETURNING id),
    actor AS (INSERT INTO users(organization_id,login) SELECT id,'first-look' FROM org RETURNING id),
    project AS (INSERT INTO projects(organization_id,name,intake_mode) SELECT id,'First look',true FROM org RETURNING id)
    SELECT actor.id AS actor,project.id AS project FROM actor,project`);
  const profile=Object.fromEntries(['A','B'].map((branch)=>[branch,{routeId:'first-'+branch,model:'fixture/'+branch,
    dataClass:'synthetic',maxTurns:8,maxTokens:256,maxKnownRejections:1}]));
  for(const branch of ['A','B']) {
    const route=profile[branch].routeId;
    await db.query(`INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
      VALUES($1,'r1','managed',true,65536,1,3000,0)`,[route]);
    await db.query(`INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
      VALUES($1,$2,'synthetic',$3,'r1',true)`,[owner.project,route,branch==='A'?'primary_a':'primary_b']);
  }
  const units=new Map();
  async function accept(order,file,numberOfPages) {
    const versionId=`00000000-0000-4000-8000-${String(order).padStart(12,'0')}`;
    await db.query(`WITH receipt AS (INSERT INTO intake_receipts(project_id,source,created_by,sealed_at)
        VALUES($1,'upload',$2,now()) RETURNING id),
      original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
        VALUES(gen_random_uuid(),$1,$3,1,$4) RETURNING id),
      document AS (INSERT INTO intake_documents(project_id) VALUES($1) RETURNING id),
      version AS (INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type)
        SELECT $5,$1,document.id,original.id,'application/pdf' FROM original,document RETURNING id,document_id,original_id),
      occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
        SELECT $1,receipt.id,$3,'application/pdf',version.id,'accepted' FROM receipt,version RETURNING id)
      INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      SELECT $1,receipt.id,version.document_id,version.id,version.original_id FROM receipt,version,occurrence`,
    [owner.project,owner.actor,file,hash(file),versionId]);
    units.set(versionId,Array.from({length:numberOfPages},(_,index)=>({id:String(index+1),width:400,height:400,locator:{page:index+1}})));
    return versionId;
  }
  const large=await accept(1,'large.pdf',5);
  const plain=await accept(2,'plain.pdf',1);
  const register=await accept(3,'register.pdf',1);
  const reader={formatFor:()=> 'pdf',readerVersion:()=> 'first-look-v1',async map(source) {
    return {source,format:'pdf',readerVersion:'first-look-v1',units:units.get(source.versionId)};
  }};
  while(await preparePackageMap(db,queue,reader,[])){}
  await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
    SELECT project_id,document_id,version_id,'first-look-v1',receipt_id,$3,'pdf',$4
    FROM intake_reader_jobs WHERE project_id=$1 AND version_id=$2`,[owner.project,register,hash('register.pdf'),JSON.stringify(units.get(register))]);
  const blockId=hash('registry block');
  await db.query(`INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal)
    VALUES($1,$2,1,'first-look-v1','pdf',1,1)`,[owner.project,register]);
  await db.query(`INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining)
    VALUES($1,$2,$3,1,0,'1','{"unitId":"1"}',$4,1,'{}','{}')`,[blockId,owner.project,register,hash('register bytes')]);
  await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
    VALUES($1,0,'shown-register','Facade register','facade register','{"unitId":"1","box":{"x":0,"y":0,"width":10,"height":10}}')`,[blockId]);
  const jobs=async()=>(await db.query(`SELECT subject_id AS version,state,payload FROM gateway_jobs
    WHERE project_id=$1 AND kind='harness_research' ORDER BY created_at,id`,[owner.project])).rows;
  while(!(await jobs()).length)assert.equal(await dispatchPackagePair(db,queue,profile),true);
  const first=await jobs();
  assert.deepEqual(first.map(({version})=>version),[register,register]);
  assert.deepEqual(first.map(({payload})=>payload.branch).sort(),['A','B']);
  assert.ok(first.every(({state,payload})=>state==='ready'&&payload.packageWindow.profileInspection.lineIds[0]==='shown-register'));
  assert.equal(await dispatchPackagePair(db,queue,profile),true);
  assert.equal(await dispatchPackagePair(db,queue,profile),true);
  const round=await jobs();
  assert.deepEqual(round.slice(2).map(({version})=>version),[large,large,plain,plain]);
  assert.ok(round.every(({state,payload})=>state==='ready'&&payload.place.unitId==='1'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM gateway_attempts')).rows[0].n,0);

  const root=await queue.claim({workerId:'first-reader',kinds:['harness_research'],leaseMs:30_000});
  assert.equal(root.subjectId,register);
  const {id:windowId}=root.payload.packageWindow;
  const lineIds=['shown-register',...Array.from({length:6},(_,i)=>`register-segment-${i}`)];
  for(const [i,line] of lineIds.slice(1).entries()) {
    await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
      VALUES($1,$2,$3,'Facade register','facade register','{"unitId":"1"}')`,[blockId,i+1,line]);
  }
  const blocks=lineIds.map((lineId,i)=>({id:`native:${i+1}`,kind:'native',lineIds:[lineId]}));
  await db.query('INSERT INTO harness_package_structures(window_id,blocks) VALUES($1,$2)',[windowId,JSON.stringify(blocks)]);
  const inspection=await packageStructure(db,{task:{projectId:owner.project,jobId:root.lease.jobId,job:root.payload}});
  assert.deepEqual(inspection.profileInspectionLines,['shown-register']);
  const rawEvidence=randomUUID();
  await db.query(`INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload)
    VALUES($1,$2,$3,'first-look-v1',$4,$5,'fixture-first-page',$6,'{}')`,
  [rawEvidence,owner.project,register,root.lease.jobId,root.payload.branch,hash('test reader receipt')]);
  const finish=(job)=>queue.finish(job.lease,{kind:'reviewed_no_match',evidenceIds:[rawEvidence]},
    {state:'completed',evidenceRef:rawEvidence});
  assert.equal(await finish(root),true);
  assert.equal(await dispatchPackageFollowup(db,queue,false),false,'passive scheduler does not create a profile scan');
  assert.equal(await dispatchPackageFollowup(db,queue),true);
  const child=await queue.claim({workerId:'first-reader',kinds:[packageFollowupKind],leaseMs:30_000});
  assert.deepEqual(child.payload.packageWindow.followup.blocks,['native:1','native:2','native:3']);
  assert.equal(child.payload.packageWindow.followup.discovery.candidateBlocks.length,7);
  await db.query(`INSERT INTO harness_package_block_checks(window_id,job_id,block_id,evidence_id,reviewed,reason)
    VALUES($1,$2,'native:1',$3,true,'Address checked')`,[windowId,child.lease.jobId,rawEvidence]);
  assert.equal(await finish(child),true);
  assert.equal(await dispatchPackageFollowup(db,queue),true);
  const continued=await queue.claim({workerId:'first-reader',kinds:[packageFollowupKind],leaseMs:30_000});
  assert.deepEqual(continued.payload.packageWindow.followup.blocks,['native:4','native:5','native:6']);
  assert.equal(await finish(continued),true);
  assert.equal(await dispatchPackageFollowup(db,queue),false);
  const assessment=await readPackageAnalysis(db,owner.project);
  assert.deepEqual(assessment.windows.find(({id})=>id===windowId).structure.branches[root.payload.branch].profileScan,
    {reviewed:['native:1'],remaining:['native:2','native:3','native:4','native:5','native:6','native:7']});
});
