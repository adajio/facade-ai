import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { chromium } from '../../web/node_modules/playwright/index.mjs';
import {
  applyImpact, compiled, completeUpload, declare, file, newReceipt, observations, queuedRace, review, setup, sha256,
} from './fixture.mjs';

const { inProjectionSnapshot, publishProjectEvent, readProjectionPosition } = await compiled('supplements/events.js');

function blocked(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body?.code, code);
}

const post = (data, version, key) => ({ method: 'POST', data, version, key });
const patch = (data, version) => ({ method: 'PATCH', data, version });
const confirm = (requestExternal) => ({ action: 'confirm', reason: 'Сверено по оригиналу', requestExternal });
const attachment = (assessment) => assessment.questions.find((item) => item.requirement.positionId === 'attachment');

async function allowedLetter(tab, base, scopeId, recipient, expectedItems) {
  const { items } = await tab.ok(`${base}/letters/eligible?scopeId=${scopeId}&recipient=${encodeURIComponent(recipient)}`);
  assert.equal(items.length, expectedItems);
  const letter = await tab.ok(`${base}/letters`, post({ scopeId, recipient, items: items.map((item) => ({
    questionId: item.questionId, questionVersion: item.questionVersion, decisionId: item.decisionId,
  })) }), 201);
  const path = `/api/letters/${letter.id}`;
  const getText = () => tab.request(`${path}/current-text`, { version: letter.version });
  const text = await tab.ok(`${path}/current-text`, { version: letter.version });
  return { ...letter, path, getText, text };
}

async function exportLetter(tab, letter, format) {
  const entry = await tab.ok(`${letter.path}/exports`, post({ format }, letter.version), 201);
  const bytes = await tab.ok(entry.url, { raw: true });
  return { ...entry, bytes };
}

async function projectionOrder(db, projectId, tab, base) {
  const before = await tab.ok(`${base}/snapshot`);
  const slow = await db.connect();
  const fast = await db.connect();
  try {
    await slow.query('BEGIN');
    await publishProjectEvent(slow, projectId, { type: 'test.slow', payload: {} });
    await fast.query('BEGIN');
    await publishProjectEvent(fast, projectId, { type: 'test.fast', payload: {} });
    await fast.query('COMMIT');

    const afterFast = await tab.ok(`${base}/events?after=${before.cursor}&limit=1`);
    assert.deepEqual(afterFast.events.map(({ type }) => type), ['test.fast']);
    await inProjectionSnapshot(db, async (tx) => {
      const captured = await readProjectionPosition(tx, projectId);
      await slow.query('COMMIT');
      assert.deepEqual(await readProjectionPosition(tx, projectId), captured);
    });
    const afterSlow = await tab.ok(`${base}/events?after=${afterFast.cursor}`);
    assert.deepEqual(afterSlow.events.map(({ type }) => type), ['test.slow']);

    await fast.query('BEGIN');
    await publishProjectEvent(fast, projectId, { type: 'test.rollback', payload: {} });
    await fast.query('ROLLBACK');
    assert.deepEqual(await tab.ok(`${base}/events?after=${afterSlow.cursor}`), {
      events: [], cursor: afterSlow.cursor, head: afterSlow.head, hasMore: false,
    });
    return afterSlow.head;
  } finally {
    await Promise.allSettled([slow.query('ROLLBACK'), fast.query('ROLLBACK')]);
    slow.release();
    fast.release();
  }
}

