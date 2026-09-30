import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('parses defaults and comma-separated values', () => {
    const config = loadConfig({
      SUB2API_DATA_DIR: './custom-data',
      SUB2API_ALLOWED_MODELS: 'codearts/glm-5.2, qoder/*',
      SUB2API_CORS_ORIGINS: 'https://admin.example.com, https://ops.example.com',
      SUB2API_SCHEDULER_INTERVAL_MS: '0',
      SUB2API_BALANCE_REFRESH_MINUTES: '0',
    })

    expect(config.dataDir.endsWith('custom-data')).toBe(true)
    expect(config.allowedModels).toEqual(['codearts/glm-5.2', 'qoder/*'])
    expect(config.corsOrigins).toEqual(['https://admin.example.com', 'https://ops.example.com'])
    expect(config.schedulerIntervalMs).toBe(0)
    expect(config.balanceRefreshMinutes).toBe(0)
  })

  it('falls back when numeric values are invalid', () => {
    const config = loadConfig({
      SUB2API_PORT: 'not-a-port',
      SUB2API_REQUEST_TIMEOUT_MS: '-1',
      SUB2API_SCHEDULER_INTERVAL_MS: 'bad',
      SUB2API_BALANCE_REFRESH_MINUTES: 'bad',
    })

    expect(config.port).toBe(8787)
    expect(config.requestTimeoutMs).toBe(300_000)
    expect(config.schedulerIntervalMs).toBe(1_800_000)
    expect(config.balanceRefreshMinutes).toBe(60)
    expect(config.corsOrigins).toEqual([])
  })
})
