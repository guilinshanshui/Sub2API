import { describe, expect, it, vi } from 'vitest'
import {
  createCompletion,
  ModelCatalog,
  OpenAiRequestError,
  parseMessagesForOpenAi,
  parseResponsesInput,
} from './openai.js'
import type { GatewayRuntime } from './runtime.js'
import type { GatewaySettings } from './types.js'

const settings: GatewaySettings = {
  defaultProvider: '',
  defaultModel: '',
  allowedModels: [],
  requestTimeoutMs: 30_000,
  logLevel: 'info',
}

function catalogRuntime(): GatewayRuntime {
  return {
    llm: {
      listProviders: () => [
        { id: 'provider-a', name: 'Provider A' },
        { id: 'provider-b', name: 'Provider B' },
      ],
      listModels: vi.fn(async (provider: string) => provider === 'provider-a'
        ? [{ id: 'shared', name: 'Shared A' }, { id: 'blocked', name: 'Blocked' }]
        : [{ id: 'shared', name: 'Shared B' }, { id: 'unique-b', name: 'Unique B' }]),
    },
    accountPool: {
      disabledModelsFor: () => new Set(['blocked']),
    },
  } as unknown as GatewayRuntime
}

describe('ModelCatalog', () => {
  it('filters globally disabled and upstream-disabled models', async () => {
    const catalog = new ModelCatalog(catalogRuntime())
    const models = await catalog.list({ ...settings, allowedModels: ['provider-*/*'] })

    expect(models.map((model) => model.id)).toEqual([
      'provider-a/shared',
      'provider-b/shared',
      'provider-b/unique-b',
    ])
    expect(catalog.isAllowed({
      id: 'provider-a/blocked',
      provider: 'provider-a',
      upstreamId: 'blocked',
      name: 'Blocked',
      aliases: [],
    }, settings)).toBe(false)
  })

  it('resolves full IDs, unique bare IDs, and rejects ambiguous bare IDs', async () => {
    const catalog = new ModelCatalog(catalogRuntime())

    expect((await catalog.resolve('provider-a/shared', settings)).upstreamId).toBe('shared')
    expect((await catalog.resolve('unique-b', settings)).provider).toBe('provider-b')
    await expect(catalog.resolve('shared', settings)).rejects.toThrow('ambiguous')
  })

  it('passes through an explicitly provider-qualified unknown model', async () => {
    const catalog = new ModelCatalog(catalogRuntime())
    expect(await catalog.resolve('provider-a/new-model', settings)).toMatchObject({
      id: 'provider-a/new-model',
      provider: 'provider-a',
      upstreamId: 'new-model',
    })
  })
})

describe('OpenAI request parsing', () => {
  it('restores assistant tool calls and tool results', () => {
    const parsed = parseMessagesForOpenAi([
      { role: 'system', content: 'You are concise.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ], { provider: 'provider-a', model: 'shared' })

    expect(parsed.system).toBe('You are concise.')
    expect(parsed.messages).toHaveLength(2)
    expect(JSON.stringify(parsed.messages)).toContain('tool-call')
    expect(JSON.stringify(parsed.messages)).toContain('tool-result')
  })

  it('restores Responses function-call history', () => {
    const parsed = parseResponsesInput([
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"found":true}' },
    ], { provider: 'provider-a', model: 'shared' })

    expect(parsed.messages).toHaveLength(2)
    expect(JSON.stringify(parsed.messages)).toContain('tool-call')
    expect(JSON.stringify(parsed.messages)).toContain('tool-result')
  })

  it('rejects image inputs with a clear protocol error', () => {
    expect(() => parseMessagesForOpenAi([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
    ], { provider: 'provider-a', model: 'shared' }))
      .toThrow(OpenAiRequestError)
  })
})

describe('createCompletion', () => {
  it('aggregates text, reasoning, tool calls, and usage', async () => {
    const runtime = {
      llm: {
        prepareCall: vi.fn(async () => ({
          config: {},
          stream: async function* () {
            yield { type: 'reasoning-delta', text: 'think' }
            yield { type: 'text-delta', text: 'hello' }
            yield {
              type: 'tool-call-delta',
              index: 0,
              id: 'call_3',
              name: 'lookup',
              argumentsDelta: '{"id":',
            }
            yield {
              type: 'tool-call-delta',
              index: 0,
              id: 'call_3',
              argumentsDelta: '3}',
            }
            yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          },
        })),
      },
    } as unknown as GatewayRuntime

    const result = await createCompletion(runtime, {
      provider: 'provider-a',
      model: 'shared',
      publicModel: 'provider-a/shared',
      messages: [],
    }, new AbortController().signal)

    expect(result.text).toBe('hello')
    expect(result.reasoning).toBe('think')
    expect(result.toolCalls).toEqual([{ id: 'call_3', name: 'lookup', arguments: '{"id":3}' }])
    expect(result.usage.totalTokens).toBe(9)
    expect(result.finishReason).toBe('tool_calls')
  })
})
