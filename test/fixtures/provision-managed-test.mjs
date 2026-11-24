import pg from 'pg';

const [appName, journalName, runId] = process.argv.slice(2);
if (!/^test_[a-z0-9_]+$/.test(appName ?? '') || !/^(?:test|journal)_[a-z0-9_]+$/.test(journalName ?? '') ||
    appName === journalName || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId ?? '')) {
  throw new Error('Supply independently confirmed app database name, journal database name and test run UUID');
}

const targets = [
  { kind: 'app', name: appName, url: process.env.DATABASE_URL },
  { kind: 'journal', name: journalName, url: process.env.FACADE_GATEWAY_JOURNAL_URL },
];
for (const { name, url } of targets) {
  if (!url || decodeURIComponent(new URL(url).pathname) !== '/' + name) {
    throw new Error('Configured database URL differs from the confirmed test database name');
  }
}
const connections = [];
try {
  for (const { kind, name, url } of targets) {
    const db = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    connections.push({ db, kind });
    await db.connect();
    await db.query('BEGIN');
    const { rows: [target] } = await db.query('SELECT current_database() AS name');
    if (target.name !== name) throw new Error('Connected database differs from the confirmed test database');
    const { rows: [boundary] } = await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('facade/model-runtime',0)) AS locked");
    if (!boundary.locked) throw new Error('Stop the runtime on the confirmed test database before provisioning it');
    const { rows: [{ marked }] } = await db.query("SELECT to_regclass('public.facade_managed_test_seal') IS NOT NULL AS marked");
    if (marked) {
      const { rows } = await db.query(`SELECT to_jsonb(seal)->>'run_id' AS "runId", to_jsonb(seal)->>'kind' AS kind
        FROM public.facade_managed_test_seal seal LIMIT 2`);
      if (rows.length !== 1 || rows[0].runId !== runId || rows[0].kind !== kind) {
        throw new Error('An existing managed test marker belongs to another run');
      }
    }
  }
  for (const { db, kind } of connections) {
    await db.query(`CREATE TABLE IF NOT EXISTS public.facade_managed_test_seal (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), run_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('app','journal')), created_at timestamptz NOT NULL DEFAULT now())`);
    await db.query('INSERT INTO public.facade_managed_test_seal(run_id,kind) VALUES ($1,$2) ON CONFLICT DO NOTHING', [runId, kind]);
  }
  for (const { db } of connections) await db.query('COMMIT');
  console.log(`FACADE_MANAGED_TEST_RUN_ID=${runId}`);
} finally {
  await Promise.allSettled(connections.map(({ db }) => db.end()));
}
