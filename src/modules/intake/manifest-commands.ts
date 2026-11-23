import type { PoolClient } from "pg";
import { excludePublicImport, lockPublicImport, queuePublicImport, retryPublicImport } from "../imports/intake-source.js";
import type { IntakeStorage } from "./blob.js";
import { conflict, notFound } from "./errors.js";
import { appendIntakeEvent, lockIntakeProject } from "./gate.js";
import { closeDeclaredReceipt, insertManifestItems, readManifestItem } from "./manifest.js";
import type { ManifestItemInput } from "./manifest.js";
import { lockReceipt } from "./receipts.js";
import type { ReceiptContext } from "./receipts.js";
import { declareOriginal, getUpload, lockUploadTransaction, retireUpload } from "./uploads.js";

type CheckScopes = (scopeIds: string[] | null | undefined) => Promise<void>;
type ItemContext = ReceiptContext & { itemId: string };

export async function storeManifestItems(
  tx: PoolClient, input: ReceiptContext & { actorId: string }, version: number, items: ManifestItemInput[],
  checkScopes: CheckScopes,
) {
  await checkScopes([...new Set(items.flatMap(item => item.scopeIds ?? []))].sort());
  await insertManifestItems(tx, input, version, items);
  for (const item of items) {
    if (item.kind !== "link") continue;
    const { importId } = await queuePublicImport(tx, {
      ...input, url: item.url, scopeIds: item.scopeIds, manifestItemId: item.itemId,
    });
    await tx.query("UPDATE intake_manifest_items SET import_id=$3 WHERE receipt_id=$1 AND id=$2",
      [input.receiptId, item.itemId, importId]);
  }
}

export async function appendManifestItems(
  tx: PoolClient, input: ReceiptContext & { actorId: string; manifestVersion: number },
  items: ManifestItemInput[], checkScopes: CheckScopes,
) {
  await lockIntakeProject(tx, input.projectId);
  const receipt = await lockReceipt(tx, input);
  if (receipt.manifest_mode !== "open" || receipt.sealed_at) {
    conflict("manifest_not_open", "Поступление больше не принимает новые входы.");
  }
  if (receipt.manifest_version !== input.manifestVersion) {
    conflict("manifest_version_conflict", "Состав поступления изменился. Откройте актуальную опись.");
  }
  const manifestVersion = input.manifestVersion + 1;
  await storeManifestItems(tx, input, manifestVersion, items, checkScopes);
  await tx.query("UPDATE intake_receipts SET manifest_version=$2 WHERE id=$1", [input.receiptId, manifestVersion]);
  return { receiptId: input.receiptId, manifestVersion };
}

export async function startManifestUpload(tx: PoolClient, storage: IntakeStorage,
  input: ItemContext & { restartUploadId: string | null }, checkScopes: CheckScopes,
) {
  // Upload publication/retirement take the upload lock before the project lock.
  if (input.restartUploadId) await lockUploadTransaction(tx, input.restartUploadId);
  await lockIntakeProject(tx, input.projectId);
  const item = await readManifestItem(tx, input.receiptId, input.itemId);
  await checkScopes(item.scope_ids);
  if (item.kind === "link" || item.excluded_at) notFound();
  if (item.upload_id && item.upload_id !== input.restartUploadId) {
    return await getUpload(tx, { projectId: input.projectId, uploadId: item.upload_id });
  }
  if (input.restartUploadId) {
    if (!item.upload_id) conflict("manifest_upload_changed", "Передача входа уже изменилась.");
    const prior = await retireUpload(tx, { projectId: input.projectId, uploadId: input.restartUploadId }, "expired");
    if (prior.status !== "expired") conflict("upload_still_active", "Подтверждённые части ещё можно докачать.");
  }
  const upload = await declareOriginal(tx, storage, {
    ...input, manifestItemId: input.itemId, relativePath: item.relative_path, size: Number(item.size),
    sha256: item.sha256, mediaType: item.media_type, scopeIds: item.scope_ids ?? undefined,
    replacesVersionId: item.replaces_version_id ?? undefined,
  });
  await tx.query("UPDATE intake_manifest_items SET upload_id=$3 WHERE receipt_id=$1 AND id=$2",
    [input.receiptId, input.itemId, upload.uploadId]);
  return upload;
}

export async function excludeManifestItem(tx: PoolClient, input: ItemContext & {
  manifestVersion: number; uploadId: string | null; importId: string | null; reason: string; actorId: string;
}, checkScopes: CheckScopes) {
  if (input.uploadId) await lockUploadTransaction(tx, input.uploadId);
  if (input.importId) await lockPublicImport(tx, input.importId);
  await lockIntakeProject(tx, input.projectId);
  const receipt = await lockReceipt(tx, input);
  const item = await readManifestItem(tx, input.receiptId, input.itemId);
  await checkScopes(item.scope_ids);
  if (item.excluded_at) return { itemId: input.itemId, status: "excluded" as const, sealed: Boolean(receipt.sealed_at) };
  if (receipt.manifest_version !== input.manifestVersion || item.upload_id !== input.uploadId || item.import_id !== input.importId) {
    conflict("manifest_version_conflict", "Состав поступления изменился. Откройте актуальную опись.");
  }
  if (item.accepted_at) conflict("manifest_input_already_accepted", "Принятый вход остаётся в описи.");
  if (item.upload_id) {
    const upload = await retireUpload(tx, { projectId: input.projectId, uploadId: item.upload_id }, "cancelled", true);
    await tx.query("UPDATE intake_occurrences SET restriction='manifest_input_excluded' WHERE id=(SELECT occurrence_id FROM intake_uploads WHERE id=$1)",
      [upload.uploadId]);
  }
  if (item.import_id) await excludePublicImport(tx, { ...input, importId: item.import_id });
  await tx.query(
    "UPDATE intake_manifest_items SET excluded_at=now(), excluded_by=$3, exclusion_reason=$4 WHERE receipt_id=$1 AND id=$2",
    [input.receiptId, input.itemId, input.actorId, input.reason],
  );
  await appendIntakeEvent(tx, input.projectId, input.receiptId, "intake.manifest_input_excluded", {
    itemId: input.itemId, manifestVersion: input.manifestVersion,
  });
  const sealed = await closeDeclaredReceipt(tx, input, false);
  return { itemId: input.itemId, status: "excluded" as const, sealed };
}

export async function retryManifestLink(tx: PoolClient, input: ItemContext & { importId: string }, checkScopes: CheckScopes) {
  await lockPublicImport(tx, input.importId);
  await lockIntakeProject(tx, input.projectId);
  const item = await readManifestItem(tx, input.receiptId, input.itemId);
  await checkScopes(item.scope_ids);
  if (item.excluded_at || item.import_id !== input.importId) notFound();
  return await retryPublicImport(tx, input);
}
