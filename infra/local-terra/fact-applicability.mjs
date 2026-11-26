export const factScopeKinds = ['applicable', 'unrelated', 'undetermined'];
export const factScopeFields = ['element', 'zone', 'purpose', 'variant'];
export const factScopeLabelLimit = 120;
export const factScopeReasonLimit = 420;
export const literalFactBasis = 'literal';

export const factApplicabilityInstruction = `Для каждого инженерного свойства проверь применимость конкретного свидетельства до оценки. В scope.target назови элемент текущего вопроса и, когда они различают решения, зону, назначение и исполнение. В scope.observed укажи элемент, зону, назначение и исполнение, которые описаны в конкретной опоре. Указывай для каждой стороны наиболее точные обозначения. Сохраняй различия, которые влияют на применение. Для совпадающих областей используй одинаковые дословные обозначения. Приведи адресные дословные фрагменты с ними в scope, включая фрагмент, связывающий обозначение с самим значением. Для переноса между отличающимися областями нужна отдельная явная положительная запись о применении из источника с обоими обозначениями. Название файла, сходный термин или значение, соседняя строка, вариант или редакция сами по себе не связывают записи. Если явно описан другой предмет, зона, функция или вариант, выбери unrelated. Если связь не установлена, выбери undetermined. Объясни причину, оставь вывод на внутреннюю сверку (insufficient, letter omit). Не используй такие наблюдения в сводном выводе, статусе present, противоречии, ответе на вопрос или тексте письма. Любое инженерное утверждение в сводном выводе представь отдельным свойством с проверенной областью. Для present и partial нужна хотя бы одна такая адресная опора. Для прямо исключённого требования действуют правила applicability. Проверяй каждую сторону противоречия и разрешение по той же области. Применимость требования целиком (applicability) и применимость свидетельства к свойству (scope) оценивай отдельно. Разнеси подпись, материал, параметр, назначение конкретной зоне и недостаток подтверждения по отдельным свойствам. Для дословной записи или подписи, в том числе строки легенды или штампа, используй scope.basis=literal, совпадающие target и observed, одну прямую цитату свойства и ту же опору области. Такой факт подтверждает только наличие записи в источнике. Само назначение элемента или цвета зоне проверяй отдельным свойством. Для открытого вопроса допускается insufficient с ask и прямой опорой, именующей его предмет. Для unanswered нужна явная постановка вопроса в источнике.`;

const undeterminedReason = 'Связь приведённого свидетельства с элементом, зоной, назначением и исполнением текущего вопроса не установлена.';
const unrelatedReason = 'Адресный источник относится к другой области или другому элементу, назначению либо исполнению.';
const remit = 'Сначала требуется внутренняя сверка назначения и области по источникам.';
const rowFinding = 'Часть сведений требует проверки применимости. Адреса и результат проверки приведены по свойствам.';
const phrases = value => value.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
const located = source => typeof source?.quote === 'string' && source.quote.trim() && !source.limitation
  && typeof source.anchor === 'string' && source.anchor.trim();
export function sameFactSourcePlace(a,b) {
  if (a.versionId !== b.versionId || a.originalSha256 !== b.originalSha256) return false;
  if (a.anchor === b.anchor) return true;
  try {
    const left = JSON.parse(a.anchor), right = JSON.parse(b.anchor);
    return typeof left.unitId === 'string' && left.unitId === right.unitId &&
      typeof left.lineId === 'string' && left.lineId === right.lineId &&
      (!left.readerVersion || !right.readerVersion || left.readerVersion === right.readerVersion);
  } catch { return false; }
}
const word = /[\p{L}\p{N}]/u;
const negatedAssignment = /(?<![\p{L}\p{N}])(?:не\s+(?:для|примен\p{L}*|использ\p{L}*|предназначен\p{L}*|относится|распространя\p{L}*)|not\s+(?:for|applicable|used|intended))(?![\p{L}\p{N}])/iu;

