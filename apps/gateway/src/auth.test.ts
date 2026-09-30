import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminAuth } from './auth.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-auth-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('AdminAuth', () => {
  it('requires the one-time token and persists the configured administrator', async () => {
    const directory = await temporaryDirectory()
    const auth = new AdminAuth(directory, 'http://127.0.0.1:8787', '')
    await auth.initialize()

    const setupToken = auth.oneTimeSetupToken()
    expect(auth.status()).toEqual({ configured: false, setupRequired: true })
    expect(setupToken).toBeTruthy()
    await expect(auth.setup('wrong-token', 'password-123')).rejects.toThrow('Invalid setup token')

    const session = await auth.setup(setupToken!, 'password-123')
    expect(auth.status()).toEqual({ configured: true, setupRequired: false })
    expect(await auth.verifySession(session.token)).toMatchObject({ username: 'admin' })

    const reloaded = new AdminAuth(directory, 'http://127.0.0.1:8787', '')
    await reloaded.initialize()
    expect((await reloaded.login('password-123')).username).toBe('admin')
    await expect(reloaded.login('wrong-password')).rejects.toThrow('Invalid username or password')
  })

  it('creates secure cookies only when the public URL uses HTTPS', async () => {
    const directory = await temporaryDirectory()
    const auth = new AdminAuth(directory, 'https://gateway.example.com', 'password-123')
    await auth.initialize()

    const cookie = auth.sessionCookieHeader('token-value', 60)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(auth.clearCookieHeader()).toContain('Max-Age=0')
  })
})
