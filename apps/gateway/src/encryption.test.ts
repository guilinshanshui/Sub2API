import { describe, expect, it } from 'vitest'
import { decryptText, encryptText, generateMasterKey, isEncryptedEnvelope } from './encryption.js'

describe('encryption', () => {
  it('round-trips text with AES-256-GCM', () => {
    const key = generateMasterKey()
    const envelope = encryptText('refresh-token-value', key)

    expect(isEncryptedEnvelope(envelope)).toBe(true)
    expect(envelope.data).not.toContain('refresh-token-value')
    expect(decryptText(envelope, key)).toBe('refresh-token-value')
  })

  it('rejects tampered ciphertext', () => {
    const key = generateMasterKey()
    const envelope = encryptText('secret', key)
    const bytes = Buffer.from(envelope.data, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 1

    expect(() => decryptText({ ...envelope, data: bytes.toString('base64') }, key)).toThrow()
  })

  it('validates envelope shape', () => {
    expect(isEncryptedEnvelope({ v: 1, iv: 'a', tag: 'b', data: 'c' })).toBe(true)
    expect(isEncryptedEnvelope({ v: 2, iv: 'a', tag: 'b', data: 'c' })).toBe(false)
    expect(isEncryptedEnvelope({ v: 1, iv: 'a' })).toBe(false)
  })
})
