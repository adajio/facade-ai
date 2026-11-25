import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { addAbortSignal } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { lockProjectScopes, transaction } from "../access/commands.js";
import { queueArchive } from "../imports/archive-queue.js";
import { importScratchUnwrittenBytes } from "../imports/reserve.js";
import {
  freeBytes, MAX_RECEIPT_BYTES, partPath, partsStream, removeParts, verifyOriginal, verifyPart,
} from "./blob.js";
import type { IntakeStorage } from "./blob.js";
import { conflict, IntakeError, invalid, notFound } from "./errors.js";
import { appendIntakeEvent, closeEmptyHold, createHold, lockIntakeProject } from "./gate.js";
import { checksum, parseMediaType, parsePath, parseScopeIds, parseSize, uuid } from "./inputs.js";
import { lockReceipt } from "./receipts.js";
import { acceptManifestInput } from "./manifest.js";
import type { ReceiptContext } from "./receipts.js";

type Queryable = Pool | PoolClient;
export type UploadContext = { projectId: string; uploadId: string };
type UploadStatus = "uploading" | "complete" | "cancelled" | "expired";

type UploadRow = {
  id: string;
  receipt_id: string;
  project_id: string;
  occurrence_id: string;
  hold_id: string | null;
  replaces_version_id: string | null;
  state: UploadStatus;
  size: string;
  sha256: string;
  part_size: number;
  declaration_hash: string;
  expires_at: Date;
  expired: boolean;
  prepared_object_key: string | null;
  prepared_media_type: string | null;
};

type Part = { number: number; offset: number; length: number; sha256: string };
export type DeclareOriginalInput = ReceiptContext & {
  uploadId?: string;
  manifestItemId?: string;
  relativePath: string;
  size: number;
  sha256: string;
  mediaType?: string;
  scopeIds?: string[];
  replacesVersionId?: string;
  parentOccurrenceId?: string;
  importId?: string;
};

export function normalizeDeclaration(input: DeclareOriginalInput) {
  return {
    receiptId: uuid(input.receiptId),
    projectId: uuid(input.projectId),
    relativePath: parsePath(input.relativePath),
    size: parseSize(input.size),
    sha256: checksum(input.sha256),
    mediaType: parseMediaType(input.mediaType),
    scopeIds: parseScopeIds(input.scopeIds),
    replacesVersionId: input.replacesVersionId == null ? null : uuid(input.replacesVersionId),
    parentOccurrenceId: input.parentOccurrenceId == null ? null : uuid(input.parentOccurrenceId),
    importId: input.importId == null ? null : uuid(input.importId),
  };
}

export async function lockDiskReservations(tx: PoolClient): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('intake/disk', 0))");
}

export async function intakeUnwrittenBytes(tx: PoolClient): Promise<bigint> {
  const { rows: [{ bytes }] } = await tx.query<{ bytes: string }>(
    `SELECT COALESCE(SUM(2 * u.size - COALESCE(p.bytes, 0)), 0) AS bytes
       FROM intake_uploads u LEFT JOIN (
          SELECT upload_id, SUM(length) AS bytes FROM intake_parts GROUP BY upload_id
       ) p ON p.upload_id = u.id WHERE u.state = 'uploading'`,
  );
  return BigInt(bytes);
}

type Declaration = ReturnType<typeof normalizeDeclaration>;

