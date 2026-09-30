import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyManager } from '../api-keys.js'
import type { GatewayConfig } from '../config.js'
import { ModelCatalog } from '../openai.js'
import type { GatewayRuntime } from '../runtime.js'
import { GatewayStorage } from '../storage.js'
import { registerOpenAiRoutes } from './openai.js'

interface Fixture {
  app: FastifyInstance
  storage: GatewayStorage
}

const fixtures: Fixture[] = []
const temporaryDirectories: string[] = []

async function createFixture(): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-openai-route-'))
  temporaryDirectories.push(dataDir)
  const config: GatewayConfig = {
    dataDir,
    host: '127.0.0.1',
    port: 8787,
    publicUrl: 'http://127.0.0.1:8787',
    bootstrapApiKey: 'sk-test',
    bootstrapAdminPassword: '',
    allowedModels: [],
    defaultProvider: '',
    defaultModel: '',
    requestTimeoutMs: 30_000,
    schedulerIntervalMs: 0,
    balanceRefreshMinutes: 0,
    corsOrigins: [],
    logLevel: 'silent',
  }
  const apiKeys = new ApiKeyManager(dataDir, config.bootstrapApiKey)
  await apiKeys.initialize()
  const storage = new GatewayStorage(dataDir, config)
  await storage.initialize()

  const runtime = {
    llm: {
      listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
      listModels: vi.fn(async () => [{ id: 'shared', name: 'Shared' }]),
      prepareCall: vi.fn(async () => ({
        config: {},
        stream: async function* () {
          yield { type: 'text-delta', text: 'hello' }
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })),
    },
    accountPool: {
      disabledModelsFor: () => new Set<string>(),
    },
  } as unknown as GatewayRuntime

  const app = Fastify()
  registerOpenAiRoutes(app, {
    apiKeys,
    catalog: new ModelCatalog(runtime),
    config,
    runtime,
    storage,
  })
  await app.ready()
  const fixture = { app, storage }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ app }) => app.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 20,
  })))
})

describe('OpenAI routes', () => {
  it('serves authenticated models and chat completions', async () => {
    const { app } = await createFixture()

    const models = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-test' },
    })
    expect(models.statusCode).toBe(200)
    expect(models.json().data[0].id).toBe('provider-a/shared')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().choices[0].message.content).toBe('hello')
  })

  it('streams Chat Completions and Responses events', async () => {
    const { app } = await createFixture()

    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    })
    expect(chat.statusCode).toBe(200)
    expect(chat.body).toContain('data: {"id":"chatcmpl-')
    expect(chat.body).toContain('"content":"hello"')
    expect(chat.body).toContain('data: [DONE]')

    const responses = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        stream: true,
        input: 'Hi',
      },
    })
    expect(responses.statusCode).toBe(200)
    expect(responses.body).toContain('event: response.created')
    expect(responses.body).toContain('event: response.output_text.delta')
    expect(responses.body).toContain('event: response.completed')
  })

  it('does not fail a successful response when audit persistence fails', async () => {
    const { app, storage } = await createFixture()
    vi.spyOn(storage, 'appendUsage').mockRejectedValue(new Error('disk full'))
    vi.spyOn(storage, 'appendLog').mockRejectedValue(new Error('disk full'))

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().choices[0].message.content).toBe('hello')
  })

  it('rejects unauthenticated requests', async () => {
    const { app } = await createFixture()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'provider-a/shared',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('invalid_api_key')
  })
})
