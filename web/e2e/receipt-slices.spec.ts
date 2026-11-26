import { expect, test } from '@playwright/test';

const projectId = '10000000-1000-4000-8000-000000000001';
const receiptId = '20000000-2000-4000-8000-000000000001';
const olderReceiptId = '20000000-2000-4000-8000-000000000002';
const openReceiptId = '20000000-2000-4000-8000-000000000003';
const versionId = '30000000-3000-4000-8000-000000000001';
const occurrenceId = '40000000-4000-4000-8000-000000000001';
const documentId = '50000000-5000-4000-8000-000000000001';
const oldSlice = '60000000-6000-4000-8000-000000000001';
const currentSlice = '60000000-6000-4000-8000-000000000002';
const api = '/api/projects/' + projectId;
const receipts = '/projects/' + projectId + '/receipts';
const project = {
  id: projectId, name: 'Синтетический комплект', version: 1,
  scopes: [], intakeMode: true, actions: ['project:read', 'project:engineer'],
};
const position = { sliceId: oldSlice, cursor: '0', projectionVersion: '0' };
const receipt = { receiptId, number: 17, sealed: true, inventoryOpen: false, source: 'upload' };
const openReceipt = { receiptId: openReceiptId, number: 19, sealed: false, inventoryOpen: true, source: 'upload' };
const openInventory = {
  ...openReceipt, projectId, uploads: [], imports: [], occurrences: [],
  manifest: {
    mode: 'open', version: 2, items: [{
      itemId: occurrenceId, kind: 'file', relativePath: 'ожидающий.pdf', status: 'declared', size: 10, confirmedBytes: 0,
    }],
  },
};
const inventory = {
  ...receipt, projectId, manifest: null, uploads: [], imports: [],
  occurrences: [{ occurrenceId, versionId, documentId, relativePath: 'закреплённый лист.pdf', mediaType: 'application/pdf', status: 'accepted' }],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === '/api/me') {
      return route.fulfill({ json: {
        user: { id: projectId, login: 'test-intake', organizationId: projectId }, csrfToken: 'synthetic', projects: [project],
      } });
    }
    if (pathname === api) return route.fulfill({ json: project });
    if (pathname === api + '/snapshot') return route.fulfill({ json: position });
    if (pathname === api + '/events') return route.fulfill({ json: { events: [], cursor: '0', head: position, hasMore: false } });
    if (pathname.endsWith('/capabilities')) return route.fulfill({ json: {} });
    if (pathname === api + '/work-slices/current') return route.fulfill({ json: { workSliceId: currentSlice } });
    if (pathname === api + '/work-slices/' + oldSlice + '/receipts') {
      if (searchParams.has('cursor')) return route.fulfill({ status: 409, json: { code: 'snapshot_required' } });
      if (searchParams.get('receiptId') === receiptId) return route.fulfill({ json: {
        receipts: [receipt], total: 1, workSliceId: oldSlice, filter: 'processing', nextCursor: null,
        selection: 'present', selectedReceipt: receipt,
      } });
      return route.fulfill({ json: {
        receipts: [{ ...receipt, receiptId: olderReceiptId, number: 5 }],
        total: 2, workSliceId: oldSlice, filter: 'processing', nextCursor: 'expired-page',
      } });
    }
    if (pathname === api + '/work-slices/' + currentSlice + '/receipts') {
      const filter = searchParams.get('filter');
      const selectedId = searchParams.get('receiptId');
      const selected = selectedId === openReceiptId ? openReceipt : receipt;
      const filtered = filter === 'open' && !selected.inventoryOpen;
      return route.fulfill({ json: {
        receipts: filtered ? [] : [selected], total: filtered ? 0 : 1,
        workSliceId: currentSlice, filter, nextCursor: null,
        ...(selectedId ? { selection: filtered ? 'filtered' : 'present', selectedReceipt: selected } : {}),
      } });
    }
    if (pathname === api + '/receipts') return route.fulfill({ json: { receipts: [], nextCursor: null } });
    if (pathname === api + '/work-slices/' + currentSlice + '/receipts/' + receiptId + '/inventory') {
      return route.fulfill({ json: { ...inventory, workSliceId: currentSlice, inventoryRevision: '1:1', historical: true } });
    }
    if (pathname === api + '/work-slices/' + oldSlice + '/receipts/' + receiptId + '/inventory') {
      return route.fulfill({ status: 409, json: { code: 'inventory_snapshot_unavailable' } });
    }
    if (pathname === '/api/receipts/' + openReceiptId + '/inventory') return route.fulfill({ json: openInventory });
    if (pathname.endsWith('/supplements/links') || pathname.endsWith('/import-inventory')) return route.fulfill({ json: { items: [] } });
    if (pathname.endsWith('/content')) return route.fulfill({ headers: { 'content-type': 'application/pdf' }, body: '' });
    if (pathname.endsWith('/reader/units')) return route.fulfill({ json: { source: { documentId, versionId }, units: [] } });
    if (pathname.endsWith('/work')) return route.fulfill({ json: {
      jobs: [], jobCount: 0, branches: [], mapReady: false, mapped: false, catalogAssigned: false,
    } });
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
});