async function checkProvenance(tx: PoolClient, input: Declaration): Promise<string | null> {
  let importId = input.importId;
  if (input.parentOccurrenceId) {
    const { rows: [parent] } = await tx.query<{ import_id: string | null; inventory_pending: boolean }>(
      "SELECT import_id, inventory_pending FROM intake_occurrences WHERE id = $1 AND receipt_id = $2 AND state = 'accepted'",
      [input.parentOccurrenceId, input.receiptId],
    );
    if (!parent) notFound();
    if (!parent.inventory_pending) conflict("container_closed", "Container inventory is already closed");
    if (importId !== null && importId !== parent.import_id) invalid("import_mismatch", "Child must inherit the container import");
    importId = parent.import_id;
  } else if (importId) {
    const { rows: [entry] } = await tx.query<{ state: string }>(
      "SELECT state FROM intake_imports WHERE id = $1 AND receipt_id = $2",
      [importId, input.receiptId],
    );
    if (!entry) notFound();
    if (entry.state !== "running") conflict("import_not_running", "Import is not running");
  }
  if (input.replacesVersionId) {
    const { rowCount } = await tx.query(
      "SELECT 1 FROM intake_document_versions WHERE id = $1 AND project_id = $2",
      [input.replacesVersionId, input.projectId],
    );
    if (!rowCount) notFound();
  }
  return importId;
}

