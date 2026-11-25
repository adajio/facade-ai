import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { readSession, authorize, touchSession, uuid } from '../access/auth.js';
import { executeCommand, transaction } from '../access/commands.js';
import { invalid, unavailable } from '../access/errors.js';
import { object, text } from '../access/input.js';
import { acceptedOriginals, verifyOriginalBasis, type OriginalBasis } from '../intake/accepted-originals.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { ReaderAddress } from '../pdf/types.js';
import type { synchronizeFacadeAssessment } from './facade-store.js';

type Params = { projectId: string; versionId: string };
type Candidate = { id: string; label: string };
export type DocumentFacadeLink = { version: number; versionId: string; targetKey: string; facadeId: string; facadeLabel: string; assessmentContextId: string;
  basis: OriginalBasis; reason: string; authorId: string; authorName: string; createdAt: Date };

const documentKey = 'document';

export function facadePlaceKey({ locator }: ReaderAddress) {
  if (locator?.page !== undefined) return JSON.stringify(['pdf', locator.page]);
  if (locator?.sheet && locator.cell) return JSON.stringify(['xlsx', locator.sheet, locator.cell]);
}

export function matchingDocumentFacadeLink(links: ReadonlyMap<string, DocumentFacadeLink> | undefined, address: ReaderAddress) {
  const key = facadePlaceKey(address);
  return (key ? links?.get(key) : undefined) ?? links?.get(documentKey);
}

export async function readDocumentFacadeLinks(tx: PoolClient, projectId: string, versionId?: string) {
  const { rows } = await tx.query<DocumentFacadeLink>(
    `SELECT DISTINCT ON (l.version_id, l.target_key) l.version, l.version_id AS "versionId", l.target_key AS "targetKey",
       c.facade_id AS "facadeId", c.id AS "assessmentContextId", coalesce(c.manual_name,l.facade_label) AS "facadeLabel", l.original_basis AS basis,
       l.reason, l.author_id AS "authorId", u.login AS "authorName", l.created_at AS "createdAt"
     FROM document_facade_links l JOIN facade_assessment_contexts c ON c.id=l.context_id
       JOIN users u ON u.id=l.author_id
     WHERE l.project_id=$1 AND ($2::uuid IS NULL OR l.version_id=$2)
     ORDER BY l.version_id, l.target_key, l.version DESC`, [projectId, versionId ?? null],
  );
  return rows;
}

export async function findDocumentFacadeLink(tx: PoolClient, projectId: string, original: OriginalBasis) {
  const links = await readDocumentFacadeLinks(tx, projectId, original.versionId);
  return matchingDocumentFacadeLink(new Map(links.map((link) => [link.targetKey, link])), original.address);
}

export async function readManuallyNamedFacades(tx: PoolClient, projectId: string): Promise<Candidate[]> {
  const { rows } = await tx.query<Candidate>(
    'SELECT facade_id AS id, manual_name AS label FROM facade_assessment_contexts WHERE project_id=$1 AND manual_name IS NOT NULL ORDER BY id',
    [projectId],
  );
  return rows;
}

function linkVersion(links: DocumentFacadeLink[]) {
  return links.reduce((version, link) => Math.max(version, link.version), 1);
}

export function publicDocumentFacadeLink({ targetKey, createdAt, ...link }: DocumentFacadeLink) {
  return { ...link, createdAt: createdAt.toISOString(), target: targetKey === documentKey ? 'document' as const : 'place' as const };
}

