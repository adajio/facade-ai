import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawingBatchReasons } from '../infra/local-terra/drawing-batches.mjs';
import { queueReassessment, queuedReasons, runReassessment } from '../infra/local-terra/reassessment.mjs';

import { groupDrawingPhrases } from '../infra/local-terra/drawing-reading.mjs';
import { preparePromptSnapshot, makeRequest, validate } from '../infra/local-terra/producer.mjs';
import { ModelTransportError, remainingRequestBytes } from '../infra/local-terra/request-budget.mjs';
import { attachReadingSkills } from '../infra/local-terra/sheet-review.mjs';
import { terraRequestKind } from '../infra/local-terra/transport/production.mjs';

const require=createRequire(import.meta.url);
const {PNG}=require('pngjs');
const uuid=n=>`9d66e74c-21a0-4342-90ac-${String(n).padStart(12,'0')}`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function png(draw) {
  const image=new PNG({width:240,height:170});
  image.data.fill(255);
  if (draw) for (let y=15;y<155;y++) for (let x=12;x<228;x++) {
    if (x%23 && y%15) continue;
    image.data[(y*image.width+x)*4]=42;
    image.data[(y*image.width+x)*4+1]=48;
    image.data[(y*image.width+x)*4+2]=56;
  }
  return PNG.sync.write(image);
}

function glyph(id,text,x,y,layer='notes') {
  return {id,text,locator:{derivativeHandle:id},drawingBounds:{x,y,width:6.9,height:10},details:{layer}};
}

test('CAD glyph groups keep coordinate order and exact underlying literals',()=>{
  const literal=[...'Фасад'].map((value,index)=>glyph(String(index+20),value,index*6.9,20));
  const groups=groupDrawingPhrases([glyph('FF','X',3,21,'axes'),glyph('AB','A',215,20),...literal.reverse()]);
  assert.deepEqual(groups.map(group=>[group.display,group.parts.map(part=>part.line.id)]),[
    ['Фасад',['20','21','22','23','24']],
  ]);
});

test('a native space joins adjacent words but cannot bridge columns, lines or a formatting break',()=>{
  const entity=(id,text,x,y,width)=>({...glyph(id,text,x,y),drawingBounds:{x,y,width,height:10}});
  const first=entity('A','Архитектурные',0,20,80.6);
  const space=entity('B','\\fCAD; ',89.3,20,223.2);
  const last=entity('C','решения',92.4,20,43.4);
  const catalog=text=>text==='Архитектурные решения' ? ['doc.architecture'] : [];
  const [phrase]=groupDrawingPhrases([last,space,first],catalog);
  assert.equal(phrase.display,'Архитектурные решения');
  assert.deepEqual(phrase.catalogKeys,['doc.architecture']);
  assert.deepEqual(phrase.parts.map(({handle})=>handle),['A','B','C']);
  for (const lines of [[first,entity('B',' ',89.3,20,223.2),entity('C','решения',112,20,43.4)],
      [first,space,entity('C','решения',92.4,35,43.4)],[first,entity('B','\\P',89.3,20,223.2),last]]) {
    assert.equal(groupDrawingPhrases(lines,catalog).some(candidate=>candidate.catalogKeys.length),false);
  }
});

