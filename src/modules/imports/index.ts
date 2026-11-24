import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { accessConfig, checkCsrf, checkOrigin, readCookie, requireAccess } from "../access/auth.js";
import { executeCommand } from "../access/commands.js";
import { unauthenticated, unavailable } from "../access/errors.js";
import { parseScopeIds, uuid } from "../intake/inputs.js";
import { lockIntakeProject } from "../intake/gate.js";
import { cancelImport, updateImport } from "../intake/receipts.js";
import { queuePublicImport } from "./intake-source.js";
import { ImportIssue, importLimits } from "./policy.js";
import { findJob, jobView, setStatus, tryJobLock } from "./state.js";
import type { Job } from "./state.js";
import { publicShare } from "./yandex.js";

export { queueArchive } from "./archive-queue.js";
export { startImports } from "./worker.js";

async function receiptProject(db: Pool, request: FastifyRequest, receiptId: string): Promise<string> {
  await requireAccess(db, request, { action: "session" });
  const { rows: [row] } = await db.query<{ project_id: string }>(
    "SELECT project_id FROM intake_receipts WHERE id=$1", [receiptId],
  );
  if (!row) throw unavailable();
  return row.project_id;
}

function params(request: FastifyRequest) {
  return request.params as { receiptId: string; importId?: string };
}

