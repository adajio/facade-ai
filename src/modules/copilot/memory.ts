import { copilotOcrOperation } from './admission.js';
import type { Pool } from 'pg';
import type { SessionAccount } from '../access/auth.js';
import { AccessError } from '../access/index.js';
import type { createRuntimePdfService } from '../pdf/index.js';
import { ReaderError, type Evidence, type ReaderLine } from '../pdf/types.js';
import { readProjectMemory, searchProjectMemory, type MemoryHit } from '../project-memory/index.js';
import type { CopilotMemory, MemorySource } from './contracts.js';

type Reader = Pick<ReturnType<typeof createRuntimePdfService>, 'readMaterializedNative' | 'open' | 'findEvidence' | 'content'>;
type Version = Pick<MemorySource, 'documentId' | 'versionId' | 'sha256' | 'label' | 'version'> & { mediaType: string; receiptId: string; occurrenceId: string };
const blockDigest = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function readCopilotVersions(db: Pool, projectId: string, versionIds: string[]) {
  const { rows } = await db.query<Version>(
    `SELECT v.id AS "versionId",v.document_id AS "documentId",o.sha256,c.relative_path AS label,v.media_type AS "mediaType",
       c.receipt_id AS "receiptId",c.id AS "occurrenceId",
       CASE WHEN EXISTS (
         SELECT 1 FROM intake_document_versions successor JOIN intake_occurrences a
           ON a.project_id=successor.project_id AND a.version_id=successor.id AND a.state='accepted'
         WHERE successor.project_id=v.project_id AND successor.replaces_version_id=v.id
       ) THEN 'historical' ELSE 'current' END AS version
     FROM intake_document_versions v JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id
     JOIN LATERAL (SELECT id,receipt_id,relative_path FROM intake_occurrences
       WHERE project_id=v.project_id AND version_id=v.id AND state='accepted' ORDER BY created_at,id LIMIT 1) c ON true
     WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])`, [projectId, versionIds]);
  return new Map(rows.map((row) => [row.versionId, row]));
}

function key(snapshot: string, hit: Pick<MemoryHit, 'blockId' | 'lineId'>) {
  return snapshot + '.' + hit.blockId + '.' + Buffer.from(hit.lineId, 'utf8').toString('base64url');
}

