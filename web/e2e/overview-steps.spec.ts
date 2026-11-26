import { expect, test } from '@playwright/test';

import { versionForCount } from '../src/lib/assessment-version';
import { ApiError } from '../src/lib/http';
import { matchesSelection } from '../src/lib/triage';
import type { AssessmentQuestion } from '../src/lib/workspace';

test('Пять выборок открывают конкретные строки, включая отдельный запрос на уточнение', () => {
  const rows = Array.from({length:16}, (_, id) => ({id:String(id),
    outcome:id < 5 ? 'covered' : id === 5 ? 'confirmed_missing' : 'needs_review', letterEligible:id === 5} as AssessmentQuestion));
  const ids = (selection:string) => rows.filter(row => matchesSelection(row, selection)).map(row => row.id);
  expect(ids('all')).toEqual(rows.map(row => row.id));
  expect(ids('checked')).toEqual(rows.slice(0,6).map(row => row.id));
  expect(ids('done')).toEqual(rows.slice(0,5).map(row => row.id));
  expect(ids('review')).toEqual(rows.slice(6).map(row => row.id));
  expect(ids('letter')).toEqual(['5']);
  rows[5].outcome = 'needs_review';
  expect(ids('checked')).toHaveLength(5);
  expect(ids('letter')).toEqual(['5']);
  expect(ids('review')).not.toContain('5');
});

test('Счётчик открывает прежнюю редакцию и сохраняет проверку доступа', async () => {
  const current = { version: 4 };
  const requested: string[] = [];
  const load = async (id: string) => { requested.push(id); return { version: Number(id) }; };
  expect(await versionForCount('4', current, load)).toEqual({ snapshot: current });
  expect(requested).toEqual([]);
  expect(await versionForCount('3', current, load)).toEqual({ snapshot: { version: 3 }, historical: '3' });
  expect(requested).toEqual(['3']);
  const missing = async () => { throw new ApiError(404, 'assessment_not_found', 'Редакция недоступна'); };
  expect(await versionForCount('2', current, missing)).toEqual({ snapshot: current, expired: true });
  const denied = new ApiError(403, 'forbidden', 'Доступ отозван');
  await expect(versionForCount('3', current, async () => { throw denied; })).rejects.toBe(denied);
});

test('Обзор выбирает операцию и счётчики именно выбранного фасада', async ({ page }) => {
  const id = '10000000-0000-4000-8000-000000000001';
  const project = { id, name: 'Два фасада', version: 1, scopes: [], intakeMode: true, actions: ['project:read', 'project:engineer'] };
  const areaA = { contextId: 'area-a', name: 'Фасад А', kind: 'facade', total: 2, ready: 0, checked: 0,
    review: 2, letter: 0, actionable: 1, conflicts: 0, covered: 0, concluded: false, outcome: 'needs_review' };
  const areaB = { ...areaA, contextId: 'area-b', name: 'Фасад Б', total: 1, review: 1, actionable: 0, concluded: true };
  let accepted = 0;
  let unavailable = false;
  const route = '/projects/' + id + '/overview';
  await page.route('**/api/**', async req => {
    const path = new URL(req.request().url()).pathname;
    if (path === '/api/me') return req.fulfill({json: {user: {id, login: 'tester', organizationId: id}, projects: [project], csrfToken: 'test'}});
    if (path === '/api/projects/' + id) return req.fulfill({json: project});
    if (path.endsWith('/work-slices/current') && unavailable) return req.fulfill({status:503,json:{code:'unavailable',message:'Сводка недоступна'}});
    if (path.endsWith('/work-slices/current')) return req.fulfill({json: {projectId: id, workSliceId: 'one', files: { accepted, prepared: accepted },
      acceptedOccurrences: accepted, totals: {all: accepted, open: 0, processing: 0}, filters: [], readings: [], confirmedBytes: 0,
      assessment: {kind: 'facade', version: 4, total: 3, review: 3, covered: 0, contexts: [areaA, areaB]}}});
    return req.fulfill({json: {events: [], cursor: '0', sliceId: '1', changes: []}});
  });
  unavailable = true;
  await page.goto(route + '?context=area-a');
  const continuation = page.getByRole('navigation', {name:'Продолжить работу'});
  await expect(continuation.getByRole('link', {name:'Загрузить комплект'})).toHaveAttribute('href', /receipts.*upload=1/);
  await expect(continuation.getByRole('link', {name:'Открыть поступления'})).toBeVisible();
  await expect(page.getByRole('button', {name:'Обновить обзор'})).toBeVisible();
  unavailable = false;
  await page.getByRole('button', {name:'Обновить обзор'}).click();
  const current = page.locator('summary[aria-current="step"]');
  await expect(current).toContainText('1. Приём');
  accepted = 1;
  await page.reload();
  await expect(current).toContainText('3. Проверка требований');
  await expect(page.getByRole('link', {name: 'Требуют проверки · 2'})).toHaveAttribute('href', /context=area-a/);
  await page.getByRole('link', {name: 'Фасад Б', exact: true}).click();
  await expect(current).toContainText('4. Заключение');
  await expect(page.getByRole('link', {name: 'Открыть заключение по области'})).toHaveAttribute('href', /context=area-b/);
  await page.goBack();
  await expect(current).toContainText('3. Проверка требований');
  await page.goto(route + '?context=obsolete');
  await expect(page.getByText('Выбранная область проверки недоступна.')).toBeVisible();
  await expect(page.getByRole('link', {name: /Требуют проверки ·/})).toHaveCount(0);
});

