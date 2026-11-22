import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AccessError, executeCommand, requireAccess } from '../access/index.js';
import type { WorkQueue } from '../gateway/queue.js';
import { transaction } from '../gateway/types.js';
import { isReaderId } from '../pdf/service.js';
import type { ResearchStop } from './session.js';

const reason = 'repeated_rejected_action';
const latest = `NOT EXISTS (SELECT 1 FROM harness_research_stops later WHERE later.job_id=s.job_id AND later.sequence>s.sequence)`;
const unavailable = () => new AccessError(404, 'not_found', 'Остановка исследования недоступна.');

export async function resumeResearchStops(db: Pool, queue: Pick<WorkQueue, 'resume'>): Promise<boolean> {
  return transaction(db, async (tx) => {
    const { rows: [row] } = await tx.query<{ job_id: string }>(
      `SELECT s.job_id FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id
       JOIN gateway_generations g USING(generation_id)
       WHERE s.resume_requested_at IS NOT NULL AND j.state='held' AND j.reason=$1 AND g.current AND ${latest}
       AND NOT EXISTS (SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
       ORDER BY s.resume_requested_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, [reason]);
    return row ? queue.resume(row.job_id, [reason]) : false;
  });
}

export async function register(app: FastifyInstance) {
  app.get<{ Params: { projectId: string }; Querystring: { scopeId: string } }>(
    '/api/projects/:projectId/research-stops', async (request) => {
      const { projectId } = request.params;
      const { scopeId } = request.query;
      if (!isReaderId(projectId) || !isReaderId(scopeId)) throw unavailable();
      await requireAccess(app.db, request, { action: 'project:engineer', projectId, scopeId });
      const { rows } = await app.db.query<{ stop: ResearchStop; jobId: string; generationId: string;
        branch: 'A' | 'B' | 'lead'; status: string }>(
        `SELECT e.event->'stop' AS stop,j.id AS "jobId",j.generation_id AS "generationId",
         CASE WHEN j.payload->>'mode'='lead' THEN 'lead' ELSE j.payload->>'branch' END AS branch,
         CASE WHEN NOT g.current THEN 'historical' WHEN s.resume_requested_at IS NULL THEN 'held'
              WHEN j.state='held' AND j.reason=$3 AND ${latest} THEN 'continuation_requested' ELSE 'continued' END AS status
         FROM harness_research_stops s JOIN harness_research_events e USING(job_id,sequence)
         JOIN gateway_jobs j ON j.id=s.job_id JOIN gateway_generations g USING(generation_id)
         WHERE j.project_id=$1 AND j.scope_id=$2 ORDER BY e.created_at DESC,s.id LIMIT 100`, [projectId, scopeId, reason]);
      return { items: rows.map(({ stop, ...item }) => ({ ...stop, ...item })) };
    });

  app.post<{ Params: { projectId: string; id: string } }>('/api/projects/:projectId/research-stops/:id/resume', async (request, reply) => {
    const { projectId, id } = request.params;
    if (!isReaderId(projectId) || !isReaderId(id)) throw unavailable();
    const { rows: [stop] } = await app.db.query<{ scope_id: string }>(
      'SELECT j.scope_id FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id WHERE s.id=$1 AND j.project_id=$2',
      [id, projectId]);
    if (!stop) throw unavailable();
    const result = await executeCommand(app.db, request, {
      requirement: { action: 'project:engineer', projectId, scopeId: stop.scope_id },
      operation: 'research.stop.resume', input: { id },
    }, async (tx, actor) => {
      const updated = await tx.query(
        `UPDATE harness_research_stops s SET resume_requested_at=coalesce(s.resume_requested_at,clock_timestamp()),
           resume_requested_by=coalesce(s.resume_requested_by,$3)
         FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
         WHERE s.job_id=j.id AND s.id=$1 AND j.project_id=$2 AND g.current AND ${latest}
           AND (s.resume_requested_at IS NOT NULL OR j.state='held' AND j.reason=$4)`, [id, projectId, actor.userId, reason]);
      if (!updated.rowCount) throw new AccessError(409, 'research_stop_not_current', 'Остановка больше не ожидает продолжения.');
      return { status: 202, body: { id, status: 'continuation_requested' }, audit: { objectId: id } };
    });
    return reply.code(result.status).send(result.body);
  });
}
