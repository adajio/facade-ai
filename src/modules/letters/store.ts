import type { Pool, PoolClient } from 'pg';
import type { Format, Layout, LetterItem } from './content.js';
import { hashText, renderText } from './content.js';
import { LetterError } from './inputs.js';

type Db = Pool | PoolClient;

export interface Letter {
  id: string;
  projectId: string;
  scopeId?: string | null;
  assessmentContextId?: string | null;
  number: number;
  createdAt: Date;
}

interface RevisionBody {
  recipient: string;
  layout: Layout;
  items: LetterItem[];
  status: 'draft' | 'confirmed';
}

export interface Revision extends RevisionBody {
  id: string;
  version: number;
  text: string;
  textSha256: string;
  createdAt: Date;
}

const letterColumns = `l.id, l.project_id AS "projectId", l.scope_id AS "scopeId",
  l.assessment_context_id AS "assessmentContextId", l.number, l.created_at AS "createdAt"`;
const revisionColumns = 'id, version, status, recipient, layout, items, text, text_sha256 AS "textSha256", created_at AS "createdAt"';
const sentColumns = 'id, revision_id AS "revisionId", recipient, items, text, text_sha256 AS "textSha256", sent_at AS "sentAt", registered_at AS "registeredAt", registered_by AS "registeredBy"';

export function notFound(): never {
  throw new LetterError(404, 'not_found', 'Ресурс недоступен.');
}

export function summary(letter: Letter, current: Revision) {
  return { ...letter, version: current.version, revisionId: current.id, status: current.status, recipient: current.recipient };
}

export async function getLetter(db: Db, id: string) {
  const { rows: [letter] } = await db.query<Letter>(`SELECT ${letterColumns} FROM letters l WHERE l.id = $1`, [id]);
  return letter ?? notFound();
}

export async function listLetters(db: Db, projectId: string, target: Pick<Letter, 'scopeId' | 'assessmentContextId'>,
  cursor: string | null, limit: number, engineer: boolean) {
  const { rows } = await db.query<ReturnType<typeof summary>>(`
    SELECT ${letterColumns}, r.version, r.id AS "revisionId", r.status, r.recipient
    FROM letters l
    JOIN LATERAL (SELECT id, version, status, recipient FROM letter_revisions
      WHERE letter_id = l.id AND ($5 OR status = 'confirmed') ORDER BY version DESC LIMIT 1) r ON TRUE
    WHERE l.project_id = $1 AND ($2::uuid IS NULL OR l.scope_id = $2)
      AND ($6::uuid IS NULL OR l.assessment_context_id = $6)
      AND ($3::uuid IS NULL OR l.number < (SELECT number FROM letters
        WHERE id = $3 AND project_id = $1 AND ($2::uuid IS NULL OR scope_id = $2)
          AND ($6::uuid IS NULL OR assessment_context_id = $6)))
    ORDER BY l.number DESC LIMIT $4
  `, [projectId, target.scopeId ?? null, cursor, limit + 1, engineer, target.assessmentContextId ?? null]);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)?.id : null };
}

export async function addLetter(tx: PoolClient, projectId: string, target: Pick<Letter, 'scopeId' | 'assessmentContextId'>, userId: string) {
  const { rows: [letter] } = await tx.query<Letter>(`
    WITH counter AS (
      INSERT INTO letter_counters (project_id, last_number) VALUES ($1, 1)
      ON CONFLICT (project_id) DO UPDATE SET last_number = letter_counters.last_number + 1
      RETURNING last_number
    )
    INSERT INTO letters AS l (project_id, scope_id, number, created_by, assessment_context_id)
    SELECT $1, $2, last_number, $3, $4 FROM counter
    RETURNING ${letterColumns}
  `, [projectId, target.scopeId ?? null, userId, target.assessmentContextId ?? null]);
  return letter;
}

export async function putRevision(tx: PoolClient, letterId: string, version: number, userId: string, body: RevisionBody) {
  const { status, recipient, layout, items } = body;
  const text = renderText(recipient, layout, items);
  const { rows: [revision] } = await tx.query<Revision>(`
    INSERT INTO letter_revisions (letter_id, version, status, recipient, layout, items, text, text_sha256, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${revisionColumns}
  `, [letterId, version, status, recipient, layout, JSON.stringify(items), text, hashText(text), userId]);
  return revision;
}

export async function getRevision(db: Db, letterId: string, revisionId?: string, engineer = true) {
  const { rows: [revision] } = await db.query<Revision>(`
    SELECT ${revisionColumns} FROM letter_revisions
    WHERE letter_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3 OR status = 'confirmed')
    ORDER BY version DESC LIMIT 1
  `, [letterId, revisionId ?? null, engineer]);
  return revision ?? notFound();
}

export interface ExportMetadata {
  id: string;
  revisionId: string;
  version: number;
  format: Format;
}
export function exportReceipt(letterId: string, entry: ExportMetadata) {
  const path = `/api/letters/${letterId}`;
  return {
    ...entry, url: `${path}/exports/${entry.id}`,
    historicalUrl: `${path}/revisions/${entry.revisionId}/exports/${entry.id}`,
  };
}

