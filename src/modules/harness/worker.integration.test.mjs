import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const run = process.env.FACADE_HARNESS_INTEGRATION === '1';
const built = (file) => process.env.FACADE_HARNESS_TEST_DIST
  ? pathToFileURL(join(process.env.FACADE_HARNESS_TEST_DIST, file)).href
  : new URL(`../../../dist/${file}`, import.meta.url).href;
const origin = 'http://127.0.0.1:3000';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseRequest(serverRequest) {
  return new Response(serverRequest).json();
}

function toolMessage(name, args) {
  return { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

function syntheticPdf(...lines) {
  const text = lines.map((line) => `(${line.replace(/[()]/g, '\\$&')}) Tj`).join(' 0 -24 Td ');
  const stream = `BT /F1 14 Tf 30 140 Td ${text} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 270] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(result + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function until(read, valid, label) {
  const stop = Date.now() + 35_000;
  let latest;
  do {
    latest = await read();
    if (valid(latest)) return latest;
    await delay(200);
  } while (Date.now() < stop);
  assert.fail(`${label}: ${JSON.stringify(latest)}`);
}

test('ordinary upload runs two Mastra readers through PostgreSQL, the reader, questions and assessment', {
  skip: !run, timeout: 210_000,
}, async (t) => {
  const { createApi } = await import(built('src/platform/api.js'));
  const { readConfig } = await import(built('src/platform/config.js'));
  const { bootstrapAdmin } = await import(built('src/modules/access/bootstrap.js'));
  const { createGateway, journalFromEnv } = await import(built('src/modules/gateway/index.js'));
  const { startWorker } = await import(built('src/modules/harness/index.js'));
  const pg = await import('pg');
  const config = readConfig();
  const journalPool = new pg.Pool({ connectionString: process.env.FACADE_GATEWAY_JOURNAL_URL });
  let driver;
  let app;
  let worker;
  let provider;
  let connection;
  let unblock;
  t.after(async () => {
    driver?.abort();
    await unblock?.();
    await worker;
    if (provider) await new Promise((resolve) => provider.close(resolve));
    delete process.env.FACADE_HARNESS_MANAGED_URL;
    await connection?.close();
    await app?.close();
    await journalPool.end();
  });
  await journalPool.query(await readFile(new URL('../gateway/journal.sql', import.meta.url), 'utf8'));
  await journalPool.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES($1)', [process.env.FACADE_GATEWAY_LEDGER_ID]);
  app = await createApi(config);
  const password = `fixture-${randomUUID()}-password`;
  await bootstrapAdmin(app.db, { organization: 'Harness Test', login: 'step9', password });
  let credentials = {};
  async function command(method, url, payload, extra = {}, accepted = []) {
    const response = await app.inject({ method, url, payload, headers: { origin, host: '127.0.0.1:3000', ...credentials, ...extra,
      'idempotency-key': randomUUID(),
    } });
    assert.ok(response.statusCode < 300 || accepted.includes(response.statusCode), `${method} ${url} -> ${response.statusCode} ${response.body}`);
    return response;
  }
  const session = await command('POST', '/api/sessions', { login: 'step9', password });
  credentials = { cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json().csrfToken };
  const catalog = (await command('POST', '/api/catalogs', {
    key: 'fixture', name: 'Fixture',
    requirements: [{
      key: 'r1-thickness', part: 'R1 Thickness', formats: ['pdf'], equivalents: [],
      applicability: 'all', sourceRoles: ['design'], completenessCriterion: 'Addressed thickness', addressee: 'customer',
    }],
  })).json();
  const project = (await command('POST', '/api/projects', {
    name: 'Harness PDF', catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P',
  })).json();
  const projectId = project.id;
  const scopeId = project.scopes[0].id;

  connection = journalFromEnv();
  const gateway = createGateway(app.db, { journal: connection.journal });
  for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b'], ['lead', 'review']]) {
    await gateway.configureRoute({
      id: `managed-${role}`, revision: 'replay', transport: 'managed', enabled: true,
      maxRequestBytes: 16 * 1024 ** 2, ceilingUsdNanos: 1, timeoutMs: 25_000,
    });
    await gateway.grantRoute({
      projectId, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  async function attach(projectId, scopeId, receiptId, relativePath, pdf) {
    const upload = (await command('POST', `/api/receipts/${receiptId}/uploads`, {
      relativePath, size: pdf.length, sha256: sha256(pdf), mediaType: 'application/pdf', ...(scopeId ? { scopeIds: [scopeId] } : {}),
    })).json();
    await command('PUT', `/api/uploads/${upload.uploadId}/parts/1`, pdf, {
      'content-type': 'application/octet-stream', 'x-part-sha256': sha256(pdf), 'content-length': String(pdf.length),
    });
    return () => command('POST', `/api/uploads/${upload.uploadId}/complete`, {});
  }
  const providerCalls = [];
  let delayedSha;
  let exhaustedProjectId;
  let rasterSha;
  const statementFixtures = new Map();
  const sentB = Promise.withResolvers();
  const releaseB = Promise.withResolvers();
  unblock = releaseB.resolve;
  let rejectedOnce = false;
  const providerErrors = [];
  provider = createServer(async (req, res) => {
    try {
      const { attempt, routeId, request } = await parseRequest(req);
      providerCalls.push({ attempt, routeId, request });
      const assignment = JSON.parse(request.messages[1].content);
      if (routeId === 'managed-b' && assignment.place?.source.sha256 === delayedSha &&
        !request.messages.some(({ role }) => role === 'tool')) {
        sentB.resolve();
        await releaseB.promise;
      }
      const completed = request.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
      const completedTools = request.messages.flatMap(({ role, tool_calls }) =>
        role === 'assistant' ? tool_calls.map(({ function: f }) => f.name) : []);
      let output;
      if (!completedTools.length && routeId === 'managed-b' && !rejectedOnce) {
        rejectedOnce = true;
        res.end(JSON.stringify({ receipt: { state: 'rejected', evidenceRef: 'fixture:429', code: 'http_429' } }));
        return;
      }
      if (assignment.mode === 'lead') {
        assert.equal(routeId, 'managed-lead');
        output = toolMessage('propose_resolution', {
          aObservationId: assignment.dispute.a.observationId, bObservationId: assignment.dispute.b.observationId,
          explanation: 'Two distinct originals state incompatible values.',
        });
      } else if (assignment.mode === 'verify') {
        assert.notEqual(routeId, 'managed-lead');
        if (completedTools.length < 2) output = toolMessage('survey', { support: completedTools.length ? 'B' : 'A' });
        else output = toolMessage('verify_resolution', {
          verdict: 'supported', evidenceIds: completed.map((reply) => reply.evidence.evidenceId),
          explanation: 'Verified both addressed originals.',
        });
      } else if (!completedTools.length) output = toolMessage('survey', {});
      else if (completedTools.length === 1) {
        const image = request.messages.flatMap(({ content }) => Array.isArray(content) ? content : [])
          .find(({ type }) => type === 'image_url');
        assert.ok(image);
        const imageBytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        assert.equal(sha256(imageBytes), completed[0].evidence.sha256);
        output = toolMessage('extract', {});
      } else if (statementFixtures.has(assignment.place.source.sha256)) {
        const fixture = statementFixtures.get(assignment.place.source.sha256);
        const source = completed[1];
        const { lines } = JSON.parse(source.content);
        const predicate = lines.find(({ text }) => text === fixture.quote);
        const subject = lines.find(({ text }) => text === fixture.contextQuote);
        assert.ok(predicate && subject);
        const checked = request.tools.find((tool) => tool.function.name === 'save_observation').function.parameters;
        assert.ok(checked.properties.deliveryStatement);
        const previous = completed.at(-1);
        if (previous.observationId) {
          output = toolMessage('finish_reading', { status: 'covered', explanation: 'Literal statement recorded.' });
        } else {
          const invalid = completedTools.length === 2 && routeId === 'managed-a';
          if (completedTools.length > 2) assert.equal(previous.code, 'reader_quote_mismatch');
          output = toolMessage('save_observation', {
            evidenceId: source.evidence.evidenceId, lineId: predicate.id, quote: predicate.text, sourceRole: 'inventory',
            deliveryStatement: { status: fixture.status, item: fixture.item,
              context: { lineId: invalid ? predicate.id : subject.id, quote: subject.text } },
          });
        }
      } else if (assignment.place.source.sha256 === rasterSha) {
        const box = { x: 40, y: 140, width: 530, height: 65 };
        if (completedTools.length === 2) {
          assert.deepEqual(JSON.parse(completed[1].content).lines, []);
          output = toolMessage('zoom', { box });
        } else if (completedTools.length === 3) {
          assert.ok(completed[2].transform.pixelsPerPoint > completed[0].transform.pixelsPerPoint);
          output = toolMessage('ocr', { box });
        } else if (completedTools.length === 4) {
          const source = completed[3];
          const { lines } = JSON.parse(source.content);
          const line = lines.find(({ text }) => /\b1200\b/.test(text));
          assert.ok(line, JSON.stringify(lines));
          output = toolMessage('save_observation', {
            evidenceId: source.evidence.evidenceId, lineId: line.id, quote: line.text,
            value: '1200', unit: 'мм', sourceRole: 'design',
          });
        } else {
          assert.ok(completed[4].observationId, JSON.stringify(completed[4]));
          output = toolMessage('finish_reading', { status: 'covered', explanation: 'Raster evidence verified.' });
        }
      } else if (completedTools.length === 2) {
        const source = completed[1];
        const { lines } = JSON.parse(source.content);
        const header = lines.find(({ text }) => text.includes('Thickness'));
        const line = lines.find(({ text }) => /Thickness.*[23]$/.test(text.trim())) ?? (header &&
          lines.find(({ text, box }) => /^[23]$/.test(text) && box && header.box && Math.abs(box.y - header.box.y) < 1));
        if (!line) output = toolMessage('finish_reading', { status: 'no_match', explanation: 'Window inspected.' });
        else output = toolMessage('save_observation', {
          evidenceId: source.evidence.evidenceId, lineId: line.id, quote: line.text, value: line.text.trim().at(-1), unit: 'мм', sourceRole: 'design',
        });
      } else {
        assert.ok(completed[2].observationId, JSON.stringify(completed[2]));
        output = toolMessage('finish_reading', { status: 'covered', explanation: 'Addressed agreement' });
      }
      res.end(JSON.stringify({ receipt: {
        state: 'paid', providerId: `managed:${attempt.id}`,
        costUsdNanos: attempt.projectId === exhaustedProjectId ? 10_000_000_000 : 0,
        evidenceRef: 'replay:step9',
      }, output }));
    } catch (error) {
      providerErrors.push(error.message);
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const managedUrl = `http://127.0.0.1:${provider.address().port}/replay`;
  process.env.FACADE_HARNESS_MANAGED_URL = managedUrl;
  const warnings = [];
  function beginWorker() {
    driver = new AbortController();
    worker = startWorker({ db: app.db, config, signal: driver.signal, logger: {
      info() {}, warn(message) { warnings.push(message); }, error(message) { warnings.push(message); },
    } });
  }
  async function stopWorker() {
    driver.abort();
    await worker;
  }
  beginWorker();

  const pdf = await readFile(new URL('../../../test/fixtures/input/facade-supplement.pdf', import.meta.url));
  const receipt = (await command('POST', `/api/projects/${projectId}/receipts`, { source: 'upload' })).json();
  const complete = await attach(projectId, scopeId, receipt.receiptId, 'attachment.pdf', pdf);
  const sealed = (await complete()).json();
  await command('POST', `/api/receipts/${receipt.receiptId}/seal`, {});
  const coverage = await until(async () => {
    const rows = await app.db.query(`SELECT p.branch,p.state FROM gateway_primary p
      JOIN gateway_generations g USING(generation_id) WHERE g.project_id=$1 AND g.current ORDER BY p.branch`, [projectId]);
    return { rows: rows.rows, warnings, providerErrors };
  }, ({ rows }) => rows.length === 2 && rows.every(({ state }) => state === 'completed'), 'Both reader obligations');
  assert.deepEqual(coverage.rows.map(({ branch }) => branch), ['A', 'B']);
  const card = (await command('GET', `/api/projects/${projectId}/assessments/current?scopeId=${scopeId}`)).json();
  const machine = card.questions[0].machine;
  assert.equal(machine.outcome, 'covered');
  assert.deepEqual(machine.citations.map(({ branch }) => branch).sort(), ['A', 'B']);
  for (const citation of machine.citations) {
    assert.equal(citation.versionId, sealed.versionId);
    const evidence = await command('GET', `/api/v1/evidence/${citation.evidenceId}/content`);
    assert.match(evidence.body, /Thickness/);
    const { rows: [legacy] } = await app.db.query(
      'SELECT request_sha256,payload FROM reader_observations WHERE id=$1', [citation.observationId]);
    const source = { projectId, documentId: citation.documentId, versionId: citation.versionId, sha256: citation.sha256 };
    const candidate = {
      evidenceId: citation.evidenceId, scope: scopeId, quote: citation.quote, value: citation.value, unit: citation.unit,
      lineId: legacy.payload.lineId,
    };
    assert.equal(legacy.request_sha256, sha256(JSON.stringify({ source, candidate })));
    assert.equal(Object.hasOwn(legacy.payload, 'deliveryStatement'), false);
  }
  const questions = await app.db.query('SELECT count(*)::int AS count FROM inquiry_observations WHERE project_id=$1', [projectId]);
  assert.equal(questions.rows[0].count, 2);
  assert.equal(providerCalls.length, 9);
  const retry = providerCalls.find(({ attempt }) => attempt.previousRejectedId);
  assert.ok(retry);
  const journal = await connection.journal.balance();
  assert.equal(journal.spentUsdNanos, 0);

  await t.test('typed delivery statements from A and B reach assessment with the literal source', async () => {
    const statementCatalog = (await command('POST', '/api/catalogs', {
      key: 'delivery-statements', name: 'Delivery statements',
      requirements: [{
        key: 'torsion-report', part: 'Torsion test report', formats: ['pdf'], equivalents: [],
        applicability: 'all', sourceRoles: ['design'], completenessCriterion: 'Addressed report', addressee: 'customer',
      }],
    })).json();
    for (const [status, quote, kind, assigned, outcome] of [
      ['not_delivered', 'Torsion test report is not included.', 'absence', true, 'confirmed_missing'],
      ['not_delivered', 'Torsion test report is not included.', 'absence', false, 'needs_review'],
      ['delivered', 'Included in this shipment.', 'delivery', true, 'needs_review'],
    ]) {
      const item = 'Torsion test report';
      const contextQuote = status === 'delivered' ? item : 'Current shipment register';
      const file = syntheticPdf(contextQuote, quote);
      statementFixtures.set(sha256(file), { status, quote, item, contextQuote });
      const study = (await command('POST', '/api/projects', {
        name: status, catalogVersionId: statementCatalog.id, scopeName: 'F-A', stage: 'P',
      })).json();
      const studyScope = study.scopes[0].id;
      for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b']]) {
        await gateway.grantRoute({
          projectId: study.id, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
        });
      }
      const receipt = (await command('POST', `/api/projects/${study.id}/receipts`, {})).json();
      const complete = await attach(study.id, assigned ? studyScope : undefined, receipt.receiptId, 'transmittal.pdf', file);
      await complete();
      await command('POST', `/api/receipts/${receipt.receiptId}/seal`, {});
      const state = await until(async () => {
        const { rows } = await app.db.query('SELECT state FROM gateway_jobs WHERE project_id=$1', [study.id]);
        return { rows, providerErrors, warnings };
      }, ({ rows }) => rows.length === 2 && rows.every(({ state }) => state === 'done'), 'Both statements persisted');
      assert.equal(state.rows.length, 2);
      const { rows: [revision] } = await app.db.query(
        'SELECT question_id,review,machine FROM assessment_question_revisions WHERE scope_id=$1 ORDER BY version DESC LIMIT 1', [studyScope]);
      assert.equal(revision.machine.outcome, outcome);
      assert.equal(revision.machine.delivery, 'not_demonstrated');
      assert.equal(revision.review.inventory?.alternativesChecked ?? false, outcome === 'confirmed_missing');
      assert.deepEqual(revision.review.findings.map((finding) => finding.kind), [kind, kind]);
      const applicability = outcome === 'confirmed_missing' ? 'active' : 'unknown';
      assert.deepEqual(revision.review.findings.map((finding) => finding.applicability), [applicability, applicability]);
      assert.deepEqual(revision.review.findings.map(({ citation }) => citation.branch).sort(), ['A', 'B']);
      for (const { citation, nonDelivery } of revision.review.findings) {
        assert.deepEqual(nonDelivery, status === 'not_delivered' ? {
          kind: 'explicit_non_delivery', subjectQuote: item, questionId: revision.question_id, receiptId: receipt.receiptId,
        } : undefined);
        assert.equal(citation.quote, quote);
        assert.equal(citation.value, null);
        assert.equal(citation.unit, null);
        const pinned = (await command('GET', `/api/v1/observations/${citation.observationId}`)).json();
        const { lines } = (await command('GET', citation.href + '/content')).json();
        assert.deepEqual(pinned.deliveryStatement, {
          status, item, context: { lineId: lines.find(({ text }) => text === contextQuote).id, quote: contextQuote },
        });
        assert.ok(lines.some(({ id, text }) => id === pinned.lineId && text === quote));
      }
    }
  });
  if (process.env.FACADE_HARNESS_STATEMENTS_ONLY === '1') {
    assert.deepEqual(providerErrors, []);
    assert.deepEqual(warnings, []);
    return;
  }

  const large = (await command('POST', '/api/projects', {
    name: 'Harness dispute', catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P',
  })).json();
  const largeScope = large.scopes[0].id;
  for (const [role, purposes] of [['a', ['primary_a', 'review']], ['b', ['primary_b', 'review']], ['lead', ['review']]]) {
    for (const purpose of purposes) await gateway.grantRoute({
      projectId: large.id, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  const incoming = (await command('POST', `/api/projects/${large.id}/receipts`, { source: 'upload' })).json();
  const fillA = await attach(large.id, largeScope, incoming.receiptId, 'one.pdf', syntheticPdf('F-A R1 Thickness (mm) 2'));
  const fillB = await attach(large.id, largeScope, incoming.receiptId, 'two.pdf', syntheticPdf('F-A R1 Thickness (mm) 3'));
  const remaining = syntheticPdf('F-A R1 Layout only');
  delayedSha = sha256(remaining);
  const fillRemaining = await attach(large.id, largeScope, incoming.receiptId, 'three.pdf', remaining);
  await fillA();
  await fillB();
  const reviews = () => providerCalls.filter(({ attempt }) => attempt.projectId === large.id && attempt.purpose === 'review');
  const showCard = async () => (await command('GET',
    `/api/projects/${large.id}/assessments/current?scopeId=${largeScope}`)).json().questions[0].machine;
  const early = await until(showCard, ({ limitations }) => limitations.includes('dispute_pending'), 'Early dispute card');
  assert.equal(early.outcome, 'needs_review');
  assert.equal(reviews().length, 0);
  const blocked = (await fillRemaining()).json();
  const pin = await app.db.connect();
  let pinned = true;
  const unlock = async () => {
    if (!pinned) return;
    pinned = false;
    try {
      await pin.query('SELECT pg_advisory_unlock(94009)');
    } finally {
      pin.release();
    }
  };
  unblock = async () => {
    releaseB.resolve();
    await unlock();
  };
  await pin.query('SELECT pg_advisory_lock(94009)');
  await app.db.query(`
    CREATE TABLE harness_test_delay(version_id uuid PRIMARY KEY);
    CREATE FUNCTION harness_test_pause_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.branch='B' AND NEW.state <> OLD.state AND EXISTS(
        SELECT 1 FROM gateway_jobs j JOIN harness_test_delay t ON t.version_id::text=j.subject_id
        WHERE j.obligation_id=NEW.id AND j.generation_id=NEW.generation_id
      ) THEN PERFORM pg_advisory_xact_lock(94009); END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER harness_test_pause_finish BEFORE UPDATE ON gateway_primary
      FOR EACH ROW EXECUTE FUNCTION harness_test_pause_finalization();
  `);
  await app.db.query('INSERT INTO harness_test_delay(version_id) VALUES($1)', [blocked.versionId]);
  await command('POST', `/api/receipts/${incoming.receiptId}/seal`, {});
  await Promise.race([sentB.promise, delay(15_000, undefined, { ref: false }).then(() => assert.fail('B was not dispatched'))]);
  assert.equal(reviews().length, 0);
  assert.equal((await showCard()).outcome, 'needs_review');
  releaseB.resolve();
  await until(async () => (await app.db.query(
    "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=94009 AND NOT granted",
  )).rows[0].count, (count) => count > 0, 'Result precedes B obligation commit');

  const small = (await command('POST', '/api/projects', {
    name: 'Independent PDF', catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P',
  })).json();
  const smallScope = small.scopes[0].id;
  for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b']]) {
    await gateway.grantRoute({
      projectId: small.id, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  const smallReceipt = (await command('POST', `/api/projects/${small.id}/receipts`, {})).json();
  const completeSmall = await attach(small.id, smallScope, smallReceipt.receiptId, 'small.pdf', pdf);
  await completeSmall();
  await command('POST', `/api/receipts/${smallReceipt.receiptId}/seal`, {});
  await until(async () => (await command('GET', `/api/projects/${small.id}/assessments/current?scopeId=${smallScope}`)).json(),
    (card) => card.questions[0]?.machine.outcome === 'covered', 'Independent small project completes during B barrier');
  assert.equal(reviews().length, 0);
  await unlock();
  const resolved = await until(showCard, (machine) => machine.outcome === 'confirmed_conflict', 'Two rereads completed');
  assert.deepEqual(resolved.citations.map(({ value }) => value).sort(), ['2', '3']);
  assert.ok(reviews().some(({ routeId }) => routeId === 'managed-lead'));
  assert.ok(reviews().some(({ routeId }) => routeId === 'managed-a'));
  assert.ok(reviews().some(({ routeId }) => routeId === 'managed-b'));
  assert.equal(reviews().length, 7);
  assert.equal((await connection.journal.balance()).spentUsdNanos, 0);

  const assessLarge = async () =>
    (await command('GET', `/api/projects/${large.id}/assessments/current?scopeId=${largeScope}`)).json();
  let assessed = await assessLarge();
  while (assessed.holds.length) {
    const [hold] = assessed.holds;
    const closed = await command('POST', `/api/projects/${large.id}/supplements/holds/${hold.id}/resolve`, {
      generation: hold.generation, reason: 'Synthetic composition checked',
      impacts: [{ scopeId: largeScope, assessmentVersion: assessed.version, questionIds: [] }],
    }, { 'if-match': `"${hold.version}"` }, [412]);
    assessed = await assessLarge();
    if (closed.statusCode === 412) assert.ok(assessed.holds.every(({ id }) => id !== hold.id));
  }
  const question = assessed.questions[0];
  const decision = (await command('POST', `/api/questions/${question.id}/decisions`, {
    action: 'confirm', reason: 'Synthetic originals checked', requestExternal: true,
  }, { 'if-match': `"${question.version}"` })).json();
  const items = [{ questionId: question.id, questionVersion: decision.version, decisionId: decision.id }];
  let letter = (await command('POST', `/api/projects/${large.id}/letters`, {
    scopeId: largeScope, recipient: 'customer', items,
  })).json();
  if (letter.status !== 'confirmed') {
    letter = (await command('POST', `/api/letters/${letter.id}/confirm`, { items },
      { 'if-match': `"${letter.version}"` })).json();
  }
  const versionHeader = { 'if-match': `"${letter.version}"` };
  const fullText = (await command('GET', `/api/letters/${letter.id}/current-text`, undefined, versionHeader)).json().text;
  assert.match(fullText, /R1 Thickness/);
  assert.match(fullText, /2\s*мм/);
  assert.match(fullText, /3\s*мм/);
  for (const format of ['txt', 'docx']) {
    const exported = (await command('POST', `/api/letters/${letter.id}/exports`, { format }, versionHeader)).json();
    const file = await command('GET', exported.url);
    if (format === 'txt') assert.equal(file.body, fullText);
    else {
      const python = spawnSync('python3', ['-c', `
import io, sys, zipfile
from xml.etree import ElementTree as XML
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as doc:
    root = XML.fromstring(doc.read('word/document.xml'))
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
sys.stdout.write('\\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', ns)) for p in root.findall('.//w:p', ns)))
`], { input: file.rawPayload, encoding: 'utf8' });
      assert.equal(python.status, 0, python.stderr);
      assert.equal(python.stdout, fullText);
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'harness-raster-'));
  let raster;
  try {
    const inputFile = new URL('../../../test/fixtures/input/facade-package.pdf', import.meta.url);
    const separation = spawnSync('pdfseparate', ['-f', '2', '-l', '2', inputFile.pathname, join(workDir, 'page-%d.pdf')]);
    assert.equal(separation.status, 0, separation.stderr?.toString());
    raster = await readFile(join(workDir, 'page-2.pdf'));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  rasterSha = sha256(raster);
  const rasterCatalog = (await command('POST', '/api/catalogs', {
    key: 'raster', name: 'Raster',
    requirements: [{
      key: 'r1-width', part: 'R1 Width', formats: ['pdf'], equivalents: [],
      applicability: 'all', sourceRoles: ['design'], completenessCriterion: 'Addressed width', addressee: 'customer',
    }],
  })).json();
  const rasterProject = (await command('POST', '/api/projects', {
    name: 'Raster PDF', catalogVersionId: rasterCatalog.id, scopeName: 'F-B', stage: 'P',
  })).json();
  const rasterScope = rasterProject.scopes[0].id;
  for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b']]) {
    await gateway.grantRoute({
      projectId: rasterProject.id, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  const rasterReceipt = (await command('POST', `/api/projects/${rasterProject.id}/receipts`, {})).json();
  const completeRaster = await attach(rasterProject.id, rasterScope, rasterReceipt.receiptId, 'raster.pdf', raster);
  await completeRaster();
  await command('POST', `/api/receipts/${rasterReceipt.receiptId}/seal`, {});
  const rasterCard = await until(async () => (await command('GET',
    `/api/projects/${rasterProject.id}/assessments/current?scopeId=${rasterScope}`)).json(),
  (card) => card.questions[0]?.machine.outcome === 'covered', 'OCR and zoom recover a zero-native-text place');
  assert.deepEqual(rasterCard.questions[0].machine.citations.map(({ value }) => value), ['1200', '1200']);

  await stopWorker();
  delete process.env.FACADE_HARNESS_MANAGED_URL;
  beginWorker();
  const parked = (await command('POST', '/api/projects', {
    name: 'Offline queue recovery', catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P',
  })).json();
  const parkedScope = parked.scopes[0].id;
  for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b']]) {
    await gateway.grantRoute({
      projectId: parked.id, routeId: `managed-${role}`, revision: 'replay', purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  const parkedReceipt = (await command('POST', `/api/projects/${parked.id}/receipts`, {})).json();
  const completeParked = await attach(parked.id, parkedScope, parkedReceipt.receiptId, 'offline.pdf', pdf);
  await completeParked();
  await command('POST', `/api/receipts/${parkedReceipt.receiptId}/seal`, {});
  const workOfParked = async () => (await app.db.query(
    'SELECT id, state, reason, lease_epoch FROM gateway_jobs WHERE project_id=$1 ORDER BY purpose', [parked.id])).rows;
  const waiting = await until(workOfParked, (rows) => rows.length === 2, 'Map and queue are available without a transport');
  await delay(1600);
  assert.ok(waiting.every(({ state, lease_epoch }) => state === 'ready' && lease_epoch === 0));
  assert.deepEqual(await workOfParked(), waiting);
  assert.equal(providerCalls.filter(({ attempt }) => attempt.projectId === parked.id).length, 0);
  await stopWorker();

  for (const [reason, nextAction] of [
    ['route_reconciliation', 'operator_reconcile_route'],
    ['journal_unavailable', 'restore_external_journal'],
  ]) {
    const work = await gateway.claim({ workerId: 'legacy-fixture', kinds: ['harness_research'], leaseMs: 10_000 });
    assert.equal(work?.projectId, parked.id);
    assert.ok(await gateway.suspend(work.lease, { reason, nextAction }));
  }
  process.env.FACADE_HARNESS_MANAGED_URL = managedUrl;
  beginWorker();
  await until(workOfParked, (rows) => rows.every(({ state }) => state === 'done'), 'Preserved holds recover with the transport');
  assert.equal(providerCalls.filter(({ attempt }) => attempt.projectId === parked.id).length, 8);

  const budgetProject = (await command('POST', '/api/projects', {
    name: 'Budget boundary', catalogVersionId: catalog.id, scopeName: 'F-A', stage: 'P',
  })).json();
  exhaustedProjectId = budgetProject.id;
  const budgetScope = budgetProject.scopes[0].id;
  for (const [role, purpose] of [['a', 'primary_a'], ['b', 'primary_b']]) {
    await gateway.configureRoute({
      id: `managed-${role}`, revision: 'synthetic-budget', transport: 'managed', enabled: true,
      maxRequestBytes: 16 * 1024 ** 2, ceilingUsdNanos: 10_000_000_000, timeoutMs: 25_000,
    });
    await gateway.grantRoute({
      projectId: budgetProject.id, routeId: `managed-${role}`, revision: 'synthetic-budget',
      purpose, dataClass: 'synthetic', allowed: true,
    });
  }
  const budgetReceipt = (await command('POST', `/api/projects/${budgetProject.id}/receipts`, {})).json();
  const completeBudget = await attach(budgetProject.id, budgetScope, budgetReceipt.receiptId, 'budget.pdf', pdf);
  await completeBudget();
  await command('POST', `/api/receipts/${budgetReceipt.receiptId}/seal`, {});
  const cutoff = await until(async () => (await app.db.query(
    `SELECT j.reason,p.state FROM gateway_jobs j JOIN gateway_primary p
       ON p.generation_id=j.generation_id AND p.id=j.obligation_id WHERE j.project_id=$1`,
    [budgetProject.id])).rows, (rows) => rows.length === 2 && rows.every(({ reason }) => reason === 'budget_exhausted'),
  'Outstanding places visible after the simulated budget cutoff');
  assert.deepEqual(cutoff.map(({ state }) => state), ['pending', 'pending']);
  assert.equal(providerCalls.filter(({ attempt }) => attempt.projectId === budgetProject.id).length, 1);
  assert.equal((await connection.journal.balance()).spentUsdNanos, 10_000_000_000);
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(warnings, []);
});
