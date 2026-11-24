import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const state = process.env.JOURNAL_STATE;
const [identity, secret] = await Promise.all([
  readFile(join(state, 'ledger-id'), 'utf8'),
  readFile(join(state, 'app-password'), 'utf8'),
]);
const ledgerId = identity.trim();
const password = secret.trim();
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ledgerId) || !/^[0-9a-f]{64}$/.test(password)) {
  throw new Error('Supply the pinned ledger UUID and a random 32-byte hex password');
}
if (process.argv[2] !== 'validate') {
  const connection = {
    host: process.env.JOURNAL_SOCKET,
    port: Number(process.env.JOURNAL_PORT),
    user: process.env.JOURNAL_ADMIN,
    connectionTimeoutMillis: 5000,
  };
  const admin = new pg.Client({ ...connection, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE facade_journal');
  } finally {
    await admin.end();
  }

  const db = new pg.Client({ ...connection, database: 'facade_journal' });
  const ddl = await readFile(new URL('../../src/modules/gateway/journal.sql', import.meta.url), 'utf8');
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL log_min_error_statement = 'panic'");
    await db.query(`CREATE ROLE facade_journal_app LOGIN PASSWORD '${password}'`);
    await db.query('REVOKE ALL ON DATABASE facade_journal FROM PUBLIC; GRANT CONNECT ON DATABASE facade_journal TO facade_journal_app');
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO facade_journal_app');
    await db.query(ddl);
    await db.query('INSERT INTO gateway_external_ledger(ledger_id) VALUES ($1)', [ledgerId]);
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO facade_journal_app');
    await db.query('GRANT UPDATE (frozen) ON gateway_external_ledger TO facade_journal_app');
    await db.query('GRANT INSERT, UPDATE ON gateway_external_attempts, gateway_external_reconciliation TO facade_journal_app');
    await db.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO facade_journal_app');
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}
