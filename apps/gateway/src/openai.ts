import { randomUUID } from 'node:crypto'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
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
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
  reasoningEfforts?: readonly PublicReasoningEffort[]
  defaultReasoningEffort?: string
  /** True when the level is a Codex compatibility placeholder and must not be sent upstream. */
  syntheticReasoning?: boolean
}

export interface PublicReasoningEffort {
  id: string
  name: string
  description?: string
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
  reasoningEffort?: string
}

export interface ImageInputWriter {
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
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
  /** Facts from a terminal `error`/`aborted` finish chunk; drives the thrown error. */
  failure?: { message?: string; code?: string }
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
        throw new OpenAiRequestError('Image input is only supported in user messages.', 400, 'unsupported_image_input')
      }
      return ''
    }).join('')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

function normalizeImageMediaType(value: string | undefined): ImageMediaType | undefined {
  const normalized = value?.toLowerCase().split(';', 1)[0]?.trim()
  if (normalized === 'image/jpg') return 'image/jpeg'
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp' || normalized === 'image/gif') {
    return normalized
  }
  return undefined
}

function imageUrlFromPart(record: Record<string, unknown>): string | undefined {
  const direct = asString(record.image_url)
  if (direct !== undefined && direct.length > 0) return direct
  return asString(asRecord(record.image_url)?.url)
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  const match = /^172\.(\d{1,3})\./.exec(host)
  if (match !== null) {
    const second = Number(match[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

async function imagePartFromOpenAi(
  part: Record<string, unknown>,
  writer: ImageInputWriter | undefined,
): Promise<{ type: 'image'; attachment: ImageAttachmentRef }> {
  if (writer === undefined) throw new OpenAiRequestError('Image input requires the attachment service.', 400, 'unsupported_image_input')
  const url = imageUrlFromPart(part)
  if (url === undefined || url.length === 0) throw new OpenAiRequestError('Image input requires image_url.', 400, 'invalid_image_input')

  let data: Uint8Array
  let mediaType: ImageMediaType | undefined
  let name: string | undefined
  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(url)
  if (dataUrl !== null) {
    mediaType = normalizeImageMediaType(dataUrl[1] ?? undefined)
    if (mediaType === undefined) throw new OpenAiRequestError('Only PNG, JPEG, WebP, and GIF images are supported.', 400, 'unsupported_image_type')
    // Buffer.from is lenient and would silently drop junk, so the payload is
    // checked against the base64 alphabet before it is trusted.
    const payload = (dataUrl[2] ?? '').replace(/\s+/g, '')
    if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
      throw new OpenAiRequestError('Image data URL is not valid base64.', 400, 'invalid_image_input')
    }
    data = new Uint8Array(Buffer.from(payload, 'base64'))
  } else {
    let parsed: URL
    try { parsed = new URL(url) } catch {
      throw new OpenAiRequestError('Image URL is invalid.', 400, 'invalid_image_input')
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || isPrivateHostname(parsed.hostname)) {
      throw new OpenAiRequestError('Remote image URL must be a public http(s) address.', 400, 'invalid_image_input')
    }
    let response: Response
    try {
      response = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      throw new OpenAiRequestError(`Failed to download image: ${error instanceof Error ? error.message : String(error)}`, 400, 'invalid_image_input')
    }
    if (!response.ok) throw new OpenAiRequestError(`Image download failed with HTTP ${response.status}.`, 400, 'invalid_image_input')
    mediaType = normalizeImageMediaType(response.headers.get('content-type') ?? undefined)
    if (mediaType === undefined) throw new OpenAiRequestError('Remote image has an unsupported content type.', 400, 'unsupported_image_type')
    data = new Uint8Array(await response.arrayBuffer())
    name = decodeURIComponent(parsed.pathname.split('/').pop() ?? '') || undefined
  }

  try {
    const attachment = await writer.saveImage({
      data,
      mediaType,
      ...name === undefined ? {} : { name },
    })
    return { type: 'image', attachment }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new OpenAiRequestError(`Image input was rejected: ${message}`, 400, 'invalid_image_input')
  }
}

async function contentBlocksFromOpenAi(
  content: unknown,
  writer: ImageInputWriter | undefined,
): Promise<Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: content === null || content === undefined ? '' : String(content) }]
  }
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) blocks.push({ type: 'text', text: part })
      continue
    }
    const record = asRecord(part)
    if (record === undefined) continue
    const type = asString(record.type)
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = asString(record.text) ?? ''
      if (text.length > 0) blocks.push({ type: 'text', text })
      continue
    }
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      blocks.push(await imagePartFromOpenAi(record, writer))
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
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

