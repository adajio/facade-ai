import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import { readSnapshot } from '../infra/local-terra/producer.mjs';
import { cheaperInferenceScenario } from '../infra/local-terra/scenario-one-provider.mjs';
import { processScenarioOne, journalledScenarioCall } from '../infra/local-terra/scenario-one.mjs';

test('Scenario 1 uses the exact CheaperInference model, JSON and ZDR', async () => {
  assert.equal(await cheaperInferenceScenario({}),null);
  const call = await cheaperInferenceScenario({FACADE_SCENARIO_ONE_ENABLED:'1',CHEAPER_INFERENCE_API_KEY:'synthetic-key'},async (url,init) => {
    assert.equal(url,'https://api.cheaperinference.com/v1/chat/completions');
    assert.equal(init.headers['x-client-request-id'],'test-request');
    assert.equal(init.redirect,'error');
    assert.deepEqual(JSON.parse(init.body),{model:'gemini-3.5-flash-lite',zdr:true,stream:false,max_tokens:4096,
      response_format:{type:'json_object'},messages:[{role:'system',content:'classify'},{role:'user',content:'fixture'}]});
    return Response.json({model:'gemini-3.5-flash-lite',choices:[{finish_reason:'stop',message:{content:'{"evidence":[]}'}}]});
  });
  assert.deepEqual(await call({model:'gemini-3.5-flash-lite',instruction:'classify',content:'fixture',requestId:'test-request'}),{evidence:[]});
});

