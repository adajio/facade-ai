import type { Pool, PoolClient } from 'pg';
import type { WorkQueue } from '../gateway/queue.js';
import { hash, transaction } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import { publishProjectEvent } from '../supplements/events.js';
import { getCatalog, getProject, matchesDefaultProfile } from '../access/project-state.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import { ReaderRefusal, jobSchema, type BlockCheck, type PackageBlock, type PackageSemanticCheck, type Place, type ReaderContext } from './contracts.js';
import type { ReaderService } from './reader.js';

export const packageFollowupKind = 'harness_package_followup';

const activeSource = `EXISTS (SELECT 1 FROM intake_occurrences o WHERE o.project_id=w.project_id
  AND o.version_id=w.version_id AND o.state='accepted') AND NOT EXISTS (
  SELECT 1 FROM intake_document_versions v JOIN intake_occurrences o ON o.version_id=v.id
    AND o.project_id=v.project_id AND o.state='accepted'
  WHERE v.project_id=w.project_id AND v.replaces_version_id=w.version_id)`;
const activeWindows = `harness_package_windows w JOIN harness_package_maps m
  ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active`;
const activeFacts = `harness_package_facts fact
  LEFT JOIN harness_package_followups child ON child.job_id=fact.job_id
  JOIN harness_package_branches primary_branch ON primary_branch.job_id=coalesce(child.root_job_id,fact.job_id) AND primary_branch.active
  JOIN ${activeWindows} ON w.id=fact.window_id
  JOIN LATERAL (SELECT version,state,candidates FROM harness_package_bindings b
    WHERE b.fact_id=fact.id ORDER BY version DESC LIMIT 1) binding ON true`;

export function currentFacadeScopes(project: string, stage: string) {
  return `SELECT detected.id,detected.label,confirmed.kind FROM (
    SELECT DISTINCT (candidate->>'id')::uuid AS id,candidate->>'label' AS label
    FROM ${activeFacts} CROSS JOIN LATERAL jsonb_array_elements(binding.candidates) candidate
    WHERE fact.project_id=${project} AND ${activeSource}
  ) detected
  LEFT JOIN facade_assessment_contexts ctx ON ctx.project_id=${project} AND ctx.facade_id=detected.id AND ctx.kind='facade'
  LEFT JOIN LATERAL (
    SELECT latest.kind FROM (SELECT * FROM facade_type_assignments t
      WHERE t.context_id=ctx.id ORDER BY t.version DESC LIMIT 1) latest
    JOIN ${activeFacts} ON fact.id=latest.observation_id
    WHERE ${activeSource} AND w.version_id=latest.original_version_id AND fact.revision_status='current'
      AND fact.revision=latest.basis->>'revision'
      AND (fact.design_stage IS NULL OR lower(fact.design_stage)=lower(${stage}))
      AND binding.version=latest.binding_version AND binding.state='identified'
      AND jsonb_array_length(binding.candidates)=1 AND binding.candidates->0->>'id'=detected.id::text
  ) confirmed ON true`;
}

export function structureFromLines(format:string,lines:{id:string;locator?:Record<string,string|number>}[],
  limitations:string[],frame?:Place['box']) {
  const seen=new Set<string>();
  const unique=lines.filter(({id})=>{ if(seen.has(id))return false;seen.add(id);return true; });
  const blocks:PackageBlock[]=format==='pdf'?[{id:'page-detail',kind:'visual',...(frame?{box:frame}:{})}]:[];
  const batch=Math.max(32,Math.ceil(unique.length/4000));
  for(let offset=0;offset<unique.length;) {
    let end=Math.min(offset+batch,unique.length);
    const first=unique[offset].locator?.row;
    // Keep all cells of a spreadsheet row together, including row labels and visible headers.
    if(format==='xlsx') {
      while(end<unique.length && unique[end-1].locator?.row!==undefined &&
        unique[end-1].locator?.row===unique[end].locator?.row) end++;
    }
    const last=unique[end-1]?.locator?.row;
    blocks.push({id:`native:${offset+1}`,kind:'native',lineIds:unique.slice(offset,end).map(({id})=>id),
      ...(typeof first==='number'&&typeof last==='number'?{rows:{first,last}}:{})});
    offset=end;
  }
  const reason=limitations.find((item)=>!(format==='pdf'&&item==='pdf_native_empty'));
  return {blocks,limitation:unique.length!==lines.length?'structure_duplicate_line_ids':
    reason??(format==='pdf'&&!frame?'structure_visual_geometry_unavailable':!blocks.length?'structure_unavailable':null)};
}

