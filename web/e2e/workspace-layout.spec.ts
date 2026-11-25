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

    await page.getByRole('button', { name: 'Направляющая · Толщина' }).focus();
    await page.keyboard.press('j');
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toBeFocused();
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toBeFocused();
    await page.getByRole('radio', { name: /Все требования/ }).focus();
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: 'Направляющая · Толщина' })).toHaveCount(0);
    await page.getByRole('radio', { name: /Требуют проверки/ }).focus();
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
    if (viewport.width === 1024) {
      const height = page.getByRole('separator', { name: 'Высота просмотрщика' });
      await height.focus();
      await page.keyboard.press('ArrowUp');
      await expect(height).toHaveAttribute('aria-valuenow', '67.5');
      await page.getByRole('button', { name: 'Показать сбоку' }).click();
    }
    const handle = page.getByRole('separator', { name: 'Ширина просмотрщика' });
    await handle.focus();
    await page.keyboard.press(']');
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

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const intersect = (first: DOMRect, second: DOMRect) =>
      Math.min(first.right, second.right) > Math.max(first.left, second.left) &&
      Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top);
    const colors = (css: string) => css.match(/[\d.]+/g)!.map(Number);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map((value) => value / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    function contrast(node: Element) {
      const parents = [];
      for (let current: Element | null = node; current; current = current.parentElement) {
        parents.push(colors(getComputedStyle(current).backgroundColor));
      }
      const background = parents.reverse().reduce((under, top) => {
        const alpha = top[3] ?? 1;
        return under.map((value, i) => top[i] * alpha + value * (1 - alpha));
      }, [255, 255, 255]);
      const actual = luminance(colors(getComputedStyle(node).color));
      const paper = luminance(background);
      return (Math.max(actual, paper) + .05) / (Math.min(actual, paper) + .05);
    }
    const rail = document.querySelector('.workspace > aside')!;
    const frame = document.querySelector('.project-content')!;
    const list = frame.querySelector('.section-content')!;
    const dock = frame.querySelector('.evidence-dock')!;
    const viewer = dock.querySelector('.comparison')!;
    const separator = frame.querySelector('[role="separator"]');
    const controls = [...viewer.querySelectorAll('button, a.button, summary'), ...dock.querySelectorAll('.layout-toggle')]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({ element, name: element.getAttribute('aria-label') ?? element.textContent?.trim(), ...rect(element) }));
    const region = separator?.getBoundingClientRect();
    const horizontal = separator?.getAttribute('aria-orientation') === 'horizontal';
    const line = separator ? Number.parseFloat(getComputedStyle(separator, '::before')[horizontal ? 'height' : 'width']) : null;
    const crossed = region && region.width && region.height ? controls
      .filter(({ element }) => intersect(region, element.getBoundingClientRect()))
      .map(({ name }) => name) : [];
    const physicalHits = region && region.width && region.height ? [.05, .5, .95].map((point) => {
      const x = region.left + region.width * (horizontal ? .5 : point);
      const y = region.top + region.height * (horizontal ? point : .5);
      const element = document.elementFromPoint(x, y);
      return element?.closest('[role="separator"]') === separator;
    }) : [];
    const listBounds = list.getBoundingClientRect();
    const dockBounds = dock.getBoundingClientRect();
    const adjacent = [...controls.map(({ element }) => element), ...list.querySelectorAll('button, a.button, summary')];
    const frontControls = adjacent.flatMap((element) => {
      if (!element.getClientRects().length) return [];
      const bounds = element.getBoundingClientRect();
      const owner = list.contains(element) ? listBounds : dockBounds;
      const left = Math.max(bounds.left, owner.left, 0);
      const right = Math.min(bounds.right, owner.right, innerWidth);
      const top = Math.max(bounds.top, owner.top, 0);
      const bottom = Math.min(bounds.bottom, owner.bottom, innerHeight);
      if (right - left < 2 || bottom - top < 2) return [];
      const hits = [left + 1, (left + right) / 2, right - 1].some((x) =>
        [top + 1, (top + bottom) / 2, bottom - 1].some((y) =>
          document.elementFromPoint(x, y)?.closest('[role="separator"]')));
      return hits ? [element.getAttribute('aria-label') ?? element.textContent?.trim()] : [];
    });
    const metadata = [...viewer.querySelectorAll('.values small, .details dt, .meta')]
      .filter((node) => node.getClientRects().length)
      .map((node) => ({ text: node.textContent?.trim(), ratio: contrast(node) }));
    return {
      rail: rect(rail), frame: rect(frame), list: rect(list), dock: rect(dock), viewer: rect(viewer),
      separator: separator && region?.width && region?.height ? {
        ...rect(separator), horizontal, line, physicalHits, crossed, frontControls,
        paneOverlap: [intersect(region, listBounds), intersect(region, dockBounds)],
      } : null,
      controls: controls.map(({ name, width, height }) => ({ name, width, height })),
      minimumContrast: Math.min(...metadata.map(({ ratio }) => ratio)), metadata,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

for (const width of [850, 851, 1140, 1141, 1366, 1367]) {
  test(`Граница ${width}px · разделитель, цели и возврат к строке`, async ({ page }, info) => {
    const height = 850;
    const compact = width >= 851 && width <= 1140;
    const mobile = width <= 850;
    await page.setViewportSize({ width, height });
    await mockProject(page);
    await page.goto(base + '/question-1?scope=scope-a');
    const row = page.getByRole('button', { name: 'Направляющая · Толщина' });
    const compare = page.getByRole('button', { name: 'Сравнить два источника' });
    await expect(row).toBeVisible();
    if (mobile) {
      const menu = page.getByRole('button', { name: /^Разделы/ });
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('navigation', { name: 'Разделы проекта' })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    } else {
      expect((await page.locator('.workspace > aside').boundingBox())?.width).toBe(compact ? 56 : 232);
    }
    await compare.click();
    const viewer = page.getByRole('region', { name: 'Сравнение источников' });
    await expect(viewer.getByText('I3 · 51 мм')).toBeVisible();
    const address = viewer.getByText('Адрес и редакция', { exact: true }).first();
    await address.click();
    await expect(viewer.getByText('Направляющие.pdf', { exact: true }).last()).toBeVisible();
    const pane = await layoutMetrics(page);
    await info.attach('layout.json', { body: JSON.stringify(pane, null, 2), contentType: 'application/json' });
    expect.soft(pane.horizontalOverflow).toBe(0);
    expect.soft(pane.minimumContrast).toBeGreaterThanOrEqual(7);
    expect.soft(pane.controls.filter(({ width, height }) => width < 39.99 || height < 39.99)).toEqual([]);
    const checkSeparator = (value: NonNullable<typeof pane.separator>, horizontal: boolean) => {
      expect.soft(value.horizontal).toBe(horizontal);
      expect.soft(horizontal ? value.height : value.width).toBeGreaterThanOrEqual(40);
      expect.soft(value.line).toBe(6);
      expect.soft(value.physicalHits).toEqual([true, true, true]);
      expect.soft(value.crossed).toEqual([]);
      expect.soft(value.frontControls).toEqual([]);
      expect.soft(value.paneOverlap).toEqual([false, false]);
    };
    if (mobile) {
      expect.soft(pane.separator).toBeNull();
      expect.soft(pane.viewer).toMatchObject({ x: 0, y: 0, width, height });
    } else {
      expect(pane.separator).not.toBeNull();
      checkSeparator(pane.separator!, compact);
      expect.soft(pane.rail.width).toBe(width <= 1366 ? 56 : 232);
      const share = compact ? pane.dock.height / (pane.list.height + pane.dock.height) :
        pane.dock.width / (pane.list.width + pane.dock.width);
      expect.soft(share).toBeCloseTo(compact ? .625 : width <= 1366 ? .56 : .55, 2);
      if (compact) {
        await page.getByRole('button', { name: 'Показать сбоку' }).click();
        const drawer = await layoutMetrics(page);
        await info.attach('drawer.json', { body: JSON.stringify(drawer, null, 2), contentType: 'application/json' });
        expect(drawer.separator).not.toBeNull();
        checkSeparator(drawer.separator!, false);
        expect.soft(drawer.dock.width / drawer.frame.width).toBeCloseTo(.62, 2);
        await page.getByRole('button', { name: 'Показать снизу' }).click();
      }
    }
    await viewer.getByRole('button', { name: 'Закрыть сравнение источников' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(compare).toBeFocused();
    await expect(row).toBeInViewport();
    await expect(page).toHaveURL(/question-1\?scope=scope-a/);
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
