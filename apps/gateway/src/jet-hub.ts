import { randomUUID } from 'node:crypto'
import { asRecord, asString } from './utils.js'

type JetHubHandler = (request: Request) => Promise<Response>

interface RegisteredFetch {
  path?: string
  methods?: readonly string[]
  requestBody?: string
  fetch: JetHubHandler
}

export interface JetHubRegistration {
  fetch: {
    register(options: RegisteredFetch): () => void
  }
}

/**
 * Small typed facade over the upstream Jet Hub RPC endpoint.
 *
 * The upstream plugin owns the account pool, login flows, credential refresh,
 * and provider-specific behavior. Keeping this boundary as RPC avoids a second
 * implementation of those rules in the gateway.
 */
export class JetHubClient {
  private handler: JetHubHandler | undefined

  setHandler(handler: JetHubHandler): void {
    this.handler = handler
  }

  clearHandler(handler?: JetHubHandler): void {
    if (handler === undefined || this.handler === handler) this.handler = undefined
  }

  get available(): boolean {
    return this.handler !== undefined
  }

  async call<T = unknown>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.handler === undefined) throw new Error('Jet Hub RPC is not available')
    const rpcId = randomUUID()
    const request = new Request('http://sub2api.local/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'jet-hub',
        payload: { method, payload },
      }),
      signal,
    })
    const response = await this.handler(request)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      throw new Error(`Jet Hub returned invalid JSON (${response.status})`)
    }

    const envelope = asRecord(parsed)
    const result = asRecord(envelope?.result)
    if (envelope?.type !== 'server-response' || result === undefined) {
      throw new Error('Jet Hub returned an invalid RPC response')
    }
    if (result.ok !== true) {
      const error = asRecord(result.error)
      const message = asString(error?.message) || `Jet Hub RPC ${method} failed`
      const code = asString(error?.code)
      const suffix = code === undefined ? '' : ` [${code}]`
      throw new Error(`${message}${suffix}`)
    }
    return result.value as T
  }
}
