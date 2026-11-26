import { admitRecordedClaim } from './review-admission.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, claim, makeRequest, preparePromptSnapshot, parseModelResponse, readSnapshot } from './producer.mjs';
import { reconcilePreliminaryReview } from './review-continuity.mjs';
import { validatedPartial } from './partial-result.mjs';
import { replaySavedSheets } from './replay-sheets.mjs';
import { replayAddressed } from './replay-addressed.mjs';
import { renderQuestions } from './review-analysis.mjs';
import { loadReport } from './revise.mjs';
import { duration, emitActivity, modelFailure, remainingRequestBytes, responseUsage } from './request-budget.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function read(path) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch (error) { if (error.code==='ENOENT') return null; throw error; }
}

export function reassessmentKey(scope,reason) {
  return digest(['addressed-review-v2',reason,scope.projectId,scope.receiptId,scope.preparationId,scope.catalogVersionId,scope.stage]);
}

export async function queueReassessment(stateDir,scope,reason) {
  if (!(reason==='operator' || (reason==='sheet_applicability_v1' || reason==='sheet_applicability_v2') || reason==='replay_sheet_applicability_v1' || reason==='index_complete' || /^replay_saved_v[1-3]$/.test(reason) || /^requirements:[a-z0-9_.-]+(?:,[a-z0-9_.-]+)*$/.test(reason)) || !/^[a-zA-Z0-9_-]+$/.test(scope.receiptId) || !scope.preparationId) throw Error('invalid_reassessment_scope');
  const key = reassessmentKey(scope,reason);
  const folder = join(stateDir,'addressed',scope.receiptId);
  await mkdir(folder,{recursive:true,mode:0o700});
  const path = join(folder,key+'.ticket');
  const value={key,reason,preparationId:scope.preparationId,catalogVersionId:scope.catalogVersionId,stage:scope.stage,
    ...(reason==='index_complete' && {indexCursor:scope.indexCursor})};
  const tmp=path+'.'+randomUUID()+'.tmp';
  const handle=await open(tmp,'wx',0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(tmp,path); }
    catch(error) {
      if (error.code!=='EEXIST') throw error;
      let prior;
      try { prior=await read(path); } catch(cause) { if (!(cause instanceof SyntaxError)) throw cause; }
      if (prior?.key===key && prior.reason===reason) return key;
      // Repair a ticket interrupted by older versions. The separate payment journal is authoritative.
      await atomicWrite(path,value);
    }
  } finally { await unlink(tmp); }
  const dir=await open(dirname(path),'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return key;
}

export async function queuedReasons(stateDir,scope) {
  const folder=join(stateDir,'addressed',scope.receiptId);
  let names;
  try { names=await readdir(folder); } catch(error) { if (error.code==='ENOENT') return []; throw error; }
  const done=new Set(names.filter(name=>name.endsWith('.done')).map(name=>name.slice(0,-5)));
  const reasons=[];
  for (const name of names.filter(name=>name.endsWith('.ticket')).sort()) {
    if (done.has(name.slice(0,-7))) continue;
    let ticket;
    try { ticket=await read(join(folder,name)); }
    catch(error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.error(scope.receiptId,'invalid_reassessment_ticket',name);
      continue;
    }
    if (ticket?.key===reassessmentKey(scope,ticket.reason)) reasons.push(ticket.reason);
  }
  return reasons;
}

