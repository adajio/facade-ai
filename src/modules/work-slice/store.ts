import { inventoryOpen } from '../intake/receipts.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { invalid } from '../access/errors.js';
import { synchronizeFacadeAssessment } from '../assessment/facade-store.js';
import { getLockedGate, getRevision, snapshot, synchronize } from '../assessment/store.js';
import { readProjectionPosition } from '../supplements/events.js';
import { SupplementError } from '../supplements/errors.js';

export const filters = ['all', 'open', 'processing'] as const;
export type Filter = typeof filters[number];
export type ReceiptRow = {
  receiptId: string;
  number: number;
  sealed: boolean;
  inventoryOpen: boolean;
  processing: boolean;
  source: string;
  createdAt: string;
  inventoryRevision: string;
};
type AreaCounts = {
  outcome: string;
  covered: number;
  checked: number;
  conflicts: number;
  total: number;
  ready: number;
  review: number;
  letter: number;
  actionable: number;
  concluded: boolean;
  previousConclusion?: { assessmentVersion: number; reason: string };
};
type AssessmentStatus = AreaCounts & {
  kind: 'facade' | 'scope'; version: number; contextId?: string;
  contexts?: (AreaCounts & { contextId: string; kind: string; name: string })[];
};
type ReadingStatus = { state: string; branch: 'A' | 'B' | null; total: number };
type WorkSlice = Awaited<ReturnType<typeof capture>>;

export const snapshotRequired = () => new SupplementError(409, 'snapshot_required', 'Срез или курсор устарел. Обновите список поступлений.');
export const inventoryUnavailable = () => new SupplementError(409, 'inventory_snapshot_unavailable', 'Закреплённая опись недоступна. Откройте актуальную опись.');

export function parseFilter(value: unknown): Filter {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'open' || value === 'processing') return value;
  throw invalid('invalid_filter', 'Выберите допустимый фильтр описи.');
}

function includes(row: Pick<ReceiptRow, 'inventoryOpen' | 'processing'>, filter: Filter) {
  return filter === 'all' || (filter === 'open' ? row.inventoryOpen : row.processing);
}

export function countRequirements(questions: { outcome: string; letterEligible?: boolean; machine: { outcome: string; citations?: unknown[] } }[]) {
  const ready = questions.filter(({ outcome }) => outcome === 'covered' || outcome === 'excluded').length;
  const letter = questions.filter(({ letterEligible }) => letterEligible).length;
  return {
    ready, letter, review: questions.filter((q) => !q.letterEligible && q.outcome !== 'covered' && q.outcome !== 'excluded').length,
    actionable: questions.filter((q) => !q.letterEligible && q.outcome !== 'covered' && q.outcome !== 'excluded' &&
      (q.outcome !== 'needs_review' || Boolean(q.machine.citations?.length))).length,
    covered: questions.filter(({ outcome }) => outcome === 'covered').length,
    checked: questions.filter(({ outcome }) => outcome !== 'needs_review').length,
    conflicts: questions.filter(({ machine }) => machine.outcome === 'confirmed_conflict').length,
    total: questions.length,
  };
}

async function captureAssessment(tx: PoolClient, projectId: string, intakeMode: boolean, scopeId?: string): Promise<AssessmentStatus | null> {
  if (intakeMode && !scopeId) {
    const { version, payload } = await synchronizeFacadeAssessment(tx, projectId);
    const questions = payload.contexts.flatMap((context) => context.questions);
    return { kind: 'facade', version, outcome: payload.outcome, ...countRequirements(questions),
      contexts: payload.contexts.map((area) => ({
        contextId: area.assessmentContextId, kind: area.kind, name: area.name,
        outcome: area.outcome, concluded: Boolean(area.conclusion), ...countRequirements(area.questions),
        ...(area.previousConclusion && { previousConclusion: { assessmentVersion: area.previousConclusion.assessmentVersion,
          reason: area.previousConclusion.reason } }),
      })),
      contextId: payload.contexts.length === 1 ? payload.contexts[0].assessmentContextId : undefined,
      concluded: payload.contexts.length > 0 && payload.contexts.every((item) => Boolean(item.conclusion)) };
  }
  if (!scopeId) return null;
  if (!await getRevision(tx, projectId, scopeId)) return null;
  const gate = await getLockedGate(tx, projectId, scopeId);
  const revision = await synchronize(tx, projectId, scopeId, gate);
  const { version, outcome, questions, conclusion } = await snapshot(tx, revision, gate);
  return { kind: 'scope', version, outcome, ...countRequirements(questions), concluded: Boolean(conclusion) };
}

