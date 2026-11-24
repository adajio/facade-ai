import type { PoolClient } from "pg";
import { archiveFormat } from "./policy.js";

type ArchiveSource = {
  projectId: string;
  receiptId: string;
  occurrenceId: string;
  versionId: string;
  relativePath: string;
  mediaType?: string | null;
  importId?: string | null;
  parentOccurrenceId?: string | null;
};

export async function queueArchive(tx: PoolClient, source: ArchiveSource): Promise<boolean> {
  if (!archiveFormat(source.relativePath, source.mediaType)) return false;
  await tx.query(
    `INSERT INTO import_jobs
       (id, project_id, receipt_id, occurrence_id, version_id, root_occurrence_id, depth, relative_path, actor_id)
     SELECT occurrence.id, occurrence.project_id, occurrence.receipt_id, occurrence.id, $4,
       COALESCE(parent.root_occurrence_id, occurrence.id), COALESCE(parent.depth + 1, 1), $5,
       COALESCE(parent.actor_id, linked.actor_id, receipt.created_by)
     FROM intake_occurrences occurrence
     JOIN intake_receipts receipt ON receipt.id=occurrence.receipt_id
     LEFT JOIN import_jobs parent ON parent.occurrence_id=occurrence.parent_occurrence_id
     LEFT JOIN import_jobs linked ON linked.id=occurrence.import_id AND linked.source_url IS NOT NULL
     WHERE occurrence.id=$1 AND occurrence.project_id=$2 AND occurrence.receipt_id=$3
     ON CONFLICT (occurrence_id) DO NOTHING`,
    [source.occurrenceId, source.projectId, source.receiptId, source.versionId, source.relativePath],
  );
  return true;
}
