import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { authorize, readSession, touchSession } from "../access/auth.js";
import { executeCommand } from "../access/commands.js";
import { object } from "../access/input.js";
import { inProjectionSnapshot } from "../supplements/events.js";
import { canonicalJson, compareCitationValues, normalizeFactValue, requirementSubjectKey, type Review } from "./domain.js";
import type { FacadeObservation } from "./facade-input.js";
import { facadeAssessmentHref, readFacadeSnapshot, synchronizeFacadeAssessment } from "./facade-store.js";
import { identifier, shortText, versionNumber } from "./inputs.js";
import { AssessmentError, invalidInput } from "./store.js";

type Decision =
  | { action: "confirm" | "exclude" }
  | { action: "select_variant"; variant: string }
  | { action: "correct"; value: string; unit: string | null }
  | { action: "merge"; primaryId: string };
type Input = { observationId: string; memberIds: string[]; reason: string; decision: Decision };
type Saved = {
  id: string; decision: Decision; reason: string; authorId: string; createdAt: string; assessmentVersion: number;
};
type Member = Saved & { observationId: string; bindingKey: string; memberCount: number };
type Place = Pick<FacadeObservation, "id" | "evidenceId" | "address" | "quote" | "value" | "unit" | "variant" |
  "branch" | "documentId" | "versionId" | "sha256" | "revision">;
export type FactReviewView = Saved & {
  state: "applied" | "review_required" | "stale";
  places: Place[];
  normalized: ReturnType<typeof normalizeFactValue>;
  variant: string | null;
  mergedInto?: string;
};

export function factArea(observation: FacadeObservation) {
  const { state, candidates } = observation.binding;
  if (state === "common") return "common";
  if (state === "identified" && candidates.length === 1) return candidates[0].id;
  return null;
}

function bindingKey(observation: FacadeObservation) {
  return canonicalJson([observation.binding.state, observation.binding.candidates.map(({ id }) => id).sort(),
    observation.revisionStatus, observation.versionId, observation.sha256, observation.address]);
}

export function factEquivalenceKey(observation: FacadeObservation) {
  const area = factArea(observation);
  const subject = requirementSubjectKey(observation.attribute ?? "");
  const normalized = normalizeFactValue(observation.value, observation.unit);
  if (!area || !subject || observation.revisionStatus !== "current" || !normalized ||
      (!normalized.numeric && normalized.unit)) return null;
  const variant = requirementSubjectKey(observation.variant ?? "");
  return createHash("sha256").update(canonicalJson([
    area, subject, variant, observation.sourceRole, observation.designStage,
    normalized.value, normalized.unit?.trim() || null, normalized.numeric,
  ])).digest("hex");
}

export function equivalentFacts(left: FacadeObservation, right: FacadeObservation) {
  const key = factEquivalenceKey(left);
  return key !== null && key === factEquivalenceKey(right);
}

function parseInput(observationId: string, data: unknown): Input {
  const body = object(data);
  const reason = shortText(body.reason, 2000);
  const { action } = body;
  let decision: Decision;
  let memberIds = [observationId];
  const allowed = ["action", "reason"];
  if (action === "confirm" || action === "exclude") decision = { action };
  else if (action === "select_variant") {
    allowed.push("variant");
    decision = { action, variant: shortText(body.variant, 200) };
  } else if (action === "correct") {
    allowed.push("value", "unit");
    const value = shortText(body.value, 100);
    const unit = body.unit == null || body.unit === "" ? null : shortText(body.unit, 100);
    if (!normalizeFactValue(value, unit)?.numeric) invalidInput("Укажите корректное число и единицу.");
    decision = { action, value, unit };
  } else if (action === "merge") {
    allowed.push("memberIds");
    if (!Array.isArray(body.memberIds) || body.memberIds.length < 1 || body.memberIds.length > 24) {
      invalidInput("Выберите от одной до 24 эквивалентных записей.");
    }
    memberIds = [...new Set([observationId, ...body.memberIds.map(identifier)])].sort();
    if (memberIds.length < 2) invalidInput("Выберите другую эквивалентную запись.");
    decision = { action, primaryId: observationId };
  } else invalidInput("Укажите доступное действие со сведением.");
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalidInput("Передано неизвестное поле решения.");
  return { observationId, memberIds, reason, decision };
}

