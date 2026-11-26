import type { Pool, PoolClient } from 'pg';
import { accessConfig, authorize, uuid, type SessionAccount } from '../access/auth.js';
import { invalid, unavailable, unauthenticated } from '../access/errors.js';
import type { ReaderAddress, ReaderLine, ReaderUnit, SourceRef } from '../pdf/types.js';
import { blockId, fingerprint, folded, memoryVersion, type MemoryBlock, type MemoryContentReader,
  type MemoryHit, type MemoryReadInput, type MemoryReadResult, type MemoryRemainder,
  type MemorySearchInput, type MemorySearchResult, type MemorySnapshot, type MemoryTarget } from './contracts.js';

type AuthorizedTarget = { projectId: string; scopeId: string | null };
type Version = Omit<SourceRef, 'projectId'> & {
  readerVersion: string | null; total: number | null; indexed: number; limitation: string | null;
};
type Manifest = { version: number; versions: Version[] };
type StoredBlock = {
  blockId: string; unitId: string; address: ReaderAddress; remaining: MemoryRemainder[];
  limitations: string[]; sha256: string | null; size: number | null; versionId: string;
};
type Publication = { id: string; page: number; box: ReaderAddress['box']; quote: string | null; hasPreview: boolean };

const digestPattern = /^[0-9a-f]{64}$/;
const maximumRemainder = 100;
const selectManifest = `
  SELECT "versionId" AS version_id, "readerVersion" AS reader_version, total, indexed
    FROM jsonb_to_recordset($2::jsonb) AS v("versionId" uuid, "readerVersion" text, total integer, indexed integer)`;
const selectBlock = `b.id AS "blockId",b.unit_id AS "unitId",b.address,b.remaining,b.limitations,
  b.artifact_sha256 AS sha256,b.artifact_size AS size,b.version_id AS "versionId"`;

async function withAuthorization<T>(db: Pool, session: SessionAccount, input: MemoryTarget,
  use: (tx: PoolClient, target: AuthorizedTarget) => Promise<T>) {
  const target = { projectId: uuid(input.projectId), scopeId: input.scopeId === undefined ? null : uuid(input.scopeId) };
  const tx = await db.connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const { rowCount } = await tx.query(`
          SELECT 1 FROM access_sessions s JOIN users u ON u.id=s.user_id
           WHERE s.id=$1 AND s.user_id=$2 AND u.organization_id=$3 AND u.state='active'
             AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
             AND s.last_seen_at>statement_timestamp()-make_interval(secs=>$4)`,
        [session.sessionId, session.id, session.organizationId, accessConfig().idleSeconds]);
        if (!rowCount) throw unauthenticated();
        await authorize(tx, session, { action: 'project:read', projectId: target.projectId, scopeId: target.scopeId ?? undefined });
        const result = await use(tx, target);
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        await tx.query('ROLLBACK');
        if (attempt >= 2 || (error as { code?: unknown } | null)?.code !== '40001') throw error;
      }
    }
  } finally {
    tx.release();
  }
}

