import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFactApplicability, factScopeSources, hasUnverifiedFactScope } from '../infra/local-terra/fact-applicability.mjs';
import { analysisFields, analysisSources, citationSchema, noOpenQuestions, readAnalysis, renderQuestions } from '../infra/local-terra/review-analysis.mjs';

const element = (element, rest = {}) => ({element,...rest});
const source = (anchor, quote, limitation) => ({versionId:'synthetic',originalSha256:'a'.repeat(64),anchor,quote,...(limitation && {limitation})});
const cite = ({anchor,quote}) => ({id:anchor,quote});
const rawScope = (target,observed,...sources) => ({kind:'applicable',target,observed,
  reason:'Адресная запись относится к применяемому решению.',citations:sources.map(cite)});
const rawProperty = (scope,sources,overrides = {}) => ({key:'subject',label:'Проверяемое свойство',status:'confirmed',
  finding:'Установлено значение из приведённой записи.',letter:{kind:'omit',text:'Решение подтверждено.'},
  citations:sources.map(cite),...(scope && {scope}),...overrides});
const rawAnalysis = (properties,tensions = []) => ({
  applicability:{kind:'included',reason:'Требование рассматривается.',citations:[]},properties,tensions,
});

function makeRow(properties, sources, tensions = [], options = {requireFactScope:true}) {
  const byAddress = new Map(sources.map(item => [item.anchor,item]));
  const resolve = citations => citations.map(({id,quote}) => {
    const entry = byAddress.get(id);
    assert(entry?.quote.includes(quote),'unverified_source');
    return {...entry,quote};
  });
  const check = (condition,message) => assert(condition,message);
  const analysis = readAnalysis(rawAnalysis(properties,tensions),resolve,check,options);
  return applyFactApplicability({key:'req',title:'Требование',status:'present',finding:'Сведения подтверждены в нужной области.',
    sources,analysis});
}

const cases = [
  ['different elements',element('наружный утеплитель'),element('утеплитель шва'), 'Утеплитель шва — плита 50 мм.'],
  ['different purposes',element('лист оцинкованный',{purpose:'откос'}),element('лист оцинкованный',{purpose:'крышка парапета'}),
    'Лист оцинкованный 0,7 мм — крышка парапета.'],
  ['different work and zones',element('анкер',{zone:'фасад',purpose:'испытание на вырыв'}),
    element('анкер',{zone:'кровля',purpose:'распорное крепление'}),'Кровля. Анкер М8, зона кровля, распорное крепление.'],
  ['different cladding options',element('облицовка',{variant:'тип 1'}),element('облицовка',{variant:'тип 10'}),
    'Облицовка тип 10: керамогранит 8 мм.'],
];
for (const [name,target,observed,text] of cases) {
  test(name + ' cannot confirm the required property or generate a question', () => {
    const observation = source('note',text);
    const scope = rawScope(target,observed,observation);
    const row = makeRow([rawProperty(scope,[observation],{
      status:'unanswered',
      finding:'Прочитанное число относится к текущему требованию.',
      letter:{kind:'ask',text:'Повторно запросить данные по текущему требованию.'},
    })],[observation]);
    const property = row.analysis.properties[0];
    assert.equal(row.status,'unassessed');
    assert.deepEqual(row.sources,[]);
    assert.doesNotMatch(row.finding,/подтверждены/);
    assert.equal(property.status,'insufficient');
    assert.equal(property.scope.kind,'undetermined');
    assert.deepEqual(property.scope.target,target);
    assert.deepEqual(property.scope.observed,observed);
    assert.deepEqual(property.sources,[]);
    assert.deepEqual(factScopeSources(property),[observation]);
    assert.deepEqual(analysisSources(row.analysis),[observation]);
    assert.equal(renderQuestions([row]),noOpenQuestions);
    assert(hasUnverifiedFactScope(row));
    const unrelated = makeRow([rawProperty({...scope,kind:'unrelated'},[observation])],[observation]);
    assert.equal(unrelated.analysis.properties[0].scope.kind,'unrelated');
    assert.deepEqual(applyFactApplicability(unrelated),unrelated);
  });
}

test('direct assignment and explicitly documented transfer preserve the property', () => {
  const target = element('откос',{zone:'фасад А'});
  const observed = element('крышка парапета',{zone:'кровля А'});
  const note = source('drawing','Крышка парапета, кровля А, выполнена из стали 0,8 мм.');
  const transfer = source('written-resolution','Крышка парапета, кровля А, применяется как откос на зоне фасад А.');
  const scope = rawScope(target,observed,note,transfer);
  const row = makeRow([rawProperty(scope,[note])],[note,transfer]);
  assert.equal(row.status,'present');
  assert.equal(row.analysis.properties[0].status,'confirmed');
  assert.equal(row.analysis.properties[0].scope.kind,'applicable');
  assert(!hasUnverifiedFactScope(row));

  const same = makeRow([rawProperty(rawScope(observed,observed,note),
    [{...note,quote:'стали 0,8 мм'}])],[note]);
  assert.equal(same.analysis.properties[0].status,'confirmed');
});

