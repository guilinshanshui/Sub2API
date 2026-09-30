import { randomUUID } from 'node:crypto'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm/message'
import type { GatewayRuntime } from './runtime.js'
import type { GatewaySettings } from './types.js'
import { asBoolean, asNumber, asRecord, asString, wildcardMatch } from './utils.js'

export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'invalid_request_error',
  ) {
    super(message)
    this.name = 'OpenAiRequestError'
  }
}

export interface PublicModel {
  id: string
  provider: string
  upstreamId: string
  name: string
  description?: string
  aliases: string[]
}

export interface CompletionToolCall {
  id: string
  name: string
  arguments: string
}

export interface CompletionResult {
  text: string
  reasoning: string
  toolCalls: CompletionToolCall[]
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

export interface CompletionRequest {
  provider: string
  model: string
  publicModel: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

interface CatalogState {
  loadedAt: number
  models: PublicModel[]
  byId: Map<string, PublicModel>
  byBareId: Map<string, PublicModel[]>
}

interface StreamState {
  text: string
  reasoning: string
  toolCalls: Map<number, CompletionToolCall>
  finishReason: CompletionResult['finishReason']
  usage: CompletionResult['usage']
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) return value
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

function asContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      const record = asRecord(part)
      const type = asString(record?.type)
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        return asString(record?.text) ?? ''
      }
      if (type === 'image_url' || type === 'input_image' || type === 'image') {
        throw new OpenAiRequestError('Image input is not supported by this gateway yet.', 400, 'unsupported_image_input')
      }
      return ''
    }).join('')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

function toToolSchema(tool: unknown): ToolSchema {
  const record = asRecord(tool)
  if (record?.type !== 'function') throw new OpenAiRequestError('Only function tools are supported.', 400, 'unsupported_tool')
  const fn = asRecord(record.function)
  const name = asString(fn?.name)
  if (name === undefined || name.length === 0) throw new OpenAiRequestError('Tool function name is required.', 400, 'invalid_tool')
  const parameters = asRecord(fn?.parameters) ?? { type: 'object', properties: {} }
  return {
    name,
    description: asString(fn?.description) ?? '',
    parameters,
  }
}

function parseStop(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.length > 0 ? [value] : undefined
  if (Array.isArray(value)) {
    const result = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return result.length > 0 ? result : undefined
  }
  return undefined
}

function messageFromOpenAi(
  raw: unknown,
  target: { provider: string; model: string },
): { message?: Message; system?: string } {
  const record = asRecord(raw)
  if (record === undefined) throw new OpenAiRequestError('Each message must be an object.', 400, 'invalid_message')
  const role = asString(record.role)
  if (role === 'system' || role === 'developer') {
    return { system: asContentText(record.content) }
  }
  if (role === 'user') {
    return {
      message: createUserMessage({
        content: [{ type: 'text', text: asContentText(record.content) }],
        source: { kind: 'user' },
      }),
    }
  }
  if (role === 'assistant') {
    const content = asContentText(record.content)
    const blocks: Message['content'] = []
    if (content.length > 0) blocks.push({ type: 'text', text: content })
    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : []
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall)
      const fn = asRecord(call?.function)
      const id = asString(call?.id) ?? randomUUID()
      const name = asString(fn?.name) ?? ''
      const args = asString(fn?.arguments) ?? '{}'
      blocks.push({ type: 'tool-call', id: id as never, name, arguments: args })
    }
    return {
      message: createAssistantMessage({
        content: blocks,
        source: { provider: target.provider, model: target.model },
      }),
    }
  }
  if (role === 'tool') {
    const id = asString(record.tool_call_id)
    if (id === undefined) throw new OpenAiRequestError('Tool messages require tool_call_id.', 400, 'invalid_tool_message')
    const text = asContentText(record.content)
    return {
      message: createToolResultMessage({
        callId: id as never,
        content: [{ type: 'text', text }],
        isError: false,
      }),
    }
  }
  throw new OpenAiRequestError(`Unsupported message role: ${role ?? 'unknown'}`, 400, 'invalid_message')
}

export function parseMessagesForOpenAi(
  messages: unknown,
  target: { provider: string; model: string },
): { messages: Message[]; system?: string } {
  if (!Array.isArray(messages)) throw new OpenAiRequestError('messages must be an array.', 400, 'invalid_messages')
  const result: Message[] = []
  const systems: string[] = []
  for (const raw of messages) {
    const parsed = messageFromOpenAi(raw, target)
    if (parsed.message !== undefined) result.push(parsed.message)
    if (parsed.system !== undefined && parsed.system.length > 0) systems.push(parsed.system)
  }
  return {
    messages: result,
    system: systems.length > 0 ? systems.join('\n\n') : undefined,
  }
}

