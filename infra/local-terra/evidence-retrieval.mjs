// Search the indexed literal of every address in scope. Catalog phrases, independent
// requirements and the measured properties of a source have separate ranking lanes.
const hints = {
  'doc.facades': [['Вид фасада','развёртка фасада'],['Обозначение осей','фасад в осях','фасад по осям']],
  'doc.floor_plans': [['План этажа','поэтажный план'],['Подвал','план подвального этажа','план подземного этажа','техническое подполье'],
    ['Кровля','план кровли','план покрытия']],
  'doc.sections': [['Разрез','поперечный разрез','продольный разрез']],
  'doc.architecture': [['Опись АР','ведомость рабочих чертежей','общие данные архитектурные решения']],
  'doc.architecture_details': [['Узлы','узел примыкания','деталь крепления','узел цоколя','узел карниза','узел откоса']],
  'data.cladding': [
    ['Материал облицовки','облицовка кирпичом','облицовка плиткой','фасадная плитка','облицовочная панель','наружный штукатурный слой'],
    ['Толщина облицовки','толщина плитки','толщина панели','толщина кирпича','толщина штукатурного слоя'],
    ['Толщина плитки','толщина плитки','облицовка плиткой'],
    ['Числовой состав слоёв','слой утеплителя','минераловатный утеплитель'],
    ['Плиточная облицовка','облицовка плиткой','фасадная плитка','керамическая плитка','бетонная плитка'],
    ['Кирпичная облицовка','облицовка кирпичом','кирпичная облицовка','гибкие связи'],
    ['Состав и толщина слоёв','слой утеплителя','минераловатный утеплитель','наружная стена','фасадная теплоизоляционная система'],
    ['Толщины слоёв по зонам','слой утеплителя','выше земли','ниже земли','утепление цоколя'],
    ['Зона применения','облицовка цоколя','облицовка в осях','облицовка откоса','наружная стена'],
    ['Крепление облицовки','способ крепления','гибкие связи','крепление плитки','подсистема навесного фасада'],
  ],
  'doc.cladding_certificates': [['Свидетельство','техническое свидетельство','техническая пригодность']],
  'doc.facade_brief': [['Задание НВФ','техническое задание нвф','навесной вентилируемый фасад']],
  'doc.customer_brief': [['Задание от заказчика','задание заказчика','утверждено заказчиком']],
  'doc.concrete': [['Комплект КЖ','железобетонные конструкции','марка бетона']],
  'doc.steel': [['Комплект КМ','металлические конструкции','ведомость металлопроката']],
  'doc.glazing': [['Ведомость СПК','ведомость заполнения проёмов','спецификация окон','оконные блоки','витражные конструкции'],
    ['Установочные узлы','монтажный узел','узел установки окна','узел крепления витража']],
  'doc.anchor_tests': [['Испытания и усилия','испытание анкеров','усилие на вырыв','акт испытания','выдергивающая нагрузка']],
  'doc.thermal': [['Теплотехника','сопротивление теплопередаче','тепловая защита','коэффициент теплопроводности']],
  'doc.colors': [['Код и окраска','цвет облицовки','цветовое решение','окраска фасада','ral','ncs','рал'],
    ['Цвет заполнений','цвет профиля','цвет окон','цвет витража','цвет переплёта']],
};
const propertyLanes = new Set(['Толщина облицовки','Плиточная облицовка','Кирпичная облицовка','Состав и толщина слоёв',
  'Толщины слоёв по зонам','Числовой состав слоёв','Толщина плитки','Код и окраска','Цвет заполнений','Испытания и усилия']);
const common = new Set('для или при это как что его ней указан выпол налич состав сведе требо прове долже доку архи scope stage compl'.split(' '));
const wordPattern = /[\p{L}]{2,}/gu;
const measurePattern = /\d\s*(?:[мm][мm]|кПа|кН|МПа|kg|мм²|см)(?!\p{L})/iu;
const layerNumber = /\b\d+\s*(?:-й\s+)?сло[йяе]/gu;
const dimensions = /\d+(?:[.,]\d+)?\s*(?:[мm][мm]|см)(?!\p{L})/giu;
const tiledThickness = /(?:облицовк|плитк)[^.!?\n]{0,64}толщин/u;
const colorPattern = /(?:ral|ncs|рал)[\s:№-]*[sс]?[\s-]*\d{3,5}/iu;
const dxfMarkup = /\\(?:[HhWwTtQqAaCcFfSs]|p[ilrtxq])[^;\n]*;|\\[Pp](?!\p{L})/gu;

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(dxfMarkup, ' ');
}

function wordList(value) {
  return (value.match(wordPattern) ?? []).map(word => word.slice(0, /[а-я]/.test(word) ? 5 : 6));
}

function terms(value) {
  return wordList(normalized(value)).filter(word => !common.has(word));
}

function strings(value) {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') :
    typeof value === 'string' ? [value] : [];
}

