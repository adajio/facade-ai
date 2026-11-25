import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { authorize, readSession, requireMutationProtection, touchSession, uuid } from "../access/auth.js";
import { executeCommand } from "../access/commands.js";
import { AccessError, invalid, sendAccessError, unavailable } from "../access/errors.js";
import { assertScopesAvailable, lockScopes } from "../supplements/holds.js";
import { inProjectionSnapshot, publishProjectEvent, readProjectionPosition } from "../supplements/events.js";
import type { Candidate, ObservationPublication, Pair } from "./domain.js";
import { createInquiry, enqueue } from "./store.js";
import type { InquiryRow, SearchResult } from "./store.js";
import { registerApplicability } from "./applicability.js";
import { packageContext, packageSource, packageStateColumns, stale, type PackageSearch } from "./package-inquiry.js";

export { getCurrentInquiryPairs, onObservationPublished } from "./store.js";
export { processNextInquiry } from "./worker.js";
export { createGatewayMeaningChecker } from "./gateway.js";
export { createRuntimeInquiryPorts, publishReaderObservation } from "./reader.js";
export type { ObservationPublication, OpenSupport, Pair, QuestionSearchPorts } from "./domain.js";

type ReadRow = InquiryRow & Partial<SearchResult> & {
  running: boolean; sourceReplaced: boolean; basisChanged: boolean; package_result: PackageSearch | null;
};
type InquiryTarget = Pick<InquiryRow, "project_id" | "scope_id" | "assessment_context_id">;
type InquiryLocation = { scopeId?: string; assessmentContextId?: string };

function location(input: { scopeId?: unknown; assessmentContextId?: unknown }): InquiryLocation {
  if ((input.scopeId === undefined) === (input.assessmentContextId === undefined)) throw invalid();
  return input.scopeId !== undefined ? { scopeId: uuid(input.scopeId) } : { assessmentContextId: uuid(input.assessmentContextId) };
}

function requiredVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw invalid();
  return value;
}

function sourceInput(body: Record<string, unknown>) {
  return { versionId: uuid(body.versionId), anchor: requiredText(body.anchor, 200) };
}

function eventPayload(ref: InquiryTarget, id: string) {
  return { ...(ref.scope_id ? { scopeId: ref.scope_id } : { assessmentContextId: ref.assessment_context_id }), inquiryIds: [id] };
}

function currentBasis(inquiry: ReadRow, current: Awaited<ReturnType<typeof packageContext>>) {
  if (inquiry.sourceReplaced || inquiry.basisChanged || inquiry.stage !== current.payload.stage || inquiry.catalog_version_id !== current.payload.catalogVersionId) throw stale();
}

const protectedReply = { "Cache-Control": "no-store" };

function requiredText(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw invalid();
  return value.trim();
}

function optionalText(value: unknown, max?: number): string | undefined {
  return value == null ? undefined : requiredText(value, max);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function positiveVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value) || Number(value) < 1 ||
    Number(value) > 2_147_483_647) throw invalid();
  return Number(value);
}

async function target(db: Pool | PoolClient, id: string): Promise<InquiryTarget> {
  const { rows: [row] } = await db.query<InquiryTarget>("SELECT project_id, scope_id, assessment_context_id FROM inquiries WHERE id = $1", [id]);
  if (!row) throw unavailable();
  return row;
}

async function detail(tx: PoolClient, id: string, projectId: string, searchVersion?: number) {
  const { rows: [row] } = await tx.query<ReadRow>(
    `SELECT i.*, r.state, r.candidates, r.pairs, r.limitations, r.package_result,
       coalesce(j.lease_until > now(), false) AS running, ${packageStateColumns}
     FROM inquiries i
     LEFT JOIN inquiry_search_results r ON r.inquiry_id = i.id AND r.search_version = coalesce($3, i.search_version)
     LEFT JOIN inquiry_jobs j ON j.inquiry_id = i.id
     WHERE i.id = $1 AND i.project_id = $2`,
    [id, projectId, searchVersion],
  );
  if (!row || (searchVersion !== undefined && !row.state)) throw unavailable();
  return row;
}

