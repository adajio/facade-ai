import assert from 'node:assert/strict';
import { managedWorkerOptions } from '../fixtures/managed-worker-support.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '/app/node_modules/pg/lib/index.js';
import { createApi } from '/app/dist/src/platform/api.js';
import { readConfig } from '/app/dist/src/platform/config.js';
import { createFormatAdapters } from '/app/dist/src/modules/formats/index.js';
import { createGateway, journalFromEnv } from '/app/dist/src/modules/gateway/index.js';
import { estimateOpenRouterRequest } from '/app/dist/src/modules/gateway/openrouter.js';
import { startWorker } from '/app/dist/src/modules/harness/index.js';
import { connectReader } from '/app/dist/src/modules/harness/reader.js';
import { advance } from '/app/dist/src/modules/harness/session.js';
import { createIntakeStorage } from '/app/dist/src/modules/intake/blob.js';
import { createRuntimePdfService } from '/app/dist/src/modules/pdf/index.js';
import { acceptanceHttp } from './early-review-http.mjs';

const frozen = JSON.parse(await readFile('/frozen/machine-final-live.json', 'utf8')).main;
const intake = JSON.parse(await readFile('/frozen/intake-verified.json', 'utf8'));
const managedLedger = (await readFile('/results/managed-ledger-id.txt', 'utf8')).trim();
assert.equal(frozen.projectId, intake.projectId);
assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/test_early_review(?:_live|_final)?_[a-f0-9]{12}$/u);
assert.equal(new URL(process.env.FACADE_GATEWAY_JOURNAL_URL).hostname, 'postgres-journal');
assert.equal(process.env.FACADE_GATEWAY_LEDGER_ID, managedLedger);
assert.ok(!process.env.FACADE_GATEWAY_LIVE_MODE && !process.env.FACADE_GATEWAY_OPENROUTER_KEY);
const origin = 'http://127.0.0.1:18466';
process.env.PORT = new URL(origin).port;
process.env.FACADE_PUBLIC_ORIGIN = origin;
const config = readConfig();
const app = await createApi(config);
const journal = journalFromEnv();
const ledgerDb = new pg.Pool({ connectionString: process.env.FACADE_GATEWAY_JOURNAL_URL });
const gateway = createGateway(app.db, { journal: journal.journal });
const shutdown = new AbortController();
let worker;
const calls = [];
const transportErrors = [];
const routeIds = ['managed-lead', 'managed-a', 'managed-b'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unknown = frozen.authoritativeAttempts.filter(({ state }) => state === 'unknown');
assert.equal(unknown.length, 1);
const disputed = new Set(frozen.disputes.map(({ id }) => id));
assert.equal(disputed.size, 2);
const wrongRevision = [...disputed].sort()[0];
const south = intake.scopeIds['Южный пирс'];
const { rows: [foreignWindow] } = await app.db.query(
  `SELECT hp.obligation_id AS id, hp.place FROM harness_primary_places hp
   JOIN gateway_generations g USING(generation_id) JOIN gateway_jobs j
     ON j.generation_id=g.generation_id AND j.obligation_id=hp.obligation_id::text
   WHERE g.current AND g.project_id=$1 AND g.scope_id=$2 AND NOT (j.payload ? 'localRefusal')
   ORDER BY hp.obligation_id LIMIT 1`, [intake.projectId, south]);
assert.ok(foreignWindow?.id);

function sendTool(name, args) {
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    const { attempt, routeId, request } = await new Response(req).json();
    const job = JSON.parse(request.messages[1].content);
    assert.equal(attempt.purpose, 'review');
    assert.equal(attempt.projectId, intake.projectId);
    assert.ok(disputed.has(job.dispute.id));
    assert.equal(routeId, 'managed-lead');
    assert.equal(job.mode, 'lead');
    const tools = request.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
    const opened = tools.filter(({ ok, evidence }) => ok && evidence?.evidenceId);
    const issued = request.messages.flatMap(({ role, tool_calls }) => role === 'assistant' ? tool_calls ?? [] : []);
    const reads = issued.filter(({ function: func }) => func.name === 'extract');
    const contexts = issued.filter(({ function: func }) => func.name === 'open_context')
      .map(({ function: func }) => JSON.parse(func.arguments).contextId);
    const evidenceIds = [...new Set(opened.map(({ evidence }) => evidence.evidenceId))];
    let action, args;
    if (!issued.length) {
      action = 'inventory';
      args = {};
    } else if (reads.length < 2) {
      action = 'extract';
      args = { support: reads.length ? 'B' : 'A' };
    } else if (!issued.some(({ function: func }) => func.name === 'context_inventory')) {
      action = 'context_inventory';
      args = {};
    } else {
      assert.ok(opened.length >= 2, JSON.stringify(tools.map(({ code, ok }) => ({ code, ok }))));
      const assigned = tools.find(({ inventory }) => Array.isArray(inventory))?.inventory;
      const windows = tools.find(({ items }) => Array.isArray(items))?.items;
      assert.equal(assigned?.length, 2);
      assert.ok(windows?.length && windows.every(({ id }) => id !== foreignWindow.id));
      const selected = [
        ...assigned.map(({ place, support }) => windows.find((item) => item.support === support
          && item.place.unitId === place.unitId && item.place.source.versionId === place.source.versionId)),
        windows.find(({ support, place }) => support === 'B' && place.unitId.startsWith('paragraphs:')),
      ];
      assert.ok(selected.every(Boolean));
      const nextWindow = selected.find(({ id }) => !contexts.includes(id));
      if (!contexts.includes(foreignWindow.id)) {
        action = 'open_context';
        args = { contextId: foreignWindow.id, representation: 'native' };
      } else if (nextWindow) {
        action = 'open_context';
        args = { contextId: nextWindow.id, representation: 'native' };
      } else {
        const negative = tools.filter(({ code }) => code === 'context_window_unavailable');
        assert.equal(negative.length, 1);
        assert.equal(opened.length, 5);
        const sourcePair = evidenceIds.slice(0, 2).join(', ');
        const reasons = {
          variant: 'Одно исполнение не установлено.',
          revision: 'Действующие редакции для сопоставления не установлены.',
          applicability: 'Принадлежность к области известна, применимость к одному исполнению открыта.',
          comparability: 'Сопоставимость требует проверки применимости и редакций.',
        };
        const isWrongRevision = job.dispute.id === wrongRevision;
        const expectedRefusal = isWrongRevision ? 'pair_revision_not_addressed' : 'pair_quote_not_found';
        const refused = tools.some(({ code }) => code === expectedRefusal);
        const quoteSource = ({ evidence, content }, pattern) => {
          const line = JSON.parse(content).lines.find(({ text }) => pattern.test(text.trim()));
          assert.ok(line);
          return { evidenceId: evidence.evidenceId, quote: line.text.trim().slice(0, 140) };
        };
        const sources = [quoteSource(opened[2], /QF-91.*зазор/iu), quoteSource(opened[3], /^QF-91$/iu)];
        const revisions = [quoteSource(opened[2], /редакция N05/iu), quoteSource(opened[4], /редакция N05/iu)];
        const checks = Object.fromEntries(Object.entries(reasons).map(([criterion, reason]) => [criterion, {
          status: !refused && criterion === (isWrongRevision ? 'revision' : 'variant') ? 'confirmed' : 'unclear',
          reason: refused ? reason : `Контрольное утверждение для отрицательной проверки. Опоры: ${sourcePair}.`,
          sources,
        }]));
        if (!refused && !isWrongRevision) checks.variant.sources = [
          { ...sources[0], quote: 'Такой подписи исполнения нет в выданной строке.' }, sources[1],
        ];
        if (refused) checks.revision = { status: 'confirmed',
          reason: 'На выданном листе схемы и в заголовке протокола указана редакция N05.', sources: revisions };
        action = 'propose_resolution';
        args = { aObservationId: job.dispute.a.observationId, bObservationId: job.dispute.b.observationId,
          explanation: refused ? 'Открыты обе реальные опоры. Применимость пары остаётся открытой.'
            : 'Контрольная гипотеза для проверки отказа.', checks, evidenceIds };
      }
    }
    calls.push({ attempt: attempt.id, job: attempt.jobId, routeId, mode: job.mode, branch: job.branch, dispute: job.dispute.id,
      action, evidenceIds, wireHash: sha(JSON.stringify(request)),
      ...(args.checks ? { checks: args.checks, verdict: args.verdict, supportedPlaces: opened.map(({ evidence, content }) => ({
        evidenceId: evidence.evidenceId, place: evidence.place, sha256: evidence.sha256,
        textPrefix: typeof content === 'string' ? content.slice(0, 2500) : null,
      })) } : {}),
      lastTool: tools.at(-1) ? { code: tools.at(-1).code, ok: tools.at(-1).ok } : null });
    const receipt = { state: 'paid', costUsdNanos: 0, providerId: `managed:${attempt.id}`,
      evidenceRef: `controlled:${attempt.id}` };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ receipt, output: sendTool(action, args) }));
  } catch (error) {
    transportErrors.push(error.message);
    res.writeHead(500).end();
  }
});

