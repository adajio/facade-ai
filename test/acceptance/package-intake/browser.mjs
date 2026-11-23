import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, baseUrl, login, passwordPath, inputDir, output, mode, resumeId] = process.argv.slice(2);
assert.ok(['baseline', 'candidate-ui', 'candidate'].includes(mode));
const isCandidate = mode !== 'baseline';
if (resumeId) assert.ok(mode === 'candidate-ui' && /^[a-f0-9-]{36}$/u.test(resumeId));
const origin = new URL(baseUrl).origin;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.match(login, /^pkgintake_[a-z\d_]+$/u);
assert.ok(!inputDir.split('/').includes('closed-oracle'));
const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright/index.mjs')).href);
const files = (await readdir(inputDir)).sort().map((name) => resolve(inputDir, name));
assert.ok(files.length >= 2 && files.some((name) => name.endsWith('.pdf')));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { platform: 'Chrome', mode, origin, loginPosts: 0, documents: [], screenshots: [], checks: {} };
const limit = 30_000;
let browser;
let phase = 'start';

try {
  process.env.TMPDIR = resolve(output, 'playwright-tmp');
  await mkdir(process.env.TMPDIR, { mode: 0o700 });
  browser = await chromium.launch({
    executablePath: process.env.FACADE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--disable-background-networking', '--no-first-run', '--disable-sync'],
  });
  const context = await browser.newContext({ baseURL: origin, acceptDownloads: false });
  context.setDefaultTimeout(limit);
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && !['about:', 'blob:', 'chrome-extension:'].includes(url.protocol)) return route.abort();
    if (url.pathname === '/api/sessions' && request.method() === 'POST') {
      if (++report.loginPosts !== 1) return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  phase = 'synthetic login';
  await page.goto('/projects');
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill((await readFile(passwordPath, 'utf8')).trim());
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('heading', { name: 'Проекты', exact: true }).waitFor();

  async function api(path, expected, options = {}) {
    const response = await context.request.fetch(path, options);
    const body = await response.json();
    assert.equal(response.status(), expected,
      `${options.method ?? 'GET'} ${path}: ${body.code ?? response.status()}`);
    return body;
  }
  const { csrfToken, projects } = await api('/api/me', 200);
  const { catalogs } = await api('/api/catalogs', 200);
  if (isCandidate) {
    assert.deepEqual(projects.map(({ id }) => id), resumeId ? [resumeId] : []);
    assert.deepEqual(catalogs, []);
  } else {
    assert.ok(projects.length < 2 && projects.every(({ name }) => /^Local QA [a-f0-9]{8}$/u.test(name)));
    assert.ok(catalogs.length < 2 && catalogs.every(({ key, name }) => key === 'baseline-local' && name === 'Baseline QA'));
  }
  const write = (method, data) => ({
    method, data, headers: { origin, 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() },
  });
  const newProject = 'Local QA ' + randomUUID().slice(0, 8);

  const form = page.locator('form').filter({ has: page.getByLabel('Название проекта', { exact: true }) });
  let projectId = projects[0]?.id;
  let request;
  if (projectId) {
    phase = 'resume the isolated project already created by the browser';
    await page.getByRole('link', { name: projects[0].name, exact: true }).click();
    if (resumeId) report.checks.previousCreation = '201 observed before browser navigation; continued from exact committed project';
  } else {
    phase = 'project with empty catalogs';
    await page.getByRole('button', { name: 'Создать проект', exact: true }).click();
    await form.getByLabel('Название проекта', { exact: true }).fill(newProject);
    if (mode === 'baseline') {
      let catalog = catalogs[0];
      if (!catalog) {
        await page.getByText('В организации пока нет доступных версий каталога.').waitFor();
        assert.equal(await form.getByRole('button', { name: 'Сохранить проект' }).isDisabled(), true);
        const refused = await context.request.post('/api/projects', write('POST', { mode: 'intake', name: newProject }));
        report.checks.legacyIntakePost = refused.status();
        assert.equal(refused.status(), 404);
        report.checks.projectWithoutCatalog = 'legacy blocked (form disabled and HTTP 404)';
        await page.screenshot({ path: resolve(output, 'legacy-empty-catalog.png'), fullPage: true });
        report.screenshots.push('legacy-empty-catalog.png');
        catalog = await api('/api/catalogs', 201, write('POST', { key: 'baseline-local', name: 'Baseline QA', requirements: [] }));
        await page.reload();
        await page.getByRole('button', { name: 'Создать проект', exact: true }).click();
        await form.getByLabel('Название проекта', { exact: true }).fill(newProject);
      }
      phase = 'legacy catalog fallback';
      await form.locator('select').selectOption({ value: catalog.id });
    }
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/projects' &&
      response.request().method() === 'POST');
    await form.getByRole('button', { name: /Сохранить проект|Создать проект|Создать и загрузить/u }).click();
    const projectResponse = await created;
    assert.equal(projectResponse.status(), 201);
    report.checks.projectCreateStatus = projectResponse.status();
    request = projectResponse.request().postDataJSON();
    await page.waitForURL(/\/projects\/[a-f0-9-]{36}\//u);
    projectId = new URL(page.url()).pathname.split('/')[2];
  }
  assert.match(projectId, /^[a-f0-9-]{36}$/u);
  const project = await api('/api/projects/' + projectId, 200);
  if (isCandidate) {
    if (!resumeId) {
      assert.equal(request.mode, 'intake');
      assert.ok(!request.catalogVersionId && !request.scopeName);
    }
    assert.deepEqual(project.scopes ?? [], []);
    assert.equal(project.catalogVersionId, null);
    assert.equal(project.stage, null);
    const stillEmpty = await api('/api/catalogs', 200);
    assert.deepEqual(stillEmpty.catalogs, []);
    report.checks.projectWithoutCatalog = 'verified zero catalogs and scopes on the browser-created project';
  }
  const scope = project.scopes?.[0]?.id;
  const projectPath = '/projects/' + projectId;

  phase = 'normal upload';
  await page.waitForURL((url) => url.pathname.startsWith(projectPath + '/'));
  const listing = '/api/projects/' + projectId + '/receipts';
  const before = await api(listing, 200);
  assert.ok(before.receipts.length < 2);
  let receiptId = before.receipts[0]?.receiptId;
  if (isCandidate) assert.equal(receiptId, undefined);
  if (isCandidate) {
    await page.getByRole('link', { name: 'Загрузить комплект', exact: true }).click();
    await page.waitForURL((url) => url.pathname === projectPath + '/receipts' && url.searchParams.get('upload') === '1');
  } else if (!receiptId) {
    await page.getByRole('link', { name: 'Поступления', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить поступление', exact: true }).click();
  }
  const picker = page.locator('input[type=file]').first();
  if (!receiptId) await picker.setInputFiles(files);
  let lostReply;
  let lostClosingReply;
  if (isCandidate) {
    lostReply = new Promise((resolve, reject) => {
      const noPart = setTimeout(() => reject(new Error('No upload part reached the server')), limit);
      void page.route(/\/api\/uploads\/[^/]+\/parts\/1$/u, async (route) => {
        try {
          const committed = await route.fetch({ maxRetries: 0 });
          assert.ok(committed.ok());
          await route.abort('connectionreset');
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(noPart);
        }
      }, { times: 1 }).catch(reject);
    });
    void lostReply.catch(() => {});
    let completionRequests = 0;
    await page.route(/\/api\/uploads\/[^/]+\/complete$/u, async (route) => {
      if (++completionRequests !== files.length) return route.continue();
      const committed = await route.fetch({ maxRetries: 0 });
      lostClosingReply = committed.status();
      await route.abort('connectionreset');
    });
  }
  if (!receiptId) {
    const receiptResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === listing && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Начать передачу|Передать и начать|Загрузить и начать/u }).click();
    const registration = await receiptResponse;
    assert.equal(registration.status(), 201);
    ({ receiptId } = await registration.json());
  }
  report.projectId = projectId;
  report.receiptId = receiptId;

  const inventoryRoute = '/api/receipts/' + receiptId + '/inventory';
  const receiptPath = projectPath + '/receipts/' + receiptId;
  if (lostReply) {
    phase = 'recover a confirmed part after the response was lost';
    await lostReply;
    const interrupted = await api(inventoryRoute, 200);
    assert.equal(interrupted.inventoryOpen, true);
    assert.ok(interrupted.uploads.some(({ confirmedBytes }) => confirmedBytes > 0));
    assert.equal(interrupted.manifest.items.length, files.length);
    const selected = interrupted.manifest.items.map(({ itemId }) => itemId).sort();
    await page.goto(receiptPath);
    await page.getByRole('heading', { name: 'Опись', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
    const transfer = page.getByRole('form', { name: 'Передача исходных данных', exact: true });
    await transfer.locator('input[type=file]').setInputFiles(files);
    await transfer.getByRole('button', { name: 'Продолжить передачу', exact: true }).click();
    report.manifestBeforeRetry = selected;
  }
  let inventory;
  const deadline = Date.now() + 180_000;
  do {
    inventory = await api(inventoryRoute, 200);
    if (inventory.occurrences.filter(({ status }) => status === 'accepted').length === files.length &&
        (!isCandidate || inventory.inventoryOpen === false)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.equal(inventory.occurrences.length, files.length);
  assert.equal(inventory.occurrences.filter(({ status }) => status === 'accepted').length, files.length);
  if (isCandidate) {
    assert.equal(inventory.inventoryOpen, false);
    assert.equal(inventory.sealed, true);
    assert.ok(lostClosingReply >= 200 && lostClosingReply < 300, 'did not lose the final committed 2xx');
    assert.deepEqual(inventory.manifest.items.map(({ itemId }) => itemId).sort(), report.manifestBeforeRetry);
    const { receipts } = await api(listing, 200);
    assert.equal(receipts.length, 1);
    report.checks.resumeSameReceipt = true;
    report.checks.finalReplyLostAfterCommit = lostClosingReply;
  }
  if (mode === 'candidate') {
    const assessment = await api('/api/v1/projects/' + projectId + '/facade-assessment', 200);
    assert.deepEqual(assessment.observations.counts, { identified: 0, common: 0, unclear: 0, unidentified: 0 });
    assert.ok(assessment.observations.href.startsWith('/api/v1/projects/' + projectId + '/'));
    assert.deepEqual((await api(assessment.observations.href, 200)).items, []);
    const snapshot = await api('/api/projects/' + projectId + '/snapshot', 200);
    assert.equal(snapshot.facadeAssessmentVersion, assessment.version);
    report.checks.zeroObservations = true;
    report.assessmentProjection = Object.keys(assessment).sort();
  }
  await page.goto(receiptPath + (scope ? '?scope=' + scope : ''));
  await page.getByRole('heading', { name: 'Опись', exact: true }).waitFor();

  phase = 'original bytes and selected PDF card';
  for (const file of files) {
    const item = inventory.occurrences.find(({ relativePath }) => relativePath === basename(file));
    assert.ok(item?.versionId && item.documentId);
    const path = '/api/documents/' + item.documentId + '/versions/' + item.versionId + '/content';
    const local = await readFile(file);
    const original = await context.request.get(path);
    assert.equal(original.status(), 200);
    assert.equal(hash(await original.body()), hash(local));
    if (file.endsWith('.pdf')) {
      const range = await context.request.get(path, { headers: { range: 'bytes=0-4' } });
      assert.equal(range.status(), 206);
      assert.equal((await range.body()).toString(), '%PDF-');
    }
    report.documents.push({ versionId: item.versionId, format: basename(file).split('.').at(-1), bytes: local.length });
  }
  const pdf = inventory.occurrences.find(({ relativePath }) => relativePath.endsWith('.pdf'));
  if (mode === 'candidate-ui') {
    const work = await api('/api/documents/' + pdf.documentId + '/versions/' + pdf.versionId + '/work', 200);
    assert.equal(work.catalogAssigned, false);
    assert.deepEqual(work.jobs, []);
    report.checks.pdfWorkBeforeReading = { mapReady: work.mapReady, catalogAssigned: work.catalogAssigned, jobs: 0 };
  }
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: pdf.relativePath, exact: true }) });
  const cardAction = isCandidate
    ? row.getByRole('link', { name: /Карточка|Открыть оригинал/u }).first()
    : row.getByRole('button', { name: 'Карточка документа', exact: true });
  await cardAction.click();
  await page.getByRole('heading', { name: pdf.relativePath, exact: true }).waitFor();
  if (isCandidate) {
    const current = new URL(page.url());
    assert.equal(current.pathname, receiptPath);
    assert.equal(current.searchParams.get('document'), pdf.versionId);
    assert.equal(current.searchParams.get('row'), pdf.occurrenceId);
    const pdfContentPath = '/api/documents/' + pdf.documentId + '/versions/' + pdf.versionId + '/content';
    const navigation = page.waitForResponse((response) => new URL(response.url()).pathname === pdfContentPath &&
      response.request().resourceType() === 'document' && [200, 206].includes(response.status()));
    await page.getByRole('button', { name: 'Открыть оригинал', exact: true }).click();
    await page.getByRole('heading', { name: 'Оригинал PDF', exact: true }).waitFor();
    const frame = page.locator('iframe[title^="Оригинал PDF"]');
    assert.match(await frame.getAttribute('src'), /#page=1$/u);
    const response = await navigation;
    assert.match(response.headers()['content-type'], /^application\/pdf/u);
    report.checks.pdfInlineDocument = response.status();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    report.checks.pdfViewerRetained = await frame.isVisible();
    report.checks.pdfViewerPageInUrl = new URL(page.url()).searchParams.get('page');
    if (report.checks.pdfViewerRetained) await frame.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'candidate-pdf-before-findings.png'), fullPage: true });
    report.screenshots.push('candidate-pdf-before-findings.png');
    await page.reload();
    await page.getByRole('heading', { name: pdf.relativePath, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Открыть оригинал', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('document'), pdf.versionId);
    assert.equal(new URL(page.url()).searchParams.get('row'), pdf.occurrenceId);
    report.checks.pdfViewerAfterReload = await frame.isVisible();
    await page.getByRole('link', { name: 'К описи', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.has('document'), false);
    assert.equal(new URL(page.url()).searchParams.get('row'), pdf.occurrenceId);
    await row.waitFor();
    report.checks.cardReload = true;
  } else {
    await page.reload();
    await page.getByRole('heading', { name: 'Опись', exact: true }).waitFor();
    report.checks.cardReload = await page.getByRole('heading', { name: pdf.relativePath, exact: true }).count() === 0
      ? 'legacy selection lost' : 'selection preserved';
  }
  report.checks.originalsByteIdentical = files.length;
  report.checks.pdfRange = 206;
  report.checks.inventoryOpen = inventory.inventoryOpen;
  report.complete = true;
} catch (error) {
  report.failedAt = phase;
  report.kind = error.name;
  report.detail = String(error.message).split('\n')[0];
  process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(resolve(output, 'browser-' + mode + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode, phase, loginPosts: report.loginPosts, complete: report.complete === true,
    ...(report.detail && { detail: report.detail }) }));
}
