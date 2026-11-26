import type { PoolClient } from 'pg';

type Pixels = {
  confirmedImages: number; partialImages: number;
  latest: { id: string; partsDelivered: number; partsExpected: number };
};

/** Reduce only matching runs to proof records. The stored request/response and image bytes stay internal. */
export async function readDeliveredPixels(tx: PoolClient, input: {
  projectId: string; receiptId: string; preparationId: string | null; cutoff: string | null; versionIds: string[];
}) {
  if (!input.versionIds.length) return new Map<string, Pixels>();
  // The local transport predates the standard gateway receipts and exists on only some installs.
  const { rows: [{ available }] } = await tx.query<{ available: boolean }>(
    "SELECT to_regclass('local_terra_calls') IS NOT NULL AS available");
  const local = available ? `EXISTS (
    SELECT 1 FROM local_terra_calls l WHERE l.project_id=$1 AND l.job_id=e.run_id AND l.id::text=m.event->>'attemptId'
      AND l.request_hash=m.event->>'requestHash' AND l.model='gpt-6.1-terra' AND l.state='completed'
      AND ($4::timestamptz IS NULL OR l.finished_at<=$4)
  )` : 'false';
  const { projectId, receiptId, preparationId, cutoff, versionIds } = input;
  const { rows } = await tx.query<{ versionId: string; value: Pixels }>(`
    WITH images AS MATERIALIZED (
      SELECT ev.id,ev.version_id,ev.run_id,ev.created_at,ev.payload
      FROM reader_evidence ev
      JOIN gateway_jobs j ON j.id=ev.run_id AND j.project_id=$1 AND j.purpose='primary_a'
      JOIN reader_maps rm ON rm.project_id=$1 AND rm.version_id=ev.version_id AND rm.reader_version=ev.reader_version
      JOIN intake_document_versions v ON v.project_id=$1 AND v.id=ev.version_id
      JOIN intake_originals o ON o.project_id=$1 AND o.id=v.original_id AND o.sha256=rm.original_sha256
      WHERE ev.project_id=$1 AND ev.version_id=ANY($5::uuid[]) AND ev.branch='A'
        AND ev.payload#>>'{source,sha256}'=o.sha256
        AND ev.payload->>'representation'='render' AND ev.payload->>'mediaType' LIKE 'image/%'
        AND ev.payload->>'receiptId'=$2::uuid::text
        AND ($4::timestamptz IS NULL OR ev.created_at<=$4)
        AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM intake_package_preparation_items pi
          JOIN harness_package_maps pm ON pm.version_id=pi.version_id AND pm.fingerprint=pi.map_fingerprint AND pm.project_id=pi.project_id
          WHERE pi.manifest_id=$3 AND pi.project_id=$1 AND pi.version_id=ev.version_id AND pm.reader_version=ev.reader_version))
        AND (j.payload#>>'{packageWindow,preparationId}' IS NULL OR EXISTS (
          SELECT 1 FROM intake_package_preparations p WHERE p.project_id=$1 AND p.receipt_id=$2
            AND p.id::text=j.payload#>>'{packageWindow,preparationId}' AND ($3::uuid IS NULL OR p.id=$3)))
    ), turns AS MATERIALIZED (
      SELECT e.id,e.version_id,m.event,m.created_at,m.sequence,m.job_id,
        ${local} AS local_completed
      FROM images e
      JOIN harness_research_events m ON m.job_id=e.run_id AND m.created_at>=e.created_at
        AND m.event->>'kind'='model' AND m.event->'inputRefs' ? e.id::text
      WHERE ($4::timestamptz IS NULL OR m.created_at<=$4) AND
        (${local} OR EXISTS (
          SELECT 1 FROM gateway_attempts a WHERE a.project_id=$1 AND a.job_id=e.run_id
            AND a.id::text=m.event->>'attemptId' AND a.state='paid' AND a.input_refs ? e.id::text
        ))
    ), explicit_parts AS (
      SELECT t.id,t.version_id,t.created_at,v.part->>'part' AS part,v.part->>'total' AS total
      FROM turns t CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(t.event->'visualReceipts')='array' THEN t.event->'visualReceipts' ELSE '[]'::jsonb END) v(part)
      WHERE v.part->>'evidenceId'=t.id::text AND v.part->>'part' ~ '^[1-9][0-9]?$'
        AND v.part->>'total' ~ '^[1-9][0-9]?$'
    ), legacy_full AS (
      SELECT t.id,t.version_id,max(t.created_at) AS created_at FROM turns t JOIN images ev ON ev.id=t.id
      WHERE t.local_completed AND NOT (t.event ? 'visualReceipts')
        AND ev.payload->>'mediaType'='image/png'
        AND EXISTS (
          SELECT 1 FROM harness_research_events reply
          WHERE reply.job_id=t.job_id AND reply.sequence<t.sequence AND reply.event->>'kind'='tool'
            AND reply.event#>>'{reply,evidence,evidenceId}'=t.id::text
            AND reply.event#>>'{reply,evidence,sha256}'=ev.payload->>'sha256'
            AND reply.event#>>'{reply,image,mediaType}'='image/png'
            AND left(reply.event#>>'{reply,image,data}',11)='iVBORw0KGgo'
        )
      GROUP BY t.id,t.version_id
    ), parts AS (
      SELECT id,version_id,max(created_at) AS created_at,total::int AS expected,count(DISTINCT part)::int AS delivered
      FROM explicit_parts WHERE part::int<=total::int AND total::int<=64
      GROUP BY id,version_id,total
      UNION ALL
      SELECT id,version_id,created_at,1,1 FROM legacy_full
    ), verified AS (
      SELECT DISTINCT ON (id) id,version_id,created_at,expected,delivered
      FROM parts ORDER BY id,(delivered=expected) DESC,created_at DESC,delivered DESC
    )
    SELECT version_id AS "versionId",jsonb_build_object(
      'confirmedImages',count(*) FILTER (WHERE delivered=expected),
      'partialImages',count(*) FILTER (WHERE delivered<expected),
      'latest',(array_agg(jsonb_build_object('id',id,'partsDelivered',delivered,'partsExpected',expected)
        ORDER BY created_at DESC,id DESC))[1]) AS value
    FROM verified GROUP BY version_id`, [projectId,receiptId,preparationId,cutoff,versionIds]);
  return new Map(rows.map(row => [row.versionId, row.value]));
}