const { call, login, currentScopes, engineerPhase } = acceptanceHttp(origin, intake);

async function readReview() {
  const { rows } = await app.db.query(
    `SELECT j.id,j.job_key AS key,j.state,j.reason,j.scope_id,j.generation_id,j.payload,j.payload->>'mode' AS mode,j.payload->>'branch' AS branch,
            j.payload#>>'{dispute,id}' AS dispute,j.result
       FROM gateway_jobs j WHERE j.project_id=$1 AND j.purpose='review' ORDER BY j.job_key`, [frozen.projectId]);
  return rows;
}

async function quoteReview(jobs) {
  const plan = JSON.parse(await readFile('/frozen/alibaba-isolated-plan.json', 'utf8'));
  const results = [];
  for (const job of jobs) {
    const settings = plan.modes.main[job.mode === 'lead' ? 'lead' : job.branch];
    const [routeKey, route] = Object.entries(plan.routes).find(([, { id }]) => id === settings.routeId);
    const profile = plan.profiles[routeKey];
    const task = { jobId: job.id, projectId: frozen.projectId, scopeId: job.scope_id, generationId: job.generation_id,
      job: { ...job.payload, settings }, earlyPair: true };
    const { rows } = await app.db.query('SELECT event FROM harness_research_events WHERE job_id=$1 ORDER BY sequence', [job.id]);
    for (const [index, { event }] of rows.entries()) {
      if (event.kind !== 'model') continue;
      await advance(task, {
        reader: {},
        load: async () => rows.slice(0, index).map((row) => row.event),
        append: () => { throw Error('Quote-only session tried to persist an event'); },
        call: async ({ request }) => {
          results.push({ job: job.id, dispute: job.dispute, stage: job.branch ?? job.mode, turn: event.turn,
            route: route.id, profileValidUntil: profile.validUntil, bound: estimateOpenRouterRequest(profile, route, request) });
          return { status: 'held', code: 'budget_exhausted', nextAction: 'quote_only' };
        },
      });
    }
  }
  return results;
}

