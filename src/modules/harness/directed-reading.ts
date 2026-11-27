import type { Pool, PoolClient } from 'pg';
import { inventoryOpen } from '../intake/receipts.js';
import { receiptStopState, type StopState } from './reading-stop.js';
import { memoryVersion } from '../project-memory/contracts.js';

export type DirectedReading = {
  mode: 'ordinary' | 'waiting_report' | 'waiting_index' | 'planning' | 'enough_evidence' | 'no_new_targets' | 'operator_stopped' | 'receipt_call_limit' | 'no_useful_change' | 'no_addressed_goal' | 'directed';
  windowIds: string[];
  receiptId: string | null;
  preparationId: string | null;
  requirementsByWindow: Record<string,string[]>;
  reportId?:string; goalCatalogId?:string; goalStage?:string; provisional?:boolean; stopRecorded?:boolean;
  goalsByWindow?: Record<string,{requirement:string; question:string}[]>;
  callCount?: number;
  callLimit?: number;
  stagnantWindows?: number;
  openRequirements: number;
  indexPendingVersions: number;
  indexCompleteVersions: number;
  indexPendingUnits: number;
  indexUnknownVersions: number;
};

// Estimate the next useful addresses for automatic reading. These bounds affect scheduling only.
const targetsPerRequirement = 2;
const targetsPerReceipt = 24;
export const productionDeepReading = { kind:'local_terra_production_research', targetsPerReceipt:4, turnsPerWindow:8 } as const;
const maxTermsPerProperty = 12;
const ignoredWords = '^(проект|документ|материал|налич|предостав|получ|необходим|указан|информац|данн|требован|провер|подтверж|сведени|файл|действующ|применим|текущ|долж|между|после|перед|для|содерж|соответ|drawing|document|source|provided|current|evidence|value|presence|exact|existing|project|required|verify|cannot|include|with|from|when|must)';

// project is a trusted SQL column or parameter expression supplied by the caller.
function directedReadingScopeSql(project: string, research = false) {
  return String.raw`WITH intake AS MATERIALIZED (
    SELECT r.id,r.project_id,cur.manifest_id,prep.manifest,p.catalog_version_id,p.project_stage,cat.requirements,
      coalesce(gen.generation,0) AS generation,${inventoryOpen} AS inventory_open
    FROM intake_receipts r JOIN projects p ON p.id=r.project_id
    LEFT JOIN catalog_versions cat ON cat.id=p.catalog_version_id AND cat.organization_id=p.organization_id
    LEFT JOIN intake_project_generations gen ON gen.project_id=p.id
    LEFT JOIN intake_package_preparation_current cur ON cur.project_id=r.project_id AND cur.receipt_id=r.id
    LEFT JOIN intake_package_preparations prep ON prep.id=cur.manifest_id AND prep.project_id=r.project_id AND prep.receipt_id=r.id
    WHERE r.project_id=${project} ORDER BY r.number DESC LIMIT 1
  ), report AS MATERIALIZED (
    SELECT review.id,review.rows FROM preliminary_package_reviews review JOIN intake i ON i.project_id=review.project_id
      AND i.id=review.receipt_id AND i.catalog_version_id=review.catalog_version_id AND i.project_stage=review.stage
      AND i.generation=review.input_generation AND i.manifest_id IS NOT NULL
      AND (i.manifest_id=review.preparation_id OR review.preparation_id IS NULL AND review.inventory=(
        SELECT jsonb_agg(jsonb_build_object('versionId',source.version_id,'originalSha256',source.sha256) ORDER BY source.version_id)
        FROM (SELECT DISTINCT v.id AS version_id,original.sha256 FROM intake_occurrences o
          JOIN intake_document_versions v ON v.project_id=o.project_id AND v.id=o.version_id
          JOIN intake_originals original ON original.project_id=v.project_id AND original.id=v.original_id
          WHERE o.project_id=i.project_id AND o.receipt_id=i.id AND o.state='accepted') source
      ))
    WHERE review.model='gpt-6.1-terra' AND NOT i.inventory_open
    ORDER BY review.created_at DESC,review.id DESC LIMIT 1
  ), documents AS MATERIALIZED (
    SELECT DISTINCT ON (pin.version_id) pin.version_id,pin.project_id,m.reader_version,pin.map_fingerprint AS fingerprint,
      item->>'label' AS label,m.format,pm.total,pm.next_ordinal
    FROM intake i CROSS JOIN LATERAL jsonb_array_elements(i.manifest->'items') item
    JOIN intake_package_preparation_items pin ON pin.project_id=i.project_id AND pin.manifest_id=i.manifest_id
      AND pin.version_id::text=item->>'versionId'
    LEFT JOIN harness_package_maps m ON m.project_id=pin.project_id AND m.version_id=pin.version_id AND m.fingerprint=pin.map_fingerprint
      AND m.active AND m.reader_version=item->>'readerVersion'
    LEFT JOIN project_memory_versions pm ON pm.project_id=m.project_id AND pm.version_id=m.version_id
      AND pm.reader_version=m.reader_version AND pm.contract=${memoryVersion}
    WHERE item->>'kind'='document' AND item->>'state'='available'
      ${research ? 'AND m.refusal IS NULL' : ''}
      AND EXISTS (SELECT 1 FROM intake_occurrences o
        WHERE o.project_id=i.project_id AND o.receipt_id=i.id AND o.version_id=pin.version_id AND o.state='accepted')
      AND NOT EXISTS (SELECT 1 FROM intake_document_versions newer JOIN intake_occurrences o ON o.project_id=newer.project_id
        AND o.version_id=newer.id AND o.state='accepted'
        WHERE newer.project_id=i.project_id AND newer.replaces_version_id=pin.version_id)
    ORDER BY pin.version_id,item->>'label'
  ), index_status AS (
    SELECT (count(*) FILTER (WHERE total IS NULL OR next_ordinal < total))::int AS pending,
      (count(*) FILTER (WHERE total=next_ordinal))::int AS complete,
      coalesce(sum(total-next_ordinal),0)::int AS units,(count(*) FILTER (WHERE total IS NULL))::int AS unknown
    FROM documents
  )`;
}

