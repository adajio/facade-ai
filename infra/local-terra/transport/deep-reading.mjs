import { ModelTransportError } from '../request-budget.mjs';

// A confirmed rejection before model dispatch permits retry of the exact effect. A
// lost acknowledgement after dispatch leaves a durable reconciliation hold.
const waiting = new Set([
  'mac_terra_busy', 'mac_terra_not_started', 'mac_terra_paused', 'adapter_unavailable',
  'held_terra_mac_busy', 'held_terra_mac_unavailable', 'held_terra_production_paused',
  'held_terra_prior_provider_attempt', 'held_openrouter_terra_billing', 'openrouter_terra_rejected_402',
]);
export const retryableDeepReason = reason => waiting.has(reason);
export function deepCallFailure(error) {
  if (error instanceof ModelTransportError && error.state === 'rejected') {
    return {state:'rejected',reason:error.message};
  }
  return {state:'unknown',reason:'subscription_outcome_unknown'};
}

const newest = `NOT EXISTS (SELECT 1 FROM intake_receipts newer
  WHERE newer.project_id=r.project_id AND newer.number>r.number)`;
const admission = `(r.created_at>$1::timestamptz OR EXISTS (
  SELECT 1 FROM jsonb_to_recordset($2::jsonb) grant_row("projectId" uuid,"receiptId" uuid,"preparationId" uuid)
  WHERE grant_row."projectId"=r.project_id AND grant_row."receiptId"=r.id AND grant_row."preparationId"=cur.manifest_id
))`;

// Filter before asking for a package plan, verifying derivatives or assigning any reader effect.
export async function admittedDeepReceipts(tx, access) {
  if (!access) return [];
  const {rows} = await tx.query(`SELECT r.project_id AS "projectId",r.id AS "receiptId",cur.manifest_id AS "preparationId",
    p.catalog_version_id AS "catalogVersionId",p.project_stage AS stage
    FROM intake_receipts r JOIN projects p ON p.id=r.project_id AND p.intake_mode
    JOIN harness_package_projects package ON package.project_id=r.project_id
    JOIN intake_package_preparation_current cur ON cur.project_id=r.project_id AND cur.receipt_id=r.id
    WHERE r.analysis_scenario=2 AND r.sealed_at IS NOT NULL AND ${admission} AND ${newest}
      AND EXISTS (SELECT 1 FROM preliminary_package_reviews report
        LEFT JOIN intake_project_generations gen ON gen.project_id=p.id
        WHERE report.project_id=p.id AND report.receipt_id=r.id AND report.preparation_id=cur.manifest_id
          AND report.catalog_version_id=p.catalog_version_id AND report.stage=p.project_stage
          AND report.input_generation=coalesce(gen.generation,0) AND report.model='gpt-6.1-terra')
      AND NOT EXISTS (SELECT 1 FROM project_reading_activity a WHERE a.project_id=p.id AND a.receipt_id=r.id
        AND a.preparation_id=cur.manifest_id AND a.stage='deep_reading' AND a.status IN ('completed','partial')
        AND a.fields->>'catalogVersionId'=p.catalog_version_id::text AND a.fields->>'projectStage'=p.project_stage
        AND (a.reason IS DISTINCT FROM 'no_addressed_goal' OR a.fields->>'reportId'=(
          SELECT rp.id::text FROM preliminary_package_reviews rp WHERE rp.project_id=p.id AND rp.receipt_id=r.id
            AND rp.preparation_id=cur.manifest_id AND rp.catalog_version_id=p.catalog_version_id AND rp.stage=p.project_stage
          ORDER BY rp.created_at DESC,rp.id DESC LIMIT 1)))
    ORDER BY r.created_at,r.id`, [access.activatedAt,JSON.stringify(access.grants)]);
  return rows;
}

export async function currentDeepReceipt(tx, target) {
  const result = await tx.query(`SELECT 1 FROM intake_receipts r
    JOIN projects p ON p.id=r.project_id AND p.intake_mode
    JOIN intake_package_preparation_current cur ON cur.project_id=r.project_id AND cur.receipt_id=r.id
    WHERE r.project_id=$1 AND r.id=$2 AND cur.manifest_id=$3 AND p.catalog_version_id=$4 AND p.project_stage=$5
      AND r.analysis_scenario=2 AND r.sealed_at IS NOT NULL AND ${newest}`,
  [target.projectId,target.receiptId,target.preparationId,target.catalogVersionId,target.stage]);
  return Boolean(result.rowCount);
}

