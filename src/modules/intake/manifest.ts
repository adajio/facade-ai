import type { PoolClient } from "pg";
import { archiveFormat } from "../imports/policy.js";
import { publicShare } from "../imports/yandex.js";
import { MAX_RECEIPT_BYTES } from "./blob.js";
import { conflict, IntakeError, invalid, notFound } from "./errors.js";
import { appendIntakeEvent } from "./gate.js";
import { checksum, parseMediaType, parsePath, parseScopeIds, parseSize, uuid } from "./inputs.js";
import type { ReceiptContext } from "./receipts.js";

export type ManifestMode = "once" | "open";
const maxItems = 10_000;

export function parseManifestMode(value: unknown): ManifestMode {
  if (value !== "once" && value !== "open") invalid("invalid_manifest_mode", "Выберите режим приёма.");
  return value;
}

export function parseManifestVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid("manifest_version_required", "Передайте текущую версию состава.");
  }
  return value as number;
}

export function parseExclusionReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes("\0")) {
    invalid("manifest_exclusion_reason_required", "Укажите причину исключения входа.");
  }
  return value.trim();
}

export function parseManifestItems(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    invalid("invalid_manifest_items", "Укажите от 1 до 10 000 входов.");
  }
  const ids = new Set<string>();
  const items = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("invalid_manifest_item", "Укажите вход передачи.");
    const input = item as Record<string, unknown>;
    const itemId = uuid(input.itemId);
    if (ids.has(itemId)) invalid("duplicate_manifest_item", "Идентификаторы входов должны быть уникальными.");
    ids.add(itemId);
    const scopeIds = parseScopeIds(input.scopeIds);
    if (input.kind === "link") return { itemId, kind: "link" as const, scopeIds, url: publicShare(input.url) };
    if (input.kind !== "file") invalid("invalid_manifest_item_kind", "Укажите файл или ссылку.");
    const relativePath = parsePath(input.relativePath);
    const mediaType = parseMediaType(input.mediaType);
    return {
      itemId, kind: archiveFormat(relativePath, mediaType) ? "archive" as const : "file" as const,
      relativePath, mediaType, scopeIds, size: parseSize(input.size), sha256: checksum(input.sha256),
      replacesVersionId: input.replacesVersionId == null ? undefined : uuid(input.replacesVersionId),
    };
  });
  return items;
}

export type ManifestItemInput = ReturnType<typeof parseManifestItems>[number];

export type ManifestItemRow = {
  kind: ManifestItemInput["kind"]; relative_path: string; size: string; sha256: string;
  media_type: string; scope_ids: string[] | null; replaces_version_id: string | null;
  upload_id: string | null; import_id: string | null; excluded_at: Date | null; accepted_at: Date | null;
};

export async function readManifestItem(tx: PoolClient, receiptId: string, itemId: string): Promise<ManifestItemRow> {
  const { rows: [item] } = await tx.query<ManifestItemRow>(
    "SELECT * FROM intake_manifest_items WHERE receipt_id=$1 AND id=$2", [receiptId, itemId],
  );
  if (!item) notFound();
  return item;
}

export async function insertManifestItems(
  tx: PoolClient, input: ReceiptContext, version: number, items: ManifestItemInput[],
) {
  const { rows: [{ count, bytes }] } = await tx.query<{ count: string; bytes: string }>(
    `SELECT count(*), coalesce(sum(size) FILTER (WHERE excluded_at IS NULL),0) AS bytes
       FROM intake_manifest_items WHERE receipt_id=$1`, [input.receiptId],
  );
  if (Number(count) + items.length > maxItems) invalid("invalid_manifest_items", "В поступлении допускается до 10 000 входов.");
  if (BigInt(bytes) + items.reduce((sum, item) => sum + BigInt(item.size ?? 0), 0n) > BigInt(MAX_RECEIPT_BYTES)) {
    throw new IntakeError(413, "receipt_size_limit", "Превышен предел размера поступления.");
  }
  for (const item of items) {
    if (item.replacesVersionId) {
      const { rowCount } = await tx.query(
        "SELECT 1 FROM intake_document_versions WHERE project_id=$1 AND id=$2",
        [input.projectId, item.replacesVersionId],
      );
      if (!rowCount) notFound();
    }
  }
  const { rowCount } = await tx.query(
    `INSERT INTO intake_manifest_items (receipt_id, id, added_version, position, kind,
       relative_path, size, sha256, media_type, scope_ids, replaces_version_id)
     SELECT $1, item.id, $2, item.position, item.kind, item.path, item.size, item.sha256,
       item.media_type, item.scope_ids, item.replaces_version_id
     FROM jsonb_to_recordset($3::jsonb) AS item(id uuid, position integer, kind text,
       path text, size bigint, sha256 text, media_type text, scope_ids uuid[], replaces_version_id uuid)
     ON CONFLICT (receipt_id,id) DO NOTHING`,
    [input.receiptId, version, JSON.stringify(items.map((item, position) => ({
      id: item.itemId, position, kind: item.kind, path: item.relativePath, size: item.size, sha256: item.sha256,
      media_type: item.mediaType, scope_ids: item.scopeIds, replaces_version_id: item.replacesVersionId,
    })))],
  );
  if (rowCount !== items.length) conflict("duplicate_manifest_item", "Один из входов уже объявлен.");
  await appendIntakeEvent(tx, input.projectId, input.receiptId, "intake.manifest_declared", {
    receiptId: input.receiptId, version, itemCount: items.length,
  });
}