test('neighbors, qualifiers, and negative or conditional assignments cannot transfer a value', () => {
  const target = element('откос',{zone:'фасад А'});
  const observed = element('крышка парапета',{zone:'кровля А'});
  const note = source('drawing','Крышка парапета, кровля А, выполнена из стали 0,8 мм.');
  const contexts = [
    'Крышка парапета — кровля А; откос — фасад А.',
    'Крышка парапета, кровля А, не применяется как откос в зоне фасад А.',
    'Крышка парапета, кровля А, применяется как откос в зоне фасад А только при отдельном согласовании.',
    'Крышка парапета, кровля А, применяется как откос в зоне фасад А?',
  ];
  for (const [index,quote] of contexts.entries()) {
    const context = source('context-'+index,quote);
    const row = makeRow([rawProperty(rawScope(target,observed,note,context),[note])],[note,context]);
    assert.equal(row.status,'unassessed',quote);
  }
  const heading = source('header','Откос — фасад А.');
  const detail = source('detail','Сталь 0,8 мм.');
  const withHeading = makeRow([rawProperty(rawScope(target,target,heading),[detail])],[heading,detail]);
  assert.equal(withHeading.status,'unassessed');
  const sourceWithNoZone = source('unassigned','Откос из стали 0,8 мм.');
  const withNoZone = makeRow([rawProperty(rawScope(target,element('откос'),sourceWithNoZone),[sourceWithNoZone])],[sourceWithNoZone]);
  assert.equal(withNoZone.status,'unassessed');
  const mapping = source('mapping','Крышка парапета, кровля А, применяется как откос на зоне фасад А.','Плохая экспозиция.');
  const withLimitedMapping = makeRow([rawProperty(rawScope(target,observed,note,mapping),[note])],[note,mapping]);
  assert.equal(withLimitedMapping.status,'unassessed');
});

test('a supported finding survives alongside a blocked one while rejected sides and response are withheld', () => {
  const target = element('панель',{zone:'фасад А'});
  const other = element('панель',{zone:'фасад Б'});
  const a = source('a','Панель, фасад А: 8 мм.');
  const b = source('b','Панель, фасад Б: 10 мм.');
  const tension = {key:'different_zones',propertyKey:'panel',status:'open',finding:'Два значения.',
    sides:[{text:'8 мм',citations:[cite(a)]},{text:'10 мм',citations:[cite(b)]}],resolutionCitations:[]};
  const conflict = rawProperty(rawScope(target,target,a),[a],{key:'panel',status:'conflicting',
    response:{state:'received',finding:'Получено адресное уточнение.',citations:[cite(b)]},
    letter:{kind:'ask',text:'Какую толщину выбрать?'}});
  const correct = rawProperty(rawScope(target,target,a),[a],{
    key:'material',label:'Материал',status:'unanswered',
    letter:{kind:'ask',text:'Уточните материал панели на фасаде А.'},
  });
  const row = makeRow([conflict,correct],[a,b],[tension]);
  assert.equal(row.status,'partial');
  assert.deepEqual(row.sources,[a]);
  assert.equal(row.analysis.tensions.length,0);
  assert.equal(row.analysis.properties[0].scope.kind,'undetermined');
  assert.equal(row.analysis.properties[0].response,undefined);
  assert.deepEqual(row.analysis.properties[0].scope.sources,[a,b]);
  assert.equal(row.analysis.properties[1].status,'unanswered');
  assert.equal(renderQuestions([row]),'Требование — Материал. Уточните материал панели на фасаде А.');
});

test('scope is required for new model output and absent scope is held while a legacy result remains readable', () => {
  const refs = {citations:citationSchema};
  assert(analysisFields(refs,{requireFactScope:true}).properties.items.required.includes('scope'));
  assert(!analysisFields(refs).properties.items.required.includes('scope'));
  const observation = source('archive','Синтетический узел.');
  const property = rawProperty(undefined,[observation]);
  const legacy = makeRow([property],[observation],[],{});
  assert.equal(legacy.analysis.properties[0].scope,undefined);
  assert.equal(legacy.status,'present');
  const current = makeRow([property],[observation]);
  assert.equal(current.analysis.properties[0].scope.kind,'undetermined');
  assert.equal(current.status,'unassessed');

  const fabricated = source('invented','Вымышленное назначение.');
  const falseScope = rawScope(element('узел'),element('узел'),fabricated);
  assert.throws(() => makeRow([rawProperty(falseScope,[observation])],[observation]),/unverified_source/);
});

test('relabeling an explicitly excluded destination cannot confirm it as the observed scope', () => {
  const target = element('откос',{zone:'фасад А'});
  const observation = source('note','Крышка парапета 50 мм не применяется как откос в зоне фасад А.');
  const row = makeRow([rawProperty(rawScope(target,target,observation),[observation])],[observation]);
  assert.equal(row.status,'unassessed');
  assert.equal(row.analysis.properties[0].status,'insufficient');
});

