import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { readSnapshot } from '../../../infra/local-terra/producer.mjs';
import { directedReadingPlanSql, directedWindowAllowed, readProductionDirectedReadingPlan } from '../../../dist/src/modules/harness/directed-reading.js';
import { jobSchema } from '../../../dist/src/modules/harness/contracts.js';
import { initialMessages } from '../../../dist/src/modules/harness/openrouter.js';
import { packageStructure } from '../../../dist/src/modules/harness/package-walk.js';
import { dispatchPackagePair } from '../../../dist/src/modules/harness/package-dispatch.js';
import { readTerraReading } from '../../../dist/src/modules/assessment/terra-reading.js';
import { WorkQueue } from '../../../dist/src/modules/gateway/queue.js';
import { admittedDeepReceipts, chooseDeepWindow, currentDeepReceipt, deepReadingActivity, deepReadingWork, installDeepLedger } from '../../../infra/local-terra/transport/deep-reading.mjs';

const url = process.env.DIRECTED_READING_TEST_DATABASE_URL;
const hash = text => createHash('sha256').update(text).digest('hex');

test('held-out directed reading preserves an open gap and stops after the selected addresses', {skip:!url}, async t => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname,'127.0.0.1');
  assert.equal(parsed.pathname,'/test_facade_directed_reading');
  const db = new pg.Pool({connectionString:url,options:'-c jit=off'});
  t.after(()=>db.end());
  assert.equal((await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count,0);
  const [org,user,catalog,project,receipt,manifest,version,document,original] = Array.from({length:9},randomUUID);
  const stage = 'Стадия 1', reader = 'fixture-v1', filename = 'Листы парапета.pdf', originalHash = hash(original);
  const requirements = [
    {key:'R1',part:'Огнезащитная обработка'},
    {key:'R2',part:'Кронштейн',completenessCriterion:'Вылет кронштейна'},
    {key:'R3',part:'Герметизация стыка',completenessCriterion:'Марка герметика'},
  ];
  const ordinary = 'Карниз на кровле. Ориентир проекта.';
  const book = Array.from({length:32},()=>ordinary);
  book[0]='Пропитка антипиреном ИП-56.';
  book[14]='Кронштейн — общие указания.';
  book[25]='Кронштейн, вылет 172 мм.';
  // This useful but differently worded item is intentionally outside the router's vocabulary.
  book[30]='Бутилкаучуковая мастика МБ-02 между плитами.';
  const units = book.map((_,i)=>({id:String(i+1),width:400,height:500,locator:{page:i+1}}));
  const windowIds = book.map(()=>randomUUID());
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)",[user,org,user]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)",[catalog,org,JSON.stringify(requirements),user]);
  await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage,intake_mode) VALUES($1,$2,'Fixture',$3,$4,true)",[project,org,catalog,stage]);
  const queue = new WorkQueue(db);
  const generation = randomUUID();
  await queue.openGeneration({projectId:project,scopeId:null,generationId:generation});
  await db.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)',[project,generation]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receipt,project,user]);
  await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)",[original,project,original,originalHash]);
  await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[document,project]);
  await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",[version,project,document,original]);
  await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'application/pdf',$4,'accepted')",[project,receipt,filename,version]);
  await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)",[project,receipt,document,version,original]);
  await db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,$4,$5,$6,'pdf',$7)",[project,document,version,reader,receipt,originalHash,JSON.stringify(units)]);
  await db.query("INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format) VALUES($1,$2,'fixture',$3,$3,'pdf')",[project,version,reader]);
  const source={projectId:project,documentId:document,versionId:version,sha256:originalHash};
  const places=units.map(({id,locator})=>({source,unitId:id,page:locator.page}));
  await db.query(`INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place)
    SELECT ($3::uuid[])[ordinal],$1,$2,'fixture',ordinal,place FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY w(place,ordinal)`,
  [project,version,windowIds,JSON.stringify(places)]);
  const item={kind:'document',state:'available',versionId:version,readerVersion:reader,originalSha256:originalHash,label:filename};
  await db.query(`INSERT INTO intake_package_preparations(id,project_id,receipt_id,revision,snapshot_hash,manifest)
    VALUES($1,$2,$3,1,$4,$5)`,[manifest,project,receipt,hash(manifest),JSON.stringify({counts:{available:1},items:[item],restrictions:[]})]);
  await db.query('INSERT INTO intake_package_preparation_current VALUES($1,$2,$3)',[project,receipt,manifest]);
  await db.query("INSERT INTO intake_package_preparation_items VALUES($1,$2,$3,'fixture')",[manifest,project,version]);
  await db.query('INSERT INTO intake_package_preparation_windows SELECT $1,$2,id FROM unnest($3::uuid[]) w(id)',[manifest,project,windowIds]);
  await db.query(`INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal)
    VALUES($1,$2,1,$3,'pdf',$4,0)`,[project,version,reader,book.length]);
  assert.equal(await readSnapshot(db,receipt),null);
  async function indexPage(i) {
    const unitId = String(i+1), block = hash(version+' '+i), line=book[i];
    await db.query(`INSERT INTO project_memory_blocks(id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining)
      VALUES($1,$2,$3,1,$4,$5,jsonb_build_object('unitId',$5::text),$1,1,'{}','{graphics}')`,[block,project,version,i,unitId]);
    await db.query(`INSERT INTO project_memory_lines VALUES($1,0,$2,$3,lower($3),jsonb_build_object('unitId',$4::text))`,[block,'line-'+unitId,line,unitId]);
    await db.query('UPDATE project_memory_versions SET next_ordinal=$2 WHERE version_id=$1',[version,i+1]);
  }
  await indexPage(0);
  const early = await readSnapshot(db,receipt);
  assert.deepEqual(early.lines.map(line=>line.text),[book[0]]);
  assert.deepEqual(early.indexCoverage,{availableVersions:1,completeVersions:0,pendingVersions:1,totalUnits:32,processedUnits:1,unknownTotalVersions:0});
  assert.match(early.scopeNote,/Осталось проиндексировать 31 участков/u);
  assert.ok(early.unread.some(item=>item.reasons?.includes('memory_index_pending')));

  const ref=(i)=>({versionId:version,originalSha256:originalHash,anchor:JSON.stringify({unitId:String(i+1)}),quote:book[i]});
  const rows=[
    {key:'R1',status:'present',sources:[ref(0)]},
    {key:'R2',status:'present',sources:[ref(14)],analysis:{properties:[{key:'extension',label:'Вылет кронштейна',status:'insufficient',sources:[ref(14)]}]}},
    {key:'R3',status:'unassessed',sources:[]},
  ];
  async function report(number,rows) {
    await db.query(`INSERT INTO preliminary_package_reviews(project_id,receipt_id,catalog_version_id,model,stage,input_generation,inventory,scope_note,rows,draft_text,content_hash,preparation_id,created_at)
      VALUES($1,$2,$3,'gpt-6.1-terra',$4,coalesce((SELECT generation FROM intake_project_generations WHERE project_id=$1),0),$5,'Охват зафиксирован',$6,'Черновик',$7,$8,now()+make_interval(secs=>$9))`,
    [project,receipt,catalog,stage,JSON.stringify(early.inventory),JSON.stringify(rows),hash(manifest+' '+number),manifest,number]);
  }
  await report(0,[rows[0],{key:'R2',status:'unassessed',sources:[]},rows[2]]);
  const plan = async()=> (await db.query(directedReadingPlanSql('$1::uuid'),[project])).rows[0];
  assert.equal((await plan()).mode,'waiting_index');
  const target = {projectId:project,receiptId:receipt,preparationId:manifest,catalogVersionId:catalog,stage};
  const future = {activatedAt:'2999-01-01T00:00:00.000000Z',grants:[]};
  const past = {activatedAt:'2000-01-01T00:00:00.000000Z',grants:[]};
  assert.deepEqual(await admittedDeepReceipts(db,null),[]);
  assert.deepEqual(await admittedDeepReceipts(db,future),[]);
  assert.deepEqual(await admittedDeepReceipts(db,{...future,grants:[{...target,preparationId:randomUUID()}]}),[]);
  assert.deepEqual(await admittedDeepReceipts(db,{...future,grants:[target]}),[target]);
  assert.deepEqual(await admittedDeepReceipts(db,past),[target]);
  assert.equal(await currentDeepReceipt(db,{...target,receiptId:randomUUID()}),false);
  const production = await readProductionDirectedReadingPlan(db,project);
  assert.equal(production.mode,'directed');
  assert.deepEqual(production.windowIds,[windowIds[0]]);
  const candidate = await chooseDeepWindow(db,target,production);
  assert.equal(candidate.requiresVisual,true);
  await db.query(`CREATE TABLE local_terra_calls (id uuid PRIMARY KEY,job_id uuid,project_id uuid,state text,
    created_at timestamptz DEFAULT clock_timestamp(),finished_at timestamptz)`);
  await installDeepLedger(db,'local_terra_production_research');
  await installDeepLedger(db,'local_terra_production_research');
  const summary = await deepReadingWork(db,target,'local_terra_production_research');
  assert.deepEqual(summary,{started:0,active:0,completed:0,lastFinishedAt:null,unknown:null});
  assert.equal(await deepReadingActivity(db,target,'running',null,{started:1}),true);
  assert.equal(await deepReadingActivity(db,target,'running',null,{started:1}),false);
  assert.deepEqual(await admittedDeepReceipts(db,past),[target]);
  assert.equal((await readTerraReading(db,project)).progress.directed.indexPendingUnits,31);
  for (let i=1;i<book.length;i++) await indexPage(i);
  assert.equal((await readSnapshot(db,receipt)).indexCoverage.pendingVersions,0);
  await report(1,rows);
  const selected=await plan();
  assert.equal(selected.openRequirements,2);
  assert.equal(selected.mode,'directed');
  assert.deepEqual(new Set(selected.windowIds),new Set([windowIds[14],windowIds[25]]));
  const heldOutEvidence=[windowIds[25],windowIds[30]];
  const recall=heldOutEvidence.filter(id=>selected.windowIds.includes(id)).length;
  t.diagnostic(`Selected ${selected.windowIds.length}/${book.length} pages. Held-out relevant addresses ${recall}/${heldOutEvidence.length}; missed alternative terminology on page 31.`);
  assert.equal(recall,1);
  assert.equal(await directedWindowAllowed(db,project,windowIds[25],true,receipt),true);
  assert.equal(await directedWindowAllowed(db,project,windowIds[30],true,receipt),false);

  const profile=Object.fromEntries(['A','B'].map(branch=>[branch,{routeId:project+branch,model:'fixture/'+branch,
    dataClass:'synthetic',maxTurns:8,maxTokens:256,maxKnownRejections:1}]));
  for (const branch of ['A','B']) {
    const route=profile[branch].routeId;
    await db.query(`INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
      VALUES($1,'r1','managed',true,65536,1,3000,0)`,[route]);
    await db.query(`INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
      VALUES($1,$2,'synthetic',$3,'r1',true)`,[project,route,branch==='A'?'primary_a':'primary_b']);
  }
  for (let i=0;i<4 && await dispatchPackagePair(db,queue,profile,true);i++) { /* no transport is invoked */ }
  const scheduled=(await db.query(`SELECT id,payload FROM gateway_jobs
    WHERE project_id=$1 AND purpose='primary_a' ORDER BY created_at,id`,[project])).rows;
  const jobs=scheduled.map(({payload})=>jobSchema.parse(payload));
  assert.deepEqual(jobs.map(job=>job.packageWindow.id),[windowIds[14],windowIds[25]]);
  for (const [index,job] of jobs.entries()) {
    assert.deepEqual(job.packageWindow.directedRequirements,['R2']);
    assert.match(initialMessages(job)[0].content,/назначенных требований/u);
    await db.query("INSERT INTO harness_package_structures(window_id,blocks) VALUES($1,'[]')",[job.packageWindow.id]);
    const structure=await packageStructure(db,{task:{projectId:project,jobId:scheduled[index].id,job}});
    assert.deepEqual(structure.directedFocus,[{key:'R2',part:'Кронштейн',criterion:'Вылет кронштейна'}]);
  }
  await db.query(`UPDATE gateway_jobs SET state='done',result='{"kind":"reviewed_no_match","evidenceIds":[]}'
    WHERE project_id=$1 AND purpose IN ('primary_a','primary_b')`,[project]);
  assert.equal(await dispatchPackagePair(db,queue,profile,true),false,'empty outcomes do not advance to other pages');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM gateway_attempts WHERE project_id=$1',[project])).rows[0].n,0);

  await report(2,[rows[0],{...rows[1],analysis:{properties:[{key:'new_property',label:'Бутилкаучуковая мастика',
    status:'insufficient',sources:[ref(30)]}]}},rows[2]]);
  assert.ok((await plan()).windowIds.includes(windowIds[30]));
  assert.equal(await directedWindowAllowed(db,project,windowIds[30],true,receipt),false,'the per-requirement cap spans review revisions');
  assert.equal(await dispatchPackagePair(db,queue,profile,true),false);

  await report(3,[rows[0],{key:'R2',status:'present',sources:[ref(25)]},rows[2]]);
  assert.equal((await plan()).mode,'no_new_targets');
  assert.equal((await plan()).openRequirements,1);
  await report(4,[rows[0],{key:'R2',status:'present',sources:[ref(25)]},{key:'R3',status:'present',sources:[ref(30)]}]);
  assert.equal((await plan()).mode,'enough_evidence');
  const remaining = await readTerraReading(db,project);
  assert.equal(remaining.progress.totalWindows-remaining.progress.completed,32);
  assert.equal(remaining.progress.directed.openRequirements,0);

  await report(5,[rows[0],{key:'R2',status:'present',sources:[ref(25)]},{key:'R3',status:'present',sources:[ref(30)]}]);
  const firstPoll = await readTerraReading(db,project,db);
  assert.equal(firstPoll.progress.directed.mode,'planning');
  assert.ok(firstPoll.report?.id,'the saved review is immediately visible on a cold planner');
  let nextPoll = firstPoll;
  const deadline = Date.now()+3000;
  while(nextPoll.progress.directed.mode==='planning' && Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,25));
    nextPoll=await readTerraReading(db,project,db);
  }
  assert.equal(nextPoll.progress.directed.mode,'enough_evidence');
  assert.equal(await deepReadingActivity(db,target,'completed','enough_evidence',{started:1,openRequirements:0}),true);
  assert.deepEqual(await admittedDeepReceipts(db,past),[]);

  await db.query("INSERT INTO intake_receipts(project_id,source,created_by) VALUES($1,'upload',$2)",[project,user]);
  assert.equal((await plan()).mode,'waiting_report');
  assert.equal(await directedWindowAllowed(db,project,windowIds[25],true,receipt),false);
});
