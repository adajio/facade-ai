import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const enabled=process.env.FACADE_DISCOVERY_INTEGRATION==='1';
const viewUpgrade=process.env.FACADE_VIEW_UPGRADE;
const built=(path)=>process.env.FACADE_HARNESS_TEST_DIST
  ?pathToFileURL(join(process.env.FACADE_HARNESS_TEST_DIST,path)).href:new URL(`../../../dist/${path}`,import.meta.url).href;
const sha=(text)=>createHash('sha256').update(text).digest('hex');

test('addressed PDF and XLSX facts share a stable facade; the branch worker consumes memory and preserves history', {
  skip:!enabled||viewUpgrade==='verify'||viewUpgrade==='verify-claim',
}, async(t)=>{
  const url=process.env.DATABASE_URL;
  const database=new URL(url).pathname.slice(1);
  assert.match(database,/^test_facade_identity_[a-z0-9_]+$/u);
  const db=new pg.Pool({connectionString:url});
  t.after(()=>db.end());
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,database);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n,0);
  const {WorkQueue}=await import(built('src/modules/gateway/queue.js'));
  const {dispatchPackagePair,preparePackageMap}=await import(built('src/modules/harness/package-dispatch.js'));
  const {publishPackageObservation}=await import(built('src/modules/harness/package-observation.js'));
  const {reconcileNextFacadeDiscovery}=await import(built('src/modules/harness/facade-discovery.js'));
  const {dispatchPackageFollowup,packageFollowupKind}=await import(built('src/modules/harness/package-walk.js'));
  const {readPackageAnalysis}=await import(built('src/modules/harness/package-analysis.js'));
  const {initialMessages}=await import(built('src/modules/harness/openrouter.js'));
  const {resumeInterruptedResearch}=await import(built('src/modules/harness/runner.js'));
  const {readFacadeSnapshot,synchronizeFacadeAssessment}=await import(built('src/modules/assessment/facade-store.js'));
  const queue=new WorkQueue(db);
  const {rows:[owner]}=await db.query(`WITH org AS (INSERT INTO organizations(name) VALUES('Fixture') RETURNING id),
    actor AS (INSERT INTO users(organization_id,login) SELECT id,'fixture-identity' FROM org RETURNING id),
    project AS (INSERT INTO projects(organization_id,name,intake_mode) SELECT id,'Addressed',true FROM org RETURNING id)
    SELECT actor.id AS actor,project.id AS project FROM actor,project`);
  const projectId=owner.project;
  const profile=Object.fromEntries(['A','B'].map((branch)=>[branch,{routeId:'test-'+branch,model:'fixture/'+branch,
    dataClass:'synthetic',maxTurns:8,maxTokens:256,maxKnownRejections:1}]));
  for(const branch of ['A','B']) {
    const route=profile[branch].routeId;
    await db.query(`INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
      VALUES($1,'r1','managed',true,65536,1,3000,0)`,[route]);
    await db.query(`INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
      VALUES($1,$2,'synthetic',$3,'r1',true)`,[projectId,route,branch==='A'?'primary_a':'primary_b']);
  }
  const formats=new Map();
  async function accept(filename,format,previous=null) {
    const hash=sha(filename);
    const media=format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const documentId=previous?.document_id??(await db.query(
      'INSERT INTO intake_documents(project_id) VALUES($1) RETURNING id',[projectId])).rows[0].id;
    const {rows:[row]}=await db.query(`WITH receipt AS (
        INSERT INTO intake_receipts(project_id,source,created_by,sealed_at) VALUES($1,'upload',$2,now()) RETURNING id),
      original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
        VALUES(gen_random_uuid(),$1,$3,1,$4) RETURNING id),
      ver AS (INSERT INTO intake_document_versions(project_id,document_id,original_id,media_type,replaces_version_id)
        SELECT $1,$5,original.id,$6,$7 FROM original RETURNING id,document_id,original_id),
      occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
        SELECT $1,receipt.id,$3,$6,ver.id,'accepted' FROM receipt,ver RETURNING id)
      INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      SELECT $1,receipt.id,ver.document_id,ver.id,ver.original_id FROM receipt,ver,occurrence
      RETURNING receipt_id,document_id,version_id`,[projectId,owner.actor,filename,hash,documentId,media,previous?.version_id??null]);
    const units=[{id:'1',width:640,height:260,locator:format==='pdf'?{page:1}:{sheet:'Fixture'}}];
    formats.set(row.version_id,{format,units});
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,'test',$4,$5,$6,$7)`,[projectId,row.document_id,row.version_id,row.receipt_id,hash,format,JSON.stringify(units)]);
    return row;
  }
  const reader={formatFor:(media)=>media==='application/pdf'?'pdf':'xlsx',readerVersion:()=> 'test',
    async map(source) {return {...formats.get(source.versionId),source,readerVersion:'test'};}};
  const mark='VB-27';
  const pdf=await accept('scope.pdf','pdf');
  const xlsx=await accept('matrix.xlsx','xlsx');
  const settle=async()=>{while(await reconcileNextFacadeDiscovery(db)){}};
  while(await preparePackageMap(db,queue,reader,[])){}
  while(await dispatchPackagePair(db,queue,profile)){}
  const leased=new Map();
  for(let step=0;step<4;step++) {
    const job=await queue.claim({workerId:'fixture',kinds:['harness_research'],leaseMs:30_000});
    assert.ok(job);
    leased.set(job.payload.place.source.versionId+job.payload.branch,job);
  }
  async function publish(job,row,quote,value,options={}) {
    const {branch,place,packageWindow}=job.payload;
    const evidenceId=randomUUID(),id=randomUUID(),lineId=randomUUID();
    const address={unitId:place.unitId,...(options.locator?{locator:options.locator}:{})};
    const observation={id,evidenceId,runId:job.lease.jobId,branch,scope:null,source:place.source,
      receiptId:row.receipt_id,address,lineId,readerVersion:'test',grounding:'text',quote,value,unit:'mm'};
    const componentLineId=options.bindingComponent?randomUUID():undefined;
    if(options.bindingComponent)observation.components=[{evidenceId,lineId:componentLineId,quote:options.bindingComponent.quote,
      source:place.source,address,readerVersion:'test',binding:{kind:'context',lineId:componentLineId,text:options.bindingComponent.quote}}];
    const evidence={evidenceId,place,readerVersion:'test',sha256:sha(quote)};
    const content=JSON.stringify([{id:lineId,text:options.openedLine??quote,locator:options.locator},
      ...(options.bindingComponent?[{id:componentLineId,text:options.bindingComponent.line}]:[]),...(options.headers??[])]);
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query(`INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload)
        VALUES($1,$2,$3,'test',$4,$5,$1::uuid::text,$6,'{}')`,[evidenceId,projectId,row.version_id,job.lease.jobId,branch,sha(quote)]);
      await client.query(`INSERT INTO reader_observations(id,project_id,version_id,run_id,branch,operation_key,request_sha256,evidence_id,scope_id,payload)
        VALUES($1,$2,$3,$4,$5,$1::uuid::text,$6,$7,NULL,$8)`,[id,projectId,row.version_id,job.lease.jobId,branch,sha(quote),evidenceId,observation]);
      await client.query(`INSERT INTO harness_research_events(job_id,sequence,event)
        SELECT $1,coalesce(max(sequence),0)+1,$2 FROM harness_research_events WHERE job_id=$1`,
      [job.lease.jobId,{kind:'tool',reply:{evidence,body:{content:JSON.stringify({lines:JSON.parse(content)})}}}]);
      await publishPackageObservation(client,{task:{job:job.payload,jobId:job.lease.jobId,generationId:job.generationId,projectId,scopeId:null},
        branch,effectKey:id},{evidence,quote,value,unit:'mm',package:options.package??{
          attribute:'Depth',role:{value:'specification',quote:'Specification'},
          stage:{value:'RD',quote:'Stage: RD'},revision:{value:'Q-9',quote:'Revision: Q-9 current',status:'current'},
          binding:{state:'identified',labels:[mark],quote,reason:'Synthetic mark'}}},observation);
      await client.query('INSERT INTO harness_package_structures(window_id,blocks) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [packageWindow.id,JSON.stringify([{kind:'native',id:'native:1',lineIds:[lineId]}])]);
      await client.query(`INSERT INTO harness_package_block_checks(window_id,job_id,block_id,evidence_id,reviewed,reason)
        VALUES($1,$2,'native:1',$3,true,'Fixture raw line') ON CONFLICT DO NOTHING`,[packageWindow.id,job.lease.jobId,evidenceId]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return {id,evidenceId,lineId};
  }
  const text=(value,identity='Facade',context='Building: Forge | Axes: 6-8',kind='')=>
    `Specification | Depth ${value} mm | ${identity}: ${mark} | ${context} | Stage: RD | Revision: Q-9 current | Variant: V2${kind}`;
  const pdfFact=await publish(leased.get(pdf.version_id+'A'),pdf,text('11','Project facade ID'),'11');
  await publish(leased.get(pdf.version_id+'B'),pdf,text('11','Project facade ID'),'11');
  await publish(leased.get(xlsx.version_id+'A'),xlsx,text('19'),'19');
  const tableFact=await publish(leased.get(xlsx.version_id+'B'),xlsx,text('19'),'19');
  const representative=`Specification | Facade: Detail-73 | Refers to ${mark} | Building: Forge | Axes: 6-8 | Stage: RD | Revision: Q-9 current`;
  const viewFact=await publish(leased.get(pdf.version_id+'A'),pdf,representative,'11',{
    package:{binding:{state:'identified',labels:['Detail-73'],quote:representative,reason:'Candidate from the view name.'}},
  });
  const cropped='Facade: AA-77';
  const ownView='View: Sequence-39';
  const openedLine=`${cropped} | ${ownView} | Refers to ${mark} | Building: Forge | Axes: 6-8`;
  const croppedFact=viewUpgrade==='seed'?undefined:await publish(leased.get(pdf.version_id+'A'),pdf,cropped,'11',{
    openedLine,package:{binding:{state:'identified',labels:['AA-77'],quote:cropped,reason:'Candidate from a narrow quote.'}},
  });
  const ownFact=viewUpgrade==='seed'?undefined:await publish(leased.get(pdf.version_id+'A'),pdf,ownView,'11',{
    openedLine,package:{binding:{state:'identified',labels:['Sequence-39'],quote:ownView,reason:'Candidate from the addressed view.'}},
  });
  const composedFact=viewUpgrade?.startsWith('seed')?undefined:await publish(leased.get(pdf.version_id+'A'),pdf,'Render sequence 39','11',{
    bindingComponent:{quote:ownView,line:openedLine},package:{references:{binding:0},
      binding:{state:'identified',labels:['Sequence-39'],quote:ownView,reason:'The addressed binding component.'}},
  });
  await publish(leased.get(pdf.version_id+'A'),pdf,'Схема восточного фасада','11');
  await publish(leased.get(pdf.version_id+'B'),pdf,'Схема восточного фасада','11');
  const referenceText=text('19','Project facade ref','Physical schedule');
  const references=[await publish(leased.get(xlsx.version_id+'A'),xlsx,referenceText,'19'),
    await publish(leased.get(xlsx.version_id+'B'),xlsx,referenceText,'19')];
  const alias=await publish(leased.get(xlsx.version_id+'B'),xlsx,'Access-17','Access-17',{
    locator:{sheet:'Fixture',section:'suffix',row:9,column:2},
    headers:[{id:'head',text:'Access label',locator:{sheet:'Fixture',section:'suffix',row:8,column:2}}],
    package:{binding:{state:'identified',labels:['Access-17'],quote:'Access-17',reason:'Fixture false candidate'}}});
  for(const job of leased.values()) assert.equal(await queue.finish(job.lease,{kind:'covered'},{state:'completed',evidenceRef:'fixture'}),true);
  await settle();
  const state=()=>readPackageAnalysis(db,projectId);
  const first=await state();
  if(viewUpgrade==='seed'||viewUpgrade==='seed-claim') {
    assert.deepEqual(first.candidates.map(({label})=>label).sort(),viewUpgrade==='seed'?['Detail-73',mark]:[mark]);
    if(croppedFact)assert.equal(first.facts.find(({id})=>id===croppedFact.id).binding.candidates[0]?.label,mark);
    const {binding}=first.facts.find(({id})=>id===tableFact.id);
    await db.query(`INSERT INTO harness_package_bindings(fact_id,version,state,candidates,reason,actor_id)
      VALUES($1,$2,'identified',$3,'Manual decision on a different original',$4)`,
    [tableFact.id,binding.version+1,JSON.stringify(binding.candidates),owner.actor]);
    return;
  }
  assert.deepEqual(first.candidates.map(({label})=>label),[mark]);
  const facadeId=first.candidates[0].id;
  assert.equal(first.facadeProfiles[0].identity,'independent');
  assert.equal(first.facts.find(({id})=>id===viewFact.id).binding.candidates[0]?.id,facadeId);
  assert.deepEqual(first.facadeMentions.find(({factId})=>factId===viewFact.id).relation,{sourceLabel:'Detail-73',targetLabels:[mark]});
  assert.equal(first.facts.find(({id})=>id===croppedFact.id).binding.state,'unclear');
  assert.equal(first.facadeMentions.find(({factId})=>factId===croppedFact.id).relation,undefined);
  assert.equal(first.facts.find(({id})=>id===ownFact.id).binding.candidates[0]?.id,facadeId);
  assert.equal(first.facts.find(({id})=>id===composedFact.id).binding.candidates[0]?.id,facadeId);
  assert.ok(first.reviewCandidates.some(({a,b,scope})=>a===pdfFact.id&&b===tableFact.id&&scope.id===facadeId));
  assert.ok(references.every(({id})=>first.facts.find((f)=>f.id===id).binding.candidates[0]?.id===facadeId));
  assert.equal(first.facts.find(({id})=>id===alias.id).binding.state,'unclear');
  const rawTitle=text('11','Project facade ID',undefined,' | Facade type: cassette')
    .replace(`Project facade ID: ${mark} | Building: Forge | Axes: 6-8`,`Фасад ${mark} в осях 6-8 корпуса Forge`);
  await db.query(`INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal)
    VALUES($1,$2,1,'test','pdf',1,1)`,[projectId,pdf.version_id]);
  const blockId=sha('canonical PDF block');
  await db.query(`INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining)
    VALUES($1,$2,$3,1,0,'1','{"unitId":"1"}',$4,1,'{}','{}')`,[blockId,projectId,pdf.version_id,sha(rawTitle)]);
  await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
    VALUES($1,0,'title',$2,lower($2),'{"unitId":"1"}')`,[blockId,rawTitle]);
  assert.equal(await dispatchPackageFollowup(db,queue),true,'canonical memory plans a bounded profile revisit');
  assert.equal(await dispatchPackageFollowup(db,queue),false,'one active followup per project');
  const epoch=async()=>(await db.query('SELECT epoch::int FROM harness_semantic_scope_epochs WHERE project_id=$1 AND scope_key=$2',
    [projectId,facadeId])).rows[0].epoch;
  const initialEpoch=await epoch();
  const branches=[];
  for(let i=0;i<2;i++) {
    const child=await queue.claim({workerId:'fixture',kinds:[packageFollowupKind],leaseMs:30_000});
    assert.equal(child.subjectId,pdf.version_id);
    assert.equal(child.payload.packageWindow.followup.discovery.label,mark);
    branches.push(child.payload.branch);
    await publish(child,pdf,rawTitle,'11');
    await settle();
    const progressed=await epoch();
    await publish(child,pdf,rawTitle,'11');
    await settle();
    assert.equal(await epoch(),progressed,'duplicated address proof does not reopen checked positions');
    assert.equal(await queue.finish(child.lease,{kind:'covered'},{state:'completed',evidenceRef:'fixture'}),true);
    await settle();
    if(i===0)assert.equal(await dispatchPackageFollowup(db,queue),true);
  }
  assert.deepEqual(branches.sort(),['A','B']);
  assert.equal(await dispatchPackageFollowup(db,queue),false);
  const checked=await state();
  assert.equal(checked.candidates[0].id,facadeId);
  assert.deepEqual(checked.facadeProfiles[0].attributes.facadeKind.map(({value})=>value),['cassette']);
  assert.equal(new Set(checked.facadeProfiles[0].attributes.facadeKind[0].evidence.map(({branch})=>branch)).size,2);
  assert.ok(await epoch()>initialEpoch);
  const oriented='Фасад восточный | Корпус: Forge | Оси: А–Б';
  await db.query(`INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address)
    VALUES($1,1,'orient',$2,lower($2),'{"unitId":"1"}')`,[blockId,oriented]);
  for(let i=0;i<2;i++) {
    assert.equal(await dispatchPackageFollowup(db,queue),true,'memory locates the same direction with changed word order and case');
    const child=await queue.claim({workerId:'fixture',kinds:[packageFollowupKind],leaseMs:30_000});
    assert.match(child.payload.packageWindow.followup.discovery.label,/^Восточного фасада$/iu);
    await publish(child,pdf,oriented,'11');
    assert.equal(await queue.finish(child.lease,{kind:'covered'},{state:'completed',evidenceRef:'fixture'}),true);
    await settle();
  }
  assert.equal(await dispatchPackageFollowup(db,queue),false,'a revisit is never repeated with the same root and subject');
  const pdfRoot=leased.get(pdf.version_id+'A');
  const open=await publish(pdfRoot,pdf,'Depth 12 mm','12',{package:{attribute:'Depth'}});
  await settle();
  const unqualified=await state();
  assert.ok(unqualified.comparisonFollowups.includes(open.id));
  assert.ok(!unqualified.reviewCandidates.some(({a,b})=>a===open.id||b===open.id));
  const snapshot=async(version)=>{
    const tx=await db.connect();
    try{
      await tx.query('BEGIN');
      const result=version===undefined?await synchronizeFacadeAssessment(tx,projectId):await readFacadeSnapshot(tx,projectId,version);
      await tx.query('COMMIT');
      return result;
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  };
  const openSource=(summary)=>{
    const item=summary.payload.comparisonReview.items.find(({sources})=>sources.some(({citation})=>citation.observationId===open.id));
    assert.ok(item?.reasons.includes('facade_link_unproven'));
    return item.sources.find(({citation})=>citation.observationId===open.id);
  };
  const historical=await snapshot();
  assert.equal(openSource(historical).clarification,undefined);
  await db.query(`UPDATE gateway_grants SET allowed=false
    WHERE project_id=$1 AND route_id=$2 AND purpose='primary_a'`,[projectId,profile.A.routeId]);
  assert.equal(openSource(await snapshot()).clarification,undefined,'the route is irrelevant until there is an addressable plan');
  await db.query(`UPDATE harness_package_structures SET blocks=jsonb_set(blocks,'{0,lineIds}',blocks#>'{0,lineIds}'||to_jsonb($2::text))
    WHERE window_id=$1`,[pdfRoot.payload.packageWindow.id,open.lineId]);
  assert.equal(await dispatchPackageFollowup(db,queue,false),false);
  const blocked=await snapshot();
  assert.deepEqual(openSource(blocked).clarification,[{branch:'A',state:'route_required'}]);
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM harness_package_followups WHERE plan_key LIKE 'comparison:%') AS jobs,
    (SELECT count(*)::int FROM gateway_attempts) AS attempts`)).rows[0],{jobs:0,attempts:0});

  await db.query('UPDATE gateway_routes SET enabled=false WHERE id=$1',[profile.A.routeId]);
  await db.query(`UPDATE gateway_grants SET allowed=true
    WHERE project_id=$1 AND route_id=$2 AND purpose='primary_a'`,[projectId,profile.A.routeId]);
  assert.equal(await dispatchPackageFollowup(db,queue,false),false);
  assert.deepEqual(openSource(await snapshot()).clarification,[{branch:'A',state:'route_required'}]);
  await db.query('UPDATE gateway_routes SET enabled=true WHERE id=$1',[profile.A.routeId]);
  assert.equal(openSource(await snapshot()).clarification,undefined);
  assert.deepEqual((await Promise.all([dispatchPackageFollowup(db,queue,false),dispatchPackageFollowup(db,queue,false)])).sort(),[false,true]);
  assert.deepEqual(openSource(await snapshot()).clarification,[{branch:'A',state:'ready'}]);
  const claim=()=>queue.claim({workerId:'fixture',kinds:[packageFollowupKind],leaseMs:30_000});
  const clarification=await claim();
  assert.deepEqual(openSource(await snapshot()).clarification,[{branch:'A',state:'leased'}]);
  assert.equal(clarification.payload.branch,'A');
  assert.deepEqual(clarification.payload.place,pdfRoot.payload.place);
  const wire=JSON.parse(initialMessages(clarification.payload)[1].content);
  assert.deepEqual(wire.comparison,{lineId:open.lineId,property:'Depth'});
  assert.deepEqual(wire.blocks,['native:1']);
  assert.ok(!JSON.stringify(wire).includes(xlsx.version_id));
  assert.ok(!JSON.stringify(wire).includes(tableFact.id));
  assert.equal(await queue.suspend(clarification.lease,{reason:'analysis_replay_only',nextAction:'fixture'}),true);
  assert.deepEqual(openSource(await snapshot()).clarification,[{branch:'A',state:'held'}]);
  assert.equal(await dispatchPackageFollowup(db,queue,false),false,'held clarification retains the same identity');
  await resumeInterruptedResearch(db,queue,AbortSignal.timeout(10_000),true);
  const resumed=await claim();
  assert.equal(resumed.lease.jobId,clarification.lease.jobId);
  assert.equal(await queue.finish(resumed.lease,{kind:'reviewed_no_match'},{state:'completed',evidenceRef:open.evidenceId}),true);
  assert.deepEqual(openSource(await snapshot()).clarification,[{branch:'A',state:'done'}]);
  assert.equal(openSource(await snapshot(historical.version)).clarification,undefined);
  assert.deepEqual(openSource(await snapshot(blocked.version)).clarification,[{branch:'A',state:'route_required'}]);
  assert.equal(await dispatchPackageFollowup(db,queue,false),false,'unchanged anchor never enqueues twice');
  const {rows:[effects]}=await db.query(`SELECT (SELECT count(*)::int FROM gateway_attempts) AS attempts,
    (SELECT count(*)::int FROM harness_package_review_pairs) AS pairs,(SELECT count(*)::int FROM letters) AS letters`);
  assert.deepEqual(effects,{attempts:0,pairs:0,letters:0});
  const priorEpoch=await epoch();
  const last=checked.facts.find(({id})=>id===tableFact.id).binding.version;
  const lastReplaced=checked.facts.find(({id})=>id===pdfFact.id).binding.version;
  await db.query(`INSERT INTO harness_package_bindings(fact_id,version,state,candidates,reason,actor_id)
    VALUES($1,$2,'identified',$3,'Engineer fixture',$4),($5,$6,'identified',$3,'Replaced engineer fixture',$4)`,
    [tableFact.id,last+1,JSON.stringify([{id:facadeId,label:mark}]),owner.actor,pdfFact.id,lastReplaced+1]);
  const replacement=await accept('scope-v2.pdf','pdf',pdf);
  assert.notEqual(pdf.version_id,replacement.version_id);
  const immediately=await state();
  assert.deepEqual(immediately.candidates.map(({id})=>id),[facadeId]);
  assert.equal(immediately.facadeProfiles[0].identity,'engineer');
  assert.equal(immediately.facts.find(({id})=>id===pdfFact.id),undefined);
  assert.ok(!immediately.comparisonFollowups.includes(open.id));
  assert.equal(immediately.facts.find(({id})=>id===tableFact.id).binding.state,'identified');
  assert.ok(references.every(({id})=>immediately.facts.find((f)=>f.id===id).binding.state==='unclear'));
  assert.equal(immediately.facts.find(({id})=>id===tableFact.id).binding.actorId,owner.actor);
  await settle();
  const current=await state();
  assert.equal(current.candidates[0].id,facadeId);
  assert.ok(references.every(({id})=>current.facts.find((f)=>f.id===id).binding.state==='unclear'));
  assert.equal(current.facts.find(({id})=>id===tableFact.id).binding.actorId,owner.actor);
  assert.equal(current.facadeProfiles[0].attributes.facadeKind,undefined);
  assert.ok(await epoch()>priorEpoch);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reader_evidence WHERE id=$1',[pdfFact.evidenceId])).rows[0].n,1);
  assert.equal((await db.query('SELECT actor_id FROM harness_package_bindings WHERE fact_id=$1 AND version=$2',
    [pdfFact.id,lastReplaced+1])).rows[0].actor_id,owner.actor);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM harness_package_bindings WHERE fact_id=$1',[tableFact.id])).rows[0].n,last+1);
});

test('migration reinterprets a stored view reference while preserving prior and manual bindings', {
  skip:!enabled||!['verify','verify-claim'].includes(viewUpgrade),
}, async(t)=>{
  const connectionString=process.env.DATABASE_URL;
  assert.match(new URL(connectionString).pathname,/^\/test_facade_identity_view_(?:upgrade|claim)$/u);
  const db=new pg.Pool({connectionString});
  t.after(()=>db.end());
  const {readPackageAnalysis}=await import(built('src/modules/harness/package-analysis.js'));
  const {facadeDiscoveryVersion,reconcileNextFacadeDiscovery}=await import(built('src/modules/harness/facade-discovery.js'));
  const {rows:[{id:projectId}]}=await db.query("SELECT id FROM projects WHERE name='Addressed'");
  const before=await readPackageAnalysis(db,projectId);
  const manual=before.facts.find(({binding})=>binding.actorId);
  assert.ok(manual);
  assert.deepEqual(before.candidates.map(({label})=>label),['VB-27']);
  while(await reconcileNextFacadeDiscovery(db)){}
  const after=await readPackageAnalysis(db,projectId);
  assert.deepEqual(after.candidates,before.candidates);
  assert.deepEqual(after.facts.find(({id})=>id===manual.id).binding,manual.binding);
  const addressed=after.facadeMentions.find(({relation})=>relation?.sourceLabel==='Detail-73');
  assert.ok(addressed);
  assert.equal(after.facts.find(({id})=>id===addressed.factId).binding.candidates[0].id,before.candidates[0].id);
  const {rows:[history]}=await db.query(`SELECT d.prior_mentions AS mentions,
    EXISTS(SELECT 1 FROM harness_package_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.candidates) c
      WHERE b.fact_id=d.fact_id AND c->>'label'='Detail-73') AS retained
    FROM harness_facade_discovery d WHERE d.fact_id=$1 AND d.resolved AND d.discovery_version=$2`,[addressed.factId,facadeDiscoveryVersion]);
  if(viewUpgrade==='verify') {
    assert.ok(history.retained);
    assert.equal(history.mentions[0].version,1);
    assert.deepEqual(history.mentions[0].mentions.map(({label})=>label),['Detail-73']);
  }else{
    const cropped=after.facts.find(({observation})=>observation.quote==='Facade: AA-77');
    const own=after.facts.find(({observation})=>observation.quote==='View: Sequence-39');
    assert.equal(cropped.binding.state,'unclear');
    assert.equal(own.binding.candidates[0].id,before.candidates[0].id);
    const {rows:[prior]}=await db.query(`SELECT d.prior_mentions AS mentions,
      EXISTS(SELECT 1 FROM harness_package_bindings b WHERE b.fact_id=d.fact_id AND b.version<$2 AND b.state='identified'
        AND b.candidates->0->>'id'=$3) AS retained
      FROM harness_facade_discovery d WHERE d.fact_id=$1 AND d.discovery_version=$4`,
    [cropped.id,cropped.binding.version,before.candidates[0].id,facadeDiscoveryVersion]);
    assert.ok(prior.retained);
    assert.equal(prior.mentions[0].version,2);
    assert.equal(prior.mentions[0].mentions[0].relation.targetLabels[0],'VB-27');
    await db.query('INSERT INTO harness_facade_discovery_dirty(project_id) VALUES($1)',[projectId]);
    while(await reconcileNextFacadeDiscovery(db)){}
    const repeated=await readPackageAnalysis(db,projectId);
    assert.deepEqual(repeated.facts.map(({binding})=>binding),after.facts.map(({binding})=>binding));
    assert.deepEqual(repeated.facadeMentions,after.facadeMentions);
  }
});
