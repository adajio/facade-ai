import { expect as assertBrowser, test, type Locator } from '@playwright/test';
import { accepted, command, signIn } from './synthetic';

const expect = assertBrowser.configure({ timeout: 30_000 });

type Fact = {
  id: string; address: object; attribute: string; branch: 'A' | 'B'; documentId: string;
  quote: string; value: string; unit: string; variant: string | null; sourceRole: string;
  engineeringReview?: { decision: { action: string }; state: string };
};
type Question = { id: string; version: number; requirement: { positionId: string };
  machine: { outcome: string; citations: { observationId: string }[] } };
type Summary = { version: number; observations: { href: string };
  contexts: { name: string; assessmentContextId: string; facadeId: string; questions: Question[] }[] };

test('Сведения сохраняют пять инженерных действий, буквальные опоры и независимый допуск письма', async ({ page, baseURL, browser }) => {
  test.skip(!process.env.FACADE_E2E_FACT_REVIEW_FIXTURE, 'Нужна БД после фасадной серии с FACADE_FACT_REVIEW_BROWSER_SEED=1');
  test.setTimeout(240_000);
  page.setDefaultTimeout(40_000);
  await signIn(page, 'package-assessment', 'synthetic-acceptance-only');
  const origin = new URL(baseURL!).origin;
  const json = async <T,>(path: string) => accepted<T>(await page.request.get(path), path);
  const account = await json<{ projects: { id: string; name: string }[] }>('/api/me');
  const facade = account.projects.find(({ name }) => name === 'Synthetic facades')!;
  const omission = account.projects.find(({ name }) => name === 'Synthetic non-delivery')!;
  expect(facade?.id).toBeTruthy();
  expect(omission?.id).toBeTruthy();
  const base = (projectId: string) => '/api/v1/projects/' + projectId;
  const summary = (projectId: string) => json<Summary>(base(projectId) + '/facade-assessment');
  const review = async (projectId: string, factId: string, data: object, version: number) =>
    accepted<{ version: number }>(await command(page.context(), origin, base(projectId) + '/package-facts/' + factId + '/reviews',
      'POST', data, version), 'Инженерское решение');
  const caseFacts = (snapshot: Summary, facadeId?: string) => json<{ items: Fact[] }>(
    snapshot.observations.href + (facadeId ? '?facadeId=' + facadeId : ''));
  const row = (fact: Fact) => page.locator('#finding-' + fact.id);
  const factsUrl = (projectId: string, area: string, fact?: string) =>
    '/projects/' + projectId + '/facts?context=' + area + (fact ? '&fact=' + fact : '');

  async function begin(item: Locator, action: string, reason: string) {
    await item.getByText('Решение по сведению', { exact: true }).click();
    await item.getByRole('combobox', { name: 'Действие', exact: true }).selectOption(action);
    await item.getByLabel('Основание решения', { exact: true }).fill(reason);
  }
  async function save(item: Locator, expected = 200) {
    const returned = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/reviews'));
    await item.getByRole('button', { name: 'Сохранить решение по сведению' }).click();
    expect((await returned).status()).toBe(expected);
  }
  async function reload(fact: Fact, expected: string) {
    await expect(page).toHaveURL(new RegExp('fact=' + fact.id));
    await expect(row(fact)).toContainText(expected);
    await page.reload();
    await expect(row(fact)).toContainText(expected);
    await expect(row(fact)).toBeFocused();
    await expect(row(fact)).toContainText(fact.quote);
  }

  const first = await summary(facade.id);
  const left = first.contexts.find(({ name }) => name === 'F1')!;
  const right = first.contexts.find(({ name }) => name === 'F2')!;
  const { items } = await caseFacts(first, left.facadeId);
  const confirm = items.find(({ attribute, value }) => attribute === 'Width' && value === '100')!;
  const variant = items.find(({ attribute, value, variant }) => attribute === 'Thickness' && value === '20' && variant === 'v1')!;
  const correction = items.find(({ attribute, value }) => attribute === 'Mount spacing' && value === '13')!;
  const concurrent = items.find(({ attribute, value }) => attribute === 'Mount spacing' && value === '11')!;
  const merge = items.find(({ attribute, value, branch }) => attribute === 'Thickness' && value === '15' && branch === 'A')!;
  const peer = items.find((item) => item.id !== merge.id && item.documentId !== merge.documentId &&
    item.attribute === merge.attribute && item.value === merge.value && item.sourceRole === merge.sourceRole)!;
  expect([confirm, variant, correction, concurrent, merge, peer].every(Boolean)).toBeTruthy();
  if (merge.engineeringReview?.decision.action === 'merge' && merge.engineeringReview.state === 'applied') {
    await review(facade.id, merge.id, { action: 'confirm', reason: 'Повтор проверки раскрывает исходные записи' }, first.version);
  }

  await page.goto('/projects/' + facade.id + '/completeness?context=' + left.assessmentContextId);
  await page.getByRole('link', { name: 'Найденные сведения', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('context=' + left.assessmentContextId));
  await begin(row(confirm), 'confirm', 'Подтвердил число по исходной строке');
  await save(row(confirm));
  await reload(confirm, 'Значение подтверждено');

  await page.goto(factsUrl(facade.id, left.assessmentContextId));
  await begin(row(variant), 'select_variant', 'Сверил напечатанный вариант по оригиналу');
  await row(variant).getByRole('combobox', { name: 'Вариант', exact: true }).selectOption('v1');
  await save(row(variant));
  await reload(variant, 'Вариант выбран');

  await page.goto(factsUrl(facade.id, left.assessmentContextId));
  const old = await summary(facade.id);
  const route = '**/facade-assessment';
  let freeze = true;
  await page.route(route, (request) => freeze ? request.fulfill({ json: old }) : request.continue());
  const reason = 'Перепроверил число и единицу по исходной строке';
  await begin(row(correction), 'correct', reason);
  await row(correction).getByLabel('Исправленное число').fill('1,4');
  await row(correction).getByLabel('Единица', { exact: true }).fill('см');
  await review(facade.id, concurrent.id, { action: 'confirm', reason: 'Независимая инженерная запись' }, old.version);
  await save(row(correction), 412);
  freeze = false;
  await page.unroute(route);
  await expect(row(correction).getByLabel('Основание решения', { exact: true })).toHaveValue(reason);
  await expect(row(correction).getByLabel('Исправленное число')).toHaveValue('1,4');
  const rebase = row(correction).getByRole('button', { name: 'Использовать текущую версию' });
  if (!await rebase.isVisible()) {
    await page.locator('.sync-menu > summary').click();
    await page.getByRole('button', { name: 'Обновить сейчас' }).click();
    await page.locator('.sync-menu > summary').click();
  }
  await rebase.click();
  await expect(row(correction).getByLabel('Основание решения', { exact: true })).toHaveValue(reason);
  await save(row(correction));
  await reload(correction, 'Число или единица исправлены');
  await expect(row(correction)).toContainText(/Нормализованное значение · 14\s*мм/u);
  await expect(row(correction)).toContainText(/Буквальное значение · 13\s*mm/u);

  const beforeMerge = await summary(facade.id);
  const previous = items[items.findIndex(({ id }) => id === merge.id) - 1]?.id;
  const limitedPage = await json<{ items: Fact[] }>(beforeMerge.observations.href + '?facadeId=' + left.facadeId +
    '&limit=1' + (previous ? '&after=' + previous : ''));
  expect(limitedPage.items.map(({ id }) => id)).toEqual([merge.id]);
  const lookup = base(facade.id) + '/package-facts/' + merge.id + '/equivalents?version=' + beforeMerge.version;
  const peers = await json<{ version: number; items: Fact[] }>(lookup + '&contextId=' + left.assessmentContextId);
  expect(peers.version).toBe(beforeMerge.version);
  expect(peers.items.map(({ id }) => id)).toContain(peer.id);
  expect((await page.request.get(lookup + '&contextId=' + right.assessmentContextId)).status()).toBe(404);

  await page.goto(factsUrl(facade.id, left.assessmentContextId, merge.id));
  await expect(page.locator('[id^=finding-]')).toHaveCount(1);
  await begin(row(merge), 'merge', 'Обе редакции дают эквивалентное значение');
  await row(merge).locator('input[type=checkbox][value="' + peer.id + '"]').check();
  await save(row(merge));
  await reload(merge, 'Эквивалентные записи объединены');
  const places = row(merge).getByRole('list', { name: 'Места в оригиналах' });
  expect((await page.request.get(lookup + '&contextId=' + left.assessmentContextId)).status()).toBe(412);
  await expect(places.getByRole('button', { name: 'Открыть основание' })).toHaveCount(2);
  await expect(places).toContainText(peer.quote);
  await page.goto(factsUrl(facade.id, right.assessmentContextId));
  await expect(row(merge)).toHaveCount(0);
  await expect(row(peer)).toHaveCount(0);
  await expect(page.locator('li[id^=finding-]').filter({ hasText: 'Thickness' }).first()).toContainText('F2');

  const current = await summary(omission.id);
  const area = current.contexts.find(({ name }) => name === 'E1')!;
  const anchor = area.questions.find(({ requirement }) => requirement.positionId === 'anchor')!;
  const silence = area.questions.find(({ requirement }) => requirement.positionId === 'variable')!;
  const collected = await caseFacts(current, area.facadeId);
  const source = collected.items.find(({ attribute, branch }) => attribute === 'Anchor plan' && branch === 'A')!;
  await review(omission.id, source.id, { action: 'confirm', reason: 'Контрольная подготовка исходной опоры непередачи' }, current.version);
  const baseline = await summary(omission.id);
  const ready = baseline.contexts.find(({ assessmentContextId }) => assessmentContextId === area.assessmentContextId)!
    .questions.find(({ id }) => id === anchor.id)!;
  expect(ready.machine.outcome).toBe('confirmed_missing');
  await accepted(await command(page.context(), origin, '/api/v1/questions/' + ready.id + '/decisions',
    'POST', { action: 'confirm', reason: 'Контрольный допуск реестра', requestExternal: true }, ready.version), 'Допуск непередачи');
  const eligible = () => json<{ items: { questionId: string; kind: string }[] }>(
    base(omission.id) + '/letters/eligible?assessmentContextId=' + area.assessmentContextId);
  expect((await eligible()).items.map(({ kind }) => kind).sort()).toEqual(['clarification', 'confirmed_missing']);
  await page.goto(factsUrl(omission.id, area.assessmentContextId, source.id));
  await begin(row(source), 'exclude', 'Дословная запись остаётся; выбранная трактовка требует сверки');
  await save(row(source));
  await reload(source, 'Ложная находка исключена');
  await expect(row(source)).toContainText('зависимый вывод требует сверки');
  expect((await eligible()).items).toEqual([expect.objectContaining({ questionId: silence.id, kind: 'clarification' })]);
  await page.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: /^Письма(?:\s|$)/u }).click();
  await expect(page.getByText('Доступно для запроса · 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Variable profile clearance/u })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Anchor plan/u })).toHaveCount(0);

  const limited = await browser.newPage({ baseURL });
  try {
    await signIn(limited, 'scope-viewer', 'synthetic-acceptance-only');
    await limited.goto(factsUrl(facade.id, left.assessmentContextId));
    expect((await limited.request.get(base(facade.id) + '/facade-assessment')).status()).toBe(404);
    expect((await limited.request.get(lookup + '&contextId=' + left.assessmentContextId)).status()).toBe(404);
    await expect(limited.locator('[id^=finding-]')).toHaveCount(0);
    await expect(limited.getByText('Решение по сведению', { exact: true })).toHaveCount(0);
  } finally { await limited.close(); }
});
