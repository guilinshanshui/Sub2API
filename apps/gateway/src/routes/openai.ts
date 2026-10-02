import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ApiKeyManager } from '../api-keys.js'
import type { GatewayConfig } from '../config.js'
import type { CompletionRequest, CompletionResult, ModelCatalog, PublicModel } from '../openai.js'
import {
  chatCompletionChunk,
  chatCompletionResponse,
  completionUsageChunk,
  createCompletion,
  isStreaming,
  numericField,
  OpenAiRequestError,
  parseMessagesForOpenAi,
  parseResponsesInput,
  parseToolChoice,
  responseCreated,
  pickReasoningEffort,
  responsesResponse,
  sse,
} from '../openai.js'
import type { GatewayRuntime } from '../runtime.js'
import type { GatewayStorage } from '../storage.js'
import type { ApiKeyRecord } from '../types.js'
import { asRecord, asString } from '../utils.js'

function requestedReasoningEffort(model: PublicModel, body: Record<string, unknown>): string | undefined {
  if (model.syntheticReasoning === true) return undefined
  return pickReasoningEffort(model, body.reasoning_effort ?? asRecord(body.reasoning)?.effort)
}

function publicModelPayload(model: PublicModel): Record<string, unknown> {
  const reasoningLevels = (model.reasoningEfforts ?? []).map((effort) => ({
    effort: effort.id,
    description: effort.description ?? effort.name,
  }))
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.provider,
    permission: [],
    root: model.id,
    parent: null,
    name: model.name,
    description: model.description,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    input_modalities: model.inputModalities,
    supported_reasoning_levels: reasoningLevels,
    ...model.defaultReasoningEffort !== undefined ? { default_reasoning_level: model.defaultReasoningEffort } : {},
    supports_reasoning_summaries: reasoningLevels.length > 0,
  }
}

interface OpenAiRouteOptions {
  apiKeys: ApiKeyManager
  catalog: ModelCatalog
  config: GatewayConfig
  runtime: GatewayRuntime
  storage: GatewayStorage
}

interface ParsedRequest {
  apiKey: ApiKeyRecord
  body: Record<string, unknown>
  model: PublicModel
  publicModel: string
  stream: boolean
  created: number
  id: string
}

function openAiError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof OpenAiRequestError) {
    return reply.code(error.status).send({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: error.code,
      },
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return reply.code(502).send({
    error: {
      message,
      type: 'server_error',
      code: 'upstream_error',
    },
  })
}

function unauthorized(reply: FastifyReply, message = 'Missing or invalid API key.'): FastifyReply {
  reply.header('www-authenticate', 'Bearer realm="sub2api"')
  return reply.code(401).send({
    error: {
      message,
      type: 'authentication_error',
      code: 'invalid_api_key',
    },
  })
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  apiKeys: ApiKeyManager,
): Promise<ApiKeyRecord | undefined> {
  const authorization = request.headers.authorization
    ?? (typeof request.headers['x-api-key'] === 'string' ? `Bearer ${request.headers['x-api-key']}` : undefined)
  const key = await apiKeys.authenticate(authorization)
  if (key === undefined) {
    unauthorized(reply)
    return undefined
  }
  return key
}

function parseModel(body: Record<string, unknown>, settings: ReturnType<GatewayStorage['getSettings']>): string {
  const requested = asString(body.model)
  if (requested !== undefined && requested.length > 0) return requested
  if (settings.defaultProvider.length > 0 && settings.defaultModel.length > 0) {
    return `${settings.defaultProvider}/${settings.defaultModel}`
  }
  throw new OpenAiRequestError('model is required.', 400, 'missing_model')
}

async function prepareRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OpenAiRouteOptions,
): Promise<ParsedRequest | undefined> {
  const apiKey = await authenticate(request, reply, options.apiKeys)
  if (apiKey === undefined) return undefined
  const body = asRecord(request.body)
  if (body === undefined) throw new OpenAiRequestError('Request body must be a JSON object.', 400, 'invalid_body')
  const settings = options.storage.getSettings()
  const publicModel = parseModel(body, settings)
  const model = await options.catalog.resolve(publicModel, settings)
  if (!options.catalog.isAllowed(model, settings)) {
    throw new OpenAiRequestError(`Model is disabled: ${publicModel}`, 404, 'model_not_found')
  }
  if (!options.apiKeys.allowsModel(apiKey, model.id)
    && !options.apiKeys.allowsModel(apiKey, model.upstreamId)
    && !model.aliases.some((alias) => options.apiKeys.allowsModel(apiKey, alias))) {
    throw new OpenAiRequestError(`API key is not allowed to use model: ${publicModel}`, 403, 'model_not_allowed')
  }
  return {
    apiKey,
    body,
    model,
    publicModel,
    stream: isStreaming(body.stream),
    created: Math.floor(Date.now() / 1000),
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
  }
}

