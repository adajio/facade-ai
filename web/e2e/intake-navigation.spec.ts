import { expect, test } from '@playwright/test';
import type { Part } from '../src/lib/intake';

for (const { pause, name } of [
  { pause: false, name: 'Передача продолжается при смене проекта и показывает прогресс после возврата' },
  { pause: true, name: 'После паузы и перезагрузки докачиваются только неподтверждённые части' },
]) test(name, async ({ page }) => {
  const project = { id: 'intake-first', name: 'Первый проект', version: 1, scopes: [], intakeMode: true,
    actions: ['project:read', 'project:engineer'] };
  const other = { ...project, id: 'intake-second', name: 'Второй проект' };
  const receipts = '/projects/' + project.id + '/receipts';
  const file = { name: 'synthetic.zip', mimeType: 'application/zip', buffer: Buffer.from('0123456789abcdef') };
  const position = { sliceId: 'test', cursor: '0', projectionVersion: '0' };
  const parts: Part[] = [];
  const requestedParts: number[] = [];
  let declared: { receiptId: string; items: { itemId: string; relativePath: string; sha256: string }[] } | undefined;
  let complete = false;
  let finishThird!: () => void;
  const third = new Promise<void>(resolve => { finishThird = resolve; });
  let finishOriginal!: () => void;
  const original = new Promise<void>(resolve => { finishOriginal = resolve; });
  const upload = () => ({
    uploadId: 'upload', size: file.buffer.length, sha256: declared?.items[0].sha256, partSize: 4,
    confirmedBytes: parts.length * 4, status: complete ? 'complete' : 'uploading', parts,
  });
  const receipt = () => ({ receiptId: declared?.receiptId, number: 1, source: 'upload', sealed: complete, inventoryOpen: !complete });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: {
      user: { id: 'operator', login: 'operator', organizationId: 'synthetic' }, csrfToken: 'synthetic',
      projects: [project, other],
    } });
    for (const entry of [project, other]) {
      const root = '/api/projects/' + entry.id;
      if (path === root) return route.fulfill({ json: entry });
      if (path === root + '/snapshot') return route.fulfill({ json: position });
      if (path === root + '/events') return route.fulfill({ json: { events: [], cursor: '0', head: position, hasMore: false } });
    }
    if (path === '/api' + receipts && route.request().method() === 'POST') {
      declared = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: receipt() });
    }
    if (path === '/api' + receipts) return route.fulfill({ json: { receipts: declared ? [receipt()] : [] } });
    if (declared && path === '/api/receipts/' + declared.receiptId + '/inventory') {
      return route.fulfill({ json: {
        ...receipt(), projectId: project.id, uploads: [], imports: [], occurrences: [],
        manifest: { mode: 'once', version: 1, items: [{
          ...declared.items[0], kind: 'archive', size: file.buffer.length, confirmedBytes: parts.length * 4,
          status: complete ? 'accepted' : 'uploading', expiresAt: '2026-12-01T00:00:00Z',
        }] },
      } });
    }
    if (path.endsWith('/manifest/' + declared?.items[0].itemId + '/upload') || path === '/api/uploads/upload') {
      return route.fulfill({ json: upload() });
    }
    if (path.startsWith('/api/uploads/upload/parts/')) {
      const part = Number(path.split('/').at(-1));
      requestedParts.push(part);
      if (part === 3 && requestedParts.length === 3) {
        await third;
        if (pause) {
          await route.abort().catch(() => {});
          return;
        }
      }
      parts.push({ number: part, offset: (part - 1) * 4, length: 4, sha256: route.request().headers()['x-part-sha256'] });
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/api/uploads/upload/complete') {
      await original;
      complete = true;
      return route.fulfill({ json: upload() });
    }
    if (path.endsWith('/capabilities')) return route.fulfill({ json: {} });
    if (path.endsWith('/supplements/links') || path.endsWith('/import-inventory')) {
      return route.fulfill({ json: { items: [] } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });

  await page.goto(receipts + '?upload=1');
  const form = page.getByRole('form', { name: 'Передача исходных данных' });
  await form.getByLabel('Файлы или архивы').setInputFiles(file);
  const thirdRequest = page.waitForRequest('**/api/uploads/upload/parts/3');
  await form.getByRole('button', { name: 'Начать передачу' }).click();
  await thirdRequest;
  expect(parts.map(part => part.number)).toEqual([1, 2]);

  const finalizeRequest = page.waitForRequest('**/api/uploads/upload/complete');
  try {
    await page.getByRole('link', { name: 'Обзор', exact: true }).click();
    await page.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Поступления' }).click();
    const status = page.getByRole('region', { name: 'Статус передачи' });
    await expect(status.getByRole('progressbar')).toHaveAttribute('value', '8');
    await status.getByRole('link', { name: 'Открыть опись передачи' }).click();
    await expect(page.getByRole('progressbar', { name: 'Подтверждённые байты файла synthetic.zip' })).toHaveAttribute('value', '8');
    if (pause) {
      await status.getByRole('button', { name: 'Приостановить' }).click();
      await expect(status.getByRole('alert')).toHaveText('Передача приостановлена. Уже принятые части сохранены.');
    } else {
      await page.getByRole('link', { name: 'Все проекты' }).click();
      await page.getByRole('link', { name: other.name, exact: true }).click();
      await expect(page.locator('.project-name')).toHaveText(other.name);
      await expect(status).toHaveCount(0);
    }
  } finally {
    finishThird();
  }
  try {
    if (pause) {
      await page.reload();
      await expect(page.getByRole('progressbar', { name: 'Подтверждённые байты файла synthetic.zip' })).toHaveAttribute('value', '8');
      await page.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
      await form.getByLabel('Файлы или архивы').setInputFiles(file);
      await form.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
    }
    await finalizeRequest;
    if (pause) await expect(page.getByRole('region', { name: 'Статус передачи' }))
      .toContainText('Сохраняем оригинал в хранилище');
  } finally {
    finishOriginal();
  }
  await expect.poll(() => complete, { timeout: 3000 }).toBe(true);
  expect(requestedParts).toEqual(pause ? [1, 2, 3, 3, 4] : [1, 2, 3, 4]);
  if (!pause) {
    await expect(page.locator('.project-name')).toHaveText(other.name);
    await page.getByRole('link', { name: 'Все проекты' }).click();
    await page.getByRole('link', { name: project.name, exact: true }).click();
    await page.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Поступления' }).click();
  }
  await expect(page.getByRole('region', { name: 'Статус передачи' }))
    .toContainText('Передача завершена. Принятые оригиналы доступны в описи.');
});
