import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, origin, authPath, beforePath, output, reassessedPath] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const { login, password } = await read(authPath);
assert.match(login, /^pkgintake_engineer_[a-f0-9]{8}$/u);
const before = await read(beforePath);
const after = reassessedPath ? await read(reassessedPath) : null;
const changed = before.contexts.find(({ letter }) => letter?.status === 201);
const letter = changed.letter.result;
const facets = before.final.contexts.filter(({ kind }) => kind === 'facade');
assert.equal(facets.length, 2);
process.env.TMPDIR = resolve(output, 'playwright-tmp');
await mkdir(process.env.TMPDIR, { mode: 0o700 });
const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({
  executablePath: process.env.FACADE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--disable-background-networking', '--no-first-run', '--disable-sync'],
});
const report = { afterSupplement: Boolean(after), loginPosts: 0, facadeRows: [] };
try {
  const context = await browser.newContext({ baseURL: origin, acceptDownloads: false });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !['about:', 'blob:'].includes(url.protocol)) return route.abort();
    if (url.pathname === '/api/sessions' && route.request().method() === 'POST' && ++report.loginPosts !== 1) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.goto('/projects');
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('heading', { name: 'Проекты', exact: true }).waitFor();
  await page.goto('/projects/' + before.projectId + '/completeness');
  await page.getByRole('heading', { name: 'Выявленные фасады и общий уровень', exact: true }).waitFor();
  for (const facet of facets) {
    const missing = page.getByRole('link', { name: 'Подтверждённая нехватка · ' + facet.name, exact: true });
    const expected = after ? 0 : facet.counts.confirmed_missing;
    assert.equal(Number(await missing.innerText()), expected);
    report.facadeRows.push({ id: facet.assessmentContextId, confirmedMissing: expected });
  }
  await page.screenshot({ path: resolve(output, 'facades.png'), fullPage: true });
  await page.goto('/projects/' + before.projectId + '/letters/' + letter.id + '?context=' + changed.id);
  await page.getByRole('heading', { name: /Письмо №/u }).waitFor();
  if (!after) {
    await page.getByRole('button', { name: 'Выгрузить TXT', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Выгрузить DOCX', exact: true }).waitFor();
  } else {
    await page.getByText(/Снимок отправки|История отправки|Отправленные редакции|Отправлено/u).first().waitFor();
  }
  await page.screenshot({ path: resolve(output, 'letter.png'), fullPage: true });
  report.complete = true;
} finally {
  await browser.close();
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