export async function declareOriginal(tx: PoolClient, storage: IntakeStorage, input: DeclareOriginalInput) {
  const declaration = normalizeDeclaration(input);
  const { projectId, receiptId, parentOccurrenceId, scopeIds, replacesVersionId, relativePath, mediaType, size, sha256 } = declaration;
  const uploadId = input.uploadId ? uuid(input.uploadId) : randomUUID();
  const declarationHash = createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
  await lockIntakeProject(tx, projectId);
  await lockProjectScopes(tx, projectId, scopeIds);
  const receipt = await lockReceipt(tx, declaration);
  const previous = await readUpload(tx, { projectId, uploadId });
  if (previous) {
    if (previous.declaration_hash !== declarationHash) conflict("upload_declaration_mismatch", "Upload identifier is already in use");
    return await uploadView(tx, previous);
  }
  if (!parentOccurrenceId && !declaration.importId && receipt.sealed_at) {
    conflict("receipt_sealed", "Receipt no longer accepts new inputs");
  }
  if (!parentOccurrenceId && !declaration.importId && receipt.manifest_mode && !input.manifestItemId) {
    conflict("manifest_item_required", "Объявите файл в составе поступления.");
  }
  const importId = await checkProvenance(tx, declaration);
  if (!parentOccurrenceId) {
    const { rows: [{ bytes }] } = await tx.query<{ bytes: string }>(
      `SELECT COALESCE(SUM(u.size), 0) AS bytes FROM intake_uploads u
         JOIN intake_occurrences o ON o.id = u.occurrence_id WHERE u.receipt_id = $1
          AND o.parent_occurrence_id IS NULL AND u.state IN ('uploading', 'complete')`,
      [receiptId],
    );
    if (Number(bytes) + size > MAX_RECEIPT_BYTES) {
      throw new IntakeError(413, "receipt_size_limit", "Receipt exceeds the byte limit");
    }
  }
  await lockDiskReservations(tx);
  const { rows: [{ present }] } = await tx.query<{ present: boolean }>(
    "SELECT to_regclass('import_scratch_reservations') IS NOT NULL AS present",
  );
  const scratch = present ? await importScratchUnwrittenBytes(tx) : 0n;
  const unwritten = await intakeUnwrittenBytes(tx);
  // Confirming bytes can lower outstanding reservations while the file is being written.
  // Read reservations before sampling physical free bytes to stay conservative.
  const free = await freeBytes(storage);
  if (free < BigInt(storage.diskGuardBytes) + 2n * BigInt(size) + unwritten + scratch) {
    throw new IntakeError(429, "intake_disk_reserve", "Disk capacity is temporarily reserved");
  }
  const hold = importId || parentOccurrenceId
    ? null
    : await createHold(tx, { projectId, receiptId, source: "upload", sourceId: uploadId, scopeIds });
  const { rows: [{ id: occurrenceId }] } = await tx.query<{ id: string }>(
    `INSERT INTO intake_occurrences (project_id, receipt_id, parent_occurrence_id, import_id, relative_path, declared_media_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [projectId, receiptId, parentOccurrenceId, importId, relativePath, mediaType],
  );
  const { rows: [upload] } = await tx.query<UploadRow>(
    `INSERT INTO intake_uploads (id, project_id, receipt_id, occurrence_id, hold_id, replaces_version_id,
         size, sha256, part_size, declaration_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + $11 * interval '1 second')
     RETURNING *`,
    [uploadId, projectId, receiptId, occurrenceId, hold?.id ?? null, replacesVersionId, size, sha256, storage.partSize,
      declarationHash, storage.ttlSeconds],
  );
  await appendIntakeEvent(tx, projectId, receiptId, "intake.upload_declared", { uploadId, occurrenceId });
  return await uploadView(tx, upload);
}

async function readUpload(db: Queryable, input: UploadContext): Promise<UploadRow | undefined> {
  const { rows: [row] } = await db.query<UploadRow>(
    "SELECT u.*, u.expires_at <= statement_timestamp() AS expired FROM intake_uploads u WHERE id = $1 AND project_id = $2",
    [input.uploadId, input.projectId],
  );
  return row;
}

async function readParts(db: Queryable, uploadId: string): Promise<Part[]> {
  const { rows } = await db.query<Omit<Part, "offset"> & { offset: string }>(
    `SELECT number, byte_offset AS "offset", length, sha256 FROM intake_parts WHERE upload_id = $1 ORDER BY number`,
    [uploadId],
  );
  return rows.map((row) => ({ ...row, offset: Number(row.offset) }));
}

async function uploadView(db: Queryable, upload: UploadRow) {
  const parts = await readParts(db, upload.id);
  return {
    receiptId: upload.receipt_id,
    occurrenceId: upload.occurrence_id,
    uploadId: upload.id,
    holdId: upload.hold_id,
    status: upload.state,
    size: Number(upload.size),
    sha256: upload.sha256,
    partSize: upload.part_size,
    expiresAt: upload.expires_at,
    parts,
    confirmedBytes: parts.reduce((total, part) => total + part.length, 0),
  };
}

export async function getUpload(db: Queryable, input: UploadContext) {
  const upload = await readUpload(db, input);
  if (!upload) notFound();
  return await uploadView(db, upload);
}

const uploadLock = "hashtextextended('intake/upload/' || $1::text, 0)";

type UploadOperation<T> = (tx: PoolClient, signal: AbortSignal) => Promise<T>;

async function waitForUploadLock<T>(db: Pool, uploadId: string, action: UploadOperation<T>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return await withUploadLock(db, uploadId, action);
    } catch (error) {
      if (!(error instanceof IntakeError && error.code === "upload_busy") || Date.now() >= deadline) throw error;
    }
    // Keep the pool available to other uploads and projects while waiting.
    await delay(250);
  }
}

async function withUploadLock<T>(db: Pool, uploadId: string, action: UploadOperation<T>): Promise<T> {
  const tx = await db.connect();
  let locked = false;
  let releaseError: Error | undefined;
  const controller = new AbortController();
  const onConnectionError = (error: Error) => {
    releaseError = error;
    controller.abort(error);
  };
  tx.on("error", onConnectionError);
  try {
    const { rows: [{ acquired }] } = await tx.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${uploadLock}) AS acquired`, [uuid(uploadId)],
    );
    locked = acquired;
    if (!locked) conflict("upload_busy", "Upload is processing another operation");
    return await action(tx, controller.signal);
  } finally {
    if (locked && !releaseError) {
      try {
        await tx.query(`SELECT pg_advisory_unlock(${uploadLock})`, [uploadId]);
      } catch {
        releaseError = new Error("Upload connection lost");
      }
    }
    tx.off("error", onConnectionError);
    tx.release(releaseError);
  }
}

function assertActive(upload: UploadRow) {
  if (upload.expired || upload.state === "expired") throw new IntakeError(410, "upload_expired", "Upload expired");
  if (upload.state !== "uploading") conflict("upload_closed", "Upload no longer accepts bytes");
}

export type CheckUploadAccess = (db: PoolClient) => Promise<void>;

