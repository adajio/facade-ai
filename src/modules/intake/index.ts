import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { requireAccess, requireMutationProtection } from "../access/auth.js";
import type { AccessRequirement } from "../access/auth.js";
import { executeCommand } from "../access/commands.js";
import { createIntakeStorage, MAX_RECEIPT_BYTES } from "./blob.js";
import type { IntakeStorage } from "./blob.js";
import { getOriginal, parseRange } from "./content.js";
import { IntakeError, invalid, notFound } from "./errors.js";
import { checksum, parseMediaType, parsePath, parseScopeIds, parseSize, uuid } from "./inputs.js";
import { parseExclusionReason, parseManifestItems, parseManifestMode, parseManifestVersion } from "./manifest.js";
import { appendManifestItems, excludeManifestItem, retryManifestLink, startManifestUpload, storeManifestItems } from "./manifest-commands.js";
import { createReceipt, getInventory, listReceipts, sealReceipt } from "./receipts.js";
import { cleanIntakeUploads, declareOriginal, getUpload, prepareOriginal, publishPreparedOriginal, retireUpload, writePart } from "./uploads.js";

export { createIntakeStorage } from "./blob.js";
export type { IntakeStorage, ObjectStore } from "./blob.js";
export { openOriginal } from "./content.js";
export { getIntakeGate, lockIntakeProject, resolveIntakeHold } from "./gate.js";
export { cancelImport, completeOccurrenceInventory, declareImport, updateImport } from "./receipts.js";
export { cleanIntakeUploads, declareOriginal, finalizeOriginal, intakeUnwrittenBytes, lockDiskReservations, writePart } from "./uploads.js";

function parameters(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) invalid("invalid_body", "Expected an object");
  return value as Record<string, unknown>;
}

function emptyBody(request: FastifyRequest) {
  if (Object.keys(jsonBody(request)).length !== 0) invalid("invalid_body", "Expected an empty object");
}

function engineer(projectId: string): AccessRequirement {
  return { projectId, action: "project:engineer" };
}

function checkItemScopes(tx: PoolClient, request: FastifyRequest, projectId: string) {
  return async (scopeIds: string[] | null | undefined) => {
    for (const scopeId of scopeIds ?? []) {
      await requireAccess(tx, request, { projectId, scopeId, action: "project:engineer" });
    }
  };
}

async function relatedProject(
  db: Pool, table: "intake_receipts" | "intake_uploads" | "intake_document_versions", id: string, documentId?: string,
): Promise<string> {
  const { rows: [row] } = await db.query<{ project_id: string }>(
    `SELECT project_id FROM ${table} WHERE id = $1${documentId ? " AND document_id = $2" : ""}`,
    documentId ? [id, documentId] : [id],
  );
  if (!row) notFound();
  return row.project_id;
}

async function relatedProjectWithSession(db: Pool, request: FastifyRequest, receiptId: string) {
  await requireAccess(db, request, { action: "session" });
  return await relatedProject(db, "intake_receipts", receiptId);
}

