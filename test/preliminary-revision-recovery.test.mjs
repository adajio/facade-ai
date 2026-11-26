import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {applyRevision, reviseReceipt, revisionRequest, prepareRevisionSnapshot} from '../infra/local-terra/revise.mjs';
import {maxInputTokens, maxRequestBytes, ModelTransportError, measureRequest} from '../infra/local-terra/request-budget.mjs';

const read = async (path) => JSON.parse(await readFile(path,'utf8'));
const hash = 'a'.repeat(64);
const row = (key, finding) => ({key, status:'unassessed', finding, sources:[]});
const rejected = () => Object.assign(new Error('stale parent'), {code:'invalid_assessment_input'});
const response = (argumentsValue) => ({model:'gpt-6.1-terra',choices:[{finish_reason:'tool_calls',message:{tool_calls:[{
  type:'function',function:{name:'revise_package_review',arguments:JSON.stringify(argumentsValue)},
}]}}]});
const proposal = (id = 'O1') => ({
  changes:[{key:'R1',status:'present',finding:'Ведомость найдена.',ids:[id]}],
  letterEdits:[{key:'R1',before:'Передайте ведомость.',after:'Уточните её действующую редакцию.'}],
});

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(),'preliminary-revision-'));
  t.after(() => rm(stateDir,{recursive:true,force:true}));
  const projectId = randomUUID(), receiptId = randomUUID(), versionId = randomUUID();
  const r = {reportId:randomUUID(),projectId,receiptId,catalogVersionId:randomUUID(),stage:'РД',
    inventory:[{versionId,originalSha256:hash}],scopeNote:'Предварительная проверка',preparationId:randomUUID(),
    requirements:[{key:'R1',part:'Ведомость'},{key:'R2',part:'Крепления'}],
    rows:[row('R1','Ведомость не установлена.'),row('R2','Узел не установлен.')],
    draftText:'Передайте ведомость.\r\n\r\n\r\nУточните крепления.  '};
  const fact = {id:randomUUID(),versionId,originalSha256:hash,label:'drawing.pdf',address:{unitId:'p17',locator:{page:17}},
    quote:'Ведомость 1',limitation:null,grounding:'text'};
  const dir = join(stateDir,'revisions',receiptId);
  const pendingPath = join(dir,'pending.json');
  const state = {r,facts:[fact],published:new Map(),modelCalls:0,publishCalls:0};
  const db = {async query(sql,args) {
    if (sql.includes('ORDER BY r.created_at DESC')) {
      assert.deepEqual(args,[receiptId]);
      return {rows:state.r?[structuredClone(state.r)]:[]};
    }
    if (sql.includes('FROM intake_package_preparation_windows pw')) {
      const [project, receipt, manifest, seen] = args;
      assert.deepEqual([project,receipt,manifest],[projectId,receiptId,state.r.preparationId]);
      return {rows:structuredClone(state.facts.filter(({id})=>!seen.includes(id)))};
    }
    if (sql.includes('revision_key=$3 AND previous_report_id=$4')) {
      const [project,receipt,key,parent] = args;
      assert.deepEqual([project,receipt],[projectId,receiptId]);
      return {rows:state.published.has(key+parent)?[state.published.get(key+parent)]:[]};
    }
    return assert.fail('Unexpected SQL');
  }};
  const run = (overrides = {}) => reviseReceipt({db,receiptId,stateDir,
    admitClaim:async (_snapshot,reserve)=>await reserve()?'claimed':'claimed_elsewhere',
    modelCall:async request=>{
      state.modelCalls++;
      assert.equal((await read(pendingPath)).state,'sending');
      assert.equal(JSON.parse(request.messages[1].content).facts[0].id,'O1');
      return response(proposal());
    },
    publish:async (_db,input)=>{
      state.publishCalls++;
      assert.equal(input.previousReportId,state.r.reportId);
      const id = randomUUID();
      state.published.set(input.revisionKey+input.previousReportId,{id});
      state.r = {...state.r, reportId:id, rows:input.rows, draftText:input.draftText};
      return {id};
    },
    ...overrides,
  });
  const resultPaths = async () => (await readdir(dir)).filter(name=>name.endsWith('.result.json')).map(name=>join(dir,name));
  const reopen = async () => {
    const [name] = (await readdir(dir)).filter(file=>/^[a-f0-9]{64}\.json$/.test(file));
    const path = join(dir,name);
    await writeFile(path,JSON.stringify({...await read(path),at:0}));
  };
  return {r,fact,state,run,pendingPath,dir,resultPaths,reopen};
}