function parseKey(id: string) {
  const [snapshot, blockId, encoded, ...rest] = id.split('.');
  if (rest.length || !snapshot || !blockId || !encoded || !blockDigest.test(snapshot) ||
      !blockDigest.test(blockId) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const lineId = Buffer.from(encoded, 'base64url').toString('utf8');
  return { snapshot, blockId, lineId };
}

function unavailable(error: unknown) {
  return error instanceof AccessError && error.statusCode === 404 ||
    error instanceof ReaderError && [404, 424].includes(error.statusCode);
}

async function ocrSource(db: Pool, projectId: string, evidence: Evidence, bytes: Buffer): Promise<MemorySource | null> {
  const source = (await readCopilotVersions(db, projectId, [evidence.source.versionId])).get(evidence.source.versionId);
  if (!source || source.sha256 !== evidence.source.sha256 || source.documentId !== evidence.source.documentId) return null;
  const { lines } = JSON.parse(bytes.toString('utf8')) as { lines: ReaderLine[] };
  const text = lines.map((line) => line.text).join('\n').trim();
  if (!text) return null;
  return {
    ...source, id: 'ocr.' + evidence.id, address: evidence.address, text: text.slice(0, 1800),
    readerVersion: evidence.readerVersion, representation: 'ocr', limitations: evidence.limitations,
    proof: { kind: 'evidence', evidenceId: evidence.id },
  };
}

export function createCopilotMemory(db: Pool, reader: () => Reader): CopilotMemory {
  return {
    async search(session, projectId, query) {
      const found = await searchProjectMemory(db, session, { projectId, query, limit: 20 });
      const ocrWindows = found.remaining.filter(({ remaining, address }) =>
        remaining.includes('ocr') && typeof address.locator?.page === 'number');
      const byVersion = Map.groupBy(ocrWindows, ({ versionId }) => versionId);
      const firstWindows = [...byVersion.values()].map(([first]) => first);
      const pending = [...new Set([...firstWindows, ...ocrWindows])].slice(0, 5);
      const records = [...found.hits, ...pending];
      const documents = await readCopilotVersions(db, projectId, [...new Set(records.flatMap(({ versionId }) => versionId ? [versionId] : []))]);
      const sources = found.hits.flatMap((hit) => {
        const source = hit.versionId ? documents.get(hit.versionId) : undefined;
        if (!source) return [];
        return [{
          ...source, id: key(found.snapshot, hit), address: hit.address, text: hit.text.slice(0, 1800),
          representation: 'native' as const, limitations: [], proof: { kind: 'memory' as const, blockId: hit.blockId },
        }];
      });
      const windows = pending.flatMap((block) => {
        const source = block.versionId ? documents.get(block.versionId) : undefined;
        return source ? [{
          ...source, id: key(found.snapshot, { blockId: block.blockId, lineId: '@window' }), address: block.address,
          text: '', window: true as const, representation: 'native' as const, limitations: block.limitations,
          proof: { kind: 'memory' as const, blockId: block.blockId },
        }] : [];
      });
      return {
        sources, windows, limitations: [
          ...found.limitations,
          ...(found.status !== 'ready' ? ['Поиск охватывает проиндексированные исходные представления.'] : []),
          ...(found.pendingBlocks ? [`Окон с остатком проверки: ${found.pendingBlocks}.`] : []),
          ...(found.truncated ? ['Показаны первые 20 совпадений. Уточните поисковую фразу.'] : []),
        ],
      };
    },
    async open(session, projectId, id) {
      try {
        if (id.startsWith('ocr.') && uuid.test(id.slice(4))) {
          const evidence = await reader().findEvidence(projectId, id.slice(4));
          if (!evidence || evidence.representation !== 'ocr') return null;
          return ocrSource(db, projectId, evidence, await reader().content(evidence));
        }
        const ref = parseKey(id);
        if (!ref) return null;
        const { block, lines, structure } = await readProjectMemory(db, reader(), session, { projectId, ...ref });
        if (!block.versionId) return null;
        const document = (await readCopilotVersions(db, projectId, [block.versionId])).get(block.versionId);
        if (!document) return null;
        const common = {
          ...document, id, readerVersion: block.readerVersion, representation: 'native' as const,
          limitations: block.limitations, proof: { kind: 'memory' as const, blockId: ref.blockId },
        };
        if (ref.lineId === '@window' && block.remaining.includes('ocr') && typeof block.address.locator?.page === 'number') {
          return { ...common, address: block.address, text: '', window: true };
        }
        const index = lines.findIndex(({ id }) => id === ref.lineId);
        if (index < 0) return null;
        const addressFor = (line: ReaderLine) => ({
          ...block.address, box: line.box ?? block.address.box, locator: { ...block.address.locator, ...line.locator },
        });
        const line = lines[index];
        const row = structure?.rows.find(({ lineIds }) => lineIds.includes(line.id))?.lineIds ?? [];
        const column = structure?.columns.find(({ lineIds }) => lineIds.includes(line.id))?.lineIds.slice(0, 2) ?? [];
        const ids = new Set([...row.slice(0, 12), ...column]);
        const neighbours = ids.size ? lines.filter(({ id }) => ids.has(id)) :
          [...lines.slice(0, Math.min(2, index)), ...lines.slice(Math.max(2, index - 2), index + 3)];
        const context = neighbours.filter(({ id }) => id !== line.id).slice(0, 12)
          .map((entry) => ({ id: entry.id, address: addressFor(entry), text: entry.text.slice(0, 300) }));
        return { ...common, address: addressFor(line), text: line.text.slice(0, 1800), context,
          limitations: [...common.limitations, ...(line.text.length > 1800 ? ['Текст места показан частично.'] : [])],
        };
      } catch (error) {
        if (unavailable(error)) return null;
        throw error;
      }
    },
    async searchPublications(session, projectId, scopeId, query) {
      const found = await searchProjectMemory(db, session, { projectId, scopeId, query, limit: 20 });
      return {
        sources: found.hits.map((hit) => ({ id: key(found.snapshot, hit), page: Number(hit.address.locator?.page), quote: hit.text })),
        limitations: [
          'Поиск по тексту действующих публикаций в выбранной области. Изображения доступны в разделе «Фрагменты».',
          ...(found.truncated ? ['Показаны первые 20 совпадений. Уточните поисковую фразу.'] : []),
        ],
      };
    },
    async openPublication(session, projectId, scopeId, id) {
      const ref = parseKey(id);
      if (!ref) return null;
      try {
        const { block, lines } = await readProjectMemory(db, reader(), session, { projectId, scopeId, ...ref });
        const line = lines.find(({ id }) => id === ref.lineId);
        return line ? { id, page: Number(block.address.locator?.page), quote: line.text } : null;
      } catch (error) {
        if (unavailable(error)) return null;
        throw error;
      }
    },
  };
}

export function createCopilotResearch(db: Pool, reader: Reader) {
  return async (_session: SessionAccount, projectId: string, source: MemorySource, jobId: string, addressKey?: string): Promise<MemorySource | null> => {
    try {
      const result = await reader.open(
        { projectId, documentId: source.documentId, versionId: source.versionId, sha256: source.sha256 },
        { runId: jobId, branch: 'A', operationKey: addressKey ? copilotOcrOperation + '/' + addressKey : copilotOcrOperation },
        { address: source.address, readerVersion: source.readerVersion, representation: 'ocr' },
      );
      return await ocrSource(db, projectId, result.evidence, result.bytes);
    } catch (error) {
      if (error instanceof ReaderError && [404, 415, 422, 424].includes(error.statusCode)) return null;
      throw error;
    }
  };
}
