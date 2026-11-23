import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { invalid } from '../access/errors.js';
import { synchronizeFacadeAssessment } from '../assessment/facade-store.js';
import { getRevision, snapshot } from '../assessment/store.js';
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
type AssessmentStatus = {
  kind: 'facade' | 'scope';
  version: number;
  outcome: string;
  covered: number;
  total: number;
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

async function captureAssessment(tx: PoolClient, projectId: string, intakeMode: boolean, scopeId?: string): Promise<AssessmentStatus | null> {
  if (intakeMode && !scopeId) {
    const { version, payload } = await synchronizeFacadeAssessment(tx, projectId);
    const questions = payload.contexts.flatMap((context) => context.questions);
    return { kind: 'facade', version, outcome: payload.outcome,
      covered: questions.filter(({ outcome }) => outcome === 'covered').length, total: questions.length };
  }
  if (!scopeId) return null;
  const revision = await getRevision(tx, projectId, scopeId);
  if (!revision) return null;
  const { version, outcome, questions } = await snapshot(tx, revision);
  return { kind: 'scope', version, outcome,
    covered: questions.filter((row) => row.outcome === 'covered').length, total: questions.length };
}

// The count also changes if a concurrently allocated lower event ID commits
// after a higher one. Intake events are append-only.
export const inventoryRevision = `(SELECT concat(coalesce(max(e.id),0),':',count(*))
  FROM intake_events e WHERE e.receipt_id=r.id)`;

const currentReadingJobs = `SELECT j.id,j.purpose,j.state,j.payload FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
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
        (r.sealed_at IS NULL OR EXISTS (
          SELECT 1 FROM intake_occurrences o WHERE o.receipt_id=r.id AND (o.state='declared' OR o.inventory_pending)
        ) OR EXISTS (
          SELECT 1 FROM intake_imports i WHERE i.receipt_id=r.id AND i.state IN ('queued','running','paused')
        )) AS "inventoryOpen",
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
  const totals = {
    all: rows.length,
    open: rows.filter((row) => includes(row, 'open')).length,
    processing: rows.filter((row) => includes(row, 'processing')).length,
  };
  const active = rows.find((row) => row.processing) ?? rows.find((row) => row.inventoryOpen);
  return {
    ...position, projectId, scopeId: scopeId ?? null, catalogAssigned: project.catalogAssigned,
    assessment, totals, readings,
    confirmedBytes: rows.reduce((sum, row) => sum + Number(row.confirmedBytes), 0),
    acceptedOccurrences: rows.reduce((sum, row) => sum + row.originals, 0),
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
  const { receipts: _receipts, ...summary } = payload;
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
