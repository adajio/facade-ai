import type { PoolClient } from 'pg';
import { getIntakeGate } from '../intake/index.js';
import { readProjectionPosition } from './events.js';
import { getQuestions, getRevision } from '../assessment/store.js';
import { effectiveOutcome } from '../assessment/domain.js';

export async function readProjectSnapshot(tx: PoolClient, projectId: string, scopeId?: string, restricted = false, manages = false) {
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
  const navCounts = restricted ? undefined : await readNavCounts(tx, projectId, scopeId, holds.length > 0, manages);
  const result = { ...projection, projectId, scopes: states, holds, ...(navCounts ? { navCounts } : {}) };
  if (scopeId) return result;
  const { rows: [facade] } = await tx.query<{ version: number }>(
    'SELECT version FROM facade_assessment_snapshots WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [projectId],
  );
  return { ...result, facadeAssessmentVersion: facade?.version ?? null };
}

async function readNavCounts(tx: PoolClient, projectId: string, scopeId: string | undefined, held: boolean, manages: boolean) {
  const { rows: [counts] } = await tx.query<{ activeUploads: number; members: number | null }>(`
    SELECT (
      SELECT count(*)::int FROM intake_uploads WHERE project_id=$1
        AND state='uploading' AND expires_at>statement_timestamp()
      ) + (
      SELECT count(*)::int FROM intake_imports WHERE project_id=$1 AND state IN ('failed','limited')
      ) AS "activeUploads",
      CASE WHEN $2 THEN (SELECT count(*)::int FROM project_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=$1 AND u.state='active' AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()))
      END AS members`, [projectId, manages]);
  const { rows: contexts } = scopeId ? { rows: [{ id: scopeId, contextHeld: held }] } :
    await tx.query<{ id: string; contextHeld: boolean }>(`
    SELECT (context->>'assessmentContextId')::uuid AS id,
           jsonb_array_length(coalesce(context->'holds','[]'::jsonb))>0 AS "contextHeld"
    FROM (SELECT payload FROM facade_assessment_snapshots WHERE project_id=$1 ORDER BY version DESC LIMIT 1) recent
    CROSS JOIN LATERAL jsonb_array_elements(recent.payload->'contexts') context`, [projectId]);
  let needsReview = 0;
  let readyForLetter = 0;
  const when = new Date();
  for (const { id, contextHeld } of contexts) {
    const revision = await getRevision(tx, projectId, id);
    if (!revision) continue;
    const questions = await getQuestions(tx, id, revision.version);
    for (const row of questions) {
      if (!row.active) continue;
      const outcome = effectiveOutcome(row.machine, row.decision, when);
      const clarification = row.decision?.action === 'request_clarification' && row.review?.clarification;
      const problem = outcome === 'confirmed_missing' || outcome === 'confirmed_conflict' || clarification;
      if (outcome === 'needs_review' && !clarification || problem && !row.decision) needsReview++;
      if (problem && !contextHeld && !row.review?.supplementReceiptIds?.length && row.decision?.requestExternal &&
          row.requirement.recipient && !revision.limitations.some((item) => ['catalog_rule_duplicate', 'catalog_rule_invalid'].includes(item))) {
        readyForLetter++;
      }
    }
  }
  return { activeUploads: counts.activeUploads, needsReview, readyForLetter, ...(counts.members === null ? {} : { members: counts.members }) };
}
