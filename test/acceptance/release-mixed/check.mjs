import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { intakeClient, submitOnce } from '../package-intake/intake-client.mjs';
import { mixedInputs } from './inputs.mjs';

const requireWeb = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium, expect: browserExpect } = requireWeb('@playwright/test');
const expect = browserExpect.configure({ timeout: 18_000 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (file, data) => writeFile(join(run, file), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const origin = process.env.FACADE_RELEASE_ORIGIN;
const run = process.env.FACADE_RELEASE_RUN;
const phase = process.argv[2];
const login = 'pkgintake_release';
assert.ok(['initial', 'restarted'].includes(phase));
const password = (await readFile(join(run, 'password'), 'utf8')).trim();
const catalog = JSON.parse(await readFile(new URL('../../../infra/catalogs/intake-stage-1.json', import.meta.url), 'utf8'));
const signedPdfSha = sha(await readFile(new URL('../../fixtures/input/facade-package.pdf', import.meta.url)));
const client = await intakeClient(origin, login, password);
const controls = new Map([
  ['doc.facades', [
    { label: 'mtext.dwg', quote: /FACADE RIB(?:\s|\^J)+67\.25 mm/i, at: ({ space, derivativeHandle, entityOrdinal }) => space === 'Model' && (derivativeHandle || entityOrdinal) },
    { label: 'north.jpg', quote: /FACADE RIB\s+42\s+MM/i, at: ({ page }) => page === 1 },
  ]],
  ['doc.architecture', [{ label: 'north.jpg', quote: /FACADE NORTH/i, at: ({ page }) => page === 1 }]],
  ['doc.architecture_details', [{ label: 'scan.pdf', quote: /mixed construction sheet/i, at: ({ page }) => page === 1 }]],
  ['doc.facade_brief', [{ label: 'brief.pdf.sig', quote: /not included/i, at: ({ page, embeddedSha256 }) => page >= 1 && embeddedSha256 === signedPdfSha }]],
  ['doc.glazing', [{ label: 'schedule.doc', quote: /2\.40 mm/, at: ({ table, row, column }) => table === 1 && row === 2 && column === 3 }]],
]);
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

async function waitFor(label, read, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(1_000);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function originalUrl(item) {
  return `/api/documents/${item.documentId}/versions/${item.versionId}/content`;
}
function readerUrl(item) {
  return `/api/v1/documents/${item.documentId}/versions/${item.versionId}`;
}

async function inspectPublic(upload) {
  const { projectId, receiptId } = upload;
  const inventoryResponse = await client.call('GET', `/api/receipts/${receiptId}/inventory`, 200);
  const inventory = inventoryResponse.json;
  assert.equal(inventory.sealed, true);
  const byName = new Map(inventory.occurrences.map((item) => [item.relativePath, item]));
  assert.deepEqual([...byName.keys()].sort(), [
    'Thumbs.db', 'brief.pdf.sig', 'colour-swatch.png', 'detached.sig', 'mtext.dwg', 'north.jpg', 'scan.pdf', 'schedule.doc',
    'unreadable.doc',
  ]);
  for (const [name, item] of byName) {
    const source = upload.documents.find(({ occurrenceId }) => occurrenceId === item.occurrenceId);
    assert.equal(item.sha256, source?.sha256, name);
    const { bytes } = await client.call('GET', originalUrl(item), 200);
    assert.equal(sha(bytes), item.sha256, name);
  }
  const base = `/api/v1/projects/${projectId}`;
  const prepUrl = `${base}/receipts/${receiptId}/preparation`;
  if (phase === 'initial') {
    const prep = await waitFor('sealed package preparation', async () => {
      const { json } = await client.call('GET', prepUrl, 200);
      await write('preparation.json', json);
      return json.state === 'ready' && json.manifestId && json;
    }, 220_000);
    assert.equal(prep.items.length, byName.size);
    const details = new Map(prep.items.map((item) => [item.label, item]));
    for (const [name, format] of [['north.jpg', 'image'], ['colour-swatch.png', 'image'], ['scan.pdf', 'pdf'],
      ['schedule.doc', 'doc'], ['mtext.dwg', 'dwg'], ['brief.pdf.sig', 'sig']]) {
      assert.equal(details.get(name).state, 'available', name);
      assert.equal(details.get(name).format, format, name);
      assert.ok(details.get(name).readableParts > 0, name);
    }
    assert.equal(details.get('mtext.dwg').derivativeAvailable, true);
    for (const [name, reason] of [['Thumbs.db', 'windows_thumbnail_cache'], ['detached.sig', 'signature_detached']]) {
      const { kind, state, reason: actual, readableParts } = details.get(name);
      assert.deepEqual({ kind, state, reason: actual, readableParts }, { kind: 'technical', state: 'excluded', reason, readableParts: 0 });
    }
    assert.equal(details.get('unreadable.doc').state, 'unavailable');
    assert.equal(details.get('unreadable.doc').reason, 'doc_signature_invalid');
  }
  const review = await waitFor('the saved preliminary review', async () => {
    const { json } = await client.call('GET', `${base}/preliminary-package-reviews`, 200);
    const items = json.items.filter((item) => item.receiptId === receiptId);
    const current = items.find(({ isCurrent }) => isCurrent);
    if (!current?.scopeNote.includes('Текстовый индекс готов для всех доступных редакций')) return;
    assert.ok(items.length <= 2, 'at most one reassessment when the index completes');
    return current;
  }, phase === 'initial' ? 160_000 : 15_000);
  await write(`review-${phase}.json`, review);
  assert.equal(review.stage, catalog.defaultProfile.stage);
  assert.match(review.scopeNote, /Отсутствие не устанавливалось/iu);
  assert.match(review.draftText, /FACADE RIB/iu);
  assert.match(review.draftText, /mtext\.dwg[^.]*67\.25 mm/iu);
  assert.match(review.draftText, /north\.jpg[^.]*42 mm/iu);
  assert.match(review.draftText, /уточнить.*размер/iu);
  assert.equal(review.rows.length, 16);
  assert.ok(review.rows.every(row => row.analysis?.applicability?.reason && Array.isArray(row.analysis.properties)));
  const namedDetail = review.rows.find(row => row.key === 'doc.facades').analysis;
  assert.equal(namedDetail.properties[0].status, 'conflicting');
  assert.equal(namedDetail.properties[0].letter.kind, 'ask');
  assert.deepEqual(namedDetail.tensions[0].sides.map(side => side.sources[0].label), ['mtext.dwg','north.jpg']);
  assert.equal(review.rows.flatMap(row => row.analysis.properties).filter(property => property.letter.kind === 'ask').length, 1);
  assert.deepEqual(review.rows.map(({ key, title }) => ({ key, title })),
    catalog.requirements.map(({ key, part }) => ({ key, title: part })));
  for (const { key, status, sources } of review.rows) {
    const required = controls.get(key) ?? [];
    assert.equal(status, required.length ? 'partial' : 'unassessed', key);
    assert.equal(sources.length, required.length, key);
    for (const control of required) {
      const source = sources.find(({ label }) => label === control.label);
      assert.ok(source, `${key}: ${control.label}`);
      const received = byName.get(control.label);
      assert.equal(source.versionId, received.versionId);
      assert.equal(source.documentId, received.documentId);
      assert.equal(source.originalSha256, received.sha256);
      assert.match(source.quote, control.quote);
      const { unitId, lineId, address } = JSON.parse(source.anchor);
      assert.ok(unitId && lineId && address.unitId === unitId && address.locator && control.at(address.locator), JSON.stringify(source));
    }
  }

  const maps = {};
  for (const name of ['north.jpg', 'colour-swatch.png', 'scan.pdf', 'schedule.doc', 'mtext.dwg', 'brief.pdf.sig']) {
    const item = byName.get(name);
    const { json } = await client.call('GET', `${readerUrl(item)}/reader/units`, 200);
    assert.equal(json.source.sha256, item.sha256);
    assert.equal(json.source.versionId, item.versionId);
    assert.ok(json.units.length > 0, name);
    maps[name] = json;
  }
  assert.deepEqual(maps['scan.pdf'].units.map(({ locator }) => locator.page), [1, 2, 3]);
  assert.equal(maps['brief.pdf.sig'].units[0].locator.embeddedSha256, signedPdfSha);
  const derivatives = {};
  for (const [name, page] of [['north.jpg', 1], ['colour-swatch.png', 1], ['scan.pdf', 2], ['brief.pdf.sig', 1]]) {
    const url = `${readerUrl(byName.get(name))}/reader/pages/${page}`;
    const preview = await waitFor(`PNG preview of ${name}`, async () => {
      const result = await client.call('GET', url, [200, 503]);
      return result.response.status === 200 && result;
    }, 25_000);
    assert.equal(preview.response.headers.get('content-type'), 'image/png');
    assert.ok(preview.bytes.subarray(0, 8).equals(pngSignature));
    derivatives[name] = sha(preview.bytes);
  }
  const dwgUrl = `${readerUrl(byName.get('mtext.dwg'))}/dwg-derivative`;
  const { response, bytes } = await client.call('GET', dwgUrl, 200);
  const dwgSha = sha(bytes);
  assert.equal(response.headers.get('etag'), `"sha256-${dwgSha}"`);
  assert.ok(maps['mtext.dwg'].units.some(({ locator }) => locator.derivativeSha256 === dwgSha));
  assert.match(bytes.toString('utf8'), /FACADE RIB[\s\S]{0,40}67\.25 mm/i);
  await write(`public-${phase}.json`, { review, maps, derivatives, dwgSha });
  return { byName, maps, derivatives, dwgSha, review };
}

async function checkBrowser(upload, publicState) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.FACADE_CHROME_PATH ?? (existsSync(chrome) ? chrome : undefined);
  const browser = await chromium.launch({ executablePath, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage();
    const root = `${origin}/projects/${upload.projectId}`;
    await page.goto(`${origin}/login`);
    await page.getByLabel('Логин').fill(login);
    await page.getByLabel('Пароль').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/projects`);
    await page.goto(`${root}/completeness`);
    const table = page.getByRole('region', { name: 'Комплектность по требованиям' });
    await expect(table.getByRole('columnheader', { name: 'Что нашла система' })).toBeVisible();
    const matrixRows = table.locator('tbody tr[id^="matrix-row-"]');
    await expect(matrixRows).toHaveCount(16);
    for (const row of publicState.review.rows) {
      const item = matrixRows.filter({ has: page.getByRole('link', { name: row.title, exact: true }) });
      const required = controls.get(row.key) ?? [];
      await expect(item).toContainText(required.length ? 'Частично' : 'Не оценено');
      if (!required.length) continue;
      await item.getByRole('link', { name: `Сверить и решить · ${row.title}`, exact: true }).click();
      const details = table.getByRole('region', { name: row.title, exact: true });
      await expect(details.getByRole('form', { name: 'Решение инженера по требованию' })).toBeVisible();
      const evidence = details.getByRole('list', { name: 'Основания вывода' });
      for (const control of required) {
        await expect(evidence).toContainText(control.quote);
        const link = evidence.getByRole('link', { name: control.label, exact: true });
        const url = originalUrl(publicState.byName.get(control.label));
        await expect(link).toHaveAttribute('href', url + (control.label === 'scan.pdf' ? '#page=1' : ''));
        const actual = await page.request.get(origin + url);
        assert.equal(actual.status(), 200);
        assert.equal(sha(await actual.body()), publicState.byName.get(control.label).sha256);
      }
      if (row.key === 'doc.facades') {
        const property = details.getByRole('region', { name: 'Размер FACADE RIB' });
        await expect(property).toContainText('Есть противоречие');
        await expect(property).toContainText('Вопрос для письма');
        for (const control of required) {
          await expect(property.getByRole('link', { name: control.label, exact: true }))
            .toHaveAttribute('href', originalUrl(publicState.byName.get(control.label)));
        }
      }
      await details.getByRole('link', { name: 'Свернуть требование' }).click();
    }
    await page.goto(`${root}/letters`);
    const letter = page.getByRole('region', { name: 'Черновик письма по результатам проверки' });
    await expect(letter.getByLabel('Текст предварительного черновика')).toHaveValue(publicState.review.draftText);
    await expect(letter).toContainText(/Отсутствие не устанавливалось/iu);
    await letter.getByText('Основания вопросов письма', { exact: true }).click();
    const questionBasis = letter.getByRole('list', { name: 'Основания вопроса по свойству «Размер FACADE RIB»' });
    for (const control of controls.get('doc.facades')) {
      await expect(questionBasis.getByRole('link', { name: control.label, exact: true }))
        .toHaveAttribute('href', originalUrl(publicState.byName.get(control.label)));
    }
    await page.screenshot({ path: join(run, `letter-${phase}.png`) });
    if (phase === 'initial') {
      await page.goto(`${root}/receipts/${upload.receiptId}`);
      const prep = page.getByRole('region', { name: 'Подготовка документов к анализу' });
      await expect(prep.getByRole('heading', { name: 'Непрочитанные документы и ограничения приёма' })).toBeVisible();
      await expect(prep.getByText('unreadable.doc', { exact: true })).toBeVisible();
      await prep.getByText(/Служебные файлы Windows/).click();
      await expect(prep.getByText('Thumbs.db', { exact: true })).toBeVisible();
      await prep.getByText(/Файлы подписи/).click();
      await expect(prep.getByText('detached.sig', { exact: true })).toBeVisible();
      await expect(prep.getByText(/Действительность электронной подписи здесь не проверялась/)).toBeVisible();
      await prep.getByText(/Машиночитаемые версии DWG/).click();
      const download = prep.getByRole('link', { name: 'Скачать машиночитаемую версию', exact: true });
      const url = `${readerUrl(publicState.byName.get('mtext.dwg'))}/dwg-derivative`;
      await expect(download).toHaveAttribute('href', url);
      assert.equal(sha(await (await page.request.get(origin + url)).body()), publicState.dwgSha);
      await page.screenshot({ path: join(run, 'receipt-initial.png') });
    }
  } finally {
    await browser.close();
  }
}

try {
  let upload;
  if (phase === 'initial') {
    const directory = await mixedInputs(run);
    await client.call('POST', '/api/catalogs', 201, catalog);
    const { json: project } = await client.call('POST', '/api/projects', 201,
      { name: 'Контрольный смешанный пакет', mode: 'intake' });
    assert.equal(project.stage, catalog.defaultProfile.stage);
    upload = await submitOnce(client, project.id, directory);
    await write('upload.json', upload);
  } else {
    upload = JSON.parse(await readFile(join(run, 'upload.json'), 'utf8'));
  }

  const current = await inspectPublic(upload);
  if (phase === 'restarted') {
    const prior = JSON.parse(await readFile(join(run, 'public-initial.json'), 'utf8'));
    assert.deepEqual({ review: current.review, maps: current.maps, derivatives: current.derivatives, dwgSha: current.dwgSha }, prior);
  }
  await checkBrowser(upload, current);
  const attempts = (await readdir(join(run, 'state'))).filter((name) => name.endsWith('.json'));
  assert.equal(attempts.length, 1, 'expect one local synthetic answer for this receipt');
  const primaryJournal = JSON.parse(await readFile(join(run, 'state', attempts[0]), 'utf8'));
  assert.equal(primaryJournal.state, 'published');
  const addressed = join(run, 'state', 'addressed', upload.receiptId);
  const reassessmentFiles = await readdir(addressed).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const complete = primaryJournal.snapshot.indexCoverage.pendingVersions === 0;
  const responses = await Promise.all(reassessmentFiles.filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(join(addressed,name),'utf8'))));
  assert.ok(responses.length <= 1, 'expect at most one index completion attempt');
  const completedAttempt = complete ? primaryJournal : responses.find(item => item.state === 'published');
  assert.ok(completedAttempt, 'expect a published result with complete index coverage');
  assert.equal(primaryJournal.result.rows.length,16);
  const journal = completedAttempt.snapshot ? completedAttempt : primaryJournal;
  const result = journal.result ?? JSON.parse(journal.response.choices[0].message.tool_calls[0].function.arguments);
  const responseChars = JSON.stringify(result).length;
  assert.equal(result.rows.length,journal.snapshot.requirements.length);
  assert.ok(JSON.stringify(primaryJournal.result).length < 55_000 && responseChars < 55_000);
  await write(`review-transport-${phase}.json`, {
    primaryResponseChars:JSON.stringify(primaryJournal.result).length, primaryRequestBytes:primaryJournal.snapshot.budget?.requestBytes,
    primaryProviderElapsedMs:primaryJournal.transport?.providerElapsedMs, responseChars,requestBytes:journal.snapshot.budget?.requestBytes,
    providerElapsedMs:journal.transport?.providerElapsedMs,
  });
  for (const [path, reason] of [['scan.pdf', 'pdf_non_native_unreviewed'], ['colour-swatch.png', 'raster_ocr_empty'],
    ['unreadable.doc', 'doc_signature_invalid']]) {
    assert.ok(journal.snapshot.unread.some((entry) =>
      entry.path === path && (entry.reason === reason || entry.reasons?.includes(reason))), `${path}: ${reason}`);
  }
  console.log(`PASS ${phase}: receipt, hashes, catalog, sources, limits, previews, draft and DWG derivative`);
} finally {
  await write(`http-${phase}.json`, client.http);
}
