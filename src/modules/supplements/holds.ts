import type { PoolClient } from 'pg';
import { lockProjectScopes } from '../access/index.js';
import { applyAssessmentUpdate } from '../assessment/index.js';
import { getIntakeGate, lockIntakeProject, resolveIntakeHold } from '../intake/index.js';
import { SupplementError } from './errors.js';

export async function lockScopes(tx: PoolClient, projectId: string, scopeIds?: readonly string[]) {
  await lockIntakeProject(tx, projectId);
  return lockProjectScopes(tx, projectId, scopeIds);
}

export async function assertScopesAvailable(tx: PoolClient, projectId: string, scopeIds: readonly string[]) {
  const scopes = await lockScopes(tx, projectId, scopeIds);
  const gates = [];
  for (const scope of scopes) {
    const gate = await getIntakeGate(tx, projectId, scope.id);
    if (gate.holds.length > 0) {
      throw new SupplementError(409, 'scope_held', 'Ожидается проверка влияния нового поступления.');
    }
    gates.push({ scopeId: scope.id, ...gate });
  }
  return gates;
}

interface HoldRow {
  id: string;
  version: number;
  generation: number;
  scopeIds: string[] | null;
  receiptId: string;
  source: 'upload' | 'import';
  closed: boolean;
}

export async function readLockedHold(tx: PoolClient, projectId: string, holdId: string): Promise<HoldRow> {
  await lockScopes(tx, projectId);
  const { rows: [hold] } = await tx.query<Omit<HoldRow, 'generation'> & { generation: string }>(`
    SELECT h.id, h.version, h.generation, h.scope_ids AS "scopeIds", h.receipt_id AS "receiptId",
           h.source, h.closed_at IS NOT NULL AS closed
    FROM intake_holds h WHERE h.project_id = $1 AND h.id = $2 FOR UPDATE
  `, [projectId, holdId]);
  if (!hold) throw new SupplementError(404, 'not_found', 'Причина удержания недоступна.');
  return { ...hold, generation: Number(hold.generation) };
}

export function assertHoldCurrent(hold: HoldRow, generation: number): void {
  if (hold.closed || hold.generation !== generation) {
    throw new SupplementError(412, 'hold_version_mismatch', 'Версия или поколение причины изменились.');
  }
}

type Changes = Parameters<typeof applyAssessmentUpdate>[1]['changes'];

export async function resolveSupplementImpact(tx: PoolClient, input: {
  projectId: string;
  holdId: string;
  generation: number;
  version: number;
  reason: string;
  impacts: { scopeId: string; changes: Changes; assessmentVersion?: number | null }[];
}) {
  const { projectId, holdId, generation, version, reason, impacts } = input;
  const hold = await readLockedHold(tx, projectId, holdId);
  assertHoldCurrent(hold, generation);
  if (hold.version !== version) {
    throw new SupplementError(412, 'hold_version_mismatch', 'Версия причины изменилась.');
  }
  const scopeIds = hold.scopeIds;
  if (!scopeIds) {
    throw new SupplementError(422, 'hold_scope_unclassified', 'Сначала определите область применимости поступления.');
  }
  const impactedScopes = new Set(impacts.map((impact) => impact.scopeId));
  if (impacts.length !== scopeIds.length || scopeIds.some((id) => !impactedScopes.has(id))) {
    throw new SupplementError(422, 'hold_impact_incomplete', 'Укажите результат проверки влияния для каждой удержанной области.');
  }
  await assertMaterialAccepted(tx, projectId, hold);
  for (const { scopeId, changes, assessmentVersion } of impacts) {
    if (assessmentVersion !== undefined) {
      const { rows: [current] } = await tx.query<{ version: number }>(`
        SELECT version FROM assessment_revisions WHERE scope_id = $1 ORDER BY version DESC LIMIT 1
      `, [scopeId]);
      if ((current?.version ?? null) !== assessmentVersion) {
        throw new SupplementError(412, 'assessment_input_stale', 'Оценка области изменилась после проверки влияния.');
      }
    }
    if (changes.length === 0) continue;
    await applyAssessmentUpdate(tx, { projectId, scopeId, eventId: holdId, reason, changes });
  }
  const result = await resolveIntakeHold(tx, { projectId, holdId, generation, version, scopeIds: null });
  const delta = impacts.map(({ scopeId, changes }) => ({ scopeId, questionIds: changes.map((change) => change.questionId) }));
  await tx.query(`
    INSERT INTO supplement_impacts (hold_id, project_id, reason, changes) VALUES ($1, $2, $3, $4)
  `, [holdId, projectId, reason, JSON.stringify(delta)]);
  return result;
}

async function assertMaterialAccepted(tx: PoolClient, projectId: string, hold: HoldRow): Promise<void> {
  const { rows: [result] } = await tx.query<{ accepted: boolean }>(`
    SELECT CASE WHEN $3 = 'upload' THEN EXISTS (
        SELECT 1 FROM intake_uploads u JOIN intake_occurrences o ON o.id = u.occurrence_id
        WHERE u.project_id = $1 AND u.hold_id = $2 AND u.state = 'complete' AND NOT o.inventory_pending
      ) ELSE EXISTS (
        SELECT 1 FROM intake_imports i
        JOIN intake_occurrences o ON o.import_id = i.id AND o.receipt_id = i.receipt_id
        WHERE i.project_id = $1 AND i.hold_id = $2 AND i.state IN ('completed', 'limited')
          AND o.state = 'accepted' AND NOT EXISTS (
            SELECT 1 FROM intake_occurrences pending
            WHERE pending.import_id = i.id AND (pending.inventory_pending OR pending.state = 'declared')
          )
      ) END AS accepted
  `, [projectId, hold.id, hold.source]);
  if (!result.accepted) {
    throw new SupplementError(409, 'hold_material_pending', 'Материалы по этой причине ещё не приняты или импорт продолжается.');
  }
}