test('Карточка TIFF показывает разные физические страницы и ссылку на закреплённый оригинал', async ({ page }) => {
  const filename = 'Синтетические страницы.tiff';
  const sha256 = 'a'.repeat(64);
  const content = `/api/documents/${documentId}/versions/${versionId}/content`;
  const reader = `/api/v1/documents/${documentId}/versions/${versionId}/reader`;
  await page.route('**' + api + '/work-slices/' + currentSlice + '/receipts/' + receiptId + '/inventory*', (route) => route.fulfill({ json: {
    ...inventory, workSliceId: currentSlice, inventoryRevision: '1:1', historical: true,
    occurrences: [{ ...inventory.occurrences[0], relativePath: filename, sha256, mediaType: 'image/tiff' }],
  } }));
  await page.route('**' + content, (route) => route.fulfill({ headers: { etag: `"sha256-${sha256}"`, 'content-type': 'image/tiff' }, body: '' }));
  await page.route('**' + reader + '/units', (route) => route.fulfill({ json: {
    source: { documentId, versionId, sha256 }, readerVersion: 'raster-fixture', format: 'image',
    units: [1, 2].map((page) => ({ id: String(page), width: 40, height: 40, locator: { page, rasterFormat: 'tiff' } })),
  } }));
  const png = [
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARElEQVRYhe3YsQkAMAwDwd9/aWUHN2kO3BuErUdq9WWyOFLPceWdYiBjmYFEsBgsBouDxWAxWBwsSosJ5qkipnzprMEDqvU6G9n0iCIAAAAASUVORK5CYII=',
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAQElEQVRYhe3VsQ0AQAgDsdt/6fwONN9YokeKIK71Z7I4Uc9x5Z1SIFOZQSIshsWwOCyGxbA4LIbFYTEshsUdM3hw2zobUxOamgAAAABJRU5ErkJggg==',
  ];
  await page.route('**' + reader + '/pages/*', (route) => route.fulfill({
    headers: { etag: `"sha256-${sha256}"`, 'content-type': 'image/png' },
    body: Buffer.from(png[Number(new URL(route.request().url()).pathname.at(-1)) - 1], 'base64'),
  }));

  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(receipts + '/' + receiptId + '?workSlice=' + currentSlice);
  await page.getByRole('link', { name: 'Карточка документа' }).click();
  await expect(page.getByRole('link', { name: 'Скачать оригинал' })).toHaveAttribute('href', content);
  await page.getByRole('button', { name: 'Открыть оригинал' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Оригинал изображения' })).toBeFocused();
  for (const [ordinal, color] of [[1, [255, 0, 0]], [2, [0, 255, 0]]] as const) {
    const image = page.getByRole('img', { name: 'Оригинал изображения, страница ' + ordinal });
    await expect(image).toBeVisible();
    expect(await image.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      const context = document.createElement('canvas').getContext('2d')!;
      context.drawImage(element, 0, 0);
      return [...context.getImageData(1, 1, 1, 1).data].slice(0, 3);
    })).toEqual(color);
    if (ordinal === 1) await page.getByRole('button', { name: 'Следующая страница' }).press('Enter');
  }
  await expect(page.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
  await expect(page).toHaveURL(/[?&]page=2(?:&|$)/);
});

test('Опись показывает сохранённый оригинал подписи и открывает PDF с теми же байтами', async ({ page }) => {
  const signatureDocument = '70000000-7000-4000-8000-000000000001';
  const signatureVersion = '80000000-8000-4000-8000-000000000001';
  await page.route(`**/api/receipts/${receiptId}/inventory`, (route) => route.fulfill({ json: inventory }));
  await page.route(`**/api/v1/projects/${projectId}/receipts/${receiptId}/preparation`, (route) => route.fulfill({ json: {
    projectId, receiptId, state: 'ready', manifestId: 'fixture', revision: 1,
    counts: { total: 1, available: 1, unavailable: 0, waiting: 0, archives: 0, technical: 1, restrictions: 0 },
    items: [{ occurrenceId: 'signature-occurrence', documentId: signatureDocument, versionId: signatureVersion,
      label: 'закреплённый лист.pdf.sig', state: 'excluded', kind: 'technical', reason: 'signature_pdf_duplicate',
      relatedPdf: { occurrenceId, documentId, versionId, label: 'закреплённый лист.pdf' } }], restrictions: [], reasons: [],
  } }));
  await page.goto(receipts + '/' + receiptId);
  await page.getByText('Файлы подписи · 1', { exact: true }).click();
  await expect(page.getByText('Действительность электронной подписи здесь не проверялась.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Скачать оригинал подписи' })).toHaveAttribute('href',
    `/api/documents/${signatureDocument}/versions/${signatureVersion}/content`);
  await page.getByRole('link', { name: 'Связанный PDF · закреплённый лист.pdf' }).click();
  await expect(page.getByRole('heading', { name: 'закреплённый лист.pdf' })).toBeVisible();
});

