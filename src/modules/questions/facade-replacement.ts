import type { PoolClient } from "pg";
import { invalid, unavailable } from "../access/errors.js";
import { requirementSubjectKey, type Finding } from "../assessment/domain.js";
import { facadeEvidenceGroups } from "../assessment/facade-rule.js";
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
  const { rows } = await tx.query<{ observation: Observation; originalId: string; supplementIds: string[] }>(
    `SELECT o.payload AS observation,v.original_id AS "originalId",ARRAY(
        SELECT DISTINCT r.id FROM intake_occurrences occ JOIN intake_receipts r
          ON r.project_id=occ.project_id AND r.id=occ.receipt_id
        WHERE occ.project_id=o.project_id AND occ.version_id=o.version_id AND occ.state='accepted'
          AND r.sealed_at IS NOT NULL AND r.id=ANY($3::uuid[]) ORDER BY r.id
      ) AS "supplementIds"
      FROM reader_observations o JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
      WHERE o.project_id=$1 AND o.scope_id IS NULL AND o.id=ANY($2::uuid[])`,
    [projectId, [...selected, ...retired].map(({ observationId }) => observationId), review.supplementReceiptIds],
  );
  const byId = new Map(rows.map((row) => [row.observation.id, row]));
  const signal = AbortSignal.timeout(30_000);
  const replacing = new Set(selected.map(({ versionId }) => versionId));
  if (retired.some(({ versionId }) => replacing.has(versionId))) {
    throw invalid("replacement_same_version", "Укажите новую редакцию основания.");
  }
  async function verify(ref: Reference, proposed: boolean) {
    const stored = byId.get(ref.observationId);
    const finding: Finding | undefined = findings.get(ref.observationId);
    const fact = facts.get(ref.observationId);
    const citation = finding?.citation;
    if (!stored || !citation || !fact || citation.evidenceId !== ref.evidenceId || citation.versionId !== ref.versionId) {
      throw unavailable();
    }
    const { observation, originalId, supplementIds } = stored;
    const groups = facadeEvidenceGroups(requirement, fact, finding);
    if (finding.applicability !== "active" || !finding.sourceRole ||
        (proposed && (!fact.property || !groups.length || !supplementIds.length)) ||
        (!proposed && supplementIds.length)) {
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
    if (proposed && (proof.content.kind !== "text" || (finding.kind === "value" &&
        !hasAddressedSubject({ subject: fact.property!, property: fact.property! }, observation, deliveredLines(proof.content.text))))) {
      throw invalid("replacement_subject_unverified", "Новая опора должна содержать адрес и атрибут вопроса.");
    }
    return { ...ref, address: citation.address, supplementIds, runId: observation.runId, branch: observation.branch, groups,
      valueRole: finding.valueRole, variant: fact.variant ? requirementSubjectKey(fact.variant) : null };
  }
  const replacements: Awaited<ReturnType<typeof verify>>[] = [];
  const replaced: Awaited<ReturnType<typeof verify>>[] = [];
  for (const ref of selected) replacements.push(await verify(ref, true));
  for (const ref of retired) replaced.push(await verify(ref, false));
  if (replaced.some(({ groups, valueRole, variant }) => groups.length && !replacements.some((item) =>
    groups.some((group) => item.groups.includes(group)) && (!valueRole || item.valueRole === valueRole) &&
    (!variant || item.variant === variant)))) {
    throw invalid("replacement_requirement_mismatch", "Новые опоры должны подтверждать заменяемую часть, назначение значения и вариант.");
  }
  const receiptIds = [...new Set(replacements.flatMap(({ supplementIds }) => supplementIds))].sort();
  for (const receiptId of receiptIds) {
    const related = replacements.filter(({ supplementIds }) => supplementIds.includes(receiptId));
    if (!related.some(({ branch, runId }) => branch === "A" &&
      related.some((other) => other.branch === "B" && other.runId !== runId))) {
      throw invalid("independent_support_required", "Для каждой досылки подтвердите адресные опоры обеих ветвей.");
    }
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
  return { id, questionId: question.id, version: question.version, assessmentVersion: context.revision.version,
    assessmentContextId: context.context.id, receiptIds };
}