export async function deepReadingWork(tx,target,kind) {
  const {rows:[summary]} = await tx.query(`SELECT count(DISTINCT j.payload#>>'{packageWindow,id}')::int AS started,
    count(*) FILTER (WHERE gen.current AND pinned.id=$4
      AND j.payload#>>'{packageWindow,productionReview,catalogVersionId}'=$5
      AND j.payload#>>'{packageWindow,productionReview,stage}'=$6 AND j.state IN ('ready','leased'))::int AS active,
    count(*) FILTER (WHERE gen.current AND pinned.id=$4 AND j.state='done' AND j.result->>'kind' IN
      ('covered','reviewed_no_match'))::int AS completed,
    max((SELECT max(e.created_at) FROM gateway_outbox e
      WHERE e.job_id=j.id AND e.lease_epoch=j.lease_epoch AND e.event_type IN ('finished','suspended')))
      FILTER (WHERE gen.current AND pinned.id=$4 AND j.state IN ('done','held')) AS "lastFinishedAt",
    bool_or(gen.current AND pinned.id=$4
      AND j.payload#>>'{packageWindow,productionReview,catalogVersionId}'=$5
      AND j.payload#>>'{packageWindow,productionReview,stage}'=$6
      AND EXISTS (SELECT 1 FROM local_terra_calls WHERE job_id=j.id AND state='unknown')) AS unknown
    FROM intake_package_preparations pinned JOIN gateway_jobs j ON j.project_id=pinned.project_id
      AND j.payload#>>'{packageWindow,preparationId}'=pinned.id::text AND j.kind=$3
    JOIN gateway_generations gen ON gen.generation_id=j.generation_id
    WHERE pinned.project_id=$1 AND pinned.receipt_id=$2`,
  [target.projectId,target.receiptId,kind,target.preparationId,target.catalogVersionId,target.stage]);
  return summary;
}

export async function chooseDeepWindow(tx, target, plan) {
  const {rows:[window]} = await tx.query(`SELECT w.id,w.version_id,w.place,m.reader_version,p.generation_id,
    (m.format IN ('pdf','sig','dwg','dxf','image')) AS "requiresVisual"
    FROM unnest($4::uuid[]) WITH ORDINALITY AS shortlist(id,rank)
    JOIN harness_package_windows w ON w.id=shortlist.id
    JOIN intake_package_preparation_windows pin ON pin.project_id=w.project_id AND pin.window_id=w.id AND pin.manifest_id=$3
    JOIN harness_package_maps m ON m.project_id=w.project_id AND m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
    JOIN harness_package_projects p ON p.project_id=w.project_id
    JOIN gateway_generations g ON g.generation_id=p.generation_id AND g.current
    WHERE w.project_id=$1 AND m.refusal IS NULL
      AND NOT EXISTS (SELECT 1 FROM harness_package_branches b WHERE b.window_id=w.id AND b.branch='A' AND b.active)
      AND EXISTS (SELECT 1 FROM intake_occurrences o WHERE o.project_id=$1 AND o.receipt_id=$2
        AND o.version_id=w.version_id AND o.state='accepted')
    ORDER BY shortlist.rank LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
  [target.projectId,target.receiptId,target.preparationId,plan.windowIds]);
  return window;
}

export async function deepReadingActivity(tx,target,status,reason,counters) {
  const {rowCount} = await tx.query(`INSERT INTO project_reading_activity
    (project_id,receipt_id,preparation_id,stage,status,reason,fields,attempt_key)
    VALUES($1,$2,$3,'deep_reading',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
  [target.projectId,target.receiptId,target.preparationId,status,reason,{
    ...counters,catalogVersionId:target.catalogVersionId,projectStage:target.stage,
  }, [target.preparationId,target.catalogVersionId,target.stage,counters.started ?? 0,...(reason==='no_addressed_goal'?[counters.reportId]:[])].join(':')]);
  return rowCount > 0;
}

export async function installDeepLedger(db) {
  const { rows:[schema] } = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='local_terra_calls'::regclass AND conname='local_terra_calls_state_check'
      AND strpos(pg_get_constraintdef(oid),'''rejected''')>0) AS ready`);
  if (!schema.ready) await db.query(`ALTER TABLE local_terra_calls
    ADD COLUMN IF NOT EXISTS failure_code text,
    DROP CONSTRAINT IF EXISTS local_terra_calls_state_check,
    ADD CONSTRAINT local_terra_calls_state_check CHECK (state IN ('sending','completed','unknown','rejected'))`);
}
