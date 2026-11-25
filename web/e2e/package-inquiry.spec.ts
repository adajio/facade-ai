import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accepted, command, pdf, signIn, unique } from './synthetic';

test('Адресный вопрос в пакетном проекте без установленного фасада остаётся внутренним', async ({ page, baseURL }) => {
  const build = process.env.FACADE_E2E_BUILD_DIR;
  test.skip(!build || !process.env.DATABASE_URL || !process.env.FACADE_E2E_STAGE_ONE, 'Нужна отдельная синтетическая БД с подготовленной сборкой');
  const compiled = (name: string) => import(pathToFileURL(resolve(build!, 'src', name + '.js')).href);
  const [{ openPool }, { transaction }, { passwordHash }] = await Promise.all([
    compiled('platform/db'), compiled('modules/access/commands'), compiled('modules/access/auth'),
  ]);
  const db = openPool(process.env.DATABASE_URL);
  const login = unique('package-inquiry');
  const password = randomUUID();
  try {
    const hash = await passwordHash(password);
    await transaction(db, async (tx: import('pg').PoolClient) => {
      const { rows: [org] } = await tx.query('INSERT INTO organizations(name) VALUES ($1) RETURNING id', [login]);
      await tx.query("INSERT INTO users(organization_id,login,password_hash,state,org_admin,can_create_project) VALUES($1,$2,$3,'active',true,true)", [org.id, login, hash]);
    });
  } finally { await db.end(); }
  const origin = new URL(baseURL!).origin;
  await signIn(page, login, password);
  const project = await accepted<{ id: string }>(await command(page.context(), origin, '/api/projects', 'POST',
    { mode: 'intake', name: unique('Адресный вопрос по комплекту') }), 'Создание проекта');
  await page.goto('/projects/' + project.id + '/overview');
  await page.getByRole('link', { name: 'Поступления', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить комплект' }).click();
  const original = pdf('Panel B damage inspect flashing');
  await page.getByLabel('Файлы или архивы').setInputFiles(original);
  await page.getByRole('button', { name: 'Начать передачу' }).click();
  const originalRow = page.getByRole('row').filter({ hasText: original.name });
  await originalRow.getByRole('link', { name: 'Карточка документа' }).click();
  await expect(page.locator('.unit-list button').first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole('link', { name: 'Комплектность', exact: true }).click();
  await page.getByRole('link', { name: 'Внутренние вопросы', exact: true }).click();
  const registry = page.getByRole('region', { name: 'Адресные исследовательские вопросы' });
  await expect(registry.getByRole('heading', { name: 'Адресные исследовательские вопросы · Весь комплект' })).toBeVisible();
  await registry.getByText('Задать адресный вопрос', { exact: true }).click();
  const subject = registry.getByLabel('Предмет', { exact: true });
  await subject.fill('Panel B');
  await page.locator('.sync-menu > summary').click();
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/facade-assessment') && response.ok());
  await page.getByRole('button', { name: 'Обновить сейчас' }).click();
  await refreshed;
  await page.locator('.sync-menu > summary').click();
  await expect(subject).toBeVisible();
  await expect(subject).toHaveValue('Panel B');
  await registry.getByLabel('Свойство или что найти').fill('damage');
  await registry.getByLabel('Документ-основание').selectOption({ label: original.name });
  await registry.getByLabel('Физическая страница PDF').fill('1');
  const posted = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/inquiries'));
  await registry.getByRole('button', { name: 'Поставить вопрос' }).click();
  const response = await posted;
  expect(response.status()).toBe(201);
  await expect(page).toHaveURL(/inquiry=[a-f0-9-]{36}/u);
  await expect(registry.getByRole('heading', { name: 'Panel B · damage' })).toBeFocused();
  await expect(registry.getByText('Внутренний вопрос · в письмо не включается.')).toBeVisible();
  await expect(registry.getByRole('link', { name: /стр\. 1/ })).toHaveAttribute('href', /\/content#page=1$/);
  await page.reload();
  await expect(registry.getByRole('heading', { name: 'Panel B · damage' })).toBeVisible();
  await page.getByRole('link', { name: 'Письма', exact: true }).click();
  await expect(page.getByText(/Оснований для письма пока нет/)).toBeVisible();
  await page.goBack();
  await expect(registry.getByRole('heading', { name: 'Panel B · damage' })).toBeVisible();
});