function facadeNameKey(label: string) {
  return label.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function registerDocumentFacades(app: FastifyInstance, prefix: string, synchronize: typeof synchronizeFacadeAssessment) {
  const path = `${prefix}/projects/:projectId/versions/:versionId/facade-links`;
  const db = app.db;
  app.get<{ Params: Params }>(path, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    const result = await transaction(db, async (tx) => {
      const session = await readSession(tx, request);
      const actor = await authorize(tx, session, { action: 'project:read', projectId });
      await lockIntakeProject(tx, projectId);
      const { rowCount } = await tx.query('SELECT 1 FROM intake_document_versions WHERE project_id=$1 AND id=$2', [projectId, versionId]);
      if (!rowCount) throw unavailable();
      const links = await readDocumentFacadeLinks(tx, projectId, versionId);
      const current = (await acceptedOriginals(tx, projectId, { versionId })).length > 0;
      const editable = current && (actor.role === 'engineer' || actor.role === 'project_manager');
      const candidates = editable ? (await synchronize(tx, projectId)).input.evidence.facades : [];
      await touchSession(tx, session);
      return { version: linkVersion(links), current, editable, links: links.map(publicDocumentFacadeLink), candidates };
    });
    return reply.header('ETag', `"${result.version}"`).send(result);
  });

  app.put<{ Params: Params }>(path, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    const payload = object(request.body);
    if (Object.keys(payload).some((key) => !['target', 'pageOrAnchor', 'facadeId', 'facadeName', 'reason'].includes(key)) ||
        (payload.target !== 'document' && payload.target !== 'place') ||
        (payload.facadeId === undefined) === (payload.facadeName === undefined)) {
      throw invalid('invalid_document_facade_link', 'Укажите объект привязки и один фасад.');
    }
    const input = {
      versionId, target: payload.target, pageOrAnchor: text(payload.pageOrAnchor, 'адрес', 200),
      facadeId: payload.facadeId === undefined ? undefined : uuid(payload.facadeId),
      facadeName: payload.facadeName === undefined ? undefined : text(payload.facadeName, 'обозначение фасада', 160),
      reason: text(payload.reason, 'основание', 2000),
    };
    let previous: DocumentFacadeLink[];
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:engineer', projectId }, operation: 'assessment.document_facade.link', input,
      async version(tx) {
        await lockIntakeProject(tx, projectId);
        previous = await readDocumentFacadeLinks(tx, projectId, versionId);
        return { current: linkVersion(previous), href: `${prefix}/projects/${projectId}/versions/${versionId}/facade-links` };
      },
    }, async (tx, actor) => {
      const basis = await verifyOriginalBasis(tx, projectId, versionId, input.pageOrAnchor);
      const targetKey = input.target === 'document' ? documentKey : facadePlaceKey(basis.address);
      if (!targetKey) throw invalid('invalid_document_facade_link', 'Укажите страницу PDF или ячейку XLSX.');
      const current = await synchronize(tx, projectId);
      const active = current.active.flatMap(({ context }) => context.facadeId ? [{ id: context.id, facadeId: context.facadeId, name: context.name }] : []);
      let facade = active.find(({ facadeId }) => facadeId === input.facadeId);
      if (input.facadeName) {
        const name = input.facadeName;
        if (active.some((item) => facadeNameKey(item.name) === facadeNameKey(name))) {
          throw invalid('facade_name_already_used', 'Фасад с таким обозначением уже есть. Выберите его в списке.');
        }
        const facadeId = randomUUID();
        const { rows: [row] } = await tx.query<{ id: string }>(
          `INSERT INTO facade_assessment_contexts(project_id,kind,facade_id,manual_name) VALUES($1,'facade',$2,$3) RETURNING id`,
          [projectId, facadeId, name],
        );
        facade = { id: row.id, facadeId, name };
      }
      if (!facade) throw unavailable();
      const version = linkVersion(previous) + 1;
      await tx.query(
        `INSERT INTO document_facade_links(project_id,version_id,version,target_key,context_id,facade_label,original_basis,author_id,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, versionId, version, targetKey, facade.id, facade.name, basis, actor.userId, input.reason],
      );
      const previousFacade = (previous.find((link) => link.targetKey === targetKey) ??
        previous.find((link) => link.targetKey === documentKey))?.facadeId;
      await tx.query(
        `INSERT INTO harness_semantic_scope_epochs(project_id,scope_key,epoch)
         SELECT $1,scope_key,1 FROM unnest($2::text[]) scope_key
         ON CONFLICT(project_id,scope_key) DO UPDATE SET epoch=harness_semantic_scope_epochs.epoch+1`,
        [projectId, [...new Set([facade.facadeId, ...(previousFacade ? [previousFacade] : [])])]],
      );
      const updated = await synchronize(tx, projectId);
      const links = await readDocumentFacadeLinks(tx, projectId, versionId);
      const body = { version, current: true, editable: true, links: links.map(publicDocumentFacadeLink),
        candidates: updated.input.evidence.facades, assessmentVersion: updated.version, assessmentContextId: facade.id };
      return { body, audit: { objectId: versionId, version, details: {
        target: input.target, facadeId: facade.facadeId, previousFacadeId: previousFacade, reason: input.reason, basis,
      } } };
    });
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}