// A bounded review must be able to revisit what the engineer already sees. Reuse
// exact, previously accepted quotations only for the same version and preparation.
export function withPreviousEvidence(raw,report) {
  if (raw.preparationId!==report.preparationId || raw.projectId!==report.projectId ||
      raw.receiptId!==report.receiptId || raw.catalogVersionId!==report.catalogVersionId || raw.stage!==report.stage) return raw;
  const hashes=new Map(raw.inventory.map(item=>[item.versionId,item.originalSha256]));
  const lines=[...raw.lines], priorProperties=[], priorLineIds=[];
  const byAddress=new Map();
  const addressKey=line=>JSON.stringify([line.versionId,line.anchor]);
  for (const line of lines) byAddress.set(addressKey(line),line);
  let sequence=lines.reduce((maximum,line)=>Math.max(maximum,Number(/^L(\d+)$/u.exec(line.id)?.[1]) || 0),0);
  const groups=report.rows.map(row=> (row.analysis?.properties ?? []).filter(prop=>prop.letter.kind==='ask' || prop.status==='confirmed')
    .map(prop=>({row,prop})).sort((a,b)=>Number(b.prop.letter.kind==='ask')-Number(a.prop.letter.kind==='ask')));
  for (let rank=0;rank<16 && priorProperties.length<40;rank++) for (const group of groups) {
    const record=group[rank];
    if (!record || priorProperties.length>=40) continue;
    const {row,prop}=record, ids=[];
    for (const src of prop.sources.slice(0,3)) {
      if (src.limitation || !src.quote || src.quote.length>4000 || hashes.get(src.versionId)!==src.originalSha256) continue;
      try { if (!JSON.parse(src.anchor)?.unitId) continue; } catch { continue; }
      const key=addressKey(src);
      let line=byAddress.get(key);
      if (!line?.text.includes(src.quote)) {
        line={id:'L'+(++sequence),versionId:src.versionId,originalSha256:src.originalSha256,anchor:src.anchor,text:src.quote};
        byAddress.set(key,line); lines.push(line);
      }
      ids.push(line.id);
      if (!priorLineIds.includes(line.id)) priorLineIds.push(line.id);
    }
    priorProperties.push([row.key,prop.key,prop.label,prop.status,prop.letter.kind,prop.letter.text,ids]);
  }
  return {...raw,lines,priorLineIds,priorProperties};
}

export function selectReassessment(raw,report,ticket) {
  if (ticket.reason==='operator') return raw;
  if (['sheet_applicability_v1','sheet_applicability_v2'].includes(ticket.reason)) return withPreviousEvidence(raw,report);
  const active=new Set(report.rows.map(row=>row.key));
  let selected;
  const uncovered=new Set();
  const evidence=raw.retrieval.evidence;
  if (ticket.reason.startsWith('requirements:')) {
    selected=new Set(ticket.reason.slice(13).split(','));
    if ([...selected].some(key=>!active.has(key))) throw Error('unknown_target_requirement');
  } else {
    const cursors=new Map((ticket.indexCursor ?? []).map(item=>[item.versionId,item]));
    const changed=new Set(raw.indexCursor.filter(item=>{
      const old=cursors.get(item.versionId);
      return !old || old.contract!==item.contract || old.processedUnits!==item.processedUnits;
    }).map(item=>item.versionId));
    const byId=new Map(raw.lines.map(line=>[line.id,line]));
    const newHits=evidence.filter(hit=>changed.has(byId.get(hit.id)?.versionId));
    selected=new Set(newHits.flatMap(hit=>hit.matches.filter(match=>active.has(match.key)).map(match=>match.key)));
    for (const hit of newHits) if (!hit.matches.length) uncovered.add(hit.id);
    if (uncovered.size) for (const row of report.rows) {
      if (row.analysis?.applicability.kind!=='excluded' && (row.status!=='present'
          || row.analysis?.properties.some(property=>property.status!=='confirmed'))) selected.add(row.key);
    }
  }
  const requirements=raw.requirements.filter(item=>selected.has(item.key));
  const hits=evidence.flatMap(hit=>{
    const matches=hit.matches.filter(match=>selected.has(match.key));
    return matches.length || uncovered.has(hit.id) && selected.size ? [{...hit,matches}] : [];
  });
  const lines=new Set(hits.flatMap(hit=>[hit.id,...hit.neighbours.map(n=>n.id),...hit.refs.flatMap(ref=>ref.lines ?? [])]));
  const priorProperties=report.rows.filter(row=>selected.has(row.key)).flatMap(row=>(row.analysis?.properties ?? [])
    .map(property=>[row.key,property.key,property.label,property.status,property.letter.kind,property.letter.text]));
  priorProperties.sort((a,b)=>Number(b[4]==='ask')-Number(a[4]==='ask'));
  return {...raw,requirements,priorProperties,requestLimitBytes:Math.min(60000,32000+Math.max(0,requirements.length-1)*5000),lines:raw.lines.filter(line=>lines.has(line.id)),retrieval:{...raw.retrieval,evidence:hits},
    scopeNote:raw.scopeNote+' В этой редакции повторно проверены требования: '+requirements.map(item=>item.part).join(', ')+'. По остальным сохранены предыдущие выводы.'};
}

