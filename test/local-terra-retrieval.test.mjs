import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceCollector } from '../infra/local-terra/evidence-retrieval.mjs';
import { contextRelation, readEvidence, referencesIn } from '../infra/local-terra/evidence-retrieval-db.mjs';
import { preparePromptSnapshot } from '../infra/local-terra/producer.mjs';

test('full scan finds late subject evidence and keeps independently addressed property variants', () => {
  const file = {versionId:'design',path:'specification.docx'};
  const collector = createEvidenceCollector([
    {key:'doc.architecture',part:'Архитектурные решения'},
    {key:'data.cladding',part:'Облицовка',evidenceRule:{allOf:[{anyOf:[{subject:'Толщина облицовки'}]}]}},
  ],[file]);
  for (let ordinal=0;ordinal<5002;ordinal++) collector.add({
    blockId:'first-block',versionId:file.versionId,ordinal,folded:'запись без тематического текста',
  });
  const variants = [
    'Утеплитель: 1 слой 31 мм; 2 слой 43 мм.',
    'Утеплитель: 1 слой 31 мм; 2 слой 72 мм.',
    'Утеплитель: 1 слой 31 мм; 2 слой 43 мм.',
    'Облицовка фасадной плиткой толщиной 17 мм.',
  ];
  const latest = variants.map((folded,ordinal)=>({
    blockId:'scoped-part-'+ordinal,versionId:file.versionId,ordinal,folded:folded.toLowerCase(),
  }));
  for (const line of latest) collector.add(line);
  const {totalLines,candidates,requirements} = collector.finish();
  assert.equal(totalLines,5006);
  assert.deepEqual(requirements.map(({key})=>key),['doc.architecture','data.cladding']);
  for (const line of latest) assert.ok(candidates.some(item=>item.blockId===line.blockId && item.ordinal===line.ordinal));
  assert.equal(candidates.filter(item=>item.matches.length===0).length,1);
});

test('context separates physical sheet, table row and CAD reader order', () => {
  const source = (locator, props = {}) => ({
    versionId:'version',readerVersion:'active',blockId:'sheet',lineId:'1.2.3.0',address:{locator},...props,
  });
  assert.equal(contextRelation(source({page:1}),source({page:1},{lineId:'1.2.4.0'})),'pdf_text_block');
  assert.equal(contextRelation(source({page:1}),source({page:2},{lineId:'2.2.3.0'})),undefined);
  assert.equal(contextRelation(source({table:1,row:4}),source({table:1,row:4})),'same_row');
  assert.equal(contextRelation(source({table:1,row:4}),source({table:2,row:4})),undefined);
  assert.equal(contextRelation(source({space:'Model',view:'A'}),source({space:'Model',view:'B'})),undefined);
  assert.equal(contextRelation(source({space:'Model'}),source({space:'Model'})),'reader_order');
  assert.equal(contextRelation(source({space:'Model'}),source({space:'Model'},{readerVersion:'stale'})),undefined);
  assert.deepEqual(referencesIn('См. лист А-8. Координаты на физической странице 6.').map(x=>[x.kind,x.target]),
    [['named_sheet','А-8'],['pdf_page','6']]);
});