async function messageFromOpenAi(
  raw: unknown,
  target: { provider: string; model: string },
  imageWriter?: ImageInputWriter,
): Promise<{ message?: Message; system?: string }> {
  const record = asRecord(raw)
  if (record === undefined) throw new OpenAiRequestError('Each message must be an object.', 400, 'invalid_message')
  const role = asString(record.role)
  if (role === 'system' || role === 'developer') {
    return { system: asContentText(record.content) }
  }
  if (role === 'user') {
    return {
      message: createUserMessage({
        content: await contentBlocksFromOpenAi(record.content, imageWriter),
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

export async function parseMessagesForOpenAi(
  messages: unknown,
  target: { provider: string; model: string },
  imageWriter?: ImageInputWriter,
): Promise<{ messages: Message[]; system?: string }> {
  if (!Array.isArray(messages)) throw new OpenAiRequestError('messages must be an array.', 400, 'invalid_messages')
  const result: Message[] = []
  const systems: string[] = []
  for (const raw of messages) {
    const parsed = await messageFromOpenAi(raw, target, imageWriter)
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

const REASONING_EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'Disables reasoning for the fastest responses',
  minimal: 'Minimal reasoning for the fastest responses',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
}

function reasoningEffortLabel(id: string): string {
  if (id.length === 0) return id
  return id.slice(0, 1).toUpperCase() + id.slice(1)
}

/** Pick the closest effort the model actually accepts instead of failing the turn. */
export function pickReasoningEffort(model: PublicModel, requested: unknown): string | undefined {
  const efforts = model.reasoningEfforts ?? []
  if (efforts.length === 0) return undefined
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted.length > 0 && efforts.some((effort) => effort.id === wanted)) return wanted
  const fallback = model.defaultReasoningEffort
  if (fallback !== undefined && efforts.some((effort) => effort.id === fallback)) return fallback
  return efforts[0]?.id
}

/** Resolve adapter-owned context, output cap, modalities, and effort metadata in parallel. */
async function enrichModelCapabilities(runtime: GatewayRuntime, models: PublicModel[]): Promise<void> {
  if (typeof runtime.llm.resolveModelInfo !== 'function') return
  const queue = [...models]
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (;;) {
      const model = queue.shift()
      if (model === undefined) return
      try {
        const info = await runtime.llm.resolveModelInfo(model.provider, model.upstreamId)
        if (info.context?.contextWindow !== undefined) model.contextWindow = info.context.contextWindow
        if (info.defaultMaxTokens !== undefined) model.maxTokens = info.defaultMaxTokens
        if (info.inputModalities !== undefined) model.inputModalities = info.inputModalities
        const declared = info.reasoning
        const efforts = declared?.efforts ?? []
        if (efforts.length > 0) {
          model.reasoningEfforts = efforts.map((effort) => ({
            id: String(effort.id),
            name: effort.name,
            ...effort.description !== undefined ? { description: effort.description } : {},
          }))
          if (declared?.defaultEffort !== undefined) model.defaultReasoningEffort = String(declared.defaultEffort)
        } else if (declared?.defaultEffort !== undefined) {
          const id = String(declared.defaultEffort)
          model.reasoningEfforts = [{
            id,
            name: reasoningEffortLabel(id),
            description: REASONING_EFFORT_DESCRIPTIONS[id],
          }]
          model.defaultReasoningEffort = id
        }
        if (model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0) {
          model.reasoningEfforts = [{
            id: 'medium',
            name: 'Default',
            description: 'Uses the provider default reasoning behavior',
          }]
          model.defaultReasoningEffort = 'medium'
          model.syntheticReasoning = true
        }
      } catch {
        // Capability enrichment is best effort; listing must still succeed.
      }
    }
  })
  await Promise.all(workers)
}

function matchesAllowed(modelId: string, settings: GatewaySettings): boolean {
  if (settings.allowedModels.length === 0) return true
  return settings.allowedModels.some((pattern) => wildcardMatch(pattern, modelId))
}

/**
 * Older Codex / CC Switch model catalogs were generated against the original
 * WorkBuddy gateway, which addressed its two upstreams as `cn:<model>` and
 * `global:<model>`. sub2api names the same providers buddy/workbuddy, so map
 * the legacy namespace onto them instead of rejecting the request outright.
 */
const LEGACY_MODEL_NAMESPACES: Record<string, string> = {
  cn: 'buddy',
  global: 'workbuddy',
}

const LEGACY_NAMESPACE_BY_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_MODEL_NAMESPACES).map(([namespace, provider]) => [provider, namespace]),
)

function splitLegacyModelId(model: string): { provider: string; upstreamId: string } | undefined {
  const colon = model.indexOf(':')
  if (colon <= 0) return undefined
  const provider = LEGACY_MODEL_NAMESPACES[model.slice(0, colon).toLowerCase()]
  const upstreamId = model.slice(colon + 1)
  if (provider === undefined || upstreamId.length === 0) return undefined
  return { provider, upstreamId }
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

    const legacy = splitLegacyModelId(model)
    if (legacy !== undefined && this.isKnownProvider(legacy.provider, state)) {
      return {
        id: publicModelId(legacy.provider, legacy.upstreamId),
        provider: legacy.provider,
        upstreamId: legacy.upstreamId,
        name: legacy.upstreamId,
        aliases: [],
      }
    }

    const slash = model.indexOf('/')
    if (slash > 0) {
      const provider = model.slice(0, slash)
      const upstreamId = model.slice(slash + 1)
      if (this.isKnownProvider(provider, state)) {
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

  private isKnownProvider(provider: string, state: CatalogState): boolean {
    return state.models.some((item) => item.provider === provider)
      || this.runtime.llm.listProviders().some((item) => item.id === provider)
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
          inputModalities: entry.inputModalities,
        })
      }
    }
    await enrichModelCapabilities(this.runtime, models)
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
    for (const model of models) {
      const namespace = LEGACY_NAMESPACE_BY_PROVIDER[model.provider]
      if (namespace === undefined) continue
      const alias = `${namespace}:${model.upstreamId}`
      model.aliases = [...model.aliases, alias]
      byId.set(alias, model)
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
    ...request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort as never } : {},
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
  // A terminal error/aborted finish means the upstream turn produced no
  // usable answer (rate limited, policy blocked, or an empty completed
  // response). Surfacing it as an error is required: returning a 200 with an
  // empty message makes clients such as Codex end the session silently.
  if (state.finishReason === 'error') throw upstreamFailureError(state.failure)
  if (state.text.length === 0 && state.reasoning.length === 0 && state.toolCalls.size === 0) {
    throw new OpenAiRequestError(
      `${request.provider}: model returned a completed response with no content`,
      502,
      'empty_response',
    )
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
      else if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        // Adapters report upstream failures as a terminal finish chunk instead of
        // throwing (e.g. an HTTP 200 whose SSE carried an error frame, or a
        // completed response with no content). Keep the facts so the caller can
        // raise a real error; swallowing them here is what made Codex end the
        // turn silently on an empty 200.
        state.finishReason = 'error'
        const failure = chunk.reason.failure
        state.failure = {
          ...typeof failure.message === 'string' ? { message: failure.message } : {},
          ...typeof failure.code === 'string' ? { code: failure.code } : {},
        }
      }
      else state.finishReason = 'stop'
      break
    default:
      break
  }
}