test('Читает первую страницу нового среза и восстанавливает строку при возврате из карточки', async ({ page }) => {
  const closedInventoryRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/' + receiptId + '/inventory')) closedInventoryRequests.push(path);
  });
  await page.goto(receipts + '?workSlice=' + oldSlice + '&filter=processing');
  await expect(page.getByRole('link', { name: 'Поступление №5' })).toBeVisible();
  await page.getByRole('button', { name: 'Ещё поступления' }).click();
  await expect(page.getByText('Список обновлён по текущим данным.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Поступление №5' })).toHaveCount(0);

  const receiptPage = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === api + '/work-slices/' + currentSlice + '/receipts' &&
      url.searchParams.get('filter') === 'processing' && url.searchParams.get('receiptId') === receiptId &&
      !url.searchParams.has('cursor');
  });
  await page.getByRole('link', { name: 'Поступление №17' }).click();
  await receiptPage;
  await page.getByRole('link', { name: 'Карточка документа' }).click();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'закреплённый лист.pdf' })).toBeVisible();
  const card = new URL(page.url());
  expect(card.searchParams.get('workSlice')).toBe(currentSlice);
  expect(card.searchParams.get('filter')).toBe('processing');
  expect(card.searchParams.get('document')).toBe(versionId);
  expect(card.searchParams.get('row')).toBe(occurrenceId);

  await page.getByRole('link', { name: 'К описи' }).click();
  await expect(page.locator('#occurrence-' + occurrenceId)).toBeFocused();
  expect(new URL(page.url()).searchParams.get('row')).toBe(occurrenceId);
  await page.getByRole('navigation', { name: 'Фильтры поступлений' }).getByRole('link', { name: 'Опись открыта' }).click();
  await expect(page.getByText('Выбранное поступление не входит в этот фильтр.')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('workSlice')).toBe(currentSlice);
  await expect(page.locator('#occurrence-' + occurrenceId)).toBeVisible();
  expect(closedInventoryRequests.length).toBeGreaterThan(0);
  expect([...new Set(closedInventoryRequests)]).toEqual([
    api + '/work-slices/' + currentSlice + '/receipts/' + receiptId + '/inventory',
  ]);
});