test('the row cannot publish an unsupported claim outside its checked properties', () => {
  const observed = source('value','Панель, фасад А: 8 мм.');
  const target = element('панель',{zone:'фасад А'});
  const safe = rawProperty(rawScope(target,target,observed),[observed],{finding:'На фасаде А панель 8 мм.'});
  const raw = makeRow([safe],[observed]);
  const row = applyFactApplicability({...raw,finding:'Фасад Б: панель 50 мм.'},{requireFactScope:true});
  assert.equal(row.status,'present');
  assert.match(row.finding,/фасаде А панель 8 мм/);
  assert.doesNotMatch(row.finding,/Фасад Б|50 мм/);

  const bypass = {...makeRow([],[observed]),finding:'Фасад Б: панель 50 мм.'};
  const held = applyFactApplicability(bypass,{requireFactScope:true});
  assert.equal(held.status,'unassessed');
  assert.doesNotMatch(held.finding,/Фасад Б|50 мм/);
  assert(hasUnverifiedFactScope(held));
  assert.equal(renderQuestions([held]),noOpenQuestions);
  assert.deepEqual(applyFactApplicability(held,{requireFactScope:true}),held);
});

test('reassessment cannot restore historical unscoped claims or letter questions', async () => {
  const { mergeSelection } = await import('../infra/local-terra/reassessment.mjs');
  const note = source('note','Утеплитель шва — плита 50 мм.');
  const priorQuestion = rawProperty(undefined,[note],{
    status:'unanswered',letter:{kind:'ask',text:'Какая толщина наружного утеплителя?'},
    finding:'Для наружной зоны использован утеплитель 50 мм.',
  });
  const legacy = makeRow([priorQuestion],[note],[],{});
  const target = element('наружный утеплитель'), observed = element('утеплитель шва');
  const scope = {...rawScope(target,observed,note),kind:'unrelated'};
  const current = makeRow([rawProperty(scope,[note])],[note]);
  const input = {factScopeVersion:1,inventory:[note],rows:[current]};
  const merged = mergeSelection(input,[legacy]);
  assert.equal(merged.rows[0].analysis.properties[0].scope.kind,'unrelated');
  assert.equal(merged.rows[0].status,'unassessed');
  assert.equal(merged.rows[0].retained,undefined);
  assert.equal(merged.draftText,noOpenQuestions);
  assert.match(renderQuestions([legacy]),/Какая толщина/);
});

test('continuity preserves a previously scoped value only when its own addressed proof is still admitted', async () => {
  const { reconcilePreliminaryReview } = await import('../infra/local-terra/review-continuity.mjs');
  const target = element('наружный утеплитель'), observed = element('утеплитель шва');
  const insulation = source('outer','Наружный утеплитель — 120 мм.');
  const seam = source('seam','Утеплитель шва — 50 мм.');
  const previous = makeRow([rawProperty(rawScope(target,target,insulation),[insulation],{
    finding:'Наружный утеплитель имеет толщину 120 мм.',
  })],[insulation]);
  const fresh = makeRow([rawProperty({...rawScope(target,observed,seam),kind:'unrelated'},[seam])],[seam]);
  const input = {factScopeVersion:1,inventory:[insulation],rows:[fresh]};
  for (const admitted of [undefined,new Set([insulation.versionId])]) {
    const output = reconcilePreliminaryReview(input,[previous],admitted);
    assert.equal(output.rows[0].analysis.properties[0].scope.kind,'applicable');
    assert.match(output.rows[0].finding,/120 мм/);
    assert.doesNotMatch(output.rows[0].finding,/50 мм/);
  }
  const wrongTarget = makeRow([rawProperty(rawScope(observed,observed,seam),[seam],{finding:'Толщина 50 мм.'})],[seam]);
  const rechecked = reconcilePreliminaryReview({...input,rows:[wrongTarget]},[previous]);
  assert.equal(rechecked.rows[0].analysis.properties[0].scope.target.element,target.element);
  assert.match(rechecked.rows[0].finding,/120 мм/);
  const excluded = reconcilePreliminaryReview(input,[previous],new Set());
  assert.equal(excluded.rows[0].analysis.properties[0].scope.kind,'unrelated');
  const nearby = {...insulation,quote:'Наружный утеплитель — 120 мм; утеплитель шва — 50 мм.'};
  const inSamePlace = makeRow([rawProperty({...rawScope(target,observed,nearby),kind:'unrelated'},[nearby])],[nearby]);
  const reopened = reconcilePreliminaryReview({...input,rows:[inSamePlace]},[previous]);
  assert.equal(reopened.rows[0].analysis.properties[0].scope.kind,'unrelated');
});

