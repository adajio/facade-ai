import type { FastifyInstance } from 'fastify';
import { createDocumentRevisionReader } from '../assessment/document-revision.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { getIntakeGate } from '../intake/gate.js';
import { lockScopes } from '../supplements/holds.js';
import { getGrounds } from './grounds.js';
import { registerLetterRoutes } from './routes.js';

export { getSentItems } from './store.js';

export async function register(app: FastifyInstance): Promise<void> {
  let reader: ReturnType<typeof createRuntimePdfService> | undefined;
  let readRevision: ReturnType<typeof createDocumentRevisionReader> | undefined;
  const readDocumentRevision: ReturnType<typeof createDocumentRevisionReader> = (...input) => {
    reader ??= createRuntimePdfService(app.db, app.config);
    readRevision ??= createDocumentRevisionReader(reader);
    return readRevision(...input);
  };
  app.addHook('onClose', async () => { reader?.close(); });

  for (const prefix of ['/api', '/api/v1']) {
    app.register(async (scope) => {
      registerLetterRoutes(scope, {
        lockScopes,
        getHolds: async (tx, projectId, scopeId) => (await getIntakeGate(tx, projectId, scopeId)).holds,
        getGrounds: (tx, args) => getGrounds(tx, args, readDocumentRevision),
      }, prefix);
    });
  }
}