test('physical page is target_opened only after returning indexed pinned target, with all prompt ids supplied', async () => {
  const versionId = 'version';
  const scope = [{versionId,readerVersion:'pdf-accepted',contract:2,processedUnits:3}];
  const [file] = [{versionId,path:'drawing.pdf',originalSha256:'a'.repeat(64)}];
  const text = 'Высота 42 мм. См. лист Б-7 и физическую страницу 3.';
  const anchor = {versionId,readerVersion:'pdf-accepted',blockId:'block',blockOrdinal:0,ordinal:0,unitId:'1',
    lineId:'1.1.0.0',text,address:{unitId:'1',locator:{page:1}}};
  const checkScope = args => assert.deepEqual(JSON.parse(args[1]),scope);
  const client = {async query(sql,args){
    if (/^DECLARE preliminary_evidence/.test(sql)) {
      assert.match(sql,/b\.reader_version=s\."readerVersion"[\s\S]*b\.contract=s\.contract AND b\.ordinal<s\."processedUnits"/u);
      checkScope(args);
      return {rows:[]};
    }
    if (/^FETCH/.test(sql)) return {rows:[{versionId,blockId:'block',ordinal:0,folded:text.toLowerCase()}]};
    if (/^CLOSE/.test(sql)) return {rows:[]};
    if (/pins AS/u.test(sql)) {
      checkScope(args);
      return {rows:[{...anchor,position:0},{...anchor,position:0,ordinal:1,lineId:'1.1.1.0',text:'Парапет.'}]};
    }
    if (/requested AS/u.test(sql)) {
      checkScope(args);
      const refs = JSON.parse(args[2]);
      assert.equal(refs.length,2);
      assert.equal(refs[0].kind,'named_sheet');
      assert.equal(refs[1].kind,'pdf_page');
      return {rows:[{...anchor,id:refs[1].id,unitId:'3',blockId:'third-block',blockOrdinal:2,lineId:'3.4.0.0',
        blockAddress:{unitId:'3',locator:{page:3}},address:{unitId:'3',locator:{page:3}},
        text:'Таблица высот',remaining:['graphics']}]};
    }
    throw Error('unexpected_query');
  }};
  const requirements = [{key:'spec.height',part:'Высота'}];
  const evidence = await readEvidence(client,'project',scope,requirements,[file]);
  const [root] = evidence.retrieval.evidence;
  assert.deepEqual(root.refs.map(ref=>ref.status),['reference_candidate','target_opened']);
  assert.equal(root.refs[0].address,undefined);
  assert.equal(root.refs[1].address.unitId,'3');
  assert.deepEqual(root.refs[1].remaining,['graphics']);
  const packed = preparePromptSnapshot({stage:'Проект',requirements,files:[file],...evidence});
  const supplied = new Set(packed.promptData.lines.map(line=>line[0]));
  assert.ok(packed.promptData.context.every(([from,to])=>supplied.has(from) && supplied.has(to)));
  assert.ok(packed.promptData.references.every(([from,,,...rest])=>supplied.has(from) && rest[2].every(id=>supplied.has(id))));
  assert.equal(JSON.parse(evidence.lines.find(line=>line.id===root.refs[1].lines[0]).anchor).unitId,'3');
  assert.ok(packed.budget.requestBytes<=packed.budget.maxRequestBytes);
  assert.ok(packed.budget.estimatedInputTokens<=packed.budget.maxInputTokens);
});

test('small index preserves addressed exclusion text even without catalog vocabulary matches', async () => {
  const file = {versionId:'v',path:'signed-appendix.pdf',originalSha256:'b'.repeat(64)};
  const scope = [{versionId:file.versionId,readerVersion:'pdf',contract:1,processedUnits:1}];
  const requirements = [{key:'glass',part:'Glazing schedule',completenessCriterion:'Verify the delivered set of windows'}];
  const text = ['Issued documents',...Array.from({length:18},(_,index)=>'Item '+index),'not included'];
  const rows = text.map((literal,ordinal)=>({versionId:file.versionId,blockId:'b',ordinal,folded:literal.toLowerCase()}));
  const client = {async query(sql,args){
    if (/^FETCH FORWARD/.test(sql)) return {rows};
    if (/^(DECLARE|CLOSE)/.test(sql)) return {rows:[]};
    if (!/pins AS/.test(sql)) throw Error('unexpected_query');
    return {rows:JSON.parse(args[2]).map(pin=>({...rows[pin.ordinal],...pin,readerVersion:'pdf',blockOrdinal:0,
      unitId:'1',lineId:'address:'+pin.ordinal,address:{unitId:'1',locator:{page:1}},text:text[pin.ordinal]}))};
  }};
  const raw = await readEvidence(client,'project',scope,requirements,[file]);
  const packed = preparePromptSnapshot({stage:'Intake',files:[file],requirements,...raw});
  assert.equal(packed.budget.totalLines,20);
  assert.equal(packed.budget.selectedLines,20);
  assert.equal(packed.budget.remainingLines,0);
  assert.equal(raw.retrieval.evidence.find(item=>item.id===packed.lines.find(line=>line.text==='not included').id).matches.length,0);
  assert.ok(packed.lines.some(line=>line.text==='not included' && JSON.parse(line.anchor).lineId==='address:19'));
});
