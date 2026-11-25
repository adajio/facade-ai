import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { StartupError } from './config.js'
import type { AppConfig } from './config.js'
import { openPool } from './db.js'
import { findApiModules, loadModule } from './modules.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
    config: AppConfig
  }
}

const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url))

function isApiPath(url: string): boolean {
  const path = url.split('?', 1)[0]
  return path === '/api' || path.startsWith('/api/')
}

export async function createApi(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  })
  const db = openPool(config.databaseUrl)
  app.decorate('db', db)
  app.decorate('config', config)
  app.addHook('onClose', () => db.end())

  app.addHook('onRequest', async (request, reply) => {
    if (isApiPath(request.url)) reply.header('Cache-Control', 'no-store')
  })

  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof Error
      ? error as Error & { statusCode?: number; code?: string }
      : undefined
    const status = failure?.statusCode && failure.statusCode >= 400 ? failure.statusCode : 500
    if (status >= 500) {
      const sqlState = failure?.code && /^[0-9A-Z]{5}$/.test(failure.code) ? failure.code : undefined
      request.log.error({ status, method: request.method, route: request.routeOptions.url, sqlState }, 'Request failed')
    }
    return reply.code(status).send({
      code: status < 500 ? failure?.code ?? 'bad_request' : 'internal_error',
      message: status < 500 ? failure?.message : 'Internal server error',
      requestId: request.id,
    })
  })

  app.get('/healthz', async (_, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ status: 'ok' })
  })
  app.get('/readyz', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await db.query('SELECT 1')
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({
        status: 'unavailable',
        code: 'database_unavailable',
        requestId: request.id,
      })
    }
  })

  try {
    const hasWeb = await access(new URL('index.html', new URL('../../../web/dist/', import.meta.url)))
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      })

    if (hasWeb) {
      app.register(fastifyStatic, { root: webRoot, prefix: '/assets/', serve: false })
      app.get('/assets/*', (request, reply) => {
        const { '*': filename } = request.params as { '*': string }
        return reply.sendFile(`assets/${filename}`, { immutable: true, maxAge: '1y' })
      })
    }

    app.setNotFoundHandler((request, reply) => {
      if (
        hasWeb && !isApiPath(request.url) && !request.url.startsWith('/assets/') &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        (request.url.split('?', 1)[0] === '/' || request.headers.accept?.includes('text/html'))
      ) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
      }
      return reply.code(404).send({
        code: 'not_found',
        message: 'Route not found',
        requestId: request.id,
      })
    })

    app.addHook('onRoute', (route) => {
      if (!isApiPath(route.url)) throw new StartupError('Modules must declare routes under /api')
    })

    for (const name of await findApiModules()) {
      const module = await loadModule(name)
      if (name === 'harness' && typeof module.startWorker === 'function' && !module.register) continue
      const register = module.register
      if (typeof register !== 'function') {
        throw new StartupError(`Module ${name} must export register(app)`)
      }

      const mount = async (scope: FastifyInstance): Promise<void> => {
        try {
          await register(scope)
        } catch (error) {
          if (error instanceof StartupError) throw error
          throw new StartupError(`Registration failed for module ${name}`)
        }
      }

      // Access installs the origin and CSRF hooks shared by every API module.
      if (name === 'access') await mount(app)
      else app.register(mount)
    }

    await app.ready()
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}