// A container upload is accepted when its original is durable. A link is accepted
// when the source import finishes; nested container inventories may still be open.
export async function acceptManifestInput(
  tx: PoolClient, input: ReceiptContext & ({ uploadId: string } | { importId: string }),
) {
  const byUpload = "uploadId" in input;
  const { rowCount } = await tx.query(
    `UPDATE intake_manifest_items SET accepted_at=now() WHERE receipt_id=$1
       AND ${byUpload ? "upload_id" : "import_id"}=$2 AND accepted_at IS NULL AND excluded_at IS NULL`,
    [input.receiptId, byUpload ? input.uploadId : input.importId],
  );
  if (rowCount) await closeDeclaredReceipt(tx, input, false);
}

export async function closeDeclaredReceipt(tx: PoolClient, input: ReceiptContext, explicit: boolean) {
  const { rowCount } = await tx.query(
    `UPDATE intake_receipts r SET sealed_at=now() WHERE r.id=$1 AND r.project_id=$2 AND r.sealed_at IS NULL
       AND (${explicit ? "r.manifest_mode IS NOT NULL" : "r.manifest_mode='once'"})
       AND NOT EXISTS (
         SELECT 1 FROM intake_manifest_items m WHERE m.receipt_id=r.id
          AND m.accepted_at IS NULL AND m.excluded_at IS NULL
       )`,
    [input.receiptId, input.projectId],
  );
  if (rowCount) await appendIntakeEvent(tx, input.projectId, input.receiptId, "intake.receipt_sealed", { receiptId: input.receiptId });
  return Boolean(rowCount);
}

export const manifestProjection = `CASE WHEN r.manifest_mode IS NOT NULL THEN jsonb_build_object(
  'mode', r.manifest_mode, 'version', r.manifest_version, 'items', (
    SELECT jsonb_agg(jsonb_build_object(
      'itemId', m.id, 'kind', m.kind, 'relativePath', m.relative_path,
      'size', m.size, 'sha256', m.sha256, 'uploadId', m.upload_id, 'importId', m.import_id,
      'occurrenceId', u.occurrence_id, 'expiresAt', u.expires_at,
      'canRetry', m.excluded_at IS NULL AND coalesce(i.state='paused' OR (i.state='failed' AND EXISTS (
        SELECT 1 FROM import_jobs j WHERE j.id=i.id AND NOT j.manifest_saved
      )), false),
      'confirmedBytes', CASE WHEN u.state='complete' THEN m.size WHEN u.state='uploading' AND u.expires_at>statement_timestamp() THEN
        COALESCE((SELECT sum(p.length) FROM intake_parts p WHERE p.upload_id=u.id),0) ELSE 0 END,
      'status', CASE WHEN m.excluded_at IS NOT NULL THEN 'excluded' WHEN m.accepted_at IS NOT NULL THEN 'accepted'
        WHEN u.state='expired' OR (u.state='uploading' AND u.expires_at<=statement_timestamp()) THEN 'expired'
        ELSE COALESCE(u.state,i.state,'declared') END,
      'reason', CASE WHEN m.excluded_at IS NOT NULL THEN m.exclusion_reason
        WHEN u.state='expired' OR (u.state='uploading' AND u.expires_at<=statement_timestamp()) THEN 'upload_expired'
        ELSE i.reason END
    ) ORDER BY m.added_version,m.position)
    FROM intake_manifest_items m LEFT JOIN intake_uploads u ON u.id=m.upload_id
    LEFT JOIN intake_imports i ON i.id=m.import_id WHERE m.receipt_id=r.id
  )
) END`;
