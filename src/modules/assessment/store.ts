import type { PoolClient } from "pg";
import { lockProjectScopes } from "../access/index.js";
import { AccessError } from "../access/errors.js";
import type { CatalogRequirement } from "../access/input.js";
import { publishProjectEvent } from "../supplements/events.js";
import { getIntakeGate, lockIntakeProject } from "../intake/index.js";
import {
  canonicalJson, effectiveOutcome, evaluate, pairProofVersion, pairRevalidationRequired,
  type Citation, type Decision, type Machine, type Requirement, type Review, type Scope,
} from "./domain.js";
import { activeResearchMaterials } from "./non-delivery.js";
import { currentResearchStops } from "./research-stops.js";

export class AssessmentError extends AccessError {
  get details(): Record<string, unknown> { return this.info; }
}

export type Change = {
  reason: string;
  addedQuestionIds: string[];
  affectedQuestionIds: string[];
  removedQuestionIds: string[];
  previousDecisionIds: string[];
};

export type Conclusion = {
  id: string;
  startWork: "can_start" | "cannot_start" | "can_start_with_limitations";
  reason: string;
  authorId: string;
  createdAt: string;
  basedOnVersion: number;
  criticalQuestionIds: string[];
};

export type Revision = {
  scope_id: string;
  version: number;
  catalog_version_id: string | null;
  source_token: string;
  scope: Scope;
  limitations: string[];
  input_generation: string;
  change: Change;
  conclusion: Conclusion | null;
  created_at: Date;
};

export type Question = {
  id: string;
  version: number;
  dependency_version: number;
  active: boolean;
  requirement: Requirement;
  review: Review | null;
  machine: Machine;
  decision: Decision | null;
  previous_decision_id: string | null;
};

export type Gate = {
  generation: string;
  holds: Awaited<ReturnType<typeof getIntakeGate>>["holds"];
};

function key(requirement: Pick<Requirement, "positionId" | "partId">): string {
  return JSON.stringify([requirement.positionId, requirement.partId]);
}

export function invalidInput(message: string): never {
  throw new AssessmentError(422, "invalid_assessment_input", message);
}

export async function getLockedGate(tx: PoolClient, projectId: string, scopeId: string): Promise<Gate> {
  await lockIntakeProject(tx, projectId);
  await lockProjectScopes(tx, projectId, [scopeId]);
  const gate = await getIntakeGate(tx, projectId, scopeId);
  return { generation: String(gate.generation), holds: gate.holds };
}

export function assertAvailable(gate: Gate): void {
  if (gate.holds.length) {
    throw new AssessmentError(409, "scope_held", "Поступление удерживает допуск по области.", {
      holds: gate.holds,
    });
  }
}

export async function getRevision(
  tx: PoolClient, projectId: string, scopeId: string, version?: number,
): Promise<Revision | null> {
  const result = await tx.query<Revision>(
    `SELECT r.*
     FROM assessment_revisions AS r
     JOIN assessment_series AS s USING (scope_id)
     WHERE s.project_id = $1 AND r.scope_id = $2 AND ($3::integer IS NULL OR r.version = $3)
     ORDER BY r.version DESC LIMIT 1`,
    [projectId, scopeId, version ?? null],
  );
  return result.rows[0] ?? null;
}

export async function getQuestions(
  tx: PoolClient, scopeId: string, version: number,
): Promise<Question[]> {
  const result = await tx.query<Question>(
    `SELECT q.id, r.version, r.dependency_version, r.active, r.requirement, r.review,
            r.machine, r.decision, r.previous_decision_id
     FROM assessment_questions AS q
     JOIN LATERAL (
       SELECT * FROM assessment_question_revisions
       WHERE scope_id = q.scope_id AND question_id = q.id AND assessment_version <= $2
       ORDER BY assessment_version DESC LIMIT 1
     ) AS r ON true
     WHERE q.scope_id = $1
     ORDER BY q.position_id, q.part_id`,
    [scopeId, version],
  );
  return result.rows;
}

export function makeChange(reason: string, questions: Question[]): Change {
  return {
    reason,
    addedQuestionIds: [],
    affectedQuestionIds: questions.map(({ id }) => id),
    removedQuestionIds: [],
    previousDecisionIds: questions.flatMap(({ decision }) => decision ? [decision.id] : []),
  };
}