function publicModelId(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

function matchesAllowed(modelId: string, settings: GatewaySettings): boolean {
  if (settings.allowedModels.length === 0) return true
  return settings.allowedModels.some((pattern) => wildcardMatch(pattern, modelId))
}

export class ModelCatalog {
  private state: CatalogState | undefined

  constructor(private readonly runtime: GatewayRuntime) {}

  async list(settings: GatewaySettings, force = false): Promise<PublicModel[]> {
    const state = await this.ensure(force)
    return state.models.filter((model) => this.isAllowed(model, settings))
  }

  isAllowed(model: PublicModel, settings: GatewaySettings): boolean {
    return !this.isDisabled(model) && matchesAllowed(model.id, settings)
  }

  private isDisabled(model: PublicModel): boolean {
    const lookup = this.runtime.accountPool?.disabledModelsFor
    return typeof lookup === 'function'
      ? lookup.call(this.runtime.accountPool, model.provider).has(model.upstreamId)
      : false
  }

  async resolve(model: string, settings: GatewaySettings): Promise<PublicModel> {
    const state = await this.ensure(false)
    const exact = state.byId.get(model)
    if (exact !== undefined) return exact

    const slash = model.indexOf('/')
    if (slash > 0) {
      const provider = model.slice(0, slash)
      const upstreamId = model.slice(slash + 1)
      const knownProvider = state.models.some((item) => item.provider === provider)
      if (knownProvider || this.runtime.llm.listProviders().some((item) => item.id === provider)) {
        return {
          id: publicModelId(provider, upstreamId),
          provider,
          upstreamId,
          name: upstreamId,
          aliases: [],
        }
      }
    }

    const bare = state.byBareId.get(model) ?? []
    if (bare.length === 1) return bare[0] as PublicModel

    if (settings.defaultProvider.length > 0 && settings.defaultModel.length > 0) {
      if (model === settings.defaultModel || model === publicModelId(settings.defaultProvider, settings.defaultModel)) {
        return {
          id: publicModelId(settings.defaultProvider, settings.defaultModel),
          provider: settings.defaultProvider,
          upstreamId: settings.defaultModel,
          name: settings.defaultModel,
          aliases: [],
        }
      }
    }

    if (bare.length > 1) {
      throw new OpenAiRequestError(`Model "${model}" is ambiguous; use provider/model.`, 400, 'ambiguous_model')
    }
    throw new OpenAiRequestError(`Unknown model: ${model}`, 404, 'model_not_found')
  }

  private async ensure(force: boolean): Promise<CatalogState> {
    if (!force && this.state !== undefined && Date.now() - this.state.loadedAt < 30_000) return this.state
    const models: PublicModel[] = []
    for (const provider of this.runtime.llm.listProviders()) {
      let entries: LlmModelInfo[]
      try {
        entries = await this.runtime.llm.listModels(provider.id)
      } catch {
        entries = []
      }
      for (const entry of entries) {
        models.push({
          id: publicModelId(provider.id, entry.id),
          provider: provider.id,
          upstreamId: entry.id,
          name: entry.name,
          description: entry.description,
          aliases: [],
        })
      }
    }
    const byId = new Map(models.map((model) => [model.id, model]))
    const byBareId = new Map<string, PublicModel[]>()
    for (const model of models) {
      const list = byBareId.get(model.upstreamId) ?? []
      list.push(model)
      byBareId.set(model.upstreamId, list)
    }
    for (const [bare, list] of byBareId) {
      if (list.length === 1) {
        const model = list[0] as PublicModel
        model.aliases = [...model.aliases, bare]
        byId.set(bare, model)
      }
    }
    this.state = { loadedAt: Date.now(), models, byId, byBareId }
    return this.state
  }
}

export async function createCompletion(
  runtime: GatewayRuntime,
  request: CompletionRequest,
  signal: AbortSignal,
  onChunk?: (chunk: StreamChunk, state: StreamState) => void,
): Promise<CompletionResult> {
  const config: LlmCallConfig = {
    provider: request.provider,
    model: request.model,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    stop: request.stop,
  }
  const prepared = await runtime.llm.prepareCall(config, signal)
  const options: GenerateOptions = {
    ...prepared.config,
    messages: request.messages,
    system: request.system,
    tools: request.tools,
    signal,
  }
  const state: StreamState = {
    text: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }
  for await (const chunk of prepared.stream(options)) {
    applyChunk(state, chunk)
    onChunk?.(chunk, state)
  }
  return {
    text: state.text,
    reasoning: state.reasoning,
    toolCalls: [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    finishReason: state.finishReason,
    usage: state.usage,
  }
}

function applyChunk(state: StreamState, chunk: StreamChunk): void {
  switch (chunk.type) {
    case 'text-delta':
      state.text += chunk.text
      break
    case 'reasoning-delta':
      state.reasoning += chunk.text
      break
    case 'tool-call-delta': {
      const current = state.toolCalls.get(chunk.index) ?? {
        id: chunk.id,
        name: chunk.name ?? '',
        arguments: '',
      }
      if (chunk.name !== undefined) current.name = chunk.name
      current.arguments += chunk.argumentsDelta
      state.toolCalls.set(chunk.index, current)
      break
    }
    case 'block-end':
      if (chunk.block.type === 'tool-call') {
        state.toolCalls.set(chunk.index, {
          id: chunk.block.id,
          name: chunk.block.name,
          arguments: stripJsonFence(chunk.block.arguments),
        })
      }
      break
    case 'usage':
      state.usage = {
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        totalTokens: chunk.usage.totalTokens ?? chunk.usage.inputTokens + chunk.usage.outputTokens,
      }
      break
    case 'finish':
      if (chunk.reason.kind === 'tool-calls') state.finishReason = 'tool_calls'
      else if (chunk.reason.kind === 'max-tokens') state.finishReason = 'length'
      else if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') state.finishReason = 'error'
      else state.finishReason = 'stop'
      break
    default:
      break
  }
}

export function chatCompletionResponse(
  id: string,
  model: string,
  result: CompletionResult,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: result.text.length > 0 ? result.text : null,
  }
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    },
  }
}