function syntheticDrawings({missingIndex=false,mismatch=false,stampTitle=false}={}) {
  const files=Array.from({length:11},(_,index)=>({versionId:uuid(20+index),documentId:uuid(40+index),
    originalSha256:sha(`synthetic-dwg-${index}`),format:'dwg',path:`drawing-${index}.dwg`}));
  const source={projectId:uuid(1),receiptId:uuid(2),preparationId:uuid(3),catalogVersionId:uuid(4),stage:'Стадия 1',
    scopeNote:'Синтетический пакет',files,inventory:files.map(({versionId,originalSha256})=>({versionId,originalSha256})),lines:[],totalLines:22,
    requirements:[{key:'facades',part:'Фасады'},...(stampTitle ? [{key:'doc.architecture',part:'Раздел АР',
      aliases:['Архитектурные решения','Лист']}] : [])],indexCursor:files.map(file=>({versionId:file.versionId,readerVersion:'dwg-fixture-v1',
      contract:3,processedUnits:3}))};
  const frame={width:240,height:170};
  const unit=(id,space)=>({id,label:id,...frame,locator:{coverage:'partial',space,candidateCount:5,entityCount:125,
    derivativeSha256:sha('derivative'),partSha256:sha(id),converterIdentity:'sha256:'+sha('converter'),derivativeFormat:'dxf'}});
  const maps=files.map(file=>({...file,readerVersion:'dwg-fixture-v1',mapFingerprint:sha(file.versionId),
    units:[unit('PL1','Paper'),unit('M1','Model')]}));
  const byVersion=new Map(maps.map(map=>[map.versionId,map]));
  const text=new Map([['B1','Условные обозначения'],['B2','Лист 1'],['B3','Плитка'],['B4','под'],['B5','кирпич']]);
  const geometry=[{x:176,y:-9,width:100,height:10},{x:176,y:39,width:36,height:10},
    {x:176,y:83,width:33,height:10},{x:212,y:83,width:16.5,height:10},{x:231,y:83,width:33,height:10}];
  if (stampTitle) {
    for (const [id,value] of [['C1','Архитектурные'],['C2',' '],['C3','решения'],['C4','Наружная облицовка см. раздел АР']]) text.set(id,value);
    for (const [x,width] of [[134,80.6],[223.3,223.2],[226.4,43.4]]) geometry.push({x,y:107,width,height:10});
    geometry.push({x:134,y:121,width:149,height:6});
  }
  const db={async query(sql,params){
    if (sql.startsWith('SELECT DISTINCT')) {
      assert.deepEqual(params.slice(0,3),[source.projectId,source.receiptId,source.preparationId]);
      assert.match(sql,/hm.active/u);
      return {rows:maps.filter(map=>params[3].includes(map.versionId))};
    }
    assert.match(sql,/JOIN project_memory_lines/u);
    return {rows:missingIndex ? [] : JSON.parse(params[3]).map(target=>({...target,blockId:'block:'+target.unitId,blockOrdinal:0,ordinal:0,
      readerVersion:'dwg-fixture-v1',text:mismatch && target.lineId==='B5' ? 'гранит' : text.get(target.lineId),
      address:{unitId:target.unitId,locator:{derivativeHandle:target.lineId}}}))};
  }};
  const blank=png(false), graphic=png(true);
  const images=new Map();
  const reader={async previewDwg(pin,input){
    assert.equal(pin.projectId,source.projectId);
    const map=byVersion.get(pin.versionId);
    assert.equal(pin.documentId,map.documentId);
    assert.equal(input.readerVersion,map.readerVersion);
    const {address,representation}=input;
    if (representation==='native') return {address:{...address,locator:map.units.find(unit=>unit.id===address.unitId).locator},
      drawingFrame:{x:100,y:-40,...frame},lines:[...text].map(([id,value],i)=>({
        id,text:value,locator:{derivativeHandle:id},drawingBounds:geometry[i],details:{layer:'titles'},
      }))};
    const box=address.locator ? {x:8,y:8,width:210,height:140} : address.box ?? {x:0,y:0,...frame};
    const bytes=pin.versionId===files[3].versionId && address.unitId==='PL1' ? blank : graphic;
    return {address:{...address,box},mediaType:'image/png',bytes,transform:{...frame,pixelOriginX:0,pixelOriginY:0,pixelsPerPoint:1},limitations:[]};
  },async storeSheetPreview(image,bytes,digest){
    assert.equal(sha(bytes),digest);
    assert.equal(image.originalSha256,byVersion.get(image.versionId).originalSha256);
    images.set(image.id,{...image.address,versionId:image.versionId});
  }};
  return {source,files,db,reader,images,frame};
}
test('ordinary primary request retains all eleven DWG overviews, their addressable details and indexed text',async()=>{
  const {source,db,reader,images,frame}=syntheticDrawings();
  const build=async()=>preparePromptSnapshot({...(await attachReadingSkills(db,reader,'unused',source)),reviewContract:2});
  const prepared=await build();
  const request=makeRequest(prepared);
  const prompt=JSON.parse(request.messages[1].content[0].text);
  assert.equal(terraRequestKind(request),'review');
  assert.ok(remainingRequestBytes(prepared.budget)>=0);
  assert.equal(prepared.budget.visualFiles,11);
  assert.equal(prepared.budget.evidenceFiles,11);
  assert.equal(prompt.drawingCoverage.length,11);
  assert.ok(prompt.drawingCoverage.every(row=>row[3].length===1 && row[4].length>=1));
  assert.ok(prompt.drawingLimits.includes('dwg_model_fallback'));
  assert.equal(prompt.sheetImages.filter(image=>image[1]==='drawing_sheet').length,10);
  assert.equal(prompt.sheetImages.filter(image=>image[1]==='drawing_model').length,1);
  assert.equal(prompt.sheetImages.filter(image=>image[1]==='title_block').length,11);
  const inscriptions=prompt.lines.filter(row=>row[0].startsWith('P'));
  assert.equal(new Set(inscriptions.map(row=>row[1])).size,11);
  assert.ok(inscriptions.some(row=>row[3]==='Плитка под кирпич'));
  assert.ok(inscriptions.some(row=>row[3]==='Условные обозначения'));
  assert.equal(prepared.drawingTextVersion,2);
  const parts=request.messages[1].content.slice(1);
  assert.ok(parts.length<prompt.sheetImages.length);
  assert.ok(prompt.sheetImages.some(panel=>panel[1]==='legend' && images.get(panel[0]).box.width<frame.width));
  assert.ok(prompt.sheetImages.every(panel=>panel[4]>=1 && panel[4]<=parts.length && images.has(panel[0])));
  assert.ok(prepared.sheetReading.drawings.every(drawing=>drawing.phrases.some(phrase=>phrase.indexedParts.some(part=>
    /^D[a-f0-9]{24}$/u.test(part.id) && JSON.parse(part.anchor).readerVersion==='dwg-fixture-v1'))));
  assert.equal(prepared.factScopeVersion,1);
  assert.deepEqual(makeRequest(await build()),request);
});

