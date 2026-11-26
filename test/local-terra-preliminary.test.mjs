import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, claim, processReceipt, readSnapshot, makeRequest, parseModelResponse } from '../infra/local-terra/producer.mjs';
const hash='b'.repeat(64);
function fakeDb({published=false,service=false}={}) {
  const client={release(){},async query(sql){
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {rows:[]};
    if (/FROM intake_receipts r JOIN projects/.test(sql)) return {rows:[{id:'r',project_id:'p',catalog_version_id:'c',project_stage:'RD',requirements:[{key:'1',part:'Чертёж'}],ready:true,preparation_id:'m',manifest:{counts:{available:1},items:[
      {kind:'document',state:'available',versionId:'v',originalSha256:hash,readerVersion:'pdf'},
      ...(service?[{kind:'technical',state:'excluded',versionId:'z',originalSha256:'a'.repeat(64)}]:[])],restrictions:[]}}]};
    if (/FROM intake_occurrences o JOIN intake_document_versions/.test(sql)) return {rows:[{versionId:'v',originalSha256:hash,path:'drawing.pdf',mediaType:'application/pdf',restricted:false,hasReaderJob:true},...(service?[{versionId:'z',originalSha256:'a'.repeat(64),path:'__MACOSX/._drawing',mediaType:'application/octet-stream',hasReaderJob:false}]:[])]};
    if (/SELECT DISTINCT ON \(m.version_id\)/.test(sql)) return {rows:[{version_id:'v',reader_version:'pdf',total:1,next_ordinal:1}]};
    if (/FROM project_memory_blocks b JOIN project_memory_lines/.test(sql)) return {rows:[{versionId:'v',unitId:'page-1',lineId:'line-1',text:'Высота 37 мм',address:{locator:{page:1}}}]};
    if (/WITH sequenced/.test(sql)) return {rows:[{version_id:'v',remaining:['graphics'],limitations:['drawing_unread'],first:2,last:4,first_unit:'p3',last_unit:'p5'}]};
    throw Error('unexpected query');
  }};
  return {connect:async()=>client,query:async()=>({rowCount:published?1:0}),setPublished(){published=true;}};
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
  const {preparePromptSnapshot} = await import('../infra/local-terra/producer.mjs');
  const s = await readSnapshot(fakeDb(),'r');
  const noisy = {...s, lines:Array.from({length:5000}, (_, i) => ({...s.lines[0],id:'L'+(i+1),
    text:'Фасад '.repeat(25), anchor:JSON.stringify({unitId:'page-'+i,lineId:'x'.repeat(200)})})),
    unread:Array.from({length:1400},(_, i)=>({...s.unread[0],fromUnit:'p'+i,throughUnit:'p'+i})),
    scopeNote:'Предварительный обзор'};
  const prepared = preparePromptSnapshot(noisy);
  const request = makeRequest(prepared);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 180_000);
  assert.ok(prepared.lines.length > 0 && prepared.lines.length < noisy.lines.length);
  assert.match(prepared.scopeNote,/модели передано/i);
  assert.ok(!request.messages[1].content.includes(hash));
  assert.ok(request.messages[1].content.includes('drawing_unread'));
  assert.throws(()=>validate(prepared,{...result,rows:[{...result.rows[0],citations:[{id:noisy.lines.at(-1).id,quote:'Фасад'}]}]}),/invalid_citation/);
});

test('an uncertain call permits exactly one explicitly authorized replacement with the exact request and preparation', async () => {
  const {preparePromptSnapshot} = await import('../infra/local-terra/producer.mjs');
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
