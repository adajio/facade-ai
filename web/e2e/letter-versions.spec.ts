import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accepted, admin, applyFixtureReview, command, pdf, signIn, unique } from './synthetic';

test('Основания, клавиатура, письмо, досылка и конфликт вкладок', async ({ page, baseURL }) => {
  const build = process.env.FACADE_E2E_BUILD_DIR;
  test.skip(!build || !process.env.DATABASE_URL || !admin.login || !admin.password, 'Нужны сборка и окружение отдельной синтетической БД');
  test.setTimeout(160_000);
  const origin = new URL(baseURL!).origin;
  const ctx = page.context();
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const { openPool } = await import(pathToFileURL(resolve(build!, 'src/platform/db.js')).href);
  const tools = await import(pathToFileURL(resolve(import.meta.dirname, '../../test/e2e-supplements/fixture.mjs')).href);
  const db = openPool(process.env.DATABASE_URL);
  const second = await ctx.newPage();
  try {
    await signIn(page, admin.login!, admin.password!);
    const recipient = 'Синтетический адресат';
    const catalog = await accepted<{ id: string }>(await command(ctx, origin, '/api/catalogs', 'POST', {
      key: unique('web-proof'), name: 'Каталог адресных оснований',
      requirements: [{
        key: 'bracket', part: 'узел крепления', applicability: 'Фасад А',
        formats: ['pdf'], equivalents: [], sourceRoles: ['inventory'],
        completenessCriterion: 'Адресуемый документ', addressee: recipient,
      }],
    }), 'Версия каталога');
    const project = await accepted<{ id: string; scopes: { id: string }[] }>(await command(ctx, origin, '/api/projects', 'POST', {
      name: unique('Фасад-письмо'), catalogVersionId: catalog.id, scopeName: 'Фасад А',
    }), 'Проект');
    const scopeId = project.scopes[0].id;
    const projectPath = '/projects/' + project.id;
    const base = '/api' + projectPath;
    const current = base + '/assessments/current?scopeId=' + scopeId;
    const fixture = pdf('Bracket NOT INCLUDED');
    const sourceHash = sha(fixture.buffer);
    const receipt = await accepted<{ receiptId: string }>(await command(ctx, origin, base + '/receipts', 'POST', {}), 'Поступление');
    const receiptPath = '/api/receipts/' + receipt.receiptId;
    const upload = await accepted<{ uploadId: string; holdId: string }>(await command(ctx, origin, receiptPath + '/uploads', 'POST', {
      relativePath: fixture.name, size: fixture.buffer.length, sha256: sourceHash,
      mediaType: fixture.mimeType, scopeIds: [scopeId],
    }), 'Декларация');
    const uploadPath = '/api/uploads/' + upload.uploadId;
    const { csrfToken } = await accepted<{ csrfToken: string }>(await ctx.request.get('/api/me'), 'Сеанс');
    expect((await ctx.request.put(uploadPath + '/parts/1', {
      data: fixture.buffer, headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sourceHash },
    })).ok()).toBe(true);
    const original = await accepted<{ documentId: string; versionId: string }>(await command(ctx, origin, uploadPath + '/complete', 'POST', {}), 'Финализация');
    expect((await command(ctx, origin, receiptPath + '/seal', 'POST', {})).ok()).toBe(true);
    const hints = await tools.observations(db, { ...original, projectId: project.id, sha256: sourceHash }, scopeId, 'NOT INCLUDED');
    const snapshot = await accepted<{ holds: { id: string }[]; scopes?: { holds: { id: string }[] }[] }>(await ctx.request.get(base + '/snapshot?scopeId=' + scopeId), 'Срез');
    const hold = (snapshot.holds ?? snapshot.scopes?.[0]?.holds ?? []).find((item) => item.id === upload.holdId);
    expect(hold).toBeTruthy();
    await applyFixtureReview(async () => {
      const assessment = await accepted<{ questions: { id: string }[] }>(await ctx.request.get(current), 'Оценка');
      await tools.applyImpact(db, project.id, hold, [{
        scopeId, changes: assessment.questions.map((item) => tools.review(item, assessment, hints, 'absence', receipt.receiptId)),
      }]);
    });
    const completeness = projectPath + '/completeness?scope=' + scopeId;
    await page.goto(completeness);
    await second.goto(completeness);
    await expect(page.getByRole('heading', { name: 'Обязательные части' })).toBeVisible();
    const originButton = page.getByRole('button', { name: 'Основание A', exact: true });
    await originButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Оригинал и основание' })).toBeVisible();
    await expect(page.getByRole('blockquote')).toContainText('NOT INCLUDED');
    await page.getByRole('button', { name: 'Следующее место' }).click();
    await expect(page.getByText('2 из 2', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(originButton).toBeFocused();
    await page.setViewportSize({ width: 470, height: 760 });
    await originButton.click();
    await expect(page.getByRole('link', { name: 'Открыть оригинал' })).toBeVisible();
    await page.keyboard.press('Escape');

    await second.getByLabel('Основание решения').fill('Ввод другой вкладки сохранён');
    await page.getByLabel('Основание решения').fill('Узел отсутствует по описи');
    await page.getByLabel('Подтвердить к внешнему запросу').check();
    await page.getByRole('button', { name: 'Сохранить решение' }).click();
    await expect(page.getByText('Сохранено на сервере.')).toBeVisible();
    await second.getByRole('button', { name: 'Сохранить решение' }).click();
    await expect(second.getByText('Ваш ввод сохранён.', { exact: false })).toBeVisible();
    await expect(second.getByLabel('Основание решения')).toHaveValue('Ввод другой вкладки сохранён');

    await page.getByRole('button', { name: 'Разделы · Комплектность' }).click();
    await page.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Письма' }).click();
    await page.getByRole('combobox', { name: 'Адресат', exact: true }).selectOption(recipient);
    await page.getByRole('checkbox', { name: /узел крепления/ }).check();
    await page.getByRole('button', { name: 'Сформировать черновик' }).click();
    const text = page.getByTestId('current-letter-text');
    await expect(text).toContainText('узел крепления');
    const letterPath = new URL(page.url()).pathname;
    const letterApi = '/api/v1/letters/' + letterPath.split('/').at(-1);
    const beforeEdit = await accepted<{ revisionId: string }>(await ctx.request.get(letterApi), 'Исходное письмо');
    const revision = await accepted<{ items: { sources: { label: string }[] }[] }>(
      await ctx.request.get(letterApi + '/revisions/' + beforeEdit.revisionId), 'Ссылки основания',
    );
    const sourceLabel = revision.items[0].sources[0].label;
    expect(revision.items[0].sources).toHaveLength(2);
    const action = 'направьте узел крепления в формате pdf';
    const custom = 'Фасад А. Для согласования, пожалуйста, ' + action + '. Сверено по документу ' + sourceLabel + '.';
    await page.getByText('Редактировать формулировки', { exact: true }).click();
    await page.getByRole('textbox', { name: 'узел крепления', exact: true }).fill(custom);
    await page.getByRole('button', { name: 'Сохранить редакцию' }).click();
    await expect(page.getByText('Сохранённый черновик', { exact: true })).toBeVisible();
    await expect(text).toHaveCount(0);
    const saved = page.getByRole('textbox', { name: 'Сохранённая формулировка', exact: true });
    await expect(saved).toHaveValue(custom);

    async function mark(needle: string, label: string) {
      const start = custom.indexOf(needle);
      expect(start).toBeGreaterThanOrEqual(0);
      await saved.focus();
      await saved.evaluate((node, range) => (node as HTMLTextAreaElement).setSelectionRange(range.start, range.end), {
        start, end: start + needle.length,
      });
      await page.getByRole('button', { name: label, exact: true }).click();
    }

    await mark('Фасад А', 'Отметить область');
    await mark('узел крепления', 'Отметить предмет');
    await mark(action, 'Отметить действие');
    await mark(sourceLabel, 'Отметить источник 1');
    await mark(sourceLabel, 'Отметить источник 2');
    await page.getByRole('checkbox', { name: 'Сверил смысл всей формулировки с актуальными основаниями' }).check();
    await page.getByRole('button', { name: 'Подтвердить редакцию' }).click();
    await expect(text).toContainText(custom);
    const actualText = await text.textContent();
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button', { name: 'Выгрузить TXT' }).click(),
    ]);
    const txtPath = await download.path();
    const fs = await import('node:fs/promises');
    expect(await fs.readFile(txtPath!, 'utf8')).toBe(actualText);
    const [document] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button', { name: 'Выгрузить DOCX' }).click(),
    ]);
    const docxPath = await document.path();
    const docxText = execFileSync('python3', ['-c', [
      'import json, sys, zipfile, xml.etree.ElementTree as ET',
      'with zipfile.ZipFile(sys.argv[1]) as z: root = ET.fromstring(z.read("word/document.xml"))',
      'ns = {"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}',
      'print(json.dumps("\\n".join("".join(t.text or "" for t in p.findall(".//w:t", ns)) for p in root.findall(".//w:p", ns)), ensure_ascii=False))',
    ].join('\n'), docxPath!], { encoding: 'utf8' });
    expect(JSON.parse(docxText)).toBe(actualText);
    const detail = await accepted<{ version: number; exports: { format: string; url: string; historicalUrl: string }[] }>(
      await ctx.request.get(letterApi), 'Письмо',
    );
    const record = detail.exports.find((item) => item.format === 'txt')!;
    expect(record).toBeTruthy();

    await second.goto(letterPath + '?scope=' + scopeId);
    await expect(second.getByTestId('current-letter-text')).toBeVisible();
    const supplement = await accepted<{ receiptId: string }>(await command(ctx, origin, base + '/receipts', 'POST', {}), 'Досылка');
    expect((await command(ctx, origin, '/api/receipts/' + supplement.receiptId + '/uploads', 'POST', {
      relativePath: 'supplement.pdf', size: fixture.buffer.length, sha256: sourceHash, scopeIds: [scopeId],
    })).ok()).toBe(true);
    expect((await ctx.request.get(record.url)).status()).toBe(409);
    expect((await ctx.request.get(record.historicalUrl)).status()).toBe(200);
    await expect(second.getByTestId('current-letter-text')).toHaveCount(0);
    await expect(second.getByText('Актуальная выдача удержана', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Зафиксировать отправку' }).click();
    await page.getByLabel('Когда отправлено').fill('2026-11-21T09:30');
    await page.getByRole('button', { name: 'Сохранить факт отправки' }).click();
    await expect(page.getByRole('heading', { name: 'История · снимок отправки' })).toBeVisible();
    await expect(page.getByText(actualText!, { exact: true })).toBeVisible();
  } finally {
    await second.close();
    await db.end();
  }
});
