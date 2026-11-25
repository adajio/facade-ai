import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accepted, command, pdf, signIn, unique } from './synthetic';

test('Д7 по принятому оригиналу без машинного предложения', async ({ page, baseURL }, info) => {
  test.setTimeout(150_000);
  const build = process.env.FACADE_E2E_BUILD_DIR;
  test.skip(!build || !process.env.DATABASE_URL || !process.env.FACADE_E2E_STAGE_ONE, 'Нужен изолированный синтетический стенд');
  const compiled = (name: string) => import(pathToFileURL(resolve(build!, 'src', name + '.js')).href);
  const [{ openPool }, { transaction }, { passwordHash }] = await Promise.all([
    compiled('platform/db'), compiled('modules/access/commands'), compiled('modules/access/auth'),
  ]);
  const db = openPool(process.env.DATABASE_URL);
  const login = unique('d7-browser');
  const password = randomUUID();
  try {
    const hash = await passwordHash(password);
    await transaction(db, async (tx: import('pg').PoolClient) => {
      const { rows: [org] } = await tx.query('INSERT INTO organizations(name) VALUES($1) RETURNING id', [login]);
      await tx.query("INSERT INTO users(organization_id,login,password_hash,state,org_admin,can_create_project) VALUES($1,$2,$3,'active',true,true)",
        [org.id, login, hash]);
    });
  } finally { await db.end(); }

  await signIn(page, login, password);
  const origin = new URL(baseURL!).origin;
  const issue = (path: string, method: string, body: unknown, version?: number) => command(page.context(), origin, path, method, body, version);
  const requirement = { key: 'panel', part: 'Кассеты', level: 'facade', applicability: 'all', formats: ['pdf'],
    equivalents: [], sourceRoles: ['drawing'], completenessCriterion: 'Указать адрес', addressee: 'Заказчик', facadeKinds: ['panel'] };
  for (const [key, stage, facadeKinds] of [['d7-intake', 'Стадия 1', []], ['d7-panel', 'РД', ['panel']]]) {
    await accepted(await issue('/api/catalogs', 'POST', { key, name: key, requirements: [requirement],
      defaultProfile: { stage, facadeKinds, approvalReference: 'Синтетическое правило' } }), 'Каталог');
  }
  const project = await accepted<{ id: string }>(await issue('/api/projects', 'POST', { mode: 'intake', name: 'Ручная проверка D7' }), 'Проект');
  const projectApi = `/api/v1/projects/${project.id}`;
  const assessmentPath = `${projectApi}/facade-assessment`;
  await page.goto(`/projects/${project.id}/overview`);
  await page.getByRole('link', { name: 'Поступления', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить комплект' }).click();
  const original = { ...pdf(['F-D7', 'Facade type: panel']), name: 'Учебный фасад D7.pdf' };
  await page.getByLabel('Файлы или архивы').setInputFiles(original);
  await page.getByRole('button', { name: 'Начать передачу' }).click();
  const documentCard = page.getByRole('row').filter({ hasText: original.name }).getByRole('link', { name: 'Карточка документа' });
  const confirmFile = page.getByRole('button', { name: 'Подтвердить сохранённый файл', disabled: false });
  await expect(page.getByRole('status').filter({ hasText: /Передача завершена/ })).toBeVisible({ timeout: 45_000 });
  if (!await documentCard.isVisible() && await confirmFile.isVisible()) await confirmFile.click();
  await documentCard.click({ timeout: 45_000 });
  await page.getByText('Принадлежность документа или отдельного места фасаду', { exact: true }).click({ timeout: 45_000 });
  await page.getByLabel('Объект привязки').selectOption('place');
  await page.getByLabel('Страница с обозначением фасада').fill('1');
  await page.getByLabel('Обозначение нового фасада').fill('F-D7');
  await page.getByLabel('Обоснование принадлежности').fill('Обозначение F-D7 указано на странице 1');
  const [linked] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/facade-links') && response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Сохранить принадлежность' }).click(),
  ]);
  expect(linked.ok()).toBeTruthy();
  expect(await linked.json()).toMatchObject({ links: [{ facadeLabel: 'F-D7', target: 'place', basis: { address: { locator: { page: 1 } } } }] });
  await page.reload();
  await page.getByText('Принадлежность документа или отдельного места фасаду', { exact: true }).click();
  await expect(page.getByText('Обозначение F-D7 указано на странице 1')).toBeVisible();
  await page.getByRole('link', { name: 'Открыть область проверки' }).click();
  const card = page.getByRole('region', { name: 'Принадлежность и тип фасада' });
  await expect(card.getByRole('heading', { name: 'Тип фасада' })).toBeVisible();
  const before = await accepted<{ version: number; observations: { proposalCounts: { facadeKind: number } } }>(
    await page.request.get(assessmentPath), 'Оценка до подтверждения');
  expect(before.observations.proposalCounts.facadeKind).toBe(0);
  const state = await accepted<{ version: number }>(await page.request.get(`/api/projects/${project.id}`), 'Версия проекта');

  // FE-03 starts with the facade card open. The accepted original is prefilled
  // from its manual association. One click selects the address field.
  await card.getByRole('button', { name: 'Подтвердить тип фасада' }).click();
  await expect(card.getByLabel('Документ-основание').locator('option:checked')).toHaveText(original.name);
  const anchor = card.getByLabel('Физическая страница PDF');
  await anchor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('1');
  const kind = card.getByRole('combobox', { name: 'Тип фасада', exact: true });
  for (let tab = 0; tab < 3 && !await kind.evaluate((element) => element === document.activeElement); tab++) {
    await page.keyboard.press('Tab');
  }
  await expect(kind).toBeFocused();
  await page.keyboard.press('p');
  await expect(kind).toHaveValue('panel');
  await page.keyboard.press('Tab');
  await expect(card.getByLabel('Комментарий инженера')).toBeFocused();
  await page.keyboard.insertText('На странице 1 указан panel');
  const [saved] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/kind') && response.request().method() === 'PUT'),
    card.getByRole('button', { name: 'Сохранить тип фасада' }).click(),
  ]);
  expect(saved.ok()).toBeTruthy();
  expect(saved.request().headers()['if-match']).toBe(`"${state.version}"`);
  const { documentVersionId } = saved.request().postDataJSON();
  expect(saved.request().postDataJSON()).toMatchObject({ kind: 'panel', pageOrAnchor: '1', provenanceKind: 'engineer_override' });
  await expect(card.getByRole('status').filter({ hasText: 'Тип фасада сохранён.' })).toBeVisible();
  info.annotations.push({ type: 'FE-03', description: '3 клика после открытия карточки: начать подтверждение, выбрать поле адреса, сохранить. Адрес введён с клавиатуры, переходы Tab, тип выбран нажатием p, основание с клавиатуры.' });

  const after = await accepted<{ version: number }>(await page.request.get(`/api/projects/${project.id}`), 'Сохранённый проект');
  const invalid = await issue(new URL(saved.url()).pathname, 'PUT', { kind: 'panel', documentVersionId,
    pageOrAnchor: '2', provenanceKind: 'engineer_override', reason: 'На таком адресе лист отсутствует' }, after.version);
  expect(invalid.status()).toBe(422);
  expect(await invalid.json()).toMatchObject({ code: 'original_address_unavailable' });
  await page.reload();
  await expect(card.getByText('panel · Подтверждён')).toBeVisible();
  await expect(card.getByText(new RegExp(`Решение №1\\s*·\\s*${login}`))).toBeVisible();
  await expect(card.getByRole('link', { name: 'Открыть оригинал', exact: true })).toHaveAttribute('href', new RegExp(documentVersionId + '/content#page=1$'));
  const current = await accepted<{ stage: string; outcome: string; observations: { proposalCounts: { facadeKind: number } } }>(
    await page.request.get(assessmentPath), 'Оценка после подтверждения');
  expect(current).toMatchObject({ stage: 'Стадия 1', outcome: 'needs_review', observations: { proposalCounts: { facadeKind: 0 } } });

  await page.getByText(/^Заключение · F-D7/).click();
  await page.getByLabel('Можно ли начать работы').selectOption('can_start_with_limitations');
  await page.getByLabel('Основание решения', { exact: true }).fill('Можно начать подготовку в пределах проверенного листа.');
  const saveConclusion = page.getByRole('button', { name: 'Сохранить заключение' });
  await expect(saveConclusion).toBeDisabled();
  await page.getByLabel('Документ-основание').selectOption(documentVersionId);
  await page.getByLabel('Физическая страница PDF').fill('1');
  await saveConclusion.click();
  await expect(page.getByText('Версия оценки для заключения')).toBeVisible();

  await page.getByRole('link', { name: 'Кассеты', exact: true }).click();
  const operation = page.getByRole('combobox', { name: 'Действие по требованию' });
  const decisionForm = page.locator('form').filter({ has: operation });
  await operation.selectOption('exclude');
  await page.getByRole('combobox', { name: 'Исключение' }).selectOption('work_without_data');
  await page.getByLabel('Действует до (местное время)').fill('2099-11-25T18:00');
  await page.getByLabel('Для начала работ').check();
  await decisionForm.getByLabel('Основание решения', { exact: true }).fill('Временное исключение для данного фасада.');
  await page.getByRole('button', { name: 'Сохранить решение по требованию' }).click();
  await expect(page.getByText(/^Работаем без этих данных · до /)).toBeVisible();
  await expect(page.getByText(/^Машинный вывод · Требует проверки/)).toBeVisible();
  await operation.selectOption('revoke');
  await decisionForm.getByLabel('Основание решения', { exact: true }).fill('Фасад возвращён на проверку.');
  await page.getByRole('button', { name: 'Сохранить решение по требованию' }).click();
  await expect(page.getByText(/^Решение отменено/)).toContainText('Фасад возвращён на проверку');
  const previousConclusion = page.getByRole('link', { name: /^Предыдущее заключение/ });
  if (!await previousConclusion.isVisible()) await page.getByText(/^Заключение · F-D7/).click();
  await expect(page.getByText('Инженерское решение по одному из требований изменилось.')).toBeVisible();
  await previousConclusion.click();
  await expect(page.getByText(/Можно начать подготовку в пределах проверенного листа/)).toBeVisible();
  await expect(saveConclusion).toHaveCount(0);
});
