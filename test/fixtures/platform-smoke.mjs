import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import pg from 'pg'

const root = process.cwd()
const exec = promisify(execFile)
const config = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: process.env.FACADE_PLATFORM_TEST_PORT ?? '18081',
}
assert.match(new URL(config.DATABASE_URL).pathname, /^\/test_step1_[a-f0-9]+$/)
assert.ok(config.FACADE_DATA_DIR)

const snapshot = await mkdtemp(join(tmpdir(), 'facade-step1-'))
const db = new pg.Pool({ connectionString: config.DATABASE_URL })
const children = new Map()
const cli = (file, ...args) => exec(process.execPath, [file, ...args], { cwd: snapshot, env: config })

function start(file) {
  const child = spawn(process.execPath, [file], { cwd: snapshot, env: config, stdio: 'ignore' })
  children.set(child, once(child, 'exit'))
  return child
}

async function stop(child) {
  child.kill('SIGTERM')
  const result = await children.get(child)
  children.delete(child)
  return result
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) return
    await delay(50)
  }
  assert.fail('Stand smoke wait expired')
}

try {
  for (const path of ['apps/api/src/main.ts', 'apps/worker/src/main.ts', 'src/platform',
    'db/migrations/01_platform_schema.sql', 'package.json', 'tsconfig.json']) {
    await mkdir(join(snapshot, path, '..'), { recursive: true })
    await cp(resolve(root, path), join(snapshot, path), { recursive: true })
  }
  await symlink(resolve(root, 'node_modules'), join(snapshot, 'node_modules'))

  const migrations = join(snapshot, 'db/migrations')
  await writeFile(join(migrations, '02-fixture_create.sql'), 'CREATE TABLE smoke_order (value integer);')
  await writeFile(join(migrations, '02_fixture_use.sql'), 'INSERT INTO smoke_order VALUES (1);')
  const broken = join(migrations, '03_fixture_retry.sql')
  await writeFile(broken, 'CREATE TABLE smoke_retry (value integer); SELECT 1/0;')

  // Two clean runners contend for the same migration lock, then both reject the broken migration.
  const migrate = () => cli('dist/src/platform/migrate.js')
  await cli('node_modules/typescript/bin/tsc', '-p', 'tsconfig.json')
  const attempts = await Promise.allSettled([migrate(), migrate()])
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected')
    assert.match(attempt.reason.stderr, /Migration failed: 03_fixture_retry.sql/)
  }

  const { rows: [state] } = await db.query(
    "SELECT count(*)::int AS rows, to_regclass('smoke_retry') IS NULL AS rolled_back FROM smoke_order",
  )
  assert.deepEqual(state, { rows: 1, rolled_back: true })
  await writeFile(broken, 'CREATE TABLE smoke_retry (value integer);')
  assert.match((await migrate()).stdout, /Applied 03_fixture_retry.sql/)
  assert.match((await migrate()).stdout, /Database migrations are current/)
  const completed = join(migrations, '02_fixture_use.sql')
  const before = await readFile(completed)
  await writeFile(completed, 'INSERT INTO smoke_order VALUES (2);')
  await assert.rejects(migrate(), (error) => {
    assert.match(error.stderr, /Applied migration is missing or changed: 02_fixture_use.sql/)
    return true
  })
  await writeFile(completed, before)
  assert.match((await migrate()).stdout, /Database migrations are current/)
  console.log('Migrations: both filenames, name order, concurrency, rollback, retry and checksum verified')

  await mkdir(join(snapshot, 'dist/src/modules/access'), { recursive: true })
  await writeFile(join(snapshot, 'dist/src/modules/access/index.js'), `
    export async function register(app) {
      app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'POST' && !request.headers['x-fixture-token']) {
          return reply.code(403).send({code: 'missing_token'})
        }
      })
    }
  `)
  await mkdir(join(snapshot, 'dist/src/modules/probe'), { recursive: true })
  await writeFile(join(snapshot, 'dist/src/modules/probe/index.js'), `
    import marker from '@facade-fixture/isolated'
    export async function register(app) {
      app.post('/api/probe', async () => {
        const version = await app.db.query("SHOW server_version_num")
        return { version: version.rows[0].server_version_num, marker }
      })
    }
  `)
  const dependency = join(snapshot, 'src/modules/probe/node_modules/@facade-fixture/isolated')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  await writeFile(join(dependency, 'index.js'), "export default 'workspace dependency'\n")
  await cli('src/platform/link-workspaces.mjs')

  await mkdir(join(snapshot, 'web/dist/assets'), { recursive: true })
  await writeFile(join(snapshot, 'web/dist/index.html'), '<title>Smoke Svelte shell</title>')
  await writeFile(join(snapshot, 'web/dist/assets/probe.js'), 'export {};')

  const compiledModules = join(snapshot, 'dist/src/modules')
  await mkdir(join(compiledModules, 'converter-port'))
  await writeFile(join(compiledModules, 'converter-port/index.js'), "throw new Error('Library loaded by API')")
  await mkdir(join(compiledModules, 'invalid-api'))
  await writeFile(join(compiledModules, 'invalid-api/index.js'), 'export const version = 1')
  await assert.rejects(cli('dist/apps/api/src/main.js'), (error) => {
    assert.match(error.stderr, /Module invalid-api must export register\(app\)/)
    return true
  })
  await rm(join(compiledModules, 'invalid-api'), { recursive: true })

  const api = start('dist/apps/api/src/main.js')
  const origin = `http://127.0.0.1:${config.PORT}`
  await waitFor(async () => (await fetch(origin + '/readyz').catch(() => null))?.ok)
  const get = (path, options) => fetch(origin + path, options)
  assert.equal((await get('/healthz')).status, 200)
  assert.match(await (await get('/', { headers: { accept: 'text/html' } })).text(), /Smoke Svelte shell/)
  assert.equal((await get('/assets/probe.js')).status, 200)
  const missing = await get('/api/missing', { headers: { accept: 'text/html' } })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'not_found')

  assert.equal((await get('/api/probe', { method: 'POST' })).status, 403)
  const authorized = await get('/api/probe', {
    method: 'POST', headers: { 'x-fixture-token': 'synthetic' },
  })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.headers.get('cache-control'), 'no-store')
  const info = await authorized.json()
  assert.match(info.version, /^16/)
  assert.equal(info.marker, 'workspace dependency')
  assert.deepEqual(await stop(api), [0, null])
  console.log('API: library exclusion, fail-fast registration, health, DB readiness, scoped route, shared hook, isolated dependency, SPA and static assets verified')

  await assert.rejects(cli('dist/apps/worker/src/main.js'), (error) => {
    assert.match(error.stderr, /Harness module is required/)
    return true
  })
  await mkdir(join(snapshot, 'dist/src/modules/harness'), { recursive: true })
  await writeFile(join(snapshot, 'dist/src/modules/harness/index.js'), `
    import { writeFile } from 'node:fs/promises'
    import { setInterval } from 'node:timers/promises'
    export async function startWorker({db, signal}) {
      await db.query('SELECT 1')
      await writeFile('worker-started', '')
      try {
        for await (const _ of setInterval(1000, null, {signal})) {}
      } catch (error) {
        if (error.name !== 'AbortError') throw error
      }
      await writeFile('worker-stopped', '')
    }
  `)
  const worker = start('dist/apps/worker/src/main.js')
  await waitFor(async () => (await readFile(join(snapshot, 'worker-started')).catch(() => null)) !== null)
  assert.deepEqual(await stop(worker), [0, null])
  await readFile(join(snapshot, 'worker-stopped'))
  console.log('Worker: missing harness fails, configured harness runs and shuts down on SIGTERM')

  assert.ok(config.FACADE_S3_ENDPOINT && config.FACADE_S3_BUCKET)
  const require = createRequire(resolve(root, 'src/modules/intake/package.json'))
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
  const storage = new S3Client({
    endpoint: config.FACADE_S3_ENDPOINT,
    region: config.AWS_REGION ?? 'us-east-1',
    forcePathStyle: true,
  })
  const object = { Bucket: config.FACADE_S3_BUCKET, Key: `step1/${randomUUID()}` }
  const payload = Buffer.from('Synthetic stand probe\n')
  try {
    await storage.send(new PutObjectCommand({ ...object, Body: payload }))
    const { Body } = await storage.send(new GetObjectCommand(object))
    assert.deepEqual(Buffer.from(await Body.transformToByteArray()), payload)
    const anonymous = await fetch(`${config.FACADE_S3_ENDPOINT}/${object.Bucket}/${object.Key}`)
    assert.ok([403, 404].includes(anonymous.status))
    await anonymous.body?.cancel()
  } finally {
    await storage.send(new DeleteObjectCommand(object))
    storage.destroy()
  }
  console.log('S3: authenticated write/read/delete and anonymous download denial verified')
} finally {
  await Promise.allSettled([...children].map(([child]) => stop(child)))
  await db.end()
  await rm(snapshot, { force: true, recursive: true })
}
