import type {PoolClient} from 'pg';
import {lockIntakeProject} from '../intake/gate.js';
import type {ReviewRow} from '../assessment/preliminary-changes.js';
import {publishProjectEvent} from '../supplements/events.js';

// A receipt shares one allowance across directed research and paid amendments. Its first overview is separate.
export const backgroundCallLimits = { compact:32, legacy:96, addressed:240 } as const;
export function readingProfile(rows:ReviewRow[]):keyof typeof backgroundCallLimits {
  if (!rows.length || !rows.every(row=>row.analysis)) return 'legacy';
  if (rows.some(row=>row.analysis?.applicability?.kind!=='excluded' && (
    row.analysis?.properties?.some(p=>p.letter?.kind==='ask' && (!p.scope || p.scope.kind==='applicable') && p.sources?.some(s=>s.quote && !s.limitation)) ||
    row.analysis?.tensions?.some(t=>t.status==='open' && t.sides?.length>=2 && t.sides.every(side=>side.sources?.some(s=>s.quote && !s.limitation)))))) return 'addressed';
  return 'compact';
}
export type WindowGain = 'flat' | 'gain' | 'unknown';
export type AutomaticStop = 'receipt_call_limit' | 'no_useful_change';
export type StopState = { reason:AutomaticStop|null; callCount:number; callLimit:number; stagnantWindows:number; provisional?:boolean };
type Review = {rows:ReviewRow[]; draftText:string};

const normalize = (s:string) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const sorted = (values:string[]) => [...new Set(values)].sort();
export function engineeringOutcome(review:Review):string {
  const items:string[]=[];
  for(const row of review.rows) {
    const add=(...values:unknown[])=>items.push(JSON.stringify([row.key,...values]));
    add(row.status,row.analysis?.applicability?.kind);
    const quotes=(sources:ReviewRow['sources'])=>sorted((sources??[]).filter(s=>s.quote && !s.limitation).map(s=>normalize(s.quote!)));
    if (!row.analysis) add('legacy',quotes(row.sources),normalize(row.finding??''));
    for(const p of row.analysis?.properties??[]) {
      const direct=quotes(p.sources);
      const scope=p.scope?.kind;
      if (p.status==='confirmed' && direct.length && (!scope || scope==='applicable')) {
        const words=(s:string)=>normalize(s).match(/[\p{L}\p{N}]+/gu)??[];
        const inSource=new Set(direct.flatMap(words));
        const citedValue=sorted(words(p.finding??'').filter(w=>inSource.has(w) && (w.length>2 || /\d/u.test(w)) || ['не','без','нет'].includes(w)));
        add('fact',p.key,direct,citedValue,p.scope?.target?.element,p.scope?.target?.zone,p.scope?.target?.purpose,p.scope?.target?.variant);
      } else if (p.status==='conflicting' || p.status==='unanswered' || p.letter?.kind==='ask' || p.response ||
          (p.scope?.sources?.some(s=>s.quote && !s.limitation) && (scope==='unrelated'||scope==='undetermined'))) {
        // A sourced applicability question is work for the engineer. Multiple links to the same task are one outcome.
        add('action',p.key,p.status,scope,p.letter?.kind,p.response?.state);
      }
    }
    for(const t of row.analysis?.tensions??[]) add('conflict',t.propertyKey,t.status);
  }
  return JSON.stringify([sorted(items),sorted(review.draftText.split(/\n+/u).map(normalize).filter(Boolean))]);
}
export function readingStopReason(count:number,latest:WindowGain[],profile:keyof typeof backgroundCallLimits='compact'):AutomaticStop|null {
  if(count>=backgroundCallLimits[profile]) return 'receipt_call_limit';
  return profile==='compact' && latest.length>=2 && latest[0]==='flat' && latest[1]==='flat' ? 'no_useful_change' : null;
}

const profileByReport = new Map<string,ReturnType<typeof readingProfile>>();
const jobsSql=`SELECT j.* FROM intake_package_preparations m JOIN gateway_jobs j ON j.project_id=m.project_id
  AND j.payload#>>'{packageWindow,preparationId}'=m.id::text
  WHERE m.project_id=$1 AND m.receipt_id=$2`;

