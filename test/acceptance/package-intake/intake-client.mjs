import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sha = (data) => createHash('sha256').update(data).digest('hex');

export async function intakeClient(origin, login, password) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(login, /^pkgintake_[a-z0-9_]+$/u);
  const session = {};
  const http = [];
  async function call(method, path, expected, body, options = {}) {
    assert.ok(path.startsWith('/api/') && !path.startsWith('//'));
    const raw = Buffer.isBuffer(body);
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(45_000), redirect: 'error',
      headers: { origin, ...session, 'idempotency-key': randomUUID(), ...options.headers,
        ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined || raw ? body : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : null;
    http.push({ method, path, status: response.status, ...(json?.code && { code: json.code }) });
    assert.ok([expected].flat().includes(response.status), `${method} ${path}: ${response.status} ${json?.code ?? ''}`);
    return { bytes, json, response };
  }
  const { response, json } = await call('POST', '/api/sessions', 200, { login, password });
  session.cookie = response.headers.get('set-cookie').split(';', 1)[0];
  session['x-csrf-token'] = json.csrfToken;
  return { call, http };
}

export async function submitOnce({ call }, projectId, inputDir, mode = 'once') {
  assert.ok(inputDir.split('/').includes('intake-input') && !inputDir.split('/').includes('closed-oracle'));
  const files = await Promise.all((await readdir(inputDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    .map(async (entry) => {
      assert.ok(entry.isFile() && entry.name === basename(entry.name));
      const bytes = await readFile(resolve(inputDir, entry.name));
      return { bytes, item: { itemId: randomUUID(), kind: 'file', relativePath: entry.name, size: bytes.length, sha256: sha(bytes) } };
    }));
  assert.ok(files.length > 0);
  const receiptId = randomUUID();
  const { json: registered } = await call('POST', '/api/projects/' + projectId + '/receipts', 201, {
    mode, receiptId, items: files.map(({ item }) => item),
  });
  assert.equal(registered.receiptId, receiptId);
  const path = '/api/receipts/' + receiptId;
  const read = async () => (await call('GET', path + '/inventory', 200)).json;
  const declared = await read();
  assert.equal(declared.manifest.mode, mode);
  assert.deepEqual(declared.manifest.items.map(({ itemId }) => itemId), files.map(({ item }) => item.itemId));
  for (const { item, bytes } of files) {
    const { json: upload } = await call('POST', path + '/manifest/' + item.itemId + '/upload', 201, {});
    const target = '/api/uploads/' + upload.uploadId;
    for (let offset = 0, part = 1; offset < bytes.length; offset += upload.partSize, part++) {
      const chunk = bytes.subarray(offset, offset + upload.partSize);
      await call('PUT', target + '/parts/' + part, [200, 201, 204], chunk, { headers: { 'x-part-sha256': sha(chunk) } });
    }
    await call('POST', target + '/complete', [200, 201], {});
  }
  const accepted = await read();
  assert.ok(accepted.manifest.items.every(({ status }) => status === 'accepted'));
  assert.equal(accepted.sealed, mode === 'once');
  if (mode === 'open') assert.equal(accepted.inventoryOpen, true);
  let inventory = accepted;
  const deadline = Date.now() + 60_000;
  while (inventory.occurrences.some(({ inventoryPending }) => inventoryPending) && Date.now() < deadline) {
    await delay(400);
    inventory = await read();
  }
  assert.ok(inventory.occurrences.every(({ inventoryPending }) => !inventoryPending), 'archive was still expanding at deadline');
  const documents = [];
  for (const { status, documentId, versionId, occurrenceId, sha256 } of inventory.occurrences) {
    if (status !== 'accepted') continue;
    const { bytes } = await call('GET', `/api/documents/${documentId}/versions/${versionId}/content`, 200);
    assert.equal(sha(bytes), sha256);
    documents.push({ documentId, versionId, occurrenceId, sha256 });
  }
  return { mode: 'candidate', complete: true, receiptId, projectId, documents, accepted, inventory };
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const [origin, login, passwordPath, inputRoot, out, ...cases] = process.argv.slice(2);
  const client = await intakeClient(origin, login, (await readFile(passwordPath, 'utf8')).trim());
  assert.ok(cases.length && new Set(cases).size === cases.length &&
    cases.every((value) => /^(?:closed_[a-z_]+|open_archive|zero_candidates|review_control|review_negative|letter_control)$/u.test(value)));
  try {
    for (const name of cases) {
      const { json: project } = await client.call('POST', '/api/projects', 201,
        { name: 'Local QA ' + randomUUID().slice(0, 8), mode: 'intake' });
      const report = await submitOnce(client, project.id, resolve(inputRoot, name), name === 'open_archive' ? 'open' : 'once');
      await writeFile(resolve(out, name.replaceAll('_', '-') + '.json'), JSON.stringify({ ...report, case: name }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' });
    }
  } finally {
    await writeFile(resolve(out, 'api-upload-trace.json'), JSON.stringify(client.http, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
}
