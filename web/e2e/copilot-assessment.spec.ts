import { expect, test } from '@playwright/test';

test('Тип фасада, непроверенное место и опора доступны из одного требования', async ({ page }) => {
  const projectId = '10000000-0000-4000-8000-000000000001';
  const context = '10000000-0000-4000-8000-000000000002';
  const facadeId = '10000000-0000-4000-8000-000000000003';
  const observationId = '10000000-0000-4000-8000-000000000004';
  const evidenceId = '10000000-0000-4000-8000-000000000005';
  const versionId = '10000000-0000-4000-8000-000000000006';
  const documentId = '10000000-0000-4000-8000-000000000007';
  const questionId = '10000000-0000-4000-8000-000000000008';
  const project = { id: projectId, name: 'Два фасада', version: 7,
    actions: ['project:read', 'project:engineer'], intakeMode: true, scopes: [] };
  const snapshots = { cursor: '1', projectionVersion: '1', sliceId: '1' };
  const address = { unitId: '3', locator: { page: 3 }, box: { x: 10, y: 20, width: 30, height: 20 } };
  const basis = { id: observationId, evidenceId, versionId, address, revision: 'Р2', quote: 'Тип НВФ — кассетный' };
  const boundary = { complete: true, reason: null, basisIds: [] };
  const building = {
    assessmentContextId: context, facadeId, kind: 'facade', name: 'Фасад Ф-3', version: 1,
    outcome: 'needs_review', counts: { covered: 0, confirmed_missing: 0, confirmed_conflict: 0, needs_review: 1 },
    questionHolds: [],
    questions: [{ id: questionId, version: 1, outcome: 'needs_review',
      requirement: { subject: 'Облицовка', part: 'Узел', applicability: 'unknown' },
      machine: { outcome: 'needs_review', limitations: [], citations: [] },
      semanticRemainder: { state: 'open', totalWindows: 4, verifiedWindows: 1, alternativesVerified: false,
        reasons: ['structural_remainder_open'], omittedItems: 2,
        items: [{ windowId: 'w3', versionId, unitId: '3', box: address.box, pendingBranches: ['B'],
          reason: 'structural_remainder_open', nextAction: 'Проверить оговорку под таблицей.' }] },
    }],
  };
  const written: { body: unknown; version: string | undefined }[] = [];
  const decisions: { body: unknown; version: string | undefined }[] = [];
  let checked = false;
  const clarification = { inventories: [{ receiptId: 'receipt', number: '1', revision: '7:7' }],
    alternatives: ['pdf', 'эквивалентная схема'], semanticBasisIds: ['a', 'b'],
    places: [{ documentId, versionId, sha256: 'synthetic', label: 'РД-2.pdf', address }] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/me') return route.fulfill({ json: { csrfToken: 'fixture', user: { id: 'synthetic', login: 'eng' }, projects: [project] } });
    if (pathname === '/api/projects/' + projectId) return route.fulfill({ json: { ...project, version: written.length ? 8 : 7 } });
    if (pathname.endsWith('/snapshot')) return route.fulfill({ json: snapshots });
    if (pathname.endsWith('/events')) return route.fulfill({ json: { events: [], cursor: '1', head: snapshots, hasMore: false } });
    if (pathname.endsWith('/facade-assessment')) return route.fulfill({ json: {
      projectId, version: written.length + 2, stage: 'РД', activeWindows: 4, completedWindows: 3, structurallyReviewedWindows: 2,
      limitations: ['semantic_remainder_open'], outcome: 'needs_review',
      coverage: { inventory: boundary, map: boundary, reading: boundary, subject: boundary },
      contexts: [{ ...building, questions: checked ? [{ ...building.questions[0], version: decisions.length ? 3 : 2,
        clarification, decision: decisions.length ? { id: 'd8', outcome: 'needs_review', action: 'request_clarification',
          reason: 'Проверены листы и аналоги', createdAt: '2026-11-24T12:00:00Z', requestExternal: true, clarification } : undefined,
      }] : building.questions, facadeType: written.length
        ? { state: 'confirmed', kind: 'кассетный', basis, version: 1 }
        : { state: 'unconfirmed', kind: null, basis: null, version: null } }],
    } });
    if (pathname.endsWith('/observations')) return route.fulfill({ json: { version: written.length + 2, nextCursor: null, items: [{
      ...basis, versionId, evidenceHref: '/api/v1/evidence/' + evidenceId, proposedFacadeKind: 'кассетный', facadeKindSourceVerified: true,
      revisionStatus: 'current', binding: { state: 'identified', reason: '', candidates: [{ id: facadeId, label: 'Фасад Ф-3' }] },
    }] } });
    if (pathname.endsWith('/facades/' + facadeId + '/kind')) {
      written.push({ body: request.postDataJSON(), version: request.headers()['if-match'] });
      return route.fulfill({ json: { version: 8 } });
    }
    if (pathname.endsWith('/questions/' + questionId + '/decisions')) {
      decisions.push({ body: request.postDataJSON(), version: request.headers()['if-match'] });
      return route.fulfill({ status: 201, json: { id: 'd8', version: 3 } });
    }
    if (pathname.endsWith('/copilot/versions/' + versionId)) return route.fulfill({ json: {
      versionId, documentId, label: 'РД-2.pdf', version: 'current', mediaType: 'application/pdf',
      occurrenceId: 'fixture-occurrence', receiptId: 'fixture-receipt',
    } });
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });

  await page.goto('/projects/' + projectId + '/completeness/' + questionId + '?context=' + context);
  await page.getByText(/^Что вошло в проверку ·/).click();
  await expect(page.getByText('Структура проверена обеими ветвями')).toBeVisible();
  await expect(page.getByText('2 из 4', { exact: true })).toBeVisible();
  await expect(page.getByText('1 из 4 окон · Есть остаток')).toBeVisible();
  await expect(page.getByText('Альтернативы · Требуют сверки')).toBeVisible();
  await expect(page.getByText('Применимость требования требует подтверждения.')).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить тип фасада' }).click();
  await page.getByLabel('Тип и адресная опора').selectOption(observationId);
  await page.getByLabel('Комментарий инженера').fill('Проверен адрес и редакция Р2');
  await page.getByRole('button', { name: 'Сохранить тип фасада' }).click();
  await expect(page.getByText('кассетный · Подтверждён')).toBeVisible();
  expect(written).toEqual([{ body: { kind: 'кассетный', observationId, reason: 'Проверен адрес и редакция Р2' }, version: '"7"' }]);
  await page.getByRole('link', { name: 'Открыть место 3' }).click();
  await expect(page.getByText('РД-2.pdf')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть оригинал этой версии' }))
    .toHaveAttribute('href', '/api/documents/' + documentId + '/versions/' + versionId + '/content#page=3');
  await expect(page.getByRole('heading', { name: 'Запрос на уточнение' })).toHaveCount(0);

  checked = true;
  await page.goto('/projects/' + projectId + '/completeness/' + questionId + '?context=' + context);
  await page.getByText('Проверенные описи и места', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'РД-2.pdf · с. 3' })).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Подтвердить запрос на уточнение' });
  await page.getByLabel('Комментарий к запросу').fill('Проверены листы и аналоги');
  await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox', { name: /Подтверждаю проверку закрытых описей/ }).check();
  await confirm.click();
  expect(decisions).toEqual([{ body: { action: 'request_clarification', requestExternal: true, reason: 'Проверены листы и аналоги' },
    version: '"2"' }]);
  await expect(page.getByText(/Инженер подтвердил запрос для письма/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Запрос на уточнение' })).toBeVisible();
});

