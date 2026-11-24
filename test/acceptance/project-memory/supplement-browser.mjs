import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, origin, login, passwordPath, snapshotPath, input, output] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:18[0-9]{3}$/u);
assert.notEqual(origin, 'http://127.0.0.1:18443');
assert.match(login, /^pkgintake_[a-z\d_]+$/u);
assert.equal(basename(input), 'supplement');
assert.equal((await stat(output)).mode & 0o077, 0);
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
assert.ok(['primary', 'follow-up'].includes(snapshot.phase));
assert.match(snapshot.project.id, /^[a-f0-9-]{36}$/u);
const files = (await readdir(input, { withFileTypes: true })).map((item) => {
  assert.ok(item.isFile() && item.name.endsWith('.pdf'));
  return resolve(input, item.name);
});
assert.equal(files.length, 2);

const project = '/projects/' + snapshot.project.id;
const receipts = '/api' + project + '/receipts';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
process.env.TMPDIR = resolve(output, 'chrome-tmp');
await mkdir(process.env.TMPDIR, { mode: 0o700 });
const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({
  executablePath: process.env.FACADE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--disable-background-networking', '--no-first-run', '--disable-sync'],
});
const report = { verifiedOriginals: 0, loginPosts: 0, complete: false };
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
  await page.goto(project + '/receipts?upload=1');
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill((await readFile(passwordPath, 'utf8')).trim());
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const picker = page.locator('input[type=file]').first();
  await picker.setInputFiles(files);
  const before = (await (await context.request.get(receipts)).json()).receipts;
  const posted = page.waitForResponse((response) => new URL(response.url()).pathname === receipts && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Начать передачу|Передать и начать|Загрузить и начать/u }).click();
  const receipt = await posted;
  assert.equal(receipt.status(), 201);
  for (let count = 0; count < 90 && !report.receiptId; count++) {
    const { receipts: after } = await (await context.request.get(receipts)).json();
    const added = after.filter(({ receiptId }) => !before.some((row) => row.receiptId === receiptId));
    assert.ok(added.length <= 1);
    report.receiptId = added[0]?.receiptId;
    if (!report.receiptId) await new Promise((listen) => setTimeout(listen, 1000));
  }
  assert.ok(report.receiptId);
  const inventoryPath = '/api/receipts/' + report.receiptId + '/inventory';
  let inventory;
  for (let count = 0; count < 90; count++) {
    const read = await context.request.get(inventoryPath);
    assert.equal(read.status(), 200);
    inventory = await read.json();
    if (inventory.sealed && inventory.occurrences.length === files.length && inventory.occurrences.every((item) => item.status === 'accepted')) break;
    await new Promise((listen) => setTimeout(listen, 1000));
  }
  assert.equal(inventory?.sealed, true);
  assert.equal(inventory.occurrences.length, files.length);
  for (const path of files) {
    const entry = inventory.occurrences.find(({ relativePath }) => relativePath === basename(path));
    assert.equal(entry?.status, 'accepted');
    const original = await context.request.get('/api/documents/' + entry.documentId + '/versions/' + entry.versionId + '/content');
    assert.equal(original.status(), 200);
    assert.equal(sha256(await original.body()), sha256(await readFile(path)));
    report.verifiedOriginals++;
  }
  await page.goto(project + '/receipts/' + report.receiptId);
  await page.getByRole('heading', { name: 'Опись', exact: true }).waitFor();
  report.complete = true;
} catch (error) {
  report.error = error.name;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(output, 'browser-receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { receiptId, ...publicReport } = report;
  console.log(JSON.stringify(publicReport));
}
