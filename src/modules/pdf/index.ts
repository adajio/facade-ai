import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authorize, readSession, touchSession } from '../access/auth.js';
import { unavailable } from '../access/errors.js';
import { createFormatAdapters, resolveFormat } from '../formats/index.js';
import { getOriginal } from '../intake/content.js';
import { createIntakeStorage, type IntakeStorage, type ObjectStore } from '../intake/blob.js';
import { createPdfAdapter } from './pdf-adapter.js';
import { createReaderService, isReaderId, type ReaderDependencies } from './service.js';
import { type ArtifactStore, type Box, type DocumentKey, type ReaderAdapter, type ReadScope, type SourceRef, ReaderError } from './types.js';

export * from './types.js';
export { createPdfAdapter } from './pdf-adapter.js';
export { createReaderService, type ReaderDependencies } from './service.js';

export function createPdfService(db: Pool, deps: ReaderDependencies, additional: readonly ReaderAdapter[] = []) {
  const reader = createReaderService(db, deps, [createPdfAdapter({
    ocrLanguages: process.env.FACADE_PDF_OCR_LANGUAGES,
    profile: process.env.FACADE_READER_PROFILE,
  }), ...additional]);

  const address = (page: number, box?: Box) => {
    if (!Number.isSafeInteger(page) || page < 1) throw new ReaderError('reader_address_invalid', 'Неверный номер страницы', 422);
    return { unitId: String(page), box };
  };
  return {
    ...reader,
    page(source: SourceRef, scope: ReadScope, page: number) {
      return reader.open(source, scope, { representation: 'render', address: address(page) });
    },
    zoom(source: SourceRef, scope: ReadScope, input: { page: number; box: Box; dpi?: number }) {
      if (!input.box) throw new ReaderError('reader_address_invalid', 'Для увеличения нужна рамка', 422);
      return reader.open(source, scope, { representation: 'render', address: address(input.page, input.box), dpi: input.dpi });
    },
    native(source: SourceRef, scope: ReadScope, input: { page: number; box?: Box }) {
      return reader.open(source, scope, { representation: 'native', address: address(input.page, input.box) });
    },
    search(source: SourceRef, scope: ReadScope, input: { page: number; box?: Box; query: string }) {
      return reader.open(source, scope, {
        representation: 'native', address: address(input.page, input.box), query: input.query,
      });
    },
    ocr(source: SourceRef, scope: ReadScope, input: { page: number; box?: Box; dpi?: number }) {
      return reader.open(source, scope, { representation: 'ocr', address: address(input.page, input.box), dpi: input.dpi });
    },
  };
}

function artifactsIn(store: ObjectStore): ArtifactStore {
  const key = (projectId: string, hash: string) => `reader-evidence/${projectId}/${hash}`;
  return {
    async put(projectId, sha256, bytes) {
      const objectKey = key(projectId, sha256);
      const current = await store.head(objectKey);
      if (current) {
        if (current.sha256 !== sha256 || current.size !== bytes.length) {
          throw new ReaderError('reader_artifact_mismatch', 'Нарушена целостность сохранённого представления', 424);
        }
        return;
      }
      await store.put(objectKey, { sha256, size: bytes.length }, Readable.from([bytes], { objectMode: false }));
    },
    async get(projectId, sha256, size) {
      const object = await store.get(key(projectId, sha256));
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of object) {
        received += chunk.length;
        if (received > size) throw new Error('Reader artifact exceeds recorded size');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, received);
    },
  };
}

export function createRuntimePdfService(
  db: Pool,
  config: { dataDir: string },
  options: { storage?: IntakeStorage; adapters?: readonly ReaderAdapter[] } = {},
) {
  const adapters = options.adapters ?? createFormatAdapters();
  const formats = new Set(['pdf', ...adapters.map(({ format }) => format)]);
  const storage = options.storage ?? createIntakeStorage(config.dataDir);
  const maxOriginalBytes = Number(process.env.FACADE_READER_MAX_ORIGINAL_BYTES ?? 512 * 1024 ** 2);
  if (!Number.isSafeInteger(maxOriginalBytes) || maxOriginalBytes < 1) {
    throw new Error('Invalid FACADE_READER_MAX_ORIGINAL_BYTES');
  }
  const service = createPdfService(db, {
    artifacts: artifactsIn(storage.objects),
    scratchDir: join(config.dataDir, 'reader-scratch'),
    scratchReserveBytes: storage.diskGuardBytes,
    maxOriginalBytes,
    async resolveOriginal(document) {
      const { rows: [assignment] } = await db.query<{ receipt_id: string }>(
        `SELECT receipt_id FROM intake_reader_jobs
         WHERE project_id = $1 AND document_id = $2 AND version_id = $3`,
        [document.projectId, document.documentId, document.versionId],
      );
      if (!assignment) return null;
      const original = await getOriginal(db, storage, document.projectId, document.versionId, document.documentId);
      const inferred = resolveFormat(original.relativePath);
      const format = original.mediaType === 'application/pdf' ? 'pdf' : formats.has(inferred) ? inferred : 'unknown';
      return {
        ...document, receiptId: assignment.receipt_id, sha256: original.sha256, size: original.size, format,
        relativePath: original.relativePath, open: () => original.open(),
      };
    },
  }, adapters);
  return {
    ...service,
    close: () => { if (!options.storage) storage.objects.close(); },
  };
}

