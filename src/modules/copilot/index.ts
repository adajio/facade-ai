import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccessError, executeCommand, sendAccessError } from '../access/index.js';
import { authorize, readSession, touchSession, uuid, type AccessActor, type SessionAccount } from '../access/auth.js';
import { invalid, unavailable } from '../access/errors.js';
import type { CopilotMemory, MemorySource, StoredAnswer } from './contracts.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { verifyCopilotInputs } from './admission.js';
import { createCopilotMemory, readCopilotVersions } from './memory.js';
export { createCopilotMemory, createCopilotResearch } from './memory.js';
export { copilotKind, copilotModelAdmission, enqueueCopilot, processNextCopilot, type CopilotRuntime } from './worker.js';

type Project = { projectId: string };
type Search = { Params: Project; Querystring: { q?: string; scopeId?: string } };
type Question = { Params: Project & { questionId: string } };
type Source = { Params: Project; Querystring: { id?: string; scopeId?: string } };

const engineer = ({ role }: AccessActor) => role === 'engineer' || role === 'project_manager';

function text(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || value.includes('\0')) {
    throw invalid('invalid_input', `Введите текст длиной от 1 до ${limit} символов.`);
  }
  return value.trim();
}

export function publicSource(source: MemorySource) {
  const { id, label, address, documentId, versionId, text, context, window, version, representation, limitations } = source;
  return { id, label, address, documentId, versionId, text, context, window, version, representation, limitations };
}

export async function register(app: FastifyInstance) {
  let service: ReturnType<typeof createRuntimePdfService> | undefined;
  const reader = () => service ??= createRuntimePdfService(app.db, app.config);
  app.addHook('onClose', async () => { service?.close(); });
  registerCopilot(app, createCopilotMemory(app.db, reader));
}