test('an addressed revision stores the correct scope outcome and never reissues a legacy question', async () => {
  const { applyRevision, revisionRequest } = await import('../infra/local-terra/revise.mjs');
  const target = element('наружный утеплитель'), observed = element('утеплитель шва');
  const old = source('archive','Вопрос о толщине наружного утеплителя.');
  const priorQuestion = rawProperty(undefined,[old],{
    status:'unanswered',letter:{kind:'ask',text:'Уточните утеплитель.'},
  });
  const legacy = makeRow([priorQuestion],[old],[],{});
  const fact = {...source('new','Утеплитель шва — плита 50 мм.'),id:'fact-1',address:{unitId:'P1'}};
  const snapshot = {wireVersion:3,factScopeVersion:1,rows:[legacy],inventory:[old],requirements:[{key:'req'}],facts:[fact]};
  assert.match(revisionRequest(snapshot).messages[0].content,/scope\.target/);
  const property = {...rawProperty(undefined,[]),ids:['O1'],
    scope:{kind:'unrelated',target,observed,reason:'Описана заделка шва.',ids:['O1']}};
  delete property.citations;
  const answer = {changes:[{key:'req',status:'present',finding:'Толщина наружного утеплителя 50 мм.',ids:['O1'],
    analysis:{applicability:null,properties:[property],tensions:[]}}]};
  const updated = applyRevision(snapshot,answer);
  assert.equal(updated.rows[0].status,'unassessed');
  assert.doesNotMatch(updated.rows[0].finding,/50 мм/);
  assert.equal(updated.rows[0].analysis.properties[0].scope.kind,'unrelated');
  assert.equal(updated.rows[0].analysis.properties[0].scope.sources[0].quote,fact.quote);
  assert.equal(updated.draftText,noOpenQuestions);
  assert.match(renderQuestions(snapshot.rows),/Уточните утеплитель/);
});

test('primary validation and its real tool schema check scope before publishing a draft', async () => {
  const { makeRequest, validate } = await import('../infra/local-terra/producer.mjs');
  const note = source('synthetic-note','Облицовка тип 2: керамогранит 8 мм.');
  const target = element('облицовка',{variant:'тип 1'}), observed = element('облицовка',{variant:'тип 2'});
  const snapshot = {reviewContract:2,factScopeVersion:1,requirements:[{key:'req',part:'Облицовка'}],
    lines:[{...note,id:note.anchor,text:note.quote}],inventory:[note],scopeNote:'Синтетический комплект.',promptData:{}};
  const scope = rawScope(target,observed,note);
  const entry = {key:'req',status:'present',finding:'Тип 1: керамогранит 8 мм.',citations:[cite(note)],
    analysis:rawAnalysis([rawProperty(scope,[note])])};
  const request = makeRequest(snapshot);
  assert.match(request.messages[0].content,/scope\.target/);
  assert(request.tools[0].function.parameters.properties.rows.items.properties.analysis.properties.properties.items.required.includes('scope'));
  const published = validate(snapshot,{rows:[entry]});
  assert.equal(published.rows[0].status,'unassessed');
  assert.doesNotMatch(published.rows[0].finding,/8 мм/);
  assert.equal(published.rows[0].analysis.properties[0].scope.sources[0].anchor,note.anchor);
  assert.equal(published.draftText,noOpenQuestions);
});

test('an addressed supplement does not retarget a previously established property', async () => {
  const { applyRevision } = await import('../infra/local-terra/revise.mjs');
  const outside = element('наружный утеплитель'), joint = element('утеплитель шва');
  const old = source('outer','Наружный утеплитель — 120 мм.');
  const saved = makeRow([rawProperty(rawScope(outside,outside,old),[old],{finding:'Толщина 120 мм.'})],[old]);
  const fact = {...source('joint','Утеплитель шва — 50 мм.'),id:'fact-1',address:{unitId:'P1'}};
  const snapshot = {wireVersion:3,factScopeVersion:1,rows:[saved],inventory:[old],requirements:[{key:'req'}],facts:[fact]};
  const {citations,...property} = rawProperty(undefined,[],{finding:'Толщина 50 мм.'});
  const answer = {changes:[{key:'req',status:'present',finding:'Толщина 50 мм.',ids:['O1'],analysis:{
    applicability:null,tensions:[],
    properties:[{...property,ids:['O1'],scope:{kind:'applicable',target:joint,observed:joint,
      reason:'Подтверждена заделка шва.',ids:['O1']}}],
  }}]};
  assert.equal(applyRevision(snapshot,answer),null);
  assert.match(snapshot.rows[0].finding,/120 мм/);
});

