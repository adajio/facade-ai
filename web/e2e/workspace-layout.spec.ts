import { expect, test, type Page } from '@playwright/test';

const project = {
  id: 'project-ui', name: 'Контроль направляющих', version: 1, actions: ['project:engineer', 'project:manage'],
  scopes: [
    { id: 'scope-a', name: 'Фасад А', stage: 'РД', version: 1 },
    { id: 'scope-b', name: 'Фасад Б', stage: 'РД', version: 1 },
  ],
};
const session = { user: { id: 'engineer', login: 'Инженер' }, projects: [project], csrfToken: 'synthetic' };
const base = '/projects/' + project.id + '/completeness';
const citations = [
  { evidenceId: 'drawing', documentId: 'pdf', versionId: 'pdf-v1', value: '44', unit: 'мм', label: 'Направляющие.pdf' },
  { evidenceId: 'schedule', documentId: 'xlsx', versionId: 'xlsx-v1', value: '51', unit: 'мм', label: 'Ведомость.xlsx' },
];
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBeYAAAAASUVORK5CYII=', 'base64');

async function mockProject(page: Page) {
  const requests = { images: 0, verify: 0, deny: false, documents: 0 };
  page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) requests.documents++; });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value, headers: { 'cache-control': 'no-store' } });
    if (path === '/api/me') {
      requests.verify++;
      return requests.deny ? json({ code: 'denied' }, 403) : json(session);
    }
    if (path === '/api/sessions/current') return route.fulfill({ status: 204 });
    if (path === '/api/projects/' + project.id) return json(project);
    if (path.endsWith('/snapshot')) return json({
      sliceId: 'slice-1', projectionVersion: '4', cursor: '4', navCounts: { needsReview: 1, activeUploads: 2 },
    });
    if (path.endsWith('/events')) return json({ events: [], cursor: '4', hasMore: false });
    if (path.endsWith('/assessments/current')) return json({
      version: 1, outcome: 'needs_review', catalogVersionId: 'catalog-1',
      questions: [{
        id: 'question-1', version: 1, outcome: 'confirmed_conflict',
        requirement: { subject: 'Направляющая', part: 'Толщина', formats: ['PDF', 'XLSX'] },
        machine: { outcome: 'confirmed_conflict', limitations: [], citations, receiptIds: [] },
      }],
    });
    if (path.endsWith('/evidence/drawing/content')) {
      requests.images++;
      return route.fulfill({ body: picture, contentType: 'image/png', headers: { 'cache-control': 'no-store' } });
    }
    if (path.endsWith('/evidence/schedule/content')) return json({ lines: [{ text: 'I3 · 51 мм' }] });
    const evidence = citations.find((item) => path.endsWith('/evidence/' + item.evidenceId));
    if (evidence) return json({
      id: evidence.evidenceId,
      source: { projectId: project.id, documentId: evidence.documentId, versionId: evidence.versionId, sha256: 'synthetic', name: evidence.label },
      address: evidence.documentId === 'pdf' ? { page: 1 } : { locator: { sheet: 'Current data', cell: 'I3' } },
    });
    if (path.startsWith('/api/documents/') && route.request().method() === 'HEAD') return route.fulfill({
      status: 200, headers: { etag: '"sha256-synthetic"', 'content-type': 'application/pdf', 'cache-control': 'no-store' },
    });
    return json({ code: 'not_found' }, 404);
  });
  return requests;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test(`Рабочая строка, сравнение и SPA-навигация · ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const requests = await mockProject(page);
    await page.goto(base + '?scope=scope-a');
    const select = page.getByLabel('Стадия и область');
    const compare = page.getByRole('button', { name: 'Сравнить два источника' });
    await expect(compare).toBeVisible();
    await select.selectOption('scope-b');
    await expect(page).toHaveURL(/scope=scope-b/);
    await page.goBack();
    await expect(select).toHaveValue('scope-a');
    expect(requests.documents).toBe(1);

    await page.getByRole('heading', { name: 'Комплектность', exact: true }).click();
    await page.keyboard.press('j');
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toBeFocused();
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toHaveCount(0);
    await page.keyboard.press('1');
    await compare.click();
    const viewer = page.getByRole('region', { name: 'Сравнение источников' });
    await expect(viewer.getByText(/Δ \+7 мм \(\+15,9\s*%\)/)).toBeVisible();
    await expect(viewer.getByRole('img', { name: 'Сохранённое изображение участка оригинала' })).toBeVisible();
    await expect(viewer.getByText('I3 · 51 мм')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toBeInViewport();
    await expect(viewer.getByRole('button', { name: 'Подтвердить конфликт для письма' })).toBeInViewport();
    if (process.env.FACADE_AXE_PATH) {
      await page.addScriptTag({ path: process.env.FACADE_AXE_PATH });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (options: object) => Promise<{
          violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
        }> } }).axe;
        const result = await axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
        return result.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
          .map(({ id, nodes }) => ({ id, targets: nodes.flatMap(({ target }) => target) }));
      });
      expect(violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('comparison.png'), fullPage: false });
    }
    await page.keyboard.press(']');
    const handle = page.getByRole('separator', { name: 'Ширина просмотрщика' });
    await expect(handle).toHaveAttribute('aria-valuenow', viewport.width === 1024 ? '67' : '60');
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', viewport.width === 1024 ? '62' : '55');
    const bounds = await handle.boundingBox();
    expect(bounds).toBeTruthy();
    await page.mouse.move(bounds!.x + 3, bounds!.y + 12);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + 44, bounds!.y + 12);
    await page.mouse.up();
    expect(Number(await handle.getAttribute('aria-valuenow'))).toBeLessThan(viewport.width === 1024 ? 62 : 55);

    await page.keyboard.press('Escape');
    await expect(compare).toBeFocused();
    await compare.click();
    await expect(viewer.getByRole('img', { name: 'Сохранённое изображение участка оригинала' })).toBeVisible();
    expect(requests.images).toBe(1);
    await viewer.getByRole('button', { name: 'Подтвердить конфликт для письма' }).click();
    await expect(page.getByLabel('Основание решения')).toBeFocused();
    await expect(page.getByLabel('Подтвердить к внешнему запросу')).toBeChecked();
  });
}

test('Краткий уход сохраняет экран, pagehide скрывает DOM, отказ очищает доступ', async ({ page }) => {
  const requests = await mockProject(page);
  await page.goto(base + '?scope=scope-a');
  const reason = page.getByLabel('Основание решения');
  await reason.fill('Несохранённый комментарий');
  const protectedContent = page.locator('#protected-content');
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await expect.poll(() => requests.verify).toBeGreaterThan(1);
  await expect(reason).toBeFocused();
  await expect(reason).toHaveValue('Несохранённый комментарий');
  await expect(protectedContent).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Проверяем доступ' })).toHaveCount(0);

  const synchronouslyHidden = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return document.getElementById('protected-content')?.hidden;
  });
  expect(synchronouslyHidden).toBe(true);
  requests.deny = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('heading', { name: 'Ресурс недоступен' })).toBeVisible();
  await expect(protectedContent).toHaveCount(0);
});

test('Истечение окна доступа отзывает объектные URL открытых материалов', async ({ page }) => {
  await page.clock.install();
  await mockProject(page);
  await page.addInitScript(() => {
    document.documentElement?.setAttribute('data-revoked', '0');
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => {
      const root = document.documentElement;
      root.dataset.revoked = String(Number(root.dataset.revoked ?? 0) + 1);
      revoke(url);
    };
  });
  await page.goto(base + '?scope=scope-a');
  await page.getByRole('button', { name: 'Сравнить два источника' }).click();
  await expect(page.getByRole('img', { name: 'Сохранённое изображение участка оригинала' })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
  await page.clock.fastForward(31_000);
  await expect(page.getByRole('heading', { name: 'Доступ требует проверки' })).toBeVisible();
  await expect(page.locator('#protected-content')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-revoked', '1');
});

test('Источник Помощника открывается рядом с ответом и сохраняет черновик', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = await mockProject(page);
  const original = { id: 'source-1', label: 'Ведомость.xlsx', documentId: 'sheet', versionId: 'sheet-v1',
    address: { unitId: 'table-1', locator: { sheet: 'Current data', cell: 'I3' } }, text: 'Толщина 51 мм',
    version: 'current', representation: 'native', limitations: [] };
  await page.route('**/api/projects/project-ui/copilot/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/budget')) return route.fulfill({ json: { state: 'ready', limitUsdNanos: 100_000_000, remainingUsdNanos: 0 } });
    return route.fulfill({ json: path.endsWith('/sources')
      ? { mode: 'originals', source: original }
      : { id: 'question', question: 'Толщина?', state: 'answered', citations: [original], claims: [{ text: 'Указано 51 мм', sources: ['source-1'] }] } });
  });
  await page.goto('/projects/project-ui/copilot/question?scope=scope-a');
  const draft = page.getByLabel('Вопрос инженера');
  await draft.fill('Следующий вопрос инженера');
  await expect(page.getByRole('link', { name: /Помощник · остаток/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Спросить помощника' })).toBeDisabled();
  await expect(page.getByText('Указано 51 мм')).toBeVisible();
  const chip = page.getByRole('link', { name: /Ведомость\.xlsx/ }).first();
  await chip.click();
  const source = page.getByRole('complementary', { name: 'Источник помощника' });
  await expect(source.getByText('Толщина 51 мм')).toBeVisible();
  await expect(draft).toHaveValue('Следующий вопрос инженера');
  expect((await source.boundingBox())!.x).toBeGreaterThan((await draft.boundingBox())!.x);
  await page.keyboard.press('Escape');
  await expect(source).toHaveCount(0);
  await expect(chip).toBeFocused();
  expect(requests.documents).toBe(1);
});