export async function getExportMetadata(tx: Db, letterId: string, revisionId: string, format: Format) {
  const { rows: [entry] } = await tx.query<Omit<ExportMetadata, 'version'>>(`
    SELECT id, revision_id AS "revisionId", format
    FROM letter_exports WHERE letter_id = $1 AND revision_id = $2 AND format = $3
  `, [letterId, revisionId, format]);
  return entry;
}

export async function putExport(tx: PoolClient, letterId: string, revisionId: string, format: Format, content: Buffer, userId: string) {
  const { rows: [entry] } = await tx.query<Omit<ExportMetadata, 'version'>>(`
    INSERT INTO letter_exports (letter_id, revision_id, format, content, created_by)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, revision_id AS "revisionId", format
  `, [letterId, revisionId, format, content, userId]);
  return entry;
}

export async function readExport(db: Db, letterId: string, exportId: string) {
  const { rows: [entry] } = await db.query<ExportMetadata & { content: Buffer }>(`
    SELECT e.id, e.revision_id AS "revisionId", r.version, e.format, e.content
    FROM letter_exports e JOIN letter_revisions r ON r.id = e.revision_id
    WHERE e.letter_id = $1 AND e.id = $2
  `, [letterId, exportId]);
  return entry ?? notFound();
}

export interface Sent {
  id: string;
  revisionId: string;
  recipient: string;
  items: LetterItem[];
  text: string;
  textSha256: string;
  sentAt: Date;
  registeredAt: Date;
  registeredBy: string;
}

export async function putSent(tx: PoolClient, letterId: string, input: {
  revisionId: string; recipient: string; text: string; sentAt: string;
}, items: LetterItem[], userId: string) {
  const { rows: [sent] } = await tx.query<Sent>(`
    INSERT INTO letter_sends (letter_id, revision_id, recipient, items, text, text_sha256, sent_at, registered_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING ${sentColumns}
  `, [letterId, input.revisionId, input.recipient, JSON.stringify(items), input.text, hashText(input.text), input.sentAt, userId]);
  return sent;
}

export async function getSent(db: Db, letterId: string, sentId: string) {
  const { rows: [sent] } = await db.query<Sent>(`
    SELECT ${sentColumns} FROM letter_sends WHERE letter_id = $1 AND id = $2
  `, [letterId, sentId]);
  return sent ?? notFound();
}

export async function getSentItems(tx: PoolClient, projectId: string, letterId: string, sentId: string): Promise<LetterItem[]> {
  const { rows: [snapshot] } = await tx.query<Pick<Sent, 'items'>>(`
    SELECT s.items FROM letter_sends s JOIN letters l ON l.id = s.letter_id
    WHERE l.project_id = $1 AND s.letter_id = $2 AND s.id = $3
  `, [projectId, letterId, sentId]);
  return snapshot?.items ?? notFound();
}

export async function putResponse(tx: PoolClient, letterId: string, input: {
  sentId: string; itemId: string; kind: 'response' | 'refusal'; text: string; receivedAt: string;
}, userId: string) {
  const { rows: [response] } = await tx.query<{ id: string }>(`
    INSERT INTO letter_responses (letter_id, sent_id, item_id, kind, text, received_at, registered_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [letterId, input.sentId, input.itemId, input.kind, input.text, input.receivedAt, userId]);
  return response;
}

export async function readResponse(db: Db, letterId: string, responseId: string) {
  const { rows: [response] } = await db.query(`
    SELECT id, sent_id AS "sentId", item_id AS "itemId", kind, text, received_at AS "receivedAt",
      registered_at AS "registeredAt", registered_by AS "registeredBy"
    FROM letter_responses WHERE letter_id = $1 AND id = $2
  `, [letterId, responseId]);
  return response ?? notFound();
}

export async function readHistory(tx: PoolClient, letterId: string, engineer: boolean) {
  const revisions = await tx.query(`
    SELECT id, version, status, created_at AS "createdAt" FROM letter_revisions
    WHERE letter_id = $1 AND ($2 OR status = 'confirmed') ORDER BY version DESC
  `, [letterId, engineer]);
  const sent = await tx.query(`
    SELECT id, revision_id AS "revisionId", recipient, sent_at AS "sentAt", registered_at AS "registeredAt"
    FROM letter_sends WHERE letter_id = $1 ORDER BY registered_at DESC, id DESC
  `, [letterId]);
  const responses = await tx.query(`
    SELECT id, sent_id AS "sentId", item_id AS "itemId", kind, received_at AS "receivedAt", registered_at AS "registeredAt"
    FROM letter_responses WHERE letter_id = $1 ORDER BY registered_at DESC, id DESC
  `, [letterId]);
  const exports = await tx.query<ExportMetadata>(`
    SELECT e.id, e.revision_id AS "revisionId", r.version, e.format
    FROM letter_exports e JOIN letter_revisions r ON r.id = e.revision_id
    WHERE e.letter_id = $1 ORDER BY r.version DESC, e.format
  `, [letterId]);
  return { revisions: revisions.rows, sent: sent.rows, responses: responses.rows, exports: exports.rows.map((entry) => exportReceipt(letterId, entry)) };
}