export function chatCompletionChunk(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

export function completionUsageChunk(
  id: string,
  model: string,
  created: number,
  result: CompletionResult,
): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    },
  })
}

function responseOutput(result: CompletionResult): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  if (result.text.length > 0 || result.toolCalls.length === 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: [] }],
    })
  }
  for (const call of result.toolCalls) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    })
  }
  return output
}

export function responsesResponse(
  id: string,
  model: string,
  result: CompletionResult,
  createdAt: number,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: responseOutput(result),
    output_text: result.text,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
}

export function responseCreated(id: string, model: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model,
    output: [],
  }
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function parseToolChoice(value: unknown): void {
  if (value === undefined || value === null) return
  if (value === 'auto' || value === 'none' || value === 'required') return
  const record = asRecord(value)
  if (record?.type === 'function') return
  throw new OpenAiRequestError('Unsupported tool_choice value.', 400, 'unsupported_tool_choice')
}

export function parseResponsesInput(input: unknown, target: { provider: string; model: string }): { messages: Message[]; system?: string } {
  if (typeof input === 'string') {
    return {
      messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } })],
    }
  }
  if (!Array.isArray(input)) throw new OpenAiRequestError('input must be a string or an array.', 400, 'invalid_input')
  const messages: Message[] = []
  const systems: string[] = []
  for (const item of input) {
    const record = asRecord(item)
    if (record === undefined) continue
    const type = asString(record.type)
    if (type === 'function_call') {
      const callId = asString(record.call_id)
      const name = asString(record.name)
      if (callId === undefined || name === undefined || name.length === 0) {
        throw new OpenAiRequestError('function_call requires call_id and name.', 400, 'invalid_input')
      }
      messages.push(createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: callId as never,
          name,
          arguments: asString(record.arguments) ?? '{}',
        }],
        source: { provider: target.provider, model: target.model },
      }))
      continue
    }
    if (type === 'function_call_output') {
      const callId = asString(record.call_id)
      if (callId === undefined) throw new OpenAiRequestError('function_call_output requires call_id.', 400, 'invalid_input')
      messages.push(createToolResultMessage({
        callId: callId as never,
        content: [{ type: 'text', text: asContentText(record.output) }],
        isError: false,
      }))
      continue
    }
    const role = asString(record.role)
    if (role === 'system' || role === 'developer') {
      systems.push(asContentText(record.content))
      continue
    }
    if (role === 'user') {
      messages.push(createUserMessage({
        content: [{ type: 'text', text: asContentText(record.content) }],
        source: { kind: 'user' },
      }))
      continue
    }
    if (role === 'assistant') {
      const content = asContentText(record.content)
      messages.push(createAssistantMessage({
        content: content.length > 0 ? [{ type: 'text', text: content }] : [],
        source: { provider: target.provider, model: target.model },
      }))
    }
  }
  return {
    messages,
    system: systems.length > 0 ? systems.join('\n\n') : undefined,
  }
}

export function isStreaming(value: unknown): boolean {
  return asBoolean(value) === true
}

export function numericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key])
    if (value !== undefined) return value
  }
  return undefined
}
