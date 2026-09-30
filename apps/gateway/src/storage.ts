import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { GatewayConfig } from './config.js'
import type { GatewaySettings, LogRecord, UsageRecord } from './types.js'
import { atomicWriteFile, sanitizeForLog } from './utils.js'

interface SettingsFile {
  version: 1
  settings: GatewaySettings
}

interface UsageFile {
  version: 1
  records: UsageRecord[]
}

interface LogFile {
  version: 1
  records: LogRecord[]
}

const MAX_USAGE_RECORDS = 10_000
const MAX_LOG_RECORDS = 5_000

function parseSettings(raw: string, fallback: GatewaySettings): GatewaySettings {
  const parsed = JSON.parse(raw) as Partial<SettingsFile>
  if (parsed.version !== 1 || typeof parsed.settings !== 'object' || parsed.settings === null) {
    throw new Error('Invalid settings.json')
  }
  const settings = parsed.settings as Partial<GatewaySettings>
  return {
    defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : fallback.defaultProvider,
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : fallback.defaultModel,
    allowedModels: Array.isArray(settings.allowedModels)
      ? settings.allowedModels.filter((item): item is string => typeof item === 'string')
      : fallback.allowedModels,
    requestTimeoutMs: Number.isFinite(settings.requestTimeoutMs) && (settings.requestTimeoutMs ?? 0) > 0
      ? Math.floor(settings.requestTimeoutMs as number)
      : fallback.requestTimeoutMs,
    logLevel: typeof settings.logLevel === 'string' && settings.logLevel.length > 0 ? settings.logLevel : fallback.logLevel,
  }
}

function parseRecords<T>(raw: string, label: string): T[] {
  const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown }
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error(`Invalid ${label}`)
  return parsed.records as T[]
}

export class GatewayStorage {
  private readonly settingsPath: string
  private readonly usagePath: string
  private readonly logsPath: string
  private settings: GatewaySettings
  private usage: UsageRecord[] = []
  private logs: LogRecord[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, config: GatewayConfig) {
    this.settingsPath = path.join(dataDir, 'settings.json')
    this.usagePath = path.join(dataDir, 'usage.json')
    this.logsPath = path.join(dataDir, 'logs.json')
    this.settings = {
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      allowedModels: [...config.allowedModels],
      requestTimeoutMs: config.requestTimeoutMs,
      logLevel: config.logLevel,
    }
  }

  async initialize(): Promise<void> {
    await this.loadSettings()
    this.usage = await this.loadArray<UsageRecord>(this.usagePath, 'usage.json')
    this.logs = await this.loadArray<LogRecord>(this.logsPath, 'logs.json')
  }

  getSettings(): GatewaySettings {
    return structuredClone(this.settings)
  }

  async updateSettings(patch: Partial<GatewaySettings>): Promise<GatewaySettings> {
    return await this.withLock(async () => {
      const next: GatewaySettings = {
        ...this.settings,
        ...patch,
        allowedModels: patch.allowedModels === undefined
          ? this.settings.allowedModels
          : patch.allowedModels.map((item) => item.trim()).filter(Boolean),
        requestTimeoutMs: patch.requestTimeoutMs === undefined
          ? this.settings.requestTimeoutMs
          : Math.max(1_000, Math.floor(patch.requestTimeoutMs)),
      }
      this.settings = next
      await this.saveJson(this.settingsPath, { version: 1, settings: next } satisfies SettingsFile)
      return structuredClone(next)
    })
  }

  async appendUsage(record: Omit<UsageRecord, 'id'> & { id?: string }): Promise<UsageRecord> {
    const value: UsageRecord = {
      ...record,
      id: record.id ?? randomUUID(),
    }
    return await this.withLock(async () => {
      this.usage.push(value)
      if (this.usage.length > MAX_USAGE_RECORDS) this.usage.splice(0, this.usage.length - MAX_USAGE_RECORDS)
      await this.saveJson(this.usagePath, { version: 1, records: this.usage } satisfies UsageFile)
      return value
    })
  }

  async listUsage(limit = 200): Promise<UsageRecord[]> {
    return this.usage.slice(-Math.max(1, Math.min(limit, MAX_USAGE_RECORDS))).reverse()
  }

  async clearUsage(): Promise<void> {
    await this.withLock(async () => {
      this.usage = []
      await this.saveJson(this.usagePath, { version: 1, records: [] } satisfies UsageFile)
    })
  }

  async appendLog(record: Omit<LogRecord, 'id'> & { id?: string }): Promise<LogRecord> {
    const value: LogRecord = {
      ...record,
      id: record.id ?? randomUUID(),
      metadata: record.metadata === undefined ? undefined : sanitizeForLog(record.metadata) as Record<string, unknown>,
    }
    await this.withLock(async () => {
      this.logs.push(value)
      if (this.logs.length > MAX_LOG_RECORDS) this.logs.splice(0, this.logs.length - MAX_LOG_RECORDS)
      await this.saveJson(this.logsPath, { version: 1, records: this.logs } satisfies LogFile)
    })
    return value
  }

  async listLogs(limit = 200): Promise<LogRecord[]> {
    return this.logs.slice(-Math.max(1, Math.min(limit, MAX_LOG_RECORDS))).reverse()
  }

  async clearLogs(): Promise<void> {
    await this.withLock(async () => {
      this.logs = []
      await this.saveJson(this.logsPath, { version: 1, records: [] } satisfies LogFile)
    })
  }

  private async loadSettings(): Promise<void> {
    try {
      this.settings = parseSettings(await fs.readFile(this.settingsPath, 'utf8'), this.settings)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.saveJson(this.settingsPath, { version: 1, settings: this.settings } satisfies SettingsFile)
    }
  }

  private async loadArray<T>(filePath: string, label: string): Promise<T[]> {
    try {
      return parseRecords<T>(await fs.readFile(filePath, 'utf8'), label)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.saveJson(filePath, { version: 1, records: [] })
      return []
    }
  }

  private async saveJson(filePath: string, value: unknown): Promise<void> {
    await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}