test('revision budgets the full prompt and keeps the strongest late observation with its exact address', async t => {
  const {r,fact} = await fixture(t);
  const bulk=Array.from({length:95},()=>({...fact,id:randomUUID(),quote:'Однотипная строка '.repeat(180)}));
  const decisive={...fact,id:randomUUID(),versionId:randomUUID(),quote:'Крепления, ведомость: узел 17'};
  const {snapshot,request} = prepareRevisionSnapshot(r,[...bulk,decisive],101);
  const {budget} = snapshot;
  assert.equal(budget.requestBytes,measureRequest(request).requestBytes);
  assert.ok(budget.requestBytes<=maxRequestBytes && budget.estimatedInputTokens<=maxInputTokens);
  assert.equal(budget.remainingFacts,101-snapshot.facts.length);
  assert.ok(budget.selectedFacts<96);
  assert.equal(budget.coveredFiles,2);
  assert.equal(snapshot.facts[0].id,decisive.id);
  assert.deepEqual(JSON.parse(request.messages[1].content).facts[0].address,decisive.address);
});

test('known provider rejection preserves exact pending batch across restart', async t => {
  const {run,pendingPath,state} = await fixture(t);
  const events=[];
  const recordActivity=async (_db,event)=>events.push(event);
  assert.equal(await run({recordActivity,modelCall:async ()=>{
    throw new ModelTransportError('rejected','provider_context_limit');
  }}),'revision_rejected:provider_context_limit');
  assert.equal(await run({recordActivity}),'revision_rejected:provider_context_limit');
  assert.equal(state.modelCalls,0);
  assert.deepEqual(events.map(({status})=>status),['sending','rejected','rejected']);
  const pending=await read(pendingPath);
  assert.equal(pending.snapshot.facts[0].id,state.facts[0].id);
  assert.equal(pending.state,'rejected');
});

test('known invalid answer is retained with its reason and releases the next batch', async (t) => {
  const {state,run,resultPaths,pendingPath,reopen,fact} = await fixture(t);
  const bad = {model:'gpt-6.1-terra'};
  assert.equal(await run({modelCall:async ()=>bad,publish:()=>assert.fail('invalid answer')}),'revision_rejected:invalid_revision_response');
  const [path] = await resultPaths();
  const {activityFields,pending,...result} = await read(path);
  assert.deepEqual(result, {state:'rejected',reportId:state.r.reportId,observationIds:[fact.id],reason:'invalid_revision_response'});
  const {budget,requestSha256,...snapshot} = pending.snapshot;
  assert.deepEqual(snapshot,{...state.r,facts:[fact],wireVersion:2,key:path.split('/').at(-1).split('.')[0]});
  assert.match(requestSha256,/^[a-f0-9]{64}$/);
  assert.equal(budget.selectedFacts,1);
  assert.equal(activityFields.estimatedInputTokens,budget.estimatedInputTokens);
  assert.deepEqual(pending.response,bad);
  await assert.rejects(read(pendingPath),{code:'ENOENT'});
  await reopen();
  const next = {...fact,id:randomUUID(),quote:'Ведомость 2'};
  state.facts.push(next);
  assert.equal(await run(),'published');
  assert.equal(state.modelCalls,1);
  assert.equal(state.publishCalls,1);
  assert.deepEqual(state.r.rows[0].sources.map(({quote})=>quote),[next.quote]);
});

test('unknown send is held without a second call, even when preparation changes', async (t) => {
  const {state,run,pendingPath} = await fixture(t);
  assert.equal(await run({modelCall:async ()=>{throw Error('connection closed');}}),'revision_outcome_unknown');
  assert.equal((await read(pendingPath)).state,'unknown');
  state.r = {...state.r,preparationId:randomUUID()};
  assert.equal(await run(),'revision_outcome_unknown');
  assert.equal(state.modelCalls,0);
  assert.equal(state.publishCalls,0);
});

test('publication committed before cursor recovery is acknowledged by exact durable identity', async (t) => {
  const {state,run,resultPaths,pendingPath} = await fixture(t);
  await assert.rejects(run({publish:async (_db,input)=>{
    const id = randomUUID();
    state.published.set(input.revisionKey+input.previousReportId,{id});
    state.r = {...state.r, reportId:id, rows:input.rows, draftText:input.draftText};
    throw Error('lost response after commit');
  }}), /lost response after commit/);
  assert.equal((await read(pendingPath)).state,'responded');
  assert.equal(await run({publish:()=>assert.fail('already committed')}),'published');
  assert.equal(state.modelCalls,1);
  assert.equal((await read((await resultPaths())[0])).publishedReportId,state.r.reportId);
  await assert.rejects(read(pendingPath),{code:'ENOENT'});
});

