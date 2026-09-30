import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { JetHubClient } from './jet-hub.js'
import { createGatewayRuntime } from './runtime.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('createGatewayRuntime', () => {
  it('registers the Jet Hub RPC endpoint before returning', async () => {
    const directory = await temporaryDirectory()
    const config = loadConfig({
      SUB2API_DATA_DIR: directory,
      SUB2API_SCHEDULER_INTERVAL_MS: '0',
    })
    const jetHub = new JetHubClient()
    const runtime = await createGatewayRuntime(config, jetHub)

    try {
      expect(jetHub.available).toBe(true)
      await expect(jetHub.call('account.list', { provider: 'codearts' })).resolves.toEqual({
        accounts: [],
      })
    } finally {
      await runtime.dispose()
    }
  })
})