async function reviewEvidence(jobs) {
  const { rows: events } = await app.db.query(
    'SELECT job_id,sequence,event FROM harness_research_events WHERE job_id=ANY($1::uuid[]) ORDER BY job_id,sequence',
    [jobs.map(({ id }) => id)]);
  const { rows: attempts } = await ledgerDb.query(
    'SELECT id,purpose,state,spent_usd_nanos,started_at,metadata FROM gateway_external_attempts ORDER BY created_order');
  const paid = attempts.filter(({ state }) => state === 'paid');
  assert.deepEqual(paid.map(({ id }) => id).sort(),
    events.filter(({ event }) => event.kind === 'model').map(({ event }) => event.attemptId).sort());
  assert.equal(new Set(paid.map(({ metadata }) => metadata.effectKey)).size, paid.length);
  assert.ok(paid.every(({ purpose, spent_usd_nanos }) => purpose === 'review' && spent_usd_nanos === '0'));
  assert.deepEqual(attempts.filter(({ state }) => state === 'unknown').map(({ id }) => id), unknown.map(({ id }) => id));
  assert.ok(attempts.filter(({ state }) => state !== 'paid' && state !== 'unknown')
    .every(({ state, purpose, started_at }) => state === 'cancelled' && purpose === 'review' && started_at === null));
  return { transport: 'controlled-local', jobs, events, attempts, quotes: await quoteReview(jobs),
    balance: await journal.journal.balance() };
}

