import { expect, test } from '@playwright/test';
import { accepted, admin, pdf, signIn, unique } from './synthetic';

test.describe('Рабочее место на штатном API', () => {
  test.skip(!admin.login || !admin.password, 'Задайте FACADE_E2E_ADMIN_LOGIN и FACADE_E2E_ADMIN_PASSWORD для отдельной синтетической БД');

  test('Первичный проект по названию и подтверждение стадии', async ({ page }) => {
    await signIn(page, admin.login!, admin.password!);
    await page.getByRole('button', { name: 'Создать проект' }).click();
    const name = unique('Первичный приём');
    const form = page.getByRole('heading', { name: 'Новый проект' }).locator('..');
    await form.getByLabel('Название проекта').fill(name);
    await expect(form.getByLabel('Версия каталога')).toHaveCount(0);
    await form.getByRole('button', { name: 'Сохранить проект' }).click();
    await expect(page.getByRole('navigation', { name: 'Путь к проекту' }).getByText(name)).toBeVisible();
    const path = new URL(page.url()).pathname.replace(/\/overview$/, '');
    const project = await accepted(await page.request.get('/api' + path), 'Первичный проект');
    expect(project).toMatchObject({ stage: null, catalog: null, catalogVersionId: null, scopes: [], role: 'project_manager' });
    await page.getByRole('link', { name: 'Участники' }).click();
    await expect(page.getByText('Нет рабочего каталога.', { exact: true })).toBeVisible();
    await expect(page.getByText('Стадия уточняется.')).toBeVisible();
    await expect(page.getByLabel('Код стадии')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подтвердить стадию проекта' })).toBeDisabled();
    await page.getByRole('link', { name: 'Поступления' }).click();
    await page.getByRole('button', { name: 'Загрузить комплект' }).click();
    const original = { ...pdf('Design stage RD'), name: 'Синтетический титул.pdf' };
    await page.getByLabel('Файлы или архивы').setInputFiles(original);
    await page.getByRole('button', { name: 'Начать передачу' }).click();
    await page.getByRole('row').filter({ hasText: original.name }).getByRole('link', { name: 'Карточка документа' }).click();
    const href = (await page.getByRole('link', { name: 'Скачать оригинал' }).getAttribute('href'))!;
    await expect.poll(async () => (await page.request.get('/api/v1' + href.slice(4).replace(/\/content$/, '/reader/units'))).status(),
      { timeout: 45_000 }).toBe(200);
    await page.getByRole('link', { name: 'Участники' }).click();
    await page.getByLabel('Код стадии').fill('РД');
    await page.getByLabel('Документ-основание').selectOption({ label: original.name });
    await page.getByLabel('Физическая страница PDF').fill('1');
    await page.getByLabel('Комментарий инженера').fill('Решение по синтетическому оригиналу');
    await page.getByRole('button', { name: 'Подтвердить стадию проекта' }).click();
    await expect(page.getByText('Стадия проекта сохранена.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Подтверждённая стадия: РД')).toBeVisible();
    await expect(page.getByText('Установлено инженером')).toBeVisible();
    await expect(page.getByText('Ожидается подтверждение типов фасадов.')).toBeVisible();

    await page.goto('/admin');
    await page.getByLabel('Код каталога').fill(unique('profile'));
    await page.getByLabel('Название', { exact: true }).fill('Синтетический рабочий профиль');
    await page.getByLabel('Опубликовать утверждённый рабочий профиль').check();
    await expect(page.getByRole('button', { name: 'Опубликовать каталог' })).toBeDisabled();
    await page.getByLabel('Код стадии').fill('РД');
    await page.getByLabel('Коды подтверждённых типов фасадов через запятую').fill('synthetic-kind');
    await page.getByLabel('Ссылка или номер решения об утверждении').fill('Синтетический протокол');
    await page.getByRole('button', { name: 'Добавить обязательную часть' }).click();
    await page.getByLabel('Код части').fill('P-1');
    await page.getByLabel('Наименование').fill('Учебный чертёж');
    await page.getByLabel('Другие названия требования через запятую').fill('Монтажная схема, Схема фасада');
    await page.getByLabel('Уровень требования').selectOption('facade');
    await page.getByLabel('Форматы').fill('PDF');
    await page.getByLabel('Роли источников').fill('drawing');
    await page.getByLabel('Критерий полноты').fill('Указан материал');
    await page.getByRole('button', { name: 'Задать правило доказательств' }).click();
    await page.getByRole('combobox', { name: 'Роль источника', exact: true }).selectOption('drawing');
    await page.getByLabel('Адресат').fill('Проектировщик');
    const [response] = await Promise.all([
      page.waitForResponse((result) => new URL(result.url()).pathname === '/api/catalogs' && result.request().method() === 'POST'),
      page.getByRole('button', { name: 'Опубликовать каталог' }).click(),
    ]);
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      defaultProfile: { stage: 'РД', facadeKinds: ['synthetic-kind'] },
      requirements: [{ level: 'facade', aliases: ['Монтажная схема', 'Схема фасада'],
        evidenceRule: { allOf: [{ anyOf: [{ sourceRole: 'drawing' }] }] } }],
    });
  });
});
