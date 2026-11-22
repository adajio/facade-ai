import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../access/commands.js";
import { WorkQueue } from "../gateway/queue.js";
import { jobSchema } from "../harness/contracts.js";
import { loadResearchProfile } from "../harness/profile.js";
import { researchKind } from "../harness/runner.js";
import { publishProjectEvent } from "../supplements/events.js";
import { lockScopes } from "../supplements/holds.js";
import { makePair } from "./domain.js";
import type { InquirySearchContext, ObservationPublication } from "./domain.js";
import { enqueue } from "./store.js";
import type { InquiryRow, SearchResult } from "./store.js";

function citation(source: ObservationPublication, branch: "A" | "B") {
  return {
    branch, observationId: source.observationId, evidenceId: source.evidenceId,
    quote: source.quote, value: source.measurement?.value, unit: source.measurement?.unit,
    place: {
      source: {
        projectId: source.projectId, documentId: source.documentId, versionId: source.versionId, sha256: source.sha256,
      },
      unitId: source.address.unitId, ...(source.address.box ? { box: source.address.box } : {}),
    },
  };
}

export async function scheduleSemanticReview(db: Pool, tx: PoolClient, inquiry: InquiryRow, result: SearchResult) {
  if (!inquiry.assessment_question_id || !inquiry.anchor_id) return;
  const questionId = inquiry.assessment_question_id;
  const eligible = result.candidates.filter(({ source, applicability }) =>
    source.assessmentQuestionId === questionId && source.quote && source.measurement &&
    (applicability === "verified" || applicability === "meaning_unclear"));
  const branchB = eligible.filter(({ source }) => source.branch === "B");
  const branchA = eligible.filter(({ source }) => source.branch === "A");
  const pair = branchA.flatMap((left) => branchB.flatMap((right) => {
    if (left.applicability !== "meaning_unclear" && right.applicability !== "meaning_unclear") return [];
    return makePair({ ...left, applicability: "verified" }, { ...right, applicability: "verified" }) ?? [];
  }))[0];
  if (!pair) return;
  const { left: a, right: b } = pair;

  const { A, B, lead } = loadResearchProfile();
  if (!A || !B || !lead) return;
  const { rows: [generation] } = await tx.query<{ id: string }>(
    `SELECT h.id FROM harness_generations h JOIN gateway_generations g ON g.generation_id=h.id AND g.current
     WHERE h.project_id=$1 AND h.scope_id=$2
       AND (SELECT count(*) FROM harness_observations o
            WHERE o.generation_id=h.id AND o.question_id=$3 AND o.observation_id=ANY($4::uuid[]))=2
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS wanted(route_id text, data_class text)
         WHERE NOT EXISTS (
           SELECT 1 FROM gateway_grants grant_row JOIN gateway_routes r
             ON r.id=grant_row.route_id AND r.revision=grant_row.revision AND r.enabled
           WHERE grant_row.project_id=$1 AND grant_row.route_id=wanted.route_id
             AND grant_row.data_class=wanted.data_class AND grant_row.purpose='review' AND grant_row.allowed
         )
       )`,
    [inquiry.project_id, inquiry.scope_id, questionId, [a.observationId, b.observationId],
      JSON.stringify([lead, A, B].map((route) => ({ route_id: route.routeId, data_class: route.dataClass })))],
  );
  if (!generation) return;
  const { rows: [prior] } = await tx.query<{ id: string }>(
    `SELECT id FROM harness_disputes
     WHERE generation_id=$1 AND question_id=$2 AND a_observation_id=$3 AND b_observation_id=$4`,
    [generation.id, questionId, a.observationId, b.observationId],
  );
  const disputeId = prior?.id ?? randomUUID();
  const payload = jobSchema.safeParse({
    mode: "lead", settings: lead,
    dispute: {
      id: disputeId,
      question: {
        id: questionId, subject: inquiry.subject.subject, property: inquiry.subject.property,
        ...(inquiry.subject.variant ? { variant: inquiry.subject.variant } : {}),
      },
      a: citation(a, "A"), b: citation(b, "B"),
    },
  });
  if (!payload.success) return;
  if (!prior) {
    await tx.query(
      `INSERT INTO harness_disputes(generation_id,question_id,id,a_observation_id,b_observation_id)
       VALUES($1,$2,$3,$4,$5)`,
      [generation.id, questionId, disputeId, a.observationId, b.observationId],
    );
    await new WorkQueue(db).enqueue({
      projectId: inquiry.project_id, scopeId: inquiry.scope_id, generationId: generation.id,
      key: `lead:${disputeId}`, kind: researchKind, purpose: "review", subjectId: questionId, payload: payload.data,
    }, tx);
  }
  await tx.query(
    `INSERT INTO inquiry_semantic_checks(inquiry_id,generation_id,dispute_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [inquiry.id, generation.id, disputeId],
  );
}

export async function hasVerifiedMeaning(db: Pool, context: InquirySearchContext, source: ObservationPublication): Promise<boolean> {
  if (!source.assessmentQuestionId) return false;
  const result = await db.query(
    `SELECT 1
     FROM inquiries i JOIN harness_disputes d ON d.question_id=i.assessment_question_id
     JOIN gateway_generations g ON g.generation_id=d.generation_id AND g.current
     JOIN harness_review_results a ON a.generation_id=d.generation_id AND a.dispute_id=d.id AND a.stage='A'
     JOIN harness_review_results b ON b.generation_id=d.generation_id AND b.dispute_id=d.id AND b.stage='B'
     JOIN inquiry_observations candidate ON candidate.id=$4 AND candidate.scope_id=i.scope_id AND NOT candidate.superseded
     WHERE i.id=$1 AND i.search_version=$2 AND i.assessment_question_id=$3
       AND g.project_id=i.project_id AND g.scope_id=i.scope_id
       AND EXISTS (
         SELECT 1 FROM inquiry_observations reviewed
         WHERE reviewed.id IN (d.a_observation_id,d.b_observation_id) AND NOT reviewed.superseded
           AND reviewed.version_id=candidate.version_id
           AND reviewed.source->'address'=candidate.source->'address'
           AND reviewed.source->'quote'=candidate.source->'quote'
           AND reviewed.source->'measurement'=candidate.source->'measurement'
           AND reviewed.source->'role'=candidate.source->'role'
           AND reviewed.source->'comparableContext'=candidate.source->'comparableContext'
       )
       AND NOT EXISTS (SELECT 1 FROM inquiry_observations old
          WHERE old.id IN (d.a_observation_id,d.b_observation_id) AND old.superseded)
       AND a.result->>'verdict'='supported' AND b.result->>'verdict'='supported' LIMIT 1`,
    [context.inquiryId, context.searchVersion, source.assessmentQuestionId, source.observationId],
  );
  return Boolean(result.rowCount);
}

export async function refreshCompletedSemanticReview(db: Pool): Promise<boolean> {
  const { rows: [next] } = await db.query<{
    id: string; scope_id: string; project_id: string; generation_id: string; dispute_id: string;
  }>(
    `SELECT i.id,i.scope_id,i.project_id,t.generation_id,t.dispute_id
     FROM inquiry_semantic_checks t JOIN inquiries i ON i.id=t.inquiry_id
     JOIN gateway_generations g ON g.generation_id=t.generation_id
     WHERE t.settled_at IS NULL AND (
       NOT g.current OR EXISTS (
         SELECT 1 FROM harness_review_results lead WHERE lead.generation_id=t.generation_id
           AND lead.dispute_id=t.dispute_id AND lead.stage='lead' AND lead.result->>'kind'<>'proposal'
       ) OR
       (SELECT count(*) FROM harness_review_results r WHERE r.generation_id=t.generation_id
        AND r.dispute_id=t.dispute_id AND r.stage IN ('A','B'))=2
     )
     ORDER BY i.id LIMIT 1`,
  );
  if (!next) return false;
  return transaction(db, async (tx) => {
    await lockScopes(tx, next.project_id, [next.scope_id]);
    const { rowCount } = await tx.query(
      `UPDATE inquiry_semantic_checks SET settled_at=now()
       WHERE inquiry_id=$1 AND generation_id=$2 AND dispute_id=$3 AND settled_at IS NULL`,
      [next.id, next.generation_id, next.dispute_id],
    );
    if (!rowCount) return false;
    const { rows: [revised] } = await tx.query<{ search_version: number }>(
      `UPDATE inquiries i SET search_version=search_version+1, version=version+1
       WHERE i.id=$1 AND EXISTS (
         SELECT 1 FROM gateway_generations g JOIN harness_review_results r ON r.generation_id=g.generation_id
         WHERE g.generation_id=$2 AND g.current AND r.dispute_id=$3 AND r.stage IN ('A','B')
           AND r.result->>'verdict'='supported'
         GROUP BY g.generation_id HAVING count(*)=2
       ) AND NOT EXISTS (SELECT 1 FROM inquiry_jobs j WHERE j.inquiry_id=i.id) RETURNING search_version`,
      [next.id, next.generation_id, next.dispute_id],
    );
    if (revised) {
      await enqueue(tx, next.id, revised.search_version);
      await publishProjectEvent(tx, next.project_id, {
        type: "inquiries.changed", payload: { scopeId: next.scope_id, inquiryIds: [next.id] },
      });
    }
    return true;
  });
}