const scopeStamp = `md5(jsonb_build_array((SELECT manifest_id FROM intake),(SELECT id FROM report),
  (SELECT jsonb_agg(jsonb_build_array(version_id,reader_version,fingerprint,total,next_ordinal) ORDER BY version_id)
   FROM documents))::text)`;

export function directedReadingPlanSql(project: string, research = false) {
  return String.raw`${directedReadingScopeSql(project,research)}, open AS MATERIALIZED (
    SELECT req->>'key' AS requirement,coalesce(property->>'key','') AS property_key,req,
      property->>'label' AS property_label,
      left(coalesce(CASE WHEN property#>>'{letter,kind}'='ask' THEN nullif(btrim(property#>>'{letter,text}'),'') END,
        nullif(btrim(property->>'label'),''),nullif(btrim(req->>'completenessCriterion'),''),nullif(btrim(req->>'part'),'')),600) AS question,CASE
        WHEN property#>>'{scope,kind}'='undetermined' AND property->'sources'='[]'::jsonb THEN property#>'{scope,sources}'
        ELSE coalesce(property->'sources',review->'sources') END AS sources
    FROM intake i CROSS JOIN report rp
    CROSS JOIN LATERAL jsonb_array_elements(i.requirements) req
    LEFT JOIN LATERAL (
      SELECT row FROM jsonb_array_elements(rp.rows) row WHERE row->>'key'=req->>'key'
    ) results(review) ON true
    LEFT JOIN LATERAL (
      SELECT prop FROM jsonb_array_elements(review#>'{analysis,properties}') prop
      WHERE prop->>'status' IS DISTINCT FROM 'confirmed'
        OR prop ? 'scope' AND prop#>>'{scope,kind}' IS DISTINCT FROM 'applicable' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(prop->'sources') ref
        WHERE length(btrim(ref->>'quote'))>=3 AND ref->>'limitation' IS NULL
      )
    ) open_property(property) ON true
    WHERE (req->>'applicability' IS NULL OR req->>'applicability' !~* '^stage:'
        OR lower(trim(substr(req->>'applicability',7)))=lower(i.project_stage))
      AND review#>>'{analysis,applicability,kind}' IS DISTINCT FROM 'excluded'
      AND (property IS NOT NULL OR review->>'status' IS DISTINCT FROM 'present' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(review->'sources') reference
        WHERE length(btrim(reference->>'quote'))>=3 AND reference->>'limitation' IS NULL
      ))
  ), literal_places AS MATERIALIZED (
    SELECT review->>'key' AS requirement,ref->>'versionId' AS version,ref->>'anchor' AS anchor
    FROM report rp
    CROSS JOIN LATERAL jsonb_array_elements(rp.rows) review
    CROSS JOIN LATERAL jsonb_array_elements(review#>'{analysis,properties}') property
    CROSS JOIN LATERAL jsonb_array_elements(property->'sources') ref
    WHERE property->>'status'='confirmed' AND property#>>'{scope,kind}'='applicable'
      AND property#>>'{scope,basis}'='literal' AND length(btrim(ref->>'quote'))>=3 AND ref->>'limitation' IS NULL
  ), terms AS MATERIALIZED (
    SELECT o.requirement,o.property_key,(array_agg(w.term ORDER BY w.weight DESC,w.term))[1:${maxTermsPerProperty}] AS tokens
    FROM open o CROSS JOIN LATERAL (
      SELECT DISTINCT ON (prefix) prefix AS term,part.score AS weight FROM (
        VALUES (1,concat_ws(' ',o.req->>'completenessCriterion',o.req#>>'{comparison,property}')),
          (2,concat_ws(' ',o.req->>'part',o.req->>'aliases')),(4,o.property_label)
        UNION ALL SELECT 3,concat_ws(' ',e->>'subject',e->>'property',e->>'attribute')
          FROM jsonb_path_query(o.req,'$.evidenceRule.allOf[*].anyOf[*]') e
      ) part(score,words)
      CROSS JOIN LATERAL regexp_matches(lower(part.words),'[[:alnum:]]{4,}','g') r
      CROSS JOIN LATERAL (SELECT left(r[1],5) AS prefix) stem
      WHERE r[1] !~ '${ignoredWords}' AND r[1] !~ '^[0-9]+$'
      ORDER BY prefix,part.score DESC
    ) w GROUP BY o.requirement,o.property_key
  ), indexed_text AS MATERIALIZED (
    SELECT b.id,string_agg(line.folded,E'\n') AS contents
    FROM index_status ix JOIN documents d ON ix.pending=0
    JOIN project_memory_blocks b ON b.project_id=d.project_id AND b.version_id=d.version_id
      AND b.contract=${memoryVersion} AND b.ordinal<d.next_ordinal
    JOIN project_memory_lines line ON line.block_id=b.id
    WHERE EXISTS (SELECT 1 FROM terms)
    GROUP BY b.id
  ), place_index AS MATERIALIZED (
    SELECT w.id,w.version_id,w.ordinal,w.place->>'unitId' AS unit,b.id AS block,
      coalesce(b.remaining && ARRAY['graphics','ocr']::text[],false) AS visual,
      (d.format IN ('pdf','sig','dwg','dxf','image')
        AND coalesce(w.place#>>'{locator,coverage}','addressable')<>'native_only') AS can_open_image
    FROM intake i CROSS JOIN report rp CROSS JOIN documents d
    JOIN intake_package_preparation_windows pin ON pin.project_id=d.project_id AND pin.manifest_id=i.manifest_id
    JOIN harness_package_windows w ON w.id=pin.window_id AND w.project_id=d.project_id AND w.version_id=d.version_id AND w.map_fingerprint=d.fingerprint
    LEFT JOIN project_memory_blocks b ON b.project_id=d.project_id AND b.version_id=d.version_id
      AND b.contract=${memoryVersion} AND b.ordinal<d.next_ordinal AND b.unit_id=w.place->>'unitId'
    WHERE coalesce(w.place#>>'{locator,coverage}','addressable') NOT IN ('held','original_only')
      AND d.reader_version IS NOT NULL
  ), lexical_hits AS MATERIALIZED (
    SELECT words.id AS block,t.requirement,t.property_key,4*count(*)::int AS weight
    FROM indexed_text words CROSS JOIN terms t CROSS JOIN LATERAL unnest(t.tokens) token
    WHERE strpos(words.contents,token)>0 GROUP BY words.id,t.requirement,t.property_key
  ), label_hits AS MATERIALIZED (
    SELECT d.version_id,t.requirement,t.property_key,count(*)::int AS weight
    FROM index_status ix JOIN documents d ON ix.pending=0 CROSS JOIN terms t CROSS JOIN LATERAL unnest(t.tokens) token
    WHERE lower(d.label) ~ ('\m'||token) GROUP BY d.version_id,t.requirement,t.property_key
  ), signals AS (
    SELECT p.id,p.version_id,p.ordinal,p.unit,h.requirement,h.property_key,h.weight,p.visual
    FROM place_index p JOIN lexical_hits h ON h.block=p.block
    UNION ALL SELECT p.id,p.version_id,p.ordinal,p.unit,h.requirement,h.property_key,h.weight,true
    FROM place_index p JOIN label_hits h ON h.version_id=p.version_id WHERE p.visual
    UNION ALL SELECT DISTINCT p.id,p.version_id,p.ordinal,p.unit,o.requirement,o.property_key,24,true
    FROM open o CROSS JOIN LATERAL jsonb_array_elements(o.sources) s
    JOIN place_index p ON (p.visual OR p.can_open_image) AND s->>'versionId'=p.version_id::text
      AND strpos(s->>'anchor','"unitId":'||to_json(p.unit)::text)>0
  ), candidates AS MATERIALIZED (
    SELECT id,version_id,ordinal,requirement,property_key,sum(weight)+CASE WHEN bool_or(visual) THEN 2 ELSE 0 END AS score
    FROM signals s WHERE s.property_key<>'' OR NOT EXISTS (
      -- A generic coverage task cannot be justified only by a literal record already used at this address.
      SELECT 1 FROM literal_places checked WHERE checked.requirement=s.requirement AND checked.version=s.version_id::text
        AND strpos(checked.anchor,'"unitId":'||to_json(s.unit)::text)>0
    ) GROUP BY id,version_id,ordinal,requirement,property_key
  ), ranked AS (
    SELECT *,row_number() OVER (PARTITION BY requirement,property_key ORDER BY score DESC,ordinal,version_id,id) AS per_property
    FROM candidates
  ), per_requirement AS (
    SELECT id,requirement,max(score) AS score,
      row_number() OVER (PARTITION BY requirement ORDER BY min(per_property),max(score) DESC,min(ordinal),id) AS rank
    FROM ranked WHERE per_property<=${targetsPerRequirement} GROUP BY id,requirement
  ), shortlist AS (
    SELECT id,max(score) AS score,min(rank) AS rank FROM per_requirement
    WHERE rank<=${targetsPerRequirement} GROUP BY id ORDER BY rank,score DESC,id LIMIT ${targetsPerReceipt}
  ), goals AS (
    SELECT shortlist.id,shortlist.rank,shortlist.score,(array_agg(requirement ORDER BY requirement))[1:${targetsPerReceipt}] AS keys
    FROM shortlist JOIN per_requirement ON per_requirement.id=shortlist.id
    WHERE per_requirement.rank<=${targetsPerRequirement} GROUP BY shortlist.id,shortlist.rank,shortlist.score
  ), questions AS (
    SELECT g.id,jsonb_agg(DISTINCT jsonb_build_object('requirement',o.requirement,'question',o.question)
      ORDER BY jsonb_build_object('requirement',o.requirement,'question',o.question)) AS items
    FROM goals g JOIN ranked r ON r.id=g.id AND r.requirement=ANY(g.keys) AND r.per_property<=${targetsPerRequirement}
    JOIN open o ON o.requirement=r.requirement AND o.property_key=r.property_key
    WHERE o.question IS NOT NULL GROUP BY g.id
  ), planned AS (
    SELECT coalesce(array_agg(g.id ORDER BY g.rank,g.score DESC,g.id),'{}'::uuid[]) AS ids,
      coalesce(jsonb_object_agg(g.id,g.keys),'{}'::jsonb) AS requirements,
      coalesce(jsonb_object_agg(g.id,q.items),'{}'::jsonb) AS questions
    FROM goals g JOIN questions q ON q.id=g.id
  )
  SELECT ${scopeStamp} AS stamp,CASE WHEN NOT EXISTS (SELECT 1 FROM report) THEN CASE WHEN EXISTS (
      SELECT 1 FROM preliminary_package_reviews saved WHERE saved.project_id=${project} AND saved.model='gpt-6.1-terra'
    ) THEN 'waiting_report' ELSE 'ordinary' END
    WHEN NOT EXISTS (SELECT 1 FROM open) THEN 'enough_evidence'
    WHEN ix.pending>0 AND cardinality(planned.ids)=0 THEN 'waiting_index'
    WHEN cardinality(planned.ids)=0 THEN 'no_addressed_goal' ELSE 'directed' END AS mode,
    planned.ids AS "windowIds",(SELECT id FROM intake) AS "receiptId",(SELECT manifest_id FROM intake) AS "preparationId",
    (SELECT id FROM report) AS "reportId",(SELECT catalog_version_id FROM intake) AS "goalCatalogId",(SELECT project_stage FROM intake) AS "goalStage",
    planned.requirements AS "requirementsByWindow",planned.questions AS "goalsByWindow",(SELECT count(DISTINCT requirement)::int FROM open) AS "openRequirements",
    ix.pending AS "indexPendingVersions",ix.complete AS "indexCompleteVersions",
    ix.units AS "indexPendingUnits",ix.unknown AS "indexUnknownVersions"
  FROM index_status ix CROSS JOIN planned`;
}

