import type { FastifyInstance } from 'fastify';
import { authorize, readSession, touchSession, uuid } from '../access/auth.js';
import { transaction } from '../access/commands.js';
import { AccessError, invalid, sendAccessError, unavailable } from '../access/errors.js';
import { getInventory } from '../intake/receipts.js';
import { inProjectionSnapshot } from '../supplements/events.js';
import { optionalIdentifier, pageLimit } from '../supplements/inputs.js';
import { currentWorkSlice, inventoryRevision, inventoryUnavailable, loadWorkSlice, parseFilter, receiptPage, snapshotRequired, summarizeCurrentReader } from './store.js';

const base = '/api/projects/:projectId/work-slices';
type Current = { Params: { projectId: string }; Querystring: { scopeId?: string } };
type SliceParams = Current['Params'] & { workSliceId: string };
type Listing = { Params: SliceParams; Querystring: { filter?: string; cursor?: string; limit?: string; receiptId?: string } };
type Inventory = { Params: SliceParams & { receiptId: string } };

export async function register(app: FastifyInstance) {
  const { db } = app;
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });

  app.get<Current>(base + '/current', async (request) => {
    const projectId = uuid(request.params.projectId);
    const scopeId = optionalIdentifier(request.query.scopeId);
    // Repeatable read can reject a concurrent publisher. Retry before handing
    // out a version, so the membership, readings and counts always agree.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { result, session } = await transaction(db, async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          const session = await readSession(tx, request);
          await authorize(tx, session, { action: 'project:read', projectId });
          if (scopeId) await authorize(tx, session, { action: 'project:read', projectId, scopeId });
          return { result: await currentWorkSlice(tx, projectId, scopeId), session };
        });
        await touchSession(db, session);
        return result;
      } catch (error) {
        const conflict = error as { code?: string; constraint?: string };
        // Two repeatable-read transactions may each see the same last assessment
        // even after the second obtains the project lock. Retry that allocation.
        const versionConflict = conflict.code === '23505' && [
          'facade_assessment_snapshots_pkey', 'assessment_revisions_pkey', 'assessment_question_revisions_pkey',
        ].includes(conflict.constraint ?? '');
        if (conflict.code !== '40001' && !versionConflict) throw error;
      }
    }
    throw snapshotRequired();
  });

  app.get<{ Params: SliceParams }>(base + '/:workSliceId', async (request) => {
    const projectId = uuid(request.params.projectId);
    const workSliceId = uuid(request.params.workSliceId);
    const { result, session } = await inProjectionSnapshot(db, async (tx) => {
      const session = await readSession(tx, request);
      await authorize(tx, session, { action: 'project:read', projectId });
      const slice = await loadWorkSlice(tx, projectId, workSliceId);
      if (slice.scopeId) await authorize(tx, session, { action: 'project:read', projectId, scopeId: slice.scopeId });
      return { result: await summarizeCurrentReader(tx, slice, workSliceId), session };
    });
    await touchSession(db, session);
    return result;
  });

  app.get<Listing>(base + '/:workSliceId/receipts', async (request) => {
    const projectId = uuid(request.params.projectId);
    const workSliceId = uuid(request.params.workSliceId);
    const filter = parseFilter(request.query.filter);
    const limit = request.query.limit === undefined ? 50 : pageLimit(request.query.limit);
    const receiptId = optionalIdentifier(request.query.receiptId);
    if (receiptId && request.query.cursor !== undefined) throw invalid('invalid_cursor', 'Передайте курсор или выбранное поступление.');
    const { result, session } = await inProjectionSnapshot(db, async (tx) => {
      const session = await readSession(tx, request);
      await authorize(tx, session, { action: 'project:read', projectId });
      const slice = await loadWorkSlice(tx, projectId, workSliceId);
      if (slice.scopeId) await authorize(tx, session, { action: 'project:read', projectId, scopeId: slice.scopeId });
      return { result: receiptPage(slice, workSliceId, filter, limit, request.query.cursor, receiptId), session };
    });
    await touchSession(db, session);
    return result;
  });

  app.get<Inventory>(base + '/:workSliceId/receipts/:receiptId/inventory', async (request) => {
    const projectId = uuid(request.params.projectId);
    const workSliceId = uuid(request.params.workSliceId);
    const receiptId = uuid(request.params.receiptId);
    const { result, session } = await inProjectionSnapshot(db, async (tx) => {
      const session = await readSession(tx, request);
      await authorize(tx, session, { action: 'project:read', projectId });
      const slice = await loadWorkSlice(tx, projectId, workSliceId);
      if (slice.scopeId) await authorize(tx, session, { action: 'project:read', projectId, scopeId: slice.scopeId });
      const row = slice.receipts.find((item) => item.receiptId === receiptId);
      if (!row) throw unavailable();
      const { rows: [head] } = await tx.query<{ version: string }>(
        `SELECT ${inventoryRevision} AS version
         FROM intake_receipts r WHERE r.project_id=$1 AND r.id=$2`, [projectId, receiptId],
      );
      if (!row.sealed || row.inventoryOpen || !head || head.version !== row.inventoryRevision) throw inventoryUnavailable();
      const inventory = await getInventory(tx, { projectId, receiptId });
      if (!inventory.sealed || inventory.inventoryOpen) throw inventoryUnavailable();
      return { result: { ...inventory, workSliceId, inventoryRevision: head.version, historical: true }, session };
    });
    await touchSession(db, session);
    return result;
  });
}
