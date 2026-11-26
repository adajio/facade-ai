import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { makeRequest, preparePromptSnapshot, reconcilePreliminaryReview, validate } from '../infra/local-terra/producer.mjs';
import { applyRevision, prepareRevisionSnapshot } from '../infra/local-terra/revise.mjs';
import { remainingRequestBytes } from '../infra/local-terra/request-budget.mjs';

const catalog = JSON.parse(await readFile(new URL('../infra/catalogs/intake-stage-1.json', import.meta.url)));
const originalSha256 = 'a'.repeat(64);
const lines = [
  ['L1','first','Размер панели 540 мм'],
  ['L2','second','Размер панели 620 мм'],
  ['L3','first','Требуется указать толщину цинкового покрытия'],
  ['L4','second','Материал панели — сталь'],
  ['L5','first','Ответ заказчика на запрос №7 о покрытии к дате сверки не получен'],
  ['L6','second','Ответ заказчика на запрос №8: цвет RAL 7035'],
  ['L7','second','Крепления этого участка выполняются к стальной раме; КЖ в область заказа не входит'],
].map(([id,versionId,text],index) => ({id,versionId,originalSha256,text,
  anchor:JSON.stringify({unitId:'page-1',lineId:String(index+1),address:{unitId:'page-1',locator:{page:1}}})}));
const citations = (...ids) => ids.map(index => ({id:lines[index].id,quote:lines[index].text}));
const inventory = ['first','second'].map(versionId => ({versionId,originalSha256}));
const files = inventory.map(item => ({...item,path:item.versionId + '.pdf'}));
const scope = {reviewContract:2,projectId:'project',receiptId:'receipt',catalogVersionId:'catalog',stage:'Стадия 1',
  inventory, files, requirements:catalog.requirements, lines, scopeNote:'Чтение доступных строк.'};

const omit = text => ({kind:'omit',text});
const ask = text => ({kind:'ask',text});
const applicable = {kind:'included',reason:'В документах названа панель.',citations:citations(0)};
const material = {key:'material',label:'Материал панели',status:'confirmed',finding:'Предусмотрена сталь.',
  citations:citations(3),letter:omit('Материал установлен.')};
const size = {key:'size',label:'Размер панели',status:'conflicting',finding:'Указаны 540 и 620 мм.',
  citations:[],letter:ask('Какой размер применять для этой панели — 540 или 620 мм?')};
const coating = {key:'coating',label:'Толщина покрытия',status:'unanswered',finding:'В листе запрошена толщина.',
  citations:citations(2),letter:ask('Укажите толщину цинкового покрытия этой панели.')};
const sideA = {text:'На первом листе 540 мм.',citations:citations(0)};
const sideB = {text:'На втором листе 620 мм.',citations:citations(1)};
const tension = {key:'size-discrepancy',propertyKey:'size',status:'open',finding:'Разные размеры одной панели.',
  sides:[sideA,sideB],resolutionCitations:[]};
const result = {rows:catalog.requirements.map(({key},index) => ({key,status:index < 3 ? 'partial' : 'unassessed',
  finding:index < 3 ? 'В области требования найдены адресные сведения.' : 'Чтение этой области ограничено.',
  citations:index < 3 ? citations(index) : [],
  analysis:index < 3 ? {applicability:applicable,properties:[[material,size],[coating],[{
    key:'gloss',label:'Блеск покрытия',status:'not_mentioned',finding:'Параметр не упомянут в прочитанных строках.',
    citations:[],letter:omit('Отдельный вопрос по этому параметру не обоснован.'),
  }]][index],tensions:index === 0 ? [tension] : []} : {
    applicability:{kind:'undetermined',reason:'Прямых сведений в доступных строках нет.',citations:[]},
    properties:[],tensions:[],
  },
}))};

test('the actual 16-position catalog keeps structured questions and both original addresses', () => {
  const prepared = preparePromptSnapshot(scope);
  const request = makeRequest(prepared);
  const schema = request.tools[0].function.parameters;
  assert.equal(schema.properties.rows.minItems,16);
  assert.equal(schema.properties.rows.maxItems,16);
  assert.ok(schema.properties.rows.items.required.includes('analysis'));
  assert.ok(remainingRequestBytes(prepared.budget) >= 0);
  assert.ok(JSON.stringify(result).length < 55_000);
  const review = validate(prepared,{...result,draftText:'Просим повторно предоставить весь комплект.'});
  assert.equal(review.rows.length,16);
  assert.equal(review.rows[1].analysis.properties[0].status,'unanswered');
  assert.equal(review.rows[2].analysis.properties[0].status,'not_mentioned');
  assert.deepEqual(review.rows[0].analysis.tensions[0].sides.map(side => side.sources[0].versionId),['first','second']);
  assert.match(review.draftText,/Какой размер применять/);
  assert.match(review.draftText,/Укажите толщину цинкового покрытия/);
  assert.doesNotMatch(review.draftText,/Блеск|Материал панели|повторно/);
});