type DirectedState = { stamp: string; report: string | null; receiptId: string | null; earlierReview: boolean; stopped: boolean; preparation: string|null; savedStop: StopState|null;
  indexPendingVersions: number; indexCompleteVersions: number; indexPendingUnits: number; indexUnknownVersions: number };

const cache = new Map<string, { stamp: string; plan: DirectedReading; expires?: number }>();
const planning = new Set<string>();
// The operator's decision follows this receipt across report revisions and restarts.
const stoppedReceiptSql = (project: string, receipt: string) => `EXISTS (
  SELECT 1 FROM project_reading_activity a WHERE a.project_id=${project} AND a.receipt_id=${receipt}
    AND a.stage='deep_reading' AND a.status='partial' AND a.reason='operator_stopped')`;

export async function receiptReadingStopped(tx: PoolClient, projectId: string, receiptId: string): Promise<boolean> {
  const {rows:[row]} = await tx.query<{stopped:boolean}>(`SELECT ${stoppedReceiptSql('$1','$2')} AS stopped`,
    [projectId,receiptId]);
  return row.stopped;
}

const scopeStateSql = (research: boolean) => `${directedReadingScopeSql('$1::uuid',research)}
  SELECT (SELECT id FROM intake) AS "receiptId",(SELECT id FROM report) AS report,
    ${stoppedReceiptSql('$1::uuid','(SELECT id FROM intake)')} AS stopped,
    (SELECT manifest_id FROM intake) AS preparation,
    (SELECT jsonb_build_object('reason',a.reason,'callCount',a.fields->'callCount','callLimit',a.fields->'callLimit','stagnantWindows',a.fields->'stagnantWindows')
      FROM intake i JOIN project_reading_activity a ON a.project_id=i.project_id AND a.receipt_id=i.id AND a.preparation_id=i.manifest_id
      WHERE a.stage='deep_reading' AND a.status='partial' AND a.reason IN ('no_useful_change','receipt_call_limit')
        AND a.fields->>'catalogVersionId'=i.catalog_version_id::text AND a.fields->>'projectStage'=i.project_stage ORDER BY a.id DESC LIMIT 1) AS "savedStop",
    EXISTS (SELECT 1 FROM preliminary_package_reviews saved WHERE saved.project_id=$1 AND saved.model='gpt-6.1-terra') AS "earlierReview",
    ix.pending AS "indexPendingVersions",ix.complete AS "indexCompleteVersions",
    ix.units AS "indexPendingUnits",ix.unknown AS "indexUnknownVersions",
    ${scopeStamp} AS stamp
  FROM index_status ix`;

