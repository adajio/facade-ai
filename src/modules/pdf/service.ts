import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import { blockId, fingerprint, memoryVersion } from '../project-memory/contracts.js';
import { groundComponents } from './components.js';
import { verifiedNativeLineCrops, type NativeLineCrop, type VerifiedNativeDeliveryLine } from './native-line.js';
import {
  type ArtifactStore, type Box, type DocumentKey, type Evidence, type Observation, type ReaderComponentInput,
  type NativeArtifact, type NativeBlock, type NativePresentation, type ReaderOutput,
  type Original, type PageMap, type PinInput, type ReaderAdapter, type ReaderAddress, type ReaderLine, type ReaderUnit,
  type ReadRequest, type ReadScope, type ResolveOriginal, type SourceRef, contains, ReaderError, validBox,
} from './types.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const maxArtifactBytes = 32 * 1024 * 1024;

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const isReaderId = (id: unknown): id is string => typeof id === 'string' && uuid.test(id);

export interface ReaderDependencies {
  resolveOriginal: ResolveOriginal;
  artifacts: ArtifactStore;
  scratchDir?: string;
  scratchReserveBytes?: number;
  maxOriginalBytes?: number;
}

interface MapRow {
  project_id: string;
  document_id: string;
  version_id: string;
  receipt_id: string;
  original_sha256: string;
  reader_version: string;
  format: string;
  units: PageMap['units'];
}

interface ReplayRow<Result> {
  request_sha256: string;
  payload: Result;
}

type ReaderTable = 'reader_evidence' | 'reader_observations';

function checkedSource(source: SourceRef): SourceRef {
  const { projectId, documentId, versionId, sha256 } = source;
  if (![projectId, documentId, versionId].every(isReaderId) || typeof sha256 !== 'string' || !digest.test(sha256)) {
    throw new ReaderError('reader_source_invalid', 'Нужны ID проекта, документа, версии и SHA-256 оригинала', 422);
  }
  return { projectId, documentId, versionId, sha256 };
}

function checkedScope({ runId, branch, operationKey }: ReadScope): ReadScope {
  if (!isReaderId(runId) || (branch !== 'A' && branch !== 'B')
    || typeof operationKey !== 'string' || operationKey.length < 1 || operationKey.length > 200
    || operationKey.includes('\0')) {
    throw new ReaderError('reader_attempt_invalid', 'Неверная ветвь, запуск или ключ инструмента', 422);
  }
  return { runId, branch, operationKey };
}