// The count also changes if a concurrently allocated lower event ID commits
// after a higher one. Intake events are append-only.
export const inventoryRevision = `(SELECT concat(coalesce(max(e.id),0),':',count(*))
  FROM intake_events e WHERE e.receipt_id=r.id)`;

const currentReadingJobs = `SELECT j.id,j.purpose,j.state,j.payload,j.reason,j.next_action FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
  WHERE j.project_id=$1 AND g.current AND j.kind='harness_research'
    AND (j.payload->'packageWindow' IS NULL OR EXISTS (
      SELECT 1 FROM harness_package_branches b JOIN harness_package_windows w ON w.id=b.window_id
      JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint
      WHERE b.job_id=j.id AND b.active AND m.active
    ))`;

async function capture(tx: PoolClient, projectId: string, scopeId?: string) {
  const { rows: [project] } = await tx.query<{ intakeMode: boolean; catalogAssigned: boolean }>(
    `SELECT intake_mode AS "intakeMode",catalog_version_id IS NOT NULL AS "catalogAssigned" FROM projects WHERE id=$1`, [projectId],
  );
  const assessment = await captureAssessment(tx, projectId, project.intakeMode, scopeId);
  // Assessment may publish a revision in this transaction. Include its committed
  // event coordinate in the very same slice rather than reading the earlier head.
  await tx.query('SET CONSTRAINTS supplement_publish_enqueued_events IMMEDIATE');
  const position = await readProjectionPosition(tx, projectId);
  const { rows } = await tx.query<Omit<ReceiptRow, 'createdAt'> & {
    createdAt: Date; confirmedBytes: string; originals: number;
  }>(
    `WITH jobs AS MATERIALIZED (${currentReadingJobs}),
      active_versions AS (
        SELECT DISTINCT address->>'versionId' AS id FROM jobs j
        CROSS JOIN LATERAL unnest(ARRAY[
          j.payload#>'{place,source}', j.payload#>'{dispute,a,place,source}', j.payload#>'{dispute,b,place,source}'
        ]) AS source(address)
        WHERE j.state IN ('ready','leased') AND address IS NOT NULL
      ),
      active_receipts AS (
        SELECT o.receipt_id FROM intake_occurrences o JOIN active_versions v ON v.id=o.version_id::text
        WHERE o.project_id=$1
        UNION SELECT receipt_id FROM intake_reader_jobs WHERE project_id=$1 AND dispatched_at IS NULL
        UNION SELECT receipt_id FROM import_jobs WHERE project_id=$1 AND status IN ('queued','running')
        UNION SELECT receipt_id FROM intake_imports WHERE project_id=$1 AND state IN ('queued','running')
      ),
      originals AS (
        SELECT o.receipt_id, count(*)::int AS count, sum(b.size) AS bytes
        FROM intake_occurrences o JOIN intake_document_versions v ON v.project_id=o.project_id AND v.id=o.version_id
        JOIN intake_originals b ON b.project_id=v.project_id AND b.id=v.original_id
        WHERE o.project_id=$1 AND o.state='accepted' GROUP BY o.receipt_id
      ),
      uploads AS (
        SELECT u.receipt_id, sum(p.length) AS bytes FROM intake_uploads u JOIN intake_parts p ON p.upload_id=u.id
        WHERE u.project_id=$1 AND u.state='uploading' AND u.expires_at>statement_timestamp()
        GROUP BY u.receipt_id
      )
      SELECT r.id AS "receiptId",r.number::float8 AS number,r.sealed_at IS NOT NULL AS sealed,
        ${inventoryOpen} AS "inventoryOpen",
        p.receipt_id IS NOT NULL AS processing,r.source,r.created_at AS "createdAt",
        ${inventoryRevision} AS "inventoryRevision",
        (coalesce(o.bytes,0)+coalesce(u.bytes,0))::text AS "confirmedBytes",coalesce(o.count,0) AS originals
      FROM intake_receipts r LEFT JOIN active_receipts p ON p.receipt_id=r.id
      LEFT JOIN originals o ON o.receipt_id=r.id LEFT JOIN uploads u ON u.receipt_id=r.id
      WHERE r.project_id=$1 ORDER BY r.number DESC,r.id`, [projectId],
  );
  const { rows: readings } = await tx.query<ReadingStatus>(
    `WITH jobs AS (${currentReadingJobs})
     SELECT state,CASE purpose WHEN 'primary_a' THEN 'A' WHEN 'primary_b' THEN 'B' END AS branch,count(*)::int AS total
     FROM jobs GROUP BY 1,2 ORDER BY 2,1`, [projectId],
  );
  const stops = readings.some(row => row.state === 'held') ? (await tx.query<{
    jobId: string; branch: 'A' | 'B' | null; reason: string | null; nextAction: string | null;
    versionId: string | null; receiptId: string | null; label: string | null;
  }>(`WITH jobs AS (${currentReadingJobs})
      SELECT j.id AS "jobId", CASE j.purpose WHEN 'primary_a' THEN 'A' WHEN 'primary_b' THEN 'B' END AS branch,
        j.reason, j.next_action AS "nextAction", o.version_id AS "versionId", o.receipt_id AS "receiptId", o.relative_path AS label
      FROM jobs j LEFT JOIN LATERAL (SELECT version_id,receipt_id,relative_path FROM intake_occurrences
        WHERE project_id=$1 AND state='accepted' AND version_id::text=coalesce(
          j.payload#>>'{place,source,versionId}',j.payload#>>'{dispute,a,place,source,versionId}')
        ORDER BY created_at,id LIMIT 1) o ON true
      WHERE j.state='held' ORDER BY (j.reason='unknown_charge') DESC NULLS LAST,j.id LIMIT 9`, [projectId])).rows : [];
  const totals = {
    all: rows.length,
    open: rows.filter((row) => includes(row, 'open')).length,
    processing: rows.filter((row) => includes(row, 'processing')).length,
  };
  const { rows: [files] } = await tx.query<{ accepted: number; prepared: number }>(
    `SELECT count(DISTINCT o.version_id)::int AS accepted,
            count(DISTINCT o.version_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(m.units) u
              WHERE u->>'id' IS DISTINCT FROM 'original'
                AND coalesce(u#>>'{locator,coverage}','addressable') NOT IN ('held','original_only')
            ))::int AS prepared
       FROM intake_occurrences o
       LEFT JOIN LATERAL (SELECT units FROM reader_maps
         WHERE version_id=o.version_id AND project_id=o.project_id ORDER BY created_at DESC,reader_version DESC LIMIT 1) m ON true
       WHERE o.project_id=$1 AND o.state='accepted'`, [projectId],
  );
  const active = rows.find((row) => row.processing) ?? rows.find((row) => row.inventoryOpen);
  return {
    ...position, projectId, scopeId: scopeId ?? null, catalogAssigned: project.catalogAssigned,
    assessment, totals, readings, files, stops: stops.slice(0, 8), moreStops: stops.length > 8,
    confirmedBytes: rows.reduce((sum, row) => sum + Number(row.confirmedBytes), 0),
    acceptedOccurrences: rows.reduce((sum, row) => sum + row.originals, 0),
    latestReceipt: rows[0] ? { receiptId: rows[0].receiptId, number: rows[0].number } : null,
    activeReceipt: active ? { receiptId: active.receiptId, number: active.number,
      filter: active.processing ? 'processing' as const : 'open' as const } : null,
    receipts: rows.map(({ confirmedBytes: _bytes, originals: _originals, createdAt, ...row }) => ({ ...row, createdAt: createdAt.toISOString() })),
  };
}

