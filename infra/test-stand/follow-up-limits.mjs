import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archiveBytes, convertBytes, converterImage } from '/app/dist/src/modules/converter-port/index.js';
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
const image = await converterImage('dwg');
await assert.rejects(convertBytes('dwg', Buffer.from('AC1015!'), { image }), { code: 'memory_limit' });
const recovered = await convertBytes('dwg', Buffer.from('AC1015.'), { image });
assert.equal(recovered.bytes.toString(), 'fixture recovered\n');
console.log(JSON.stringify({
  archiveImage: await converterImage('archive'), expandedBytes: expanded, overLimitBytes: 1,
  converterFixtureImage: image, memoryLimitMiB: 512, oomTranslated: 'memory_limit', subsequentJob: 'ok',
}, null, 2));
