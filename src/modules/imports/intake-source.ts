import type { PoolClient } from "pg";
import { lockProjectScopes } from "../access/commands.js";
import { closeEmptyHold } from "../intake/gate.js";
import { cancelImport, declareImport, updateImport } from "../intake/receipts.js";
import type { ReceiptContext } from "../intake/receipts.js";
import { ImportIssue } from "./policy.js";
import { findJob, setStatus, tryJobLock } from "./state.js";

export async function queuePublicImport(tx: PoolClient, input: ReceiptContext & {
  actorId: string; url: string; scopeIds?: string[]; manifestItemId?: string;
}) {
  const declared = await declareImport(tx, input);
  await tx.query(
    "INSERT INTO import_jobs(id, project_id, receipt_id, actor_id, source_url) VALUES ($1,$2,$3,$4,$5)",
    [declared.importId, input.projectId, input.receiptId, input.actorId, input.url],
  );
  return { importId: declared.importId, receiptId: input.receiptId, status: "queued" as const };
}

export async function lockPublicImport(tx: PoolClient, importId: string) {
  if (!await tryJobLock(tx, importId, false)) throw new ImportIssue("import_running", false, 409);
}

export async function excludePublicImport(tx: PoolClient, input: ReceiptContext & { importId: string }) {
  const job = await findJob(tx, input.receiptId, input.importId);
  if (job.status === "completed") throw new ImportIssue("import_already_accepted", false, 409);
  if (["failed", "limited", "cancelled"].includes(job.status)) {
    // The import and any accepted documents stay in the inventory.
    await lockProjectScopes(tx, input.projectId);
    const { rows: [empty] } = await tx.query<{ hold_id: string }>(
      `SELECT i.hold_id FROM intake_imports i WHERE i.id=$1 AND NOT EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.import_id=i.id AND o.state IN ('declared','accepted')
       )`, [input.importId],
    );
    if (empty) await closeEmptyHold(tx, input.projectId, empty.hold_id);
    return;
  }
  if (job.status === "running") await updateImport(tx, { ...input, status: "paused", reason: "worker_interrupted" });
  await cancelImport(tx, input);
  await setStatus(tx, job, "cancelled");
}

export async function retryPublicImport(tx: PoolClient, input: ReceiptContext & { importId: string }) {
  const job = await findJob(tx, input.receiptId, input.importId);
  if (job.status === "queued") return { importId: input.importId, status: job.status };
  if (job.status !== "paused" && (job.status !== "failed" || job.manifest_saved)) {
    throw new ImportIssue("import_retry_unavailable", false, 409);
  }
  await updateImport(tx, { ...input, status: "queued" });
  await setStatus(tx, job, "queued");
  await tx.query("UPDATE import_jobs SET attempts=0 WHERE id=$1", [job.id]);
  return { importId: input.importId, status: "queued" as const };
}
