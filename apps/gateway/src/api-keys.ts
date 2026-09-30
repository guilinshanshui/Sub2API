import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ApiKeyRecord } from './types.js'
import { atomicWriteFile, wildcardMatch } from './utils.js'
import { createApiKeyValue, hashApiKey } from './auth.js'

interface ApiKeyFile {
  version: 1
  keys: ApiKeyRecord[]
}

export class ApiKeyManager {
  private readonly filePath: string
  private keys: ApiKeyRecord[] | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private lastUsedPersistedAt = 0

  constructor(
    dataDir: string,
    private readonly bootstrapKey: string,
  ) {
    this.filePath = path.join(dataDir, 'api-keys.json')
  }

  async initialize(): Promise<void> {
    await this.load()
    if (this.bootstrapKey.length > 0 && !this.keys!.some((key) => key.hash === hashApiKey(this.bootstrapKey))) {
      this.keys!.push({
        id: randomUUID(),
        name: 'Environment bootstrap key',
        prefix: this.bootstrapKey.slice(0, 16),
        hash: hashApiKey(this.bootstrapKey),
        createdAt: Date.now(),
        enabled: true,
      })
      await this.save()
    }
  }

  private async load(): Promise<void> {
    if (this.keys !== undefined) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<ApiKeyFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.keys)) throw new Error('Invalid api-keys.json')
      this.keys = parsed.keys
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.keys = []
    }
  }

  private async save(): Promise<void> {
    await atomicWriteFile(this.filePath, `${JSON.stringify({ version: 1, keys: this.keys ?? [] }, null, 2)}\n`)
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async list(): Promise<Array<Omit<ApiKeyRecord, 'hash'>>> {
    await this.load()
    return this.keys!.map(({ hash: _hash, ...key }) => ({ ...key }))
  }

  async create(input: { name?: string; allowedModels?: string[] }): Promise<{ key: string; record: Omit<ApiKeyRecord, 'hash'> }> {
    const value = createApiKeyValue()
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name?.trim() || 'API key',
      prefix: value.slice(0, 20),
      hash: hashApiKey(value),
      value,
      createdAt: Date.now(),
      enabled: true,
      allowedModels: input.allowedModels?.filter(Boolean),
    }
    await this.withLock(async () => {
      await this.load()
      this.keys!.push(record)
      await this.save()
    })
    const { hash: _hash, ...safe } = record
    return { key: value, record: safe }
  }

  async update(id: string, patch: { name?: string; enabled?: boolean; allowedModels?: string[] }): Promise<Omit<ApiKeyRecord, 'hash'>> {
    return await this.withLock(async () => {
      await this.load()
      const record = this.keys!.find((item) => item.id === id)
      if (record === undefined) throw new Error('API key not found')
      if (patch.name !== undefined) record.name = patch.name.trim() || record.name
      if (patch.enabled !== undefined) record.enabled = patch.enabled
      if (patch.allowedModels !== undefined) {
        const models = patch.allowedModels.map((item) => item.trim()).filter(Boolean)
        record.allowedModels = models.length > 0 ? models : undefined
      }
      await this.save()
      const { hash: _hash, ...safe } = record
      return { ...safe }
    })
  }

  async delete(id: string): Promise<void> {
    await this.withLock(async () => {
      await this.load()
      const index = this.keys!.findIndex((item) => item.id === id)
      if (index < 0) return
      this.keys!.splice(index, 1)
      await this.save()
    })
  }

  async authenticate(header: string | undefined): Promise<ApiKeyRecord | undefined> {
    if (header === undefined) return undefined
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match?.[1] === undefined) return undefined
    await this.load()
    const record = this.keys!.find((item) => item.hash === hashApiKey(match[1] as string))
    if (record === undefined || !record.enabled) return undefined
    const now = Date.now()
    record.lastUsedAt = now
    if (now - this.lastUsedPersistedAt >= 60_000) {
      this.lastUsedPersistedAt = now
      void this.withLock(async () => {
        await this.save()
      }).catch(() => undefined)
    }
    return record
  }

  allowsModel(record: ApiKeyRecord, model: string): boolean {
    if (record.allowedModels === undefined || record.allowedModels.length === 0) return true
    return record.allowedModels.some((pattern) => wildcardMatch(pattern, model))
  }
}