function summary(row: ReadRow) {
  const state = row.state ?? (row.running ? "searching" : "queued");
  return {
    id: row.id, projectId: row.project_id, scopeId: row.scope_id, stage: row.stage,
    sliceId: row.slice_id, catalogVersionId: row.catalog_version_id, ...row.subject,
    version: row.version, searchVersion: row.search_version, needsReview: row.needs_review || row.sourceReplaced || row.basisChanged,
    ...(row.assessment_context_id ? {
      assessmentContextId: row.assessment_context_id, assessmentVersion: row.package_snapshot_version,
      internalOnly: true, sourceReplaced: row.sourceReplaced, basisChanged: row.basisChanged,
    } : {}),
    state, nextAction: state === "verified" ? "choose_support" : state === "partial" || state === "empty"
      ? "continue_internal_review" : "wait_for_search",
    assessmentQuestionId: row.assessment_question_id,
    assessmentHref: row.assessment_context_id
      ? `/api/v1/projects/${row.project_id}/facade-assessment/${row.package_snapshot_version}`
      : `/api/v1/projects/${row.project_id}/assessments/current?scopeId=${row.scope_id}`,
  };
}

function support(source: ObservationPublication) {
  const { supersedesVersionIds: _replacement, ...visible } = source;
  return {
    ...visible,
    href: `/api/v1/evidence/${source.evidenceId}`,
    evidenceHref: `/api/v1/evidence/${source.evidenceId}`,
    contentHref: `/api/v1/evidence/${source.evidenceId}/content`,
    originalHref: `/api/documents/${source.documentId}/versions/${source.versionId}/content`,
    receiptHref: `/api/receipts/${source.receiptId}/inventory`,
    correspondenceHref: `/api/v1/projects/${source.projectId}/supplements/links?receiptId=${source.receiptId}`,
  };
}

function candidateView(candidate: Candidate) {
  return { ...candidate, source: support(candidate.source) };
}

function pairView(pair: Pair) {
  return { ...pair, left: support(pair.left), right: support(pair.right) };
}

