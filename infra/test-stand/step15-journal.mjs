import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const root = process.argv[2];
const journal = 'facade_step15';
const port = 15435;
const identityFile = join(root, 'identity.json');
const envFile = join(root, 'journal.env');
async function optionalFile(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const pinnedEnv = await optionalFile(envFile);
let identity = await optionalFile(identityFile);
if (!identity) {
  if (pinnedEnv) throw new Error('Recover the original journal identity');
  identity = JSON.stringify({ id: randomUUID(), password: randomBytes(32).toString('hex') });
  await writeFile(identityFile, identity, { mode: 0o600, flag: 'wx' });
}
const { id, password } = JSON.parse(identity);
if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(password)) throw new Error('Invalid local journal identity');

const config = { host: join(root, 'socket'), port, user: 'postgres' };
const administrator = new pg.Client({ ...config, database: 'postgres' });
await administrator.connect();
try {
  if (!(await administrator.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [journal])).rowCount) {
    if (pinnedEnv) throw new Error('Recover the original journal role');
    await administrator.query(`CREATE ROLE ${journal} LOGIN PASSWORD '${password}' CONNECTION LIMIT 12`);
  }
  if (!(await administrator.query('SELECT 1 FROM pg_database WHERE datname=$1', [journal])).rowCount) {
    if (pinnedEnv) throw new Error('Recover the original journal database');
    await administrator.query(`CREATE DATABASE ${journal}`);
  }
  await administrator.query(`REVOKE ALL ON DATABASE ${journal} FROM PUBLIC; GRANT CONNECT ON DATABASE ${journal} TO ${journal}`);
} finally {
  await administrator.end();
}

const db = new pg.Client({ ...config, database: journal });
await db.connect();
try {
  await db.query('BEGIN');
  if (!(await db.query("SELECT to_regclass('public.gateway_external_ledger') AS name")).rows[0].name) {
    if (pinnedEnv) throw new Error('Recover the original journal tables');
    await db.query(await readFile(new URL('../../src/modules/gateway/journal.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO gateway_external_ledger (ledger_id) VALUES ($1)', [id]);
  }
  const ledger = await db.query('SELECT ledger_id FROM gateway_external_ledger');
  if (ledger.rowCount !== 1 || ledger.rows[0].ledger_id !== id) throw new Error('Pinned journal identity differs');
  await db.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${journal};
    GRANT SELECT, UPDATE ON gateway_external_ledger TO ${journal};
    GRANT SELECT, INSERT, UPDATE ON gateway_external_attempts, gateway_external_reconciliation TO ${journal};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${journal}`);
  await db.query('COMMIT');
} finally {
  await db.end();
}

const url = `postgresql://${journal}:${password}@step15-journal:${port}/${journal}?sslmode=verify-full&sslrootcert=/run/facade/journal-ca.pem`;
const env = `FACADE_GATEWAY_JOURNAL_URL=${url}\nFACADE_GATEWAY_LEDGER_ID=${id}\n`;
try {
  await writeFile(envFile, env, { mode: 0o600, flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST' || pinnedEnv !== env) throw error;
}