test('два сеанса, обе гонки допуска, курсор и история письма', { timeout: 240_000 }, async (t) => {
  const origin = process.env.FACADE_E2E_BASE_URL;
  const output = process.env.FACADE_E2E_OUTPUT;
  assert(origin && process.env.DATABASE_URL && process.env.FACADE_DATA_DIR && output,
    'Укажите адрес API, отдельную базу, каталог объектов и каталог протокола.');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const certificatePath = process.env.FACADE_E2E_STAND_TLS_CERT;
  const browserArgs = [];
  if (certificatePath) {
    const certificate = new X509Certificate(await readFile(certificatePath));
    const fingerprint = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    browserArgs.push(`--ignore-certificate-errors-spki-list=${fingerprint}`);
  }
  const browser = await chromium.launch({ channel: process.env.FACADE_E2E_BROWSER_CHANNEL || undefined, args: browserArgs });
  t.after(async () => { await browser.close(); await db.end(); });
  const { a, b, base, projectId, scopeA, scopeB, addressee, createCatalog, requirements } = await setup(db, browser, origin);
  const [originalFile, supplementFile] = await Promise.all([file('facade-package.pdf'), file('facade-supplement.pdf')]);
  const current = (scopeId) => a.ok(`${base}/assessments/current?scopeId=${scopeId}`);
  const projectSnapshot = () => a.ok(`${base}/snapshot`);
  const holdFor = async (holdId) => {
    const cause = (await projectSnapshot()).holds.find(({ id }) => id === holdId);
    assert(cause, 'expected active intake hold');
    return cause;
  };
  const updateScope = (hold, scopeIds) => b.ok(`${base}/supplements/holds/${hold.id}`, patch({ generation: hold.generation, scopeIds }, hold.version));
  const receiptId = await newReceipt(a, base);
  const declared = await declare(a, receiptId, originalFile, [scopeA, scopeB]);
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const source = { ...(await completeUpload(a, receiptId, declared.body, originalFile)), projectId, sha256: originalFile.sha256 };
  const initialHold = await holdFor(declared.body.holdId);
  const initialA = await current(scopeA);
  const initialB = await current(scopeB);
  const hintsA = await observations(db, source, scopeA, 'not included');
  const hintsB = await observations(db, source, scopeB, 'F-B');
  for (const [index, hint] of hintsA.entries()) {
    const tab = index === 0 ? a : b;
    const addressed = await tab.ok(`/api/v1/evidence/${hint.evidenceId}`);
    assert.equal(addressed.address.unitId, '1');
    assert.equal(addressed.source.sha256, originalFile.sha256);
    assert((await tab.ok(`/api/v1/evidence/${hint.evidenceId}/content`, { raw: true })).length > 0);
  }
  await applyImpact(db, projectId, initialHold, [
    { scopeId: scopeA, changes: initialA.questions.map((question) => review(question, initialA, hintsA, 'absence', receiptId)) },
    { scopeId: scopeB, changes: initialB.questions.map((question) => review(question, initialB, hintsB, 'absence', receiptId)) },
  ]);
  for (const scopeId of [scopeA, scopeB]) {
    for (const question of (await current(scopeId)).questions) {
      assert.equal(question.outcome, 'confirmed_missing');
      await a.ok(`/api/questions/${question.id}/decisions`, post(confirm(true), question.version), 201);
    }
  }
  await t.test('регистрация отправки и объявление досылки в обоих порядках', async (raceTest) => {
    const orders = [];
    for (const [registrationFirst, name] of [[true, 'регистрация отправки первая'], [false, 'объявление досылки первое']]) {
      await raceTest.test(name, async () => {
        const subject = await allowedLetter(a, base, scopeA, addressee, 2);
        const sentRevision = await a.ok(`${subject.path}/revisions/${subject.revisionId}`);
        const incoming = await newReceipt(b, base);
        const before = await projectSnapshot();
        const register = () => a.request(`${subject.path}/sent`, post({
          revisionId: subject.revisionId, recipient: addressee, itemIds: sentRevision.items.map(({ id }) => id),
          text: subject.text.text, sentAt: new Date().toISOString(),
        }));
        const upload = () => declare(b, incoming, supplementFile, [scopeA]);
        const [first, second] = await queuedRace(db, projectId, registrationFirst ? register : upload, registrationFirst ? upload : register);
        const [sent, intake] = registrationFirst ? [first, second] : [second, first];
        assert.equal(intake.status, 201, JSON.stringify(intake.body));

        let history;
        const historyUrl = `${subject.path}/sent/${sent.body?.id}`;
        try {
          assert.equal(sent.status, 201, JSON.stringify(sent.body));
          const { events } = await b.ok(`${base}/events?after=${before.cursor}`);
          const registered = events.find(({ type, payload }) => type === 'letter.sent' && payload.id === sent.body.id);
          const declared = events.find(({ type, payload }) => type === 'intake.upload_declared' && payload.receiptId === incoming);
          assert(registered && declared, 'Оба коммита должны быть видны в ленте проекта');
          assert.equal(BigInt(registered.cursor) < BigInt(declared.cursor), registrationFirst);
          blocked(await subject.getText(), 409, 'scope_held');
          history = await b.ok(historyUrl);
          assert.equal(history.historical, true);
          assert.equal(history.text, subject.text.text);
          assert.equal(history.textSha256, sha256(Buffer.from(subject.text.text)));
          assert.deepEqual(history.items.map(({ id }) => id), sentRevision.items.map(({ id }) => id));
          orders.push({ registrationFirst, registrationCursor: registered.cursor, intakeCursor: declared.cursor,
            items: history.items.length, textSha256: history.textSha256 });
        } finally {
          await b.ok(`/api/uploads/${intake.body.uploadId}/cancel`, post({}));
        }
        assert.equal((await a.ok(`${subject.path}/current-text`, { version: subject.version })).text, subject.text.text);
        assert.deepEqual(await a.ok(historyUrl), history);
      });
    }
    assert.equal(orders.length, 2);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'send-order.json'), JSON.stringify(orders, null, 2) + '\n');
  });
  const oldA = await current(scopeA);
  const oldQuestion = attachment(oldA);
  const letter = await allowedLetter(a, base, scopeA, addressee, 2);
  const independent = await allowedLetter(a, base, scopeB, addressee, 1);
  const [oldTxt, oldDocx] = await Promise.all([exportLetter(a, letter, 'txt'), exportLetter(a, letter, 'docx')]);
  assert.equal(oldTxt.bytes.toString('utf8'), letter.text.text);
  const revision = await a.ok(`${letter.path}/revisions/${letter.revisionId}`);
  assert.equal(revision.items.length, 2);
  await t.test('содержательная правка блокирует актуальный текст и выгрузку', async () => {
    const subject = await allowedLetter(a, base, scopeA, addressee, 2);
    const saved = await a.ok(`${subject.path}/revisions/${subject.revisionId}`);
    const proposed = 'Фасад Б, указать 20 мм';
    const written = await b.ok(subject.path, patch({ items: [{ questionId: oldQuestion.id, wording: proposed }] }, subject.version));
    const draft = await a.ok(`${subject.path}/revisions/${written.revisionId}`);
    assert.equal(draft.status, 'draft');
    assert(draft.text.includes(proposed));
    blocked(await a.request(`${subject.path}/current-text`, { version: written.version }), 422, 'letter_unconfirmed');
    blocked(await a.request(`${subject.path}/exports`, post({ format: 'txt' }, written.version)), 422, 'letter_unconfirmed');
    blocked(await b.request(`${subject.path}/confirm`, post({ items: saved.items.map(({ questionId, questionVersion, decisionId }) => ({
      questionId, questionVersion, decisionId,
    })) }, written.version)), 422, 'letter_wording_not_supported');
  });
  const positionBefore = await projectSnapshot();
  const sentAt = new Date().toISOString();

  await t.test('досылка фиксируется первой, два удержания и отложенная запись отправки', async (raceTest) => {
    const supplementReceipt = await newReceipt(b, base);
    assert.equal((await letter.getText()).status, 200, 'пустая квитанция не удерживает письмо');
    const [heldUpload, oldGet] = await queuedRace(db, projectId,
      () => declare(b, supplementReceipt, supplementFile),
      () => a.request(oldTxt.url),
    );
    assert.equal(heldUpload.status, 201, JSON.stringify(heldUpload.body));
    blocked(oldGet, 409, 'scope_held');
    blocked(await letter.getText(), 409, 'scope_held');
    blocked(await independent.getText(), 409, 'scope_held');
    blocked(await a.request(`/api/questions/${oldQuestion.id}/decisions`, post(confirm(true), oldQuestion.version)), 409, 'scope_held');
    blocked(await a.request(`${base}/conclusions`, post({ scopeId: scopeA, reason: 'Старая вкладка', startWork: 'cannot_start' }, oldA.version)), 409, 'scope_held');

    const unknown = await holdFor(heldUpload.body.holdId);
    const update = await updateScope(unknown, [scopeA]);
    blocked(await b.request(`${base}/supplements/holds/${unknown.id}`, patch({ generation: unknown.generation, scopeIds: [scopeA] }, unknown.version)), 412);
    assert.equal((await independent.getText()).status, 200);
    blocked(await letter.getText(), 409, 'scope_held');
    const resolveMessage = {
      generation: unknown.generation, reason: 'Проверено по перечню',
      impacts: [{ scopeId: scopeA, assessmentVersion: oldA.version, questionIds: [oldQuestion.id] }],
    };
    const resolvePath = `${base}/supplements/holds/${unknown.id}/resolve`;
    blocked(await b.request(resolvePath, post(resolveMessage, update.version)), 409, 'hold_material_pending');

    const sending = await a.ok(`${letter.path}/sent`, post({
      revisionId: letter.revisionId, itemIds: revision.items.map(({ id }) => id), recipient: addressee,
      text: letter.text.text, sentAt,
    }), 201);
    const linkBody = { receiptId: supplementReceipt, letterId: letter.id, sentId: sending.id,
      itemId: revision.items.find((item) => item.questionId === oldQuestion.id).id };
    const linkKey = randomUUID();
    const link = await b.ok(`${base}/supplements/links`, post(linkBody, undefined, linkKey), 201);
    const replay = await b.request(`${base}/supplements/links`, post(linkBody, undefined, linkKey));
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.body, link);
    blocked(await b.request(`${base}/supplements/links`, post({ ...linkBody, itemId: undefined }, undefined, linkKey)), 409, 'idempotency_conflict');
    blocked(await b.request(`${base}/supplements/links`, post({ ...linkBody, itemId: randomUUID() })), 404, 'not_found');
    const linkList = `${base}/supplements/links?receiptId=${supplementReceipt}`;
    assert.equal((await a.ok(linkList)).items.length, 1);
    await b.ok(`${base}/supplements/links`, post({ ...linkBody, itemId: undefined }), 201);
    const firstPage = await a.ok(`${linkList}&limit=1`);
    assert(firstPage.nextCursor);
    assert.equal((await a.ok(`${linkList}&limit=1&after=${firstPage.nextCursor}`)).items.length, 1);
    blocked(await a.request(`${base}/supplements/links?after=${firstPage.nextCursor}`), 409, 'snapshot_required');
    const historyUrl = `${letter.path}/sent/${sending.id}`;
    const historyBefore = await a.ok(historyUrl);
    assert.equal(historyBefore.text, oldTxt.bytes.toString('utf8'));
    assert.equal(historyBefore.items.length, 2);

    const abandonedReceipt = await newReceipt(b, base);
    const abandoned = await declare(b, abandonedReceipt, supplementFile, [scopeA]);
    assert.equal(abandoned.status, 201);
    assert.equal((await projectSnapshot()).holds.length, 2);
    const accepted = {
      ...(await completeUpload(b, supplementReceipt, heldUpload.body, supplementFile)),
      projectId, sha256: supplementFile.sha256,
    };
    const latest = await current(scopeA);
    blocked(await b.request(resolvePath, post({ ...resolveMessage, impacts: [{
      ...resolveMessage.impacts[0], assessmentVersion: latest.version + 1,
    }] }, update.version)), 412, 'assessment_input_stale');
    const hints = await observations(db, accepted, scopeA, 'Attachment detail', 'D-01');
    await applyImpact(db, projectId, { ...unknown, version: update.version }, [
      { scopeId: scopeA, changes: [review(attachment(latest), latest, hints, 'value', supplementReceipt)] },
    ]);
    blocked(await letter.getText(), 409, 'scope_held');
    assert.deepEqual((await projectSnapshot()).holds.map((hold) => hold.id), [abandoned.body.holdId]);
    await b.ok(`/api/uploads/${abandoned.body.uploadId}/cancel`, post({}));
    blocked(await letter.getText(), 412, 'letter_basis_stale');
    blocked(await a.request(`/api/questions/${oldQuestion.id}/decisions`, post(confirm(true), oldQuestion.version)), 412);
    const newA = await current(scopeA);
    assert.deepEqual(newA.change.affectedQuestionIds, [oldQuestion.id]);
    assert.equal(attachment(newA).outcome, 'covered');
    assert.equal((await independent.getText()).status, 200);
    await a.ok(`/api/questions/${oldQuestion.id}/decisions`, post(confirm(false), attachment(newA).version), 201);

    const newLetter = await allowedLetter(a, base, scopeA, addressee, 1);
    assert.match(newLetter.text.text, /AL-01/);
    assert.doesNotMatch(newLetter.text.text, /узел крепления/);
    const [newTxt, newDocx] = await Promise.all([exportLetter(a, newLetter, 'txt'), exportLetter(a, newLetter, 'docx')]);
    assert.equal(newTxt.bytes.toString('utf8'), newLetter.text.text);

    await raceTest.test('выгрузка фиксируется первой, импорт удерживает до первого байта', async () => {
      const raceReceipt = await newReceipt(b, base);
      const [eligibleExport, declaredAfter] = await queuedRace(db, projectId,
        () => a.request(newTxt.url, { raw: true }),
        () => declare(b, raceReceipt, supplementFile),
      );
      assert.equal(eligibleExport.status, 200, JSON.stringify(eligibleExport.body));
      assert.deepEqual(eligibleExport.bytes, newTxt.bytes);
      assert.equal(declaredAfter.status, 201);
      blocked(await a.request(newTxt.url), 409, 'scope_held');
      await b.ok(`/api/uploads/${declaredAfter.body.uploadId}/cancel`, post({}));
      assert.equal((await newLetter.getText()).status, 200);

      const importReceipt = await newReceipt(b, base, 'import');
      const queuedImport = await b.ok(`/api/receipts/${importReceipt}/imports`, post({ url: 'https://disk.yandex.ru/d/synthetic-step7' }), 202);
      blocked(await newLetter.getText(), 409, 'scope_held');
      blocked(await a.request(newTxt.url), 409, 'scope_held');
      assert.deepEqual(await a.ok(oldTxt.historicalUrl, { raw: true }), oldTxt.bytes);
      await b.ok(`/api/receipts/${importReceipt}/imports/${queuedImport.importId}/cancel`, post({}));
      assert.equal((await newLetter.getText()).status, 200);
    });

    const replacement = await createCatalog(requirements.map((row) => ({ ...row, completenessCriterion: 'Новая редакция критерия' })));
    const project = await a.ok(base);
    await a.ok(`${base}/catalog`, { method: 'PUT', data: { catalogVersionId: replacement.id }, version: project.version });
    await current(scopeA);
    assert.deepEqual(await b.ok(historyUrl), historyBefore);
    const historicalTxt = await b.request(oldTxt.historicalUrl, { raw: true });
    assert.equal(historicalTxt.headers['x-letter-historical'], 'true');
    assert.deepEqual(historicalTxt.bytes, oldTxt.bytes);
    assert.deepEqual(await b.ok(oldDocx.historicalUrl, { raw: true }), oldDocx.bytes);
    assert.equal(sha256(await b.ok(`/api/documents/${source.documentId}/versions/${source.versionId}/content`, { raw: true })), originalFile.sha256);
    for (const hint of hintsA) assert.equal((await b.ok(`/api/v1/evidence/${hint.evidenceId}`)).source.sha256, originalFile.sha256);

    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(join(output, 'before.txt'), oldTxt.bytes), writeFile(join(output, 'before.docx'), oldDocx.bytes),
      writeFile(join(output, 'after.txt'), newTxt.bytes), writeFile(join(output, 'after.docx'), newDocx.bytes),
      writeFile(join(output, 'snapshots.json'), JSON.stringify({ positionBefore, oldA, newA, historyBefore, latest: await projectSnapshot() }, null, 2)),
    ]);
  });

  await t.test('повторяемая лента, порядок commit, откат и истечение курсора', async () => {
    const path = `${base}/events?after=${positionBefore.cursor}&limit=1`;
    const page = await a.ok(path);
    assert(page.events.length === 1 && page.hasMore);
    assert.deepEqual(await b.ok(path), page);
    const head = await projectionOrder(db, projectId, a, base);
    await db.query(`INSERT INTO supplement_event_publications (project_id, type, payload)
      SELECT $1, 'test.retention', '{}'::jsonb FROM generate_series(1, 4097)`, [projectId]);
    blocked(await a.request(`${base}/events?after=${head.cursor}`), 409, 'snapshot_required');
    const resumed = await projectSnapshot();
    assert.deepEqual((await a.ok(`${base}/events?after=${resumed.cursor}`)).events, []);
    assert.equal(resumed.cursor, resumed.projectionVersion);
    await a.ok('/api/sessions/current', { method: 'DELETE' });
    blocked(await a.request(`${base}/events?after=${resumed.cursor}`), 401);
    assert.equal((await b.ok(`${base}/snapshot`)).cursor, resumed.cursor);
  });
});
