import pg from 'pg'

export function openPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 })
  pool.on('error', () => console.error('PostgreSQL: idle connection failed'))
  return pool
}