test('overflow resumes through independently journaled DWG batches and keeps the partial publication at a limit',async t=>{
  const {source,files,db,reader,images}=syntheticDrawings();
  const withSkills=snapshot=>attachReadingSkills(db,reader,'unused',snapshot);
  const reading={...await withSkills(source),reviewContract:2};
  let primary;
  for (let limit=13000;limit<=28000;limit+=200) {
    const candidate=preparePromptSnapshot({...reading,requestLimitBytes:limit});
    if (remainingRequestBytes(candidate.budget)>=0 && candidate.budget.visualFiles>=2 && drawingBatchReasons(candidate).length>=2) {
      primary=candidate;
      break;
    }
  }
  assert.ok(primary,'a valid primary request with at least two overflow batches');
  const stateDir=await mkdtemp(join(tmpdir(),'drawing-batches-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const tickets=drawingBatchReasons(primary);
  for (const reason of tickets) await queueReassessment(stateDir,source,reason);
  assert.deepEqual(await queuedReasons(stateDir,source),tickets);
  const previousSource={...source.inventory[0],anchor:'plan:1',quote:'План закреплённого фасада'};
  const analysis={applicability:{kind:'undetermined',reason:'Требуется сверка.',sources:[]},properties:[],tensions:[]};
  const previousRow={key:'facades',status:'partial',finding:previousSource.quote,sources:[previousSource],analysis};
  let report={...source,reportId:'initial',scopeNote:primary.scopeNote,rows:[previousRow]};
  const ctl={async connect(){
    return {release(){},async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK|^DECLARE|^CLOSE|^FETCH|^WITH sequenced|^SELECT id,parent_occurrence_id/u.test(sql)) return {rows:[]};
      if (sql.includes('p.catalog_version_id, p.project_stage')) return {rows:[{id:source.receiptId,project_id:source.projectId,
        catalog_version_id:source.catalogVersionId,project_stage:source.stage,requirements:source.requirements,ready:true,
        preparation_id:source.preparationId,manifest:{counts:{available:files.length},restrictions:[],
          items:files.map(file=>({...file,kind:'document',state:'available',readerVersion:'dwg-fixture-v1'}))}}]};
      if (sql.includes('bool_or(o.restriction')) return {rows:files};
      if (sql.includes('SELECT DISTINCT ON (m.version_id)')) return {rows:files.map(file=>({
        version_id:file.versionId,reader_version:'dwg-fixture-v1',contract:3,total:3,next_ordinal:3,
      }))};
      throw Error('unexpected snapshot query');
    }};
  },async query(sql) {
    if (sql.includes('revision_key=$3')) return {rowCount:0};
    if (sql.includes('AS "reportId"')) return {rows:[report]};
    throw Error('unexpected report query');
  }};
  const orders=[], activity=[], published=[];
  let limit=true;
  const run={db:ctl,stateDir,withSkills,recordActivity:async(_db,event)=>activity.push(event),
    admitClaim:async(_snapshot,reserve)=>await reserve() ? 'claimed' : 'held',
    modelCall:async request=>{
      if (limit) throw new ModelTransportError('rejected','mac_terra_budget_exhausted');
      const prompt=JSON.parse(request.messages[1].content[0].text);
      orders.push([...new Set(prompt.sheetImages.filter(image=>image[1].startsWith('drawing_')).map(image=>images.get(image[0]).versionId))]);
      return {rows:[{key:'facades',status:'unassessed',finding:'Требуется сверка этого источника.',citations:[],
        analysis:{applicability:{kind:'undetermined',reason:'Требуется сверка.',citations:[]},properties:[],tensions:[]}}]};
    },
    async publish(_db,input){
      const id='batch-'+(published.length+1);
      assert.equal(input.previousReportId,report.reportId);
      assert.equal(input.rows[0].status,'partial');
      assert.deepEqual(input.rows[0].sources,[previousSource]);
      published.push(input.revisionKey);
      report={...report,...input,reportId:id};
      return {id};
    }};
  assert.equal(await runReassessment(run,source,tickets[0]),'waiting');
  assert.equal(activity.at(-1).reason,'mac_terra_budget_exhausted');
  assert.equal(report.reportId,'initial');
  limit=false;
  for (const reason of tickets) assert.equal(await runReassessment(run,source,reason),'published');
  const expected=tickets.flatMap(reason=>reason.slice('drawing_batch:'.length).split(',')).sort();
  assert.deepEqual(orders.flat().sort(),expected);
  assert.equal(new Set(published).size,tickets.length);
  assert.equal(await runReassessment(run,source,tickets[0]),'published');
  assert.equal(orders.length,tickets.length);
  assert.match(report.scopeNote,/Дополнительная партия DWG/u);
});

