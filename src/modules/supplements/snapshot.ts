import type { PoolClient } from 'pg';
import { getIntakeGate } from '../intake/index.js';
import { readProjectionPosition } from './events.js';

export async function readProjectSnapshot(tx: PoolClient, projectId: string, scopeId?: string, restricted = false) {
  const projection = await readProjectionPosition(tx, projectId);
  const { rows: scopes } = await tx.query<{
    id: string;
    version: number;
    assessmentVersion: number | null;
    catalogVersionId: string;
  }>(`
    SELECT s.id, s.version, p.catalog_version_id AS "catalogVersionId", a.version AS "assessmentVersion"
    FROM project_scopes s
    JOIN projects p ON p.id = s.project_id
    LEFT JOIN LATERAL (
      SELECT version FROM assessment_revisions WHERE scope_id = s.id ORDER BY version DESC LIMIT 1
    ) a ON true
    WHERE s.project_id = $1 AND ($2::uuid IS NULL OR s.id = $2) ORDER BY s.id
  `, [projectId, scopeId ?? null]);
  const states = [];
  for (const scope of scopes) {
    const gate = await getIntakeGate(tx, projectId, scope.id);
    states.push({
      ...scope,
      inputGeneration: gate.generation,
      holds: gate.holds.map((cause) => {
        const reason = cause.scopeIds === null ? 'Ожидается классификация поступления' : 'Ожидается проверка влияния поступления';
        return restricted ? {
          id: cause.id, generation: cause.generation, version: cause.version,
          scopeIds: cause.scopeIds === null ? null : [scope.id], reason,
        } : { ...cause, reason };
      }),
    });
  }
  const holds = [...new Map(states.flatMap((scope) => scope.holds).map((cause) => [cause.id, cause])).values()];
  const result = { ...projection, projectId, scopes: states, holds };
  if (scopeId) return result;
  const { rows: [facade] } = await tx.query<{ version: number }>(
    'SELECT version FROM facade_assessment_snapshots WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [projectId],
  );
  return { ...result, facadeAssessmentVersion: facade?.version ?? null };
}
