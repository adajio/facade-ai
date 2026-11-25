import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DocumentRevisionReader } from "./document-revision.js";
import { facadeAssessmentHref, getLockedFacadeContext } from "./facade-store.js";
import {
  canonicalJson, effectiveOutcome, evaluate, type ClarificationBasis, type Decision, type Exclusion, type Machine, type Outcome,
} from "./domain.js";
import {
  AssessmentError, announceAssessment, assertAvailable, assessmentHref, getLockedGate, getQuestions, invalidInput,
  letterGroundKind, makeChange, synchronize, writeQuestion, writeRevision, type Gate, type Question, type Revision,
} from "./store.js";

type Decide = {
  action: Decision["action"];
  reason: string;
  requestExternal?: boolean;
  outcome?: Exclude<Outcome, "excluded">;
  observationIds?: string[];
  exclusion?: Exclusion;
  startWorkCritical?: boolean;
};

type DecideContext = {
  projectId: string; scopeId: string; assessmentContextId?: string;
  revision: Revision; gate: Gate; question: Question;
};

function chooseBasis(question: Question, input: Decide): Machine {
  if (input.action !== "correct") return question.machine;
  if (input.outcome === "needs_review") {
    return { ...question.machine, outcome: "needs_review", limitations: ["engineer_requests_review"] };
  }
  const review = question.review;
  if (!review) invalidInput("Для исправления вывода нужны проверенные адресные основания.");
  const ids = new Set(input.observationIds);
  const known = new Set(review.findings.map(({ citation }) => citation.observationId));
  if ([...ids].some((id) => !known.has(id))) invalidInput("Опора отсутствует в текущей проверке.");
  const findings = ids.size ? review.findings.filter(({ citation }) => ids.has(citation.observationId)) :
    review.findings;
  const allGrounds = evaluate(question.requirement, review, true);
  const basis = evaluate(question.requirement, { ...review, findings }, true);
  if (basis.outcome === "confirmed_missing" && allGrounds.outcome !== "confirmed_missing") {
    invalidInput("Действующие опоры не позволяют подтвердить нехватку.");
  }
  if (basis.outcome !== input.outcome) invalidInput("Выбранные опоры не подтверждают исправленный вывод.");
  return basis;
}

export async function recordDecision(
  tx: PoolClient, context: DecideContext, authorId: string, input: Decide,
) {
  const { question, gate, projectId, scopeId, revision } = context;
  if (!revision.catalog_version_id) invalidInput("Нет рабочего каталога.");
  const clarification = input.action === "request_clarification" ? question.review?.clarification : undefined;
  if (input.action === "request_clarification" && (!clarification || !input.requestExternal || !context.assessmentContextId ||
      question.machine.outcome !== "needs_review" || !question.requirement.recipient)) {
    throw new AssessmentError(422, "clarification_unavailable",
      "Для запроса подтвердите проверку закрытых описей, относящихся мест и допустимых аналогов.");
  }
  const confirmingConflict = (input.action === "confirm" || input.action === "correct") &&
    question.machine.outcome === "confirmed_conflict" && question.review !== null;
  const machine = confirmingConflict ? evaluate(question.requirement, question.review) : question.machine;
  const basis = chooseBasis({ ...question, machine }, input);
  if (input.action === "revoke" && (!question.decision || question.decision.action === "revoke")) {
    invalidInput("Нет действующего решения для отмены.");
  }
  const now = new Date();
  if (input.exclusion?.until && Date.parse(input.exclusion.until) <= now.getTime()) {
    invalidInput("Срок исключения должен быть позже текущего времени.");
  }
  const outcome = input.action === "exclude" ? "excluded" : basis.outcome;
  const isExternal = outcome === "confirmed_missing" || outcome === "confirmed_conflict";
  if (input.requestExternal && !clarification && (!isExternal || !question.requirement.recipient ||
      (input.action !== "confirm" && input.action !== "correct"))) {
    invalidInput("Для внешнего запроса требуется подтверждённый недостаток или противоречие и адресат каталога.");
  }
  const decision: Decision = {
    id: randomUUID(),
    authorId,
    action: input.action,
    reason: input.reason,
    outcome,
    requestExternal: input.requestExternal ?? false,
    catalogVersionId: revision.catalog_version_id,
    createdAt: now.toISOString(),
    basis,
    startWorkCritical: input.action === "revoke" ? null :
      input.startWorkCritical ?? question.decision?.startWorkCritical ?? null,
    ...(input.exclusion ? { exclusion: input.exclusion } : {}),
    ...(clarification ? { clarification } : {}),
  };
  const conclusion = canonicalJson(question.machine) === canonicalJson(machine) &&
    effectiveOutcome(question.machine, question.decision, now) === effectiveOutcome(machine, decision, now) &&
    Boolean(question.decision?.startWorkCritical) === Boolean(decision.startWorkCritical) ? revision.conclusion : null;
  const next = await writeRevision(tx, revision, revision.version + 1, gate, makeChange("engineer_decision", [question]), conclusion);
  const version = question.version + 1;
  await writeQuestion(tx, next, {
    ...question,
    version,
    machine,
    decision,
    previous_decision_id: question.decision?.id ?? question.previous_decision_id,
  });
  if (!context.assessmentContextId) await announceAssessment(tx, projectId, next);
  const subject = context.assessmentContextId ? { assessmentContextId: context.assessmentContextId } : { scopeId };
  return { id: decision.id, questionId: question.id, version, ...subject, assessmentVersion: next.version, outcome };
}

