import type { PoolClient } from 'pg';
import { inventoryOpen } from '../intake/receipts.js';
import { loadResearchProfile } from '../harness/profile.js';

const model = 'gpt-6.1-terra';
const route = 'codex-subscription-terra';
// Count admitted windows and already assigned work; an absent snapshot never
// implies that unassigned windows are ready for a new analysis.
const visibleReadingWindow = `(EXISTS (SELECT 1 FROM intake_package_preparation_current cur
  JOIN intake_package_preparation_windows pi ON pi.manifest_id=cur.manifest_id AND pi.project_id=cur.project_id
  WHERE cur.project_id=w.project_id AND cur.receipt_id=$2 AND pi.window_id=w.id)

 OR EXISTS (SELECT 1 FROM harness_package_branches old JOIN gateway_jobs job ON job.id=old.job_id
   JOIN gateway_generations generation ON generation.generation_id=job.generation_id AND generation.current
   WHERE old.window_id=w.id AND old.active AND old.branch='A' AND old.settings->>'model'=$3
     AND old.settings->>'routeId'=$4 AND job.project_id=w.project_id AND job.purpose='primary_a'))`;
/** The overview is a bounded, read-only view of the newest intake. */
export async function readTerraReading(tx: PoolClient, projectId: string) {
  const profile = loadResearchProfile();
  let configured: { B?: unknown; lead?: unknown } | null = null;
  try { configured = JSON.parse(process.env.FACADE_HARNESS_PROFILE ?? 'null'); } catch { /* disabled */ }
  const explicitProfile = configured !== null && typeof configured === 'object' && !Array.isArray(configured)
    && configured.B == null && configured.lead == null && profile.A?.model === model && profile.A.routeId === route;
  const { rows: [mode] } = await tx.query<{ enabled: boolean }>(`SELECT
    (p.intake_mode AND $2::boolean) OR EXISTS (SELECT 1 FROM preliminary_package_reviews r WHERE r.project_id=p.id AND r.model=$3)
    OR (EXISTS (SELECT 1 FROM harness_package_windows w JOIN harness_package_branches b ON b.window_id=w.id
      JOIN gateway_jobs j ON j.id=b.job_id AND j.project_id=p.id AND j.purpose='primary_a'
      WHERE w.project_id=p.id AND b.branch='A' AND b.settings->>'model'=$3 AND b.settings->>'routeId'=$4)
      AND NOT EXISTS (SELECT 1 FROM harness_package_windows w JOIN harness_package_maps m
        ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
        JOIN harness_package_branches b ON b.window_id=w.id AND b.active AND b.branch='B'
        JOIN gateway_jobs j ON j.id=b.job_id JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
        WHERE w.project_id=p.id AND j.project_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM gateway_jobs j JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
        WHERE j.project_id=p.id AND j.purpose='review' AND j.state IN ('ready','held','leased'))) AS enabled
    FROM projects p WHERE p.id=$1`, [projectId, explicitProfile, model, route]);
  if (!mode?.enabled) return { enabled: false, receipt: null, report: null, progress: null, activity: [] };
  const { rows: [receipt] } = await tx.query<{ receiptId: string; receiptNumber: number; inventoryOpen: boolean;
    acceptedVersions: number; rootFiles: number; rootArchives: number; directChildren: number; deeperChildren: number; officeParts: number }>(
    `WITH latest AS (SELECT r.*, ${inventoryOpen} AS inventory_open FROM intake_receipts r
       WHERE r.project_id=$1 ORDER BY r.number DESC LIMIT 1), occurrences AS (
       SELECT o.*, parent.parent_occurrence_id AS grandparent,
         CASE WHEN o.relative_path ~* '\\.doc$' AND EXISTS (SELECT 1 FROM reader_maps rm
             WHERE rm.project_id=o.project_id AND rm.version_id=o.version_id AND rm.format='doc'
               AND rm.reader_version LIKE 'formats-1.1.4:doc:%'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(rm.units) unit
                 WHERE unit#>>'{locator,coverage}' IN ('addressable','partial'))) THEN false
           WHEN o.relative_path ~* '\\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$' THEN false
           ELSE lower(btrim(split_part(coalesce(u.prepared_media_type,v.media_type,o.declared_media_type),';',1))) IN ('application/zip','application/x-zip-compressed','application/vnd.rar','application/x-rar-compressed','application/x-7z-compressed')
             OR o.relative_path ~* '\\.(zip|rar|7z)$' END AS archive
       FROM latest r JOIN intake_occurrences o ON o.receipt_id=r.id AND o.project_id=r.project_id AND o.state='accepted'
       LEFT JOIN intake_occurrences parent ON parent.id=o.parent_occurrence_id AND parent.receipt_id=o.receipt_id
       LEFT JOIN intake_uploads u ON u.occurrence_id=o.id
       LEFT JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
     ), office_parents AS (
       SELECT parent.id FROM occurrences parent JOIN occurrences child ON child.parent_occurrence_id=parent.id
       WHERE parent.relative_path ~* '\\.(doc|docx|docm)$'
       GROUP BY parent.id HAVING bool_or(child.relative_path ~* '(^|/)\\[Content_Types\\]\\.xml$')
         AND bool_or(child.relative_path ~* '(^|/)word/document\\.xml$')
     ) SELECT r.id AS "receiptId",r.number::float8 AS "receiptNumber",r.inventory_open AS "inventoryOpen",
       count(DISTINCT o.version_id)::int AS "acceptedVersions",
       count(*) FILTER (WHERE o.id IS NOT NULL AND o.parent_occurrence_id IS NULL AND NOT o.archive)::int AS "rootFiles",
       count(*) FILTER (WHERE o.id IS NOT NULL AND o.parent_occurrence_id IS NULL AND o.archive)::int AS "rootArchives",
       count(*) FILTER (WHERE o.parent_occurrence_id IS NOT NULL AND o.grandparent IS NULL)::int AS "directChildren",
       count(*) FILTER (WHERE o.grandparent IS NOT NULL)::int AS "deeperChildren",
       count(*) FILTER (WHERE o.parent_occurrence_id IN (SELECT id FROM office_parents))::int AS "officeParts"
     FROM latest r LEFT JOIN occurrences o ON true GROUP BY r.id,r.number,r.inventory_open`, [projectId]);
  if (!receipt) return { enabled: true, receipt: null, report: null, progress: null, activity: [] };
  const { rows: [report] } = await tx.query<{ id: string; createdAt: Date; summary: unknown; draftAvailable: boolean }>(
    `SELECT r.id,r.created_at AS "createdAt", jsonb_build_object(
       'present',count(*) FILTER (WHERE item->>'status'='present'),
       'partial',count(*) FILTER (WHERE item->>'status'='partial'),
       'notFound',count(*) FILTER (WHERE item->>'status'='not_found'),
       'unassessed',count(*) FILTER (WHERE item->>'status'='unassessed')) AS summary,
       length(btrim(r.draft_text))>0 AS "draftAvailable"
     FROM preliminary_package_reviews r JOIN projects p ON p.id=r.project_id
     LEFT JOIN intake_project_generations g ON g.project_id=p.id
     LEFT JOIN LATERAL jsonb_array_elements(r.rows) item ON true
     WHERE r.project_id=$1 AND r.receipt_id=$2 AND r.model=$3 AND r.catalog_version_id=p.catalog_version_id
       AND r.stage=p.project_stage AND r.input_generation=coalesce(g.generation,0)
       AND (r.preparation_id IS NULL OR EXISTS (SELECT 1 FROM intake_package_preparation_current cur
         WHERE cur.project_id=r.project_id AND cur.receipt_id=r.receipt_id AND cur.manifest_id=r.preparation_id))
     GROUP BY r.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, [projectId, receipt.receiptId, model]);
  const { rows: [progress] } = await tx.query<{
    totalWindows: number; mappedVersions: number; completed: number; covered: number; noMatch: number;
    refused: number; held: number; reading: number; queued: number; unassigned: number; heldReasons: unknown; observations: number;
  }>(`WITH accepted AS (SELECT DISTINCT version_id FROM intake_occurrences
       WHERE project_id=$1 AND receipt_id=$2 AND state='accepted'), maps AS (
       SELECT m.version_id,m.fingerprint FROM harness_package_maps m JOIN accepted a ON a.version_id=m.version_id
       WHERE m.project_id=$1 AND m.active), windows AS (
       SELECT w.id,w.version_id FROM maps m JOIN harness_package_windows w ON w.version_id=m.version_id AND w.map_fingerprint=m.fingerprint WHERE w.project_id=$1 AND ${visibleReadingWindow}
     ), jobs AS (
       SELECT w.id,w.version_id,j.id AS job_id,j.state,j.result,j.reason FROM windows w JOIN harness_package_branches b
         ON b.window_id=w.id AND b.active AND b.branch='A' AND b.settings->>'model'=$3 AND b.settings->>'routeId'=$4
       JOIN gateway_jobs j ON j.id=b.job_id AND j.project_id=$1 AND j.purpose='primary_a'
       JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
     ), reasons AS (SELECT reason,count(*)::int AS count FROM jobs WHERE state='held' GROUP BY reason ORDER BY count(*) DESC,reason LIMIT 8),
     observations AS (SELECT count(DISTINCT o.id)::int AS count FROM jobs j
       JOIN reader_observations o ON o.project_id=$1 AND o.version_id=j.version_id AND o.branch='A'
         AND (o.run_id=j.job_id OR EXISTS (SELECT 1 FROM harness_package_followups f
           WHERE f.root_job_id=j.job_id AND f.job_id=o.run_id AND f.window_id=j.id AND f.branch='A')))
     SELECT (SELECT count(*)::int FROM windows) AS "totalWindows",(SELECT count(DISTINCT version_id)::int FROM maps) AS "mappedVersions",
       count(*) FILTER (WHERE state='done' AND result->>'kind' IN ('covered','reviewed_no_match','final_refusal'))::int AS completed,
       count(*) FILTER (WHERE state='done' AND result->>'kind'='covered')::int AS covered,
       count(*) FILTER (WHERE state='done' AND result->>'kind'='reviewed_no_match')::int AS "noMatch",
       count(*) FILTER (WHERE state='done' AND result->>'kind'='final_refusal')::int AS refused,
       count(*) FILTER (WHERE state='held')::int AS held,count(*) FILTER (WHERE state='leased')::int AS reading,
       count(*) FILTER (WHERE state='ready')::int AS queued,
       ((SELECT count(*) FROM windows) - count(*))::int AS unassigned,
       coalesce((SELECT jsonb_agg(jsonb_build_object('reason',reason,'count',count)) FROM reasons),'[]'::jsonb) AS "heldReasons",
       (SELECT count FROM observations) AS observations FROM jobs`, [projectId, receipt.receiptId, model, route]);
  const { rows: activity } = await tx.query(`WITH accepted AS (
       SELECT DISTINCT ON (o.version_id) o.version_id,v.document_id,o.relative_path AS label
       FROM intake_occurrences o JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
       WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.state='accepted' ORDER BY o.version_id,o.relative_path,o.id
     ) SELECT 'observation' AS kind,a.document_id AS "documentId",a.version_id AS "versionId",a.label,
       o.payload->'address' AS anchor,NULL::text AS text,o.payload->>'quote' AS quote,o.payload->>'value' AS value,
       o.payload->>'unit' AS unit,o.payload->>'limitation' AS limitation,o.created_at AS "createdAt"
     FROM accepted a JOIN harness_package_maps m ON m.version_id=a.version_id AND m.project_id=$1 AND m.active
     JOIN harness_package_windows w ON w.version_id=m.version_id AND w.map_fingerprint=m.fingerprint AND w.project_id=$1
     JOIN harness_package_branches b ON b.window_id=w.id AND b.active AND b.branch='A' AND b.settings->>'model'=$3 AND b.settings->>'routeId'=$4
     JOIN gateway_jobs j ON j.id=b.job_id AND j.project_id=$1 AND j.purpose='primary_a'
     JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
     JOIN reader_observations o ON o.project_id=$1 AND o.version_id=a.version_id AND o.branch='A'
       AND (o.run_id=j.id OR EXISTS (SELECT 1 FROM harness_package_followups f
         WHERE f.root_job_id=j.id AND f.job_id=o.run_id AND f.window_id=w.id AND f.branch='A'))
     WHERE ${visibleReadingWindow} AND (nullif(o.payload->>'quote','') IS NOT NULL OR nullif(o.payload->>'value','') IS NOT NULL OR nullif(o.payload->>'limitation','') IS NOT NULL)
     ORDER BY o.created_at DESC,o.id DESC LIMIT 20`, [projectId, receipt.receiptId, model, route]);
  return { enabled: true, receipt, report: report ?? null, progress, activity };
}
