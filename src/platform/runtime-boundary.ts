import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import { StartupError } from './config.js'

function hasManagedSlots(serialized: string | undefined): boolean {
  let profiles: unknown
  try { profiles = JSON.parse(serialized ?? '{}') } catch { return false }
  if (profiles === null || typeof profiles !== 'object') return false
  return Object.values(profiles).some((slot: unknown) => {
    if (slot === null || typeof slot !== 'object') return false
    const { routeId, model } = slot as Record<string, unknown>
    return (typeof routeId === 'string' && /^managed-/i.test(routeId)) ||
      (typeof model === 'string' && /^managed\//i.test(model))
  })
}

export function checkRuntimeInvocation(): void {
  if (process.argv.length > 2) throw new StartupError('Unexpected runtime arguments')
  if (process.env.FACADE_HARNESS_MANAGED_URL?.trim()) {
    throw new StartupError('Managed model endpoints require the isolated test entrypoint')
  }
  if (hasManagedSlots(process.env.FACADE_HARNESS_PROFILE) || hasManagedSlots(process.env.FACADE_GATEWAY_STEP15_PROFILES)) {
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

export async function sealManagedTestDatabase(db: Pool): Promise<PoolClient> {
  const client = await db.connect()
  try {
    const { rows: [target] } = await client.query<{ database: string }>('SELECT current_database() AS database')
    if (!/^test_[a-z0-9_]+$/.test(target.database)) {
      throw new StartupError('Managed model tests require a dedicated test_ database')
    }
    const { rows: [boundary] } = await client.query<{ locked: boolean }>(`
      SELECT pg_try_advisory_lock(hashtextextended('facade/model-runtime',0)) AS locked`)
    if (!boundary.locked) throw new StartupError('Database already serves a runtime process')
    await client.query('CREATE TABLE IF NOT EXISTS public.facade_managed_test_seal (created_at timestamptz NOT NULL DEFAULT now())')
    return client
  } catch (error) {
    client.release(true)
    throw error
  }
}