function integer(value: unknown, code: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid(code, "Expected a nonnegative integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid(code, "Integer is out of range");
  return number;
}

function attachment(path: string): string {
  const name = path.split("/").at(-1) ?? "original";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return `attachment; filename="original"; filename*=UTF-8''${encoded}`;
}

async function registerRoutes(app: FastifyInstance, storage: () => IntakeStorage): Promise<void> {
  const { db } = app;
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    requireMutationProtection(request);
  });

  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));

  app.get("/api/projects/:projectId/intake/capabilities", async (request) => {
    const projectId = uuid(parameters(request).projectId);
    await requireAccess(db, request, { projectId, action: "project:read" });
    const { partSize, ttlSeconds, diskGuardBytes } = storage();
    return {
      partSize, maxReceiptBytes: MAX_RECEIPT_BYTES, uploadTtlSeconds: ttlSeconds, diskGuardBytes,
      channels: ["upload"],
    };
  });

  app.post("/api/projects/:projectId/receipts", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const projectId = uuid(parameters(request).projectId);
    const raw = jsonBody(request);
    const mode = raw.mode === undefined && raw.items === undefined ? undefined : parseManifestMode(raw.mode);
    const items = mode ? parseManifestItems(raw.items) : undefined;
    const receiptId = mode && raw.receiptId != null ? uuid(raw.receiptId) : undefined;
    const source = raw.source ?? (items?.every(item => item.kind === "link") ? "import" : "upload");
    if (source !== "upload" && source !== "import") invalid("invalid_receipt_source", "Unknown receipt source");
    const result = await executeCommand(db, request, {
      operation: "intake.create_receipt", requirement: engineer(projectId), input: { source, mode, receiptId },
    }, async (tx, actor) => {
      const body = await createReceipt(tx, { projectId, source, createdBy: actor.userId, receiptId, mode });
      if (items) await storeManifestItems(tx, { projectId, receiptId: body.receiptId, actorId: actor.userId },
        1, items, checkItemScopes(tx, request, projectId));
      return { body, status: 201, audit: { objectId: body.receiptId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/projects/:projectId/receipts", async (request) => {
    const projectId = uuid(parameters(request).projectId);
    await requireAccess(db, request, { projectId, action: "project:read" });
    const query = request.query as Record<string, unknown>;
    return await listReceipts(db, { projectId, uploading: query.state === "uploading",
      before: query.cursor === undefined ? null : integer(query.cursor, "invalid_cursor") });
  });

  app.get("/api/receipts/:receiptId/inventory", async (request) => {
    const receiptId = uuid(parameters(request).receiptId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_receipts", receiptId);
    await requireAccess(db, request, { projectId, action: "project:read" });
    return await getInventory(db, { projectId, receiptId });
  });

  app.post("/api/receipts/:receiptId/seal", async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_receipts", receiptId);
    const raw = jsonBody(request);
    if (Object.keys(raw).some(key => key !== "manifestVersion")) invalid("invalid_body", "Ожидается версия состава.");
    const manifestVersion = raw.manifestVersion === undefined ? undefined : parseManifestVersion(raw.manifestVersion);
    const input = { projectId, receiptId, manifestVersion };
    const result = await executeCommand(db, request, {
      operation: "intake.seal", requirement: engineer(projectId), input: { receiptId, manifestVersion },
    }, async (tx) => ({ body: await sealReceipt(tx, input), audit: { objectId: receiptId } }));
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/receipts/:receiptId/manifest", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    const projectId = await relatedProjectWithSession(db, request, receiptId);
    const raw = jsonBody(request);
    const manifestVersion = parseManifestVersion(raw.manifestVersion);
    const items = parseManifestItems(raw.items);
    const result = await executeCommand(db, request, {
      operation: "intake.manifest_append", requirement: engineer(projectId), input: { receiptId, manifestVersion },
    }, async (tx, actor) => {
      const body = await appendManifestItems(tx, { projectId, receiptId, manifestVersion, actorId: actor.userId },
        items, checkItemScopes(tx, request, projectId));
      return { body, audit: { objectId: receiptId, version: body.manifestVersion } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/receipts/:receiptId/manifest/:itemId/upload", async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    const itemId = uuid(parameters(request).itemId);
    const projectId = await relatedProjectWithSession(db, request, receiptId);
    const raw = jsonBody(request);
    const restartUploadId = raw.restartUploadId == null ? null : uuid(raw.restartUploadId);
    const input = { projectId, receiptId, itemId, restartUploadId };
    const result = await executeCommand(db, request, {
      operation: "intake.manifest_upload", requirement: engineer(projectId), input,
    }, async (tx) => {
      const body = await startManifestUpload(tx, storage(), input, checkItemScopes(tx, request, projectId));
      return { body, status: 201, audit: { objectId: body.uploadId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/receipts/:receiptId/manifest/:itemId/exclude", async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    const itemId = uuid(parameters(request).itemId);
    const projectId = await relatedProjectWithSession(db, request, receiptId);
    const raw = jsonBody(request);
    const input = {
      projectId, receiptId, itemId, manifestVersion: parseManifestVersion(raw.manifestVersion),
      uploadId: raw.uploadId == null ? null : uuid(raw.uploadId),
      importId: raw.importId == null ? null : uuid(raw.importId),
      reason: parseExclusionReason(raw.reason),
    };
    const result = await executeCommand(db, request, {
      operation: "intake.manifest_exclude", requirement: engineer(projectId), input,
    }, async (tx, actor) => ({
      body: await excludeManifestItem(tx, { ...input, actorId: actor.userId }, checkItemScopes(tx, request, projectId)),
      audit: { objectId: itemId, version: input.manifestVersion },
    }));
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/receipts/:receiptId/manifest/:itemId/retry", async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    const itemId = uuid(parameters(request).itemId);
    const projectId = await relatedProjectWithSession(db, request, receiptId);
    const importId = uuid(jsonBody(request).importId);
    const input = { projectId, receiptId, itemId, importId };
    const result = await executeCommand(db, request, {
      operation: "intake.manifest_retry_import", requirement: engineer(projectId), input,
    }, async (tx) => ({
      body: await retryManifestLink(tx, input, checkItemScopes(tx, request, projectId)),
      audit: { objectId: itemId },
    }));
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/receipts/:receiptId/uploads", async (request, reply) => {
    const receiptId = uuid(parameters(request).receiptId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_receipts", receiptId);
    const body = jsonBody(request);
    const input = {
      receiptId, projectId, relativePath: parsePath(body.relativePath), size: parseSize(body.size),
      sha256: checksum(body.sha256), mediaType: parseMediaType(body.mediaType), scopeIds: parseScopeIds(body.scopeIds),
      replacesVersionId: body.replacesVersionId == null ? undefined : uuid(body.replacesVersionId),
    };
    const result = await executeCommand(db, request, {
      operation: "intake.declare", requirement: engineer(projectId), input,
    }, async (tx) => {
      for (const scopeId of input.scopeIds ?? []) {
        await requireAccess(tx, request, { projectId, scopeId, action: "project:engineer" });
      }
      const declared = await declareOriginal(tx, storage(), input);
      return { body: declared, status: 201, audit: { objectId: declared.uploadId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/uploads/:uploadId", async (request) => {
    const uploadId = uuid(parameters(request).uploadId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_uploads", uploadId);
    await requireAccess(db, request, { projectId, action: "project:read" });
    return await getUpload(db, { projectId, uploadId });
  });

  app.put("/api/uploads/:uploadId/parts/:number", async (request) => {
    const uploadId = uuid(parameters(request).uploadId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_uploads", uploadId);
    const { body, headers } = request;
    if (!(body instanceof Readable)) throw new IntakeError(415, "invalid_content_type", "Expected application/octet-stream");
    const number = integer(parameters(request).number, "invalid_part_number");
    const length = integer(headers["content-length"], "invalid_part_length");
    const sha256 = checksum(headers["x-part-sha256"]);
    return await writePart(db, storage(), { projectId, uploadId, number, length, sha256 }, body, async (tx) => {
      await requireAccess(tx, request, engineer(projectId));
    });
  });

  app.post("/api/uploads/:uploadId/complete", async (request, reply) => {
    const uploadId = uuid(parameters(request).uploadId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_uploads", uploadId);
    emptyBody(request);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\w.:~-]{1,160}$/.test(key)) {
      invalid("idempotency_key_required", "Supply an Idempotency-Key");
    }
    const input = { projectId, uploadId };
    const prepared = await prepareOriginal(db, storage(), input, async (tx) => {
      await requireAccess(tx, request, engineer(projectId));
    });
    const result = await executeCommand(db, request, {
      operation: "intake.complete", requirement: engineer(projectId), input,
    }, async (tx) => {
      const body = await publishPreparedOriginal(tx, input, prepared);
      return { body, audit: { objectId: uploadId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/uploads/:uploadId/cancel", async (request, reply) => {
    const uploadId = uuid(parameters(request).uploadId);
    await requireAccess(db, request, { action: "session" });
    const projectId = await relatedProject(db, "intake_uploads", uploadId);
    emptyBody(request);
    const input = { projectId, uploadId };
    const result = await executeCommand(db, request, {
      operation: "intake.cancel", requirement: engineer(projectId), input,
    }, async (tx) => ({ body: await retireUpload(tx, input, "cancelled"), audit: { objectId: uploadId } }));
    return reply.code(result.status).send(result.body);
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/documents/:documentId/versions/:versionId/content",
    handler: async (request, reply) => {
      const documentId = uuid(parameters(request).documentId);
      const versionId = uuid(parameters(request).versionId);
      await requireAccess(db, request, { action: "session" });
      const projectId = await relatedProject(db, "intake_document_versions", versionId, documentId);
      await requireAccess(db, request, { projectId, action: "project:read" });
      const original = await getOriginal(db, storage(), projectId, versionId, documentId);
      const etag = `"sha256-${original.sha256}"`;
      reply.header("Accept-Ranges", "bytes").header("ETag", etag).header("X-Content-Type-Options", "nosniff");
      const ifRange = request.headers["if-range"];
      let range;
      if (request.method === "GET" && request.headers.range && (!ifRange || ifRange === etag)) {
        try {
          range = parseRange(request.headers.range, original.size);
        } catch (error) {
          if (error instanceof IntakeError && error.statusCode === 416) reply.header("Content-Range", `bytes */${original.size}`);
          throw error;
        }
      }
      const pdf = original.mediaType === "application/pdf";
      reply.type(pdf ? "application/pdf" : "application/octet-stream");
      if (!pdf) reply.header("Content-Disposition", attachment(original.relativePath));
      if (request.method === "HEAD") {
        await original.check();
        return reply.header("Content-Length", original.size).send();
      }
      const stream = await original.open(range);
      if (!range) return reply.header("Content-Length", original.size).send(stream);
      return reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${original.size}`)
        .header("Content-Length", range.end - range.start + 1).send(stream);
    },
  });
}

export async function register(app: FastifyInstance): Promise<void> {
  let current: IntakeStorage | undefined;
  const storage = () => current ??= createIntakeStorage(app.config.dataDir);
  await registerRoutes(app, storage);
  let cleanup: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (cleanup || !process.env.FACADE_S3_ENDPOINT || !process.env.FACADE_S3_BUCKET) return;
    cleanup = cleanIntakeUploads(app.db, storage()).catch(() => {
      app.log.warn("Intake upload cleanup will retry");
    }).finally(() => { cleanup = undefined; });
  }, 30_000).unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await cleanup;
    current?.objects.close();
  });
}