function viewState(observation: FacadeObservation, decision: Decision): FactReviewView["state"] {
  return decision.action === "exclude" || (decision.action === "correct" && compareCitationValues(observation, decision) !== "equal") ||
    (decision.action === "select_variant" && requirementSubjectKey(observation.variant ?? "") !== requirementSubjectKey(decision.variant))
    ? "review_required" : "applied";
}

function place({ id, evidenceId, address, quote, value, unit, variant, branch, documentId, versionId, sha256, revision }: FacadeObservation): Place {
  return { id, evidenceId, address, quote, value, unit, variant, branch, documentId, versionId, sha256, revision };
}

export async function readFactReviews(tx: PoolClient, projectId: string, observations: FacadeObservation[]) {
  const views = new Map<string, FactReviewView>();
  if (!observations.length) return views;
  const { rows } = await tx.query<Member>(
    `SELECT DISTINCT ON (m.observation_id) r.id, r.decision, r.reason, r.author_id AS "authorId",
       r.created_at AS "createdAt", r.assessment_version AS "assessmentVersion",
       m.observation_id AS "observationId", m.binding_key AS "bindingKey",
       (SELECT count(*)::integer FROM facade_fact_review_members siblings WHERE siblings.review_id=r.id) AS "memberCount"
     FROM facade_fact_reviews r JOIN facade_fact_review_members m ON m.review_id=r.id
     WHERE r.project_id=$1 AND m.observation_id=ANY($2::uuid[])
     ORDER BY m.observation_id,r.sequence DESC`, [projectId, observations.map(({ id }) => id)],
  );
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const valid = new Set(rows.filter(({ observationId, bindingKey: stored }) => bindingKey(byId.get(observationId)!) === stored)
    .map(({ observationId }) => observationId));
  const groups = Map.groupBy(rows, ({ id }) => id);
  for (const row of rows) {
    const { observationId, bindingKey: _key, memberCount, ...saved } = row;
    const observation = byId.get(observationId)!;
    const { decision } = saved;
    const groupMembers = groups.get(saved.id)!;
    const groupApplicable = decision.action !== "merge" || (groupMembers.length === memberCount &&
      groupMembers.some(({ observationId }) => observationId === decision.primaryId) &&
      groupMembers.every(({ observationId }) => valid.has(observationId)));
    const state = valid.has(observationId) && groupApplicable ? viewState(observation, decision) : "stale";
    const normalized = state !== "stale" && decision.action === "correct"
      ? normalizeFactValue(decision.value, decision.unit) : normalizeFactValue(observation.value, observation.unit);
    views.set(observationId, { ...saved, state, normalized,
      variant: state !== "stale" && decision.action === "select_variant" ? decision.variant : observation.variant,
      places: decision.action === "merge" && state !== "stale"
        ? groupMembers.map(({ observationId }) => place(byId.get(observationId)!)) : [place(observation)],
      ...(decision.action === "merge" && state !== "stale" && observationId !== decision.primaryId ? { mergedInto: decision.primaryId } : {}),
    });
  }
  return views;
}

function blocksFactEvidence(decision?: FactReviewView) {
  return decision?.state === "review_required" || decision?.state === "stale" && decision.decision.action === "exclude";
}

/** A changed fact stays outside the machine proof until its reading is accepted again. */
export function holdReviewedEvidence(review: Review, reviews: ReadonlyMap<string, FactReviewView>): Review {
  const changed = ({ citation }: Review["findings"][number]) => blocksFactEvidence(reviews.get(citation.observationId));
  if (!review.findings.some(changed)) return review;
  return { findings: review.findings.filter((finding) => !changed(finding)), completenessChecked: false,
    remaining: [...new Set([...review.remaining, "engineer_fact_review_required"])], requireVerifiedPairs: true,
    ...(review.supplementReceiptIds?.length ? { supplementReceiptIds: review.supplementReceiptIds } : {}) };
}

type ObservationReviewProjection = FacadeObservation & {
  equivalenceKey?: string | null; engineeringReview?: FactReviewView;
};

