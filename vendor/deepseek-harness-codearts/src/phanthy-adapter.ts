/**
 * PhanthyCode LLM 适配器。
 *
 * 上游 `/v1/messages` 是 Anthropic Messages 协议：请求侧由 OpenAI wire 转换，
 * 响应侧由 Anthropic SSE 转回 DSH StreamChunk。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlockType,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { readWithIdleTimeout } from './sse.js'
import {
  PHANTHY_CLIENT_ID,
  PHANTHY_FALLBACK_MODEL_IDS,
  PHANTHY_OAUTH_BETA,
  isPhanthyExpired,
  resolvePhanthyModel,
  type PhanthyCredential,
} from './phanthy.js'
import { PHANTHY, type PhanthyFallbackModel, type PhanthyProduct } from './phanthy-product.js'

/** Anthropic 请求消息。 */
type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

/** Anthropic 请求工具。 */
interface AnthropicTool {
  name: string
  description?: string
  input_schema: unknown
}

/** Anthropic SSE 帧类型。 */
type AnthropicEvent = {
  type: 'message_start' | 'message_stop'
  message?: { id?: string; model?: string; usage?: { input_tokens?: number } }
} | {
  type: 'content_block_start'
  index: number
  content_block?: { type?: string; id?: string; name?: string }
} | {
  type: 'content_block_delta'
  index: number
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
} | {
  type: 'content_block_stop'
  index: number
} | {
  type: 'message_delta'
  delta?: { stop_reason?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
} | {
  type: 'error'
  error?: { type?: string; message?: string }
}

/** 适配器构造参数。 */
export interface PhanthyAdapterOptions {
  credentialRef: CredentialRef
  resolveCredential: (modelId?: string) => Promise<PhanthyCredential | undefined>
  refresh: () => Promise<void>
  fetchImpl?: typeof fetch
  accountPool?: AccountPool
  product?: PhanthyProduct
}

/** OpenAI tools → Anthropic tools。 */
function convertTools(tools: ToolSchema[] | undefined): AnthropicTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description.length > 0 ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }))
}

/** reasoning effort → Anthropic thinking。 */
interface AnthropicThinking {
  type: 'enabled' | 'disabled'
  budget_tokens?: number
}

function convertThinking(effort: string | undefined): AnthropicThinking | undefined {
  if (effort === undefined || effort.length === 0) return undefined
  if (effort === 'none' || effort === 'minimal' || effort === 'off' || effort === 'disabled') {
    return { type: 'disabled' }
  }
  return { type: 'enabled', budget_tokens: 4096 }
}

/** OpenAI wire 消息 → Anthropic messages。 */
interface AnthropicWire {
  system: string
  messages: AnthropicMessage[]
}

export function convertOpenAiWireToAnthropic(messages: Array<Record<string, unknown>>): AnthropicWire {
  const systemParts: string[] = []
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    const role = String(message.role)
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : String(message.content ?? '')
      if (text.trim().length > 0) systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = String(message.tool_call_id ?? '')
      const text = typeof message.content === 'string' ? message.content : String(message.content ?? '')
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: [{ type: 'text', text }],
        }],
      })
      continue
    }

    if (role === 'assistant') {
      const content: Array<Record<string, unknown>> = []
      const text = typeof message.content === 'string' ? message.content : ''
      if (text.length > 0) content.push({ type: 'text', text })
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const rawCall of toolCalls) {
        const call = rawCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
        const name = typeof call.function?.name === 'string' ? call.function.name : ''
        if (name.length === 0) continue
        const args = typeof call.function?.arguments === 'string' && call.function.arguments.trim().length > 0
          ? call.function.arguments
          : '{}'
        content.push({
          type: 'tool_use',
          id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `tool_${randomUUID()}`,
          name,
          input: JSON.parse(args) as unknown,
        })
      }
      converted.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] })
      continue
    }

    if (role === 'user') {
      if (typeof message.content === 'string') {
        converted.push({ role: 'user', content: message.content.length > 0 ? message.content : ' ' })
        continue
      }
      if (Array.isArray(message.content)) {
        const content = message.content
          .filter((part): part is { type: string; text?: unknown } =>
            typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
          .map((part) => ({ type: 'text', text: String(part.text ?? '') }))
        converted.push({ role: 'user', content: content.length > 0 ? content : ' ' })
        continue
      }
      converted.push({ role: 'user', content: ' ' })
    }
  }
  return { system: systemParts.join('\n\n'), messages: converted }
}

