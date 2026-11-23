import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { accepted, admin, command, signIn, unique } from './synthetic';

// Each physical page has a different visible marker. This checks the pixels
// painted by Chrome's PDF viewer, independently of the frame URL and HTTP status.
function markedPdf() {
  const stream = (color: string) => {
    const content = `${color} rg 30 440 180 160 re f\n`;
    return `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 660] /Contents 4 0 R >>',
    stream('1 0 0'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 660] /Contents 6 0 R >>',
    stream('0 1 0'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, entry] of objects.entries()) {
    offsets.push(String(pdf.length).padStart(10, '0') + ' 00000 n \n');
    pdf += `${index + 1} 0 obj\n${entry}\nendobj\n`;
  }
  return Buffer.from(pdf + `xref\n0 ${offsets.length}\n${offsets.join('')}` +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

async function expectRenderedPage(
  frame: Locator, marker: 'red' | 'green', evidence: string, testInfo: TestInfo,
) {
  await expect(async () => {
    const pixels = await frame.screenshot({ timeout: 2000 });
    const counts = await frame.page().evaluate(async (png) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      let green = 0;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
        if (r >= 220 && g < 60 && b < 60) red++;
        if (g >= 220 && r < 60 && b < 60) green++;
      }
      return { red, green };
    }, pixels.toString('base64'));
    expect(counts[marker]).toBeGreaterThan(1000);
    expect(counts[marker === 'red' ? 'green' : 'red']).toBeLessThan(100);
    const path = testInfo.outputPath(evidence + '.png');
    await writeFile(path, pixels);
    await testInfo.attach(evidence, { path, contentType: 'image/png' });
  }).toPass({ timeout: 12_000 });
}

test('Комплект без стадии, оригинал PDF, адрес листа и возврат к описи', async ({ page }, testInfo) => {
  test.skip(!admin.login || !admin.password, 'Нужна отдельная синтетическая БД');
  test.setTimeout(150_000);
  const fixture = markedPdf();
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  await page.setViewportSize({ width: 480, height: 900 });
  await signIn(page, admin.login!, admin.password!);
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByLabel('Название проекта').fill(unique('Синтетический комплект'));
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(page.getByRole('link', { name: 'Загрузить комплект' })).toBeVisible();
  await page.getByRole('link', { name: 'Загрузить комплект' }).press('Enter');
  await expect(page).toHaveURL(/\/receipts\?upload=1$/);
  await expect(page.getByRole('heading', { name: 'Новое поступление' })).toBeVisible();
  const filename = 'Два синтетических листа.pdf';
  await page.getByLabel('Файлы или архивы').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: fixture });
  await page.getByRole('button', { name: 'Начать передачу' }).click();

  const row = page.getByRole('row').filter({ hasText: filename }).filter({ has: page.getByRole('link', { name: 'Карточка документа' }) });
  await expect(row).toBeVisible({ timeout: 45_000 });
  const rowId = await row.getAttribute('id');
  const card = row.getByRole('link', { name: 'Карточка документа' });
  await card.press('Enter');
  await expect(page.getByRole('heading', { name: filename })).toBeFocused();
  await expect(page).toHaveURL(/\/receipts\/[^?]+\?.*document=.*row=/);
  await expect(page.getByText('Состояние чтения', { exact: true })).toBeVisible();
  const download = page.getByRole('link', { name: 'Скачать оригинал' });
  const href = (await download.getAttribute('href'))!;
  const state = await page.request.get(href.replace(/\/content$/, '/work'));
  expect(state.status()).toBe(200);
  expect(await state.json()).toMatchObject({ catalogAssigned: false, jobs: expect.any(Array) });
  const head = await page.request.head(href);
  expect(head.status()).toBe(200);
  expect(head.headers()['etag']).toBe('"sha256-' + hash(fixture) + '"');
  expect(head.headers()['content-length']).toBe(String(fixture.length));
  const range = await page.request.get(href, { headers: { Range: 'bytes=0-7' } });
  expect(range.status()).toBe(206);
  expect(await range.body()).toEqual(fixture.subarray(0, 8));
  expect((await page.request.head(href.replace(/\/versions\/[^/]+/, '/versions/' + randomUUID()))).status()).toBe(404);

  const [saved] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const target = await saved.path();
  expect(hash(await readFile(target!))).toBe(hash(fixture));

  await page.getByRole('button', { name: 'Открыть оригинал' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Оригинал PDF' })).toBeFocused();
  const firstPage = page.locator('iframe[title="Оригинал PDF, страница 1"]');
  await expect(firstPage).toHaveAttribute('src', href + '#page=1');
  await expectRenderedPage(firstPage, 'red', 'pdf-page-1', testInfo);
  await page.getByRole('button', { name: 'Следующая страница' }).press('Enter');
  const secondPage = page.locator('iframe[title="Оригинал PDF, страница 2"]');
  await expect(secondPage).toHaveAttribute('src', href + '#page=2');
  await expectRenderedPage(secondPage, 'green', 'pdf-page-2-before-event', testInfo);
  const displayedFrame = await secondPage.elementHandle();

  const projectId = new URL(page.url()).pathname.split('/')[2];
  const projectPath = '/api/projects/' + projectId;
  const slice = page.getByText(/^Срез \d+$/);
  await page.waitForResponse((response) => new URL(response.url()).pathname === projectPath + '/events' && response.ok());
  const receiptId = randomUUID();
  const publication = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== projectPath + '/events' || !response.ok()) return false;
    const { events } = await response.json() as { events: { type: string; payload: { receiptId?: string } }[] };
    return events.some((event) => event.type === 'intake.receipt_created' && event.payload.receiptId === receiptId);
  });
  await accepted(await command(page.context(), new URL(page.url()).origin, projectPath + '/receipts', 'POST',
    { receiptId, source: 'upload', mode: 'open',
      items: [{ itemId: randomUUID(), kind: 'file', relativePath: 'соседний-лист.pdf',
        size: fixture.length, sha256: hash(fixture), mediaType: 'application/pdf' }] }),
    'Публикация события по соседнему поступлению');
  const { cursor } = await (await publication).json() as { cursor: string };
  await expect.poll(async () => Number((await slice.innerText()).split(' ')[1])).toBeGreaterThanOrEqual(Number(cursor));
  expect(await displayedFrame.evaluate((element) => element.isConnected)).toBe(true);
  await expectRenderedPage(secondPage, 'green', 'pdf-page-2-after-event', testInfo);

  await page.reload();
  await expect(secondPage).toHaveAttribute('src', href + '#page=2');
  await expectRenderedPage(secondPage, 'green', 'pdf-page-2-after-reload', testInfo);
  await page.getByRole('link', { name: 'К описи' }).press('Enter');
  await expect(page.locator('[id="' + rowId + '"]')).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]document=/);
});
