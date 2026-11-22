import type { Pool, PoolClient } from "pg";
import type { ByteRange, IntakeStorage } from "./blob.js";
import { IntakeError, notFound } from "./errors.js";

export function parseRange(value: string, size: number): ByteRange | undefined {
  if (!/^bytes=/i.test(value)) return undefined;
  // Multiple ranges are ignored and answered with a full representation.
  if (value.includes(",")) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) {
    throw new IntakeError(416, "invalid_range", "Byte range is not satisfiable");
  }
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) throw new IntakeError(416, "invalid_range", "Byte range is not satisfiable");
    return { start: suffix > total ? 0 : Number(total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) throw new IntakeError(416, "invalid_range", "Byte range is not satisfiable");
  return { start: Number(start), end: end >= total ? size - 1 : Number(end) };
}

export async function getOriginal(
  db: Pool | PoolClient, storage: IntakeStorage, projectId: string, versionId: string, documentId?: string,
) {
  const { rows: [row] } = await db.query<{
    object_key: string; sha256: string; size: string; media_type: string; relative_path: string;
    document_id: string; original_id: string;
  }>(
    `SELECT b.object_key, b.sha256, b.size, v.media_type, v.document_id, v.original_id, o.relative_path
       FROM intake_document_versions v
       JOIN intake_originals b ON b.id = v.original_id AND b.project_id = v.project_id
       JOIN intake_occurrences o ON o.version_id = v.id
      WHERE v.project_id = $1 AND v.id = $2 AND ($3::uuid IS NULL OR v.document_id = $3)`,
    [projectId, versionId, documentId ?? null],
  );
  if (!row) notFound();
  const size = Number(row.size);
  async function check() {
    const object = await storage.objects.head(row.object_key);
    if (!object || object.sha256 !== row.sha256 || object.size !== size) {
      throw new IntakeError(424, "original_storage_mismatch", "Stored original is unavailable");
    }
  }
  return {
    documentId: row.document_id, versionId, originalId: row.original_id, size, sha256: row.sha256,
    mediaType: row.media_type, relativePath: row.relative_path,
    check,
    async open(range?: ByteRange) {
      await check();
      return storage.objects.get(row.object_key, range);
    },
  };
}

export async function openOriginal(
  db: Pool | PoolClient, storage: IntakeStorage, projectId: string, versionId: string, range?: ByteRange,
) {
  const { open, check: _check, ...original } = await getOriginal(db, storage, projectId, versionId);
  return { ...original, stream: await open(range) };
}
