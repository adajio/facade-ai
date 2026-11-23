import { readConfig, reportStartupError, StartupError } from '../../../src/platform/config.js'
import { openPool } from '../../../src/platform/db.js'
import { findModules, loadModule } from '../../../src/platform/modules.js'
import { checkRuntimeInvocation, openProductionDatabase } from '../../../src/platform/runtime-boundary.js'
import type { WorkerContext } from '../../../src/platform/worker-context.js'

async function main(): Promise<void> {
  checkRuntimeInvocation()
  const config = readConfig()
  if (!(await findModules()).includes('harness')) {
    throw new StartupError('Harness module is required to start the worker')
  }
  const { startWorker } = await loadModule('harness')
  if (typeof startWorker !== 'function') {
    throw new StartupError('Harness must export startWorker(context)')
  }

  const controller = new AbortController()
  const db = openPool(config.databaseUrl)
  const context: WorkerContext = { db, config, signal: controller.signal, logger: console }

  function stop(): void {
    controller.abort()
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  let release: (() => void) | undefined
  try {
    release = await openProductionDatabase(db)
    await startWorker(context)
    if (!context.signal.aborted) throw new StartupError('Harness returned before shutdown')
  } catch (error) {
    if (!context.signal.aborted || error !== context.signal.reason) throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    release?.()
    await db.end()
  }
}

main().catch((error) => reportStartupError('Worker', error))
