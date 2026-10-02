export const PROVIDER_IDS = [
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'phanthy',
] as const

export type ProviderId = typeof PROVIDER_IDS[number]

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  codearts: '华为 CodeArts',
  buddy: '腾讯 CodeBuddy',
  workbuddy: 'WorkBuddy (国际版)',
  lobsterai: '有道 LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder 中国版',
  trae: 'TRAE',
  cline: 'Cline',
  loomy: '讯飞 Loomy',
  raccoon: '商汤 Raccoon Work',
  phanthy: 'PhanthyCode',
}

export interface RpcResponse<T = unknown> {
  ok: boolean
  value?: T
  error?: {
    code: string
    message: string
  }
}

export interface ProviderAccountStatus {
  id: string
  provider: string
  nickname: string
  enabled: boolean
  credentialRef: string
  createdAt: number
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
  source?: string
  modelRateLimits?: Record<string, number>
}

export interface ModelListEntry {
  id: string
  name: string
  disabled: boolean
}

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  hash: string
  value?: string
  createdAt: number
  lastUsedAt?: number
  enabled: boolean
  allowedModels?: string[]
}

export interface UsageRecord {
  id: string
  timestamp: number
  apiKeyId?: string
  apiKeyName?: string
  provider: string
  model: string
  status: number
  stream: boolean
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  errorCode?: string
}

export interface LogRecord {
  id: string
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  message: string
  requestId?: string
  provider?: string
  model?: string
  status?: number
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface GatewaySettings {
  defaultProvider: string
  defaultModel: string
  allowedModels: string[]
  requestTimeoutMs: number
  /**
   * 客户端 system 提示词的处理方式。
   *
   * `replace`（默认）用 `systemPrompt` 整段替掉客户端自带的 system；`passthrough`
   * 原样转发。上游 CodeBuddy 系会拒掉某些客户端身份提示词（HTTP 403
   * `Illegal API invocation from an unapproved channel`），换号也救不回来，
   * 因此默认由网关自带一段中性提示词，从源头避开。
   */
  systemPromptMode: 'passthrough' | 'replace'
  /** `systemPromptMode === 'replace'` 时向上游下发的 system 文本。 */
  systemPrompt: string
  logLevel: string
}

export interface AuthContext {
  kind: 'admin'
  subject: string
}

export interface ApiKeyContext {
  kind: 'api-key'
  key: ApiKeyRecord
}
