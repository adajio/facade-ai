import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const compiledRoot = process.env.FACADE_E2E_BUILD_DIR
  ? pathToFileURL(`${resolve(process.env.FACADE_E2E_BUILD_DIR)}/`)
  : new URL('../../dist/', import.meta.url);
export const compiled = (path) => import(new URL(`src/modules/${path}`, compiledRoot));
const [{ bootstrapAdmin }, { transaction }, { lockIntakeProject }, { createRuntimePdfService }, { resolveSupplementImpact }] = await Promise.all([
  compiled('access/bootstrap.js'), compiled('access/commands.js'), compiled('intake/index.js'),
  compiled('pdf/index.js'), compiled('supplements/index.js'),
]);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function session(browser, origin, account) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/healthz`);
  let csrf;

  async function request(path, options = {}) {
    const { method = 'GET', data, binary, version, key = randomUUID(), raw = false } = options;
    const result = await page.evaluate(async ({ path, method, data, binary, version, key, csrf, raw }) => {
      const headers = {};
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (version !== undefined) headers['If-Match'] = `"${version}"`;
      if (method !== 'GET') headers['Idempotency-Key'] = key;
      if (data !== undefined) headers['Content-Type'] = 'application/json';
      if (binary) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Part-SHA256'] = binary.sha256;
      }
      const body = binary
        ? Uint8Array.from(atob(binary.base64), (char) => char.charCodeAt(0))
        : data === undefined ? undefined : JSON.stringify(data);
      const response = await fetch(path, { method, headers, body, cache: 'no-store' });
      const out = { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
      if (raw && response.ok) out.bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      else out.body = (await response.text()).trim();
      return out;
    }, { path, method, data, binary, version, key, csrf, raw });
    if (result.body && (result.headers['content-type'] ?? '').includes('application/json')) {
      result.body = JSON.parse(result.body);
    }
    if (result.bytes) result.bytes = Buffer.from(result.bytes);
    return result;
  }

  async function ok(path, options, expected) {
    const result = await request(path, options);
    assert(result.status >= 200 && result.status < 300, `${options?.method ?? 'GET'} ${path} => ${result.status} ${result.body?.code ?? ''}`);
    if (expected !== undefined) assert.equal(result.status, expected, path);
    return result.bytes ?? result.body;
  }

  const login = await ok('/api/sessions', { method: 'POST', data: account }, 200);
  csrf = login.csrfToken;
  assert(csrf, 'expected browser CSRF token');
  return { context, page, request, ok };
}

export async function setup(db, browser, origin) {
  // Bootstrap once per disposable database. Every retry gets a new project.
  const accountPath = process.env.FACADE_E2E_FIXTURE_ACCOUNT;
  let account;
  if (accountPath) {
    try {
      account = JSON.parse(await readFile(accountPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!account) {
    account = { login: `step7-${randomUUID()}`, password: randomUUID() };
    await bootstrapAdmin(db, { organization: 'Step 7 synthetic', ...account });
    if (accountPath) await writeFile(accountPath, JSON.stringify(account), { flag: 'wx', mode: 0o600 });
  }
  const a = await session(browser, origin, account);
  const b = await session(browser, origin, account);
  const addressee = 'Испытательный адресат';
  const rule = (key, part, applicability) => ({
    key, part, applicability: `scope:${applicability}`, formats: ['pdf'], equivalents: [], sourceRoles: ['inventory'],
    completenessCriterion: 'Адресуемый документ', addressee,
  });
  const createCatalog = (items) => a.ok('/api/catalogs', {
    method: 'POST', data: { key: 'step7', name: 'Каталог шага 7', requirements: items },
  }, 201);
  const catalog = await createCatalog([]);
  const project = await a.ok('/api/projects', {
    method: 'POST', data: { name: 'Два фасада', catalogVersionId: catalog.id, scopeName: 'F-A' },
  }, 201);
  const base = `/api/projects/${project.id}`;
  const scopeA = project.scopes[0].id;
  const scopeB = (await a.ok(`${base}/scopes`, { method: 'POST', data: { stage: 'design', name: 'F-B' } }, 201)).id;
  const requirements = [
    rule('attachment', 'узел крепления', scopeA),
    rule('AL-01', 'спецификацию AL-01', scopeA),
    rule('support', 'опорную деталь F-B', scopeB),
  ];
  const scopedCatalog = await createCatalog(requirements);
  const { version } = await a.ok(base);
  await a.ok(`${base}/catalog`, { method: 'PUT', version, data: { catalogVersionId: scopedCatalog.id } });
  return { a, b, base, projectId: project.id, scopeA, scopeB, addressee, createCatalog, requirements };
}

export async function file(name) {
  const bytes = await readFile(new URL(`../fixtures/input/${name}`, import.meta.url));
  return { name, bytes, sha256: sha256(bytes) };
}

export async function newReceipt(tab, base, source = 'upload') {
  return (await tab.ok(`${base}/receipts`, { method: 'POST', data: { source } }, 201)).receiptId;
}

export function declare(tab, receiptId, source, scopeIds) {
  return tab.request(`/api/receipts/${receiptId}/uploads`, {
    method: 'POST',
    data: { relativePath: source.name, size: source.bytes.length, sha256: source.sha256, mediaType: 'application/pdf', scopeIds },
  });
}

export async function completeUpload(tab, receiptId, upload, source) {
  const { uploadId, partSize } = upload;
  assert(partSize > 0);
  for (let offset = 0, partNumber = 1; offset < source.bytes.length; offset += partSize, partNumber += 1) {
    const part = source.bytes.subarray(offset, offset + partSize);
    await tab.ok(`/api/uploads/${uploadId}/parts/${partNumber}`, {
      method: 'PUT', binary: { base64: part.toString('base64'), sha256: sha256(part) },
    });
  }
  const original = await tab.ok(`/api/uploads/${uploadId}/complete`, { method: 'POST', data: {} });
  await tab.ok(`/api/receipts/${receiptId}/seal`, { method: 'POST', data: {} });
  assert.equal(sha256(await tab.ok(`/api/documents/${original.documentId}/versions/${original.versionId}/content`, { raw: true })), source.sha256);
  return original;
}

export async function observations(db, source, scope, needle, value) {
  const pdf = createRuntimePdfService(db, { dataDir: process.env.FACADE_DATA_DIR });
  try {
    const runId = randomUUID();
    const hints = [];
    for (const branch of ['A', 'B']) {
      const read = { branch, runId, operationKey: `open-${branch}` };
      const opened = await pdf.native(source, read, { page: 1 });
      const { lines } = JSON.parse(opened.bytes.toString('utf8'));
      const line = lines.find((entry) => entry.text.includes(needle));
      assert(line, `native PDF line missing: ${needle}`);
      hints.push(await pdf.pin(source, { ...read, operationKey: `pin-${branch}` }, {
        scope, evidenceId: opened.evidence.id, quote: line.text, lineId: line.id,
        value, ...(value === undefined ? { limitation: 'inventory_citation' } : {}),
      }));
    }
    return hints;
  } finally {
    pdf.close();
  }
}

export function review(question, assessment, hints, kind, receiptId) {
  return {
    questionId: question.id, expectedDependencyVersion: question.dependencyVersion,
    review: {
      inputGeneration: String(assessment.inputGeneration),
      findings: hints.map((hint) => ({
        kind, observationId: hint.id, sourceRole: 'inventory', comparisonKey: question.requirement.positionId, applicability: 'active',
      })),
      remaining: [], completenessChecked: true,
      ...(kind === 'absence' ? { inventory: {
        kind: 'exhaustive_inventory', assessmentId: randomUUID(), receiptIds: [receiptId],
        currentCompositionChecked: true, alternativesChecked: true,
      } } : {}),
    },
  };
}

export function applyImpact(db, projectId, cause, impacts) {
  return transaction(db, (tx) => resolveSupplementImpact(tx, {
    projectId, holdId: cause.id, generation: cause.generation, version: cause.version,
    reason: 'Проверено по синтетическому оригиналу', impacts,
  }));
}

async function waitForIntakeQueue(db, blockerPid, expected) {
  const expires = Date.now() + 20_000;
  while (Date.now() < expires) {
    const { rows: [{ total }] } = await db.query(`
      SELECT count(*)::int AS total
      FROM pg_locks AS waiting
      JOIN pg_locks AS held USING (locktype, database, classid, objid, objsubid)
      WHERE held.pid = $1 AND held.locktype = 'advisory' AND held.granted AND NOT waiting.granted
    `, [blockerPid]);
    if (total >= expected) return;
    await setTimeout(25);
  }
  throw new Error(`Expected ${expected} HTTP commands waiting for the shared advisory lock`);
}

export async function queuedRace(db, projectId, first, second) {
  const blocker = await db.connect();
  const pending = [];
  try {
    await blocker.query('BEGIN');
    await lockIntakeProject(blocker, projectId);
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
    pending.push(first());
    pending[0].catch(() => {});
    await waitForIntakeQueue(db, pid, 1);
    pending.push(second());
    pending[1].catch(() => {});
    await waitForIntakeQueue(db, pid, 2);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  return Promise.all(pending);
}
