import { expect, test } from '@playwright/test';

test('Форма заключения переживает временный отказ и конфликт, при отказе в доступе карточка скрыта', async ({ page }) => {
  const projectId = '20000000-0000-4000-8000-000000000001';
  const area = '20000000-0000-4000-8000-000000000002';
  const documentId = '20000000-0000-4000-8000-000000000003';
  const versionId = '20000000-0000-4000-8000-000000000004';
  const project = { id: projectId, name: 'Контроль восстановления', version: 1, intakeMode: true, scopes: [],
    stage: 'Стадия 1', actions: ['project:read', 'project:engineer'] };
  const original = { id: versionId, documentId, label: 'Разрешённый лист.pdf', mediaType: 'application/pdf' };
  const head = { cursor: '1', sliceId: '1', projectionVersion: '1' };
  const boundary = { complete: false, reason: null, basisIds: [] };
  const draft = 'До поступления ведомости можно подготовить оси.';
  const submissions: { version?: string; payload: unknown }[] = [];
  let assessmentFailure = 0;
  let assessmentVersion = 1;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/me') return route.fulfill({ json: { csrfToken: 'fixture', user: { id: 'tester', login: 'engineering' }, projects: [project] } });
    if (pathname === `/api/projects/${projectId}`) return route.fulfill({ json: project });
    if (pathname.endsWith('/snapshot')) return route.fulfill({ json: head });
    if (pathname.endsWith('/events')) return route.fulfill({ json: { events: [], cursor: '1', head, hasMore: false } });
    if (pathname.endsWith('/confirmation-originals')) return route.fulfill({ json: { originals: [original], nextCursor: null } });
    if (pathname.endsWith('/facade-assessment')) {
      if (assessmentFailure) return route.fulfill({ status: assessmentFailure, json: { message: 'Временный отказ службы оценки' } });
      return route.fulfill({ json: {
        projectId, version: assessmentVersion, acceptedVersions: 1, stage: project.stage, activeWindows: 0, completedWindows: 0,
        limitations: [], outcome: 'needs_review', coverage: { inventory: boundary, map: boundary, reading: boundary, subject: boundary },
        observations: { counts: { identified: 0, common: 0, unclear: 0, unidentified: 0 } },
        contexts: [{ assessmentContextId: area, name: 'Весь комплект', kind: 'common', facadeId: null, version: assessmentVersion,
          outcome: 'needs_review', questions: [], questionHolds: [], counts: {},
          ...(assessmentVersion > 2 ? { conclusion: { startWork: 'can_start_with_limitations', reason: draft, basedOnVersion: 2 } } : {}),
        }],
      } });
    }
    if (pathname.endsWith('/conclusions') && request.method() === 'POST') {
      submissions.push({ version: request.headers()['if-match'], payload: request.postDataJSON() });
      if (submissions.length === 1) {
        assessmentVersion = 2;
        return route.fulfill({ status: 412, json: { code: 'version_conflict', currentVersion: 2 } });
      }
      assessmentVersion = 3;
      return route.fulfill({ status: 201, json: { id: 'conclusion-fixture', version: 3 } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });

  await page.goto(`/projects/${projectId}/completeness?context=${area}&panel=conclusion`);
  const reason = page.getByLabel('Основание решения', { exact: true });
  const originalChoice = page.getByLabel('Документ-основание');
  const anchor = page.getByLabel('Физическая страница PDF');
  const save = page.getByRole('button', { name: 'Сохранить заключение' });
  await page.getByLabel('Можно ли начать работы').selectOption('can_start_with_limitations');
  await reason.fill(draft);
  await originalChoice.selectOption(versionId);
  await anchor.fill('1');
  await expect(save).toBeEnabled();
  const reload = async () => {
    const sync = page.locator('.sync-menu');
    if (await sync.getAttribute('open') === null) await sync.locator('summary').click();
    await page.getByRole('button', { name: 'Обновить сейчас' }).click();
  };
  assessmentFailure = 503;
  await reload();
  await expect(page.getByText(/Доступна последняя проверенная версия/)).toBeVisible();
  await expect(reason).toHaveValue(draft);
  await expect(originalChoice).toHaveValue(versionId);
  await expect(anchor).toHaveValue('1');
  await expect(save).toBeDisabled();
  assessmentFailure = 0;
  await page.getByRole('button', { name: 'Повторить загрузку оценки' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Сервер уже сохранил другую версию/)).toBeVisible();
  await expect(reason).toHaveValue(draft);
  await expect(anchor).toHaveValue('1');
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Загрузить текущую версию для сверки' }).click();
  await page.getByRole('button', { name: 'Сверил изменения', exact: true }).click();
  await save.click();
  await expect(page.getByText('Решение сохранено.')).toBeVisible();
  expect(submissions.map(({ version }) => version)).toEqual(['"1"', '"2"']);
  expect(submissions[1].payload).toEqual(submissions[0].payload);

  assessmentFailure = 403;
  await reload();
  await expect(page.getByText('Сводка оценки · Ресурс недоступен.')).toBeVisible();
  await expect(page.getByText(/^Заключение ·/)).toHaveCount(0);
  await expect(reason).toHaveCount(0);
});
