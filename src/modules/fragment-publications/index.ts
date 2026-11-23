import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { authorize, readSession, touchSession, uuid, type AccessActor } from '../access/auth.js';
import { executeCommand, transaction } from '../access/commands.js';
import { AccessError, invalid, sendAccessError, unavailable } from '../access/errors.js';
import { object, text } from '../access/input.js';
import { createRuntimePdfService, ReaderError, validBox, type Box } from '../pdf/index.js';

type ScopeParams = { projectId: string; scopeId: string };
type CardParams = ScopeParams & { publicationId: string };
type PreviewParams = CardParams & { version: string };
type ReadRoute = { Params: ScopeParams };
type Card = {
  id: string; page: number; box: Box; quote: string | null; hasPreview: boolean; version: number;
};
type History = { version: number; actorId: string; reason: string; createdAt: Date };

const base = '/api/projects/:projectId/scopes/:scopeId/fragment-publications';
const state = (version: number) => version === 1 ? 'draft' : version === 2 ? 'granted' : 'revoked';
const canEdit = ({ role }: AccessActor) => role === 'project_manager' || role === 'engineer';
const href = ({ projectId, scopeId }: ScopeParams, id: string) =>
  `/api/projects/${projectId}/scopes/${scopeId}/fragment-publications/${id}`;

function scope(params: ScopeParams): ScopeParams {
  return { projectId: uuid(params.projectId), scopeId: uuid(params.scopeId) };
}

const scopedCards = `
  FROM fragment_publications p
  JOIN LATERAL (
    SELECT version FROM fragment_publication_revisions WHERE publication_id=p.id ORDER BY version DESC LIMIT 1
  ) r ON true
  WHERE p.project_id=$1 AND p.scope_id=$2`;
const cardFields = 'p.id, p.page, p.box, p.quote, p.image IS NOT NULL AS "hasPreview", r.version';

function present(item: Card, target: ScopeParams) {
  const { hasPreview, ...card } = item;
  return {
    ...card, state: state(card.version),
    ...(hasPreview && card.version < 3 ? { previewUrl: href(target, card.id) + '/versions/' + card.version + '/preview' } : {}),
  };
}

function creation(body: unknown) {
  const input = object(body);
  const { documentId, versionId, page, kind } = input;
  const frame = object(input.box);
  const coordinates = [frame.x, frame.y, frame.width, frame.height];
  if (!coordinates.every((coordinate): coordinate is number => typeof coordinate === 'number')) {
    throw invalid('fragment_address_invalid', 'Укажите страницу и рамку фрагмента.');
  }
  const [x, y, width, height] = coordinates;
  const box = { x, y, width, height };
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10_000 || !validBox(box)) {
    throw invalid('fragment_address_invalid', 'Укажите страницу и рамку фрагмента.');
  }
  if ((kind !== 'quote' && kind !== 'crop') || (kind === 'crop' && input.quote !== undefined)) {
    throw invalid('fragment_kind_invalid', 'Выберите цитату или обрезанное изображение.');
  }
  return {
    documentId: uuid(documentId), versionId: uuid(versionId), page, box,
    quote: kind === 'quote' ? text(input.quote, '«Точная цитата»', 500) : undefined,
    reason: text(input.reason, '«Основание»', 500),
  };
}

async function appendRevision(tx: PoolClient, id: string, version: number, actor: AccessActor, reason: string) {
  await tx.query(
    'INSERT INTO fragment_publication_revisions (publication_id,version,actor_id,reason) VALUES ($1,$2,$3,$4)',
    [id, version, actor.userId, reason],
  );
}