export async function register(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });
  await registerApplicability(app);

  for (const prefix of ["/api", "/api/v1"]) {
    app.get<{ Params: { projectId: string }; Querystring: InquiryLocation & { after?: string } }>(
      `${prefix}/projects/:projectId/inquiries`, async (request, reply) => {
        const projectId = uuid(request.params.projectId);
        const { scopeId, assessmentContextId } = location(request.query);
        const contextId = assessmentContextId ?? scopeId;
        const cursor = request.query.after?.split(".");
        if (cursor && (cursor.length !== 3 || uuid(cursor[1]) !== contextId)) throw unavailable();
        const after = cursor ? uuid(cursor[2]) : null;
        const result = await inProjectionSnapshot(app.db, async (tx) => {
          const session = await readSession(tx, request);
          await authorize(tx, session, { projectId, scopeId, action: "project:read" });
          if (assessmentContextId) await packageContext(tx, projectId, assessmentContextId);
          const position = await readProjectionPosition(tx, projectId);
          if (cursor && uuid(cursor[0]) !== position.sliceId) {
            throw new AccessError(409, "snapshot_required", "Список изменился. Обновите срез вопросов.");
          }
          const { rows } = await tx.query<ReadRow>(
            `SELECT i.*, r.state, coalesce(j.lease_until > now(), false) AS running, ${packageStateColumns}
             FROM inquiries i JOIN projects p ON p.id = i.project_id LEFT JOIN inquiry_search_results r
               ON r.inquiry_id = i.id AND r.search_version = i.search_version
             LEFT JOIN inquiry_jobs j ON j.inquiry_id = i.id
             WHERE i.project_id = $1 AND (i.scope_id = $2 AND p.catalog_version_id = i.catalog_version_id
               OR i.assessment_context_id = $4)
               AND ($3::uuid IS NULL OR i.id > $3)
             ORDER BY i.id LIMIT 101`,
            [projectId, scopeId, after, assessmentContextId],
          );
          const inquiries = rows.slice(0, 100).map(summary);
          const nextAfter = rows.length > 100 ? `${position.sliceId}.${contextId}.${inquiries[99].id}` : null;
          return { session, body: { ...position, inquiries, nextAfter } };
        });
        await touchSession(app.db, result.session);
        return reply.headers(protectedReply).send(result.body);
      },
    );

    app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/inquiries`, async (request, reply) => {
      requireMutationProtection(request);
      const projectId = uuid(request.params.projectId);
      const body = object(request.body);
      const { scopeId, assessmentContextId } = location(body);
      const subject = { subject: requiredText(body.subject), property: requiredText(body.property), variant: optionalText(body.variant) };
      const input = assessmentContextId ? {
        assessmentContextId, assessmentVersion: requiredVersion(body.assessmentVersion),
        assessmentQuestionId: body.assessmentQuestionId === undefined ? undefined : uuid(body.assessmentQuestionId), ...sourceInput(body),
      } : { scopeId, sliceId: uuid(body.sliceId), catalogVersionId: uuid(body.catalogVersionId) };
      const result = await executeCommand(app.db, request, {
        operation: "inquiry.create", requirement: { projectId, scopeId, action: "project:engineer" }, input: { ...input, ...subject },
      }, async (tx) => {
        await lockScopes(tx, projectId, scopeId ? [scopeId] : []);
        const current = await readProjectionPosition(tx, projectId);
        let inquiry: InquiryRow;
        if ("versionId" in input && input.assessmentContextId) {
          const snapshot = await packageContext(tx, projectId, input.assessmentContextId, input.assessmentVersion);
          if (input.assessmentQuestionId && !snapshot.context.questions.some(({ id }) => id === input.assessmentQuestionId)) throw unavailable();
          const source = await packageSource(tx, projectId, input, snapshot.payload, snapshot.context);
          inquiry = await createInquiry(tx, { ...subject, projectId, assessmentContextId: input.assessmentContextId,
            assessmentVersion: snapshot.version, packageSource: source, assessmentQuestionId: input.assessmentQuestionId,
            stage: snapshot.payload.stage, catalogVersionId: snapshot.payload.catalogVersionId, sliceId: current.sliceId });
        } else {
          const { rows: [scope] } = await tx.query<{ stage: string; catalog_version_id: string }>(
            `SELECT s.stage, p.catalog_version_id FROM project_scopes s JOIN projects p ON p.id = s.project_id
             WHERE s.id = $1 AND p.id = $2`, [input.scopeId, projectId],
          );
          if (!scope) throw unavailable();
          if (scope.catalog_version_id !== input.catalogVersionId || current.sliceId !== input.sliceId) {
            throw new AccessError(409, "snapshot_required", "Вопрос относится к устаревшему срезу. Обновите данные.");
          }
          inquiry = await createInquiry(tx, { ...subject, projectId, scopeId: input.scopeId!, stage: scope.stage,
            catalogVersionId: input.catalogVersionId, sliceId: input.sliceId });
        }
        await publishProjectEvent(tx, projectId, { type: "inquiries.changed", payload: eventPayload(inquiry, inquiry.id) });
        return { body: { id: inquiry.id, version: inquiry.version }, status: 201, audit: { objectId: inquiry.id, version: 1 } };
      });
      return reply.headers(protectedReply).code(result.status).send(result.body);
    });

    app.get<{ Params: { id: string }; Querystring: { searchVersion?: string; assessmentContextId?: string } }>(
      `${prefix}/inquiries/:id`, async (request, reply) => {
        const id = uuid(request.params.id);
        const selected = positiveVersion(request.query.searchVersion);
        const response = await inProjectionSnapshot(app.db, async (tx) => {
          const session = await readSession(tx, request);
          const ref = await target(tx, id);
          await authorize(tx, session, {
            projectId: ref.project_id, scopeId: ref.scope_id ?? undefined, action: "project:read",
          });
          if (request.query.assessmentContextId !== undefined &&
            uuid(request.query.assessmentContextId) !== ref.assessment_context_id) throw unavailable();
          const inquiry = await detail(tx, id, ref.project_id, selected);
          const history = await tx.query(
            `SELECT version, search_version AS "searchVersion", author_id AS "authorId",
               action, reason, answer, candidate_ids AS "candidateIds", created_at AS "createdAt"
             FROM inquiry_decisions WHERE inquiry_id = $1 AND ($2::integer IS NULL OR search_version = $2)
             ORDER BY version DESC LIMIT 50`,
            [id, selected],
          );
          const searches = await tx.query(
            `SELECT search_version AS "searchVersion", state, completed_at AS "completedAt"
             FROM inquiry_search_results WHERE inquiry_id = $1 ORDER BY search_version DESC LIMIT 50`, [id],
          );
          return { session, body: {
            ...summary(inquiry), selectedSearchVersion: selected ?? inquiry.search_version,
            candidates: inquiry.package_result?.candidates ?? (inquiry.candidates ?? []).map(candidateView),
            pairs: (inquiry.pairs ?? []).map(pairView),
            ...(inquiry.package_source ? { source: inquiry.package_result?.source ?? inquiry.package_source,
              ...(inquiry.package_result ? {
                assessmentVersion: inquiry.package_result.assessmentVersion,
                assessmentHref: `/api/v1/projects/${ref.project_id}/facade-assessment/${inquiry.package_result.assessmentVersion}`,
                sliceId: inquiry.package_result.sliceId, stage: inquiry.package_result.stage,
                catalogVersionId: inquiry.package_result.catalogVersionId,
              } : {}) } : {}),
            limitations: inquiry.limitations ?? [], decision: history.rows[0] ?? null, decisionHistory: history.rows,
            searchHistory: searches.rows,
          } };
        });
        await touchSession(app.db, response.session);
        return reply.headers(protectedReply).send(response.body);
      },
    );

    app.post<{ Params: { id: string } }>(`${prefix}/inquiries/:id/searches`, async (request, reply) => {
      requireMutationProtection(request);
      const id = uuid(request.params.id);
      const session = await readSession(app.db, request);
      const ref = await target(app.db, id);
      if (!ref.assessment_context_id) throw unavailable();
      const contextId = ref.assessment_context_id;
      const requirement = { projectId: ref.project_id, action: "project:engineer" as const };
      await authorize(app.db, session, requirement);
      const body = object(request.body);
      const input = { ...sourceInput(body), assessmentVersion: requiredVersion(body.assessmentVersion) };
      const result = await executeCommand(app.db, request, {
        operation: "inquiry.repeat", requirement, input: { id, ...input },
        version: async (tx) => {
          await lockScopes(tx, ref.project_id, []);
          const inquiry = await detail(tx, id, ref.project_id);
          return { current: inquiry.version, href: `/api/v1/inquiries/${id}` };
        },
      }, async (tx) => {
        const inquiry = await detail(tx, id, ref.project_id);
        const snapshot = await packageContext(tx, ref.project_id, contextId, input.assessmentVersion);
        const source = await packageSource(tx, ref.project_id, input, snapshot.payload, snapshot.context);
        const position = await readProjectionPosition(tx, ref.project_id);
        const { rows: [updated] } = await tx.query<{ version: number; search_version: number }>(
          `UPDATE inquiries SET version=version+1, search_version=search_version+1, slice_id=$2,
             package_snapshot_version=$3, package_source=$4, stage=$5, catalog_version_id=$6,
             needs_review=needs_review OR EXISTS (SELECT 1 FROM inquiry_decisions WHERE inquiry_id=$1)
           WHERE id=$1 RETURNING version, search_version`,
          [id, position.sliceId, snapshot.version, source, snapshot.payload.stage, snapshot.payload.catalogVersionId],
        );
        await enqueue(tx, id, updated.search_version);
        await publishProjectEvent(tx, ref.project_id, { type: "inquiries.changed", payload: eventPayload(ref, id) });
        return { body: { id, version: updated.version, searchVersion: updated.search_version },
          audit: { objectId: id, version: updated.version, details: { previousSearchVersion: inquiry.search_version } } };
      });
      return reply.headers(protectedReply).code(result.status).send(result.body);
    });

    app.post<{ Params: { id: string } }>(`${prefix}/inquiries/:id/decisions`, async (request, reply) => {
      requireMutationProtection(request);
      const session = await readSession(app.db, request);
      const id = uuid(request.params.id);
      const ref = await target(app.db, id);
      const requirement = { projectId: ref.project_id, scopeId: ref.scope_id ?? undefined, action: "project:engineer" as const };
      await authorize(app.db, session, requirement);
      const body = object(request.body);
      const action = body.action;
      if (action !== "accept" && action !== "correct" && action !== "reject") throw invalid();
      const reason = requiredText(body.reason, 4000);
      const answer = optionalText(body.answer, 4000);
      const rawIds = body.candidateIds === undefined ? [] : body.candidateIds;
      if (!Array.isArray(rawIds) || rawIds.length > 24) throw invalid();
      const candidateIds = [...new Set(rawIds.map(uuid))].sort();
      if ((action === "correct" && !answer) || (action !== "reject" && !candidateIds.length)) throw invalid();

      const result = await executeCommand(app.db, request, {
        operation: "inquiry.decide", requirement, input: { id, action, reason, answer, candidateIds },
        version: async (tx) => {
          await lockScopes(tx, ref.project_id, ref.scope_id ? [ref.scope_id] : []);
          const inquiry = await detail(tx, id, ref.project_id);
          return { current: inquiry.version, href: `/api/v1/inquiries/${id}`, details: { searchVersion: inquiry.search_version } };
        },
      }, async (tx, actor) => {
        const inquiry = await detail(tx, id, ref.project_id);
        if (ref.assessment_context_id) {
          currentBasis(inquiry, await packageContext(tx, ref.project_id, ref.assessment_context_id));
        } else {
          await assertScopesAvailable(tx, ref.project_id, [ref.scope_id!]);
          const catalog = await tx.query<{ catalog_version_id: string }>(
            "SELECT catalog_version_id FROM projects WHERE id = $1", [ref.project_id],
          );
          if (catalog.rows[0]?.catalog_version_id !== inquiry.catalog_version_id) {
            throw new AccessError(409, "snapshot_required", "Обновите вопрос для текущей версии каталога.");
          }
        }
        if (!inquiry.state) throw new AccessError(409, "search_pending", "Дождитесь завершения поиска.");
        const verified = new Set((inquiry.package_result?.candidates ?? inquiry.candidates)?.filter(({ applicability }) => applicability === "verified")
          .map(({ source }) => source.observationId));
        if (candidateIds.some((candidate) => !verified.has(candidate))) {
          throw invalid("unverified_support", "Выберите проверенные опоры текущего поиска.");
        }
        const version = inquiry.version + 1;
        await tx.query(
          `INSERT INTO inquiry_decisions
           (inquiry_id, version, search_version, author_id, action, reason, answer, candidate_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, version, inquiry.search_version, actor.userId, action, reason, answer, candidateIds],
        );
        await tx.query("UPDATE inquiries SET version = $2, needs_review = false WHERE id = $1", [id, version]);
        await publishProjectEvent(tx, ref.project_id, {
          type: "inquiries.changed", payload: eventPayload(ref, id),
        });
        return { body: { id, version }, audit: { objectId: id, version } };
      });
      return reply.headers(protectedReply).code(result.status).send(result.body);
    });
  }
}