export async function scanPackageStructure(db: Pool, service: Pick<ReaderService,'open'>) {
  const { rows: [row] } = await db.query<{ id: string; projectId: string; place: Place; version: string; format: string; width:number|null;height:number|null }>(
    `SELECT w.id,w.project_id AS "projectId",w.place,m.reader_version AS version,m.format,(unit.item->>'width')::float8 AS width,(unit.item->>'height')::float8 AS height
     FROM ${activeWindows}
     LEFT JOIN reader_maps rm ON rm.version_id=w.version_id AND rm.reader_version=m.reader_version AND m.format='pdf'
     LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(rm.units) item WHERE item->>'id'=w.place->>'unitId' LIMIT 1) unit ON true
     WHERE m.refusal IS NULL AND m.reader_version IS NOT NULL AND ${activeSource}
       AND NOT EXISTS (SELECT 1 FROM harness_package_structures t WHERE t.window_id=w.id)
       AND NOT EXISTS (SELECT 1 FROM harness_package_structure_retries t WHERE t.window_id=w.id AND t.retry_at>clock_timestamp())
       AND EXISTS (SELECT 1 FROM harness_package_branches b JOIN gateway_jobs j ON j.id=b.job_id
         WHERE b.window_id=w.id AND b.active AND j.payload#>>'{packageWindow,walkProtocol}'='1')
     ORDER BY w.ordinal,w.version_id LIMIT 1`);
  if (!row) return false;
  let evidenceId: string | null = null;
  let plan: ReturnType<typeof structureFromLines>;
  try {
    const { evidence, bytes } = await service.open(row.place.source, { runId: row.id, branch: 'A', operationKey: 'package-structure-v1' },
      { address: { unitId: row.place.unitId, box: row.place.box }, representation: 'native', readerVersion: row.version });
    evidenceId = evidence.id;
    const frame=row.place.box??(row.width&&row.height?{x:0,y:0,width:row.width,height:row.height}:undefined);
    plan = structureFromLines(row.format, deliveredLines(bytes.toString('utf8')), evidence.limitations,frame);
  } catch (error) {
    const { code, statusCode } = (error ?? {}) as { code?: string; statusCode?: number };
    if (!statusCode || statusCode>=500 || statusCode===429) {
      await db.query(`INSERT INTO harness_package_structure_retries(window_id,reason,retry_at,failures)
        VALUES($1,$2,clock_timestamp()+interval '5 seconds',1)
        ON CONFLICT(window_id) DO UPDATE SET reason=EXCLUDED.reason,
          retry_at=clock_timestamp()+least(harness_package_structure_retries.failures*5,60)*interval '1 second',
          failures=least(harness_package_structure_retries.failures+1,12)`,[row.id,code??'structure_retry']);
      return true;
    }
    const frame=row.place.box??(row.width&&row.height?{x:0,y:0,width:row.width,height:row.height}:undefined);
    plan=structureFromLines(row.format,[],[code??'structure_unavailable'],frame);
  }
  return transaction(db, async (tx) => {
    await lockIntakeProject(tx,row.projectId);
    const saved = await tx.query(
      `INSERT INTO harness_package_structures(window_id,evidence_id,blocks,limitation)
       SELECT w.id,$2,$3,$4 FROM ${activeWindows} WHERE w.id=$1 AND ${activeSource}
       ON CONFLICT(window_id) DO NOTHING`, [row.id,evidenceId,JSON.stringify(plan.blocks),plan.limitation]);
    if (saved.rowCount) {
      await tx.query('DELETE FROM harness_package_structure_retries WHERE window_id=$1',[row.id]);
      await publishProjectEvent(tx,row.projectId,{ type:'package-analysis.changed',payload:{} });
    }
    return Boolean(saved.rowCount);
  });
}

