import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processReceipt,reconcilePreliminaryReview,recoverPreparationFindings} from '../infra/local-terra/producer.mjs';
import {checkAnalysis,renderQuestions} from '../infra/local-terra/review-analysis.mjs';

const sha = 'a'.repeat(64);
const source = {versionId:'v1',originalSha256:sha,anchor:'страница 1, строка 2',quote:'План подвала М1:100'};
const other = {...source,versionId:'v2',anchor:'пространство Model, handle 12'};
const analysis = (properties = [], tensions = [], kind = 'included') => ({
  applicability:{kind,reason:'По охвату комплекта.',sources:kind==='excluded'?[source]:[]},properties,tensions,
});
const row = (key, overrides) => ({key,title:key,status:'unassessed',finding:'Нужна адресная сверка.',sources:[],analysis:analysis(),...overrides});
const confirmed = {key:'drawing_scale',label:'Масштаб чертежа',status:'confirmed',finding:'Указан масштаб 1:100.',
  sources:[source],letter:{kind:'omit',text:'Масштаб указан.'}};
const question = {key:'coverage',label:'Охват секций',status:'insufficient',finding:'Нужно уточнение.',
  sources:[source],letter:{kind:'ask',text:'Уточните состав чертежей.'}};
const old = row('plan',{status:'partial',finding:'Найден план подвала; план кровли не найден.',
  sources:[source],analysis:analysis([confirmed,{...question,key:'old_question',letter:{kind:'ask',text:'Старый вопрос.'}}])});
const target = (rows, inventory = [{versionId:'v2',originalSha256:sha},{versionId:'v1',originalSha256:sha}]) => ({
  projectId:'p',receiptId:'r',preparationId:'m2',catalogVersionId:'c',stage:'RD',inventory,rows,draftText:renderQuestions(rows),
});

test('preserves previous wording and confirmed properties with their exact citations and keeps fresh questions', async () => {
  const input = target([row('plan',{analysis:analysis([question])})]);
  const db = {async query(sql,args) {
    assert.match(sql,/prep\.revision<current\.revision/);
    assert.match(sql,/prep\.receipt_id=current\.receipt_id/);
    assert.match(sql,/now\.map_fingerprint=before\.map_fingerprint/);
    assert.match(sql,/FROM prior_report WHERE prior_report\.catalog_version_id=\$4 AND prior_report\.stage=\$5 AND prior_report\.inventory=\$6/);
    assert.deepEqual(args.slice(0,5),['p','r','m2','c','RD']);
    assert.deepEqual(JSON.parse(args[5]).map(item=>item.versionId),['v1','v2']);
    return {rows:[{rows:[old],admittedVersions:['v1','v2']}]};
  }};
  const output = await recoverPreparationFindings(db,input);
  const [saved] = output.rows;
  assert.equal(saved.status,input.rows[0].status);
  assert.equal(saved.finding,input.rows[0].finding);
  assert.deepEqual(saved.sources,input.rows[0].sources);
  assert.deepEqual(saved.retained,{status:'partial',finding:old.finding,sources:[source]});
  assert.deepEqual(saved.analysis.properties,[question,confirmed]);
  checkAnalysis(saved.analysis,(valid,reason)=>assert.ok(valid,reason));
  assert.equal(output.draftText,input.draftText);
  assert.strictEqual(await recoverPreparationFindings(db,output),output);
});

test('mentions of anchor brands never replace the current limitation on applicability and load tests', async () => {
  const anchorSource = {...source,quote:'4 - Анкер R-HPTII-ZF-10080/20\n5 - Распорный анкер HSA М8х105'};
  const previous = row('doc.anchor_tests',{status:'partial',sources:[anchorSource],
    finding:'В чертеже указаны марки анкеров, но их применимость к основанию фасада не установлена; актов испытаний или расчётных усилий с единицами в переданных строках не подтверждено. Оставшиеся записи и графика не проверены.'});
  const fresh = row('doc.anchor_tests',{
    finding:'Подписанные акты испытаний либо расчётные усилия с единицами для применимого основания не установлены; чтение неполное.',
  });
  const input = target([fresh]);
  const db = {query:async()=>({rows:[{rows:[previous],admittedVersions:['v1']}]})};
  const output = await recoverPreparationFindings(db,input);
  assert.deepEqual(output.rows,[{...fresh,retained:{status:'partial',finding:previous.finding,sources:[anchorSource]}}]);
  assert.equal(output.draftText,input.draftText);
  assert.deepEqual(reconcilePreliminaryReview(input,output.rows).rows,output.rows);
});