// Most polls finish at a tiny local file lookup. The membership/reader query runs only for a pending completion.
async function indexComplete(db,scope) {
  const {rows:[row]}=await db.query(`SELECT NOT EXISTS (SELECT 1 FROM intake_package_preparations p,
    LATERAL jsonb_array_elements(p.manifest->'items') item
    LEFT JOIN LATERAL (SELECT reader_version,total,next_ordinal FROM project_memory_versions v WHERE
      v.project_id=$2 AND v.version_id=(item->>'versionId')::uuid ORDER BY v.contract DESC LIMIT 1) m ON true
    WHERE p.id=$1 AND p.project_id=$2 AND item->>'state'='available' AND item->>'kind'='document'
      AND (m.reader_version IS DISTINCT FROM item->>'readerVersion' OR m.total IS NULL OR m.next_ordinal IS DISTINCT FROM m.total)) complete`,
    [scope.preparationId,scope.projectId]);
  return row.complete;
}

export async function runReassessment(run,scope,reason) {
  const {db,stateDir,modelCall,publish,admitClaim,recordActivity}=run;
  const key=reassessmentKey(scope,reason);
  const base=join(stateDir,'addressed',scope.receiptId,key);
  const ticket=await read(base+'.ticket');
  if (!ticket) return 'idle';
  if (reason==='replay_sheet_applicability_v1') return replaySavedSheets(run,scope,key,base);
  if (/^replay_saved_v[1-3]$/.test(reason)) return replayAddressed(run,scope,key,base);
  const path=base+'.json';
  let saved=await read(path);
  if (saved?.state==='published') { await atomicWrite(base+'.done',{reviewId:saved.reviewId}); return 'published'; }
  const notify=(status,snapshot,fields={},error)=>emitActivity(recordActivity,db,snapshot,'revision',status,key,fields,error);
  const published=await db.query('SELECT id FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2 AND revision_key=$3',[scope.projectId,scope.receiptId,key]);
  if (published.rowCount) {
    await atomicWrite(path,{...saved,state:'published',reviewId:published.rows[0].id});
    await notify('published',scope,{...saved?.snapshot?.budget,...saved?.transport,reviewId:published.rows[0].id});
    return 'published';
  }
  const replayValidation=saved?.state==='rejected' && Boolean(saved.response) && saved.validationVersion!==3;
  if (saved && saved.state!=='responded' && !replayValidation) {
    return saved.state==='sending' ? 'unknown' : saved.state;
  }
  if (!saved) {
    if (reason==='index_complete' && !await indexComplete(db,scope)) return 'waiting';
    const report=await loadReport(db,scope.receiptId);
    if (!report || report.preparationId!==scope.preparationId || report.catalogVersionId!==scope.catalogVersionId || report.stage!==scope.stage) return 'waiting';
    const raw=await readSnapshot(db,scope.receiptId);
    if (!raw || raw.preparationId!==report.preparationId || raw.stage!==report.stage || raw.catalogVersionId!==report.catalogVersionId ||
        JSON.stringify(raw.inventory)!==JSON.stringify(report.inventory) || reason==='index_complete' && raw.indexCoverage.pendingVersions) return 'waiting';
    const selected=selectReassessment(raw,report,ticket);
    if (!selected.requirements.length) {
      const publication=await publish(db,{...report,model:'gpt-6.1-terra',scopeNote:raw.scopeNote+' Индекс завершён. Новых адресных кандидатов по требованиям не выявлено.',previousReportId:report.reportId,revisionKey:key});
      await atomicWrite(path,{state:'published',reviewId:publication.id,publishedAt:new Date().toISOString(),calls:0});
      await notify('published',scope,{reviewId:publication.id,selectedFacts:0});
      return 'published';
    }
    const snapshot=preparePromptSnapshot({...(run.withSkills ? await run.withSkills(selected) : selected),reviewContract:2});
    const request=makeRequest(snapshot);
    snapshot.requestSha256=digest(request);
    const startedAt=Date.now();
    if (remainingRequestBytes(snapshot.budget)<0) {
      await atomicWrite(path,{state:'rejected',snapshot,startedAt,error:'request_limit'});
      await notify('rejected',snapshot,snapshot.budget,'primary_request_limit');
      return 'rejected';
    }
    const admission=await admitRecordedClaim(admitClaim,stateDir,snapshot,()=>claim(path,{...snapshot,startedAt,parentId:report.reportId}));
    if (admission!=='claimed') return admission;
    await notify('sending',snapshot,snapshot.budget);
    let response;
    try { response=await modelCall(request); }
    catch (error) {
      const failure=modelFailure(error);
      await atomicWrite(path,{...failure,snapshot,startedAt});
      await notify(failure.state,snapshot,{...snapshot.budget,...duration(startedAt)},failure.reason);
      return failure.state;
    }
    const transport={...responseUsage(response),providerElapsedMs:Date.now()-startedAt};
    saved={state:'responded',snapshot,response,parentId:report.reportId,startedAt,transport};
    await atomicWrite(path,saved);
  }
  const {snapshot,response,transport,startedAt}=saved;
  const fields={...snapshot.budget,...transport,...duration(startedAt)};
  let input;
  try { input=validatedPartial(snapshot,response?.rows ? response : parseModelResponse(response)); }
  catch(error) {
    await atomicWrite(path,{...saved,state:'rejected',error:error.message,validationVersion:3});
    await notify('rejected',snapshot,fields,error.message);
    return 'rejected';
  }
  const current=await loadReport(db,scope.receiptId);
  if (!current || current.preparationId!==snapshot.preparationId || current.stage!==snapshot.stage || current.catalogVersionId!==snapshot.catalogVersionId ||
      JSON.stringify(current.inventory)!==JSON.stringify(snapshot.inventory)) return 'scope_changed';
  if (current.reportId!==saved.parentId) {
    const {rows:[previous]}=await db.query(`SELECT rows FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2
      AND id=$3 AND catalog_version_id=$4 AND stage=$5 AND inventory=$6::jsonb AND (preparation_id IS NULL OR preparation_id=$7)`,
      [scope.projectId,scope.receiptId,saved.parentId,scope.catalogVersionId,scope.stage,JSON.stringify(current.inventory),scope.preparationId]);
    if (!sameTargetRows(input.rows,previous?.rows,current.rows)) {
      await atomicWrite(path,{...saved,state:'superseded',reason:'revision_parent_rows_changed'});
      await notify('partial',snapshot,fields,'revision_parent_rows_changed');
      return 'superseded';
    }
  }
  const updated=mergeSelection(input,current.rows);
  const publication=await publish(db,{...updated,previousReportId:current.reportId,revisionKey:key});
  await atomicWrite(path,{...saved,state:'published',parentId:current.reportId,reviewId:publication.id,publishedAt:new Date().toISOString()});
  await notify('published',snapshot,{...fields,reviewId:publication.id});
  return 'published';
}

export function mergeSelection(input,previousRows) {
  const updated=reconcilePreliminaryReview(input,previousRows);
  if (updated.rows.length!==previousRows.length) {
    const replacement=new Map(updated.rows.map(row=>[row.key,row]));
    updated.rows=previousRows.map(row=>replacement.get(row.key) ?? row);
    if (updated.rows.some(row=>!row.analysis)) throw Error('structured_parent_required');
    updated.draftText=renderQuestions(updated.rows);
  }
  return updated;
}

export function sameTargetRows(targets,original,current) {
  if (!original) return false;
  const byKey=rows=>new Map(rows.map(row=>[row.key,row]));
  const before=byKey(original),after=byKey(current);
  return targets.every(({key})=>before.has(key) && after.has(key) &&
    JSON.stringify(before.get(key))===JSON.stringify(after.get(key)));
}
