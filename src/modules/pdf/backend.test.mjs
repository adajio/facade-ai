import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import pg from 'pg';

const compiled = process.env.FACADE_PDF_TEST_BUILD ?? 'dist';
const load = (module) => import(pathToFileURL(resolve(compiled, module)).href);
const { createPdfAdapter, createRuntimePdfService } = await load('src/modules/pdf/index.js');
const { groundComponents } = await load('src/modules/pdf/components.js');
const { verifiedNativeLineCrops } = await load('src/modules/pdf/native-line.js');
const { createApi } = await load('src/platform/api.js');

function rotatedPdf(rotation, stream = '1 0 0 rg 60 70 20 10 re f\n0 0 0 rg BT /F1 14 Tf 60 70 Td (ROTATE) Tj ET\n',
  right = 320) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${right + 80} 300] /CropBox [40 30 ${right} 250]
       /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f '];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, '0')} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return Buffer.from(pdf + `xref\n0 ${offsets.length}\n${offsets.join('\n')}
trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

function colorAt(png, x, y) {
  // Poppler writes RGB8 PNG. Reconstruct rows up to the requested pixel.
  assert.deepEqual([...png.subarray(24, 26)], [8, 2]);
  const width = png.readUInt32BE(16);
  const chunks = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const bytes = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + bytes));
    }
    offset += 12 + bytes;
  }
  const stride = width * 3;
  const pixels = inflateSync(Buffer.concat(chunks));
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const offset = row * (stride + 1);
    const type = pixels[offset];
    const current = Buffer.alloc(stride);
    for (let k = 0; k < stride; k++) {
      const left = k < 3 ? 0 : current[k - 3];
      const up = previous[k];
      const corner = k < 3 ? 0 : previous[k - 3];
      const estimate = left + up - corner;
      const error = [left, up, corner].map((value) => Math.abs(estimate - value));
      const paeth = [left, up, corner][error.indexOf(Math.min(...error))];
      current[k] = (pixels[offset + k + 1] + [0, left, up, (left + up) >> 1, paeth][type]) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * 3, x * 3 + 3)];
}

