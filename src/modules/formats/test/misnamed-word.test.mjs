import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, writeFile, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const root = process.env.FACADE_STEP11_DIST ?? resolve('dist');
const load = (p) => import(pathToFileURL(join(root, 'src/modules', p)));

test('OOXML Word under .doc is read natively without a converter', async () => {
  const { createFormatAdapters } = await load('formats/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'facade-word-'));
  try {
    const word = join(dir, 'word.doc');
    await copyFile(new URL('./fixtures/schedule.docx', import.meta.url), word);
    const adapter = createFormatAdapters().find((item) => item.format === 'doc');
    const units = await adapter.inspect(word);
    const table = units.find((item) => item.locator.table === 1);
    assert.ok(table, JSON.stringify(units));
    const result = await adapter.read(word, { representation:'native', address:{ unitId:table.id, locator:{table:1,row:2,column:3} } }, table);
    assert.equal(result.lines[0].text, '2.40 mm');
    const before = process.env.FACADE_CONVERTER_SOCKET;
    try {
      process.env.FACADE_CONVERTER_SOCKET = join(dir, 'unavailable.sock');
      const unavailable = createFormatAdapters().find((item) => item.format === 'doc');
      assert.ok((await unavailable.inspect(word)).some((item) => item.locator.table === 1));
    } finally {
      if (before === undefined) delete process.env.FACADE_CONVERTER_SOCKET;
      else process.env.FACADE_CONVERTER_SOCKET = before;
    }
    assert.match(await adapter.version(), /^formats-1\.1\.4:doc:/);
    const otherZip = join(dir, 'spreadsheet.doc');
    await copyFile(new URL('./fixtures/schedule.xlsx', import.meta.url), otherZip);
    assert.equal((await adapter.inspect(otherZip))[0].locator.coverage, 'held');
    const invalid = join(dir, 'invalid.doc');
    await writeFile(invalid, Buffer.from('504b0304', 'hex'));
    const invalidUnits = await adapter.inspect(invalid);
    assert.equal(invalidUnits[0].locator.coverage, 'held');
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('byte-verified Word .doc is not expanded, while a real non-Word ZIP remains an archive', async () => {
  const { classifyDocZip } = await load('intake/uploads.js');
  const { archiveFormat, confirmedWordPackageMime } = await load('imports/policy.js');
  const docx = await readFile(new URL('./fixtures/schedule.docx', import.meta.url));
  const xlsx = await readFile(new URL('./fixtures/schedule.xlsx', import.meta.url));
  const classify = (name, bytes) => classifyDocZip(name, 'application/zip', bytes.length,
    () => Readable.from([bytes.subarray(0,7), bytes.subarray(7)]));
  const wordType = await classify('nested/word.doc', docx);
  assert.equal(wordType, confirmedWordPackageMime);
  assert.equal(archiveFormat('nested/word.doc', wordType), null);
  const zipType = await classify('nested/other.doc', xlsx);
  assert.equal(zipType, 'application/zip');
  assert.equal(archiveFormat('nested/other.doc', zipType), 'zip');
  assert.equal(await classify('broken.doc', Buffer.from('504b0304','hex')), 'application/zip');
  assert.equal(archiveFormat('ordinary.zip', 'application/zip'), 'zip');
  assert.equal(archiveFormat('ordinary.zip', confirmedWordPackageMime), 'zip');
  assert.equal(await classifyDocZip('large.doc', 'application/zip', 16 * 1024 * 1024 + 1, () => { throw Error('unexpected read'); }), 'application/zip');
  assert.equal(archiveFormat('large.doc', 'application/zip'), 'zip');
});
