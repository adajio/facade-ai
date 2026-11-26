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

function preserveProperties(current, previous, inInventory, positiveOnly) {
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
    if (positiveOnly && fresh) continue;
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

const absence = /(?:^|[^\p{L}])(?:отсутств\p{L}*|нет|не(?!\s+(?:менее|более|ниже|выше)(?:\s|$))|неизвест\p{L}*|без|not|no|missing|absent|without)(?:$|[^\p{L}])/iu;
const affirmed = /(?:^|[^\p{L}])(?<!не )(?:найден|указан|приведен|представлен|обнаружен|подтвержден|предусмотрен|зафиксирован|обозначен|содерж|имеется|есть|требует)\p{L}*/iu;
const exactSource = source => typeof source.anchor === 'string' && source.anchor.trim() &&
  typeof source.quote === 'string' && source.quote.trim() && !source.limitation;
const historicalFinding = entry => {
  if (!entry || !['present','partial'].includes(entry.status) || !entry.finding?.trim() ||
      !entry.sources?.length || !entry.sources.every(exactSource)) return;
  const wording = identity(entry.finding).replace(/\s+/gu,' ');
  if (absence.test(wording) && !affirmed.test(wording)) return;
  // Keep the old wording and its qualifications together, only as recorded history.
  return {status:entry.status,finding:entry.finding,sources:entry.sources};
};

function priorPositive(older) {
  if (older.status === 'not_found' || older.analysis?.applicability.kind === 'excluded') return {};
  const oldAnalysis = older.analysis;
  const properties = oldAnalysis?.properties.flatMap(property => {
    if (property.status !== 'confirmed' || absence.test(property.finding) || property.letter.kind !== 'omit' ||
        !property.sources.length || !property.sources.every(exactSource)) return [];
    const {response,...value} = property;
    return [{...value,...(response?.state === 'received' && !absence.test(response.finding) &&
      response.sources.every(exactSource) && {response})}];
  });
  return {
    finding: oldAnalysis?.tensions.some(tension => tension.status === 'open') ? undefined :
      historicalFinding(older) ?? historicalFinding(older.retained),
    analysis: oldAnalysis && {...oldAnalysis,properties,tensions:[]},
  };
}

// The new result is based on a bounded selection. Keep material findings against the same
// originals when the selection cannot revisit them, separately displaying earlier row wording.
export function reconcilePreliminaryReview(input, previousRows = [], admittedVersions) {
  if (!input.rows.some(row => row.analysis)) return input;
  const originals = new Map(input.inventory.map(original => [original.versionId,original.originalSha256]));
  const inInventory = source => originals.get(source.versionId) === source.originalSha256 &&
    (!admittedVersions || admittedVersions.has(source.versionId));
  const previousByKey = new Map(previousRows.map(row => [row.key,row]));
  const rows = input.rows.map(row => {
    const previous = previousByKey.get(row.key);
    if (!row.analysis || !previous) return row;
    if (admittedVersions) {
      if (row.status === 'not_found' || row.analysis.applicability.kind === 'excluded' ||
          row.analysis.tensions.some(tension => tension.status === 'open')) return row;
      const {finding,analysis:olderAnalysis} = priorPositive(previous);
      const analysis = preserveProperties(row.analysis,olderAnalysis,inInventory,true);
      const hasNewAssessment = row.analysis.tensions.length ||
        row.analysis.properties.some(property => property.status === 'confirmed' || property.response);
      if (!row.retained && row.status === 'unassessed' && !hasNewAssessment &&
          finding?.sources.every(inInventory)) return {...row,analysis,retained:finding};
      const carried = analysis.properties.filter(property => !row.analysis.properties.includes(property));
      if (!carried.length) return row;
      const retained = row.retained ?? {status:'partial',finding:carried.map(property => property.finding).join('\n'),
        sources:mergeSources(...carried.map(property => [...property.sources,...(property.response?.sources ?? [])])).slice(0,100)};
      return {...row,analysis,retained};
    }
    const analysis = preserveProperties(row.analysis,previous.analysis,inInventory);
    const established = hasFinding(previous)
      ? {status:previous.status,finding:previous.finding,sources:previous.sources} : undefined;
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
  if (admittedVersions && rows.every((row,index) => row === input.rows[index])) return input;
  return {...input,rows,draftText:renderQuestions(rows)};
}

export async function recoverPreparationFindings(db, input, stage = input.stage) {
  if (!input.preparationId || !stage || !input.rows.some(row => row.analysis)) return input;
  const inventory = input.inventory.map(({versionId,originalSha256}) => ({versionId,originalSha256}))
    .sort((a,b) => a.versionId.localeCompare(b.versionId));
  const {rows:[previous]} = await db.query(`WITH current AS (
      SELECT prep.id,prep.revision,prep.project_id,prep.receipt_id
      FROM intake_package_preparation_current cur JOIN intake_package_preparations prep ON prep.id=cur.manifest_id
      JOIN projects p ON p.id=cur.project_id
      WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3 AND p.catalog_version_id=$4 AND p.project_stage=$5
    ), prior_preparation AS (
      SELECT prep.id,prep.project_id,prep.receipt_id FROM current
      JOIN intake_package_preparations prep ON prep.project_id=current.project_id AND prep.receipt_id=current.receipt_id
        AND prep.revision<current.revision
      ORDER BY prep.revision DESC LIMIT 1
    ), prior_report AS (
      SELECT pr.rows,pr.inventory,pr.stage,pr.catalog_version_id FROM prior_preparation prep
      JOIN preliminary_package_reviews pr ON pr.preparation_id=prep.id AND pr.project_id=prep.project_id AND pr.receipt_id=prep.receipt_id
      ORDER BY pr.created_at DESC,pr.id DESC LIMIT 1
    )
    SELECT prior_report.rows,ARRAY(
      SELECT before.version_id FROM prior_preparation
      JOIN intake_package_preparation_items before ON before.manifest_id=prior_preparation.id
        AND before.project_id=prior_preparation.project_id
      JOIN intake_package_preparation_items now ON now.manifest_id=$3 AND now.project_id=before.project_id
        AND now.version_id=before.version_id AND now.map_fingerprint=before.map_fingerprint
    ) AS "admittedVersions"
    FROM prior_report WHERE prior_report.catalog_version_id=$4 AND prior_report.stage=$5 AND prior_report.inventory=$6::jsonb`,
  [input.projectId,input.receiptId,input.preparationId,input.catalogVersionId,stage,JSON.stringify(inventory)]);
  if (!previous?.admittedVersions.length) return input;
  return reconcilePreliminaryReview(input,previous.rows,new Set(previous.admittedVersions));
}
