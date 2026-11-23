import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { executeCommand, requireAccess } from "../access/index.js";
import { transaction } from "../access/commands.js";
import { AccessError, sendAccessError } from "../access/errors.js";
import { accessConfig, authorize, checkCsrf, checkOrigin, readCookie, readSession, touchSession } from "../access/auth.js";
import { facadeKindSet, getProject, updateConfirmedFacadeKinds } from "../access/project-state.js";
import { object } from "../access/input.js";
import { lockIntakeProject } from "../intake/gate.js";
import { recordDecision } from "./commands.js";
import { facadeAssessmentHref, getLockedFacadeContext, readFacadeObservationPage, readFacadeSnapshot, synchronizeFacadeAssessment } from "./facade-store.js";
import { recordFacadeType } from "./facade-types.js";
import { identifier, parseConclusion, parseDecision, shortText, versionNumber } from "./inputs.js";
import {
  AssessmentError, announceAssessment, assertAvailable, assessmentHref, getLockedGate, getQuestions, invalidInput,
  getRevision, makeChange, snapshot, synchronize, writeRevision, type Conclusion, type Gate,
} from "./store.js";

export { selectConfirmedGrounds, type Ground, type GroundSelection, type GroundsOptions } from "./commands.js";
export { applyAssessmentUpdate, type AssessmentChange, type AssessmentUpdate, type ReviewInput } from "./updates.js";
export type { DocumentRevision, NonDeliveryStatement } from "./domain.js";
export { createDocumentRevisionReader, type DocumentRevisionReader } from "./document-revision.js";

type Project = { projectId: string };
type ScopeQuery = { scopeId?: string };

async function scopeFromQuery(tx: PoolClient, request: FastifyRequest, projectId: string, query: ScopeQuery) {
  if (query.scopeId !== undefined) return identifier(query.scopeId);
  const session = await readSession(tx, request);
  const { rows } = await tx.query<{ id: string }>(
    `SELECT s.id FROM project_scopes AS s
     JOIN project_memberships AS m ON m.project_id = s.project_id AND m.user_id = $2
       AND (m.scope_id IS NULL OR m.scope_id = s.id)
     WHERE s.project_id = $1 AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
     ORDER BY s.id LIMIT 2`,
    [projectId, session.id],
  );
  if (rows.length === 1) return rows[0]!.id;
  await authorize(tx, session, { action: "project:read", projectId });
  throw new AssessmentError(422, "scope_required", "Выберите область оценки.");
}

/** Called inside a write transaction, for example before committing a catalog or scope change. */
export async function refreshScopeAssessment(tx: PoolClient, projectId: string, scopeId: string) {
  const gate = await getLockedGate(tx, projectId, scopeId);
  return synchronize(tx, projectId, scopeId, gate);
}

export async function register(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });
  const config = accessConfig();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method !== "POST") return;
    const cookie = readCookie(request);
    if (cookie) {
      checkOrigin(request, config);
      checkCsrf(request, cookie);
    }
  });
  for (const prefix of ["/api/v1", "/api"]) {
    registerRoutes(app, prefix);
  }
}

