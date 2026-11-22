import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { freeBytes } from "../intake/blob.js";
import type { IntakeStorage } from "../intake/blob.js";
import { intakeUnwrittenBytes, lockDiskReservations } from "../intake/uploads.js";
import { ImportIssue } from "./policy.js";
import { transaction } from "./state.js";
import { importScratchUnwrittenBytes } from "./reserve.js";

const chunkReservation = 8 * 1024 ** 2;

export async function resetScratch(db: Pool, workspace: string, mode: "source" | "archive"): Promise<string> {
  const root = join(workspace, "import-scratch", mode);
  // The caller owns the corresponding session lock for the entire cleanup and job.
  await rm(root, { recursive: true, force: true });
  await db.query(
    `DELETE FROM import_scratch_reservations r USING import_jobs j
     WHERE r.job_id=j.id AND (j.source_url IS NOT NULL)=$1`, [mode === "source"],
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function reserveScratch(
  db: Pool, storage: IntakeStorage, jobId: string, slot: "entry" | "source", pending: number,
): Promise<void> {
  await transaction(db, async tx => {
    await lockDiskReservations(tx);
    await tx.query("DELETE FROM import_scratch_reservations WHERE job_id=$1 AND slot=$2", [jobId, slot]);
    const free = await freeBytes(storage);
    const outstandingScratch = await importScratchUnwrittenBytes(tx);
    const outstandingIntake = await intakeUnwrittenBytes(tx);
    if (free < BigInt(storage.diskGuardBytes) + outstandingScratch + outstandingIntake + BigInt(pending)) {
      throw new ImportIssue("import_disk_reserve", true);
    }
    await tx.query(
      "INSERT INTO import_scratch_reservations(job_id,slot,pending_bytes) VALUES ($1,$2,$3)",
      [jobId, slot, pending],
    );
  });
}

async function releaseScratch(db: Pool, jobId: string, slot: "entry" | "source"): Promise<void> {
  await db.query("DELETE FROM import_scratch_reservations WHERE job_id=$1 AND slot=$2", [jobId, slot]);
}

export async function reserveBrokerInput(
  db: Pool, storage: IntakeStorage, jobId: string, size: number,
): Promise<() => Promise<void>> {
  await reserveScratch(db, storage, jobId, "source", size);
  return () => releaseScratch(db, jobId, "source");
}

export async function stageBytes(
  db: Pool, storage: IntakeStorage, workspace: string, jobId: string, slot: "entry" | "source",
  stream: AsyncIterable<Buffer>, limit: number, signal: AbortSignal,
): Promise<{ path: string; size: number; sha256: string }> {
  const path = join(workspace, slot);
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let capacity = 0;

  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (size + chunk.length > limit) throw new ImportIssue("source_length_mismatch");
      if (size + chunk.length > capacity) {
        const pending = Math.min(limit - size, Math.max(chunk.length, chunkReservation));
        await reserveScratch(db, storage, jobId, slot, pending);
        capacity = size + pending;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new ImportIssue("import_disk_io", true);
        offset += bytesWritten;
      }
      hash.update(chunk);
      size += chunk.length;
    }
    return { path, size, sha256: hash.digest("hex") };
  } catch (error) {
    await rm(path, { force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new ImportIssue("import_disk_reserve", true);
    throw error;
  } finally {
    await file.close();
    await releaseScratch(db, jobId, slot);
  }
}
