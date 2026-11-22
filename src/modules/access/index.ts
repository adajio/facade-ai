import type { FastifyInstance, FastifyRequest } from 'fastify';
import { accessConfig, checkCsrf, checkOrigin, readCookie } from './auth.js';
import { AccessError, sendAccessError } from './errors.js';
import { registerProjects } from './projects.js';
import { registerSessions } from './sessions.js';
import { registerUsers } from './users.js';

export { requireAccess, requireMutationProtection, projectActions } from './auth.js';
export type { AccessActor, AccessRequirement, ProjectAction, ProjectRole } from './auth.js';
export { executeCommand, lockProjectScopes, transaction, writeAudit } from './commands.js';
export type { AuditEvent, ProjectScope } from './commands.js';
export { AccessError, sendAccessError } from './errors.js';

const publicMutations = new Set([
  '/api/sessions', '/api/invitations/complete', '/api/password-resets/complete',
]);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function apiPath(request: FastifyRequest) {
  return request.url.split('?', 1)[0];
}

export async function register(app: FastifyInstance): Promise<void> {
  const config = accessConfig();
  const { db } = app;

  app.addHook('onRequest', async (request, reply) => {
    const path = apiPath(request);
    if (path !== '/api' && !path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (safeMethods.has(request.method)) return;

    try {
      const isPublic = request.method === 'POST' && publicMutations.has(path);
      const cookie = readCookie(request);
      if (isPublic || cookie) checkOrigin(request, config);
      if (!isPublic && cookie) checkCsrf(request, cookie);
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      return sendAccessError(error, request, reply);
    }
  });

  await app.register(async (routes) => {
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof AccessError) return sendAccessError(error, request, reply);
      throw error;
    });
    registerSessions(routes, db, config);
    registerUsers(routes, db, config);
    registerProjects(routes, db);
  });
}