export async function receiptStopState(tx:PoolClient,project:string,receipt:string,preparation:string,
    ownGatewayEffect?:string):Promise<StopState> {
  const args=[project,receipt];
  const {rows:[meta]}=await tx.query(`SELECT to_regclass('local_terra_calls') IS NOT NULL AS local,
    (SELECT r.id FROM preliminary_package_reviews r JOIN projects p ON p.id=r.project_id
      LEFT JOIN intake_project_generations gen ON gen.project_id=p.id
      WHERE r.project_id=$1 AND r.receipt_id=$2 AND r.catalog_version_id=p.catalog_version_id AND r.stage=p.project_stage
        AND r.input_generation=coalesce(gen.generation,0) AND (r.preparation_id=$3 OR r.preparation_id IS NULL)
      ORDER BY (r.preparation_id IS NOT NULL) DESC,r.created_at DESC,r.id DESC LIMIT 1) AS report`,[...args,preparation]);
  let profile=profileByReport.get(meta.report);
  if (!profile) {
    const {rows:[review]}=await tx.query<{rows:ReviewRow[]}>('SELECT rows FROM preliminary_package_reviews WHERE id=$1',[meta.report]);
    profile=readingProfile(review?.rows??[]);
    if(meta.report) {
      if(profileByReport.size>=64) profileByReport.delete(profileByReport.keys().next().value!);
      profileByReport.set(meta.report,profile);
    }
  }
  const callLimit=backgroundCallLimits[profile];
  // Historical turns can precede installation of the activity exporter. Count the original ledgers.
  // A revision reservation and its wire event share a key. Prepared gateway work may finish its own reserved call.
  const {rows:[{count,pending}]}=await tx.query<{count:number;pending:number}>(`WITH jobs AS MATERIALIZED (${jobsSql}), effects AS (
    SELECT attempt_key FROM project_reading_activity WHERE project_id=$1 AND receipt_id=$2 AND
      ((stage='revision' AND status='sending') OR (stage='revision_reservation' AND status='reserved'))
    GROUP BY attempt_key)
    SELECT (SELECT count(*) FROM effects)::int +
      (SELECT count(*)::int FROM gateway_attempts g JOIN jobs j ON j.id=g.job_id WHERE g.state<>'cancelled'
        AND NOT (g.effect_key IS NOT DISTINCT FROM $3 AND g.state IN ('reserved','prepared'))) +
      ${meta.local ? '(SELECT count(*)::int FROM local_terra_calls c JOIN jobs j ON j.id=c.job_id)' : '0'} AS count,
    (SELECT count(*)::int FROM gateway_attempts g JOIN jobs j ON j.id=g.job_id WHERE g.state IN ('reserved','prepared')
        AND g.effect_key IS DISTINCT FROM $3) AS pending`,
    [...args,ownGatewayEffect??null]);
  const state:StopState={callCount:count,callLimit,stagnantWindows:0,reason:readingStopReason(count,[],profile),provisional:count-pending<callLimit && pending>0};
  if(state.reason || profile!=='compact') return state;
  // Inspect only the last two distinct terminal places, even after a retry. A hold or an
  // incomplete revision proves nothing about the value of that place.
  const {rows:windows}=await tx.query<{gain:WindowGain}>(`
    WITH places AS (
      SELECT DISTINCT ON (j.payload#>>'{packageWindow,id}') j.id,j.created_at,j.state,j.result,finish.at
      FROM gateway_jobs j JOIN gateway_generations gen ON gen.generation_id=j.generation_id AND gen.current CROSS JOIN LATERAL (SELECT max(o.created_at) AS at FROM gateway_outbox o
        WHERE o.job_id=j.id AND o.lease_epoch=j.lease_epoch AND o.event_type IN ('finished','suspended')) finish
      WHERE j.project_id=$1 AND j.payload#>>'{packageWindow,preparationId}'=$3
        AND j.payload#>'{packageWindow,directedRequirements}' IS NOT NULL AND j.purpose='primary_a' AND j.state IN ('done','held')
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id=j.project_id AND
          j.payload#>>'{packageWindow,goalCatalogId}'=p.catalog_version_id::text AND j.payload#>>'{packageWindow,goalStage}'=p.project_stage)
      ORDER BY j.payload#>>'{packageWindow,id}',j.created_at DESC,j.id DESC
    ), last_two AS (SELECT * FROM places ORDER BY at DESC NULLS LAST,created_at DESC,id LIMIT 2)
    SELECT CASE WHEN w.state<>'done' OR w.at IS NULL THEN 'unknown'
        WHEN f.total=0 AND w.result->>'kind'='reviewed_no_match' THEN 'flat'
        WHEN f.total>0 AND f.complete THEN CASE WHEN f.changed THEN 'gain' ELSE 'flat' END
        ELSE 'unknown' END AS gain
    FROM last_two w CROSS JOIN LATERAL (
      SELECT count(*) AS total,bool_and(a.id IS NOT NULL) AS complete,bool_or(a.status='gain') AS changed
      FROM harness_package_facts fact JOIN projects p ON p.id=fact.project_id LEFT JOIN project_reading_activity a
        ON a.project_id=$1 AND a.receipt_id=$2 AND a.preparation_id::text=$3 AND a.stage='reviewed_observation'
          AND a.attempt_key=concat_ws(':',$3::text,p.catalog_version_id,p.project_stage,fact.id)
          AND a.status IN ('flat','gain')
      WHERE fact.job_id=w.id
    ) f ORDER BY w.at DESC NULLS LAST,w.created_at DESC,w.id`,[...args,preparation]);
  const gains=windows.map(w=>w.gain);
  state.stagnantWindows=gains[0]==='flat' ? (gains[1]==='flat'?2:1) : 0;
  state.reason=readingStopReason(count,gains,profile);
  return state;
}