export async function register(app: FastifyInstance): Promise<void> {
  const access = accessConfig();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST") {
      const cookie = readCookie(request);
      if (!cookie) throw unauthenticated();
      checkOrigin(request, access);
      checkCsrf(request, cookie);
    }
  });

  app.get("/api/imports/capabilities", async request => {
    await requireAccess(app.db, request, { action: "session" });
    return {
      channels: ["upload", "yandex_disk"],
      archiveFormats: ["zip", "rar", "7z"],
      limits: importLimits,
      archiveIsolationConfigured: Boolean(process.env.FACADE_CONVERTER_SOCKET),
    };
  });

  app.post("/api/receipts/:receiptId/imports", async (request, reply) => {
    const receiptId = uuid(params(request).receiptId);
    const projectId = await receiptProject(app.db, request, receiptId);
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
      Object.keys(request.body).some(key => key !== "url" && key !== "scopeIds")) {
      throw new ImportIssue("invalid_import_body");
    }
    const body = request.body as { url?: unknown; scopeIds?: unknown };
    const url = publicShare(body?.url);
    const scopeIds = parseScopeIds(body?.scopeIds);
    const result = await executeCommand(app.db, request, {
      operation: "imports.create",
      requirement: { action: "project:engineer", projectId },
      input: { receiptId, url, scopeIds },
    }, async (tx, actor) => {
      for (const scopeId of scopeIds ?? []) {
        await requireAccess(tx, request, { action: "project:engineer", projectId, scopeId });
      }
      const queued = await queuePublicImport(tx, { projectId, receiptId, actorId: actor.userId, url, scopeIds });
      return { status: 202, body: queued, audit: { objectId: queued.importId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/receipts/:receiptId/imports", async request => {
    const receiptId = uuid(params(request).receiptId);
    const projectId = await receiptProject(app.db, request, receiptId);
    await requireAccess(app.db, request, { action: "project:read", projectId });
    const { rows } = await app.db.query<Job>(
      `SELECT * FROM import_jobs WHERE receipt_id=$1 AND project_id=$2
       AND source_url IS NOT NULL ORDER BY created_at,id`,
      [receiptId, projectId],
    );
    return { imports: rows.map(jobView) };
  });

  app.post("/api/receipts/:receiptId/imports/:importId/cancel", async (request, reply) => {
    const receiptId = uuid(params(request).receiptId);
    const importId = uuid(params(request).importId);
    if (request.body != null && (typeof request.body !== "object" || Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0)) throw new ImportIssue("invalid_import_body");
    const projectId = await receiptProject(app.db, request, receiptId);
    const result = await executeCommand(app.db, request, {
      operation: "imports.cancel",
      requirement: { action: "project:engineer", projectId },
      input: { receiptId, importId },
    }, async tx => {
      if (!await tryJobLock(tx, importId, false)) {
        throw new ImportIssue("import_running", false, 409);
      }
      const job = await findJob(tx, receiptId, importId);
      await lockIntakeProject(tx, projectId);
      const { rowCount } = await tx.query("SELECT 1 FROM intake_manifest_items WHERE import_id=$1", [importId]);
      if (rowCount) throw new ImportIssue("manifest_exclusion_reason_required", false, 409);
      const occupied = await tx.query(
        `SELECT 1 FROM intake_occurrences
           WHERE receipt_id=$1 AND (state='accepted' OR (import_id=$2 AND state='declared'))
         UNION ALL
         SELECT 1 FROM intake_imports WHERE receipt_id=$1 AND id<>$2 AND state='running'
         LIMIT 1`,
        [receiptId, importId],
      );
      if (occupied.rowCount) throw new ImportIssue("import_not_empty", false, 409);
      if (job.status === "running") {
        // A granted transaction lock proves the old worker session has gone away.
        await updateImport(tx, { projectId, receiptId, importId, status: "paused", reason: "worker_interrupted" });
      }
      const cancelled = await cancelImport(tx, { projectId, receiptId, importId });
      await setStatus(tx, job, "cancelled");
      return { body: cancelled, audit: { objectId: importId, version: cancelled.version } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/receipts/:receiptId/archive-inventory/:occurrenceId", async request => {
    const { receiptId: rawReceiptId, occurrenceId: rawOccurrenceId } =
      request.params as { receiptId: string; occurrenceId: string };
    const receiptId = uuid(rawReceiptId);
    const occurrenceId = uuid(rawOccurrenceId);
    const projectId = await receiptProject(app.db, request, receiptId);
    await requireAccess(app.db, request, { action: "project:read", projectId });
    const { rows: [archive] } = await app.db.query<Job>(
      "SELECT * FROM import_jobs WHERE receipt_id=$1 AND project_id=$2 AND occurrence_id=$3",
      [receiptId, projectId, occurrenceId],
    );
    if (!archive) throw new ImportIssue("archive_not_found", false, 404);
    return {
      occurrenceId, versionId: archive.version_id, depth: archive.depth, state: archive.status,
      reason: archive.reason, unknownRemainder: archive.status !== "completed",
    };
  });

  app.get("/api/receipts/:receiptId/import-inventory", async request => {
    const receiptId = uuid(params(request).receiptId);
    const projectId = await receiptProject(app.db, request, receiptId);
    await requireAccess(app.db, request, { action: "project:read", projectId });
    const query = request.query as { cursor?: string; limit?: string; sourceId?: string };
    const sourceId = query.sourceId === undefined ? null : uuid(query.sourceId);
    const cursor = query.cursor === undefined ? null : uuid(query.cursor);
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ImportIssue("invalid_inventory_limit");
    const { rows } = await app.db.query<{ id: string; size: string }>(
      `SELECT e.id, job.id AS "sourceId", job.occurrence_id AS "containerOccurrenceId",
        e.parent_id AS "parentId", e.original_path AS "originalPath", e.relative_path AS "relativePath",
        e.kind, e.ordinal, e.state AS status, e.reason, e.observed_bytes AS size,
        e.sha256, e.media_type AS "mediaType", e.occurrence_id AS "occurrenceId",
        e.version_id AS "versionId", e.upload_id AS "uploadId"
      FROM import_inventory_entries e JOIN import_jobs job ON job.id=e.job_id
      WHERE e.receipt_id=$1 AND job.project_id=$2 AND ($3::uuid IS NULL OR e.id>$3)
        AND ($5::uuid IS NULL OR job.id=$5)
      ORDER BY e.id LIMIT $4`,
      [receiptId, projectId, cursor, limit + 1, sourceId],
    );
    return {
      entries: rows.slice(0, limit).map(row => ({ ...row, size: Number(row.size) })),
      nextCursor: rows.length > limit ? rows[limit - 1]?.id : null,
    };
  });
}
