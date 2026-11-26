import type { PoolClient } from 'pg';

type ProgressEvent = { stage: string; status: string; reason: string | null; at: string };
type ReadingBoundary = { projectId: string; receiptId: string; preparationId: string | null; reviewId: string | null; cutoff: string | null };

const primaryMetrics = [
  'requestBytes', 'promptBytes', 'estimatedInputTokens', 'maxInputTokens', 'maxRequestBytes',
  'inputTokens', 'outputTokens', 'totalFiles', 'selectedFiles', 'coveredFiles',
  'totalLines', 'selectedLines', 'remainingLines', 'elapsedMs', 'providerElapsedMs', 'timeToFirstUsefulMs',
] as const;

export async function readReceiptReadingActivity(tx: PoolClient, boundary: ReadingBoundary) {
  const { projectId, receiptId, preparationId, reviewId, cutoff } = boundary;
  const options = [projectId, receiptId, preparationId, reviewId, cutoff];
  const events = `SELECT stage,status,reason,event_time AS at,fields
    FROM project_reading_activity
    WHERE project_id=$1 AND receipt_id=$2
      AND ($3::uuid IS NULL OR preparation_id=$3 OR preparation_id IS NULL)
      AND ($5::timestamptz IS NULL OR event_time<=$5 OR fields->>'reviewId'=$4::text)`;
  const { rows: [result] } = await tx.query<{
    latest: ProgressEvent | null;
    primary: (ProgressEvent & { fields: Record<string, unknown> }) | null;
  }>(`SELECT
      (SELECT to_jsonb(e)-'fields' FROM (${events}
        AND (NOT (fields ? 'reviewId') OR fields->>'reviewId'=$4::text)
        ORDER BY CASE WHEN stage IN ('primary_review','revision','review_saved') THEN 0 ELSE 1 END,
        event_time DESC,id DESC LIMIT 1) e) AS latest,
      (SELECT to_jsonb(e) FROM (${events} AND stage='primary_review'
        AND fields ? 'requestBytes' ORDER BY event_time DESC,id DESC LIMIT 1) e) AS primary`, options);
  const primary = result.primary;
  const request = primary && {
    status: primary.status,
    ...Object.fromEntries(primaryMetrics.flatMap((name) => {
      const value = primary.fields[name];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[name, value]] : [];
    })),
  };
  const latest = result.latest && {
    ...result.latest,
    reason: result.latest.reason && /^[a-z0-9_.:-]{1,120}$/i.test(result.latest.reason) ? result.latest.reason : null,
  };
  return { latest, request };
}
