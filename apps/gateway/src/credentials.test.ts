import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { EncryptedCredentialProvider } from './credentials.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-credentials-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('EncryptedCredentialProvider', () => {
  it('stores references and records in an encrypted vault', async () => {
    const directory = await temporaryDirectory()
    const ref = `SUB2API_TEST_REF_${process.pid}` as CredentialRef
    const key = 'sub2api/test-record' as CredentialKey
    delete process.env[ref]

    const provider = new EncryptedCredentialProvider(new Context(), directory)
    await provider.set(ref, 'refresh-token')

    expect(await provider.resolve(ref)).toEqual({ value: 'refresh-token', source: 'encrypted-file' })
    expect(await provider.describe(ref)).toEqual({
      configured: true,
      source: 'encrypted-file',
      writable: true,
    })
    expect(await provider.hasStoredReference(ref)).toBe(true)

    await provider.modifyRecord(key, async () => ({
      kind: 'grant',
      payload: { accessToken: 'token' },
    }))
    expect(await provider.readRecord(key)).toEqual({
      kind: 'grant',
      payload: { accessToken: 'token' },
    })
    expect(await provider.listRecords()).toEqual([{ key, kind: 'grant' }])

    const raw = await fs.readFile(path.join(directory, 'credentials.enc.json'), 'utf8')
    expect(raw).not.toContain('refresh-token')
    expect(raw).not.toContain('accessToken')
  })

  it('fails loudly when the vault is corrupt', async () => {
    const directory = await temporaryDirectory()
    const ref = `SUB2API_CORRUPT_REF_${process.pid}` as CredentialRef
    delete process.env[ref]
    await fs.writeFile(path.join(directory, 'credentials.enc.json'), '{not-json', 'utf8')

    const provider = new EncryptedCredentialProvider(new Context(), directory)
    await expect(provider.resolve(ref)).rejects.toThrow('Credential vault could not be read')
  })
})