async function readEquivalentFacts(tx: PoolClient, projectId: string, observationId: string, options: {
  version: number; contextId?: string; after?: string;
}) {
  const current = await readFacadeSnapshot(tx, projectId);
  if (!current) throw new AssessmentError(404, "assessment_not_found", "Версия оценки недоступна.");
  if (current.version !== options.version) throw new AssessmentError(412, "version_conflict",
    "Сведения изменились. Обновите оценку перед объединением.", { currentVersion: current.version });
  const context = current.payload.contexts.find(({ assessmentContextId }) => assessmentContextId === options.contextId);
  if (options.contextId && !context) throw new AssessmentError(404, "assessment_not_found", "Область проверки недоступна.");
  const refs = current.payload.observations.refs;
  const { rows: [selected] } = await tx.query<{ payload: ObservationReviewProjection }>(
    `SELECT payload FROM facade_assessment_observations
     WHERE project_id=$1 AND observation_id=$2 AND ref=ANY($3::text[])`,
    [projectId, observationId, refs],
  );
  const primary = selected?.payload;
  if (!primary || context?.facadeId && factArea(primary) !== context.facadeId) {
    throw new AssessmentError(404, "fact_not_found", "Сведение недоступно в выбранной области.");
  }
  if (primary.equivalenceKey === undefined) throw new AssessmentError(409, "snapshot_required",
    "Обновите оценку, чтобы получить варианты объединения.");
  if (!primary.equivalenceKey || blocksFactEvidence(primary.engineeringReview)) {
    return { items: [], nextCursor: null, version: current.version };
  }
  const groupId = primary.engineeringReview?.decision.action === "merge" && primary.engineeringReview.state === "applied"
    ? primary.engineeringReview.id : null;
  const pageSize = 24;
  const { rows } = await tx.query<Place & { attribute: string | null; label: string | null }>(
    `SELECT o.observation_id AS id,o.payload->>'evidenceId' AS "evidenceId",o.payload->'address' AS address,
       o.payload->>'quote' AS quote,o.payload->>'attribute' AS attribute,o.payload->>'branch' AS branch,
       o.payload->>'revision' AS revision,o.payload->>'documentId' AS "documentId",o.payload->>'versionId' AS "versionId",
       o.payload->>'sha256' AS sha256,o.payload->>'value' AS value,o.payload->>'unit' AS unit,o.payload->>'variant' AS variant,
       (SELECT c.relative_path FROM intake_occurrences c WHERE c.project_id=o.project_id
          AND c.receipt_id=(o.payload->>'receiptId')::uuid AND c.version_id=(o.payload->>'versionId')::uuid
          AND c.state='accepted' ORDER BY c.created_at,c.id LIMIT 1) AS label
     FROM facade_assessment_observations o
     WHERE o.project_id=$1 AND o.ref=ANY($2::text[]) AND o.observation_id<>$3
       AND o.payload->>'equivalenceKey'=$4 AND ($5::uuid IS NULL OR o.observation_id>$5)
       AND ($6::text IS NULL OR o.payload#>>'{engineeringReview,id}' IS DISTINCT FROM $6)
       AND o.payload#>>'{engineeringReview,state}' IS DISTINCT FROM 'review_required'
       AND ((o.payload#>>'{engineeringReview,state}'='stale' AND
         o.payload#>>'{engineeringReview,decision,action}'='exclude') IS NOT TRUE)
       AND o.payload#>>'{engineeringReview,mergedInto}' IS NULL
     ORDER BY o.observation_id LIMIT $7`,
    [projectId, refs, observationId, primary.equivalenceKey, options.after ?? null, groupId, pageSize + 1],
  );
  const items = rows.slice(0, pageSize);
  return { items, version: current.version, nextCursor: rows.length > pageSize ? items.at(-1)!.id : null };
}

