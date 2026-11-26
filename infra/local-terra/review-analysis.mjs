import {
  applyAnalysisFactApplicability, factScopeFields, factScopeKinds, factScopeLabelLimit,
  factScopeReasonLimit, factScopeSources, missingFactScope,
} from './fact-applicability.mjs';

export const applicabilityKinds = ['included', 'excluded', 'undetermined'];
export const propertyStatuses = ['confirmed', 'unanswered', 'not_mentioned', 'insufficient', 'conflicting'];
export const responseStates = ['received', 'not_received'];
export const tensionStatuses = ['open', 'resolved'];
export const noOpenQuestions = 'По доступным основаниям адресных вопросов для письма не установлено.';
export const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const textSchema = maxLength => ({type:'string',minLength:1,maxLength});
const enumSchema = values => ({type:'string',enum:values});
const arraySchema = (items, maxItems, minItems=0) => ({type:'array',items,maxItems,minItems});
export const record = (properties, optional = []) => ({type:'object',properties,
  required:Object.keys(properties).filter(key => !optional.includes(key)),additionalProperties:false});
const keySchema = {type:'string',pattern:'^[a-z][a-z0-9_-]{0,49}$'};
export const citationSchema = arraySchema(record({id:textSchema(80),quote:textSchema(4000)}), 12);

export function analysisFields(references, {requireFactScope = false} = {}) {
  const scopeSide = record(Object.fromEntries(factScopeFields.map(field => [field,textSchema(factScopeLabelLimit)])),
    factScopeFields.slice(1));
  const scope = record({kind:enumSchema(factScopeKinds),target:scopeSide,observed:scopeSide,
    reason:textSchema(factScopeReasonLimit),...references},['observed']);
  const applicability = record({kind:enumSchema(applicabilityKinds),reason:textSchema(420),...references});
  const properties = arraySchema(record({
    key:keySchema,label:textSchema(120),status:enumSchema(propertyStatuses),finding:textSchema(550),
    scope,...references,response:{anyOf:[record({state:enumSchema(responseStates),finding:textSchema(350),...references}),{type:'null'}]},
    letter:record({kind:enumSchema(['ask','omit']),text:textSchema(350)}),
  },requireFactScope ? ['response'] : ['response','scope']), 16);
  const tensions = arraySchema(record({
    key:keySchema,propertyKey:keySchema,status:enumSchema(tensionStatuses),finding:textSchema(550),
    sides:arraySchema(record({text:textSchema(350),...references}),4,2),
    ...(references.citations ? {resolutionCitations:references.citations} : {resolutionIds:references.ids}),
  }), 12);
  return {applicability,properties,tensions};
}

const keyOk = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,49}$/.test(value);
const list = (value, max, min=0) => Array.isArray(value) && value.length >= min && value.length <= max;
const sourcePlace = source => JSON.stringify([source.versionId,source.anchor]);
const located = sources => sources.filter(source => validText(source.quote,4000) && !source.limitation);

export function checkAnalysis(analysis, check) {
  const {applicability,properties,tensions} = analysis ?? {};
  check(applicabilityKinds.includes(applicability?.kind) && validText(applicability.reason,420), 'invalid_review_applicability');
  check(applicability.kind !== 'excluded' || located(applicability.sources).length > 0, 'exclusion_without_evidence');
  check(list(properties,16) && list(tensions,12), 'invalid_review_analysis');
  const byProperty = new Map(), tensionKeys = new Set(), open = new Set();
  for (const property of properties) {
    check(keyOk(property?.key) && !byProperty.has(property.key) && validText(property.label,120)
      && propertyStatuses.includes(property.status) && validText(property.finding,550), 'invalid_review_property');
    const supported = located(property.sources).length > 0;
    const response = property.response;
    if (response) {
      check(responseStates.includes(response.state) && validText(response.finding,350) && located(response.sources).length > 0,
        'response_without_evidence');
      check(response.state !== 'received' || property.status !== 'unanswered','received_response_marked_unanswered');
      check(response.state !== 'not_received' || property.status !== 'not_mentioned','unreceived_response_marked_unmentioned');
    }
    check(!['confirmed','unanswered'].includes(property.status) || supported,'property_without_evidence');
    check(['ask','omit'].includes(property.letter?.kind) && validText(property.letter.text,350),'invalid_review_letter');
    check(property.letter.kind !== 'ask' || (applicability.kind !== 'excluded'
      && property.status !== 'confirmed' && (supported || response || property.status === 'conflicting')), 'question_without_open_evidence');
    byProperty.set(property.key, property);
  }
  for (const tension of tensions) {
    check(keyOk(tension?.key) && !tensionKeys.has(tension.key) && byProperty.has(tension.propertyKey)
      && tensionStatuses.includes(tension.status) && validText(tension.finding,550) && list(tension.sides,4,2), 'invalid_review_tension');
    const distinct = new Set();
    for (const side of tension.sides) {
      const places = located(side.sources).map(sourcePlace);
      check(validText(side.text,350) && places.length > 0 && places.every(place => !distinct.has(place)), 'tension_without_distinct_sides');
      for (const place of places) distinct.add(place);
    }
    check(tension.status !== 'resolved' || located(tension.resolutionSources).length > 0, 'tension_without_resolution');
    check(tension.status !== 'open' || tension.resolutionSources.length === 0, 'open_tension_with_resolution');
    if (tension.status === 'open') open.add(tension.propertyKey);
    tensionKeys.add(tension.key);
  }
  for (const property of properties) {
    check((property.status === 'conflicting') === open.has(property.key), 'unlinked_review_tension');
  }
  return analysis;
}

