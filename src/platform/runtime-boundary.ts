import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import { StartupError } from './config.js'
import { openPool } from './db.js'

function isManagedSlot(slot: unknown): boolean {
  if (slot === null || typeof slot !== 'object') return false
  const { routeId, model } = slot as Record<string, unknown>
  return (typeof routeId === 'string' && /^managed-/i.test(routeId)) ||
    (typeof model === 'string' && /^managed\//i.test(model))
}

function hasManagedSlots(serialized: string | undefined): boolean {
  let profiles: unknown
  try { profiles = JSON.parse(serialized ?? '{}') } catch { return false }
  return profiles !== null && typeof profiles === 'object' &&
    (isManagedSlot(profiles) || Object.values(profiles).some(isManagedSlot))
}

export function checkRuntimeInvocation(): void {
  if (process.argv.length > 2) throw new StartupError('Unexpected runtime arguments')
  if (process.env.FACADE_HARNESS_MANAGED_URL?.trim()) {
    throw new StartupError('Managed model endpoints require the isolated test entrypoint')
  }
  if ([process.env.FACADE_HARNESS_PROFILE, process.env.FACADE_GATEWAY_STEP15_PROFILES,
    process.env.FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES, process.env.FACADE_COPILOT_PROFILE].some(hasManagedSlots)) {
    throw new StartupError('Managed model profiles require the isolated test entrypoint')
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new StartupError('Runtime requires TLS certificate verification')
  }
}

export async function toolHash(file: URL): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function openProductionDatabase(db: Pool): Promise<() => void> {
  const client = await db.connect()
  try {
    const { rows: [boundary] } = await client.query<{ locked: boolean }>(`
      SELECT pg_try_advisory_lock_shared(hashtextextended('facade/model-runtime',0)) AS locked`)
    if (!boundary.locked) throw new StartupError('Database already serves an isolated model test')
    const { rows: [schema] } = await client.query<{ sealed: boolean; routes: boolean }>(`
      SELECT to_regclass('public.facade_managed_test_seal') IS NOT NULL AS sealed,
        to_regclass('public.gateway_routes') IS NOT NULL AS routes`)
    if (schema.sealed || (schema.routes && (await client.query(
      "SELECT 1 FROM public.gateway_routes WHERE transport='managed' LIMIT 1")).rowCount)) {
      throw new StartupError('Managed test database is sealed for isolated tools')
    }
    return () => client.release(true)
  } catch (error) {
    client.release(true)
    throw error
  }
}

export async function verifyManagedTestTarget(client: Pick<PoolClient, 'query'>, kind: 'app' | 'journal'): Promise<void> {
  const runId = process.env.FACADE_MANAGED_TEST_RUN_ID;
  if (!runId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId)) {
    throw new StartupError('Managed model tests require a pinned test run ID');
  }
  const { rows: [target] } = await client.query<{ database: string; marked: boolean }>(`
    SELECT current_database() AS database, to_regclass('public.facade_managed_test_seal') IS NOT NULL AS marked`);
  const names = kind === 'app' ? /^test_[a-z0-9_]+$/ : /^(?:test|journal)_[a-z0-9_]+$/;
  if (!names.test(target.database) || !target.marked) {
    throw new StartupError(`Managed model tests require a marked ${kind} database`);
  }
  const { rows } = await client.query<{ runId: string; kind: string }>(`
    SELECT to_jsonb(seal)->>'run_id' AS "runId", to_jsonb(seal)->>'kind' AS kind
    FROM public.facade_managed_test_seal seal LIMIT 2`);
  if (rows.length !== 1 || rows[0].runId !== runId || rows[0].kind !== kind) {
    throw new StartupError(`Managed model test ${kind} database identity differs`);
  }
}

export async function sealManagedTestDatabase(db: Pool): Promise<PoolClient> {
  const client = await db.connect()
  try {
    await verifyManagedTestTarget(client, 'app')
    const { rows: [boundary] } = await client.query<{ locked: boolean }>(`
      SELECT pg_try_advisory_lock(hashtextextended('facade/model-runtime',0)) AS locked`)
    if (!boundary.locked) throw new StartupError('Database already serves a runtime process')
    const journalUrl = process.env.FACADE_GATEWAY_JOURNAL_URL;
    if (!journalUrl) throw new StartupError('Managed model tests require a journal database URL');
    const journal = openPool(journalUrl);
    try {
      await verifyManagedTestTarget(journal, 'journal');
    } finally {
      await journal.end();
    }
    return client
  } catch (error) {
    client.release(true)
    throw error
  }
}