export async function writePart(
  db: Pool, storage: IntakeStorage,
  input: UploadContext & { number: number; length: number; sha256: string },
  stream: Readable, authorize?: CheckUploadAccess,
) {
  const { uploadId, number, length } = input;
  const sha256 = checksum(input.sha256);
  if (!Number.isSafeInteger(number) || number < 1) invalid("invalid_part_number", "Parts are numbered from one");
  return await waitForUploadLock(db, uploadId, async (tx, signal) => {
    await authorize?.(tx);
    const upload = await readUpload(tx, input);
    if (!upload) notFound();
    if (upload.state !== "complete") assertActive(upload);
    const offset = (number - 1) * upload.part_size;
    const size = Number(upload.size);
    if (offset >= size || !Number.isSafeInteger(offset) || length !== Math.min(upload.part_size, size - offset)) {
      invalid("part_length_mismatch", "Part number or length differs from declaration");
    }
    const { rows: [previous] } = await tx.query<{ sha256: string }>(
      "SELECT sha256 FROM intake_parts WHERE upload_id = $1 AND number = $2", [uploadId, number],
    );
    if (previous && previous.sha256 !== sha256) conflict("part_conflict", "This part already has a different SHA-256");
    if (!previous && upload.state === "complete") conflict("upload_closed", "Upload no longer accepts bytes");
    await verifyPart(storage, uploadId, number, addAbortSignal(signal, stream), { size: length, sha256 }, !previous);
    if (!previous) {
      await authorize?.(tx);
      await tx.query(
        "INSERT INTO intake_parts (upload_id, number, byte_offset, length, sha256) VALUES ($1, $2, $3, $4, $5)",
        [uploadId, number, offset, length, sha256],
      );
    }
    return { number, offset, length, sha256 };
  });
}

async function detectMediaType(storage: IntakeStorage, uploadId: string, part?: Part): Promise<string> {
  if (!part) return "application/octet-stream";
  const header = Buffer.alloc(Math.min(1024, part.length));
  const file = await open(partPath(storage, uploadId, part), "r");
  try {
    await file.read(header);
  } finally {
    await file.close();
  }
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (header.subarray(0, 4).toString("hex") === "504b0304" || header.subarray(0, 4).toString("hex") === "504b0506") {
    return "application/zip";
  }
  if (header.subarray(0, 6).toString("hex") === "377abcaf271c") return "application/x-7z-compressed";
  if (header.subarray(0, 6).toString("hex") === "526172211a07") return "application/vnd.rar";
  return "application/octet-stream";
}

function objectKey(upload: UploadRow): string {
  return `originals/${upload.project_id}/${upload.id}`;
}

export type Publication = {
  receiptId: string; uploadId: string; occurrenceId: string; originalId: string;
  documentId: string; versionId: string; jobId: string; mediaType: string;
};
async function readPublication(db: Queryable, upload: UploadRow): Promise<Publication> {
  const { rows: [row] } = await db.query<Omit<Publication, "receiptId" | "uploadId" | "occurrenceId">>(
    `SELECT v.original_id AS "originalId", v.document_id AS "documentId", v.id AS "versionId",
            v.media_type AS "mediaType", j.id AS "jobId"
       FROM intake_occurrences o JOIN intake_document_versions v ON v.id = o.version_id
       JOIN intake_reader_jobs j ON j.version_id = v.id WHERE o.id = $1`,
    [upload.occurrence_id],
  );
  if (!row) throw new Error("Published intake version is incomplete");
  return { receiptId: upload.receipt_id, uploadId: upload.id, occurrenceId: upload.occurrence_id, ...row };
}

type Prepared = {
  uploadId: string; projectId: string; sha256: string; size: number; objectKey: string; mediaType: string;
};

