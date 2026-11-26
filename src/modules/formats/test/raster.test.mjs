import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import sharp from 'sharp';
import { makeRequest, readSnapshot } from '../../../../infra/local-terra/producer.mjs';

const fromBuild = (path) => import(new URL(`../../../../dist/src/modules/${path}`, import.meta.url));
const { createFormatAdapters } = await fromBuild('formats/index.js');
const { verifyPhysicalInventory } = await fromBuild('formats/physical-inventory.js');
const { buildMap } = await fromBuild('harness/dispatch.js');
const raster = createFormatAdapters().find(({ format }) => format === 'image');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function scan() {
  const body = '<svg xmlns="http://www.w3.org/2000/svg" width="880" height="420">' +
    '<rect width="880" height="420" fill="white"/><rect x="20" y="30" width="100" height="90" fill="red"/>' +
    '<text x="160" y="140" font-size="64" font-family="sans-serif">ФАСАД СЕВЕР</text>' +
    '<text x="160" y="245" font-size="64" font-family="sans-serif">FACADE 42 MM</text></svg>';
  return sharp(Buffer.from(body)).jpeg({ quality: 94 });
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'facade-raster-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function firstPixel(bytes) {
  const pixels = await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  return [...pixels];
}

test('raster preserves EXIF-oriented crop, verifies every TIFF page, and rejects false signatures and corrupt pixels', async (t) => {
  const directory = await temporary(t);
  const rotated = join(directory, 'turned.jpg');
  await scan().withMetadata({ orientation: 6 }).toFile(rotated);
  const [jpg] = await raster.inspect(rotated);
  assert.deepEqual([jpg.width, jpg.height], [420, 880]);
  const box = { x: 320, y: 40, width: 30, height: 30 };
  const zoom = await raster.read(rotated, { address: { unitId: jpg.id, box }, representation: 'render' }, jpg);
  assert.deepEqual(zoom.transform, { width: 30, height: 30, pixelsPerPoint: 1, pixelOriginX: 320, pixelOriginY: 40 });
  const [red, green, blue] = await firstPixel(zoom.bytes);
  assert.ok(red > 220 && green < 30 && blue < 30, `${red},${green},${blue}`);
  await assert.rejects(raster.read(rotated, { address: { unitId: jpg.id, box: { ...box, x: 419 } }, representation: 'render' }, jpg),
    { code: 'reader_address_invalid' });

  const tiff = join(directory, 'multiple.tiff');
  const pageBytes = 60 * 40 * 3;
  const pages = Buffer.concat([Buffer.alloc(pageBytes, 15), Buffer.alloc(pageBytes, 245)]);
  const tiffBytes = await sharp(pages, { raw: { width: 60, height: 80, channels: 3, pageHeight: 40 } })
    .tiff({ compression: 'none' }).toBuffer();
  await writeFile(tiff, tiffBytes);
  const source = { projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(), sha256: hash(tiffBytes) };
  const units = await raster.inspect(tiff, source);
  assert.deepEqual(units.map(({ id, width, height, locator }) => [id, width, height, locator.page]),
    [['1', 60, 40, 1], ['2', 60, 40, 2]]);
  const map = { source, format: 'image', readerVersion: await raster.version(), units };
  assert.match(verifyPhysicalInventory(map).basisId, /^inventory-v1:/);
  assert.equal(verifyPhysicalInventory({ ...map, units: units.slice(0, 1) }).limitation, 'physical_inventory_map_mismatch');
  for (const [page, gray] of [[1, 15], [2, 245]]) {
    const view = await raster.read(tiff, { address: { unitId: String(page) }, representation: 'render' }, units[page - 1]);
    assert.deepEqual(await firstPixel(view.bytes), [gray, gray, gray]);
  }
  const bad = join(directory, 'broken.jpg');
  await writeFile(bad, tiffBytes.subarray(0, -100));
  await assert.rejects(raster.inspect(bad), { code: 'raster_invalid_or_unreadable' });
  await writeFile(bad, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  await assert.rejects(raster.inspect(bad), { code: 'raster_signature_unsupported' });
  await writeFile(bad, (await scan().toBuffer()).subarray(0, -3000));
  await assert.rejects(raster.inspect(bad), { code: 'raster_invalid_or_unreadable' });

  const large = join(directory, 'large.png');
  const wide = await sharp({ create: { width: 2201, height: 900, channels: 3, background: 'white' } }).png().toBuffer();
  await writeFile(large, wide);
  const wideSource = { ...source, versionId: randomUUID(), sha256: hash(wide) };
  const wideMap = { ...map, source: wideSource, units: await raster.inspect(large, wideSource) };
  const mapped = await buildMap({ ...wideSource, format: 'image' }, async () => wideMap);
  assert.deepEqual(mapped.units.map(({ box }) => box), [
    { x: 0, y: 0, width: 1149, height: 900 }, { x: 1052, y: 0, width: 1149, height: 900 },
  ]);
});

test('a picture with no text remains visually available while native output records an empty OCR result', async (t) => {
  if ((await raster.version()).includes('ocr=unavailable')) return t.skip('Requires Tesseract rus+eng');
  const path = join(await temporary(t), 'photo.png');
  await sharp({ create: { width: 100, height: 70, channels: 3, background: '#829db5' } }).png().toFile(path);
  const [unit] = await raster.inspect(path);
  const address = { unitId: '1' };
  const view = await raster.read(path, { address, representation: 'render' }, unit);
  assert.deepEqual(await firstPixel(view.bytes), [130, 157, 181]);
  const text = await raster.read(path, { address, representation: 'native' }, unit);
  assert.deepEqual(text.lines, []);
  assert.deepEqual(text.limitations, ['raster_ocr_empty']);
});

const runtime = process.env.FACADE_RASTER_TEST_DB;
test('a prior failed JPG is rebuilt through preparation, serves PNG/OCR in harness, and reaches the preliminary request', { skip: !runtime }, async (t) => {
  assert.match(new URL(runtime).pathname, /^\/test_facade_raster_[a-z0-9_]+$/);
  const db = new pg.Pool({ connectionString: runtime });
  t.after(() => db.end());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n, 0);
  assert.doesNotMatch(await raster.version(), /ocr=unavailable/);
  const { createRuntimePdfService, register } = await fromBuild('pdf/index.js');
  const { WorkQueue } = await fromBuild('gateway/queue.js');
  const { activatePackageProjects, dispatchPackagePair, preparePackageMap } = await fromBuild('harness/package-dispatch.js');
  const { scanPackageStructure } = await fromBuild('harness/package-walk.js');
  const { connectReader } = await fromBuild('harness/reader.js');
  const { indexNextProjectMemory } = await fromBuild('project-memory/consumer.js');
  const { digest } = await fromBuild('access/auth.js');
  const bytes = await scan().toBuffer();
  const sha256 = hash(bytes);
  const token = randomBytes(32).toString('base64url');
  const { rows: [source] } = await db.query(`WITH org AS (INSERT INTO organizations(name) VALUES('Synthetic raster') RETURNING id),
    actor AS (INSERT INTO users(organization_id,login,password_hash,state)
      SELECT id,'raster-actor','$argon2id$test-only','active' FROM org RETURNING id,organization_id),
    catalog AS (INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by)
      SELECT organization_id,'raster',1,'Synthetic catalogue','[{"key":"test","part":"Facade"}]',id FROM actor RETURNING id,organization_id),
    project AS (INSERT INTO projects(organization_id,name,intake_mode,project_stage,catalog_version_id)
      SELECT organization_id,'Fixture',true,'Стадия 1',id FROM catalog RETURNING id,organization_id),
    member AS (INSERT INTO project_memberships(organization_id,project_id,user_id,role)
      SELECT project.organization_id,project.id,actor.id,'engineer' FROM project,actor),
    session AS (INSERT INTO access_sessions(user_id,token_hash,expires_at)
      SELECT id,$3,now()+interval '1 hour' FROM actor),
    receipt AS (INSERT INTO intake_receipts(project_id,source,created_by,sealed_at)
      SELECT project.id,'upload',actor.id,now() FROM project,actor RETURNING id,project_id),
    original AS (INSERT INTO intake_originals(id,project_id,object_key,size,sha256)
      SELECT gen_random_uuid(),id,'fixture.jpg',$1,$2 FROM project RETURNING id,project_id,sha256),
    document AS (INSERT INTO intake_documents(project_id) SELECT id FROM project RETURNING id,project_id),
    version AS (INSERT INTO intake_document_versions(project_id,document_id,original_id,media_type)
      SELECT document.project_id,document.id,original.id,'image/jpeg' FROM document,original RETURNING *),
    occurrence AS (INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
      SELECT receipt.project_id,receipt.id,'fixture.JPG','image/jpeg',version.id,'accepted' FROM receipt,version RETURNING id),
    job AS (INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id)
      SELECT receipt.project_id,receipt.id,version.document_id,version.id,version.original_id FROM receipt,version,occurrence RETURNING *)
    SELECT project_id AS "projectId",receipt_id AS "receiptId",document_id AS "documentId",version_id AS "versionId",$2::text AS sha256 FROM job`,
  [bytes.length, sha256, digest(token)]);
  const queue = new WorkQueue(db);
  await activatePackageProjects(db, queue, [source.projectId]);
  const legacy = 'formats-1.1.3:image';
  await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
    VALUES($1,$2,$3,$4,$5,$6,'image','[{"id":"original","locator":{"coverage":"original_only","limitations":"image_reader_unsupported"}}]')`,
  [source.projectId, source.documentId, source.versionId, legacy, source.receiptId, source.sha256]);
  await db.query(`INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format,physical_limitation)
    VALUES($1,$2,$3,$4,$4,'image','image_reader_unsupported')`, [source.projectId, source.versionId, hash(legacy), legacy]);
  const directory = await temporary(t);
  const stored = new Map([['fixture.jpg', bytes]]);
  let originalOpens = 0;
  const storage = { diskGuardBytes: 0, objects: {
    async get(key) {
      const data = stored.get(key);
      assert.ok(data, key);
      if (key === 'fixture.jpg') originalOpens++;
      return Readable.from([data]);
    },
    async head(key) {
      const data = stored.get(key);
      return data && { size: data.length, sha256: hash(data) };
    },
    async put(key, identity, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      assert.deepEqual({ size: data.length, sha256: hash(data) }, identity);
      stored.set(key, data);
    },
  } };
  const reader = createRuntimePdfService(db, { dataDir: directory }, { storage });
  const legacyReader = createRuntimePdfService(db, { dataDir: directory }, { storage, adapters: [{
    format: 'image', version: async () => legacy,
    async inspect() { throw new Error('The legacy map has already been recorded'); },
    async read(_path, { address }) {
      const output = { address, lines: [], limitations: ['image_reader_unsupported'] };
      return { ...output, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(output)) };
    },
  }] });
  assert.equal(await indexNextProjectMemory(db, legacyReader), true);
  assert.equal(await indexNextProjectMemory(db, legacyReader), true);
  const profile = Object.fromEntries(['A', 'B'].map((branch) => [branch, { routeId: 'raster-' + branch, model: 'fixture',
    dataClass: 'synthetic', maxTurns: 8, maxTokens: 256, maxKnownRejections: 1 }]));
  for (const branch of ['A', 'B']) {
    await db.query(`INSERT INTO gateway_routes(id,revision,transport,enabled,max_request_bytes,ceiling_usd_nanos,timeout_ms,min_interval_ms)
      VALUES($1,'r1','managed',true,65536,1,3000,0)`, [profile[branch].routeId]);
    await db.query(`INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
      VALUES($1,$2,'synthetic',$3,'r1',true)`, [source.projectId, profile[branch].routeId, branch === 'A' ? 'primary_a' : 'primary_b']);
  }
  assert.equal(await preparePackageMap(db, queue, reader, []), true);
  assert.equal(await preparePackageMap(db, queue, reader, []), false);
  const { rows: [map] } = await db.query(`SELECT reader_version,physical_proof FROM harness_package_maps WHERE version_id=$1 AND active`, [source.versionId]);
  assert.match(map.reader_version, /^raster-v1:/);
  assert.equal(map.physical_proof, true);
  assert.equal(await indexNextProjectMemory(db, reader), true);
  assert.equal(await indexNextProjectMemory(db, reader), true);
  assert.equal(await indexNextProjectMemory(db, reader), false);
  const snapshot = await readSnapshot(db, source.receiptId);
  const text = snapshot.lines.map(({ text }) => text).join('\n');
  assert.match(text, /ФАСАД СЕВЕР/u);
  assert.match(text, /FACADE 42/u);
  assert.match(makeRequest(snapshot).messages[1].content, /ФАСАД СЕВЕР/u);
  assert.ok(snapshot.unread.some(({ remaining }) => remaining?.includes('graphics')));

  // The first dispatch reconciles the package's A/B profile, the second admits its window.
  assert.equal(await dispatchPackagePair(db, queue, profile, true, reader), true);
  assert.equal(await dispatchPackagePair(db, queue, profile, true, reader), true);
  assert.equal(await scanPackageStructure(db, reader), true);
  const { rows: [job] } = await db.query(`SELECT id AS "jobId",generation_id AS "generationId",payload AS job FROM gateway_jobs
    WHERE project_id=$1 AND purpose='primary_a'`, [source.projectId]);
  const harness = connectReader(db, reader, async () => { throw new Error('No model or publication needed in this check'); });
  const task = { ...job, projectId: source.projectId, scopeId: null };
  const read = (effectKey, request) => harness.read({ task, branch: 'A', effectKey }, request);
  const overview = await read('raster-survey', { kind: 'survey' });
  assert.equal(overview.mediaType, 'image/png');
  assert.equal(overview.transform.width, 880);
  const cropped = await read('raster-zoom', { kind: 'zoom', box: { x: 40, y: 50, width: 40, height: 40 } });
  const [red, green, blue] = await firstPixel(cropped.bytes);
  assert.ok(red > 220 && green < 30 && blue < 30);
  const ocr = await read('raster-ocr', { kind: 'ocr' });
  assert.match(JSON.parse(ocr.bytes).lines.find(({ text }) => text.includes('ФАСАД')).text, /СЕВЕР/u);
  const evidence = await reader.findEvidence(source.projectId, ocr.evidenceId);
  assert.equal(hash(await reader.content(evidence, 'ocr-input')), evidence.inputImage.sha256);

  const app = Fastify();
  app.decorate('db', db);
  app.decorate('config', { dataDir: directory });
  await app.register(register, { storage });
  t.after(() => app.close());
  const url = `/api/v1/documents/${source.documentId}/versions/${source.versionId}/reader/pages/1`;
  assert.ok([401, 403, 404].includes((await app.inject(url)).statusCode));
  const reply = await app.inject({ url, headers: { cookie: 'facade_session=' + token } });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.headers['content-type'], 'image/png');
  assert.equal(reply.headers.etag, `"sha256-${sha256}"`);
  assert.deepEqual(reply.rawPayload, overview.bytes);
  assert.ok(originalOpens >= 5);
});