export async function currentWorkSlice(tx: PoolClient, projectId: string, scopeId?: string) {
  const payload = await capture(tx, projectId, scopeId);
  const content = JSON.stringify(payload);
  const hash = createHash('sha256').update(content).digest('hex');
  await tx.query(`DELETE FROM work_slices WHERE id IN (
    SELECT id FROM work_slices WHERE expires_at<=statement_timestamp()
    ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED)`);
  const prior = await tx.query<{ id: string }>(
    'SELECT id FROM work_slices WHERE project_id=$1 AND fingerprint=$2 AND expires_at>statement_timestamp()',
    [projectId, hash],
  );
  let workSliceId = prior.rows[0]?.id;
  if (!workSliceId) {
    const { rows: [saved] } = await tx.query<{ id: string }>(
      `INSERT INTO work_slices(project_id,fingerprint,payload) VALUES($1,$2,$3)
       ON CONFLICT (project_id,fingerprint) DO UPDATE SET
         id=EXCLUDED.id,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at RETURNING id`,
      [projectId, hash, content],
    );
    workSliceId = saved.id;
    await tx.query(`DELETE FROM work_slices WHERE id IN (
      SELECT id FROM work_slices WHERE project_id=$1 ORDER BY created_at DESC,id OFFSET 128
    ) AND id<>$2`, [projectId, workSliceId]);
  }
  return summarizeCurrentReader(tx, payload, workSliceId);
}

