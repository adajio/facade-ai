import { expect as playwrightExpect, test } from '@playwright/test';
import { accepted, account, admin, command, pdf, signIn, unique } from './synthetic';

const expect = playwrightExpect.configure({ timeout: 45_000 });

test.describe('Рабочее место на штатном API', () => {
  test.describe.configure({ timeout: 180_000 });
  test.skip(!admin.login || !admin.password, 'Задайте FACADE_E2E_ADMIN_LOGIN и FACADE_E2E_ADMIN_PASSWORD для отдельной синтетической БД');

  test('Вход, каталог, обрыв загрузки, ранний оригинал и отзыв доступа', async ({ page, browser, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const info = await page.request.get('/readyz');
    expect(info.ok()).toBe(true);

    const ownerErrors: string[] = [];
    page.on('pageerror', (error) => ownerErrors.push(error.name));

    await signIn(page, admin.login!, admin.password!, '/admin');
    await expect(page.getByRole('heading', { name: 'Администрирование' })).toBeVisible();
    const catalogName = unique('Каталог-web');
    await page.getByLabel('Код каталога').fill(unique('web'));
    await page.getByLabel('Название', { exact: true }).fill(catalogName);
    const [published] = await Promise.all([
      page.waitForResponse((result) => new URL(result.url()).pathname === '/api/catalogs' && result.request().method() === 'POST'),
      page.getByRole('button', { name: 'Опубликовать каталог' }).click(),
    ]);
    expect(published.ok()).toBe(true);
    const { id: catalogVersionId } = await published.json() as { id: string };
    await expect(page.getByText('Версия каталога опубликована.')).toBeVisible();

    const engineerContext = await browser.newContext({ baseURL });
    const viewerContext = await browser.newContext({ baseURL });
    const operatorContext = await browser.newContext({ baseURL });
    const outsiderContext = await browser.newContext({ baseURL });
    const contexts = [engineerContext, viewerContext, operatorContext, outsiderContext];
    try {
      const engineer = await account(page.context(), engineerContext, origin, 'web-eng');
      const viewer = await account(page.context(), viewerContext, origin, 'web-view');
      const operator = await account(page.context(), operatorContext, origin, 'web-ops', true);
      const outsider = await account(page.context(), outsiderContext, origin, 'web-out');

      const project = unique('Фасад-web');
      const { id: projectId } = await accepted<{ id: string }>(await command(
        page.context(), origin, '/api/projects', 'POST', { name: project, catalogVersionId },
      ), 'Проект прежнего формата');
      const projectPath = '/projects/' + projectId;
      await page.goto(projectPath + '/overview');
      await expect(page.getByRole('navigation', { name: 'Путь к проекту' }).getByText(project)).toBeVisible();

      await page.getByRole('button', { name: 'Добавить область' }).click();
      await page.getByLabel('Название области').fill('Фасад А');
      await page.getByLabel('Стадия', { exact: true }).fill('РД');
      await page.getByRole('button', { name: 'Сохранить область' }).click();
      const scopeSelect = page.getByLabel('Стадия и область');
      await scopeSelect.selectOption({ label: 'Фасад А · РД' });
      const scopeId = await scopeSelect.inputValue();

      await page.getByRole('link', { name: 'Участники' }).click();
      const userId = page.getByLabel('ID учётной записи');
      await userId.fill(engineer.userId);
      await page.getByRole('button', { name: 'Сохранить участника' }).click();
      await expect(page.getByRole('cell', { name: engineer.login, exact: true })).toBeVisible();
      await userId.fill(viewer.userId);
      await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('viewer');
      await page.getByRole('button', { name: 'Сохранить участника' }).click();
      await expect(page.getByRole('cell', { name: viewer.login, exact: true })).toBeVisible();

      let engineering = await engineerContext.newPage();
      await signIn(engineering, engineer.login, engineer.password, projectPath + '/receipts?scope=' + scopeId);
      await expect(engineering.getByRole('heading', { name: 'Поступления', exact: true })).toBeVisible();
      await expect(engineering.getByRole('link', { name: 'Участники' })).toHaveCount(0);
      await engineering.getByRole('link', { name: 'Письма' }).click();
      await expect(engineering.getByText('Оснований для письма пока нет.', { exact: false })).toBeVisible();
      await expect(engineering.getByRole('link', { name: 'Проверить комплектность' })).toBeVisible();
      expect((await command(engineerContext, origin, '/api/v1/projects/' + projectId + '/letters', 'POST', {
        scopeId, recipient: 'Синтетический адресат', items: [],
      })).status()).toBe(422);
      await expect(engineering.getByRole('link', { name: /^Письмо №/ })).toHaveCount(0);
      await engineering.goto(projectPath + '/receipts?upload=1&scope=' + scopeId);
      const later = { ...pdf(), name: 'второй-лист.pdf' };
      await engineering.getByLabel('Файлы или архивы', { exact: true }).setInputFiles([pdf(), later]);
      await engineering.route('**/api/uploads/*/complete', async (route) => {
        const real = await route.fetch({ maxRetries: 0, timeout: 45_000 });
        expect(real.ok()).toBe(true);
        await route.abort('connectionreset');
      }, { times: 1 });
      await engineering.getByRole('button', { name: 'Начать передачу' }).click();
      await expect(engineering.getByText('Осталось входов: 1')).toBeVisible();
      const receiptPage = new URL(engineering.url()).pathname;
      const receiptId = receiptPage.split('/').at(-1)!;
      const list = await engineerContext.request.get('/api/projects/' + projectId + '/receipts?state=uploading');
      expect(list.ok()).toBe(true);
      expect((await list.json()).receipts.map((receipt: { receiptId: string }) => receipt.receiptId)).toEqual([receiptId]);

      await engineering.close();
      engineering = await engineerContext.newPage();
      await engineering.goto(receiptPage + '?scope=' + scopeId);
      await engineering.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
      await engineering.getByLabel('Файлы или архивы', { exact: true }).setInputFiles(later);
      await engineering.route('**/api/uploads/*/complete', async (route) => {
        const real = await route.fetch({ maxRetries: 0, timeout: 45_000 });
        expect(real.ok()).toBe(true);
        await route.abort('connectionreset');
      }, { times: 1 });
      await engineering.getByRole('form', { name: 'Передача исходных данных' })
        .getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
      await expect(engineering.getByText('Опись зафиксирована', { exact: true })).toBeVisible();
      await expect(engineering.getByRole('link', { name: 'Карточка документа' })).toHaveCount(2);
      await engineering.getByRole('link', { name: 'Карточка документа' }).first().click();
      await expect(engineering).toHaveURL(/document=[0-9a-f-]+&row=[0-9a-f-]+/);
      await engineering.reload();
      await expect(engineering.getByRole('heading', { name: pdf().name })).toBeVisible();
      const cardUrl = new URL(engineering.url());
      const original = (await engineering.getByRole('link', { name: 'Скачать оригинал' }).getAttribute('href'))!;
      const range = await engineerContext.request.get(original, { headers: { Range: 'bytes=0-7' } });
      expect(range.status()).toBe(206);
      expect(range.headers()['cache-control']).toBe('no-store');
      expect((await range.body()).toString()).toBe('%PDF-1.4');
      await engineering.getByRole('link', { name: 'К описи' }).first().click();
      await expect(engineering.locator('#occurrence-' + cardUrl.searchParams.get('row'))).toBeFocused();
      await expect(engineering.getByRole('heading', { name: 'Опись', exact: true })).toBeVisible();
      await engineering.getByRole('button', { name: 'Уточнить область' }).first().click();
      await engineering.getByRole('checkbox', { name: 'РД · Фасад А' }).check();
      await engineering.getByRole('button', { name: 'Сохранить применимость' }).click();
      await expect(engineering.getByText('Применимость поступления уточнена.')).toBeVisible();
      await engineering.getByRole('button', { name: 'Проверить влияние' }).click();
      await engineering.getByLabel('Подтверждаю отсутствие влияния').check();
      await engineering.getByLabel('Основание проверки').fill('Контрольный документ не меняет требований пустого каталога');
      await engineering.getByRole('button', { name: 'Сохранить проверку влияния' }).click();
      await expect(engineering.getByText('Проверка влияния сохранена.', { exact: false })).toBeVisible();


      const viewing = await viewerContext.newPage();
      await signIn(viewing, viewer.login, viewer.password, projectPath + '/receipts/' + receiptId);
      await expect(viewing.getByRole('link', { name: 'Карточка документа' })).toHaveCount(2);
      expect((await viewerContext.request.get(original, { headers: { Range: 'bytes=0-7' } })).status()).toBe(206);
      await expect(viewing.getByRole('button', { name: 'Загрузить комплект' })).toHaveCount(0);
      expect((await command(viewerContext, origin, '/api/projects/' + projectId + '/receipts', 'POST', {})).status()).toBe(403);

      const operating = await operatorContext.newPage();
      await signIn(operating, operator.login, operator.password, '/operator');
      await operating.getByLabel('Служебный ID проекта').fill(projectId);
      await operating.getByRole('button', { name: 'Открыть диагностику' }).click();
      await expect(operating.getByRole('heading', { name: 'Очередь', exact: true })).toBeVisible();
      await expect(operating.getByText(pdf().name)).toHaveCount(0);
      expect([403, 404]).toContain((await operatorContext.request.get(original)).status());

      const foreign = await outsiderContext.newPage();
      await signIn(foreign, outsider.login, outsider.password, projectPath + '/receipts/' + receiptId);
      await expect(foreign.getByRole('heading', { name: 'Ресурс недоступен' })).toBeVisible();
      expect([403, 404]).toContain((await outsiderContext.request.get(original)).status());

      await page.getByRole('button', { name: 'Отозвать доступ ' + viewer.login }).click();
      await expect(page.getByText('Доступ отозван.')).toBeVisible();
      const blockedView = viewing.getByRole('heading', { name: 'Ресурс недоступен' });
      const loginView = viewing.getByRole('heading', { name: 'Вход', exact: true });
      await expect(blockedView.or(loginView)).toBeVisible({ timeout: 20_000 });
      await expect(viewing.getByRole('link', { name: 'Карточка документа' })).toHaveCount(0);
      expect([401, 403, 404]).toContain((await viewerContext.request.get(original, { headers: { Range: 'bytes=0-7' } })).status());
      if (await loginView.isVisible()) {
        await signIn(viewing, viewer.login, viewer.password, projectPath + '/receipts/' + receiptId);
        await expect(blockedView).toBeVisible();
        expect([403, 404]).toContain((await viewerContext.request.get(original)).status());
      }
      expect(ownerErrors).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test('Пополняемый приём и карточка работают в проекте без области', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await signIn(page, admin.login!, admin.password!);
    const project = await accepted<{ id: string; scopes: { id: string }[] }>(
      await command(page.context(), origin, '/api/projects', 'POST', { name: unique('Приём без области'), mode: 'intake' }),
      'Проект',
    );
    expect(project.scopes).toEqual([]);
    const path = '/projects/' + project.id + '/receipts';
    await page.goto(path + '?upload=1');
    await page.getByLabel('Оставить приём открытым').check();
    await page.getByLabel('Файлы или архивы', { exact: true }).setInputFiles(pdf());
    let lostCreateResponse = false;
    await page.route('**/api/projects/' + project.id + '/receipts', async (route) => {
      if (route.request().method() !== 'POST' || lostCreateResponse) return await route.continue();
      const response = await route.fetch({ maxRetries: 0, timeout: 45_000 });
      expect(response.status()).toBe(201);
      lostCreateResponse = true;
      await route.abort('connectionreset');
    });
    await page.getByRole('button', { name: 'Начать передачу' }).click();
    await expect(page.getByText('Приём оставлен открытым', { exact: false })).toBeVisible();
    expect(lostCreateResponse).toBe(true);
    await expect(page.getByRole('link', { name: 'Карточка документа' })).toHaveCount(1);
    await page.getByRole('link', { name: 'Карточка документа' }).click();
    await expect(page.getByRole('heading', { name: pdf().name })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('scope')).toBe(false);
    const badLink = new URL(page.url());
    badLink.searchParams.set('row', '11111111-1111-4111-8111-111111111111');
    await page.goto(badLink.href);
    await expect(page.getByText('Документ недоступен.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Скачать оригинал' })).toHaveCount(0);
    await page.getByRole('link', { name: 'К описи' }).click();

    await page.getByRole('button', { name: 'Добавить ещё' }).click();
    await page.getByLabel('Файлы или архивы', { exact: true }).setInputFiles({
      name: 'комплект.zip', mimeType: 'application/zip',
      buffer: Buffer.from('504b0506' + '00'.repeat(18), 'hex'),
    });
    await page.getByRole('button', { name: 'Начать передачу' }).click();
    await expect(page.getByRole('link', { name: 'Карточка документа' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Завершить приём', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Приём завершён.' })).toBeVisible();
    await expect(page.getByText('Опись открыта', { exact: true })).toBeVisible();
    await expect(page.getByText('Принят · раскрывается', { exact: true })).toBeVisible();
  });
});