type EvidenceRoute = { Params: { id: string } };
type UnitsRoute = { Params: { documentId: string; versionId: string } };

export async function register(
  app: FastifyInstance, options: Parameters<typeof createRuntimePdfService>[2] = {},
): Promise<void> {
  let service: ReturnType<typeof createRuntimePdfService> | undefined;
  const reader = () => service ??= createRuntimePdfService(app.db, app.config, options);
  app.addHook('onClose', async () => { service?.close(); });
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

  async function projectFor(request: FastifyRequest, table: 'reader_evidence' | 'reader_observations', id: string) {
    const session = await readSession(app.db, request);
    if (!isReaderId(id)) throw unavailable();
    const { rows } = await app.db.query<{ project_id: string; scope?: string }>(
      table === 'reader_observations'
        ? `SELECT project_id, scope_id AS scope FROM reader_observations WHERE id = $1`
        : 'SELECT project_id FROM reader_evidence WHERE id = $1', [id],
    );
    if (!rows[0]) throw unavailable();
    const { project_id: projectId, scope } = rows[0];
    await authorize(app.db, session, { action: 'project:read', projectId, scopeId: scope });
    await touchSession(app.db, session);
    return projectId;
  }

  async function authorizedEvidence(request: FastifyRequest<EvidenceRoute>) {
    const { id } = request.params;
    const projectId = await projectFor(request, 'reader_evidence', id);
    const evidence = await reader().findEvidence(projectId, id);
    if (!evidence) throw unavailable();
    return evidence;
  }

  app.get<UnitsRoute>('/api/v1/documents/:documentId/versions/:versionId/reader/units', async (request) => {
    const { documentId, versionId } = request.params;
    const session = await readSession(app.db, request);
    if (!isReaderId(documentId) || !isReaderId(versionId)) throw unavailable();
    const { rows } = await app.db.query<{ project_id: string }>(
      'SELECT project_id FROM intake_document_versions WHERE document_id = $1 AND id = $2', [documentId, versionId],
    );
    if (!rows[0]) throw unavailable();
    const document: DocumentKey = { projectId: rows[0].project_id, documentId, versionId };
    await authorize(app.db, session, { action: 'project:read', projectId: document.projectId });
    await touchSession(app.db, session);
    const map = await reader().latestMap(document);
    if (!map) throw new ReaderError('reader_map_unavailable', 'Карта оригинала ещё недоступна', 404);
    return map;
  });

  app.get<EvidenceRoute>('/api/v1/evidence/:id', async (request) => {
    const evidence = await authorizedEvidence(request);
    const href = `/api/v1/evidence/${evidence.id}`;
    return {
      ...evidence, source: { ...evidence.source, relativePath: evidence.relativePath },
      contentUrl: `${href}/content`,
      inputImage: evidence.inputImage && { ...evidence.inputImage, url: `${href}/ocr-input` },
      originalHref: `/api/documents/${evidence.source.documentId}/versions/${evidence.source.versionId}/content`,
    };
  });

  app.get<EvidenceRoute>('/api/v1/evidence/:id/content', async (request, reply) => {
    const evidence = await authorizedEvidence(request);
    return reply.header('X-Content-Type-Options', 'nosniff')
      .type(evidence.mediaType).send(await reader().content(evidence));
  });

  app.get<EvidenceRoute>('/api/v1/evidence/:id/ocr-input', async (request, reply) => {
    const evidence = await authorizedEvidence(request);
    return reply.header('X-Content-Type-Options', 'nosniff')
      .type('image/png').send(await reader().content(evidence, 'ocr-input'));
  });

  app.get<EvidenceRoute>('/api/v1/observations/:id', async (request) => {
    const { id } = request.params;
    const projectId = await projectFor(request, 'reader_observations', id);
    const observation = await reader().findObservation(projectId, id);
    if (!observation) throw unavailable();
    return { ...observation, evidenceHref: `/api/v1/evidence/${observation.evidenceId}` };
  });
}