function subjects(rule) {
  return Array.isArray(rule?.allOf) ? rule.allOf.map(group =>
    Array.isArray(group?.anyOf) ? [...new Set(group.anyOf.flatMap(option => strings(option?.subject)))] : [])
    .filter(group => group.length) : [];
}

export function buildEvidenceRanking(requirements) {
  const index = new Map();
  const lanes = [];
  function add(key, criterion, label, labels, additional = [], focused = false) {
    const weights = new Map(additional.flatMap(text => terms(text).map(term => [term,1])));
    const phrases = labels.map(terms).filter(phrase => phrase.length > 1);
    for (const text of labels) for (const term of terms(text)) weights.set(term,4);
    const lane = lanes.length;
    lanes.push({key,criterion,label,phrases,property:propertyLanes.has(label),focused});
    for (const [term,weight] of weights) {
      if (!index.has(term)) index.set(term, []);
      index.get(term).push([lane,weight]);
    }
  }
  for (const [criterion,row] of requirements.entries()) {
    const labels = [...strings(row.part),...strings(row.aliases),...strings(row.equivalents),...strings(row.evidenceRule)];
    const bySubject = subjects(row.evidenceRule);
    add(row.key,criterion,row.part ?? row.key,[...labels,...bySubject.flat()],strings(row.completenessCriterion));
    for (const [subject,...aliases] of hints[row.key] ?? []) add(row.key,criterion,subject,[subject,...aliases],[],true);
    for (const group of bySubject) {
      if (!lanes.some(lane => lane.key === row.key && lane.label === group[0])) add(row.key,criterion,group[0],group,[],true);
    }
  }
  return {
    lanes,
    score(text, { file = false } = {}) {
      const value = normalized(text);
      const words = wordList(value);
      const unique = new Set(words);
      const results = new Map();
      for (const term of unique) for (const [lane,weight] of index.get(term) ?? []) {
        results.set(lane,(results.get(lane) ?? 0)+weight);
      }
      for (const [lane,weight] of results) {
        const {label,phrases,property,focused} = lanes[lane];
        const phrase = phrases.reduce((best,phrase) => Math.max(best,
          words.some((word,i) => word === phrase[0] && phrase.every((term,j) => words[i+j] === term)) ? phrase.length : 0),0);
        let score = weight + phrase * 6;
        if (!file) {
          if (weight < 4 || (focused && weight<8 && phrases.length && !phrase && label!=='Код и окраска')) {
            results.delete(lane);
            continue;
          }
          if (property && weight >= 8 && measurePattern.test(value)) score += 15;
          if (label === 'Числовой состав слоёв' && [...value.matchAll(layerNumber)].length>1 && measurePattern.test(value)) {
            score += 85;
            if (/^\s*[•—–-]?\s*утеплител/u.test(value)) score += 10;
          }
          if (label === 'Толщина плитки' && tiledThickness.test(value) && measurePattern.test(value)) {
            score += 60;
            if (/^\s*[•—–-]?\s*облицовк[^.!?\n]{0,50}плитк/u.test(value)) score += 18;
          }
          if (label === 'Код и окраска' && colorPattern.test(value)) score += 26;
          if (label === 'Цвет заполнений' && phrase && colorPattern.test(value)) score += 32;
          if (label === 'Обозначение осей' && /^\s*фасад[ы]?\s+(?:в|по)\s+осях(?!\p{L})/u.test(value)) score += 60;
          if (label === 'Подвал' && /^\s*план\s+(?:подвал|подземн)/u.test(value)) {
            score += 40;
            if (/(?:м\s*)?\d+\s*:\s*\d+\s*\)?\s*$/u.test(value)) score += 25;
          }
          if (label === 'Кирпичная облицовка' && phrase && colorPattern.test(value)) score += 22;
          if (label === 'Плиточная облицовка' && phrase && /\d/u.test(value)) score += 16;
          if (label === 'Толщины слоёв по зонам' && /\b\d+\s*сло/u.test(value) && measurePattern.test(value)) score += 18;
          // A line which names all phrases once in a standards list should not crowd
          // out shorter, addressed statements of one material or property.
          score /= 1 + Math.max(0, unique.size-18) / 36;
        }
        results.set(lane,score);
      }
      return results;
    },
  };
}

const limitPerLane = 24;
const limitPerSource = 8;
const limitRepeatedText = 3;
const smallIndexLineLimit = 512;
const smallIndexByteLimit = 128_000;

function queue(store, candidate, limit = limitPerLane) {
  if (store.length >= limit && store.at(-1).score >= candidate.score) return;
  const sameSource = store.filter(existing => existing.hit.versionId === candidate.hit.versionId);
  const repeated = sameSource.filter(existing => existing.hit.folded === candidate.hit.folded);
  candidate.score -= repeated.length*8;
  const eviction = repeated.length >= limitRepeatedText ? repeated.at(-1) :
    sameSource.length >= limitPerSource ? sameSource.at(-1) : undefined;
  if (eviction) {
    if (eviction.score >= candidate.score) return;
    store.splice(store.indexOf(eviction), 1);
  }
  const before = store.findIndex(existing => existing.score < candidate.score);
  if (before < 0) store.push(candidate);
  else store.splice(before,0,candidate);
  if (store.length > limit) store.pop();
}

