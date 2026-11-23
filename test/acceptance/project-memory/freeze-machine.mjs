import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

const [databaseEnv, projectId, phase, output] = process.argv.slice(2);
assert.match(projectId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
assert.ok(['rehearsal', 'progress', 'primary', 'follow-up', 'supplement', 'continuation'].includes(phase));
assert.equal((await stat(dirname(output))).mode & 0o077, 0);
const { DATABASE_URL } = parseEnv(await readFile(databaseEnv, 'utf8'));
const connection = new URL(DATABASE_URL);
assert.equal(connection.hostname, '127.0.0.1');
assert.match(connection.pathname, /^\/test_project_memory_(?:live|rehearsal)_[a-f0-9]{12}$/u);

const pool = new pg.Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 3_000 });
const client = await pool.connect();
const byProject = async (sql) => (await client.query(sql, [projectId])).rows;
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='20s'");
  const [project] = await byProject(`SELECT id, version, project_stage AS stage, intake_mode, catalog_version_id
    FROM projects WHERE id=$1`);
  assert.ok(project?.intake_mode);
  const jobs = await byProject(`SELECT id, kind, purpose, payload, state, reason, cursor, result
    FROM gateway_jobs WHERE project_id=$1 ORDER BY created_at,id`);
  const events = await byProject(`SELECT e.job_id, e.sequence, e.event #- '{reply,image,data}' AS event FROM harness_research_events e
    JOIN gateway_jobs j ON j.id=e.job_id WHERE j.project_id=$1 ORDER BY e.job_id,e.sequence`);
  const maps = await byProject(`SELECT version_id, original_sha256, reader_version, format, units
    FROM reader_maps WHERE project_id=$1 ORDER BY version_id,reader_version`);
  const evidence = await byProject(`SELECT id, version_id, reader_version, run_id, branch, payload FROM reader_evidence
    WHERE project_id=$1 ORDER BY created_at,id`);
  const findings = await byProject(`SELECT o.id, o.version_id, o.run_id, o.branch, o.evidence_id, o.payload,
      to_jsonb(f) AS package_fact FROM reader_observations o
    LEFT JOIN harness_package_facts f ON f.id=o.id WHERE o.project_id=$1 ORDER BY o.created_at,o.id`);
  const comparisons = await byProject(`SELECT p.*,l.state AS lead_state,a.state AS a_state,b.state AS b_state
    FROM harness_package_review_pairs p JOIN gateway_jobs l ON l.id=p.lead_job_id
    LEFT JOIN gateway_jobs a ON a.id=p.a_job_id LEFT JOIN gateway_jobs b ON b.id=p.b_job_id
    WHERE p.project_id=$1 ORDER BY p.id`);
  const localAttempts = await byProject(`SELECT id,job_id,route_id,purpose,effect_key,request_hash,state,ceiling_usd_nanos,receipt
    FROM gateway_attempts WHERE project_id=$1 ORDER BY created_at,id`);
  const hasTable = async (name) => (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])).rows[0].present;
  const memory = await hasTable('project_memory_blocks') ? await byProject(`SELECT b.*,
      coalesce(jsonb_agg(jsonb_build_object('lineId',l.line_id,'literal',l.literal,'address',l.address) ORDER BY l.ordinal)
        FILTER (WHERE l.line_id IS NOT NULL),'[]'::jsonb) AS lines
    FROM project_memory_blocks b LEFT JOIN project_memory_lines l ON l.block_id=b.id
    WHERE b.project_id=$1 GROUP BY b.id ORDER BY b.version_id,b.ordinal`) : [];
  const structures = await hasTable('harness_package_structures') ? await byProject(`SELECT s.*,w.version_id,w.place
    FROM harness_package_structures s JOIN harness_package_windows w ON w.id=s.window_id
    WHERE w.project_id=$1 ORDER BY s.window_id`) : [];
  const coverageChecks = await hasTable('harness_package_block_checks') ? await byProject(`SELECT c.*
    FROM harness_package_block_checks c JOIN gateway_jobs j ON j.id=c.job_id WHERE j.project_id=$1
    ORDER BY c.job_id,c.block_id`) : [];
  const helper = await hasTable('copilot_questions') ? await byProject(`SELECT id,job_id,state,reason,result
    FROM copilot_questions WHERE project_id=$1 ORDER BY created_at,id`) : [];
  if (phase === 'primary') assert.equal(helper.length, 0, 'late questions must not precede the primary snapshot');
  const result = { phase, project, jobs, events, maps, evidence, findings, comparisons, localAttempts, memory, structures, coverageChecks, helper };
  await client.query('COMMIT');
  const body = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  await writeFile(output, body, { mode: 0o600, flag: 'wx' });
  const summary = { phase, sha256: createHash('sha256').update(body).digest('hex'), branches: {} };
  for (const branch of ['A', 'B']) {
    const ids = new Set(jobs.filter(({ purpose }) => purpose === 'primary_' + branch.toLowerCase()).map(({ id }) => id));
    const rows = events.filter(({ job_id }) => ids.has(job_id)).map(({ event }) => event);
    const proposed = rows.flatMap(({ message }) => message?.tool_calls?.map(({ function: item }) => item.name) ?? []);
    const transmitted = new Set(rows.flatMap(({ inputRefs }) => inputRefs ?? []));
    summary.branches[branch] = {
      jobs: ids.size,
      opened: new Set(evidence.filter(({ run_id }) => ids.has(run_id)).map(({ id }) => id)).size,
      transmitted: transmitted.size,
      proposed: proposed.filter((name) => name === 'save_observation' || name === 'save_compound_observation').length,
      accepted: findings.filter(({ run_id }) => ids.has(run_id)).length,
    };
  }
  console.log(JSON.stringify(summary));
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('Machine snapshot failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