/** Cache the calculation only for exactly the same report, reader versions and indexed prefixes. */
export async function readDirectedReadingPlan(tx: PoolClient, projectId: string, background?: Pool): Promise<DirectedReading> {
  return readPlan(tx,projectId,false,background);
}

export async function readProductionDirectedReadingPlan(tx: PoolClient, projectId: string): Promise<DirectedReading> {
  return readPlan(tx,projectId,true);
}

async function readPlan(tx: PoolClient, projectId: string, research: boolean, background?: Pool): Promise<DirectedReading> {
  const { rows: [{ stamp, report, earlierReview, stopped, preparation, savedStop, ...state }] } = await tx.query<DirectedState>(scopeStateSql(research), [projectId]);
  if (stopped) return { ...state, mode:'operator_stopped', windowIds:[], requirementsByWindow:{}, preparationId:null, openRequirements:0 };
  if (!report) return { ...state, mode: earlierReview ? 'waiting_report' : 'ordinary',
    windowIds:[], requirementsByWindow:{}, preparationId:null, openRequirements:0 };
  const policy = savedStop ?? (state.receiptId && preparation ? await receiptStopState(tx,projectId,state.receiptId,preparation) : null);
  if (policy?.reason && policy.provisional) return {...state, mode:'planning', windowIds:[], requirementsByWindow:{},
    preparationId:null, openRequirements:0, callCount:policy.callCount, callLimit:policy.callLimit, provisional:true};
  if (policy?.reason) return {...state, mode:policy.reason, windowIds:[], requirementsByWindow:{}, preparationId:preparation,
    openRequirements:0, callCount:policy.callCount, callLimit:policy.callLimit, stagnantWindows:policy.stagnantWindows, provisional:policy.provisional, stopRecorded:Boolean(savedStop)};
  const cacheKey = research ? projectId + ':production' : projectId;
  // A competing branch can become active independently of the index.
  const saved = cache.get(cacheKey);
  if (saved?.stamp===stamp && (saved.expires === undefined || saved.expires > Date.now())) return availableTargets(tx,projectId,saved.plan);
  if (background) {
    if (!planning.has(projectId) && planning.size<2) {
      planning.add(projectId);
      void refreshDirectedReadingPlan(background,projectId).finally(()=>planning.delete(projectId));
    }
    return {...state,mode:'planning',windowIds:[],requirementsByWindow:{},preparationId:null,openRequirements:0};
  }
  // This analytical query is rerun only for changed input. JIT compilation is slower than the query itself.
  await tx.query('SET LOCAL jit=off');
  const { rows: [{stamp: computed, ...plan}] } = await tx.query<DirectedReading & {stamp: string}>(
    directedReadingPlanSql('$1::uuid',research), [projectId]);
  if (cache.size>=64 && !saved) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey,{stamp:computed,plan,...(research && {expires:Date.now()+10_000})});
  return availableTargets(tx,projectId,plan);
}