async function continueEngineer() {
  const jobs = await readReview();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(({ mode, state }) => mode === 'lead' && state === 'done'));
  const proof = await reviewEvidence(jobs);
  await writeFile('/results/managed-review-evidence.json', JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  await app.listen({ host: config.host, port: config.port });
  const owner = await login('stage15_live_operator', (await readFile('/synthetic-auth', 'utf8')).trim());
  const freeze = '/results/managed-machine-before-engineering.json';
  if (process.argv.includes('--freeze-before-engineer')) {
    await writeFile(freeze, JSON.stringify(await currentScopes(owner), null, 2) + '\n', { flag: 'wx' });
  }
  const initial = JSON.parse(await readFile(freeze, 'utf8'));
  const engineering = await engineerPhase(owner, initial, {
    persistProjected: async (projection) => assert.deepEqual(projection, initial),
  });
  await writeFile('/results/managed-engineering.json', JSON.stringify(engineering, null, 2) + '\n', { flag: 'wx' });
}

async function auditContext() {
  const storage = createIntakeStorage(config.dataDir);
  const service = createRuntimePdfService(app.db, config, { storage, adapters: createFormatAdapters() });
  const reader = connectReader(app.db, service, async () => assert.fail('Context audit cannot publish observations'));
  const windows = [];
  for (const job of await readReview()) {
    const task = { jobId: job.id, projectId: frozen.projectId, scopeId: job.scope_id, generationId: job.generation_id,
      job: job.payload, earlyPair: true };
    const context = { task, branch: 'A', effectKey: randomUUID() };
    const listed = await reader.contexts(context, 0);
    assert.ok(!listed.nextOffset && listed.items.length);
    for (const item of listed.items) {
      const result = await reader.openContext({ ...context, effectKey: randomUUID() }, item.id, 'native');
      assert.equal(result.support, item.support);
      assert.deepEqual(result.place, item.place);
      assert.equal(sha(result.bytes), result.sha256);
      const { lines } = JSON.parse(result.bytes);
      windows.push({ dispute: job.dispute, window: item.id, source: item.place.source, support: item.support, format: item.format,
        unitId: item.place.unitId, evidenceId: result.evidenceId, lines });
    }
  }
  await writeFile('/results/managed-context-audit.json', JSON.stringify(windows, null, 2) + '\n', { flag: 'wx' });
}