export function registerCopilot(app: FastifyInstance, memory: CopilotMemory) {
  const { db } = app;
  const path = '/api/projects/:projectId/copilot';

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });

  async function read<T>(request: FastifyRequest, projectId: string, work: (
    actor: AccessActor, session: SessionAccount,
  ) => Promise<T>, scopeId?: string, editable = false) {
    const requirement = { action: editable ? 'project:engineer' as const : 'project:read' as const, projectId, scopeId };
    const session = await readSession(db, request);
    const actor = await authorize(db, session, requirement);
    const result = await work(actor, session);
    const current = await readSession(db, request);
    if ((await authorize(db, current, requirement)).role !== actor.role) throw unavailable();
    await touchSession(db, current);
    return result;
  }

  app.get<Search>(path + '/search', (request) => {
    const projectId = uuid(request.params.projectId);
    const scopeId = request.query.scopeId === undefined ? undefined : uuid(request.query.scopeId);
    const query = text(request.query.q, 200);
    return read(request, projectId, async (actor, session) => {
      if (engineer(actor)) {
        const result = await memory.search(session, projectId, query);
        return { mode: 'originals', sources: result.sources.map(publicSource), windows: result.windows.map(publicSource), limitations: result.limitations };
      }
      if (!scopeId) return { mode: 'publications', sources: [], limitations: ['Выберите область опубликованных фрагментов.'] };
      return { mode: 'publications', ...await memory.searchPublications(session, projectId, scopeId, query) };
    }, scopeId);
  });

  app.get<Source>(path + '/sources', (request) => {
    const projectId = uuid(request.params.projectId);
    const sourceId = request.query.id;
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 360) throw unavailable();
    const scopeId = request.query.scopeId === undefined ? undefined : uuid(request.query.scopeId);
    return read(request, projectId, async (actor, session) => {
      if (engineer(actor)) {
        const source = await memory.open(session, projectId, sourceId);
        if (!source) throw unavailable();
        return { mode: 'originals', source: publicSource(source) };
      }
      const source = scopeId ? await memory.openPublication(session, projectId, scopeId, sourceId) : null;
      if (!source) throw unavailable();
      return { mode: 'publications', source };
    }, scopeId);
  });

  app.get<{ Params: Project & { versionId: string } }>(path + '/versions/:versionId', (request) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    return read(request, projectId, async () => {
      const version = (await readCopilotVersions(db, projectId, [versionId])).get(versionId);
      if (!version) throw unavailable();
      const { documentId, label, version: state, mediaType, receiptId, occurrenceId } = version;
      return { documentId, versionId, label, version: state, mediaType, receiptId, occurrenceId };
    }, undefined, true);
  });

  app.post<{ Params: Project }>(path + '/questions', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const body = request.body as { question?: unknown } | null;
    const question = text(body?.question, 2000);
    const result = await executeCommand(db, request, {
      operation: 'copilot.ask', requirement: { action: 'project:engineer', projectId }, input: { question },
    }, async (tx, actor) => {
      const { rows: [created] } = await tx.query<{ id: string }>(
        `INSERT INTO copilot_questions (organization_id,project_id,user_id,session_id,question)
         VALUES($1,$2,$3,$4,$5) RETURNING id`, [actor.organizationId, projectId, actor.userId, actor.sessionId, question]);
      return { body: created, status: 202, audit: { objectId: created.id } };
    });
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(result.status).send(result.body);
  });

  app.get<Question>(path + '/questions/:questionId', (request) => {
    const projectId = uuid(request.params.projectId);
    const questionId = uuid(request.params.questionId);
    return read(request, projectId, async (actor, session) => {
      const { rows: [row] } = await db.query<{
        id: string; question: string; state: string; reason: string | null; result: StoredAnswer | null;
        queueReason: string | null; generationCurrent: boolean | null; researchSourceId: string | null;
        jobId: string | null; scopeId: string | null; asOf: Date | null;
      }>(`SELECT q.id,q.question,q.state,q.reason,q.result,
             CASE WHEN j.state='held' OR (j.state='ready' AND j.available_at>clock_timestamp()) THEN j.reason END AS "queueReason",
             g.current AS "generationCurrent",q.research_source_id AS "researchSourceId",
             j.id AS "jobId",j.scope_id AS "scopeId",
             (SELECT e.created_at FROM gateway_outbox e WHERE e.job_id=j.id AND e.event_type='finished'
              ORDER BY e.lease_epoch DESC LIMIT 1) AS "asOf"
           FROM copilot_questions q LEFT JOIN gateway_jobs j ON j.id=q.job_id
           LEFT JOIN gateway_generations g ON g.generation_id=j.generation_id
           WHERE q.project_id=$1 AND q.user_id=$2 AND q.id=$3`, [projectId, actor.userId, questionId]);
      if (!row) throw unavailable();
      const { id, question, result } = row;
      let { state, reason } = row;
      if (!result && row.generationCurrent === false) { state = 'held'; reason = 'inputs_changed'; }
      else if (!result && row.queueReason && row.queueReason !== 'addressed_research') { state = 'held'; reason = row.queueReason; }
      if (!result) return { id, question, state, reason,
        ...(state === 'research_queued' && row.researchSourceId ? { researchSourceId: row.researchSourceId } : {}),
      };
      const unavailableSources = { id, question, state: 'held', reason: 'sources_unavailable' };
      if (!row.jobId || !await verifyCopilotInputs(db, {
        projectId, scopeId: row.scopeId, jobId: row.jobId, inputRefs: result.exposed.map(({ id }) => id),
      })) return unavailableSources;
      const citations = await Promise.all(result.cited.map((sourceId) => memory.open(session, projectId, sourceId)));
      if (citations.some((source) => !source)) return unavailableSources;
      const sources = citations.filter((source): source is MemorySource => source !== null).map(publicSource);
      const historical = sources.some(({ version }) => version === 'historical') ||
        !result.claims.length && row.generationCurrent === false;
      return {
        id, question, state: historical ? 'historical' : state, reason, asOf: row.asOf,
        claims: result.claims, citations: sources,
        limitations: result.limitations,
      };
    }, undefined, true);
  });
}
