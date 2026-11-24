import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { archiveBytes, convertDwg, converterImage, dwgProfile } from '/app/dist/src/modules/converter-port/index.js';
import { readArchiveFrames } from '/app/dist/src/modules/imports/archive.js';

const zip = readFileSync('/run/fixture.zip');
const expanded = 256 * 1024;
async function expand(bytes) {
  const chunks = [];
  const result = [];
  for await (const frame of readArchiveFrames(archiveBytes(zip, { size: zip.length, bytes, entries: 1 }))) {
    if (frame.type === 'data') chunks.push(frame.bytes);
    else result.push(frame);
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(bytes, 0x42));
  return result;
}
const member = { type: 'entry', path: 'fixture.bin', kind: 'file' };
assert.deepEqual(await expand(expanded), [member, { type: 'end', result: 'ok' }, { type: 'done', result: 'ok' }]);
assert.deepEqual(await expand(expanded - 1), [member, { type: 'end', result: 'archive_expanded_limit' },
  { type: 'done', result: 'archive_expanded_limit' }]);
const profile = await dwgProfile();
assert.ok(profile);
const chunks = [];
const recover = (input, result) => convertDwg(Readable.from([Buffer.from(input)]),
  new Writable({ write(chunk, _encoding, done) { if (result) chunks.push(chunk); done(); } }),
  { size: Buffer.byteLength(input), image: profile.id, identity: profile.identity, timeout: profile.timeout });
await assert.rejects(recover('AC1015!', false), { code: 'memory_limit' });
const recovered = await recover('AC1015.', true);
assert.ok(recovered.size > 0);
assert.match(Buffer.concat(chunks).toString(), /0\r?\nEOF\s*$/);
console.log(JSON.stringify({
  archiveImage: await converterImage('archive'), expandedBytes: expanded, overLimitBytes: 1,
  converterFixtureImage: profile.id, oomTranslated: 'memory_limit', subsequentJob: 'ok',
}, null, 2));
