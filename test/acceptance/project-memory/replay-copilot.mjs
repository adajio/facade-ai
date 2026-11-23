import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Run inside a product image with --network none. The archive is read-only.
const [protocolPath, archivePath] = process.argv.slice(2);
const { decodeTurn } = await import(pathToFileURL(protocolPath).href);
assert.equal((await stat(archivePath)).mode & 0o077, 0);
const attempts = JSON.parse(await readFile(archivePath, 'utf8'));
assert.equal(attempts.length, 2);
assert.ok(attempts.every(({ request_hash, receipt }) => /^[a-f0-9]{64}$/u.test(request_hash) &&
  receipt.state === 'paid' && receipt.routeVerified === true));

const [search, batch] = attempts.map(({ response }) => decodeTurn(response));
assert.ok(search && batch);
assert.deepEqual(search.actions.map(({ action }) => action.name), ['search_sources']);
assert.equal(batch.actions.length, 3);
const priorInputs = new Set(attempts[1].input_refs);
const originalCalls = attempts[1].response.choices[0].message.tool_calls;
assert.equal(new Set(originalCalls.map(({ id }) => id)).size, originalCalls.length);
assert.ok(isDeepStrictEqual(batch.message.tool_calls,
  originalCalls.map(({ id, type, function: fn }) => ({ id, type, function: fn }))));
assert.ok(isDeepStrictEqual(batch.actions.map(({ callId }) => callId), originalCalls.map(({ id }) => id)));
assert.ok(batch.actions.every(({ action }) => action.name === 'open_source' && priorInputs.has(action.args.sourceId)));
assert.equal(new Set(batch.actions.map(({ action }) => action.args.sourceId)).size, batch.actions.length);

console.log(JSON.stringify({ searchActions: search.actions.length, orderedReadActions: batch.actions.length,
  authorizedByArchivedInput: batch.actions.length, duplicateCalls: 0, answeredQuestion: false, newModelCalls: 0 }));