/** Provider-neutral failure code -> HTTP status, so callers can act on it. */
const UPSTREAM_STATUS_BY_CODE: Record<string, number> = {
  RATE_LIMIT: 429,
  QUOTA_EXCEEDED: 429,
  AUTH: 401,
  MISSING_CREDENTIAL: 401,
  INVALID_REQUEST: 400,
  UNSUPPORTED_CONTENT: 400,
  NOT_FOUND: 404,
}

/** Turn a terminal adapter failure into an HTTP error instead of an empty 200. */
function upstreamFailureError(failure: StreamState['failure']): OpenAiRequestError {
  const code = failure?.code ?? 'upstream_error'
  const status = UPSTREAM_STATUS_BY_CODE[code] ?? 502
  const message = failure?.message !== undefined && failure.message.length > 0
    ? failure.message
    : `Upstream model call failed (${code}).`
  return new OpenAiRequestError(message, status, code.toLowerCase())
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

export function responseOutput(result: CompletionResult): Array<Record<string, unknown>> {
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
  output?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: output ?? responseOutput(result),
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

export async function parseResponsesInput(
  input: unknown,
  target: { provider: string; model: string },
  imageWriter?: ImageInputWriter,
): Promise<{ messages: Message[]; system?: string }> {
  if (typeof input === 'string') {
    return {
      messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } })],
    }
  }
  if (!Array.isArray(input)) throw new OpenAiRequestError('input must be a string or an array.', 400, 'invalid_input')
  const messages: Message[] = []
  const systems: string[] = []
  // Codex 先集中下发一轮里的**多个** function_call，再集中下发它们的输出
  // （顺序是 call A、call B、result A、result B）。逐条落成独立 assistant 消息时，
  // 发往腾讯系上游就变成 `assistant(tool_calls:[A])`、`assistant(tool_calls:[B])`、
  // `tool A`、`tool B`；而后端要求工具结果**紧跟**声明它的那条 assistant，
  // 于是整个会话被 400 拒绝（「模型无法处理此请求 / 工具记录不完整」）。
  // 实测 workbuddy/deepseek-v4.1-flash：上述交错形状 400，成组形状 200。
  // 把连续的 function_call 合并进**同一条** assistant 消息即还原 OpenAI 的
  // 并行工具调用形状，结果消息的顺序也随之对上。
  const pendingToolCalls: Array<{ type: 'tool-call'; id: never; name: string; arguments: string }> = []
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    messages.push(createAssistantMessage({
      content: pendingToolCalls.splice(0, pendingToolCalls.length),
      source: { provider: target.provider, model: target.model },
    }))
  }
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
      pendingToolCalls.push({
        type: 'tool-call',
        id: callId as never,
        name,
        arguments: asString(record.arguments) ?? '{}',
      })
      continue
    }
    // 任何非 function_call 条目都意味着这一批并行调用已经结束。
    flushToolCalls()
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      messages.push(createUserMessage({
        content: await contentBlocksFromOpenAi([record], imageWriter),
        source: { kind: 'user' },
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
        content: await contentBlocksFromOpenAi(record.content, imageWriter),
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
  flushToolCalls()
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