/** OpenAI stop_reason 映射。 */
function mapStopReason(reason: string | undefined): 'stop' | 'tool-calls' | 'max-tokens' {
  if (reason === 'tool_use' || reason === 'stop_sequence') return reason === 'tool_use' ? 'tool-calls' : 'stop'
  if (reason === 'max_tokens') return 'max-tokens'
  return 'stop'
}

/** 解析 SSE data 行。 */
function parseSseData(line: string): AnthropicEvent | undefined {
  if (!line.startsWith('data:')) return undefined
  const raw = line.slice(5).trim()
  if (raw.length === 0 || raw === '[DONE]') return undefined
  try {
    return JSON.parse(raw) as AnthropicEvent
  } catch {
    return undefined
  }
}

/** PhanthyCode 适配器。 */
export class PhanthyAdapter extends LlmAdapter {
  private readonly product: PhanthyProduct
  private readonly fetchImpl: typeof fetch
  private readonly fallbackIndex: ReadonlyMap<string, PhanthyFallbackModel>

  constructor(private readonly options: PhanthyAdapterOptions) {
    super()
    this.product = options.product ?? PHANTHY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  listAllModels(): readonly { id: string; name: string }[] {
    return this.product.fallbackModels.map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(): readonly ('text')[] {
    return ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    return this.product.fallbackModels.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(),
    }
    if (fallback !== undefined && fallback.contextWindow > 0) resolved.context = { contextWindow: fallback.contextWindow }
    if (fallback !== undefined && fallback.maxTokens > 0) resolved.defaultMaxTokens = fallback.maxTokens
    resolved.reasoning = phanthyReasoningInfo()
    return resolved
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isPhanthyExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    let currentAccountId = ''
    if (credential !== undefined) {
      currentAccountId = await this.options.accountPool?.findAccountIdByCredential(
        this.product.id,
        credential.access_token,
      ) ?? ''
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('phanthy: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const wire = serializeMessages(options.messages)
    const anthropic = convertOpenAiWireToAnthropic(wire)
    const system = [options.system, anthropic.system]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n')

    const requestedMaxTokens = options.maxTokens ?? 8192
    const thinking = convertThinking(options.reasoningEffort)
    const budget = thinking?.type === 'enabled' ? thinking.budget_tokens : undefined
    const maxTokens = Math.max(
      1024,
      Math.min(65536, budget !== undefined && budget + 1024 > requestedMaxTokens ? budget + 1024 : requestedMaxTokens),
    )

    const body = JSON.stringify({
      model: resolvePhanthyModel(options.model),
      messages: anthropic.messages,
      ...(system.length > 0 ? { system } : {}),
      max_tokens: maxTokens,
      stream: true,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
      ...convertTools(options.tools).length > 0 ? { tools: convertTools(options.tools) } : {},
      ...(thinking !== undefined ? { thinking } : {}),
    })

    const session = String(options.sessionId ?? randomUUID())
    const headers = (): Record<string, string> => ({
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      'Content-Type': 'application/json',
      'User-Agent': 'phanthycode2api/1.0',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': session,
    })

    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.apiBase}/v1/messages`, {
        method: 'POST',
        headers: headers(),
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `phanthy: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error as Error },
        )
      }
      throw error
    }

    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('phanthy: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.fetchImpl(`${this.product.apiBase}/v1/messages`, {
        method: 'POST',
        headers: headers(),
        body,
        signal: options.signal,
      })
    }

    if (!response.ok) {
      if (currentAccountId !== '') {
        await this.options.accountPool?.reportAccountFailure(currentAccountId, `HTTP ${response.status}`)
      }
      const text = await response.text().catch(() => '')
      throw new LlmError(`phanthy: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status })
    }
    if (!response.body) throw new LlmError('phanthy: empty model response body', 'EMPTY_RESPONSE')
    if (currentAccountId !== '') {
      await this.options.accountPool?.reportAccountSuccess(currentAccountId)
    }

    const reader = response.body.getReader()

    const blocks: Array<{ index: number; emitIndex?: number; kind: 'text' | 'reasoning'; text: string }> = []
    const toolCalls: Array<{ index: number; id: string; name: string; args: string }> = []
    let nextIndex = 0
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: string | undefined
    let finished = false

    try {
      let buffer = ''
      while (true) {
        const firstRead = await readWithIdleTimeout(reader, 120_000, 'phanthy', options.signal, 'first-token')
        if (firstRead.done) break
        let value = firstRead.value
        let done: boolean = firstRead.done
        while (!done) {
          buffer += new TextDecoder().decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const event = parseSseData(line)
            if (event === undefined) continue

            if (event.type === 'message_start') {
              inputTokens = event.message?.usage?.input_tokens ?? 0
              continue
            }
            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                toolCalls.push({
                  index: event.index,
                  id: event.content_block.id ?? '',
                  name: event.content_block.name ?? '',
                  args: '',
                })
              } else {
                blocks.push({ index: event.index, kind: event.content_block?.type === 'thinking' ? 'reasoning' : 'text', text: '' })
              }
              continue
            }
            if (event.type === 'content_block_delta') {
              const delta = event.delta
              if (delta?.type === 'text_delta') {
                const target = blocks.find((block) => block.index === event.index)
                if (target === undefined) {
                  blocks.push({ index: event.index, kind: 'text', text: delta.text ?? '' })
                  const fallbackIndex = nextIndex++
                  if ((delta.text ?? '').length > 0) {
                    yield { type: 'block-start', index: fallbackIndex, blockType: 'text' as ContentBlockType }
                    yield { type: 'text-delta', index: fallbackIndex, text: delta.text ?? '' }
                  }
                } else {
                  if (target.text.length === 0) {
                    const mapped = nextIndex++
                    target.emitIndex = mapped
                    yield { type: 'block-start', index: mapped, blockType: 'text' as ContentBlockType }
                  }
                  target.text += delta.text ?? ''
                  yield { type: 'text-delta', index: target.emitIndex!, text: delta.text ?? '' }
                }
              } else if (delta?.type === 'thinking_delta') {
                let target = blocks.find((block) => block.index === event.index)
                if (target === undefined) {
                  target = { index: event.index, kind: 'reasoning', text: delta.thinking ?? '' }
                  blocks.push(target)
                  const mapped = nextIndex++
                  target.emitIndex = mapped
                  yield { type: 'block-start', index: mapped, blockType: 'reasoning' as ContentBlockType }
                } else {
                  if (target.text.length === 0) {
                    const mapped = nextIndex++
                    target.emitIndex = mapped
                    yield { type: 'block-start', index: mapped, blockType: 'reasoning' as ContentBlockType }
                  }
                  target.text += delta.thinking ?? ''
                  yield { type: 'reasoning-delta', index: target.emitIndex!, text: delta.thinking ?? '' }
                }
              } else if (delta?.type === 'input_json_delta') {
                const target = toolCalls.find((call) => call.index === event.index)
                if (target !== undefined) target.args += delta.partial_json ?? ''
              }
              continue
            }
            if (event.type === 'message_delta') {
              stopReason = event.delta?.stop_reason
              outputTokens = event.usage?.output_tokens ?? outputTokens
              continue
            }
            if (event.type === 'error') {
              const message = event.error?.message ?? 'unknown upstream error'
              throw new LlmError(`phanthy: ${message}`, 'UPSTREAM')
            }
          }
          const nextRead = await readWithIdleTimeout(reader, 120_000, 'phanthy', options.signal, 'chunk')
          done = nextRead.done
          value = nextRead.value
        }
      }
    } finally {
      reader.releaseLock()
    }

    for (const tool of toolCalls) {
      if (tool.id.length === 0 || tool.name.length === 0) continue
      const index = nextIndex++
      yield { type: 'block-start', index, blockType: 'tool-call' as ContentBlockType }
      yield {
        type: 'tool-call-delta',
        index,
        id: ToolCallId(tool.id),
        name: tool.name,
        argumentsDelta: tool.args,
      }
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(tool.id),
          name: tool.name,
          arguments: tool.args || '{}',
        },
      }
    }
    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
    }
    if (!finished) {
      yield { type: 'finish', reason: { kind: mapStopReason(stopReason) } }
    }
  }
}

/** 档位元信息。 */
function phanthyReasoningInfo() {
  return {
    efforts: [
      { id: ReasoningEffortId('on'), name: '开启' },
      { id: ReasoningEffortId('off'), name: '关闭' },
    ],
    defaultEffort: ReasoningEffortId('off'),
  }
}

/** 注册 provider 与适配器。 */
export function registerPhanthyLlm(ctx: Context, options: PhanthyAdapterOptions): PhanthyAdapter {
  const product = options.product ?? PHANTHY
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new PhanthyAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