test('a reconstructed material annotation is citable before indexing and cannot assign a zone',async()=>{
  const {source,db,reader}=syntheticDrawings({missingIndex:true});
  const evidence=await attachReadingSkills(db,reader,'unused',source);
  const snapshot=preparePromptSnapshot({...evidence,reviewContract:2});
  const line=snapshot.lines.find(line=>line.text==='Плитка под кирпич');
  assert.match(line.id,/^P[a-f0-9]{24}$/u);
  assert.equal(line.indexChecked,false);
  const anchor=JSON.parse(line.anchor);
  assert.equal(anchor.evidenceMode,'literal');
  assert.equal(anchor.address.locator.derivativeSha256,sha('derivative'));
  assert.equal(anchor.address.locator.partSha256,sha(anchor.unitId));
  assert.equal(anchor.address.box.x,76);
  assert.deepEqual(anchor.drawingText.parts,[['B3','B3'],['B4','B4'],['B5','B5']]);
  const citations=[{id:line.id,quote:line.text}];
  const side={element:'Плитка под кирпич'};
  const property={key:'material_label',label:'Подпись материала',status:'confirmed',finding:'Зафиксирована подпись материала.',
    citations,letter:{kind:'omit',text:'Сохранена подпись.'},scope:{kind:'applicable',target:side,observed:side,
      basis:'literal',reason:'Подпись прочитана.',citations}};
  const result={rows:[{key:'facades',status:'present',finding:'Подпись материала найдена.',citations,
    analysis:{applicability:{kind:'included',reason:'Материал указан.',citations:[]},properties:[property],tensions:[]}}]};
  const [row]=validate(snapshot,result).rows;
  assert.equal(row.status,'partial');
  assert.equal(row.analysis.properties[0].scope.basis,'literal');
  assert.equal(row.sources[0].quote,'Плитка под кирпич');
  assert.equal(row.sources[0].anchor,line.anchor);
  property.scope.basis=undefined;
  property.scope.target={...side,zone:'весь фасад'};
  assert.equal(validate(snapshot,result).rows[0].status,'unassessed');
  citations[0].quote='Панель под кирпич';
  assert.throws(()=>validate(snapshot,result),/invalid_citation/u);
});

test('an indexed and native glyph mismatch withholds the reconstructed line',async()=>{
  const {source,db,reader}=syntheticDrawings({mismatch:true});
  const evidence=await attachReadingSkills(db,reader,'unused',source);
  const snapshot=preparePromptSnapshot({...evidence,reviewContract:2});
  assert.ok(snapshot.lines.some(line=>line.text==='Условные обозначения'));
  assert.ok(snapshot.lines.every(line=>line.text!=='Плитка под кирпич'));
});

test('the ordinary request reserves a catalog name ahead of the isolated stamp attribute and keeps stable sources',async()=>{
  const fixture=syntheticDrawings({stampTitle:true});
  const build=async requirements=>preparePromptSnapshot({...(await attachReadingSkills(fixture.db,fixture.reader,'unused',
    {...fixture.source,requirements})),reviewContract:2});
  const selected=await build(fixture.source.requirements);
  const query=makeRequest(selected);
  const prompt=JSON.parse(query.messages[1].content[0].text);
  const named=prompt.lines.find(row=>row[3]==='Архитектурные решения');
  assert.match(named[0],/^P[a-f0-9]{24}$/u);
  const source=selected.lines.find(line=>line.id===named[0]);
  assert.deepEqual(JSON.parse(source.anchor).drawingText.parts,[['C1','C1'],['C2','C2'],['C3','C3']]);
  assert.deepEqual(selected.sheetReading.drawings[0].phrases.find(phrase=>phrase.display.includes('см. раздел АР'))?.catalogKeys,[]);
  assert.ok(prompt.lines.findIndex(row=>row[0]===named[0]) < prompt.lines.findIndex(row=>row[3]==='Плитка под кирпич'));
  const prior=await build(fixture.source.requirements.slice(0,1));
  const material=prior.lines.find(line=>line.text==='Плитка под кирпич');
  assert.equal(selected.lines.find(line=>line.id===material.id)?.anchor,material.anchor);
  assert.equal(selected.drawingTextVersion,2);
});