export async function register(app: FastifyInstance) {
  const { db } = app;
  let pdf: ReturnType<typeof createRuntimePdfService> | undefined;
  app.addHook('onClose', async () => { pdf?.close(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    if (error instanceof ReaderError && error.code === 'reader_resource_wait') {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, requestId: request.id });
    }
    throw error;
  });

  async function read<T>(request: FastifyRequest<ReadRoute>,
    work: (tx: PoolClient, target: ScopeParams, edit: boolean) => Promise<T>) {
    const target = scope(request.params);
    return transaction(db, async (tx) => {
      const session = await readSession(tx, request);
      const actor = await authorize(tx, session, { action: 'project:read', ...target });
      const result = await work(tx, target, canEdit(actor));
      await touchSession(tx, session);
      return result;
    });
  }

  app.get<ReadRoute & { Querystring: { after?: string } }>(base, (request) =>
    read(request, async (tx, target, edit) => {
      const after = request.query.after === undefined ? null : uuid(request.query.after);
      const { rows } = await tx.query<Pick<Card, 'id' | 'page' | 'version'>>(
        `SELECT p.id, p.page, r.version ${scopedCards}
           AND ($3::boolean OR r.version=2) AND ($4::uuid IS NULL OR p.id>$4)
         ORDER BY p.id LIMIT 51`,
        [target.projectId, target.scopeId, edit, after],
      );
      return {
        items: rows.slice(0, 50).map((item) => ({ id: item.id, page: item.page, version: item.version, state: state(item.version) })),
        nextCursor: rows.length > 50 ? rows[49].id : null,
      };
    }));

  app.get<{ Params: CardParams }>(base + '/:publicationId', (request, reply) =>
    read(request, async (tx, target, edit) => {
      const id = uuid(request.params.publicationId);
      const { rows: [card] } = await tx.query<Card>(
        `SELECT ${cardFields} ${scopedCards} AND p.id=$3 AND ($4::boolean OR r.version=2)`,
        [target.projectId, target.scopeId, id, edit],
      );
      if (!card) throw unavailable();
      reply.header('ETag', `"${card.version}"`);
      const visible = present(card, target);
      if (!edit) return visible;
      const { rows: [source] } = await tx.query(
        `SELECT document_id AS "documentId", original_version_id AS "versionId", original_sha256 AS sha256,
                reader_version AS "readerVersion" FROM fragment_publications WHERE id=$1`,
        [id],
      );
      const { rows: history } = await tx.query<History>(
        `SELECT version, actor_id AS "actorId", reason, created_at AS "createdAt"
         FROM fragment_publication_revisions WHERE publication_id=$1 AND version<=$2 ORDER BY version`,
        [id, card.version],
      );
      return { ...visible, source, history };
    }));

  app.get<{ Params: PreviewParams }>(base + '/:publicationId/versions/:version/preview', async (request, reply) => {
    const image = await read(request, async (tx, target, edit) => {
      const id = uuid(request.params.publicationId);
      const { version } = request.params;
      if (version !== '2' && !(version === '1' && edit)) throw unavailable();
      const { rows: [row] } = await tx.query<{ image: Buffer }>(
        `SELECT p.image ${scopedCards} AND p.id=$3 AND r.version=$4 AND p.image IS NOT NULL`,
        [target.projectId, target.scopeId, id, Number(version)],
      );
      if (!row) throw unavailable();
      return row.image;
    });
    return reply.header('X-Content-Type-Options', 'nosniff').type('image/png').send(image);
  });

  app.post<ReadRoute>(base, async (request, reply) => {
    const target = scope(request.params);
    const input = creation(request.body);
    const result = await executeCommand(db, request, {
      operation: 'fragment.submit', requirement: { action: 'project:engineer', ...target }, input,
    }, async (tx, actor) => {
      const { rows: [source] } = await tx.query<{ sha256: string }>(
        `SELECT o.sha256 FROM intake_document_versions v
         JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id
         WHERE v.project_id=$1 AND v.document_id=$2 AND v.id=$3 AND v.media_type='application/pdf'
           AND EXISTS(SELECT 1 FROM intake_occurrences c
                      WHERE c.project_id=v.project_id AND c.version_id=v.id AND c.state='accepted')`,
        [target.projectId, input.documentId, input.versionId],
      );
      if (!source) throw unavailable();
      const { documentId, versionId, page, reason } = input;
      pdf ??= createRuntimePdfService(db, app.config, { adapters: [] });
      const material = await pdf.readPdfFragment({ projectId: target.projectId, documentId, versionId, ...source }, input, tx);
      const { rows: [{ id }] } = await tx.query<{ id: string }>(
        `INSERT INTO fragment_publications
           (project_id,scope_id,document_id,original_version_id,original_sha256,reader_version,page,box,quote,image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [target.projectId, target.scopeId, documentId, versionId, source.sha256, material.readerVersion,
          page, material.box, material.quote ?? null, material.image ?? null],
      );
      await appendRevision(tx, id, 1, actor, reason);
      return { status: 201, body: { id, version: 1 }, audit: { objectId: id, version: 1 } };
    });
    return sendCommand(reply, result);
  });

  for (const action of ['grant', 'revoke'] as const) {
    app.post<{ Params: CardParams }>(base + '/:publicationId/' + action, async (request, reply) => {
      const target = scope(request.params);
      const id = uuid(request.params.publicationId);
      const reason = text(object(request.body).reason, '«Основание»', 500);
      let current: number;
      const result = await executeCommand(db, request, {
        operation: 'fragment.' + action, requirement: { action: 'project:engineer', ...target }, input: { id, reason },
        version: async (tx) => {
          const coordinates = [target.projectId, target.scopeId, id];
          const locked = await tx.query(
            'SELECT 1 FROM fragment_publications WHERE project_id=$1 AND scope_id=$2 AND id=$3 FOR UPDATE', coordinates,
          );
          if (!locked.rowCount) throw unavailable();
          const { rows: [head] } = await tx.query<{ version: number }>(
            `SELECT r.version ${scopedCards} AND p.id=$3`, coordinates,
          );
          current = head.version;
          return { current, href: href(target, id) };
        },
      }, async (tx, actor) => {
        if (current !== (action === 'grant' ? 1 : 2)) {
          throw new AccessError(409, 'fragment_state_conflict', 'Действие недоступно в текущем состоянии публикации.');
        }
        const version = current + 1;
        await appendRevision(tx, id, version, actor, reason);
        return { body: { id, version }, audit: { objectId: id, version } };
      });
      return sendCommand(reply, result);
    });
  }
}

function sendCommand(reply: FastifyReply, result: { status: number; replayed: boolean; body: { version: number } }) {
  if (result.replayed) reply.header('Idempotency-Replayed', 'true');
  return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
}
