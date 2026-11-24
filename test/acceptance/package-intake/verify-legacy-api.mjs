import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { intakeClient } from './intake-client.mjs';

const [mode, origin, login, snapshotPath, passwordPath] = process.argv.slice(2);
assert.ok(['complete-on-candidate', 'read-after-rollback'].includes(mode));
const initial = JSON.parse(await readFile(snapshotPath, 'utf8'));
assert.equal(initial.projects.length, 1);
assert.equal(initial.receipts.length, 1);
const [[projectId, catalogVersionId]] = initial.projects;
const [[receiptId]] = initial.receipts;
const pending = initial.uploads.filter(([, , , , state]) => state === 'uploading');
assert.equal(pending.length, 1);
const [[uploadId, occurrenceId, expectedBytes, expectedHash]] = pending;
const client = await intakeClient(origin, login, (await readFile(passwordPath, 'utf8')).trim());
const { call } = client;
const project = (await call('GET', '/api/projects/' + projectId, 200)).json;
assert.equal(project.catalogVersionId, catalogVersionId);
assert.deepEqual(project.scopes.map(({ id }) => id).sort(), initial.scopes.map(([id]) => id).sort());
const receiptPath = '/api/receipts/' + receiptId + '/inventory';
const before = (await call('GET', receiptPath, 200)).json;
const uploadPath = '/api/uploads/' + uploadId;
const upload = (await call('GET', uploadPath, 200)).json;
assert.equal(upload.sha256, expectedHash);
assert.equal(upload.confirmedBytes, expectedBytes);
if (mode === 'complete-on-candidate') {
  assert.equal(upload.status, 'uploading');
  assert.equal(before.manifest ?? null, null);
  assert.equal(before.occurrences.find(({ occurrenceId: id }) => id === occurrenceId).status, 'declared');
  await call('POST', uploadPath + '/complete', [200, 201], {});
} else {
  assert.equal(upload.status, 'complete');
}
const inventory = (await call('GET', receiptPath, 200)).json;
assert.deepEqual(inventory.occurrences.map(({ occurrenceId: id }) => id).sort(), initial.occurrences.map(([id]) => id).sort());
const oldVersions = new Set(initial.versions.map(([id]) => id));
assert.ok([...oldVersions].every((id) => inventory.occurrences.some(({ versionId }) => versionId === id)));
const accepted = inventory.occurrences.filter(({ status }) => status === 'accepted');
assert.equal(accepted.length, initial.originals.length + 1);
const completed = accepted.find(({ occurrenceId: id }) => id === occurrenceId);
assert.equal(completed.sha256, expectedHash);
for (const { versionId, documentId, sha256, size } of accepted) {
  const { bytes } = await call('GET', `/api/documents/${documentId}/versions/${versionId}/content`, 200);
  assert.equal(bytes.length, size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
}
console.log(JSON.stringify({ mode, projectId, catalogVersionId, receiptId, uploadId, completed: completed.versionId,
  originalsByteVerified: accepted.length, acknowledgedPartBytes: expectedBytes, calls: client.http }, null, 2));
