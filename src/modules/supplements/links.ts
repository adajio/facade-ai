import type { PoolClient } from 'pg';
import { getSentItems } from '../letters/index.js';
import { SupplementError } from './errors.js';
import { readProjectionPosition } from './events.js';
import { identifier } from './inputs.js';

export interface ReceiptLinkTarget {
  receiptId: string;
  letterId: string;
  sentId: string;
  itemId: string | null;
}

interface ReceiptLink extends ReceiptLinkTarget {
  id: string;
  createdAt: Date;
}

const linkFields = `id, receipt_id AS "receiptId", letter_id AS "letterId",
                    sent_id AS "sentId", item_id AS "itemId", created_at AS "createdAt"`;

export async function linkReceipt(tx: PoolClient, projectId: string, target: ReceiptLinkTarget, actorId: string) {
  const { receiptId, letterId, sentId, itemId } = target;
  const { rowCount } = await tx.query('SELECT 1 FROM intake_receipts WHERE project_id = $1 AND id = $2', [projectId, receiptId]);
  if (!rowCount) throw new SupplementError(404, 'not_found', 'Поступление недоступно.');
  const sentItems = await getSentItems(tx, projectId, letterId, sentId);
  if (itemId && !sentItems.some((item) => item.id === itemId)) {
    throw new SupplementError(404, 'not_found', 'Пункт отсутствует в указанном снимке отправки.');
  }
  const { rows: [created] } = await tx.query<ReceiptLink>(`
    INSERT INTO supplement_receipt_links (project_id, receipt_id, letter_id, sent_id, item_id, actor_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (project_id, receipt_id, letter_id, sent_id, item_id) DO NOTHING
    RETURNING ${linkFields}
  `, [projectId, receiptId, letterId, sentId, itemId, actorId]);
  if (created) return { link: created, created: true };

  const { rows: [existing] } = await tx.query<ReceiptLink>(`
    SELECT ${linkFields} FROM supplement_receipt_links
    WHERE project_id = $1 AND receipt_id = $2 AND letter_id = $3 AND sent_id = $4 AND item_id IS NOT DISTINCT FROM $5
  `, [projectId, receiptId, letterId, sentId, itemId]);
  return { link: existing, created: false };
}

export async function readReceiptLinks(tx: PoolClient, projectId: string, target: {
  receiptId?: string;
  letterId?: string;
  after?: string;
  limit: number;
}) {
  const position = await readProjectionPosition(tx, projectId);
  const tokenPrefix = [projectId, position.sliceId, target.receiptId ?? '', target.letterId ?? ''].join(':');
  const after = target.after === undefined ? undefined : decodeCursor(target.after, tokenPrefix);
  const { rows } = await tx.query<ReceiptLink>(`
    SELECT ${linkFields} FROM supplement_receipt_links
    WHERE project_id = $1 AND ($2::uuid IS NULL OR receipt_id = $2)
      AND ($3::uuid IS NULL OR letter_id = $3) AND ($4::uuid IS NULL OR id > $4)
    ORDER BY id LIMIT $5
  `, [projectId, target.receiptId ?? null, target.letterId ?? null, after ?? null, target.limit + 1]);
  const items = rows.slice(0, target.limit);
  const last = items.at(-1);
  return {
    ...position,
    items,
    nextCursor: rows.length > items.length && last
      ? Buffer.from(`${tokenPrefix}:${last.id}`).toString('base64url') : null,
  };
}

function decodeCursor(cursor: string, prefix: string): string {
  if (typeof cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(cursor)) {
    throw new SupplementError(422, 'invalid_cursor', 'Проверьте курсор списка связей.');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(`${prefix}:`)) {
    throw new SupplementError(409, 'snapshot_required', 'Срез или фильтр списка изменился. Обновите список.');
  }
  return identifier(decoded.slice(prefix.length + 1));
}
