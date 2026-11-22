import type { PoolClient } from "pg";
import type { Observation } from "../pdf/types.js";
import { canonicalJson, type Finding, type Review } from "./domain.js";
import { matchesStatement, proveResearchNonDelivery } from "./non-delivery.js";
import { hasSameReviewDependencies, isPendingReview } from "./review-dependencies.js";
import {
  AssessmentError, announceAssessment, assessmentHref, getLockedGate, getQuestions, invalidate,
  invalidInput, makeChange, normalizeFormat, synchronize, writeQuestion, writeRevision,
  type Gate, type Question, type Revision,
} from "./store.js";
import { identifier, shortText } from "./inputs.js";

type FindingInput = Pick<Finding, "kind" | "sourceRole" | "applicability" | "comparisonKey" | "nonDelivery"> & {
  observationId: string;
} | Finding;

export type ReviewInput = Omit<Review, "findings" | "inventory"> & {
  inputGeneration?: string;
  researchGenerationId?: string;
  inventory?: Omit<NonNullable<Review["inventory"]>, "observationIds" | "researchInputGeneration" | "materials">;
  findings: FindingInput[];
};

export type AssessmentChange = {
  questionId: string;
  expectedDependencyVersion?: number;
  review?: ReviewInput | null;
};

export type AssessmentUpdate = {
  projectId: string;
  scopeId: string;
  eventId: string;
  reason: string;
  changes: readonly AssessmentChange[];
};

type ObservationRow = {
  observation: Observation;
  format: string;
  label: string;
  superseded: boolean;
};

