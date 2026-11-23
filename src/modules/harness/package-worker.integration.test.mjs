import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const enabled = process.env.FACADE_PACKAGE_INTEGRATION === '1';
const built = (file) => process.env.FACADE_HARNESS_TEST_DIST
  ? pathToFileURL(join(process.env.FACADE_HARNESS_TEST_DIST, file)).href
  : new URL(`../../../dist/${file}`, import.meta.url).href;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function pdf(lines) {
  const drawing = lines.map((line) => `(${line}) Tj`).join(' 0 -24 Td ');
  const stream = `BT /T 7 Tf 20 140 Td ${drawing} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 270] /Resources << /Font << /T 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 6\n0000000000 65535 f \n'
    + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(result + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function until(read, accept, label) {
  const end = Date.now() + 120_000;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await delay(500);
  } while (Date.now() < end);
  assert.fail(`${label} — ${JSON.stringify({
    coverage: last?.coverage, facts: last?.facts.length, pairs: last?.verifiedPairs.length,
    windows: last?.windows.map(({ branches }) => branches),
  })}`);
}

function tool(name, args) {
  return { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function',
      function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

const primaryDrawing = 'Drawing | current revision R1 | variant V9 | scope: K-47 | project facade ID: K-47 | Gap 30 mm';
const opposingDrawing = 'Drawing | project facade ID: K-47 | Gap 4.1 cm';
const opposingTitle = 'Drawing | current revision R2 | variant V9 | scope: K-47 | project facade ID: K-47';
const register = 'Schedule | current revision R1 | Complete list of facades | project facade ID: K-47 | project facade ID: M-18 | all common materials listed';
const notDelivered = 'Transmittal | current revision R1 | project facade ID: M-18 | thermal report not delivered';
const common = 'Specification | applies to all facades | current revision R1 | System vent';
function observation(line) {
  const lower = line.text.toLowerCase();
  const ids = [...line.text.matchAll(/project facade ID: ([\w-]+)/g)];
  const revision = /current revision (\w+)/.exec(line.text);
  const role = lower.includes('drawing') ? { value: 'drawing', quote: 'Drawing' }
    : lower.includes('specification') ? { value: 'specification', quote: 'Specification' }
      : lower.includes('transmittal') ? { value: 'inventory', quote: 'Transmittal' }
        : lower.includes('schedule') ? { value: 'schedule', quote: 'Schedule' } : undefined;
  const attribute = lower.includes('gap') ? 'Gap' : lower.includes('thermal report') ? 'thermal report' :
    lower.includes('system vent') ? 'System vent' : lower.includes('mar?') ? 'Material identifier' : 'Facade register';
  const measurement = /Gap ([\d.,]+) (mm|cm)/.exec(line.text);
  const binding = ids.length ? {
    state: 'identified', labels: ids.map((item) => item[1]), projectIdentifiers: ids.map((item) => ({ label: item[1], quote: item[0] })),
    quote: line.text, reason: 'Printed project facade identifier.',
  } : lower.includes('all facades') ? {
    state: 'common', labels: [], quote: 'applies to all facades', reason: 'The specification expressly applies to every facade.',
  } : { state: 'unclear', labels: [], quote: line.text, reason: 'Incomplete material identifier.' };
  return {
    quote: line.text, lineId: line.id, ...(measurement ? { value: measurement[1], unit: measurement[2] } : {}),
    ...(lower.includes('not delivered') ? { sourceRole: 'inventory',
      deliveryStatement: { status: 'not_delivered', item: 'thermal report' } } : {}),
    package: { attribute, role, binding,
      ...(revision ? { revision: { value: revision[1], quote: revision[0], status: 'current' } } : {}),
      ...(lower.includes('complete list') ? { subjectRegister: { labels: ids.map((item) => item[1]),
        quote: line.text, commonQuote: 'all common materials listed' } } : {}),
    },
  };
}

test('ordinary intake publishes independent package evidence before questions and retains it on passive replay', {
  skip: !enabled, timeout: 310_000,
}, async (t) => {
  const { createApi } = await import(built('src/platform/api.js'));
  const { readConfig } = await import(built('src/platform/config.js'));
  const { bootstrapAdmin } = await import(built('src/modules/access/bootstrap.js'));
  const { createGateway, PostgresIntentJournal } = await import(built('src/modules/gateway/index.js'));
  const { startWorker, readPackageAnalysis } = await import(built('src/modules/harness/index.js'));
  const { activatePackageProjects, preparePackageMap, dispatchPackagePair } = await import(built('src/modules/harness/package-dispatch.js'));
  const { loadResearchProfile } = await import(built('src/modules/harness/profile.js'));
  const { Pool } = await import('pg');
  const config = readConfig();
  const external = new Pool({ connectionString: process.env.FACADE_GATEWAY_JOURNAL_URL });
  await external.query(await readFile(new URL('../gateway/journal.sql', import.meta.url), 'utf8'));
  await external.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES($1)', [process.env.FACADE_GATEWAY_LEDGER_ID]);
  const app = await createApi(config);
  const calls = [];
  const errors = [];
  const warnings = [];
  let worker;
  let driver;
  const provider = createServer(async (req, res) => {
    try {
      const { attempt, request } = await new Response(req).json();
      const assignment = JSON.parse(request.messages[1].content);
      assert.equal(attempt.scopeId, null);
      calls.push(attempt);
      const replies = request.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
      const wrong = replies.find(({ ok }) => ok === false);
      if (wrong) throw new Error(JSON.stringify(wrong));
      if (assignment.mode === 'lead' || assignment.mode === 'verify') {
        const texts = replies.filter(({ content }) => content && JSON.parse(content).lines);
        const { a, b } = assignment.dispute;
        let output;
        if (!texts.length) output = tool('extract', { support: 'A' });
        else if (texts.length === 1) output = tool('extract', { support: 'B' });
        else {
          const direct = texts.slice(0, 2);
          const titleIndex = direct.findIndex((reply) => !JSON.parse(reply.content).lines.some(({ text }) => text.includes('current revision')));
          const inventory = replies.find(({ items }) => items);
          if (titleIndex >= 0 && !inventory) output = tool('context_inventory', {});
          else if (titleIndex >= 0 && texts.length === 2) {
            const support = titleIndex === 0 ? 'A' : 'B';
            output = tool('open_context', { contextId: inventory.items.find((item) => item.support === support).id });
          } else {
            const citation = (reply, predicate) => ({ evidenceId: reply.evidence.evidenceId, quote: JSON.parse(reply.content).lines.find(predicate).text });
            const measurement = direct.map((reply) => citation(reply, ({ text }) => text.includes('Gap')));
            const metadata = direct.map((reply, index) => citation(index === titleIndex ? texts[2] : reply,
              ({ text }) => text.includes('current revision')));
            const check = (sources) => ({ status: 'confirmed', reason: 'Verified the printed context and anchored quantities.', sources });
            const proof = { explanation: 'Checked the two addressed values and title contexts.',
              evidenceIds: measurement.map(({ evidenceId }) => evidenceId),
              checks: { variant: check(metadata), revision: check(metadata), applicability: check(metadata), comparability: check(measurement) } };
            output = assignment.mode === 'lead'
              ? tool('propose_resolution', { aObservationId: a.observationId, bObservationId: b.observationId, ...proof })
              : tool('verify_resolution', { verdict: 'supported', ...proof });
          }
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ receipt: { state: 'paid', costUsdNanos: 0, providerId: attempt.id, evidenceRef: 'synthetic:pair' }, output }));
        return;
      }
      assert.equal(assignment.question, undefined);
      assert.equal(assignment.objective, 'package_primary');
      const extracted = replies.find(({ content }) => content && JSON.parse(content).lines);
      const saved = replies.filter(({ observationId }) => observationId).length;
      const surveyed = replies.some(({ evidence }) => evidence);
      let output;
      if (!surveyed) output = tool('survey', {});
      else if (!extracted) output = tool('extract', {});
      else {
        const { lines } = JSON.parse(extracted.content);
        output = saved < lines.length
          ? tool('save_observation', { evidenceId: extracted.evidence.evidenceId, ...observation(lines[saved]) })
          : tool('finish_reading', { status: 'covered', explanation: 'Surveyed and transcribed addressed lines.' });
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        receipt: { state: 'paid', costUsdNanos: 0, providerId: attempt.id, evidenceRef: 'synthetic:package' }, output,
      }));
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500).end();
    }
  });
  t.after(async () => {
    driver?.abort();
    await worker;
    await new Promise((resolve) => provider.close(resolve));
    await app.close();
    await external.end();
    delete process.env.FACADE_HARNESS_MANAGED_URL;
    delete process.env.FACADE_HARNESS_PACKAGE_EFFECTS;
    delete process.env.FACADE_HARNESS_REPLAY_ONLY;
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  process.env.FACADE_HARNESS_MANAGED_URL = `http://127.0.0.1:${provider.address().port}`;
  const password = `test-${randomUUID()}`;
  await bootstrapAdmin(app.db, { organization: 'Package fixture', login: 'package-fixture', password });
  let credentials = {};
  async function command(method, url, payload, headers = {}, expected) {
    const response = await app.inject({ method, url, payload, headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000',
      ...credentials, 'idempotency-key': randomUUID(), ...headers } });
    assert.ok(expected ? response.statusCode === expected : response.statusCode < 300,
      `${method} ${url} received ${response.statusCode} ${response.body}`);
    return response;
  }
  const session = await command('POST', '/api/sessions', { login: 'package-fixture', password });
  credentials = { cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json().csrfToken };
  const project = (await command('POST', '/api/projects', { name: 'Uncatalogued intake', mode: 'intake' })).json();
  assert.deepEqual(project.scopes, []);
  assert.equal(project.catalog, null);
  const gateway = createGateway(app.db);
  for (const [routeId, purpose] of [['managed-a', 'primary_a'], ['managed-b', 'primary_b'], ['managed-lead', 'review']]) {
    await gateway.configureRoute({ id: routeId, revision: 'fixture-v1', transport: 'managed', enabled: true,
      maxRequestBytes: 12 * 1024 ** 2, ceilingUsdNanos: 1, timeoutMs: 20_000 });
    await gateway.grantRoute({ projectId: project.id, routeId, revision: 'fixture-v1', purpose, dataClass: 'synthetic', allowed: true });
    if (purpose !== 'review') await gateway.grantRoute({ projectId: project.id, routeId, revision: 'fixture-v1',
      purpose: 'review', dataClass: 'synthetic', allowed: true });
  }
  const receipt = (await command('POST', `/api/projects/${project.id}/receipts`, { source: 'upload' })).json();
  const receiptUrl = `/api/receipts/${receipt.receiptId}`;
  async function upload(relativePath, pdfBytes, target = receiptUrl) {
    const { uploadId } = (await command('POST', target + '/uploads', {
      relativePath, size: pdfBytes.length, sha256: sha(pdfBytes), mediaType: 'application/pdf',
    })).json();
    await command('PUT', `/api/uploads/${uploadId}/parts/1`, pdfBytes, {
      'content-type': 'application/octet-stream', 'x-part-sha256': sha(pdfBytes), 'content-length': String(pdfBytes.length),
    });
    return (await command('POST', `/api/uploads/${uploadId}/complete`, {})).json();
  }

  function run() {
    driver = new AbortController();
    worker = startWorker({ db: app.db, config, logger: { warn: (message) => warnings.push(message) }, signal: driver.signal });
  }
  const analyze = () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    return readPackageAnalysis(app.db, project.id);
  };
  process.env.FACADE_HARNESS_REPLAY_ONLY = '1';
  run();
  const first = await upload('first.pdf', pdf([primaryDrawing, register, notDelivered, common]));
  const passive = await until(analyze, ({ windows }) => windows.some(({ branches }) => branches.A.status === 'held'), 'passive hold');
  assert.equal(calls.length, 0);
  assert.equal(passive.facts.length, 0);
  assert.equal(passive.coverage.completedWindows, 0);

  driver.abort();
  await worker;
  const projectPath = '/api/projects/' + project.id;
  const scope = (await command('POST', projectPath + '/scopes', { stage: 'RD', name: 'First facade only' })).json();
  const viewerLogin = 'package-viewer';
  const viewerPassword = 'test-' + randomUUID();
  const invitation = (await command('POST', '/api/users/invitations', { login: viewerLogin })).json();
  await command('POST', '/api/invitations/complete', { password: viewerPassword, token: invitation.token });
  const projectVersion = (await command('GET', projectPath)).json().version;
  await command('PUT', projectPath + '/members/' + invitation.userId, {
    role: 'viewer', scopeId: scope.id, expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'Synthetic scope grant',
  }, { 'if-match': `"${projectVersion}"` });
  const viewer = await command('POST', '/api/sessions', { login: viewerLogin, password: viewerPassword }, { cookie: '' });
  const viewerHeaders = { cookie: viewer.headers['set-cookie'].split(';')[0], 'x-csrf-token': viewer.json().csrfToken };
  const fragments = `${projectPath}/scopes/${scope.id}/fragment-publications`;
  const raw = `/api/documents/${first.documentId}/versions/${first.versionId}/content`;
  const rawRange = { ...viewerHeaders, range: 'bytes=0-7' };
  assert.deepEqual((await command('GET', fragments, undefined, viewerHeaders)).json().items, []);
  await command('GET', raw, undefined, rawRange, 404);
  const selection = {
    documentId: first.documentId, versionId: first.versionId,
    page: 1, kind: 'quote', quote: 'Gap 30 mm', box: { x: 10, y: 110, width: 620, height: 24 },
    reason: 'Exact quote for the first facade',
  };
  await command('POST', fragments, { ...selection, versionId: randomUUID() }, {}, 404);
  await command('POST', fragments, { ...selection, box: { x: 0, y: 0, width: 640, height: 270 } }, {}, 422);
  const createKey = { 'idempotency-key': randomUUID() };
  const blocker = await app.db.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('facade/heavy-local-slot',0))");
    const busy = await command('POST', fragments, selection, createKey, 503);
    assert.equal(busy.json().code, 'reader_resource_wait');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const fragment = (await command('POST', fragments, selection, createKey, 201)).json();
  const replayed = await command('POST', fragments, selection, createKey, 201);
  assert.equal(replayed.headers['idempotency-replayed'], 'true');
  assert.deepEqual(replayed.json(), fragment);
  const cardPath = fragments + '/' + fragment.id;
  await command('GET', cardPath, undefined, viewerHeaders, 404);
  const grant = { 'if-match': '"1"', 'idempotency-key': randomUUID() };
  const grantBody = { reason: 'Checked the selected original' };
  await command('POST', cardPath + '/grant', grantBody, grant);
  const granted = (await command('GET', cardPath, undefined, viewerHeaders)).json();
  assert.deepEqual(granted, { id: fragment.id, page: 1, box: selection.box, quote: selection.quote, version: 2, state: 'granted' });

  delete process.env.FACADE_HARNESS_REPLAY_ONLY;
  process.env.FACADE_HARNESS_PACKAGE_EFFECTS = 'enabled';
  run();
  await upload('second.pdf', pdf([opposingDrawing, opposingTitle]));
  await command('POST', receiptUrl + '/seal', {});
  const complete = await until(analyze, ({ coverage }) => coverage.completedWindows === 2, 'completed package');
  assert.equal(complete.coverage.physicalProof.versionIds.length, 2);
  assert.equal(complete.coverage.subjectProof.facadeIds.length, 2);
  assert.deepEqual(complete.candidates.map(({ label }) => label).sort(), ['K-47', 'M-18']);
  assert.equal(complete.facts.length, 12);
  assert.equal(complete.facts.filter(({ binding }) => binding.state === 'common').length, 2);
  assert.equal(complete.facts.filter(({ observation }) => observation.deliveryStatement?.status === 'not_delivered').length, 2);
  const reviewed = await until(analyze, ({ verifiedPairs }) => verifiedPairs.length > 0, 'fresh pair review');
  assert.ok(reviewed.verifiedPairs.some(({ proof }) =>
    [proof.revisionA, proof.revisionB].map((value) => value.toUpperCase()).sort().join('/') === 'R1/R2'));
  const contextual = reviewed.facts.find(({ observation, basis }) => observation.value === '4.1' && basis.revisionEvidence);
  assert.equal(contextual.revision.toUpperCase(), 'R2');
  assert.equal(contextual.variant, 'v9');
  await command('GET', contextual.basis.revisionEvidence.href, undefined);
  const assessment = (await command('GET', `/api/v1/projects/${project.id}/facade-assessment`, undefined)).json();
  assert.equal(assessment.catalog, null);
  assert.equal(assessment.completedWindows, 2);
  assert.equal(assessment.observations.counts.common, 2);
  assert.deepEqual(assessment.contexts.filter(({ kind }) => kind === 'facade').map(({ name }) => name).sort(), ['K-47', 'M-18']);
  assert.ok(assessment.limitations.includes('catalog_unassigned'));
  assert.ok(complete.windows.every(({ branches }) => branches.A.jobId !== branches.B.jobId));
  const fact = complete.facts[0];
  await command('GET', fact.evidenceHref, undefined);
  await t.test('package bindings leave the fragment publication as the only scoped disclosure', async () => {
    const mixedFacts = complete.facts.filter(({ observation }) => observation.source.versionId === first.versionId);
    assert.ok(mixedFacts.some(({ binding }) => binding.candidates.some(({ label }) => label === 'K-47')));
    assert.ok(mixedFacts.some(({ binding }) => binding.candidates.some(({ label }) => label === 'M-18')));
    const mixedEvidence = new Set();
    for (const { observation, evidenceHref } of mixedFacts) {
      mixedEvidence.add(evidenceHref);
      await command('GET', '/api/v1/observations/' + observation.id, undefined, viewerHeaders, 404);
    }
    for (const evidence of mixedEvidence) {
      for (const path of [evidence, evidence + '/content', evidence + '/ocr-input']) {
        await command('GET', path, undefined, rawRange, 404);
      }
    }
    await command('HEAD', raw, undefined, viewerHeaders, 404);
    await command('GET', raw, undefined, rawRange, 404);
    await command('GET', raw.replace('/api/documents/', '/api/v1/documents/').replace('/content', '/reader/units'),
      undefined, viewerHeaders, 404);
    await command('GET', `${projectPath}/facade-assessment/${assessment.version}/observations`, undefined, viewerHeaders, 404);
    const scopedEvents = (await command('GET', `${projectPath}/events?after=0&scopeId=${scope.id}`, undefined, viewerHeaders)).json();
    assert.ok(scopedEvents.events.length);
    assert.ok(scopedEvents.events.every(({ type, payload }) => type === 'project.changed' && Object.keys(payload).length === 0));
    assert.deepEqual((await command('GET', cardPath, undefined, viewerHeaders)).json(), granted);
    assert.deepEqual((await command('GET', fragments, undefined, viewerHeaders)).json().items.map(({ id }) => id), [fragment.id]);
    const revocation = await command('POST', cardPath + '/revoke', { reason: 'Finished review' }, { 'if-match': '"2"' });
    assert.equal(revocation.json().version, 3);
    assert.equal((await command('POST', cardPath + '/grant', grantBody, grant)).headers['idempotency-replayed'], 'true');
    await command('GET', cardPath, undefined, viewerHeaders, 404);
    assert.deepEqual((await command('GET', fragments, undefined, viewerHeaders)).json().items, []);
    const history = (await command('GET', cardPath)).json().history;
    assert.deepEqual(history.map(({ version }) => version), [1, 2, 3]);
  });
  const event = await app.db.query("SELECT 1 FROM supplement_project_events WHERE project_id=$1 AND type='package-analysis.changed'", [project.id]);
  assert.ok(event.rowCount);

  const callsBeforeRestart = calls.length;
  const jobsBeforeRestart = complete.windows.flatMap(({ branches }) => [branches.A.jobId, branches.B.jobId]).sort();
  driver.abort();
  await worker;
  process.env.FACADE_HARNESS_REPLAY_ONLY = '1';
  run();
  const restored = await analyze();
  assert.deepEqual(restored.windows.flatMap(({ branches }) => [branches.A.jobId, branches.B.jobId]).sort(), jobsBeforeRestart);
  await delay(1200);
  assert.equal(calls.length, callsBeforeRestart);
  const journal = await external.query('SELECT coalesce(sum(spent_usd_nanos),0)::int AS spend FROM gateway_external_attempts');
  assert.equal(journal.rows[0].spend, 0);
  driver.abort();
  await worker;

  await t.test('addressed legacy transition preserves paid keys and unknown reserve under fair slot caps', async () => {
    const catalog = (await command('POST', '/api/catalogs', { key: 'legacy', name: 'Legacy',
      requirements: [{ key: 'gap', part: 'Gap', formats: ['pdf'], equivalents: [], applicability: 'all',
        sourceRoles: ['drawing'], completenessCriterion: 'Addressed value', addressee: 'customer' }] })).json();
    async function newProject(name, legacy = false) {
      const project = (await command('POST', '/api/projects', legacy
        ? { name, catalogVersionId: catalog.id, scopeName: 'Existing scope' } : { name, mode: 'intake' })).json();
      const receipt = (await command('POST', `/api/projects/${project.id}/receipts`, { source: 'upload' })).json();
      await upload('transition.pdf', pdf([name]), `/api/receipts/${receipt.receiptId}`);
      await command('POST', `/api/receipts/${receipt.receiptId}/seal`, {});
      return project;
    }
    const existing = await newProject('Existing package', true);
    const other = await newProject('Untouched historical package', true);
    const small = await newProject('Competing intake package');
    for (const project of [existing, small]) {
      for (const [routeId, purpose] of [['managed-a','primary_a'], ['managed-b','primary_b']]) {
        await gateway.grantRoute({ projectId: project.id, routeId, revision: 'fixture-v1', purpose, dataClass: 'synthetic', allowed: true });
      }
    }
    const { rows: [original] } = await app.db.query(
      `SELECT j.project_id AS "projectId",j.document_id AS "documentId",j.version_id AS "versionId", o.sha256
       FROM intake_reader_jobs j JOIN intake_originals o ON o.id=j.original_id WHERE j.project_id=$1`, [existing.id]);
    const place = { source: original, unitId: '1', page: 1 };
    const legacyRef = { projectId: existing.id, scopeId: existing.scopes[0].id, generationId: randomUUID() };
    let sends = 0;
    const legacyGateway = createGateway(app.db, { journal: new PostgresIntentJournal(external, process.env.FACADE_GATEWAY_LEDGER_ID),
      transport: { kind: 'managed', async send(attempt) {
        sends++;
        return attempt.purpose === 'primary_a'
          ? { receipt: { state: 'paid', providerId: 'legacy-paid', costUsdNanos: 0, evidenceRef: 'synthetic:old' }, output: { original: true } }
          : { receipt: { state: 'unknown', code: 'fixture-lost-receipt' } };
      } } });
    await legacyGateway.openGeneration(legacyRef);
    for (const branch of ['A', 'B']) {
      const id = 'legacy-' + branch;
      await legacyGateway.declarePrimary(legacyRef, { id, branch, place: 'original-window' });
      await legacyGateway.enqueue({ ...legacyRef, key: id, kind: 'legacy_fixture_research', subjectId: original.versionId,
        purpose: branch === 'A' ? 'primary_a' : 'primary_b', obligationId: id, payload: { mode: 'primary', branch, place } });
    }
    const seen = [];
    for (const expected of ['paid', 'held']) {
      const work = await legacyGateway.claim({ workerId: 'legacy-fixture', kinds: ['legacy_fixture_research'], leaseMs: 60_000 });
      const branch = work.payload.branch.toLowerCase();
      const call = { lease: work.lease, effectKey: 'legacy-step-' + branch, routeId: 'managed-' + branch,
        dataClass: 'synthetic', request: { original: branch }, inputRefs: [] };
      const result = await legacyGateway.call(call);
      assert.equal(result.status, expected);
      seen.push({ call, result });
    }
    const before = (await app.db.query(`SELECT id,effect_key,state,ceiling_usd_nanos FROM gateway_attempts
      WHERE project_id=$1 ORDER BY state`, [existing.id])).rows;
    assert.deepEqual(before.map(({ state }) => state), ['paid', 'unknown']);
    const readerVersion = complete.windows[0].readerVersion;
    const map = {
      formatFor: () => 'pdf', readerVersion: async () => readerVersion,
      async map(source) {
        const count = source.projectId === existing.id ? 2625 : 3;
        return { format: 'pdf', source, readerVersion, units: Array.from({ length: count }, (_, index) => ({
          id: String(index + 1), width: 600, height: 400, locator: { page: index + 1 },
        })) };
      },
    };
    await activatePackageProjects(app.db, gateway, [existing.id]);
    const target = (await app.db.query('SELECT generation_id FROM harness_package_projects WHERE project_id=$1', [existing.id])).rows[0];
    await activatePackageProjects(app.db, gateway, [existing.id]);
    assert.deepEqual((await app.db.query('SELECT generation_id FROM harness_package_projects WHERE project_id=$1', [existing.id])).rows[0], target);
    assert.equal(await preparePackageMap(app.db, gateway, map, [existing.id]), true);
    assert.equal(await preparePackageMap(app.db, gateway, map, [existing.id]), true);
    assert.equal(await preparePackageMap(app.db, gateway, map, [existing.id]), false);

    const profile = loadResearchProfile({});
    for (let index = 0; index < 12; index++) if (!await dispatchPackagePair(app.db, gateway, profile)) break;
    const large = await readPackageAnalysis(app.db, existing.id);
    const competing = await readPackageAnalysis(app.db, small.id);
    assert.equal(large.windows.length, 2625);
    assert.equal(large.coverage.completedWindows, 0);
    assert.deepEqual(Object.values(large.windows[0].branches).map(({ reason }) => reason),
      ['prior_paid_window_incompatible', 'prior_effect_unsettled']);
    assert.equal(large.windows.flatMap(({ branches }) => Object.values(branches)).filter(({ jobId }) => jobId).length, 8);
    assert.equal(competing.windows.length, 3);
    assert.ok(competing.windows.every(({ branches }) => branches.A.jobId && branches.B.jobId));
    assert.equal((await readPackageAnalysis(app.db, other.id)).windows.length, 0);
    assert.deepEqual((await app.db.query(`SELECT id,effect_key,state,ceiling_usd_nanos FROM gateway_attempts
      WHERE project_id=$1 ORDER BY state`, [existing.id])).rows, before);
    const nextReaderVersion = readerVersion + ';fixture-profile=v2';
    const switched = { ...map, readerVersion: async () => nextReaderVersion,
      async map(source) { return { ...await map.map(source), readerVersion: nextReaderVersion }; } };
    // The same source and frames are read under a new derived-map contract.
    for (let index = 0; index < 4; index++) assert.equal(await preparePackageMap(app.db, gateway, switched, [existing.id]), true);
    assert.equal(await preparePackageMap(app.db, gateway, switched, [existing.id]), false);
    for (let index = 0; index < 12; index++) if (!await dispatchPackagePair(app.db, gateway, profile)) break;
    const changed = await readPackageAnalysis(app.db, existing.id);
    assert.notEqual(changed.windows[0].id, large.windows[0].id);
    assert.deepEqual(changed.windows[0].place, large.windows[0].place);
    assert.equal(changed.coverage.completedWindows, 0);
    assert.deepEqual(Object.values(changed.windows[0].branches).map(({ reason }) => reason),
      ['prior_paid_window_incompatible', 'prior_effect_unsettled']);
    await command('GET', contextual.basis.revisionEvidence.href, undefined);
    assert.equal((await legacyGateway.call(seen[0].call)).replay, true);
    assert.equal((await legacyGateway.call(seen[1].call)).code, 'unknown_charge');
    const stopId = randomUUID();
    const unknownJob = seen[1].call.lease.jobId;
    await app.db.query("INSERT INTO harness_research_events(job_id,sequence,event) VALUES($1,1,'{}')", [unknownJob]);
    await app.db.query('INSERT INTO harness_research_stops(id,job_id,sequence) VALUES($1,$2,1)', [stopId, unknownJob]);
    const resumeUrl = `/api/projects/${existing.id}/research-stops/${stopId}/resume`;
    await command('POST', resumeUrl, {}, { 'if-match': '"2"' }, 412);
    const blocked = await command('POST', resumeUrl, {}, { 'if-match': '"1"' }, 409);
    assert.equal(blocked.json().code, 'research_attempt_unsettled');
    assert.equal((await app.db.query('SELECT resume_requested_at FROM harness_research_stops WHERE id=$1', [stopId]))
      .rows[0].resume_requested_at, null);
    assert.equal(sends, 2);
  });
});
