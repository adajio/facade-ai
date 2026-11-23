import { expect, test } from '@playwright/test';

test('Настройки показывают адресные предложения и подтверждают выбранное основание', async ({ page }) => {
  const projectId = '10000000-0000-0000-0000-000000000000';
  const documentId = '20000000-0000-0000-0000-000000000000';
  const versionId = '30000000-0000-0000-0000-000000000000';
  const projectPath = '/projects/' + projectId;
  const base = '/api' + projectPath;
  const assessment = '/api/v1' + projectPath + '/facade-assessment';
  const original = `/api/documents/${documentId}/versions/${versionId}/content`;
  const sha = 'b'.repeat(64);
  const actions = ['project:read', 'project:engineer', 'project:manage'];
  let projectVersion = 1;
  let stage: string | null = null;
  let confirmedFacadeKinds: string[] = [];
  let mode: 'empty' | 'single' | 'competing' = 'empty';
  const commands: { path: string; body: unknown; version?: string }[] = [];

  function observation(index: number, quote: string, designStage: string | null, proposedFacadeKind: string | null) {
    const id = `40000000-0000-0000-0000-00000000000${index}`;
    const evidence = `50000000-0000-0000-0000-00000000000${index}`;
    return {
      id, quote, designStage, basis: { stage: designStage ? quote : undefined }, proposedFacadeKind,
      evidenceHref: '/api/v1/evidence/' + evidence, evidenceId: evidence, documentId, versionId, sha256: sha,
      address: { unitId: 'title-page', locator: { page: index } },
      binding: { candidates: proposedFacadeKind ? [{ label: 'Фасад А' }] : [] },
    };
  }
  const first = observation(1, 'Стадия: РД', 'РД', null);
  const second = observation(2, 'Стадия: П', 'П', null);
  const facade = observation(3, 'Фасад А | Тип фасада: panel', null, 'panel');
  const fixtures = [first, second, facade];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'PUT') {
      commands.push({ path, body: request.postDataJSON(), version: request.headers()['if-match'] });
      if (path === base + '/stage') stage = request.postDataJSON().stage;
      if (path === base + '/facade-assessment/facade-kinds') confirmedFacadeKinds = request.postDataJSON().facadeKinds;
      await route.fulfill({ json: { version: ++projectVersion } });
      return;
    }
    const project = { id: projectId, name: 'Синтетический проект', version: projectVersion, role: 'project_manager',
      actions, intakeMode: true, catalog: null, scopes: [], stage, confirmedFacadeKinds };
    if (path === '/api/me') {
      return route.fulfill({ json: { user: { id: projectId, login: 'manager' }, projects: [project], csrfToken: 'synthetic' } });
    }
    if (path === base) return route.fulfill({ json: project });
    if (path === base + '/members') return route.fulfill({ json: { version: projectVersion, members: [] } });
    if (path === base + '/catalog-options') {
      return route.fulfill({ json: { version: projectVersion, reason: 'stage_unknown', catalogs: [], nextCursor: null } });
    }
    if (path === base + '/snapshot') return route.fulfill({ json: { sliceId: 'synthetic', cursor: '0' } });
    if (path === base + '/events') return route.fulfill({ json: { cursor: '0', events: [] } });
    if (path === assessment) {
      const counts = mode === 'empty' ? { stage: 0, facadeKind: 0 } : { stage: mode === 'single' ? 1 : 2, facadeKind: 1 };
      return route.fulfill({ json: { version: 7, observations: {
        href: assessment + '/7/observations', proposalCounts: counts,
      } } });
    }
    if (path === assessment + '/7/observations') {
      if (url.searchParams.get('proposal') === 'facadeKind') {
        return route.fulfill({ json: { version: 7, items: [facade], nextCursor: null } });
      }
      const after = url.searchParams.has('after');
      return route.fulfill({ json: { version: 7, items: [after ? second : first],
        nextCursor: mode === 'competing' && !after ? first.id : null } });
    }
    const fact = fixtures.find(({ evidenceHref }) => evidenceHref === path);
    if (fact) return route.fulfill({ json: { id: fact.evidenceId, address: fact.address,
      source: { projectId, documentId, versionId, sha256: sha, name: 'Титул.pdf' } } });
    const finding = fixtures.find(({ id }) => '/api/v1/observations/' + id === path);
    if (finding) return route.fulfill({ json: finding });
    if (path.startsWith('/api/v1/evidence/') && path.endsWith('/content')) {
      return route.fulfill({ json: { lines: [] } });
    }
    if (path === original) return route.fulfill({ status: 200, headers: { ETag: '"sha256-' + sha + '"', 'Content-Type': 'application/pdf' } });
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });

  await page.goto(projectPath + '/members');
  await expect(page.getByText('Стадия уточняется.')).toBeVisible();
  await expect(page.getByText('В прочитанных исходниках пока нет предложения по стадии.')).toBeVisible();
  await expect(page.getByLabel('Код стадии')).toBeHidden();
  expect(commands).toHaveLength(0);

  mode = 'single';
  await page.getByRole('button', { name: 'Обновить предложения' }).click();
  await expect(page.getByRole('heading', { name: 'Предложенная стадия' })).toBeVisible();
  await page.getByRole('link', { name: 'Открыть основание для РД' }).click();
  const preview = page.getByRole('region', { name: 'Оригинал и основание' });
  await expect(preview.getByText(versionId)).toBeVisible();
  await expect(preview.getByText('Физическая страница')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('evidence=' + first.evidenceId));
  await preview.getByRole('button', { name: 'Закрыть просмотр оригинала' }).click();
  await page.getByRole('button', { name: 'Подтвердить стадию РД' }).click();
  await expect(page.getByText('Подтверждённая стадия: РД')).toBeVisible();
  expect(commands[0]).toMatchObject({ path: base + '/stage', version: '"1"', body: { stage: 'РД', evidenceIds: [first.evidenceId] } });

  await page.getByRole('button', { name: 'Подтвердить тип panel' }).click();
  await expect(page.getByText('Подтверждённые типы фасадов: panel')).toBeVisible();
  expect(commands[1]).toMatchObject({ path: base + '/facade-assessment/facade-kinds', version: '"2"',
    body: { facadeKinds: ['panel'], evidenceIds: [facade.evidenceId] } });

  mode = 'competing';
  await page.getByRole('button', { name: 'Обновить предложения' }).click();
  await expect(page.getByRole('heading', { name: 'В исходниках указаны разные стадии' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть основание для РД' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть основание для П', exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  await page.getByRole('button', { name: 'Подтвердить стадию П', exact: true }).click();
  await expect(page.getByText('Подтверждённая стадия: П')).toBeVisible();
  expect(commands[2]).toMatchObject({ path: base + '/stage', version: '"3"', body: { stage: 'П', evidenceIds: [second.evidenceId] } });
});