export type GroundSelection = { questionId: string; questionVersion: number; decisionId: string };

export type GroundsOptions = {
  projectId: string;
  scopeId?: string;
  assessmentContextId?: string;
  recipient?: string;
  items?: readonly GroundSelection[];
  readDocumentRevision?: DocumentRevisionReader;
};

export type Ground = {
  questionId: string;
  questionVersion: number;
  decisionId: string;
  kind: "confirmed_missing" | "confirmed_conflict" | "clarification";
  scope: Revision["scope"];
  scopeId: string;
  assessmentContextId?: string;
  subject: string;
  part: string;
  recipient: string;
  requestedAction: string;
  requiredFormats: string[];
  citations: Machine["citations"];
  inventory?: Machine["inventory"];
  clarification?: ClarificationBasis;
  catalogVersionId: string;
};

export async function selectConfirmedGrounds(tx: PoolClient, options: GroundsOptions) {
  const { projectId, assessmentContextId, recipient, items, readDocumentRevision } = options;
  const scopeId = assessmentContextId ?? options.scopeId!;
  const facade = assessmentContextId ? await getLockedFacadeContext(tx, projectId, assessmentContextId) : null;
  const gate = facade?.gate ?? await getLockedGate(tx, projectId, scopeId);
  const revision = facade?.revision ?? await synchronize(tx, projectId, scopeId, gate);
  if (items !== undefined || recipient !== undefined) assertAvailable(gate);
  const questions = (facade?.questions ?? await getQuestions(tx, scopeId, revision.version)).filter((question) => question.active);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const href = facade ? facadeAssessmentHref(projectId) : assessmentHref(projectId, scopeId);
  const selected = items?.map((selection) => {
    const question = byId.get(selection.questionId);
    if (question?.review?.supplementReceiptIds?.length) {
      throw new AssessmentError(409, "question_held", "Ожидается проверка досылки по вопросу.",
        { receiptIds: question.review.supplementReceiptIds, href });
    }
    if (!question || question.version !== selection.questionVersion || question.decision?.id !== selection.decisionId) {
      throw new AssessmentError(412, "letter_basis_stale", "Основание письма изменилось.", { href });
    }
    return question;
  }) ?? questions;
  const now = new Date();
  const grounds: Ground[] = [];
  if (!gate.holds.length && !revision.limitations.includes("catalog_rule_duplicate") &&
      !revision.limitations.includes("catalog_rule_invalid")) {
    for (const question of selected) {
      const { decision, requirement } = question;
      const kind = letterGroundKind(question, revision, gate, now);
      if (!kind || !decision || !requirement.recipient || (recipient !== undefined && recipient !== requirement.recipient)) continue;
      const clarification = kind === "clarification" ? decision.clarification : undefined;
      const citations = [];
      for (const citation of decision.basis.citations) {
        const documentRevision = citation.documentRevision ??
          await readDocumentRevision?.(tx, projectId, revision.scope.stage, citation);
        citations.push(documentRevision ? { ...citation, documentRevision } : citation);
      }
      grounds.push({
        questionId: question.id,
        questionVersion: question.version,
        decisionId: decision.id,
        kind,
        scope: revision.scope,
        scopeId,
        ...(assessmentContextId ? { assessmentContextId } : {}),
        subject: requirement.subject,
        part: requirement.part,
        recipient: requirement.recipient,
        requestedAction: kind === "clarification" ? "Направить документ или указать, где приведены данные" :
          kind === "confirmed_conflict" ? `Подтвердить значение для «${requirement.part}»` : requirement.requestedAction,
        requiredFormats: requirement.formats,
        citations,
        catalogVersionId: decision.catalogVersionId,
        ...(decision.basis.inventory ? { inventory: decision.basis.inventory } : {}),
        ...(clarification ? { clarification } : {}),
      });
    }
  }
  return { assessmentVersion: revision.version, scope: revision.scope, holds: gate.holds, items: grounds };
}