test('inflections and qualified continuations in the same addressed record preserve proof', () => {
  const records = [
    [element('основной материал обшивки'),'В качестве основного материала обшивки принята фиброплита.'],
    [element('План этажа',{zone:'отм. -2.500',purpose:'с проёмами и ригелями'}),'План этажа на отм. -2.500\nс проёмами и ригелями'],
    [element('обшивка панелями',{variant:'Гладкая керамика'}),'Обшивка панелями с креплением по инструкции.\n\tГладкая керамика'],
    [element('защитная система',{purpose:'окраска фасадной краской',variant:'RAL 7000'}),'Защитная система с последующей окраской фасадной краской. RAL 7000.'],
  ];
  for (const [i,[area,quote]] of records.entries()) {
    const note=source('record-'+i,quote);
    const row=makeRow([rawProperty(rawScope(area,area,note),[note])],[note]);
    assert.equal(row.analysis.properties[0].scope.kind,'applicable',quote);
  }
});

test('a full literal at the same reader line qualifies its excerpt across address encodings', () => {
  const anchor={unitId:'17',lineId:'17.2.1.4',readerVersion:'reader-2'};
  const full=source(JSON.stringify({...anchor,blockId:'block-17'}),'Плита, фасад А: 12 мм.');
  const excerpt=source(JSON.stringify({...anchor,address:{unitId:'17',locator:{page:17}}}),'12 мм');
  const area=element('плита',{zone:'фасад А'});
  const row=makeRow([rawProperty(rawScope(area,area,full),[excerpt])],[full,excerpt]);
  assert.equal(row.analysis.properties[0].scope.kind,'applicable');
  const elsewhere={...excerpt,anchor:JSON.stringify({...anchor,lineId:'17.2.1.5'})};
  assert.equal(makeRow([rawProperty(rawScope(area,area,full),[elsewhere])],[full,elsewhere]).status,'unassessed');
});

test('mixed measurements, mismatched elevations and narrower observed scope stay on internal review',()=>{
  const records=[
    [element('Панель',{zone:'Фасад Б'}),element('Панель',{zone:'Фасад Б'}),
      'Панель, фасад А: 8 мм. Панель, фасад Б: 10 мм.'],
    [element('План этажа',{zone:'+2.500'}),element('План этажа',{zone:'-2.500'}),'План этажа на -2.500.'],
    [element('Анкер'),element('Анкер',{zone:'фасад А'}),'Анкер на фасаде А, усилие 3 кН.'],
  ];
  for (const [i,[target,observed,quote]] of records.entries()) {
    const proof=source('unsafe-'+i,quote);
    const row=makeRow([rawProperty(rawScope(target,observed,proof),[proof])],[proof]);
    assert.equal(row.status,'unassessed',quote);
    assert.equal(row.analysis.properties[0].letter.kind,'omit');
  }
  const binder=source('binder','Панель, фасад Б: 10 мм.');
  const area=element('Панель',{zone:'Фасад Б'});
  const wrongValue=rawProperty(rawScope(area,area,binder),[binder],{finding:'Толщина 12 мм.'});
  assert.equal(makeRow([wrongValue],[binder]).status,'unassessed');
});

test('unchanged address and old question survive bounded strict reassessment with a visual note',async()=>{
  const { reconcilePreliminaryReview } = await import('../infra/local-terra/review-continuity.mjs');
  const proof=source('prior-document','В узле У7 стальной кронштейн. Шаг должен быть указан на рабочем чертеже.');
  const earlier=makeRow([rawProperty(undefined,[proof],{
    status:'unanswered',finding:'На листе указан кронштейн и запрос на шаг.',
    letter:{kind:'ask',text:'Уточните шаг кронштейнов в узле У7.'},
  })],[proof],[],{});
  const visual={versionId:proof.versionId,originalSha256:proof.originalSha256,anchor:JSON.stringify({unitId:'sheet-2',
    sheetPreview:{sha256:'b'.repeat(64),state:'inconclusive',title:'Узел У7',observation:'Масштаб требует сверки.'}})};
  const limited={...makeRow([],[]),status:'unassessed',finding:'Участок не вошёл в очередную выборку.',sources:[visual]};
  const input={factScopeVersion:1,inventory:[proof],rows:[limited]};
  const output=reconcilePreliminaryReview(input,[earlier]);
  assert.equal(output.rows[0].status,'partial');
  assert.equal(output.rows[0].retained.finding,earlier.finding);
  assert.deepEqual(output.rows[0].analysis.properties[0].sources,[proof]);
  assert.equal(output.rows[0].analysis.properties[0].scope,undefined);
  assert.deepEqual(output.rows[0].sources,[visual,proof]);
  assert.match(output.draftText,/Уточните шаг кронштейнов в узле У7/);
  const next = reconcilePreliminaryReview(input,output.rows);
  assert.equal(next.rows[0].retained.finding,earlier.finding);

  const withLimited={...earlier,sources:[proof,{...source('same-original','На соседнем листе дана только ссылка.'),limitation:'Открыта ссылка.'}]};
  const ruled=reconcilePreliminaryReview(input,[withLimited]);
  assert.equal(ruled.rows[0].status,'partial');
  assert.equal(ruled.rows[0].retained.sources[1].limitation,'Открыта ссылка.');
  const historyOnly=reconcilePreliminaryReview(input,[{...earlier,status:'unassessed',sources:[],retained:output.rows[0].retained}]);
  assert.equal(historyOnly.rows[0].status,'unassessed');
  assert.ok(historyOnly.rows[0].retained);
  const different=reconcilePreliminaryReview({...input,inventory:[{...proof,originalSha256:'z'.repeat(64)}]},[earlier]);
  assert.equal(different.rows[0].status,'unassessed');
  assert.deepEqual(different.rows[0].sources,[visual]);
  assert.equal(different.draftText,noOpenQuestions);

  const held=applyFactApplicability({...limited,status:'partial'},{requireFactScope:true});
  assert.equal(held.status,'unassessed');
  assert.deepEqual(held.sources,[visual]);
});