function parseChatMessages(body: Record<string, unknown>, model: PublicModel) {
  if (!Array.isArray(body.messages)) throw new OpenAiRequestError('messages must be an array.', 400, 'invalid_messages')
  const messages = body.messages
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => {
      const record = asRecord(tool)
      if (record?.type !== 'function') throw new OpenAiRequestError('Only function tools are supported.', 400, 'unsupported_tool')
      const fn = asRecord(record.function)
      const name = asString(fn?.name)
      if (name === undefined) throw new OpenAiRequestError('Tool function name is required.', 400, 'invalid_tool')
      return {
        name,
        description: asString(fn?.description) ?? '',
        parameters: asRecord(fn?.parameters) ?? { type: 'object', properties: {} },
      }
    })
    : undefined
  parseToolChoice(body.tool_choice)
  return {
    messages,
    tools,
    temperature: numericField(body, ['temperature']),
    maxTokens: numericField(body, ['max_tokens', 'max_completion_tokens']),
    stop: typeof body.stop === 'string'
      ? [body.stop]
      : Array.isArray(body.stop)
        ? body.stop.filter((item): item is string => typeof item === 'string')
        : undefined,
    model,
  }
}

function createTimeoutSignal(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onAborted = () => controller.abort()
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort()
  }
  request.raw.once('aborted', onAborted)
  reply.raw.once('close', onClose)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
      request.raw.off('aborted', onAborted)
      reply.raw.off('close', onClose)
    },
  }
}

async function persistCall(
  options: OpenAiRouteOptions,
  parsed: ParsedRequest,
  startedAt: number,
  status: number,
  result: CompletionResult | undefined,
  error?: unknown,
  logger?: Pick<FastifyRequest['log'], 'warn'>,
): Promise<void> {
  const durationMs = Date.now() - startedAt
  try {
    await options.storage.appendUsage({
      timestamp: Date.now(),
      apiKeyId: parsed.apiKey.id,
      apiKeyName: parsed.apiKey.name,
      provider: parsed.model.provider,
      model: parsed.model.id,
      status,
      stream: parsed.stream,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      totalTokens: result?.usage.totalTokens ?? 0,
      durationMs,
      errorCode: error instanceof OpenAiRequestError ? error.code : error === undefined ? undefined : 'upstream_error',
    })
  } catch (persistError) {
    logger?.warn({ err: persistError, requestId: parsed.id }, 'Failed to persist OpenAI usage record')
  }
  try {
    await options.storage.appendLog({
      timestamp: Date.now(),
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      event: 'openai.request',
      message: error === undefined ? 'OpenAI request completed' : error instanceof Error ? error.message : String(error),
      requestId: parsed.id,
      provider: parsed.model.provider,
      model: parsed.model.id,
      status,
      durationMs,
      metadata: {
        apiKeyId: parsed.apiKey.id,
        stream: parsed.stream,
        inputTokens: result?.usage.inputTokens ?? 0,
        outputTokens: result?.usage.outputTokens ?? 0,
      },
    })
  } catch (persistError) {
    logger?.warn({ err: persistError, requestId: parsed.id }, 'Failed to persist OpenAI log record')
  }
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) return
  reply.raw.write(typeof data === 'string' ? `event: ${event}\ndata: ${data}\n\n` : sse(event, data))
}

function startSse(reply: FastifyReply): void {
  reply.raw.statusCode = 200
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('cache-control', 'no-cache, no-transform')
  reply.raw.setHeader('connection', 'keep-alive')
  reply.raw.setHeader('x-accel-buffering', 'no')
  reply.hijack()
  reply.raw.flushHeaders?.()
}