async function projectManifest(tx: PoolClient, projectId: string, search: { snapshot?: string; versionIds?: readonly string[] }) {
  if (search.snapshot !== undefined) {
    if (!digestPattern.test(search.snapshot) || search.versionIds !== undefined) throw unavailable();
    const { rows: [row] } = await tx.query<{ manifest: Manifest }>(`
      SELECT manifest FROM project_memory_snapshots WHERE project_id=$1 AND fingerprint=$2`, [projectId, search.snapshot]);
    if (!row || fingerprint([projectId, row.manifest]) !== search.snapshot) throw unavailable();
    return { snapshot: search.snapshot, ...row.manifest };
  }
  if (search.versionIds !== undefined && (!Array.isArray(search.versionIds) || search.versionIds.length > 200)) {
    throw invalid('memory_versions_invalid', 'Укажите не более 200 версий.');
  }
  const versionIds = search.versionIds === undefined ? null : [...new Set(search.versionIds.map(uuid))];
  const { rows: versions } = await tx.query<Version>(`
    SELECT v.id AS "versionId",v.document_id AS "documentId",o.sha256,m.reader_version AS "readerVersion",
           m.total,coalesce(m.next_ordinal,0) AS indexed,coalesce(m.physical_limitation,m.last_error) AS limitation
      FROM intake_document_versions v JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id
      LEFT JOIN project_memory_versions m ON m.project_id=v.project_id AND m.version_id=v.id AND m.contract=$2
     WHERE v.project_id=$1 AND EXISTS (
        SELECT 1 FROM intake_occurrences c WHERE c.project_id=v.project_id AND c.version_id=v.id AND c.state='accepted')
       AND (($3::uuid[] IS NOT NULL AND v.id=ANY($3)) OR ($3::uuid[] IS NULL AND NOT EXISTS (
        SELECT 1 FROM intake_document_versions newer JOIN intake_occurrences c
          ON c.project_id=newer.project_id AND c.version_id=newer.id AND c.state='accepted'
         WHERE newer.project_id=v.project_id AND newer.replaces_version_id=v.id)))
     ORDER BY v.id`, [projectId, memoryVersion, versionIds]);
  if (versionIds && versions.length !== versionIds.length) throw unavailable();
  const manifest = { version: memoryVersion, versions };
  const snapshot = fingerprint([projectId, manifest]);
  // A deterministic, immutable record permits reopening the same settled prefix after indexing or replacement.
  await tx.query(`
    INSERT INTO project_memory_snapshots (project_id,fingerprint,manifest) VALUES ($1,$2,$3)
    ON CONFLICT (project_id,fingerprint) DO NOTHING`, [projectId, snapshot, manifest]);
  return { snapshot, ...manifest };
}

function fromBlock(block: StoredBlock, version: Version): MemoryBlock {
  return {
    blockId: block.blockId, unitId: block.unitId, versionId: version.versionId, documentId: version.documentId,
    readerVersion: version.readerVersion ?? undefined, address: block.address, limitations: block.limitations,
    remaining: block.remaining, status: !block.sha256 ? 'unknown' : block.remaining.length ? 'partial' : 'ready',
  };
}

function pendingBlock(projectId: string, version: Version, unit: ReaderUnit): MemoryBlock {
  return {
    blockId: blockId({ ...version, projectId }, version.readerVersion!, unit.id), unitId: unit.id,
    versionId: version.versionId, documentId: version.documentId, readerVersion: version.readerVersion!,
    address: { unitId: unit.id, locator: unit.locator }, status: 'unknown',
    remaining: ['native'], limitations: ['memory_index_pending'],
  };
}

type ProjectManifest = Manifest & { snapshot: string };

async function remainingProject(tx: PoolClient, projectId: string, data: ProjectManifest): Promise<MemorySnapshot> {
  const versions = new Map(data.versions.map((version) => [version.versionId, version]));
  const args = [projectId, JSON.stringify(data.versions), data.version];
  const { rows: [{ count }] } = await tx.query<{ count: number }>(`
    WITH versions AS (${selectManifest})
    SELECT count(*)::int AS count FROM versions v JOIN project_memory_blocks_all b
      ON b.project_id=$1 AND b.version_id=v.version_id AND b.contract=$3 AND b.reader_version=v.reader_version AND b.ordinal<v.indexed
     WHERE cardinality(b.remaining)>0`, args);
  const queued = data.versions.reduce((sum, version) => sum + (version.total ?? 0) - version.indexed, 0);
  const limitations = [...new Set(data.versions.flatMap(({ total, limitation }) =>
    [limitation, total === null ? 'memory_index_pending' : null].filter((code): code is string => Boolean(code))))];
  const remaining: MemoryBlock[] = [];
  if (count) {
    const { rows } = await tx.query<StoredBlock>(`
      WITH versions AS (${selectManifest})
      SELECT ${selectBlock} FROM versions v JOIN project_memory_blocks_all b
        ON b.project_id=$1 AND b.version_id=v.version_id AND b.contract=$3 AND b.reader_version=v.reader_version AND b.ordinal<v.indexed
       WHERE cardinality(b.remaining)>0
       ORDER BY b.version_id,b.ordinal LIMIT ${maximumRemainder}`, args);
    remaining.push(...rows.map((row) => fromBlock(row, versions.get(row.versionId)!)));
  }
  if (queued && remaining.length < maximumRemainder) {
    const { rows } = await tx.query<{ versionId: string; unit: ReaderUnit }>(`
      WITH versions AS (${selectManifest})
      SELECT v.version_id AS "versionId",unit FROM versions v
        JOIN reader_maps m ON m.project_id=$1 AND m.version_id=v.version_id AND m.reader_version=v.reader_version
        CROSS JOIN LATERAL jsonb_array_elements(m.units) WITH ORDINALITY AS item(unit,position)
       WHERE v.indexed<v.total AND position>v.indexed ORDER BY v.version_id,position LIMIT $3`,
    [projectId, JSON.stringify(data.versions), maximumRemainder - remaining.length]);
    remaining.push(...rows.map(({ versionId, unit }) => pendingBlock(projectId, versions.get(versionId)!, unit)));
  }
  const hadResult = data.versions.some(({ indexed }) => indexed > 0);
  const complete = data.versions.length > 0 && !queued && !count && !limitations.length
    && data.versions.every(({ total }) => total && total > 0);
  return {
    version: data.version, snapshot: data.snapshot, boundary: 'project',
    status: complete ? 'ready' : hadResult ? 'partial' : 'unknown',
    pendingBlocks: queued + count, remaining, limitations,
  };
}

