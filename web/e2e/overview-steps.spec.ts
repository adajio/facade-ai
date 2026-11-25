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
