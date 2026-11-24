import { rm } from "node:fs/promises";
import { addAbortSignal, Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { IntakeStorage } from "../intake/blob.js";
import { IntakeError } from "../intake/errors.js";
import { retireUpload } from "../intake/uploads.js";
import { openOriginal } from "../intake/content.js";
import { extractArchive } from "./archive.js";
import type { ArchiveFrame } from "./archive.js";
import { ImportIssue, importLimits, safeRelativePath } from "./policy.js";
import { reserveBrokerInput, stageBytes } from "./scratch.js";
import { addNode, rejectNode, transaction } from "./state.js";
import type { Job, NodeEntry, Status } from "./state.js";
import { acceptRemote, acceptStaged, recoverPublished } from "./transfer.js";
import type { PublicDisk, RemoteEntry } from "./yandex.js";

type CompletedStatus = Extract<Status, "completed" | "limited" | "failed">;
type ProcessingResult = { status: CompletedStatus; reason?: string };

export function classify(error: unknown): ImportIssue | undefined {
  if (error instanceof ImportIssue) return error;
  if (!(error instanceof IntakeError)) return undefined;
  return new ImportIssue(error.code, error.statusCode === 424 || error.statusCode === 429 ||
    error.code === "upload_busy", error.statusCode);
}

function retry(issue: ImportIssue, job: Job): boolean {
  return issue.retryable && (!issue.code.startsWith("remote_") || job.attempts < 5);
}

async function retireRejected(db: Pool, job: Job, entry: NodeEntry, reason: string, bytes: number) {
  const { rows: [upload] } = await db.query<{ state: string }>(
    "SELECT state FROM intake_uploads WHERE id=$1 AND project_id=$2", [entry.id, job.project_id],
  );
  if (upload?.state === "uploading") {
    await transaction(db, tx => retireUpload(tx, { projectId: job.project_id, uploadId: entry.id }, "cancelled"));
  }
  await rejectNode(db, entry, reason, bytes);
}

async function saveManifest(db: Pool, job: Job, entries: RemoteEntry[]): Promise<void> {
  await transaction(db, async tx => {
    const ids: string[] = [];
    for (const [ordinal, entry] of entries.entries()) {
      const parentId = entry.parent === null ? null : ids[entry.parent];
      const node = await addNode(tx, job, ordinal, {
        path: entry.path, relativePath: entry.path, kind: entry.kind, parentId,
        remotePath: entry.remotePath, size: entry.size, sha256: entry.sha256, mediaType: entry.mediaType,
      });
      if (entry.restriction) {
        await tx.query(
          "UPDATE import_inventory_entries SET state='rejected', reason=$2 WHERE id=$1",
          [node.id, entry.restriction],
        );
      }
      ids.push(node.id);
    }
    await tx.query("UPDATE import_jobs SET manifest_saved=true WHERE id=$1", [job.id]);
  });
}

function terminalIssue(issue: ImportIssue, hadFiles: boolean): ProcessingResult {
  if (hadFiles || /_limit$|_empty$/.test(issue.code)) {
    return { status: "limited", reason: issue.code };
  }
  return { status: "failed", reason: issue.code };
}

export async function processRemote(
  db: Pool, storage: IntakeStorage, workspace: string, job: Job,
  transport: PublicDisk, signal: AbortSignal,
): Promise<ProcessingResult> {
  const url = job.source_url;
  if (!url) throw new Error("Remote import has no source");
  if (!job.manifest_saved) {
    try {
      const entries = await transport.manifest(url, signal);
      await saveManifest(db, job, entries);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const issue = classify(error);
      if (!issue || retry(issue, job)) throw error;
      return terminalIssue(issue, false);
    }
  }
  const { rows } = await db.query<NodeEntry>(
    "SELECT * FROM import_inventory_entries WHERE job_id=$1 AND kind='file' ORDER BY ordinal", [job.id],
  );
  const { rows: [unavailableFolder] } = await db.query<{ reason: string }>(
    `SELECT reason FROM import_inventory_entries WHERE job_id=$1 AND kind='directory'
      AND state='rejected' ORDER BY ordinal LIMIT 1`, [job.id],
  );
  let accepted = 0;
  let reason = unavailableFolder?.reason;
  let pause: ImportIssue | undefined;
  for (const entry of rows) {
    signal.throwIfAborted();
    if (entry.state === "accepted") {
      accepted++;
      continue;
    }
    if (entry.state === "rejected") {
      reason ??= entry.reason ?? "remote_entry_rejected";
      continue;
    }
    try {
      if (!await recoverPublished(db, storage, job, entry)) {
        await acceptRemote(db, storage, workspace, job, entry, transport, signal);
      }
      accepted++;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const issue = classify(error);
      if (!issue) throw error;
      if (retry(issue, job)) {
        pause ??= issue;
        continue;
      }
      await retireRejected(db, job, entry, issue.code, 0);
      reason ??= issue.code;
    }
  }
  if (pause) throw pause;
  if (reason) return terminalIssue(new ImportIssue(reason), accepted > 0);
  if (!rows.length) return { status: "limited", reason: "remote_folder_empty" };
  return { status: "completed" };
}

function archivePath(path: string, kind: NodeEntry["kind"]): string | null {
  try {
    return safeRelativePath(kind === "directory" ? path.replace(/[\\\/]$/, "") : path);
  } catch (error) {
    if (error instanceof ImportIssue && error.code === "invalid_source_path") return null;
    throw error;
  }
}

function verifiedArchiveInput(original: { stream: Readable; size: number; sha256: string }, signal: AbortSignal) {
  const stream = addAbortSignal(signal, original.stream);
  return Readable.from((async function* () {
    const hash = createHash("sha256");
    let size = 0;
    let last: Buffer | undefined;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) continue;
      size += bytes.length;
      if (size > original.size) throw new ImportIssue("archive_source_unconfirmed", true);
      hash.update(bytes);
      if (last) yield last;
      last = bytes;
    }
    if (size !== original.size || hash.digest("hex") !== original.sha256) {
      throw new ImportIssue("archive_source_unconfirmed", true);
    }
    // The broker starts decoding only after receiving the declared body length.
    if (last) yield last;
  })(), { objectMode: false });
}

