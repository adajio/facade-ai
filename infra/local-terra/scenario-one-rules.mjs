// The model extracts evidence. This code owns the checklist and the draft.
const clean = value => value.trim().replace(/\s+/gu, ' ');
const fold = value => clean(value).normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function checklistTargets(requirements) {
  return requirements.flatMap(requirement => (requirement.evidenceRule?.allOf ?? []).map(({anyOf}, index) => ({
    id: requirement.key + '/' + index,
    key: requirement.key,
    title: requirement.part,
    notes: requirement.completenessCriterion,
    alternatives: anyOf.filter(option => option.sourceRole !== 'inventory'),
  })));
}

export function collectEvidence(targets, lines, output, kind) {
  const byId = new Map(lines.map(line => [line.id, line]));
  const allowed = new Map(targets.map(target => [target.id, target]));
  if (!output || !Array.isArray(output.evidence) || output.evidence.length > 160) return null;
  const evidence = output.evidence.flatMap(entry => {
    const target = allowed.get(entry?.target);
    const line = byId.get(entry?.line);
    const {quote, value, subject} = entry ?? {};
    if (!target || !line || typeof quote !== 'string' || !quote.trim() || quote.length > 800 || !line.text.includes(quote)) return [];
    if (!target.alternatives.some(option => option.sourceRole === entry.role && option.mode === kind)) return [];
    if (kind === 'value' && (typeof value !== 'string' || value.length > 180 || !value.trim() || !quote.includes(value) ||
        typeof subject !== 'string' || !subject.trim() || subject.length > 100 || !quote.includes(subject))) return [];
    return [{target:target.id, role:entry.role, quote, ...(kind === 'value' && {value,subject}) ,
      source:{versionId:line.versionId, originalSha256:line.originalSha256, anchor:line.anchor, quote}}];
  });
  return {evidence, rejected:evidence.length !== output.evidence.length};
}

// Criticality of the mapped positions from the September checklist (F01, P02, F02, P06, I01).
const requiredCritical = new Set(['doc.facades','doc.floor_plans','doc.sections','doc.architecture','data.cladding']);
const optionalRequests = new Set(['doc.revit','doc.thermal']);
const requiredFormats = new Map([
  ['doc.colors',['pdf']],
  ['doc.glazing',['dwg']],
]);
const draftLabels = new Map([
  ['doc.glazing', 'ведомость и установочные узлы СПК'],
  ['doc.facade_brief', 'подписанное техническое задание на проектирование НВФ'],
]);

export function evaluateChecklist(requirements, evidence, files, coverageComplete) {
  const targets = checklistTargets(requirements);
  const byVersion = new Map(files.map(file => [file.versionId, file]));
  const rows = [];
  const requests = [];
  for (const requirement of requirements) {
    const positions = targets.filter(target => target.key === requirement.key);
    const targetsById = new Set(positions.map(position => position.id));
    const extra = evidence.filter(item => item.target === 'facts/'+requirement.key && byVersion.has(item.source.versionId));
    const accepted = evidence.filter(item => targetsById.has(item.target) && byVersion.has(item.source.versionId));
    const formats = new Set(requiredFormats.get(requirement.key) ?? [...(requirement.formats ?? []), ...(requirement.equivalents ?? [])]);
    const matches = accepted.filter(item => !formats.size || formats.has(byVersion.get(item.source.versionId).format));
    const confirmed = new Set(matches.map(item => item.target));
    const missing = positions.filter(position => !confirmed.has(position.id));
    const values = new Map();
    for (const item of matches.filter(x => x.value)) {
      const scope = JSON.stringify([item.target, fold(item.subject)]);
      const variants = values.get(scope) ?? new Set();
      variants.add(fold(item.value));
      values.set(scope, variants);
    }
    const conflict = [...values.values()].some(variants => variants.size > 1);
    const allFound = positions.length > 0 && !missing.length && !conflict;
    const status = allFound ? 'present' : accepted.length ? 'partial' :
      coverageComplete && positions.length ? 'not_found' : 'unassessed';
    const sources = [...new Map([...accepted,...extra].map(item => [JSON.stringify(item.source), item.source])).values()].slice(0, 100);
    const details = [...new Set([...matches,...extra].filter(item => item.value).map(item => clean(item.subject) + ' — ' + clean(item.value)))];
    const absent = [...new Set(missing.flatMap(item => item.alternatives.map(option => option.subject).filter(Boolean)))];
    const wrongFormat = !matches.length && accepted.length > 0;
    const approved = status === 'not_found' || conflict || wrongFormat || status === 'partial' && coverageComplete;
    const name = draftLabels.get(requirement.key) ?? requirement.part;
    const action = conflict ? 'Просим уточнить расхождение по позиции «' + name + '».' :
      wrongFormat ? 'Просим направить «' + name + '» в формате ' + [...formats].map(format => format.toUpperCase()).join(' или ') + '.' :
      absent.length && accepted.length ? 'Просим уточнить по позиции «' + name + '» следующие сведения: ' + absent.join(', ') + '.' :
      'Просим предоставить «' + name + '».';
    const description = conflict ? 'По одному обозначению извлечены разные значения. Требуется сверка областей применения.' :
      wrongFormat ? 'Подходящие сведения найдены, формат отличается от предусмотренного чек-листом.' :
      allFound ? 'Найдены сведения по всем правилам наличия и значения.' :
      status === 'partial' ? 'Подтверждена часть сведений.' :
      status === 'not_found' ? 'В классифицированных материалах позиция не найдена.' :
      'Нужная позиция не установлена по доступному тексту.';
    rows.push({key:requirement.key,status,finding:[description,...details.slice(0,16)].join(' '),sources});
    if (approved) requests.push({key:requirement.key,critical:requiredCritical.has(requirement.key),optional:optionalRequests.has(requirement.key),text:action});
  }
  return {rows,requests};
}

export function composeScenarioOneDraft(requests, objectName, covered) {
  if (!requests.length) return covered
    ? 'Вопросов по итогам проверки чек-листа нет.'
    : 'Черновик запроса пока пуст. Проверьте неоценённые позиции и ограничения чтения.';
  const sections = [
    ['Для начала проектирования просим предоставить или уточнить:', requests.filter(item => item.critical)],
    ['Также просим предоставить или уточнить:', requests.filter(item => !item.critical && !item.optional)],
    ['При наличии просим направить:', requests.filter(item => item.optional)],
  ];
  return ['Добрый день!', 'Объект: ' + clean(objectName) + '.',
    ...sections.flatMap(([heading,items]) => items.length ? [heading,items.map((item,index) => (index+1) + '. ' + item.text).join('\n')] : []),
    'С уважением,'].join('\n\n');
}