test('an old addressed question closes only with a verified update to the same scope',async()=>{
  const {reconcilePreliminaryReview} = await import('../infra/local-terra/review-continuity.mjs');
  const earlierSource=source('initial-panel','Панель, фасад А: уточнить толщину.');
  const earlier=makeRow([rawProperty(undefined,[earlierSource],{
    status:'unanswered',finding:'В записи требуется толщина панели.',
    letter:{kind:'ask',text:'Уточните толщину панели на фасаде А.'},
  })],[earlierSource],[],{});
  for (const [zone,expected] of [['фасад Б',true],['фасад А',false]]) {
    const exact=source('new-value','Панель, '+zone+': 10 мм.');
    const area=element('панель',{zone});
    const current=makeRow([rawProperty(rawScope(area,area,exact),[exact],{finding:'Толщина 10 мм.'})],[exact]);
    const output=reconcilePreliminaryReview({factScopeVersion:1,inventory:[exact],rows:[current]},[earlier]);
    assert.equal(output.draftText.includes('Уточните толщину панели на фасаде А'),expected);
    assert.equal(output.rows[0].analysis.properties[0].scope.kind,'applicable');
    assert.equal(new Set(output.rows[0].analysis.properties.map(property=>property.key)).size,
      output.rows[0].analysis.properties.length);
  }
});

test('a color designator can continue the same physical record without being a scope field',()=>{
  const area=element('защитная система',{variant:'с последующей окраской'});
  const note=source('color','Защитная система с последующей окраской. RAL 7000 - серый.');
  const stated=rawProperty(rawScope(area,area,note),[note],{finding:'Для системы установлен RAL 7000.'});
  assert.equal(makeRow([stated],[note]).analysis.properties[0].status,'confirmed');
  const separate={...note,quote:'Защитная система с последующей окраской; RAL 7000 - серый.'};
  assert.equal(makeRow([{...stated,citations:[cite(separate)],scope:rawScope(area,area,separate)}],
    [separate]).analysis.properties[0].status,'insufficient');
});

test('bounded reassessment retains checked plans and addressed context without repeating validation',async()=>{
  const {reconcilePreliminaryReview} = await import('../infra/local-terra/review-continuity.mjs');
  const line=source('plan','План этажа на отм. -1.500\nс проёмами и лестницей');
  const earlierArea=element('План этажа',{zone:'отм. -1.500',purpose:'с проёмами и лестницей'});
  const currentArea=element('План этажа на отм. -1.500',{purpose:'с проёмами и лестницей'});
  const note=source('reveal','На листе приведено название узла проёма.');
  const context=rawProperty({...rawScope(element('узел проёма'),element('узел проёма'),note),kind:'undetermined'},[note],{
    key:'reveal',label:'Содержание узла проёма',status:'insufficient',letter:{kind:'omit',text:'Нужно открыть узел.'},
  });
  const previous={...makeRow([rawProperty(rawScope(earlierArea,earlierArea,line),[line]),context],[line,note]),status:'partial'};
  const fresh={...makeRow([rawProperty(rawScope(currentArea,currentArea,line),[line])],[line]),status:'partial'};
  const input={factScopeVersion:1,inventory:[line],rows:[fresh]};
  const merged=reconcilePreliminaryReview(input,[previous]);
  assert.equal(merged.rows[0].status,'partial');
  assert.equal(merged.rows[0].analysis.properties[0].scope.target.zone,earlierArea.zone);
  assert.equal(merged.rows[0].analysis.properties[1].scope.kind,'undetermined');
  assert.match(merged.rows[0].analysis.properties[1].scope.reason,/^Контекст предыдущего разбора/);
  assert.equal(merged.draftText,noOpenQuestions);
  const gone={...input,rows:[{...makeRow([],[]),status:'unassessed'}]};
  assert.equal(reconcilePreliminaryReview(gone,[previous]).rows[0].status,'partial');
  const excluded={...fresh,status:'unassessed',analysis:{...fresh.analysis,
    applicability:{kind:'excluded',reason:'Эти планы исключены из выдачи.',sources:[line]},properties:[]}};
  assert.equal(reconcilePreliminaryReview({...input,rows:[excluded]},[previous]).rows[0].status,'unassessed');
  assert.equal(reconcilePreliminaryReview({...input,rows:[excluded]},[previous]).rows[0].analysis.applicability.kind,'excluded');
});

