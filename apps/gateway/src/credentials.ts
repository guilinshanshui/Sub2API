import fs from 'node:fs/promises'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  parseCredentialKey,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { decryptText, encryptText, generateMasterKey, isEncryptedEnvelope, type EncryptedEnvelope } from './encryption.js'
import { atomicWriteFile, ensureDirectory } from './utils.js'

interface CredentialVaultFile {
  version: 1
  refs: Record<string, EncryptedEnvelope>
  records: Record<string, EncryptedEnvelope>
}

const EMPTY_VAULT: CredentialVaultFile = { version: 1, refs: {}, records: {} }

function parseVault(raw: string): CredentialVaultFile {
  const parsed = JSON.parse(raw) as Partial<CredentialVaultFile>
  if (parsed.version !== 1) throw new Error('Unsupported credential vault version')
  return {
    version: 1,
    refs: typeof parsed.refs === 'object' && parsed.refs !== null ? parsed.refs : {},
    records: typeof parsed.records === 'object' && parsed.records !== null ? parsed.records : {},
  }
}

/**
 * Encrypted credential store used by the upstream account pool.
 *
 * References and grant records live in one AES-256-GCM vault. The master key is
 * deliberately stored in a separate file so copying the data file alone does
 * not expose provider refresh tokens.
 */
export class EncryptedCredentialProvider extends CredentialProvider {
  private readonly vaultPath: string
  private readonly keyPath: string
  private vault: CredentialVaultFile | undefined
  private masterKey: Buffer | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    ctx: Context,
    dataDir: string,
    private readonly logger?: { warn(message: string): void },
  ) {
    super(ctx)
    this.vaultPath = path.join(dataDir, 'credentials.enc.json')
    this.keyPath = path.join(dataDir, 'master.key')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.vault !== undefined && this.masterKey !== undefined) return
    await ensureDirectory(path.dirname(this.vaultPath))
    try {
      const keyText = (await fs.readFile(this.keyPath, 'utf8')).trim()
      const key = Buffer.from(keyText, 'base64')
      if (key.length !== 32) throw new Error('master.key must contain a 32-byte base64 key')
      this.masterKey = key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const key = generateMasterKey()
      await atomicWriteFile(this.keyPath, `${key.toString('base64')}\n`)
      this.masterKey = key
    }

    try {
      this.vault = parseVault(await fs.readFile(this.vaultPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.vault = structuredClone(EMPTY_VAULT)
        return
      }
      throw new Error(`Credential vault could not be read: ${String(error)}`, { cause: error })
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async save(): Promise<void> {
    if (this.vault === undefined) throw new Error('Credential vault is not loaded')
    await atomicWriteFile(this.vaultPath, `${JSON.stringify(this.vault, null, 2)}\n`)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.trim().length > 0) {
      return { value: ambient, source: 'env' }
    }
    await this.ensureLoaded()
    const envelope = this.vault?.refs[ref]
    if (envelope === undefined) return undefined
    const value = decryptText(envelope, this.masterKey as Buffer)
    return value.length > 0 ? { value, source: 'encrypted-file' } : undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.trim().length > 0) {
      return { configured: true, source: 'env', writable: false }
    }
    await this.ensureLoaded()
    return {
      configured: this.vault?.refs[ref] !== undefined,
      source: this.vault?.refs[ref] === undefined ? undefined : 'encrypted-file',
      writable: true,
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) throw new Error('Credential values cannot be empty')
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.trim().length > 0) {
      throw new Error(`Credential ${ref} is shadowed by a read-only environment variable`)
    }
    await this.withLock(async () => {
      await this.ensureLoaded()
      this.vault!.refs[ref] = encryptText(value, this.masterKey as Buffer)
      await this.save()
    })
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.trim().length > 0) {
      throw new Error(`Credential ${ref} is shadowed by a read-only environment variable`)
    }
    await this.withLock(async () => {
      await this.ensureLoaded()
      if (this.vault!.refs[ref] === undefined) return
      delete this.vault!.refs[ref]
      await this.save()
    })
    this.notifyUpdated(ref)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    await this.ensureLoaded()
    const envelope = this.vault?.records[key]
    if (envelope === undefined) return undefined
    const parsed = JSON.parse(decryptText(envelope, this.masterKey as Buffer)) as CredentialRecord
    if (parsed.kind !== 'grant' && parsed.kind !== 'api-key') throw new Error(`Invalid credential record: ${key}`)
    return parsed
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    await this.ensureLoaded()
    const envelope = this.vault?.records[key]
    if (envelope === undefined) return { configured: false, writable: true }
    const record = await this.readRecord(key)
    return { configured: true, kind: record?.kind, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    await this.ensureLoaded()
    const entries: CredentialRecordEntry[] = []
    for (const [rawKey, envelope] of Object.entries(this.vault?.records ?? {})) {
      try {
        const record = JSON.parse(decryptText(envelope, this.masterKey as Buffer)) as CredentialRecord
        entries.push({ key: parseCredentialKey(rawKey), kind: record.kind })
      } catch (error) {
        this.logger?.warn(`Skipping unreadable credential record ${rawKey}: ${String(error)}`)
      }
    }
    return entries
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    let result: CredentialRecord | undefined
    let changed = false
    await this.withLock(async () => {
      await this.ensureLoaded()
      const current = await this.readRecordUnlocked(key)
      const next = await mutate(current)
      if (next === undefined) {
        result = current
        return
      }
      this.vault!.records[key] = encryptText(JSON.stringify(next), this.masterKey as Buffer)
      await this.save()
      result = next
      changed = true
    })
    if (changed) this.notifyRecordUpdated(key)
    return result
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    let removed = false
    await this.withLock(async () => {
      await this.ensureLoaded()
      if (this.vault!.records[key] === undefined) return
      delete this.vault!.records[key]
      await this.save()
      removed = true
    })
    if (removed) this.notifyRecordUpdated(key)
  }

  private async readRecordUnlocked(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const envelope = this.vault?.records[key]
    if (envelope === undefined) return undefined
    return JSON.parse(decryptText(envelope, this.masterKey as Buffer)) as CredentialRecord
  }

  /** Test/diagnostic helper: true when the encrypted vault has a value. */
  async hasStoredReference(ref: string): Promise<boolean> {
    await this.ensureLoaded()
    return isEncryptedEnvelope(this.vault?.refs[ref])
  }
}
