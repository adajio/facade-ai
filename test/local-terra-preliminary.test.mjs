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
    if (/FROM intake_receipts r JOIN projects/.test(sql)) return {rows:[{id:'r',project_id:'p',catalog_version_id:'c',project_stage:'RD',requirements:[{key:'1',part:'Чертёж'}],ready:true}]};
    if (/FROM intake_occurrences o JOIN intake_document_versions/.test(sql)) return {rows:[{versionId:'v',originalSha256:hash,path:'drawing.pdf',mediaType:'application/pdf',restricted:false,hasReaderJob:true},...(service?[{versionId:'z',originalSha256:'a'.repeat(64),path:'__MACOSX/._drawing',mediaType:'application/octet-stream',hasReaderJob:false}]:[])]};
    if (/SELECT DISTINCT ON \(m.version_id\)/.test(sql)) return {rows:[{version_id:'v',total:1,next_ordinal:1}]};
    if (/FROM project_memory_blocks b JOIN project_memory_lines/.test(sql)) return {rows:[{versionId:'v',unitId:'page-1',lineId:'line-1',text:'Высота 37 мм',address:{locator:{page:1}}}]};
    throw Error('unexpected query');
  }};
  return {connect:async()=>client,query:async()=>({rowCount:published?1:0}),setPublished(){published=true;}};
}
const result={rows:[{key:'1',status:'present',finding:'37 мм',citations:[{id:'L1',quote:'37 мм'}]}],draftText:'Предварительный обзор'};
const statePath=(dir,s)=>join(dir,`r-${createHash('sha256').update(JSON.stringify({projectId:s.projectId,receiptId:s.receiptId,catalogVersionId:s.catalogVersionId,stage:s.stage,inventory:s.inventory})).digest('hex')}.json`);
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
    assert.equal(await processReceipt({db,receiptId:'r',stateDir:dir,modelCall:()=>{called=true;}}),'unknown');
    assert.equal(called,false); assert.equal(JSON.parse(await readFile(path)).state,'sending');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('response replay after failed publish does not call model',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-')); const db=fakeDb(); const snapshot=await readSnapshot(db,'r');
  try { await writeFile(statePath(dir,snapshot),JSON.stringify({state:'responded',snapshot,result})); let calls=0, publishes=0;
    const opt={db,receiptId:'r',stateDir:dir,modelCall:()=>calls++,publish:async()=>{if(!publishes++) throw Error('offline');}};
    await assert.rejects(processReceipt(opt),/offline/); assert.equal(await processReceipt(opt),'published'); assert.equal(calls,0); assert.equal(publishes,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('changed inventory gets a new fingerprint; service file limitation is explicit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prelim-')); const db=fakeDb(); const snap=await readSnapshot(db,'r');
  try { await claim(statePath(dir,snap),snap); const changed=fakeDb({service:true}); let calls=0,saved;
    assert.equal(await processReceipt({db:changed,receiptId:'r',stateDir:dir,modelCall:async()=>{calls++;return result;},publish:async(_db,input)=>{saved=input;}}),'published');
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