async function scopePublications(tx: PoolClient, { projectId, scopeId }: AuthorizedTarget, snapshot?: string) {
  const { rows } = await tx.query<Publication>(`
    SELECT p.id,p.page,p.box,p.quote,p.image IS NOT NULL AS "hasPreview"
      FROM fragment_publications p JOIN LATERAL (
        SELECT version FROM fragment_publication_revisions WHERE publication_id=p.id ORDER BY version DESC LIMIT 1
      ) r ON r.version=2
     WHERE p.project_id=$1 AND p.scope_id=$2 ORDER BY p.id`, [projectId, scopeId]);
  const current = fingerprint([memoryVersion, projectId, scopeId, rows.map(({ id }) => id)]);
  if (snapshot !== undefined && snapshot !== current) throw unavailable();
  return { snapshot: current, rows };
}

function publishedBlock(target: AuthorizedTarget, { id, page, box, hasPreview }: Publication): MemoryBlock {
  return {
    blockId: fingerprint([memoryVersion, target.projectId, target.scopeId, id, 2]), unitId: String(page),
    status: 'partial', remaining: hasPreview ? ['graphics'] : [], limitations: ['memory_scope_publications_only'],
    address: { unitId: String(page), locator: { page }, box },
  };
}

function structure(lines: ReaderLine[]): NonNullable<MemoryReadResult['structure']> {
  const rows = new Map<string, { key: (string | number)[]; lineIds: string[] }>();
  const columns = new Map(rows);
  const screen = new Map(rows);
  function add(groups: typeof rows, key: (string | number)[], id: string) {
    const encoded = JSON.stringify(key);
    if (!groups.has(encoded)) groups.set(encoded, { key, lineIds: [] });
    groups.get(encoded)!.lineIds.push(id);
  }
  for (const line of lines) {
    const { sheetId, table, row, column } = line.locator ?? {};
    const grid = sheetId ?? table;
    if (grid !== undefined && row !== undefined) add(rows, [grid, row], line.id);
    if (grid !== undefined && column !== undefined) add(columns, [grid, column], line.id);
    if (line.box && /^\d+\.\d+\.\d+\.\d+$/.test(line.id)) {
      add(screen, [line.id.split('.').slice(0, 2).join('.')], line.id);
    }
  }
  return { rows: [...rows.values()], columns: [...columns.values()], screen: [...screen.values()] };
}