export async function writeRevision(
  tx: PoolClient,
  base: Pick<Revision, "scope_id" | "catalog_version_id" | "source_token" | "scope" | "limitations">,
  version: number,
  gate: Gate,
  change: Change,
  conclusion: Conclusion | null = null,
): Promise<Revision> {
  const result = await tx.query<Revision>(
    `INSERT INTO assessment_revisions
       (scope_id, version, catalog_version_id, source_token, scope, limitations, input_generation, change, conclusion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      base.scope_id, version, base.catalog_version_id, base.source_token, base.scope,
      JSON.stringify(base.limitations), gate.generation, change, conclusion,
    ],
  );
  return result.rows[0]!;
}

export async function writeQuestion(
  tx: PoolClient, revision: Revision, question: Question,
): Promise<void> {
  await tx.query(
    `INSERT INTO assessment_question_revisions
        (scope_id, question_id, version, assessment_version, dependency_version,
         active, requirement, review, machine, decision, previous_decision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      revision.scope_id, question.id, question.version, revision.version, question.dependency_version,
      question.active, question.requirement, question.review, question.machine, question.decision,
      question.previous_decision_id,
    ],
  );
}

export function invalidate(question: Question, review: Review | null): Question {
  return {
    ...question,
    version: question.version + 1,
    dependency_version: question.dependency_version + 1,
    review,
    machine: evaluate(question.requirement, review),
    previous_decision_id: question.decision?.id ?? question.previous_decision_id,
    decision: null,
  };
}

type ScopeSource = {
  id: string;
  name: string;
  stage: string;
  version: number;
  catalog_version_id: string;
  requirements: CatalogRequirement[];
};

function applicability(rule: string, scope: ScopeSource): Requirement["applicability"] | "elsewhere" {
  const normalize = (value: string) => value.toLowerCase().trim();
  const value = normalize(rule);
  if (["all", "applicable", "*", "все", "для всех", "все фасады"].includes(value)) return "applicable";
  if ([scope.name, scope.stage, scope.id].map(normalize).includes(value)) return "applicable";
  const match = /^(scope|stage):(.+)$/.exec(value);
  if (match) {
    const field = match[1] === "stage" ? scope.stage : scope.id;
    return normalize(field) === normalize(match[2]!) ? "applicable" : "elsewhere";
  }
  return "unknown";
}

export function normalizeFormat(format: string): string {
  const normalized = format.trim().toLowerCase().replace(/^\./, "");
  return normalized === "application/pdf" ? "pdf" : normalized;
}

export function catalogRequirement(row: CatalogRequirement, applies: Requirement["applicability"]): Requirement {
  return {
    positionId: row.key,
    partId: row.key,
    subject: row.part,
    ...(row.aliases?.length ? { aliases: row.aliases } : {}),
    ...(row.evidenceRule ? { evidenceRule: row.evidenceRule } : {}),
    part: row.part,
    formats: [...new Set([...row.formats, ...row.equivalents].map(normalizeFormat))].sort(),
    requiredFormats: [...new Set(row.formats.map(normalizeFormat))].sort(),
    equivalentFormats: [...new Set(row.equivalents.map(normalizeFormat))].sort(),
    sourceRoles: [...new Set(row.sourceRoles.map((role) => role.trim().toLowerCase()))].sort(),
    completeness: row.completenessCriterion,
    recipient: row.addressee || null,
    requestedAction: `Предоставить ${row.part}`,
    applicability: applies,
  };
}

function catalogRequirements(source: ScopeSource): { requirements: Requirement[]; limitations: string[] } {
  if (!source.requirements.length) return { requirements: [], limitations: ["catalog_empty"] };
  const requirements: Requirement[] = [];
  for (const row of source.requirements) {
    if (!row?.key || !row.part || !row.applicability || !Array.isArray(row.formats) ||
        !Array.isArray(row.equivalents) || !Array.isArray(row.sourceRoles)) {
      return { requirements: [], limitations: ["catalog_rule_invalid"] };
    }
    const applies = applicability(row.applicability, source);
    if (applies === "elsewhere") continue;
    requirements.push(catalogRequirement(row, applies));
  }
  const duplicates = new Set(requirements.map(key)).size !== requirements.length;
  if (duplicates) return { requirements: [], limitations: ["catalog_rule_duplicate"] };
  return { requirements, limitations: requirements.length ? [] : ["no_applicable_requirements"] };
}

function citationVersions(citation: Citation): string[] {
  return [citation.versionId, ...citation.components?.map(({ source }) => source.versionId) ?? []];
}

function activeVersions(question: Question): string[] {
  return question.review?.findings
    .filter((finding) => finding.applicability === "active")
    .flatMap(({ citation }) => citationVersions(citation)) ?? [];
}

