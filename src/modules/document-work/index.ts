import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { authorize, readSession, touchSession, uuid, type AccessDb } from '../access/auth.js';
import { executeCommand } from '../access/commands.js';
import { AccessError, invalid, sendAccessError, unavailable } from '../access/errors.js';
import { researchKind } from '../harness/runner.js';

const base = '/api/documents/:documentId/versions/:versionId';
const stopped = 'repeated_rejected_action';
const priorityRange = { min: -10, max: 10 };

type DocumentRoute = { Params: { documentId: string; versionId: string } };
type PriorityRoute = { Params: DocumentRoute['Params'] & { jobId: string } };
type Document = { documentId: string; versionId: string; projectId: string };
type Job = {
  id: string; generationId: string; version: number; priority: number;
  state: 'ready' | 'leased' | 'held' | 'done'; reason: string | null; nextAction: string | null;
  branch: 'A' | 'B'; unitId: string | null; page: number | null; leaseUntil: Date | null;
  stopId: string | null; stopVersion: number | null; resumeRequested: boolean; effectPending: boolean; routeAvailable: boolean;
};

async function accessDocument(db: Pool, request: FastifyRequest<DocumentRoute>) {
  const session = await readSession(db, request);
  const documentId = uuid(request.params.documentId);
  const versionId = uuid(request.params.versionId);
  const { rows: [row] } = await db.query<{ projectId: string }>(
    `SELECT project_id AS "projectId" FROM intake_document_versions v
     WHERE document_id=$1 AND id=$2 AND EXISTS (
       SELECT 1 FROM intake_occurrences o
       WHERE o.project_id=v.project_id AND o.version_id=v.id AND o.state='accepted'
     )`,
    [documentId, versionId],
  );
  if (!row) throw unavailable();
  const actor = await authorize(db, session, { action: 'project:read', projectId: row.projectId });
  await touchSession(db, session);
  return { document: { ...row, documentId, versionId }, actor };
}

// xmin changes with the queue row, including claims, suspensions and priority writes.
// The queue row is locked before accepting this opaque revision in If-Match.
const jobs = `
  SELECT j.id,j.generation_id AS "generationId",j.xmin::text::bigint::float8 AS version,
    j.priority,j.state,j.reason,j.next_action AS "nextAction",j.lease_until AS "leaseUntil",
    CASE WHEN j.purpose='primary_a' THEN 'A' ELSE 'B' END AS branch,
    j.payload#>>'{place,unitId}' AS "unitId", j.payload#>'{place,page}' AS page,
    s.id AS "stopId",s.sequence AS "stopVersion",s.resume_requested_at IS NOT NULL AS "resumeRequested",
    EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown')) AS "effectPending",
    EXISTS(SELECT 1 FROM gateway_routes r WHERE r.id=coalesce(b.settings->>'routeId',j.payload#>>'{settings,routeId}')
      AND r.enabled) AS "routeAvailable"
  FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
  LEFT JOIN harness_route_bindings b ON b.job_id=j.id
  LEFT JOIN LATERAL (
    SELECT id,sequence,resume_requested_at FROM harness_research_stops
    WHERE job_id=j.id ORDER BY sequence DESC LIMIT 1
  ) s ON true
  WHERE j.project_id=$1 AND j.subject_id=$2::uuid::text AND j.kind=$3 AND g.current
    AND j.purpose IN ('primary_a','primary_b')`;

const parameters = (document: Document) => [document.projectId, document.versionId, researchKind];
const priorityReason = (job: Job) => job.effectPending ? 'operator_reconcile_attempt'
  : job.state !== 'ready' ? 'job_not_waiting' : undefined;
const resumeReason = (job: Job) => job.effectPending ? 'operator_reconcile_attempt'
  : job.resumeRequested ? 'continuation_requested'
  : job.state === 'held' && job.stopId && job.reason === stopped ? undefined : 'no_resumable_stop';

async function getJob(db: AccessDb, document: Document, jobId: string, lock = false) {
  const { rows: [job] } = await db.query<Job>(
    `${jobs} AND j.id=$4 ${lock ? 'FOR UPDATE OF j' : ''}`,
    [...parameters(document), jobId],
  );
  return job;
}

async function lockJob(tx: PoolClient, document: Document, job: Job) {
  // The worker locks the generation before it locks a work item.
  const generation = await tx.query(
    'SELECT 1 FROM gateway_generations WHERE generation_id=$1 AND current FOR UPDATE', [job.generationId],
  );
  if (!generation.rowCount) return;
  return getJob(tx, document, job.id, true);
}