export async function packageStructure(db: Pool | PoolClient, context: ReaderContext) {
  const { task } = context;
  if (task.job.mode !== 'primary' || !task.job.packageWindow?.walkProtocol) {
    throw new ReaderRefusal('package_walk_unavailable','permanent');
  }
  const { rows: [row] } = await db.query<{ blocks: PackageBlock[]; limitation: string | null }>(
    'SELECT blocks,limitation FROM harness_package_structures WHERE window_id=$1',[task.job.packageWindow.id]);
  if (!row) throw new ReaderRefusal('package_structure_pending','temporary');
  const followup=task.job.packageWindow.followup;
  const targets=followup?.blocks;
  const {rows:prior}=followup?await db.query<{blockId:string;evidenceId:string}>(
    `SELECT DISTINCT ON (c.block_id) c.block_id AS "blockId",c.evidence_id AS "evidenceId"
     FROM harness_package_block_checks c WHERE c.window_id=$1 AND c.reviewed AND
       (c.job_id=$2 OR EXISTS(SELECT 1 FROM harness_package_followups f WHERE f.root_job_id=$2 AND f.job_id=c.job_id))
     ORDER BY c.block_id,c.job_id`,[task.job.packageWindow.id,followup.rootJobId]):{rows:[]};
  const structure={...row,blocks:targets?row.blocks.filter(({id})=>targets.includes(id)):row.blocks,
    ...(prior.length?{earlierBranchChecks:prior}:{})};
  const project = await getProject(db,task.projectId);
  if(!project.stage||!project.catalogVersionId) return structure;
  const catalog=await getCatalog(db,project.organizationId,project.catalogVersionId);
  if(project.intakeMode&&!matchesDefaultProfile(project,catalog)) return structure;
  const {rows:[own]}=await db.query<{facades:{id:string;label:string}[]}>(
    `SELECT coalesce(jsonb_agg(DISTINCT available.item),'[]') AS facades FROM (
       SELECT item FROM harness_package_facts f JOIN harness_package_bindings b
         ON b.fact_id=f.id AND b.version=1 AND b.state='identified'
       CROSS JOIN LATERAL jsonb_array_elements(b.candidates) item WHERE f.job_id=$1
       UNION ALL
       SELECT jsonb_build_object('id',id,'label',label) FROM (${currentFacadeScopes('$2','$3::text')}) facade
       WHERE kind IS NOT NULL OR id=ANY($4::uuid[])
     ) available`,[task.jobId,task.projectId,project.stage,followup?.semantic?.positions.flatMap(({facadeId})=>facadeId??[])??[]]);
  const assigned=followup?.semantic?.positions.map(({positionId})=>positionId);
  return {...structure,catalog:{
    catalogVersionId:catalog.id,stage:project.stage,facades:own.facades,
    positions:(assigned?catalog.requirements.filter(({key})=>assigned.includes(key)):catalog.requirements.slice(0,64))
      .map(({key,part,aliases,level,evidenceRule})=>({positionId:key,part,aliases,level,
      subjects:[...new Set(evidenceRule?.allOf.flatMap(({anyOf})=>anyOf.map(({subject})=>subject).filter(Boolean))??[])]})),
  }};
}

export async function savePackageBlocks(tx: PoolClient, context: ReaderContext, checks: BlockCheck[]) {
  const { task } = context;
  if (task.job.mode !== 'primary' || !task.job.packageWindow?.walkProtocol) throw new ReaderRefusal('package_walk_unavailable','permanent');
  const { blocks } = await packageStructure(tx,context);
  if (checks.some(({blockId}) => !blocks.some(({id})=>id===blockId))) throw new ReaderRefusal('package_block_unassigned','permanent');
  await tx.query(
    `INSERT INTO harness_package_block_checks(window_id,job_id,block_id,evidence_id,reviewed,reason)
     SELECT $1,$2,item.block,item.evidence,item.reviewed,item.reason
     FROM jsonb_to_recordset($3::jsonb) item(block text,evidence uuid,reviewed boolean,reason text)
     ON CONFLICT(job_id,block_id) DO UPDATE SET evidence_id=EXCLUDED.evidence_id,reviewed=EXCLUDED.reviewed,reason=EXCLUDED.reason
     WHERE NOT harness_package_block_checks.reviewed OR EXCLUDED.reviewed`,
    [task.job.packageWindow.id,task.jobId,JSON.stringify(checks.map((item)=>({
      block:item.blockId,evidence:item.evidenceId,reviewed:item.reviewed,reason:item.reason,
    })))]);
  await publishProjectEvent(tx,task.projectId,{ type:'package-analysis.changed',payload:{} });
}

