import path from 'node:path'

export interface GatewayConfig {
  dataDir: string
  host: string
  port: number
  publicUrl: string
  bootstrapApiKey: string
  bootstrapAdminPassword: string
  allowedModels: string[]
  defaultProvider: string
  defaultModel: string
  requestTimeoutMs: number
  schedulerIntervalMs: number
  balanceRefreshMinutes: number
  corsOrigins: string[]
  logLevel: string
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function csv(value: string | undefined): string[] {
  if (value === undefined) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const dataDir = path.resolve(env.SUB2API_DATA_DIR?.trim() || './data')
  const host = env.SUB2API_HOST?.trim() || '127.0.0.1'
  const port = integer(env.SUB2API_PORT, 8787)
  return {
    dataDir,
    host,
    port,
    publicUrl: (env.SUB2API_PUBLIC_URL?.trim() || `http://${host}:${port}`).replace(/\/+$/, ''),
    bootstrapApiKey: env.SUB2API_API_KEY?.trim() || '',
    bootstrapAdminPassword: env.SUB2API_ADMIN_PASSWORD || '',
    allowedModels: csv(env.SUB2API_ALLOWED_MODELS),
    defaultProvider: env.SUB2API_DEFAULT_PROVIDER?.trim() || '',
    defaultModel: env.SUB2API_DEFAULT_MODEL?.trim() || '',
    requestTimeoutMs: integer(env.SUB2API_REQUEST_TIMEOUT_MS, 300_000),
    schedulerIntervalMs: nonNegativeInteger(env.SUB2API_SCHEDULER_INTERVAL_MS, 30 * 60_000),
    balanceRefreshMinutes: nonNegativeInteger(env.SUB2API_BALANCE_REFRESH_MINUTES, 60),
    corsOrigins: csv(env.SUB2API_CORS_ORIGINS),
    logLevel: env.SUB2API_LOG_LEVEL?.trim() || 'info',
  }
}