export async function register(app: FastifyInstance) {
  const { db } = app;
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });

  app.get<DocumentRoute>(base + '/work', async (request) => {
    const { document, actor } = await accessDocument(db, request);
    const { rows: [result] } = await db.query<{
      mappingReason: string | null; mapReady: boolean; mapped: boolean; catalogAssigned: boolean;
      branches: { branch: string; total: number; completed: number; outcome: string }[];
      jobs: Job[]; jobCount: number;
    }>(
      `WITH work AS MATERIALIZED (${jobs}),
       branch AS (
         SELECT branch,count(*)::int AS total,(count(*) FILTER (WHERE state='done'))::int AS completed,
           CASE WHEN bool_or("effectPending" OR state='held') THEN 'held'
                WHEN bool_or(state='leased') THEN 'running'
                WHEN bool_or(state='ready' AND "routeAvailable") THEN 'queued'
                WHEN bool_or(state='ready') THEN 'waiting_route' ELSE 'completed' END AS outcome
         FROM work GROUP BY branch
       ),
       visible AS (
         SELECT * FROM work
         ORDER BY "effectPending" DESC, CASE state WHEN 'held' THEN 0 WHEN 'leased' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END,
           priority DESC,id LIMIT 40
       )
       SELECT
         (SELECT f.reason FROM intake_reader_jobs j JOIN harness_map_retries f ON f.job_id=j.id
          WHERE j.project_id=$1 AND j.version_id=$2) AS "mappingReason",
         EXISTS(SELECT 1 FROM reader_maps WHERE project_id=$1 AND version_id=$2) AS "mapReady",
         EXISTS(SELECT 1 FROM intake_reader_jobs WHERE project_id=$1 AND version_id=$2 AND dispatched_at IS NOT NULL) AS mapped,
         p.catalog_version_id IS NOT NULL AS "catalogAssigned",
         coalesce((SELECT jsonb_agg(to_jsonb(branch) ORDER BY branch.branch) FROM branch),'[]'::jsonb) AS branches,
         coalesce((SELECT jsonb_agg(to_jsonb(visible)) FROM visible),'[]'::jsonb) AS jobs,
         (SELECT count(*)::int FROM work) AS "jobCount"
       FROM projects p WHERE p.id=$1`,
      parameters(document),
    );
    const engineer = actor.role === 'project_manager' || actor.role === 'engineer';
    const { jobs: items, ...status } = result;
    return {
      ...status,
      jobs: items.map((item) => {
        const { generationId: _generation, effectPending, resumeRequested: _requested,
          stopId, stopVersion, routeAvailable, ...job } = item;
        const priorityBlock = engineer ? priorityReason(item) : 'insufficient_permission';
        const resumeBlock = engineer ? resumeReason(item) : 'insufficient_permission';
        return {
          ...job,
          ...(effectPending ? { reason: 'unknown_charge', nextAction: 'operator_reconcile_attempt' } :
            job.state === 'ready' && !routeAvailable && !job.reason ? { reason: 'waiting_route' } : {}),
          actions: {
            priority: priorityBlock ? { reason: priorityBlock } : { ...priorityRange, version: job.version },
            resume: resumeBlock ? { reason: resumeBlock } : {
              href: '/api/projects/' + document.projectId + '/research-stops/' + stopId + '/resume',
              version: stopVersion,
            },
          },
        };
      }),
    };
  });

  app.patch<PriorityRoute>(base + '/work/:jobId/priority', async (request, reply) => {
    const { document } = await accessDocument(db, request);
    const job = await getJob(db, document, uuid(request.params.jobId));
    if (!job) throw unavailable();
    const priority = (request.body as { priority?: unknown } | null)?.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < priorityRange.min || priority > priorityRange.max) {
      throw invalid('invalid_priority', 'Укажите целый приоритет от −10 до 10.');
    }
    let current: Job | undefined;
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:engineer', projectId: document.projectId },
      operation: 'document.work.priority', input: { ...document, jobId: job.id, priority },
      version: async (tx) => {
        current = await lockJob(tx, document, job);
        if (!current) throw new AccessError(409, 'job_not_current', 'Работа сменила поколение. Обновите карточку.');
        return { current: current.version, href: '/api/documents/' + document.documentId + '/versions/' + document.versionId + '/work' };
      },
    }, async (tx) => {
      const blocked = priorityReason(current!);
      if (blocked) throw new AccessError(409, blocked, 'Приоритет доступен для ожидающей работы без неясного результата отправки.');
      const { rows: [updated] } = await tx.query<{ version: number }>(
        'UPDATE gateway_jobs SET priority=$2 WHERE id=$1 RETURNING xmin::text::bigint::float8 AS version',
        [job.id, priority],
      );
      return { body: { id: job.id, priority, version: updated.version },
        audit: { objectId: job.id, details: { previousPriority: current!.priority, priority } } };
    });
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(result.status).send(result.body);
  });
}