test('Остаток комплекта виден рядом с доказанными результатами и действующими основаниями письма', async ({ page }) => {
  const id = '20000000-0000-4000-8000-000000000001';
  const contextId = '20000000-0000-4000-8000-000000000002';
  const project = { id, name: 'Смешанный комплект', version: 1, scopes: [], intakeMode: true,
    actions: ['project:read', 'project:engineer'] };
  const base = '/projects/' + id;
  const api = '/api' + base;
  const recipient = 'Заказчик';
  const partialTitle = 'Подсистема';
  const limitedTitle = 'Теплотехника';
  const conflictTitle = 'Толщина облицовки';
  const stableTitle = 'Изоляция';
  const outcome = 'mixed';
  const areaCounts = { contextId, name: 'Весь комплект', kind: 'common', total: 16, ready: 2,
    checked: 4, review: 12, letter: 2, actionable: 1, conflicts: 2, covered: 3, concluded: false, outcome,
    evidence: { proven: 3, partial: 2, remainder: 15 } };
  const position = { cursor: '1', projectionVersion: '1', sliceId: '1' };
  let basisVersion = 1;
  let letter: { id: string; number: number; version: number; status: string; recipient: string; assessmentContextId: string; revisionId: string } | undefined;
  let saved: unknown;
  let stale = false;
  function ground(questionId: string, subject: string, questionVersion: number) {
    const action = 'Подтвердить значение';
    return { questionId, subject, questionVersion, decisionId: questionId + '-decision-' + questionVersion,
      kind: 'confirmed_conflict', recipient, action, wording: subject + '. Просим подтвердить значение.', sources: [] };
  }
  function question(questionId: string, subject: string, machineOutcome: string, complete = false) {
    return { id: questionId, version: 1, outcome: machineOutcome,
      requirement: { subject, part: subject, formats: ['pdf'], completeness: 'Проверить на листе' },
      letterEligible: machineOutcome === 'confirmed_conflict',
      machine: { outcome: machineOutcome, limitations: [], citations: [], receiptIds: [] },
      semanticRemainder: { state: complete ? 'complete' : 'open', totalWindows: 2,
        verifiedWindows: complete ? 2 : 1, reasons: [], omittedItems: 0,
        items: questionId === 'partial' ? [{ versionId: 'file-v1', unitId: '2', reason: 'reading_pending',
          pendingBranches: ['B'], nextAction: 'Сверить примечание под таблицей.' }] : [] },
    };
  }
  const limited = question('limited', limitedTitle, 'covered', true);
  const requirements = [
    question('done', 'Разрез', 'covered', true), question('partial', partialTitle, 'covered'),
    { ...limited, machine: { ...limited.machine, limitations: ['reading_incomplete'] },
      decision: { id: 'decision', action: 'confirm', outcome: 'covered', reason: 'Сверено инженером' } },
    question('conflict', conflictTitle, 'confirmed_conflict'), question('stable', stableTitle, 'confirmed_conflict'),
    ...Array.from({ length: 11 }, (_, i) => question('open-' + i, 'Критерий ' + (i + 6), 'needs_review')),
  ];
  const boundary = { complete: true, reason: null, basisIds: [] };
  const text = stableTitle + '. Просим подтвердить значение.';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (pathname === '/api/me') return route.fulfill({ json: {
      user: { id, login: 'engineer', organizationId: id }, csrfToken: 'fixture', projects: [project],
    } });
    if (pathname === api) return route.fulfill({ json: project });
    if (pathname === api + '/snapshot') return route.fulfill({ json: position });
    if (pathname === api + '/events') return route.fulfill({ json: { events: [], cursor: '1', head: position, hasMore: false } });
    if (pathname.endsWith('/work-slices/current')) return route.fulfill({ json: {
      projectId: id, workSliceId: 'one', files: { accepted: 2, prepared: 2 }, acceptedOccurrences: 2,
      totals: { all: 1, open: 0, processing: 1 }, filters: [], confirmedBytes: 16,
      readings: [{ state: 'held', branch: 'B', total: 1 }],
      stops: [{ jobId: 'job', branch: 'B', reason: 'unknown_charge', nextAction: 'operator_reconcile_attempt' }],
      assessment: { ...areaCounts, kind: 'facade', version: 1, contexts: [areaCounts] },
    } });
    if (pathname.endsWith('/facade-assessment')) return route.fulfill({ json: {
      projectId: id, version: 1, stage: 'Стадия 1', outcome, activeWindows: 2, completedWindows: 1,
      limitations: ['reading_incomplete'], coverage: { inventory: boundary, map: boundary, reading: boundary, subject: boundary },
      contexts: [{ assessmentContextId: contextId, name: 'Весь комплект', version: 1, kind: 'common', outcome, counts: {},
        questionHolds: [], questions: requirements }],
    } });
    if (pathname.endsWith('/inquiries')) return route.fulfill({ json: { inquiries: [], nextAfter: null, sliceId: '1' } });
    if (pathname.endsWith('/confirmation-originals')) return route.fulfill({ json: { originals: [], nextCursor: null } });
    if (pathname.endsWith('/applicability')) return route.fulfill({ json: { replacements: [] } });
    if (pathname.endsWith('/letters/eligible')) return route.fulfill({ json: {
      items: [ground('conflict', conflictTitle, basisVersion), ground('stable', stableTitle, 1)], holds: [],
    } });
    if (pathname.endsWith('/letters') && req.method() === 'POST') {
      saved = req.postDataJSON();
      letter = { id: 'saved-letter', number: 1, version: 1, status: 'confirmed', recipient, assessmentContextId: contextId, revisionId: 'rev1' };
      return route.fulfill({ status: 201, json: letter });
    }
    if (pathname.endsWith('/letters')) return route.fulfill({ json: { items: letter ? [letter] : [] } });
    if (pathname.endsWith('/letters/saved-letter')) return route.fulfill({ json: {
      ...letter, revisions: [{ id: 'rev1', version: 1, status: 'confirmed' }], sent: [], responses: [], exports: [],
    } });
    if (pathname.endsWith('/revisions/rev1')) return route.fulfill({ json: {
      id: 'rev1', status: 'confirmed', items: [{ ...ground('stable', stableTitle, 1), id: 'item', editedWording: null }],
      text, recipient, layout: 'formal', version: 1,
    } });
    if (pathname.endsWith('/current-text')) return stale
      ? route.fulfill({ status: 412, json: { code: 'letter_basis_stale', message: 'Основание письма изменилось.' } })
      : route.fulfill({ json: { text, version: 1, revisionId: 'rev1' } });
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto(base + '/overview');
  await expect(page.getByRole('list', { name: 'Остановленные задания' })).toContainText('Техническому оператору нужно сверить журнал отправок');
  await expect(page.getByRole('link', { name: 'Подтверждено к запросу · 2' })).toBeVisible();
  await page.getByRole('link', { name: 'Все требования · 16', exact: true }).click();
  await expect(page.locator('[data-triage-row]')).toHaveCount(16);
  await expect(page.getByRole('row').filter({ hasText: 'Разрез' })).toContainText('Доказана достаточность');
  await expect(page.getByRole('row').filter({ hasText: partialTitle })).toContainText('Найдено частично');
  await expect(page.getByRole('row').filter({ hasText: limitedTitle })).toContainText('Найдено частично');
  await expect(page.getByRole('row').filter({ hasText: limitedTitle })).toContainText('есть ограничения');
  await page.getByRole('radio', { name: 'Найдено частично 2' }).check();
  await expect(page.locator('[data-triage-row]')).toHaveCount(2);
  await page.getByRole('link', { name: partialTitle, exact: true }).click();
  await expect(page.getByText('Сверить примечание под таблицей.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть место 2' })).toHaveAttribute('href', /copilot.*version=file-v1.*unit=2/);
  await page.getByRole('link', { name: 'Внутренние вопросы', exact: true }).click();
  await expect(page.getByRole('link', { name: partialTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: conflictTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: limitedTitle, exact: true })).toHaveCount(0);

  await page.goto(base + '/letters?context=' + contextId);
  await page.getByRole('combobox', { name: 'Адресат', exact: true }).selectOption(recipient);
  await page.getByRole('checkbox', { name: new RegExp(conflictTitle) }).check();
  await page.getByRole('checkbox', { name: new RegExp(stableTitle) }).check();
  basisVersion = 2;
  await page.locator('.sync-menu > summary').click();
  await page.getByRole('button', { name: 'Обновить сейчас' }).click();
  await expect(page.getByText('Основания части выбранных пунктов изменились.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: new RegExp(conflictTitle) })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: new RegExp(stableTitle) })).toBeChecked();
  await page.getByRole('button', { name: 'Создать письмо из выбранных пунктов' }).click();
  await expect(page.getByTestId('current-letter-text')).toHaveText(text);
  expect(saved).toEqual({ assessmentContextId: contextId, recipient,
    items: [{ questionId: 'stable', questionVersion: 1, decisionId: 'stable-decision-1' }] });

  stale = true;
  await page.locator('.sync-menu > summary').click();
  await page.getByRole('button', { name: 'Обновить сейчас' }).click();
  await expect(page.getByText('Основание письма изменилось.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выгрузить TXT' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Редакция 1' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