export async function searchProjectMemory(db: Pool, session: SessionAccount, input: MemorySearchInput): Promise<MemorySearchResult> {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500 || input.query.includes('\0')) {
    throw invalid('memory_query_invalid', 'Укажите текст поиска до 500 символов.');
  }
  const query = folded(input.query.trim());
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('memory_limit_invalid', 'Лимит от 1 до 100.');
  return withAuthorization(db, session, input, async (tx, target) => {
    if (target.scopeId) {
      if (input.versionIds !== undefined) throw unavailable();
      const { snapshot, rows } = await scopePublications(tx, target, input.snapshot);
      const hits = rows.flatMap((row) => {
        if (row.quote === null || !folded(row.quote).includes(query)) return [];
        const block = publishedBlock(target, row);
        return [{ blockId: block.blockId, address: block.address, lineId: 'quote', text: row.quote }];
      });
      const crops = rows.filter(({ hasPreview }) => hasPreview);
      return {
        version: memoryVersion, snapshot, status: rows.length ? 'partial' : 'unknown', boundary: 'publications',
        hits: hits.slice(0, limit), truncated: hits.length > limit, pendingBlocks: crops.length,
        remaining: crops.slice(0, maximumRemainder).map((row) => publishedBlock(target, row)),
        limitations: ['memory_scope_publications_only'],
      };
    }
    const data = await projectManifest(tx, target.projectId, input);
    const { rows: hits } = await tx.query<MemoryHit>(`
      WITH versions AS (${selectManifest})
      SELECT b.id AS "blockId",l.line_id AS "lineId",l.literal AS text,l.address,b.version_id AS "versionId"
        FROM versions v JOIN project_memory_blocks_all b
          ON b.project_id=$1 AND b.version_id=v.version_id AND b.contract=$3 AND b.reader_version=v.reader_version AND b.ordinal<v.indexed
        JOIN project_memory_lines l ON l.block_id=b.id
       WHERE strpos(l.folded,$4)>0 ORDER BY b.version_id,b.ordinal,l.ordinal LIMIT $5`,
    [target.projectId, JSON.stringify(data.versions), data.version, query, limit + 1]);
    return { ...await remainingProject(tx, target.projectId, data), hits: hits.slice(0, limit), truncated: hits.length > limit };
  });
}

export async function readProjectMemory(
  db: Pool, reader: MemoryContentReader, session: SessionAccount, input: MemoryReadInput,
): Promise<MemoryReadResult> {
  if (typeof input.snapshot !== 'string' || typeof input.blockId !== 'string' || !digestPattern.test(input.blockId)) {
    throw unavailable();
  }
  return withAuthorization(db, session, input, async (tx, target) => {
    if (target.scopeId) {
      const { snapshot, rows } = await scopePublications(tx, target, input.snapshot);
      for (const row of rows) {
        const block = publishedBlock(target, row);
        if (block.blockId !== input.blockId) continue;
        return {
          version: memoryVersion, snapshot, block, lines: row.quote === null ? [] : [{ id: 'quote', text: row.quote }],
          ...(row.hasPreview ? { previewUrl: `/api/projects/${target.projectId}/scopes/${target.scopeId}/fragment-publications/${row.id}/versions/2/preview` } : {}),
        };
      }
      throw unavailable();
    }
    const data = await projectManifest(tx, target.projectId, input);
    const { rows: [stored] } = await tx.query<StoredBlock>(`
      WITH versions AS (${selectManifest})
      SELECT ${selectBlock} FROM versions v JOIN project_memory_blocks_all b
        ON b.project_id=$1 AND b.version_id=v.version_id AND b.contract=$3 AND b.reader_version=v.reader_version AND b.ordinal<v.indexed
       WHERE b.id=$4`, [target.projectId, JSON.stringify(data.versions), data.version, input.blockId]);
    if (!stored) {
      const state = await remainingProject(tx, target.projectId, data);
      const pending = state.remaining.find((entry) => entry.blockId === input.blockId);
      if (!pending) throw unavailable();
      return { version: data.version, snapshot: data.snapshot, block: pending, lines: [] };
    }
    const block = fromBlock(stored, data.versions.find(({ versionId }) => versionId === stored.versionId)!);
    const presentation = stored.sha256 && stored.size
      ? await reader.readMaterializedNative(target.projectId, { sha256: stored.sha256, size: stored.size }) : null;
    if (presentation && fingerprint(presentation.address) !== fingerprint(block.address)) throw unavailable();
    return { version: data.version, snapshot: data.snapshot, block, lines: presentation?.lines ?? [],
      ...(presentation ? { structure: structure(presentation.lines) } : {}) };
  });
}
