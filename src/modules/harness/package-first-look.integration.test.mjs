import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    SELECT actor.id AS actor,project.id AS project,org.id AS org FROM actor,project,org`);
  const profile=Object.fromEntries(['A','B'].map((branch)=>[branch,{routeId:'first-'+branch,model:'fixture/'+branch,
    dataClass:'synthetic',maxTurns:8,maxTokens:256,maxKnownRejections:1}]));
  for(const branch of ['A','B']) {
    const route=profile[branch].routeId;
    await db.query(`INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
      VALUES($1,'r1','managed',true,65536,1,3000,0)`,[route]);
    await db.query(`INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
      VALUES($1,$2,'synthetic',$3,'r1',true)`,[owner.project,route,branch==='A'?'primary_a':'primary_b']);
  }
  const dataDir=await mkdtemp(join(tmpdir(),'facade-first-look-'));
  const previousDataDir=process.env.FACADE_DATA_DIR;
  process.env.FACADE_DATA_DIR=dataDir;
  t.after(async()=>{
    if (previousDataDir===undefined) delete process.env.FACADE_DATA_DIR;
    else process.env.FACADE_DATA_DIR=previousDataDir;
    await rm(dataDir,{recursive:true,force:true});
  });
  const { persistDwgFile }=await import(built('src/modules/formats/dwg-durable.js'));
  const documents=new Map();
  async function accept(order,file,numberOfPages) {
    const versionId=`00000000-0000-4000-8000-${String(order).padStart(12,'0')}`;
    const dwg=file.endsWith('.dwg');
    const media=dwg?'application/octet-stream':'application/pdf';
    await db.query(`WITH receipt AS (INSERT INTO intake_receipts(project_id,source,created_by,sealed_at)
        VALUES($1,'upload',$2,now()) RETURNING id),
      original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
        VALUES(gen_random_uuid(),$1,$3,1,$4) RETURNING id),
      document AS (INSERT INTO intake_documents(project_id) VALUES($1) RETURNING id),
      version AS (INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type)
        SELECT $5,$1,document.id,original.id,$6 FROM original,document RETURNING id,document_id,original_id),
      occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
        SELECT $1,receipt.id,$3,$6,version.id,'accepted' FROM receipt,version RETURNING id)
      INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      SELECT $1,receipt.id,version.document_id,version.id,version.original_id FROM receipt,version,occurrence`,
    [owner.project,owner.actor,file,hash(file),versionId,media]);
    documents.set(versionId,{format:dwg?'dwg':'pdf',
      units:Array.from({length:numberOfPages},(_,index)=>({id:String(index+1),width:400,height:400,locator:{page:index+1}}))});
    return versionId;
  }
  const large=await accept(1,'large.pdf',5);
  const plain=await accept(2,'plain.pdf',1);
  const register=await accept(3,'register.pdf',1);
  const readerVersion='first-look-v1';
  const reader={formatFor:(_media,path)=>/(?:^|\.)dwg$/u.test(path)?'dwg':'pdf',readerVersion:()=>readerVersion,async map(source) {
    const {format,units}=documents.get(source.versionId);
    let mapped=units;
    if (format==='dwg') {
      const derivative='0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';
      const path=join(dataDir,'fixture.dxf');
      await writeFile(path,derivative);
      const file=await open(path,'r');
      let durable;
      try { durable=await persistDwgFile(source,file,hash(derivative)); } finally { await file.close(); }
      await db.query(`INSERT INTO dwg_derivatives(project_id,document_id,version_id,original_sha256,reader_version,
        converter_identity,derivative_sha256,byte_size,format,storage_key)
        VALUES($1,$2,$3,$4,$5,'fixture',$6,$7,'dxf',$8) ON CONFLICT DO NOTHING`,
      [source.projectId,source.documentId,source.versionId,source.sha256,readerVersion,hash(derivative),durable.size,durable.storageKey]);
      mapped=units.map(unit=>({...unit,locator:{...unit.locator,derivativeSha256:hash(derivative)}}));
    }
    // The synthetic service persists the map it returns, like the runtime reader.
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      SELECT project_id,document_id,version_id,$3,receipt_id,$4,$5,$6
      FROM intake_reader_jobs WHERE project_id=$1 AND version_id=$2 ON CONFLICT DO NOTHING`,
    [source.projectId,source.versionId,readerVersion,source.sha256,format,JSON.stringify(mapped)]);
    return {source,format,readerVersion,units:mapped};
  }};
  while(await preparePackageMap(db,queue,reader,[])){}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM intake_package_preparation_current')).rows[0].n,3);
  const dispatch=()=>dispatchPackagePair(db,queue,profile,undefined,reader);
  async function indexHint(versionId,file,unit,ordinal,lineId) {
    const blockId=hash('fixture index '+versionId);
    await db.query(`INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal)
      VALUES($1,$2,1,'first-look-v1','pdf',$3,$4)`,[owner.project,versionId,documents.get(versionId).units.length,ordinal+1]);
    await db.query(`INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining)
      VALUES($1,$2,$3,1,$4,$5,jsonb_build_object('unitId',$5::text),$6,1,'{}','{}')`,
      [blockId,owner.project,versionId,ordinal,unit,hash(file+' index bytes')]);
    await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
      VALUES($1,0,$2,'Facade register','facade register',jsonb_build_object('unitId',$3::text,'box','{"x":0,"y":0,"width":10,"height":10}'::jsonb))`,
      [blockId,lineId,unit]);
    return blockId;
  }
  const blockId=await indexHint(register,'register.pdf','1',0,'shown-register');
  const jobs=async()=>(await db.query(`SELECT subject_id AS version,state,payload FROM gateway_jobs
    WHERE project_id=$1 AND kind='harness_research' ORDER BY created_at,id`,[owner.project])).rows;
  while(!(await jobs()).length)assert.equal(await dispatch(),true);
  const first=await jobs();
  assert.deepEqual(first.map(({version})=>version),[register,register]);
  assert.deepEqual(first.map(({payload})=>payload.branch).sort(),['A','B']);
  assert.ok(first.every(({state,payload})=>state==='ready'&&payload.packageWindow.profileInspection.lineIds[0]==='shown-register'));
  assert.equal(await dispatch(),true);
  assert.equal(await dispatch(),true);
  const round=await jobs();
  assert.deepEqual(round.slice(2).map(({version})=>version),[large,large,plain,plain]);
  assert.ok(round.every(({state,payload})=>state==='ready'&&payload.place.unitId==='1'));

  await t.test('a queued assignment does not count as a physical opening',async()=>{
    await indexHint(large,'large.pdf','3',2,'newly-indexed-register');
    assert.equal(await dispatch(),true);
    const next=(await jobs()).slice(6);
    assert.equal(next.length,2);
    assert.ok(next.every(({version,payload})=>version===large&&payload.place.unitId==='3'&&
      payload.packageWindow.profileInspection.lineIds.includes('newly-indexed-register')));
  });

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
  async function readerEvidence(job) {
    const evidenceId=randomUUID();
    await db.query(`INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload)
      VALUES($1,$2,$3,'first-look-v1',$4,$5,'fixture-first-page',$6,$7)`,
      [evidenceId,owner.project,job.subjectId,job.lease.jobId,job.payload.branch,hash('test reader receipt'),
        JSON.stringify({address:{unitId:job.payload.place.unitId},representation:'native'})]);
    return evidenceId;
  }
  const rawEvidence=await readerEvidence(root);
  const finish=(job,evidenceId=rawEvidence)=>queue.finish(job.lease,{kind:'reviewed_no_match',evidenceIds:[evidenceId]},
    {state:'completed',evidenceRef:evidenceId});
  assert.equal(await finish(root),true);
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
  const assessment=await readPackageAnalysis(db,owner.project);
  assert.deepEqual(assessment.windows.find(({id})=>id===windowId).structure.branches[root.payload.branch].profileScan,
    {reviewed:['native:1'],remaining:['native:2','native:3','native:4','native:5','native:6','native:7']});
  const refuse=(job)=>queue.finish(job.lease,{kind:'final_refusal',reason:'fixture_no_evidence',evidenceIds:[]},
    {state:'final_refusal',evidenceRef:'fixture:no-evidence'});
  const claimFollowup=()=>queue.claim({workerId:'first-reader',kinds:[packageFollowupKind],leaseMs:30_000});
  const claimPrimary=()=>queue.claim({workerId:'first-reader',kinds:['harness_research'],leaseMs:30_000});

  await t.test('structural continuation uses only unread blocks with the sibling still queued',async()=>{
    assert.equal(await dispatchPackageFollowup(db,queue,false),true);
    const structural=await claimFollowup();
    assert.equal(structural.payload.branch,root.payload.branch);
    assert.deepEqual(structural.payload.packageWindow.followup.blocks,blocks.slice(1).map(({id})=>id));
    assert.equal(await refuse(structural),true);
    assert.equal(await dispatchPackageFollowup(db,queue),false,'no automatic loop after a structural refusal without progress');
    const {windows}=await readPackageAnalysis(db,owner.project);
    assert.equal(windows.find(({id})=>id===windowId).structure.branches[root.payload.branch].followup.reason,'fixture_no_evidence');
  });

  await t.test('a terminal catalogue refusal without a check remains eligible for one retry',async()=>{
    const {rows:[{id:catalog}]}=await db.query(`INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,
      created_by,default_stage,default_facade_kinds,approval_reference)
      VALUES($1,'fixture',1,'Fixture','[{"key":"position-1","level":"common","applicability":"all"}]',$2,'RD','{universal}','fixture')
      RETURNING id`,[owner.org,owner.actor]);
    await db.query(`UPDATE projects SET catalog_version_id=$2,project_stage='RD',confirmed_facade_kinds='{universal}' WHERE id=$1`,
      [owner.project,catalog]);
    assert.equal(await dispatchPackageFollowup(db,queue),true);
    const firstCheck=await claimFollowup();
    assert.equal(firstCheck.payload.packageWindow.followup.semantic.catalogVersionId,catalog);
    assert.equal(await refuse(firstCheck),true);
    assert.equal(await dispatchPackageFollowup(db,queue),true);
    const retry=await claimFollowup();
    assert.notEqual(retry.lease.jobId,firstCheck.lease.jobId);
    assert.deepEqual(retry.payload.packageWindow.followup.semantic,firstCheck.payload.packageWindow.followup.semantic);
    assert.equal(await refuse(retry),true);
    assert.equal(await dispatchPackageFollowup(db,queue),false,'same root and catalogue position have a finite retry budget');
  });

  await t.test('a disabled earlier route cannot delay another root or repeat its checked blocks',async()=>{
    let plainStructure=false;
    const parked=[];
    for(let job; (job=await claimPrimary());) {
      if(![register,plain].includes(job.subjectId)) {
        parked.push(job.lease.jobId);
        assert.equal(await queue.suspend(job.lease,{reason:'fixture',nextAction:'fixture'}),true);
        continue;
      }
      const evidenceId=await readerEvidence(job);
      if(job.subjectId===plain) {
        const {id}=job.payload.packageWindow;
        if(!plainStructure) {
          await db.query('INSERT INTO harness_package_structures(window_id,blocks) VALUES($1,$2)',[id,JSON.stringify(blocks.slice(0,2))]);
          plainStructure=true;
        }
        await db.query(`INSERT INTO harness_package_block_checks(window_id,job_id,block_id,evidence_id,reviewed,reason)
          VALUES($1,$2,'native:1',$3,true,'Already read')`,[id,job.lease.jobId,evidenceId]);
      }
      assert.equal(await finish(job,evidenceId),true);
    }
    const denied=root.payload.branch==='A'?'B':'A';
    const grantAllowed=(allowed)=>db.query('UPDATE gateway_grants SET allowed=$3 WHERE project_id=$1 AND route_id=$2',
      [owner.project,profile[denied].routeId,allowed]);
    await grantAllowed(false);
    try {
      assert.equal(await dispatchPackageFollowup(db,queue,false),true);
      const next=await claimFollowup();
      assert.equal(next.subjectId,plain);
      assert.equal(next.payload.branch,root.payload.branch);
      assert.deepEqual(next.payload.packageWindow.followup.blocks,['native:2']);
      assert.equal(await refuse(next),true);
    } finally {
      await grantAllowed(true);
      for(const id of parked) assert.equal(await queue.resume(id),true);
    }
  });

  await t.test('a branch does not receive a facade discovery label from the other branch',async()=>{
    const {facadeDiscoveryVersion}=await import(built('src/modules/harness/facade-discovery.js'));
    await db.query('UPDATE projects SET catalog_version_id=NULL WHERE id=$1',[owner.project]);
    await db.query(`INSERT INTO harness_package_block_checks(window_id,job_id,block_id,evidence_id,reviewed,reason)
      SELECT s.window_id,b.job_id,item->>'id',e.id,true,'Already read'
      FROM harness_package_structures s JOIN harness_package_branches b ON b.window_id=s.window_id AND b.active
      JOIN reader_evidence e ON e.run_id=b.job_id AND e.branch=b.branch
      CROSS JOIN LATERAL jsonb_array_elements(s.blocks) item
      WHERE e.project_id=$1 ON CONFLICT DO NOTHING`,[owner.project]);
    await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
      VALUES($1,20,'registered-type','Project facade ID: OWN-17 | Facade type: ribbed panel',
        'project facade id: own-17 | facade type: ribbed panel','{"unitId":"1"}')`,[blockId]);
    const factId=randomUUID();
    const own=[factId,owner.project,register,root.lease.jobId,root.payload.branch,hash('fixture identified facade'),rawEvidence];
    await db.query(`INSERT INTO reader_observations(id,project_id,version_id,run_id,branch,operation_key,request_sha256,evidence_id,payload)
      VALUES($1,$2,$3,$4,$5,'fixture-designation',$6,$7,'{"quote":"Facade type: ribbed panel"}')`,own);
    await db.query(`INSERT INTO harness_package_facts(id,project_id,window_id,job_id,source_role,revision_status,basis,materials)
      VALUES($1,$2,$3,$4,'drawing','current','{}','[]')`,[factId,owner.project,windowId,root.lease.jobId]);
    await db.query(`INSERT INTO harness_package_bindings(fact_id,version,state,candidates,reason)
      VALUES($1,1,'identified',$2,'Branch recorded the printed designation')`,
      [factId,JSON.stringify([{id:randomUUID(),label:'OWN-17'}])]);
    await db.query(`INSERT INTO harness_facade_discovery(fact_id,discovery_version,resolved,mentions)
      VALUES($1,$2,true,$3)`,[factId,facadeDiscoveryVersion,JSON.stringify([{kind:'registry',label:'OWN-17',branch:root.payload.branch}])]);
    assert.equal(await dispatchPackageFollowup(db,queue,false),false);
    const {rows:[{count}]}=await db.query(`SELECT count(*)::int FROM harness_package_followups WHERE window_id=$1 AND plan_key LIKE 'facade:%'`,
      [windowId]);
    assert.equal(count,0);
  });

  await t.test('a newly mapped DWG gets one open slot before a deferred continuation with its sibling denied',async()=>{
    while(await dispatch()){}
    const waiting=await claimPrimary();
    assert.equal(await queue.suspend(waiting.lease,{reason:'repeated_rejected_action',nextAction:'fixture'}),true);
    assert.equal(await dispatch(),true,'existing work fills the just released slot');
    assert.equal(await queue.resume(waiting.lease.jobId),false);
    const deferred=async()=>(await db.query('SELECT state FROM gateway_jobs WHERE id=$1',[waiting.lease.jobId])).rows[0].state;
    assert.equal(await deferred(),'held');
    const sibling=waiting.payload.branch==='A'?'B':'A';
    await db.query('UPDATE gateway_grants SET allowed=false WHERE project_id=$1 AND route_id=$2',
      [owner.project,profile[sibling].routeId]);
    const dwg=await accept(4,'late.dwg',2);
    const nextOriginal=await accept(5,'behind-dwg.pdf',1);
    assert.equal(await preparePackageMap(db,queue,reader,[]),true);
    assert.equal(await preparePackageMap(db,queue,reader,[]),true);
    assert.equal(await refuse(await claimPrimary()),true);
    assert.equal(await dispatch(),true);
    assert.deepEqual((await jobs()).filter(({version})=>version===dwg).map(({payload})=>payload.branch),[waiting.payload.branch]);
    assert.equal(await deferred(),'held');
    assert.equal(await refuse(await claimPrimary()),true);
    assert.equal(await dispatch(),true);
    assert.equal(await deferred(),'ready','the deferred job gets the next free slot despite another untouched original');
    assert.equal((await jobs()).some(({version})=>version===nextOriginal),false);
    assert.equal(await refuse(await claimPrimary()),true);
    assert.equal(await dispatch(),true);
    assert.deepEqual((await jobs()).filter(({version})=>version===nextOriginal).map(({payload})=>payload.branch),[waiting.payload.branch]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gateway_attempts')).rows[0].n,0);
  });
});
