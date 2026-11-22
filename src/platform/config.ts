import { resolve } from 'node:path'

export interface AppConfig {
  databaseUrl: string
  dataDir: string
  host: string
  port: number
}

export class StartupError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new StartupError(`Specify ${name}`)
  return value
}

export function readDatabaseUrl(env = process.env): string {
  const value = required(env, 'DATABASE_URL')
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error()
  } catch {
    throw new StartupError('DATABASE_URL must be a PostgreSQL URL')
  }
  return value
}

export function readConfig(env = process.env): AppConfig {
  const portText = env.PORT?.trim() || '3000'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new StartupError('PORT must be an integer from 1 to 65535')
  }

  return {
    databaseUrl: readDatabaseUrl(env),
    dataDir: resolve(required(env, 'FACADE_DATA_DIR')),
    host: env.HOST?.trim() || '127.0.0.1',
    port,
  }
}

export function reportStartupError(processName: string, error: unknown): void {
  const reason = error instanceof StartupError ? error.message : 'Unexpected error'
  console.error(`${processName}: ${reason}`)
  process.exitCode = 1
}
