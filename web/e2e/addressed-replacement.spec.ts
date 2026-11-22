import { expect, test } from '@playwright/test';
import { addressedFixture, type Publication } from './addressed-fixture';
import { accepted, account, admin, command, pdf, signIn } from './synthetic';

test('Досылка N06 заменяет выбранные места одного вопроса и сохраняет историю', async ({ page, browser, baseURL }) => {
  const build = process.env.FACADE_E2E_BUILD_DIR;
  test.skip(!build || !process.env.DATABASE_URL || !admin.login || !admin.password, 'Нужна отдельная синтетическая БД и сборка');
  test.setTimeout(120_000);
  await signIn(page, admin.login!, admin.password!);
  const owner = page.context();
  const origin = new URL(baseURL!).origin;
  const engineerContext = await browser.newContext({ baseURL });
  const viewerContext = await browser.newContext({ baseURL });
  const fixture = await addressedFixture(build!, owner, origin, ['QF-91 gap', 'QF-92 length']);
  const reason = 'N06 уточняет зазор и заменяет обе указанные старые строки';
  type Ref = { observationId: string; evidenceId: string; versionId: string };

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
      questionId, expectedDependencyVersion: assessment.questions.find((row) => row.id === questionId)?.dependencyVersion,
      review: {
        inputGeneration: String(assessment.inputGeneration), remaining: [], completenessChecked: true,
        findings: refs.map(({ observationId }) => ({
          kind: 'value', observationId, sourceRole: 'design', comparisonKey: questionId, applicability: 'active',
        })),
      },
    })));
  }

  try {
    const engineer = await account(owner, engineerContext, origin, 'n06-engineer');
    const viewer = await account(owner, viewerContext, origin, 'n06-viewer');
    let projectVersion = fixture.project.version;
    for (const [user, role] of [[engineer, 'engineer'], [viewer, 'viewer']] as const) {
      const assignment = await accepted<{ version: number }>(await command(owner, origin, fixture.base + '/members/' + user.userId,
        'PUT', { role }, projectVersion), 'Назначить проектную роль');
      projectVersion = assignment.version;
    }
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
    const oldLength = (await fixture.getAssessment()).questions.find((row) => row.id === length.id)!;
    expect(oldLength.outcome).toBe('covered');
    await accepted(await command(owner, origin, '/api/questions/' + length.id + '/decisions', 'POST', {
      action: 'confirm', requestExternal: false, reason: 'Проверена независимая строка длины',
    }, oldLength.version), 'Подтвердить длину');
    const fixedLength = (await fixture.getAssessment()).questions.find((row) => row.id === length.id)!;
    expect(fixedLength.decision?.id).toBeTruthy();

    const txt = await fixture.upload({ name: 'n06-unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('QF-91 gap 37 mm\n') });
    const txtProofs = [
      await read(txt, gap.id, 'gap', 'QF-91 gap 37 mm', '37', 'A'),
      await read(txt, gap.id, 'gap', 'QF-91 gap 37 mm', '37', 'B'),
    ];
    await apply(txt, [{ questionId: gap.id, refs: [...previous, ...txtProofs] }]);
    await fixture.drain();
    const inquiries = await accepted<{ inquiries: { id: string; assessmentQuestionId: string }[] }>(
      await owner.request.get(fixture.base + '/inquiries?scopeId=' + fixture.scopeId), 'Вопросы',
    );
    const id = inquiries.inquiries.find((entry) => entry.assessmentQuestionId === gap.id)?.id;
    expect(id).toBeTruthy();
    const url = '/projects/' + fixture.project.id + '/questions/' + id + '?scope=' + fixture.scopeId;
    const replacementApi = '/api/v1/questions/' + gap.id + '/source-replacements';
    const historyApi = '/api/v1/questions/' + gap.id + '/applicability';
    const editing = await engineerContext.newPage();
    await signIn(editing, engineer.login, engineer.password, url);
    const form = editing.getByRole('region', { name: 'Замена опор вопроса' });
    await expect(form.getByText('Формат TXT отсутствует в закреплённом требовании. Замена удержана.').first()).toBeVisible();
    await expect(form.getByRole('checkbox', { name: /n06-unsupported\.txt.*ветвь A/ })).toBeDisabled();
    const before = (await fixture.getAssessment()).questions.find((row) => row.id === gap.id)!;
    const blocked = await command(engineerContext, origin, replacementApi, 'POST', {
      replacements: txtProofs, replaced: previous, reason,
    }, before.version);
    expect(blocked.status()).toBe(422);
    expect((await blocked.json()).code).toBe('support_format_not_admitted');
    expect((await (await engineerContext.request.get(historyApi)).json()).replacements).toEqual([]);

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

    const reading = await viewerContext.newPage();
    await signIn(reading, viewer.login, viewer.password, url);
    await expect(reading.getByRole('heading', { name: 'История замены опор' })).toBeVisible();
    await expect(reading.getByRole('button', { name: 'Подтвердить замену' })).toHaveCount(0);
    expect((await command(viewerContext, origin, replacementApi, 'POST', {
      replaced: previous, replacements: newProofs, reason,
    }, changed.version)).status()).toBe(403);
  } finally {
    await Promise.all([engineerContext.close(), viewerContext.close(), fixture.close()]);
  }
});
