import { expect, test } from '@playwright/test';
import { addressedFixture } from './addressed-fixture';
import { accepted, admin, command, pdf, signIn } from './synthetic';

test('Карточка и история письма открывают три различные опоры одного конфликта', async ({ page, baseURL }) => {
  const build = process.env.FACADE_E2E_BUILD_DIR;
  test.skip(!build || !process.env.DATABASE_URL || !admin.login || !admin.password, 'Нужна отдельная синтетическая БД и сборка');
  await signIn(page, admin.login!, admin.password!);
  const context = page.context();
  const origin = new URL(baseURL!).origin;
  const fixture = await addressedFixture(build!, context, origin, ['QF-91 gap']);
  try {
    const initial = await fixture.getAssessment();
    const files = [];
    const findings = [];
    for (const [index, value] of ['37', '44', '37'].entries()) {
      const ordinal = index + 1;
      const quote = 'QF-91 gap ' + value + ' mm';
      const file = await fixture.upload({ ...pdf(quote + ' source ' + ordinal), name: 'gap-source-' + ordinal + '.pdf' });
      const observation = await fixture.observe(file, {
        subject: 'QF-91', property: 'gap', quote, value, questionId: initial.questions[0].id, branch: ordinal === 2 ? 'B' : 'A',
      });
      files.push(file);
      findings.push({
        kind: 'value', observationId: observation.id, sourceRole: 'design', comparisonKey: 'QF-91 gap', applicability: 'active',
      });
    }
    await fixture.resolveHold(files[0]);
    await fixture.resolveHold(files[1]);
    const latest = await fixture.getAssessment();
    await fixture.resolveHold(files[2], [{
      questionId: latest.questions[0].id, expectedDependencyVersion: latest.questions[0].dependencyVersion,
      review: { inputGeneration: String(latest.inputGeneration), findings, remaining: [], completenessChecked: true },
    }]);
    const confirmed = (await fixture.getAssessment()).questions[0];
    expect(confirmed.outcome).toBe('confirmed_conflict');
    const decision = await accepted<{ version: number; decision: { id: string } }>(
      await command(context, origin, '/api/questions/' + confirmed.id + '/decisions', 'POST', {
        action: 'confirm', requestExternal: true, reason: 'Проверены три разных оригинала',
      }, confirmed.version), 'Подтвердить запрос',
    );
    const current = (await fixture.getAssessment()).questions[0];
    const letter = await accepted<{ id: string; revisionId: string }>(
      await command(context, origin, fixture.base + '/letters', 'POST', {
        scopeId: fixture.scopeId, recipient: fixture.recipient,
        items: [{ questionId: current.id, questionVersion: current.version, decisionId: current.decision?.id ?? decision.decision.id }],
      }), 'Письмо',
    );
    const url = '/projects/' + fixture.project.id + '/letters/' + letter.id + '?scope=' + fixture.scopeId;
    for (const suffix of ['', '&revision=' + letter.revisionId]) {
      await page.goto(url + suffix);
      for (const index of [1, 2, 3]) {
        const filename = 'gap-source-' + index + '.pdf';
        const support = page.getByRole('button', { name: new RegExp(filename.replace('.', '\\.')) });
        await expect(support).toHaveCount(1);
        await support.click();
        const viewer = page.getByRole('region', { name: 'Оригинал и основание' });
        await expect(viewer.getByText(filename, { exact: true })).toBeVisible();
        await expect(viewer.getByText(index + ' из 3', { exact: true })).toBeVisible();
        await viewer.getByRole('button', { name: 'Закрыть просмотр оригинала' }).click();
      }
    }
  } finally {
    await fixture.close();
  }
});
