export interface AuthStatus {
  configured: boolean
  setupRequired: boolean
}

export interface AdminSession {
  username: string
  expiresAt: number
}

export interface HealthStatus {
  status: string
  uptimeMs: number
  jetHubAvailable: boolean
  version: string
}

export interface SystemInfo {
  version: string
  dataDir: string
  host: string
  port: number
  publicUrl: string
  startedAt: number
}

export interface ProviderSummary {
  id: string
  name: string
  displayName: string
  accountCount: number
  enabledCount: number
  validCount: number
  refreshableCount: number
}

export interface ProviderAccount {
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
  consecutiveFailures?: number
  cooldownUntil?: number
  softRateStreak?: number
  softRateCooldownUntil?: number
  degradeStreak?: number
  degradeCooldownUntil?: number
  inFlight?: number
  reserveCredits?: number
  balanceSnapshots?: Record<string, unknown>
}

export interface AutomationConfig {
  enabled: boolean
  enabledJobs: Record<string, boolean>
  reserveCredits: number
  signinSchedules?: Record<string, string>
  governance?: {
    failureThreshold?: number
    cooldownBaseMs?: number
    cooldownMaxMs?: number
    maxInFlight?: number
    softRateBaseMs?: number
    softRateMaxMs?: number
    degradeThreshold?: number
    degradeCooldownMs?: number
    degradeCooldownMaxMs?: number
  }
}

export interface AutomationJob {
  id: string
  name: string
  description: string
  schedule: string[]
  enabled: boolean
  lastRunAt?: number
  lastStatus?: 'success' | 'skipped' | 'unverified' | 'error'
  lastMessage?: string
}

export interface AutomationRun {
  id: string
  jobId: string
  provider?: string
  accountId?: string
  task: string
  status: 'success' | 'skipped' | 'unverified' | 'error'
  startedAt: number
  completedAt: number
  message?: string
  details?: Record<string, unknown>
}

export interface AutomationStatus {
  config: AutomationConfig
  jobs: AutomationJob[]
  runs: AutomationRun[]
  lastPollAt?: number
}

export interface GrowthTaskView {
  taskCode: string
  title: string
  description?: string
  current: number
  target: number
  reward?: string
  acceptStatus: string
  status: string
  locked: boolean
  tag?: string
  jumpUrl?: string
}

export interface AutomationTasks {
  accountId: string
  nickname: string
  desktop: GrowthTaskView[]
  miniprogram: GrowthTaskView[]
  errors: string[]
}

export interface ModelInfo {
  id: string
  name: string
  disabled: boolean
}

export interface ModelGroup {
  provider: string
  name: string
  models: ModelInfo[]
}

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  value?: string
  createdAt: number
  lastUsedAt?: number
  enabled: boolean
  allowedModels?: string[]
}

export interface CreatedApiKey {
  key: string
  record: ApiKeyRecord
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

export interface UsageSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  errors: number
  averageDurationMs: number
}

export interface UsageResponse {
  records: UsageRecord[]
  summary: UsageSummary
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

export interface CreateAccountResult {
  accountId: string
  loginUrl: string
  loginMode?: 'url' | 'sms' | 'code'
}

export interface LoginPollResult {
  done: boolean
  success?: boolean
  error?: string
}

export interface RetestResult {
  accounts: Array<{
    accountId: string
    nickname?: string
    tested: number
    cleared: string[]
    stillLimited: Array<{ modelId: string; ok: boolean; message?: string; resetTimeMs?: number }>
    error?: string
  }>
  clearedCount: number
}

export interface RefreshResult {
  success: boolean
  error?: string
}

export interface ResetResult {
  clearedCount: number
  accountCount: number
}

export interface CreditsStatusAccount {
  accountId: string
  nickname: string
  status: Record<string, unknown> | null
}

export interface CreditsStatusResult {
  accounts: CreditsStatusAccount[]
}

export interface CreditsClaimResult {
  results: Array<{
    accountId: string
    nickname: string
    outcome: Record<string, unknown>
  }>
  summary: {
    claimed: number
    totalCredit: number
    alreadyClaimed: number
    inactive: number
    failed: number
  }
}

export interface CreditsBalanceAccount {
  accountId: string
  nickname: string
  balance?: {
    total: number
    expiredTotal?: number
    packages?: Array<Record<string, unknown>>
  } | null
  error?: string
  /** PhanthyCode 特有的钱包与开工奖励明细。 */
  detail?: Record<string, unknown>
}

export interface OnboardingStatus {
  tasks: Record<string, boolean>
  earned: number
  total: number
  titles?: Record<string, string>
  points?: Record<string, number>
}

export interface OnboardingClaimResult {
  claimed: Array<{ key: string; title: string; points: number }>
  skipped: string[]
  earned: number
  total: number
}

export interface BackupStatus {
  accounts: number
  withoutExpiry: number
}

export interface BackupExport {
  payload: unknown
  warnings?: string[]
}

export interface BackupImportResult {
  credentialsImported: number
  accountsImported: number
  skipped: string[]
  expiredAccounts: number
  missingCredentials: number
}

export interface SchedulerStatus {
  running: boolean
  intervalMs: number
  lastRunAt?: number
  lastManualRunAt?: number
  balanceRefreshMinutes?: number
  lastBalanceRefreshAt?: number
  startedAt: number
}

export interface SchedulerRunResult {
  refreshed: number
  failed: number
  balanceAccounts?: number
  balanceFailures?: number
  completedAt: number
}

export interface LoomyLockStatus {
  locked: boolean
}