export function registerFactReviews(app: FastifyInstance, prefix: string) {
  const resource = `${prefix}/projects/:projectId/package-facts/:id`;
  app.get<{ Params: { projectId: string; id: string }; Querystring: { version?: string; contextId?: string; after?: string } }>(
    `${resource}/equivalents`, async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const observationId = identifier(request.params.id);
      const { version, contextId, after } = request.query;
      const snapshot = await inProjectionSnapshot(app.db, async (tx) => {
        const session = await readSession(tx, request);
        await authorize(tx, session, { action: "project:engineer", projectId });
        const page = await readEquivalentFacts(tx, projectId, observationId, {
          version: versionNumber(version), contextId: contextId === undefined ? undefined : identifier(contextId),
          after: after === undefined ? undefined : identifier(after),
        });
        return { session, page };
      });
      await touchSession(app.db, snapshot.session);
      return reply.header("ETag", `"${snapshot.page.version}"`).send(snapshot.page);
    },
  );

  app.post<{ Params: { projectId: string; id: string } }>(
    `${resource}/reviews`, async (request, reply) => {
      const projectId = identifier(request.params.projectId);
      const input = parseInput(identifier(request.params.id), request.body);
      let current: Awaited<ReturnType<typeof synchronizeFacadeAssessment>>;
      const result = await executeCommand(app.db, request, {
        operation: "assessment.review_fact", requirement: { action: "project:engineer", projectId }, input,
        async version(tx) {
          current = await synchronizeFacadeAssessment(tx, projectId);
          return { current: current.version, href: facadeAssessmentHref(projectId) };
        },
      }, async (tx, actor) => {
        const byId = new Map(current.input.observations.map((observation) => [observation.id, observation]));
        const primary = byId.get(input.observationId);
        if (!primary || primary.revisionStatus === "superseded") {
          throw new AssessmentError(404, "fact_not_found", "Сведение недоступно в текущей оценке.");
        }
        const memberIds = input.decision.action === "merge" ? [...new Set(input.memberIds.flatMap((id) => {
          const review = current.input.factReviews.get(id);
          return review?.decision.action === "merge" && review.state === "applied" ? review.places.map(({ id }) => id) : [id];
        }))].sort() : input.memberIds;
        if (memberIds.length > 25) invalidInput("Объединение поддерживает до 25 адресных записей.");
        const members = memberIds.map((id) => byId.get(id));
        if (input.decision.action === "merge" && members.some((candidate) => !candidate ||
          (candidate.id !== primary.id && !equivalentFacts(primary, candidate)) ||
          blocksFactEvidence(current.input.factReviews.get(candidate.id)))) {
          invalidInput("Записи должны иметь равное значение, вариант, назначение и одну установленную область.");
        }
        if (input.decision.action === "confirm" && primary.value === null && !primary.quote) invalidInput("Для подтверждения нужна сохранённая запись.");
        if (input.decision.action === "select_variant") {
          const chosenVariant = requirementSubjectKey(input.decision.variant);
          const area = factArea(primary);
          if (!current.input.observations.some((candidate) => candidate.revisionStatus !== "superseded" &&
            requirementSubjectKey(candidate.variant ?? "") === chosenVariant &&
            (candidate.id === primary.id || area !== null && area === factArea(candidate) &&
              requirementSubjectKey(primary.attribute ?? "") === requirementSubjectKey(candidate.attribute ?? "")))) {
            invalidInput("Выберите вариант из сохранённых сведений по этому предмету и области.");
          }
        }
        const { rows: [{ id }] } = await tx.query<{ id: string }>(
          `INSERT INTO facade_fact_reviews(project_id,assessment_version,author_id,reason,decision)
           VALUES($1,$2,$3,$4,$5) RETURNING id`, [projectId, current.version, actor.userId, input.reason, input.decision],
        );
        await tx.query(
          `INSERT INTO facade_fact_review_members(review_id,observation_id,binding_key)
           SELECT $1, "observationId", "bindingKey" FROM jsonb_to_recordset($2::jsonb) m("observationId" uuid,"bindingKey" text)`,
          [id, JSON.stringify(members.map((item) => ({ observationId: item!.id, bindingKey: bindingKey(item!) })))],
        );
        const updated = await synchronizeFacadeAssessment(tx, projectId);
        return { body: { id, version: updated.version }, audit: { objectId: id, version: updated.version,
          details: { observations: memberIds, action: input.decision.action } } };
      });
      return reply.header("ETag", `"${result.body.version}"`).code(result.status).send(result.body);
    },
  );
}
