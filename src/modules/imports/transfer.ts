import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import type { IntakeStorage } from "../intake/blob.js";
import { declareOriginal, finalizeOriginal, getUpload, writePart } from "../intake/uploads.js";
import { ImportIssue } from "./policy.js";
import { stageBytes } from "./scratch.js";
import { transaction } from "./state.js";
import type { Job, NodeEntry } from "./state.js";
import type { PublicDisk, RemoteEntry } from "./yandex.js";

type Identity = { size: number; sha256: string; mediaType?: string };

function mediaType(value: string | null): string | undefined {
  return value && value.length <= 127 && /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/i.test(value)
    ? value.toLowerCase() : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publish(
  db: Pool, storage: IntakeStorage, job: Job, entry: NodeEntry, identity: Identity,
  open: () => Promise<Readable>, signal: AbortSignal,
): Promise<void> {
  const relativePath = entry.relative_path;
  if (!relativePath) throw new ImportIssue("invalid_source_path");
  const uploadId = entry.id;
  const projectId = job.project_id;
  const upload = await transaction(db, async tx => {
    const result = await declareOriginal(tx, storage, {
      projectId, receiptId: job.receipt_id, uploadId, relativePath,
      size: identity.size, sha256: identity.sha256, mediaType: identity.mediaType,
      importId: job.source_url ? job.id : undefined,
      parentOccurrenceId: job.occurrence_id ?? undefined,
    });
    await tx.query(
      "UPDATE import_inventory_entries SET upload_id=$2, occurrence_id=$3 WHERE id=$1",
      [entry.id, uploadId, result.occurrenceId],
    );
    return result;
  });

  if (upload.status !== "complete" && (identity.size === 0 || upload.confirmedBytes !== identity.size)) {
    signal.throwIfAborted();
    const input = await open();
    try {
      const partSize = upload.partSize;
      const confirmed = new Map(upload.parts.map(part => [part.number, part]));
      let number = 1;
      let offset = 0;
      let seen = 0;
      let remaining = identity.size;
      let part = Buffer.allocUnsafe(Math.min(partSize, remaining));
      for await (const chunk of input) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        seen += bytes.length;
        if (seen > identity.size) throw new ImportIssue("source_length_mismatch");
        let cursor = 0;
        while (cursor < bytes.length) {
          const count = Math.min(part.length - offset, bytes.length - cursor);
          bytes.copy(part, offset, cursor, cursor + count);
          offset += count;
          cursor += count;
          if (offset !== part.length) continue;
          const checksum = sha256(part);
          const previous = confirmed.get(number);
          if (previous && previous.sha256 !== checksum) throw new ImportIssue("source_content_changed");
          if (!previous) {
            await writePart(db, storage, { projectId, uploadId, number, length: part.length, sha256: checksum },
              Readable.from([part]));
          }
          remaining -= part.length;
          number++;
          offset = 0;
          part = Buffer.allocUnsafe(Math.min(partSize, remaining));
        }
      }
      if (seen !== identity.size) throw new ImportIssue("remote_transfer_interrupted", true);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "ETIMEDOUT", "ABORT_ERR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) throw new ImportIssue("remote_transfer_interrupted", true);
      throw error;
    } finally {
      input.destroy();
    }
  }

  signal.throwIfAborted();
  await confirmPublication(db, storage, entry, { projectId, uploadId }, identity);
}

async function confirmPublication(
  db: Pool, storage: IntakeStorage, entry: NodeEntry, coordinates: { projectId: string; uploadId: string },
  identity: Identity,
): Promise<void> {
  const published = await finalizeOriginal(db, storage, coordinates);
  await db.query(
    `UPDATE import_inventory_entries SET state='accepted', reason=NULL, observed_bytes=$2, sha256=$3,
      occurrence_id=$4, version_id=$5, media_type=$6 WHERE id=$1`,
    [entry.id, identity.size, identity.sha256, published.occurrenceId, published.versionId, published.mediaType],
  );
}

/** Finalization can commit before the import worker records its view of the occurrence. */
export async function recoverPublished(
  db: Pool, storage: IntakeStorage, job: Job, entry: NodeEntry,
): Promise<boolean> {
  if (!entry.upload_id) return false;
  const coordinates = { projectId: job.project_id, uploadId: entry.upload_id };
  const upload = await getUpload(db, coordinates);
  if (upload.status !== "complete") return false;
  await confirmPublication(db, storage, entry, coordinates, upload);
  return true;
}

export async function acceptStaged(
  db: Pool, storage: IntakeStorage, job: Job, entry: NodeEntry,
  staged: { path: string; size: number; sha256: string }, signal: AbortSignal,
): Promise<void> {
  await publish(db, storage, job, entry, { ...staged, mediaType: mediaType(entry.media_type) },
    async () => createReadStream(staged.path, { signal }), signal);
}

export async function acceptRemote(
  db: Pool, storage: IntakeStorage, workspace: string, job: Job, entry: NodeEntry,
  transport: PublicDisk, signal: AbortSignal,
): Promise<void> {
  if (job.source_url === null || entry.relative_path === null || entry.remote_path === null) {
    throw new ImportIssue("remote_metadata_invalid");
  }
  const url = job.source_url;
  const size = Number(entry.expected_bytes);
  const remote: RemoteEntry = {
    path: entry.relative_path, remotePath: entry.remote_path, kind: "file", size,
    sha256: entry.sha256, parent: null, mediaType: entry.media_type,
  };
  const open = async () => {
    const response = await transport.download(url, remote, signal);
    const contentLength = response.headers["content-length"];
    if (contentLength !== undefined && contentLength !== String(size)) {
      response.destroy();
      throw new ImportIssue("source_length_mismatch");
    }
    return response;
  };

  if (entry.sha256) {
    await publish(db, storage, job, entry, { size, sha256: entry.sha256, mediaType: mediaType(entry.media_type) },
      open, signal);
    return;
  }
  const response = await open();
  try {
    const staged = await stageBytes(db, storage, workspace, job.id, "source", response, size, signal);
    try {
      if (staged.size !== size) throw new ImportIssue("remote_transfer_interrupted", true);
      await acceptStaged(db, storage, job, entry, staged, signal);
    } finally {
      await rm(staged.path, { force: true });
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
      throw new ImportIssue("remote_transfer_interrupted", true);
    }
    throw error;
  } finally {
    response.destroy();
  }
}
