import type { PoolClient } from "pg";
import { invalid, unavailable } from "../access/errors.js";
import { requirementSubjectKey, type Finding } from "../assessment/domain.js";
import { facadeEvidenceGroups, proveFacadeRule } from "../assessment/facade-rule.js";
import { getLockedFacadeContext, synchronizeFacadeAssessment } from "../assessment/facade-store.js";
import type { Observation } from "../pdf/types.js";
import { deliveredLines } from "./attribute-aliases.js";
import { createReaderSupportOpener } from "./reader.js";
import { hasAddressedSubject } from "./subject-evidence.js";

type Reference = { observationId: string; evidenceId: string; versionId: string };
type State = Awaited<ReturnType<typeof getReplacementQuestion>>;
type Opener = ReturnType<typeof createReaderSupportOpener>;

export async function getReplacementQuestion(tx: PoolClient, projectId: string, assessmentContextId: string, id: string) {
  const state = await getLockedFacadeContext(tx, projectId, assessmentContextId);
  const question = state.questions.find((item) => item.active && item.id === id);
  if (!question || !state.revision.catalog_version_id) throw unavailable();
  return { ...state, question, catalogVersionId: state.revision.catalog_version_id };
}

async function editionSupports(tx: PoolClient, projectId: string, observationIds: string[], receiptIds: string[]) {
  const { rows } = await tx.query<{ observation: Observation; originalId: string; supplementIds: string[] }>(
    `SELECT o.payload AS observation,v.original_id AS "originalId",ARRAY(
        SELECT DISTINCT r.id FROM intake_occurrences occ JOIN intake_receipts r
          ON r.project_id=occ.project_id AND r.id=occ.receipt_id
        WHERE occ.project_id=o.project_id AND occ.version_id=o.version_id AND occ.state='accepted'
          AND r.sealed_at IS NOT NULL AND r.id=ANY($3::uuid[]) ORDER BY r.id
      ) AS "supplementIds"
      FROM reader_observations o JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
      WHERE o.project_id=$1 AND o.scope_id IS NULL AND o.id=ANY($2::uuid[])`,
    [projectId, observationIds, receiptIds],
  );
  return new Map(rows.map((row) => [row.observation.id, row]));
}

async function firstBasisReceipts(tx: PoolClient, state: State, projectId: string) {
  const { question, context, catalogVersionId } = state;
  if (question.decision || !question.previous_decision_id || !question.review?.supplementReceiptIds?.length) return [];
  const { rows } = await tx.query<{ id: string }>(
    `SELECT DISTINCT r.id FROM assessment_question_revisions previous
     JOIN assessment_revisions revision ON revision.scope_id=previous.scope_id AND revision.version=previous.assessment_version
     JOIN letters letter ON letter.project_id=$1 AND letter.assessment_context_id=previous.scope_id
     JOIN supplement_receipt_links link ON link.project_id=letter.project_id AND link.letter_id=letter.id
     JOIN letter_sends sent ON sent.letter_id=letter.id AND sent.id=link.sent_id
     JOIN intake_receipts r ON r.project_id=link.project_id AND r.id=link.receipt_id
     CROSS JOIN LATERAL jsonb_array_elements(sent.items) item
     WHERE previous.question_id=$2 AND previous.scope_id=$3 AND previous.version < $4 AND previous.active
       AND previous.decision->>'id'=$5 AND previous.decision->>'action'='request_clarification'
       AND previous.decision->'requestExternal'='true'::jsonb
       AND jsonb_typeof(previous.decision->'clarification')='object'
       AND revision.catalog_version_id=$6::uuid AND previous.decision->>'catalogVersionId'=$6::text
       AND item->>'questionId'=previous.question_id::text AND item->>'decisionId'=$5 AND item->>'kind'='clarification'
       AND (link.item_id IS NULL OR item->>'id'=link.item_id::text)
       AND r.id=ANY($7::uuid[]) AND r.sealed_at IS NOT NULL
       AND r.created_at >= revision.created_at
       AND NOT EXISTS (SELECT 1 FROM facade_source_replacements done
         WHERE done.question_id=previous.question_id AND done.catalog_version_id=revision.catalog_version_id
           AND done.replaced='[]'::jsonb AND done.created_at >= revision.created_at)
     ORDER BY r.id`,
    [projectId, question.id, context.id, question.version, question.previous_decision_id, catalogVersionId, question.review.supplementReceiptIds],
  );
  return rows.map(({ id }) => id);
}

