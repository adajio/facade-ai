import { expect, test, type Page } from '@playwright/test';

const projectId = '20000000-0000-4000-8000-000000000001';
const contextId = '20000000-0000-4000-8000-000000000002';
const receiptId = '20000000-0000-4000-8000-000000000003';
const documentId = '20000000-0000-4000-8000-000000000004';
const versionId = '20000000-0000-4000-8000-000000000005';
const statuses = ['present', 'partial', 'not_found', 'unassessed'] as const;
const labels = ['Представлено', 'Частично', 'Не найдено', 'Не оценено'];
const base = `/projects/${projectId}/completeness`;

async function fixture(page: Page, editable: boolean, comparable = false) {
  const project = { id: projectId, name: 'Синтетический комплект', version: 1, intakeMode: true, scopes: [],
    stage: 'Стадия 1', actions: editable ? ['project:read', 'project:engineer'] : ['project:read'] };
  const questions = Array.from({ length: 16 }, (_, index) => ({
    id: `question-${index}`, version: 1, outcome: 'needs_review',
    requirement: { positionId: `key-${index}`, partId: `key-${index}`, subject: '', part: `Требование ${index + 1}`, formats: ['pdf'] },
    machine: { outcome: 'needs_review', citations: [], receiptIds: [], limitations: [] },
    semanticRemainder: { state: 'open', totalWindows: 3, verifiedWindows: 0, reasons: [], items: [], omittedItems: 0 },
  }));
  let decision: { action: string; outcome: string; reason: string; authorId: string; createdAt: string } | undefined;
  const submissions: { body: Record<string, unknown>; version?: string }[] = [];
  const boundary = { complete: false, reason: 'reading_pending', basisIds: [] };
  const assessment = (historical = false) => ({
    projectId, version: historical ? 1 : decision ? 2 : 1, catalogVersionId: 'catalog', acceptedVersions: 1,
    stage: 'Стадия 1', activeWindows: 3, completedWindows: 0, limitations: [], outcome: 'needs_review',
    coverage: { inventory: boundary, map: boundary, reading: boundary, subject: boundary },
    observations: { counts: { identified: 0, common: 0, unclear: 0, unidentified: 0 } },
    unresolvedMentions: { limited: false, items: [{ label: 'Синтетическое упоминание', citation: { evidenceId: 'evidence', quote: 'Ось А' } }] },
    contexts: [{ assessmentContextId: contextId, name: 'Весь комплект', kind: 'common', facadeId: null,
      version: historical ? 1 : decision ? 2 : 1, outcome: 'needs_review', counts: {}, questionHolds: [],
      questions: questions.map((question, index) => index || historical || !decision ? question : { ...question, version: 2, decision }),
    }],
  });
  const review = { id: 'review', receiptId, catalogVersionId: 'catalog', model: 'synthetic-terra',
    createdAt: '2026-11-26T00:00:00Z', stage: 'Стадия 1', scopeNote: '', isCurrent: true, draftText: 'Синтетический черновик',
    rows: questions.map((question, index) => ({ key: question.requirement.positionId, title: question.requirement.part,
      status: statuses[index % statuses.length], finding: `Синтетический вывод ${index + 1}`,
      sources: index ? [] : [{ documentId, versionId, label: 'Синтетический.pdf', anchor: 'Стр. 3–4' }],
    })),
  };
  const baseline = { ...review, rows: review.rows.map((row, index) => index ? row : { ...row, status: 'partial' }),
    changes: { baselineId: null, baselineAt: null, rows: [], letter: { changed: false, added: [], removed: [] } } };
  const added = { documentId, versionId, label: 'Синтетический.pdf',
    anchor: JSON.stringify({ address: { locator: { page: 7 } }, lineId: 'L14' }),
    quote: 'Синтетическая цитата с листа', limitation: 'Требуется сверить ревизию листа' };
  const detailed = { ...review, id: 'detailed', createdAt: '2026-11-26T01:00:00Z', draftText: 'Обновлённый проект письма',
    rows: review.rows.map((row, index) => index ? row : { ...row, finding: 'Вывод после подробного чтения', sources: [...row.sources, added] }),
    changes: { baselineId: baseline.id, baselineAt: baseline.createdAt, rows: baseline.rows.map((row, index) => ({
      key: row.key, changed: !index, previousStatus: row.status, previousFinding: row.finding,
      addedSources: index ? [] : [added], removedSources: [],
    })), letter: { changed: true, added: ['Обновлённый проект письма'], removed: [review.draftText] } },
  };
  let published = false;
  let reviewRequests = 0;
  let chainUpdated = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/me') return route.fulfill({ json: { csrfToken: 'test', user: { id: 'engineer', login: 'test' }, projects: [project] } });
    if (path === `/api/projects/${projectId}`) return route.fulfill({ json: project });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: { cursor: published ? '1' : '0', sliceId: '0', projectionVersion: '0' } });
    if (path.endsWith('/events')) return route.fulfill({ json: { events: published && url.searchParams.get('after') === '0'
      ? [{ cursor: '1', type: 'package-analysis.changed', payload: {} }] : [], cursor: published ? '1' : '0', hasMore: false } });
    if (path.endsWith('/preliminary-package-reviews')) {
      reviewRequests += 1;
      return route.fulfill({ json: { items: comparable ? published ? [detailed, { ...baseline, isCurrent: false }] : [baseline] : [review], nextCursor: null } });
    }
    if (path.endsWith('/evidence-chain')) {
      const historical = published && url.searchParams.get('reviewId') === 'review';
      return route.fulfill({ json: {
        receiptId, receiptNumber: 17, reviewId: url.searchParams.get('reviewId'), historical,
        cutoff: historical ? review.createdAt : null, inventoryOpen: false, preparationId: 'prepared',
        latest: historical ? null : { stage: 'revision', status: chainUpdated ? 'unknown' : 'sending',
          reason: chainUpdated ? 'held_legacy_attempt' : null, at: review.createdAt },
        request: { status: 'published', requestBytes: 1200, selectedFiles: 1, totalFiles: 2, coveredFiles: 1, selectedLines: 2, totalLines: 5 },
        items: [{ versionId, documentId, label: 'Синтетический.pdf', mediaType: 'application/pdf', mapUnits: 2,
          index: null, preparation: null, windows: null,
          openings: { units:2, rendered:1, ocr:1, latestId:'ocr-proof', latestRenderId:'raster-proof', latestOcrId:'ocr-proof', latestOcrInputId:'ocr-proof' },
          pixels: historical ? null : { confirmedImages: 1, partialImages: 0, latest: { id: 'raster-proof', partsDelivered: 1, partsExpected: 1 } },
          citations: { count: 1, examples: [{ key:'key-0', title:'Требование 1', anchor:'Стр. 3–4' }] } }],
        nextCursor: null,
      } });
    }
    if (path.endsWith('/reading-progress')) return route.fulfill({ json: { totalWindows: 3, mappedVersions: 1, acceptedVersions: 1,
      completed: published ? 2 : 0, covered: 0, partial: published ? 1 : undefined, noMatch: published ? 1 : 0, refused: 0, held: 0, reading: 1 } });
    if (path.endsWith('/facade-assessment')) return route.fulfill({ json: assessment() });
    if (path.endsWith('/facade-assessment/1')) return route.fulfill({ json: assessment(true) });
    if (path.endsWith('/letters')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/letters/eligible')) return route.fulfill({ json: { items: [], holds: [] } });
    if (path.endsWith('/questions/question-0/decisions') && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push({ body, version: request.headers()['if-match'] });
      decision = { action: 'confirm', outcome: 'needs_review', reason: String(body.reason), authorId: 'engineer', createdAt: '2026-11-26T00:00:00Z' };
      return route.fulfill({ status: 201, json: { id: 'decision', version: 2, outcome: 'needs_review' } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  return { submissions, changeChain: () => { chainUpdated = true; }, publishDetailed: () => { published = true; }, reviewRequests: () => reviewRequests };
}

test('Комплектность показывает цвета и путь инженера до технических блоков, решение сохраняется и открывается снова', async ({ page }) => {
  const { submissions } = await fixture(page, true);
  await page.goto(base);
  const table = page.getByRole('region', { name: 'Комплектность по требованиям' });
  const heading = table.getByRole('heading', { name: 'Требования · Весь комплект' });
  await expect(heading).toBeVisible();
  const technical = page.getByText('Что вошло в проверку', { exact: true });
  const mentions = page.getByRole('heading', { name: 'Упоминания без установленного фасада' });
  await expect(technical).toBeVisible();
  await expect(mentions).toBeVisible();
  expect(await technical.evaluate((element) => {
    const target = [...document.querySelectorAll('h2')].find((node) => node.textContent === 'Требования · Весь комплект');
    return target && Boolean(target.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  expect(await heading.evaluate((element) => {
    const target = [...document.querySelectorAll('h2')].find((node) => node.textContent === 'Упоминания без установленного фасада');
    return target && Boolean(element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(16);
  await expect(rows.first()).toContainText('Нет данных для сравнения');
  const colors = [];
  for (let i = 0; i < 4; i++) {
    const badge = rows.nth(i).locator('.status-badge');
    await expect(badge).toHaveText(labels[i]);
    colors.push(await badge.evaluate((element) => getComputedStyle(element).backgroundColor));
  }
  expect(colors).toEqual(['rgb(228, 242, 236)', 'rgb(255, 243, 191)', 'rgb(249, 229, 225)', 'rgb(234, 241, 242)']);
  await page.emulateMedia({ forcedColors: 'active' });
  for (let i = 0; i < 4; i++) {
    const badge = rows.nth(i).locator('.status-badge');
    await expect(badge).toHaveText(labels[i]);
    expect(await badge.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.borderTopWidth === '1px' && style.borderTopColor === style.color;
    })).toBe(true);
  }
  await page.emulateMedia({ forcedColors: 'none' });
  await rows.first().getByRole('link', { name: 'Сверить и решить · Требование 1' }).click();
  const form = page.getByRole('form', { name: 'Решение инженера по требованию' });
  await expect(form).toBeVisible();
  const card = rows.first().locator('xpath=following-sibling::tr[1]');
  await expect(card).toContainText('Что нашла система');
  await expect(card).toContainText('Ваше решение по требованию');
  await expect(card.getByRole('form', { name: 'Решение инженера по требованию' })).toBeVisible();
  const left = await card.getByRole('heading', { name: 'Что нашла система' }).boundingBox();
  const right = await card.getByRole('heading', { name: 'Ваше решение по требованию' }).boundingBox();
  expect(left && right && left.x < right.x).toBeTruthy();
  await expect(page.getByRole('link', { name: 'Задать адресный вопрос по требованию' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/Terra|synthetic-terra/i);
  const source = card.getByRole('link', { name: 'Синтетический.pdf' });
  await expect(source).toHaveAttribute('href', `/api/documents/${documentId}/versions/${versionId}/content#page=3`);
  await expect(form.getByRole('combobox', { name: 'Действие по требованию' })).toHaveValue('confirm');
  await expect(form.getByRole('option', { name: 'Оставить на внутренней сверке' })).toBeAttached();
  const reason = 'Сверить синтетический лист и уточнить состав.';
  await form.getByLabel('Основание решения').fill(reason);
  await form.getByRole('button', { name: 'Сохранить решение по требованию' }).click();
  await expect(page.getByText('Решение сохранено.')).toBeVisible();
  expect(submissions).toEqual([{ version: '"1"', body: { action: 'confirm', reason, requestExternal: false } }]);
  await expect(card).toContainText(reason);
  await table.getByRole('link', { name: 'Сверить и решить · Требование 2', exact: true }).click();
  await expect(table.locator('tbody tr').nth(2)).toContainText('Ваше решение по требованию');
  await expect(table.locator('tbody tr').nth(1)).not.toContainText('Ваше решение по требованию');
  await table.getByRole('link', { name: 'Сверить и решить · Требование 1', exact: true }).click();
  await expect(table.locator('tbody tr').nth(1)).toContainText(reason);
  await page.reload();
  const firstRow = page.getByRole('region', { name: 'Комплектность по требованиям' }).locator('tbody tr').first();
  await expect(firstRow.locator('xpath=following-sibling::tr[1]')).toContainText(reason);
});

test('Подробное чтение обновляет изменения требования рядом с сохранённым вводом инженера и сохраняет историю письма', async ({ page }) => {
  const { publishDetailed, reviewRequests } = await fixture(page, true, true);
  await page.goto(base);
  const matrix = page.getByRole('region', { name: 'Комплектность по требованиям' });
  const rows = matrix.locator('tbody tr');
  await expect(rows).toHaveCount(16);
  await expect(rows.first()).toContainText('Первоначальный разбор');
  await matrix.getByRole('link', { name: 'Сверить и решить · Требование 1', exact: true }).click();
  const input = matrix.getByLabel('Основание решения');
  await input.fill('Несохранённая инженерная запись');
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  const source = rows.first().locator('xpath=following-sibling::tr[1]');
  publishDetailed();
  await expect(rows.first()).toContainText('Статус изменился с «Частично» на «Представлено»');
  await expect(rows.nth(2)).toContainText('С первоначального разбора без изменений');
  await expect(input).toHaveValue('Несохранённая инженерная запись');
  await expect(input).toBeFocused();
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(0);
  await expect(source).toContainText('Синтетический вывод 1');
  await expect(source).toContainText('Вывод после подробного чтения');
  const addedSources = source.getByRole('list', { name: 'Добавленные основания' });
  await expect(addedSources).toContainText('Синтетическая цитата с листа');
  await expect(addedSources).toContainText('Требуется сверить ревизию листа');
  await expect(addedSources.getByRole('link', { name: 'Синтетический.pdf' })).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=7`);
  expect(reviewRequests()).toBeLessThan(8);
  await matrix.getByRole('link', { name: 'Свернуть требование', exact: true }).click();
  await expect(page.getByText(/частично прочитано 1/)).toBeVisible();
  await page.goto(`/projects/${projectId}/letters`);
  const letter = page.getByRole('region', { name: 'Черновик письма по результатам проверки' });
  await expect(letter).toContainText('Проект письма изменился');
  await letter.getByText('Изменения проекта письма', { exact: true }).click();
  await expect(letter.getByText('Синтетический черновик', { exact: true })).toBeVisible();
  await expect(letter.getByText('Обновлённый проект письма', { exact: true })).toBeVisible();
  await expect(letter.getByLabel('Текст предварительного черновика')).toHaveValue('Обновлённый проект письма');
  await letter.getByLabel('Разбор').selectOption('review');
  await expect(letter).toContainText('Исторический разбор');
  await expect(letter).toContainText('Первоначальный проект письма');
  await expect(letter.getByLabel('Текст предварительного черновика')).toHaveValue('Синтетический черновик');
});

test('Историческая версия и пользователь без инженерных прав открывают основания без формы записи', async ({ page }) => {
  await fixture(page, false);
  await page.goto(base);
  const table = page.getByRole('region', { name: 'Комплектность по требованиям' });
  await table.getByRole('link', { name: 'Посмотреть основания · Требование 1', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Синтетический.pdf' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Решение инженера по требованию' })).toHaveCount(0);
  await page.goto(`${base}?context=${contextId}&revision=1`);
  await expect(page.getByText(/Историческая версия · только чтение/)).toBeVisible();
  await page.getByRole('link', { name: 'Посмотреть основания · Требование 1', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Решение инженера по требованию' })).toHaveCount(0);
});


test('Историческая версия остаётся только для чтения даже у инженера', async ({ page }) => {
  const { submissions } = await fixture(page, true);
  await page.goto(`${base}?context=${contextId}&revision=1`);
  await expect(page.getByText(/Историческая версия · только чтение/)).toBeVisible();
  await page.getByRole('link', { name: 'Посмотреть основания · Требование 1', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Решение инженера по требованию' })).toHaveCount(0);
  expect(submissions).toEqual([]);
});

test('Цепочка файла сохраняет фокус и прокрутку на обновлении и открывает сведения выбранной редакции', async ({ page }) => {
  const { changeChain, publishDetailed } = await fixture(page, false, true);
  await page.goto(base);
  const chain = page.getByRole('region', { name: 'Как обработаны файлы' });
  await expect(chain).toContainText('Идёт запрос. Ответ ещё не получен');
  await expect(chain).toContainText('Индексных строк 2 из 5');
  await chain.getByText('Состояние по файлам').click();
  const origin = chain.getByRole('link', { name: 'Синтетический.pdf', exact: true });
  await origin.focus();
  const position = await origin.evaluate(element => element.getBoundingClientRect().top);
  await expect(chain.getByRole('link', { name: 'Вход OCR' })).toHaveAttribute('href', '/api/v1/evidence/ocr-proof/ocr-input');
  await expect(chain.getByRole('link', { name: /Требование 1/ })).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=3`);
  await expect(chain.getByRole('link', { name: /Исходный рендер для последней передачи/ })).toHaveAttribute('href',
    '/api/v1/evidence/raster-proof/content');
  changeChain();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(chain).toContainText('Требуется сверка сохранённой попытки');
  await expect(origin).toBeFocused();
  expect(Math.abs(await origin.evaluate(element => element.getBoundingClientRect().top) - position)).toBeLessThan(3);
  publishDetailed();
  const selector = page.getByRole('region', { name: 'Предварительный разбор пакета' }).getByRole('combobox');
  await expect(selector).toHaveValue('detailed');
  await selector.selectOption('review');
  await chain.getByText('Состояние по файлам').click();
  await expect(chain).toContainText('История поступления №17');
  await expect(chain.getByText('Передача не подтверждена')).toBeVisible();
});
