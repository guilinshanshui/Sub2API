import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedEnvelope {
  v: 1
  iv: string
  tag: string
  data: string
}

export function generateMasterKey(): Buffer {
  return randomBytes(32)
}

export function encryptText(plaintext: string, masterKey: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  }
}

export function decryptText(envelope: EncryptedEnvelope, masterKey: Buffer): string {
  if (envelope.v !== 1) throw new Error(`Unsupported encrypted envelope version: ${String(envelope.v)}`)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<EncryptedEnvelope>
  return candidate.v === 1
    && typeof candidate.iv === 'string'
    && typeof candidate.tag === 'string'
    && typeof candidate.data === 'string'
}