export async function facadeSupplementOptions(tx: PoolClient, state: State, projectId: string) {
  const { question } = state;
  const { review, requirement } = question;
  if (requirement.applicability !== "applicable" || !review?.supplementReceiptIds?.length) return null;
  const first = new Set(await firstBasisReceipts(tx, state, projectId));
  const facts = new Map(state.input.evidence.facts.map((fact) => [fact.finding.citation.observationId, fact]));
  const supports = await editionSupports(tx, projectId, review.findings.map(({ citation }) => citation.observationId), review.supplementReceiptIds);
  const incoming = [];
  const previous = [];
  for (const finding of review.findings) {
    const { citation } = finding;
    const fact = facts.get(citation.observationId);
    const stored = supports.get(citation.observationId);
    if (!fact || !stored || finding.applicability !== "active") continue;
    const qualified = facadeEvidenceGroups(requirement, fact, finding).length > 0;
    if (stored.supplementIds.length && qualified) {
      incoming.push({ citation, firstEligible: stored.supplementIds.every((id) => first.has(id)) });
    } else if (!stored.supplementIds.length && (qualified || finding.kind === "absence")) {
      previous.push(citation);
    }
  }
  return { version: question.version, receiptIds: review.supplementReceiptIds, mayAddFirst: first.size > 0, incoming, previous };
}