function reviewAfterSourceChange(question: Question, superseded: ReadonlySet<string>, reason: string): Review | null {
  if (!question.review) return null;
  return {
    findings: question.review.findings.filter(({ citation }) => !citationVersions(citation).some((id) => superseded.has(id))),
    completenessChecked: false,
    remaining: [reason],
  };
}

export async function synchronize(
  tx: PoolClient, projectId: string, scopeId: string, gate: Gate,
): Promise<Revision> {
  const sourceResult = await tx.query<ScopeSource>(
    `SELECT s.id, s.name, s.stage, s.version, p.catalog_version_id,
            coalesce(local.requirements, c.requirements) AS requirements
     FROM project_scopes AS s
     JOIN projects AS p ON p.id = s.project_id
     JOIN catalog_versions AS c ON c.id = p.catalog_version_id
     LEFT JOIN scope_requirements AS local
       ON local.scope_id = s.id AND local.version = s.version
       AND local.catalog_version_id = p.catalog_version_id
     WHERE p.id = $1 AND s.id = $2`,
    [projectId, scopeId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new AssessmentError(404, "scope_not_found", "Область не найдена.");
  const scope = { id: source.id, name: source.name, stage: source.stage };
  const sourceToken = canonicalJson([source.catalog_version_id, source.version, scope]);
  const current = await getRevision(tx, projectId, scopeId);
  const questions = current ? await getQuestions(tx, scopeId, current.version) : [];
  const now = Date.now();
  const expired = questions.filter((question) => {
    const until = question.decision?.exclusion?.until;
    return question.active && until && Date.parse(until) <= now;
  });
  const versions = [...new Set(questions.flatMap((q) => q.active ? activeVersions(q) : []))];
  const result = versions.length ? await tx.query<{ version_id: string }>(
    `SELECT version_id FROM inquiry_superseded_versions WHERE scope_id = $1 AND version_id = ANY($2::uuid[])`,
    [scopeId, versions],
  ) : null;
  const superseded = new Set(result?.rows.map(({ version_id }) => version_id));
  const sourceSuperseded = (question: Question) => activeVersions(question).some((id) => superseded.has(id));
  const researchProofs = questions.filter(({ active, machine }) =>
    active && machine.inventory?.materials && machine.inventory.researchInputGeneration !== gate.generation);
  const materials = researchProofs.length
    ? canonicalJson(await activeResearchMaterials(tx, projectId, scopeId, scope.stage))
    : undefined;
  const changedInventories = new Set(researchProofs.filter(({ machine }) =>
    canonicalJson(machine.inventory?.materials) !== materials).map(({ id }) => id));
  const legacyPair = (question: Question) =>
    question.review?.confirmedPairs?.some(({ proofVersion }) => proofVersion !== pairProofVersion);
  const affected = (question: Question) => sourceSuperseded(question) || changedInventories.has(question.id) || legacyPair(question);
  const currentReview = (question: Question): Review | null => {
    if (sourceSuperseded(question) || changedInventories.has(question.id)) {
      return reviewAfterSourceChange(question, superseded, sourceSuperseded(question) ? "source_superseded" : "research_inventory_changed");
    }
    const { review } = question;
    if (!review || !legacyPair(question)) return review;
    return {
      ...review, completenessChecked: false, remaining: [...new Set([...review.remaining, pairRevalidationRequired])],
      confirmedPairs: review.confirmedPairs!.filter(({ proofVersion }) => proofVersion === pairProofVersion),
    };
  };
  const expiredIds = new Set(expired.map(({ id }) => id));

  if (current?.source_token === sourceToken) {
    const changed = questions.filter((question) => question.active && (expiredIds.has(question.id) || affected(question)));
    if (!changed.length) return current;
    const reason = changed.some(sourceSuperseded) ? "source_superseded" :
      changedInventories.size ? "research_inventory_changed" :
        changed.some(legacyPair) ? pairRevalidationRequired : "exclusion_expired";
    const revision = await writeRevision(tx, current, current.version + 1, gate, makeChange(reason, changed));
    for (const question of changed) {
      await writeQuestion(tx, revision, invalidate(question, currentReview(question)));
    }
    await announceAssessment(tx, projectId, revision);
    return revision;
  }

  const { requirements, limitations } = catalogRequirements(source);
  const replacements: Question[] = [];
  const old = new Map(questions.map((question) => [key(question.requirement), question]));
  const change = makeChange(!current ? "catalog_initialized" :
    current.catalog_version_id !== source.catalog_version_id ? "catalog_changed" : "scope_requirements_changed", []);

  await tx.query(
    `INSERT INTO assessment_series (project_id, scope_id) VALUES ($1,$2)
     ON CONFLICT (scope_id) DO NOTHING`,
    [projectId, scopeId],
  );
  const previousScopeVersion = current ? (JSON.parse(current.source_token) as [string, number])[1] : source.version;
  const skippedScopeVersions = source.version - previousScopeVersion > 1;
  for (const requirement of requirements) {
    const identifier = key(requirement);
    const prior = old.get(identifier);
    old.delete(identifier);
    if (!prior) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO assessment_questions (scope_id, position_id, part_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [scopeId, requirement.positionId, requirement.partId],
      );
      const id = rows[0]!.id;
      change.addedQuestionIds.push(id);
      replacements.push({
        id, active: true, version: 1, dependency_version: 1, requirement,
        review: null, machine: evaluate(requirement, null), decision: null, previous_decision_id: null,
      });
      continue;
    }
    const unchanged = canonicalJson(prior.requirement) === canonicalJson(requirement);
    const priorAffected = affected(prior);
    if (prior.active && unchanged && !priorAffected && !expiredIds.has(prior.id) && !skippedScopeVersions) continue;
    change.affectedQuestionIds.push(prior.id);
    if (prior.decision) change.previousDecisionIds.push(prior.decision.id);
    const review = prior.active && unchanged && !skippedScopeVersions ? currentReview(prior) : null;
    replacements.push(invalidate({ ...prior, active: true, requirement }, review));
  }
  for (const prior of old.values()) {
    if (!prior.active) continue;
    change.removedQuestionIds.push(prior.id);
    if (prior.decision) change.previousDecisionIds.push(prior.decision.id);
    replacements.push(invalidate({ ...prior, active: false }, null));
  }

  const revision = await writeRevision(tx, {
    scope_id: scopeId, catalog_version_id: source.catalog_version_id, source_token: sourceToken, scope, limitations,
  }, (current?.version ?? 0) + 1, gate, change);
  for (const question of replacements) await writeQuestion(tx, revision, question);
  await announceAssessment(tx, projectId, revision);
  return revision;
}

export async function announceAssessment(tx: PoolClient, projectId: string, revision: Revision) {
  await publishProjectEvent(tx, projectId, {
    type: "assessment.changed",
    payload: { scopeId: revision.scope_id, assessmentVersion: revision.version },
  });
}

export function assessmentHref(projectId: string, scopeId: string): string {
  return `/api/v1/projects/${projectId}/assessments/current?scopeId=${scopeId}`;
}

export async function snapshot(tx: PoolClient, revision: Revision, gate?: Gate, includeResearchStops = false) {
  const historical = gate === undefined;
  const when = historical ? revision.created_at : new Date();
  const stops = gate && includeResearchStops && await currentResearchStops(tx, revision, gate.generation);
  const questions = (await getQuestions(tx, revision.scope_id, revision.version)).filter((item) => item.active)
    .map((question) => ({
      id: question.id,
      version: question.version,
      dependencyVersion: question.dependency_version,
      requirement: question.requirement,
      machine: question.machine,
      ...(stops && stops.has(question.id) ? { researchStops: stops.get(question.id)! } : {}),
      decision: question.decision,
      previousDecisionId: question.previous_decision_id,
      outcome: effectiveOutcome(question.machine, question.decision, when),
    }));
  const outcomes = new Set(questions.map((question) => question.outcome));
  const ready = outcomes.has("covered") || outcomes.has("excluded");
  const problem = outcomes.has("confirmed_missing") || outcomes.has("confirmed_conflict");
  const unresolved = outcomes.has("needs_review") || revision.limitations.length > 0 || Boolean(gate?.holds.length) ||
    questions.some(({ machine }) => machine.outcome === "confirmed_conflict" && machine.limitations.length > 0);
  const outcome = Number(ready) + Number(problem) + Number(unresolved) > 1 ? "mixed" :
    unresolved ? "needs_review" : problem ? "confirmed_problems" : "sufficient";
  return {
    scope: revision.scope,
    catalogVersionId: revision.catalog_version_id,
    version: revision.version,
    inputGeneration: gate?.generation ?? revision.input_generation,
    holds: gate?.holds ?? [],
    historical,
    outcome,
    limitations: revision.limitations,
    questions,
    conclusion: revision.conclusion,
    change: revision.change,
    createdAt: revision.created_at.toISOString(),
  };
}