test('an already answered dimension does not widen an earlier scoped question or affect another variant',async()=>{
  const {reconcilePreliminaryReview} = await import('../infra/local-terra/review-continuity.mjs');
  const prior=source('grounded-dimension','Плита ПАН-7 толщиной 12 мм для стены в световом дворе.');
  const oldGap={key:'panel-zone',label:'Плита из паспорта: зона применения',status:'insufficient',
    finding:'В явно названной стене не установлены оси применения плиты.',
    letter:{kind:'ask',text:'Уточните оси стены в световом дворе для плиты ПАН-7 толщиной 12 мм.'}};
  // The value in the old question describes the object. The old request is for axes.
  const earlier=makeRow([rawProperty(undefined,[prior],{...oldGap,
    letter:{...oldGap.letter,text:'Уточните оси стены в световом дворе для плиты ПАН-7, 12 мм.'}}),
  rawProperty(undefined,[prior],{key:'panel-thickness',label:'Толщина плиты',finding:'Толщина 12 мм.'})],[prior],[],{});
  for (const [variant,zone,expected] of [['ПАН-7',undefined,1],['ПАН-8',undefined,2],['ПАН-7','Фасад Б',2]]) {
    const note=source('new-window',`Плита ${variant}${zone ? ', '+zone : ''}.`);
    const area=element('плита',{variant,...(zone && {zone})});
    const newer=makeRow([rawProperty(rawScope(area,area,note),[note],{...oldGap,
      label:oldGap.label+' и толщина',letter:{kind:'ask',text:`Какова толщина и каковы зоны применения плиты ${variant}?`},
    })],[note]);
    const report=reconcilePreliminaryReview({factScopeVersion:1,inventory:[prior],rows:[newer]},[earlier]);
    assert.equal(report.rows[0].analysis.properties.filter(property=>property.letter.kind==='ask').length,expected);
    if (expected===1) assert.doesNotMatch(report.draftText,/Какова толщина/);
  }
});

test('a primary review salvages a legend entry and an addressed question from a malformed row',async()=>{
  const {validatedPartial}=await import('../infra/local-terra/partial-result.mjs');
  const catalog=JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../infra/catalogs/intake-stage-1.json',import.meta.url)));
  const legend=source('note','Облицовка: фиброцементная панель, RAL 7015.');
  const elevation=source('elevation','Фасад 4 — маркировка шва Ш3.');
  const color=element('фиброцементная панель');
  const joint=element('шва Ш3',{zone:'Фасад 4'});
  const legendRecord=rawProperty({...rawScope(color,color,legend),basis:'literal'},[legend],{
    key:'legend_finish',label:'Запись облицовки',finding:'Все фасады выполнены из указанной панели.',
  });
  const falseAssignment=rawProperty(rawScope({...color,zone:'Фасад 4'},color,legend),[legend],{
    key:'assigned_finish',label:'Назначение отделки',finding:'Фасаду 4 назначен RAL 7015.',
  });
  const question=rawProperty(rawScope(joint,joint,elevation),[elevation],{
    key:'joint_dimension',label:'Неуточнённый размер шва',status:'insufficient',finding:'В обозначении размер шва не указан.',
    letter:{kind:'ask',text:'Укажите ширину шва Ш3 фасада 4.'},
  });
  const bogus=rawProperty(undefined,[source('invented','Произвольный текст.')],{key:'fabricated'});
  const snapshot={reviewContract:2,factScopeVersion:1,requirements:catalog.requirements,scopeNote:'Синтетический обзор.',
    lines:[legend,elevation].map(item=>({...item,id:item.anchor,text:item.quote})),inventory:[legend]};
  const cases=catalog.requirements.map(({key},index)=>({key,status:index?'unassessed':'present',
    finding:'Материалы рассматриваются.',citations:index?[]:[{id:'invented',quote:'Произвольный текст.'}],
    analysis:rawAnalysis(index===0?[legendRecord,falseAssignment,question,bogus]:index===1?[question]:[])}));
  const published=validatedPartial(snapshot,{rows:cases});
  assert.equal(published.rows.length,16);
  assert.equal(published.rows[0].status,'partial');
  const properties=published.rows[0].analysis.properties;
  assert.deepEqual(properties.map(property=>[property.key,property.status]),[
    ['legend_finish','confirmed'],['assigned_finish','insufficient'],['joint_dimension','insufficient'],
  ]);
  assert.match(properties[0].finding,/В источнике указано: «Облицовка/);
  assert.doesNotMatch(published.rows[0].finding,/Все фасады|Фасаду 4 назначен/);
  assert.equal(properties[1].scope.sources[0].quote,legend.quote);
  assert.equal(published.rows[1].status,'unassessed');
  assert.match(published.draftText,/Укажите ширину шва Ш3 фасада 4/);
  assert.equal(published.draftText.match(/Укажите ширину/g).length,1);
  assert.equal(published.rows[1].analysis.properties[0].sources[0].quote,elevation.quote);
});

