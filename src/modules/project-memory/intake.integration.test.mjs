import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID as id } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const connectionString = process.env.FACADE_MEMORY_TEST_DB;
const dist = process.env.FACADE_MEMORY_TEST_DIST ?? resolve('dist');
const load = (file) => import(pathToFileURL(join(dist, 'src/modules', file)));
const nativeFixture = (name) => readFile(new URL(`../formats/test/fixtures/${name}`, import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function bootWorker(directory, objects, use) {
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const key = path.slice('/memory-fixture/'.length);
      const object = objects.get(key);
      if (request.method === 'PUT') {
        const bytes = Buffer.concat(await Array.fromAsync(request));
        const meta = { sha256: request.headers['x-amz-meta-sha256'], size: bytes.length };
        assert.equal(meta.sha256, sha(bytes));
        objects.set(key, { bytes, meta });
        response.writeHead(200, { etag: '"fixture"' }).end();
      } else if (object) {
        response.writeHead(200, { 'Content-Length': object.meta.size, 'x-amz-meta-sha256': object.meta.sha256 });
        response.end(request.method === 'HEAD' ? undefined : object.bytes);
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [join(dist, 'apps/worker/src/main.js')], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
      DATABASE_URL: connectionString, FACADE_DATA_DIR: directory,
      FACADE_S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`, FACADE_S3_BUCKET: 'memory-fixture',
      AWS_ACCESS_KEY_ID: 'synthetic-local-only', AWS_SECRET_ACCESS_KEY: 'synthetic-local-only', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', FACADE_INTAKE_DISK_GUARD_BYTES: '0',
      FACADE_HARNESS_REPLAY_ONLY: '1',
    },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    for (let attempt = 0; attempt < 35; attempt++) {
      if (child.exitCode !== null) assert.fail(`Worker stopped during boot: ${output}`);
      if (await use()) return output;
      await delay(350);
    }
    assert.fail(`Worker boot did not index accepted originals: ${output}`);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill('SIGTERM');
      try { await exited; }
      finally { clearTimeout(force); }
    }
    server.closeAllConnections();
    server.close();
  }
}

test('accepted and restored originals materialize with isolated reads, progress, dedup and historical versions', {
  skip: !connectionString,
  timeout: 50_000,
}, async (t) => {
  const { indexNextProjectMemory, searchProjectMemory, readProjectMemory } = await load('project-memory/index.js');
  const { createRuntimePdfService } = await load('pdf/index.js');
  const db = new pg.Pool({ connectionString });
  const directory = await mkdtemp(join(tmpdir(), 'facade-memory-fixture-'));
  t.after(async () => { await db.end(); await rm(directory, { recursive: true, force: true }); });

  const objects = new Map();
  const objectWrites = new Map();
  let interruptAt = 2;
  let artifactWrites = 0;
  const storage = {
    diskGuardBytes: 0,
    objects: {
      async head(key) { return objects.get(key)?.meta; },
      async get(key) { return Readable.from([objects.get(key).bytes]); },
      async put(key, meta, input) {
        const bytes = Buffer.concat(await Array.fromAsync(input));
        assert.deepEqual(meta, { sha256: sha(bytes), size: bytes.length });
        objects.set(key, { meta, bytes });
        objectWrites.set(key, (objectWrites.get(key) ?? 0) + 1);
        if (++artifactWrites === interruptAt) throw new Error('Simulate interruption after durable store');
      },
    },
  };
  const reader = createRuntimePdfService(db, { dataDir: directory }, { storage });
  const organizationId = id();
  const userId = id();
  const scopeUser = id();
  const scopeId = id();
  const projectId = id();
  const otherProject = id();
  const project = { projectId };
  const member = (extra) => ({ projectId, scopeId, ...extra });
  const stage = 'РД';
  async function insert(sql, args) {
    const result = await db.query(sql, args);
    return result.rows[0]?.id;
  }
  const { rows: [{ lsn: startLsn }] } = await db.query('SELECT pg_current_wal_lsn() AS lsn');
  await insert('INSERT INTO organizations(id,name) VALUES ($1,$2)', [organizationId, 'Synthetic memory']);
  await insert(`INSERT INTO users(id,organization_id,login,password_hash,state)
    VALUES ($1::uuid,$3,$1::uuid::text,'$argon2id$fixture','active'),
           ($2::uuid,$3,$2::uuid::text,'$argon2id$fixture','active')`, [userId, scopeUser, organizationId]);
  async function account(user) {
    const sessionId = await insert(`INSERT INTO access_sessions(user_id,token_hash,expires_at)
      VALUES ($1,$2,now()+interval '1 hour') RETURNING id`, [user, randomBytes(32)]);
    return { id: user, organizationId, sessionId };
  }
  const session = await account(userId);
  const participant = await account(scopeUser);
  const catalogId = await insert(`INSERT INTO catalog_versions(organization_id,catalog_key,revision,name,requirements,created_by)
    VALUES ($1,'memory-fixture',1,'Memory fixture','[]',$2) RETURNING id`, [organizationId, userId]);
  for (const current of [projectId, otherProject]) {
    await insert('INSERT INTO projects(id,organization_id,name,catalog_version_id) VALUES ($1,$2,$3,$4)',
      [current, organizationId, 'Memory fixture', catalogId]);
    await insert(`INSERT INTO project_memberships(organization_id,project_id,user_id,role)
      VALUES ($1,$2,$3,'engineer')`, [organizationId, current, userId]);
  }
  await insert('INSERT INTO project_scopes(id,project_id,stage,name) VALUES ($1,$2,$3,$4)', [scopeId, projectId, stage, 'Restricted']);
  await insert(`INSERT INTO project_memberships(organization_id,project_id,user_id,role,scope_id,expires_at,reason)
    VALUES ($1,$2,$3,'viewer',$4,now()+interval '1 hour','Synthetic fragment test')`, [organizationId, projectId, scopeUser, scopeId]);

  async function accepted(name, bytes, { current = projectId, replaces, mime = 'text/plain' } = {}) {
    const receipt = await insert(`INSERT INTO intake_receipts(project_id,source,created_by)
      VALUES ($1,'upload',$2) RETURNING id`, [current, userId]);
    const document = replaces?.documentId ?? await insert('INSERT INTO intake_documents(project_id) VALUES ($1) RETURNING id', [current]);
    const digest = sha(bytes);
    const objectKey = `fixture/${current}/${digest}`;
    objects.set(objectKey, { meta: { sha256: digest, size: bytes.length }, bytes });
    await insert(`INSERT INTO intake_originals(id,project_id,object_key,sha256,size)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id,sha256,size) DO NOTHING`, [id(), current, objectKey, digest, bytes.length]);
    const { rows: [{ id: original }] } = await db.query(
      'SELECT id FROM intake_originals WHERE project_id=$1 AND object_key=$2', [current, objectKey]);
    const version = await insert(`INSERT INTO intake_document_versions(project_id,document_id,original_id,media_type,replaces_version_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [current, document, original, mime, replaces?.versionId ?? null]);
    await insert(`INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
      VALUES ($1,$2,$3,$4,$5,'accepted')`, [current, receipt, name, mime, version]);
    await insert(`INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id,dispatched_at)
      VALUES ($1,$2,$3,$4,$5,now())`, [current, receipt, document, version, original]);
    return { projectId: current, versionId: version, documentId: document, sha256: digest, objectKey };
  }
  async function drain() {
    for (let tick = 0; tick < 150; tick++) if (!await indexNextProjectMemory(db, reader)) return;
    assert.fail('Memory work did not settle');
  }
  const find = (query, extra) => searchProjectMemory(db, session, { ...project, query, ...extra });
  const activeScope = () => ({ runId: id(), branch: 'A', operationKey: 'read' });
  const original = Buffer.from(Array.from({ length: 950 }, (_, index) =>
    index === 949 ? 'Лазурное покрытие L7' : `fixture ${index + 1}`).join('\n'));
  const source = await accepted('fixture.txt', original);
  const before = await find('ЛАЗУРНОЕ');
  assert.equal(before.status, 'unknown');
  assert.deepEqual(before.hits, []);

  const started = performance.now();
  await Promise.all(Array.from({ length: 4 }, () => indexNextProjectMemory(db, reader)));
  await drain();
  const paused = await find('лазурное');
  assert.equal(paused.status, 'partial');
  assert.equal(paused.pendingBlocks, 9);
  assert.deepEqual(paused.hits, []);
  const waiting = await readProjectMemory(db, reader, session, { ...project, snapshot: paused.snapshot,
    blockId: paused.remaining[0].blockId });
  assert.equal(waiting.block.status, 'unknown');

  const competing = await accepted('ready.txt', Buffer.from('Second project complete'), { current: otherProject });
  await drain();
  assert.equal((await find('Second', { projectId: competing.projectId })).status, 'ready');
  assert.equal((await find('лазурное')).pendingBlocks, 9);
  // Make the scheduled retry due without coupling the test to wall-clock sleep.
  await db.query('UPDATE project_memory_versions SET retry_at=clock_timestamp() WHERE version_id=$1', [source.versionId]);
  interruptAt = 0;
  await drain();
  const firstIndexMs = performance.now() - started;
  const found = await find('лазурное');
  assert.equal(found.status, 'ready');
  assert.equal(found.hits[0].address.locator.line, 950);
  assert.equal(found.hits[0].text, 'Лазурное покрытие L7');
  assert.equal((await find('лазурное', { snapshot: paused.snapshot })).hits.length, 0);
  assert.equal((await find('лазурное', { snapshot: before.snapshot })).status, 'unknown');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM reader_evidence WHERE project_id=$1', [projectId])).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM reader_observations WHERE project_id=$1', [projectId])).rows[0].count, 0);

  const filtered = await reader.open(source, activeScope(), { address: { unitId: 'lines:901' }, representation: 'native', query: 'лазурное' });
  assert.equal(JSON.parse(filtered.bytes).lines.length, 1);
  const native = await reader.open(source, activeScope(), { address: { unitId: 'lines:901' }, representation: 'native' });
  assert.notEqual(native.evidence.id, filtered.evidence.id);
  assert.equal(JSON.parse(native.bytes).lines.length, 50);
  const sameNative = await reader.open(source, activeScope(), { address: { unitId: 'lines:901' }, representation: 'native' });
  assert.notEqual(sameNative.evidence.id, native.evidence.id);
  assert.equal(sameNative.evidence.sha256, native.evidence.sha256);

  const replacement = await accepted('fixture.txt', Buffer.from('Тёмное покрытие R2'), { replaces: source });
  const duplicate = await accepted('copy.txt', original);
  await drain();
  assert.equal((await find('тёмное')).hits[0].versionId, replacement.versionId);
  assert.deepEqual((await find('лазурное')).hits.map(({ versionId }) => versionId), [duplicate.versionId]);
  const originalObject = objects.get(source.objectKey);
  objects.delete(source.objectKey);
  const historicalAddress = { ...project, snapshot: found.snapshot, blockId: found.hits[0].blockId };
  const historical = await readProjectMemory(db, reader, session, historicalAddress);
  objects.set(source.objectKey, originalObject);
  assert.equal(historical.block.versionId, source.versionId);
  assert.equal(historical.lines.at(-1).text, 'Лазурное покрытие L7');
  const artifactKey = `reader-evidence/${projectId}/${native.evidence.sha256}`;
  const canonical = objects.get(artifactKey);
  const corrupted = Buffer.from(canonical.bytes);
  corrupted[0] ^= 1;
  objects.set(artifactKey, { ...canonical, bytes: corrupted });
  await assert.rejects(readProjectMemory(db, reader, session, historicalAddress), { code: 'reader_artifact_mismatch' });
  objects.set(artifactKey, canonical);
  assert.ok([...objectWrites.values()].every((writes) => writes === 1));

  const lateOld = await accepted('race.txt', Buffer.from('Race fixture obsolete'));
  assert.equal(await indexNextProjectMemory(db, reader), true); // old worker pins the map
  const lateNew = await accepted('race.txt', Buffer.from('Race fixture current'), { replaces: lateOld });
  const startedOld = Promise.withResolvers();
  const releaseOld = Promise.withResolvers();
  const oldWorker = indexNextProjectMemory(db, {
    map: reader.map,
    async materializeNative(...args) {
      assert.equal(args[0].versionId, lateOld.versionId);
      startedOld.resolve();
      await releaseOld.promise;
      return reader.materializeNative(...args);
    },
  });
  try {
    await startedOld.promise;
    assert.equal(await indexNextProjectMemory(db, reader), false);
    const pendingReplacement = await find('Race fixture');
    assert.deepEqual(pendingReplacement.hits, []);
  } finally {
    releaseOld.resolve();
    await oldWorker;
  }
  await drain();
  assert.deepEqual((await find('Race fixture')).hits.map(({ versionId }) => versionId), [lateNew.versionId]);
  assert.deepEqual((await find('Race fixture', { versionIds: [lateOld.versionId] })).hits.map(({ versionId }) => versionId),
    [lateOld.versionId]);

  const xlsx = await accepted('schedule.xlsx', await nativeFixture('schedule.xlsx'), { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const pdf = await accepted('mixed.pdf', await nativeFixture('mixed-raster.pdf'), { mime: 'application/pdf' });
  const mixedStarted = performance.now();
  await drain();
  const mixedIndexMs = performance.now() - mixedStarted;
  const searchStarted = performance.now();
  const thickness = await find('Thickness, mm');
  const searchMs = performance.now() - searchStarted;
  const warmStarted = performance.now();
  for (let i = 0; i < 3; i++) assert.deepEqual((await find('Thickness, mm', { snapshot: thickness.snapshot })).hits, thickness.hits);
  const warmSearchMs = (performance.now() - warmStarted) / 3;
  assert.equal(thickness.status, 'partial');
  assert.ok(thickness.remaining.some((block) => block.versionId === pdf.versionId && block.remaining.includes('graphics')));
  const cell = thickness.hits.find((entry) => entry.versionId === xlsx.versionId);
  assert.equal(cell.address.locator.cell, 'B2');
  const table = await readProjectMemory(db, reader, session, { ...project, snapshot: thickness.snapshot, blockId: cell.blockId });
  assert.ok(table.structure.rows.some(({ lineIds }) => lineIds.includes(cell.lineId) && lineIds.length === 3));
  assert.ok(table.structure.columns.some(({ lineIds }) => lineIds.includes(cell.lineId) && lineIds.length >= 3));

  const published = await insert(`INSERT INTO fragment_publications
    (project_id,scope_id,document_id,original_version_id,original_sha256,reader_version,page,box,quote)
    VALUES ($1,$2,$3,$4,$5,'fixture',1,'{"x":10,"y":10,"height":5,"width":7}','Permitted quote') RETURNING id`,
  [projectId, scopeId, pdf.documentId, pdf.versionId, pdf.sha256]);
  await insert(`INSERT INTO fragment_publication_revisions(publication_id,version,actor_id,reason)
    VALUES ($1,1,$2,'Synthetic'),($1,2,$2,'Synthetic')`, [published, userId]);
  await assert.rejects(searchProjectMemory(db, participant, { ...project, query: 'лазурное' }), { statusCode: 404 });
  const restricted = await searchProjectMemory(db, participant, member({ query: 'Thickness' }));
  assert.deepEqual(restricted.hits, []);
  assert.equal(restricted.boundary, 'publications');
  const publication = await searchProjectMemory(db, participant, member({ query: 'permitted' }));
  assert.equal(publication.hits[0].text, 'Permitted quote');
  await assert.rejects(readProjectMemory(db, reader, participant, member({
    snapshot: thickness.snapshot, blockId: cell.blockId,
  })), { statusCode: 404 });
  await insert(`INSERT INTO fragment_publication_revisions(publication_id,version,actor_id,reason)
    VALUES ($1,3,$2,'Revoked fixture')`, [published, userId]);
  await assert.rejects(readProjectMemory(db, reader, participant, member({
    snapshot: publication.snapshot, blockId: publication.hits[0].blockId,
  })), { statusCode: 404 });
  await db.query('UPDATE access_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [participant.sessionId]);
  await assert.rejects(searchProjectMemory(db, participant, member({ query: 'permitted' })), { statusCode: 401 });

  const { rows: [stats] } = await db.query(`
    SELECT (SELECT count(*) FROM project_memory_blocks) AS blocks,
           (SELECT count(*) FROM project_memory_lines) AS lines,
           pg_total_relation_size('project_memory_blocks')+pg_total_relation_size('project_memory_lines')+
             pg_total_relation_size('project_memory_snapshots')+pg_total_relation_size('project_memory_versions') AS "indexBytes",
           pg_wal_lsn_diff(pg_current_wal_lsn(),$1) AS "walBytes"`, [startLsn]);
  t.diagnostic(JSON.stringify({ ...stats, firstIndexMs: Math.round(firstIndexMs), mixedIndexMs: Math.round(mixedIndexMs),
    searchMs: Math.round(searchMs), warmSearchMs: Math.round(warmSearchMs), nodePeakRssKiB: process.resourceUsage().maxRSS,
    artifactBytes: [...objects].reduce((sum, [key, { meta }]) => sum + (key.startsWith('reader-evidence/') ? meta.size : 0), 0) }));

  if (process.env.FACADE_MEMORY_BOOT_TEST === '1') {
    const boot = await accepted('boot.txt', Buffer.from('Boot proof 173'), { current: otherProject });
    const accompanying = await accepted('boot-partner.txt', Buffer.from('Boot proof 174'));
    const output = await bootWorker(directory, objects, async () => {
      const [a, b] = await Promise.all([
        find('Boot proof 173', { projectId: boot.projectId }), find('Boot proof 174'),
      ]);
      return a.hits.some(({ versionId }) => versionId === boot.versionId) &&
        b.hits.some(({ versionId }) => versionId === accompanying.versionId);
    });
    t.diagnostic(`Ordinary worker boot indexed two projects. ${output.trim()}`);
  }
});
