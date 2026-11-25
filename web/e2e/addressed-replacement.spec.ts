import { expect, test as base, type BrowserContext, type Locator, type TestInfo } from '@playwright/test';
import { addressedFixture, type Publication } from './addressed-fixture';
import { accepted, account, admin, command, pdf, signIn } from './synthetic';
import type { Assessment, AssessmentQuestion } from '../src/lib/workspace';

const reason = 'N06 уточняет зазор и заменяет обе указанные старые строки';
const gapDecisionReason = 'До адресной досылки проверены две строки зазора';
const formatNotice = 'Формат TXT отсутствует в закреплённом требовании. Замена удержана.';
const missingNotice = 'В текущей версии оценки прежние опоры отсутствуют. Повторно сверьте эту строку, чтобы продолжить замену.';
type Ref = { observationId: string; evidenceId: string; versionId: string };

function question(snapshot: Assessment, id: string) {
  const row = snapshot.questions.find((item) => item.id === id);
  if (!row) throw new Error('В оценке отсутствует строка ' + id);
  return row;
}

function referenceIds(sources: { observationId?: string }[]) {
  return sources.map(({ observationId }) => observationId).sort();
}

async function prepare(build: string, owner: BrowserContext, engineerContext: BrowserContext, origin: string) {
  const engineer = await account(owner, engineerContext, origin, 'n06-engineer');
  const fixture = await addressedFixture(build, owner, origin, ['QF-91 gap', 'QF-92 length']);

  async function read(
    file: Publication, questionId: string, property: 'gap' | 'length', line: string, value: string, branch: 'A' | 'B',
  ) {
    const { id, evidenceId } = await fixture.observe(file, {
      subject: property === 'gap' ? 'QF-91' : 'QF-92', property, quote: line, value, questionId, branch,
    });
    return { observationId: id, evidenceId, versionId: file.versionId };
  }

  async function apply(file: Publication, entries: { questionId: string; refs: Ref[] }[]) {
    const assessment = await fixture.getAssessment();
    await fixture.resolveHold(file, entries.map(({ questionId, refs }) => ({
      questionId, expectedDependencyVersion: question(assessment, questionId).dependencyVersion,
      review: {
        inputGeneration: String(assessment.inputGeneration), remaining: [], completenessChecked: true,
        findings: refs.map(({ observationId }) => ({
          kind: 'value', observationId, sourceRole: 'design', comparisonKey: questionId, applicability: 'active',
        })),
      },
    })));
  }

  try {
    await accepted(await command(owner, origin, fixture.base + '/members/' + engineer.userId, 'PUT',
      { role: 'engineer' }, fixture.project.version), 'Назначить роль инженера');
    const initial = await fixture.getAssessment();
    const gap = initial.questions.find((row) => row.requirement.part === 'QF-91 gap')!;
    const length = initial.questions.find((row) => row.requirement.part === 'QF-92 length')!;
    const left = await fixture.upload({ ...pdf(['QF-91 gap 37 mm', 'QF-92 length 825 mm']), name: 'n05-design.pdf' });
    const right = await fixture.upload({ ...pdf('QF-91 gap 44 mm'), name: 'n05-schedule.pdf' });
    const previous = [
      await read(left, gap.id, 'gap', 'QF-91 gap 37 mm', '37', 'A'),
      await read(right, gap.id, 'gap', 'QF-91 gap 44 mm', '44', 'B'),
    ];
    const unchanged = [
      await read(left, length.id, 'length', 'QF-92 length 825 mm', '825', 'A'),
      await read(left, length.id, 'length', 'QF-92 length 825 mm', '825', 'B'),
    ];
    await fixture.resolveHold(left);
    await apply(right, [{ questionId: gap.id, refs: previous }, { questionId: length.id, refs: unchanged }]);
    const oldLength = question(await fixture.getAssessment(), length.id);
    expect(oldLength.outcome).toBe('covered');
    await accepted(await command(owner, origin, '/api/questions/' + length.id + '/decisions', 'POST', {
      action: 'confirm', requestExternal: false, reason: 'Проверена независимая строка длины',
    }, oldLength.version), 'Подтвердить длину');
    const fixedLength = question(await fixture.getAssessment(), length.id);
    expect(fixedLength.decision?.id).toBeTruthy();

    const inquiries = await accepted<{ inquiries: { id: string; assessmentQuestionId: string }[] }>(
      await owner.request.get(fixture.base + '/inquiries?scopeId=' + fixture.scopeId), 'Вопросы',
    );
    const inquiryId = inquiries.inquiries.find((entry) => entry.assessmentQuestionId === gap.id)?.id;
    if (!inquiryId) throw new Error('Не создан вопрос QF-91 gap');
    const url = '/projects/' + fixture.project.id + '/questions/' + inquiryId + '?scope=' + fixture.scopeId;
    const replacementApi = '/api/v1/questions/' + gap.id + '/source-replacements';
    const historyApi = '/api/v1/questions/' + gap.id + '/applicability';

    async function prepareTxt() {
      const txt = await fixture.upload({ name: 'n06-unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('QF-91 gap 37 mm\n') });
      const txtProofs = [
        await read(txt, gap.id, 'gap', 'QF-91 gap 37 mm', '37', 'A'),
        await read(txt, gap.id, 'gap', 'QF-91 gap 37 mm', '37', 'B'),
      ];
      await apply(txt, [{ questionId: gap.id, refs: [...previous, ...txtProofs] }]);
      const reviewed = question(await fixture.getAssessment(), gap.id);
      expect(reviewed.outcome).toBe('confirmed_conflict');
      expect(referenceIds(reviewed.machine.citations)).toEqual(referenceIds(previous));
      await accepted(await command(owner, origin, '/api/questions/' + gap.id + '/decisions', 'POST', {
        action: 'confirm', requestExternal: false, reason: gapDecisionReason,
      }, reviewed.version), 'Подтвердить прежние опоры зазора');
      return txtProofs;
    }

    async function openForm() {
      await fixture.drain();
      const editing = await engineerContext.newPage();
      await signIn(editing, engineer.login, engineer.password, url);
      return { editing, form: editing.getByRole('region', { name: 'Замена опор вопроса' }) };
    }

    return {
      fixture, gap, length, fixedLength, left, right, previous, replacementApi, historyApi, url, inquiryId,
      apply, read, prepareTxt, openForm,
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

const test = base.extend<{ delivery: Awaited<ReturnType<typeof prepare>> & { owner: BrowserContext; engineerContext: BrowserContext; origin: string } }>({
  delivery: async ({ page, browser, baseURL }, use) => {
    const build = process.env.FACADE_E2E_BUILD_DIR;
    base.skip(!build || !process.env.DATABASE_URL || !admin.login || !admin.password, 'Нужна отдельная синтетическая БД и сборка');
    await signIn(page, admin.login!, admin.password!);
    const owner = page.context();
    const origin = new URL(baseURL!).origin;
    const engineerContext = await browser.newContext({ baseURL });
    try {
      const delivery = await prepare(build!, owner, engineerContext, origin);
      try {
        await use({ ...delivery, owner, engineerContext, origin });
      } finally {
        await delivery.fixture.close();
      }
    } finally {
      await engineerContext.close();
    }
  },
});

test.setTimeout(120_000);

async function expectHeldForm(form: Locator, snapshot: Assessment, gap: AssessmentQuestion) {
  await expect(form.getByText(formatNotice, { exact: true })).toHaveCount(2);
  for (const branch of ['A', 'B']) {
    await expect(form.getByRole('checkbox', { name: new RegExp('n06-unsupported[.]txt.*ветвь ' + branch) })).toBeDisabled();
  }
  await expect(form.getByText('Версия оценки', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText(String(snapshot.version));
  await expect(form.getByText('Версия строки для подтверждения').locator('xpath=following-sibling::dd[1]')).toHaveText(String(gap.version));
  await expect(form.getByText('Предмет', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('QF-91 gap');
  await expect(form.getByRole('button', { name: 'Подтвердить замену', exact: true })).toBeDisabled();
}

async function recordVersions(testInfo: TestInfo, before: Assessment, after: Assessment, gapId: string, incoming: Ref[], code: string) {
  const state = (snapshot: Assessment) => {
    const gap = question(snapshot, gapId);
    return { assessmentVersion: snapshot.version, questionVersion: gap.version, dependencyVersion: gap.dependencyVersion,
      decisionId: gap.decision?.id ?? null, citations: gap.machine.citations.map(({ observationId, evidenceId, versionId }) =>
        ({ observationId, evidenceId, versionId })) };
  };
  await testInfo.attach('addressed-replacement.json', {
    body: JSON.stringify({ questionId: gapId, before: state(before), after: state(after), incoming, code }, null, 2),
    contentType: 'application/json',
  });
}

test('Досылка TXT при действующих прежних опорах удерживается по формату', async ({ delivery }, testInfo) => {
  const { fixture, gap, length, fixedLength, previous, replacementApi, historyApi, origin, engineerContext } = delivery;
  const txtProofs = await delivery.prepareTxt();
  const before = await fixture.getAssessment();
  const reviewed = question(before, gap.id);
  expect(reviewed.decision).toMatchObject({ reason: gapDecisionReason });
  const { form, editing } = await delivery.openForm();
  await expectHeldForm(form, before, reviewed);
  await expect(form.getByText(missingNotice)).toHaveCount(0);
  const oldOptions = form.getByRole('group', { name: 'Прежние опоры, которые нужно заменить' });
  await expect(oldOptions.getByRole('checkbox')).toHaveCount(2);
  for (const name of ['n05-design.pdf', 'n05-schedule.pdf']) {
    await expect(oldOptions.getByRole('checkbox', { name })).toBeEnabled();
  }
  for (const details of await oldOptions.getByText('Адрес и редакция прежней опоры', { exact: true }).all()) {
    await details.click();
  }
  for (const { versionId } of previous) await expect(oldOptions.getByText(versionId, { exact: true })).toBeVisible();

  const blocked = await command(engineerContext, origin, replacementApi, 'POST', {
    replacements: txtProofs, replaced: previous, reason,
  }, reviewed.version);
  expect(blocked.status()).toBe(422);
  const problem = await blocked.json();
  expect(problem.code).toBe('support_format_not_admitted');
  expect(await accepted(await engineerContext.request.get(historyApi), 'История замены')).toMatchObject({ replacements: [] });
  await expect(editing.getByRole('region', { name: 'История замены опор' })).toHaveCount(0);
  const after = await fixture.getAssessment();
  expect(after.version).toBe(before.version);
  expect(question(after, gap.id)).toEqual(reviewed);
  expect(question(after, length.id)).toEqual(fixedLength);
  const archive = await fixture.getAssessment(before.version);
  expect(question(archive, gap.id).decision).toEqual(reviewed.decision);
  expect(referenceIds(question(archive, gap.id).machine.citations)).toEqual(referenceIds(previous));
  await recordVersions(testInfo, before, after, gap.id, txtProofs, problem.code);
});

test('Досылка TXT после обновления первичного чтения удерживается до сверки строки', async ({ delivery }, testInfo) => {
  const { fixture, gap, length, fixedLength, previous, replacementApi, historyApi, origin, engineerContext, inquiryId, owner } = delivery;
  const txtProofs = await delivery.prepareTxt();
  await fixture.drain();
  const before = await fixture.getAssessment();
  const reviewed = question(before, gap.id);
  expect(reviewed.decision).toMatchObject({ reason: gapDecisionReason });
  expect(referenceIds(reviewed.machine.citations)).toEqual(referenceIds(previous));

  const publication = await fixture.publishPrimaryReview({
    questionId: gap.id, expectedDependencyVersion: reviewed.dependencyVersion,
    review: {
      inputGeneration: String(before.inputGeneration), findings: [],
      remaining: ['primary_coverage_pending'], completenessChecked: false,
    },
  });
  const current = await fixture.getAssessment();
  const updated = question(current, gap.id);
  expect(current.version).toBe(publication.assessmentVersion);
  expect(current.version).toBeGreaterThan(before.version);
  expect(current.change?.reason).toBe('primary_research_update');
  expect(updated.version).toBeGreaterThan(reviewed.version);
  expect(updated.dependencyVersion).toBeGreaterThan(reviewed.dependencyVersion!);
  expect(updated.machine.citations).toEqual([]);
  expect(updated.decision).toBeNull();
  expect(updated).toMatchObject({ previousDecisionId: reviewed.decision?.id, outcome: 'needs_review' });
  expect(question(current, length.id)).toEqual(fixedLength);

  const found = await accepted<{ candidates: { source: Ref }[] }>(
    await owner.request.get('/api/v1/inquiries/' + inquiryId), 'Сохранённые места',
  );
  expect(referenceIds(found.candidates.map(({ source }) => source))).toEqual(referenceIds([...previous, ...txtProofs]));

  const { editing, form } = await delivery.openForm();
  await expectHeldForm(form, current, updated);
  const oldOptions = form.getByRole('group', { name: 'Прежние опоры, которые нужно заменить' });
  await expect(oldOptions.getByText(missingNotice, { exact: true })).toBeVisible();
  await expect(oldOptions.getByRole('checkbox')).toHaveCount(0);
  await expect(oldOptions.getByRole('link', { name: 'Открыть строку для сверки' })).toHaveAttribute('href',
    '/projects/' + fixture.project.id + '/completeness/' + gap.id + '?scope=' + fixture.scopeId);
  const request = { replacements: txtProofs, replaced: previous, reason };
  expect((await command(engineerContext, origin, replacementApi, 'POST', request, reviewed.version)).status()).toBe(412);
  const blocked = await command(engineerContext, origin, replacementApi, 'POST', request, updated.version);
  expect(blocked.status()).toBe(422);
  const problem = await blocked.json();
  expect(problem.code).toBe('review_incomplete');
  expect(await accepted(await engineerContext.request.get(historyApi), 'История замены')).toMatchObject({ replacements: [] });
  await expect(editing.getByRole('region', { name: 'История замены опор' })).toHaveCount(0);
  const after = await fixture.getAssessment();
  expect(after.version).toBe(current.version);
  expect(question(after, gap.id)).toEqual(updated);
  expect(question(after, length.id)).toEqual(fixedLength);
  const archive = await fixture.getAssessment(before.version);
  expect(question(archive, gap.id).decision).toEqual(reviewed.decision);
  expect(referenceIds(question(archive, gap.id).machine.citations)).toEqual(referenceIds(previous));
  await recordVersions(testInfo, before, after, gap.id, txtProofs, problem.code);
});

test('Досылка N06 заменяет выбранные места одного вопроса и сохраняет историю', async ({ delivery, browser, baseURL }) => {
  const { fixture, gap, length, fixedLength, left, right, previous, replacementApi, url, apply, read, owner, engineerContext, origin } = delivery;
  const { editing, form } = await delivery.openForm();
  const next = await fixture.upload({ ...pdf('QF-91 gap 37 mm N06'), name: 'n06-approved.pdf' });
  const newProofs = [
    await read(next, gap.id, 'gap', 'QF-91 gap 37 mm N06', '37', 'A'),
    await read(next, gap.id, 'gap', 'QF-91 gap 37 mm N06', '37', 'B'),
  ];
  await apply(next, [{ questionId: gap.id, refs: [...previous, ...newProofs] }]);
  await fixture.drain();
  await editing.reload();
  const earlier = (await fixture.getAssessment()).questions.find((row) => row.id === gap.id)!;
  const newOptions = form.getByRole('group', { name: 'Новые опоры обеих ветвей' });
  const oldOptions = form.getByRole('group', { name: 'Прежние опоры, которые нужно заменить' });
  await newOptions.getByRole('checkbox', { name: /n06-approved\.pdf.*ветвь A/ }).check();
  await newOptions.getByRole('checkbox', { name: /n06-approved\.pdf.*ветвь B/ }).check();
  await oldOptions.getByRole('checkbox', { name: /n05-design\.pdf/ }).check();
  await oldOptions.getByRole('checkbox', { name: /n05-schedule\.pdf/ }).check();
  await form.getByLabel('Причина замены').fill(reason);
  await expect(form.getByRole('button', { name: 'Подтвердить замену', exact: true })).toBeDisabled();
  await form.getByRole('checkbox', { name: 'Подтверждаю замену выбранных опор только для этого вопроса' }).check();
  const sent = editing.waitForResponse((response) => new URL(response.url()).pathname === replacementApi &&
    response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Подтвердить замену', exact: true }).click();
  const applied = await sent;
  expect(applied.status()).toBe(201);
  expect(await applied.request().headerValue('if-match')).toBe(JSON.stringify(String(earlier.version)));
  const after = await fixture.getAssessment();
  const changed = after.questions.find((row) => row.id === gap.id)!;
  expect(changed.outcome).toBe('covered');
  expect(changed.machine.citations.map((citation) => citation.observationId).sort()).toEqual(newProofs.map((proof) => proof.observationId).sort());
  expect(after.questions.find((row) => row.id === length.id)).toEqual(fixedLength);
  expect(after.catalogVersionId).toBe(fixture.catalogVersionId);
  const stale = await command(engineerContext, origin, replacementApi, 'POST', { replaced: previous, replacements: newProofs, reason }, earlier.version);
  expect(stale.status()).toBe(412);

  await fixture.drain();
  await editing.reload();
  const history = editing.getByRole('region', { name: 'История замены опор' });
  await expect(history.getByText(reason)).toBeVisible();
  await history.getByText('Адреса и версии до и после замены', { exact: true }).click();
  await expect(history.getByRole('button', { name: /^Открыть новую опору/ })).toHaveCount(2);
  for (const [index, filename] of ['n05-design.pdf', 'n05-schedule.pdf'].entries()) {
    // The server sorts references by observation UUID. Locate the matching version.
    const version = [left, right][index].versionId;
    const option = history.getByRole('listitem').filter({ hasText: 'Версия оригинала · ' + version }).filter({
      has: editing.getByRole('button', { name: /^Открыть прежнюю опору/ }),
    }).last();
    await option.getByRole('button', { name: /^Открыть прежнюю опору/ }).click();
    const evidence = editing.getByRole('region', { name: 'Оригинал и основание' });
    await expect(evidence.getByText(filename, { exact: true })).toBeVisible();
    await expect(evidence.getByText(version, { exact: true })).toBeVisible();
    await evidence.getByRole('button', { name: 'Закрыть просмотр оригинала' }).click();
  }

  const viewerContext = await browser.newContext({ baseURL });
  try {
    const viewer = await account(owner, viewerContext, origin, 'n06-viewer');
    const project = await accepted<{ version: number }>(await owner.request.get(fixture.base), 'Проект');
    await accepted(await command(owner, origin, fixture.base + '/members/' + viewer.userId, 'PUT', {
      role: 'viewer',
    }, project.version), 'Назначить роль читателя');
    const reading = await viewerContext.newPage();
    await signIn(reading, viewer.login, viewer.password, url);
    await expect(reading.getByRole('heading', { name: 'История замены опор' })).toBeVisible();
    await expect(reading.getByRole('button', { name: 'Подтвердить замену' })).toHaveCount(0);
    expect((await command(viewerContext, origin, replacementApi, 'POST', {
      replaced: previous, replacements: newProofs, reason,
    }, changed.version)).status()).toBe(403);
  } finally {
    await viewerContext.close();
  }
});
