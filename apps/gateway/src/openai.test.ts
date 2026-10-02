import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocalAttachmentStore } from './attachments.js'
import {
  createCompletion,
  ModelCatalog,
  OpenAiRequestError,
  parseMessagesForOpenAi,
  parseResponsesInput,
  pickReasoningEffort,
} from './openai.js'
import type { GatewayRuntime } from './runtime.js'
import type { GatewaySettings } from './types.js'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

  it('maps legacy cn: / global: namespaces onto the buddy and workbuddy providers', async () => {
    const runtime = {
      llm: {
        listProviders: () => [
          { id: 'buddy', name: 'CodeBuddy' },
          { id: 'workbuddy', name: 'WorkBuddy' },
        ],
        listModels: vi.fn(async (provider: string) => provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
          : [{ id: 'gpt-5.5', name: 'GPT-5.5' }]),
      },
      accountPool: { disabledModelsFor: () => new Set<string>() },
    } as unknown as GatewayRuntime
    const catalog = new ModelCatalog(runtime)

    const domestic = await catalog.resolve('cn:deepseek-v4.1-flash', settings)
    expect(domestic).toMatchObject({
      id: 'buddy/deepseek-v4.1-flash',
      provider: 'buddy',
      upstreamId: 'deepseek-v4.1-flash',
    })
    expect(domestic.aliases).toContain('cn:deepseek-v4.1-flash')

    const oversea = await catalog.resolve('global:gpt-5.5', settings)
    expect(oversea).toMatchObject({
      id: 'workbuddy/gpt-5.5',
      provider: 'workbuddy',
      upstreamId: 'gpt-5.5',
    })
    expect(oversea.aliases).toContain('global:gpt-5.5')

    expect((await catalog.list(settings)).map((model) => model.id)).toEqual([
      'buddy/deepseek-v4.1-flash',
      'workbuddy/gpt-5.5',
    ])
  })

  it('enriches capabilities and gives undeclared models a usable default level', async () => {
    const runtime = {
      llm: {
        listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
        listModels: vi.fn(async () => [
          { id: 'reasoner', name: 'Reasoner' },
          { id: 'plain', name: 'Plain' },
        ]),
        resolveModelInfo: vi.fn(async (_provider: string, model: string) => model === 'reasoner'
          ? {
              provider: 'provider-a', id: 'reasoner', name: 'Reasoner',
              context: { contextWindow: 200_000 }, defaultMaxTokens: 64_000,
              inputModalities: ['text'],
              reasoning: {
                efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
                defaultEffort: 'high',
              },
            }
          : { provider: 'provider-a', id: 'plain', name: 'Plain', context: { contextWindow: 128_000 } }),
      },
      accountPool: { disabledModelsFor: () => new Set<string>() },
    } as unknown as GatewayRuntime
    const catalog = new ModelCatalog(runtime)
    const models = await catalog.list(settings)
    const reasoner = models.find((model) => model.upstreamId === 'reasoner')
    expect(reasoner).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000, defaultReasoningEffort: 'high' })
    expect(reasoner?.reasoningEfforts?.map((effort) => effort.id)).toEqual(['low', 'high'])
    expect(pickReasoningEffort(reasoner!, 'low')).toBe('low')
    expect(pickReasoningEffort(reasoner!, 'bogus')).toBe('high')
    const plain = models.find((model) => model.upstreamId === 'plain')
    expect(plain).toMatchObject({ syntheticReasoning: true, defaultReasoningEffort: 'medium' })
    expect(pickReasoningEffort(plain!, 'high')).toBe('medium')
  })

  it('passes an unlisted legacy id through for a known provider but rejects unknown namespaces', async () => {
    const catalog = new ModelCatalog(catalogRuntime())
    await expect(catalog.resolve('cn:deepseek-v4.1-flash', settings)).rejects.toThrow('Unknown model')
    await expect(catalog.resolve('nope:deepseek-v4.1-flash', settings)).rejects.toThrow('Unknown model')
  })
})

describe('OpenAI request parsing', () => {
  it('restores assistant tool calls and tool results', async () => {
    const parsed = await parseMessagesForOpenAi([
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

  it('restores Responses function-call history', async () => {
    const parsed = await parseResponsesInput([
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"found":true}' },
    ], { provider: 'provider-a', model: 'shared' })

    expect(parsed.messages).toHaveLength(2)
    expect(JSON.stringify(parsed.messages)).toContain('tool-call')
    expect(JSON.stringify(parsed.messages)).toContain('tool-result')
  })

  it('rejects image inputs when the attachment service is unavailable', async () => {
    await expect(parseMessagesForOpenAi([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
    ], { provider: 'provider-a', model: 'shared' }))
      .rejects.toThrow(OpenAiRequestError)
  })

  it('stores a data URL image through the attachment writer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-images-'))
    const store = new LocalAttachmentStore(new Context(), root)
    try {
      const parsed = await parseMessagesForOpenAi([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
          ],
        },
      ], { provider: 'provider-a', model: 'shared' }, store)

      const content = parsed.messages[0]?.content ?? []
      expect(content.map((block) => block.type)).toEqual(['text', 'image'])
      const image = content[1]
      if (image?.type !== 'image') throw new Error('expected an image block')
      expect(image.attachment.mediaType).toBe('image/png')
      expect(image.attachment.width).toBe(1)
      await expect(store.readImage(image.attachment)).resolves.toMatchObject({ ref: image.attachment })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects bytes whose magic number contradicts the declared type', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-images-'))
    const store = new LocalAttachmentStore(new Context(), root)
    try {
      const png = new Uint8Array(Buffer.from(PNG_1X1, 'base64'))
      await expect(store.saveImage({ data: png, mediaType: 'image/jpeg' }))
        .rejects.toThrow(/does not match/u)
      await expect(store.saveImage({ data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }))
        .rejects.toThrow(/not a supported raster image/u)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
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
