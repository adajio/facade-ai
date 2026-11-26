import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveDrawingAlternatives } from '../infra/local-terra/drawing-alternatives.mjs';
import { queueReassessment, reassessmentKey, runReassessment } from '../infra/local-terra/reassessment.mjs';

const scope={projectId:'p',receiptId:'r',catalogVersionId:'c',stage:'stage_1',preparationId:'m'};
test('only an unambiguous prepared sibling PDF is a readable companion',()=>{
  const item=(id,label,state,format)=>({label,state,format,kind:'document',occurrenceId:id,documentId:id,versionId:id,
    originalSha256:'a'.repeat(64),windowIds:state==='available'?['one']:[]});
  const cad=item('a','АР/Корпус 2 изм.3.dwg','unavailable','dwg');
  const pdf=item('b','АР/Корпус 2 изм.3.PDF','available','pdf');
  const other=item('c','АР/Корпус 2 изм.3.pdf','available','pdf');
  const parents=new Map([['a','zip'],['b','zip'],['c','other']]);
  const match=(...items)=>deriveDrawingAlternatives([cad,...items],parents);
  assert.equal(match(pdf,other)[0].availableVersionId,'b');
  assert.deepEqual(match({...pdf,label:'АР/Корпус 2 изм.2.pdf'},other),[]);
  assert.deepEqual(match({...pdf,windowIds:[]},other),[]);
  assert.deepEqual(match({...pdf,label:'АР/Корпус 2 изм.3.bak'},other),[]);
  parents.set('c','zip');
  assert.deepEqual(match(pdf,other),[]);
});
test('reassessment tickets are scoped, idempotent and never redispatch an uncertain call',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'addressed-review-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const reason='operator';
  const [key,duplicate]=await Promise.all([queueReassessment(stateDir,scope,reason),queueReassessment(stateDir,scope,reason)]);
  assert.equal(key,duplicate);
  assert.notEqual(key,reassessmentKey({...scope,preparationId:'other'},reason));
  assert.notEqual(key,reassessmentKey(scope,'index_complete'));
  const path=join(stateDir,'addressed','r',key+'.json');
  const run={stateDir,modelCall:assert.fail,admitClaim:assert.fail,publish:assert.fail,db:{query:async()=>({rowCount:0})}};
  for (const state of ['sending','unknown','rejected']) {
    await writeFile(path,JSON.stringify({state}));
    assert.equal(await runReassessment(run,scope,reason),state==='sending'?'unknown':state);
  }
  assert.equal(await runReassessment(run,{...scope,preparationId:'other'},reason),'idle');
  run.db.query=async()=>({rowCount:1,rows:[{id:'saved'}]});
  assert.equal(await runReassessment(run,scope,reason),'published');
  assert.equal(JSON.parse(await readFile(path)).reviewId,'saved');
  assert.equal(await runReassessment({...run,db:{query:assert.fail}},scope,reason),'published');
});
test('a completion ticket waits while a prepared source lacks the complete pinned index',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'addressed-index-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  await queueReassessment(stateDir,scope,'index_complete');
  const run={stateDir,modelCall:assert.fail,admitClaim:assert.fail,publish:assert.fail,db:{query:async sql =>
    sql.includes('revision_key') ? {rowCount:0} : {rows:[{complete:false}]} }};
  assert.equal(await runReassessment(run,scope,'index_complete'),'waiting');
});

test('a citation with escaped tabs round-trips to literal bytes; a fabricated claim is withheld independently',async()=>{
  const {validatedPartial}=await import('../infra/local-terra/partial-result.mjs');
  const catalog=[{key:'scope.one',part:'Вид'},{key:'scope.two',part:'Прочее'}];
  const snapshot={reviewContract:2,requirements:catalog,lines:[{id:'L1',versionId:'v',originalSha256:'s',anchor:'sheet:1',text:'Вид\n1.\tФасад'}],scopeNote:'Обзор.'};
  const analysis={applicability:{kind:'undetermined',reason:'Область требует сверки',citations:[]},properties:[],tensions:[]};
  const rows=catalog.map((req,index)=>({key:req.key,status:'partial',finding:'Вид в документе',analysis,
    citations:[{id:'L1',quote:index?'Фасад вымышленного корпуса':'Вид\\n1.\\tФасад'}]}));
  const input=validatedPartial(snapshot,{rows});
  assert.equal(input.rows[0].sources[0].quote,snapshot.lines[0].text);
  assert.equal(input.rows[1].status,'unassessed');
  assert.equal(input.rows[1].sources.length,0);
  assert.match(input.scopeNote,/scope.two/);
  assert.doesNotMatch(input.draftText,/вымышленного/);
  assert.throws(()=>validatedPartial(snapshot,{rows:[]}));
});