const url = process.env.SCENARIO_TEST_DATABASE_URL;
test('sealed Scenario 1 receipt publishes from OCR, classification and facts, preserves supplements and prevents paid replay', {skip:!url}, async () => {
  const parsed = new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname) && parsed.pathname.startsWith('/facade_test_'));
  const admin = new pg.Pool({connectionString:url});
  const schema = 'scenarios_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema);
  const db = new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});
  const app = Fastify();
  const previousEnabled = process.env.FACADE_SCENARIO_ONE_ENABLED;
  try {
    const migration = '43_receipt_analysis_scenario.sql';
    for (const name of (await readdir('db/migrations')).filter(name => name.endsWith('.sql') && !name.startsWith('01_') && name < migration).sort()) {
      await db.query(await readFile('db/migrations/'+name,'utf8'));
    }
    const { transaction } = await import('../dist/src/modules/gateway/types.js');
    const { lockIntakeProject } = await import('../dist/src/modules/intake/gate.js');
    const { createReceipt, getInventory } = await import('../dist/src/modules/intake/receipts.js');
    const { publishPreliminaryPackageReview, readPreliminaryPackageReviews } = await import('../dist/src/modules/assessment/preliminary-package-review.js');
    const [org,user,project,catalog] = Array.from({length:4},randomUUID);
    const requirements = [
      {key:'doc.floor_plans',part:'Планы',formats:['pdf'],evidenceRule:{allOf:[{anyOf:[{mode:'presence',sourceRole:'drawing'}]}]}},
      {key:'data.cladding',part:'Сведения об облицовке',formats:['pdf'],evidenceRule:{allOf:[{anyOf:[{mode:'value',sourceRole:'specification',subject:'Толщина облицовки'}]}]}},
      {key:'doc.revit',part:'Модель Revit',formats:['rvt'],evidenceRule:{allOf:[{anyOf:[{mode:'presence',sourceRole:'model'}]}]}},
    ];
    await db.query('INSERT INTO organizations(id,name) VALUES ($1,$2)',[org,'fixture']);
    await db.query("INSERT INTO users(id,organization_id,login,state,password_hash) VALUES ($1,$2,$3,'active',$4)",
      [user,org,'engineer','$argon2id$synthetic']);
    await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)",
      [catalog,org,JSON.stringify(requirements),user]);
    const oldProject = randomUUID();
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'Существующий объект',$3,'Стадия 1')",[oldProject,org,catalog]);
    await db.query(await readFile('db/migrations/'+migration,'utf8'));
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage) VALUES($1,$2,'Учебный объект',$3,'Стадия 1')",[project,org,catalog]);
    process.env.FACADE_SCENARIO_ONE_ENABLED = '1';
    const create = options => transaction(db,tx=>createReceipt(tx,{projectId:project,createdBy:user,source:'upload',...options}));
    const oldReceipt = await create({projectId:oldProject});
    assert.equal(oldReceipt.analysisScenario,2);
    const explicitSecond = await create({analysisScenario:2});
    assert.equal(explicitSecond.analysisScenario,2);
    const intake = await create({});
    assert.equal(intake.analysisScenario,1);
    assert.equal((await getInventory(db,{projectId:project,receiptId:intake.receiptId})).analysisScenario,1);
    const fixture = async (receiptId, id, text) => {
      const [original,document,version,preparation] = Array.from({length:4},randomUUID);
      const sha = id.repeat(64);
      const address = {unitId:'1',locator:{page:1}};
      await db.query('UPDATE intake_receipts SET sealed_at=now() WHERE id=$1',[receiptId]);
      await db.query('INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,1,$4)',[original,project,original,sha]);
      await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)',[document,project]);
      await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",[version,project,document,original]);
      await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,'fixture.pdf','application/pdf',$3,'accepted')",[project,receiptId,version]);
      await db.query("INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units) VALUES($1,$2,$3,'fixture',$4,$5,'pdf','[]')",
        [project,document,version,receiptId,sha]);
      await db.query("INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal) VALUES($1,$2,1,'fixture','pdf',1,1)",[project,version]);
      await db.query(`INSERT INTO project_memory_blocks_all(id,project_id,version_id,contract,reader_version,ordinal,unit_id,address,limitations,remaining)
        VALUES($1,$2,$3,1,'fixture',0,'1',$4,$5,ARRAY['ocr','graphics'])`,[sha,project,version,address,text?[]:['pdf_native_empty']]);
      if (text) await db.query("INSERT INTO project_memory_lines(block_id,ordinal,line_id,literal,folded,address) VALUES($1,0,'line',$2,$2,$3)",[sha,text,address]);
      const manifest={counts:{available:1},items:[{kind:'document',state:'available',versionId:version,originalSha256:sha,readerVersion:'fixture',format:'pdf'}]};
      await db.query('INSERT INTO intake_package_preparations(id,project_id,receipt_id,revision,snapshot_hash,manifest) VALUES($1,$2,$3,1,$4,$5)',
        [preparation,project,receiptId,sha,manifest]);
      await db.query('INSERT INTO intake_package_preparation_current(project_id,receipt_id,manifest_id) VALUES($1,$2,$3)',[project,receiptId,preparation]);
      return {version,preparation};
    };
    const first = await fixture(intake.receiptId,'a');
    const requests = [];
    const provider = async ({model,content,requestId}) => {
      assert.match(requestId,/^[a-f0-9-]{36}$/u);
      requests.push({model,content});
      if (Array.isArray(content)) return {lines:['Поэтажные планы. Панель НВФ — 8 мм.']};
      const {lines} = JSON.parse(content);
      const [line,quote] = lines[0];
      if (!quote.includes('Поэтажные планы')) return {evidence:[]};
      if (model === 'gemini-3.5-flash-lite') return {evidence:[{target:'doc.floor_plans/0',line,quote,role:'drawing'}]};
      return {evidence:[{target:'data.cladding/0',line,quote,role:'specification',subject:'Панель НВФ',value:'8 мм'}]};
    };
    const reader = {open:async()=>({evidence:{mediaType:'image/png',address:{unitId:'1',locator:{page:1}},id:randomUUID()},bytes:Buffer.from('synthetic image')})};
    const runReceipt = (receiptId, overrides = {}) => processScenarioOne({db,receiptId,reader,provider,readSnapshot,transaction,lockIntakeProject,
      recordActivity:async()=>{},publish:publishPreliminaryPackageReview,isStopped:()=>false,...overrides});
    assert.equal(await readSnapshot(db,intake.receiptId),null);
    assert.equal(await runReceipt(intake.receiptId),'published');
    assert.deepEqual(requests.map(call=>call.model),['gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.8-flash']);
    assert.equal(await runReceipt(intake.receiptId),'published');
    assert.equal(requests.length,3);
    const report=(await readPreliminaryPackageReviews(db,project)).items[0];
    assert.deepEqual(report.rows.map(row=>row.status),['present','present','not_found']);
    assert.equal(report.rows[1].sources[0].versionId,first.version);
    assert.match(report.draftText,/Модель Revit/);
    await assert.rejects(publishPreliminaryPackageReview(db,{projectId:project,receiptId:intake.receiptId,catalogVersionId:catalog,
      model:'gpt-6.1-terra',scopeNote:'fixture',draftText:'fixture',inventory:[],rows:[]}));
    await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'engineer')",[org,project,user]);
    const session = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [user,createHash('sha256').update(session).digest()]);
    const {csrfToken} = await import('../dist/src/modules/access/auth.js');
    const {register} = await import('../dist/src/modules/assessment/index.js');
    app.decorate('db',db);
    app.register(register);
    const letter = '/api/v1/projects/'+project+'/preliminary-package-reviews/'+report.id+'/scenario-one-letter';
    const command = async (payload,status=200,key=randomUUID()) => {
      const response = await app.inject({method:'POST',url:letter,payload,headers:{
        cookie:'facade_session='+session,origin:'http://localhost',host:'localhost','x-csrf-token':csrfToken(session),'idempotency-key':key,
      }});
      assert.equal(response.statusCode,status,response.body);
      return response.json();
    };
    assert.equal((await app.inject({url:letter})).statusCode,401);
    await command({kind:'draft',version:0,body:'Редакция инженера'});
    await command({kind:'sent',version:0},409);
    const sendKey = randomUUID();
    const sent = await command({kind:'sent',version:1},200,sendKey);
    const replay = await command({kind:'sent',version:1},200,sendKey);
    assert.deepEqual(sent,replay);
    assert.equal(sent.history[0].body,'Редакция инженера');
    await command({kind:'response',version:2,body:'Инженер согласовал работу по альтернативному комплекту.',
      requestKey:'doc.revit',responseState:'closed'});
    const next=await create({analysisScenario:1,analysisBaseReviewId:report.id});
    await fixture(next.receiptId,'b','Письмо заказчика о досылке дополнительных материалов.');
    assert.equal(await runReceipt(next.receiptId),'published');
    const revised=(await readPreliminaryPackageReviews(db,project)).items[0];
    assert.deepEqual(revised.rows.map(row=>row.status),['present','present','not_found']);
    assert.equal(revised.rows[1].sources[0].versionId,first.version);
    assert.equal(revised.changes.baselineId,report.id);
    assert.doesNotMatch(revised.draftText,/Модель Revit/);
    assert.match(revised.scopeNote,/Учтены зарегистрированные ответы/);
    const snapshot = await readSnapshot(db,next.receiptId,{scenarioOne:true});
    let calls=0;
    const args = {db,snapshot,transaction,lockIntakeProject,isStopped:()=>false,provider:async()=>{calls++;throw Error('timeout');}};
    const operation = ['independent','ocr',2], request={model:'gemini-3.8-flash',instruction:'read',content:'fixture'};
    assert.equal((await journalledScenarioCall(args,operation,request)).state,'sending');
    assert.equal((await journalledScenarioCall(args,operation,request)).state,'sending');
    assert.equal((await journalledScenarioCall(args,operation,{...request,content:'changed fixture'})).state,'sending');
    assert.equal(calls,1);
  } finally {
    if (previousEnabled === undefined) delete process.env.FACADE_SCENARIO_ONE_ENABLED;
    else process.env.FACADE_SCENARIO_ONE_ENABLED = previousEnabled;
    await app.close();
    await db.end();
    await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.end();
  }
});