async function validateInventory(
  tx: PoolClient, projectId: string, scopeId: string, inventory: NonNullable<Review["inventory"]>,
): Promise<NonNullable<Review["inventory"]>> {
  const ids = [...new Set(inventory.receiptIds.map(identifier))].sort();
  const { rows: [result] } = await tx.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM unnest($3::uuid[]) AS selected(id)
       LEFT JOIN intake_receipts AS r ON r.id = selected.id AND r.project_id = $1
       WHERE r.sealed_at IS NULL
         OR EXISTS (SELECT 1 FROM intake_occurrences AS o WHERE o.receipt_id = selected.id
                    AND (o.state = 'declared' OR o.inventory_pending OR o.restriction IS NOT NULL))
         OR EXISTS (SELECT 1 FROM intake_imports AS i WHERE i.receipt_id = selected.id
                    AND i.state NOT IN ('complete', 'cancelled'))
     ) AND NOT EXISTS (
       SELECT 1 FROM intake_holds AS h
       WHERE h.project_id = $1 AND (h.scope_ids IS NULL OR $2 = ANY(h.scope_ids))
       AND h.receipt_id <> ALL($3::uuid[])
       AND (
         EXISTS (SELECT 1 FROM intake_uploads AS u WHERE u.hold_id = h.id AND u.state = 'complete')
         OR EXISTS (SELECT 1 FROM intake_occurrences AS o
                    WHERE o.import_id = h.source_id AND h.source = 'import' AND o.state = 'accepted')
       )
     ) AS complete`,
    [projectId, scopeId, ids],
  );
  return {
    assessmentId: identifier(inventory.assessmentId),
    kind: inventory.kind,
    receiptIds: ids,
    currentCompositionChecked: inventory.currentCompositionChecked && Boolean(result?.complete),
    alternativesChecked: inventory.alternativesChecked,
    ...(inventory.observationIds ? {
      observationIds: inventory.observationIds,
      researchInputGeneration: inventory.researchInputGeneration,
      materials: inventory.materials,
    } : {}),
  };
}

async function resolveReview(
  tx: PoolClient, projectId: string, gate: Gate, revision: Revision, question: Question, review: ReviewInput,
): Promise<Review> {
  const scopeId = revision.scope_id;
  // Inquiry jobs also validate the current research generation under this scope lock.
  // Their adapter may use the in-process review shape when the intake gate is free.
  if (review.inputGeneration === undefined ? gate.holds.length > 0 : review.inputGeneration !== gate.generation) {
    throw new AssessmentError(412, "assessment_input_stale", "Поколение входов изменилось.", {
      href: assessmentHref(projectId, scopeId), inputGeneration: gate.generation,
    });
  }
  const ids = review.findings.map((item) =>
    identifier("observationId" in item ? item.observationId : item.citation.observationId));
  if (ids.length > 500 || new Set(ids).size !== ids.length) invalidInput("Наблюдения в проверке должны быть уникальными.");
  const lookup = await tx.query<ObservationRow>(
    `SELECT o.payload AS observation, m.format, a.relative_path AS label,
            EXISTS (SELECT 1 FROM inquiry_superseded_versions AS superseded
                    WHERE superseded.scope_id = $2 AND (superseded.version_id = o.version_id OR EXISTS (
                      SELECT 1 FROM jsonb_array_elements(coalesce(o.payload->'components','[]'::jsonb)) AS c(part)
                      WHERE c.part#>>'{source,versionId}' = superseded.version_id::text))) AS superseded
     FROM reader_observations AS o
     JOIN reader_evidence AS e ON e.id = o.evidence_id AND e.project_id = o.project_id
     JOIN reader_maps AS m ON m.version_id = e.version_id AND m.reader_version = e.reader_version
     JOIN LATERAL (
       SELECT relative_path FROM intake_occurrences
       WHERE project_id = o.project_id AND version_id = o.version_id AND receipt_id = m.receipt_id
         AND state = 'accepted'
       ORDER BY created_at, id LIMIT 1
     ) AS a ON true
     WHERE o.project_id = $1 AND o.scope_id = $2 AND o.id = ANY($3::uuid[])
       AND o.payload#>>'{source,sha256}' = m.original_sha256`,
    [projectId, scopeId, ids],
  );
  const rows = new Map(lookup.rows.map((row) => [row.observation.id, row]));
  const findings = review.findings.map((input, index): Finding => {
    const row = rows.get(ids[index]!);
    if (!row) invalidInput("Наблюдение недоступно в текущей области.");
    const o = row.observation;
    const quote = o.quote ?? "";
    const sourceRole = shortText(input.sourceRole, 200).toLowerCase();
    const statement = input.kind === "absence" && input.nonDelivery ? input.nonDelivery : undefined;
    const unresolvedStatement = input.kind === "absence" && (statement
      ? !matchesStatement(statement, o, question.id, question.requirement, sourceRole)
      : o.deliveryStatement !== undefined);
    if (!statement && input.kind !== "delivery" && (!quote || o.grounding === "limited")) {
      invalidInput("Для вывода требуется адресуемая цитата.");
    }
    if (input.kind === "value" && (!o.value || !literalValuePresent(quote, o.value))) {
      invalidInput("Исходное значение должно присутствовать в цитате.");
    }
    return {
      kind: input.kind,
      sourceRole,
      applicability: row.superseded ? "superseded" : unresolvedStatement ? "unknown" : input.applicability,
      ...(statement ? { nonDelivery: statement } : {}),
      comparisonKey: shortText(input.comparisonKey, 500),
      format: normalizeFormat(row.format),
      citation: {
        observationId: o.id, evidenceId: o.evidenceId, receiptId: o.receiptId,
        documentId: o.source.documentId, versionId: o.source.versionId,
        sha256: o.source.sha256, branch: o.branch, address: { ...o.address },
        label: row.label, quote, value: o.value ?? null, unit: o.unit ?? null,
        ...(o.deliveryStatement ? { deliveryStatement: o.deliveryStatement } : {}),
        ...(o.components?.length ? { components: o.components } : {}),
        href: `/api/v1/evidence/${o.evidenceId}`,
      },
    };
  });
  const researchProof = review.researchGenerationId === undefined ? undefined : await proveResearchNonDelivery(tx, {
    projectId, generationId: identifier(review.researchGenerationId), gate, revision, question, findings,
  });
  const legacyProof = review.researchGenerationId === undefined && review.inventory ?
    { ...review.inventory, observationIds: undefined, researchInputGeneration: undefined, materials: undefined } : undefined;
  const proof = researchProof ?? legacyProof;
  const inventory = proof && await validateInventory(tx, projectId, scopeId, proof);
  return {
    findings,
    remaining: review.remaining.map((limitation) => shortText(limitation, 500)),
    completenessChecked: review.completenessChecked === true,
    ...(inventory ? { inventory } : {}),
  };
}

function literalValuePresent(quote: string, value: string): boolean {
  const literal = value.trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(literal)) return quote.includes(literal);
  const escaped = literal.replace(/[+.]/g, "\\$&");
  const pattern = `(?<![\\d.,+-])${escaped}(?![\\d]|[.,]\\d)`;
  return new RegExp(pattern, "u").test(quote);
}

