import type { Pool, PoolClient } from "pg";
export { transaction } from "../access/commands.js";
import { ImportIssue } from "./policy.js";

export type Status = "queued" | "running" | "paused" | "completed" | "limited" | "failed" | "cancelled";
export type Job = {
  id: string;
  project_id: string;
  receipt_id: string;
  actor_id: string;
  source_url: string | null;
  occurrence_id: string | null;
  version_id: string | null;
  root_occurrence_id: string | null;
  depth: number | null;
  relative_path: string | null;
  status: Status;
  reason: string | null;
  attempts: number;
  manifest_saved: boolean;
  updated_at: Date;
};

export type NodeEntry = {
  id: string;
  ordinal: number;
  parent_id: string | null;
  original_path: string;
  relative_path: string | null;
  remote_path: string | null;
  kind: "directory" | "file" | "special";
  expected_bytes: string | null;
  sha256: string | null;
  media_type: string | null;
  state: "discovered" | "directory" | "accepted" | "rejected";
  reason: string | null;
  upload_id: string | null;
  occurrence_id: string | null;
  version_id: string | null;
};

export async function findJob(db: Pool | PoolClient, receiptId: string, id: string): Promise<Job> {
  const { rows: [job] } = await db.query<Job>(
    "SELECT * FROM import_jobs WHERE receipt_id=$1 AND id=$2 AND source_url IS NOT NULL",
    [receiptId, id],
  );
  if (!job) throw new ImportIssue("import_not_found", false, 404);
  return job;
}

export async function tryJobLock(tx: PoolClient, id: string, session: boolean): Promise<boolean> {
  const fn = session ? "pg_try_advisory_lock" : "pg_try_advisory_xact_lock";
  const result = await tx.query<{ acquired: boolean }>(
    `SELECT ${fn}(hashtextextended('facade/import/job/' || $1, 0)) AS acquired`, [id],
  );
  return result.rows[0]?.acquired ?? false;
}

export async function releaseJobLock(tx: PoolClient, id: string): Promise<void> {
  await tx.query("SELECT pg_advisory_unlock(hashtextextended('facade/import/job/' || $1, 0))", [id]);
}

export function jobView(job: Job) {
  return {
    importId: job.id,
    status: job.status,
    reason: job.reason,
    updatedAt: job.updated_at,
    unknownRemainder: job.status !== "completed" && job.status !== "cancelled",
    directUploadAvailable: ["paused", "failed", "limited"].includes(job.status),
  };
}

export async function setStatus(
  tx: PoolClient, job: Job, status: Status, reason: string | null = null, delaySeconds = 0,
): Promise<void> {
  await tx.query(
    `UPDATE import_jobs SET status=$2, reason=$3, updated_at=now(),
      available_at=now()+$4::int*interval '1 second',
      attempts=attempts+($2='running')::int WHERE id=$1`,
    [job.id, status, reason, delaySeconds],
  );
}

export async function addNode(
  tx: Pool | PoolClient, job: Job, ordinal: number, input: {
    path: string;
    relativePath: string | null;
    kind: NodeEntry["kind"];
    parentId?: string | null;
    remotePath?: string | null;
    size?: number;
    sha256?: string | null;
    mediaType?: string | null;
  },
): Promise<NodeEntry> {
  const { rows: [entry] } = await tx.query<NodeEntry>(
    `INSERT INTO import_inventory_entries
       (job_id, receipt_id, ordinal, parent_id, original_path, relative_path, remote_path,
        kind, expected_bytes, sha256, media_type, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $8='directory' THEN 'directory' ELSE 'discovered' END)
     ON CONFLICT (job_id, ordinal) DO UPDATE SET ordinal=EXCLUDED.ordinal
     RETURNING *`,
    [job.id, job.receipt_id, ordinal, input.parentId ?? null, input.path, input.relativePath,
      input.remotePath ?? null, input.kind, input.size ?? null, input.sha256 ?? null, input.mediaType ?? null],
  );
  if (!entry || entry.original_path !== input.path || entry.kind !== input.kind) {
    throw new ImportIssue("source_inventory_changed");
  }
  return entry;
}

export async function rejectNode(db: Pool, entry: NodeEntry, reason: string, observedBytes: number): Promise<void> {
  await db.query(
    `UPDATE import_inventory_entries
     SET state='rejected', reason=$2, observed_bytes=GREATEST(observed_bytes, $3)
     WHERE id=$1 AND state <> 'accepted'`,
    [entry.id, reason, observedBytes],
  );
}