export async function saveSemanticCheck(tx: PoolClient, context: ReaderContext,
  check: Omit<PackageSemanticCheck,'windowId'|'branch'|'jobId'|'primaryJobId'|'readerVersion'>) {
  const { task, branch } = context;
  if (task.job.mode !== 'primary' || !task.job.packageWindow?.walkProtocol) throw new ReaderRefusal('package_walk_unavailable','permanent');
  const window = task.job.packageWindow;
  const target=window.followup?.semantic;
  if(target && (target.catalogVersionId!==check.catalogVersionId||target.stage!==check.stage||
    !target.positions.some((position)=>position.facadeId===check.facadeId&&position.positionId===check.positionId))) {
    throw new ReaderRefusal('package_semantic_target_unassigned','permanent');
  }
  const project = await getProject(tx,task.projectId);
  if (project.catalogVersionId !== check.catalogVersionId || project.stage !== check.stage) {
    throw new ReaderRefusal('package_semantic_context_stale','permanent');
  }
  const {rows:[epochs]}=await tx.query<{epoch:string;scopeEpoch:string}>(
    `SELECT coalesce((SELECT epoch FROM harness_semantic_epochs WHERE project_id=$1),0)::text AS epoch,
      coalesce((SELECT epoch FROM harness_semantic_scope_epochs WHERE project_id=$1 AND scope_key=$2),0)::text AS "scopeEpoch"`,
    [task.projectId,check.facadeId??'common']);
  if(target && (target.epoch!==epochs.epoch||
    !target.positions.some((position)=>position.facadeId===check.facadeId&&position.positionId===check.positionId&&position.scopeEpoch===epochs.scopeEpoch))) {
    throw new ReaderRefusal('package_semantic_context_stale','permanent');
  }
  const catalog = await getCatalog(tx,project.organizationId,check.catalogVersionId);
  const position = catalog.requirements.find((item)=>item.key===check.positionId && item.level===(check.facadeId ? 'facade' : 'common'));
  if (!position || (project.intakeMode && !matchesDefaultProfile(project,catalog)) ||
    !['all','applicable','*','все','для всех','все фасады','stage:'+check.stage.toLowerCase()]
      .includes(position.applicability.trim().toLowerCase().replace(/^stage:\s*/u,'stage:'))) {
    throw new ReaderRefusal('package_semantic_context_stale','permanent');
  }
  const normalize=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
  const primaryNames=[position.part,...position.aliases??[]].map(normalize);
  const options=(position.evidenceRule?.allOf??[]).flatMap(({anyOf})=>anyOf.map(({subject})=>subject).filter(
    (subject):subject is string=>Boolean(subject)));
  if(check.subject&&![...primaryNames,...options.map(normalize)].includes(normalize(check.subject))) {
    throw new ReaderRefusal('package_semantic_subject_unapproved','permanent');
  }
  if(check.facadeId) {
    const recognized=await tx.query(
      `SELECT 1 FROM (${currentFacadeScopes('$1','$2::text')}) facade
       WHERE id=$3 AND (cardinality($4::text[])=0 OR kind=ANY($4)) LIMIT 1`,
      [task.projectId,check.stage,check.facadeId,position.facadeKinds??[]]);
    if(!recognized.rowCount) throw new ReaderRefusal('package_semantic_facade_unconfirmed','permanent');
  }
  if(check.disposition==='alternatives_checked') {
    const {rows:[review]}=await tx.query<{covered:boolean;relevant:boolean}>(
      `WITH branch_proofs AS (
         SELECT c.block_id,c.evidence_id FROM harness_package_block_checks c WHERE c.window_id=$1 AND c.reviewed
           AND (c.job_id=$2 OR EXISTS(SELECT 1 FROM harness_package_followups f WHERE f.job_id=c.job_id AND f.root_job_id=$2))
           AND c.evidence_id=ANY($3::uuid[])
       )
       SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.blocks) item WHERE NOT EXISTS(
         SELECT 1 FROM branch_proofs c WHERE c.block_id=item->>'id'))
         AND s.limitation IS NULL AND jsonb_array_length(s.blocks)>0 AS covered,
       (SELECT count(DISTINCT evidence_id) FROM branch_proofs)=$4 AS relevant
       FROM harness_package_structures s WHERE s.window_id=$1`,
      [window.id,window.followup?.rootJobId??task.jobId,check.basisIds,new Set(check.basisIds).size]);
    if(!review?.covered||!review.relevant||!check.reason?.trim()) throw new ReaderRefusal('package_semantic_blocks_unreviewed','permanent');
  } else {
    const { rows } = await tx.query<{ id:string; attribute:string; role:string; stage:string; revision:string; states:string; candidates:{id:string}[] }>(
      `SELECT f.id,f.attribute,f.source_role AS role,f.design_stage AS stage,f.revision_status AS revision,b.state AS states,b.candidates
       FROM harness_package_facts f JOIN LATERAL (
         SELECT state,candidates FROM harness_package_bindings h WHERE h.fact_id=f.id ORDER BY version DESC LIMIT 1
       ) b ON true WHERE f.job_id=$1 AND f.id=ANY($2::uuid[])`,[task.jobId,check.basisIds]);
    const names=check.subject?[normalize(check.subject)]:primaryNames;
    if (rows.length !== new Set(check.basisIds).size || rows.some((row)=>!row.attribute ||
      !names.includes(normalize(row.attribute)) || !position.sourceRoles.includes(row.role)
      || row.revision!=='current' || row.stage!==check.stage || (check.facadeId ?
        row.states!=='identified'||!row.candidates.some(({id})=>id===check.facadeId) : row.states!=='common'))) {
      throw new ReaderRefusal('package_semantic_basis_unproven','permanent');
    }
  }
  await tx.query(
    `INSERT INTO harness_package_semantic_checks(job_id,window_id,branch,reader_version,catalog_version_id,stage,
       facade_id,position_id,basis_ids,disposition,subject,reason,applicability_epoch,scope_epoch)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT ON CONSTRAINT harness_package_semantic_check_unique
     DO UPDATE SET basis_ids=EXCLUDED.basis_ids,reason=EXCLUDED.reason`,[task.jobId,window.id,branch,window.readerVersion,
      check.catalogVersionId,check.stage,check.facadeId,check.positionId,check.basisIds,check.disposition,check.subject??null,check.reason??null,epochs.epoch,epochs.scopeEpoch]);
  await publishProjectEvent(tx,task.projectId,{ type:'package-analysis.changed',payload:{} });
}

