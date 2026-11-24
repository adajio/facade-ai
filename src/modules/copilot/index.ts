import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccessError, executeCommand, sendAccessError } from '../access/index.js';
import { authorize, readSession, touchSession, uuid, type AccessActor, type SessionAccount } from '../access/auth.js';
import { invalid, unavailable } from '../access/errors.js';
import { journalFromEnv } from '../gateway/index.js';
import type { PostgresIntentJournal } from '../gateway/journal.js';
import type { CopilotMemory, MemorySource, SourceIdentity, StoredAnswer } from './contracts.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { recordedReadAddresses, type Message, type ReadBatch } from './protocol.js';
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
  const { id, label, address, documentId, versionId, sha256, readerVersion, text, context, window, version, representation, limitations } = source;
  return { id, label, address, documentId, versionId, sha256, readerVersion, text, context, window, version, representation, limitations };
}

export async function register(app: FastifyInstance) {
  let service: ReturnType<typeof createRuntimePdfService> | undefined;
  let journal: ReturnType<typeof journalFromEnv> | undefined;
  const reader = () => service ??= createRuntimePdfService(app.db, app.config);
  app.addHook('onClose', async () => { service?.close(); await journal?.close(); });
  registerCopilot(app, createCopilotMemory(app.db, reader), async (projectId) => {
    if (journal === undefined) journal = journalFromEnv();
    return await journal?.journal.copilotBudget(projectId) ?? null;
  });
}

export function registerCopilot(app: FastifyInstance, memory: CopilotMemory,
  readBudget?: PostgresIntentJournal['copilotBudget'],
) {
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

  app.get<{ Params: Project }>(path + '/budget', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const projectId = uuid(request.params.projectId);
    return read(request, projectId, async () => {
      try {
        const balance = await readBudget?.(projectId);
        if (!balance) return { state: 'unconfigured' };
        const { limitUsdNanos, remainingUsdNanos, frozen } = balance;
        return { state: frozen ? 'frozen' : 'ready', limitUsdNanos, remainingUsdNanos: frozen ? 0 : remainingUsdNanos };
      } catch {
        return { state: 'unavailable' };
      }
    }, undefined, true);
  });

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

  async function partialReads(projectId: string, scopeId: string | null, jobId: string, researchSourceId?: string) {
    const { rows: [job] } = await db.query<{
      cursor: { found: SourceIdentity[]; opened: string[]; messages: Message[]; readBatch?: ReadBatch } | null;
    }>(`SELECT j.cursor FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
       WHERE j.id=$1 AND j.project_id=$2 AND g.current`, [jobId, projectId]);
    if (!job) return null;
    const cursor = job.cursor;
    if (!cursor || (!cursor.opened.length && !researchSourceId && !cursor.readBatch)) return { sources: [] };
    if (!await verifyCopilotInputs(db, {
      projectId, scopeId, jobId, inputRefs: cursor.found.map(({ id }) => id),
    })) return null;
    const opened = new Set(cursor.opened);
    const addresses = recordedReadAddresses(cursor.messages, opened);
    const sources = cursor.found.filter(({ id }) => addresses.has(id) || id === researchSourceId);
    const batch = cursor.readBatch;
    const inputs = batch ? cursor.found.slice(0, batch.foundBefore) : [];
    const current = await readCopilotVersions(db, projectId, [...new Set([...sources, ...inputs].map(({ versionId }) => versionId))]);
    const { rowCount } = await db.query(
      `SELECT 1 FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
       WHERE j.id=$1 AND j.project_id=$2 AND g.current`, [jobId, projectId],
    );
    if (!rowCount) return null;
    function currentSource(pin: SourceIdentity) {
      const source = current.get(pin.versionId);
      return source?.version === 'current' && source.sha256 === pin.sha256 && source.documentId === pin.documentId
        ? { id: pin.id, label: source.label } : null;
    }
    const permitted = sources.map(currentSource).filter((source) => source !== null);
    // Search terms can include content from the earlier model context.
    const readActions = batch && inputs.every(currentSource) ? batch.calls.map(({ action }, index) => {
      const completed = index < batch.next;
      if (action.name === 'search_sources') return { operation: action.name, completed, query: action.args.query };
      const source = inputs.find(({ id }) => id === action.args.sourceId);
      return { operation: action.name, completed, ...(source ? { sourceId: source.id } : {}) };
    }) : undefined;
    return {
      sources: permitted.flatMap((source) => {
        const address = addresses.get(source.id);
        return address ? [{ ...source, ...address }] : [];
      }),
      researchSourceId: permitted.find(({ id }) => id === researchSourceId)?.id,
      readActions,
    };
  }

  app.get<Question>(path + '/questions/:questionId', (request) => {
    const projectId = uuid(request.params.projectId);
    const questionId = uuid(request.params.questionId);
    return read(request, projectId, async (actor, session) => {
      const { rows: [row] } = await db.query<{
        id: string; question: string; state: string; reason: string | null; result: StoredAnswer | null;
        queueReason: string | null; generationCurrent: boolean | null; researchSourceId: string | null;
        jobId: string | null; scopeId: string | null; asOf: Date | null; readBatchPending: boolean | null;
      }>(`SELECT q.id,q.question,q.state,q.reason,q.result,
             CASE WHEN j.state='held' OR (j.state='ready' AND j.available_at>clock_timestamp()) THEN j.reason END AS "queueReason",
             g.current AS "generationCurrent",q.research_source_id AS "researchSourceId",
             j.id AS "jobId",j.scope_id AS "scopeId",
             (j.cursor#>>'{readBatch,next}')::int < jsonb_array_length(j.cursor#>'{readBatch,calls}') AS "readBatchPending",
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
      const unavailableSources = { id, question, state: 'held', reason: 'sources_unavailable' };
      if (!result) {
        const partial = (state === 'held' || row.readBatchPending) && row.generationCurrent && row.jobId
          ? await partialReads(projectId, row.scopeId, row.jobId, row.researchSourceId ?? undefined) : undefined;
        if (partial === null) return unavailableSources;
        const researchSourceId = state === 'held' ? partial?.researchSourceId : row.researchSourceId;
        return { id, question, state, reason,
          ...(researchSourceId ? { researchSourceId } : {}),
          ...(partial?.sources.length ? { partialSources: partial.sources } : {}),
          ...(partial?.readActions ? { readActions: partial.readActions } : {}),
        };
      }
      if (!row.jobId || !await verifyCopilotInputs(db, {
        projectId, scopeId: row.scopeId, jobId: row.jobId, inputRefs: result.exposed.map(({ id }) => id),
      })) return unavailableSources;
      const citations = await Promise.all(result.cited.map((sourceId) => memory.open(session, projectId, sourceId)));
      if (citations.some((source) => !source)) return unavailableSources;
      const sources = citations.filter((source): source is MemorySource => source !== null).map(publicSource);
      const historical = sources.some(({ version }) => version === 'historical') ||
        !result.claims.length && row.generationCurrent === false;
      const partial = !result.claims.length && !historical && row.jobId
        ? await partialReads(projectId, row.scopeId, row.jobId) : undefined;
      return {
        id, question, state: historical ? 'historical' : state, reason, asOf: row.asOf,
        claims: result.claims, citations: sources,
        ...(partial?.sources.length ? { partialSources: partial.sources } : {}),
        ...(partial?.readActions ? { readActions: partial.readActions } : {}),
        limitations: result.limitations,
      };
    }, undefined, true);
  });
}