try {
  if (process.argv.includes('--context-audit')) {
    await auditContext();
  } else if (process.argv.includes('--continue-engineer')) {
    await continueEngineer();
  } else {
    const historical = unknown[0];
    assert.equal(historical.purpose, 'primary_b');
    await ledgerDb.query(
      `INSERT INTO gateway_external_attempts(id,effect_key,project_id,generation_id,route_id,purpose,
         ceiling_usd_nanos,metadata,state,receipt,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'unknown',$9,$10)`,
      [historical.id, historical.metadata.effectKey, frozen.projectId, historical.metadata.generationId,
        historical.route_id, historical.purpose, historical.ceiling_usd_nanos, historical.metadata,
        historical.receipt, historical.started_at]);
    assert.equal((await app.db.query('SELECT count(*)::int AS n FROM gateway_grants WHERE allowed')).rows[0].n, 0);
    await app.db.query('UPDATE gateway_journal_binding SET ledger_id=$1', [managedLedger]);
    for (const id of routeIds) {
      const route = { id, revision: 'early-review-control-1', transport: 'managed', enabled: true,
        maxRequestBytes: 16 * 1024 * 1024, ceilingUsdNanos: 1, timeoutMs: 8_000 };
      await gateway.configureRoute(route);
      await gateway.grantRoute({ projectId: frozen.projectId, routeId: id, dataClass: 'synthetic',
        purpose: 'review', revision: route.revision, allowed: true });
    }
    const countPrimary = async () => (await app.db.query(
      `SELECT state,count(*)::int AS n FROM gateway_primary p JOIN gateway_generations g USING(generation_id)
       WHERE g.project_id=$1 AND g.current GROUP BY state ORDER BY state`, [frozen.projectId])).rows;
    const primaryBefore = await countPrimary();
    assert.ok(primaryBefore.some(({ state, n }) => state === 'pending' && n > 0));
    assert.deepEqual(await readReview(), []);
    await app.listen({ host: config.host, port: config.port });
    await call({}, 'GET', '/readyz', 200);
    const owner = await login('stage15_live_operator', (await readFile('/synthetic-auth', 'utf8')).trim());
    const initial = await currentScopes(owner);

    const { rows: [heldPrimary] } = await app.db.query(
      `SELECT j.id,j.reason,j.next_action FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
        WHERE g.current AND g.project_id=$1 AND g.generation_id=$2
          AND j.kind='harness_research' AND j.purpose='primary_a'
          AND j.payload#>>'{question,id}' IS DISTINCT FROM $3
          AND j.state='held' AND j.reason='repeated_rejected_action'
          AND NOT EXISTS (SELECT FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
        ORDER BY j.id LIMIT 1`, [frozen.projectId, frozen.disputes[0].generation_id, frozen.disputes[0].question_id]);
    assert.ok(heldPrimary?.next_action);
    assert.equal(await gateway.resume(heldPrimary.id, [heldPrimary.reason]), true);
    const concurrentPrimary = await gateway.claim({ workerId: 'early-review-test-primary', kinds: ['harness_research'], leaseMs: 120_000 });
    assert.equal(concurrentPrimary?.lease.jobId, heldPrimary.id);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const options = managedWorkerOptions(`http://127.0.0.1:${provider.address().port}/managed`, import.meta.url);
    worker = startWorker({ db: app.db, config, signal: shutdown.signal, logger: app.log }, options);
    let jobs;
    const deadline = Date.now() + 100_000;
    do {
      await delay(350);
      jobs = await readReview();
      if (transportErrors.length) throw Error(transportErrors.join('\n'));
    } while (Date.now() < deadline && (jobs.length < 2 || jobs.some(({ state }) => state !== 'done')));
    assert.equal(jobs.length, 2, JSON.stringify(jobs));
    assert.ok(jobs.every(({ state }) => state === 'done'), JSON.stringify(jobs));
    assert.equal(await gateway.heartbeat(concurrentPrimary.lease, 120_000), true);
    assert.equal(await gateway.suspend(concurrentPrimary.lease, { reason: heldPrimary.reason, nextAction: heldPrimary.next_action }), true);
    for (const id of disputed) {
      const pair = jobs.filter(({ dispute }) => dispute === id);
      assert.equal(pair.length, 1);
      assert.equal(pair[0].result.kind, 'proposal');
      const { revision, variant, applicability, comparability } = pair[0].result.checks;
      assert.equal(revision.status, 'confirmed');
      assert.ok(revision.sources.every(({ quote }) => /редакция N05/iu.test(quote)));
      assert.ok([variant, applicability, comparability].every(({ status }) => status === 'unclear'));
      const code = id === wrongRevision ? 'pair_revision_not_addressed' : 'pair_quote_not_found';
      assert.equal(calls.filter(({ dispute, lastTool }) => dispute === id && lastTool?.code === code).length, 1);
    }
    const history = (await app.db.query(`SELECT stage,result,dispute_id AS dispute FROM harness_review_results
      WHERE dispute_id=ANY($1::uuid[]) ORDER BY dispute_id,stage`, [[...disputed]])).rows;
    assert.equal(history.length, 2);
    assert.deepEqual(await countPrimary(), primaryBefore);
    const proof = await reviewEvidence(jobs);
    assert.equal(proof.quotes.length, calls.length);
    await writeFile('/results/managed-review-evidence.json', JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    shutdown.abort();
    await worker;
    const engineering = await engineerPhase(owner, initial, {
      persistProjected: assessment => writeFile('/results/managed-machine-before-engineering.json',
        JSON.stringify(assessment, null, 2) + '\n', { flag: 'wx' }),
    });
    await writeFile('/results/managed-report.json', JSON.stringify({
      transport: 'controlled-local', primaryBefore, concurrentPrimary: heldPrimary.id,
      concurrentPrimaryGeneration: concurrentPrimary.generationId, historicalUnknown: historical.id, foreignWindow,
      calls, jobs, history, ...engineering, quotes: proof.quotes, balance: await journal.journal.balance(),
    }, null, 2) + '\n', { flag: 'wx' });
  }
} finally {
  shutdown.abort();
  await worker;
  provider.closeAllConnections();
  provider.close();
  await Promise.all([ledgerDb.end(), journal.close(), app.close()]);
}