export async function dispatchPackageFollowup(db: Pool,queue: WorkQueue) {
  return transaction(db,async (tx)=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('facade/package-followup',0))");
    const {rows:[row]}=await tx.query<{ rootId:string;windowId:string;projectId:string;generationId:string;payload:unknown;blocks:string[];round:number }>(
      `SELECT j.id AS "rootId",w.id AS "windowId",w.project_id AS "projectId",j.generation_id AS "generationId",j.payload,missing.ids AS blocks,coalesce(history.round,0)+1 AS round
       FROM ${activeWindows}
       JOIN harness_package_structures s ON s.window_id=w.id
       JOIN harness_package_branches b ON b.window_id=w.id AND b.active
       JOIN gateway_jobs j ON j.id=b.job_id AND (j.state='done' OR j.state='held' AND j.reason='turn_limit_final')
       JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
       LEFT JOIN LATERAL (
         SELECT split_part(f.plan_key,':',2)::int AS round,x.state,x.reason,EXISTS(
           SELECT 1 FROM harness_package_block_checks c WHERE c.job_id=f.job_id AND c.reviewed AND f.blocks?c.block_id
             AND NOT EXISTS (
               SELECT 1 FROM harness_package_block_checks earlier WHERE earlier.block_id=c.block_id AND earlier.reviewed
                 AND (earlier.job_id=j.id OR EXISTS(
                   SELECT 1 FROM harness_package_followups prev JOIN gateway_jobs pj ON pj.id=prev.job_id
                   WHERE prev.root_job_id=j.id AND prev.job_id=earlier.job_id AND pj.created_at<x.created_at))
             )) AS progressed
         FROM harness_package_followups f JOIN gateway_jobs x ON x.id=f.job_id
         WHERE f.root_job_id=j.id AND f.plan_key LIKE 'blocks:%'
         ORDER BY split_part(f.plan_key,':',2)::int DESC LIMIT 1
       ) history ON true
       JOIN LATERAL (
         SELECT ARRAY(SELECT item->>'id' FROM jsonb_array_elements(s.blocks) item
           WHERE NOT EXISTS (SELECT 1 FROM harness_package_block_checks c WHERE c.block_id=item->>'id' AND c.reviewed
             AND (c.job_id=j.id OR EXISTS(SELECT 1 FROM harness_package_followups f WHERE f.root_job_id=j.id AND f.job_id=c.job_id)))
             OR (history.round IS NULL AND (SELECT count(*) FROM harness_package_branches siblings JOIN gateway_jobs root ON root.id=siblings.job_id
                 WHERE siblings.window_id=w.id AND siblings.active AND root.result->>'kind'='reviewed_no_match')=2)
         ) AS ids
       ) missing ON cardinality(missing.ids)>0
       WHERE ${activeSource} AND j.payload#>>'{packageWindow,walkProtocol}'='1'
         AND (history.round IS NULL OR history.progressed AND
           (history.state='done' OR history.state='held' AND history.reason='turn_limit_final'))
         AND 2=(SELECT count(*) FROM harness_package_branches peer JOIN gateway_jobs p ON p.id=peer.job_id
           WHERE peer.window_id=w.id AND peer.active AND (p.state='done' OR p.state='held' AND p.reason='turn_limit_final') AND p.payload#>>'{packageWindow,walkProtocol}'='1'
             AND NOT EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.job_id=p.id AND a.state IN ('reserved','prepared','sending','unknown')))
         AND NOT EXISTS (SELECT 1 FROM harness_package_followups f JOIN gateway_jobs x ON x.id=f.job_id
           WHERE x.project_id=w.project_id AND x.state IN ('ready','leased'))
         AND 4>(SELECT count(*) FROM harness_package_followups f JOIN gateway_jobs x ON x.id=f.job_id WHERE x.state IN ('ready','leased'))
       ORDER BY j.created_at,j.project_id,b.branch LIMIT 1`);
    if (!row) return dispatchCatalogFollowup(tx,queue);
    return putFollowup(tx,queue,row,`blocks:${row.round}`);
  });
}

