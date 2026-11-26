import type { Pool, PoolClient } from 'pg';
import { verifyPhysicalInventory } from '../formats/physical-inventory.js';
import type { createRuntimePdfService } from '../pdf/index.js';
import { pdfPageFormat, ReaderError, type NativeBlock, type PageMap, type ReaderAddress, type SourceRef } from '../pdf/types.js';
import { blockId, folded, memoryVersion, type MemoryRemainder } from './contracts.js';

type MemoryIndexer = Pick<ReturnType<typeof createRuntimePdfService>, 'map' | 'materializeNative'>;
type Candidate = SourceRef & { readerVersion: string | null; targetReaderVersion: string | null; format: string | null; ordinal: number };
const slot = "hashtextextended('facade/heavy-local-slot',0)";
const valueLimits = new Set(['format_zero_text_candidates', 'xlsx_formula_cache_unverified',
  'xlsx_formula_value_missing', 'xlsx_cell_error', 'cad_entity_handle_unconfirmed']);

async function dequeue(db: Pool | PoolClient) {
  const { rows: [row] } = await db.query<Candidate>(`
    SELECT j.project_id AS "projectId", j.document_id AS "documentId", j.version_id AS "versionId", o.sha256,
           m.reader_version AS "readerVersion", target.reader_version AS "targetReaderVersion", m.format, coalesce(m.next_ordinal,0) AS ordinal
      FROM intake_reader_jobs j JOIN intake_originals o ON o.project_id=j.project_id AND o.id=j.original_id
      LEFT JOIN project_memory_versions m ON m.project_id=j.project_id AND m.version_id=j.version_id AND m.contract=$1
      LEFT JOIN LATERAL (
        SELECT r.reader_version FROM reader_maps r
        LEFT JOIN harness_package_maps p ON p.project_id=r.project_id AND p.version_id=r.version_id
          AND p.reader_version=r.reader_version AND p.active
        WHERE r.project_id=j.project_id AND r.version_id=j.version_id AND r.document_id=j.document_id AND r.original_sha256=o.sha256
        ORDER BY (p.version_id IS NOT NULL) DESC,r.created_at DESC,r.reader_version DESC LIMIT 1
      ) target ON true
     WHERE (m.total IS NULL OR m.next_ordinal<m.total OR (target.reader_version IS NOT NULL AND target.reader_version IS DISTINCT FROM m.reader_version))
       AND (m.retry_at IS NULL OR m.retry_at<=clock_timestamp())
       AND EXISTS (SELECT 1 FROM intake_occurrences c WHERE c.project_id=j.project_id
                   AND c.version_id=j.version_id AND c.state='accepted')
     ORDER BY coalesce(m.updated_at,j.created_at),j.id LIMIT 1`, [memoryVersion]);
  return row;
}

function physicalLimitation(map: PageMap) {
  if (pdfPageFormat(map.format) && map.units.length > 0 && map.units.every((unit, index) =>
    unit.locator?.page === index + 1 && unit.width && unit.height)) return null;
  if (map.format === 'pdf') return 'pdf_physical_inventory_unavailable';
  const proof = verifyPhysicalInventory(map);
  return 'limitation' in proof ? proof.limitation : null;
}

