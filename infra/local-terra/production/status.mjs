import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

async function localState(path) {
  const counts = new Map();
  async function scan(dir) {
    let entries;
    try { entries = await readdir(dir,{withFileTypes:true}); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = join(dir,entry.name);
      if (entry.isDirectory()) await scan(filename);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const {state} = JSON.parse(await readFile(filename,'utf8'));
        if (['sending','unknown','responded','published','rejected'].includes(state))
          counts.set(state,(counts.get(state) ?? 0)+1);
      }
    }
  }
  await scan(path);
  return Object.fromEntries(counts);
}

async function inspect(connectionString, query) {
  if (!connectionString) throw Error('database_config_required');
  const client = new pg.Client({connectionString,query_timeout:5000,connectionTimeoutMillis:5000});
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    return await query(client);
  } finally {
    await client.query('ROLLBACK').catch(()=>{});
    await client.end();
  }
}

const held = ['reserved','prepared','sending','unknown'];
try {
  const local = process.argv.indexOf('--terra-state');
  if (local >= 0) {
    const states = await localState(process.argv[local+1]);
    console.log(JSON.stringify(states));
    if (process.argv.includes('--require-no-active') && (states.sending || states.responded)) process.exitCode=3;
  } else {
    const result = await inspect(process.env.DATABASE_URL,async db=>{
      const {rows:[{timeout}]} = await db.query('SELECT coalesce(max(timeout_ms),0)::int AS timeout FROM gateway_routes WHERE enabled');
      const {rows:[{installed}]} = await db.query("SELECT to_regclass('preliminary_package_reviews') IS NOT NULL AS installed");
      const {rows:attempts} = await db.query('SELECT state,count(*)::int AS count FROM gateway_attempts WHERE state=ANY($1) GROUP BY state ORDER BY state',[held]);
      return {preliminaryMigration:installed,workerGraceSeconds:Math.max(60,Math.ceil(timeout/1000)+45),attempts};
    });
    const journal = await inspect(process.env.FACADE_GATEWAY_JOURNAL_URL,async db=>{
      const {rows} = await db.query('SELECT state,count(*)::int AS count FROM gateway_external_attempts WHERE state=ANY($1) GROUP BY state ORDER BY state',[held]);
      return rows;
    });
    if (process.argv.includes('--worker-grace')) console.log(result.workerGraceSeconds);
    else console.log(JSON.stringify({...result,journal}));
    if (process.argv.includes('--require-no-active') &&
        [...result.attempts,...journal].some(row=>row.state !== 'unknown')) process.exitCode=3;
    if (process.argv.includes('--require-preliminary-schema') && !result.preliminaryMigration) process.exitCode=4;
  }
} catch (error) {
  console.error('terra-production-status',typeof error?.code === 'string' ? error.code : 'read_failed');
  process.exitCode=2;
}
