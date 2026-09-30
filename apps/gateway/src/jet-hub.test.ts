import { describe, expect, it } from 'vitest'
import { JetHubClient } from './jet-hub.js'

describe('JetHubClient', () => {
  it('unwraps successful RPC responses', async () => {
    const client = new JetHubClient()
    client.setHandler(async (request) => {
      const body = await request.json() as { payload: { method: string; payload: unknown } }
      expect(body.payload.method).toBe('account.list')
      return Response.json({
        type: 'server-response',
        result: { ok: true, value: { accounts: [] } },
      })
    })

    expect(await client.call('account.list', { provider: 'codearts' })).toEqual({ accounts: [] })
  })

  it('reports upstream RPC errors with their code', async () => {
    const client = new JetHubClient()
    client.setHandler(async () => Response.json({
      type: 'server-response',
      result: { ok: false, error: { code: 'not_found', message: 'Account not found' } },
    }))

    await expect(client.call('account.refresh', { accountId: 'missing' }))
      .rejects.toThrow('Account not found [not_found]')
  })

  it('rejects invalid JSON and unavailable handlers', async () => {
    const client = new JetHubClient()
    await expect(client.call('account.list', {})).rejects.toThrow('not available')

    client.setHandler(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(client.call('account.list', {})).rejects.toThrow('invalid JSON')
  })
})
