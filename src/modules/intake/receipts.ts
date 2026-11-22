import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockProjectScopes } from "../access/commands.js";
import { conflict, invalid, notFound } from "./errors.js";
import { appendIntakeEvent, closeEmptyHold, createHold, lockIntakeProject } from "./gate.js";
import { parseScopeIds, uuid } from "./inputs.js";

type Receipt = {
  id: string;
  project_id: string;
  number: string;
  source: "upload" | "import";
  created_at: Date;
  sealed_at: Date | null;
};

export type ReceiptContext = { projectId: string; receiptId: string };

export async function lockReceipt(tx: PoolClient, input: ReceiptContext): Promise<Receipt> {
  const { rows: [receipt] } = await tx.query<Receipt>(
    "SELECT * FROM intake_receipts WHERE id = $1 AND project_id = $2 FOR UPDATE",
    [input.receiptId, input.projectId],
  );
  if (!receipt) notFound();
  return receipt;
}

export async function createReceipt(tx: PoolClient, input: {
  projectId: string; createdBy: string; source: Receipt["source"];
}) {
  const { projectId, createdBy, source } = input;
  await lockIntakeProject(tx, projectId);
  const { rows: [receipt] } = await tx.query<Receipt>(
    "INSERT INTO intake_receipts (project_id, created_by, source) VALUES ($1, $2, $3) RETURNING *",
    [projectId, createdBy, source],
  );
  const result = { receiptId: receipt.id, number: Number(receipt.number), source, sealed: false, inventoryOpen: true };
  await appendIntakeEvent(tx, projectId, receipt.id, "intake.receipt_created", result);
  return result;
}

export async function sealReceipt(tx: PoolClient, input: ReceiptContext) {
  await lockIntakeProject(tx, input.projectId);
  const receipt = await lockReceipt(tx, input);
  if (!receipt.sealed_at) {
    await tx.query("UPDATE intake_receipts SET sealed_at = now() WHERE id = $1", [receipt.id]);
    await appendIntakeEvent(tx, input.projectId, receipt.id, "intake.receipt_sealed", { receiptId: receipt.id });
  }
  return { receiptId: receipt.id, sealed: true };
}

export async function declareImport(tx: PoolClient, input: ReceiptContext & { importId?: string; scopeIds?: string[] }) {
  const { projectId, receiptId } = input;
  const importId = input.importId ? uuid(input.importId) : randomUUID();
  const scopeIds = parseScopeIds(input.scopeIds);
  await lockIntakeProject(tx, projectId);
  await lockProjectScopes(tx, projectId, scopeIds);
  const receipt = await lockReceipt(tx, input);
  const existing = await tx.query<{ state: ImportState; hold_id: string; initial_scope_ids: string[] | null }>(
    `SELECT i.state, i.hold_id, e.data->'scopeIds' AS initial_scope_ids FROM intake_imports i
       JOIN intake_events e ON e.project_id = i.project_id AND e.receipt_id = i.receipt_id
        AND e.type = 'intake.held' AND e.data->>'id' = i.hold_id::text
       WHERE i.id = $1 AND i.receipt_id = $2`,
    [importId, receiptId],
  );
  const current = existing.rows[0];
  if (current) {
    if (JSON.stringify(current.initial_scope_ids) !== JSON.stringify(scopeIds ?? null)) {
      conflict("import_declaration_mismatch", "Import identifier is already in use");
    }
    return { importId, receiptId, status: current.state, holdId: current.hold_id };
  }
  if (receipt.sealed_at) conflict("receipt_sealed", "Receipt no longer accepts new inputs");
  const hold = await createHold(tx, { projectId, receiptId, source: "import", sourceId: importId, scopeIds });
  await tx.query(
    "INSERT INTO intake_imports (id, project_id, receipt_id, hold_id) VALUES ($1, $2, $3, $4)",
    [importId, projectId, receiptId, hold.id],
  );
  const result = { importId, receiptId, status: "queued" as const, holdId: hold.id };
  await appendIntakeEvent(tx, projectId, receiptId, "intake.import_queued", result);
  return result;
}

export type ImportState = "queued" | "running" | "paused" | "completed" | "limited" | "failed" | "cancelled";
type ImportContext = ReceiptContext & { importId: string };
type ImportRow = { state: ImportState; hold_id: string; version: number; reason: string | null };

async function lockImport(tx: PoolClient, input: ImportContext): Promise<ImportRow> {
  await lockIntakeProject(tx, input.projectId);
  const { rows: [previous] } = await tx.query<ImportRow>(
    `SELECT state, hold_id, version, reason FROM intake_imports
       WHERE id = $1 AND receipt_id = $2 AND project_id = $3 FOR UPDATE`,
    [input.importId, input.receiptId, input.projectId],
  );
  if (!previous) notFound();
  return previous;
}

const importTransitions: Record<ImportState, ImportState[]> = {
  queued: ["running", "paused", "failed"],
  running: ["paused", "completed", "limited", "failed"],
  paused: ["queued", "running", "failed"],
  completed: [],
  limited: [],
  failed: ["queued", "running"],
  cancelled: [],
};

export async function updateImport(tx: PoolClient, input: ImportContext & {
  status: Exclude<ImportState, "cancelled">; reason?: string; expectedVersion?: number;
}) {
  const current = await lockImport(tx, input);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    conflict("import_version_mismatch", "Import state changed");
  }
  if (current.state === input.status && current.reason === (input.reason ?? null)) {
    return { importId: input.importId, status: current.state, version: current.version };
  }
  if (current.state !== input.status && !importTransitions[current.state].includes(input.status)) {
    conflict("import_transition_denied", "Import cannot enter this state");
  }
  return await storeImportState(tx, input, input.status, input.reason);
}