test('a newly indexed source triggers only its addressed requirements and preserves surrounding evidence',async()=>{
  const {selectReassessment}=await import('../infra/local-terra/reassessment.mjs');
  const requirements=[{key:'doc.alpha',part:'Проём'},{key:'doc.beta',part:'Скат'}];
  const source={requirements,scopeNote:'Опись.',indexCursor:[
    {versionId:'v1',contract:2,processedUnits:8},{versionId:'v2',contract:2,processedUnits:4}],
    lines:[{id:'L1',versionId:'v1'},{id:'L2',versionId:'v2'},{id:'L3',versionId:'v1'}],
    retrieval:{evidence:[
      {id:'L1',matches:[{key:'doc.alpha',rank:0}],neighbours:[{id:'L3'}],refs:[]},
      {id:'L2',matches:[{key:'doc.beta',rank:1}],neighbours:[],refs:[]},
    ]}};
  const old=[{...source.indexCursor[0],processedUnits:2},source.indexCursor[1]];
  const selected=selectReassessment(source,{rows:requirements},{reason:'index_complete',indexCursor:old});
  assert.deepEqual(selected.requirements,[requirements[0]]);
  assert.deepEqual(selected.lines.map(line=>line.id),['L1','L3']);
  assert.deepEqual(selectReassessment(source,{rows:requirements},{reason:'requirements:doc.beta'}).requirements,[requirements[1]]);
});

test('explicit material layers use millimetres and keep separate design zones and versions',async()=>{
  const {includeLayerEvidence,layerComposition}=await import('../infra/local-terra/layer-composition.mjs');
  const make=(id,v,txt)=>({id,versionId:v,originalSha256:v,anchor:'page-3',text:txt});
  const a=make('A','v1','Теплоизоляция 90 мм: 1 слой 30 мм; 2 слой 50 мм.');
  const b=make('B','v2','Выше отметки 400 мм теплоизоляция 90 мм: 1 слой 40 мм; 2 слой 50 мм.');
  assert.equal(layerComposition('1 слой 10 мм; 2 слой 30 мм'),undefined);
  assert.equal(layerComposition('Утеплитель 90 мм: 1 слой 30–40 мм; 2 слой 50 мм'),undefined);
  assert.equal(layerComposition('Утеплитель 90 мм: 1 слой 30 мм; 2 слой 0,05 м'),undefined);
  const row={key:'data.cladding',status:'partial',sources:[],analysis:{applicability:{kind:'included'},properties:[]}};
  const [updated]=includeLayerEvidence({lines:[a,b],promptData:{evidence:[['A',[row.key]],['B',[row.key]]]}},{rows:[row]});
  const property=updated.analysis.properties[0];
  assert.deepEqual(property.sources.map(source=>source.versionId),['v1','v2']);
  assert.equal(property.letter.kind,'omit');
  assert.match(property.finding,/30 \+ 50 = 80 мм/);
  assert.match(property.finding,/40 \+ 50 = 90 мм/);
});

test('newly readable unfamiliar terms reach still-open catalog rows after partial publication',async()=>{
  const {selectReassessment}=await import('../infra/local-terra/reassessment.mjs');
  const requirements=[{key:'a',part:'Фасады'},{key:'b',part:'СПК'}];
  const raw={requirements,scopeNote:'',indexCursor:[{versionId:'v',contract:1,processedUnits:1}],
    lines:[{id:'L99',versionId:'v'}],retrieval:{evidence:[{id:'L99',matches:[],neighbours:[],refs:[]}]}};
  const selected=selectReassessment(raw,{rows:[{key:'a',status:'present'},{key:'b',status:'unassessed'}]},{reason:'index_complete',indexCursor:[]});
  assert.deepEqual(selected.requirements,[requirements[1]]);
  assert.equal(selected.lines[0].id,'L99');
});

