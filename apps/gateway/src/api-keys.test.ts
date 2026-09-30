import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiKeyManager } from './api-keys.js'
import { delay } from './utils.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-keys-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('ApiKeyManager', () => {
  it('authenticates bootstrap and generated keys without exposing hashes', async () => {
    const directory = await temporaryDirectory()
    const manager = new ApiKeyManager(directory, 'sk-bootstrap')
    await manager.initialize()

    const bootstrap = await manager.authenticate('Bearer sk-bootstrap')
    expect(bootstrap?.enabled).toBe(true)

    const created = await manager.create({ name: 'CI', allowedModels: ['codearts/*'] })
    expect(created.key).toMatch(/^sk-sub2api-/)
    expect(created.record).not.toHaveProperty('hash')

    const authenticated = await manager.authenticate(`Bearer ${created.key}`)
    expect(authenticated?.id).toBe(created.record.id)
    expect(manager.allowsModel(authenticated!, 'codearts/glm-5.2')).toBe(true)
    expect(manager.allowsModel(authenticated!, 'qoder/model')).toBe(false)

    const listed = await manager.list()
    expect(listed.every((item) => !('hash' in item))).toBe(true)
    await delay(10)
  })

  it('rejects disabled and malformed credentials', async () => {
    const directory = await temporaryDirectory()
    const manager = new ApiKeyManager(directory, '')
    await manager.initialize()
    const created = await manager.create({ name: 'disabled' })

    await manager.update(created.record.id, { enabled: false })
    expect(await manager.authenticate(`Bearer ${created.key}`)).toBeUndefined()
    expect(await manager.authenticate(created.key)).toBeUndefined()
    expect(await manager.authenticate(undefined)).toBeUndefined()
  })
})