test('exclusion, fabricated quotes and the two sides of a disagreement are checked', () => {
  const revised = replacement => ({rows:result.rows.map((row,index) => index ? row : {...row,...replacement})});
  const original = result.rows[0].analysis;
  assert.throws(() => validate(scope,revised({analysis:undefined})),/invalid_review_analysis/);
  assert.throws(() => validate(scope,revised({analysis:{...original,tensions:[{...tension,sides:[sideA,sideA]}]}})),/tension_without_distinct_sides/);
  assert.throws(() => validate(scope,revised({analysis:{...original,applicability:{...applicable,kind:'excluded',citations:[]}}})),/exclusion_without_evidence/);
  assert.throws(() => validate(scope,revised({analysis:{...original,properties:[{...material,citations:[{id:'L4',quote:'алюминий'}]},size]}})),/invalid_citation/);
  assert.throws(() => validate(scope,revised({analysis:{...original,properties:[{...material,letter:ask('Какой материал?')},size]}})),/question_without_open_evidence/);
});

test('revision resolves one question from a new address and preserves unrelated decisions', () => {
  const published = validate(scope,result);
  const report = {...published,stage:scope.stage,requirements:catalog.requirements,reportId:'prior'};
  const fact = {id:'new-resolution',versionId:'second',originalSha256,address:{unitId:'page-2',locator:{page:2}},
    lineId:'1',label:'second.pdf',quote:'Применять габарит панели 620 мм из редакции 2.'};
  const {snapshot,request} = prepareRevisionSnapshot(report,[fact],1);
  assert.equal(snapshot.wireVersion,3);
  const data = JSON.parse(request.messages[1].content);
  const [row] = data.rows;
  const [priorTension] = row.analysis.tensions;
  const {citations:left, ...first} = sideA;
  const {citations:right, ...second} = sideB;
  const {citations:unused,...priorSize} = size;
  const update = {key:row.key,status:'partial',finding:'Редакция 2 разрешила расхождение по размеру.',ids:['O1'],
    analysis:{applicability:null,properties:[{...priorSize,status:'confirmed',finding:'620 мм в редакции 2.',
      ids:['O1'],letter:omit('Рабочий размер установлен.')}],tensions:[{
      key:tension.key,propertyKey:size.key,status:'resolved',finding:'Применяется редакция 2.',
      sides:[{...first,ids:priorTension.sides[0].ids},{...second,ids:priorTension.sides[1].ids}],resolutionIds:['O1'],
    }]}};
  const output = applyRevision({...snapshot,key:'revision'},{changes:[update]});
  assert.equal(output.rows[0].analysis.tensions[0].resolutionSources[0].quote,fact.quote);
  assert.equal(output.rows[0].analysis.properties[1].status,'confirmed');
  assert.deepEqual(output.rows[0].analysis.properties[0],published.rows[0].analysis.properties[0]);
  assert.deepEqual(output.rows.slice(1),published.rows.slice(1));
  assert.doesNotMatch(output.draftText,/Какой размер применять/);
  assert.match(output.draftText,/Укажите толщину цинкового покрытия/);
  assert.throws(() => applyRevision(snapshot,{changes:[{...update,analysis:{...update.analysis,tensions:[]}}]}),/unlinked_review_tension/);
});

test('a bounded full reassessment preserves confirmed and disputed properties against pinned originals', () => {
  const previous = validate(scope,result);
  const fresh = validate(scope,{rows:result.rows.map((row,index) => index ? row : {...row,status:'unassessed',
    finding:'Новый отбор не охватил страницы.',citations:[],analysis:{...row.analysis,properties:[],tensions:[]}})});
  const updated = reconcilePreliminaryReview(fresh,previous.rows);
  assert.equal(updated.rows[0].status,previous.rows[0].status);
  assert.equal(updated.rows[0].finding,previous.rows[0].finding);
  assert.equal(updated.rows[0].retained.finding,previous.rows[0].finding);
  assert.deepEqual(updated.rows[0].sources,previous.rows[0].sources);
  assert.deepEqual(updated.rows[0].analysis.properties,previous.rows[0].analysis.properties);
  assert.deepEqual(updated.rows[0].analysis.tensions,previous.rows[0].analysis.tensions);
  assert.equal(updated.draftText,previous.draftText);
  const changed = reconcilePreliminaryReview({...fresh,inventory:inventory.slice(0,1)},previous.rows);
  assert.equal(changed.rows[0].analysis.properties.length,0);
  assert.equal(changed.rows[0].finding,previous.rows[0].finding);
});