test('Каталог сохраняет применимость по типу и роли сравнения', async ({ page }) => {
  const forms: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/me') return route.fulfill({ json: {
      csrfToken: 'fixture', user: { id: 'synthetic', login: 'admin' }, actions: ['organization:admin'], projects: [],
    } });
    if (pathname === '/api/users') return route.fulfill({ json: { users: [] } });
    if (pathname === '/api/catalogs' && request.method() === 'POST') {
      forms.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { id: 'fixture' } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  await page.goto('/admin');
  await page.getByLabel('Код каталога').fill('typed-facade');
  await page.getByLabel('Название', { exact: true }).fill('Фасады');
  await page.getByRole('button', { name: 'Добавить обязательную часть' }).click();
  await page.getByLabel('Код части').fill('cladding');
  await page.getByLabel('Наименование').fill('Облицовка');
  await page.getByLabel('Уровень требования').selectOption('facade');
  await page.getByLabel('Применимые типы фасада через запятую').fill('Кассетный, Стоечно-ригельный');
  await page.getByLabel('Форматы', { exact: true }).fill('PDF, XLSX');
  await page.getByLabel('Роли источников').fill('drawing, schedule');
  await page.getByLabel('Критерий полноты').fill('Сверить толщину');
  await page.getByLabel('Адресат').fill('Инженер');
  await page.getByRole('button', { name: 'Задать правило доказательств' }).click();
  await page.getByLabel('Роль значения в доказательстве').selectOption('design');
  await page.getByRole('button', { name: 'Задать правила сравнения' }).click();
  await page.getByLabel('Приоритет').fill('15');
  await page.getByRole('button', { name: 'Добавить источник сравнения' }).click();
  await page.getByLabel('Роль сравниваемого источника').last().selectOption('schedule');
  await page.getByLabel('Роль сравниваемого значения').last().selectOption('as_built');
  await page.getByLabel('Приоритет').last().fill('12');
  await page.getByRole('button', { name: 'Опубликовать каталог' }).click();
  await expect.poll(() => forms.length).toBe(1);
  expect(forms[0]).toMatchObject({ requirements: [{
    level: 'facade', facadeKinds: ['Кассетный', 'Стоечно-ригельный'],
    evidenceRule: { allOf: [{ anyOf: [{ sourceRole: 'drawing', valueRole: 'design' }] }] },
    comparison: { sources: [
      { sourceRole: 'drawing', valueRole: 'design', priority: 15 }, { sourceRole: 'schedule', valueRole: 'as_built', priority: 12 },
    ] },
  }] });

  await page.getByLabel('Уровень требования').selectOption('common');
  await expect(page.getByLabel('Применимые типы фасада через запятую')).toHaveCount(0);
  await page.getByLabel('Что проверять').selectOption('presence');
  await page.getByRole('button', { name: 'Опубликовать каталог' }).click();
  await expect.poll(() => forms.length).toBe(2);
  const changed = (forms[1] as { requirements: { evidenceRule: { allOf: { anyOf: object[] }[] } }[] }).requirements[0];
  expect(changed).not.toHaveProperty('facadeKinds');
  expect(changed.evidenceRule.allOf[0].anyOf[0]).not.toHaveProperty('valueRole');
});
