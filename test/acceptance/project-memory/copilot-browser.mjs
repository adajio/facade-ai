import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, origin, login, passwordPath, snapshotPath, questionPath, output, waitSeconds = '1500'] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:18[0-9]{3}$/u);
assert.notEqual(origin, 'http://127.0.0.1:18443');
assert.match(login, /^pkgintake_[a-z\d_]+$/u);
assert.match(waitSeconds, /^[1-9]\d{0,3}$/u);
assert.equal((await stat(output)).mode & 0o077, 0);
for (const path of [snapshotPath, questionPath, passwordPath]) assert.equal((await stat(path)).mode & 0o077, 0);
const snapshot = await readFile(snapshotPath);
const frozen = JSON.parse(snapshot);
const release = JSON.parse(await readFile(questionPath, 'utf8'));
assert.equal(frozen.phase, 'primary');
assert.equal(frozen.helper.length, 0);
assert.equal(release.primarySha256, createHash('sha256').update(snapshot).digest('hex'));
assert.equal(typeof release.question, 'string');
assert.equal(typeof release.previouslyUnselected, 'boolean');
const projectPath = '/projects/' + frozen.project.id + '/copilot';
const endpoint = '/api' + projectPath + '/questions';
const archive = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', {
  flag: 'wx', mode: 0o600,
});

process.env.TMPDIR = resolve(output, 'chrome-tmp');
await mkdir(process.env.TMPDIR, { mode: 0o700 });
const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({
  executablePath: process.env.FACADE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--disable-background-networking', '--no-first-run', '--disable-sync'],
});
const report = { submitted: false, previouslyUnselected: release.previouslyUnselected, loginPosts: 0, openSources: 0 };
const temporarilyHeld = new Set(['budget_reserve_wait', 'route_busy', 'route_rate_limited', 'dispatch_not_started', 'recovery_required']);
try {
  const context = await browser.newContext({ baseURL: origin });
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && !['about:', 'blob:', 'chrome-extension:'].includes(url.protocol)) return route.abort();
    if (url.pathname === '/api/sessions' && request.method() === 'POST' && ++report.loginPosts !== 1) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(projectPath);
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill((await readFile(passwordPath, 'utf8')).trim());
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const question = page.getByLabel('Вопрос инженера', { exact: true });
  await question.fill(release.question);
  const posted = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Спросить помощника', exact: true }).click();
  const result = await posted;
  assert.equal(result.ok(), true);
  report.submitted = true;
  await page.waitForURL((url) => url.pathname.startsWith(projectPath + '/'));
  const id = new URL(page.url()).pathname.slice(projectPath.length + 1);
  assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  await archive('question-created.json', { id, status: result.status(), primarySha256: release.primarySha256 });
  const deadline = Date.now() + Number(waitSeconds) * 1000;
  let answer;
  while (Date.now() < deadline) {
    const read = await context.request.get(endpoint + '/' + id, { timeout: 20_000 });
    assert.equal(read.ok(), true);
    answer = await read.json();
    if (['answered', 'limited', 'historical'].includes(answer.state) ||
        answer.state === 'held' && !temporarilyHeld.has(answer.reason)) break;
    await new Promise((listen) => setTimeout(listen, 10_000));
  }
  report.state = answer?.state ?? 'unknown';
  report.reason = answer?.reason ?? null;
  report.claims = answer?.claims?.length ?? 0;
  report.citations = answer?.citations?.length ?? 0;
  report.partialSources = answer?.partialSources?.length ?? 0;
  await archive('answer.json', answer ?? null);
  await page.reload();
  await page.getByRole('heading', { name: release.question, exact: true }).waitFor();
  const allLinks = new Set();
  for (const [name, count] of [['Открытые источники', report.citations], ['Места, открытые до остановки', report.partialSources]]) {
    if (!count) continue;
    const heading = page.getByRole('heading', { name, exact: true });
    await heading.waitFor();
    const links = await heading.locator('xpath=following-sibling::ul[1]').getByRole('link')
      .evaluateAll((items) => items.map(({ href }) => href));
    assert.equal(links.length, count);
    for (const href of links) allLinks.add(href);
  }
  for (const href of allLinks) {
    assert.equal(new URL(href).origin, origin);
    await page.goto(href);
    await page.getByRole('heading', { name: 'Адрес в оригинале', exact: true }).waitFor();
    report.openSources++;
  }
} catch (error) {
  report.error = error.name;
  process.exitCode = 1;
} finally {
  await browser.close();
  await archive('browser-summary.json', report);
  console.log(JSON.stringify(report));
}