test('an unknown addressed attempt holds other paid requests under the same scope lock',async t=>{
  const {admitRecordedClaim}=await import('../infra/local-terra/review-admission.mjs');
  const stateDir=await mkdtemp(join(tmpdir(),'unknown-addressed-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const key=await queueReassessment(stateDir,scope,'operator');
  await writeFile(join(stateDir,'addressed','r',key+'.json'),JSON.stringify({state:'unknown',snapshot:scope}));
  const locked=async(_s,reserve)=>(await reserve())?'claimed':'held';
  assert.equal(await admitRecordedClaim(locked,stateDir,scope,assert.fail),'held_scope_outcome_unknown');
  assert.equal(await admitRecordedClaim(locked,stateDir,{...scope,preparationId:'new'},async()=>true),'claimed');
});
test('grouped thousands in engineering quantities preserve the complete value',async()=>{
  const {layerComposition}=await import('../infra/local-terra/layer-composition.mjs');
  for (const space of [' ','\u00a0','\u202f']) {
    const result=layerComposition('Теплоизоляция 1'+space+'200 мм: 1 слой 900 мм; 2 слой 300 мм.');
    assert.equal(result.stated,1200);assert.equal(result.sum,1200);
  }
});

test('rebase admits only unaffected target rows',async()=>{
  const {sameTargetRows}=await import('../infra/local-terra/reassessment.mjs');
  const a={key:'a',finding:'изначально'},b={key:'b',finding:'сверить крепёж'};
  const revised=[{...a,finding:'изменено'},b];
  assert.equal(sameTargetRows([a],[a,b],revised),false);
  assert.equal(sameTargetRows([b],[a,b],revised),true);
  assert.equal(sameTargetRows([a],undefined,revised),false);
});

test('an interrupted legacy ticket is repaired without losing a neighbouring ticket',async t=>{
  const {queuedReasons}=await import('../infra/local-terra/reassessment.mjs');
  const stateDir=await mkdtemp(join(tmpdir(),'repair-ticket-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const key=await queueReassessment(stateDir,scope,'operator');
  const path=join(stateDir,'addressed','r',key+'.ticket');
  await writeFile(path,'');
  await queueReassessment(stateDir,scope,'index_complete');
  assert.deepEqual(await queuedReasons(stateDir,scope),['index_complete']);
  assert.equal(await queueReassessment(stateDir,scope,'operator'),key);
  assert.deepEqual((await queuedReasons(stateDir,scope)).sort(),['index_complete','operator']);
});

test('narrow review keeps distinct unanswered properties and uses the newer wording for the same addressed gap',async()=>{
  const {mergeSelection}=await import('../infra/local-terra/reassessment.mjs');
  const src={versionId:'v',originalSha256:'sum',anchor:'page-7',quote:'Секция с прозрачной вставкой'};
  const req=(key,label,finding)=>({key,label,status:'insufficient',sources:[src],finding,letter:{kind:'ask',text:'Уточните '+label}});
  const original=req('prior','Декоративные модули ограждения','Имеется чертёж; толщина и высота в доступном описании не определены.');
  const current=req('next','Модули на ограждениях','Имеется схема; толщина и высота в приведённой строке не указаны.');
  const independent=req('edge','Край ограждения','Зона в доступном описании не указана.');
  const row={key:'a',title:'Схема',status:'partial',finding:'См. схему',sources:[src],
    analysis:{applicability:{kind:'included',sources:[src]},tensions:[],properties:[current]}};
  const previous={...row,analysis:{...row.analysis,properties:[original,independent]}};
  const result=mergeSelection({inventory:[src],rows:[row]},[previous]);
  assert.deepEqual(result.rows[0].analysis.properties.map(p=>p.key),['next','edge']);
});