export async function replaceFacadeSources(tx: PoolClient, input: {
  id: string;
  state: State;
  projectId: string;
  selected: Reference[];
  retired: Reference[];
  reason: string;
  actorId: string;
  open: Opener;
}) {
  const { id, state, projectId, selected, retired, reason, actorId, open } = input;
  const { review, requirement } = state.question;
  if (requirement.applicability !== "applicable" || !review?.supplementReceiptIds?.length) {
    throw invalid("replacement_not_held", "Для вопроса нужна связанная досылка и установленная применимость.");
  }
  const findings = new Map(review.findings.map((finding) => [finding.citation.observationId, finding]));
  const facts = new Map(state.input.evidence.facts.map((fact) => [fact.finding.citation.observationId, fact]));
  const first = retired.length ? undefined : new Set(await firstBasisReceipts(tx, state, projectId));
  if (first && !first.size) throw invalid("first_support_unavailable", "Первую опору можно добавить по ранее отправленному запросу на уточнение и связанной закрытой досылке.");
  const byId = await editionSupports(tx, projectId, [...selected, ...retired].map(({ observationId }) => observationId), review.supplementReceiptIds);
  const signal = AbortSignal.timeout(30_000);
  const replacing = new Set(selected.map(({ versionId }) => versionId));
  if (retired.some(({ versionId }) => replacing.has(versionId))) {
    throw invalid("replacement_same_version", "Укажите новую редакцию основания.");
  }
  async function verify(ref: Reference, proposed: boolean) {
    const stored = byId.get(ref.observationId);
    const finding: Finding | undefined = findings.get(ref.observationId);
    const fact = facts.get(ref.observationId);
    if (!stored || !finding || !fact || finding.citation.evidenceId !== ref.evidenceId || finding.citation.versionId !== ref.versionId) {
      throw unavailable();
    }
    const { citation } = finding;
    const { observation, originalId, supplementIds } = stored;
    const groups = facadeEvidenceGroups(requirement, fact, finding);
    if (finding.applicability !== "active" || !finding.sourceRole ||
        (proposed && (!fact.property || !groups.length || !supplementIds.length)) ||
        (!proposed && (supplementIds.length || (!groups.length && finding.kind !== "absence")))) {
      throw invalid("support_unverified", "Проверьте действующую редакцию, применимость и формат опоры.");
    }
    const proof = await open({
      ...observation.source, scopeId: null, originalId, observationId: observation.id,
      receiptId: observation.receiptId, evidenceId: observation.evidenceId, address: { ...observation.address },
      quote: observation.quote, components: observation.components,
      measurement: observation.value === undefined || observation.unit === undefined ? undefined :
        { value: observation.value, unit: observation.unit },
    }, signal);
    if (!proof) throw invalid("support_unavailable", "Оригинал или адресное представление недоступны.");
    if (proposed && (proof.content.kind !== "text" || ((first || finding.kind === "value") &&
        !hasAddressedSubject({ subject: fact.property!, property: fact.property! }, observation, deliveredLines(proof.content.text))))) {
      throw invalid("replacement_subject_unverified", "Новая опора должна содержать адрес и атрибут вопроса.");
    }
    return { ...ref, finding, address: citation.address, supplementIds, runId: observation.runId, branch: observation.branch, groups,
      valueRole: finding.valueRole, variant: fact.variant ? requirementSubjectKey(fact.variant) : null };
  }
  const replacements: Awaited<ReturnType<typeof verify>>[] = [];
  const replaced: Awaited<ReturnType<typeof verify>>[] = [];
  for (const ref of selected) replacements.push(await verify(ref, true));
  for (const ref of retired) replaced.push(await verify(ref, false));
  const sameRequirement = (old: typeof replaced[number], item: typeof replacements[number]) => !old.groups.length ||
    (old.groups.some((group) => item.groups.includes(group)) && (!old.valueRole || item.valueRole === old.valueRole) &&
      (!old.variant || item.variant === old.variant));
  if (replaced.length && (replaced.some((old) => !replacements.some((item) => sameRequirement(old, item))) ||
      replacements.some((item) => !replaced.some((old) => sameRequirement(old, item))))) {
    throw invalid("replacement_requirement_mismatch", "Новые опоры должны подтверждать заменяемую часть, назначение значения и вариант.");
  }
  const receiptIds = [...new Set(replacements.flatMap(({ supplementIds }) => supplementIds))].sort();
  for (const receiptId of receiptIds) {
    if (first && !first.has(receiptId)) {
      throw invalid("first_support_unavailable", "Выберите опоры из закрытой досылки к отправленному запросу на уточнение.");
    }
    const related = replacements.filter(({ supplementIds }) => supplementIds.includes(receiptId));
    if (!related.some(({ branch, runId }) => branch === "A" &&
      related.some((other) => other.branch === "B" && other.runId !== runId))) {
      throw invalid("independent_support_required", "Для каждой досылки подтвердите адресные опоры обеих ветвей.");
    }
  }
  if (first && !proveFacadeRule(requirement, facts, replacements.map(({ finding }) => finding)).length) {
    throw invalid("first_support_unproven", "Выбранные адреса обеих ветвей не подтверждают действующее требование каталога.");
  }
  const reference = ({ observationId, evidenceId, versionId, address }: typeof replacements[number]) =>
    ({ observationId, evidenceId, versionId, address });
  await tx.query(
    `INSERT INTO facade_source_replacements (id,question_id,catalog_version_id,author_id,reason,replaced,replacements,receipt_ids)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, state.question.id, state.catalogVersionId, actorId, reason,
      JSON.stringify(replaced.map(reference)), JSON.stringify(replacements.map(reference)), receiptIds],
  );
  const updated = await synchronizeFacadeAssessment(tx, projectId);
  const context = updated.active.find(({ context }) => context.id === state.context.id)!;
  const question = context.questions.find(({ id }) => id === state.question.id);
  if (!question) throw unavailable();
  if (first && !question.review?.supplementReceiptIds?.length && question.machine.outcome !== "covered") {
    throw invalid("first_support_unproven", "Текущий комплект не подтверждает требование после сверки досылки.");
  }
  return { id, questionId: question.id, version: question.version, assessmentVersion: context.revision.version,
    assessmentContextId: context.context.id, receiptIds };
}