test('Открытое поступление загружает актуальную опись и показывает докачку', async ({ page }) => {
  const inventoryRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/' + openReceiptId + '/inventory')) inventoryRequests.push(path);
  });
  await page.goto(receipts + '/' + openReceiptId + '?workSlice=' + currentSlice + '&filter=open');
  await expect(page.getByText('ожидающий.pdf')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Продолжить передачу' })).toBeEnabled();
  expect([...new Set(inventoryRequests)]).toEqual(['/api/receipts/' + openReceiptId + '/inventory']);
});

test('Недоступная закреплённая опись требует явного перехода к актуальному срезу', async ({ page }) => {
  await page.goto(receipts + '/' + receiptId + '?workSlice=' + oldSlice + '&filter=processing&row=' + occurrenceId);
  await expect(page.getByText('Закреплённая опись недоступна.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Карточка документа' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Открыть актуальную опись' }).click();
  await expect(page.locator('#occurrence-' + occurrenceId)).toBeFocused();
  const url = new URL(page.url());
  expect(url.searchParams.get('workSlice')).toBe(currentSlice);
  expect(url.searchParams.get('filter')).toBe('processing');
  expect(url.searchParams.get('row')).toBe(occurrenceId);
});

test('Смена фильтра оставляет в реестре только строки нового запроса', async ({ page }) => {
  const listPath = api + '/work-slices/' + oldSlice + '/receipts';
  let releasePrevious!: () => void;
  let paginationStarted!: () => void;
  let paginationFinished!: () => void;
  const previous = new Promise<void>(resolve => { releasePrevious = resolve; });
  const started = new Promise<void>(resolve => { paginationStarted = resolve; });
  const finished = new Promise<void>(resolve => { paginationFinished = resolve; });

  await page.route(url => url.pathname === listPath && url.searchParams.has('cursor'), async route => {
    paginationStarted();
    try {
      await previous;
      await route.fulfill({ json: {
        receipts: [{ ...receipt, receiptId: olderReceiptId, number: 23 }],
        total: 2, workSliceId: oldSlice, filter: 'processing', nextCursor: null,
      } });
    } catch {
      // Navigation may have already cancelled the in-flight request.
    } finally {
      paginationFinished();
    }
  });
  await page.route(url => url.pathname === listPath && url.searchParams.get('filter') === 'open', route =>
    route.fulfill({ json: { receipts: [receipt], total: 1, workSliceId: oldSlice, filter: 'open', nextCursor: null } }));

  try {
    await page.goto(receipts + '?workSlice=' + oldSlice + '&filter=processing');
    await page.getByRole('button', { name: 'Ещё поступления' }).click();
    await started;
    await page.getByRole('navigation', { name: 'Фильтры поступлений' }).getByRole('link', { name: 'Опись открыта' }).click();
    await expect(page.getByRole('link', { name: 'Поступление №17' })).toBeVisible();
  } finally {
    releasePrevious();
  }
  await finished;
  await expect(page.getByRole('link', { name: 'Поступление №23' })).toHaveCount(0);
});

test('Прямая ссылка открывает форму приёма публичного источника', async ({ page }) => {
  await page.goto(receipts + '?upload=link');
  await expect(page.getByRole('textbox', { name: 'Публичная ссылка' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Принять ссылку' })).toBeEnabled();
});
