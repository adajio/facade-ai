import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';

const runDatabase = process.env.LETTERS_TEST_DB === '1';
const out = process.env.LETTERS_TEST_BUILD ?? new URL('../../../dist/', import.meta.url).pathname;
const load = (module) => import(pathToFileURL(resolve(out, 'src/modules', module)));

const golden = [
  'Запрос исходных данных',
  'Кому: ООО «Заказчик»',
  '1. Фасад А. Узлы. Не получен материал в требуемом формате (pdf). Основание: «Опись.pdf», стр. 1. Просим предоставить Узлы.',
  '2. Фасад А. AL-01, толщина. Значения расходятся, в источнике «Спецификация R2.pdf», стр. 3 указано 2 мм, а в источнике «Задание R1.pdf», стр. 1 указано 0,003 м. Просим подтвердить значение для «AL-01, толщина».',
].join('\n\n');

function extractDocx(bytes) {
  const extractor = `
import sys, io, zipfile
import xml.etree.ElementTree as ET

with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as document:
    assert document.testzip() is None
    assert '[Content_Types].xml' in document.namelist()
    root = ET.fromstring(document.read('word/document.xml'))
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
base = '{' + ns['w'] + '}'
lines = [''.join((word.text or '') if word.tag == base + 't' else '\\t' if word.tag == base + 'tab' else ''
                 for word in paragraph.iter()) for paragraph in root.findall('w:body/w:p', ns)]
sys.stdout.buffer.write('\\n'.join(lines).encode('utf-8'))
`;
  const result = spawnSync('python3', ['-c', extractor], { input: bytes, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

test('DOCX сохраняет абзацы, кириллицу, табуляцию и XML-символы TXT', async () => {
  const { renderDocument } = await load('letters/content.js');
  const text = 'Проверка А и Б\n\n\t & <2 мм> ';
  assert.equal((await renderDocument('txt', text)).toString('utf8'), text);
  assert.equal(extractDocx(await renderDocument('docx', text)), text);
});

test('Адрес письма берётся из закреплённой опоры', async () => {
  const { renderGround } = await load('letters/grounds.js');
  const basis = {
    scope: { name: 'Фасад А' }, subject: 'Узлы', part: 'Узлы',
    kind: 'confirmed_missing', requestedAction: 'Предоставить узлы', requiredFormats: ['pdf'],
  };
  const incomplete = {
    label: 'Реестр N05.txt',
    address: { unitId: 'lines:1', locator: { firstLine: 1, lastLine: 3 } },
  };
  const fallback = renderGround({ ...basis, citations: [incomplete] });
  assert.equal(fallback.sources[0].label, '«Реестр N05.txt»');
  const actual = {
    ...incomplete,
    address: { unitId: 'lines:1', locator: { firstLine: 1, lastLine: 3, line: 2 } },
    deliveryStatement: { status: 'not_delivered', item: 'Узлы' },
    documentRevision: { label: 'N05', quote: 'Фасад А · РД · N05', address: { unitId: 'lines:1', locator: { line: 1 } } },
  };
  const missing = renderGround({ ...basis, citations: [actual] });
  assert.equal(missing.sources[0].label, '«Реестр N05.txt», ред. N05, строка 2');
  assert.deepEqual(missing.sources[0].address, actual);
  assert.match(missing.wording, /ред\. N05, строка 2/u);

  const conflict = renderGround({ ...basis, kind: 'confirmed_conflict', citations: [
    { label: 'Чертёж.pdf', address: { locator: { page: 1 } }, value: '19', unit: 'мм' },
    { label: 'Ведомость.docx', address: { locator: { table: 1, row: 2, column: 2 } }, value: '26', unit: 'мм' },
  ] });
  assert.deepEqual(conflict.sources.map(({ label }) => label), [
    '«Чертёж.pdf», стр. 1', '«Ведомость.docx», табл. 1, строка 2, столбец 2',
  ]);
  assert.match(conflict.wording, /стр\. 1 указано 19 мм[\s\S]*столбец 2 указано 26 мм/u);
});

test('AC06, R02 и блокировка текущего экспорта через HTTP и PostgreSQL', { skip: !runDatabase, timeout: 420_000 }, async (t) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const origin = 'http://localhost:3000';
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  const modules = await Promise.all([
    load('access/index.js'), load('access/auth.js'), load('letters/index.js'), load('assessment/index.js'),
    load('intake/gate.js'),
  ]);
  const [access, auth, letters, assessment, intake] = modules;
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('config', { dataDir: process.env.FACADE_DATA_DIR });
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500;
    reply.code(status).send({ code: error.code, message: error.message, requestId: request.id });
  });
  t.after(async () => {
    await app.close();
    await db.end();
  });
  await app.register(access.register);
  await app.register(assessment.register);
  await app.register(letters.register);
  await app.ready();

  const ids = await seed(db, auth);
  t.diagnostic('Подготовлены синтетический каталог, области и адреса');
  const { projectId, scopeId, actorId, receiptId } = ids;
  const recipient = 'ООО «Заказчик»';

  async function login(name) {
    const response = await app.inject({
      method: 'POST', url: '/api/sessions', headers: { origin },
      payload: { login: ids[name], password: ids.password },
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      'x-csrf-token': response.json().csrfToken,
    };
  }
  const engineer = await login('engineer');
  const viewer = await login('viewer');
  const outsider = await login('outsider');
  function call(method, url, { payload, as = engineer, version, key } = {}) {
    const headers = { origin, ...as };
    if (version !== undefined) headers['if-match'] = `"${version}"`;
    if (method !== 'GET') headers['idempotency-key'] = key ?? randomUUID();
    return app.inject({ method, url, headers, payload });
  }
  async function json(statusCode, method, url, options) {
    const response = await call(method, url, options);
    assert.equal(response.statusCode, statusCode, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json();
  }

  const assessments = `/api/projects/${projectId}/assessments/current`;
  const base = `/api/projects/${projectId}/letters`;
  const readAssessment = (scope) => json(200, 'GET', `${assessments}?scopeId=${scope}`);
  async function conclude(scope, startWork, outcome) {
    const snapshot = await readAssessment(scope);
    assert.equal(snapshot.outcome, outcome);
    await json(201, 'POST', `/api/projects/${projectId}/conclusions`, {
      version: snapshot.version, payload: { scopeId: scope, startWork, reason: 'Синтетическая проверка' },
    });
    assert.equal((await readAssessment(scope)).conclusion.startWork, startWork);
  }
  function review(findings, inventory) {
    return { findings, completenessChecked: true, remaining: [], ...(inventory ? { inventory } : {}) };
  }
  const initial = await readAssessment(scopeId);
  const byPart = Object.fromEntries(initial.questions.map((question) => [question.requirement.part, question]));
  const covered = await readAssessment(ids.coveredScope);
  const coveredId = covered.questions.find((question) => question.requirement.part === 'AL-01, толщина').id;
  const inventory = {
    assessmentId: randomUUID(), kind: 'explicit_non_delivery', receiptIds: [receiptId],
    currentCompositionChecked: true, alternativesChecked: true,
  };
  const absence = ['A', 'B'].map((branch) => evidence(ids, 'inventory', branch, 1));
  let values = [evidence(ids, 'spec', 'A', 3, '2', 'мм'), evidence(ids, 'task', 'B', 1, '0,003', 'м')];

  async function update(scope, changes, reason) {
    await access.transaction(db, async (tx) => {
      for (const { review } of changes) {
        for (const finding of review?.findings ?? []) {
          await publishEvidence(tx, ids, scope, finding.citation);
        }
      }
      await assessment.applyAssessmentUpdate(tx, { projectId, scopeId: scope, eventId: randomUUID(), reason, changes });
    });
  }
  function confirm(question) {
    return json(201, 'POST', `/api/questions/${question.id}/decisions`, {
      version: question.version, payload: { action: 'confirm', reason: 'Сверено для автопроверки', requestExternal: true },
    }).then(({ id, version }) => ({ questionId: question.id, questionVersion: version, decisionId: id }));
  }

  const matching = [evidence(ids, 'spec', 'A', 3, '2', 'мм'), evidence(ids, 'spec', 'B', 3, '2', 'мм')];
  await update(ids.coveredScope, [
    { questionId: coveredId, review: review(matching) },
    { questionId: covered.questions.find((question) => question.requirement.part === 'Узлы').id,
      review: review(matching) },
  ], 'Комплект предоставлен');
  await conclude(ids.coveredScope, 'can_start', 'sufficient');
  await conclude(ids.reviewScope, 'cannot_start', 'needs_review');
  for (const scope of [ids.coveredScope, ids.reviewScope]) {
    const empty = await json(422, 'POST', base, { payload: { scopeId: scope, recipient, items: [] } });
    assert.equal(empty.code, 'no_eligible_items');
  }
  const { rows: [counts] } = await db.query(`
    SELECT (SELECT count(*) FROM letters WHERE project_id = $1)::int AS letters,
           (SELECT count(*) FROM letter_counters WHERE project_id = $1)::int AS counters,
           (SELECT count(*) FROM letter_exports e JOIN letters l ON l.id = e.letter_id WHERE l.project_id = $1)::int AS exports
  `, [projectId]);
  assert.deepEqual(counts, { letters: 0, counters: 0, exports: 0 });
  t.diagnostic('Разные заключения без письма, номера и экспортов');

  await update(scopeId, [
    { questionId: byPart.Узлы.id, review: review(absence, inventory) },
    { questionId: byPart['AL-01, толщина'].id, review: review(values) },
  ], 'Результат контролируемых чтений');
  const checked = await readAssessment(scopeId);
  const selected = [];
  for (const part of ['Узлы', 'AL-01, толщина']) {
    selected.push(await confirm(checked.questions.find((question) => question.requirement.part === part)));
  }
  const eligible = await json(200, 'GET', `${base}/eligible?scopeId=${scopeId}`);
  assert.equal(eligible.items.length, 2);

  const create = { payload: { scopeId, recipient, items: selected }, key: randomUUID() };
  const [letter, duplicate] = await Promise.all([json(201, 'POST', base, create), json(201, 'POST', base, create)]);
  assert.deepEqual(letter, duplicate);
  assert.equal(letter.number, 1);
  const letterPath = `/api/letters/${letter.id}`;
  const revisionPath = `${letterPath}/revisions/${letter.revisionId}`;
  assert.equal((await json(200, 'GET', `${letterPath}/current-text`, { version: 1 })).text, golden);
  const original = await json(200, 'GET', revisionPath);
  assert.equal(original.textSha256, digest(golden));
  assert.equal(original.items.length, 2);

  const files = await Promise.all(['txt', 'docx'].map((format) =>
    json(201, 'POST', `${letterPath}/exports`, { version: 1, payload: { format } })));
  const [txt, docx] = await Promise.all(files.map(({ url }) => call('GET', url, { as: viewer })));
  assert.equal(txt.statusCode, 200);
  assert.equal(txt.rawPayload.toString('utf8'), golden);
  assert.equal(docx.statusCode, 200);
  assert.equal(extractDocx(docx.rawPayload), golden);
  t.diagnostic('TXT, DOCX и текущая редакция совпали с эталоном');
  assert.equal((await call('GET', files[1].url, { as: outsider })).statusCode, 404);
  assert.equal((await call('POST', `${letterPath}/exports`, { as: viewer, version: 1, payload: { format: 'txt' } })).statusCode, 403);
  const changed = original.items[1].wording.replace('2 мм', '20 мм');
  const patch = { version: 1, payload: { items: [{ questionId: selected[1].questionId, wording: changed }] }, key: randomUUID() };
  const draft = await json(200, 'PATCH', letterPath, patch);
  assert.equal(draft.status, 'draft');
  assert.equal((await json(200, 'GET', `${letterPath}/revisions/${draft.revisionId}`)).items[1].editedWording, changed);
  assert.equal((await call('GET', `${letterPath}/revisions/${draft.revisionId}`, { as: viewer })).statusCode, 404);
  assert.equal((await json(422, 'GET', `${letterPath}/current-text`, { version: 2 })).code, 'letter_unconfirmed');
  assert.equal((await json(422, 'POST', `${letterPath}/confirm`, { version: 2, payload: { items: selected } })).code, 'letter_wording_not_supported');
  assert.equal((await call('GET', files[0].url)).statusCode, 412);
  assert.deepEqual(await json(200, 'PATCH', letterPath, patch), draft);
  assert.equal((await json(409, 'PATCH', letterPath, { ...patch, payload: { layout: 'brief' } })).code, 'idempotency_conflict');

  const changedReview = markWording(changed, original.items[1], { scope: 'Фасад А', action: 'Просим подтвердить', values: ['20 мм', '0,003 м'] });
  const wrongValue = await json(422, 'POST', `${letterPath}/confirm`, {
    version: draft.version, payload: { items: [selected[0], { ...selected[1], review: changedReview }] },
  });
  assert.deepEqual([wrongValue.code, wrongValue.field], ['letter_wording_basis_mismatch', 'value']);

  const oppositeScope = original.items[1].wording.replace('Фасад А', 'Фасад Б');
  const opposite = await json(200, 'PATCH', letterPath, {
    version: draft.version, payload: { items: [{ questionId: selected[1].questionId, wording: oppositeScope }] },
  });
  const oppositeReview = markWording(oppositeScope, original.items[1], {
    scope: 'Фасад Б', action: 'Просим подтвердить', values: ['2 мм', '0,003 м'],
  });
  const wrongScope = await json(422, 'POST', `${letterPath}/confirm`, {
    version: opposite.version, payload: { items: [selected[0], { ...selected[1], review: oppositeReview }] },
  });
  assert.deepEqual([wrongScope.code, wrongScope.field], ['letter_wording_basis_mismatch', 'scope']);

  const authorText = 'По фасаду А остался открытым вопрос о проектной величине (толщина AL-01). '
    + 'В заявке видим 0.003 м («Задание R1.pdf», стр. 1), в спецификации — 2 мм («Спецификация R2.pdf», стр. 3). '
    + 'Подтвердите, пожалуйста, какое значение брать для рабочей документации.';
  const changedUnitText = authorText.replace('2 мм (', '2 ммоль (');
  const changedUnitDraft = await json(200, 'PATCH', letterPath, {
    version: opposite.version, payload: { items: [{ questionId: selected[1].questionId, wording: changedUnitText }] },
  });
  const authorMarks = { scope: 'фасаду А', subject: 'толщина AL-01', action: 'Подтвердите, пожалуйста', values: ['2 мм', '0.003 м'] };
  const rejectedUnit = await json(422, 'POST', `${letterPath}/confirm`, {
    version: changedUnitDraft.version,
    payload: { items: [selected[0], { ...selected[1], review: markWording(changedUnitText, original.items[1], authorMarks) }] },
  });
  assert.deepEqual([rejectedUnit.code, rejectedUnit.field], ['letter_wording_basis_mismatch', 'value']);
  const authorDraft = await json(200, 'PATCH', letterPath, {
    version: changedUnitDraft.version, payload: { items: [{ questionId: selected[1].questionId, wording: authorText }] },
  });
  const pendingReview = await json(422, 'POST', `${letterPath}/confirm`, {
    version: authorDraft.version, payload: { items: selected },
  });
  assert.equal(pendingReview.code, 'letter_wording_not_supported');
  const authorItem = (await json(200, 'GET', `${letterPath}/revisions/${authorDraft.revisionId}`)).items[1];
  const authorReview = markWording(authorText, original.items[1], authorMarks);
  assert.equal(authorItem.wordingSha256, authorReview.wordingSha256);
  const oldHash = await json(412, 'POST', `${letterPath}/confirm`, {
    version: authorDraft.version, payload: { items: [selected[0], { ...selected[1],
      review: { ...authorReview, wordingSha256: oppositeReview.wordingSha256 },
    }] },
  });
  assert.equal(oldHash.code, 'letter_wording_review_stale');
  const reviewed = await json(200, 'POST', `${letterPath}/confirm`, {
    version: authorDraft.version, payload: { items: [selected[0], { ...selected[1], review: authorReview }] },
  });
  const reviewedRevision = await json(200, 'GET', `${letterPath}/revisions/${reviewed.revisionId}`);
  assert.equal(reviewedRevision.items[1].wordingApproval.actorId, actorId);
  assert.equal(reviewedRevision.items[1].wordingApproval.wordingSha256, digest(authorText));
  const expectedAuthor = golden.slice(0, golden.indexOf('2. Фасад А.')) + '2. ' + authorText;
  assert.equal((await json(200, 'GET', `${letterPath}/current-text`, { version: reviewed.version })).text, expectedAuthor);
  for (const format of ['txt', 'docx']) {
    const entry = await json(201, 'POST', `${letterPath}/exports`, { version: reviewed.version, payload: { format } });
    const exported = await call('GET', entry.url);
    assert.equal(exported.statusCode, 200);
    assert.equal(format === 'txt' ? exported.rawPayload.toString('utf8') : extractDocx(exported.rawPayload), expectedAuthor);
  }
  t.diagnostic('Авторский текст выпущен в обоих форматах. Подмена числа и области отклонена с переданной сверкой.');
  const changedAgain = await json(200, 'PATCH', letterPath, {
    version: reviewed.version, payload: { items: [{ questionId: selected[1].questionId, wording: changed }] },
  });
  const changedAgainItem = (await json(200, 'GET', `${letterPath}/revisions/${changedAgain.revisionId}`)).items[1];
  assert.equal(changedAgainItem.wordingApproval, undefined);

  // Admit the new wording only after a new grounded decision on the changed value.
  values = [evidence(ids, 'specUpdated', 'A', 3, '20', 'мм'), values[1]];
  await update(scopeId, [{ questionId: selected[1].questionId, review: review(values) }], 'Новая оценка толщины');
  const revisedAssessment = await readAssessment(scopeId);
  const newGround = await confirm(revisedAssessment.questions.find((question) => question.id === selected[1].questionId));
  const approved = await json(200, 'POST', `${letterPath}/confirm`, { version: changedAgain.version, payload: { items: [selected[0], newGround] } });
  const textBeforeHold = await json(200, 'GET', `${letterPath}/current-text`, { version: approved.version });
  assert.equal(textBeforeHold.text, golden.replace('2 мм', '20 мм'));
  const activeFile = await json(201, 'POST', `${letterPath}/exports`, { version: approved.version, payload: { format: 'txt' } });

  // A download reaches the same lock while the intake transaction is still open.
  const intakeTx = await db.connect();
  let download;
  let hold;
  let committed = false;
  try {
    await intakeTx.query('BEGIN');
    const { rows: [{ pid }] } = await intakeTx.query('SELECT pg_backend_pid() AS pid');
    await intake.lockIntakeProject(intakeTx, projectId);
    await access.lockProjectScopes(intakeTx, projectId, [scopeId]);
    hold = await intake.createHold(intakeTx, { projectId, receiptId, source: 'upload', sourceId: randomUUID(), scopeIds: [scopeId] });
    download = call('GET', activeFile.url);
    await waitForAdmissionLock(db, pid);
    await intakeTx.query('COMMIT');
    committed = true;
  } finally {
    try {
      if (!committed) await intakeTx.query('ROLLBACK');
    } finally {
      intakeTx.release();
    }
  }
  const heldDownload = await download;
  assert.equal(heldDownload.statusCode, 409);
  assert.equal(heldDownload.json().code, 'scope_held');
  assert.equal((await json(409, 'GET', `${letterPath}/current-text`, { version: approved.version })).code, 'scope_held');

  const fact = { payload: {
    revisionId: original.id, itemIds: original.items.map(({ id }) => id), recipient, text: `Добрый день!\n\n${golden}`,
    sentAt: '2026-11-22T07:00:00+03:00',
  }, key: randomUUID() };
  const sent = await json(201, 'POST', `${letterPath}/sent`, fact);
  assert.deepEqual(await json(201, 'POST', `${letterPath}/sent`, fact), sent);
  const snapshot = await json(200, 'GET', sent.url, { as: viewer });
  assert.deepEqual(snapshot.items, original.items);
  assert.equal(snapshot.text, fact.payload.text);
  assert.equal(snapshot.textSha256, digest(fact.payload.text));
  assert.equal(snapshot.sentAt, '2026-11-22T04:00:00.000Z');
  assert.equal(snapshot.registeredBy, actorId);
  const historical = await call('GET', files[1].historicalUrl, { as: viewer });
  assert.equal(historical.headers['x-letter-historical'], 'true');
  assert.deepEqual(historical.rawPayload, docx.rawPayload);
  const refusal = await json(201, 'POST', `${letterPath}/responses`, {
    payload: { sentId: sent.id, itemId: original.items[0].id, kind: 'refusal', text: 'Узлы пока предоставить невозможно.',
      receivedAt: '2026-11-22T07:01:00+03:00' },
  });
  assert.equal((await json(200, 'GET', refusal.url)).kind, 'refusal');
  await access.transaction(db, (tx) => intake.resolveIntakeHold(tx, {
    projectId, holdId: hold.id, generation: hold.generation, version: hold.version, scopeIds: null,
  }));
  assert.equal((await call('GET', activeFile.url)).statusCode, 200);
  const delivered = [evidence(ids, 'spec', 'A', 3, '2', 'мм'), evidence(ids, 'spec', 'B', 3, '2', 'мм')];
  await update(scopeId, [{ questionId: selected[0].questionId, review: review(delivered) }], 'Узлы получены');
  assert.equal((await json(412, 'GET', activeFile.url)).code, 'letter_basis_stale');
  const remaining = await json(200, 'GET', `${base}/eligible?scopeId=${scopeId}`);
  assert.deepEqual(remaining.items.map(({ decisionId }) => decisionId), [newGround.decisionId]);
  const next = await json(201, 'POST', base, { payload: { scopeId, recipient, items: [newGround] } });
  assert.equal(next.number, 2);
  const nextRevision = await json(200, 'GET', `/api/letters/${next.id}/revisions/${next.revisionId}`);
  assert.deepEqual(nextRevision.items.map(({ questionId }) => questionId), [newGround.questionId]);
  assert.deepEqual((await json(200, 'GET', sent.url)).items, original.items);
  await db.query('DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2', [projectId, ids.viewerId]);
  assert.equal((await call('GET', files[1].historicalUrl, { as: viewer })).statusCode, 404);
});

function markWording(wording, item, { scope, subject = item.subject, action, values }) {
  const range = (excerpt) => {
    const start = wording.indexOf(excerpt);
    assert.notEqual(start, -1, excerpt);
    return { start, end: start + excerpt.length };
  };
  return {
    wordingSha256: digest(wording),
    scope: range(scope), subject: range(subject), action: range(action),
    citations: item.sources.map(({ address, label }, index) => ({
      observationId: address.observationId, reference: range(label),
      ...(values[index] && { value: range(values[index]) }),
    })),
  };
}

async function waitForAdmissionLock(db, blockingPid) {
  const deadline = Date.now() + 5_000;
  do {
    const { rows: [{ waiting }] } = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))
      ) AS waiting
    `, [blockingPid]);
    if (waiting) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail('Текущий экспорт не дождался транзакции приёма');
}

async function seed(db, auth) {
  const organization = await insert(db, 'INSERT INTO organizations(name) VALUES ($1) RETURNING id', ['Автотест писем']);
  const suffix = randomUUID().slice(0, 8);
  const names = { engineer: `letters-engineer-${suffix}`, viewer: `letters-viewer-${suffix}`, outsider: `letters-outsider-${suffix}` };
  const password = `Synthetic-${randomUUID()}`;
  const passwordHash = await auth.passwordHash(password);
  const users = [];
  for (const login of Object.values(names)) {
    users.push(await insert(db, `INSERT INTO users(organization_id, login, state, password_hash)
      VALUES ($1, $2, 'active', $3) RETURNING id`, [organization, login, passwordHash]));
  }
  const [actorId, viewerId] = users;
  const requirements = [['U1', 'Узлы'], ['AL-01', 'AL-01, толщина']].map(([key, part]) => ({
    key, part, formats: ['pdf'], equivalents: [], applicability: 'all',
    sourceRoles: ['project'], completenessCriterion: 'Все применимые исходные данные', addressee: 'ООО «Заказчик»',
  }));
  const catalogId = await insert(db, `INSERT INTO catalog_versions(organization_id, catalog_key, revision, name, requirements, created_by)
    VALUES ($1, 'test', 1, 'Синтетический каталог', $2, $3) RETURNING id`, [organization, JSON.stringify(requirements), actorId]);
  const projectId = await insert(db, `INSERT INTO projects(organization_id, name, catalog_version_id)
    VALUES ($1, 'Проверка писем', $2) RETURNING id`, [organization, catalogId]);
  await db.query(`INSERT INTO project_memberships(organization_id, project_id, user_id, role)
    VALUES ($1,$2,$3,'project_manager'), ($1,$2,$4,'viewer')`, [organization, projectId, actorId, viewerId]);
  const scopes = [];
  for (const scope of ['Фасад А', 'Фасад Б', 'Фасад В']) {
    scopes.push(await insert(db, `INSERT INTO project_scopes(project_id, stage, name) VALUES ($1, 'РД', $2) RETURNING id`, [projectId, scope]));
  }
  const [scopeId, coveredScope, reviewScope] = scopes;
  const receiptId = await insert(db, `INSERT INTO intake_receipts(project_id, source, created_by, sealed_at)
    VALUES ($1, 'upload', $2, now()) RETURNING id`, [projectId, actorId]);
  const documents = {};
  for (const [key, filename] of Object.entries({ inventory: 'Опись.pdf', spec: 'Спецификация R2.pdf', specUpdated: 'Спецификация R2.pdf', task: 'Задание R1.pdf' })) {
    const sha256 = digest(key);
    const originalId = await insert(db, `INSERT INTO intake_originals(id, project_id, sha256, size, object_key)
      VALUES (gen_random_uuid(), $1, $2, 100, $3) RETURNING id`, [projectId, sha256, randomUUID()]);
    const documentId = await insert(db, 'INSERT INTO intake_documents(project_id) VALUES ($1) RETURNING id', [projectId]);
    const versionId = await insert(db, `INSERT INTO intake_document_versions(project_id, document_id, original_id, media_type)
      VALUES ($1, $2, $3, 'application/pdf') RETURNING id`, [projectId, documentId, originalId]);
    await db.query(`INSERT INTO intake_occurrences(project_id, receipt_id, relative_path, declared_media_type, version_id, state)
      VALUES ($1, $2, $3, 'application/pdf', $4, 'accepted')`, [projectId, receiptId, filename, versionId]);
    await db.query(`INSERT INTO reader_maps(project_id, document_id, version_id, reader_version, receipt_id, original_sha256, format, units)
      VALUES ($1, $2, $3, 'test-reader', $4, $5, 'pdf', '[]')`, [projectId, documentId, versionId, receiptId, sha256]);
    documents[key] = { documentId, versionId, sha256 };
  }
  return { ...names, password, projectId, scopeId, coveredScope, reviewScope, actorId, viewerId, receiptId, documents };
}

async function insert(db, sql, params) {
  const result = await db.query(sql, params);
  return result.rows[0].id;
}

function evidence(ids, key, branch, page, value = null, unit = null) {
  const inventory = key === 'inventory';
  const observationId = randomUUID();
  const evidenceId = randomUUID();
  return {
    kind: inventory ? 'absence' : 'value', applicability: 'active',
    sourceRole: inventory ? 'inventory' : 'project', format: 'pdf', comparisonKey: 'AL-01',
    citation: {
      observationId, evidenceId, receiptId: ids.receiptId, ...ids.documents[key],
      address: { unitId: String(page), locator: { page } },
      quote: inventory ? 'Узлы в данную передачу не входят' : `${value} ${unit}`,
      value, unit, branch, href: `/api/evidence/${evidenceId}`,
    },
  };
}

async function publishEvidence(tx, ids, scopeId, citation) {
  const readerJob = randomUUID();
  const params = [citation.evidenceId, ids.projectId, citation.versionId, readerJob, citation.branch, citation.sha256];
  await tx.query(`INSERT INTO reader_evidence(id, project_id, version_id, reader_version, run_id, branch, operation_key, request_sha256, payload)
    VALUES ($1,$2,$3,'test-reader',$4,$5,'open',$6,'{}') ON CONFLICT (id) DO NOTHING`, params);
  const { id: runId } = (await tx.query('SELECT run_id AS id FROM reader_evidence WHERE id = $1', [citation.evidenceId])).rows[0];
  const observation = {
    ...citation, id: citation.observationId, grounding: 'exact',
    source: { projectId: ids.projectId, documentId: citation.documentId, versionId: citation.versionId, sha256: citation.sha256 },
  };
  await tx.query(`INSERT INTO reader_observations(id, project_id, version_id, run_id, branch, operation_key, request_sha256, evidence_id, scope_id, payload)
    VALUES ($1,$2,$3,$4,$5,'publish',$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`, [
    citation.observationId, ids.projectId, citation.versionId, runId, citation.branch,
    citation.sha256, citation.evidenceId, scopeId, JSON.stringify(observation),
  ]);
}