test('an unrelated concurrent revision rebases a paid answer and preserves unrelated draft bytes', async (t) => {
  const {r,state,run,pendingPath} = await fixture(t);
  const later = randomUUID();
  assert.equal(await run({publish:async ()=>{
    state.r = {...state.r,reportId:later,rows:[r.rows[0],row('R2','Новые сведения A/B.')],
      draftText:r.draftText.replace('Уточните крепления.  ','Приложите чертёж креплений.  ')};
    throw rejected();
  }}),'revision_rebase_pending');
  assert.equal(await run(),'revision_rebased');
  const pending = await read(pendingPath);
  assert.equal(pending.snapshot.reportId,r.reportId);
  assert.equal(pending.rebase.reportId,later);
  assert.equal(await run(),'published');
  assert.equal(state.modelCalls,1);
  assert.equal(state.publishCalls,1);
  assert.equal(state.r.rows[1].finding,'Новые сведения A/B.');
  assert.equal(state.r.draftText,'Уточните её действующую редакцию.\r\n\r\n\r\nПриложите чертёж креплений.  ');
});

test('a changed target row archives the stale answer and leaves its observations eligible', async (t) => {
  const {r,state,run,resultPaths} = await fixture(t);
  assert.equal(await run({publish:async ()=>{
    state.r = {...state.r,reportId:randomUUID(),rows:[row('R1','Другой вывод.'),r.rows[1]]};
    throw rejected();
  }}),'revision_rebase_pending');
  assert.equal(await run(),'revision_superseded');
  const [path] = await resultPaths();
  assert.equal((await read(path)).reason,'revision_parent_rows_changed');
  assert.equal(state.r.rows[0].finding,'Другой вывод.');
  assert.equal(await run(),'published');
  assert.equal(state.modelCalls,2);
});

test('reviews resolve short observation addresses within the immutable inventory', async (t) => {
  const {r,fact} = await fixture(t);
  const snap = {...r,wireVersion:2,facts:[fact],key:'fixture'};
  const wire = JSON.parse(revisionRequest(snap).messages[1].content);
  assert.equal(wire.facts[0].id,'O1');
  assert.ok(!JSON.stringify(wire).includes(fact.id));
  assert.throws(()=>applyRevision(snap,proposal(fact.id)),/unknown_revision_observation/);
  assert.throws(()=>applyRevision({...snap,facts:[{...fact,versionId:randomUUID()}]},proposal()),/invalid_revision_source/);
  assert.throws(()=>applyRevision({...snap,facts:[{...fact,grounding:'limited'}]},proposal()),/status_without_support/);
  assert.throws(()=>applyRevision({...snap,draftText:r.draftText+'\nПередайте ведомость.'},proposal()),/letter_source_changed/);
  assert.equal(applyRevision({...snap,wireVersion:undefined},proposal(fact.id)).rows[0].status,'present');
});

