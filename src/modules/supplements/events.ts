import type { Pool, PoolClient } from 'pg';
import { SupplementError } from './errors.js';

export interface ProjectionPosition {
  sliceId: string;
  cursor: string;
  projectionVersion: string;
}

interface ProjectionHead {
  slice_id: string;
  cursor: string;
  retained_after: string;
}

interface EventInput {
  type: string;
  payload: Readonly<Record<string, unknown>>;
}

function position(sliceId: string, cursor: string): ProjectionPosition {
  return { sliceId, cursor, projectionVersion: cursor };
}

// Queue inside the domain transaction. At commit the trigger locks the
// projection head and allocates the next visible position.
export async function publishProjectEvent(tx: PoolClient, projectId: string, event: EventInput): Promise<void> {
  await tx.query(`
    INSERT INTO supplement_event_publications (project_id, type, payload) VALUES ($1, $2, $3)
  `, [projectId, event.type, event.payload]);
}

async function readHead(tx: PoolClient, projectId: string): Promise<ProjectionHead> {
  const { rows: [head] } = await tx.query<ProjectionHead>(`
    SELECT cursor, retained_after, slice_id FROM supplement_projection_heads WHERE project_id = $1
  `, [projectId]);
  return head ?? { cursor: '0', retained_after: '0', slice_id: projectId };
}

export async function readProjectionPosition(tx: PoolClient, projectId: string): Promise<ProjectionPosition> {
  const head = await readHead(tx, projectId);
  return position(head.slice_id, head.cursor);
}

interface EventRow {
  cursor: string;
  slice_id: string;
  type: string;
  payload: EventInput['payload'];
  created_at: Date;
}

export async function readProjectEvents(tx: PoolClient, projectId: string, after: string, limit: number) {
  const head = await readHead(tx, projectId);
  if (BigInt(after) < BigInt(head.retained_after) || BigInt(after) > BigInt(head.cursor)) {
    throw new SupplementError(409, 'snapshot_required', 'Курсор проекта устарел. Обновите снимок.');
  }
  const { rows } = await tx.query<EventRow>(`
    SELECT cursor, slice_id, type, payload, created_at
    FROM supplement_project_events
    WHERE project_id = $1 AND cursor > $2 AND cursor <= $3
    ORDER BY cursor LIMIT $4
  `, [projectId, after, head.cursor, limit]);
  const cursor = rows.at(-1)?.cursor ?? after;
  return {
    events: rows.map((row) => ({
      ...position(row.slice_id, row.cursor),
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    })),
    cursor,
    head: position(head.slice_id, head.cursor),
    hasMore: cursor !== head.cursor,
  };
}

export async function inProjectionSnapshot<T>(db: Pool, read: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  let discardConnection = false;
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const value = await read(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await tx.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    tx.release(discardConnection);
  }
}