export async function summarizeCurrentReader(tx: PoolClient, payload: WorkSlice, workSliceId: string) {
  // Liveness changes independently of the pinned receipt list and its pagination cursor.
  const { rows: [readingService] } = await tx.query<{ enabled: boolean; observedAt: Date; validUntil: Date }>(
    `SELECT transport_enabled AS enabled, observed_at AS "observedAt", valid_until AS "validUntil"
     FROM reader_availability ORDER BY (valid_until > statement_timestamp()) DESC,
       CASE WHEN valid_until > statement_timestamp() THEN transport_enabled END DESC, observed_at DESC LIMIT 1`);
  return { ...summarizeWorkSlice(payload, workSliceId), readingService: readingService ?? null };
}

export function summarizeWorkSlice(slice: WorkSlice, workSliceId: string) {
  const { receipts: _receipts, ...summary } = slice;
  return { ...summary, workSliceId, filters: filters.map((filter) => ({ filter, total: summary.totals[filter] })) };
}

export async function loadWorkSlice(tx: PoolClient, projectId: string, workSliceId: string) {
  const { rows: [row] } = await tx.query<{ payload: WorkSlice }>(
    'SELECT payload FROM work_slices WHERE project_id=$1 AND id=$2 AND expires_at>statement_timestamp()',
    [projectId, workSliceId],
  );
  if (!row) throw snapshotRequired();
  return row.payload;
}

function cursorFor(workSliceId: string, filter: Filter, receiptId: string) {
  return Buffer.from(`${workSliceId}:${filter}:${receiptId}`, 'ascii').toString('base64url');
}

export function receiptPage(slice: WorkSlice, workSliceId: string, filter: Filter, limit: number, cursor?: string, receiptId?: string) {
  const rows = slice.receipts.filter((row) => includes(row, filter));
  let start = 0;
  let selection: 'present' | 'filtered' | 'missing' | undefined;
  if (cursor !== undefined) {
    if (!/^[a-zA-Z0-9_-]{1,140}$/.test(cursor)) throw snapshotRequired();
    const [pinnedId, pinnedFilter, anchor] = Buffer.from(cursor, 'base64url').toString('ascii').split(':');
    const index = rows.findIndex((row) => row.receiptId === anchor && cursorFor(workSliceId, filter, row.receiptId) === cursor);
    if (pinnedId !== workSliceId || pinnedFilter !== filter || index === -1) throw snapshotRequired();
    start = index + 1;
  } else if (receiptId) {
    const index = rows.findIndex((row) => row.receiptId === receiptId);
    selection = index >= 0 ? 'present' : slice.receipts.some((row) => row.receiptId === receiptId) ? 'filtered' : 'missing';
    if (index >= 0) start = Math.floor(index / limit) * limit;
  }
  const publicRow = ({ inventoryRevision: _revision, ...row }: ReceiptRow) => row;
  const receipts = rows.slice(start, start + limit).map(publicRow);
  const selected = receiptId && slice.receipts.find((row) => row.receiptId === receiptId);
  const tail = receipts.at(-1);
  return { receipts, total: slice.totals[filter], workSliceId, filter, selection,
    ...(selected ? { selectedReceipt: publicRow(selected) } : {}),
    nextCursor: tail && start + receipts.length < rows.length ? cursorFor(workSliceId, filter, tail.receiptId) : null };
}
