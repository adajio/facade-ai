import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, claim, processReceipt, readSnapshot, makeRequest, parseModelResponse, preparePromptSnapshot } from '../infra/local-terra/producer.mjs';
import {measureRequest, maxInputTokens, maxRequestBytes, ModelTransportError} from '../infra/local-terra/request-budget.mjs';
import {queueReassessment, runReassessment} from '../infra/local-terra/reassessment.mjs';
const hash='b'.repeat(64);
function fakeDb({published=false,service=false,requirements=[{key:'1',part:'Чертёж'}]}={}) {
  const client={release(){},async query(sql){
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {rows:[]};
    if (/FROM intake_receipts r JOIN projects/.test(sql)) return {rows:[{id:'r',project_id:'p',catalog_version_id:'c',project_stage:'RD',requirements,receipt_created_at:'2026-01-01T00:00:00.000Z',ready:true,preparation_id:'m',manifest:{counts:{available:1},items:[
      {kind:'document',state:'available',versionId:'v',originalSha256:hash,readerVersion:'pdf'},
      ...(service?[{kind:'technical',state:'excluded',versionId:'z',originalSha256:'a'.repeat(64)}]:[])],restrictions:[]}}]};
    if (/FROM intake_occurrences o JOIN intake_document_versions/.test(sql)) return {rows:[{versionId:'v',originalSha256:hash,path:'drawing.pdf',mediaType:'application/pdf',restricted:false,hasReaderJob:true},...(service?[{versionId:'z',originalSha256:'a'.repeat(64),path:'__MACOSX/._drawing',mediaType:'application/octet-stream',hasReaderJob:false}]:[])]};
    if (/^SELECT id,parent_occurrence_id FROM intake_occurrences/.test(sql)) return {rows:[]};
    if (/SELECT DISTINCT ON \(m.version_id\)/.test(sql)) return {rows:[{version_id:'v',reader_version:'pdf',contract:1,total:1,next_ordinal:1}]};
    if (/^(DECLARE|CLOSE) preliminary_evidence/.test(sql)) return {rows:[]};
    if (/FETCH FORWARD/.test(sql)) return {rows:[{versionId:'v',blockId:'block-1',ordinal:0,folded:'высота 37 мм'}]};
    if (/pins AS/.test(sql)) return {rows:[{position:0,versionId:'v',readerVersion:'pdf',blockId:'block-1',blockOrdinal:0,
      ordinal:0,unitId:'page-1',lineId:'line-1',text:'Высота 37 мм',address:{locator:{page:1}}}]};
    if (/WITH sequenced/.test(sql)) return {rows:[{version_id:'v',remaining:['graphics'],limitations:['drawing_unread'],first:2,last:4,first_unit:'p3',last_unit:'p5'}]};
    throw Error('unexpected query');
  }};
  return {connect:async()=>client,query:async()=>({rowCount:published?1:0,rows:published && typeof published==='object'?[published]:[]}),setPublished(review){published=review ?? true;}};
}
const admitClaim=async (_snapshot,reserve)=>await reserve() ? 'claimed' : 'claimed_elsewhere';
const result={rows:[{key:'1',status:'present',finding:'37 мм',citations:[{id:'L1',quote:'37 мм'}]}],draftText:'Предварительный обзор'};
const statePath=(dir,s)=>join(dir,`r-${createHash('sha256').update(JSON.stringify({projectId:s.projectId,receiptId:s.receiptId,catalogVersionId:s.catalogVersionId,stage:s.stage,inventory:s.inventory,preparationId:s.preparationId})).digest('hex')}.json`);
test('only exact supplied quote can become a source',async()=>{
  const snap=await readSnapshot(fakeDb(),'r');
  assert.match(validate(snap,result).rows[0].sources[0].anchor,/page/);
  assert.throws(()=>validate(snap,{...result,rows:[{...result.rows[0],citations:[{id:'L1',quote:'38 мм'}]}]}),/invalid_citation/);
  assert.throws(()=>validate(snap,{...result,rows:[{...result.rows[0],status:'not_found'}]}),/invalid_row/);
  assert.throws(()=>validate(snap,{...result,rows:[{...result.rows[0],citations:[]}]}),/missing_citation/);
});
test('legacy rejected tool result recovers literal line breaks only if the original line verifies the quote', async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'terra-citation-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const db=fakeDb();
  const snapshot=await readSnapshot(db,'r');
  snapshot.lines[0].text='Первая строка\nВторая строка';
  const withQuote = quote=>({...result,rows:[{...result.rows[0],citations:[{id:'L1',quote}]}]});
  const raw=withQuote('строка\\nВторая');
  await writeFile(statePath(stateDir,snapshot),JSON.stringify({state:'rejected',error:'invalid_citation',snapshot,result:raw}));
  let savedQuote;
  assert.equal(await processReceipt({db,receiptId:'r',stateDir,admitClaim,modelCall:assert.fail,
    publish:async (_db,input)=>{savedQuote=input.rows[0].sources[0].quote;return {id:'old-response'};}}),'published');
  assert.equal(savedQuote,'строка\nВторая');
  assert.deepEqual(JSON.parse(await readFile(statePath(stateDir,snapshot),'utf8')).result,raw);
  assert.throws(()=>validate(snapshot,withQuote('строка\\nДругая')),/invalid_citation/);
  snapshot.lines[0].text='строка\\nВторая';
  assert.equal(validate(snapshot,raw).rows[0].sources[0].quote,'строка\\nВторая');
});
test('published inventory prevents model invocation',async()=>{
  let called=false; assert.equal(await processReceipt({db:fakeDb({published:true}),receiptId:'r',stateDir:'/unused',modelCall:()=>{called=true;}}),'published'); assert.equal(called,false);
});
test('uncertain request survives restart for same fingerprint',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-')); const db=fakeDb(); const snap=await readSnapshot(db,'r');
  try { const path=statePath(dir,snap); await claim(path,snap); let called=false;
    assert.equal(await processReceipt({db,receiptId:'r',stateDir:dir,admitClaim,modelCall:()=>{called=true;}}),'unknown');
    assert.equal(called,false); assert.equal(JSON.parse(await readFile(path)).state,'sending');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('preliminary review resumes after verified Mac rejections and keeps late uncertainty held',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'prelim-mac-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const db=fakeDb(), events=[], requests=[];
  const snapshot=await readSnapshot(db,'r');
  const path=statePath(stateDir,snapshot);
  const run=options=>processReceipt({db,receiptId:'r',stateDir,admitClaim,publish:assert.fail,
    recordActivity:async (_db,event)=>events.push(event),...options});
  const rejection=async (state,reason)=>run({modelCall:async request=>{
    assert.equal(JSON.parse(await readFile(path)).state,'sending');
    requests.push(request);
    throw new ModelTransportError(state,reason);
  }});
  for (const reason of ['mac_terra_busy','mac_terra_paused','mac_terra_budget_exhausted','mac_terra_not_started']) {
    assert.equal(await rejection('rejected',reason),'waiting');
    const saved=JSON.parse(await readFile(path));
    assert.equal(saved.state,'rejected');
    assert.equal(saved.error,reason);
    assert.deepEqual(events.at(-1).reason,reason);
    assert.equal(events.at(-1).status,'waiting');
    assert.equal(await run({admitClaim:async()=> 'held_terra_mac_unavailable',modelCall:assert.fail}),'held_terra_mac_unavailable');
  }
  assert.equal(await rejection('unknown','mac_terra_busy'),'unknown');
  assert.equal(await run({modelCall:assert.fail}),'unknown');
  assert.equal(requests.length,5);
  requests.forEach(request=>assert.deepEqual(request,requests[0]));
});

test('addressed review retries a confirmed pre-dispatch halt through its queued ticket',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'addressed-mac-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const db=fakeDb(), scope=await readSnapshot(db,'r');
  const report={...scope,reportId:'original',rows:[{key:'1',status:'unassessed',finding:'Нет решения',sources:[]}],draftText:''};
  db.query=async sql=>sql.includes('ORDER BY r.created_at DESC') ? {rows:[report]} : {rowCount:0};
  const key=await queueReassessment(stateDir,scope,'operator');
  const path=join(stateDir,'addressed','r',key+'.json');
  const events=[], requests=[];
  const run={db,stateDir,admitClaim,publish:async()=>({id:'revised'}),recordActivity:async (_db,event)=>events.push(event),
    modelCall:async request=>{
      assert.equal(JSON.parse(await readFile(path)).state,'sending');
      requests.push(request);
      if (requests.length===1) throw new ModelTransportError('rejected','mac_terra_paused');
      return {rows:[{key:'1',status:'partial',finding:'37 мм',citations:[{id:'L1',quote:'37 мм'}],analysis:{
        applicability:{kind:'undetermined',reason:'Нужна сверка',citations:[]},properties:[],tensions:[],
      }}]};
    }};
  assert.equal(await runReassessment(run,scope,'operator'),'waiting');
  assert.equal(JSON.parse(await readFile(path)).reason,'mac_terra_paused');
  assert.equal(await runReassessment(run,scope,'operator'),'published');
  assert.equal(JSON.parse(await readFile(path)).reviewId,'revised');
  assert.deepEqual(events.map(({status,reason})=>[status,reason]),[
    ['sending',undefined],['waiting','mac_terra_paused'],['sending',undefined],['published',undefined],
  ]);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],requests[1]);
});
test('response replay after failed publish does not call model',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-')); const db=fakeDb(); const snapshot=await readSnapshot(db,'r');
  try { await writeFile(statePath(dir,snapshot),JSON.stringify({state:'responded',snapshot,result})); let calls=0, publishes=0;
    const opt={db,receiptId:'r',stateDir:dir,admitClaim,modelCall:()=>calls++,publish:async()=>{if(!publishes++) throw Error('offline');}};
    await assert.rejects(processReceipt(opt),/offline/); assert.equal(await processReceipt(opt),'published'); assert.equal(calls,0); assert.equal(publishes,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('changed inventory gets a new fingerprint; service file limitation is explicit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-')); const db=fakeDb(); const snap=await readSnapshot(db,'r');
  try { await claim(statePath(dir,snap),snap); const changed=fakeDb({service:true}); let calls=0,saved;
    assert.equal(await processReceipt({db:changed,receiptId:'r',stateDir:dir,admitClaim,modelCall:async()=>{calls++;return result;},publish:async(_db,input)=>{saved=input;}}),'published');
    assert.equal(calls,1); assert.equal(saved.inventory.length,2); assert.match(saved.scopeNote,/служебные элементы: 1/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('required single function and response envelope are enforced',()=>{
  const req=makeRequest({requirements:[],lines:[]}); assert.equal(req.tool_choice,'required'); assert.equal(req.tools.length,1);
  assert.equal(req.messages[0].role,'system'); assert.equal(req.tools[0].function.name,'submit_preliminary_review');
  const call={type:'function',function:{name:'submit_preliminary_review',arguments:JSON.stringify(result)}};
  const envelope={model:'gpt-6.1-terra',choices:[{finish_reason:'tool_calls',message:{tool_calls:[call]}}]};
  assert.deepEqual(parseModelResponse(envelope),result);
  assert.throws(()=>parseModelResponse({...envelope,choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  assert.throws(()=>parseModelResponse({...envelope,choices:[{finish_reason:'tool_calls',message:{tool_calls:[call,call]}}]}));
  assert.throws(()=>parseModelResponse({...envelope,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{...call,function:{...call.function,name:'other'}}]}}]}));
});

test('changed preparation cannot claim a model request and unread ranges keep their file and address',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-'));
  try {
    const db=fakeDb(), snap=await readSnapshot(db,'r');
    assert.deepEqual(snap.unread[0],{path:'drawing.pdf',versionId:'v',fromUnit:'p3',throughUnit:'p5',unitCount:3,remaining:['graphics'],reasons:['drawing_unread']});
    const status=await processReceipt({db,receiptId:'r',stateDir:dir,admitClaim:async()=> 'waiting',modelCall:()=>assert.fail('obsolete request')});
    assert.equal(status,'waiting');
    await assert.rejects(readFile(statePath(dir,snap)),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('native reading proposes only grounded revisions and patches the addressed draft without touching other paragraphs', async () => {
  const {applyRevision,revisionRequest}=await import('../infra/local-terra/revise.mjs');
  const s={projectId:'p',receiptId:'r',reportId:'old',key:'batch',preparationId:'prepared',inventory:[],requirements:[],
    rows:[{key:'R1',status:'not_found',finding:'Не найдено',sources:[]},{key:'R2',status:'partial',finding:'Узел',sources:[]}],
    draftText:'Предоставьте ведомость.\n\nУточните крепления.',
    facts:[{id:'obs',versionId:'v',originalSha256:hash,address:{unitId:'17',locator:{page:17}},quote:'Ведомость 1',limitation:null}]};
  assert.equal(revisionRequest(s).model,'gpt-6.1-terra');
  const change={key:'R1',finding:'Ведомость найдена на стр. 17.',status:'partial',ids:['obs']};
  const edit={key:'R1',before:'Предоставьте ведомость.',after:'Уточните действующую редакцию ведомости.'};
  const result=applyRevision(s,{changes:[change],letterEdits:[edit]});
  assert.deepEqual(result.rows[1],s.rows[1]);
  assert.equal(result.rows[0].sources[0].quote,'Ведомость 1');
  assert.equal(result.draftText,'Уточните действующую редакцию ведомости.\n\nУточните крепления.');
  assert.equal(s.rows[0].sources.length,0);
  assert.equal(applyRevision(s,{changes:[],letterEdits:[]}),null);
  assert.throws(()=>applyRevision(s,{changes:[{...change,ids:['foreign']}],letterEdits:[]}),/unknown_revision_observation/);
  assert.throws(()=>applyRevision(s,{changes:[change],letterEdits:[{...edit,before:'Несуществующий текст'}]}),/letter_source_changed/);
  assert.throws(()=>applyRevision(s,{changes:[],letterEdits:[edit]}),/invalid_letter_edit/);
  assert.throws(()=>applyRevision({...s,facts:[{...s.facts[0],limitation:'Не видна выноска'}]},{changes:[change],letterEdits:[]}),/status_without_support/);
});

test('normal adapter entry returns the revision envelope and preserves known malformed responses', async () => {
  const {invokeModel}=await import('../infra/local-terra/producer.mjs');
  const dir=await mkdtemp(join(tmpdir(),'preliminary-revision-'));
  const script=join(dir,'fixture.py');
  const envelope={model:'gpt-6.1-terra',choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'revise_package_review',arguments:'{}'}}]}}]};
  const request={tools:[{function:{name:'revise_package_review'}}]};
  try {
    await writeFile(script,`print(\u0027${JSON.stringify(envelope)}\u0027)\n`);
    assert.deepEqual(await invokeModel(script,request),envelope);
    await writeFile(script,'print("invalid json")\n');
    assert.deepEqual(await invokeModel(script,request),{error:'invalid_adapter_json'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('large preliminary prompt enforces a byte bound across files, restrictions and grounded lines', async () => {
  const s = await readSnapshot(fakeDb(),'r');
  const noisy = {...s, lines:Array.from({length:5000}, (_, i) => ({...s.lines[0],id:'L'+(i+1),
    text:'Фасад '.repeat(25), anchor:JSON.stringify({unitId:'page-'+i,lineId:'x'.repeat(200)})})),
    unread:Array.from({length:1400},(_, i)=>({...s.unread[0],fromUnit:'p'+i,throughUnit:'p'+i})),
    totalLines:5000,retrieval:undefined,scopeNote:'Предварительный обзор'};
  const prepared = preparePromptSnapshot(noisy);
  const request = makeRequest(prepared);
  const measured=measureRequest(request);
  assert.ok(measured.requestBytes <= maxRequestBytes);
  assert.ok(measured.estimatedInputTokens <= maxInputTokens);
  assert.ok(measured.estimatedInputTokens > measured.promptBytes);
  assert.equal(prepared.budget.remainingLines,noisy.lines.length-prepared.lines.length);
  assert.ok(prepared.lines.length > 0 && prepared.lines.length < noisy.lines.length);
  assert.match(prepared.scopeNote,/модели передано/i);
  assert.ok(!request.messages[1].content.includes(hash));
  assert.ok(request.messages[1].content.includes('drawing_unread'));
  assert.throws(()=>validate(prepared,{...result,rows:[{...result.rows[0],citations:[{id:noisy.lines.at(-1).id,quote:'Фасад'}]}]}),/invalid_citation/);
});

test('an uncertain call permits exactly one explicitly authorized replacement with the exact request and preparation', async () => {
  const db=fakeDb(), snapshot=await readSnapshot(db,'r');
  const previous={...snapshot,preparationId:'previous'}, dir=await mkdtemp(join(tmpdir(),'preliminary-replacement-'));
  try {
    const path=statePath(dir,previous), retryAuthorization={preparationId:snapshot.preparationId,requestSha256:'unrelated'};
    const options={db,receiptId:'r',stateDir:dir,admitClaim,modelCall:async()=>{throw Error('unconfirmed');}};
    await writeFile(path,JSON.stringify({state:'unknown',snapshot:previous,retryAuthorization}));
    assert.equal(await processReceipt(options),'held_legacy_attempt');
    retryAuthorization.requestSha256=createHash('sha256').update(JSON.stringify(makeRequest(preparePromptSnapshot(snapshot)))).digest('hex');
    await writeFile(path,JSON.stringify({state:'unknown',snapshot:previous,retryAuthorization}));
    let calls=0; options.modelCall=async()=>{calls++;throw Error('unconfirmed');};
    assert.equal(await processReceipt(options),'unknown');
    assert.equal(await processReceipt(options),'unknown');
    assert.equal(calls,1);
    assert.equal(JSON.parse(await readFile(path)).state,'unknown');
  } finally {await rm(dir,{recursive:true,force:true});}
});


test('inventory compaction and source balance preserve evidence for a late criterion under both caps', async () => {
  const base = await readSnapshot(fakeDb(), 'r');
  const requirements = [
    {key:'R1',part:'Ведомость окон'},
    {key:'R2',part:'Огнезащитный пояс',completenessCriterion:'Указана нормативная высота и узел примыкания'},
  ];
  const files=Array.from({length:306},(_,index)=>({versionId:'V'+index,path:`папка/корпус-${index%4}/Лист-"№${index%80}"-⭕.pdf`}));
  const source = (id,versionId,text) => ({...base.lines[0],id,versionId,text});
  const lines = [
    ...Array.from({length:3500},(_,index)=>source('L'+index,files[0].versionId,'Ведомость окон '.repeat(19))),
    ...files.slice(1).map((file,index) => source('E'+index,file.versionId,'Указание на листе.')),
    source('target',files.at(-1).versionId,'Узел примыкания: огнезащитный пояс 250 мм.'),
  ];
  const snapshot = preparePromptSnapshot({...base,files,lines,requirements,retrieval:undefined,totalLines:12_000});
  const {budget,promptData} = snapshot;
  assert.equal(budget.selectedFiles,306);
  assert.ok(budget.coveredFiles > 150);
  assert.equal(budget.remainingLines,12_000-snapshot.lines.length);
  assert.ok(budget.requestBytes <= maxRequestBytes && budget.estimatedInputTokens <= maxInputTokens);
  assert.ok(snapshot.lines.some(line=>line.id==='target'));
  const primary = promptData.lines.find(([id])=>id==='target');
  const [folder,name] = promptData.files[primary[1]-1];
  assert.equal(promptData.directories[folder-1]+'/'+promptData.names[name-1],files.at(-1).path);
});

test('full request sizes agree with UTF-8 bytes seen at the Python adapter boundary',async t=>{
  const {invokeModel} = await import('../infra/local-terra/producer.mjs');
  const dir=await mkdtemp(join(tmpdir(),'terra-body-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'inspect.py');
  await writeFile(script,[
    'import json, sys',
    'body = sys.stdin.buffer.read()',
    'request = json.loads(body)',
    'prompt = json.dumps(dict(messages=request["messages"], available_functions=request["tools"]), ensure_ascii=False, separators=(",", ":")).encode()',
    'print(json.dumps(dict(adapterBytes=len(body), promptBytes=len(prompt))))',
  ].join('\n'));
  const snap=await readSnapshot(fakeDb(),'r');
  const request=makeRequest({...snap,lines:[{...snap.lines[0],text:'строка "Б" \n \t \u0001 \u{1F584} '}]});
  const actual=await invokeModel(script,request);
  const fields=measureRequest(request);
  assert.equal(fields.promptBytes,actual.promptBytes);
  assert.equal(fields.requestBytes,Math.max(actual.adapterBytes,actual.promptBytes));
});

test('oversize fixed context is rejected before claim and invocation', async t => {
  const dir=await mkdtemp(join(tmpdir(),'terra-context-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=fakeDb({requirements:[{key:'1',part:'Чертёж',evidenceRule:'слово '.repeat(10000)}]});
  const events=[];
  assert.equal(await processReceipt({db,receiptId:'r',stateDir:dir,recordActivity:async(_db,event)=>events.push(event),
    admitClaim:()=>assert.fail('oversize claimed'),modelCall:()=>assert.fail('oversize sent')}),'primary_request_limit');
  assert.equal(events[0].reason,'primary_request_limit');
  assert.equal(events[0].status,'rejected');
  assert.ok(events[0].fields.requestBytes>maxRequestBytes);
});

test('primary activity records exact usage and recovers committed report after journal write is interrupted', async t => {
  const dir=await mkdtemp(join(tmpdir(),'terra-activity-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=fakeDb(), snapshot=await readSnapshot(db,'r'), events=[];
  const report={...snapshot,id:'28900b04-054b-4810-9847-0ad60bf9c44f',publishedAt:'2026-01-01T00:01:00.000Z'};
  let calls=0;
  const options={db,receiptId:'r',stateDir:dir,admitClaim,
    recordActivity:async (_db,event)=>{
      events.push(event);
      if (event.status==='completed') throw Error('telemetry unavailable');
    },
    modelCall:async request=>{
      calls++;
      assert.equal(measureRequest(request).requestBytes,events[0].fields.requestBytes);
      return {model:'gpt-6.1-terra',usage:{prompt_tokens:8921,completion_tokens:610},choices:[
        {finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_preliminary_review',arguments:JSON.stringify(result)}}]}},
      ]};
    },
    publish:async()=>{
      db.setPublished(report);
      throw Error('connection lost after publication');
    },
  };
  await assert.rejects(processReceipt(options),/after publication/);
  assert.equal(await processReceipt(options),'published');
  assert.equal(calls,1);
  assert.deepEqual(events.map(event=>event.status),['sending','completed','published']);
  assert.equal(new Set(events.map(event=>event.attemptKey)).size,1);
  assert.equal(events.at(-1).fields.reviewId,report.id);
  assert.equal(events.at(-1).fields.inputTokens,8921);
  assert.equal(events.at(-1).fields.outputTokens,610);
  assert.equal(events.at(-1).fields.timeToFirstUsefulMs,60000);
  assert.equal(JSON.parse(await readFile(statePath(dir,snapshot))).reviewId,report.id);
});

test('adapter start failure, provider rejection and late unknown outcomes are distinct', async t => {
  const {invokeModel}=await import('../infra/local-terra/producer.mjs');
  const dir=await mkdtemp(join(tmpdir(),'terra-adapter-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'adapter.py');
  await assert.rejects(invokeModel(script,{}),{message:'adapter_unavailable',state:'rejected'});
  await writeFile(script,'import sys\nprint("codex_context_limit", file=sys.stderr)\nsys.exit(1)\n');
  await assert.rejects(invokeModel(script,{}),{message:'provider_context_limit',state:'rejected'});
  await writeFile(script,'import sys\nprint("internal diagnostic", file=sys.stderr)\nsys.exit(1)\n');
  await assert.rejects(invokeModel(script,{}),{message:'adapter_failed_after_start',state:'unknown'});
});

test('retrieval ranks subjects from catalog alternatives and ignores schema field names', async () => {
  const {prioritizeEvidence} = await import('../infra/local-terra/request-budget.mjs');
  const items = [{text:'object drawing presence'}, {text:'Герметизация наружного шва'},
    {text:'Прочность бетона'}];
  const describe = item => ({source:'sheet', text:item.text, label:''});
  const rule = {allOf:[{anyOf:[{subject:'Герметизация',sourceRole:'drawing',mode:'value'}]},
    {anyOf:[{subject:'Прочность',sourceRole:'design',mode:'value'}]}]};
  const current = prioritizeEvidence(items,[{part:'Сведения',evidenceRule:rule}],describe);
  assert.deepEqual(current.map(x=>x.text),[items[1].text,items[2].text,items[0].text]);
  assert.equal(prioritizeEvidence(items,[{evidenceRule:'Прочность'}],describe)[0],items[2]);
  assert.deepEqual(prioritizeEvidence(items,[{evidenceRule:{allOf:[null,{anyOf:[null]}]}}],describe),items);
  assert.deepEqual(prioritizeEvidence(items,[{evidenceRule:{allOf:[{anyOf:[{mode:'presence',sourceRole:'drawing'}]}]}}],describe),items);
});
