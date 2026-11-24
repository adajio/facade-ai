import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accepted, account, admin, command, signIn, unique } from './synthetic';

const allowedQuote = 'FA-1 30 mm';
const otherQuote = 'FB-2 PRIVATE 47 mm';

function mixedSheet() {
  const stream = [
    'BT /F1 18 Tf 40 240 Td (' + allowedQuote + ') Tj ET',
    'BT /F1 18 Tf 224 240 Td (' + otherQuote + ') Tj ET',
    '1 0 0 rg 40 146 115 36 re f',
    '0 1 0 rg 161 146 181 36 re f',
  ].join('\n') + '\n';
  const entries = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, entry] of entries.entries()) {
    offsets.push(String(pdf.length).padStart(10, '0') + ' 00000 n \n');
    pdf += (index + 1) + ' 0 obj\n' + entry + '\nendobj\n';
  }
  const file = pdf + 'xref\n0 ' + offsets.length + '\n' + offsets.join('') +
    'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + pdf.length + '\n%%EOF\n';
  return { name: 'MIXED-SYNTHETIC.pdf', mimeType: 'application/pdf', buffer: Buffer.from(file) };
}

async function hidden(request: APIRequestContext, path: string) {
  expect((await request.get(path)).status(), path).toBe(404);
  expect((await request.head(path)).status(), path + ' HEAD').toBe(404);
  expect((await request.get(path, { headers: { Range: 'bytes=0-19' } })).status(), path + ' Range').toBe(404);
}

async function pixelCounts(page: Page) {
  return page.getByRole('img', { name: 'Обрезанное изображение фрагмента' }).evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement('canvas');
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const painter = canvas.getContext('2d')!;
    painter.drawImage(node, 0, 0);
    const bytes = painter.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let green = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      const [r, g, b] = bytes.subarray(index, index + 3);
      if (r >= 220 && g < 60 && b < 60) red++;
      if (g >= 220 && r < 60 && b < 60) green++;
    }
    return { width: canvas.width, height: canvas.height, red, green };
  });
}

async function editFragment(
  page: Page, frame: { x: number; y: number; width: number; height: number }, quote?: string,
) {
  await page.getByLabel('Слева', { exact: true }).fill(String(frame.x));
  await page.getByLabel('Сверху', { exact: true }).fill(String(frame.y));
  await page.getByLabel('Ширина', { exact: true }).fill(String(frame.width));
  await page.getByLabel('Высота', { exact: true }).fill(String(frame.height));
  await page.getByLabel('Вид фрагмента').selectOption(quote === undefined ? 'crop' : 'quote');
  if (quote !== undefined) await page.getByLabel('Точная цитата', { exact: true }).fill(quote);
  await page.getByLabel('Основание подготовки').fill('Синтетическая проверка адреса');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
}

async function grant(page: Page) {
  await page.getByLabel('Основание выдачи').fill('Проверена выбранная рамка');
  await page.getByRole('button', { name: 'Выдать в выбранную область' }).click();
  await expect(page.getByLabel('Основание отзыва')).toBeVisible();
}