// Ack the exact observations the report publisher considered. An incomplete/rejected batch cannot
// finish a window. A change shared by multiple observations conservatively credits every affected window.
export async function recordReviewedObservations(tx:PoolClient, scope:{projectId:string; receiptId:string; preparationId:string},
    baselineId:string, afterId:string, ids:string[]) {
  if(!ids.length) return;
  const {projectId,receiptId,preparationId}=scope;
  const {rows}=await tx.query<Review & {id:string}>(`SELECT id,rows,draft_text AS "draftText"
    FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2 AND preparation_id=$3
      AND id=ANY($4::uuid[])`,[projectId,receiptId,preparationId,[baselineId,afterId]]);
  const from=rows.find(r=>r.id===baselineId), to=rows.find(r=>r.id===afterId);
  if(!from || !to || ![from,to].every(r=>r.rows.length && r.rows.every(row=>row.analysis))) return;
  const changed=baselineId!==afterId && engineeringOutcome(from)!==engineeringOutcome(to);
  await tx.query(`INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,attempt_key,fields)
    SELECT $1::uuid,$2::uuid,$3::uuid,'reviewed_observation',$4,concat_ws(':',$3::uuid::text,r.catalog_version_id,r.stage,f.id),jsonb_build_object('reviewId',$6::uuid::text)
    FROM harness_package_facts f JOIN intake_package_preparation_windows w ON w.project_id=f.project_id AND w.window_id=f.window_id
    JOIN preliminary_package_reviews r ON r.id=$6::uuid AND r.project_id=f.project_id
    WHERE w.project_id=$1 AND w.manifest_id=$3 AND f.id=ANY($5::uuid[]) ON CONFLICT DO NOTHING`,
    [projectId,receiptId,preparationId,changed?'gain':'flat',ids,afterId]);
}

export async function recordReadingStop(tx:PoolClient,project:string,receipt:string,preparation:string,state:StopState) {
  if(!state.reason || state.provisional) return;
  const {rowCount}=await tx.query(`INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,reason,fields,attempt_key)
    SELECT p.id,$2::uuid,$3::uuid,'deep_reading','partial',$4,jsonb_build_object('catalogVersionId',p.catalog_version_id,
      'projectStage',p.project_stage,'callCount',$5::int,'callLimit',$6::int,'stagnantWindows',$7::int),
      concat_ws(':',$3::uuid::text,p.catalog_version_id,p.project_stage,$4::text)
    FROM projects p JOIN intake_package_preparation_current cur ON cur.project_id=p.id AND cur.receipt_id=$2 AND cur.manifest_id=$3
    WHERE p.id=$1 ON CONFLICT DO NOTHING`,[project,receipt,preparation,state.reason,state.callCount,state.callLimit,state.stagnantWindows]);
  if(rowCount) await publishProjectEvent(tx,project,{type:'package-analysis.changed',payload:{}});
}

// Call under the same project intake lock and in the transaction reserving the provider effect.
export async function admitBackgroundCall(tx:PoolClient,project:string,receipt:string,preparation:string,ownGatewayEffect?:string) {
  const {rows:[saved]}=await tx.query<{reason:string}>(`SELECT a.reason FROM project_reading_activity a JOIN projects p ON p.id=a.project_id
    WHERE a.project_id=$1 AND a.receipt_id=$2 AND a.stage='deep_reading' AND a.status='partial' AND
      (a.reason='operator_stopped' OR a.reason IN ('receipt_call_limit','no_useful_change') AND a.preparation_id=$3
        AND a.fields->>'catalogVersionId'=p.catalog_version_id::text AND a.fields->>'projectStage'=p.project_stage)
    ORDER BY (a.reason='operator_stopped') DESC,a.id DESC LIMIT 1`,[project,receipt,preparation]);
  if (saved) {
    if(saved.reason!=='receipt_call_limit' || !ownGatewayEffect) return saved.reason;
    const own=await tx.query(`WITH jobs AS (${jobsSql})
      SELECT 1 FROM gateway_attempts g JOIN jobs j ON j.id=g.job_id
      WHERE g.effect_key=$3 AND g.state IN ('reserved','prepared')`,[project,receipt,ownGatewayEffect]);
    if(!own.rowCount) return saved.reason;
  }
  const state=await receiptStopState(tx,project,receipt,preparation,ownGatewayEffect);
  if(state.reason) await recordReadingStop(tx,project,receipt,preparation,state);
  return state.reason;
}

// Schedulers often calculate a plan outside the admission lock. Only latch its current decision.
export async function confirmReadingStop(tx:PoolClient,project:string,receipt:string,preparation:string) {
  await lockIntakeProject(tx,project);
  return admitBackgroundCall(tx,project,receipt,preparation);
}
