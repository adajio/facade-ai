import type { PoolClient } from "pg";
import type { ResearchStop as ReaderStop } from "../harness/session.js";
import type { SourceRef } from "../pdf/types.js";
import type { Revision } from "./store.js";

const internalReasons = [
  "repeated_rejected_action", "turn_limit", "input_size_limit", "effect_conflict", "route_bound_unavailable",
  "unknown_charge", "route_receipt_mismatch", "http_429",
] as const;

type ResearchStopReason = typeof internalReasons[number];

const continuation: Record<ResearchStopReason, string> = {
  repeated_rejected_action: "Проверить причину отказа инструмента и продолжить с сохранённого чтения.",
  turn_limit: "Проверить сохранённый ход и условия продолжения задания.",
  input_size_limit: "Проверить размер сохранённого входа и профиль читателя.",
  effect_conflict: "Сверить сохранённый ход со штатным журналом.",
  route_bound_unavailable: "Сверить предел расходов для текущего запроса.",
  unknown_charge: "Сверить исход отправки в журнале перед продолжением.",
  route_receipt_mismatch: "Сверить квитанцию с закреплённым маршрутом.",
  http_429: "Проверить сверку отказа и условия продолжения маршрута.",
};

type Place = { source: SourceRef; unitId: string };

export type ResearchStop = {
  id?: string;
  jobId: string;
  branch: "A" | "B";
  reason: ResearchStopReason;
  place: Place;
  nextAction: string;
  continuationRequested?: boolean;
  evidence?: ReaderStop["evidence"];
  lastRequest?: ReaderStop["lastRequest"];
  lastRejectedTool?: { name: string; code: string; turn: number };
};

export async function currentResearchStops(tx: PoolClient, revision: Revision, inputGeneration: string) {
  const { rows } = await tx.query<{
    questionId: string; jobId: string; branch: "A" | "B"; reason: ResearchStopReason; place: Place;
    tool: string | null; code: string | null; turn: string | null; stop: ReaderStop | null; requested: boolean;
  }>(`SELECT p.question_id AS "questionId", j.id AS "jobId",p.branch,j.reason,p.place,
         coalesce(last.event#>>'{stop,lastRequest,tool}',
           model.event->'message'->'tool_calls'->((last.event->>'index')::int)->'function'->>'name') AS tool,
         coalesce(last.event#>>'{stop,refusalCode}',last.event#>>'{reply,body,code}') AS code,last.event->>'turn' AS turn,
         CASE WHEN stopped.id IS NOT NULL THEN last.event->'stop' END AS stop,
         stopped.resume_requested_at IS NOT NULL AS requested
       FROM harness_generations h JOIN gateway_generations g ON g.generation_id=h.id AND g.current
       JOIN harness_primary_places p ON p.generation_id=g.generation_id
       JOIN gateway_jobs j ON j.generation_id=g.generation_id AND j.obligation_id=p.obligation_id::text
       LEFT JOIN LATERAL (
         SELECT sequence,event FROM harness_research_events
         WHERE job_id=j.id AND event->>'kind'='tool' ORDER BY sequence DESC LIMIT 1
       ) last ON true
       LEFT JOIN harness_research_stops stopped ON stopped.job_id=j.id AND stopped.sequence=last.sequence
         AND j.reason='repeated_rejected_action'
       LEFT JOIN LATERAL (
         SELECT event FROM harness_research_events
         WHERE job_id=j.id AND event->>'kind'='model' AND event->>'turn'=last.event->>'turn'
         ORDER BY sequence DESC LIMIT 1
       ) model ON last.event#>>'{reply,body,code}' IS NOT NULL
       WHERE h.scope_id=$1 AND h.input_generation=$2 AND h.source_token=$3
         AND p.question_id IS NOT NULL AND j.state='held' AND j.reason=ANY($4::text[])
       ORDER BY p.question_id,p.branch,j.id`, [revision.scope_id, inputGeneration, revision.source_token, internalReasons]);
  const byQuestion = new Map<string, ResearchStop[]>();
  for (const { questionId, jobId, branch, reason, place, tool, code, turn, stop, requested } of rows) {
    const stops = byQuestion.get(questionId) ?? [];
    stops.push({
      jobId, branch, reason, place, nextAction: stop?.nextAction ?? continuation[reason],
      ...(stop ? { id: stop.id, continuationRequested: requested, evidence: stop.evidence, lastRequest: stop.lastRequest } : {}),
      ...(tool && code && turn && /^[a-z][a-z0-9_]{0,79}$/.test(tool) && /^[a-z][a-z0-9_]{0,79}$/.test(code)
        ? { lastRejectedTool: { name: tool, code, turn: Number(turn) } } : {}),
    });
    byQuestion.set(questionId, stops);
  }
  return byQuestion;
}
