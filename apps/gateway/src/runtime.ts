import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GatewayConfig } from './config.js'
import { EncryptedCredentialProvider } from './credentials.js'
import type { JetHubClient, JetHubRegistration } from './jet-hub.js'
import type { ProviderAccountStatus } from './types.js'

export interface UpstreamRuntime {
  ctx: Context
  llm: LlmRuntime
  credentials: EncryptedCredentialProvider
  accountPool: {
    listAccounts(provider: string): Promise<ProviderAccountStatus[]>
    disabledModelsFor(provider: string): ReadonlySet<string>
  }
}

export interface GatewayRuntime extends UpstreamRuntime {
  dispose(): Promise<void>
}

/**
 * Boot the ported upstream plugin inside this process.
 *
 * `connection.fetch.register` is the upstream seam used by Jet Hub. We provide
 * it before importing the plugin, then route the captured handler through the
 * gateway's own RPC client.
 */
export async function createGatewayRuntime(
  config: GatewayConfig,
  jetHub: JetHubClient,
): Promise<GatewayRuntime> {
  process.env.DSH_JET_HUB_STATE_DIR = path.join(config.dataDir, 'dsh-home')
  const ctx = new Context()
  const credentials = new EncryptedCredentialProvider(ctx, config.dataDir, {
    warn(message) {
      void message
    },
  })
  const llm = new LlmRuntime(ctx)
  new CommandRuntime(ctx)

  let registeredHandler: ((request: Request) => Promise<Response>) | undefined
  const connection: JetHubRegistration = {
    fetch: {
      register(options) {
        registeredHandler = options.fetch
        jetHub.setHandler(options.fetch)
        return () => {
          if (registeredHandler === options.fetch) {
            registeredHandler = undefined
            jetHub.clearHandler(options.fetch)
          }
        }
      },
    },
  }
  ctx.provide('connection', connection)

  const upstream = await import('@sub2api/dsh-codearts')
  upstream.apply(ctx)
  if (registeredHandler === undefined) {
    throw new Error('The upstream plugin did not register its Jet Hub RPC endpoint')
  }

  const accountPool = ctx.get('accountPool') as UpstreamRuntime['accountPool'] | undefined
  if (accountPool === undefined) throw new Error('The upstream plugin did not provide accountPool')

  return {
    ctx,
    llm,
    credentials,
    accountPool,
    async dispose() {
      jetHub.clearHandler(registeredHandler)
      await ctx.fiber.dispose()
    },
  }
}
