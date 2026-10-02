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
  runtime: FixtureRuntime
}

interface FixtureRuntime {
  llm: {
    prepareCall: ReturnType<typeof vi.fn>
  }
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
      resolveModelInfo: vi.fn(async () => ({
        provider: 'provider-a',
        id: 'shared',
        name: 'Shared',
        context: { contextWindow: 200_000 },
        defaultMaxTokens: 64_000,
        inputModalities: ['text', 'image'],
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      })),
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
  const fixture = { app, storage, runtime: runtime as unknown as FixtureRuntime }
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
    expect(models.json().data[0].context_window).toBe(200_000)
    expect(models.json().data[0].supported_reasoning_levels.map((item: { effort: string }) => item.effort)).toEqual(['low', 'high'])
    expect(models.json().data[0].default_reasoning_level).toBe('high')

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
    expect(responses.body).toContain('event: response.in_progress')
    expect(responses.body).toContain('event: response.output_item.added')
    expect(responses.body).toContain('event: response.output_text.done')
    expect(responses.body).toContain('event: response.content_part.done')
    expect(responses.body).toContain('event: response.output_item.done')
    expect(responses.body).toContain('"sequence_number":0')
  })

  it('merges top-level instructions into the system prompt', async () => {
    const { app, runtime } = await createFixture()
    let captured: { system?: string } | undefined
    runtime.llm.prepareCall = vi.fn(async () => ({
      config: {},
      stream: async function* (options: { system?: string }) {
        captured = options
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }))

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        input: 'Hi',
        instructions: 'You are a helpful coding agent.',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(captured?.system).toBe('You are a helpful coding agent.')
  })

  it('streams function call items for the Responses API', async () => {
    const { app, runtime } = await createFixture()
    runtime.llm.prepareCall = vi.fn(async () => ({
      config: {},
      stream: async function* () {
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'shell', argumentsDelta: '{"cmd":' }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '"ls"}' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    }))

    const responses = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        stream: true,
        input: 'list files',
      },
    })
    expect(responses.statusCode).toBe(200)
    expect(responses.body).toContain('"type":"function_call"')
    expect(responses.body).toContain('event: response.function_call_arguments.delta')
    expect(responses.body).toContain('event: response.function_call_arguments.done')
    expect(responses.body).toContain('"call_id":"call_1"')
    expect(responses.body).toContain('"name":"shell"')
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

  it('passes the selected reasoning effort to the adapter', async () => {
    const { app, runtime } = await createFixture()
    await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test' },
      payload: {
        model: 'provider-a/shared',
        input: 'Hi',
        reasoning: { effort: 'low' },
      },
    })
    expect(runtime.llm.prepareCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'provider-a', model: 'shared', reasoningEffort: 'low' }),
      expect.anything(),
    )
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
