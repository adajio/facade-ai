import { expect, test, type Page } from '@playwright/test';

const projectId = '20000000-0000-4000-8000-000000000001';
const contextId = '20000000-0000-4000-8000-000000000002';
const receiptId = '20000000-0000-4000-8000-000000000003';
const documentId = '20000000-0000-4000-8000-000000000004';
const versionId = '20000000-0000-4000-8000-000000000005';
const statuses = ['present', 'partial', 'not_found', 'unassessed'] as const;
const labels = ['Представлено', 'Частично', 'Не найдено', 'Не оценено'];
const base = `/projects/${projectId}/completeness`;

async function fixture(page: Page, editable: boolean) {
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
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { csrfToken: 'test', user: { id: 'engineer', login: 'test' }, projects: [project] } });
    if (path === `/api/projects/${projectId}`) return route.fulfill({ json: project });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: { cursor: '0', sliceId: '0', projectionVersion: '0' } });
    if (path.endsWith('/events')) return route.fulfill({ json: { events: [], cursor: '0', hasMore: false } });
    if (path.endsWith('/preliminary-package-reviews')) return route.fulfill({ json: { items: [review], nextCursor: null } });
    if (path.endsWith('/reading-progress')) return route.fulfill({ json: { totalWindows: 3, mappedVersions: 1, acceptedVersions: 1,
      completed: 0, covered: 0, noMatch: 0, refused: 0, held: 0, reading: 1 } });
    if (path.endsWith('/facade-assessment')) return route.fulfill({ json: assessment() });
    if (path.endsWith('/facade-assessment/1')) return route.fulfill({ json: assessment(true) });
    if (path.endsWith('/questions/question-0/decisions') && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push({ body, version: request.headers()['if-match'] });
      decision = { action: 'confirm', outcome: 'needs_review', reason: String(body.reason), authorId: 'engineer', createdAt: '2026-11-26T00:00:00Z' };
      return route.fulfill({ status: 201, json: { id: 'decision', version: 2, outcome: 'needs_review' } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  return { submissions };
}

test('Комплектность показывает цвета и путь инженера до технических блоков, решение сохраняется и открывается снова', async ({ page }) => {
  const { submissions } = await fixture(page, true);
  await page.goto(base);
  const table = page.getByRole('region', { name: 'Комплектность по требованиям' });
  const heading = table.getByRole('heading', { name: 'Требования · Весь комплект' });
  await expect(heading).toBeVisible();
  const technical = page.getByText('Что вошло в проверку · версия 1', { exact: true });
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
