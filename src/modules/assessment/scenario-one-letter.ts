import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { executeCommand, requireAccess } from "../access/index.js";
import { lockIntakeProject } from "../intake/gate.js";
import { identifier } from "./inputs.js";
import { AssessmentError, invalidInput } from "./store.js";

async function letter(tx: Pick<PoolClient, "query">, projectId: string, reviewId: string) {
  const { rows: [review] } = await tx.query<{ draftText: string; requests: {key: string; text: string}[] }>(
    `SELECT r.draft_text AS "draftText",s.requests FROM preliminary_package_reviews r
      JOIN intake_scenario_one_results s ON s.review_id=r.id WHERE r.project_id=$1 AND r.id=$2`, [projectId, reviewId],
  );
  if (!review) throw new AssessmentError(404, "scenario_one_letter_not_found", "Черновик недоступен.");
  const { rows: events } = await tx.query<{ version: number; kind: "draft" | "sent" | "response"; body: string; createdAt: Date; requestKey: string | null; responseState: string | null }>(
    `SELECT version,kind,body,created_at AS "createdAt",request_key AS "requestKey",response_state AS "responseState" FROM intake_scenario_one_letter_events
      WHERE review_id=$1 ORDER BY version DESC`, [reviewId],
  );
  return {
    version: events[0]?.version ?? 0,
    text: events.find(event => event.kind === "draft")?.body ?? review.draftText,
    history: events,
    requests: review.requests,
  };
}

export function registerScenarioOneLetter(app: FastifyInstance, prefix: string) {
  const url = `${prefix}/projects/:projectId/preliminary-package-reviews/:id/scenario-one-letter`;
  type Route = { Params: { projectId: string; id: string } };
  app.get<Route>(url, async request => {
    const projectId = identifier(request.params.projectId), reviewId = identifier(request.params.id);
    await requireAccess(app.db, request, { action: "project:engineer", projectId });
    return letter(app.db, projectId, reviewId);
  });
  app.post<Route>(url, async (request, reply) => {
    const projectId = identifier(request.params.projectId), reviewId = identifier(request.params.id);
    const input = request.body as Record<string, unknown> | undefined;
    const kind = input?.kind, body = input?.body, version = input?.version;
    const requestKey = input?.requestKey, responseState = input?.responseState;
    const linkedResponse = kind === "response" && typeof requestKey === "string" &&
      (responseState === "answered" || responseState === "closed" || responseState === "refused");
    if (!linkedResponse && (requestKey !== undefined || responseState !== undefined))
      invalidInput("Укажите пункт письма и результат ответа.");
    if ((kind !== "draft" && kind !== "sent" && kind !== "response") ||
        typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 ||
        ((kind === "draft" || kind === "response") &&
          (typeof body !== "string" || !body.trim() || body.length > 200_000))) invalidInput("Проверьте редакцию и текст письма.");
    const result = await executeCommand(app.db, request, {
      operation: "assessment.scenario_one_letter", requirement: { action: "project:engineer", projectId },
      input: { reviewId, kind, version, body, requestKey, responseState },
    }, async (tx, actor) => {
      await lockIntakeProject(tx,projectId);
      const current = await letter(tx,projectId,reviewId);
      if (current.version !== version)
        throw new AssessmentError(409, "scenario_one_letter_changed", "Письмо уже изменилось. Откройте сохранённую редакцию.");
      if (kind === "response" && !current.history.some(event => event.kind === "sent")) invalidInput("Сначала отметьте отправку письма.");
      if (linkedResponse && !current.requests.some(item => item.key === requestKey)) invalidInput("Пункт письма недоступен.");
      if (kind === "sent" || kind === "draft") {
        const eligible = await tx.query(`SELECT 1 FROM preliminary_package_reviews r
          JOIN projects p ON p.id=r.project_id AND p.catalog_version_id=r.catalog_version_id AND p.project_stage=r.stage
          JOIN intake_receipts origin ON origin.project_id=r.project_id AND origin.id=r.receipt_id
          JOIN intake_package_preparation_current cur ON cur.project_id=r.project_id AND cur.receipt_id=r.receipt_id AND cur.manifest_id=r.preparation_id
          LEFT JOIN intake_project_generations generation ON generation.project_id=r.project_id
          WHERE r.id=$1 AND r.input_generation=coalesce(generation.generation,0)
            AND NOT EXISTS (SELECT 1 FROM intake_receipts later WHERE later.project_id=r.project_id AND later.number>origin.number)
            AND NOT EXISTS (SELECT 1 FROM preliminary_package_reviews newer WHERE newer.project_id=r.project_id AND newer.receipt_id=r.receipt_id
              AND (newer.created_at,newer.id)>(r.created_at,r.id))`,[reviewId]);
        if (!eligible.rowCount) invalidInput("Изменение и отметка отправки доступны для актуального разбора.");
      }
      await tx.query(`INSERT INTO intake_scenario_one_letter_events(review_id,version,kind,body,actor_id,request_key,response_state) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [reviewId,version+1,kind,kind === "sent" ? current.text : body,actor.userId,requestKey ?? null,responseState ?? null]);
      return { body: await letter(tx,projectId,reviewId), audit: { objectId:reviewId,version:version+1 } };
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.code(result.status).send(result.body);
  });
}