const databaseUrl = process.env.PRELIMINARY_TEST_DATABASE_URL;
test('PostgreSQL revision selection cannot import another project through a manifest window', {skip: !databaseUrl}, async (t) => {
  const parsed = new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname) && /^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
  const {Pool} = (await import('pg')).default;
  const schema = 'revision_' + randomUUID().replaceAll('-','');
  const admin = new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  t.after(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  const migrations = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name=>name.endsWith('.sql')&&!name.startsWith('01_')).sort()) {
    await db.query(await readFile(new URL(name,migrations),'utf8'));
  }
  const stateDir = await mkdtemp(join(tmpdir(),'revision-scope-'));
  t.after(() => rm(stateDir,{recursive:true,force:true}));
  const [org,user,catalog] = Array.from({length:3},randomUUID);
  const requirements = [{key:'R1',part:'Ведомость'}];
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,'revision-fixture')",[user,org]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'Fixture',$3,$4)",
    [catalog,org,JSON.stringify(requirements),user]);
  async function projectFixture(quote) {
    const [project,receipt,original,document,version,generation,window,job,manifest,evidence,observation] =
      Array.from({length:11},randomUUID);
    const source = {projectId:project,documentId:document,versionId:version,sha256:hash};
    const address = {unitId:'p1',locator:{page:1}};
    const inventory = [{versionId:version,originalSha256:hash}];
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'Fixture',$3,'РД')",[project,org,catalog]);
    await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receipt,project,user]);
    await db.query('INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)',[original,project,original,hash]);
    await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)',[document,project]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",[version,project,document,original]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'drawing.pdf','application/pdf',$4,'accepted')",[randomUUID(),project,receipt,version]);
    await db.query('INSERT INTO intake_reader_jobs(id,project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,receipt,document,version,original]);
    await db.query('INSERT INTO gateway_projects(project_id) VALUES($1)',[project]);
    await db.query('INSERT INTO gateway_generations(project_id,scope_id,generation_id) VALUES($1,NULL,$2)',[project,generation]);
    await db.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)',[project,generation]);
    await db.query("INSERT INTO harness_package_maps(project_id,version_id,fingerprint,format) VALUES($1,$2,'active','pdf')",[project,version]);
    await db.query("INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place) VALUES($1,$2,$3,'active',1,$4)",
      [window,project,version,JSON.stringify({source,unitId:'p1',page:1})]);
    await db.query("INSERT INTO gateway_primary(generation_id,id,branch,place) VALUES($1,'a','A','p1')",[generation]);
    await db.query(`INSERT INTO gateway_jobs(id,project_id,scope_id,generation_id,job_key,kind,purpose,subject_id,obligation_id,spec_hash,payload,priority,state)
      VALUES($1,$2,NULL,$3,'fixture','harness_research','primary_a','fixture','a','fixture','{}',1,'done')`,[job,project,generation]);
    await db.query("INSERT INTO harness_package_branches(window_id,branch,profile_hash,settings,job_id) VALUES($1,'A','fixture','{}',$2)",[window,job]);
    await db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,'fixture',$4,$5,'pdf','[]')",[project,document,version,receipt,hash]);
    await db.query("INSERT INTO reader_evidence(id,project_id,version_id,reader_version,run_id,branch,operation_key,request_sha256,payload) VALUES($1,$2,$3,'fixture',$4,'A','read',$5,'{}')",[evidence,project,version,job,hash]);
    await db.query(`INSERT INTO reader_observations(id,project_id,version_id,run_id,branch,operation_key,request_sha256,evidence_id,scope_id,payload)
      VALUES($1,$2,$3,$4,'A','pin',$5,$6,NULL,$7)`,[observation,project,version,job,hash,evidence,JSON.stringify({source,address,quote,grounding:'text'})]);
    await db.query(`INSERT INTO harness_package_facts(id,project_id,window_id,job_id,source_role,revision_status,basis,materials)
      VALUES($1,$2,$3,$4,'drawing','current','{}','[]')`,[observation,project,window,job]);
    await db.query("INSERT INTO intake_package_preparations(id,project_id,receipt_id,revision,snapshot_hash,manifest) VALUES($1,$2,$3,1,$4,'{}')",[manifest,project,receipt,hash]);
    await db.query('INSERT INTO intake_package_preparation_current(project_id,receipt_id,manifest_id) VALUES($1,$2,$3)',[project,receipt,manifest]);
    await db.query("INSERT INTO intake_package_preparation_items(manifest_id,project_id,version_id,map_fingerprint) VALUES($1,$2,$3,'active')",[manifest,project,version]);
    await db.query('INSERT INTO intake_package_preparation_windows(manifest_id,project_id,window_id) VALUES($1,$2,$3)',[manifest,project,window]);
    await db.query(`INSERT INTO preliminary_package_reviews(project_id,receipt_id,catalog_version_id,model,stage,input_generation,inventory,scope_note,rows,draft_text,content_hash,preparation_id)
      VALUES($1,$2,$3,'gpt-6.1-terra','РД',0,$4,'Обзор',$5,'Передайте ведомость.',$6,$7)`,
      [project,receipt,catalog,JSON.stringify(inventory),JSON.stringify([row('R1','Ведомость не установлена.')]),hash,manifest]);
    return {project,receipt,window,manifest,version};
  }
  const selected = await projectFixture('Ведомость 1');
  const foreign = await projectFixture('Посторонний источник');
  // The manifest/window FK alone accepts this mismatched project relation.
  await db.query('INSERT INTO intake_package_preparation_windows(manifest_id,project_id,window_id) VALUES($1,$2,$3)',
    [selected.manifest,selected.project,foreign.window]);
  assert.equal(await reviseReceipt({
    db,receiptId:selected.receipt,stateDir,admitClaim:async (_snapshot,reserve)=>await reserve()?'claimed':'claimed_elsewhere',
    modelCall: async (request) => {
      assert.deepEqual(JSON.parse(request.messages[1].content).facts.map(({quote})=>quote),['Ведомость 1']);
      return response(proposal());
    },
    publish: async (_db,input) => {
      assert.equal(input.projectId,selected.project);
      assert.deepEqual(input.rows[0].sources.map(({versionId})=>versionId),[selected.version]);
      return {id:randomUUID()};
    },
  }), 'published');
});
