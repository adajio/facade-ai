import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { executeCommand } from '../access/index.js';
import { authorize, readSession, touchSession } from '../access/auth.js';
import { AccessError, sendAccessError } from '../access/errors.js';
import { synchronizeFacadeAssessment } from '../assessment/facade-store.js';
import { resolveIntakeHold } from '../intake/index.js';
import { SupplementError } from './errors.js';
import { inProjectionSnapshot, readProjectEvents } from './events.js';
import { assertHoldCurrent, readLockedHold, resolveSupplementImpact } from './holds.js';
import { eventCursor, expectedGeneration, identifier, identifiers, objectInput, optionalIdentifier, pageLimit } from './inputs.js';
import { linkReceipt, readReceiptLinks } from './links.js';
import { readProjectSnapshot } from './snapshot.js';

export { inProjectionSnapshot, publishProjectEvent, readProjectionPosition } from './events.js';
export { assertScopesAvailable, lockScopes, resolveSupplementImpact } from './holds.js';
export { readProjectSnapshot } from './snapshot.js';

type ProjectParams = { projectId: string };
type HoldParams = ProjectParams & { holdId: string };
type ScopeQuery = { scopeId?: string };

async function projectRead<T>(db: Pool, request: FastifyRequest, projectId: string, scopeId: string | undefined,
  read: (tx: PoolClient, restricted: boolean, manages: boolean) => Promise<T>,
): Promise<T> {
  const { result, session } = await inProjectionSnapshot(db, async (tx) => {
    const session = await readSession(tx, request);
    const actor = await authorize(tx, session, { action: 'project:read', projectId, scopeId });
    return { session, result: await read(tx, Boolean(scopeId && actor.role === 'viewer'), actor.role === 'project_manager') };
  });
  await touchSession(db, session);
  return result;
}

function sendCommand(reply: FastifyReply, result: { status: number; body: unknown; replayed: boolean }) {
  if (result.replayed) reply.header('Idempotency-Replayed', 'true');
  return reply.code(result.status).send(result.body);
}

