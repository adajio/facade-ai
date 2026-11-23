// Runs the shipped reader, worker, gateway and HTTP API in an isolated stand container.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { managedWorkerOptions, verifyManagedLauncherTargets } from '../fixtures/managed-worker-support.mjs';

await verifyManagedLauncherTargets();

const root = '/acceptance';
const output = join(root, 'evidence', process.env.STEP15_RUN_ID);
const origin = 'http://127.0.0.1:3000';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const tick = process.hrtime.bigint();
const since = () => Number(process.hrtime.bigint() - tick);
const result = (file, data) => writeFile(join(output, file), JSON.stringify(data, null, 2) + '\n');
const appFile = (path) => import(`file:///app/dist/src/${path}.js`);
const settleLimit = Number(process.env.STEP15_SETTLE_SECONDS ?? '75') * 1000;
const mixedSettleLimit = Number(process.env.STEP15_MIXED_SETTLE_SECONDS ?? process.env.STEP15_SETTLE_SECONDS ?? '75') * 1000;
if (![settleLimit, mixedSettleLimit].every(value => Number.isFinite(value) && value >= 1000)) {
  throw Error('Invalid observation interval');
}
const { createApi } = await appFile('platform/api');
const { readConfig } = await appFile('platform/config');
const { bootstrapAdmin } = await appFile('modules/access/bootstrap');
const { createGateway, journalFromEnv } = await appFile('modules/gateway/index');
const { startWorker } = await appFile('modules/harness/index');
const { canonicalJson } = await appFile('modules/assessment/domain');

delete process.env.FACADE_GATEWAY_LIVE_MODE;
delete process.env.FACADE_GATEWAY_OPENROUTER_KEY;
process.env.FACADE_PUBLIC_ORIGIN = origin;
await mkdir(output, { mode: 0o700 });
const config = readConfig();
const app = await createApi(config);
const journal = journalFromEnv();
if (!journal) throw Error('Missing isolated managed journal');
const gateway = createGateway(app.db, { journal: journal.journal });
const password = randomUUID() + '-synthetic';
let session = {};
let engineerSession;
let engineerId;
let worker, stop;
let provider;
let options;
const calls = new Map();

