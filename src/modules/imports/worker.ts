import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import type { WorkerContext } from "../../platform/worker-context.js";
import { createIntakeStorage } from "../intake/blob.js";
import type { IntakeStorage } from "../intake/blob.js";
import { completeOccurrenceInventory, updateImport } from "../intake/receipts.js";
import { classify, processArchive, processRemote } from "./processing.js";
import { resetScratch } from "./scratch.js";
import { releaseJobLock, setStatus, transaction, tryJobLock } from "./state.js";
import type { Job, Status } from "./state.js";
import { YandexDisk } from "./yandex.js";
import type { PublicDisk } from "./yandex.js";

const modeLockSql = "hashtextextended($1,0)";
const pollMs = 1000;

function logFailure(context: WorkerContext, message: string, error: unknown) {
  const info = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const code = typeof info?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(info.code) ? info.code : undefined;
  const name = typeof info?.name === "string" && /^[A-Za-z0-9_]{2,40}$/.test(info.name) ? info.name : undefined;
  const rawStatus = info?.$metadata?.httpStatusCode;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
  const tag = [name, code, status].filter(Boolean).join(" ");
  context.logger.warn(tag ? `${message} (${tag})` : message);
}

async function transition(
  context: WorkerContext, job: Job, status: Exclude<Status, "cancelled">, reason?: string, delay?: number,
) {
  await transaction(context.db, async tx => {
    const coordinates = { receiptId: job.receipt_id, projectId: job.project_id };
    if (job.source_url) {
      await updateImport(tx, { ...coordinates, importId: job.id, status, reason });
    } else if (job.occurrence_id && (status === "completed" || status === "limited" || status === "failed")) {
      await completeOccurrenceInventory(tx, { ...coordinates, occurrenceId: job.occurrence_id, restriction: reason });
    }
    await setStatus(tx, job, status, reason, delay);
  });
}

async function pick(tx: PoolClient, source: boolean): Promise<Job | undefined> {
  const { rows } = await tx.query<Job>(
    `SELECT * FROM import_jobs WHERE (source_url IS NOT NULL)=$1
      AND status IN ('queued','running','paused') AND available_at<=now()
      ORDER BY status='running' DESC, available_at, created_at, id LIMIT 1`,
    [source],
  );
  return rows[0];
}

async function workOne(
  context: WorkerContext, storage: IntakeStorage, transport: PublicDisk, mode: "source" | "archive",
  scratch: { initialized: boolean },
): Promise<boolean> {
  const lockKey = mode === "source" ? "facade/import/source" : "facade/heavy-local-slot";
  const session = await context.db.connect();
  const controller = new AbortController();
  const onConnectionError = () => controller.abort();
  session.on("error", onConnectionError);
  const signal = AbortSignal.any([controller.signal, context.signal]);
  let locked = false;
  let job: Job | undefined;
  let jobLocked = false;
  try {
    const result = await session.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${modeLockSql}) AS acquired`, [lockKey],
    );
    locked = result.rows[0]?.acquired ?? false;
    if (!locked) return false;

    job = await pick(session, mode === "source");
    if (!job) {
      if (!scratch.initialized) {
        await resetScratch(context.db, context.config.dataDir, mode);
        scratch.initialized = true;
      }
      return false;
    }
    jobLocked = await tryJobLock(session, job.id, true);
    if (!jobLocked) return false;
    const { rows: [current] } = await session.query<Job>(
      "SELECT * FROM import_jobs WHERE id=$1 AND status IN ('queued','running','paused')", [job.id],
    );
    if (!current) return false;
    job = current;
    signal.throwIfAborted();
    const workspace = await resetScratch(context.db, context.config.dataDir, mode);
    scratch.initialized = true;
    await transition(context, job, "running");
    job.attempts++;
    try {
      const result = mode === "source"
        ? await processRemote(context.db, storage, workspace, job, transport,
          AbortSignal.any([signal, AbortSignal.timeout(3 * 3600_000)]))
        : await processArchive(context.db, storage, workspace, job, signal);
      signal.throwIfAborted();
      await transition(context, job, result.status, result.reason);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const issue = classify(error);
      const code = issue?.code ?? (error instanceof DOMException && error.name === "TimeoutError"
        ? "remote_attempt_timeout" : "import_worker_retry");
      await transition(context, job, "paused", code, Math.min(300, 5 * 2 ** Math.min(job.attempts - 1, 6)));
      if (!issue) logFailure(context, "Import worker paused after an operational failure", error);
    }
    return true;
  } finally {
    let disconnect = controller.signal.aborted;
    try {
      if (job && jobLocked) await releaseJobLock(session, job.id);
      if (locked) await session.query(`SELECT pg_advisory_unlock(${modeLockSql})`, [lockKey]);
    } catch {
      disconnect = true;
    } finally {
      session.off("error", onConnectionError);
      session.release(disconnect);
    }
  }
}

export async function startImports(
  context: WorkerContext,
  options: { storage?: IntakeStorage; transport?: PublicDisk } = {},
): Promise<void> {
  const storage = options.storage ?? createIntakeStorage(context.config.dataDir);
  const transport = options.transport ?? new YandexDisk();
  async function loop(mode: "source" | "archive") {
    const scratch = { initialized: false };
    while (!context.signal.aborted) {
      try {
        if (await workOne(context, storage, transport, mode, scratch)) continue;
      } catch (error) {
        if (context.signal.aborted) return;
        logFailure(context, "Import worker will retry its queue", error);
      }
      await sleep(pollMs, undefined, { signal: context.signal }).catch(() => undefined);
    }
  }
  try {
    await Promise.all([loop("source"), loop("archive")]);
  } finally {
    if (!options.storage) storage.objects.close();
  }
}
