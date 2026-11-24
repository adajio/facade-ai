import { expect, test } from '@playwright/test';

test('Публикация каталога передаёт названия и группы доказательств', async ({ page }) => {
  const published: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me') return route.fulfill({
      json: { user: { id: 'synthetic', login: 'admin' }, projects: [], csrfToken: 'synthetic', actions: ['organization:admin'] },
    });
    if (path === '/api/users') return route.fulfill({ json: { users: [] } });
    if (path === '/api/catalogs' && request.method() === 'POST') {
      published.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { id: 'synthetic' } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });

  await page.goto('/admin');
  await page.getByLabel('Код каталога').fill('synthetic-evidence');
  await page.getByLabel('Название', { exact: true }).fill('Синтетический каталог');
  await page.getByRole('button', { name: 'Добавить обязательную часть' }).click();
  await page.getByLabel('Код части').fill('part1');
  await page.getByLabel('Наименование').fill('Чертёж фасада');
  await page.getByLabel('Другие названия требования через запятую').fill('Монтажная схема, Схема фасада');
  await page.getByLabel('Форматы', { exact: true }).fill('PDF');
  await page.getByLabel('Эквиваленты').fill('DWG');
  await page.getByLabel('Роли источников').fill('drawing, detail, calculation');
  await page.getByLabel('Критерий полноты').fill('Сверить чертёж, узел и расчёт');
  await page.getByLabel('Адресат').fill('Проектировщик');

  await page.getByRole('button', { name: 'Опубликовать каталог' }).click();
  await expect(page.getByText('Версия каталога опубликована.')).toBeVisible();
  expect(published[0]).toMatchObject({ requirements: [{ part: 'Чертёж фасада', aliases: ['Монтажная схема', 'Схема фасада'] }] });
  expect((published[0] as { requirements: object[] }).requirements[0]).not.toHaveProperty('evidenceRule');

  await page.getByRole('button', { name: 'Задать правило доказательств' }).click();
  const first = page.getByRole('group', { name: 'Группа 1', exact: true });
  await first.getByLabel('Роль источника').selectOption('drawing');
  await first.getByLabel('Форматы варианта через запятую').fill('PDF');
  await first.getByLabel('Предмет в источнике').fill('Чертёж фасада');
  await first.getByLabel('Текст оригинала').check();
  await first.getByRole('button', { name: 'Добавить вариант' }).click();
  const alternative = first.getByRole('group', { name: 'Вариант 2', exact: true });
  await alternative.getByLabel('Роль источника').selectOption('detail');
  await alternative.getByLabel('Форматы варианта через запятую').fill('DWG');
  await page.getByRole('button', { name: 'Добавить группу' }).click();
  const second = page.getByRole('group', { name: 'Группа 2', exact: true });
  await second.getByLabel('Роль источника').selectOption('calculation');
  await second.getByLabel('Что проверять').selectOption('presence');
  await page.getByLabel('Каждая группа требует отдельного оригинала').check();
  await page.getByRole('button', { name: 'Опубликовать каталог' }).click();
  await expect.poll(() => published.length).toBe(2);
  expect(published[1]).toMatchObject({ requirements: [{
    aliases: ['Монтажная схема', 'Схема фасада'], completenessCriterion: 'Сверить чертёж, узел и расчёт',
    evidenceRule: { distinctOriginals: true, allOf: [
      { anyOf: [
        { sourceRole: 'drawing', formats: ['PDF'], subject: 'Чертёж фасада', representations: ['native'] },
        { sourceRole: 'detail', formats: ['DWG'] },
      ] },
      { anyOf: [{ sourceRole: 'calculation', mode: 'presence' }] },
    ] },
  }] });
});
