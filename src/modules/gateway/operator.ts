import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAccess } from '../access/index.js';
import { uuid } from '../access/auth.js';
import { unavailable } from '../access/errors.js';
import type { Gateway } from './gateway.js';
import { GatewayError, type KnownReceipt } from './types.js';

const conflicts = new Set(['operation_conflict','attempt_already_settled','attempt_in_flight','attempt_not_sent']);

function apiError(error: unknown, requestId: string) {
  const code = error instanceof GatewayError ? error.code : 'journal_unavailable';
  const status = code === 'attempt_not_found' ? 404
    : conflicts.has(code) ? 409
    : code === 'invalid_reconciliation' ? 422
    : 503;
  return { status, body: { code, message: 'Сверка попытки шлюза', requestId } };
}

function resolution(body: Record<string, unknown>): KnownReceipt | { state: 'unknown'; code: string } {
  if (body.state === 'paid') {
    return { state: 'paid', costUsdNanos: body.costUsdNanos as number, providerId: body.providerId as string,
      evidenceRef: body.evidenceRef as string };
  }
  if (body.state === 'rejected') {
    return { state: 'rejected', code: body.code as string, evidenceRef: body.evidenceRef as string };
  }
  if (body.state === 'unknown') return { state: 'unknown', code: body.code as string };
  throw new GatewayError('invalid_reconciliation');
}

export function registerOperatorRoutes(app: FastifyInstance, gateway: Gateway): void {
  async function operator(request: FastifyRequest, projectId: string) {
    const actor = await requireAccess(app.db, request, { action: 'operator:diagnose' });
    const result = await app.db.query(
      'SELECT 1 FROM projects WHERE id=$1 AND organization_id=$2', [projectId, actor.organizationId],
    );
    if (!result.rowCount) throw unavailable();
    return actor;
  }

  app.get<{ Params: { projectId: string } }>('/api/operator/gateway/projects/:projectId', async request => {
    const projectId = uuid(request.params.projectId);
    await operator(request, projectId);
    return gateway.diagnostics(projectId);
  });

  app.post<{ Params: { projectId: string; attemptId: string }; Body: unknown }>(
    '/api/operator/gateway/projects/:projectId/attempts/:attemptId/reconcile', async (request, reply) => {
      const projectId = uuid(request.params.projectId);
      const actor = await operator(request, projectId);
      const attemptId = uuid(request.params.attemptId);
      try {
        const body = request.body as Record<string, unknown> | null;
        const operationKey = request.headers['idempotency-key'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof operationKey !== 'string') {
          throw new GatewayError('invalid_reconciliation');
        }
        if (await gateway.diagnosticAttemptProject(attemptId) !== projectId) throw new GatewayError('attempt_not_found');
        return await gateway.reconcile({ actorId: actor.userId, authority: 'gateway:reconcile' }, {
          attemptId, operationKey, reasonRef: body.reasonRef as string, resolution: resolution(body),
        });
      } catch (error) {
        const failure = apiError(error, request.id);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