export function registerOpenAiRoutes(app: FastifyInstance, options: OpenAiRouteOptions): void {
  app.get('/v1/models', async (request, reply) => {
    const apiKey = await authenticate(request, reply, options.apiKeys)
    if (apiKey === undefined) return
    try {
      const settings = options.storage.getSettings()
      const models = await options.catalog.list(settings)
      return {
        object: 'list',
        data: models
          .filter((model) => options.apiKeys.allowsModel(apiKey, model.id)
            || options.apiKeys.allowsModel(apiKey, model.upstreamId)
            || model.aliases.some((alias) => options.apiKeys.allowsModel(apiKey, alias)))
          .map(publicModelPayload),
      }
    } catch (error) {
      return openAiError(reply, error)
    }
  })

  app.post('/v1/chat/completions', async (request, reply) => {
    let parsed: ParsedRequest | undefined
    const startedAt = Date.now()
    let timeout: ReturnType<typeof createTimeoutSignal> | undefined
    try {
      parsed = await prepareRequest(request, reply, options)
      if (parsed === undefined) return
      const chat = parseChatMessages(parsed.body, parsed.model)
      const settings = options.storage.getSettings()
      timeout = createTimeoutSignal(request, reply, settings.requestTimeoutMs)
      const requestOptions: CompletionRequest = {
        provider: parsed.model.provider,
        model: parsed.model.upstreamId,
        publicModel: parsed.model.id,
        reasoningEffort: requestedReasoningEffort(parsed.model, parsed.body),
        messages: [],
        system: undefined,
        tools: chat.tools,
        temperature: chat.temperature,
        maxTokens: chat.maxTokens,
        stop: chat.stop,
      }
      const parsedMessages = await parseMessagesForOpenAi(chat.messages, {
        provider: parsed.model.provider,
        model: parsed.model.upstreamId,
      }, options.runtime.attachments)
      requestOptions.messages = parsedMessages.messages
      requestOptions.system = parsedMessages.system

      if (!parsed.stream) {
        const result = await createCompletion(options.runtime, requestOptions, timeout.signal)
        await persistCall(options, parsed, startedAt, 200, result, undefined, request.log)
        return chatCompletionResponse(parsed.id, parsed.publicModel, result, parsed.created)
      }

      startSse(reply)
      writeSse(reply, 'message', chatCompletionChunk(parsed.id, parsed.publicModel, parsed.created, { role: 'assistant' }))
      const result = await createCompletion(options.runtime, requestOptions, timeout.signal, (chunk) => {
        if (chunk.type === 'text-delta') {
          writeSse(reply, 'message', chatCompletionChunk(parsed!.id, parsed!.publicModel, parsed!.created, { content: chunk.text }))
        } else if (chunk.type === 'reasoning-delta') {
          writeSse(reply, 'message', chatCompletionChunk(parsed!.id, parsed!.publicModel, parsed!.created, { reasoning_content: chunk.text }))
        } else if (chunk.type === 'tool-call-delta') {
          writeSse(reply, 'message', chatCompletionChunk(parsed!.id, parsed!.publicModel, parsed!.created, {
            tool_calls: [{
              index: chunk.index,
              id: chunk.id,
              type: 'function',
              function: {
                name: chunk.name,
                arguments: chunk.argumentsDelta,
              },
            }],
          }))
        }
      })
      const streamOptions = asRecord(parsed.body.stream_options)
      if (streamOptions?.include_usage === true) {
        reply.raw.write(`data: ${completionUsageChunk(parsed.id, parsed.publicModel, parsed.created, result)}\n\n`)
      }
      writeSse(reply, 'message', chatCompletionChunk(parsed.id, parsed.publicModel, parsed.created, {}, result.finishReason))
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
      await persistCall(options, parsed, startedAt, 200, result, undefined, request.log)
    } catch (error) {
      if (parsed !== undefined && reply.raw.headersSent) {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          writeSse(reply, 'error', {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'server_error',
              code: error instanceof OpenAiRequestError ? error.code : 'upstream_error',
            },
          })
          reply.raw.write('data: [DONE]\n\n')
          reply.raw.end()
        }
        await persistCall(
          options,
          parsed,
          startedAt,
          error instanceof OpenAiRequestError ? error.status : 502,
          undefined,
          error,
          request.log,
        )
        return
      }
      if (parsed !== undefined) {
        await persistCall(
          options,
          parsed,
          startedAt,
          error instanceof OpenAiRequestError ? error.status : 502,
          undefined,
          error,
          request.log,
        )
      }
      return openAiError(reply, error)
    } finally {
      timeout?.dispose()
    }
  })

  app.post('/v1/responses', async (request, reply) => {
    let parsed: ParsedRequest | undefined
    const startedAt = Date.now()
    let timeout: ReturnType<typeof createTimeoutSignal> | undefined
    try {
      parsed = await prepareRequest(request, reply, options)
      if (parsed === undefined) return
      const responseInput = await parseResponsesInput(parsed.body.input, {
        provider: parsed.model.provider,
        model: parsed.model.upstreamId,
      }, options.runtime.attachments)
      const instructions = asString(parsed.body.instructions)
      if (instructions !== undefined && instructions.trim().length > 0) {
        responseInput.system = responseInput.system !== undefined && responseInput.system.length > 0
          ? `${instructions}\n\n${responseInput.system}`
          : instructions
      }
      const settings = options.storage.getSettings()
      timeout = createTimeoutSignal(request, reply, settings.requestTimeoutMs)
      const tools = Array.isArray(parsed.body.tools)
        ? parsed.body.tools.map((tool) => {
          const record = asRecord(tool)
          const name = asString(record?.name)
          if (name === undefined) throw new OpenAiRequestError('Tool name is required.', 400, 'invalid_tool')
          return {
            name,
            description: asString(record?.description) ?? '',
            parameters: asRecord(record?.parameters) ?? { type: 'object', properties: {} },
          }
        })
        : undefined
      const requestOptions = {
        provider: parsed.model.provider,
        model: parsed.model.upstreamId,
        publicModel: parsed.model.id,
        reasoningEffort: requestedReasoningEffort(parsed.model, parsed.body),
        messages: responseInput.messages,
        system: responseInput.system,
        tools,
        temperature: numericField(parsed.body, ['temperature']),
        maxTokens: numericField(parsed.body, ['max_output_tokens', 'max_tokens']),
        stop: undefined,
      }
      const responseId = `resp_${randomUUID().replace(/-/g, '')}`
      if (!parsed.stream) {
        const result = await createCompletion(options.runtime, requestOptions, timeout.signal)
        await persistCall(options, parsed, startedAt, 200, result, undefined, request.log)
        return responsesResponse(responseId, parsed.publicModel, result, parsed.created)
      }

      startSse(reply)
      let sequence = 0
      const send = (event: string, data: Record<string, unknown>): void => {
        writeSse(reply, event, { ...data, sequence_number: sequence })
        sequence += 1
      }

      let outputIndex = 0
      let messageItem: { id: string; index: number } | undefined
      let reasoningItem: { id: string; index: number; text: string } | undefined
      const functionItems = new Map<number, { id: string; index: number; callId: string; name: string }>()

      send('response.created', {
        type: 'response.created',
        response: responseCreated(responseId, parsed.publicModel, parsed.created),
      })
      send('response.in_progress', {
        type: 'response.in_progress',
        response: {
          ...responseCreated(responseId, parsed.publicModel, parsed.created),
          status: 'in_progress',
        },
      })

      const result = await createCompletion(options.runtime, requestOptions, timeout.signal, (chunk) => {
        if (chunk.type === 'text-delta') {
          if (messageItem === undefined) {
            messageItem = { id: `msg_${responseId}`, index: outputIndex }
            outputIndex += 1
            send('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: messageItem.index,
              item: {
                id: messageItem.id,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            })
            send('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: messageItem.id,
              output_index: messageItem.index,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            })
          }
          send('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: messageItem.id,
            output_index: messageItem.index,
            content_index: 0,
            delta: chunk.text,
          })
        } else if (chunk.type === 'reasoning-delta') {
          if (reasoningItem === undefined) {
            reasoningItem = { id: `rs_${responseId}`, index: outputIndex, text: '' }
            outputIndex += 1
            send('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: reasoningItem.index,
              item: { id: reasoningItem.id, type: 'reasoning', summary: [] },
            })
          }
          reasoningItem.text += chunk.text
          send('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningItem.id,
            output_index: reasoningItem.index,
            summary_index: 0,
            delta: chunk.text,
          })
        } else if (chunk.type === 'tool-call-delta') {
          let item = functionItems.get(chunk.index)
          if (item === undefined) {
            item = {
              id: `fc_${chunk.id}`,
              index: outputIndex,
              callId: chunk.id,
              name: chunk.name ?? '',
            }
            outputIndex += 1
            functionItems.set(chunk.index, item)
            send('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: item.index,
              item: {
                id: item.id,
                type: 'function_call',
                status: 'in_progress',
                call_id: item.callId,
                name: item.name,
                arguments: '',
              },
            })
          }
          if (chunk.name !== undefined && chunk.name.length > 0) item.name = chunk.name
          send('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: item.index,
            delta: chunk.argumentsDelta,
          })
        }
      })

      // Codex binds streamed deltas to items through matching ids, so close out
      // every item that was opened and mirror those ids in the final response.
      const output: Array<Record<string, unknown>> = []
      if (messageItem === undefined && result.text.length > 0) {
        messageItem = { id: `msg_${responseId}`, index: outputIndex }
        outputIndex += 1
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: messageItem.index,
          item: {
            id: messageItem.id,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        })
        send('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: messageItem.id,
          output_index: messageItem.index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      }
      if (reasoningItem !== undefined) {
        send('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: reasoningItem.id,
          output_index: reasoningItem.index,
          summary_index: 0,
          text: reasoningItem.text,
        })
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: reasoningItem.index,
          item: {
            id: reasoningItem.id,
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: reasoningItem.text }],
          },
        })
      }
      if (messageItem !== undefined) {
        const part = { type: 'output_text', text: result.text, annotations: [] }
        send('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: messageItem.id,
          output_index: messageItem.index,
          content_index: 0,
          text: result.text,
        })
        send('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: messageItem.id,
          output_index: messageItem.index,
          content_index: 0,
          part,
        })
        const item = {
          id: messageItem.id,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [part],
        }
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: messageItem.index,
          item,
        })
        output.push(item)
      } else if (result.text.length === 0 && result.toolCalls.length === 0) {
        const part = { type: 'output_text', text: '', annotations: [] }
        const item = {
          id: `msg_${responseId}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [part],
        }
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', content: [] },
        })
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item,
        })
        outputIndex += 1
        output.push(item)
      }
      for (const call of result.toolCalls) {
        const streamed = [...functionItems.values()].find((item) => item.callId === call.id)
        const id = streamed?.id ?? `fc_${call.id}`
        const index = streamed?.index ?? outputIndex++
        if (streamed === undefined) {
          send('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              id,
              type: 'function_call',
              status: 'in_progress',
              call_id: call.id,
              name: call.name,
              arguments: '',
            },
          })
        }
        send('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: id,
          output_index: index,
          arguments: call.arguments,
        })
        const item = {
          id,
          type: 'function_call',
          status: 'completed',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        }
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: index,
          item,
        })
        output.push(item)
      }

      send('response.completed', {
        type: 'response.completed',
        response: responsesResponse(responseId, parsed.publicModel, result, parsed.created, output),
      })
      reply.raw.end()
      await persistCall(options, parsed, startedAt, 200, result, undefined, request.log)
    } catch (error) {
      if (parsed !== undefined && reply.raw.headersSent) {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          writeSse(reply, 'response.failed', {
            type: 'response.failed',
            response: {
              error: {
                message: error instanceof Error ? error.message : String(error),
                code: error instanceof OpenAiRequestError ? error.code : 'upstream_error',
              },
            },
          })
          reply.raw.end()
        }
        await persistCall(
          options,
          parsed,
          startedAt,
          error instanceof OpenAiRequestError ? error.status : 502,
          undefined,
          error,
          request.log,
        )
        return
      }
      if (parsed !== undefined) {
        await persistCall(
          options,
          parsed,
          startedAt,
          error instanceof OpenAiRequestError ? error.status : 502,
          undefined,
          error,
          request.log,
        )
      }
      return openAiError(reply, error)
    } finally {
      timeout?.dispose()
    }
  })
}
