import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AccessError, executeCommand, requireAccess } from '../access/index.js';
import type { WorkQueue } from '../gateway/queue.js';
import { transaction } from '../gateway/types.js';
import { lockIntakeProject } from '../intake/gate.js';
import { isReaderId } from '../pdf/service.js';
import { readPackageAnalysis } from './package-analysis.js';
import { packageBindingEdit } from './package-observation.js';
import type { ResearchStop } from './session.js';

const reasons = ['repeated_rejected_action','turn_limit'];
const latest = `NOT EXISTS (SELECT 1 FROM harness_research_stops later WHERE later.job_id=s.job_id AND later.sequence>s.sequence)`;
const unavailable = () => new AccessError(404, 'not_found', 'Остановка исследования недоступна.');

export async function resumeResearchStops(db: Pool, queue: Pick<WorkQueue, 'resume'>): Promise<boolean> {
  return transaction(db, async (tx) => {
    const { rows: [row] } = await tx.query<{ job_id: string }>(
      `SELECT s.job_id FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id
       JOIN gateway_generations g USING(generation_id)
       WHERE s.resume_requested_at IS NOT NULL AND j.state='held' AND j.reason=ANY($1::text[]) AND g.current AND ${latest}
       AND NOT EXISTS (SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
       ORDER BY s.resume_requested_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, [reasons]);
    return row ? queue.resume(row.job_id, reasons) : false;
  });
}

export async function register(app: FastifyInstance) {
  app.post<{ Params: { projectId: string; id: string } }>(
    '/api/projects/:projectId/package-facts/:id/binding', async (request, reply) => {
      const { projectId, id } = request.params;
      if (!isReaderId(projectId) || !isReaderId(id)) throw unavailable();
      const input = packageBindingEdit.safeParse(request.body);
      if (!input.success) throw new AccessError(422, 'invalid_facade_binding', 'Укажите принадлежность и её основание.');
      const { state, reason, candidateIds } = input.data;
      const ids = [...new Set(candidateIds)];
      if ((state === 'identified' && !ids.length) || ((state === 'common' || state === 'unidentified') && ids.length)) {
        throw new AccessError(422, 'invalid_facade_binding', 'Кандидаты должны соответствовать выбранной принадлежности.');
      }
      let version: number;
      const result = await executeCommand(app.db, request, {
        requirement: { action: 'project:engineer', projectId },
        operation: 'research.package.binding', input: { id, state, reason, ids },
        version: async (tx) => {
          await lockIntakeProject(tx, projectId);
          const { rows: [current] } = await tx.query<{ version: number }>(
            `SELECT b.version FROM harness_package_bindings b JOIN harness_package_facts f ON f.id=b.fact_id
             WHERE b.fact_id=$1 AND f.project_id=$2 ORDER BY b.version DESC LIMIT 1`, [id, projectId]);
          if (!current) throw unavailable();
          version = current.version;
          return { current: version, href: `/api/v1/projects/${projectId}/facade-assessment` };
        },
      }, async (tx, actor) => {
        const analysis = await readPackageAnalysis(tx, projectId);
        const fact = analysis.facts.find((item) => item.id === id);
        if (!fact) throw unavailable();
        const candidates = ids.flatMap((candidateId) => analysis.candidates.find((item) => item.id === candidateId) ?? []);
        if (candidates.length !== ids.length) throw new AccessError(422, 'invalid_facade_binding', 'Кандидат недоступен в текущем комплекте.');
        const binding = { state, candidates, reason, quote: fact.observation.quote ?? null, actorId: actor.userId, version: version + 1 };
        await tx.query(
          `INSERT INTO harness_package_bindings(fact_id,version,state,candidates,quote,reason,actor_id)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [id, binding.version, state, JSON.stringify(candidates), binding.quote, reason, actor.userId]);
        return { body: { id, binding }, audit: { objectId: id, version: binding.version } };
      });
      return reply.code(result.status).send(result.body);
    });

  app.get<{ Params: { projectId: string }; Querystring: { scopeId?: string } }>(
    '/api/projects/:projectId/research-stops', async (request) => {
      const { projectId } = request.params;
      const { scopeId } = request.query;
      if (!isReaderId(projectId) || (scopeId !== undefined && !isReaderId(scopeId))) throw unavailable();
      await requireAccess(app.db, request, { action: 'project:engineer', projectId, scopeId });
      const { rows } = await app.db.query<{ stop: ResearchStop; jobId: string; generationId: string;
        branch: 'A' | 'B' | 'lead'; status: string; version: number }>(
        `SELECT e.event->'stop' AS stop,j.id AS "jobId",j.generation_id AS "generationId",s.sequence AS version,
         CASE WHEN j.payload->>'mode'='lead' THEN 'lead' ELSE j.payload->>'branch' END AS branch,
         CASE WHEN NOT g.current THEN 'historical' WHEN s.resume_requested_at IS NULL THEN 'held'
              WHEN j.state='held' AND j.reason=ANY($3::text[]) AND ${latest} THEN 'continuation_requested' ELSE 'continued' END AS status
         FROM harness_research_stops s JOIN harness_research_events e USING(job_id,sequence)
         JOIN gateway_jobs j ON j.id=s.job_id JOIN gateway_generations g USING(generation_id)
         WHERE j.project_id=$1 AND j.scope_id IS NOT DISTINCT FROM $2::uuid ORDER BY e.created_at DESC,s.id LIMIT 100`, [projectId, scopeId, reasons]);
      return { items: rows.map(({ stop, ...item }) => ({ ...stop, ...item })) };
    });

  app.post<{ Params: { projectId: string; id: string } }>('/api/projects/:projectId/research-stops/:id/resume', async (request, reply) => {
    const { projectId, id } = request.params;
    if (!isReaderId(projectId) || !isReaderId(id)) throw unavailable();
    const { rows: [stop] } = await app.db.query<{ scope_id: string | null }>(
      'SELECT j.scope_id FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id WHERE s.id=$1 AND j.project_id=$2',
      [id, projectId]);
    if (!stop) throw unavailable();
    const result = await executeCommand(app.db, request, {
      requirement: { action: 'project:engineer', projectId, scopeId: stop.scope_id ?? undefined },
      operation: 'research.stop.resume', input: { id },
      ...(request.headers['if-match'] === undefined ? {} : {
        version: async (tx) => {
          const { rows: [row] } = await tx.query<{ sequence: number }>(
            'SELECT sequence FROM harness_research_stops WHERE id=$1', [id]);
          if (!row) throw unavailable();
          return { current: row.sequence, href: `/api/projects/${projectId}/research-stops` };
        },
      }),
    }, async (tx, actor) => {
      await lockIntakeProject(tx, projectId);
      await tx.query(
        `SELECT 1 FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id
         JOIN gateway_generations g USING(generation_id) WHERE s.id=$1 AND j.project_id=$2 FOR UPDATE OF g`,
        [id, projectId]);
      await tx.query(
        `SELECT 1 FROM harness_research_stops s JOIN gateway_jobs j ON j.id=s.job_id
         WHERE s.id=$1 AND j.project_id=$2 FOR UPDATE OF j`, [id, projectId]);
      const unsettled = await tx.query(
        `SELECT 1 FROM harness_research_stops s JOIN gateway_attempts a ON a.job_id=s.job_id
         WHERE s.id=$1 AND a.state IN ('sending','unknown')`, [id]);
      if (unsettled.rowCount) throw new AccessError(409, 'research_attempt_unsettled', 'Перед продолжением сверяется исход вызова модели.');
      const updated = await tx.query(
        `UPDATE harness_research_stops s SET resume_requested_at=coalesce(s.resume_requested_at,clock_timestamp()),
           resume_requested_by=coalesce(s.resume_requested_by,$3)
         FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
         WHERE s.job_id=j.id AND s.id=$1 AND j.project_id=$2 AND g.current AND ${latest}
           AND (s.resume_requested_at IS NOT NULL OR j.state='held' AND j.reason=ANY($4::text[]))`, [id, projectId, actor.userId, reasons]);
      if (!updated.rowCount) throw new AccessError(409, 'research_stop_not_current', 'Остановка больше не ожидает продолжения.');
      return { status: 202, body: { id, status: 'continuation_requested' }, audit: { objectId: id } };
    });
    return reply.code(result.status).send(result.body);
  });
}
