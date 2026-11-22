import { expect, test } from '@playwright/test';
import { account, admin, command, pdf, signIn, unique } from './synthetic';

test.describe('Рабочее место на штатном API', () => {
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
    await page.getByRole('button', { name: 'Опубликовать каталог' }).click();
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

      await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Проекты' }).click();
      await page.getByRole('button', { name: 'Создать проект' }).click();
      const project = unique('Фасад-web');
      await page.getByLabel('Название проекта').fill(project);
      await page.getByLabel('Версия каталога').selectOption({ label: catalogName + ' · 1' });
      await page.getByRole('button', { name: 'Сохранить проект' }).click();
      await expect(page.getByRole('heading', { name: project })).toBeVisible();
      const projectPath = new URL(page.url()).pathname.replace(/\/overview$/, '');
      const projectId = projectPath.split('/').at(-1)!;

      await page.getByRole('button', { name: 'Добавить область' }).click();
      await page.getByLabel('Название области').fill('Фасад А');
      await page.getByLabel('Стадия', { exact: true }).fill('РД');
      await page.getByRole('button', { name: 'Сохранить область' }).click();
      await expect(page.getByLabel('Стадия и область')).toContainText('Фасад А');
      const scopeId = await page.getByLabel('Стадия и область').inputValue();

      await page.getByRole('link', { name: 'Участники' }).click();
      const userId = page.getByLabel('ID учётной записи');
      await userId.fill(engineer.userId);
      await page.getByRole('button', { name: 'Сохранить участника' }).click();
      await expect(page.getByRole('cell', { name: engineer.login, exact: true })).toBeVisible();
      await userId.fill(viewer.userId);
      await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('viewer');
      await page.getByRole('button', { name: 'Сохранить участника' }).click();
      await expect(page.getByRole('cell', { name: viewer.login, exact: true })).toBeVisible();

      const engineering = await engineerContext.newPage();
      await signIn(engineering, engineer.login, engineer.password, projectPath + '/receipts');
      await expect(engineering.getByRole('heading', { name: 'Поступления', exact: true })).toBeVisible();
      await expect(engineering.getByRole('link', { name: 'Участники' })).toHaveCount(0);
      await engineering.getByRole('link', { name: 'Письма' }).click();
      await expect(engineering.getByText('Внешних оснований пока нет.', { exact: false })).toBeVisible();
      expect((await command(engineerContext, origin, '/api/v1/projects/' + projectId + '/letters', 'POST', {
        scopeId, recipient: 'Синтетический адресат', items: [],
      })).status()).toBe(422);
      await expect(engineering.getByRole('link', { name: /^Письмо №/ })).toHaveCount(0);
      await engineering.getByRole('link', { name: 'Поступления' }).click();
      await engineering.getByRole('button', { name: 'Добавить поступление' }).click();
      await engineering.getByLabel('Файлы или архивы').setInputFiles(pdf());
      await engineering.route('**/api/uploads/*/parts/1', async (route) => {
        const real = await route.fetch({ maxRetries: 0 });
        expect(real.ok()).toBe(true);
        await route.abort('connectionreset');
      }, { times: 1 });
      await engineering.getByRole('button', { name: 'Начать передачу' }).click();
      await expect(engineering.getByText('Не удалось связаться с сервером.', { exact: false })).toBeVisible();
      const list = await engineerContext.request.get('/api/projects/' + projectId + '/receipts?state=uploading');
      expect(list.ok()).toBe(true);
      const { receipts } = await list.json();
      expect(receipts).toHaveLength(1);

      const receiptId = receipts[0].receiptId as string;
      await engineering.goto(projectPath + '/receipts/' + receiptId + '?scope=' + scopeId);
      await engineering.getByRole('button', { name: 'Докачать файл' }).click();
      await engineering.getByLabel('Исходный файл').setInputFiles(pdf());
      await engineering.route('**/api/uploads/*/complete', async (route) => {
        const real = await route.fetch({ maxRetries: 0 });
        expect(real.ok()).toBe(true);
        await route.abort('connectionreset');
      }, { times: 1 });
      await engineering.getByRole('button', { name: 'Продолжить передачу' }).click();
      await expect(engineering.getByText('Не удалось связаться с сервером.', { exact: false })).toBeVisible();
      await expect(engineering.getByRole('button', { name: 'Карточка документа' })).toHaveCount(1);
      await engineering.getByRole('button', { name: 'Карточка документа' }).click();
      await expect(engineering.getByRole('heading', { name: pdf().name })).toBeVisible();
      await expect(engineering.getByText('Опись открыта')).toBeVisible();
      const original = (await engineering.getByRole('link', { name: 'Скачать оригинал' }).getAttribute('href'))!;
      const range = await engineerContext.request.get(original, { headers: { Range: 'bytes=0-7' } });
      expect(range.status()).toBe(206);
      expect(range.headers()['cache-control']).toBe('no-store');
      expect((await range.body()).toString()).toBe('%PDF-1.4');
      await engineering.getByRole('button', { name: 'Завершить объявление входов' }).click();
      await expect(engineering.getByText('Опись зафиксирована', { exact: true })).toBeVisible();
      await engineering.getByRole('button', { name: 'Уточнить область' }).click();
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
      await expect(viewing.getByRole('button', { name: 'Карточка документа' })).toBeVisible();
      expect((await viewerContext.request.get(original, { headers: { Range: 'bytes=0-7' } })).status()).toBe(206);
      await expect(viewing.getByRole('button', { name: 'Добавить поступление' })).toHaveCount(0);
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
      await expect(viewing.getByRole('button', { name: 'Карточка документа' })).toHaveCount(0);
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
});
