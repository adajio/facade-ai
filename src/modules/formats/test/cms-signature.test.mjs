import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const load = (path) => import(new URL(`../../../../dist/src/modules/${path}`, import.meta.url));
const { createFormatAdapters, resolveFormat } = await load('formats/index.js');
const { inspectSignature } = await load('formats/cms-signature.js');
const { buildMap } = await load('harness/dispatch.js');
const { structureFromLines } = await load('harness/package-walk.js');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function ber(tag, ...children) {
  return Buffer.concat([Buffer.from([tag, 0x80]), ...children, Buffer.from([0, 0])]);
}

function der(tag, ...children) {
  const body = Buffer.concat(children);
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x83, body.length >>> 16, body.length >>> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function signed(pdf, chunked = false) {
  const packet = chunked ? ber : der;
  const version = der(2, Buffer.from([1]));
  const type = (last) => der(6, Buffer.from(`2a864886f70d0107${last}`, 'hex'));
  const octets = (value) => der(4, value);
  const content = pdf && (chunked ? ber(0x24, octets(pdf.subarray(0, 41)), octets(pdf.subarray(41))) : octets(pdf));
  // The synthetic signer has no real credentials. Only CMS packaging is under test.
  const signers = der(0x31, der(0x30, version));
  const encap = packet(0x30, type('01'), ...(content ? [packet(0xa0, content)] : []));
  return packet(0x30, type('02'), packet(0xa0, packet(0x30, version, der(0x31), encap, signers)));
}

test('CMS inspection preserves DER and chunked BER eContent exactly and recognizes detached data', () => {
  const pdf = Buffer.from('%PDF-1.7\n' + 'synthetic bytes\n'.repeat(30) + '%%EOF\n');
  for (const chunked of [false, true]) {
    assert.deepEqual(inspectSignature(signed(pdf, chunked)), { kind: 'embedded_pdf', pdf, sha256: sha256(pdf) });
    assert.deepEqual(inspectSignature(signed(undefined, chunked)), { kind: 'detached' });
  }
  assert.throws(() => inspectSignature(Buffer.from('plain .sig text')), { code: 'signature_format_unsupported' });
  assert.throws(() => inspectSignature(signed(Buffer.from('not a pdf'))), { code: 'signature_payload_unsupported' });
  assert.throws(() => inspectSignature(Buffer.concat([signed(pdf, true), Buffer.from([0xff])])), { code: 'signature_invalid' });
  assert.throws(() => inspectSignature(signed(pdf, true).subarray(0, -3)), { code: 'signature_invalid' });
});

test('one signature containing the only PDF remains readable, addressed and rendered through the normal PDF adapter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'facade-test-signature-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pdf = await readFile('test/fixtures/input/facade-package.pdf');
  const bytes = signed(pdf, true), path = join(directory, 'original.pdf.sig');
  await writeFile(path, bytes);
  const adapters = createFormatAdapters();
  const adapter = adapters.find(({ format }) => format === resolveFormat(path));
  const readerVersion = await adapter.version();
  assert.match(readerVersion, /^cms-signature-v1:/);
  const source = { projectId: randomUUID(), versionId: randomUUID(), documentId: randomUUID(), sha256: sha256(bytes) };
  const units = await adapter.inspect(path, source);
  assert.ok(units.length >= 2);
  assert.equal(units[0].locator.embeddedSha256, sha256(pdf));
  const mapped = await buildMap({ ...source, format: 'sig' }, async () => ({ source, readerVersion, format: 'sig', units }));
  assert.match(mapped.physical.basisId, /^inventory-v1:/);
  assert.deepEqual([...new Set(mapped.units.map(({ page }) => page))], units.map(({ locator }) => locator.page));
  const address = { unitId: '1' };
  const native = await adapter.read(path, { address, representation: 'native' }, units[0]);
  assert.ok(native.lines.some(({ text }) => text.includes('not included')));
  const view = await adapter.read(path, { address, representation: 'render' }, units[0]);
  assert.equal(view.mediaType, 'image/png');
  assert.equal(view.address.locator.embeddedSha256, sha256(pdf));
  const frame = { x: 0, y: 0, width: units[0].width, height: units[0].height };
  assert.ok(structureFromLines('sig', native.lines, [], frame).blocks.some(({ kind }) => kind === 'visual'));
  await assert.rejects(adapter.read(path, { address, representation: 'render' },
    { ...units[0], locator: { ...units[0].locator, embeddedSha256: 'a'.repeat(64) } }), { code: 'signature_payload_mismatch' });
});