test('crop and rotated native coordinates land on the original ink at 0°, 90°, 180°, 270°', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'facade-pdf-rotation-'));
  try {
    const adapter = createPdfAdapter();
    for (const [rotation, x, y] of [[0, 30, 174], [90, 46, 30], [180, 250, 46], [270, 174, 250]]) {
      const path = join(directory, `rotation-${rotation}.pdf`);
      await writeFile(path, rotatedPdf(rotation));
      const [unit] = await adapter.inspect(path);
      assert.equal(unit.locator.rotation, rotation);
      assert.deepEqual([unit.width, unit.height], rotation % 180 ? [220, 280] : [280, 220]);
      const address = { unitId: unit.id };
      const { lines: [line] } = await adapter.read(path, { address, representation: 'native' }, unit);
      assert.equal(line.text, 'ROTATE');
      assert.ok(x > line.box.x && x < line.box.x + line.box.width);
      assert.ok(y > line.box.y && y < line.box.y + line.box.height);
      const { bytes, transform } = await adapter.read(path, {
        address: { ...address, box: { x: x - 3, y: y - 3, width: 6, height: 6 } },
        representation: 'render', dpi: 288,
      }, unit);
      const found = Array.from({ length: 5 }, (_, i) => colorAt(bytes,
        Math.round(x * transform.pixelsPerPoint - transform.pixelOriginX + i - 2),
        Math.round(y * transform.pixelsPerPoint - transform.pixelOriginY)));
      assert.ok(found.some(([red, green, blue]) => red > 210 && green < 30 && blue < 30), `rotation ${rotation}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('two windows prove the whole measured PDF line at each page rotation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'facade-pdf-lines-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = createPdfAdapter();
  const target = 'Drawing | Facade: QF-42 | Guide offset: 44 mm';
  const stream = [
    'BT /F1 12 Tf 60 180 Td (View WEST | Mark: LK-00AB) Tj ET',
    'BT /F1 12 Tf 360 180 Td (View EAST | Mark: LK-00AB) Tj ET',
    'BT /F1 12 Tf 60 120 Td (Facade: QF-43 | Mark: LK-00AB) Tj ET',
    `BT /F1 12 Tf 360 120 Td (${target}) Tj ET`,
  ].join('\n') + '\n';

  for (const rotation of [0, 90, 180, 270]) {
    await t.test(`page rotation ${rotation}°`, async () => {
      const path = join(directory, `rotation-${rotation}.pdf`);
      await writeFile(path, rotatedPdf(rotation, stream, 680));
      const [unit] = await adapter.inspect(path);
      const read = (box, representation = 'native') => adapter.read(path,
        { address: { unitId: unit.id, box }, representation }, unit);
      const page = await read();
      const full = page.lines.find(({ text }) => text === target);
      const foreign = page.lines.find(({ text }) => text === 'Facade: QF-43 | Mark: LK-00AB');
      assert.ok(full && foreign, JSON.stringify(page.lines));
      assert.notEqual(full.id, foreign.id);

      const [axis, length] = rotation % 180 ? ['y', 'height'] : ['x', 'width'];
      const start = full.box[axis];
      const span = full.box[length];
      const padded = { x: full.box.x - 1, y: full.box.y - 1, width: full.box.width + 2, height: full.box.height + 2 };
      const lower = { ...padded, [length]: span * 0.73 + 1 };
      const upper = { ...padded, [axis]: start + span * 0.27, [length]: span * 0.73 + 1 };
      const [prefix, suffix] = rotation < 180 ? [lower, upper] : [upper, lower];
      const [left, right, neighbor] = await Promise.all([read(prefix), read(suffix), read(foreign.box)]);
      const crop = (result, line, evidenceId) => ({ line, evidenceId, frame: result.address.box });
      const first = crop(left, left.lines.find(({ id }) => id === full.id), 'prefix');
      const last = crop(right, right.lines.find(({ id }) => id === full.id), 'suffix');
      assert.ok(first.line.text.includes('Facade: QF-42'));
      assert.ok(last.line.text.includes('44 mm'));
      assert.notEqual(first.line.text, full.text);
      assert.notEqual(last.line.text, full.text);
      const adjacent = crop(neighbor, neighbor.lines.find(({ id }) => id === foreign.id), 'other-view');
      assert.ok(adjacent.line);
      assert.deepEqual(verifiedNativeLineCrops(full, [adjacent, last], 'suffix', '44 mm')?.crops, [last]);
      assert.deepEqual(verifiedNativeLineCrops(full, [last, first], 'suffix', '44 mm')?.crops, [first, last]);

      const reopened = await read(full.box);
      assert.deepEqual(reopened.lines, [full]);
      const image = await read(full.box, 'render');
      assert.deepEqual(image.address, reopened.address);
      assert.equal(image.transform.pixelOriginX, Math.floor(full.box.x * image.transform.pixelsPerPoint));
      assert.equal(image.transform.pixelOriginY, Math.floor(full.box.y * image.transform.pixelsPerPoint));
      assert.ok(Math.max(image.transform.width, image.transform.height) <= 4096);
      assert.ok(image.transform.width * image.transform.height <= 12_000_000);

      const source = { projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(), sha256: hash(await readFile(path)) };
      const receiptId = randomUUID();
      const runId = randomUUID();
      const asEvidence = (id, { address, lines }) => [id, { lines, evidence: {
        id, source, receiptId, runId, readerVersion: 'fixture', branch: 'A', format: 'pdf',
        address, representation: 'native', mediaType: 'application/json',
      } }];
      const value = { role: 'value', literal: '44', quote: '44 mm', lineId: full.id, link: { kind: 'anchor' } };
      const unitPart = { role: 'unit', literal: 'mm', quote: '44 mm', lineId: full.id, link: { kind: 'source_context', to: 0 } };
      const identifier = { role: 'identifier', literal: 'QF-42', quote: 'Facade: QF-42', lineId: full.id,
        link: { kind: 'same_row', to: 0 } };
      const input = [{ ...value, evidenceId: 'suffix' }, { ...unitPart, evidenceId: 'suffix' }, { ...identifier, evidenceId: 'prefix' }];
      const issued = new Map([asEvidence('prefix', left), asEvidence('suffix', right), asEvidence('other-view', neighbor)]);
      const { components } = groundComponents(input, issued, page);
      assert.deepEqual(components.map(({ evidenceId, address }) => [evidenceId, address.box]),
        [['suffix', last.line.box], ['suffix', last.line.box], ['prefix', first.line.box]]);
      // A whole-page read can put the two views side by side in one receipt.
      const pageEvidence = new Map([asEvidence('page', page)]);
      for (const literal of ['QF-43', 'LK-00AB']) {
        const foreignId = { ...identifier, literal, quote: foreign.text, lineId: foreign.id };
        assert.throws(() => groundComponents([...input.slice(0, 2), { ...foreignId, evidenceId: 'other-view' }], issued, page),
          { code: 'reader_component_link_invalid' });
        const samePageInput = [value, unitPart, foreignId].map((component) => ({ ...component, evidenceId: 'page' }));
        assert.throws(() => groundComponents(samePageInput, pageEvidence, page), { code: 'reader_component_link_invalid' });
      }
    });
  }
});

test('a window seam inside inter-word whitespace keeps the complete native PDF line', () => {
  const id = '1.0.4.0';
  const box = (x, width) => ({ x, y: 40, width, height: 10 });
  const full = { id, text: 'Guide offset: 44 mm', box: box(20, 100) };
  const first = { evidenceId: 'prefix', frame: box(19, 67), line: { id, text: 'Guide offset:', box: box(20, 63) } };
  const last = { evidenceId: 'suffix', frame: box(86, 35), line: { id, text: '44 mm', box: box(89, 31) } };
  assert.deepEqual(verifiedNativeLineCrops(full, [first, last], 'suffix', '44 mm')?.crops, [first, last]);
  const gap = { ...last, frame: box(88, 33) };
  assert.deepEqual(verifiedNativeLineCrops(full, [first, gap], 'suffix', '44 mm')?.crops, [gap]);
  const missed = { ...first, line: { ...first.line, text: 'Guide' } };
  assert.deepEqual(verifiedNativeLineCrops(full, [missed, last], 'suffix', '44 mm')?.crops, [last]);
});

const haveStand = Boolean(process.env.DATABASE_URL && process.env.FACADE_DATA_DIR && process.env.FACADE_S3_ENDPOINT);
const id = randomUUID;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const config = {
  databaseUrl: process.env.DATABASE_URL, dataDir: process.env.FACADE_DATA_DIR, host: '127.0.0.1', port: 0,
};
let db;

before(() => { if (haveStand) db = new pg.Pool({ connectionString: config.databaseUrl }); });
after(async () => { await db?.end(); });

async function account(organizationId, projectId, role, scopeId) {
  const userId = id();
  const token = randomBytes(32).toString('base64url');
  const { csrfToken, digest } = await load('src/modules/access/auth.js');
  await db.query(
    `INSERT INTO users(id, organization_id, login, password_hash, state)
     VALUES ($1::uuid, $2, $1::uuid::text, '$argon2id$test-only', 'active')`, [userId, organizationId],
  );
  await db.query('INSERT INTO access_sessions(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'1 hour\')',
    [userId, digest(token)]);
  if (role) {
    await db.query(
      `INSERT INTO project_memberships(organization_id, project_id, user_id, role, scope_id, expires_at, reason)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() + interval '1 hour' END,
         CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'PDF fixture' END)`,
      [organizationId, projectId, userId, role, scopeId ?? null],
    );
  }
  return { userId, cookie: `facade_session=${token}`, 'X-CSRF-Token': csrfToken(token) };
}

async function httpServer() {
  const app = await createApi(config);
  const origin = await app.listen({ host: config.host, port: 0 });
  return {
    close: () => app.close(),
    async call(path, who, method = 'GET', data, extra = {}) {
      const headers = { ...extra };
      if (who) headers.Cookie = who.cookie;
      if (method !== 'GET') {
        headers.Origin = origin;
        headers['X-CSRF-Token'] = who['X-CSRF-Token'];
        headers['Idempotency-Key'] = id();
        headers['Content-Type'] ??= 'application/json';
      }
      const body = Buffer.isBuffer(data) || data === undefined ? data : JSON.stringify(data);
      return fetch(origin + path, { method, headers, body });
    },
  };
}

async function expectStatus(response, status) {
  const body = response.headers.get('Content-Type')?.includes('json') ? await response.json() : undefined;
  assert.equal(response.status, status, body?.code);
  return body;
}

test('intake, A/B pins, restart, access and immutable bytes on the HTTP/PG/S3 stand', { skip: !haveStand }, async () => {
  const organization = id();
  const projectId = id();
  const scope = id();
  const catalog = id();
  await db.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [organization, 'PDF fixture']);
  const outsider = await account(organization);
  await db.query(
    `INSERT INTO catalog_versions(id, organization_id, catalog_key, revision, name, requirements, created_by)
     VALUES ($1, $2, 'pdf-fixture', 1, 'PDF fixture', '[]', $3)`, [catalog, organization, outsider.userId],
  );
  await db.query('INSERT INTO projects(id, organization_id, name, catalog_version_id) VALUES ($1, $2, $3, $4)',
    [projectId, organization, 'PDF fixture', catalog]);
  await db.query('INSERT INTO project_scopes(id, project_id, stage, name) VALUES ($1, $2, $3, $4)',
    [scope, projectId, 'pdf', 'Facade A']);
  const engineer = await account(organization, projectId, 'engineer');
  const scopedViewer = await account(organization, projectId, 'viewer', scope);

  let server = await httpServer();
  let worker = createRuntimePdfService(db, config);
  try {
    const file = await readFile('test/fixtures/input/facade-package.pdf');
    const sha256 = hash(file);
    const { receiptId } = await expectStatus(await server.call(`/api/projects/${projectId}/receipts`, engineer, 'POST', {}), 201);
    const { uploadId } = await expectStatus(await server.call(`/api/receipts/${receiptId}/uploads`, engineer, 'POST', {
      relativePath: 'facade-package.pdf', size: file.length, sha256, mediaType: 'application/pdf', scopeIds: [scope],
    }), 201);
    const part = await server.call(`/api/uploads/${uploadId}/parts/1`, engineer, 'PUT', file, {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(file.length), 'X-Part-SHA256': sha256,
    });
    assert.equal(part.status, 200, `part: ${part.status}`);
    const completed = await server.call(`/api/uploads/${uploadId}/complete`, engineer, 'POST', {});
    assert.ok([200, 201].includes(completed.status), `complete: ${completed.status}`);
    const { documentId, versionId } = await completed.json();
    const source = { projectId, documentId, versionId, sha256 };
    const runId = id();
    const attempt = (branch, operationKey) => ({ runId, branch, operationKey });
    const validMap = await worker.map(source);
    assert.ok(validMap.units.length >= 2);
    await assert.rejects(worker.map({ ...source, sha256: 'f'.repeat(64) }), { code: 'reader_source_mismatch' });
    await assert.rejects(worker.page(source, attempt('B', 'invalid'), 999), { code: 'reader_address_invalid' });
    const visualBox = { x: 30, y: 90, width: 210, height: 26 };
    await assert.rejects(worker.zoom(source, attempt('B', 'invalid'), {
      page: 1, box: { ...visualBox, width: validMap.units[0].width },
    }), { code: 'reader_address_invalid' });
    const a = await worker.zoom(source, attempt('A', 'zoom'), { page: 1, box: visualBox });
    const zoomInput = { page: 1, box: { ...visualBox, y: 132 } };
    const [b, concurrent] = await Promise.all([
      worker.zoom(source, attempt('B', 'zoom'), zoomInput),
      worker.zoom(source, attempt('B', 'zoom'), zoomInput),
    ]);
    assert.deepEqual(b, concurrent);
    assert.notEqual(a.evidence.id, b.evidence.id);
    assert.notEqual(a.evidence.sha256, b.evidence.sha256);
    await assert.rejects(worker.page(source, attempt('B', 'zoom'), 1), { code: 'reader_operation_conflict' });

    const candidate = { evidenceId: a.evidence.id, scope, quote: 'Thickness (mm) 2', value: '2', unit: 'mm' };
    await assert.rejects(worker.pin(source, attempt('B', 'pin'), candidate), { code: 'reader_evidence_scope_mismatch' });
    await assert.rejects(worker.pin(source, attempt('A', 'pin'), { ...candidate, box: zoomInput.box }), { code: 'reader_address_invalid' });
    const aPin = await worker.pin(source, attempt('A', 'pin'), candidate);
    const transaction = await db.connect();
    let bPin;
    try {
      await transaction.query('BEGIN');
      bPin = await worker.pin(source, attempt('B', 'pin'), {
        ...candidate, evidenceId: b.evidence.id, quote: 'Thickness (mm) 3', value: '3',
      }, transaction);
      assert.equal((await worker.listPositions(projectId, runId)).B.length, 0);
      await transaction.query('COMMIT');
    } finally {
      transaction.release();
    }
    assert.equal(aPin.grounding, 'visual');
    assert.deepEqual(await worker.listPositions(projectId, runId), { A: [aPin], B: [bPin] });

    const native = await worker.search(source, attempt('A', 'search'), { page: 1, query: 'attachment detail' });
    const [line] = JSON.parse(native.bytes).lines;
    assert.match(line.text, /not included/);
    const textCandidate = { scope, evidenceId: native.evidence.id, limitation: 'quoted notice without a numeric value' };
    await assert.rejects(worker.pin(source, attempt('A', 'notice'), {
      ...textCandidate, quote: 'invented quotation',
    }), { code: 'reader_quote_mismatch' });
    const nativePin = await worker.pin(source, attempt('A', 'notice'), { ...textCandidate, quote: line.text });
    assert.deepEqual(nativePin.address.box, line.box);
    assert.equal(nativePin.grounding, 'text');

    const rasterText = await worker.native(source, attempt('B', 'scan-native'), { page: 2 });
    assert.deepEqual(JSON.parse(rasterText.bytes).lines, []);
    assert.deepEqual(rasterText.evidence.limitations, ['pdf_native_empty']);
    const scan = await worker.page(source, attempt('B', 'scan-page'), 2);
    assert.equal(scan.evidence.mediaType, 'image/png');
    const ocr = await worker.ocr(source, attempt('B', 'scan-ocr'), { page: 2 });
    assert.ok(JSON.parse(ocr.bytes).lines.length > 0);
    const ocrInput = await worker.content(ocr.evidence, 'ocr-input');
    assert.equal(hash(ocrInput), ocr.evidence.inputImage.sha256);
    await server.close();
    worker.close();
    server = await httpServer();
    worker = createRuntimePdfService(db, config);

    for (const [read, pin] of [[a, aPin], [b, bPin]]) {
      const metaPath = `/api/v1/evidence/${read.evidence.id}`;
      const meta = await expectStatus(await server.call(metaPath, engineer), 200);
      assert.equal(meta.source.sha256, sha256);
      assert.equal(meta.source.relativePath, 'facade-package.pdf');
      assert.deepEqual(meta.transform, read.evidence.transform);
      const content = await server.call(meta.contentUrl, engineer);
      assert.equal(content.status, 200);
      assert.equal(content.headers.get('Cache-Control'), 'no-store');
      assert.equal(hash(Buffer.from(await content.arrayBuffer())), read.evidence.sha256);
      const original = await server.call(meta.originalHref, engineer);
      assert.equal(original.status, 200);
      assert.equal(hash(Buffer.from(await original.arrayBuffer())), sha256);
      await expectStatus(await server.call(metaPath, outsider), 404);
      await expectStatus(await server.call(meta.contentUrl, outsider), 404);
      await expectStatus(await server.call(meta.contentUrl, scopedViewer), 404);
      await expectStatus(await server.call(metaPath), 401);
      assert.deepEqual(JSON.parse(JSON.stringify(pin)), Object.fromEntries(Object.entries(
        await expectStatus(await server.call(`/api/v1/observations/${pin.id}`, engineer), 200),
      ).filter(([key]) => key !== 'evidenceHref')));
    }
    await expectStatus(await server.call(`/api/v1/observations/${aPin.id}`, scopedViewer), 200);
    await expectStatus(await server.call(`/api/v1/observations/${aPin.id}`, outsider), 404);
    const ocrMeta = await expectStatus(await server.call(`/api/v1/evidence/${ocr.evidence.id}`, engineer), 200);
    assert.equal(hash(Buffer.from(await (await server.call(ocrMeta.inputImage.url, engineer)).arrayBuffer())),
      ocr.evidence.inputImage.sha256);
    const map = await expectStatus(await server.call(`/api/v1/documents/${documentId}/versions/${versionId}/reader/units`, engineer), 200);
    assert.deepEqual(map, validMap);
    assert.deepEqual(await worker.zoom(source, attempt('B', 'zoom'), zoomInput), b);
  } finally {
    worker.close();
    await server.close();
  }
});