type FollowupTarget={rootId:string;windowId:string;projectId:string;generationId:string;payload:unknown;blocks:string[]};
type SemanticPlan={catalogVersionId:string;stage:string;epoch:string;positions:{facadeId:string|null;positionId:string;scopeEpoch:string}[]};

async function putFollowup(tx:PoolClient,queue:WorkQueue,row:FollowupTarget,planKey:string,semantic?:SemanticPlan) {
  await lockIntakeProject(tx,row.projectId);
  const root=jobSchema.parse(row.payload);
  if (root.mode!=='primary'||!root.packageWindow||!root.settings) return false;
  const {rows:grant}=await tx.query(
    `SELECT 1 FROM gateway_grants g JOIN gateway_routes r ON r.id=g.route_id AND r.revision=g.revision AND r.enabled
     WHERE g.project_id=$1 AND g.route_id=$2 AND g.data_class=$3 AND g.purpose=$4 AND g.allowed AND r.revision=$5`,
    [row.projectId,root.settings.routeId,root.settings.dataClass,root.branch==='A'?'primary_a':'primary_b',root.packageWindow.routeRevision]);
  if(!grant.length)return false;
  const key='package-followup:'+hash([row.rootId,planKey,row.blocks]);
  const ref={projectId:row.projectId,scopeId:null,generationId:row.generationId};
  await queue.declarePrimary(ref,{id:key,branch:root.branch,place:key},tx);
  const jobId=await queue.enqueue({...ref,kind:packageFollowupKind,key,priority:-100,
    purpose:root.branch==='A'?'primary_a':'primary_b',subjectId:root.place.source.versionId,obligationId:key,
    payload:{...root,settings:{...root.settings,maxTurns:Math.min(root.settings.maxTurns,8)},
      packageWindow:{...root.packageWindow,followup:{rootJobId:row.rootId,blocks:row.blocks,...(semantic?{semantic}:{})}}},
  },tx);
  await tx.query(`INSERT INTO harness_package_followups(root_job_id,job_id,window_id,branch,blocks,plan_key)
    VALUES($1,$2,$3,$4,$5,$6)`,[row.rootId,jobId,row.windowId,root.branch,JSON.stringify(row.blocks),planKey]);
  await publishProjectEvent(tx,row.projectId,{ type:'package-analysis.changed',payload:{} });
  return true;
}