export async function processArchive(
  db: Pool, storage: IntakeStorage, workspace: string, job: Job, signal: AbortSignal,
): Promise<ProcessingResult> {
  if (!job.depth || !job.version_id) throw new Error("Archive has no source version");
  if (job.depth > importLimits.archiveDepth) return { status: "limited", reason: "archive_depth_limit" };

  const { rows: [{ bytes, entries }] } = await db.query<{ bytes: string; entries: string }>(
    `SELECT COALESCE(SUM(expanded_bytes),0) AS bytes,
      (SELECT COUNT(*) FROM import_inventory_entries e JOIN import_jobs j ON j.id=e.job_id
        WHERE j.root_occurrence_id=$1 AND j.id<>$2) AS entries
      FROM import_jobs WHERE root_occurrence_id=$1 AND id<>$2`,
    [job.root_occurrence_id, job.id],
  );
  const maxBytes = Math.max(0, importLimits.expandedBytes - Number(bytes));
  const maxEntries = Math.max(0, importLimits.archiveEntries - Number(entries));
  const original = await openOriginal(db, storage, job.project_id, job.version_id);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await reserveBrokerInput(db, storage, job.id, original.size);
    const input = verifiedArchiveInput(original, signal);
    const frames = extractArchive({ stream: input, size: original.size }, signal, {
      bytes: maxBytes, entries: maxEntries,
    });
    const directories = new Map<string, string>();
    let ordinal = 0;
    let total = 0;
    let accepted = 0;
    let knownRestriction: string | undefined;
    let pause: ImportIssue | undefined;
    try {
      for await (const frame of frames) {
        signal.throwIfAborted();
        if (frame.type === "done") {
          if (pause) throw pause;
          if (frame.result !== "ok") return { status: "limited", reason: frame.result };
          if (knownRestriction) return { status: "limited", reason: knownRestriction };
          return accepted ? { status: "completed" } : { status: "limited", reason: "archive_empty" };
        }
        if (frame.type !== "entry" || ordinal >= maxEntries) {
          throw new ImportIssue("archive_protocol_error");
        }
        const path = archivePath(frame.path, frame.kind);
        const parentPath = path?.substring(0, path.lastIndexOf("/"));
        const node = await addNode(db, job, ordinal++, {
          path: frame.path, relativePath: path, kind: frame.kind,
          parentId: parentPath ? directories.get(parentPath) : null,
        });
        if (frame.kind === "directory" && path) directories.set(path, node.id);

        let end: string | undefined;
        let size = 0;
        async function* entryBytes() {
          while (true) {
            signal.throwIfAborted();
            const next = await frames.next();
            if (next.done) throw new ImportIssue("archive_incomplete");
            const part: ArchiveFrame = next.value;
            if (part.type === "end") {
              end = part.result;
              return;
            }
            if (part.type !== "data") throw new ImportIssue("archive_protocol_error");
            size += part.bytes.length;
            total += part.bytes.length;
            if (total > maxBytes) throw new ImportIssue("archive_expanded_limit");
            yield part.bytes;
          }
        }

        let extracted: Awaited<ReturnType<typeof stageBytes>> | undefined;
        try {
          const recovered = node.state === "discovered" && await recoverPublished(db, storage, job, node);
          if (path && frame.kind === "file" && node.state === "discovered" && !recovered) {
            extracted = await stageBytes(db, storage, workspace, job.id, "entry", entryBytes(), maxBytes - total, signal);
          } else {
            for await (const bytes of entryBytes()) void bytes;
          }
          await db.query(
            "UPDATE import_jobs SET expanded_bytes=GREATEST(expanded_bytes,$2) WHERE id=$1",
            [job.id, total],
          );
          const restriction = !path ? "invalid_source_path" : end !== "ok" ? end : undefined;
          if (restriction) {
            await retireRejected(db, job, node, restriction, size);
            knownRestriction ??= restriction;
          } else if (node.state === "rejected") {
            knownRestriction ??= node.reason ?? "archive_entry_rejected";
          } else if (extracted) {
            try {
              await acceptStaged(db, storage, job, node, extracted, signal);
              accepted++;
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              const issue = classify(error);
              if (!issue) throw error;
              if (retry(issue, job)) {
                pause ??= issue;
              } else {
                await retireRejected(db, job, node, issue.code, size);
                knownRestriction ??= issue.code;
              }
            }
          } else if (node.state === "accepted" || recovered) {
            accepted++;
          }
        } finally {
          if (extracted) await rm(extracted.path, { force: true });
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const issue = classify(error);
      if (!issue || retry(issue, job)) throw error;
      return { status: "limited", reason: issue.code };
    }
    return { status: "limited", reason: "archive_incomplete" };
  } finally {
    original.stream.destroy();
    await release?.();
  }
}