// Inflection may change a label in a literal quote. Keep all words, their order,
// and any signs, numbers and designators. This does not equate synonyms or zones.
const tokens = text => phrases(text).replaceAll('−','-').match(/[+-]?\d+(?:[.,]\d+)*|[\p{L}]+/gu) ?? [];
const inflections = ['ыми','ими','ами','ями','ого','его','ому','ему','ый','ий','ой','ая','яя','ое','ее','ые','ие',
  'ую','юю','ым','им','ом','ем','ых','их','ей','ам','ям','ах','ях','ов','ев','ью','а','я','у','ю','е','и','ы'];
function stems(word) {
  return /^[а-я]{5,}$/u.test(word) ? [word,...inflections.filter(end=>word.endsWith(end) && word.length-end.length>=4)
    .map(end=>word.slice(0,-end.length))] : [word];
}
function sameWord(left,right) {
  if (left===right) return true;
  const variants=stems(right);
  return stems(left).some(stem=>variants.includes(stem));
}
function startsWithTokens(text, words, offset = 0) {
  return offset+words.length<=text.length && words.every((word,i)=>sameWord(word,text[offset+i]));
}
function sameLabel(left,right) {
  if (phrases(left)===phrases(right)) return true;
  const a=tokens(left), b=tokens(right);
  return a.length===b.length && a.length>0 && startsWithTokens(a,b);
}
function mentions(text, label) {
  const phrase = phrases(label);
  if (!phrase) return false;
  let index = text.indexOf(phrase);
  while (index !== -1) {
    const end = index + phrase.length;
    const signed = /^\d/u.test(phrase) && /[+−-]/u.test(text[index-1] ?? '');
    if (!signed && !word.test(text[index - 1] ?? '') && !word.test(text[end] ?? '')) return true;
    index = text.indexOf(phrase, index + 1);
  }
  const a=tokens(text), b=tokens(phrase);
  return b.length>0 && a.some((_,i)=>startsWithTokens(a,b,i));
}

const scopeLabels = scope => Object.values(scope);
const clauses = quote => quote.split(/[;\n\r]+|[.!?](?=\s+\p{Lu})/u).map(phrases).filter(Boolean);
const matchesScope = (clause, scope) => scopeLabels(scope).every(label => mentions(clause, label));
const finishCode = /^(?:ral|ncs|рал)\s*\d{3,5}(?:[ \t]*[-–—][ \t]*[\p{L}][\p{L} -]{0,80})?[.!]?$/iu;

const measuredValues = text => [...phrases(text).matchAll(
  /(?<![\p{L}\p{N}])(?:[+-]?\d+(?:[.,]\d+)?\s*(?:мм|см|мпа|кпа|кн|м|н|квт|вт|°[сc]|%)|(?:ral|ncs|рал)\s*\d{3,5})(?![\p{L}\p{N}])/giu,
)].map(match=>match[0].replace(/\s+/gu,''));

function recordSpans(quote, scope) {
  // Keep an entity's wrapped description together only when the following part
  // is a specified qualifier and contributes no separate quantity or statement.
  // Unrelated numbered/listed records, paragraphs and semicolon groups stay apart.
  return quote.split(/;|\r?\n[ \t]*\r?\n|\r?\n[ \t]*(?=(?:[—–•-]\s|\d+[.)]\s))/u).flatMap(record=>{
    const parts = clauses(record);
    const spans = [...parts];
    for (const [index,part] of parts.entries()) {
      if (!mentions(part,scope.element)) continue;
      let span=part;
      for (const next of parts.slice(index+1,index+4)) {
        const qualifier = factScopeFields.slice(1).some(field=>
          scope[field] && !mentions(span,scope[field]) && sameLabel(next,scope[field]));
        const adjacentCode = finishCode.test(next) && measuredValues(span).length===0;
        const continues = !mentions(next,scope.element) && (qualifier || adjacentCode);
        if (!continues) break;
        span += ' '+next;
        spans.push(span);
      }
    }
    return spans;
  });
}

