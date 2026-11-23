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
  const stream = `BT /T 9 Tf 20 140 Td ${drawing} ET`;
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
  const end = Date.now() + 60_000;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await delay(250);
  } while (Date.now() < end);
  assert.fail(`${label} — ${JSON.stringify(last)}`);
}

function tool(name, args) {
  return { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function',
      function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

const primaryDrawing = 'Drawing | current revision R1 | variant V9 | scope: K-47 | project facade ID: K-47 | Gap 30 mm';
const opposingDrawing = 'Drawing | current revision R2 | variant V9 | scope: K-47 | project facade ID: K-47 | Gap 41 mm';
const register = 'Complete list of facades | project facade ID: K-47 | project facade ID: M-18 | all common materials listed';
const notDelivered = 'Transmittal | current revision R1 | project facade ID: M-18 | thermal report not delivered';
const common = 'Specification | applies to all facades | current revision R1 | System vent';
function observation(line) {
  const lower = line.text.toLowerCase();
  const ids = [...line.text.matchAll(/project facade ID: ([\w-]+)/g)];
  const revision = /current revision (\w+)/.exec(line.text);
  const role = lower.includes('drawing') ? { value: 'drawing', quote: 'Drawing' }
    : lower.includes('specification') ? { value: 'specification', quote: 'Specification' }
      : lower.includes('transmittal') ? { value: 'inventory', quote: 'Transmittal' } : undefined;
  const attribute = lower.includes('gap') ? 'Gap' : lower.includes('thermal report') ? 'thermal report' :
    lower.includes('system vent') ? 'System vent' : lower.includes('mar?') ? 'Material identifier' : 'Facade register';
  const value = /Gap (\d+) mm/.exec(line.text)?.[1];
  const binding = ids.length ? {
    state: 'identified', labels: ids.map((item) => item[1]), projectIdentifiers: ids.map((item) => ({ label: item[1], quote: item[0] })),
    quote: line.text, reason: 'Printed project facade identifier.',
  } : lower.includes('all facades') ? {
    state: 'common', labels: [], quote: 'applies to all facades', reason: 'The specification expressly applies to every facade.',
  } : { state: 'unclear', labels: [], quote: line.text, reason: 'Incomplete material identifier.' };
  return {
    quote: line.text, lineId: line.id, ...(value ? { value, unit: 'mm' } : {}),
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
  skip: !enabled, timeout: 175_000,
}, async (t) => {
  const { createApi } = await import(built('src/platform/api.js'));
  const { readConfig } = await import(built('src/platform/config.js'));
  const { bootstrapAdmin } = await import(built('src/modules/access/bootstrap.js'));
  const { createGateway } = await import(built('src/modules/gateway/index.js'));
  const { startWorker, readPackageAnalysis } = await import(built('src/modules/harness/index.js'));
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
          const sources = texts.map((reply) => ({ evidenceId: reply.evidence.evidenceId, quote: JSON.parse(reply.content).lines[0].text }));
          const check = { status: 'confirmed', reason: 'Both sources print this scope, variant and effective revision.', sources };
          const proof = { explanation: 'Checked the two addressed drawing lines.',
            evidenceIds: sources.map(({ evidenceId }) => evidenceId),
            checks: { variant: check, revision: check, applicability: check, comparability: check } };
          output = assignment.mode === 'lead'
            ? tool('propose_resolution', { aObservationId: a.observationId, bObservationId: b.observationId, ...proof })
            : tool('verify_resolution', { verdict: 'supported', ...proof });
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
      ...credentials, ...headers, 'idempotency-key': randomUUID() } });
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
  async function upload(relativePath, pdfBytes) {
    const { uploadId } = (await command('POST', receiptUrl + '/uploads', {
      relativePath, size: pdfBytes.length, sha256: sha(pdfBytes), mediaType: 'application/pdf',
    })).json();
    await command('PUT', `/api/uploads/${uploadId}/parts/1`, pdfBytes, {
      'content-type': 'application/octet-stream', 'x-part-sha256': sha(pdfBytes), 'content-length': String(pdfBytes.length),
    });
    await command('POST', `/api/uploads/${uploadId}/complete`, {});
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
  await upload('first.pdf', pdf([primaryDrawing, register, notDelivered, common]));
  const passive = await until(analyze, ({ windows }) => windows.some(({ branches }) => branches.A.status === 'held'), 'passive hold');
  assert.equal(calls.length, 0);
  assert.equal(passive.facts.length, 0);
  assert.equal(passive.coverage.completedWindows, 0);

  driver.abort();
  await worker;
  delete process.env.FACADE_HARNESS_REPLAY_ONLY;
  process.env.FACADE_HARNESS_PACKAGE_EFFECTS = 'enabled';
  run();
  await upload('second.pdf', pdf([opposingDrawing]));
  await command('POST', receiptUrl + '/seal', {});
  const complete = await until(analyze, ({ coverage }) => coverage.completedWindows === 2, 'completed package');
  assert.equal(complete.coverage.physicalProof.versionIds.length, 2);
  assert.equal(complete.coverage.subjectProof.facadeIds.length, 2);
  assert.deepEqual(complete.candidates.map(({ label }) => label).sort(), ['K-47', 'M-18']);
  assert.equal(complete.facts.length, 10);
  assert.equal(complete.facts.filter(({ binding }) => binding.state === 'common').length, 2);
  assert.equal(complete.facts.filter(({ observation }) => observation.deliveryStatement?.status === 'not_delivered').length, 2);
  const reviewed = await until(analyze, ({ verifiedPairs }) => verifiedPairs.length > 0, 'fresh pair review');
  assert.ok(reviewed.verifiedPairs.some(({ proof }) =>
    [proof.revisionA, proof.revisionB].sort().join('/') === 'R1/R2'));
  assert.ok(complete.windows.every(({ branches }) => branches.A.jobId !== branches.B.jobId));
  const fact = complete.facts[0];
  await command('GET', fact.evidenceHref, undefined);
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
});
