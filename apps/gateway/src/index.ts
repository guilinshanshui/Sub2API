import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { ApiKeyManager } from './api-keys.js'
import { AdminAuth } from './auth.js'
import { loadConfig } from './config.js'
import { JetHubClient } from './jet-hub.js'
import { ModelCatalog } from './openai.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerOpenAiRoutes } from './routes/openai.js'
import { createGatewayRuntime, type GatewayRuntime } from './runtime.js'
import { GatewayStorage } from './storage.js'
import { ensureDirectory } from './utils.js'

const startedAt = Date.now()
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultWebDist = path.resolve(currentDirectory, '../../web/dist')
const webDist = path.resolve(process.env.SUB2API_WEB_DIST?.trim() || defaultWebDist)

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  await ensureDirectory(config.dataDir)

  const auth = new AdminAuth(config.dataDir, config.publicUrl, config.bootstrapAdminPassword)
  await auth.initialize()

  const apiKeys = new ApiKeyManager(config.dataDir, config.bootstrapApiKey)
  await apiKeys.initialize()

  const storage = new GatewayStorage(config.dataDir, config)
  await storage.initialize()

  const jetHub = new JetHubClient()
  let runtime: GatewayRuntime | undefined
  let app: ReturnType<typeof Fastify> | undefined

  try {
    runtime = await createGatewayRuntime(config, jetHub)
    const catalog = new ModelCatalog(runtime)
    app = Fastify({
      logger: {
        level: config.logLevel,
      },
      bodyLimit: 16 * 1024 * 1024,
    })

    app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('X-Frame-Options', 'DENY')
      reply.header('Referrer-Policy', 'no-referrer')
    })

    if (config.corsOrigins.length > 0) {
      await app.register(fastifyCors, {
        origin: config.corsOrigins,
        credentials: true,
      })
    }

    registerAuthRoutes(app, auth)
    registerAdminRoutes(app, {
      auth,
      apiKeys,
      config,
      jetHub,
      runtime,
      startedAt,
      storage,
    })
    registerOpenAiRoutes(app, {
      apiKeys,
      catalog,
      config,
      runtime,
      storage,
    })

    const hasWebBuild = await exists(path.join(webDist, 'index.html'))
    if (hasWebBuild) {
      await app.register(fastifyStatic, {
        root: webDist,
        prefix: '/',
      })
    }

    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      const url = request.raw.url ?? '/'
      if (url.startsWith('/api/') || url.startsWith('/v1/')) {
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'Endpoint not found.',
          },
        })
      }
      if (hasWebBuild && request.method === 'GET') {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'Not found.',
        },
      })
    })

    await app.listen({
      host: config.host,
      port: config.port,
    })

    const setupToken = auth.oneTimeSetupToken()
    app.log.info(`Sub2API gateway listening on ${config.publicUrl}`)
    app.log.info(`Data directory: ${config.dataDir}`)
    if (!hasWebBuild) {
      app.log.warn('Web build not found. Run pnpm --filter @sub2api/web build before starting without the Vite dev server.')
    }
    if (setupToken !== undefined) {
      app.log.warn(`First-run admin setup token: ${setupToken}`)
    }
  } catch (error) {
    await app?.close().catch(() => undefined)
    await runtime?.dispose().catch(() => undefined)
    throw error
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app?.log.info(`Received ${signal}, shutting down`)
    await app?.close().catch((error: unknown) => {
      app?.log.error(error)
    })
    await runtime?.dispose().catch((error: unknown) => {
      app?.log.error(error)
    })
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