function registerRoutes(app: FastifyInstance, prefix: string) {
  const db = app.db;
  const facadePath = `${prefix}/projects/:projectId/facade-assessment`;
  type FacadeParams = Project & { version?: string };
  async function readFacade(request: FastifyRequest<{ Params: FacadeParams }>, reply: FastifyReply) {
      const projectId = identifier(request.params.projectId);
      const version = request.params.version === undefined ? undefined : versionNumber(request.params.version);
      const result = await transaction(db, async (tx) => {
        const session = await readSession(tx, request);
        await authorize(tx, session, { action: "project:read", projectId });
        const current = version === undefined ? await synchronizeFacadeAssessment(tx, projectId) :
          await readFacadeSnapshot(tx, projectId, version);
        if (!current) throw new AssessmentError(404, "assessment_not_found", "Версия оценки недоступна.");
        await touchSession(tx, session);
        const { observations, contexts, ...payload } = current.payload;
        return {
          ...payload, version: current.version, historical: version !== undefined,
          contexts: version === undefined ? contexts : contexts.map((context) => ({ ...context, historical: true })),
          observations: { counts: observations.counts, proposalCounts: observations.proposalCounts,
            href: `${facadeAssessmentHref(projectId)}/${current.version}/observations` },
        };
      });
      return reply.header("ETag", `"${result.version}"`).send(result);
  }
  app.get<{ Params: FacadeParams }>(facadePath, readFacade);
  app.get<{ Params: FacadeParams }>(`${facadePath}/:version`, readFacade);
  app.get<{
    Params: Project & { version: string };
    Querystring: { binding?: string; facadeId?: string; after?: string; limit?: string; proposal?: string };
  }>(`${facadePath}/:version/observations`, async (request, reply) => {
    const projectId = identifier(request.params.projectId);
    const version = versionNumber(request.params.version);
    const { binding, facadeId, after, limit, proposal } = request.query;
    if (binding !== undefined && binding !== "identified" && binding !== "common" &&
        binding !== "unclear" && binding !== "unidentified") invalidInput("Неизвестный тип привязки.");
    if (proposal !== undefined && proposal !== "stage" && proposal !== "facadeKind") {
      invalidInput("Неизвестный вид предложения.");
    }
    const result = await transaction(db, async (tx) => {
      const session = await readSession(tx, request);
      await authorize(tx, session, { action: "project:read", projectId });
      const items = await readFacadeObservationPage(tx, projectId, version, {
        binding, proposal, facadeId: facadeId === undefined ? undefined : identifier(facadeId),
        after: after === undefined ? undefined : identifier(after),
        limit: limit === undefined ? 50 : Math.min(versionNumber(limit), 100),
      });
      await touchSession(tx, session);
      return items;
    });
    return reply.header("ETag", `"${version}"`).send(result);
  },
  );

  app.put<{ Params: Project }>(`${facadePath}/facade-kinds`, async (request, reply) => {
    const projectId = identifier(request.params.projectId);
    const input = object(request.body);
    const facadeKinds = facadeKindSet(input.facadeKinds);
    const reason = shortText(input.reason, 2000);
    const ids = input.evidenceIds ?? [];
    if (!Array.isArray(ids) || ids.length > 100) invalidInput("Укажите до 100 адресных опор.");
    const evidenceIds = [...new Set(ids.map(identifier))].sort();
    let expectedVersion: number;
    const result = await executeCommand(db, request, {
      operation: "assessment.confirm_facade_kinds",
      requirement: { action: "project:engineer", projectId },
      input: { facadeKinds, reason, evidenceIds },
      async version(tx) {
        await lockIntakeProject(tx, projectId);
        expectedVersion = (await getProject(tx, projectId)).version;
        return { current: expectedVersion, href: `/api/projects/${projectId}` };
      },
    }, async (tx, actor) => {
      if (evidenceIds.length) {
        const current = await synchronizeFacadeAssessment(tx, projectId);
        const basis = new Map(current.input.observations.filter(({ proposedFacadeKind, facadeKindSourceVerified, revisionStatus }) =>
          proposedFacadeKind && facadeKindSourceVerified && revisionStatus === "current")
          .map(({ evidenceId, proposedFacadeKind }) => [evidenceId, proposedFacadeKind!]));
        if (evidenceIds.some((id) => !facadeKinds.includes(basis.get(id) ?? ""))) {
          invalidInput("Опора не подтверждает выбранный тип фасада в текущем комплекте.");
        }
      }
      const body = await updateConfirmedFacadeKinds(tx, { projectId, expectedVersion, facadeKinds, actor });
      await synchronizeFacadeAssessment(tx, projectId);
      return { body, audit: { objectId: projectId, version: body.version, details: { facadeKinds, reason, evidenceIds } } };
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.code(result.status).header("ETag", `"${result.body.version}"`).send(result.body);
  });

  app.put<{ Params: Project & { facadeId: string } }>(`${facadePath}/facades/:facadeId/kind`, async (request, reply) => {
    const projectId = identifier(request.params.projectId);
    const facadeId = identifier(request.params.facadeId);
    const input = object(request.body);
    if (Object.keys(input).some((key) => !["kind", "observationId", "reason"].includes(key))) invalidInput("Передано неизвестное поле.");
    const kind = shortText(input.kind, 100);
    const observationId = identifier(input.observationId);
    const reason = shortText(input.reason, 2000);
    let project: Awaited<ReturnType<typeof getProject>>;
    const result = await executeCommand(db, request, {
      operation: "assessment.confirm_facade_type",
      requirement: { action: "project:engineer", projectId },
      input: { facadeId, kind, observationId, reason },
      async version(tx) {
        await lockIntakeProject(tx, projectId);
        project = await getProject(tx, projectId);
        return { current: project.version, href: `/api/projects/${projectId}` };
      },
    }, async (tx, actor) => {
      const current = await synchronizeFacadeAssessment(tx, projectId);
      const facade = current.active.find(({ context }) => context.facadeId === facadeId)?.context;
      if (!facade) throw new AssessmentError(404, "facade_not_found", "Фасад недоступен в текущей оценке.");
      if (current.conflicted.has(facadeId)) throw new AssessmentError(422, "facade_type_conflicting_evidence",
        "В действующих оригиналах указаны разные типы. Сверьте редакции и принадлежность опор.");
      await recordFacadeType(tx, { projectId, contextId: facade.id, facadeId, kind, reason, actorId: actor.userId,
        stage: project.stage, fact: current.input.observations.find(({ id }) => id === observationId) });

      const types = current.active.filter(({ context }) => context.facadeId).map(({ context }) =>
        context.facadeId === facadeId ? kind : context.facadeType?.state === "confirmed" ? context.facadeType.kind : null);
      const allConfirmed = !types.includes(null);
      const facadeKinds = allConfirmed ? types.filter((type): type is string => type !== null) : project.confirmedFacadeKinds;
      const saved = await updateConfirmedFacadeKinds(tx, { projectId, expectedVersion: project.version, facadeKinds, actor,
        advanceVersion: true, assignmentBased: allConfirmed || project.facadeKindsFromAssignments });
      const updated = await synchronizeFacadeAssessment(tx, projectId);
      const facadeType = updated.active.find(({ context }) => context.facadeId === facadeId)?.context.facadeType;
      const body = { facadeId, assessmentContextId: facade.id, facadeType, version: saved.version, assessmentVersion: updated.version };
      return { body, audit: { objectId: facade.id, version: saved.version, details: { facadeId, kind, observationId, reason } } };
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.code(result.status).header("ETag", `"${result.body.version}"`).send(result.body);
  });

  app.get<{ Params: Project; Querystring: ScopeQuery }>(
    `${prefix}/projects/:projectId/assessments/current`,
    async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const result = await transaction(db, async (tx) => {
        const scopeId = await scopeFromQuery(tx, request, projectId, request.query);
        const actor = await authorize(tx, await readSession(tx, request), { action: "project:read", projectId, scopeId });
        const gate = await getLockedGate(tx, projectId, scopeId);
        return snapshot(tx, await synchronize(tx, projectId, scopeId, gate), gate,
          actor.role === "engineer" || actor.role === "project_manager");
      });
      return reply.header("ETag", `"${result.version}"`).send(result);
    },
  );

  app.get<{ Params: Project; Querystring: ScopeQuery & { before?: string; limit?: string } }>(
    `${prefix}/projects/:projectId/assessments`,
    (request) => transaction(db, async (tx) => {
      const projectId = identifier(request.params.projectId);
      const scopeId = await scopeFromQuery(tx, request, projectId, request.query);
      await authorize(tx, await readSession(tx, request), { action: "project:read", projectId, scopeId });
      const before = request.query.before === undefined ? null : versionNumber(request.query.before);
      const limit = request.query.limit === undefined ? 50 : Math.min(versionNumber(request.query.limit), 100);
      const { rows } = await tx.query(
        `SELECT version, catalog_version_id AS "catalogVersionId", change, created_at AS "createdAt"
         FROM assessment_revisions WHERE scope_id = $1 AND ($2::integer IS NULL OR version < $2)
         ORDER BY version DESC LIMIT $3`,
        [scopeId, before, limit + 1],
      );
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].version : null };
    }),
  );

  app.get<{ Params: Project & { version: string }; Querystring: ScopeQuery }>(
    `${prefix}/projects/:projectId/assessments/:version`,
    (request) => transaction(db, async (tx) => {
      const projectId = identifier(request.params.projectId);
      const scopeId = await scopeFromQuery(tx, request, projectId, request.query);
      await authorize(tx, await readSession(tx, request), { action: "project:read", projectId, scopeId });
      const revision = await getRevision(tx, projectId, scopeId, versionNumber(request.params.version));
      if (!revision) throw new AssessmentError(404, "assessment_not_found", "Версия оценки недоступна.");
      return snapshot(tx, revision);
    }),
  );

  app.post<{ Params: { questionId: string } }>(
    `${prefix}/questions/:questionId/decisions`,
    async (request, reply) => {
      const questionId = identifier(request.params.questionId);
      await requireAccess(db, request, { action: "session" });
      const { rows: [location] } = await db.query<{ project_id: string; scope_id: string; assessment_context_id: string | null }>(
        `SELECT s.project_id, s.scope_id, s.assessment_context_id FROM assessment_questions AS q
         JOIN assessment_series AS s USING (scope_id) WHERE q.id = $1`, [questionId],
      );
      if (!location) throw new AssessmentError(404, "not_found", "Ресурс недоступен.");
      const { project_id: projectId, scope_id: scopeId, assessment_context_id: assessmentContextId } = location;
      const requirement = { action: "project:engineer", projectId, scopeId: assessmentContextId ? undefined : scopeId } as const;
      await requireAccess(db, request, requirement);
      const input = parseDecision(request.body);
      let context: Parameters<typeof recordDecision>[1] | undefined;
      const result = await executeCommand(db, request, {
        operation: "assessment.decide", requirement, input: { questionId, ...input },
        async version(tx) {
          const facade = assessmentContextId ? await getLockedFacadeContext(tx, projectId, assessmentContextId) : null;
          const gate = facade?.gate ?? await getLockedGate(tx, projectId, scopeId);
          assertAvailable(gate);
          const revision = facade?.revision ?? await synchronize(tx, projectId, scopeId, gate);
          const question = (facade?.questions ?? await getQuestions(tx, scopeId, revision.version)).find((item) => item.id === questionId);
          const href = facade ? facadeAssessmentHref(projectId) : assessmentHref(projectId, scopeId);
          if (!question || !question.active) {
            throw new AssessmentError(412, "question_obsolete", "Обязательство изменилось.", { href });
          }
          if (question.review?.supplementReceiptIds?.length) {
            throw new AssessmentError(409, "question_held", "Ожидается проверка досылки по вопросу.", {
              receiptIds: question.review.supplementReceiptIds, href,
            });
          }
          context = { projectId, scopeId, assessmentContextId: assessmentContextId ?? undefined, revision, gate, question };
          return { current: question.version, href };
        },
      }, async (tx, actor) => {
        const body = await recordDecision(tx, context!, actor.userId, input);
        if (assessmentContextId) await synchronizeFacadeAssessment(tx, projectId);
        return { status: 201, body, audit: { objectId: questionId, version: body.version } };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.code(result.status).header("ETag", `"${result.body.version}"`).send(result.body);
    },
  );

  app.post<{ Params: Project }>(
    `${prefix}/projects/:projectId/conclusions`,
    async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const { scopeId, assessmentContextId, startWork, reason } = parseConclusion(request.body);
      let revision: Awaited<ReturnType<typeof synchronize>>;
      let gate: Gate;
      const result = await executeCommand(db, request, {
        operation: "assessment.conclude",
        requirement: { action: "project:engineer", projectId, scopeId },
        input: { scopeId, assessmentContextId, startWork, reason },
        async version(tx) {
          const facade = assessmentContextId ? await getLockedFacadeContext(tx, projectId, assessmentContextId) : null;
          gate = facade?.gate ?? await getLockedGate(tx, projectId, scopeId!);
          assertAvailable(gate);
          if (facade?.questions.some(({ active, review }) => active && review?.supplementReceiptIds?.length)) {
            throw new AssessmentError(409, "context_held", "Ожидается проверка досылки по контексту.",
              { href: facadeAssessmentHref(projectId) });
          }
          revision = facade?.revision ?? await synchronize(tx, projectId, scopeId!, gate);
          return { current: revision.version, href: facade ? facadeAssessmentHref(projectId) : assessmentHref(projectId, scopeId!) };
        },
      }, async (tx, actor) => {
        const current = await snapshot(tx, revision, gate);
        const conclusion: Conclusion = {
          id: randomUUID(), startWork, reason, authorId: actor.userId, createdAt: new Date().toISOString(),
          basedOnVersion: revision.version,
          criticalQuestionIds: current.questions.filter(({ decision }) => decision?.startWorkCritical)
            .map(({ id }) => id),
        };
        const next = await writeRevision(tx, revision, revision.version + 1, gate,
          makeChange("engineer_conclusion", []), conclusion);
        if (assessmentContextId) await synchronizeFacadeAssessment(tx, projectId);
        else await announceAssessment(tx, projectId, next);
        const body = { id: conclusion.id, scopeId, assessmentContextId, version: next.version, basedOnVersion: revision.version };
        return { status: 201, body, audit: { objectId: conclusion.id, version: body.version } };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.code(result.status).header("ETag", `"${result.body.version}"`).send(result.body);
    },
  );
}
