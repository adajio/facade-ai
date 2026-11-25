import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { accepted, admin, command, pdf, signIn, unique } from './synthetic';
import type { FacadeAssessment } from '../src/lib/facade-assessment';
import type { Inventory, Occurrence } from '../src/lib/intake';
import type { WorkSlice } from '../src/lib/work-slice';

const directCount = 23;
const archiveCount = 25;
const pdfCount = directCount + archiveCount;
const versionCount = pdfCount + 1;

type FileInput = ReturnType<typeof pdf>;
type MapView = {
  source: { versionId: string; sha256: string };
  format: string;
  readerVersion: string;
  units: { id: string; locator: { page?: number; coverage?: string; limitations?: string } }[];
};

function inputs(prefix: string, total: number): FileInput[] {
  return Array.from({ length: total }, (_, index) => ({
    ...pdf('Stage one test original ' + prefix + ' ' + index),
    name: prefix + '-' + String(index + 1).padStart(2, '0') + '.pdf',
  }));
}

function digest(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function evidence(info: TestInfo, name: string, value: unknown) {
  await info.attach(name + '.json', { contentType: 'application/json', body: JSON.stringify(value, null, 2) });
}

async function upload(page: Page, project: string, files: FileInput[]) {
  await page.goto('/projects/' + project + '/receipts?upload=1');
  const transfer = page.getByRole('form', { name: 'Передача исходных данных' });
  await transfer.getByLabel('Файлы или архивы').setInputFiles(files);
  const [response] = await Promise.all([
    page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/projects/' + project + '/receipts' &&
      reply.request().method() === 'POST', { timeout: 45_000 }),
    transfer.getByRole('button', { name: 'Начать передачу' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const { receiptId } = await response.json() as { receiptId: string };
  await expect(page.getByText('Передача завершена. Принятые оригиналы доступны в описи.', { exact: true }))
    .toBeVisible({ timeout: 180_000 });
  return receiptId;
}

test('Стадия 1: 23 прямых PDF, 25 PDF в ZIP, опись, карты, 0 из 16 и повтор того же файла', async ({ page, baseURL }, info) => {
  test.skip(process.env.FACADE_E2E_STAGE_ONE_VOLUME !== '1', 'Нужны выделенный API, работающий worker без модельного транспорта и брокер архивов');
  test.setTimeout(420_000);
  if (!admin.login || !admin.password) throw new Error('Нужен администратор выделенной синтетической БД');

  const direct = inputs('direct', directCount);
  const nested = inputs('inside', archiveCount);
  await mkdir(info.outputDir, { recursive: true });
  await Promise.all(nested.map((file) => writeFile(info.outputPath(file.name), file.buffer)));
  const archivePath = info.outputPath('package.zip');
  execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'from pathlib import Path',
    'archive, *entries = sys.argv[1:]',
    'with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:',
    '    for entry in entries:',
    '        file = Path(entry)',
    '        package.writestr(zipfile.ZipInfo(file.name), file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)',
  ].join('\n'), archivePath, ...nested.map((file) => info.outputPath(file.name))]);
  const archive = { name: 'package.zip', mimeType: 'application/zip', buffer: await readFile(archivePath) };
  const manifest = [
    ...direct.map((file) => ({ path: file.name, sha256: digest(file.buffer), parent: null })),
    { path: archive.name, sha256: digest(archive.buffer), parent: null },
    ...nested.map((file) => ({ path: file.name, sha256: digest(file.buffer), parent: archive.name })),
  ];
  expect(new Set(manifest.map(({ sha256 }) => sha256)).size).toBe(versionCount);
  await evidence(info, 'expected-originals', manifest);

  const origin = new URL(baseURL!).origin;
  await signIn(page, admin.login, admin.password);
  const catalogSource = JSON.parse(await readFile(new URL('../../infra/catalogs/intake-stage-1.json', import.meta.url), 'utf8'));
  const { id: catalogVersionId } = await accepted<{ id: string }>(
    await command(page.context(), origin, '/api/catalogs', 'POST', { ...catalogSource, key: unique('volume-catalog') }),
    'Каталог стадии 1',
  );
  const { id: project } = await accepted<{ id: string }>(await command(page.context(), origin, '/api/projects', 'POST', {
    mode: 'intake', name: unique('Объём стадии 1'),
  }), 'Создать проект');
  const projectPath = '/projects/' + project;
  const api = '/api' + projectPath;
  const assessment = async () => accepted<FacadeAssessment>(
    await page.request.get(api + '/facade-assessment'), 'Актуальная комплектность',
  );
  const workSlice = async () => accepted<WorkSlice>(
    await page.request.get(api + '/work-slices/current'), 'Текущий срез',
  );
  const inventory = async (receiptId: string) => {
    const response = await page.request.get('/api/receipts/' + receiptId + '/inventory');
    if (!response.ok()) {
      const { code, requestId } = await response.json() as { code: string; requestId: string };
      throw new Error('Опись ' + receiptId + ' · HTTP ' + response.status() + ' · ' + code + ' · запрос ' + requestId);
    }
    return response.json() as Promise<Inventory>;
  };
  async function map(item: Occurrence) {
    if (!item.documentId || !item.versionId) throw new Error('У принятого файла нет адреса редакции');
    const response = await page.request.get('/api/v1/documents/' + item.documentId + '/versions/' + item.versionId + '/reader/units');
    if (response.status() === 404) return null;
    return accepted<MapView>(response, 'Карта ' + item.relativePath);
  }

  const empty = await assessment();
  expect(empty.catalogVersionId).toBe(catalogVersionId);
  expect(empty.stage).toBe('Стадия 1');
  expect(empty.contexts).toHaveLength(1);
  const initialQuestions = empty.contexts[0].questions.map(({ id }) => id).sort();
  expect(new Set(initialQuestions).size).toBe(16);
  await page.goto(projectPath + '/overview');
  await expect(page.getByRole('link', { name: 'Загрузить первый комплект' })).toBeVisible();

  const receiptId = await upload(page, project, [...direct, archive]);
  let snapshot: Inventory | undefined;
  try {
    await expect.poll(async () => {
      snapshot = await inventory(receiptId);
      return {
        sealed: snapshot.sealed,
        open: snapshot.inventoryOpen,
        accepted: snapshot.occurrences.filter(({ status }) => status === 'accepted').length,
        restrictions: snapshot.occurrences.flatMap(({ relativePath, restriction }) => restriction ? [[relativePath, restriction]] : []),
      };
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000], message: 'Реальный worker раскрывает все элементы ZIP и закрывает опись' })
      .toEqual({ sealed: true, open: false, accepted: versionCount, restrictions: [] });
  } finally {
    if (snapshot) await evidence(info, 'first-receipt', snapshot);
  }
  const acceptedFiles = snapshot!.occurrences;
  expect(acceptedFiles).toHaveLength(versionCount);
  expect(new Set(acceptedFiles.map((file) => file.versionId)).size).toBe(versionCount);
  const container = acceptedFiles.find((item) => item.relativePath === archive.name)!;
  expect(container).toMatchObject({ status: 'accepted', mediaType: 'application/zip', inventoryPending: false });
  const archiveState = await accepted(
    await page.request.get('/api/receipts/' + receiptId + '/archive-inventory/' + container.occurrenceId), 'Состояние раскрытия ZIP',
  );
  expect(archiveState).toMatchObject({ state: 'completed', unknownRemainder: false, versionId: container.versionId });
  expect(acceptedFiles.map(({ relativePath, sha256, parentOccurrenceId }) => ({
    path: relativePath, sha256, parent: parentOccurrenceId === container.occurrenceId ? archive.name : parentOccurrenceId ?? null,
  })).sort((a, b) => a.path.localeCompare(b.path))).toEqual(manifest.sort((a, b) => a.path.localeCompare(b.path)));

  let slice: WorkSlice | undefined;
  try {
    await expect.poll(async () => {
      slice = await workSlice();
      return { files: slice.files, open: slice.totals.open, occurrences: slice.acceptedOccurrences, transport: slice.readingService?.enabled };
    }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000], message: 'Карты всех PDF с активным локальным worker и выключенным транспортом' })
      .toEqual({ files: { accepted: versionCount, prepared: pdfCount }, open: 0, occurrences: versionCount, transport: false });
  } finally {
    if (slice) await evidence(info, 'work-slice', slice);
  }
  expect(Date.parse(slice!.readingService!.validUntil)).toBeGreaterThan(Date.now());
  expect(slice!.assessment).toMatchObject({ total: 16, checked: 0 });
  const maps = [];
  for (let offset = 0; offset < acceptedFiles.length; offset += 4) {
    const loaded = await Promise.all(acceptedFiles.slice(offset, offset + 4).map(async (item) => ({ item, map: await map(item) })));
    maps.push(...loaded);
  }
  for (const { item, map: readerMap } of maps) {
    if (item.occurrenceId === container.occurrenceId) {
      expect(readerMap).toMatchObject({
        source: { versionId: item.versionId, sha256: item.sha256 },
        format: 'unknown',
        units: [{ id: 'original', locator: { coverage: 'original_only', limitations: 'format_original_only' } }],
      });
    } else {
      expect(readerMap, item.relativePath).toMatchObject({
        source: { versionId: item.versionId, sha256: item.sha256 }, units: [{ locator: { page: 1 } }],
      });
    }
  }
  await evidence(info, 'verified-maps', maps.map(({ item, map: readerMap }) => ({
    path: item.relativePath, versionId: item.versionId, format: readerMap?.format, readerVersion: readerMap?.readerVersion,
    units: readerMap?.units,
  })));

  await page.goto(projectPath + '/overview');
  const progress = page.getByRole('region', { name: 'Ход обработки проекта' });
  await expect(progress.getByText('Подготовлено 48 из 49 принятых файлов · описи закрыты')).toBeVisible();
  await expect(progress.getByText('Проверено 0 из 16 требований')).toBeVisible();
  await expect(progress.getByRole('status')).toContainText('Автоматическое чтение отключено');
  await page.screenshot({ path: info.outputPath('overview.png') });
  await progress.getByRole('link', { name: 'Посмотреть все 16 требований' }).click();
  const rows = page.locator('[data-triage-row]');
  await expect(rows).toHaveCount(16);
  const browserIds = await rows.evaluateAll((links) => links.map(({ id }) => id.replace('requirement-', '')).sort());
  expect(browserIds).toEqual(initialQuestions);
  const opened = new URL(page.url());
  expect(opened.searchParams.get('context')).toBe(empty.contexts[0].assessmentContextId);
  expect(opened.searchParams.has('revision')).toBe(false);
  await rows.filter({ hasText: /^Раздел АР$/ }).click();
  await expect(page.getByRole('heading', { name: 'Раздел АР', exact: true })).toBeFocused();
  await expect(page.getByText('Критерий достаточности', { exact: true })).toBeVisible();
  await expect(page.getByText(/Допустимая замена: DXF/)).toBeVisible();
  await evidence(info, 'requirement-ids', { catalogVersionId, before: initialQuestions, opened: browserIds });

  const original = acceptedFiles.find(({ relativePath }) => relativePath === direct[0].name)!;
  const repeatId = await upload(page, project, [direct[0]]);
  let repeated: Occurrence | undefined;
  await expect.poll(async () => {
    const result = await inventory(repeatId);
    repeated = result.occurrences.find(({ relativePath }) => relativePath === original.relativePath);
    return { sealed: result.sealed, open: result.inventoryOpen, status: repeated?.status };
  }, { timeout: 45_000 }).toEqual({ sealed: true, open: false, status: 'accepted' });
  expect(repeated!.sha256).toBe(original.sha256);
  expect(repeated!.occurrenceId).not.toBe(original.occurrenceId);
  expect(repeated!.originalId).toBe(original.originalId);
  await expect.poll(() => map(repeated!), { timeout: 75_000 }).not.toBeNull();
  const after = await workSlice();
  await evidence(info, 'duplicate', {
    first: original, repeated, firstMap: await map(original), repeatedMap: await map(repeated!),
    acceptedOccurrences: after.acceptedOccurrences, files: after.files, assessment: after.assessment,
  });
  expect(after.acceptedOccurrences).toBe(versionCount + 1);
  expect(after.assessment).toMatchObject({ total: 16, checked: 0 });
  expect.soft(repeated!.versionId, 'Повтор тех же байтов имеет ту же редакцию').toBe(original.versionId);
  expect.soft(after.files, 'Два вхождения используют одну редакцию и её карту').toEqual({ accepted: versionCount, prepared: pdfCount });
});
