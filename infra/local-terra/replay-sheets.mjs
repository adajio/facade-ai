import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validatedPartial } from './partial-result.mjs';
import { atomicWrite, parseModelResponse } from './producer.mjs';
import { mergeSelection, reassessmentKey } from './reassessment.mjs';
import { emitActivity } from './request-budget.mjs';
import { renderQuestions } from './review-analysis.mjs';
import { loadReport } from './revise.mjs';

const maxLineage = 128;
const supportedProfiles = ['sheet_applicability_v1','sheet_applicability_v2'];
const replayNote = 'Консервативно переопубликован сохранённый ответ по графическим участкам. Последующие адресные изменения сохранены.';
const sourceKey = source => JSON.stringify([
  source.versionId, source.originalSha256, source.anchor, source.quote ?? null, source.limitation ?? null,
]);
const propertyKey = item => item.key;

// Publisher adds original-document labels to sources. Ignore only this display metadata when comparing.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key,item]) => item!==undefined && (!value.anchor || !['documentId','label'].includes(key)))
    .map(([key,item]) => [key,comparable(item)]));
}
const equal = (first,second) => isDeepStrictEqual(comparable(first),comparable(second));
const choose = (before,after,corrected) => equal(before,after) ? corrected : after;

async function read(path) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch (error) {
    if (error.code==='ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function inventoryPins(inventory) {
  return inventory.map(item => [item.versionId,item.originalSha256]).sort(([a],[b]) => a.localeCompare(b));
}

async function readMapPins(db,scope) {
  const {rows:[row]} = await db.query(`/* replay_sheet_maps */
    SELECT prep.manifest->'items' items
    FROM intake_package_preparation_current cur
    JOIN intake_package_preparations prep ON prep.id=cur.manifest_id AND prep.project_id=cur.project_id
      AND prep.receipt_id=cur.receipt_id
    WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3
      AND NOT EXISTS (SELECT 1 FROM intake_package_preparation_items pin
        WHERE pin.manifest_id=cur.manifest_id AND pin.project_id=cur.project_id
        AND NOT EXISTS (SELECT 1 FROM harness_package_maps map WHERE map.project_id=pin.project_id
          AND map.version_id=pin.version_id AND map.fingerprint=pin.map_fingerprint AND map.active))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prep.manifest->'items') item
        WHERE item->>'kind'='document' AND item->>'state'='available'
          AND NOT EXISTS (SELECT 1 FROM intake_package_preparation_items pin
            WHERE pin.manifest_id=cur.manifest_id AND pin.project_id=cur.project_id
              AND pin.version_id::text=item->>'versionId' AND pin.map_fingerprint=item->>'mapFingerprint'))`,
    [scope.projectId,scope.receiptId,scope.preparationId]);
  return row?.items;
}

function sameReaders(snapshot,items) {
  if (!Array.isArray(items) || !Array.isArray(snapshot.indexCursor)) return false;
  const expected = new Map(items.filter(item => item.kind==='document' && item.state==='available')
    .map(item => [item.versionId,item.readerVersion]));
  const captured = new Map(snapshot.indexCursor.map(pin => [pin.versionId,pin.readerVersion]));
  return expected.size===snapshot.indexCursor.length && isDeepStrictEqual(expected,captured);
}

async function readLineage(db,scope,report,stopId) {
  return (await db.query(`/* replay_sheet_lineage */
    WITH RECURSIVE lineage AS (
      SELECT id,previous_report_id,revision_key,rows,0 AS depth,ARRAY[id] AS path
      FROM preliminary_package_reviews
      WHERE id=$1 AND project_id=$2 AND receipt_id=$3 AND preparation_id=$4
        AND catalog_version_id=$5 AND stage=$6 AND inventory=$7::jsonb
      UNION ALL
      SELECT r.id,r.previous_report_id,r.revision_key,r.rows,l.depth+1,l.path || r.id
      FROM lineage l JOIN preliminary_package_reviews r ON r.id=l.previous_report_id
      WHERE l.id<>$8 AND l.depth<$9 AND NOT (r.id=ANY(l.path))
        AND r.project_id=$2 AND r.receipt_id=$3 AND r.preparation_id=$4
        AND r.catalog_version_id=$5 AND r.stage=$6 AND r.inventory=$7::jsonb
    )
    SELECT id,previous_report_id AS "parentId",revision_key AS "revisionKey",rows FROM lineage ORDER BY depth`,
    [report.reportId,scope.projectId,scope.receiptId,scope.preparationId,scope.catalogVersionId,scope.stage,
      JSON.stringify(report.inventory),stopId,maxLineage])).rows;
}

function applyChanges(before, after, corrected, key) {
  const original = new Map(before.map(item => [key(item),item]));
  const latest = new Map(after.map(item => [key(item),item]));
  const result = new Map(corrected.map(item => [key(item),item]));
  for (const [id,item] of original) {
    if (!latest.has(id)) result.delete(id);
    else if (!equal(item,latest.get(id))) result.set(id,latest.get(id));
  }
  for (const [id,item] of latest) {
    if (!original.has(id)) result.set(id,item);
  }
  return [...result.values()];
}

function applyRevision(before, after, corrected) {
  if (equal(before,after)) return corrected;
  if (!before.analysis || !after.analysis || !corrected.analysis ||
      before.analysis.applicability.kind!==after.analysis.applicability.kind ||
      before.status!==after.status && after.status==='not_found') return after;
  const properties = applyChanges(before.analysis.properties,after.analysis.properties,corrected.analysis.properties,propertyKey);
  const keys = new Set(properties.map(propertyKey));
  const tensions = applyChanges(before.analysis.tensions,after.analysis.tensions,corrected.analysis.tensions,propertyKey)
    .filter(item => keys.has(item.propertyKey));
  return {
    ...corrected,
    finding:choose(before.finding,after.finding,corrected.finding),
    status:choose(before.status,after.status,corrected.status),
    retained:choose(before.retained,after.retained,corrected.retained),
    sources:applyChanges(before.sources,after.sources,corrected.sources,sourceKey),
    analysis:{
      applicability:choose(before.analysis.applicability,after.analysis.applicability,corrected.analysis.applicability),
      properties,tensions,
    },
  };
}

function preserveDescendants(corrected, trail) {
  let rows = corrected;
  for (let i = 1; i < trail.length; i++) {
    const previous = new Map(trail[i-1].rows.map(row => [row.key,row]));
    const current = new Map(trail[i].rows.map(row => [row.key,row]));
    if (previous.size!==rows.length || current.size!==rows.length ||
        !rows.every(row => previous.has(row.key) && current.has(row.key))) return;
    rows = rows.map(row => applyRevision(previous.get(row.key),current.get(row.key),row));
  }
  if (rows.some(row => row.sources.length>100 || row.analysis?.properties.length>16 ||
      row.analysis?.tensions.length>12 || ['present','partial'].includes(row.status) && !row.sources.length)) return;
  return rows;
}

export async function replaySavedSheets(run,scope,key,base) {
  const profile = supportedProfiles.find(name => reassessmentKey(scope,'replay_'+name)===key);
  if (!profile) return 'sheet_replay_profile_unknown';
  const notePath = base+'.done';
  const prior = await read(notePath);
  if (prior?.state && prior.modelCalls===0) return prior.state;
  const finish = async (state,reviewId,reusedResponses=0) => {
    await atomicWrite(notePath,{state,reviewId,reusedResponses,modelCalls:0});
    return state;
  };
  const report = await loadReport(run.db,scope.receiptId);
  if (!report || ['projectId','preparationId','catalogVersionId','stage'].some(field => report[field]!==scope[field])) return 'waiting';

  // Recover a publication if the process stopped after committing it but before writing its receipt.
  const {rows:[existing]} = await run.db.query(`/* replay_sheet_existing */
    SELECT id FROM preliminary_package_reviews
    WHERE project_id=$1 AND receipt_id=$2 AND preparation_id=$3 AND catalog_version_id=$4 AND stage=$5
      AND revision_key=$6 AND inventory=$7::jsonb`,
    [scope.projectId,scope.receiptId,scope.preparationId,scope.catalogVersionId,scope.stage,key,JSON.stringify(report.inventory)]);
  const published = async reviewId => {
    await emitActivity(run.recordActivity,run.db,scope,'revision','published',key,{reviewId,reusedResponses:1,modelCalls:0});
    return finish('published',reviewId,1);
  };
  if (existing) return published(existing.id);

  const originalKey = reassessmentKey(scope,profile);
  const saved = await read(join(dirname(base),originalKey+'.json'));
  const snapshot = saved?.snapshot;
  if (!saved || !['published','responded','rejected'].includes(saved.state) || !saved.parentId ||
      !saved.response || !snapshot?.sheetReading || !/^[a-f0-9]{64}$/.test(snapshot.requestSha256 ?? '') ||
      ['projectId','receiptId','preparationId','catalogVersionId','stage'].some(field => snapshot[field]!==scope[field]) ||
      !Array.isArray(snapshot.inventory) || !equal(inventoryPins(snapshot.inventory),inventoryPins(report.inventory))) {
    return finish('no_replayable_sheet_response',report.reportId);
  }
  if (!sameReaders(snapshot,await readMapPins(run.db,scope))) return finish('sheet_maps_changed',report.reportId);

  // The original parent defines the correction. Later reports must form the same, verifiable chain.
  const lineage = await readLineage(run.db,scope,report,saved.parentId);
  const parent = lineage.at(-1);
  const correctedIndex = lineage.findIndex(row => row.id===saved.reviewId);
  if (parent?.id!==saved.parentId || (saved.state==='published'
    ? correctedIndex<0 || lineage[correctedIndex].revisionKey!==originalKey ||
      lineage[correctedIndex].parentId!==parent.id || correctedIndex!==lineage.length-2
    : lineage.length!==1)) return finish('sheet_lineage_unverified',report.reportId);

  let input;
  try {
    const body = saved.response.rows ? saved.response : parseModelResponse(saved.response);
    input = mergeSelection(validatedPartial(snapshot,body),parent.rows);
  } catch {
    return finish('sheet_response_invalid',report.reportId);
  }
  const trail = saved.state==='published' ? lineage.slice(0,correctedIndex+1).reverse() : [];
  const rows = preserveDescendants(input.rows,trail);
  if (!rows) return finish('sheet_lineage_conflict',report.reportId);
  const draftText = renderQuestions(rows);
  if (equal([rows,draftText],[report.rows,report.draftText])) return finish('unchanged',report.reportId,1);
  const scopeNote = trail.length>1
    ? report.scopeNote.slice(0,10000-replayNote.length-1)+' '+replayNote
    : input.scopeNote;
  // The ordinary publisher compares previousReportId while holding the project lock.
  const result = await run.publish(run.db,{...input,rows,draftText,scopeNote,previousReportId:report.reportId,revisionKey:key});
  return published(result.id);
}