function checkedBox(box: Box | undefined): Box | undefined {
  if (box === undefined) return;
  if (!validBox(box)) throw new ReaderError('reader_address_invalid', 'Неверная рамка', 422);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function checkedRead(input: ReadRequest): ReadRequest {
  const { representation, address, dpi, query, readerVersion } = input;
  if (!['render', 'native', 'ocr'].includes(representation) || !address || typeof address.unitId !== 'string'
    || !address.unitId.length || address.unitId.length > 200
    || (readerVersion !== undefined && (typeof readerVersion !== 'string' || !readerVersion || readerVersion.length > 500))
    || (dpi !== undefined && (representation === 'native' || !Number.isSafeInteger(dpi) || dpi <= 0))
    || (query !== undefined && (representation !== 'native' || typeof query !== 'string'
      || !query.trim() || query.length > 500 || query.includes('\0')))) {
    throw new ReaderError('reader_address_invalid', 'Неверный вид чтения или физический адрес', 422);
  }
  const entries = Object.entries(address.locator ?? {});
  if (entries.length > 16 || entries.some(([key, val]) => key.length > 100
    || !(typeof val === 'string' && val.length <= 300 || typeof val === 'number' && Number.isFinite(val)))) {
    throw new ReaderError('reader_address_invalid', 'Неверный физический адрес', 422);
  }
  return {
    address: {
      unitId: address.unitId, box: checkedBox(address.box),
      locator: entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en'))) : undefined,
    },
    representation, dpi, query: query?.trim(), readerVersion,
  };
}

function checkedStatement(input: PinInput): PinInput['deliveryStatement'] {
  const statement = input.deliveryStatement;
  if (statement === undefined) return;
  const text = (value: unknown): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 500 && !value.includes('\0');
  if (!statement || (statement.status !== 'delivered' && statement.status !== 'not_delivered')
    || !text(statement.item) || !text(input.quote) || input.value !== undefined || input.unit !== undefined
    || input.normalizedValue !== undefined || input.limitation !== undefined || input.alternatives !== undefined
    || (statement.context !== undefined
      && (!statement.context || !text(statement.context.lineId) || !text(statement.context.quote)))
    || (!input.quote.includes(statement.item) && !statement.context?.quote.includes(statement.item))) {
    throw new ReaderError('reader_statement_invalid', 'Утверждению о передаче нужны дословная цитата и её предмет', 422);
  }
  return {
    status: statement.status, item: statement.item,
    ...(statement.context ? { context: { lineId: statement.context.lineId, quote: statement.context.quote } } : {}),
  };
}

function checkedPin(input: PinInput): PinInput {
  const { evidenceId, scope, quote, value, unit, normalizedValue, limitation, lineId, alternatives } = input;
  const statement = checkedStatement(input);
  const values = [quote, value, unit, limitation, lineId];
  if (!isReaderId(evidenceId) || (scope !== null && !isReaderId(scope)) || values.some((val) => val !== undefined
    && (typeof val !== 'string' || !val.trim() || val.length > 8000 || val.includes('\0')))
    || (normalizedValue !== undefined && !(typeof normalizedValue === 'string' && normalizedValue.length <= 8000
      && !normalizedValue.includes('\0') || typeof normalizedValue === 'number' && Number.isFinite(normalizedValue)))
    || (!quote && value !== undefined) || (value === undefined && (unit !== undefined || normalizedValue !== undefined))
    || ((!quote || (scope !== null && value === undefined)) && !limitation && !statement) || (lineId && !quote)
    || (alternatives !== undefined && (!Array.isArray(alternatives) || alternatives.length > 12
      || alternatives.some((value) => typeof value !== 'string' || !value.trim() || value.length > 500
        || value.includes('\0'))))) {
    throw new ReaderError('reader_observation_invalid', 'Для наблюдения нужны место, область и цитата либо ограничение', 422);
  }
  return {
    evidenceId, scope, quote, value, unit, normalizedValue, limitation, lineId, alternatives, box: checkedBox(input.box),
    ...(statement ? { deliveryStatement: statement } : {}),
  };
}

function mapFromRow(row: MapRow): PageMap {
  return {
    source: {
      projectId: row.project_id, documentId: row.document_id, versionId: row.version_id, sha256: row.original_sha256,
    },
    receiptId: row.receipt_id, readerVersion: row.reader_version, format: row.format, units: row.units,
  };
}

function sameSource(left: SourceRef, right: SourceRef): boolean {
  return left.projectId === right.projectId && left.documentId === right.documentId
    && left.versionId === right.versionId && left.sha256 === right.sha256;
}

function mismatch(): never {
  throw new ReaderError('reader_source_mismatch', 'Оригинал отличается от назначенной версии или SHA-256', 422);
}

async function withOriginal<T>(
  original: Original, deps: ReaderDependencies, use: (path: string) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(original.size) || original.size <= 0 || original.size > (deps.maxOriginalBytes ?? 512 * 1024 ** 2)) {
    throw new ReaderError('reader_original_limit', 'Размер оригинала за пределами профиля reader', 422);
  }
  const root = deps.scratchDir ?? tmpdir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fs = await statfs(root, { bigint: true });
  if (fs.bavail * fs.bsize < BigInt(original.size) + BigInt(deps.scratchReserveBytes ?? 0)) {
    throw new ReaderError('reader_scratch_unavailable', 'Не хватает временного места для оригинала', 503);
  }
  const folder = await mkdtemp(join(root, 'facade-reader-'));
  const path = join(folder, 'original');
  try {
    let size = 0;
    const hash = createHash('sha256');
    try {
      await pipeline(await original.open(), async function* (input) {
        for await (const chunk of input) {
          size += chunk.length;
          if (size > original.size) mismatch();
          hash.update(chunk);
          yield chunk;
        }
        if (size !== original.size || hash.digest('hex') !== original.sha256) mismatch();
      }, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if (error instanceof ReaderError) throw error;
      const failure = error as { code?: string; statusCode?: number };
      if (failure.code === 'ENOSPC') {
        throw new ReaderError('reader_scratch_unavailable', 'Не хватает временного места для оригинала', 503);
      }
      if (failure.statusCode === 424) {
        throw new ReaderError('reader_original_unavailable', 'Принятый оригинал недоступен', 424);
      }
      throw new ReaderError('reader_original_read_failed', 'Не удалось получить байты принятого оригинала', 503);
    }
    return await use(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function checkReplay<Result>(row: ReplayRow<Result>, requestHash: string): Result {
  if (row.request_sha256 !== requestHash) {
    throw new ReaderError('reader_operation_conflict', 'Ключ операции уже использован с другим входом', 409);
  }
  return row.payload;
}

async function replay<Result>(
  db: Pool | PoolClient, table: ReaderTable, projectId: string, scope: ReadScope, requestHash: string,
): Promise<Result | undefined> {
  const result = await db.query<ReplayRow<Result>>(
    `SELECT request_sha256, payload FROM ${table}
     WHERE project_id = $1 AND run_id = $2 AND branch = $3 AND operation_key = $4`,
    [projectId, scope.runId, scope.branch, scope.operationKey],
  );
  if (result.rows[0]) return checkReplay(result.rows[0], requestHash);
}

async function saveArtifact(store: ArtifactStore, projectId: string, bytes: Buffer): Promise<{ sha256: string; size: number }> {
  if (!bytes.length || bytes.length > maxArtifactBytes) {
    throw new ReaderError('reader_artifact_limit', 'Размер представления за пределами профиля reader', 422);
  }
  const hash = sha256(bytes);
  try {
    await store.put(projectId, hash, bytes);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError('reader_artifact_write_failed', 'Не удалось сохранить представление', 503);
  }
  return { sha256: hash, size: bytes.length };
}

export async function readArtifact(
  store: ArtifactStore, projectId: string, sha: string, size: number,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await store.get(projectId, sha, size);
  } catch {
    throw new ReaderError('reader_artifact_unavailable', 'Сохранённое представление недоступно', 424);
  }
  if (bytes.length !== size || sha256(bytes) !== sha) {
    throw new ReaderError('reader_artifact_mismatch', 'Повреждено сохранённое представление', 424);
  }
  return bytes;
}

function nativePresentation(bytes: Buffer, unitId?: string): NativePresentation {
  let value: NativePresentation | null;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { value = null; }
  if (!value?.address?.unitId || (unitId !== undefined && value.address.unitId !== unitId)
    || value.address.box || !Array.isArray(value.lines) || !Array.isArray(value.limitations)) {
    throw new ReaderError('reader_native_presentation_invalid', 'Полное нативное окно не подтверждено', 422);
  }
  return value;
}

export function createReaderService(db: Pool, deps: ReaderDependencies, adapters: readonly ReaderAdapter[]) {
  const registry = new Map(adapters.map((adapter) => [adapter.format, adapter]));
  if (registry.size !== adapters.length) throw new Error('Duplicate reader adapter format');

  async function describe(source: SourceRef, tx?: PoolClient): Promise<{ original: Original; adapter: ReaderAdapter; version: string }> {
    const original = await deps.resolveOriginal(source, tx);
    if (!original || !sameSource(original, source) || !isReaderId(original.receiptId)) mismatch();
    const adapter = registry.get(original.format);
    if (!adapter) throw new ReaderError('reader_format_unsupported', 'Для формата нет reader', 422);
    return { original, adapter, version: await adapter.version() };
  }

  // This path returns only a bounded PDF selection and never creates public reader evidence.
  async function readPdfFragment(sourceRef: SourceRef, input: { page: number; box: Box; quote?: string }, tx: PoolClient) {
    const source = checkedSource(sourceRef);
    const { rows: [slot] } = await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('facade/heavy-local-slot',0)) AS acquired",
    );
    if (!slot.acquired) throw new ReaderError('reader_resource_wait', 'Reader занят. Повторите подготовку фрагмента позже', 503);
    const { original, adapter, version } = await describe(source, tx);
    if (adapter.format !== 'pdf') throw new ReaderError('fragment_pdf_required', 'Для публикации нужен оригинал PDF', 422);
    return withOriginal(original, deps, async (path) => {
      const unitId = String(input.page);
      const map = await lookupMap(source, version, tx);
      const unit = (map?.units ?? await adapter.inspect(path)).find(({ id }) => id === unitId);
      const box = checkedBox(input.box)!;
      if (!unit?.width || !unit.height || !contains({ x: 0, y: 0, width: unit.width, height: unit.height }, box)
        || (box.x === 0 && box.y === 0 && box.width >= unit.width && box.height >= unit.height)) {
        throw new ReaderError('fragment_address_invalid', 'Укажите рамку фрагмента внутри страницы PDF', 422);
      }
      if (input.quote !== undefined) {
        const output = await adapter.read(path, { representation: 'native', address: { unitId, box } }, unit, true);
        const matches = (output.lines ?? []).filter(({ text }) => text.includes(input.quote!));
        if (matches.length !== 1 || matches[0].text.indexOf(input.quote) !== matches[0].text.lastIndexOf(input.quote)) {
          throw new ReaderError('fragment_quote_unverified', 'Цитата должна дословно и однозначно находиться внутри рамки', 422);
        }
        return { box, readerVersion: version, quote: input.quote };
      }

      // Align inward to the PDF raster so rounding cannot include adjacent pixels.
      const scale = 2;
      const x = Math.ceil(box.x * scale);
      const y = Math.ceil(box.y * scale);
      const width = Math.floor((box.x + box.width) * scale) - x;
      const height = Math.floor((box.y + box.height) * scale) - y;
      if (width < 1 || height < 1 || width * height > 1_000_000) {
        throw new ReaderError('fragment_crop_limit', 'Измените размер рамки. Допустимо до 1 млн пикселей', 422);
      }
      const crop = { x: x / scale, y: y / scale, width: width / scale, height: height / scale };
      const output = await adapter.read(path, {
        representation: 'render', address: { unitId, box: crop }, dpi: 72 * scale,
      }, unit);
      const t = output.transform;
      if (output.mediaType !== 'image/png' || !t || t.pixelsPerPoint !== scale
        || t.pixelOriginX !== x || t.pixelOriginY !== y || t.width > width || t.height > height
        || output.bytes.length > 4 * 1024 * 1024) {
        throw new ReaderError('fragment_crop_invalid', 'Изображение не соответствует рамке публикации', 422);
      }
      return {
        box: { ...crop, width: t.width / scale, height: t.height / scale },
        readerVersion: version, image: output.bytes,
      };
    });
  }

  async function previewPdfPage(sourceRef: SourceRef, page: number, tx: PoolClient) {
    const source = checkedSource(sourceRef);
    const { rows: [slot] } = await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('facade/heavy-local-slot',0)) AS acquired",
    );
    if (!slot.acquired) throw new ReaderError('reader_resource_wait', 'Просмотрщик занят', 503);
    const { original, adapter, version } = await describe(source, tx);
    const unitId = String(page);
    const unit = adapter.format === 'pdf' ? (await lookupMap(source, version, tx))?.units.find(({ id }) => id === unitId) : undefined;
    if (!unit?.width || !unit.height) throw new ReaderError('reader_address_invalid', 'Страница пока недоступна для предпросмотра', 422);
    const dpi = Math.floor(Math.min(144, 72 * 1600 / Math.max(unit.width, unit.height)));
    if (original.size > 32 * 1024 ** 2 || dpi < 36) {
      throw new ReaderError('pdf_preview_limit', 'Откройте страницу в полном просмотрщике PDF', 422);
    }
    return withOriginal(original, deps, async path => {
      const output = await adapter.read(path, { representation: 'render', address: { unitId }, dpi }, unit);
      if (output.address.unitId !== unitId || output.mediaType !== 'image/png' || output.bytes.length > 4 * 1024 ** 2) {
        throw new ReaderError('pdf_preview_limit', 'Откройте страницу в полном просмотрщике PDF', 422);
      }
      return output.bytes;
    });
  }

  async function lookupMap(source: SourceRef, version: string, tx?: PoolClient): Promise<PageMap | undefined> {
    const { rows } = await (tx ?? db).query<MapRow>(
      `SELECT * FROM reader_maps
       WHERE version_id = $1 AND project_id = $2 AND document_id = $3 AND reader_version = $4`,
      [source.versionId, source.projectId, source.documentId, version],
    );
    if (!rows[0]) return;
    const map = mapFromRow(rows[0]);
    if (!sameSource(map.source, source)) mismatch();
    return map;
  }

  async function insertMap(
    source: SourceRef, original: Original, version: string, adapter: ReaderAdapter, path: string,
  ): Promise<PageMap> {
    const units = await adapter.inspect(path, source);
    if (new Set(units.map(({ id }) => id)).size !== units.length || units.some(({ id }) => !id || id.length > 200)) {
      throw new ReaderError('reader_inventory_invalid', 'Reader вернул недопустимую карту физических единиц', 422);
    }
    await db.query(
      `INSERT INTO reader_maps
       (project_id, document_id, version_id, reader_version, receipt_id, original_sha256, format, units)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (version_id, reader_version) DO NOTHING`,
      [source.projectId, source.documentId, source.versionId, version, original.receiptId, source.sha256,
        adapter.format, JSON.stringify(units)],
    );
    const stored = await lookupMap(source, version);
    if (!stored) mismatch();
    return stored;
  }

  async function readMapped(source: SourceRef, original: Original, adapter: ReaderAdapter, request: ReadRequest, unit: ReaderUnit) {
    if (original.check && adapter.readCached) {
      await original.check();
      const cached = await adapter.readCached(source, request, unit);
      if (cached) return cached;
    }
    return withOriginal(original, deps, path => adapter.read(path, request, unit, undefined, source));
  }

  async function previewDwg(document: DocumentKey, input: ReadRequest) {
    const request = checkedRead(input);
    const map = await latestMap(document);
    if (!map || map.format !== 'dwg') throw new ReaderError('reader_map_unavailable', 'Карта DWG ещё недоступна', 404);
    const { original, adapter, version } = await describe(map.source);
    if (map.readerVersion !== version || request.readerVersion !== version) {
      throw new ReaderError('reader_profile_changed', 'Требуется текущая карта DWG', 409);
    }
    const unit = map.units.find(({ id }) => id === request.address.unitId);
    if (!unit) throw new ReaderError('reader_address_invalid', 'Часть DWG отсутствует в карте', 422);
    return readMapped(map.source, original, adapter, request, unit);
  }

  async function materializeNative(sourceRef: SourceRef, readerVersion: string, start: number, count: number,
    publish: (block: NativeBlock) => Promise<void>): Promise<void> {
    const source = checkedSource(sourceRef);
    const { original, adapter, version } = await describe(source);
    if (readerVersion !== version) {
      throw new ReaderError('reader_profile_changed', 'Требуется исходный профиль reader', 409);
    }
    const map = await lookupMap(source, version);
    if (!map || !Number.isSafeInteger(start) || start < 0 || start >= map.units.length
      || !Number.isSafeInteger(count) || count < 1 || count > 16) {
      throw new ReaderError('reader_address_invalid', 'Пакет нативных окон отсутствует в карте', 422);
    }
    const selected = map.units.slice(start, start + count);
    async function* readUnits(path: string): AsyncIterable<ReaderOutput | ReaderError> {
      for (const unit of selected) {
        const request = { address: { unitId: unit.id }, representation: 'native' as const };
        try {
          yield await adapter.read(path, request, unit, undefined, source);
        } catch (error) {
          if (!(error instanceof ReaderError)) throw error;
          yield error;
        }
      }
    }
    async function consume(results: AsyncIterable<ReaderOutput | ReaderError>) {
      let ordinal = start;
      for await (const output of results) {
        const unit = selected[ordinal - start];
        if (!unit) throw new Error('Adapter returned extra native units');
        if (output instanceof ReaderError || output.mediaType !== 'application/json') {
          const failure = output instanceof ReaderError ? output
            : new ReaderError('reader_native_presentation_invalid', 'Окно не имеет нативного представления', 422);
          if (![415, 422, 424].includes(failure.statusCode)) throw failure;
          await publish({ ordinal, unit, limitation: failure.code });
        } else {
          const presentation = nativePresentation(output.bytes, unit.id);
          const artifact = await saveArtifact(deps.artifacts, source.projectId, output.bytes);
          await publish({ ordinal, unit, presentation, artifact });
        }
        ordinal++;
      }
      if (ordinal !== start + selected.length) throw new Error('Adapter omitted native units');
    }
    if (original.check && adapter.readCachedNativeUnits) {
      await original.check();
      const cached = await adapter.readCachedNativeUnits(source, selected);
      if (cached) return consume(cached);
    }
    await withOriginal(original, deps, path => consume(adapter.readNativeUnits?.(path, selected, source) ?? readUnits(path)));
  }

  async function readMaterializedNative(projectId: string, artifact: NativeArtifact) {
    const bytes = await readArtifact(deps.artifacts, projectId, artifact.sha256, artifact.size);
    return nativePresentation(bytes);
  }

  async function indexedNative(source: SourceRef, version: string, format: string, request: ReadRequest, tx?: PoolClient) {
    if (request.representation !== 'native' || request.query !== undefined || request.address.box) return;
    const { unitId, locator } = request.address;
    const id = blockId(source, version, unitId);
    const { rows: [stored] } = await (tx ?? db).query<NativeArtifact & { address: ReaderAddress }>(
      `SELECT b.artifact_sha256 AS sha256,b.artifact_size AS size,b.address
         FROM project_memory_blocks b
         JOIN project_memory_versions v USING(project_id,version_id,contract)
         JOIN reader_maps r USING(project_id,version_id,reader_version)
        WHERE b.id=$1 AND b.project_id=$2 AND b.version_id=$3 AND b.contract=$4 AND b.unit_id=$5
          AND v.reader_version=$6 AND r.document_id=$7 AND r.original_sha256=$8 AND r.format=$9
          AND b.ordinal<v.next_ordinal AND r.units->b.ordinal->>'id'=$5
          AND b.artifact_sha256 IS NOT NULL AND NOT ('native'=ANY(b.remaining))`,
      [id, source.projectId, source.versionId, memoryVersion, unitId, version, source.documentId, source.sha256, format],
    );
    if (!stored || (locator && fingerprint(locator) !== fingerprint(stored.address.locator ?? {}))) return;
    const { sha256, size, address } = stored;
    const bytes = await readArtifact(deps.artifacts, source.projectId, sha256, size);
    const presentation = nativePresentation(bytes, unitId);
    if (fingerprint(presentation.address) !== fingerprint(address)) {
      throw new ReaderError('reader_artifact_mismatch', 'Адрес сохранённого представления расходится с индексом', 424);
    }
    const output: ReaderOutput = { ...presentation, bytes, mediaType: 'application/json' };
    return { id, artifact: { sha256, size }, output, presentation };
  }

  async function open(sourceRef: SourceRef, readScope: ReadScope, input: ReadRequest) {
    const source = checkedSource(sourceRef);
    const scope = checkedScope(readScope);
    const request = checkedRead(input);
    // The harness authorizes the assigned place. The reader also binds a known
    // job to its project and keeps scoped jobs on the existing original path.
    const { rows: [job] } = await db.query<{ project_id: string; scope_id: string | null }>(
      'SELECT project_id,scope_id FROM gateway_jobs WHERE id=$1', [scope.runId],
    );
    if (job && job.project_id !== source.projectId) mismatch();
    const requestHash = sha256(JSON.stringify({ source, request }));
    const previous = await replay<Evidence>(db, 'reader_evidence', source.projectId, scope, requestHash);
    if (previous) return { evidence: previous, bytes: await content(previous) };

    const { original, adapter, version } = await describe(source);
    if (request.readerVersion !== undefined && request.readerVersion !== version) {
      throw new ReaderError('reader_profile_changed', 'Требуется исходный профиль reader', 409);
    }
    const cached = !job?.scope_id ? await indexedNative(source, version, adapter.format, request) : undefined;
    if (cached && adapter.format === 'dwg') await original.check?.();
    let output = cached?.output;
    function selected(map: PageMap) {
      const unit = map.units.find(({ id }) => id === request.address.unitId);
      if (!unit) throw new ReaderError('reader_address_invalid', 'Физическая единица отсутствует в оригинале', 422);
      return unit;
    }
    if (!output) {
      const map = await lookupMap(source, version);
      output = map ? await readMapped(source, original, adapter, request, selected(map))
        : await withOriginal(original, deps, async path => {
          const fresh = await insertMap(source, original, version, adapter, path);
          return adapter.read(path, request, selected(fresh), undefined, source);
        });
    }
    if (output.address.unitId !== request.address.unitId || (output.address.box && !validBox(output.address.box))) {
      throw new ReaderError('reader_address_invalid', 'Reader вернул неожиданный адрес', 422);
    }
    if (request.query !== undefined) {
      const needle = request.query.normalize('NFC').toLowerCase();
      const lines = (output.lines ?? []).filter(({ text }) => text.normalize('NFC').toLowerCase().includes(needle));
      const limitations = [...(output.limitations ?? []), ...(!lines.length ? ['reader_no_text_match'] : [])];
      const bytes = Buffer.from(JSON.stringify({ address: output.address, lines, limitations }));
      output = { ...output, lines, limitations, bytes, mediaType: 'application/json' };
    }
    const artifact = cached?.artifact ?? await saveArtifact(deps.artifacts, source.projectId, output.bytes);
    const inputImage = output.inputImage && {
      ...await saveArtifact(deps.artifacts, source.projectId, output.inputImage.bytes),
      transform: output.inputImage.transform,
    };
    const evidence: Evidence = {
      id: randomUUID(), source, receiptId: original.receiptId, runId: scope.runId, branch: scope.branch,
      readerVersion: version, format: adapter.format, address: output.address, representation: request.representation,
      mediaType: output.mediaType, ...artifact, transform: output.transform, limitations: output.limitations ?? [],
      relativePath: original.relativePath, inputImage,
      ...(cached ? { materializedBlockId: cached.id } : {}),
    };
    const stored = await db.query<{ payload: Evidence }>(
      `INSERT INTO reader_evidence
       (id, project_id, version_id, reader_version, run_id, branch, operation_key, request_sha256, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, run_id, branch, operation_key) DO NOTHING RETURNING payload`,
      [evidence.id, source.projectId, source.versionId, version, scope.runId, scope.branch,
        scope.operationKey, requestHash, evidence],
    );
    if (stored.rows[0]) return { evidence: stored.rows[0].payload, bytes: output.bytes };
    const winner = await replay<Evidence>(db, 'reader_evidence', source.projectId, scope, requestHash);
    if (!winner) throw new Error('Missing evidence after concurrent insert');
    return { evidence: winner, bytes: await content(winner) };
  }

  async function content(evidence: Evidence, part: 'presentation' | 'ocr-input' = 'presentation'): Promise<Buffer> {
    const identity = part === 'ocr-input' ? evidence.inputImage : evidence;
    if (!identity) throw new ReaderError('reader_artifact_missing', 'У представления нет входного изображения OCR', 404);
    return readArtifact(deps.artifacts, evidence.source.projectId, identity.sha256, identity.size);
  }

  async function findEvidence(projectId: string, id: string, tx?: PoolClient): Promise<Evidence | undefined> {
    const { rows } = await (tx ?? db).query<{ payload: Evidence }>(
      'SELECT payload FROM reader_evidence WHERE project_id = $1 AND id = $2', [projectId, id],
    );
    return rows[0]?.payload;
  }

  async function verifyNativeDeliveryLine(sourceRef: SourceRef, scope: ReadScope, input: {
    readerVersion: string; unitId: string; lineId: string; submittedEvidenceId: string; quote: string;
    issued: { evidenceId: string; sha256: string }[];
  }, tx: PoolClient): Promise<VerifiedNativeDeliveryLine | undefined> {
    const source = checkedSource(sourceRef);
    const { readerVersion, unitId, lineId, submittedEvidenceId, quote, issued } = input;
    const cached = await indexedNative(source, readerVersion, 'pdf', { address: { unitId }, representation: 'native' });
    const fullAddress = cached?.output.address;
    const full = cached?.output.lines?.filter((line) => line.id === lineId);
    if (!cached || !fullAddress || fullAddress.locator?.page !== Number(unitId) || full?.length !== 1) return;
    const crops: NativeLineCrop[] = [];
    for (const { evidenceId, sha256 } of issued) {
      const evidence = await findEvidence(source.projectId, evidenceId, tx);
      const frame = evidence?.address.box;
      if (!evidence || !frame || evidence.runId !== scope.runId || evidence.branch !== scope.branch
        || evidence.format !== 'pdf' || evidence.representation !== 'native' || evidence.mediaType !== 'application/json'
        || evidence.readerVersion !== readerVersion || evidence.sha256 !== sha256 || !sameSource(source, evidence.source)
        || evidence.address.unitId !== unitId || evidence.address.locator?.page !== Number(unitId)
        || fingerprint(evidence.address.locator) !== fingerprint(fullAddress.locator)) continue;
      const body = JSON.parse((await content(evidence)).toString('utf8')) as NativePresentation;
      if (!body?.address || !Array.isArray(body.lines) || fingerprint(body.address) !== fingerprint(evidence.address)) continue;
      const lines = body.lines.filter((line) => line.id === lineId);
      if (lines.length === 1) crops.push({ evidenceId, frame, line: lines[0] });
    }
    const proof = verifiedNativeLineCrops(full[0], crops, submittedEvidenceId, quote);
    if (proof) return { ...proof, line: full[0], canonicalSha256: cached.artifact.sha256, submittedEvidenceId };
  }

  async function pin(sourceRef: SourceRef, readScope: ReadScope, input: PinInput, tx?: PoolClient,
    parts?: readonly ReaderComponentInput[], verifiedLine?: VerifiedNativeDeliveryLine): Promise<Observation> {
    const source = checkedSource(sourceRef);
    const scope = checkedScope(readScope);
    const candidate = checkedPin(input);
    const conn = tx ?? db;
    const requestHash = sha256(JSON.stringify({ source, candidate, ...(parts ? { parts } : {}), ...(verifiedLine ? { verifiedLine } : {}) }));
    const previous = await replay<Observation>(conn, 'reader_observations', source.projectId, scope, requestHash);
    if (previous) return previous;

    const evidence = await findEvidence(source.projectId, candidate.evidenceId, tx);
    if (!evidence || !sameSource(source, evidence.source)
      || evidence.runId !== scope.runId || evidence.branch !== scope.branch) {
      throw new ReaderError('reader_evidence_scope_mismatch', 'Выдача недоступна в этой версии, ветви или запуске', 422);
    }
    if (evidence.format === 'pdf' && evidence.address.box && candidate.deliveryStatement?.status === 'not_delivered'
      && verifiedLine?.anchorEvidenceId !== evidence.id) {
      throw new ReaderError('package_non_delivery_unproven', 'Для отрицания по рамке PDF нужна сверенная каноническая строка', 422);
    }
    if (evidence.format === 'ifc' && candidate.value !== undefined && !candidate.limitation && !parts) {
      throw new ReaderError('reader_ifc_unit_unproven', 'Измерению IFC нужны отдельно закреплённые сущности свойства и единицы', 422);
    }
    const map = await lookupMap(source, evidence.readerVersion, tx);
    const unit = map?.units.find(({ id }) => id === evidence.address.unitId);
    const delivered = evidence.address.box ?? (unit?.width && unit.height
      ? { x: 0, y: 0, width: unit.width, height: unit.height } : undefined);
    if (candidate.box && (!delivered || !contains(delivered, candidate.box))) {
      throw new ReaderError('reader_address_invalid', 'Рамка наблюдения выходит за границу выдачи', 422);
    }
    const scale = evidence.transform?.pixelsPerPoint;
    if (candidate.box && scale && (candidate.box.width * scale < 1 || candidate.box.height * scale < 1)) {
      throw new ReaderError('reader_address_invalid', 'Рамка мельче одного пикселя выдачи', 422);
    }
    const linkedScope = candidate.scope === null
      ? await conn.query(
        `SELECT 1 FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
         LEFT JOIN harness_package_followups f ON f.job_id=j.id
         JOIN harness_package_branches b ON b.job_id=coalesce(f.root_job_id,j.id) AND b.active
         JOIN harness_package_windows w ON w.id=b.window_id AND w.project_id=j.project_id
           AND (f.job_id IS NULL OR f.window_id=w.id AND f.branch=b.branch)
         JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
         WHERE j.id=$1 AND j.project_id=$2 AND g.current AND j.scope_id IS NULL
           AND w.version_id=$3 AND b.branch=$4 AND m.reader_version=$5`,
        [scope.runId, source.projectId, source.versionId, scope.branch, evidence.readerVersion])
      : await conn.query('SELECT 1 FROM project_scopes WHERE project_id = $1 AND id = $2', [source.projectId, candidate.scope]);
    if (!linkedScope.rowCount) {
      throw new ReaderError('reader_scope_invalid', 'Область наблюдения не принадлежит проекту', 422);
    }
    const bytes = await content(evidence);
    if (evidence.inputImage) await content(evidence, 'ocr-input');
    let address: ReaderAddress = { ...evidence.address, box: candidate.box ?? evidence.address.box };
    let grounding: Observation['grounding'] = 'limited';
    if (candidate.quote && evidence.representation === 'render') {
      if (candidate.lineId || candidate.deliveryStatement?.context) {
        throw new ReaderError('reader_quote_mismatch', 'Изображение не содержит ID строки', 422);
      }
      if (candidate.deliveryStatement && !candidate.box) {
        throw new ReaderError('reader_address_invalid', 'Для визуальной цитаты нужна рамка утверждения', 422);
      }
      grounding = 'visual';
    }
    if (candidate.quote && evidence.representation !== 'render') {
      const { lines } = JSON.parse(bytes.toString('utf8')) as { lines: ReaderLine[] };
      const matches = lines.filter((line) => line.text.includes(candidate.quote!)
        && (!candidate.lineId || candidate.lineId === line.id)
        && (!candidate.box || (line.box && contains(candidate.box, line.box))));
      if (matches.length !== 1) {
        throw new ReaderError('reader_quote_mismatch', 'Цитата не соответствует единственной строке в указанной выдаче', 422);
      }
      const [line] = matches;
      const context = candidate.deliveryStatement?.context;
      const verifiedContext = verifiedLine && candidate.deliveryStatement?.status === 'not_delivered'
        && verifiedLine.anchorEvidenceId === evidence.id && verifiedLine.line.id === line.id && context?.lineId === line.id
        && verifiedLine.crops.some(({ line: part }) => part.text.includes(context.quote));
      if (context && !verifiedContext && !lines.some((row) => row.id === context.lineId && row.text.includes(context.quote))) {
        throw new ReaderError('reader_quote_mismatch', 'Контекст утверждения отсутствует в этой выдаче', 422);
      }
      address = {
        ...address, box: line.box ?? address.box,
        locator: address.locator || line.locator ? { ...address.locator, ...line.locator } : undefined,
      };
      candidate.lineId = line.id;
      grounding = 'text';
    }
    let compound: ReturnType<typeof groundComponents> | undefined;
    if (parts) {
      const anchor = parts[0];
      if (!anchor || anchor.evidenceId !== evidence.id || anchor.lineId !== candidate.lineId || anchor.quote !== candidate.quote
        || anchor.literal !== candidate.value || parts.find(({ role }) => role === 'unit')?.literal !== candidate.unit) {
        throw new ReaderError('reader_component_anchor_mismatch', 'Якорь должен совпадать с сохранённым значением и адресом', 422);
      }
      const deliveredParts = new Map<string, { evidence: Evidence; lines: ReaderLine[] }>();
      for (const id of new Set(parts.map(({ evidenceId }) => evidenceId))) {
        const view: Evidence | undefined = id === evidence.id ? evidence : await findEvidence(source.projectId, id, tx);
        if (!view || view.runId !== scope.runId || view.branch !== scope.branch || view.representation === 'render') {
          throw new ReaderError('reader_evidence_scope_mismatch', 'Составной опоре нужна собственная адресная текстовая выдача', 422);
        }
        const partBytes = view === evidence ? bytes : await content(view);
        if (view.inputImage && view !== evidence) await content(view, 'ocr-input');
        const presentation = JSON.parse(partBytes.toString('utf8')) as NativePresentation;
        if (view.format === 'pdf' && view.representation === 'native' && view.address.box
          && (!presentation.address || fingerprint(presentation.address) !== fingerprint(view.address))) {
          throw new ReaderError('reader_artifact_mismatch', 'Адрес сохранённого PDF-фрагмента расходится с выдачей', 424);
        }
        deliveredParts.set(id, { evidence: view, lines: presentation.lines });
      }
      const needsCanonical = evidence.format === 'pdf' && evidence.representation === 'native' && evidence.address.box
        && parts.some(({ evidenceId, lineId, link }) => (link.kind === 'same_row' || link.kind === 'source_context')
          && lineId === anchor.lineId && parts[link.to]?.lineId === lineId && parts[link.to].evidenceId !== evidenceId);
      const canonical = needsCanonical && await indexedNative(source, evidence.readerVersion, 'pdf', {
        address: { unitId: evidence.address.unitId, locator: evidence.address.locator }, representation: 'native',
      }, tx);
      compound = groundComponents(parts, deliveredParts, canonical ? canonical.presentation : undefined);
    }
    const observation: Observation = {
      ...candidate, id: randomUUID(), source, receiptId: evidence.receiptId, readerVersion: evidence.readerVersion,
      runId: scope.runId, branch: scope.branch, address, grounding,
      ...(compound ? { components: compound.components, ...(compound.ifcUnit ? { unit: compound.ifcUnit } : {}) } : {}),
    };
    const stored = await conn.query<{ payload: Observation }>(
      `INSERT INTO reader_observations
       (id, project_id, version_id, run_id, branch, operation_key, request_sha256, evidence_id, scope_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (project_id, run_id, branch, operation_key) DO NOTHING RETURNING payload`,
      [observation.id, source.projectId, source.versionId, scope.runId, scope.branch,
        scope.operationKey, requestHash, evidence.id, candidate.scope, observation],
    );
    if (stored.rows[0]) return stored.rows[0].payload;
    const winner = await replay<Observation>(conn, 'reader_observations', source.projectId, scope, requestHash);
    if (!winner) throw new Error('Missing observation after concurrent insert');
    return winner;
  }

  async function latestMap(document: DocumentKey): Promise<PageMap | undefined> {
    const { rows } = await db.query<MapRow>(
      `SELECT * FROM reader_maps WHERE project_id = $1 AND document_id = $2 AND version_id = $3
       ORDER BY created_at DESC, reader_version DESC LIMIT 1`,
      [document.projectId, document.documentId, document.versionId],
    );
    if (rows[0]) return mapFromRow(rows[0]);
  }

  return {
    async readerVersion(format: string) { return await registry.get(format)?.version() ?? null; },
    async map(sourceRef: SourceRef): Promise<PageMap> {
      const source = checkedSource(sourceRef);
      const { original, adapter, version } = await describe(source);
      return await lookupMap(source, version)
        ?? await withOriginal(original, deps, (path) => insertMap(source, original, version, adapter, path));
    },
    latestMap, previewDwg,
    open, pin, findEvidence, content, readPdfFragment, previewPdfPage, materializeNative, readMaterializedNative, verifyNativeDeliveryLine,
    async findObservation(projectId: string, id: string): Promise<Observation | undefined> {
      const { rows } = await db.query<{ payload: Observation }>(
        'SELECT payload FROM reader_observations WHERE project_id = $1 AND id = $2', [projectId, id],
      );
      return rows[0]?.payload;
    },
    async listPositions(projectId: string, runId: string): Promise<{ A: Observation[]; B: Observation[] }> {
      const { rows } = await db.query<{ payload: Observation }>(
        'SELECT payload FROM reader_observations WHERE project_id = $1 AND run_id = $2 ORDER BY created_at, id',
        [projectId, runId],
      );
      const positions: { A: Observation[]; B: Observation[] } = { A: [], B: [] };
      for (const { payload } of rows) positions[payload.branch].push(payload);
      return positions;
    },
  };
}