export async function cancelImport(tx: PoolClient, input: ImportContext) {
  await lockIntakeProject(tx, input.projectId);
  await lockProjectScopes(tx, input.projectId);
  const current = await lockImport(tx, input);
  if (current.state === "cancelled") return { importId: input.importId, status: current.state, version: current.version };
  const occupied = await tx.query(
    `SELECT 1 FROM intake_occurrences WHERE import_id = $1 AND state IN ('declared', 'accepted') LIMIT 1`,
    [input.importId],
  );
  if (current.state === "running" || occupied.rowCount) {
    conflict("import_not_empty", "Stop the import and resolve its active inputs first");
  }
  await closeEmptyHold(tx, input.projectId, current.hold_id);
  return await storeImportState(tx, input, "cancelled");
}

async function storeImportState(tx: PoolClient, input: ImportContext, status: ImportState, reason?: string) {
  if (reason !== undefined && !/^[a-z0-9_.-]{1,100}$/.test(reason)) invalid("invalid_reason", "Expected a status code");
  const { rows: [{ version }] } = await tx.query<{ version: number }>(
    "UPDATE intake_imports SET state = $2, reason = $3, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING version",
    [input.importId, status, reason ?? null],
  );
  const result = { importId: input.importId, status, version };
  await appendIntakeEvent(tx, input.projectId, input.receiptId, "intake.import_updated", result);
  return result;
}

export async function completeOccurrenceInventory(tx: PoolClient, input: ReceiptContext & {
  occurrenceId: string; restriction?: string;
}) {
  const { projectId, receiptId, occurrenceId } = input;
  await lockIntakeProject(tx, projectId);
  if (input.restriction !== undefined && !/^[a-z0-9_.-]{1,100}$/.test(input.restriction)) {
    invalid("invalid_reason", "Expected a status code");
  }
  const { rowCount } = await tx.query(
    `UPDATE intake_occurrences SET inventory_pending = false, restriction = $4
      WHERE project_id = $1 AND receipt_id = $2 AND id = $3 AND state = 'accepted' AND inventory_pending`,
    [projectId, receiptId, occurrenceId, input.restriction ?? null],
  );
  if (rowCount) await appendIntakeEvent(tx, projectId, receiptId, "intake.occurrence_inventory_complete", { occurrenceId });
}

const inventoryOpen = `(r.sealed_at IS NULL OR EXISTS (
    SELECT 1 FROM intake_occurrences o WHERE o.receipt_id = r.id AND (o.state = 'declared' OR o.inventory_pending)
  ) OR EXISTS (
    SELECT 1 FROM intake_imports i WHERE i.receipt_id = r.id AND i.state IN ('queued', 'running', 'paused')
  ))`;

export async function listReceipts(db: Pool, input: { projectId: string; uploading: boolean; before: number | null }) {
  const { rows } = await db.query<{
    receiptId: string; number: string; sealed: boolean; inventoryOpen: boolean; source: string; createdAt: Date;
  }>(
    `SELECT r.id AS "receiptId", r.number, r.sealed_at IS NOT NULL AS sealed, ${inventoryOpen} AS "inventoryOpen",
            source, created_at AS "createdAt"
       FROM intake_receipts r WHERE project_id = $1 AND (NOT $2 OR ${inventoryOpen})
        AND ($3::bigint IS NULL OR r.number < $3) ORDER BY r.number DESC LIMIT 51`,
    [input.projectId, input.uploading, input.before],
  );
  const receipts = rows.slice(0, 50).map((r) => ({ ...r, number: Number(r.number) }));
  return { receipts, nextCursor: rows.length > 50 ? receipts.at(-1)?.number : null };
}

export async function getInventory(db: Pool, input: ReceiptContext) {
  const { rows: [receipt] } = await db.query<{ number: string; sealed: boolean; inventoryOpen: boolean }>(
    `SELECT r.number, r.sealed_at IS NOT NULL AS sealed, ${inventoryOpen} AS "inventoryOpen",
            COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'uploadId', u.id, 'occurrenceId', u.occurrence_id, 'status', u.state,
                 'size', u.size, 'sha256', u.sha256, 'partSize', u.part_size, 'expiresAt', u.expires_at,
                 'confirmedBytes', COALESCE((SELECT SUM(length) FROM intake_parts WHERE upload_id = u.id), 0)
               ) ORDER BY u.created_at, u.id) FROM intake_uploads u WHERE u.receipt_id = r.id
            ), '[]') AS uploads,
            COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'occurrenceId', o.id, 'relativePath', o.relative_path, 'parentOccurrenceId', o.parent_occurrence_id,
                 'importId', o.import_id, 'status', o.state, 'inventoryPending', o.inventory_pending,
                 'restriction', o.restriction, 'mediaType', COALESCE(v.media_type, o.declared_media_type),
                 'versionId', o.version_id, 'documentId', v.document_id, 'originalId', v.original_id,
                 'size', b.size, 'sha256', b.sha256
               ) ORDER BY o.created_at, o.id)
               FROM intake_occurrences o LEFT JOIN intake_document_versions v ON v.id = o.version_id
               LEFT JOIN intake_originals b ON b.id = v.original_id WHERE o.receipt_id = r.id
            ), '[]') AS occurrences,
            COALESCE((
               SELECT jsonb_agg(jsonb_build_object('importId', i.id, 'status', i.state, 'reason', i.reason,
                                                   'version', i.version) ORDER BY i.created_at, i.id)
               FROM intake_imports i WHERE i.receipt_id = r.id
            ), '[]') AS imports
       FROM intake_receipts r WHERE r.id = $1 AND r.project_id = $2`,
    [input.receiptId, input.projectId],
  );
  if (!receipt) notFound();
  return { ...receipt, number: Number(receipt.number), receiptId: input.receiptId };
}