async function writeMap(db: PoolClient, map: PageMap) {
  await db.query('BEGIN');
  try {
    // Preserve the cursor of the departing generation, including legacy rows written before this migration.
    await db.query(`INSERT INTO project_memory_generations(project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation)
      SELECT project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation
      FROM project_memory_versions WHERE project_id=$1 AND version_id=$2 AND contract=$3 AND reader_version IS NOT NULL AND total IS NOT NULL
      ON CONFLICT(version_id,contract,reader_version) DO UPDATE SET next_ordinal=EXCLUDED.next_ordinal`,
      [map.source.projectId,map.source.versionId,memoryVersion]);
    await db.query(`INSERT INTO project_memory_generations(project_id,version_id,contract,reader_version,format,total,physical_limitation)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(version_id,contract,reader_version) DO NOTHING`,
      [map.source.projectId,map.source.versionId,memoryVersion,map.readerVersion,map.format,map.units.length,physicalLimitation(map)]);
    await db.query(`INSERT INTO project_memory_versions(project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation)
      SELECT project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation FROM project_memory_generations
      WHERE project_id=$1 AND version_id=$2 AND contract=$3 AND reader_version=$4
      ON CONFLICT(version_id,contract) DO UPDATE SET reader_version=EXCLUDED.reader_version,format=EXCLUDED.format,
        total=EXCLUDED.total,next_ordinal=EXCLUDED.next_ordinal,physical_limitation=EXCLUDED.physical_limitation,
        last_error=NULL,retry_at=NULL,updated_at=clock_timestamp()`,
      [map.source.projectId,map.source.versionId,memoryVersion,map.readerVersion]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

async function targetMap(db: PoolClient, job: Candidate): Promise<PageMap> {
  const { rows: [row] } = await db.query<{ readerVersion: string; format: string; units: PageMap['units']; receiptId: string }>(`
    SELECT reader_version AS "readerVersion",format,units,receipt_id AS "receiptId" FROM reader_maps
    WHERE project_id=$1 AND document_id=$2 AND version_id=$3 AND original_sha256=$4 AND reader_version=$5`,
    [job.projectId,job.documentId,job.versionId,job.sha256,job.targetReaderVersion]);
  if (!row) throw new Error('Target reader map is unavailable');
  return { source: {projectId:job.projectId,documentId:job.documentId,versionId:job.versionId,sha256:job.sha256}, ...row };
}

function unavailable(job: Candidate, error: unknown) {
  const limitation = error instanceof ReaderError ? error.code : 'memory_operational_retry';
  const terminal = !job.readerVersion && error instanceof ReaderError && [415, 422].includes(error.statusCode);
  return { limitation, terminal };
}

function summarize(format: string, block: NativeBlock) {
  const limitations = new Set([...(block.presentation?.limitations ?? []), ...(block.limitation ? [block.limitation] : [])]);
  const remaining = new Set<MemoryRemainder>();
  if (!block.artifact || ['held', 'original_only'].includes(String(block.unit.locator?.coverage))) remaining.add('native');
  if (pdfPageFormat(format) && block.unit.locator?.page !== undefined) {
    remaining.add('graphics');
    remaining.add('ocr');
    limitations.add('pdf_non_native_unreviewed');
  } else if (format === 'image') {
    remaining.add('graphics');
    if ([...limitations].some((code) => code.startsWith('raster_ocr_') && code !== 'raster_ocr_empty')) remaining.add('ocr');
    limitations.add('raster_graphics_unreviewed');
  } else if (['dxf', 'dwg', 'ifc', 'rvt'].includes(format) ||
    [...limitations].some((code) => /graphics|drawing|inline_content|sheet_features/.test(code))) {
    remaining.add('graphics');
  }
  if ([...limitations].some((code) => !valueLimits.has(code) && !['pdf_native_empty', 'pdf_non_native_unreviewed'].includes(code))
    && !remaining.size) remaining.add('native');
  return { limitations, remaining };
}

async function writeBlock(db: PoolClient, job: Candidate, block: NativeBlock) {
  const id = blockId(job, job.readerVersion!, block.unit.id);
  const address = block.presentation?.address ?? { unitId: block.unit.id, locator: block.unit.locator };
  const { limitations, remaining } = summarize(job.format!, block);
  const lines = (block.presentation?.lines ?? []).flatMap((line, ordinal) => {
    if (!line.text.trim()) return [];
    if (line.text.includes('\0')) {
      limitations.add('memory_line_not_indexable');
      remaining.add('native');
      return [];
    }
    const lineAddress: ReaderAddress = {
      unitId: address.unitId, box: line.box, locator: { ...address.locator, ...line.locator },
    };
    return [{ ordinal, id: line.id, literal: line.text, folded: folded(line.text), address: lineAddress }];
  });
  await db.query('BEGIN');
  try {
    const result = await db.query(`
      UPDATE project_memory_versions SET next_ordinal=next_ordinal+1,last_error=NULL,retry_at=NULL,updated_at=clock_timestamp()
       WHERE project_id=$1 AND version_id=$2 AND contract=$3 AND reader_version=$4 AND next_ordinal=$5`,
    [job.projectId, job.versionId, memoryVersion, job.readerVersion, block.ordinal]);
    if (!result.rowCount) throw new Error('Project memory cursor changed');
    await db.query(`
      INSERT INTO project_memory_blocks_all
        (id,project_id,version_id,contract,ordinal,unit_id,address,artifact_sha256,artifact_size,limitations,remaining,reader_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, job.projectId, job.versionId, memoryVersion, block.ordinal, block.unit.id, address,
      block.artifact?.sha256 ?? null, block.artifact?.size ?? null, [...limitations], [...remaining], job.readerVersion]);

    if (lines.length) await db.query(`
      INSERT INTO project_memory_lines (block_id,ordinal,line_id,literal,folded,address)
      SELECT $1,x.ordinal,x.id,x.literal,x.folded,x.address
        FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer,id text,literal text,folded text,address jsonb)`,
    [id, JSON.stringify(lines)]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function indexNextProjectMemory(db: Pool, reader: MemoryIndexer, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || !await dequeue(db)) return false;
  const conn = await db.connect();
  let acquired = false;
  let discard = false;
  try {
    const { rows: [lock] } = await conn.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(${slot}) AS acquired`);
    acquired = lock.acquired;
    if (!acquired || signal?.aborted) return false;
    const job = await dequeue(conn);
    if (!job) return false;
    try {
      if (!job.readerVersion || (job.targetReaderVersion && job.targetReaderVersion !== job.readerVersion)) {
        const map = job.targetReaderVersion ? await targetMap(conn,job) : await reader.map(job);
        await writeMap(conn, map);
      } else {
        await reader.materializeNative(job, job.readerVersion, job.ordinal, pdfPageFormat(job.format!) || job.format === 'image' ? 1 : 8, async (block) => {
          signal?.throwIfAborted();
          await writeBlock(conn, job, block);
        });
      }
    } catch (error) {
      if (signal?.aborted) return false;
      const { limitation, terminal } = unavailable(job, error);
      await conn.query(`
        INSERT INTO project_memory_versions (project_id,version_id,contract,total,last_error,retry_at)
        VALUES ($1,$2,$3,CASE WHEN $5 THEN 0 ELSE NULL END,$4,clock_timestamp()+interval '5 seconds')
        ON CONFLICT (version_id,contract) DO UPDATE SET last_error=EXCLUDED.last_error,retry_at=EXCLUDED.retry_at,
          total=coalesce(project_memory_versions.total,EXCLUDED.total),updated_at=clock_timestamp()
        WHERE project_memory_versions.reader_version IS NOT DISTINCT FROM $6`,
      [job.projectId, job.versionId, memoryVersion, limitation, terminal, job.readerVersion]);
    }
    return true;
  } finally {
    if (acquired) {
      try { await conn.query(`SELECT pg_advisory_unlock(${slot})`); }
      catch { discard = true; }
    }
    conn.release(discard);
  }
}
