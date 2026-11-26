import type { PoolClient } from 'pg';
import { inventoryOpen } from '../intake/receipts.js';
import { AssessmentError } from './store.js';
import { readReceiptReadingActivity } from './receipt-reading-activity.js';
import { readDeliveredPixels } from './reading-delivery.js';

type Target = {
  reviewId: string | null; preparationId: string | null; cutoff: string | null;
  historical: boolean; inventoryOpen: boolean; receiptNumber: number;
};
type ReadingFile = {
  versionId: string; documentId: string; label: string; mediaType: string;
  preparation: { kind: string; state: string; reason: string | null } | null;
  mapUnits: number | null;
  index: { processed: number; total: number; native: number; graphics: number; ocr: number; rasterOcr: number; reason: string | null } | null;
  openings: { units: number; rendered: number; ocr: number; latestId: string | null; latestRenderId: string | null; latestOcrId: string | null; latestOcrInputId: string | null };
  windows: { total: number; checked: number; limited: number; held: number; queued: number; reading: number } | null;
  citations: { count: number; examples: { key: string; title: string; anchor: string }[] } | null;
};
const pageSize = 20;

export async function readReceiptEvidenceChain(tx: PoolClient, input: {
  projectId: string; receiptId: string; reviewId?: string; versionId?: string; after?: string;
}) {
  const { projectId, receiptId, reviewId, versionId, after } = input;
  const { rows: [target] } = await tx.query<Target>(`
    SELECT rev.id AS "reviewId", CASE WHEN rev.id IS NOT NULL THEN rev.preparation_id
      ELSE cur.manifest_id END AS "preparationId",
      CASE WHEN rev.id IS NOT NULL AND NOT rev.current THEN rev.created_at::text END AS cutoff,
      (NOT r.is_latest OR (rev.id IS NOT NULL AND NOT rev.current)) AS historical,
      r.open AS "inventoryOpen",r.number::float8 AS "receiptNumber"
    FROM (SELECT r.*, ${inventoryOpen} AS open,
      NOT EXISTS (SELECT 1 FROM intake_receipts newer WHERE newer.project_id=r.project_id AND newer.number>r.number) AS is_latest
      FROM intake_receipts r WHERE r.project_id=$1 AND r.id=$2) r
    JOIN projects p ON p.id=r.project_id
    LEFT JOIN intake_project_generations g ON g.project_id=p.id
    LEFT JOIN intake_package_preparation_current cur ON cur.project_id=r.project_id AND cur.receipt_id=r.id
    LEFT JOIN LATERAL (
      SELECT x.id,x.preparation_id,x.created_at,
        (r.is_latest AND x.catalog_version_id=p.catalog_version_id AND x.stage=p.project_stage
          AND x.input_generation=coalesce(g.generation,0)
          AND (x.preparation_id IS NULL OR x.preparation_id=cur.manifest_id)
          AND NOT EXISTS (SELECT 1 FROM preliminary_package_reviews newer
            WHERE newer.project_id=x.project_id AND newer.receipt_id=x.receipt_id AND newer.catalog_version_id=x.catalog_version_id
              AND (newer.created_at,newer.id)>(x.created_at,x.id))) AS current
      FROM preliminary_package_reviews x WHERE x.project_id=r.project_id AND x.receipt_id=r.id
        AND (($3::uuid IS NOT NULL AND x.id=$3) OR ($3 IS NULL AND x.catalog_version_id=p.catalog_version_id
          AND x.stage=p.project_stage AND x.input_generation=coalesce(g.generation,0)
          AND (x.preparation_id IS NULL OR x.preparation_id=cur.manifest_id)))
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) rev ON true
    WHERE $3::uuid IS NULL OR rev.id=$3`, [projectId, receiptId, reviewId ?? null]);
  if (!target) throw new AssessmentError(404, 'receipt_evidence_unavailable', 'Поступление или разбор недоступны.');

  const boundary = { projectId, receiptId, ...target };
  const { rows } = await tx.query<ReadingFile>(`
    WITH pinned_review AS (
      SELECT inventory,rows FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2 AND id=$3
    ), accepted AS MATERIALIZED (
      SELECT DISTINCT ON (v.id) v.id AS "versionId",v.document_id AS "documentId",v.media_type AS "mediaType",
        original.sha256,o.relative_path AS label
      FROM intake_occurrences o
      JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
      JOIN intake_originals original ON original.id=v.original_id AND original.project_id=v.project_id
      WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.state='accepted'
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM pinned_review r, jsonb_array_elements(r.inventory) item
          WHERE item->>'versionId'=v.id::text AND item->>'originalSha256'=original.sha256))
      ORDER BY v.id,o.relative_path,o.id
    ), files AS MATERIALIZED (
      SELECT * FROM accepted f WHERE ($7::uuid IS NULL OR f."versionId"=$7)
        AND ($6::uuid IS NULL OR (f.label,f."versionId")>(SELECT label,"versionId" FROM accepted WHERE "versionId"=$6))
      ORDER BY label,"versionId" LIMIT $8
    ), prepared AS (
      SELECT item FROM intake_package_preparations p
      CROSS JOIN LATERAL jsonb_array_elements(p.manifest->'items') item
      WHERE p.project_id=$1 AND p.receipt_id=$2 AND p.id=$4
    )
    SELECT f."versionId",f."documentId",f."mediaType",f.label,
      prep.value AS preparation,rm.units AS "mapUnits",idx.value AS index,evidence.value AS openings,
      reading.value AS windows,citations.value AS citations
    FROM files f
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('kind',item->>'kind','state',item->>'state','reason',item->>'reason') AS value
      FROM prepared WHERE item->>'versionId'=f."versionId"::text AND item->>'originalSha256'=f.sha256
      ORDER BY (item->>'kind'='document') DESC,(item->>'state'='available') DESC,item->>'occurrenceId' LIMIT 1
    ) prep ON true
    LEFT JOIN LATERAL (
      SELECT rm.reader_version,jsonb_array_length(rm.units) AS units FROM reader_maps rm
      WHERE rm.project_id=$1 AND rm.version_id=f."versionId" AND rm.original_sha256=f.sha256
        AND ($5::timestamptz IS NULL OR rm.created_at<=$5)
        AND ($4::uuid IS NULL OR EXISTS (
          SELECT 1 FROM intake_package_preparation_items pi
          JOIN harness_package_maps pm ON pm.version_id=pi.version_id AND pm.fingerprint=pi.map_fingerprint AND pm.project_id=pi.project_id
          WHERE pi.manifest_id=$4 AND pi.project_id=$1 AND pi.version_id=f."versionId" AND pm.reader_version=rm.reader_version))
      ORDER BY rm.created_at DESC,rm.reader_version DESC LIMIT 1
    ) rm ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('processed',m.next_ordinal,'total',m.total,'native',blocks.native,
        'graphics',blocks.graphics,'ocr',blocks.ocr,'rasterOcr',blocks.raster_ocr,'reason',coalesce(m.last_error,m.physical_limitation)) AS value
      FROM project_memory_versions m
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE 'native'=ANY(b.remaining)) AS native,
          count(*) FILTER (WHERE 'graphics'=ANY(b.remaining)) AS graphics,count(*) FILTER (WHERE 'ocr'=ANY(b.remaining)) AS ocr,
          count(*) FILTER (WHERE m.format='image' AND b.artifact_sha256 IS NOT NULL AND NOT ('ocr'=ANY(b.remaining))) AS raster_ocr
        FROM project_memory_blocks b WHERE b.project_id=m.project_id AND b.version_id=m.version_id AND b.contract=m.contract
      ) blocks
      WHERE m.project_id=$1 AND m.version_id=f."versionId" AND m.reader_version=rm.reader_version
        AND m.total IS NOT NULL AND ($5::timestamptz IS NULL OR m.updated_at<=$5)
      ORDER BY m.contract DESC LIMIT 1
    ) idx ON true
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object('units',count(DISTINCT payload#>>'{address,unitId}'),
        'rendered',count(DISTINCT payload#>>'{address,unitId}') FILTER (WHERE payload->>'representation'='render' AND payload->>'mediaType' LIKE 'image/%'),
        'ocr',count(DISTINCT payload#>>'{address,unitId}') FILTER (WHERE (payload->>'representation'='ocr' OR payload->>'format'='image') AND jsonb_typeof(payload->'inputImage')='object'),
        'latestId',(array_agg(id ORDER BY created_at DESC,id DESC))[1],
        'latestRenderId',(array_agg(id ORDER BY created_at DESC,id DESC) FILTER (WHERE payload->>'representation'='render' AND payload->>'mediaType' LIKE 'image/%'))[1],
        'latestOcrId',(array_agg(id ORDER BY created_at DESC,id DESC) FILTER (WHERE
          (payload->>'representation'='ocr' OR payload->>'format'='image') AND payload->>'mediaType'='application/json'
          AND jsonb_typeof(payload->'inputImage')='object'))[1],
        'latestOcrInputId',(array_agg(id ORDER BY created_at DESC,id DESC) FILTER (WHERE
          jsonb_typeof(payload->'inputImage')='object'))[1]) AS value
      FROM reader_evidence ev WHERE ev.project_id=$1 AND ev.version_id=f."versionId"
        AND ev.payload#>>'{source,sha256}'=f.sha256 AND ev.payload->>'receiptId'=$2::uuid::text
        AND ($5::timestamptz IS NULL OR ev.created_at<=$5)
        AND ($4::uuid IS NULL OR ev.reader_version=rm.reader_version)
    ) evidence
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('total',count(*),'checked',count(*) FILTER (WHERE state='done' AND outcome IN ('covered','reviewed_no_match')),
        'limited',count(*) FILTER (WHERE state='done' AND coalesce(outcome,'') NOT IN ('covered','reviewed_no_match')),
        'held',count(*) FILTER (WHERE state='held'),'queued',count(*) FILTER (WHERE state='ready' OR state IS NULL),
        'reading',count(*) FILTER (WHERE state='leased')) AS value
      FROM (
        SELECT w.id,j.state,j.result->>'kind' AS outcome
        FROM intake_package_preparation_windows pw JOIN harness_package_windows w ON w.id=pw.window_id AND w.project_id=pw.project_id
        LEFT JOIN LATERAL (
          SELECT j.state,j.result
          FROM harness_package_branches b
          JOIN gateway_jobs j ON j.project_id=$1 AND j.id=b.job_id AND j.purpose='primary_a'
            AND (j.payload#>>'{packageWindow,preparationId}'=$4::uuid::text
              OR (j.payload#>>'{packageWindow,preparationId}' IS NULL AND EXISTS (
                SELECT 1 FROM intake_reader_jobs old WHERE old.project_id=$1 AND old.receipt_id=$2 AND old.version_id=w.version_id)))
          JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.project_id=$1 AND g.current
          WHERE b.window_id=w.id AND b.active AND b.branch='A' AND b.settings->>'model'='gpt-6.1-terra'
        ) j ON true
        WHERE pw.manifest_id=$4 AND pw.project_id=$1 AND w.version_id=f."versionId"
      ) active_windows
      HAVING count(*)>0
    ) reading ON NOT $9::boolean
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('count',count(*),'examples',coalesce(jsonb_agg(value ORDER BY step) FILTER (WHERE step<=4),'[]')) AS value
      FROM (
        SELECT row_number() OVER (ORDER BY requirement.ordinal,source.ordinal) AS step,
          jsonb_build_object('key',requirement.item->>'key','title',requirement.item->>'title','anchor',source.item->>'anchor') AS value
        FROM pinned_review r
        CROSS JOIN LATERAL jsonb_array_elements(r.rows) WITH ORDINALITY requirement(item,ordinal)
        CROSS JOIN LATERAL jsonb_array_elements(requirement.item->'sources') WITH ORDINALITY source(item,ordinal)
        WHERE source.item->>'versionId'=f."versionId"::text
          AND source.item->>'documentId'=f."documentId"::text AND source.item->>'originalSha256'=f.sha256
      ) examples
    ) citations ON $3::uuid IS NOT NULL
    ORDER BY f.label,f."versionId"`, [projectId,receiptId,target.reviewId,target.preparationId,target.cutoff,after ?? null,versionId ?? null,pageSize + 1,target.historical]);
  if (versionId && !rows.length) throw new AssessmentError(404, 'receipt_file_unavailable', 'Файл недоступен в этой описи.');
  const files = rows.slice(0,pageSize);
  const delivered = await readDeliveredPixels(tx, { ...boundary, versionIds: files.map(({versionId}) => versionId) });
  const activity = await readReceiptReadingActivity(tx, boundary);
  return {
    receiptId, ...target, ...activity,
    items: files.map(file => ({ ...file, pixels: delivered.get(file.versionId) ?? null })),
    nextCursor: rows.length > pageSize ? files[pageSize-1].versionId : null,
  };
}