export function sourceDescribesFactScope(source, scope) {
  return located(source) && recordSpans(source.quote,scope).some(span=>matchesScope(span,scope));
}

function supportsScope(source, scope, witnesses, affirmative = false) {
  if (!located(source)) return false;
  const measures = affirmative ? measuredValues(source.quote) : [];
  const inScope = clause => matchesScope(clause, scope) && (!affirmative || !negatedAssignment.test(clause))
    && (!measures.length || measures.every(value=>measuredValues(clause).includes(value)));
  if (recordSpans(source.quote,scope).some(inScope)) return true;
  const excerpt = phrases(source.quote).replace(/[.!?]+$/u,'');
  return witnesses.some(witness => sameFactSourcePlace(witness, source)
    && recordSpans(witness.quote,scope).some(clause => clause.includes(excerpt) && inScope(clause)));
}

// A transfer requires both complete sets of designations in an explicit assignment.
// Nearby entries and two values that happen to be equal do not establish a transfer.
const assignment = /(?<![\p{L}\p{N}])(?:примен(?:ять|ить|яется|яются|им|има|имо|ены|ена|ен)|использ(?:овать|уется|уются|ован|ована|овано|ованы)|предусмотрен\p{L}*|распространя(?:ется|ются)|предназначен\p{L}*|относится|соответствует|adopt|apply|applies|use|used)(?![\p{L}\p{N}])/iu;
const qualified = /(?<![\p{L}\p{N}])(?:не(?!\s+(?:менее|более)(?![\p{L}\p{N}]))|нет|кроме|вместо|только|при условии|если|допускается|возможно|вопрос|уточнить|проверить|подтвердить|исключ\p{L}*|not|no|except|only|instead|if|may)(?![\p{L}\p{N}])/iu;
function explicitAssignment(source, target, observed) {
  return clauses(source.quote).some(clause => !source.quote.includes('?') && assignment.test(clause) && !qualified.test(clause)
    && matchesScope(clause, target) && matchesScope(clause, observed));
}

const differing = (target, observed) => factScopeFields.some(field =>
  target[field] && observed[field] && !sameLabel(target[field],observed[field]));
const incomplete = (target, observed) => factScopeFields.some(field => Boolean(target[field]) !== Boolean(observed[field]));

export function hasFactScopeDifference(scope) {
  return Boolean(scope?.observed && (differing(scope.target,scope.observed) || incomplete(scope.target,scope.observed)));
}

export function factScopeSources(property) {
  return property.scope?.sources ?? [];
}

export function sameFactScopeTarget(left, right) {
  const a = left.scope?.target, b = right.scope?.target;
  return Boolean(a && b && factScopeFields.every(field => sameLabel(a[field] ?? '',b[field] ?? '')));
}

export function canPreserveScopedProperty(previous, fresh) {
  if (previous.scope?.kind !== 'applicable' || !fresh.scope || fresh.scope.kind === 'applicable'
      || !sameFactScopeTarget(previous,fresh)) return false;
  // An unrelated new candidate leaves independent proof intact. A new finding at the
  // same place as an older proof requires an engineer to review that proof itself.
  return !factScopeSources(fresh).some(source => [...previous.sources,...factScopeSources(previous),
    ...(previous.response?.sources ?? [])].some(old => sameFactSourcePlace(old,source)));
}

export function missingFactScope(label) {
  const element = typeof label === 'string' && label.trim()
    ? label.trim().slice(0, factScopeLabelLimit) : 'Свойство требования';
  return {kind:'undetermined',target:{element},reason:undeterminedReason,sources:[]};
}

