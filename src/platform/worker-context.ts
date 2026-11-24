import type { Pool } from 'pg'
import type { AppConfig } from './config.js'

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>

export interface WorkerContext {
  db: Pool
  config: AppConfig
  signal: AbortSignal
  logger: Logger
}