async function request(method, path, payload, headers = {}, timeoutMs = 12000) {
  const startedNs = since();
  const response = await fetch(origin + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { origin, 'idempotency-key': randomUUID(), ...session,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: Buffer.isBuffer(payload) ? payload : payload === undefined ? undefined : JSON.stringify(payload),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  await appendFile(join(output, 'http.jsonl'), JSON.stringify({
    method, path, status: response.status, startNs: startedNs, endNs: since(),
  }) + '\n');
  if (response.headers.get('content-type')?.includes('application/json')) {
    return { status: response.status, value: JSON.parse(bytes), response };
  }
  return { status: response.status, bytes, response };
}

async function command(method, path, payload, headers) {
  const item = await request(method, path, payload, headers);
  if (item.status >= 300) throw Error(`${method} ${path}: ${item.status} ${item.value?.code ?? ''}`);
  return item;
}

function assistant(name, args) {
  return { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

const afterAddress = new Map([
  ['зазор', /зазор/i], ['смещение', /смещение/i], ['габарит', /QF-91/i], ['кронштейн', /QF-91.*\bA\b/i],
  ['шаг', /AnchorSpacing/i], ['герметизации', /не передана/i],
]);

function dataLines(reply) {
  if (!reply?.content || typeof reply.content !== 'string') return [];
  try {
    const content = JSON.parse(reply.content);
    return Array.isArray(content.lines) ? content.lines.filter((line) => typeof line.text === 'string') : [];
  } catch {
    return reply.content.split('\n').map(text => ({ text }));
  }
}

function controlled(body) {
  const { request } = body;
  const job = JSON.parse(request.messages[1].content);
  const tools = request.messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
  const issued = request.messages.flatMap(({ role, tool_calls }) =>
    role === 'assistant' && tool_calls ? tool_calls.map(({ function: call }) => call.name) : []);
  if (job.mode === 'lead') return assistant('propose_resolution', {
    aObservationId: job.dispute.a.observationId, bObservationId: job.dispute.b.observationId,
    explanation: 'Controlled review of two originals.',
  });
  if (job.mode === 'verify') {
    if (issued.length < 2) return assistant('extract', { support: issued.length === 0 ? 'A' : 'B' });
    return assistant('verify_resolution', {
      verdict: tools.every(item => item.evidence) ? 'supported' : 'unclear',
      evidenceIds: tools.flatMap(item => item.evidence ? [item.evidence.evidenceId] : []),
      explanation: 'Controlled separate verification of both representations.',
    });
  }
  if (!issued.length && job.place.page) return assistant('survey', {});
  if (!issued.includes('extract')) return assistant('extract', {});
  const native = tools[issued.indexOf('extract')];
  if (job.place.page && !dataLines(native).length && !issued.includes('ocr')) return assistant('ocr', {});
  const last = tools.at(-1);
  if (issued.includes('finish_reading')) return null;
  if (issued.includes('save_observation')) return assistant('finish_reading', {
    status: last?.qualified ? 'covered' : last?.observationId ? 'unreadable' : 'no_match',
    explanation: last?.observationId ? 'Controlled addressed finding stored.' : 'Reader rejected the candidate.',
  });
  const question = String(job.question?.property ?? '').toLowerCase();
  const pattern = [...afterAddress].find(([term]) => question.includes(term))?.[1];
  const lines = dataLines(last);
  const lineIndex = pattern ? lines.findIndex(({ text }) => pattern.test(text)) : -1;
  const index = lineIndex >= 0 ? lineIndex : (question.includes('смещение') && issued.includes('ocr')
    ? lines.findIndex(({ text }) => /[0-9]+\s*мм/.test(text)) : -1);
  const line = index >= 0 ? lines[index] : undefined;
  if (question.includes('герметизации') && line && last?.evidence) {
    const statementTool = request.tools?.find(item => item.function?.name === 'save_observation');
    const item = line.text.split(/\s+в текущей поставке\s+/iu)[0];
    if (statementTool?.function.parameters?.properties?.deliveryStatement && item !== line.text) {
      return assistant('save_observation', {
        evidenceId: last.evidence.evidenceId, lineId: line.id, quote: line.text,
        deliveryStatement: { status: 'not_delivered', item }, sourceRole: 'transmittal',
      });
    }
    return assistant('save_observation', {
      evidenceId: last.evidence.evidenceId, lineId: line.id, quote: line.text,
      value: 'не передана', unit: 'статус', sourceRole: 'reference',
    });
  }
  let row = line ? [line, lines[index + 1], lines[index + 2]].filter(Boolean) : [];
  if (line?.box) {
    row = lines.filter(candidate => candidate.box && Math.abs(candidate.box.y - line.box.y) < 2)
      .sort((a, b) => a.box.x - b.box.x);
  } else if (line?.locator?.row && question.includes('зазор')) {
    const subjectRow = lines.find(candidate => candidate.locator?.row && /QF-91/.test(candidate.text))?.locator.row;
    if (subjectRow) row = lines.filter(candidate => candidate.locator?.row === subjectRow);
  }
  const found = row.flatMap(candidate => {
    const matches = [...candidate.text.matchAll(/([0-9]+(?:[,.][0-9]+)?)\s*(мм|mm|м)(?=\s|$|\||[.])/gu)];
    if (matches.length) return [{ candidate, value: matches.at(-1)[1], unit: matches.at(-1)[2] }];
    const value = candidate.text.trim();
    const unit = row.find(entry => /^(мм|mm|м)$/.test(entry.text.trim()))?.text.trim();
    return unit && /^[0-9]+(?:[,.][0-9]+)?$/.test(value) ? [{ candidate, value, unit }] : [];
  })[0];
  if (found && last?.evidence) return assistant('save_observation', {
    evidenceId: last.evidence.evidenceId, lineId: found.candidate.id,
    quote: found.candidate.text.trim().slice(0, 490), value: found.value, unit: found.unit,
    sourceRole: 'schedule',
  });
  if (question.includes('смещение') && issued.includes('ocr') && last?.evidence) {
    return assistant('save_observation', {
      evidenceId: last.evidence.evidenceId, sourceRole: 'schedule',
      limitation: 'Controlled OCR found no readable measurement in the inspected raster unit.',
    });
  }
  return assistant('finish_reading', { status: 'no_match', explanation: 'Controlled scan returned no matching reading.' });
}

async function startProvider() {
  provider = createServer(async (req, res) => {
    try {
      const body = await new Response(req).json();
      if (!body.routeId.startsWith('managed-')) throw Error('Only managed traffic is allowed');
      const completion = controlled(body);
      const initial = JSON.parse(body.request.messages[1].content);
      const call = {
        attempt: body.attempt.id, routeId: body.routeId, projectId: body.attempt.projectId,
        generationId: body.attempt.generationId, requestHash: sha(JSON.stringify(body.request)),
        action: completion?.choices[0].message.tool_calls[0].function.name ?? 'controlled_refusal',
        mode: initial.mode, unitId: initial.place?.unitId, elapsedNs: since(),
      };
      calls.set(call.attempt, call);
      await appendFile(join(output, 'managed-attempts.jsonl'), JSON.stringify(call) + '\n');
      res.setHeader('content-type', 'application/json');
      if (completion === null) {
        res.end(JSON.stringify({ receipt: {
          state: 'rejected', code: 'controlled_terminal_refusal', evidenceRef: `controlled:${call.requestHash}`,
        } }));
        return;
      }
      res.end(JSON.stringify({ receipt: {
        state: 'paid', costUsdNanos: 0, providerId: `managed:${body.attempt.id}`,
        evidenceRef: `controlled:${call.requestHash}`,
      }, output: completion }));
    } catch (error) {
      await appendFile(join(output, 'managed-errors.log'), String(error?.name ?? 'Error') + '\n');
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  options = managedWorkerOptions(`http://127.0.0.1:${provider.address().port}/replay`, import.meta.url);
}

function beginWorker() {
  stop = new AbortController();
  worker = startWorker({ db: app.db, config, signal: stop.signal, logger: app.log }, options);
}

async function stopWorker() {
  if (!worker) return;
  stop.abort();
  await worker;
  worker = null;
}

async function inputs(directory, prefix = '') {
  const list = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) list.push(...await inputs(path, name + '/'));
    else if (entry.isFile()) list.push({ name, bytes: await readFile(path) });
    else throw Error('Unexpected input entry');
  }
  return list;
}

async function stageInputs(caseName) {
  const manifest = JSON.parse(await readFile(join(root, 'manifests', caseName + '.json')));
  const files = await inputs(join(root, 'input', caseName));
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(files.map(({ name }) => name).sort()) ||
      files.some(({ name, bytes }) => sha(bytes) !== manifest[name])) {
    throw Error('Frozen input manifest does not match staged files');
  }
  return { manifest, files };
}

async function upload(project, files, manifest, targetScope, afterDeclare) {
  const base = `/api/projects/${project.id}`;
  const res = await command('POST', base + '/receipts', { source: 'upload' });
  const receipt = '/api/receipts/' + res.value.receiptId;
  const declarations = [];
  for (const file of files) {
    const digest = sha(file.bytes);
    if (manifest[file.name] !== digest) throw Error('Frozen original changed');
    const scope = file.name.startsWith('Смежный фасад/') ? 'Южный пирс' : targetScope;
    const scopeIds = project.scopes.filter(({ name }) => name === scope).map(({ id }) => id);
    const prepared = await command('POST', receipt + '/uploads', {
      relativePath: file.name, size: file.bytes.length, sha256: digest, scopeIds,
    });
    declarations.push({ ...file, digest, upload: '/api/uploads/' + prepared.value.uploadId });
  }
  await afterDeclare?.({ receiptId: res.value.receiptId, href: receipt });
  const versions = {};
  for (const { name, bytes, digest, upload: id } of declarations) {
    await command('PUT', id + '/parts/1', bytes, {
      'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-part-sha256': digest,
    });
    const { value } = await command('POST', id + '/complete', {});
    const original = await command('GET', `/api/documents/${value.documentId}/versions/${value.versionId}/content`);
    if (!original.response.headers.get('cache-control')?.includes('no-store') ||
        !original.bytes || sha(original.bytes) !== digest) throw Error('Reopened bytes or cache policy differ');
    versions[name] = value;
  }
  await command('POST', receipt + '/seal', {});
  return { receiptId: res.value.receiptId, href: receipt, versions };
}

async function databaseState(projectId) {
  const generations = (await app.db.query(`SELECT generation_id AS id, sealed
    FROM gateway_generations WHERE project_id=$1 AND current ORDER BY generation_id`, [projectId])).rows;
  const ids = generations.map(({ id }) => id);
  const obligations = (await app.db.query(`SELECT generation_id, branch, place, state, evidence_ref
    FROM gateway_primary WHERE generation_id=ANY($1::uuid[]) ORDER BY generation_id, branch, place`, [ids])).rows;
  const work = (await app.db.query(`SELECT purpose, state, reason, count(*)::int AS count FROM gateway_jobs
    WHERE generation_id=ANY($1::uuid[]) GROUP BY purpose, state, reason ORDER BY purpose, state, reason`, [ids])).rows;
  const attempts = (await app.db.query(`SELECT route_id,state,count(*)::int AS count FROM gateway_attempts
    WHERE project_id=$1 GROUP BY route_id,state ORDER BY route_id,state`, [projectId])).rows;
  const unscheduledReviews = (await app.db.query(`SELECT d.id FROM harness_disputes d
    WHERE d.generation_id=ANY($1::uuid[])
      AND NOT EXISTS (SELECT 1 FROM gateway_primary p WHERE p.generation_id=d.generation_id AND p.state='pending')
      AND NOT EXISTS (SELECT 1 FROM gateway_jobs j WHERE j.generation_id=d.generation_id AND j.job_key='lead:'||d.id)
    ORDER BY d.id`, [ids])).rows;
  return { generations, obligations, work, attempts, unscheduledReviews };
}

async function settle(projectId, previous, limitMs) {
  const deadline = Date.now() + limitMs;
  let state, quietSince, previousSnapshot;
  do {
    state = await databaseState(projectId);
    if (state.generations.length && state.generations.some(({ id }) => !previous.includes(id)) &&
        state.generations.every(({ sealed }) => sealed) && state.obligations.length &&
        !state.unscheduledReviews.length && state.work.every(({ state }) => !['ready', 'leased'].includes(state))) {
      const snapshot = JSON.stringify(state);
      if (snapshot !== previousSnapshot) quietSince = Date.now();
      previousSnapshot = snapshot;
      if (Date.now() - quietSince >= 1800) return { ...state, observationEndedBy: 'no-runnable-work' };
    } else {
      previousSnapshot = undefined;
    }
    await delay(450);
  } while (Date.now() < deadline);
  return { ...state, observationEndedBy: 'time-limit' };
}

async function assessmentViews(project) {
  const assessments = {};
  for (const scope of project.scopes) {
    assessments[scope.name] = (await command('GET',
      `/api/projects/${project.id}/assessments/current?scopeId=${scope.id}`)).value;
  }
  return assessments;
}

async function capture(project, receipt) {
  const inventory = (await command('GET', receipt.href + '/inventory')).value;
  const assessments = await assessmentViews(project);
  const cards = {};
  for (const value of Object.values(receipt.versions)) {
    const item = await request('GET', `/api/v1/documents/${value.documentId}/versions/${value.versionId}/reader/units`);
    cards[value.versionId] = { status: item.status, value: item.value };
  }
  return { inventory, assessments, cards };
}

async function resolveInitialHolds(project, frozen, workload) {
  const changes = [];
  if (frozen.inventory.inventoryOpen || workload.obligations.some(item => item.state === 'pending')) return changes;
  const initialHolds = new Map();
  for (const view of Object.values(frozen.assessments)) {
    if ((view.questions ?? []).some(question => question.decision)) return changes;
    for (const hold of view.holds ?? []) initialHolds.set(hold.id, hold);
  }
  for (const hold of initialHolds.values()) {
    if (hold.source !== 'upload' || hold.receiptId !== frozen.inventory.receiptId || !hold.scopeIds?.length) continue;
    const impacts = [];
    for (const scopeId of hold.scopeIds) {
      const item = await command('GET', `/api/projects/${project.id}/assessments/current?scopeId=${scopeId}`);
      impacts.push({ scopeId, assessmentVersion: item.value.version, questionIds: [] });
    }
    const item = await request('POST', `/api/projects/${project.id}/supplements/holds/${hold.id}/resolve`, {
      generation: hold.generation,
      reason: 'Synthetic engineer verified the first accepted receipt and the absence of previous decisions.',
      impacts,
    }, { 'if-match': `"${hold.version}"` });
    changes.push({ holdId: hold.id, status: item.status, result: item.value });
  }
  return changes;
}

async function engineerLetter(project, caseName, mode, state, targetScope, workload, options) {
  const ownerSession = session;
  session = engineerSession;
  try {
    const classification = await resolveInitialHolds(project, state, workload);
    const scope = project.scopes.find(({ name }) => name === targetScope);
    const current = (await command('GET',
      `/api/projects/${project.id}/assessments/current?scopeId=${scope.id}`)).value;
    return { classification, ...await letter(project, caseName, mode, current, targetScope, options) };
  } finally {
    session = ownerSession;
  }
}

async function openCitation(citation) {
  if (!citation.href?.startsWith('/api/')) return null;
  const evidence = await request('GET', citation.href);
  const href = evidence.value?.originalHref;
  const original = href?.startsWith('/api/') ? await request('GET', href) : null;
  return { evidenceId: citation.evidenceId, status: evidence.status, originalStatus: original?.status,
    originalSha256: original?.bytes ? sha(original.bytes) : null, expectedSha256: citation.sha256,
    address: citation.address, versionId: citation.versionId };
}

function verifiedCitation(proof) {
  return proof?.status === 200 && proof.originalStatus === 200 && proof.originalSha256 === proof.expectedSha256;
}

async function letter(project, caseName, mode, state, targetScope, options = {}) {
  const scope = project.scopes.find(({ name }) => name === targetScope);
  const base = `/api/projects/${project.id}/letters`;
  const decisions = [];
  const proofs = [];
  for (const question of state.questions ?? []) {
    if (options.changedQuestionId && question.id !== options.changedQuestionId) continue;
    const part = question.requirement?.part?.toLowerCase() ?? '';
    const expected = caseName === 'missing' && part.includes('герметизации') ? 'confirmed_missing'
      : ['conflict','mixed'].includes(caseName) && part.includes('зазор') ? 'confirmed_conflict' : null;
    if (!options.allQuestions && !expected) continue;
    const citations = question.machine?.citations ?? [];
    for (const citation of citations) {
      const proof = await openCitation(citation);
      if (proof) proofs.push({ questionId: question.id, ...proof });
    }
    const proven = proofs.filter(item => item.questionId === question.id && verifiedCitation(item));
    const currentOutcome = question.machine?.outcome;
    const successorRequired = options.changedQuestionId === question.id;
    const currentBasis = !successorRequired || citations.some(({ versionId }) => options.newVersions.has(versionId));
    const external = ['confirmed_missing', 'confirmed_conflict'].includes(currentOutcome);
    const supportCurrent = currentBasis && proven.length === citations.length && citations.length > 0;
    const target = options.allQuestions ? currentOutcome : expected;
    const keepInternal = options.allQuestions && (currentOutcome === 'needs_review' || !supportCurrent || (successorRequired && external));
    const choice = keepInternal ? { action: 'correct', outcome: 'needs_review' }
      : currentOutcome === target ? { action: 'confirm' } : {
        action: 'correct', outcome: target,
        observationIds: [...new Set(citations.map(({ observationId }) => observationId))],
      };
    const decision = await request('POST', `/api/questions/${question.id}/decisions`, {
      ...choice, reason: keepInternal ? 'Synthetic engineer retained an unresolved or superseded basis for internal review.'
        : 'Synthetic engineer checked the frozen managed result and original citations.',
      requestExternal: options.allQuestions ? !keepInternal && external : true,
    }, { 'if-match': `"${question.version}"` });
    decisions.push({ id: question.id, action: keepInternal ? 'keep_internal' : choice.action, expected: target,
      status: decision.status, result: decision.value });
    if (decision.status === 422) {
      const internal = await request('POST', `/api/questions/${question.id}/decisions`, {
        action: 'correct', outcome: 'needs_review', reason: 'Synthetic engineer retained an internal check.',
      }, { 'if-match': `"${question.version}"` });
      decisions.push({ id: question.id, action: 'keep_internal', status: internal.status, result: internal.value });
    }
  }
  const eligible = await request('GET', base + '/eligible?scopeId=' + scope.id);
  const selections = (eligible.value?.items ?? []).map(({ questionId, questionVersion, decisionId }) =>
    ({ questionId, questionVersion, decisionId }));
  const before = await request('GET', base);
  const created = await request('POST', base, {
    scopeId: scope.id, recipient: 'ООО «Испытательная сторона»', items: selections,
  });
  const exports = {};
  if (created.status === 201) {
    const createdPath = '/api/letters/' + created.value.id;
    for (const format of ['txt', 'docx']) {
      const item = await request('POST', createdPath + '/exports', { format },
        { 'if-match': `"${created.value.version}"` });
      if (item.value?.url?.startsWith('/api/')) {
        const fetched = await request('GET', item.value.url);
        if (fetched.bytes && fetched.status === 200) {
          const name = `${caseName}-${mode}.${format}`;
          await writeFile(join(output, name), fetched.bytes);
          exports[format] = { file: name, sha256: sha(fetched.bytes), url: item.value.url, historicalUrl: item.value.historicalUrl };
        }
      }
    }
  }
  const after = await request('GET', base);
  return { engineerId, proofs, decisions, eligible: eligible.value, createStatus: created.status, created: created.value, exports,
    before: before.value, after: after.value };
}

async function readHistory(firstLetter, sentUrl) {
  const { id, revisionId, version } = firstLetter.created;
  const path = `/api/letters/${id}`;
  const current = await request('GET', path + '/current-text', undefined, { 'if-match': `"${version}"` });
  const revision = await command('GET', `${path}/revisions/${revisionId}`);
  const sent = sentUrl ? (await command('GET', sentUrl)).value : null;
  const citations = (sent ?? revision.value).items.flatMap(item => item.basis.citations);
  const proofs = await Promise.all(citations.map(openCitation));
  const exports = {};
  for (const [format, entry] of Object.entries(firstLetter.exports)) {
    const historical = await request('GET', entry.historicalUrl);
    const latest = await request('GET', entry.url);
    exports[format] = { historicalStatus: historical.status, historicalHeader: historical.response.headers.get('x-letter-historical'),
      historicalSha256: historical.bytes ? sha(historical.bytes) : null, currentStatus: latest.status, currentCode: latest.value?.code };
  }
  return { current: { status: current.status, value: current.value }, revision: revision.value, sent, exports, proofs };
}

async function researchEvidence(projectId, workload) {
  const ids = workload.generations.map(({ id }) => id);
  const { rows: observations } = await app.db.query(`SELECT generation_id, scope_id, question_id, finding
    FROM harness_observations WHERE project_id=$1 AND generation_id=ANY($2::uuid[]) ORDER BY generation_id, observation_id`,
  [projectId, ids]);
  const { rows: representation } = await app.db.query(`SELECT j.generation_id, j.scope_id, j.subject_id, e.branch,
      e.payload->'source' AS source, e.payload->'address' AS address, e.payload->>'representation' AS representation,
      e.payload->>'format' AS format, e.id
    FROM reader_evidence e JOIN gateway_jobs j ON j.id=e.run_id
    WHERE e.project_id=$1 AND j.generation_id=ANY($2::uuid[]) ORDER BY j.generation_id, e.id`, [projectId, ids]);
  return { observations, representation };
}

async function recordConclusion(projectPath, view) {
  const startWork = view.outcome === 'sufficient' ? 'can_start' : 'cannot_start';
  const item = await request('POST', projectPath + '/conclusions', {
    scopeId: view.scope.id, startWork,
    reason: startWork === 'cannot_start' ? 'Обязательные вопросы по синтетическому комплекту остаются открытыми.'
      : 'Синтетическая проверка обязательных вопросов завершена.',
  }, { 'if-match': `"${view.version}"` });
  return { status: item.status, value: item.value, startWork };
}

async function mixedFollowup(project, targetScope, baseline, firstLetter, engineerPassword, recordSent) {
  const ownerSession = session;
  session = engineerSession;
  try {
    const projectPath = `/api/projects/${project.id}`;
    const scope = project.scopes.find(({ name }) => name === targetScope);
    const initialConclusion = await recordConclusion(projectPath, (await assessmentViews(project))[targetScope]);
    const before = await assessmentViews(project);
    const changed = before[targetScope].questions.find(item => item.requirement.positionId === 'gap');
    session = {};
    const secondLogin = await command('POST', '/api/sessions', { login: 'stage15_engineer', password: engineerPassword });
    const secondSession = { cookie: secondLogin.response.headers.get('set-cookie').split(';')[0],
      'x-csrf-token': secondLogin.value.csrfToken };
    session = secondSession;
    const secondRead = (await assessmentViews(project))[targetScope].questions.find(item => item.id === changed.id);
    if (secondSession.cookie === engineerSession.cookie || secondRead.version !== changed.version) {
      throw Error('The independent stale session did not open the same confirmed question version');
    }
    session = engineerSession;
    let sent = null;
    let beforeHistory = null;
    if (firstLetter.createStatus === 201) {
      const old = await readHistory(firstLetter);
      beforeHistory = old;
      if (recordSent) {
        const item = old.revision.items.find(entry => entry.questionId === changed.id);
        if (!item || old.current.status !== 200) throw Error('Missing current item for synthetic sent registration');
        sent = (await command('POST', `/api/letters/${firstLetter.created.id}/sent`, {
          revisionId: old.revision.id, recipient: old.revision.recipient, itemIds: [item.id],
          text: old.current.value.text, sentAt: new Date().toISOString(),
        })).value;
        beforeHistory = await readHistory(firstLetter, sent.url);
      }
    }
    await result('mixed-before-followup-history.json', { before, initialConclusion, sent, beforeHistory });
    const { files, manifest } = await stageInputs('mixed-followup');
    const receipt = await upload(project, files, manifest, targetScope, async pending => {
      await result('mixed-followup-declared.json', { pending, assessments: await assessmentViews(project),
        history: beforeHistory ? await readHistory(firstLetter, sent?.url) : null });
    });
    const workload = await settle(project.id, baseline.generations.map(({ id }) => id), mixedSettleLimit);
    const captured = await capture(project, receipt);
    const machineFile = 'mixed-followup-machine.json';
    await result(machineFile, { project, receipt, workload, captured, evidence: await researchEvidence(project.id, workload) });
    const linked = sent ? await request('POST', `${projectPath}/supplements/links`, {
      receiptId: receipt.receiptId, letterId: firstLetter.created.id, sentId: sent.id,
    }) : null;
    const classification = [];
    for (const hold of captured.assessments[targetScope].holds.filter(item => item.receiptId === receipt.receiptId)) {
      const current = (await assessmentViews(project))[targetScope];
      const impacts = [{ scopeId: scope.id, assessmentVersion: current.version, questionIds: [changed.id] }];
      const item = await request('POST', `${projectPath}/supplements/holds/${hold.id}/resolve`, {
        generation: hold.generation, reason: 'The accepted revision expressly changes only the QF-91 clearance.', impacts,
      }, { 'if-match': `"${hold.version}"` });
      classification.push({ holdId: hold.id, status: item.status, value: item.value, impacts });
    }
    const reviewedWork = await settle(project.id, [], mixedSettleLimit);
    const beforeDecision = await assessmentViews(project);
    await result('mixed-followup-after-impact-machine.json', { reviewedWork, assessments: beforeDecision,
      evidence: await researchEvidence(project.id, reviewedWork) });
    session = secondSession;
    const stale = await request('POST', `/api/questions/${changed.id}/decisions`, {
      action: 'confirm', reason: 'Synthetic stale-version negative control.', requestExternal: true,
    }, { 'if-match': `"${secondRead.version}"` });
    session = engineerSession;
    const newVersions = new Set(Object.values(receipt.versions).map(({ versionId }) => versionId));
    const after = await letter(project, 'mixed', 'followup', beforeDecision[targetScope], targetScope,
      { allQuestions: true, changedQuestionId: changed.id, newVersions });
    const nextConclusion = await recordConclusion(projectPath, (await assessmentViews(project))[targetScope]);
    const oldAssessment = initialConclusion.status === 201 ? await request('GET',
      `${projectPath}/assessments/${initialConclusion.value.version}?scopeId=${scope.id}`) : null;
    const history = beforeHistory ? await readHistory(firstLetter, sent?.url) : null;
    await result('mixed-followup-result.json', {
      frozenMachineSha256: sha(await readFile(join(output, machineFile))),
      linked: linked ? { status: linked.status, value: linked.value } : null, classification,
      stale: { separateSession: true, originalQuestionVersion: secondRead.version, status: stale.status, value: stale.value },
      after, nextConclusion, assessments: await assessmentViews(project),
      historicalConclusion: oldAssessment ? { status: oldAssessment.status, value: oldAssessment.value?.conclusion,
        unchanged: oldAssessment.status === 200 &&
          JSON.stringify(oldAssessment.value?.conclusion) === JSON.stringify(before[targetScope].conclusion) } : null,
      history, historyUnchanged: history && JSON.stringify(history.sent) === JSON.stringify(beforeHistory.sent) &&
        JSON.stringify(history.revision) === JSON.stringify(beforeHistory.revision) &&
        history.proofs.length > 0 && history.proofs.every(verifiedCitation) &&
        Object.keys(firstLetter.exports).every(format => history.exports[format].historicalSha256 === firstLetter.exports[format].sha256),
    });
  } finally {
    session = ownerSession;
  }
}

async function storedQuestionReview(view, question) {
  const { rows: [stored] } = await app.db.query(`SELECT review FROM assessment_question_revisions
    WHERE scope_id=$1 AND question_id=$2 AND assessment_version<=$3
    ORDER BY assessment_version DESC LIMIT 1`, [view.scope.id, question.id, view.version]);
  return stored?.review;
}

function replacementSelection(review, cold, followup) {
  const oldPaths = [
    'Комплект/Монтаж/Выпуск 134.pdf', 'Комплект/Монтаж/Протокол монтажа.docx', 'Комплект/Монтаж/Протокол монтажа.doc',
  ];
  const oldSources = new Map(oldPaths.map(path => [cold.receipt.versions[path].versionId, path]));
  const incoming = new Set(Object.values(followup.receipt.versions).map(({ versionId }) => versionId));
  const replaced = new Map();
  const replacements = new Map();
  for (const finding of review?.findings ?? []) {
    if (finding.kind !== 'value') continue;
    const { citation } = finding;
    const { versionId, address, branch } = citation;
    const locator = address.locator ?? {};
    const path = oldSources.get(versionId);
    const atOldAddress = path?.endsWith('.pdf') ? locator.page === 1
      : locator.table === 1 && locator.row === 2 && locator.column === 2;
    if (path && atOldAddress && finding.applicability === 'active') {
      replaced.set(canonicalJson([versionId, address]), citation);
    }
    if (incoming.has(versionId) && locator.line === 3 && ['A', 'B'].includes(branch)) replacements.set(branch, citation);
  }
  const selected = { replaced: [...replaced.values()], replacements: [...replacements.values()] };
  return { ...selected, ready: new Set(selected.replaced.map(({ versionId }) => versionId)).size === oldSources.size
    && selected.replacements.length === 2 };
}

async function applySyntheticReplacement(gap, selection) {
  if (!selection.ready) return { status: null, code: 'fixture_addresses_unavailable' };
  const references = entries => entries.map(({ observationId, evidenceId, versionId }) => ({ observationId, evidenceId, versionId }));
  const res = await request('POST', `/api/questions/${gap.id}/source-replacements`, {
    reason: 'Тестовый инженер подтверждает замену только указанных старых адресов зазора QF-91 на опоры A/B редакции N06.',
    replaced: references(selection.replaced), replacements: references(selection.replacements),
  }, { 'if-match': `"${gap.version}"` }, 40000);
  return { status: res.status, value: res.value };
}

async function checkAddressedReplacement(project, scopeName, before, gap, selection, firstLetter, storedBefore) {
  const proof = await Promise.all([...selection.replaced, ...selection.replacements].map(openCitation));
  const response = proof.every(verifiedCitation) ? await applySyntheticReplacement(gap, selection)
    : { status: null, code: 'reference_open_failed' };
  const after = await assessmentViews(project);
  const updated = after[scopeName].questions.find(item => item.id === gap.id);
  const storedReview = await storedQuestionReview(after[scopeName], updated);
  let finalDecision = null;
  if (response.status === 201 && updated.machine.outcome === 'covered') {
    const newProof = await Promise.all(updated.machine.citations.map(openCitation));
    if (newProof.length && newProof.every(verifiedCitation)) {
      const res = await request('POST', `/api/questions/${gap.id}/decisions`, {
        action: 'confirm', reason: 'Тестовый инженер открыл действующие опоры N06 и подтвердил новое значение.',
        requestExternal: false,
      }, { 'if-match': `"${updated.version}"` });
      finalDecision = { status: res.status, value: res.value, proof: newProof, assessments: await assessmentViews(project) };
    }
  }
  const history = firstLetter.createStatus === 201 ? await readHistory(firstLetter) : null;
  const applicability = await request('GET', `/api/questions/${gap.id}/applicability`);
  const base = `/api/projects/${project.id}`;
  const eligible = await request('GET', `${base}/letters/eligible?scopeId=${after[scopeName].scope.id}`);
  const oldConclusion = await request('GET', `${base}/assessments/${storedBefore.initialConclusion.value.version}?scopeId=${after[scopeName].scope.id}`);
  await result('mixed-addressed-replacement.json', { selection, proof, response, before, after, history, storedReview, finalDecision,
    applicability: { status: applicability.status, value: applicability.value },
    eligible: { status: eligible.status, value: eligible.value },
    oldConclusion: { status: oldConclusion.status, value: oldConclusion.value?.conclusion },
    expectedEngineerId: engineerId,
    frozenOriginalResultSha256: sha(await readFile(join(output, 'mixed-followup-result.json'))) });
}

async function checkCatalogAlternative(project, profile, firstLetter, addressReplacement) {
  const projectPath = `/api/projects/${project.id}`;
  const original = (await command('GET', projectPath)).value;
  const cold = JSON.parse(await readFile(join(output, 'mixed-cold.json')));
  const followup = JSON.parse(await readFile(join(output, 'mixed-followup-machine.json')));
  const storedBefore = JSON.parse(await readFile(join(output, 'mixed-before-followup-history.json')));
  const scopeName = profile.project.scopeName;
  if (addressReplacement) {
    const ownerSession = session;
    session = engineerSession;
    try {
      const view = (await assessmentViews(project))[scopeName];
      const gap = view.questions.find(item => item.requirement.positionId === 'gap');
      const current = replacementSelection(await storedQuestionReview(view, gap), cold, followup);
      const frozenFindings = followup.evidence.observations.filter(item => item.question_id === gap.id
        && item.scope_id === view.scope.id).map(item => item.finding);
      const selection = current.ready ? current : replacementSelection({ findings: frozenFindings }, cold, followup);
      const response = await applySyntheticReplacement(gap, selection);
      const history = await request('GET', `/api/questions/${gap.id}/applicability`);
      await result('mixed-original-replacement-hold.json', { selection, response, history: { status: history.status, value: history.value },
        equivalentFormats: gap.requirement.equivalentFormats });
      if (response.status === 201) return;
    } finally {
      session = ownerSession;
    }
  }
  const baseline = await databaseState(project.id);
  const catalog = structuredClone(profile.catalog);
  const rule = catalog.requirements.find(item => item.key === 'gap');
  if (rule.formats.includes('txt') || rule.equivalents.includes('txt')) throw Error('TXT is already allowed');
  rule.equivalents.push('txt');
  const { value: approved } = await command('POST', '/api/catalogs', catalog);
  await command('PUT', projectPath + '/catalog', { catalogVersionId: approved.id },
    { 'if-match': `"${original.version}"` });
  const workload = await settle(project.id, baseline.generations.map(({ id }) => id), mixedSettleLimit);
  const ownerSession = session;
  session = engineerSession;
  try {
    const assessments = await assessmentViews(project);
    const view = assessments[scopeName];
    const gap = view.questions.find(item => item.requirement.positionId === 'gap');
    const stored = await storedQuestionReview(view, gap);
    await result('mixed-catalog-alternative.json', { previousCatalogId: original.catalogVersionId, newCatalogId: approved.id,
      equivalents: rule.equivalents, workload, assessments, storedReview: stored,
      frozenOriginalResultSha256: sha(await readFile(join(output, 'mixed-followup-result.json'))) });
    if (addressReplacement) {
      const selection = replacementSelection(stored, cold, followup);
      await checkAddressedReplacement(project, scopeName, assessments, gap, selection, firstLetter, storedBefore);
      return;
    }
    const newVersions = new Set(Object.values(followup.receipt.versions).map(({ versionId }) => versionId));
    if (gap.machine.outcome === 'covered' && gap.machine.citations.some(({ versionId }) => newVersions.has(versionId))) {
      const proofs = await Promise.all(gap.machine.citations.map(openCitation));
      const decision = proofs.every(verifiedCitation) ? await request('POST', `/api/questions/${gap.id}/decisions`, {
        action: 'confirm', reason: 'Тестовый инженер сверил основания с утверждённым эквивалентом.', requestExternal: false,
      }, { 'if-match': `"${gap.version}"` }) : null;
      await result('mixed-catalog-alternative-decision.json', { proofs,
        decision: decision ? { status: decision.status, value: decision.value } : null });
    }
  } finally {
    session = ownerSession;
  }
}

async function rewindOneTestCheckpoint(project, caseName) {
  const chosen = (await app.db.query(`SELECT j.id, e.sequence AS sequence, e.event
    FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
      JOIN harness_research_events e ON e.job_id=j.id
    WHERE g.current AND j.project_id=$1 AND j.state='done' AND j.purpose IN ('primary_a','primary_b')
      AND e.event->>'kind'='model' AND e.event#>>'{message,tool_calls,0,function,name}'='finish_reading'
      AND EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.id::text=e.event->>'attemptId' AND a.state='paid')
    ORDER BY e.created_at DESC LIMIT 1`, [project.id])).rows[0];
  if (!chosen) return null;
  const snapshot = (await app.db.query(`SELECT sequence,event FROM harness_research_events
    WHERE job_id=$1 AND sequence >= $2 ORDER BY sequence`, [chosen.id, chosen.sequence])).rows;
  await result(caseName + '-replay-checkpoint.json', { id: chosen.id, syntheticOnly: true, events: snapshot });
  const tx = await app.db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`UPDATE gateway_jobs SET state='ready',available_at=clock_timestamp(),cursor=$2::jsonb
      WHERE id=$1 AND state='done'`, [chosen.id, JSON.stringify({ researchSequence: chosen.sequence - 1 })]);
    await tx.query('DELETE FROM harness_research_events WHERE job_id=$1 AND sequence >= $2',
      [chosen.id, chosen.sequence]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  return chosen;
}

async function replayResult(chosen) {
  if (!chosen) return null;
  const deadline = Date.now() + 16000;
  let state, restored;
  do {
    state = (await app.db.query('SELECT state,reason FROM gateway_jobs WHERE id=$1', [chosen.id])).rows[0];
    if (state && ['done','held'].includes(state.state)) break;
    await delay(300);
  } while (Date.now() < deadline);
  restored = (await app.db.query('SELECT event FROM harness_research_events WHERE job_id=$1 AND sequence=$2',
    [chosen.id, chosen.sequence])).rows[0]?.event;
  return { state, sameAttempt: Boolean(restored?.attemptId && restored.attemptId === chosen.event.attemptId),
    sameRequestHash: Boolean(restored?.requestHash && restored.requestHash === chosen.event.requestHash) };
}

const projects = [];
try {
  await app.listen({ host: '127.0.0.1', port: 3000 });
  await bootstrapAdmin(app.db, { organization: 'Stage 15 controlled transport', login: 'stage15_acceptance', password });
  const auth = await command('POST', '/api/sessions', { login: 'stage15_acceptance', password });
  session = { cookie: auth.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': auth.value.csrfToken };
  const { value: invitation } = await command('POST', '/api/users/invitations', { login: 'stage15_engineer' });
  engineerId = invitation.userId;
  const ownerSession = session;
  const engineerPassword = randomUUID() + '-engineer';
  session = {};
  await command('POST', '/api/invitations/complete', { token: invitation.token, password: engineerPassword });
  session = ownerSession;
  await startProvider();
  beginWorker();
  for (const scenario of process.env.STEP15_CASES.split(',')) {
    const followup = ['mixed-followup', 'mixed-regression', 'mixed-addressed'].includes(scenario);
    const caseName = followup ? 'mixed' : scenario;
    const profile = JSON.parse(await readFile(join(root, 'config', caseName + '.json')));
    if (caseName === 'missing') {
      const control = profile.catalog.requirements.find(item => item.key === 'detail');
      control.sourceRoles.push('reference');
    }
    await result(caseName + '-profile.json', profile);
    const { manifest, files } = await stageInputs(caseName);
    const { value: catalog } = await command('POST', '/api/catalogs', profile.catalog);
    let { value: project } = await command('POST', '/api/projects', {
      ...profile.project, catalogVersionId: catalog.id,
    });
    for (const scope of profile.scopes) await command('POST', `/api/projects/${project.id}/scopes`, scope);
    const projectPath = `/api/projects/${project.id}`;
    project = (await command('GET', projectPath)).value;
    await command('PUT', projectPath + '/members/' + engineerId, { role: 'engineer' },
      { 'if-match': `"${project.version}"` });
    // The membership command revokes the member's earlier sessions.
    session = {};
    const engineer = await command('POST', '/api/sessions', { login: 'stage15_engineer', password: engineerPassword });
    engineerSession = { cookie: engineer.response.headers.get('set-cookie').split(';')[0],
      'x-csrf-token': engineer.value.csrfToken };
    session = ownerSession;
    project = (await command('GET', projectPath)).value;
    for (const route of ['a', 'b', 'lead']) {
      await gateway.configureRoute({ id: 'managed-' + route, revision: 'controlled-step15',
        transport: 'managed', enabled: true, maxRequestBytes: 16 * 1024 ** 2,
        ceilingUsdNanos: 1, timeoutMs: 12000 });
      const purposes = route === 'lead' ? ['review'] : [route === 'a' ? 'primary_a' : 'primary_b', 'review'];
      for (const purpose of purposes) {
        await gateway.grantRoute({ projectId: project.id, routeId: 'managed-' + route,
          revision: 'controlled-step15', purpose, dataClass: 'synthetic', allowed: true });
      }
    }
    const coldStart = since();
    const receipt = await upload(project, files, manifest, profile.project.scopeName);
    const timeLimit = caseName === 'mixed' ? mixedSettleLimit : settleLimit;
    const coldState = await settle(project.id, [], timeLimit);
    const cold = await capture(project, receipt);
    const coldMachine = caseName + '-cold-machine.json';
    await result(coldMachine, { project, receipt, coldState, cold,
      ...(followup ? { evidence: await researchEvidence(project.id, coldState) } : {}) });
    const coldObservedNs = since();
    const coldLetter = await engineerLetter(project, caseName, 'cold', cold, profile.project.scopeName, coldState,
      followup ? { allQuestions: true } : undefined);
    await result(caseName + '-cold.json', { project, receipt, coldStart, observedNs: coldObservedNs, coldState, cold,
      frozenMachineSha256: sha(await readFile(join(output, coldMachine))),
      letter: coldLetter });
    if (followup) {
      await mixedFollowup(project, profile.project.scopeName, coldState, coldLetter, engineerPassword, scenario === 'mixed-followup');
      if (scenario !== 'mixed-followup') await checkCatalogAlternative(project, profile, coldLetter, scenario === 'mixed-addressed');
      continue;
    }
    const warmStart = since();
    const { value: warmCatalog } = await command('POST', '/api/catalogs', profile.catalog);
    project = (await command('GET', projectPath)).value;
    await command('PUT', projectPath + '/catalog', { catalogVersionId: warmCatalog.id },
      { 'if-match': `"${project.version}"` });
    const warmState = await settle(project.id, coldState.generations.map(({ id }) => id), timeLimit);
    const warm = await capture(project, receipt);
    const warmMachine = caseName + '-warm-machine.json';
    await result(warmMachine, { project, receipt, warmState, warm });
    const warmLetter = await engineerLetter(project, caseName, 'warm', warm, profile.project.scopeName, warmState);
    const offlineBaseline = await capture(project, receipt);
    await result(caseName + '-warm.json', { project, receipt, warmStart, observedNs: since(), warmState, warm,
      frozenMachineSha256: sha(await readFile(join(output, warmMachine))), letter: warmLetter, offlineBaseline });
    projects.push({ caseName, project, receipt, warmState, warmLetter, offlineBaseline });
  }

  await stopWorker();
  await new Promise(resolve => provider.close(resolve));
  provider = null;
  const count = calls.size;
  const replays = new Map();
  if (process.env.STEP15_CHECKPOINT_REPLAY === '1') {
    // Retain the route, ledger and cached paid reply. The loopback server is
    // gone and the container remains on the stand's internal network.
    for (const { project, caseName } of projects) {
      replays.set(project.id, await rewindOneTestCheckpoint(project, caseName));
    }
  } else {
  }
  beginWorker();
  await delay(1500);
  for (const { caseName, project, receipt, warmState, warmLetter, offlineBaseline } of projects) {
    const replay = await replayResult(replays.get(project.id));
    const afterRestart = await capture(project, receipt);
    const retained = {};
    if (warmLetter.created?.id) {
      for (const format of ['txt','docx']) {
        const list = await request('GET', '/api/letters/' + warmLetter.created.id);
        const item = list.value?.exports?.find(entry => entry.format === format);
        if (item?.id) {
          const file = await request('GET', `/api/letters/${warmLetter.created.id}/exports/${item.id}`);
          if (file.status === 200 && file.bytes) retained[format] = sha(file.bytes);
        }
      }
    }
    await result(caseName + '-offline.json', {
      restartAfterManagedTransportStopped: true, newManagedRequests: calls.size - count,
      replay,
      before: warmState, after: await databaseState(project.id),
      captureEqual: JSON.stringify(offlineBaseline) === JSON.stringify(afterRestart),
      captured: afterRestart, retained,
    });
  }
  await result('journal-balance.json', await journal.journal.balance());
} finally {
  await stopWorker();
  if (provider) await new Promise(resolve => provider.close(resolve));
  await app.close();
  await journal.close();
}