function verifyLiteralProperty(property, tensions) {
  const {scope} = property;
  if (property.status !== 'confirmed' || property.letter.kind !== 'omit' || property.response || tensions.length ||
      property.sources.length !== 1 || !scope.observed || hasFactScopeDifference(scope)) return;
  const [source] = property.sources;
  if (!located(source) || source.quote.trim().length > 480 || !sourceDescribesFactScope(source,scope.observed) ||
      !scope.sources.some(witness=>located(witness) && sameFactSourcePlace(witness,source)
        && phrases(witness.quote).includes(phrases(source.quote)))) return;
  return {...property,finding:'В источнике указано: «' + source.quote.trim() + '».'};
}

function literalOnly(source) {
  try { return JSON.parse(source.anchor)?.evidenceMode === literalFactBasis; }
  catch { return false; }
}

function verifyScope(property, tensions) {
  const scope = property.scope;
  const witnesses = scope.sources.filter(located);
  const primary = property.sources.filter(located);
  const support = [
    ...primary,
    ...(property.response?.sources ?? []).filter(located),
    ...tensions.flatMap(tension => [...tension.sides.flatMap(side => side.sources),...tension.resolutionSources]).filter(located),
  ];
  const observed = scope.observed;
  const affirmative = ['confirmed','conflicting'].includes(property.status);
  const different = observed && differing(scope.target, observed);
  const linked = different && witnesses.some(source => explicitAssignment(source, scope.target, observed));
  const hasObserved = observed && support.some(source => supportsScope(source, observed, witnesses));
  if (scope.kind === 'unrelated' && different && hasObserved && !linked)
    return {...scope,reason:unrelatedReason};
  const describedValues = affirmative ? measuredValues(property.finding) : [];
  const citedValues = support.flatMap(source=>measuredValues(source.quote));
  if (scope.kind === 'applicable' && hasObserved && !incomplete(scope.target, observed)
      && (!affirmative || !support.some(literalOnly)) && (!different || linked) && describedValues.every(value=>citedValues.includes(value))
      && support.every(source => supportsScope(source, observed, witnesses, affirmative)
        || linked && supportsScope(source, scope.target, witnesses, affirmative))
      && witnesses.some(source => sourceDescribesFactScope(source,observed)))
    return scope;
  return {...scope,kind:'undetermined',reason:undeterminedReason};
}

export function applyAnalysisFactApplicability(analysis) {
  const byProperty = new Map();
  for (const tension of analysis.tensions) {
    const tensions = byProperty.get(tension.propertyKey) ?? [];
    tensions.push(tension);
    byProperty.set(tension.propertyKey, tensions);
  }
  const blocked = new Set();
  const properties = analysis.properties.map(property => {
    if (!property.scope) return property;
    const alreadyHeld = property.scope.kind !== 'applicable' && property.status === 'insufficient'
      && property.finding === remit && property.letter.kind === 'omit' && !property.sources.length && !property.response;
    const tensions = byProperty.get(property.key) ?? [];
    const literal = property.scope.basis === literalFactBasis;
    const prepared = literal && property.scope.kind === 'applicable' && verifyLiteralProperty(property,tensions);
    if (prepared) return prepared;
    const scope = alreadyHeld ? property.scope
      : literal ? {...property.scope,kind:'undetermined',reason:undeterminedReason}
        : verifyScope(property,tensions);
    if (scope.kind === 'applicable') return property;
    blocked.add(property.key);
    // Keep the addressed observation as context, and suppress every downstream use as evidence.
    const candidates = [...scope.sources, ...property.sources, ...(property.response?.sources ?? []),
      ...(byProperty.get(property.key) ?? []).flatMap(tension => [
        ...tension.sides.flatMap(side => side.sources), ...tension.resolutionSources,
      ])];
    const sources = unionSources(candidates, 12);
    const {response, ...remainder} = property;
    return {...remainder,scope:{...scope,sources},status:'insufficient',finding:remit,sources:[],
      letter:{kind:'omit',text:remit}};
  });
  return properties.some((property,index)=>property!==analysis.properties[index])
    ? {...analysis,properties,tensions:analysis.tensions.filter(tension => !blocked.has(tension.propertyKey))} : analysis;
}

