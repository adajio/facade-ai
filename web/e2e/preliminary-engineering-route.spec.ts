import { expect, test, type Page } from '@playwright/test';

const projectId = '20000000-0000-4000-8000-000000000001';
const contextId = '20000000-0000-4000-8000-000000000002';
const receiptId = '20000000-0000-4000-8000-000000000003';
const documentId = '20000000-0000-4000-8000-000000000004';
const versionId = '20000000-0000-4000-8000-000000000005';
const pngSha = '9'.repeat(64);
const statuses = ['present', 'partial', 'not_found', 'unassessed'] as const;
const labels = ['Представлено', 'Частично', 'Не найдено', 'Не оценено'];
const base = `/projects/${projectId}/completeness`;

async function fixture(page: Page, editable: boolean, comparable = false, structured = false, sheetPreviews = false) {
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
  const previewSource = (title: string, state: string, observation: string, sha256 = pngSha) => ({
    documentId, versionId, label: 'Синтетический.pdf',
    anchor: JSON.stringify({address:{unitId:'4',locator:{page:4}},sheetPreview:{sha256,state,title,observation}}),
  });
  const previewSources = sheetPreviews ? [
    previewSource('Легенда', 'observed', 'В легенде видна штриховка облицовки.'),
    previewSource('Фасад', 'inconclusive', 'Подпись у оси требует сверки.'),
    previewSource('Узел', 'unreadable', ''),
    previewSource('Посторонний путь', 'observed', 'Посторонняя ссылка', '../../external.png'),
    previewSource('Контроль CRLF', 'observed', 'Посторонняя ссылка', pngSha+'\n'),
    {...previewSource('Подменённая редакция', 'observed', 'Посторонняя ссылка'),versionId:versionId+'/../'},
  ] : [];
  const review = { id: 'review', receiptId, catalogVersionId: 'catalog', model: 'synthetic-terra',
    createdAt: '2026-11-26T00:00:00Z', stage: 'Стадия 1', scopeNote: '', isCurrent: true, draftText: 'Синтетический черновик',
    rows: questions.map((question, index) => ({ key: question.requirement.positionId, title: question.requirement.part,
      status: statuses[index % statuses.length], finding: `Синтетический вывод ${index + 1}`,
      sources: index ? [] : [{ documentId, versionId, label: 'Синтетический.pdf', anchor: 'Стр. 3–4' }, ...previewSources],
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
  const waiting = { ...added,anchor:'Стр. 4',quote:'Ответ на запрос №7 не получен' };
  const received = { ...added,anchor:'Стр. 5',quote:'Ответ на запрос №8: цвет RAL 7035' };
  const excluded = { ...added,anchor:'Стр. 6',quote:'Крепление к стальной раме. КЖ в область заказа не входит.' };
  const structuredReview = { ...review, id:'structured', draftText:'Требование 1 — Блеск покрытия. Уточните блеск покрытия.',
    changes:{baselineReceiptId:'previous-receipt',baselineScope:'previous_receipt',baselineId:baseline.id,baselineAt:baseline.createdAt,
      rows:baseline.rows.map(row=>({key:row.key,changed:true,previousStatus:row.status,previousFinding:row.finding,
        addedSources:[],removedSources:[],analysisChanged:true})),
      letter:{changed:true,added:['Уточните блеск покрытия.'],removed:[baseline.draftText]}},
    rows:review.rows.map((row,index) => ({...row,analysis:index === 1 ? {
      applicability:{kind:'excluded',reason:'КЖ исключён из области заказа.',sources:[excluded]},properties:[],tensions:[],
    } : {
      applicability:{kind:'included',reason:'Проверяемое свойство включено в задание.',sources:[]},
      properties:index === 2 ? [
        {key:'joint-sign',label:'Надпись о шве',status:'confirmed',finding:'В источнике указано: «ДШ-1».',
          scope:{basis:'literal',kind:'applicable',target:{element:'Шов'},observed:{element:'Шов'},
            reason:'Прочитана маркировка.',sources:[{...added,quote:'ДШ-1'}]},
          sources:[{...added,quote:'ДШ-1'}],letter:{kind:'omit',text:'Маркировка прочитана.'}},
        {key:'joints',label:'Деформационные швы',status:'insufficient',finding:'Подпись найдена, её привязка требует сверки.',
          scope:{kind:'undetermined',target:{element:'Шов',zone:'Ось Б'},reason:'На листе ось не подписана.',sources:[added]},
          sources:[],letter:{kind:'omit',text:'Сначала сверить область.'}},
      ] : index ? [] : [
        {key:'coating',label:'Толщина покрытия',status:'unanswered',finding:'Результат по запросу №7 не поступил.',
          sources:[waiting],response:{state:'not_received',finding:'В журнале отмечено неполучение.',sources:[waiting]},
          letter:{kind:'omit',text:'Запрос №7 уже направлен.'}},
        {key:'gloss',label:'Блеск покрытия',status:'not_mentioned',finding:'В ответе указан только цвет.',
          sources:[],response:{state:'received',finding:'Получен ответ №8.',sources:[received]},
          letter:{kind:'ask',text:'Уточните блеск покрытия.'}},
      ],tensions:[],
    }})),
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
      return route.fulfill({ json: { items: structured ? [structuredReview, {...baseline,isCurrent:false}] : comparable ? published ? [detailed, { ...baseline, isCurrent: false }] : [baseline] : [review], nextCursor: null } });
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

test('Свойства различают получение ответа, показывают исключение КЖ и сохраняют адрес вопроса', async ({ page }) => {
  await fixture(page,true,false,true);
  await page.goto(base);
  const matrix = page.getByRole('region',{name:'Комплектность по требованиям'});
  await expect(matrix.getByText('Дальше', { exact: true })).toHaveCount(16);
  await matrix.getByRole('link',{name:'Сверить и решить · Требование 1',exact:true}).click();
  const requirement = matrix.getByRole('region',{name:'Требование 1',exact:true});
  const firstRow = matrix.getByRole('row').filter({ has: page.getByRole('link', { name: 'Требование 1', exact: true }) });
  await expect(firstRow).toContainText('Уточните блеск покрытия.');
  for (const title of ['Что установлено', 'Что остаётся выяснить', 'Где проверить']) {
    await expect(requirement.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(requirement.getByRole('region',{name:'Толщина покрытия'})).toContainText('Ответ заказчика не получен');
  const gloss = requirement.getByRole('region',{name:'Блеск покрытия'});
  await expect(gloss).toContainText('Ответ получен, свойство в нём не упомянуто');
  await expect(gloss).toContainText('Уточните блеск покрытия.');
  await expect(gloss.getByRole('link',{name:'Синтетический.pdf'})).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=5`);
  await expect(requirement).toContainText('Что изменилось после предыдущего поступления');
  await matrix.getByRole('link',{name:'Свернуть требование',exact:true}).click();
  await matrix.getByRole('link',{name:'Сверить и решить · Требование 2',exact:true}).click();
  const outside = matrix.getByRole('region',{name:'Требование 2',exact:true});
  await expect(outside).toContainText('КЖ исключён из области заказа.');
  await expect(outside).toContainText('Запрос по этому требованию в письмо не включён.');
  await expect(outside.getByRole('list',{name:'Основания применимости'})).toContainText('Крепление к стальной раме');
  const thirdRow = matrix.getByRole('row').filter({ has: page.getByRole('link', { name: 'Требование 3', exact: true }) });
  await expect(thirdRow).toContainText('На листе ось не подписана.');
  await matrix.getByRole('link',{name:'Сверить и решить · Требование 3',exact:true}).click();
  const scope = matrix.getByRole('region',{name:'Требование 3',exact:true});
  const literal = scope.getByRole('region', {name:'Надпись о шве'});
  await expect(literal).toContainText('Подтверждена надпись');
  await expect(literal).toContainText('«ДШ-1»');
  await expect(literal).not.toContainText('Вопрос для письма');
  await expect(scope).toContainText('На листе ось не подписана.');
  await expect(scope).toContainText('Сначала сверить область.');
  await expect(scope.getByRole('list',{name:'Адреса проверки области по свойству «Деформационные швы»'})).toBeVisible();
  await matrix.getByRole('link',{name:'Сверить и решить · Требование 16',exact:true}).click();
  const unassessed = matrix.getByRole('region',{name:'Требование 16',exact:true});
  await expect(unassessed).toContainText('Адресный вопрос пока не сформирован.');
  await expect(unassessed).toContainText('Адресные источники по требованию отсутствуют.');
  await expect(unassessed.getByRole('link',{name:'Открыть опись поступления'})).toHaveAttribute(
    'href', `/projects/${projectId}/receipts/${receiptId}`);
  await page.goto(`/projects/${projectId}/letters`);
  const letter = page.getByRole('region',{name:'Черновик письма по результатам проверки'});
  await expect(letter).toContainText('Проект письма изменился после предыдущего поступления');
  await letter.getByText('Основания вопросов письма',{exact:true}).click();
  const basis = letter.getByRole('list',{name:'Основания вопроса по свойству «Блеск покрытия»'});
  await expect(basis.getByRole('link',{name:'Синтетический.pdf'})).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=5`);
  await expect(letter.getByLabel('Текст предварительного черновика')).not.toHaveValue(/КЖ|Толщина покрытия|ДШ-1/);
});


test('Адресное основание открывает сохранённый PNG и показывает исход графической проверки',async ({page})=>{
  await fixture(page,false,false,false,true);
  const path = `/api/v1/documents/${documentId}/versions/${versionId}/sheet-previews/${pngSha}`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+rIVsAAAAASUVORK5CYII=', 'base64');
  await page.context().route(`**${path}`,route=>route.fulfill({status:200,contentType:'image/png',body:image}));
  await page.goto(base);
  const table = page.getByRole('region',{name:'Комплектность по требованиям'});
  await table.getByRole('link',{name:'Посмотреть основания · Требование 1',exact:true}).click();
  const sources = table.getByRole('list',{name:'Основания вывода'});
  const link = sources.getByRole('link',{name:'Открыть фрагмент листа · Легенда',exact:true});
  await expect(link).toHaveAttribute('href',path);
  await expect(link).toHaveAttribute('rel','noopener noreferrer');
  await expect(sources).toContainText('Наблюдение на фрагменте');
  await expect(sources).toContainText('В легенде видна штриховка облицовки.');
  await expect(sources).toContainText('Требуется уточнение');
  await expect(sources).toContainText('Недостаточная читаемость');
  await expect(sources.getByRole('link',{name:/^Открыть фрагмент листа/})).toHaveCount(3);
  await expect(sources.getByRole('link',{name:'Синтетический.pdf',exact:true}).first()).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=3`);
  const [popup] = await Promise.all([page.waitForEvent('popup'),link.click()]);
  await popup.waitForURL(`**${path}`);
  await expect(popup.locator('img')).toBeVisible();
  await popup.close();
});


test('Обзор объясняет остановку чтения и ведёт к сохранённым требованиям и черновику', async ({ page }) => {
  await fixture(page, false);
  const stopped = {
    no_useful_change: 'Новые участки не изменили выводы по требованиям и состав вопросов письма.',
    receipt_call_limit: 'Достигнут лимит запросов на поступление.',
    no_addressed_goal: 'В сохранённом разборе нет адресной цели для продолжения.',
    operator_stopped: 'Углублённое чтение остановлено по решению оператора.',
  };
  let readingMode: keyof typeof stopped = 'no_useful_change';
  await page.route('**/api/projects/*/work-slices/current', route => route.fulfill({ json: {
    projectId, workSliceId: 'slice', assessment: { contextId },
  } }));
  await page.route('**/api/v1/projects/*/terra-reading', route => route.fulfill({ json: {
    enabled: true,
    receipt: { receiptId, receiptNumber: 17, inventoryOpen: false, acceptedVersions: 1, rootFiles: 1,
      rootArchives: 0, directChildren: 0, deeperChildren: 0, officeParts: 0 },
    report: { id: 'review', createdAt: '2026-11-26T00:00:00Z', summary: { present: 0, partial: 4, notFound: 0, unassessed: 12 },
      draftAvailable: true, hasQuestions: false },
    progress: { totalWindows: 15, mappedVersions: 1, completed: 4, covered: 0, noMatch: 4, refused: 0, held: 0,
      reading: 0, queued: 0, unassigned: 11, heldReasons: [], observations: 4,
      deep: { status: 'running', reason: null, started: 4, limit: 20 },
      directed: { mode: readingMode, openRequirements: 12, indexPendingVersions: 1, indexCompleteVersions: 0,
        indexPendingUnits: 11, indexUnknownVersions: 0, pendingTargets: 0, callCount: 8, callLimit: 8, stagnantWindows: 3 } },
    activity: [],
  } }));
  await page.goto(`/projects/${projectId}/overview`);
  const card = page.getByRole('region', { name: 'Комплектность поступления' });
  await expect(card.getByText(stopped.no_useful_change, { exact: true })).toBeVisible();
  await expect(card).toContainText('Запросов к системе чтения · 8 из 8');
  await expect(card).toContainText('Участков подряд без таких изменений · 3');
  const matrix = card.getByRole('link', { name: 'Открыть требования и источники' });
  await expect(matrix).toHaveAttribute('href', base + '?context=' + contextId);
  const draft = card.getByRole('link', { name: 'Посмотреть, почему в письме пока нет вопросов' });
  await expect(draft).toHaveAttribute('href', `/projects/${projectId}/letters`);
  await draft.focus();
  for (const mode of ['receipt_call_limit', 'no_addressed_goal', 'operator_stopped'] as const) {
    readingMode = mode;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(card.getByText(stopped[mode], { exact: true })).toBeVisible();
    await expect(draft).toBeFocused();
    await expect(page.getByText('Есть адресные участки, ожидающие чтения.')).toHaveCount(0);
    await expect(page.getByText(/Начато адресное чтение./)).toHaveCount(0);
  }
  await matrix.click();
  await expect(page.getByRole('region', { name: 'Комплектность по требованиям' })).toBeVisible();
  await page.goBack();
  await draft.click();
  await expect(page.getByRole('region', { name: 'Черновик письма по результатам проверки' })).toBeVisible();
});

test('Черновик показывает автоматическую остановку чтения именно для выбранного разбора', async ({ page }) => {
  const { publishDetailed } = await fixture(page, false, false, true);
  const reasons = {
    no_useful_change: 'Новые участки не изменили выводы по требованиям и состав вопросов письма.',
    receipt_call_limit: 'Достигнут лимит запросов на поступление.',
  };
  let mode: keyof typeof reasons = 'no_useful_change';
  let reportId = 'structured';
  await page.route('**/api/v1/projects/*/terra-reading', route => route.fulfill({ json: {
    enabled: true,
    receipt: { receiptId },
    report: { id: reportId },
    progress: { directed: { mode } },
  } }));

  const lettersUrl = `/projects/${projectId}/letters`;
  const letter = page.getByRole('region', { name: 'Черновик письма по результатам проверки' });
  const stop = letter.getByRole('status').filter({ hasText: 'Черновик по частично прочитанному пакету.' });
  const draft = letter.getByLabel('Текст предварительного черновика');
  const draftText = 'Требование 1 — Блеск покрытия. Уточните блеск покрытия.';

  await page.goto(lettersUrl);
  await expect(stop).toContainText(reasons.no_useful_change);
  await expect(stop).toContainText('Перед отправкой сверьте оставшиеся адресные вопросы по источникам.');
  await expect(letter.getByRole('link', { name: 'Сверить требования и источники' })).toHaveAttribute('href', base);
  await expect(draft).toHaveValue(draftText);
  await letter.getByText('Основания вопросов письма', { exact: true }).click();
  await expect(letter.getByRole('list', { name: 'Основания вопроса по свойству «Блеск покрытия»' })
    .getByRole('link', { name: 'Синтетический.pdf' })).toHaveAttribute('href',
    `/api/documents/${documentId}/versions/${versionId}/content#page=5`);

  await draft.focus();
  mode = 'receipt_call_limit';
  publishDetailed();
  await expect(stop).toContainText(reasons.receipt_call_limit);
  await expect(draft).toHaveValue(draftText);
  await expect(draft).toBeFocused();

  await letter.getByLabel('Разбор').selectOption('review');
  await expect(draft).toHaveValue('Синтетический черновик');
  await expect(stop).toHaveCount(0);

  reportId = 'other-review';
  const reading = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/terra-reading'));
  await page.reload();
  expect(await (await reading).json()).toMatchObject({ report: { id: reportId } });
  await expect(draft).toHaveValue(draftText);
  await expect(stop).toHaveCount(0);
});