// The overview returns its saved findings while the first large map is being ranked.
async function refreshDirectedReadingPlan(pool: Pool, projectId: string) {
  let client: PoolClient | undefined;
  try {
    client=await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    await readDirectedReadingPlan(client,projectId);
    await client.query('COMMIT');
  } catch {
    await client?.query('ROLLBACK').catch(()=>{});
  } finally {
    client?.release();
  }
}

// Rank all candidate places before inspecting history. An unsuccessful reading does not replace
// its slot with the next candidate. The cumulative cap survives amendments to the same receipt.
async function availableTargets(tx: PoolClient, projectId: string, plan: DirectedReading): Promise<DirectedReading> {
  if (!plan.windowIds.length || !plan.receiptId) return plan;
  const { rows } = await tx.query<{ windowId: string; requirements: string[] }>(`
    SELECT DISTINCT w.id AS "windowId",ARRAY(SELECT jsonb_array_elements_text(
        j.payload#>'{packageWindow,directedRequirements}')) AS requirements
    FROM intake_package_preparations prep
    JOIN intake_package_preparation_windows admitted ON admitted.manifest_id=prep.id AND admitted.project_id=prep.project_id
    JOIN harness_package_windows w ON w.id=admitted.window_id AND w.project_id=prep.project_id
    JOIN harness_package_branches branch ON branch.window_id=w.id
    JOIN gateway_jobs j ON j.project_id=w.project_id AND j.id=branch.job_id
    WHERE prep.project_id=$1 AND prep.receipt_id=$2
      AND j.payload#>>'{packageWindow,preparationId}'=prep.id::text
      AND j.payload#>'{packageWindow,directedRequirements}' IS NOT NULL`,[projectId,plan.receiptId]);
  const used = new Set(rows.map(({windowId})=>windowId));
  const usedPerRequirement = new Map<string,Set<string>>();
  for (const {windowId,requirements} of rows) for (const key of requirements) {
    const ids = usedPerRequirement.get(key) ?? new Set<string>();
    ids.add(windowId);
    usedPerRequirement.set(key,ids);
  }
  const requirementsByWindow: DirectedReading['requirementsByWindow'] = {};
  for (const id of plan.windowIds) {
    const requirements = plan.requirementsByWindow[id].filter(key=>{
      const committed = usedPerRequirement.get(key);
      return committed?.has(id) || (committed?.size ?? 0)<targetsPerRequirement;
    });
    if ((used.has(id) || used.size<targetsPerReceipt) && requirements.length) requirementsByWindow[id] = requirements;
  }
  const windowIds = plan.windowIds.filter(id=>requirementsByWindow[id]);
  return {...plan,windowIds,requirementsByWindow,mode: windowIds.length ? plan.mode :
    plan.indexPendingVersions ? 'waiting_index' : 'no_new_targets'};
}