export async function register(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });

  for (const prefix of ['/api', '/api/v1']) {
    const projectPath = `${prefix}/projects/:projectId`;
    const holdPath = `${projectPath}/supplements/holds/:holdId`;
    app.get<{ Params: ProjectParams; Querystring: ScopeQuery }>(`${projectPath}/snapshot`, async (request) => {
      const projectId = identifier(request.params.projectId);
      const scopeId = optionalIdentifier(request.query.scopeId);
      return projectRead(app.db, request, projectId, scopeId, (tx, restricted, manages) =>
        readProjectSnapshot(tx, projectId, scopeId, restricted, manages));
    });

    app.get<{ Params: ProjectParams; Querystring: ScopeQuery & { after?: string; limit?: string } }>(`${projectPath}/events`, async (request) => {
      const projectId = identifier(request.params.projectId);
      const scopeId = optionalIdentifier(request.query.scopeId);
      const after = eventCursor(request.query.after);
      const limit = pageLimit(request.query.limit);
      return projectRead(app.db, request, projectId, scopeId, async (tx, restricted) => {
        const result = await readProjectEvents(tx, projectId, after, limit);
        if (!restricted) return result;
        return { ...result, events: result.events.map((event) => ({ ...event, type: 'project.changed', payload: {} })) };
      });
    });

    app.get<{ Params: ProjectParams; Querystring: { receiptId?: string; letterId?: string; after?: string; limit?: string } }>(
      `${projectPath}/supplements/links`, async (request) => {
        const projectId = identifier(request.params.projectId);
        const target = {
          receiptId: optionalIdentifier(request.query.receiptId),
          letterId: optionalIdentifier(request.query.letterId),
          after: request.query.after,
          limit: pageLimit(request.query.limit),
        };
        return projectRead(app.db, request, projectId, undefined, (tx) => readReceiptLinks(tx, projectId, target));
      },
    );

    app.post<{ Params: ProjectParams }>(`${projectPath}/supplements/links`, async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const body = objectInput(request.body, ['receiptId', 'letterId', 'sentId', 'itemId']);
      const target = {
        receiptId: identifier(body.receiptId),
        letterId: identifier(body.letterId),
        sentId: identifier(body.sentId),
        itemId: body.itemId == null ? null : identifier(body.itemId),
      };
      const result = await executeCommand(app.db, request, {
        operation: 'supplement.link', requirement: { action: 'project:engineer', projectId }, input: target,
      }, async (tx, actor) => {
        const { link, created } = await linkReceipt(tx, projectId, target, actor.userId);
        if (created) {
          const letter = await tx.query(
            'SELECT 1 FROM letters WHERE project_id=$1 AND id=$2 AND assessment_context_id IS NOT NULL', [projectId, target.letterId]);
          if (letter.rowCount) await synchronizeFacadeAssessment(tx, projectId);
        }
        return { body: link, status: created ? 201 : 200, audit: { objectId: link.id, details: target } };
      });
      return sendCommand(reply, result);
    });

    app.patch<{ Params: HoldParams }>(holdPath, async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const holdId = identifier(request.params.holdId);
      const body = objectInput(request.body, ['generation', 'scopeIds']);
      const generation = expectedGeneration(body.generation);
      const scopeIds = identifiers(body.scopeIds, 1, 100);
      let version: number;
      const result = await executeCommand(app.db, request, {
        operation: 'supplement.classify',
        requirement: { action: 'project:engineer', projectId },
        input: { holdId, generation, scopeIds },
        version: async (tx) => {
          const hold = await readLockedHold(tx, projectId, holdId);
          assertHoldCurrent(hold, generation);
          version = hold.version;
          return { current: version, href: `${prefix}/projects/${projectId}/snapshot` };
        },
      }, async (tx) => {
        const updated = await resolveIntakeHold(tx, { projectId, holdId, generation, version, scopeIds });
        return { body: updated, audit: { objectId: holdId, version: updated.version, details: { generation, scopeIds } } };
      });
      return sendCommand(reply, result);
    });

    app.post<{ Params: HoldParams }>(`${holdPath}/resolve`, async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const holdId = identifier(request.params.holdId);
      const body = objectInput(request.body, ['generation', 'reason', 'impacts']);
      const generation = expectedGeneration(body.generation);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.includes('\0') || reason.length > 2000 || !Array.isArray(body.impacts) || body.impacts.length > 100) {
        throw new SupplementError(422, 'invalid_impact', 'Укажите области проверки и основание изменения.');
      }
      const impacts = body.impacts.map((value) => {
        const impact = objectInput(value, ['scopeId', 'assessmentVersion', 'questionIds']);
        const assessmentVersion = impact.assessmentVersion;
        if (assessmentVersion !== null && (typeof assessmentVersion !== 'number' ||
            !Number.isSafeInteger(assessmentVersion) || assessmentVersion < 1)) {
          throw new SupplementError(422, 'invalid_assessment_version', 'Передайте версию оценки области.');
        }
        return {
          scopeId: identifier(impact.scopeId),
          assessmentVersion,
          changes: identifiers(impact.questionIds, 0, 1000).map((questionId) => ({ questionId, review: null })),
        };
      });
      let version: number;
      const result = await executeCommand(app.db, request, {
        operation: 'supplement.resolve',
        requirement: { action: 'project:engineer', projectId },
        input: { holdId, generation, reason, impacts },
        version: async (tx) => {
          const hold = await readLockedHold(tx, projectId, holdId);
          assertHoldCurrent(hold, generation);
          version = hold.version;
          return { current: version, href: `${prefix}/projects/${projectId}/snapshot` };
        },
      }, async (tx) => {
        const updated = await resolveSupplementImpact(tx, { projectId, holdId, generation, version, reason, impacts });
        return { body: updated, audit: { objectId: holdId, version: updated.version } };
      });
      return sendCommand(reply, result);
    });
  }
}
