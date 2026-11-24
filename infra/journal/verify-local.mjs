import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import pg from 'pg';

const bin = process.env.JOURNAL_PG_BIN;
assert.ok(bin, 'Set JOURNAL_PG_BIN to the PostgreSQL bin directory');
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--profile-only'));
process.umask(0o077);
await mkdir('.local', { recursive: true });
const run = await mkdtemp(resolve('.local/w33-'));
const sockets = await mkdtemp('/tmp/faj-');
const journalSocket = join(sockets, 'j');
const localSocket = join(sockets, 'a');
const journalData = join(run, 'journal-data');
const localData = join(run, 'local-data');
const ledgerId = randomUUID();
const password = randomBytes(32).toString('hex');
const adminUser = userInfo().username;

const tcp = createServer();
const port = await new Promise((res, rej) => {
  tcp.once('error', rej);
  tcp.listen(0, '127.0.0.1', () => res(tcp.address().port));
});
await new Promise(res => tcp.close(res));
const journalEnv = {
  ...process.env, JOURNAL_PG_BIN: bin, JOURNAL_PGDATA: journalData, JOURNAL_STATE: run,
  JOURNAL_SOCKET: journalSocket, JOURNAL_LISTEN: '127.0.0.1',
  JOURNAL_CLIENT_CIDR: '127.0.0.1/32', JOURNAL_PORT: String(port),
};
const clientSettings = { host: '127.0.0.1', port, user: 'facade_journal_app', password,
  database: 'facade_journal', connectionTimeoutMillis: 3000 };
const url = new URL(`postgresql://facade_journal_app:${password}@127.0.0.1:${port}/facade_journal`);
url.searchParams.set('sslmode', 'verify-full');
url.searchParams.set('sslrootcert', join(run, 'server.crt'));
const gatewayEnv = { FACADE_GATEWAY_JOURNAL_URL: url.href, FACADE_GATEWAY_LEDGER_ID: ledgerId };
const journalClient = () => new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
const start = (data, log, options = []) =>
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-t', '30', '-l', join(run, log), ...options, 'start']);
const stop = (data, mode) =>
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-t', '30', '-m', mode, 'stop']);
const startJournal = () => start(journalData, 'postgres.log');
const stopJournal = mode => stop(journalData, mode);

async function withClient(client, action) {
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.end();
  }
}

async function probe() {
  return withClient(journalClient(), async db => {
    const { rows: [state] } = await db.query(`
      SELECT ledger_id, ssl, current_setting('server_version') AS version,
        current_setting('synchronous_commit') AS synchronous_commit,
        current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
        current_setting('data_checksums') AS data_checksums,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
        pg_database_size(current_database())::int AS database_bytes,
        (SELECT wal_bytes::text FROM pg_stat_wal) AS wal_bytes
      FROM gateway_external_ledger CROSS JOIN pg_stat_ssl WHERE pid=pg_backend_pid()
    `);
    assert.equal(state.ledger_id, ledgerId);
    assert.equal(state.ssl, true);
    assert.equal(state.superuser, false);
    for (const setting of ['synchronous_commit', 'fsync', 'full_page_writes', 'data_checksums']) {
      assert.equal(state[setting], 'on');
    }
    await assert.rejects(db.query('CREATE TABLE privilege_probe(id int)'), { code: '42501' });
    await assert.rejects(db.query('UPDATE gateway_external_ledger SET ledger_id=ledger_id'), { code: '42501' });
    return state;
  });
}

function cleanup(data) {
  try {
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, 'status'], { stdio: 'ignore' });
  } catch (error) {
    if ([3, 4].includes(error.status)) return;
    throw error;
  }
  stop(data, 'fast');
}

try {
  console.log('Run directory', run);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(run, 'server.key'), '-out', join(run, 'server.crt')], { stdio: 'ignore' });
  await writeFile(join(run, 'app-password'), password);
  await writeFile(join(run, 'ledger-id'), ledgerId + '\n');

  execFileSync('bash', ['infra/journal/init'], { env: journalEnv, stdio: 'inherit' });
  assert.equal((await readFile(join(run, 'initialized'), 'utf8')).trim(), ledgerId);
  assert.throws(() => execFileSync('bash', ['infra/journal/init'], { env: journalEnv, stdio: 'pipe' }),
    /PGDATA or installation marker exists/);
  startJournal();
  const before = await probe();
  const ca = await readFile(join(run, 'server.crt'), 'utf8');
  const unexpected = () => assert.fail('Unexpected PostgreSQL connection');
  await assert.rejects(withClient(new pg.Client({ ...clientSettings, ssl: false }), unexpected), { code: '28000' });
  await assert.rejects(withClient(new pg.Client({ ...clientSettings, ssl: { ca, servername: 'wrong.invalid' } }), unexpected),
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });

  stopJournal('immediate');
  await assert.rejects(withClient(journalClient(), unexpected), { code: 'ECONNREFUSED' });
  const restartedAt = performance.now();
  startJournal();
  const after = await probe();
  console.log(JSON.stringify({ check: 'profile', before, after, restartToTlsQueryMs: Math.round(performance.now() - restartedAt) }));

  if (!process.argv.includes('--profile-only')) {
    await mkdir(localSocket);
    execFileSync(join(bin, 'initdb'), ['-D', localData, '--no-instructions', '--auth-local=peer', '--auth-host=scram-sha-256']);
    start(localData, 'application-postgres.log', ['-o', `-h '' -k '${localSocket}' -p ${port}`]);
    const appConnection = { host: localSocket, port, user: adminUser, connectionTimeoutMillis: 3000 };
    const { verifyGateway } = await import('./verify-gateway.mjs');
    const journalAdminConnection = { ...appConnection, host: journalSocket, database: 'facade_journal' };
    await verifyGateway({ gatewayEnv, appConnection, journalAdminConnection, startJournal, stopJournal });
  }
  console.log('W3.3 LOCAL PASS');
} finally {
  cleanup(localData);
  cleanup(journalData);
  await Promise.all([localData, journalData, sockets, join(run, 'server.key'), join(run, 'app-password')]
    .map(path => rm(path, { recursive: true, force: true })));
}
