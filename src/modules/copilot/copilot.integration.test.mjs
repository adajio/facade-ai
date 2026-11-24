import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID as id } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.FACADE_COPILOT_TEST_DB;
const journalUrl = process.env.FACADE_COPILOT_TEST_JOURNAL;
const dist = '../../../dist/src/';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

function responseTools(attempt, calls) {
  return {
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: calls.map(([name, args], index) => ({
      id: 'call-' + attempt.id + (index ? '-' + index : ''), type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } }],
  };
}

const responseTool = (attempt, name, args) => responseTools(attempt, [[name, args]]);

test('engineer question reopens originals through the gateway and restricted search honors publication revocation', {
  skip: !databaseUrl || !journalUrl, timeout: 300_000,
}, async (t) => {
  assert.notEqual(databaseUrl, journalUrl);
  const { createApi } = await import(dist + 'platform/api.js');
  const { openRouterTransport } = await import(dist + 'modules/gateway/openrouter.js');
  const { createGateway, PostgresIntentJournal } = await import(dist + 'modules/gateway/index.js');
  const { digest, csrfToken } = await import(dist + 'modules/access/auth.js');
  const { createRuntimePdfService } = await import(dist + 'modules/pdf/index.js');
  const { indexNextProjectMemory } = await import(dist + 'modules/project-memory/index.js');
  const { createCopilotMemory, createCopilotResearch, copilotModelAdmission, processNextCopilot, copilotKind } =
    await import(dist + 'modules/copilot/index.js');
  const { verifyCopilotInputs } = await import(dist + 'modules/copilot/admission.js');

  const objects = new Map();
  const s3 = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const key = path.slice('/copilot-fixture/'.length);
    try {
      if (request.method === 'PUT') {
        const bytes = Buffer.concat(await Array.fromAsync(request));
        assert.equal(request.headers['x-amz-meta-sha256'], sha(bytes));
        objects.set(key, bytes);
        response.writeHead(200, { etag: '"fixture"' }).end();
      } else if (objects.has(key)) {
        const bytes = objects.get(key);
        response.writeHead(200, { 'Content-Length': bytes.length, 'x-amz-meta-sha256': sha(bytes) });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  const endpoint = await listen(s3);
  const portReservation = createServer();
  const origin = await listen(portReservation);
  const port = portReservation.address().port;
  await new Promise((done) => portReservation.close(done));
  Object.assign(process.env, {
    FACADE_PUBLIC_ORIGIN: origin,
    FACADE_S3_ENDPOINT: endpoint, FACADE_S3_BUCKET: 'copilot-fixture',
    AWS_ACCESS_KEY_ID: 'copilot-local-fixture', AWS_SECRET_ACCESS_KEY: 'copilot-local-fixture',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    FACADE_INTAKE_DISK_GUARD_BYTES: '0',
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'facade-copilot-'));
  const ledgerDb = new pg.Pool({ connectionString: journalUrl });
  let app;
  let reader;
  let browser;
  t.after(async () => {
    await browser?.close();
    reader?.close();
    await app?.close();
    await ledgerDb.end();
    s3.closeAllConnections();
    await new Promise((done) => s3.close(done));
    await rm(dataDir, { recursive: true, force: true });
  });

  app = await createApi({ databaseUrl, dataDir, host: '127.0.0.1', port });
  const db = app.db;
  reader = createRuntimePdfService(db, { dataDir });
  const memory = createCopilotMemory(db, () => reader);
  const ledgerId = id();
  await ledgerDb.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES($1)', [ledgerId]);
  const journal = new PostgresIntentJournal(ledgerDb, ledgerId);
  const organization = id(), project = id(), anotherProject = id(), scope = id();
  const engineer = id(), restricted = id();
  const catalog = id();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic question')", [organization]);
  await db.query(`INSERT INTO users(id,organization_id,login,password_hash,state)
    VALUES($1::uuid,$3,$1::uuid::text,'$argon2id$test','active'),($2::uuid,$3,$2::uuid::text,'$argon2id$test','active')`,
    [engineer, restricted, organization]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'copilot',1,'Synthetic','[]',$3)",
    [catalog, organization, engineer]);
  await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id) VALUES($1,$3,'Synthetic facade',$4),($2,$3,'Other facade',$4)",
    [project, anotherProject, organization, catalog]);
  await db.query("INSERT INTO project_scopes(id,project_id,stage,name) VALUES($1,$2,'РД','Опубликованная область')", [scope, project]);
  await db.query(`INSERT INTO project_memberships(organization_id,project_id,user_id,role,scope_id,expires_at,reason) VALUES
    ($1,$2,$3,'engineer',NULL,NULL,NULL),
    ($1,$2,$4,'viewer',$5,now()+interval '1 hour','Synthetic scope')`, [organization, project, engineer, restricted, scope]);

  async function session(userId) {
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [userId, digest(token)]);
    return token;
  }
  const ownerToken = await session(engineer);
  const participantToken = await session(restricted);
  async function inject(url, { token = ownerToken, method = 'GET', payload, key = id() } = {}) {
    return app.inject({
      method, url, payload, headers: { cookie: 'facade_session=' + token, origin,
        'x-csrf-token': csrfToken(token), 'idempotency-key': key },
    });
  }
  async function get(url, options) {
    const response = await inject(url, options);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  async function ask(question, key = id(), token = ownerToken) {
    return inject(base + '/questions', { method: 'POST', payload: { question }, key, token });
  }

  async function accept(filename, bytes, mediaType, options = {}) {
    const projectId = options.projectId ?? project;
    const receipt = id(), original = id(), versionId = id(), documentId = options.replaces?.documentId ?? id();
    const sha256 = sha(bytes), objectKey = 'fixture/' + original;
    objects.set(objectKey, bytes);
    await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by) VALUES($1,$2,'upload',$3)", [receipt, projectId, engineer]);
    if (!options.replaces) await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)', [documentId, projectId]);
    await db.query('INSERT INTO intake_originals(id,project_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5)',
      [original, projectId, objectKey, sha256, bytes.length]);
    await db.query(`INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type,replaces_version_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [versionId, projectId, documentId, original, mediaType, options.replaces?.versionId ?? null]);
    await db.query(`INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
      VALUES($1,$2,$3,$4,$5,'accepted')`, [projectId, receipt, filename, mediaType, versionId]);
    await db.query(`INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      VALUES($1,$2,$3,$4,$5)`, [projectId, receipt, documentId, versionId, original]);
    return { documentId, versionId, sha256 };
  }
  const table = await accept('schedule.xlsx', await readFile(new URL('../formats/test/fixtures/schedule.xlsx', import.meta.url)),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const drawing = await accept('mixed-raster.pdf', await readFile(new URL('../formats/test/fixtures/mixed-raster.pdf', import.meta.url)), 'application/pdf');
  const privateFile = await accept('other-only.txt', Buffer.from('Thickness OTHER_PROJECT_PRIVATE'), 'text/plain', { projectId: anotherProject });
  for (let operation = 0; ; operation++) {
    assert.ok(operation < 60);
    if (!await indexNextProjectMemory(db, reader)) break;
  }
  console.info('Copilot fixture: original XLSX and PDF indexed');
  const base = '/api/projects/' + project + '/copilot';
  const pub = id();
  await db.query(`INSERT INTO fragment_publications(id,project_id,scope_id,document_id,original_version_id,original_sha256,reader_version,page,box,quote)
    VALUES($1,$2,$3,$4,$5,$6,'fixture',1,'{"x":10,"y":10,"height":5,"width":7}','Permitted synthetic quote')`,
    [pub, project, scope, drawing.documentId, drawing.versionId, drawing.sha256]);
  await db.query("INSERT INTO fragment_publication_revisions(publication_id,version,actor_id,reason) VALUES($1,1,$2,'Draft'),($1,2,$2,'Grant')",
    [pub, engineer]);

  const found = await get(base + '/search?q=Thickness');
  const cell = found.sources.find((source) => source.versionId === table.versionId);
  assert.equal(cell.address.locator.cell, 'B2');
  assert.ok(found.windows.some(({ versionId }) => versionId === drawing.versionId));
  assert.doesNotMatch(JSON.stringify(found), new RegExp(privateFile.versionId + '|OTHER_PROJECT_PRIVATE'));
  const cellPath = base + '/sources?id=' + cell.id;
  const originalPath = '/api/documents/' + table.documentId + '/versions/' + table.versionId + '/content';
  const originalFile = await inject(originalPath);
  assert.equal(originalFile.statusCode, 200, originalFile.body);
  assert.equal(sha(originalFile.rawPayload), table.sha256);
  assert.equal((await get(cellPath)).source.text, 'Thickness, mm');
  assert.ok((await get(cellPath)).source.context.some((entry) => entry.address.locator.cell === 'A2'));
  assert.equal((await inject(base + '/search?q=Thickness', { token: participantToken })).statusCode, 404);
  const limited = { token: participantToken };
  assert.deepEqual((await get(base + '/search?q=Thickness&scopeId=' + scope, limited)).sources, []);
  assert.equal((await inject(cellPath + '&scopeId=' + scope, limited)).statusCode, 404);
  assert.equal((await inject(originalPath, limited)).statusCode, 404);
  assert.equal((await ask('Чужой вопрос', id(), participantToken)).statusCode, 404);
  const published = await get(base + '/search?q=Permitted&scopeId=' + scope, limited);
  assert.deepEqual(Object.keys(published.sources[0]).sort(), ['id', 'page', 'quote']);
  const publishedPath = base + '/sources?id=' + published.sources[0].id + '&scopeId=' + scope;
  assert.equal((await get(publishedPath, limited)).source.quote, 'Permitted synthetic quote');

  const sent = [];
  const readBatchQueries = Array.from({ length: 10 }, (_, index) => 'JOURNAL-ITEM-' + (index + 10));
  const route = { routeId: 'fixture-copilot', model: 'managed/copilot', dataClass: 'synthetic', maxTokens: 850 };
  const policy = { id: route.routeId, revision: 'fixture-v1', transport: 'managed', enabled: true,
    maxRequestBytes: 1_000_000, ceilingUsdNanos: 1, timeoutMs: 4000 };
  const historicCost = 1;
  const fraction = 1_000_000_000;
  const limitRoute = { ...route, routeId: 'fixture-copilot-limit' };
  const limitPolicy = { ...policy, id: limitRoute.routeId, ceilingUsdNanos: fraction / 4 };
  const gatewayOptions = {
    journal, researchAdmission: copilotModelAdmission(), reviewAdmission: async () => 'early',
    transport: {
      kind: 'managed',
      async send(attempt, _, request) {
        sent.push({ attempt, request });
        const paid = (output, costUsdNanos = 0) => ({
          output,
          receipt: { state: 'paid', costUsdNanos, providerId: 'fixture-' + attempt.id, evidenceRef: 'fixture:' + attempt.id },
        });
        if (attempt.purpose === 'primary_a') return paid({ result: 'background' }, attempt.ceilingUsdNanos);
        const question = request.messages[1].content;
        assert.doesNotMatch(JSON.stringify(request), /OTHER_PROJECT_PRIVATE|Permitted synthetic quote/);
        if (question === 'UNKNOWN') return { receipt: { state: 'unknown', code: 'fixture_unknown' } };
        const toolReplies = request.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
        const research = question === 'OCR';
        if (question === 'D11') {
          const [found, openedSource, ocr] = toolReplies;
          const quarter = limitPolicy.ceilingUsdNanos;
          // The old paid receipt and the open unknown reserve already occupy part of the share.
          if (!found) return paid(responseTool(attempt, 'search_sources', { query: 'Thickness' }),
            quarter - historicCost - policy.ceilingUsdNanos);
          if (!openedSource) return paid(responseTool(attempt, 'open_source', {
            sourceId: found.sources.find(({ versionId }) => versionId === table.versionId).sourceId,
          }), quarter);
          if (!ocr) return paid(responseTool(attempt, 'research_source', {
            sourceId: found.unresolvedWindows.find(({ versionId }) => versionId === drawing.versionId).sourceId,
            reason: 'Сверить растровую надпись',
          }), quarter);
          assert.equal(ocr.source.representation, 'ocr');
          assert.equal(ocr.source.versionId, drawing.versionId);
          return paid(responseTool(attempt, 'search_sources', { query: 'Thickness' }), quarter);
        }
        if (question === 'READ_BATCH_REPLAY') {
          const turn = sent.filter((item) => item.request.messages[1].content === question).length;
          if (turn <= 6) {
            const group = 'ABC'[Math.floor((turn - 1) / 2)];
            if (turn % 2) return paid(responseTool(attempt, 'search_sources', { query: 'JOURNAL-GROUP-' + group }));
            return paid(responseTools(attempt, toolReplies.at(-1).sources.map(({ sourceId }) => ['open_source', { sourceId }])));
          }
          assert.equal(turn, 7);
          return paid(responseTools(attempt, readBatchQueries.map((query) => ['search_sources', { query }])));
        }
        if (question === 'READ_JOURNAL') {
          const turn = sent.filter((item) => item.request.messages[1].content === question).length;
          const last = toolReplies.at(-1);
          if (turn === 1) return paid(responseTools(attempt, ['A', 'B', 'C', 'D', 'E']
            .map((group) => ['search_sources', { query: 'JOURNAL-GROUP-' + group }])));
          if (turn <= 19) {
            const number = Math.floor((turn - 2) / 2) + 1;
            return turn % 2 === 0
              ? paid(responseTool(attempt, 'search_sources', { query: 'JOURNAL-ITEM-' + String(number).padStart(2, '0') }))
              : paid(responseTool(attempt, 'open_source', { sourceId: last.sources[0].sourceId }));
          }
          if (turn === 20) {
            assert.equal(toolReplies.some(({ source }) => source?.text.includes('JOURNAL-ITEM-01')), false);
            return paid(responseTool(attempt, 'search_sources', { query: 'JOURNAL-ITEM-01' }));
          }
          assert.equal(turn, 21);
          return paid(responseTool(attempt, 'submit_answer', {
            claims: [{ text: 'Ссылка на первую прочитанную строку.', sources: [last.sources[0].sourceId] }], limitations: [],
          }));
        }
        if (question === 'PARTIAL_JOURNAL') {
          const turn = sent.filter((item) => item.request.messages[1].content === question).length;
          const last = toolReplies.at(-1);
          if (turn === 1 || turn === 3 || turn === 5) {
            const query = ({ 1: 'JOURNAL-GROUP-A', 3: 'JOURNAL-GROUP-B', 5: 'JOURNAL-ITEM-99' })[turn];
            return paid(responseTool(attempt, 'search_sources', { query }));
          }
          assert.ok(turn === 2 || turn === 4);
          assert.equal(last.sources.length, 4);
          return paid(responseTools(attempt, last.sources.map(({ sourceId }) => ['open_source', { sourceId }])));
        }
        if (question === 'MULTIPLE_OPENS') {
          if (!toolReplies.length) return paid(responseTool(attempt, 'search_sources', { query: 'QUANTUM' }));
          if (toolReplies.length === 1) {
            assert.equal(toolReplies[0].sources.length, 3);
            return paid(responseTools(attempt, toolReplies[0].sources.map(({ sourceId }) => ['open_source', { sourceId }])));
          }
          const openTurn = request.messages.find(({ tool_calls }) => tool_calls?.length === 3);
          const replies = request.messages.slice(request.messages.indexOf(openTurn) + 1);
          assert.deepEqual(replies.map(({ tool_call_id }) => tool_call_id), openTurn.tool_calls.map(({ id }) => id));
          const opened = replies.map(({ content }) => JSON.parse(content).source);
          assert.deepEqual(opened.map(({ text }) => text), ['QUANTUM-A', 'QUANTUM-B', 'QUANTUM-C']);
          return paid(responseTool(attempt, 'submit_answer', {
            claims: [{ text: 'Сверены три строки синтетического документа.', sources: opened.map(({ sourceId }) => sourceId) }],
            limitations: [],
          }));
        }
        let name, args;
        if (question === 'OCR_QUANTUM') {
          const turn = sent.filter((item) => item.request.messages[1].content === question).length;
          const last = toolReplies.at(-1);
          if (turn <= 7) {
            if (turn % 2) {
              name = 'search_sources';
              args = { query: ['Thickness', 'QUANTUM-A', 'QUANTUM-B', 'QUANTUM-C'][(turn - 1) / 2] };
            } else {
              name = 'open_source';
              args = { sourceId: last.sources[0].sourceId };
            }
          } else {
            assert.ok(request.messages.length <= 16);
            const windows = toolReplies.findLast((entry) => entry.unresolvedWindows?.length === 2)?.unresolvedWindows;
            if (turn <= 9) assert.equal(new Set(windows?.map(({ versionId }) => versionId)).size, 2);
            const previous = request.messages.findLast((entry) =>
              entry.tool_calls?.[0]?.function.name === 'research_source');
            const sourceId = turn <= 9 ? windows[turn === 8 ? 0 : 1].sourceId
              : JSON.parse(previous.tool_calls[0].function.arguments).sourceId;
            name = 'research_source';
            args = { sourceId, reason: 'Сверить отдельный PDF-адрес' };
          }
        } else if (!toolReplies.length) {
          name = 'search_sources';
          args = { query: research ? 'unmatched-ocr-only-target' : 'Thickness' };
        } else if (toolReplies.length === 1) {
          const target = research ? toolReplies[0].unresolvedWindows[0] : toolReplies[0].sources.find(({ versionId }) => versionId === table.versionId);
          assert.ok(target);
          name = research ? 'research_source' : 'open_source';
          args = research ? { sourceId: target.sourceId, reason: 'Сверить растровую надпись в этой странице' } : { sourceId: target.sourceId };
        } else {
          const actual = toolReplies[1].source;
          if (research) {
            assert.ok(actual?.representation === 'ocr' || toolReplies[1].code === 'research_unavailable');
            name = 'submit_answer';
            args = { claims: [], limitations: ['Требуется сверка снимка с оригиналом.'] };
          } else {
            assert.equal(actual.address.locator.cell, 'B2');
            assert.equal(actual.text, 'Thickness, mm');
            name = 'submit_answer';
            args = { claims: [{ text: 'Единица толщины в ведомости — миллиметры.', sources: [actual.sourceId] }],
              limitations: ['Применимость к другим фасадам требует сверки.'] };
          }
        }
        return paid(responseTool(attempt, name, args), attempt.budget ? 0 : historicCost);
      },
    },
  };
  const gateway = createGateway(db, gatewayOptions);
  await gateway.configureRoute(policy);
  await gateway.grantRoute({ projectId: project, routeId: route.routeId, revision: policy.revision,
    purpose: 'review', dataClass: route.dataClass, allowed: true });
  const runtime = { db, gateway, memory, route: null, workerId: id(), research: createCopilotResearch(db, reader) };
  const signal = new AbortController().signal;
  const next = (override = {}) => processNextCopilot({ ...runtime, ...override }, signal);

  const commandKey = id();
  const question = 'В каких единицах указана толщина в ведомости?';
  const submission = await ask(question, commandKey);
  assert.equal(submission.statusCode, 202, submission.body);
  const questionId = submission.json().id;
  const questionPath = base + '/questions/' + questionId;
  assert.deepEqual((await ask(question, commandKey)).json(), { id: questionId });
  assert.equal((await ask('Изменённый вопрос', commandKey)).statusCode, 409);
  assert.equal(await next(), true);
  assert.deepEqual(await get(questionPath), { id: questionId, question, state: 'held', reason: 'model_unavailable' });
  assert.equal(sent.length, 0);
  assert.equal((await inject(questionPath, limited)).statusCode, 404);

  const generation = { projectId: project, scopeId: null, generationId: id() };
  await gateway.openGeneration(generation);
  const primaryManifest = [
    { id: 'copilot-fixture-A', branch: 'A', place: 'fixture-pdf:1' },
    { id: 'copilot-fixture-B', branch: 'B', place: 'fixture-pdf:1' },
  ];
  await gateway.sealGeneration(generation, primaryManifest);
  const primaryJob = await gateway.enqueue({ ...generation, key: 'fixture-running-primary', kind: 'fixture-primary',
    purpose: 'primary_a', obligationId: primaryManifest[0].id, subjectId: 'fixture-pdf' });
  const activePrimary = await gateway.claim({ workerId: id(), kinds: ['fixture-primary'], leaseMs: 600_000 });
  assert.equal(activePrimary.lease.jobId, primaryJob);
  const primaryCursor = { researchSequence: 3 };
  assert.equal(await gateway.checkpoint(activePrimary.lease, primaryCursor), true);
  assert.equal(await next({ route }), true);
  let failCheckpoint = true;
  // Write the first paid response as an older worker did, before configuring the project budget.
  const legacyGateway = createGateway(db, { ...gatewayOptions, researchAdmission: undefined });
  const interruptedGateway = new Proxy(gateway, { get(target, property) {
    if (property === 'call') return ({ budget: _budget, ...input }) => legacyGateway.call(input);
    if (property === 'checkpoint' && failCheckpoint) return async () => {
      failCheckpoint = false;
      throw new Error('fixture stops after a paid response');
    };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  await assert.rejects(next({ route, gateway: interruptedGateway }), /fixture stops after a paid response/);
  await ledgerDb.query('INSERT INTO gateway_external_project_budgets VALUES($1,$2)', [project, fraction * 10]);
  await db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp() - interval '1 second' WHERE kind=$1 AND state='leased'", [copilotKind]);
  assert.equal(await next({ route, workerId: id() }), true);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].attempt.budget, undefined);
  const { rows: [historicalAttempt] } = await db.query(
    'SELECT budget,state,receipt FROM gateway_attempts WHERE id=$1', [sent[0].attempt.id]);
  assert.equal(historicalAttempt.budget, null);
  assert.equal(historicalAttempt.state, 'paid');
  assert.equal(historicalAttempt.receipt.costUsdNanos, historicCost);
  for (const { attempt } of sent.slice(1)) {
    assert.deepEqual(attempt.budget, { initiatedBy: 'copilot', packageId: project });
  }
  const answer = await get(questionPath);
  assert.equal(answer.state, 'answered');
  assert.equal(answer.claims[0].text, 'Единица толщины в ведомости — миллиметры.');
  assert.equal(answer.citations[0].id, cell.id);
  assert.equal(answer.citations[0].version, 'current');
  const { rows: [{ job_id: jobId }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [questionId]);
  assert.equal((await db.query('SELECT count(*)::int AS value FROM copilot_questions WHERE project_id=$1', [project])).rows[0].value, 1);
  assert.equal((await db.query('SELECT count(*)::int AS value FROM gateway_attempts WHERE job_id=$1', [jobId])).rows[0].value, 3);

  const tx = await db.connect();
  try {
    const { rows: [{ cursor }] } = await tx.query('SELECT cursor FROM gateway_jobs WHERE id=$1', [jobId]);
    const context = { projectId: project, scopeId: null, jobId, inputRefs: cursor.found.map(({ id }) => id) };
    assert.equal(await verifyCopilotInputs(tx, context, [table.sha256, drawing.sha256]), true);
    assert.equal(await verifyCopilotInputs(tx, context, [table.sha256]), false);
    assert.equal(await verifyCopilotInputs(tx, { ...context, projectId: anotherProject }, [table.sha256, drawing.sha256]), false);
    assert.equal(await verifyCopilotInputs(tx, { ...context, inputRefs: context.inputRefs.slice(0, 1) }, [table.sha256, drawing.sha256]), false);
    const profile = {
      routeId: 'fixture-synthetic', revision: 'test-v1', model: 'moonshotai/kimi-k3.1-pro',
      provider: 'decart/mxfp4', expectedResponseProvider: 'Decart', mode: 'synthetic-research',
      zdrEvidenceRef: 'fixture:zdr', boundEvidenceRef: 'fixture:rates', validUntil: '2099-01-01T00:00:00Z',
      inputTokenUpperBound: 1000, outputTokenLimit: 500, maxImages: 1, maxImagePixels: 4,
      maxImageWidth: 2, maxImageHeight: 2, maxImageBytes: 1024, promptNanosPerToken: 100, completionNanosPerToken: 200,
      cacheReadNanosPerToken: 15, cacheWriteNanosPerToken: 125, cacheBilling: 'replaces-input',
      reasoningNanosPerToken: 300, reasoningBilling: 'replaces-output', completionCapIncludesReasoning: true,
      completionParameter: 'max_tokens', requestNanos: 1000, imageNanos: 20000, additionalNanos: 100, knownNoChargeStatuses: [],
      syntheticScopes: [{ projectId: project, scopeId: null, approvalRef: 'fixture:scope', originalSha256s: [table.sha256, drawing.sha256] }],
    };
    const openRouter = openRouterTransport({ qualification: 'step-15', endpoint: 'https://openrouter.ai',
      apiKey: 'local-admission-test', profiles: [profile] });
    const syntheticRoute = { ...policy, id: profile.routeId, revision: profile.revision, transport: 'openrouter' };
    const wireContext = { ...context, dataClass: 'synthetic', generationId: generation.generationId, payload: { mode: 'copilot' } };
    assert.equal(await openRouter.authorize(tx, syntheticRoute, wireContext), true);
    assert.equal(await openRouter.authorize(tx, syntheticRoute, { ...wireContext, scopeId: scope }), false);
    assert.equal(await openRouter.authorize(tx, syntheticRoute, { ...wireContext, dataClass: 'private' }), false);
    assert.equal(await openRouter.authorize(tx, syntheticRoute, { ...wireContext, inputRefs: [] }), false);
  } finally {
    tx.release();
  }

  console.info('Copilot fixture: answer, paid replay and synthetic route authorization checked');
  const researchId = (await ask('OCR')).json().id;
  const researchPath = base + '/questions/' + researchId;
  assert.equal(await next({ route }), true);  // enqueue
  assert.equal(await next({ route }), true);  // model requests one exact mapped page
  const inQueue = await get(researchPath);
  assert.equal(inQueue.state, 'research_queued');
  const researchSource = await get(base + '/sources?id=' + inQueue.researchSourceId);
  assert.equal(researchSource.source.versionId, drawing.versionId);
  assert.equal(researchSource.source.address.locator.page, 1);
  // A pending cursor created before per-address operation keys still uses its original Reader key.
  await db.query(`UPDATE gateway_jobs SET cursor=cursor #- '{research,addressKey}'
    WHERE id=(SELECT job_id FROM copilot_questions WHERE id=$1)`, [researchId]);
  assert.equal(await next({ route }), true);  // same queue job reads OCR and returns a limited response
  assert.equal((await get(researchPath)).state, 'limited');
  const evidence = await db.query("SELECT count(*)::int AS value FROM reader_evidence WHERE project_id=$1 AND operation_key='copilot/addressed/ocr'", [project]);
  assert.equal(evidence.rows[0].value, 1);
  assert.equal((await db.query("SELECT count(*)::int AS value FROM reader_observations WHERE project_id=$1", [project])).rows[0].value, 0);

  console.info('Copilot fixture: addressed OCR persisted');
  const anotherPdf = await accept('another-drawing.pdf', Buffer.concat([
    await readFile(new URL('../formats/test/fixtures/mixed-raster.pdf', import.meta.url)),
    Buffer.from('\n% Synthetic alternate original\n'),
  ]), 'application/pdf');
  await accept('quantum.txt', Buffer.from('QUANTUM-A\nQUANTUM-B\nQUANTUM-C\n'), 'text/plain');
  for (let operation = 0; ; operation++) {
    assert.ok(operation < 60);
    if (!await indexNextProjectMemory(db, reader)) break;
  }
  const quantumId = (await ask('OCR_QUANTUM')).json().id;
  const quantumPath = base + '/questions/' + quantumId;
  assert.equal(await next({ route }), true);
  const { rows: [{ job_id: quantumJob }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [quantumId]);
  const stopOnce = (method, error) => new Proxy(gateway, { get(target, property) {
    if (property === method) return async () => { throw new Error(error); };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  const expire = () => db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='leased'",
    [quantumJob]);
  const progress = async () => (await db.query('SELECT cursor,state,reason FROM gateway_jobs WHERE id=$1', [quantumJob])).rows[0];
  const ocrReceipts = async () => (await db.query(
    "SELECT id,version_id,operation_key FROM reader_evidence WHERE run_id=$1 ORDER BY operation_key", [quantumJob])).rows;
  const sendsForQuantum = () => sent.filter((item) => item.attempt.jobId === quantumJob);
  await assert.rejects(next({ route, gateway: stopOnce('suspend', 'fixture stops after saving the eighth tool request') }),
    /fixture stops after saving the eighth tool request/);
  const eighth = await progress();
  assert.equal(eighth.cursor.turn, 8);
  assert.equal(eighth.cursor.research.finished, false);
  assert.equal((await get(quantumPath)).researchSourceId, eighth.cursor.research.sourceId);
  assert.equal(sendsForQuantum().length, 8);
  await expire();
  await assert.rejects(next({ route, workerId: id(), research: async (...args) => {
    await runtime.research(...args);
    throw new Error('fixture stops after saving the first OCR receipt');
  } }), /fixture stops after saving the first OCR receipt/);
  const firstRead = await ocrReceipts();
  assert.equal(firstRead.length, 1);
  await expire();
  const budgetHold = new Proxy(gateway, { get(target, property) {
    if (property === 'call') return async () => ({ status: 'held', code: 'budget_exhausted', nextAction: 'Inspect budget' });
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  assert.equal(await next({ route, gateway: budgetHold }), true);
  const heldJob = await get(quantumPath);
  assert.equal(heldJob.state, 'held');
  assert.equal(heldJob.reason, 'budget_exhausted');
  assert.equal(heldJob.researchSourceId, eighth.cursor.research.sourceId);
  assert.deepEqual(await ocrReceipts(), firstRead);
  assert.equal(sendsForQuantum().length, 8);
  assert.equal(await gateway.resume(quantumJob, ['budget_exhausted']), true);
  assert.equal(await gateway.resume(quantumJob, ['budget_exhausted']), false);
  assert.equal(await next({ route, workerId: id() }), true);
  const ninth = await progress();
  assert.equal(ninth.cursor.turn, 9);
  assert.notEqual(ninth.cursor.research.sourceId, eighth.cursor.research.sourceId);
  assert.equal(ninth.cursor.research.finished, false);
  assert.equal(await next({ route, workerId: id() }), true);
  const doneAddresses = await ocrReceipts();
  assert.equal(doneAddresses.length, 2);
  assert.deepEqual(new Set(doneAddresses.map(({ version_id }) => version_id)), new Set([drawing.versionId, anotherPdf.versionId]));
  assert.ok(doneAddresses.some(({ id }) => id === firstRead[0].id));
  assert.equal(new Set(doneAddresses.map(({ operation_key }) => operation_key)).size, 2);
  const stalled = await get(quantumPath);
  assert.equal(stalled.state, 'held');
  assert.equal(stalled.reason, 'copilot_no_progress');
  assert.equal((await progress()).cursor.stagnantTurns, 4);
  assert.equal(stalled.researchSourceId, ninth.cursor.research.sourceId);
  const sentEffects = sendsForQuantum().map(({ attempt }) => attempt.effectKey);
  assert.equal(new Set(sentEffects).size, sentEffects.length);
  assert.ok(sendsForQuantum().every(({ attempt }) => attempt.budget?.packageId === project));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM gateway_attempts WHERE job_id=$1', [quantumJob])).rows[0].count,
    sentEffects.length);
  assert.equal(await next({ route }), false);
  const { rows: [primary] } = await db.query(
    'SELECT state,lease_epoch,cursor,worker_id FROM gateway_jobs WHERE id=$1', [primaryJob]);
  assert.deepEqual(primary, {
    state: 'leased', cursor: primaryCursor, lease_epoch: activePrimary.lease.epoch, worker_id: activePrimary.lease.workerId,
  });
  console.info('Copilot fixture: eighth turn, two originals, checkpoint replay, budget and no-progress hold checked');
  console.info('Copilot fixture: already leased primary task and its cursor preserved');

  const multiId = (await ask('MULTIPLE_OPENS')).json().id;
  assert.equal(await next({ route }), true);
  const { rows: [{ job_id: multiJob }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [multiId]);
  const interruptedBatch = new Proxy(gateway, { get(target, property) {
    if (property === 'checkpoint') return async (lease, cursor, tx) => {
      if (cursor.turn === 2) throw new Error('fixture stops before saving the three read replies');
      return target.checkpoint(lease, cursor, tx);
    };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  await assert.rejects(next({ route, gateway: interruptedBatch }), /fixture stops before saving the three read replies/);
  await db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='leased'", [multiJob]);
  assert.equal(await next({ route, workerId: id() }), true);
  const multiAnswer = await get(base + '/questions/' + multiId);
  assert.equal(multiAnswer.state, 'answered');
  assert.deepEqual(multiAnswer.citations.map(({ text }) => text), ['QUANTUM-A', 'QUANTUM-B', 'QUANTUM-C']);
  assert.equal(sent.filter(({ attempt }) => attempt.jobId === multiJob).length, 3);
  assert.equal((await db.query('SELECT count(*)::int AS value FROM gateway_attempts WHERE job_id=$1', [multiJob])).rows[0].value, 3);
  console.info('Copilot fixture: three read calls in one model turn returned three citations with no duplicate send');

  const journalLines = Array.from({ length: 20 }, (_, index) =>
    'JOURNAL-ITEM-' + String(index + 1).padStart(2, '0') + ' JOURNAL-GROUP-' + 'ABCDE'[Math.floor(index / 4)]);
  const journalOriginal = await accept('read-journal.txt', Buffer.from([...journalLines, 'JOURNAL-ITEM-99 unopened'].join('\n')), 'text/plain');
  for (let operation = 0; ; operation++) {
    assert.ok(operation < 60);
    if (!await indexNextProjectMemory(db, reader)) break;
  }
  const readsId = (await ask('READ_JOURNAL')).json().id;
  assert.equal(await next({ route }), true);
  const { rows: [{ job_id: readsJob }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [readsId]);
  assert.equal(await next({ route }), true); // First quantum.
  const interruptedJournal = new Proxy(gateway, { get(target, property) {
    if (property === 'checkpoint') return async (lease, cursor, tx) => {
      if (cursor.opened.length === 7) throw new Error('fixture stops after the seventh unique read');
      return target.checkpoint(lease, cursor, tx);
    };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  await assert.rejects(next({ route, gateway: interruptedJournal }), /fixture stops after the seventh unique read/);
  await db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='leased'", [readsJob]);
  assert.equal(await next({ route, workerId: id() }), true);
  const readsAnswer = await get(base + '/questions/' + readsId);
  assert.equal(readsAnswer.state, 'answered');
  assert.equal(readsAnswer.citations[0].text, journalLines[0]);
  const { rows: [{ cursor: readsCursor }] } = await db.query('SELECT cursor FROM gateway_jobs WHERE id=$1', [readsJob]);
  assert.equal(readsCursor.opened.length, 9);
  assert.ok(readsCursor.found.length > 20);
  assert.equal(sent.filter(({ attempt }) => attempt.jobId === readsJob).length, 21);
  assert.equal((await db.query('SELECT count(*)::int AS value FROM gateway_attempts WHERE job_id=$1', [readsJob])).rows[0].value, 21);

  const batchId = (await ask('READ_BATCH_REPLAY')).json().id;
  const batchPath = base + '/questions/' + batchId;
  assert.equal(await next({ route }), true);
  const { rows: [{ job_id: batchJob }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [batchId]);
  const executed = [];
  const batchMemory = {
    ...memory,
    async search(...args) {
      if (readBatchQueries.includes(args[2])) executed.push(args[2]);
      return memory.search(...args);
    },
  };
  const stopBatch = new Proxy(gateway, { get(target, property) {
    if (property === 'checkpoint') return async (lease, cursor, tx) => {
      if (cursor.readBatch?.next === 4) throw new Error('fixture stops before committing fourth search');
      return target.checkpoint(lease, cursor, tx);
    };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  await assert.rejects(next({ route, gateway: stopBatch, memory: batchMemory }), /fixture stops before committing fourth search/);
  const readProgress = async () => (await db.query('SELECT cursor FROM gateway_jobs WHERE id=$1', [batchJob])).rows[0].cursor;
  const interrupted = await readProgress();
  assert.equal(interrupted.turn, 7);
  assert.equal(interrupted.readBatch.next, 3);
  assert.deepEqual(executed, readBatchQueries.slice(0, 4));
  await db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='leased'", [batchJob]);
  assert.equal(await next({ workerId: id() }), true);
  const paused = await get(batchPath);
  assert.equal(paused.state, 'held');
  assert.equal(paused.reason, 'model_unavailable');
  assert.deepEqual(paused.readActions, readBatchQueries.map((query, index) => (
    { operation: 'search_sources', completed: index < 3, query }
  )));
  assert.equal(paused.partialSources.length, 12);
  assert.equal(paused.claims, undefined);
  assert.equal((await inject(batchPath, limited)).statusCode, 404);
  assert.equal(await next({ route, workerId: id() }), true); // Resume the same routed job.
  assert.equal(await next({ route, workerId: id(), memory: batchMemory }), true);
  assert.equal((await readProgress()).readBatch.next, 9);
  assert.deepEqual(executed, [...readBatchQueries.slice(0, 4), ...readBatchQueries.slice(3, 9)]);
  const heldAfterReads = new Proxy(gateway, { get(target, property) {
    if (property === 'call') return ({ request, effectKey }) => {
      assert.equal(effectKey, 'copilot/turn/7');
      const turn = request.messages.find(({ tool_calls }) => tool_calls?.length === 10);
      assert.deepEqual(request.messages.slice(request.messages.indexOf(turn) + 1).map(({ tool_call_id }) => tool_call_id),
        turn.tool_calls.map(({ id }) => id));
      return Promise.resolve({ status: 'held', code: 'budget_exhausted', nextAction: 'Inspect budget' });
    };
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  assert.equal(await next({ route, workerId: id(), gateway: heldAfterReads, memory: batchMemory }), true);
  const completeBatch = await get(batchPath);
  assert.equal(completeBatch.reason, 'budget_exhausted');
  assert.equal(completeBatch.partialSources.length, 12);
  assert.equal(completeBatch.claims, undefined);
  assert.deepEqual(completeBatch.readActions, paused.readActions.map((action) => ({ ...action, completed: true })));
  assert.deepEqual(executed, [...readBatchQueries.slice(0, 4), ...readBatchQueries.slice(3)]);
  assert.equal(sent.filter(({ attempt }) => attempt.jobId === batchJob).length, 7);
  assert.equal((await db.query('SELECT count(*)::int AS value FROM gateway_attempts WHERE job_id=$1', [batchJob])).rows[0].value, 7);
  assert.equal(await next({ route }), false);
  console.info('Copilot fixture: ten read tools, durable prefix, bounded continuation and paid receipt replay checked');

  const partialId = (await ask('PARTIAL_JOURNAL')).json().id;
  const partialPath = base + '/questions/' + partialId;
  assert.equal(await next({ route }), true);
  const stopAfterRead = new Proxy(gateway, { get(target, property) {
    if (property === 'call') return (input) => input.effectKey === 'copilot/turn/5'
      ? Promise.resolve({ status: 'held', code: 'budget_exhausted', nextAction: 'Inspect budget' }) : target.call(input);
    const member = target[property];
    return typeof member === 'function' ? member.bind(target) : member;
  }});
  assert.equal(await next({ route, gateway: stopAfterRead }), true);
  const partialAnswer = await get(partialPath);
  assert.equal(partialAnswer.state, 'held');
  assert.equal(partialAnswer.reason, 'budget_exhausted');
  assert.equal(partialAnswer.claims, undefined);
  assert.equal(partialAnswer.citations, undefined);
  assert.equal(partialAnswer.partialSources.length, 8);
  assert.ok(partialAnswer.partialSources.every((source) => source.label === 'read-journal.txt' && !source.text));
  assert.equal((await inject(partialPath, limited)).statusCode, 404);
  assert.equal((await get(base + '/sources?id=' + partialAnswer.partialSources[0].id)).source.text, journalLines[0]);
  await accept('read-journal-new.txt', Buffer.from('Later journal edition'), 'text/plain', { replaces: journalOriginal });
  assert.equal((await get(partialPath)).partialSources, undefined);
  assert.equal((await get(batchPath)).readActions, undefined);
  console.info('Copilot fixture: ninth read, older citation, replay, partial addresses and superseded partial suppression checked');

  const unknownKey = id();
  const unknownId = (await ask('UNKNOWN', unknownKey)).json().id;
  assert.equal(await next({ route }), true);
  assert.equal(await next({ route }), true);
  assert.equal((await get(base + '/questions/' + unknownId)).reason, 'unknown_charge');
  const beforeRetry = sent.length;
  assert.equal((await ask('UNKNOWN', unknownKey)).json().id, unknownId);
  assert.equal(await next({ route }), false);
  assert.equal(sent.length, beforeRetry);

  console.info('Copilot fixture: unknown outcome retained');
  await t.test('D11 stops at 10% after addressed research and keeps local reads and background capacity', async () => {
    await gateway.configureRoute(limitPolicy);
    for (const purpose of ['review', 'primary_a']) {
      await gateway.grantRoute({ projectId: project, routeId: limitRoute.routeId, revision: limitPolicy.revision,
        purpose, dataClass: limitRoute.dataClass, allowed: true });
    }
    const budgetId = (await ask('D11')).json().id;
    const budgetPath = base + '/questions/' + budgetId;
    assert.equal(await next({ route: limitRoute }), true);
    assert.equal(await next({ route: limitRoute }), true);
    const pending = await get(budgetPath);
    assert.equal(pending.state, 'research_queued');
    const { rows: [{ job_id: budgetJob }] } = await db.query('SELECT job_id FROM copilot_questions WHERE id=$1', [budgetId]);
    const sentForBudget = () => sent.filter(({ attempt }) => attempt.jobId === budgetJob);
    // Lose the checkpoint after the post-OCR provider response. Restart with a new gateway and lease.
    const interrupted = new Proxy(gateway, { get(target, property) {
      if (property === 'call') return async (input) => {
        const wrongOrigin = await target.call({ ...input, budget: { initiatedBy: 'background', packageId: project } });
        assert.equal(wrongOrigin.code, 'invalid_budget_attribution');
        return target.call(input);
      };
      if (property === 'checkpoint' && sentForBudget().length === 4) {
        return async () => { throw new Error('fixture stops after paid addressed research turn'); };
      }
      const member = target[property];
      return typeof member === 'function' ? member.bind(target) : member;
    }});
    await assert.rejects(next({ route: limitRoute, gateway: interrupted }), /fixture stops after paid addressed research turn/);
    await db.query("UPDATE gateway_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [budgetJob]);
    const restarted = createGateway(db, gatewayOptions);
    assert.equal(await next({ route: limitRoute, gateway: restarted, workerId: id() }), true);
    const held = await get(budgetPath);
    assert.equal(held.state, 'held');
    assert.equal(held.reason, 'copilot_budget_exhausted');
    assert.equal(held.researchSourceId, pending.researchSourceId);
    const savedCell = held.partialSources.find(({ label, address }) =>
      label === 'schedule.xlsx' && address.locator?.cell === 'B2');
    assert.ok(savedCell);
    const openedCell = (await get(base + '/sources?id=' + savedCell.id)).source;
    assert.equal(openedCell.versionId, table.versionId);
    assert.equal(openedCell.text, 'Thickness, mm');
    assert.ok((await get(base + '/search?q=Thickness')).sources.some(({ id }) => id === savedCell.id));
    assert.equal((await get(questionPath)).state, 'answered');

    assert.equal(sentForBudget().length, 4);
    const attributed = { initiatedBy: 'copilot', packageId: project };
    const { rows: appAttempts } = await db.query(
      'SELECT id,budget,state FROM gateway_attempts WHERE job_id=$1 ORDER BY created_at', [budgetJob]);
    assert.deepEqual(appAttempts, sentForBudget().map(({ attempt }) => ({ id: attempt.id, budget: attributed, state: 'paid' })));
    const { rows: journalAttempts } = await ledgerDb.query(
      "SELECT id,metadata->'budget' AS budget,state FROM gateway_external_attempts WHERE metadata->>'jobId'=$1 ORDER BY created_order", [budgetJob]);
    assert.deepEqual(journalAttempts, appAttempts);
    const { rows: [balance] } = await ledgerDb.query(
      "SELECT spent::bigint::text AS spent,reserved::bigint::text AS reserved FROM gateway_budget_balances($1,$2) WHERE scope='copilot'",
      [project, attributed]);
    assert.deepEqual(balance, { spent: String(fraction - policy.ceilingUsdNanos), reserved: String(policy.ceilingUsdNanos) });

    const backgroundCall = {
      lease: activePrimary.lease, effectKey: 'd11-background', routeId: limitRoute.routeId, dataClass: limitRoute.dataClass,
      request: { fixture: 'background' }, inputRefs: [],
    };
    assert.equal((await restarted.call(backgroundCall)).code, 'budget_attribution_required');
    const primaryResult = await restarted.call({ ...backgroundCall, budget: { initiatedBy: 'background', packageId: project } });
    assert.equal(primaryResult.status, 'paid', JSON.stringify(primaryResult));
    assert.equal(primaryResult.receipt.costUsdNanos, limitPolicy.ceilingUsdNanos);
    const newQuestion = (await ask('D11 after exhaustion')).json().id;
    const sentBefore = sent.length;
    assert.equal(await next({ route: limitRoute, gateway: restarted }), true);
    assert.equal(await next({ route: limitRoute, gateway: restarted }), true);
    assert.equal((await get(base + '/questions/' + newQuestion)).reason, 'copilot_budget_exhausted');
    assert.equal(sent.length, sentBefore);
    assert.equal(await next({ route: limitRoute, gateway: restarted }), false);
  });

  if (process.env.FACADE_COPILOT_BROWSER === '1') {
    const require = createRequire(resolve('web/package.json'));
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.FACADE_CHROME_PATH ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    await app.listen({ host: '127.0.0.1', port });
    const pageFor = async (token) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      await page.context().addCookies([{ name: 'facade_session', value: token, url: origin, httpOnly: true }]);
      return page;
    };
    const owner = await pageFor(ownerToken);
    console.info('Copilot fixture: Chrome opened');
    await owner.goto(origin + '/projects/' + project + '/copilot/' + questionId);
    await owner.getByText('Единица толщины в ведомости — миллиметры.', { exact: true }).waitFor().catch(async (error) => {
      const visible = await owner.locator('body').innerText().catch(() => '');
      throw new Error('Answered route did not render in Chrome: ' + visible.slice(0, 800), { cause: error });
    });
    await owner.getByRole('link', { name: /schedule.xlsx.*B2/ }).first().click();
    await owner.getByRole('heading', { name: 'Адрес в оригинале' }).waitFor();
    const original = owner.getByRole('link', { name: 'Открыть оригинал этой версии' });
    assert.equal(await original.getAttribute('href'), originalPath);
    console.info('Copilot fixture: Chrome opened the addressed XLSX source');
    await owner.getByLabel('Вопрос инженера').fill('Проверка режима с выключенной моделью');
    await owner.getByRole('button', { name: 'Спросить помощника' }).click();
    await owner.waitForURL((url) => url.pathname.startsWith('/projects/' + project + '/copilot/') && !url.pathname.endsWith(questionId));
    assert.equal(await next(), true);
    await owner.getByText('Модель недоступна. Поиск по источникам работает.', { exact: false }).waitFor();
    const viewer = await pageFor(participantToken);
    await viewer.goto(origin + '/projects/' + project + '/copilot?scope=' + scope);
    assert.equal(await viewer.getByRole('button', { name: 'Спросить помощника' }).count(), 0);
    await viewer.getByRole('searchbox').fill('Permitted');
    await viewer.getByRole('button', { name: 'Найти' }).click();
    await viewer.getByRole('link', { name: 'Опубликованный фрагмент · стр. 1' }).click();
    await viewer.getByRole('heading', { name: 'Опубликованный фрагмент' }).waitFor();
    assert.equal(await viewer.getByRole('link', { name: 'Открыть оригинал этой версии' }).count(), 0);
    console.info('Copilot fixture: Chrome isolated the published fragment');
    await viewer.close();
    await owner.close();
  }

  await accept('unrelated-addendum.txt', Buffer.from('Independent text'), 'text/plain');
  await gateway.openGeneration({ ...generation, generationId: id() });
  const stalePartial = await get(partialPath);
  assert.equal(stalePartial.reason, 'inputs_changed');
  assert.equal(stalePartial.partialSources, undefined);
  const intact = await get(questionPath);
  assert.equal(intact.state, 'answered');
  assert.equal(intact.asOf, answer.asOf);
  await accept('schedule-new.txt', Buffer.from('New edition with a different dimension'), 'text/plain', { replaces: table });
  assert.equal((await get(cellPath)).source.version, 'historical');
  const historic = await get(questionPath);
  assert.equal(historic.state, 'historical');
  assert.equal(historic.citations[0].version, 'historical');
  assert.equal(historic.asOf, answer.asOf);
  assert.deepEqual(historic.claims, answer.claims);
  await db.query("UPDATE intake_occurrences SET state='cancelled',version_id=NULL WHERE project_id=$1 AND version_id=$2", [project, table.versionId]);
  const heldSource = await get(questionPath);
  assert.equal(heldSource.reason, 'sources_unavailable');
  assert.equal(heldSource.claims, undefined);
  assert.equal((await inject(cellPath)).statusCode, 404);
  await db.query("INSERT INTO fragment_publication_revisions(publication_id,version,actor_id,reason) VALUES($1,3,$2,'Revoked')", [pub, engineer]);
  assert.equal((await inject(publishedPath, limited)).statusCode, 404);
  assert.deepEqual((await get(base + '/search?q=Permitted&scopeId=' + scope, limited)).sources, []);
  await db.query('DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2', [project, engineer]);
  assert.equal((await inject(questionPath)).statusCode, 404);
  assert.equal((await inject(cellPath)).statusCode, 404);
  t.diagnostic('Only local gateway receipts were used. External requests and costs: 0.');
});