export async function readDirectedReadingPlans(tx: PoolClient, requireReport: boolean, background?: Pool) {
  const { rows } = await tx.query<{ projectId: string }>(`
    SELECT project.project_id AS "projectId" FROM harness_package_projects project
    WHERE $1::boolean OR EXISTS (SELECT 1 FROM preliminary_package_reviews saved
      WHERE saved.project_id=project.project_id AND saved.model='gpt-6.1-terra')`,[requireReport]);
  const plans = [];
  for (const {projectId} of rows) {
    const {mode,receiptId,preparationId,provisional,stopRecorded,callCount,callLimit,stagnantWindows,windowIds,requirementsByWindow} = await readDirectedReadingPlan(tx,projectId,background);
    plans.push({projectId,mode,receiptId,preparationId,provisional,stopRecorded,callCount,callLimit,stagnantWindows,windowIds,requirementsByWindow});
  }
  return plans;
}

export async function currentDirectedWindow(tx: PoolClient, projectId: string, windowId: string,
  requireReport: boolean, receiptId?: string | null, background?: Pool) {
  const plan = await readDirectedReadingPlan(tx,projectId,background);
  const requirements = plan.requirementsByWindow[windowId];
  return {
    allowed: !receiptId && plan.mode==='ordinary' && !requireReport ||
      (!receiptId || plan.receiptId===receiptId) && Boolean(requirements),
    requirements, reportId:plan.reportId, goalCatalogId:plan.goalCatalogId, goalStage:plan.goalStage, goals:plan.goalsByWindow?.[windowId]?.filter(g=>requirements?.includes(g.requirement)).slice(0,24),
    preparationId: requirements ? plan.preparationId : null,
  };
}

