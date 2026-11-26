import {analysisSources, mergeSources, renderQuestions} from './review-analysis.mjs';

const hasFinding = row => ['present','partial'].includes(row.status) && row.sources.some(source => source.quote);
const identity = text => text.trim().toLocaleLowerCase('ru').replaceAll('ё','е');
const sameProperty = (left, right) => left.key === right.key || identity(left.label) === identity(right.label);
function sameAddressedGap(older,newer) {
  if (older.status!=='insufficient' || newer.status!=='insufficient' || older.letter.kind!=='ask' || newer.letter.kind!=='ask') return false;
  const gap=property=>{
    const clause=identity(property.finding).split(';').at(-1).trim();
    if (!/(?:^|\s)не (?:определ|раскры|указ|представ|установ|подтвержд|привед)/u.test(clause)) return '';
    return clause.match(/^(.{8,100}?)(?: в (?:переданн|приведенн|доступн|представленн|исследованн)| не )/u)?.[1] ?? '';
  };
  if (!gap(older) || gap(older)!==gap(newer)) return false;
  const stems=label=>new Set(identity(label).match(/[а-яa-z]{4,}/gu)?.map(word=>word.slice(0,4)));
  const left=stems(older.label),right=stems(newer.label);
  if ([...left].filter(word=>right.has(word)).length<2 ||
      String(older.label.match(/\d+/g))!==String(newer.label.match(/\d+/g))) return false;
  return older.sources.some(a=>newer.sources.some(b=>a.versionId===b.versionId && a.anchor===b.anchor &&
    a.originalSha256===b.originalSha256 && a.quote && b.quote && (a.quote.includes(b.quote) || b.quote.includes(a.quote))));
}
const substantive = new Set(['confirmed','conflicting','unanswered']);

function preserveProperties(current, previous, inInventory) {
  if (!current || !previous || current.applicability.kind === 'excluded') return current;
  const properties = [...current.properties], tensions = [...current.tensions];
  for (const old of previous.properties) {
    const missingOpenQuestion=old.letter.kind==='ask' && !properties.some(property=>sameProperty(property,old) || sameAddressedGap(old,property));
    if (!substantive.has(old.status) && !old.response && !missingOpenQuestion) continue;
    const priorTensions = previous.tensions.filter(tension => tension.propertyKey === old.key);
    if (![...old.sources,...(old.response?.sources ?? []),...priorTensions.flatMap(tension => [
      ...tension.sides.flatMap(side => side.sources), ...tension.resolutionSources,
    ])].every(inInventory)) continue;
    const existing = properties.findIndex(property => sameProperty(property,old));
    const fresh = properties[existing];
    const freshTensions = tensions.filter(tension => tension.propertyKey === fresh?.key);
    const priorDisputed = old.status === 'conflicting';
    const explicitlyResolved = freshTensions.some(tension => tension.status === 'resolved');
    const directlyUpdated = fresh && (fresh.status === 'confirmed' || fresh.response || freshTensions.length ||
      old.status === 'unanswered' && fresh.status === 'unanswered');
    if (fresh && (fresh.status === 'conflicting' || explicitlyResolved || !priorDisputed && directlyUpdated)) continue;
    if ((!fresh && properties.length >= 16) || tensions.length + priorTensions.length > 12) continue;
    const property = fresh ? {...old,key:fresh.key} : old;
    if (priorTensions.some(tension => tensions.some(other => other.key === tension.key))) continue;
    if (fresh) properties[existing] = property; else properties.push(property);
    tensions.push(...priorTensions.map(tension => ({...tension,propertyKey:property.key})));
  }
  return {...current,properties,tensions};
}

// The new result is based on a bounded selection. Keep material findings against the same
// originals when the selection cannot revisit them, separately displaying earlier row wording.
export function reconcilePreliminaryReview(input, previousRows = []) {
  if (!input.rows.some(row => row.analysis)) return input;
  const originals = new Map(input.inventory.map(original => [original.versionId,original.originalSha256]));
  const inInventory = source => originals.get(source.versionId) === source.originalSha256;
  const previousByKey = new Map(previousRows.map(row => [row.key,row]));
  const rows = input.rows.map(row => {
    const previous = previousByKey.get(row.key);
    if (!row.analysis || !previous) return row;
    const analysis = preserveProperties(row.analysis,previous.analysis,inInventory);
    const established = hasFinding(previous)
      ? {status:previous.status,finding:previous.finding,sources:previous.sources} : previous.retained;
    const retained = previous.retained ?? established;
    if (row.status === 'unassessed' && !row.sources.length && analysis.applicability.kind !== 'excluded' &&
        established?.sources.every(inInventory)) {
      return {...row,...established,analysis,retained:established};
    }
    const currentSources = mergeSources(row.sources,analysisSources(analysis));
    const sourceKeys = new Set(currentSources.map(source => JSON.stringify([source.versionId,source.anchor,source.quote])));
    const currentSupportsRetained = retained?.sources.every(source =>
      sourceKeys.has(JSON.stringify([source.versionId,source.anchor,source.quote])));
    const keepEarlierFinding = retained && retained.sources.every(inInventory) &&
      (row.status === 'unassessed' || !currentSupportsRetained && retained.finding !== row.finding);
    return {...row,analysis,...(keepEarlierFinding && {retained})};
  });
  return {...input,rows,draftText:renderQuestions(rows)};
}