test('a literal quotation stays local and cannot change an earlier engineering property',async()=>{
  const observed=source('color','Цвет RAL 7015 для панели А.');
  const area=element('панели А');
  const original=rawProperty(rawScope(area,area,observed),[observed],{finding:'Цвет панели А — RAL 7015.'});
  const prior=makeRow([original],[observed]);
  const relabelled=makeRow([{...original,scope:{...original.scope,basis:'literal'}}],[observed]);
  const {reconcilePreliminaryReview}=await import('../infra/local-terra/review-continuity.mjs');
  const held=reconcilePreliminaryReview({rows:[relabelled],inventory:[observed],factScopeVersion:1},[prior]);
  assert.equal(relabelled.status,'partial');
  assert.equal(held.rows[0].analysis.properties[0].scope.basis,undefined);
  assert.equal(held.rows[0].analysis.properties[0].finding,original.finding);
});

test('present requires a verified material finding and closed properties',async()=>{
  const {validate}=await import('../infra/local-terra/producer.mjs');
  const evidence=source('sheet','Кронштейн К2, вылет 120 мм.');
  const target=element('Кронштейн К2');
  const scope=rawScope(target,target,evidence);
  const snapshot={reviewContract:2,factScopeVersion:1,requirements:[{key:'bracket',part:'Кронштейн'}],
    lines:[{...evidence,id:evidence.anchor,text:evidence.quote}],inventory:[evidence],scopeNote:'Синтетический обзор.'};
  const gap=rawProperty(scope,[evidence],{key:'gap',status:'insufficient',
    finding:'Применение кронштейна требует внутренней сверки.'});
  const present=rawProperty(scope,[evidence],{key:'reach',finding:'Подтверждён вылет 120 мм.'});
  const publish=properties=>validate(snapshot,{rows:[{key:'bracket',status:'present',finding:'Требование выполнено.',
    citations:[cite(evidence)],analysis:rawAnalysis(properties)}]});
  const onlyOpen=publish([gap]);
  assert.equal(onlyOpen.rows[0].status,'unassessed');
  assert.match(onlyOpen.draftText,/Вопросы пока не сформированы/u);
  const mixed=publish([gap,present]);
  assert.equal(mixed.rows[0].status,'partial');
  assert.match(mixed.rows[0].finding,/120 мм/u);
  assert.match(mixed.draftText,/Вопросы пока не сформированы/u);
  assert.equal(publish([present]).rows[0].status,'present');
  assert.match(publish([present]).draftText,/открытых адресных вопросов для письма нет/u);
});

test('a saved native quotation from a held visual reading can only confirm a literal record',async()=>{
  const {applyRevision,prepareRevisionSnapshot}=await import('../infra/local-terra/revise.mjs');
  const addr={unitId:'drawing',locator:{page:1}};
  const quote='Панель П2 из стали.';
  const observed={element:'Панель П2'};
  const priorRow={key:'req',title:'Панели',status:'unassessed',finding:'Нужна сверка.',sources:[],
    analysis:{applicability:{kind:'included',reason:'Область работ.',sources:[]},properties:[],tensions:[]}};
  const fact={id:'fact-native',versionId:'native',originalSha256:'a'.repeat(64),address:addr,quote,
    lineId:'1',grounding:'text',evidenceMode:'literal',label:'Фасад.pdf'};
  const previous={rows:[priorRow],inventory:[fact],requirements:[{key:'req',part:'Панели'}],scopeNote:'Синтетическая проверка.'};
  const {snapshot,request}=prepareRevisionSnapshot(previous,[fact],1);
  assert.equal(JSON.parse(request.messages[1].content).facts[0].evidence,'literal');
  const property={key:'panel',label:'Панель П2',finding:'На всём фасаде установлены панели П2.',
    ids:['O1'],status:'confirmed',letter:{kind:'omit',text:'Сведения установлены.'},
    scope:{kind:'applicable',observed,target:observed,reason:'Дословной записи достаточно.',ids:['O1']}};
  const run=property=>applyRevision(snapshot,{changes:[{key:'req',status:'present',finding:property.finding,ids:['O1'],
    analysis:{applicability:null,properties:[property],tensions:[]}}]}).rows[0];
  const held=run(property);
  assert.equal(held.status,'unassessed');
  assert.equal(held.analysis.properties[0].status,'insufficient');
  const verified=run({...property,scope:{...property.scope,basis:'literal'}});
  assert.equal(verified.status,'partial');
  assert.equal(verified.analysis.properties[0].status,'confirmed');
  assert.match(verified.finding,/Панель П2 из стали/u);
  assert.doesNotMatch(verified.finding,/всём фасаде/u);
});