export async function directedWindowAllowed(tx: PoolClient, projectId: string, windowId: string,
  requireReport: boolean, receiptId?: string | null) {
  return (await currentDirectedWindow(tx,projectId,windowId,requireReport,receiptId)).allowed;
}

/** Reuse an immutable addressed assignment only while its report, stage and pins are current.
 * Jobs created before questions were persisted must qualify against today's plan at the same place. */
export async function addressedWindowCurrent(tx:PoolClient,project:string,receipt:string,job:{
  id:string; preparationId?:string; goalReportId?:string; goalCatalogId?:string; goalStage?:string;
  directedGoals?:{requirement:string;question:string}[]; directedRequirements?:string[];
},production=false) {
  if (job.goalReportId && job.directedGoals?.some(g=>g.question.trim() && job.directedRequirements?.includes(g.requirement))) {
    const {rows:[current]}=await tx.query(`SELECT r.id FROM projects p JOIN intake_package_preparation_current prep
      ON prep.project_id=p.id AND prep.receipt_id=$2 AND prep.manifest_id=$3
      JOIN preliminary_package_reviews r ON r.preparation_id=prep.manifest_id AND r.receipt_id=prep.receipt_id
        AND r.catalog_version_id=p.catalog_version_id AND r.stage=p.project_stage
      LEFT JOIN intake_project_generations gen ON gen.project_id=p.id
      WHERE p.id=$1 AND r.input_generation=coalesce(gen.generation,0)
        AND p.catalog_version_id=$4 AND p.project_stage=$5
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[project,receipt,job.preparationId,job.goalCatalogId,job.goalStage]);
    if (current?.id===job.goalReportId) return true;
  }
  const plan=await readPlan(tx,project,production);
  return plan.receiptId===receipt && plan.preparationId===job.preparationId &&
    Boolean(plan.goalsByWindow?.[job.id]?.some(g=>job.directedRequirements?.includes(g.requirement)
      && plan.requirementsByWindow[job.id]?.includes(g.requirement)));
}