export function createEvidenceCollector(requirements, files) {
  const ranking = buildEvidenceRanking(requirements);
  const sourceProfiles = new Map(files.map(file => {
    const extension = file.path.split('.').at(-1).toLowerCase();
    const type = extension === 'pdf' ? 'pdf' : ['dxf','dwg','ifc','rvt'].includes(extension) ? 'cad' : 'other';
    return [file.versionId,{type,title:ranking.score(file.path,{file:true})}];
  }));
  const lanes = ranking.lanes.map(lane => ({...lane, heads:[], kinds:new Map(), values:new Map(), supported:0}));
  const representatives = new Map();
  let totalLines = 0;
  let smallIndex = [], smallIndexBytes = 0;
  return {
    add(hit) {
      totalLines++;
      if (smallIndex) {
        smallIndexBytes += Buffer.byteLength(hit.folded);
        if (totalLines <= smallIndexLineLimit && smallIndexBytes <= smallIndexByteLimit) smallIndex.push(hit);
        else smallIndex = undefined;
      }
      if (!representatives.has(hit.versionId)) representatives.set(hit.versionId,hit);
      const source = sourceProfiles.get(hit.versionId);
      for (const [lane,value] of ranking.score(hit.folded)) {
        const target = lanes[lane];
        target.supported++;
        const score = value + Math.min(4,(source?.title.get(lane) ?? 0) / 5);
        queue(target.heads,{hit,score});
        if (source) {
          if (!target.kinds.has(source.type)) target.kinds.set(source.type,[]);
          queue(target.kinds.get(source.type),{hit,score},8);
        }
        if (['Числовой состав слоёв','Толщина плитки'].includes(target.label) && score>60) {
          const layerStart = target.label === 'Числовой состав слоёв' ? hit.folded.search(layerNumber) : 0;
          const values = [...hit.folded.slice(Math.max(layerStart,0)).matchAll(dimensions)];
          const signature = values.map(match=>match[0].replaceAll(/\s+/gu,'')).join('|');
          const existing = target.values.get(signature);
          if (signature && (!existing || existing.score<score)) {
            target.values.set(signature,{hit,score});
            if (target.values.size>16) {
              const weakest = [...target.values].reduce((a,b)=>a[1].score<b[1].score ? a : b);
              target.values.delete(weakest[0]);
            }
          }
        }
      }
    },
    finish() {
      const chosen = new Map();
      function include(hit, lane, rank) {
        const key = hit.blockId + ':' + hit.ordinal;
        if (!chosen.has(key)) chosen.set(key,{...hit, matches:[], rank});
        if (lane) chosen.get(key).matches.push({key:lane.key,label:lane.label,rank});
      }
      for (const lane of lanes) {
        const items = new Set();
        if (lane.heads.length) items.add(lane.heads[0]);
        const variants = [...lane.values.values()].sort((a,b)=>b.score-a.score);
        for (const next of variants.slice(0,4)) if (next.score >= (lane.heads[0]?.score ?? 0)*0.68) items.add(next);
        const firstOfEachType = [...lane.kinds.values()].map(items=>items[0]).filter(Boolean).sort((a,b)=>b.score-a.score);
        for (const next of firstOfEachType) if (next.score >= (lane.heads[0]?.score ?? 0)*0.72) items.add(next);
        for (const next of [...lane.kinds.values()].flat().concat(lane.heads).sort((a,b)=>b.score-a.score)) items.add(next);
        lane.heads = [...new Map([...items].map(item=>[item.hit,item])).values()];
        lane.variantCompanion = variants.find(candidate=>candidate.hit!==lane.heads[0]?.hit);
      }
      const byCriterion = requirements.map((_,criterion) => lanes.filter(lane => lane.criterion === criterion));
      // Give criterion groups, their subsubjects and distinct representations a turn
      // before filling the remaining shortlist slots.
      const longest = Math.max(0,...byCriterion.map(group=>group.length));
      const depth = Math.max(0,...lanes.map(lane=>lane.heads.length));
      for (let rank=0; rank<depth; rank++) {
        for (let position=0; position<longest; position++) for (const group of byCriterion) {
          const lane = group[position], item = lane?.heads[rank];
          if (item) include(item.hit,lane,rank);
          if (rank===0 && lane?.variantCompanion) include(lane.variantCompanion.hit,lane,1);
        }
      }
      // Include uncued facts and exclusions in a small index before optional prompt context.
      for (const hit of smallIndex ?? representatives.values()) include(hit,undefined,limitPerLane);
      return {totalLines,candidates:[...chosen.values()],completeCandidatePool:smallIndex!==undefined,
        requirements:requirements.map(({key},i) => ({key,lanes:byCriterion[i].map(({label,supported,heads}) =>
          ({label,matches:supported,candidates:heads.length}))}))};
    },
  };
}
