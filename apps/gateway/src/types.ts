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
  workbuddy: 'WorkBuddy',
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
