import type { Pool, PoolClient } from 'pg';
import type { ModelAuthorization } from '../gateway/types.js';
import type { SourceIdentity } from './contracts.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

export const copilotKind = 'copilot_question';
export const maxCopilotInputRefs = 20;
export const copilotOcrOperation = 'copilot/addressed/ocr';

async function pinnedRefs(tx: Pool | PoolClient, context: Pick<ModelAuthorization, 'projectId' | 'scopeId' | 'jobId' | 'inputRefs'>) {
  const { rows: [job] } = await tx.query<{ sources: SourceIdentity[] | null }>(
    `SELECT j.cursor->'found' AS sources FROM gateway_jobs j
     JOIN copilot_questions q ON q.job_id=j.id AND q.project_id=j.project_id AND q.id::text=j.subject_id
     WHERE j.id=$1 AND j.project_id=$2 AND j.scope_id IS NOT DISTINCT FROM $3::uuid
       AND j.kind=$4 AND j.purpose='review' AND j.payload->>'mode'='copilot'`,
    [context.jobId, context.projectId, context.scopeId, copilotKind],
  );
  if (!job) return null;
  const sources = job.sources ?? [];
  if (!Array.isArray(sources) || sources.length > maxCopilotInputRefs || sources.length !== context.inputRefs.length) return null;
  if (!sources.every((source, offset) => source && source.id === context.inputRefs[offset] &&
    uuid.test(source.versionId) && uuid.test(source.documentId) && digest.test(source.sha256) &&
    (source.proof?.kind === 'memory' && digest.test(source.proof.blockId) ||
      source.proof?.kind === 'evidence' && uuid.test(source.proof.evidenceId)))) return null;
  return sources;
}

/** Validate every source exposed to the model, including search metadata from earlier turns. */
export async function verifyCopilotInputs(
  tx: Pool | PoolClient, context: Pick<ModelAuthorization, 'projectId' | 'scopeId' | 'jobId' | 'inputRefs'>,
  approvedHashes: readonly string[] | null = null,
) {
  const sources = await pinnedRefs(tx, context);
  if (!sources) return false;
  const { rows: [result] } = await tx.query<{ authorized: boolean }>(
    `WITH refs AS (
        SELECT r."documentId" AS document_id,r."versionId" AS version_id,r.sha256,r.proof
        FROM jsonb_to_recordset($2::jsonb) r("documentId" uuid,"versionId" uuid,sha256 text,proof jsonb)
      )
      SELECT (
        ($5::text[] IS NULL OR NOT EXISTS (
          SELECT 1 FROM intake_originals WHERE project_id=$1 AND sha256<>ALL($5)
        )) AND (SELECT count(*) FROM refs r
          JOIN intake_document_versions v ON v.project_id=$1 AND v.id=r.version_id AND v.document_id=r.document_id
          JOIN intake_originals o ON o.project_id=$1 AND o.id=v.original_id AND o.sha256=r.sha256
          WHERE ($5::text[] IS NULL OR o.sha256=ANY($5))
            AND EXISTS (SELECT 1 FROM intake_occurrences c WHERE c.project_id=$1 AND c.version_id=v.id AND c.state='accepted')
            AND (
              (r.proof->>'kind'='memory' AND EXISTS (
                SELECT 1 FROM project_memory_blocks b WHERE b.project_id=$1 AND b.version_id=v.id AND b.id=r.proof->>'blockId'
              )) OR (r.proof->>'kind'='evidence' AND EXISTS (
                SELECT 1 FROM reader_evidence e JOIN reader_maps m USING(project_id,version_id,reader_version)
                WHERE e.project_id=$1 AND e.version_id=v.id AND m.original_sha256=o.sha256
                  AND e.id::text=r.proof->>'evidenceId' AND e.run_id=$3
                  AND e.operation_key ~ '^copilot/addressed/ocr(/[0-9a-f]{64})?$'
              ))
            ))=$4
      ) AS authorized`, [context.projectId, JSON.stringify(sources), context.jobId, sources.length, approvedHashes]);
  return result.authorized;
}