export function hasUnverifiedFactScope(row) {
  return row.analysis?.properties.some(property => property.scope && property.scope.kind !== 'applicable') ?? false;
}

export function sheetPreviewSources(sources) {
  return (sources ?? []).filter(source=>{
    if (source.quote || typeof source.anchor!=='string') return false;
    try {
      const preview=JSON.parse(source.anchor)?.sheetPreview;
      return typeof preview?.sha256==='string' && preview.sha256.length===64 && /^[a-f0-9]{64}$/u.test(preview.sha256)
        && ['observed','inconclusive','unreadable'].includes(preview.state);
    } catch { return false; }
  });
}

function unionSources(sources, limit) {
  return [...new Map(sources.map(source => [
    JSON.stringify([source.versionId, source.originalSha256, source.anchor, source.quote, source.limitation]), source,
  ])).values()].slice(0, limit);
}

function scopedSummary(properties) {
  const selected = properties.map(({label,finding}) => label + '. ' + finding.trim());
  const first = selected.shift() ?? '';
  return selected.reduce((summary, text) => summary.length + text.length + 2 <= 800
    ? summary + '  ' + text : summary, first);
}

export function applyFactApplicability(row, {requireFactScope = false} = {}) {
  if (!row.analysis) return row;
  let analysis = applyAnalysisFactApplicability(row.analysis);
  const propertyEvidence = property => [...property.sources,...analysis.tensions
    .filter(tension=>tension.propertyKey===property.key && tension.status==='open')
    .flatMap(tension=>tension.sides.flatMap(side=>side.sources))];
  const scoped = analysis.properties.filter(property=>property.scope?.kind==='applicable' && propertyEvidence(property).some(located));
  const material = scoped.filter(property=>['confirmed','conflicting'].includes(property.status));
  const positiveRow = ['present','partial'].includes(row.status) && analysis.applicability.kind !== 'excluded';
  if (requireFactScope && positiveRow && !scoped.length && !hasUnverifiedFactScope({...row,analysis})) {
    const label = missingFactScope(row.title ?? row.key).target.element;
    const property = {key:'scope_for_requirement',label,status:'insufficient',finding:remit,sources:[],
      scope:{...missingFactScope(label),sources:row.sources.slice(0,12)},letter:{kind:'omit',text:remit}};
    const properties = [...analysis.properties.filter(item => item.key !== property.key).slice(0,15),property];
    const keys = new Set(properties.map(property => property.key));
    analysis = {...analysis,properties,tensions:analysis.tensions.filter(tension => keys.has(tension.propertyKey))};
  }
  if (hasUnverifiedFactScope({...row,analysis})) {
    const sources = unionSources([...sheetPreviewSources(row.sources),...analysis.applicability.sources,
      ...scoped.flatMap(propertyEvidence)],100);
    const hasPartial = material.length || scoped.length && (row.status==='partial' || !requireFactScope && positiveRow);
    const status = hasPartial ? 'partial' : 'unassessed';
    return {...row,analysis,status,sources,finding:rowFinding};
  }
  if (scoped.length && analysis.applicability.kind !== 'excluded') {
    const sources = unionSources([...sheetPreviewSources(row.sources),...analysis.applicability.sources,
      ...scoped.flatMap(propertyEvidence)],100);
    const assessed = material.some(property=>property.status==='confirmed' && property.scope.basis!==literalFactBasis);
    const complete = assessed && analysis.applicability.kind==='included' &&
      analysis.properties.every(property=>property.status==='confirmed');
    const status = row.status==='present' && !complete ? (material.length ? 'partial' : 'unassessed')
      : row.status==='unassessed' && material.length ? 'partial' : row.status;
    return {...row,analysis,status,sources,finding:scopedSummary(scoped)};
  }
  return row;
}