function assertCurrent(change: AssessmentChange, question: Question, revision: Revision, projectId: string) {
  if (change.review?.inputGeneration !== undefined && change.expectedDependencyVersion === undefined) {
    invalidInput("Для результата сверки требуется версия зависимостей вопроса.");
  }
  if (change.expectedDependencyVersion !== undefined &&
      change.expectedDependencyVersion !== question.dependency_version) {
    throw new AssessmentError(412, "assessment_input_stale", "Зависимости вопроса изменились.", {
      questionId: question.id, dependencyVersion: question.dependency_version,
      href: assessmentHref(projectId, revision.scope_id),
    });
  }
}

export async function applyAssessmentUpdate(tx: PoolClient, update: AssessmentUpdate) {
  const { projectId, scopeId, changes } = update;
  const eventId = identifier(update.eventId);
  const reason = shortText(update.reason, 2000);
  const gate = await getLockedGate(tx, projectId, scopeId);
  const input = JSON.parse(JSON.stringify({ reason, changes })) as unknown;
  const replay = await tx.query<{ input: unknown; assessment_version: number }>(
    "SELECT input, assessment_version FROM assessment_updates WHERE scope_id = $1 AND event_id = $2",
    [scopeId, eventId],
  );
  const previous = replay.rows[0];
  if (previous) {
    if (canonicalJson(previous.input) !== canonicalJson(input)) {
      throw new AssessmentError(409, "assessment_event_reused", "ID события уже связан с другим обновлением.");
    }
    return { assessmentVersion: previous.assessment_version, replayed: true };
  }
  if (!changes.length) invalidInput("Укажите затронутые вопросы.");
  const ids = changes.map(({ questionId }) => identifier(questionId));
  if (new Set(ids).size !== ids.length) invalidInput("Вопрос повторяется в обновлении.");
  const current = await synchronize(tx, projectId, scopeId, gate);
  const questions = new Map((await getQuestions(tx, scopeId, current.version))
    .filter((question) => question.active).map((question) => [question.id, question]));
  const prior: Question[] = [];
  const revisions: Question[] = [];
  for (const [index, change] of changes.entries()) {
    const question = questions.get(ids[index]!);
    if (!question) throw new AssessmentError(404, "question_not_found", "Вопрос недоступен в заданной области.");
    assertCurrent(change, question, current, projectId);
    const review = change.review ? await resolveReview(tx, projectId, gate, current, question, change.review) : null;
    if (review && (canonicalJson(question.review) === canonicalJson(review) ||
        (question.decision && ((gate.holds.length > 0 && isPendingReview(review)) ||
          hasSameReviewDependencies(question, review))))) continue;
    prior.push(question);
    revisions.push(invalidate(question, review));
  }
  const next = revisions.length
    ? await writeRevision(tx, current, current.version + 1, gate, makeChange(reason, prior))
    : current;
  for (const revision of revisions) await writeQuestion(tx, next, revision);
  await tx.query(
    `INSERT INTO assessment_updates (scope_id, event_id, input, assessment_version) VALUES ($1,$2,$3,$4)`,
    [scopeId, eventId, input, next.version],
  );
  if (revisions.length) await announceAssessment(tx, projectId, next);
  return { assessmentVersion: next.version, replayed: false };
}