async function dispatchCatalogFollowup(tx:PoolClient,queue:WorkQueue) {
  const {rows:targets}=await tx.query<FollowupTarget&SemanticPlan&{scopeKey:string}>(
    `SELECT j.id AS "rootId",w.id AS "windowId",w.project_id AS "projectId",j.generation_id AS "generationId",j.payload,
      ARRAY(SELECT item->>'id' FROM jsonb_array_elements(s.blocks) item) AS blocks,
      c.id AS "catalogVersionId",p.project_stage AS stage,missing.positions,coalesce(epoch.epoch,0)::text AS epoch,
      plan."scopeKey"
     FROM ${activeWindows}
     JOIN harness_package_structures s ON s.window_id=w.id AND s.limitation IS NULL AND jsonb_array_length(s.blocks)>0
     JOIN harness_package_branches b ON b.window_id=w.id AND b.active
     JOIN gateway_jobs j ON j.id=b.job_id AND (j.state='done' OR j.state='held' AND j.reason='turn_limit_final')
     JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
     JOIN projects p ON p.id=w.project_id AND p.project_stage IS NOT NULL
     JOIN catalog_versions c ON c.id=p.catalog_version_id AND c.organization_id=p.organization_id
     LEFT JOIN harness_semantic_epochs epoch ON epoch.project_id=p.id
     JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('facadeId',next.facade_id,'positionId',next.position_id,'scopeEpoch',next.scope_epoch::text)
         ORDER BY next.facade_id,next.position_id) AS positions FROM (
       SELECT DISTINCT scopes.id AS facade_id,requirement->>'key' AS position_id,coalesce(scope_epoch.epoch,0) AS scope_epoch
       FROM jsonb_array_elements(c.requirements) requirement
       JOIN LATERAL (
         SELECT NULL::uuid AS id,'common' AS level,NULL::text AS kind
         UNION ALL
         SELECT facade.id,'facade',facade.kind FROM (${currentFacadeScopes('p.id','p.project_stage')}) facade
       ) scopes ON scopes.level=requirement->>'level'
       LEFT JOIN harness_semantic_scope_epochs scope_epoch ON scope_epoch.project_id=p.id
         AND scope_epoch.scope_key=coalesce(scopes.id::text,'common')
       WHERE (lower(trim(requirement->>'applicability')) IN ('all','applicable','*','все','для всех','все фасады')
         OR lower(regexp_replace(requirement->>'applicability','^stage:[[:space:]]*','stage:'))='stage:'||lower(p.project_stage))
         AND (coalesce(jsonb_array_length(requirement->'facadeKinds'),0)=0 OR requirement->'facadeKinds'?scopes.kind)
         AND NOT EXISTS (
         SELECT 1 FROM harness_package_semantic_checks check_row
         LEFT JOIN harness_package_followups child ON child.job_id=check_row.job_id
         WHERE coalesce(child.root_job_id,check_row.job_id)=j.id AND check_row.catalog_version_id=c.id
           AND check_row.stage=p.project_stage AND check_row.disposition='alternatives_checked'
           AND check_row.applicability_epoch=coalesce(epoch.epoch,0) AND check_row.scope_epoch=coalesce(scope_epoch.epoch,0)
           AND check_row.position_id=requirement->>'key' AND check_row.facade_id IS NOT DISTINCT FROM scopes.id
           AND check_row.subject IS NULL
         )
       ORDER BY facade_id,position_id LIMIT 3
       ) next
     ) missing ON missing.positions IS NOT NULL
     JOIN LATERAL(SELECT md5(missing.positions::text) AS "scopeKey") plan ON true
     WHERE ${activeSource} AND j.payload#>>'{packageWindow,walkProtocol}'='1'
       AND (NOT p.intake_mode OR c.default_stage=p.project_stage AND c.default_facade_kinds=p.confirmed_facade_kinds)
       AND NOT EXISTS(SELECT 1 FROM harness_package_followups f WHERE f.root_job_id=j.id AND
         f.plan_key='catalog:'||c.id::text||':'||p.project_stage||':'||coalesce(epoch.epoch,0)::text||':'||plan."scopeKey")
       AND NOT EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('reserved','prepared','sending','unknown'))
       AND NOT EXISTS (SELECT 1 FROM harness_package_followups f JOIN gateway_jobs x ON x.id=f.job_id
         WHERE x.project_id=w.project_id AND x.state IN ('ready','leased'))
       AND 4>(SELECT count(*) FROM harness_package_followups f JOIN gateway_jobs x ON x.id=f.job_id WHERE x.state IN ('ready','leased'))
     ORDER BY j.created_at,j.project_id,b.branch LIMIT 8`);
  for(const row of targets) {
    const {catalogVersionId,stage,positions,epoch,scopeKey}=row;
    if(await putFollowup(tx,queue,row,`catalog:${catalogVersionId}:${stage}:${epoch}:${scopeKey}`,{catalogVersionId,stage,epoch,positions}))return true;
  }
  return false;
}
