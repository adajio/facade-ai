import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { readDatabaseUrl, reportStartupError, StartupError } from './config.js'
import { openPool } from './db.js'

const migrationDir = new URL('../../../db/migrations/', import.meta.url)
const bootstrap = '01_platform_schema.sql'

interface Migration {
  filename: string
  sql: string
  sha256: string
}

async function readMigrations(): Promise<Migration[]> {
  const filenames = (await readdir(migrationDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()

  if (!filenames.includes(bootstrap)) {
    throw new StartupError(`Missing bootstrap migration ${bootstrap}`)
  }
  return Promise.all(filenames.map(async (filename) => {
    if (!/^\d{2}[-_][a-zA-Z0-9][a-zA-Z0-9_-]*\.sql$/.test(filename)) {
      throw new StartupError(`Invalid migration filename ${filename}`)
    }

    const source = await readFile(new URL(filename, migrationDir))
    return {
      filename,
      sql: source.toString('utf8'),
      sha256: createHash('sha256').update(source).digest('hex'),
    }
  }))
}

async function migrate(): Promise<void> {
  const databaseUrl = readDatabaseUrl()
  const migrations = await readMigrations()
  const pool = openPool(databaseUrl)

  try {
    const client = await pool.connect()
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended('facade-ai/migrations', 0))")
      const { rows: [ledger] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('public.facade_schema_migrations') IS NOT NULL AS present",
      )
      const applied = ledger.present
        ? (await client.query<{ filename: string; sha256: string }>(
            'SELECT filename, sha256 FROM public.facade_schema_migrations ORDER BY filename',
          )).rows
        : []
      const checksums = new Map(migrations.map(({ filename, sha256 }) => [filename, sha256]))

      for (const { filename, sha256 } of applied) {
        if (checksums.get(filename) !== sha256) {
          throw new StartupError(`Applied migration is missing or changed: ${filename}`)
        }
      }

      const appliedNames = new Set(applied.map(({ filename }) => filename))
      // The bootstrap must create the ledger before any other migration can be recorded.
      const initial = migrations.find(({ filename }) => filename === bootstrap)!
      const pending = [initial, ...migrations.filter(({ filename }) => filename !== bootstrap)]
        .filter(({ filename }) => !appliedNames.has(filename))

      for (const { filename, sql, sha256 } of pending) {
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query(
            'INSERT INTO public.facade_schema_migrations (filename, sha256) VALUES ($1, $2)',
            [filename, sha256],
          )
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          const pgCode = (error as { code?: unknown }).code
          const detail = typeof pgCode === 'string' && /^[A-Z0-9]{5}$/.test(pgCode)
            ? ` (PostgreSQL ${pgCode})`
            : ''
          throw new StartupError(`Migration failed: ${filename}${detail}`)
        }
        console.info(`Applied ${filename}`)
      }
      if (!pending.length) console.info('Database migrations are current')
    } finally {
      client.release(true)
    }
  } finally {
    await pool.end()
  }
}

migrate().catch((error) => reportStartupError('Migrations', error))