export function readAnalysis(raw, resolve, check, options) {
  check(raw?.applicability && list(raw.properties,16) && list(raw.tensions,12), 'invalid_review_analysis');
  const {kind,reason,citations} = raw.applicability;
  const analysis = {
    applicability:{kind,reason,sources:resolve(citations)},
    properties:raw.properties.map(property => readProperty(property, resolve, check, options)),
    tensions:raw.tensions.map(tension => readTension(tension, resolve, check)),
  };
  return checkAnalysis(applyAnalysisFactApplicability(analysis),check);
}

function readScopeSide(value, check) {
  check(value && typeof value === 'object' && validText(value.element,factScopeLabelLimit)
    && Object.keys(value).every(field => factScopeFields.includes(field) && validText(value[field],factScopeLabelLimit)),
  'invalid_fact_scope_side');
  return Object.fromEntries(factScopeFields.filter(field => value[field] !== undefined).map(field => [field,value[field].trim()]));
}

function readScope(raw, resolve, check) {
  const {kind,target,observed,reason} = raw;
  check(factScopeKinds.includes(kind) && validText(reason,factScopeReasonLimit), 'invalid_fact_scope');
  return {kind,target:readScopeSide(target,check),...(observed && {observed:readScopeSide(observed,check)}),
    reason,sources:resolve(raw.citations ?? raw.ids)};
}

export function readProperty(property, resolve, check, {requireFactScope = false} = {}) {
  check(property && typeof property === 'object', 'invalid_review_property');
  const {key,label,status,finding,letter,response} = property;
  check(keyOk(key) && validText(label,120) && propertyStatuses.includes(status) && validText(finding,550),
    'invalid_review_property');
  check(['ask','omit'].includes(letter?.kind) && validText(letter.text,350),'invalid_review_letter');
  check(response == null || typeof response === 'object','invalid_review_response');
  const scope = property.scope ? readScope(property.scope,resolve,check) : requireFactScope ? missingFactScope(label) : undefined;
  return {key,label,status,finding,sources:resolve(property.citations ?? property.ids),...(scope && {scope}),
    ...(response && {response:{
      state:response.state,finding:response.finding,sources:resolve(response.citations ?? response.ids),
    }}), letter:{kind:letter.kind,text:letter.text}};
}

export function readTension(tension, resolve, check) {
  check(tension && list(tension.sides,4,2), 'invalid_review_tension');
  const {key,propertyKey,status,finding} = tension;
  return {key,propertyKey,status,finding,sides:tension.sides.map(side => {
    check(side && typeof side === 'object', 'invalid_review_tension');
    return {text:side.text,sources:resolve(side.citations ?? side.ids)};
  }),resolutionSources:resolve(tension.resolutionCitations ?? tension.resolutionIds)};
}

export function analysisSources(analysis) {
  return [ ...analysis.applicability.sources,
    ...analysis.properties.flatMap(property => [...property.sources,...(property.response?.sources ?? []),...factScopeSources(property)]),
    ...analysis.tensions.flatMap(tension => [...tension.sides.flatMap(side => side.sources), ...tension.resolutionSources]) ];
}

export function mergeSources(...groups) {
  return [...new Map(groups.flat().map(source => [
    JSON.stringify([source.versionId,source.originalSha256,source.anchor,source.quote,source.limitation]),source,
  ])).values()];
}

export function renderQuestions(rows) {
  const questions = rows.flatMap(row => (row.analysis?.properties ?? []).flatMap(property =>
    property.letter.kind === 'ask' && (!property.scope || property.scope.kind === 'applicable') ? [`${row.title ?? row.key} — ${property.label}. ${property.letter.text.trim()}`] : []));
  return questions.join('\n\n') || noOpenQuestions;
}