test('Смешанный PDF: инженер выдаёт точную цитату и обрезку, участник открывает только свою область', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!admin.login || !admin.password, 'Нужна отдельная синтетическая БД');
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const engineer = await browser.newPage({ baseURL });
  const viewer = await browser.newPage({ baseURL });
  const other = await browser.newPage({ baseURL });
  try {
    await signIn(page, admin.login!, admin.password!);
    const owner = page.context();
    const name = unique('Смешанный комплект');
    const project = await accepted<{ id: string; version: number }>(
      await command(owner, origin, '/api/projects', 'POST', { name, mode: 'intake' }), 'Создание проекта');
    const projectPath = '/api/projects/' + project.id;
    const projectUi = '/projects/' + project.id;
    const areaA = await accepted<{ id: string }>(await command(owner, origin, projectPath + '/scopes', 'POST',
      { name: 'Фасад A', stage: 'РД' }), 'Область A');
    const areaB = await accepted<{ id: string }>(await command(owner, origin, projectPath + '/scopes', 'POST',
      { name: 'Фасад B', stage: 'РД' }), 'Область B');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    for (const [target, scope] of [[engineer, undefined], [viewer, areaA.id], [other, areaB.id]] as const) {
      const member = await account(owner, target.context(), origin, 'fragment-member');
      const current = await accepted<{ version: number }>(await page.request.get(projectPath), 'Версия проекта');
      const role = scope ? { role: 'viewer', scopeId: scope, expiresAt, reason: 'Временная синтетическая выдача' }
        : { role: 'engineer' };
      await accepted(await command(owner, origin, projectPath + '/members/' + member.userId, 'PUT', role, current.version),
        'Назначение участника');
      await signIn(target, member.login, member.password);
    }
    await viewer.getByRole('link', { name, exact: true }).click();
    await expect(viewer.getByRole('heading', { name: 'Фрагменты', exact: true })).toBeVisible();
    await expect(viewer.getByText('В этой области нет доступных фрагментов.')).toBeVisible();
    await expect(viewer.getByText('Подготовить фрагмент PDF')).toHaveCount(0);

    const pdf = mixedSheet();
    const receipt = await accepted<{ receiptId: string }>(await command(engineer.context(), origin,
      projectPath + '/receipts', 'POST', { source: 'upload' }), 'Поступление');
    const sha256 = createHash('sha256').update(pdf.buffer).digest('hex');
    const { uploadId } = await accepted<{ uploadId: string }>(await command(engineer.context(), origin,
      '/api/receipts/' + receipt.receiptId + '/uploads', 'POST',
      { relativePath: pdf.name, size: pdf.buffer.length, sha256, mediaType: pdf.mimeType }), 'Объявление оригинала');
    const { csrfToken } = await (await engineer.request.get('/api/me')).json();
    await accepted(await engineer.request.put('/api/uploads/' + uploadId + '/parts/1', {
      data: pdf.buffer, headers: { Origin: origin, 'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/octet-stream', 'X-Part-Sha256': sha256 },
    }), 'Передача исходника');
    await accepted(await command(engineer.context(), origin, '/api/uploads/' + uploadId + '/complete', 'POST', {}), 'Приём оригинала');
    await engineer.goto(projectUi + '/receipts/' + receipt.receiptId + '?scope=' + areaA.id);
    const row = engineer.getByRole('row').filter({ hasText: pdf.name })
      .filter({ has: engineer.getByRole('link', { name: 'Карточка документа' }) });
    await row.getByRole('link', { name: 'Карточка документа' }).click();
    const raw = (await engineer.getByRole('link', { name: 'Скачать оригинал' }).getAttribute('href'))!;
    const docCard = engineer.url();
    const readerMap = raw.replace('/api/documents/', '/api/v1/documents/').replace('/content', '/reader/units');
    const verifyMixedDenial = async () => {
      for (const path of [raw, raw.replace('/content', '/work'), readerMap, projectPath + '/facade-assessment',
        projectPath + '/receipts', projectPath + '/snapshot', projectPath + '/events?after=0']) {
        await hidden(viewer.request, path);
      }
    };
    await verifyMixedDenial();
    await engineer.getByRole('link', { name: 'Подготовить фрагмент' }).click();
    const textFrame = { x: 31, y: 36, width: 150, height: 40 };
    await editFragment(engineer, textFrame, otherQuote);
    await expect(engineer.getByText('Цитата должна дословно и однозначно находиться внутри рамки')).toBeVisible();
    await editFragment(engineer, textFrame, allowedQuote);
    await expect(engineer.getByText(allowedQuote, { exact: true })).toBeVisible();
    const textUi = new URL(engineer.url());
    const textId = textUi.pathname.split('/').at(-1)!;
    const collection = (scopeId: string) => projectPath + '/scopes/' + scopeId + '/fragment-publications';
    const textApi = collection(areaA.id) + '/' + textId;
    await hidden(viewer.request, textApi);
    await viewer.goto(textUi.href);
    await expect(viewer.getByText('Для этой области требуется отдельная действующая выдача.', { exact: false })).toBeVisible();
    const reason = { reason: 'Недопустимая команда просмотра' };
    expect((await command(viewer.context(), origin, textApi + '/grant', 'POST', reason, 1)).status()).toBe(403);
    expect((await command(viewer.context(), origin, collection(areaA.id), 'POST', {
      documentId: raw.split('/')[3], versionId: raw.split('/')[5], page: 1, kind: 'quote', box: textFrame, quote: allowedQuote,
      reason: reason.reason,
    })).status()).toBe(403);
    await grant(engineer);
    await viewer.reload();
    await expect(viewer.getByText(allowedQuote, { exact: true })).toBeVisible();
    await expect(viewer.getByText(otherQuote, { exact: false })).toHaveCount(0);
    await expect(viewer.getByRole('link', { name: 'Скачать оригинал' })).toHaveCount(0);
    const quoteResponse = await viewer.request.get(textApi);
    expect(quoteResponse.headers()['cache-control']).toBe('no-store');
    expect(await quoteResponse.json()).toEqual({
      id: textId, version: 2, state: 'granted', page: 1, box: textFrame, quote: allowedQuote,
    });
    const conflicting = await command(engineer.context(), origin, textApi + '/grant', 'POST', reason, 1);
    expect(conflicting.status()).toBe(412);
    expect((await conflicting.json()).currentVersion).toBe(2);

    const docToFragment = () => engineer.getByRole('link', { name: 'Подготовить фрагмент' }).click();
    await engineer.goto(docCard);
    await docToFragment();
    await editFragment(engineer, { x: 30.24, y: 110.24, width: 130.52, height: 50.52 });
    const draft = engineer.getByRole('img', { name: 'Обрезанное изображение фрагмента' });
    await expect(draft).toBeVisible();
    const cropUi = engineer.url();
    const cropId = new URL(cropUi).pathname.split('/').at(-1)!;
    const draftUrl = (await draft.getAttribute('src'))!;
    await hidden(viewer.request, draftUrl);
    await grant(engineer);
    const preview = collection(areaA.id) + '/' + cropId + '/versions/2/preview';
    await expect(draft).toHaveAttribute('src', preview);
    await hidden(viewer.request, draftUrl);
    await hidden(other.request, preview);

    await engineer.goto(docCard);
    await docToFragment();
    await engineer.getByLabel('Стадия и область').selectOption(areaB.id);
    await editFragment(engineer, { x: 161, y: 110, width: 184, height: 50 });
    await grant(engineer);
    const otherUi = engineer.url();
    const otherId = new URL(otherUi).pathname.split('/').at(-1)!;
    const otherPreview = collection(areaB.id) + '/' + otherId + '/versions/2/preview';
    await hidden(viewer.request, otherPreview);
    await hidden(viewer.request, collection(areaA.id) + '/' + otherId + '/versions/2/preview');
    await other.goto(otherUi);
    await expect(other.getByRole('img', { name: 'Обрезанное изображение фрагмента' })).toBeVisible();
    const otherPixels = await pixelCounts(other);
    expect(otherPixels.green).toBeGreaterThan(1000);
    expect(otherPixels.red).toBe(0);

    await viewer.goto(cropUi);
    await viewer.reload();
    await expect(viewer.getByRole('img', { name: 'Обрезанное изображение фрагмента' })).toHaveAttribute('src', preview);
    const pixels = await pixelCounts(viewer);
    expect(pixels).toMatchObject({ width: 260, height: 100, green: 0 });
    expect(pixels.red).toBeGreaterThan(1000);
    const image = await viewer.request.get(preview);
    expect(image.headers()['cache-control']).toBe('no-store');
    expect(image.headers()['content-type']).toBe('image/png');
    expect(image.headers()['x-content-type-options']).toBe('nosniff');
    await testInfo.attach('authorized-crop', { body: await image.body(), contentType: 'image/png' });
    const visible = await accepted<{ items: { id: string }[] }>(await viewer.request.get(collection(areaA.id)), 'Выдача области A');
    expect(visible.items.map(({ id }) => id).sort()).toEqual([textId, cropId].sort());
    await verifyMixedDenial();
    expect((await command(viewer.context(), origin, collection(areaA.id) + '/' + cropId + '/revoke', 'POST', reason, 2)).status()).toBe(403);

    await engineer.goto(cropUi);
    await engineer.getByLabel('Основание отзыва').fill('Синтетический отзыв доступа');
    await engineer.getByRole('button', { name: 'Отозвать выдачу' }).click();
    await expect(engineer.getByText('Страница 1 · Отозван · версия 3', { exact: true })).toBeVisible();
    await expect(viewer.getByRole('img', { name: 'Обрезанное изображение фрагмента' })).toHaveCount(0);
    await viewer.reload();
    await expect(viewer.getByText('Для этой области требуется отдельная действующая выдача.', { exact: false })).toBeVisible();
    await hidden(viewer.request, preview);
    await hidden(viewer.request, collection(areaA.id) + '/' + randomUUID() + '/versions/2/preview');
    await verifyMixedDenial();
    expect(await (await viewer.request.get(textApi)).json()).toMatchObject({ quote: allowedQuote, version: 2 });
  } finally {
    await Promise.all([engineer.close(), viewer.close(), other.close()]);
  }
});
