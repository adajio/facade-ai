import type { PoolClient } from "pg";
import { occurrenceScope, occurrenceScopeJoin } from "../harness/occurrence-scope.js";
import type { Observation } from "../pdf/types.js";
import {
  canonicalJson, isInventoryRole, matchesRequirementSubject, type Finding, type InventoryProof, type NonDeliveryStatement, type Requirement,
} from "./domain.js";
import type { Gate, Question, Revision } from "./store.js";

export function matchesStatement(
  statement: NonDeliveryStatement,
  observation: Observation,
  questionId: string,
  requirement: Requirement,
  sourceRole: string,
): boolean {
  if (statement.kind !== "explicit_non_delivery" || statement.questionId !== questionId ||
      statement.receiptId !== observation.receiptId || !isInventoryRole(sourceRole) ||
      observation.grounding !== "text" || observation.limitation || observation.alternatives?.length) return false;
  const subject = statement.subjectQuote;
  const pinned = observation.deliveryStatement;
  return pinned?.status === "not_delivered" && pinned.item === subject &&
    matchesRequirementSubject(requirement, subject) &&
    Boolean(observation.quote) && observation.quote !== subject &&
    Boolean(observation.quote?.includes(subject) || pinned.context?.quote.includes(subject));
}

type Material = { receipt_id: string; version_id: string; assigned: boolean; superseded: boolean; covered: boolean };

function materialKeys(rows: Pick<Material, "receipt_id" | "version_id">[]): string[] {
  return [...new Set(rows.map((row) => canonicalJson([row.receipt_id, row.version_id])))].sort();
}

const materialScope = `FROM intake_occurrences c
  ${occurrenceScopeJoin}
  WHERE c.project_id = $1 AND c.state = 'accepted'
    AND (${occurrenceScope} IS NULL OR $2 = ANY(${occurrenceScope}))`;

export async function activeResearchMaterials(
  tx: PoolClient, projectId: string, scopeId: string, stage: string,
): Promise<string[]> {
  const { rows } = await tx.query<Pick<Material, "receipt_id" | "version_id">>(
    `SELECT c.receipt_id, c.version_id
     ${materialScope}
     AND NOT EXISTS (
       SELECT 1 FROM inquiry_superseded_versions s
       WHERE s.scope_id = $2 AND s.stage = $3 AND s.version_id = c.version_id
     )`,
    [projectId, scopeId, stage],
  );
  return materialKeys(rows);
}

function statementPair(findings: Finding[], material: Material[]): string[] | undefined {
  const applicable = new Set(material.filter((row) => row.assigned && !row.superseded)
    .map((row) => canonicalJson([row.receipt_id, row.version_id])));
  const sources = new Map<string, Partial<Record<"A" | "B", string>>>();
  for (const finding of findings) {
    if (finding.kind !== "absence" || finding.applicability !== "active" || !finding.nonDelivery) continue;
    const { receiptId, versionId, address, quote, observationId, branch, deliveryStatement } = finding.citation;
    if (!applicable.has(canonicalJson([receiptId, versionId]))) continue;
    const statement = canonicalJson([receiptId, versionId, address.unitId, address.locator, quote, deliveryStatement?.context]);
    const pair = sources.get(statement) ?? {};
    pair[branch] ??= observationId;
    if (pair.A && pair.B) return [pair.A, pair.B];
    sources.set(statement, pair);
  }
}

export async function proveResearchNonDelivery(tx: PoolClient, input: {
  projectId: string;
  generationId: string;
  gate: Gate;
  revision: Revision;
  question: Question;
  findings: Finding[];
}): Promise<InventoryProof | undefined> {
  const { projectId, generationId, gate, revision, question, findings } = input;
  if (!findings.some(({ nonDelivery, applicability }) => nonDelivery && applicability === "active")) return;
  const scopeId = revision.scope_id;
  const { rowCount } = await tx.query(
    `SELECT 1
     FROM harness_generations h
     JOIN gateway_generations g ON g.generation_id = h.id AND g.current AND g.sealed
       AND g.project_id = h.project_id AND g.scope_id = h.scope_id
     WHERE h.id = $1 AND h.project_id = $2 AND h.scope_id = $3
       AND h.input_generation = $4 AND h.source_token = $5 AND h.sealed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM harness_primary_places hp
         LEFT JOIN gateway_primary p ON p.generation_id = hp.generation_id AND p.id = hp.obligation_id::text
         WHERE hp.generation_id = h.id AND hp.question_id = $6 AND p.state IS DISTINCT FROM 'completed'
       )`,
    [generationId, projectId, scopeId, gate.generation, revision.source_token, question.id],
  );
  if (!rowCount) return;

  const { rows } = await tx.query<Material>(
    `SELECT c.receipt_id, c.version_id,
       coalesce($2 = ANY(${occurrenceScope}), false) AS assigned,
       EXISTS (
         SELECT 1 FROM inquiry_superseded_versions s
         WHERE s.scope_id = $2 AND s.stage = $5 AND s.version_id = c.version_id
       ) AS superseded,
       2 = (
         SELECT count(DISTINCT hp.branch) FROM harness_primary_places hp
         WHERE hp.generation_id = $3 AND hp.question_id = $4 AND hp.version_id = c.version_id
       ) AS covered
     ${materialScope}`,
    [projectId, scopeId, generationId, question.id, revision.scope.stage],
  );
  if (rows.some((row) => !row.superseded && (!row.assigned || !row.covered))) return;
  const byObservationId = new Map(findings.filter((finding) => finding.nonDelivery)
    .map((finding) => [finding.citation.observationId, finding]));
  const { rows: publications } = await tx.query<{ observation_id: string; statement: NonDeliveryStatement }>(
    `SELECT observation_id, finding->'nonDelivery' AS statement FROM harness_observations
     WHERE generation_id = $1 AND project_id = $2 AND scope_id = $3 AND question_id = $4
       AND observation_id = ANY($5::uuid[]) AND finding->>'kind' = 'absence'`,
    [generationId, projectId, scopeId, question.id, [...byObservationId.keys()]],
  );
  const published = publications.flatMap(({ observation_id, statement }) => {
    const finding = byObservationId.get(observation_id);
    return finding && canonicalJson(finding.nonDelivery) === canonicalJson(statement) ? [finding] : [];
  });
  const observationIds = statementPair(published, rows);
  if (!observationIds) return;
  return {
    assessmentId: generationId,
    kind: "explicit_non_delivery",
    receiptIds: [...new Set(rows.map((row) => row.receipt_id))],
    currentCompositionChecked: true,
    alternativesChecked: true,
    observationIds,
    researchInputGeneration: gate.generation,
    materials: materialKeys(rows.filter((row) => !row.superseded)),
  };
}
