import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { executeCommand, requireAccess } from "../access/index.js";
import { transaction } from "../access/commands.js";
import { AccessError, sendAccessError } from "../access/errors.js";
import { accessConfig, authorize, checkCsrf, checkOrigin, readCookie, readSession } from "../access/auth.js";
import { recordDecision } from "./commands.js";
import { identifier, parseConclusion, parseDecision, versionNumber } from "./inputs.js";
import {
  AssessmentError, announceAssessment, assertAvailable, assessmentHref, getLockedGate, getQuestions,
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
      const { rows: [location] } = await db.query<{ project_id: string; scope_id: string }>(
        `SELECT s.project_id, s.scope_id FROM assessment_questions AS q
         JOIN assessment_series AS s USING (scope_id) WHERE q.id = $1`, [questionId],
      );
      if (!location) throw new AssessmentError(404, "not_found", "Ресурс недоступен.");
      const { project_id: projectId, scope_id: scopeId } = location;
      const requirement = { action: "project:engineer", projectId, scopeId } as const;
      await requireAccess(db, request, requirement);
      const input = parseDecision(request.body);
      let context: Parameters<typeof recordDecision>[1] | undefined;
      const result = await executeCommand(db, request, {
        operation: "assessment.decide", requirement, input: { questionId, ...input },
        async version(tx) {
          const gate = await getLockedGate(tx, projectId, scopeId);
          assertAvailable(gate);
          const revision = await synchronize(tx, projectId, scopeId, gate);
          const question = (await getQuestions(tx, scopeId, revision.version)).find((item) => item.id === questionId);
          const href = assessmentHref(projectId, scopeId);
          if (!question || !question.active) {
            throw new AssessmentError(412, "question_obsolete", "Обязательство изменилось.", { href });
          }
          context = { projectId, scopeId, revision, gate, question };
          return { current: question.version, href };
        },
      }, async (tx, actor) => {
        const body = await recordDecision(tx, context!, actor.userId, input);
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
      const { scopeId, startWork, reason } = parseConclusion(request.body);
      let revision: Awaited<ReturnType<typeof synchronize>>;
      let gate: Gate;
      const result = await executeCommand(db, request, {
        operation: "assessment.conclude",
        requirement: { action: "project:engineer", projectId, scopeId },
        input: { scopeId, startWork, reason },
        async version(tx) {
          gate = await getLockedGate(tx, projectId, scopeId);
          assertAvailable(gate);
          revision = await synchronize(tx, projectId, scopeId, gate);
          return { current: revision.version, href: assessmentHref(projectId, scopeId) };
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
        await announceAssessment(tx, projectId, next);
        const body = { id: conclusion.id, scopeId, version: next.version, basedOnVersion: revision.version };
        return { status: 201, body, audit: { objectId: conclusion.id, version: body.version } };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.code(result.status).header("ETag", `"${result.body.version}"`).send(result.body);
    },
  );
}
