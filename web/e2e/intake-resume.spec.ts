import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accepted, admin, command, pdf, signIn, unique } from './synthetic';
import type { Inventory, Upload } from '../src/lib/intake';

async function hashStream(chunks: AsyncIterable<Uint8Array>) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of chunks) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest('hex') };
}

test('PDF and unfinished nested archive survive fresh sign-in and resume', async ({ browser, page, baseURL }, info) => {
  test.skip(process.env.FACADE_E2E_INTAKE_RESUME !== '1', 'Use a dedicated synthetic API and offline reader');
  const large = process.env.FACADE_E2E_INTAKE_RESUME_LARGE === '1';
  test.setTimeout(large ? 60 * 60_000 : 150_000);
  const login = admin.login!;
  const password = admin.password!;
  if (!login || !password) throw new Error('Specify the dedicated synthetic administrator');
  const origin = new URL(baseURL!).origin;
  const path = (url: string) => new URL(url).pathname;
  const ctx = page.context();
  await signIn(page, login, password);
  const { id: project } = await accepted<{ id: string }>(
    await command(ctx, origin, '/api/projects', 'POST', { name: unique('Синтетический приём R04'), mode: 'intake' }),
    'Проект',
  );
  const projectPath = '/projects/' + project;
  const { partSize, maxReceiptBytes } = await accepted<{ partSize: number; maxReceiptBytes: number }>(
    await ctx.request.get('/api' + projectPath + '/intake/capabilities'), 'Лимиты',
  );
  expect(maxReceiptBytes).toBe(10 * 1024 ** 3);

  const fixture = pdf('Synthetic R04 native text');
  const size = large ? maxReceiptBytes - fixture.buffer.length : partSize + 64 * 1024;
  const outer = join(info.outputDir, 'outer.zip');
  const pdfPath = join(info.outputDir, fixture.name);
  try {
    await mkdir(info.outputDir, { recursive: true });
    execFileSync('python3', ['-c', [
      'from hashlib import shake_256',
      'import io, os, sys, zipfile',
      'target, size = sys.argv[1], int(sys.argv[2])',
      'inner = io.BytesIO()',
      'with zipfile.ZipFile(inner, "w") as z: z.writestr("nested.txt", "synthetic R04")',
      'with zipfile.ZipFile(target, "w") as z:',
      '    z.writestr("inner.zip", inner.getvalue())',
      '    with z.open("padding.bin", "w", force_zip64=True) as f:',
      '        for offset in range(0, size - 4096, 1048576):',
      '            f.write(shake_256(f"facade-r04/{offset}".encode()).digest(min(1048576, size - 4096 - offset)))',
      'padding = size - os.stat(target).st_size',
      'assert 0 <= padding <= 4096',
      'with zipfile.ZipFile(target, "a") as z: z.comment = bytes(padding)',
      'assert os.stat(target).st_size == size',
    ].join('\n'), outer, String(size)], { timeout: large ? 10 * 60_000 : 15_000 });
    const archive = await hashStream(createReadStream(outer));
    expect(archive.size).toBe(size);
    await writeFile(pdfPath, fixture.buffer);

    let interrupted = 0;
    await page.route('**/api/uploads/*/parts/2', async (route) => {
      interrupted += 1;
      await route.abort('connectionreset');
    });
    await page.goto(projectPath + '/receipts?upload=1');
    const transfer = page.getByRole('form', { name: 'Передача исходных данных' });
    await transfer.getByLabel('Файлы или архивы').setInputFiles([pdfPath, outer]);
    const [created] = await Promise.all([
      page.waitForResponse((response) => path(response.url()) === '/api' + projectPath + '/receipts'
        && response.request().method() === 'POST', { timeout: large ? 10 * 60_000 : 40_000 }),
      transfer.getByRole('button', { name: 'Начать передачу' }).click(),
    ]);
    expect(created.status()).toBe(201);
    const { receiptId } = await created.json();
    const receipt = projectPath + '/receipts/' + receiptId;
    const inventoryPath = '/api/receipts/' + receiptId + '/inventory';
    await expect.poll(() => interrupted, { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await accepted<Inventory>(await ctx.request.get(inventoryPath), 'Опись до разрыва');
    expect(before).toMatchObject({ sealed: false, inventoryOpen: true });
    const pdfRow = before.occurrences.find((item) => item.relativePath === fixture.name)!;
    const waiting = before.manifest!.items.find((item) => item.relativePath === 'outer.zip')!;
    expect(pdfRow).toMatchObject({ status: 'accepted' });
    expect(waiting).toMatchObject({ kind: 'archive', status: 'uploading', confirmedBytes: partSize, sha256: archive.sha256 });

    const document = '/documents/' + pdfRow.documentId + '/versions/' + pdfRow.versionId;
    const units = '/api/v1' + document + '/reader/units';
    const map = async (session: typeof ctx) => {
      const response = await session.request.get(units);
      return response.ok() ? response.json() : null;
    };
    await expect.poll(() => map(ctx), { timeout: 50_000 }).toMatchObject({
      source: { sha256: pdfRow.sha256 },
      units: [{ locator: { page: 1 } }],
    });
    const savedMap = await map(ctx);
    await ctx.close();

    const reopened = await browser.newContext({ baseURL });
    try {
      const next = await reopened.newPage();
      await signIn(next, login, password, receipt);
      await expect(next.getByText('Опись открыта', { exact: true })).toBeVisible();
      await expect(next.getByText(/Осталось входов: 1/)).toBeVisible();
      await expect(next.getByText('outer.zip', { exact: true }).first()).toBeVisible();
      expect(await map(reopened)).toEqual(savedMap);
      expect(await accepted<Upload>(await reopened.request.get('/api/uploads/' + waiting.uploadId), 'Сохранённые части'))
        .toMatchObject({ confirmedBytes: partSize, parts: [{ number: 1, length: partSize }], status: 'uploading' });
      const pdfResponse = await reopened.request.get('/api' + document + '/content');
      expect(pdfResponse.ok()).toBe(true);
      expect(await pdfResponse.body()).toEqual(fixture.buffer);
      const pdfItem = next.getByRole('row').filter({ hasText: fixture.name });
      await pdfItem.getByRole('link', { name: 'Карточка документа' }).click();
      await expect(next.locator('.unit-list').getByRole('button')).toHaveCount(1);
      await next.goto(receipt);

      const sent: string[] = [];
      next.on('request', (request) => {
        const target = path(request.url());
        if (request.method() === 'PUT' && target.startsWith('/api/uploads/' + waiting.uploadId + '/parts/')) {
          sent.push(target.split('/').at(-1)!);
        }
      });
      await next.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
      const resume = next.getByRole('form', { name: 'Передача исходных данных' });
      await resume.getByLabel('Файлы или архивы').setInputFiles(outer);
      await resume.getByRole('button', { name: 'Продолжить передачу' }).click();
      await expect.poll(async () => {
        const view = await accepted<Inventory>(await reopened.request.get(inventoryPath), 'Опись после докачки');
        return view.manifest?.items.find((item) => item.itemId === waiting.itemId);
      }, { timeout: large ? 35 * 60_000 : 30_000 }).toMatchObject({
        status: 'accepted', confirmedBytes: waiting.size, uploadId: waiting.uploadId,
      });
      expect(sent).toEqual(Array.from({ length: Math.ceil(size / partSize) - 1 }, (_, index) => String(index + 2)));
      const after = await accepted<Inventory>(await reopened.request.get(inventoryPath), 'Опись после публикации');
      expect(after.sealed).toBe(true);
      const published = after.occurrences.find((item) => item.occurrenceId === waiting.occurrenceId)!;
      expect(published).toMatchObject({ mediaType: 'application/zip', sha256: archive.sha256 });
      const original = new URL('/api/documents/' + published.documentId + '/versions/' + published.versionId + '/content', origin);
      const cookie = (await reopened.cookies(original.href)).map(({ name, value }) => name + '=' + value).join('; ');
      const content = await fetch(original, { headers: { Cookie: cookie }, redirect: 'error' });
      expect(content.ok).toBe(true);
      const body = content.body!;
      expect(await hashStream(body as unknown as AsyncIterable<Uint8Array>)).toEqual(archive);
      if (process.env.FACADE_E2E_INTAKE_ARCHIVE_SETTLE === '1') {
        // When the dedicated worker has a broker, include archive work in the observation window.
        await expect.poll(async () => {
          return accepted<Inventory>(await reopened.request.get(inventoryPath), 'Раскрытие архива');
        }, { timeout: large ? 8 * 60_000 : 45_000 }).toMatchObject({ inventoryOpen: false });
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(outer, { force: true });
  }
});