test('leaves ineligible evidence and fresh exclusions and contradictions untouched', async () => {
  const conflicting = {...confirmed,status:'conflicting',letter:{kind:'ask',text:'Сверьте действующий масштаб.'}};
  const tension = {key:'scale',propertyKey:conflicting.key,status:'open',finding:'Масштабы расходятся.',
    sides:[{text:'М1:100',sources:[source]},{text:'М1:200',sources:[other]}],resolutionSources:[]};
  const freshAssessment = {...confirmed,key:'scale_new',finding:'Подтверждён масштаб 1:200.',sources:[other]};
  const cases = [
    [row('plan'),{...old,status:'not_found'}],
    [row('plan'),{...old,finding:'На листе отсутствует план.',analysis:analysis([question])}],
    [row('plan'),{...old,sources:[other],analysis:analysis([{...confirmed,sources:[other]}])}],
    [row('plan'),{...old,sources:[{...source,originalSha256:'b'.repeat(64)}],analysis:analysis()}],
    [row('plan'),{...old,sources:[{...source,limitation:'Текст скрыт'}],analysis:analysis()}],
    [row('plan',{analysis:analysis([],[],'excluded')}),old],
    [row('plan',{status:'not_found'}),old],
    [row('plan',{analysis:analysis([conflicting],[tension])}),old],
    [row('plan',{status:'present',finding:'Подтверждён масштаб 1:200.',sources:[other],analysis:analysis([freshAssessment])}),old],
    [row('plan',{analysis:analysis([freshAssessment])}),old],
  ];
  for (const [current,previous] of cases) {
    const input = target([current]);
    const db = {query:async()=>({rows:[{rows:[previous],admittedVersions:['v1']}]})};
    assert.strictEqual(await recoverPreparationFindings(db,input),input);
  }
  const input = target([row('plan')]);
  assert.strictEqual(await recoverPreparationFindings({query:async()=>({rows:[]})},input),input);
  const noStage = {...input,stage:null};
  assert.strictEqual(await recoverPreparationFindings({query:assert.fail},noStage),noStage);
});

test('primary publication of a saved response recovers findings without calling the model', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'terra-preparation-continuity-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const snapshot = {...target([], [{versionId:'v1',originalSha256:sha}]),requirements:[{key:'plan',part:'План'}],
    lines:[],scopeNote:'Текущее покрытие.',reviewContract:2,receiptCreatedAt:'2026-11-26T09:00:00.000Z'};
  const {projectId,receiptId,catalogVersionId,stage,inventory,preparationId} = snapshot;
  const key = createHash('sha256').update(JSON.stringify({projectId,receiptId,catalogVersionId,stage,inventory,preparationId})).digest('hex');
  const result = {rows:[{key:'plan',status:'unassessed',finding:'По текущей выборке нужна сверка.',citations:[],
    analysis:{applicability:{kind:'included',reason:'По охвату комплекта.',citations:[]},properties:[],tensions:[]}}]};
  await writeFile(join(stateDir,`r-${key}.json`),JSON.stringify({state:'responded',snapshot,result}));
  const db = {async query(sql) {
    if (sql.startsWith('SELECT pr.id')) return {rowCount:0,rows:[]};
    if (sql.includes("prep.manifest->'items'")) return {rows:[{...snapshot,items:inventory}]};
    if (sql.startsWith('WITH current AS')) return {rows:[{rows:[old],admittedVersions:['v1']}]};
    assert.fail(sql);
  }};
  let publication;
  const status = await processReceipt({db,receiptId,stateDir,reviewContract:2,modelCall:assert.fail,
    async publish(_db,input) { publication = input; return {id:'new-review'}; }});
  assert.equal(status,'published');
  assert.equal(publication.rows[0].status,'unassessed');
  assert.equal(publication.rows[0].finding,result.rows[0].finding);
  assert.equal(publication.rows[0].retained.finding,old.finding);
  assert.deepEqual(publication.rows[0].retained.sources,[source]);
  assert.deepEqual(publication.rows[0].analysis.properties,[confirmed]);
  assert.equal(publication.draftText,renderQuestions([]));
});