test('a fresh confirmation cannot silently clear a prior addressed conflict', () => {
  const previous = validate(scope,result);
  const inferred = {...size,status:'confirmed',finding:'На втором листе указаны 620 мм.',
    citations:citations(1),letter:omit('Размер установлен.')};
  const fresh = validate(scope,{rows:result.rows.map((row,index) => index ? row : {...row,
    analysis:{...row.analysis,properties:[material,inferred],tensions:[]}})});
  const revised = reconcilePreliminaryReview(fresh,previous.rows);
  assert.equal(revised.rows[0].analysis.properties[1].status,'conflicting');
  assert.match(revised.draftText,/Какой размер применять/);
});

test('receipt of a response and a property omitted in that response require direct addresses', () => {
  const reviewed = structuredClone(result);
  const waiting = reviewed.rows[1].analysis.properties[0];
  waiting.response = {state:'not_received',finding:'Ответ по запросу №7 явно отмечен как неполученный.',citations:citations(4)};
  const omitted = reviewed.rows[2].analysis.properties[0];
  omitted.response = {state:'received',finding:'На запрос №8 дан ответ о цвете.',citations:citations(5)};
  omitted.letter = ask('Уточните, какой блеск покрытия нужен при указанном цвете.');
  const concrete = validate(scope,reviewed);
  assert.equal(concrete.rows[1].analysis.properties[0].response.state,'not_received');
  assert.equal(concrete.rows[2].analysis.properties[0].response.state,'received');
  assert.equal(concrete.rows[2].analysis.properties[0].response.sources[0].quote,lines[5].text);
  assert.match(concrete.draftText,/какой блеск покрытия/);
  omitted.response.citations = [];
  assert.throws(() => validate(scope,reviewed),/response_without_evidence/);
  omitted.response.citations = citations(5);
  waiting.response.state = 'received';
  assert.throws(() => validate(scope,reviewed),/received_response_marked_unanswered/);
  assert.equal(validate(scope,result).rows[2].analysis.properties[0].response,undefined,'silence supplies no receipt status');
});

test('an explicit scope exclusion in КЖ remains visible with its source and contributes no question', () => {
  const reviewed = structuredClone(result);
  const row = reviewed.rows.find(item => draftCatalogPart(item.key) === 'Раздел КЖ');
  row.analysis.applicability = {kind:'excluded',reason:'Крепление к стальной раме. КЖ вне области заказа.',citations:citations(6)};
  const report = validate(scope,reviewed);
  const excluded = report.rows.find(item => item.key === row.key);
  assert.equal(excluded.analysis.applicability.kind,'excluded');
  assert.match(excluded.analysis.applicability.reason,/стальной раме/);
  assert.equal(excluded.analysis.applicability.sources[0].quote,lines[6].text);
  assert.doesNotMatch(report.draftText,/Раздел КЖ/);
  row.analysis.properties = [coating];
  assert.throws(() => validate(scope,reviewed),/question_without_open_evidence/);
});

function draftCatalogPart(key) {
  return catalog.requirements.find(requirement => requirement.key === key).part;
}


test('a populated 16-row revision keeps its new facts inside the adapter input budget', () => {
  const base = validate(scope,result);
  const rows = base.rows.map((row,index) => ({...row,
    finding:'Длинное пояснение о предварительных свойствах этого требования. '.repeat(12),
    analysis:{...row.analysis,tensions:[],properties:Array.from({length:4},(_,i) => ({
      key:`property-${i}`,label:`Проверяемое свойство ${i}`,status:'confirmed',
      finding:'Сохранённый вывод о подтверждённом свойстве предварительного разбора. '.repeat(6),
      letter:omit('Вопрос снят при подтверждении этого свойства. '.repeat(5)),
      sources:[{versionId:'first',originalSha256,label:'first.pdf',
        anchor:JSON.stringify({unitId:`page-${index+1}`,lineId:`line-${i}`,address:{unitId:`page-${index+1}`,locator:{page:index+1}},
          notes:'Вспомогательные данные адреса. '.repeat(4)}),
        quote:'Строка с подтверждённым свойством в оригинале. '.repeat(6)}],
    }))},
  }));
  const newFact = {id:'new-observation',versionId:'first',originalSha256,address:{unitId:'page-20',locator:{page:20}},
    quote:'Подтверждённый размер панели 620 мм из второй редакции.'};
  const {snapshot,request} = prepareRevisionSnapshot({...base,requirements:catalog.requirements,rows},[newFact],1);
  assert.equal(snapshot.wireVersion,3);
  assert.equal(snapshot.compactContext,true);
  assert.equal(snapshot.facts[0],newFact,JSON.stringify(snapshot.budget));
  assert.ok(remainingRequestBytes(snapshot.budget)>=0);
  assert.equal(JSON.parse(request.messages[1].content).rows.length,16);
  assert.equal(snapshot.rows[0].analysis.properties[0].sources[0].quote,rows[0].analysis.properties[0].sources[0].quote);
});
