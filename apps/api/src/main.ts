import { createApi } from '../../../src/platform/api.js'
import { readConfig, reportStartupError, StartupError } from '../../../src/platform/config.js'

async function main(): Promise<void> {
  const config = readConfig()
  const app = await createApi(config)

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch {
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