export async function prepareOriginal(
  db: Pool, storage: IntakeStorage, input: UploadContext, authorize?: CheckUploadAccess,
): Promise<Prepared | undefined> {
  return await waitForUploadLock(db, input.uploadId, async (tx) => {
    await authorize?.(tx);
    const upload = await readUpload(tx, input);
    if (!upload) notFound();
    if (upload.state === "complete") return undefined;
    assertActive(upload);
    const size = Number(upload.size);
    if (upload.prepared_object_key && upload.prepared_media_type) {
      return {
        uploadId: upload.id, projectId: upload.project_id, sha256: upload.sha256, size,
        objectKey: upload.prepared_object_key, mediaType: upload.prepared_media_type,
      };
    }
    const parts = await readParts(tx, upload.id);
    const expectedCount = Math.ceil(size / upload.part_size);
    if (parts.length !== expectedCount
      || parts.some((part, i) => part.number !== i + 1 || part.offset !== i * upload.part_size
          || part.length !== Math.min(upload.part_size, size - part.offset))) {
      conflict("missing_parts", "Upload has unconfirmed parts");
    }

    const identity = { size, sha256: upload.sha256 };
    const { rows: [existing] } = await tx.query<{ object_key: string }>(
      "SELECT object_key FROM intake_originals WHERE project_id = $1 AND size = $2 AND sha256 = $3",
      [upload.project_id, size, upload.sha256],
    );
    const key = existing?.object_key ?? objectKey(upload);
    const object = await storage.objects.head(key);
    if (object) {
      if (object.size !== size || object.sha256 !== upload.sha256) {
        throw new IntakeError(424, "original_storage_mismatch", "Stored object identity differs");
      }
      if (!existing) await verifyOriginal(await storage.objects.get(key), identity);
      // A matching existing blob does not establish that the new occurrence supplied those bytes.
      await verifyOriginal(partsStream(storage, upload.id, parts), identity);
    } else {
      if (existing) throw new IntakeError(424, "original_storage_missing", "An existing project original is missing");
      await verifyOriginal(partsStream(storage, upload.id, parts), identity);
      await storage.objects.put(key, identity, partsStream(storage, upload.id, parts));
      const confirmed = await storage.objects.head(key);
      if (confirmed?.sha256 !== upload.sha256 || confirmed.size !== size) {
        throw new IntakeError(424, "original_storage_mismatch", "Stored object was not confirmed");
      }
      await verifyOriginal(await storage.objects.get(key), identity);
    }
    const mediaType = await detectMediaType(storage, upload.id, parts[0]);
    await tx.query(
      "UPDATE intake_uploads SET prepared_object_key = $2, prepared_media_type = $3 WHERE id = $1",
      [upload.id, key, mediaType],
    );
    return {
      uploadId: upload.id, projectId: upload.project_id, sha256: upload.sha256, size, objectKey: key, mediaType,
    };
  });
}

export async function lockUploadTransaction(tx: PoolClient, uploadId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(${uploadLock})`, [uuid(uploadId)]);
}

// Repeated delivery of the same loose package file preserves its edition and map.
// A declared replacement, another inventory path, or an explicit scope has its own provenance.
async function repeatedEdition(tx: PoolClient, upload: UploadRow, originalId: string) {
  const { rows: [edition] } = await tx.query<{ documentId: string; versionId: string; jobId: string }>(
    `SELECT v.document_id AS "documentId", v.id AS "versionId", job.id AS "jobId"
       FROM projects p JOIN intake_document_versions v ON v.project_id=p.id AND v.original_id=$2
       JOIN intake_reader_jobs job ON job.version_id=v.id
       JOIN intake_occurrences before ON before.version_id=v.id AND before.state='accepted'
       JOIN intake_occurrences incoming ON incoming.id=$3 AND incoming.project_id=p.id
       JOIN intake_uploads previous ON previous.occurrence_id=before.id
      WHERE p.id=$1 AND p.intake_mode AND before.relative_path=incoming.relative_path
        AND before.declared_media_type=incoming.declared_media_type
        AND before.import_id IS NULL AND incoming.import_id IS NULL
        AND before.parent_occurrence_id IS NULL AND incoming.parent_occurrence_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM intake_document_versions newer WHERE newer.replaces_version_id=v.id)
        AND NOT EXISTS (SELECT 1 FROM intake_events e WHERE e.project_id=p.id
          AND e.receipt_id IN (before.receipt_id,incoming.receipt_id)
          AND e.type IN ('intake.held','intake.hold_narrowed')
          AND coalesce(e.data->>'holdId',e.data->>'id') IN (previous.hold_id::text,$4::text)
          AND jsonb_typeof(e.data->'scopeIds')='array')
      ORDER BY v.created_at DESC,v.id LIMIT 1`,
    [upload.project_id, originalId, upload.occurrence_id, upload.hold_id],
  );
  return edition;
}

async function createEdition(tx: PoolClient, upload: UploadRow, originalId: string, mediaType: string) {
  const document = upload.replaces_version_id
    ? await tx.query<{ id: string }>(
        "SELECT document_id AS id FROM intake_document_versions WHERE id = $1 AND project_id = $2",
        [upload.replaces_version_id, upload.project_id],
      )
    : await tx.query<{ id: string }>("INSERT INTO intake_documents (project_id) VALUES ($1) RETURNING id", [upload.project_id]);
  const { id: documentId } = document.rows[0];
  const { rows: [{ id: versionId }] } = await tx.query<{ id: string }>(
    `INSERT INTO intake_document_versions (project_id, document_id, original_id, media_type, replaces_version_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [upload.project_id, documentId, originalId, mediaType, upload.replaces_version_id],
  );
  return { documentId, versionId };
}

