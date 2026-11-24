import { createApi } from '../../../src/platform/api.js'
import { readConfig, reportStartupError, StartupError } from '../../../src/platform/config.js'
import { checkRuntimeInvocation, openProductionDatabase, toolHash } from '../../../src/platform/runtime-boundary.js'

async function main(): Promise<void> {
  checkRuntimeInvocation()
  const config = readConfig()
  const app = await createApi(config)
  let release: (() => void) | undefined

  app.server.once('close', () => release?.())
  try {
    release = await openProductionDatabase(app.db)
    app.log.info({ mode: 'api', toolSha256: await toolHash(new URL(import.meta.url)) }, 'Runtime identity')
  } catch (error) {
    release?.()
    await app.close()
    throw error
  }

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch {
    release?.()
    release = undefined
    await app.close()
    throw new StartupError('Could not listen on configured HOST and PORT')
  }

  function stop(): void {
    app.close().catch((error) => reportStartupError('API shutdown', error))
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((error) => reportStartupError('API startup', error))
