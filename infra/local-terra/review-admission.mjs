import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const preDispatchReasons = new Set(['mac_terra_busy','mac_terra_paused','mac_terra_budget_exhausted','mac_terra_not_started']);

export function preDispatchReviewRejection(entry) {
  const reason = entry?.error ?? entry?.reason;
  return entry?.state === 'rejected' && entry.response === undefined && entry.result === undefined && preDispatchReasons.has(reason);
}

async function names(path) {
  try { return await readdir(path); }
  catch(error) { if (error.code==='ENOENT') return []; throw error; }
}
export async function unsettledReview(stateDir,scope) {
  const receipt=scope.receiptId;
  if (!/^[a-z0-9_-]+$/iu.test(receipt)) throw Error('invalid_receipt');
  const files=(await names(stateDir)).filter(file=>file===receipt+'.json'||file.startsWith(receipt+'-')&&file.endsWith('.json')).map(file=>join(stateDir,file));
  const addressed=join(stateDir,'addressed',receipt);
  for (const name of await names(addressed)) if (name.endsWith('.json')) files.push(join(addressed,name));
  files.push(join(stateDir,'revisions',receipt,'pending.json'));
  for (const path of files) {
    let entry;
    try { entry=JSON.parse(await readFile(path,'utf8')); }
    catch(error) { if (error.code==='ENOENT') continue; throw error; }
    if (!['sending','unknown'].includes(entry.state)) continue;
    const prior=entry.snapshot;
    // A revision from independently completed observations cannot replay the lost overview.
    // Keep historical and still-sending attempts subject to the original receipt-level hold.
    if (entry.state==='unknown' && prior?.independentReadingAfterTimeout && scope.reportId && scope.facts?.length) continue;
    if (entry.state==='unknown' && prior?.drawingBatchVersions?.length) {
      const pending = new Set(prior.drawingBatchVersions);
      if (scope.drawingBatchVersions?.length && scope.drawingBatchVersions.every(id=>!pending.has(id))) continue;
      if (scope.reportId && scope.facts?.length && scope.facts.every(fact=>fact.versionId && !pending.has(fact.versionId))) continue;
    }
    if (prior?.projectId===scope.projectId && prior.receiptId===receipt && prior.preparationId===scope.preparationId &&
        prior.catalogVersionId===scope.catalogVersionId && prior.stage===scope.stage &&
        (!prior.inventory || !scope.inventory || JSON.stringify(prior.inventory)===JSON.stringify(scope.inventory))) return true;
  }
  return false;
}
// The admission callback executes under the project's intake lock. A saved reply may still be
// validated and published locally while a separate dispatched request has an unknown outcome.
export async function admitRecordedClaim(admit,stateDir,scope,reserve) {
  let held=false;
  const result=await admit(scope,async()=>{
    held=await unsettledReview(stateDir,scope);
    return held ? false : reserve();
  });
  return held ? 'held_scope_outcome_unknown' : result;
}
