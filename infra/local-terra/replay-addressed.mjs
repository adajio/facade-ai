import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseModelResponse, atomicWrite } from './producer.mjs';
import { loadReport } from './revise.mjs';
import { mergeSelection } from './reassessment.mjs';
import { validatedPartial } from './partial-result.mjs';
import { emitActivity } from './request-budget.mjs';

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value==='object') {
    const entries=Object.entries(value).filter(([key])=>!value.anchor || !['documentId','label'].includes(key));
    return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)).map(([key,x])=>[key,comparable(x)]));
  }
  return value;
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(comparable(value))).digest('hex');

// Walk only the contiguous published suffix with available addressed responses.
// A later independent publication is an ownership boundary and stays intact.
export async function replayAddressed(run,scope,key,base) {
  const report=await loadReport(run.db,scope.receiptId);
  if (!report || report.preparationId!==scope.preparationId) return 'waiting';
  const finish=async (id,state)=>{
    await atomicWrite(base+'.done',{reviewId:id,state});
    return state;
  };
  const lookup=async id=>(await run.db.query(`SELECT id,previous_report_id AS "previousId",revision_key AS "revisionKey",rows
    FROM preliminary_package_reviews WHERE id=$1 AND project_id=$2 AND receipt_id=$3 AND catalog_version_id=$4
    AND stage=$5 AND (preparation_id IS NULL OR preparation_id=$6) AND inventory=$7::jsonb`,
    [id,scope.projectId,scope.receiptId,scope.catalogVersionId,scope.stage,scope.preparationId,JSON.stringify(report.inventory)])).rows[0];
  const dir=join(run.stateDir,'addressed',scope.receiptId);
  const names=new Set(await readdir(dir));
  const suffix=[];
  let ancestor=await lookup(report.reportId);
  if (ancestor?.revisionKey===key) return finish(ancestor.id,'published');
  while (ancestor?.revisionKey && names.has(ancestor.revisionKey+'.done') && !names.has(ancestor.revisionKey+'.json')) {
    const previousRun=JSON.parse(await readFile(join(dir,ancestor.revisionKey+'.done'),'utf8'));
    if (previousRun.reviewId!==ancestor.id || previousRun.state!=='published') break;
    ancestor=await lookup(ancestor.previousId);
  }
  while (ancestor?.revisionKey && names.has(ancestor.revisionKey+'.json')) {
    const saved=JSON.parse(await readFile(join(dir,ancestor.revisionKey+'.json'),'utf8'));
    const snapshot=saved.snapshot;
    if (saved.state!=='published' || saved.reviewId!==ancestor.id || !saved.response ||
        snapshot.receiptId!==scope.receiptId || snapshot.preparationId!==scope.preparationId || snapshot.stage!==scope.stage ||
        snapshot.catalogVersionId!==scope.catalogVersionId || fingerprint(snapshot.inventory)!==fingerprint(report.inventory)) break;
    suffix.unshift(saved);
    ancestor=await lookup(ancestor.previousId);
  }
  if (!suffix.length || !ancestor) return finish(report.reportId,'no_replayable_suffix');
  let input, rows=ancestor.rows;
  for (const {snapshot,response} of suffix) {
    const body=response?.rows ? response : parseModelResponse(response);
    input=mergeSelection(validatedPartial(snapshot,body),rows);
    rows=input.rows;
  }
  if (fingerprint([rows,input.draftText])===fingerprint([report.rows,report.draftText])) return finish(report.reportId,'unchanged');
  const result=await run.publish(run.db,{...input,previousReportId:report.reportId,revisionKey:key});
  await emitActivity(run.recordActivity,run.db,scope,'revision','published',key,{reviewId:result.id,reusedResponses:suffix.length,modelCalls:0});
  return finish(result.id,'published');
}
