import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { admin, signIn, unique } from './synthetic';

test('Комплект без стадии, оригинал PDF, адрес листа и возврат к описи', async ({ page }) => {
  test.skip(!admin.login || !admin.password, 'Нужна отдельная синтетическая БД');
  const fixture = await readFile(new URL('../../test/fixtures/input/facade-package.pdf', import.meta.url));
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
  await expect(page.locator('iframe[title="Оригинал PDF, страница 1"]')).toHaveAttribute('src', href + '#page=1');
  await page.getByRole('button', { name: 'Следующая страница' }).press('Enter');
  await expect(page.locator('iframe[title="Оригинал PDF, страница 2"]')).toHaveAttribute('src', href + '#page=2');
  await page.reload();
  await expect(page.locator('iframe[title="Оригинал PDF, страница 2"]')).toHaveAttribute('src', href + '#page=2');
  await page.getByRole('link', { name: 'К описи' }).press('Enter');
  await expect(page.locator('[id="' + rowId + '"]')).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]document=/);
});