export async function publishPreparedOriginal(tx: PoolClient, input: UploadContext, prepared: Prepared | undefined) {
  await lockUploadTransaction(tx, input.uploadId);
  await lockIntakeProject(tx, input.projectId);
  const upload = await readUpload(tx, input);
  if (!upload) notFound();
  if (upload.state === "complete") return await readPublication(tx, upload);
  assertActive(upload);
  if (prepared?.uploadId !== upload.id || prepared.projectId !== upload.project_id ||
      prepared.size !== Number(upload.size) || prepared.sha256 !== upload.sha256 ||
      prepared.objectKey !== upload.prepared_object_key || prepared.mediaType !== upload.prepared_media_type) {
    throw new IntakeError(424, "original_unconfirmed", "The original object has not been confirmed");
  }
  const original = await tx.query<{ id: string }>(
    "SELECT id FROM intake_originals WHERE project_id = $1 AND sha256 = $2 AND size = $3",
    [upload.project_id, prepared.sha256, prepared.size],
  );
  const originalId = original.rows[0]?.id ?? upload.id;
  if (!original.rowCount) {
    await tx.query(
      "INSERT INTO intake_originals (id, project_id, object_key, size, sha256) VALUES ($1,$2,$3,$4,$5)",
      [originalId, upload.project_id, prepared.objectKey, prepared.size, prepared.sha256],
    );
  }
  const repeated = original.rowCount && !upload.replaces_version_id ? await repeatedEdition(tx, upload, originalId) : undefined;
  const { documentId, versionId } = repeated ?? await createEdition(tx, upload, originalId, prepared.mediaType);
  const { rows: [occurrence] } = await tx.query<{ relative_path: string }>(
    `UPDATE intake_occurrences SET state = 'accepted', version_id = $2
      WHERE id = $1 RETURNING relative_path`,
    [upload.occurrence_id, versionId],
  );
  // Office documents also have a ZIP header; their container is handled by the Office reader.
  const officePackage = prepared.mediaType === "application/zip" && /\.(docx|xlsx|pptx)$/i.test(occurrence.relative_path);
  const inventoryPending = !officePackage && await queueArchive(tx, {
    projectId: upload.project_id, receiptId: upload.receipt_id, occurrenceId: upload.occurrence_id,
    versionId, relativePath: occurrence.relative_path, mediaType: prepared.mediaType,
  });
  if (inventoryPending) {
    await tx.query("UPDATE intake_occurrences SET inventory_pending = true WHERE id = $1", [upload.occurrence_id]);
  }
  const jobId = repeated?.jobId ?? (await tx.query<{ id: string }>(
    `INSERT INTO intake_reader_jobs (project_id, receipt_id, document_id, version_id, original_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [upload.project_id, upload.receipt_id, documentId, versionId, originalId],
  )).rows[0].id;
  await tx.query("UPDATE intake_uploads SET state = 'complete' WHERE id = $1", [upload.id]);
  const result = {
    receiptId: upload.receipt_id, uploadId: upload.id, occurrenceId: upload.occurrence_id,
    originalId, documentId, versionId, jobId, mediaType: prepared.mediaType,
  };
  await appendIntakeEvent(tx, upload.project_id, upload.receipt_id, "intake.original_ready", result);
  await acceptManifestInput(tx, { projectId: upload.project_id, receiptId: upload.receipt_id, uploadId: upload.id });
  return result;
}

export async function finalizeOriginal(
  db: Pool, storage: IntakeStorage, input: UploadContext, authorize?: CheckUploadAccess,
): Promise<Publication> {
  const prepared = await prepareOriginal(db, storage, input, authorize);
  return await transaction(db, async (tx) => {
    await authorize?.(tx);
    return await publishPreparedOriginal(tx, input, prepared);
  });
}

export async function retireUpload(
  tx: PoolClient, input: UploadContext, status: "cancelled" | "expired", manifestExclusion = false,
) {
  await lockUploadTransaction(tx, input.uploadId);
  await lockIntakeProject(tx, input.projectId);
  await lockProjectScopes(tx, input.projectId);
  const upload = await readUpload(tx, input);
  if (!upload) notFound();
  if (status === "cancelled" && !manifestExclusion) {
    const { rowCount } = await tx.query("SELECT 1 FROM intake_manifest_items WHERE upload_id=$1", [input.uploadId]);
    if (rowCount) conflict("manifest_exclusion_reason_required", "Исключите вход из состава с указанием причины.");
  }
  if (upload.state === "complete") conflict("upload_already_accepted", "An accepted original remains in the inventory");
  if (upload.state !== "uploading" || (status === "expired" && !upload.expired)) {
    return { uploadId: upload.id, status: upload.state };
  }
  await tx.query("UPDATE intake_uploads SET state = $2 WHERE id = $1", [upload.id, status]);
  await tx.query("UPDATE intake_occurrences SET state = $2 WHERE id = $1", [upload.occurrence_id, status]);
  await closeEmptyHold(tx, upload.project_id, upload.hold_id);
  const result = { uploadId: upload.id, status };
  await appendIntakeEvent(tx, upload.project_id, upload.receipt_id, `intake.upload_${status}`, result);
  return result;
}

export async function cleanIntakeUploads(db: Pool, storage: IntakeStorage): Promise<void> {
  const { rows } = await db.query<UploadContext & { state: UploadStatus }>(
    `SELECT id AS "uploadId", project_id AS "projectId", state FROM intake_uploads
      WHERE (state = 'uploading' AND expires_at <= now()) OR (state <> 'uploading' AND cleaned_at IS NULL)
      ORDER BY (state = 'uploading') DESC, expires_at, id LIMIT 16`,
  );
  let failure: unknown;
  for (const input of rows) {
    try {
      await withUploadLock(db, input.uploadId, async (tx) => {
        if (input.state === "uploading") {
          await tx.query("BEGIN");
          try {
            await retireUpload(tx, input, "expired");
            await tx.query("COMMIT");
          } catch (error) {
            await tx.query("ROLLBACK");
            throw error;
          }
        }
        const upload = await readUpload(tx, input);
        if (!upload || upload.state === "uploading") return;
        const key = objectKey(upload);
        const { rowCount } = await tx.query("SELECT 1 FROM intake_originals WHERE object_key = $1", [key]);
        await removeParts(storage, upload.id);
        if (!rowCount && await storage.objects.head(key)) await storage.objects.remove(key);
        await tx.query("UPDATE intake_uploads SET cleaned_at = now() WHERE id = $1", [upload.id]);
      });
    } catch (error) {
      if (!(error instanceof IntakeError && (error.code === "upload_busy" || error.code === "upload_already_accepted"))) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
}
