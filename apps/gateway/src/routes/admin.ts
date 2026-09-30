import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ApiKeyManager } from '../api-keys.js'
import type { AdminAuth } from '../auth.js'
import type { GatewayConfig } from '../config.js'
import type { JetHubClient } from '../jet-hub.js'
import type { GatewayRuntime } from '../runtime.js'
import type { GatewayStorage } from '../storage.js'
import { PROVIDER_NAMES, type ProviderId } from '../types.js'
import { isSafePathId, parsePositiveInteger } from '../utils.js'
import { errorMessage, requireAdmin, sendAdminError } from './helpers.js'
import { dueAutomationJobIds, dueDailySigninProviders } from '@sub2api/dsh-codearts'

interface AdminRouteOptions {
  auth: AdminAuth
  apiKeys: ApiKeyManager
  config: GatewayConfig
  jetHub: JetHubClient
  runtime: GatewayRuntime
  startedAt: number
  storage: GatewayStorage
}

interface AccountListResult {
  accounts: Array<Record<string, unknown>>
}

interface CreditBalanceResultAccount {
  accountId: string
  balance?: unknown
  error?: string
}

interface ModelListResult {
  models: Array<{ id: string; name: string; disabled: boolean }>
}

interface AutomationStatusResult {
  config: {
    enabled: boolean
    enabledJobs: Record<string, boolean>
    reserveCredits: number
    signinSchedules?: Record<string, string>
    governance?: {
      failureThreshold?: number
      cooldownBaseMs?: number
      cooldownMaxMs?: number
      maxInFlight?: number
      softRateBaseMs?: number
      softRateMaxMs?: number
      degradeThreshold?: number
      degradeCooldownMs?: number
      degradeCooldownMaxMs?: number
    }
  }
  jobs: Array<{
    id: string
    name: string
    description: string
    schedule: string[]
    enabled: boolean
    lastRunAt?: number
    lastStatus?: 'success' | 'skipped' | 'unverified' | 'error'
    lastMessage?: string
  }>
  runs: Array<{
    id: string
    jobId: string
    provider?: string
    accountId?: string
    task: string
    status: 'success' | 'skipped' | 'unverified' | 'error'
    startedAt: number
    completedAt: number
    message?: string
    details?: Record<string, unknown>
  }>
}

interface CreditBalanceResultAccount {
  accountId: string
  balance?: unknown
  error?: string
}

const providerSchema = z.object({
  provider: z.string().min(1),
})

const createAccountSchema = z.object({
  provider: z.string().min(1),
  phone: z.string().optional(),
})

const updateAccountSchema = z.object({
  nickname: z.string().optional(),
  enabled: z.boolean().optional(),
  reserveCredits: z.number().min(0).optional(),
  balanceSnapshots: z.record(z.object({
    total: z.number(),
    queriedAt: z.number(),
    lastAttemptAt: z.number(),
    lastError: z.string().optional(),
  })).optional(),
})

const reorderSchema = z.object({
  provider: z.string().min(1),
  orderedIds: z.array(z.string()),
})

const loginPollSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
})

const creditsBalancesSchema = z.object({
  accountId: z.string().min(1).optional(),
})

const sendSmsSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
  phone: z.string().min(1),
})

const submitSmsSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
  code: z.string().min(1),
})

const onboardingSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
})

const modelDisabledSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  disabled: z.boolean(),
})

const modelAllSchema = z.object({
  provider: z.string().min(1),
  disabled: z.boolean(),
})

const createKeySchema = z.object({
  name: z.string().optional(),
  allowedModels: z.array(z.string()).optional(),
})

const updateKeySchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  allowedModels: z.array(z.string()).optional(),
})

const settingsSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  allowedModels: z.array(z.string()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  logLevel: z.string().optional(),
})

const importSchema = z.object({
  payload: z.unknown(),
})

const automationRunSchema = z.object({
  jobId: z.string().min(1),
  provider: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
})

const automationConfigSchema = z.object({
  enabled: z.boolean(),
  enabledJobs: z.record(z.boolean()),
  reserveCredits: z.number().min(0),
  signinSchedules: z.record(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).optional(),
  governance: z.object({
    failureThreshold: z.number().int().min(1).max(20),
    cooldownBaseMs: z.number().int().min(10_000).max(1_800_000),
    cooldownMaxMs: z.number().int().min(60_000).max(86_400_000),
    maxInFlight: z.number().int().min(0).max(50),
    softRateBaseMs: z.number().int().min(10_000).max(1_800_000),
    softRateMaxMs: z.number().int().min(60_000).max(86_400_000),
    degradeThreshold: z.number().int().min(1).max(20),
    degradeCooldownMs: z.number().int().min(10_000).max(43_200_000),
    degradeCooldownMaxMs: z.number().int().min(60_000).max(86_400_000),
  }).optional(),
})

const automationScheduleSchema = z.object({
  schedule: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(8),
})

function providerName(id: string): string {
  return PROVIDER_NAMES[id as ProviderId] ?? id
}

function isValidAccount(account: Record<string, unknown>, now: number): boolean {
  if (account.enabled !== true) return false
  if ((account.cooldownUntil as number | undefined ?? 0) > now) return false
  const expiresAt = account.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) return false
  const refreshError = account.refreshError
  return typeof refreshError !== 'string' || refreshError.trim().length === 0
}

function unknownProvider(reply: FastifyReply): FastifyReply {
  return sendAdminError(reply, 400, 'unknown_provider', '不支持的服务商。')
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const adminOnly = { preHandler: requireAdmin(options.auth) }
  const { apiKeys, jetHub, runtime, storage } = options
  let schedulerRunning = false
  let lastSchedulerRunAt: number | undefined
  let lastManualSchedulerRunAt: number | undefined
  let lastBalanceRefreshAt: number | undefined
  let lastBalanceRefreshAttemptAt: number | undefined

  const runScheduler = async (manual: boolean): Promise<{ refreshed: number; failed: number; completedAt: number }> => {
    schedulerRunning = true
    try {
      const providers = runtime.llm.listProviders()
      let refreshed = 0
      let failed = 0
      for (const provider of providers) {
        const result = await jetHub.call<AccountListResult>('account.list', { provider: provider.id })
        const enabledAccounts = result.accounts.filter((account) => account.enabled === true)
        const outcomes = await Promise.allSettled(enabledAccounts.map((account) => (
          jetHub.call('account.refresh', { accountId: account.id })
        )))
        refreshed += outcomes.filter((outcome) => outcome.status === 'fulfilled').length
        failed += outcomes.filter((outcome) => outcome.status === 'rejected').length
      }
      const completedAt = Date.now()
      lastSchedulerRunAt = completedAt
      if (manual) lastManualSchedulerRunAt = completedAt
      return { refreshed, failed, completedAt }
    } finally {
      schedulerRunning = false
    }
  }

  if (options.config.schedulerIntervalMs > 0) {
    const timer = setInterval(() => {
      if (schedulerRunning) return
      void runScheduler(false).catch((error: unknown) => {
        app.log.warn({ err: error }, 'Scheduled account refresh failed')
      })
    }, options.config.schedulerIntervalMs)
    timer.unref()
    app.addHook('onClose', async () => {
      clearInterval(timer)
    })
  }

  let balanceRefreshing = false
  const refreshAllBalances = async (manual: boolean): Promise<{ accounts: number; failed: number; completedAt: number }> => {
    if (balanceRefreshing) return { accounts: 0, failed: 0, completedAt: Date.now() }
    balanceRefreshing = true
    try {
      const providers = runtime.llm.listProviders()
      let accounts = 0
      let failed = 0
      for (const provider of providers) {
        const result = await jetHub.call<AccountListResult>('account.list', { provider: provider.id })
        const enabledAccounts = result.accounts.filter((account) => account.enabled === true)
        accounts += enabledAccounts.length
        for (const account of enabledAccounts) {
          const accountId = typeof account.id === 'string' ? account.id : ''
          if (accountId.length === 0) continue
          try {
            const refreshed = await jetHub.call<{ accounts?: CreditBalanceResultAccount[] }>('credits.balances', {
              provider: provider.id,
              accountId,
            })
            failed += (refreshed.accounts ?? []).filter((item) => item.error !== undefined).length
          } catch (error) {
            app.log.warn({ err: error, provider: provider.id, accountId }, 'Scheduled balance refresh failed')
            failed += 1
          }
        }
      }
      const completedAt = Date.now()
      lastBalanceRefreshAt = completedAt
      return { accounts, failed, completedAt }
    } finally {
      lastBalanceRefreshAttemptAt = Date.now()
      balanceRefreshing = false
    }
  }

  if (options.config.schedulerIntervalMs > 0 && options.config.balanceRefreshMinutes > 0) {
    const intervalMs = Math.max(options.config.schedulerIntervalMs, options.config.balanceRefreshMinutes * 60_000)
    const timer = setInterval(() => {
      if (balanceRefreshing) return
      void refreshAllBalances(false).catch((error: unknown) => {
        app.log.warn({ err: error }, 'Scheduled balance refresh failed')
      })
    }, intervalMs)
    timer.unref()
    app.addHook('onClose', async () => {
      clearInterval(timer)
    })
  }

  let automationRunning = false
  let lastAutomationPollAt: number | undefined
  const runAutomationDueJobs = async (): Promise<void> => {
    try {
      const status = await jetHub.call<AutomationStatusResult>('automation.status', {})
      const dueIds = dueAutomationJobIds(Date.now(), status.jobs)
        .filter((jobId) => jobId !== 'all_daily_signin')
      if (dueIds.length === 0) return
      for (const jobId of dueIds) {
        await jetHub.call('automation.run', { jobId })
      }
      const signinJob = status.jobs.find((job) => job.id === 'all_daily_signin')
      for (const provider of dueDailySigninProviders(Date.now(), status.config, signinJob?.schedule ?? [])) {
        await jetHub.call('automation.run', { jobId: 'all_daily_signin', provider })
      }
    } finally {
      lastAutomationPollAt = Date.now()
    }
  }

  if (options.config.schedulerIntervalMs > 0) {
    const automationTimer = setInterval(() => {
      if (automationRunning) return
      automationRunning = true
      void runAutomationDueJobs().catch((error: unknown) => {
        app.log.warn({ err: error }, 'Scheduled automation failed')
      }).finally(() => {
        automationRunning = false
      })
    }, 60_000)
    automationTimer.unref()
    app.addHook('onClose', async () => {
      clearInterval(automationTimer)
    })
  }

  app.get('/api/health', async () => ({
    data: {
      status: 'ok',
      uptimeMs: Date.now() - options.startedAt,
      jetHubAvailable: jetHub.available,
      version: '0.1.0',
    },
  }))

  app.get('/api/system', adminOnly, async () => ({
    data: {
      version: '0.1.0',
      dataDir: options.config.dataDir,
      host: options.config.host,
      port: options.config.port,
      publicUrl: options.config.publicUrl,
      startedAt: options.startedAt,
    },
  }))

  app.get('/api/providers', adminOnly, async (_request, reply) => {
    try {
      const now = Date.now()
      const providers = await Promise.all(runtime.llm.listProviders().map(async (provider) => {
        const result = await jetHub.call<AccountListResult>('account.list', { provider: provider.id })
        const accounts = result.accounts
        return {
          id: provider.id,
          name: providerName(provider.id),
          displayName: provider.name,
          accountCount: accounts.length,
          enabledCount: accounts.filter((account) => account.enabled === true).length,
          validCount: accounts.filter((account) => isValidAccount(account, now)).length,
          refreshableCount: accounts.filter((account) => account.refreshable === true).length,
        }
      }))
      return { data: { providers } }
    } catch (error) {
      return sendAdminError(reply, 502, 'provider_list_failed', errorMessage(error))
    }
  })

  app.get('/api/accounts', adminOnly, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const requested = query.provider
    try {
      if (requested !== undefined) {
        if (!runtime.llm.listProviders().some((provider) => provider.id === requested)) {
          return unknownProvider(reply)
        }
        const result = await jetHub.call<AccountListResult>('account.list', { provider: requested })
        return {
          data: {
            accounts: result.accounts.map((account) => ({ ...account, provider: account.provider ?? requested })),
          },
        }
      }
      const values = await Promise.all(runtime.llm.listProviders().map(async (provider) => {
        const result = await jetHub.call<AccountListResult>('account.list', { provider: provider.id })
        return result.accounts.map((account) => ({ ...account, provider: account.provider ?? provider.id }))
      }))
      return { data: { accounts: values.flat() } }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_list_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts', adminOnly, async (request, reply) => {
    const parsed = createAccountSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '服务商不能为空。')
    try {
      const value = await jetHub.call('account.create', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_create_failed', errorMessage(error))
    }
  })

  app.patch('/api/accounts/:accountId', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    const parsed = updateAccountSchema.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return sendAdminError(reply, 400, 'invalid_request', '没有可更新的字段。')
    }
    try {
      await jetHub.call('account.update', {
        accountId: params.accountId,
        patch: parsed.data,
      })
      return { data: { updated: true } }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_update_failed', errorMessage(error))
    }
  })

  app.delete('/api/accounts/:accountId', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    try {
      await jetHub.call('account.delete', { accountId: params.accountId })
      return { data: { deleted: true } }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_delete_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts/reorder', adminOnly, async (request, reply) => {
    const parsed = reorderSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '账号顺序无效。')
    try {
      await jetHub.call('account.reorder', parsed.data)
      return { data: { reordered: true } }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_reorder_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts/:accountId/refresh', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    try {
      const value = await jetHub.call('account.refresh', { accountId: params.accountId })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_refresh_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts/:accountId/retest', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    try {
      const value = await jetHub.call('account.retest', { accountId: params.accountId })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_retest_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts/:accountId/reset', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    try {
      const value = await jetHub.call('account.reset', { accountId: params.accountId })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'account_reset_failed', errorMessage(error))
    }
  })

  app.post('/api/login/poll', adminOnly, async (request, reply) => {
    const parsed = loginPollSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '登录轮询参数无效。')
    try {
      const value = await jetHub.call('login.poll', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'login_poll_failed', errorMessage(error))
    }
  })

  app.post('/api/login/send-sms', adminOnly, async (request, reply) => {
    const parsed = sendSmsSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '手机号和账号不能为空。')
    try {
      const value = await jetHub.call('login.sendSms', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'send_sms_failed', errorMessage(error))
    }
  })

  app.post('/api/login/submit-sms', adminOnly, async (request, reply) => {
    const parsed = submitSmsSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '验证码不能为空。')
    try {
      const value = await jetHub.call('login.submitSms', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'submit_sms_failed', errorMessage(error))
    }
  })

  app.post('/api/providers/:provider/retest', adminOnly, async (request, reply) => {
    const params = request.params as { provider: string }
    if (!isSafePathId(params.provider)) {
      return sendAdminError(reply, 400, 'invalid_request', '服务商 ID 无效。')
    }
    try {
      const value = await jetHub.call('account.retestAll', { provider: params.provider })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'provider_retest_failed', errorMessage(error))
    }
  })

  app.post('/api/providers/:provider/reset', adminOnly, async (request, reply) => {
    const params = request.params as { provider: string }
    if (!isSafePathId(params.provider)) {
      return sendAdminError(reply, 400, 'invalid_request', '服务商 ID 无效。')
    }
    try {
      const value = await jetHub.call('account.resetAll', { provider: params.provider })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'provider_reset_failed', errorMessage(error))
    }
  })

  app.post('/api/providers/:provider/credits/status', adminOnly, async (request, reply) => {
    const params = request.params as { provider: string }
    if (!isSafePathId(params.provider)) {
      return sendAdminError(reply, 400, 'invalid_request', '服务商 ID 无效。')
    }
    try {
      const value = await jetHub.call('credits.status', { provider: params.provider })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'credits_status_failed', errorMessage(error))
    }
  })

  app.post('/api/providers/:provider/credits/claim', adminOnly, async (request, reply) => {
    const params = request.params as { provider: string }
    if (!isSafePathId(params.provider)) {
      return sendAdminError(reply, 400, 'invalid_request', '服务商 ID 无效。')
    }
    try {
      const value = await jetHub.call('credits.claimAll', { provider: params.provider })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'credits_claim_failed', errorMessage(error))
    }
  })

  app.post('/api/providers/:provider/credits/balances', adminOnly, async (request, reply) => {
    const params = request.params as { provider: string }
    if (!isSafePathId(params.provider)) {
      return sendAdminError(reply, 400, 'invalid_request', '服务商 ID 无效。')
    }
    try {
      const parsed = creditsBalancesSchema.safeParse(request.body ?? {})
      if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '积分余额查询参数无效。')
      const value = await jetHub.call('credits.balances', {
        provider: params.provider,
        ...parsed.data.accountId === undefined ? {} : { accountId: parsed.data.accountId },
      })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'credits_balances_failed', errorMessage(error))
    }
  })

  app.post('/api/onboarding/status', adminOnly, async (request, reply) => {
    const parsed = onboardingSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '新手任务参数无效。')
    try {
      const value = await jetHub.call('onboarding.status', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'onboarding_status_failed', errorMessage(error))
    }
  })

  app.post('/api/onboarding/claim', adminOnly, async (request, reply) => {
    const parsed = onboardingSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '新手任务参数无效。')
    try {
      const value = await jetHub.call('onboarding.claim', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'onboarding_claim_failed', errorMessage(error))
    }
  })

  app.get('/api/loomy/lock', adminOnly, async (_request, reply) => {
    try {
      const value = await jetHub.call('loomy.permanentLock', {})
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'loomy_lock_failed', errorMessage(error))
    }
  })

  app.put('/api/loomy/lock', adminOnly, async (request, reply) => {
    const parsed = z.object({ locked: z.boolean() }).safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '锁定状态无效。')
    try {
      const value = await jetHub.call('loomy.permanentLock', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'loomy_lock_failed', errorMessage(error))
    }
  })

  app.get('/api/models', adminOnly, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const providers = query.provider === undefined
      ? runtime.llm.listProviders().map((provider) => provider.id)
      : [query.provider]
    try {
      const groups = await Promise.all(providers.map(async (provider) => {
        const result = await jetHub.call<ModelListResult>('model.list', { provider })
        return {
          provider,
          name: providerName(provider),
          models: result.models,
        }
      }))
      return { data: { groups } }
    } catch (error) {
      return sendAdminError(reply, 502, 'model_list_failed', errorMessage(error))
    }
  })

  app.post('/api/models/disabled', adminOnly, async (request, reply) => {
    const parsed = modelDisabledSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '模型状态参数无效。')
    try {
      const value = await jetHub.call('model.setDisabled', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'model_update_failed', errorMessage(error))
    }
  })

  app.post('/api/models/disabled-all', adminOnly, async (request, reply) => {
    const parsed = modelAllSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '模型批量状态参数无效。')
    try {
      const value = await jetHub.call('model.setAllDisabled', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'model_batch_update_failed', errorMessage(error))
    }
  })

  app.get('/api/keys', adminOnly, async () => ({
    data: { keys: await apiKeys.list() },
  }))

  app.post('/api/keys', adminOnly, async (request, reply) => {
    const parsed = createKeySchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', 'API Key 参数无效。')
    const value = await apiKeys.create(parsed.data)
    return { data: value }
  })

  app.patch('/api/keys/:keyId', adminOnly, async (request, reply) => {
    const params = request.params as { keyId: string }
    if (!isSafePathId(params.keyId)) {
      return sendAdminError(reply, 400, 'invalid_request', 'API Key ID 无效。')
    }
    const parsed = updateKeySchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', 'API Key 参数无效。')
    try {
      const value = await apiKeys.update(params.keyId, parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 404, 'key_not_found', errorMessage(error))
    }
  })

  app.delete('/api/keys/:keyId', adminOnly, async (request, reply) => {
    const params = request.params as { keyId: string }
    if (!isSafePathId(params.keyId)) {
      return sendAdminError(reply, 400, 'invalid_request', 'API Key ID 无效。')
    }
    await apiKeys.delete(params.keyId)
    return { data: { deleted: true } }
  })

  app.get('/api/settings', adminOnly, async () => ({
    data: storage.getSettings(),
  }))

  app.patch('/api/settings', adminOnly, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '设置参数无效。')
    const settings = await storage.updateSettings(parsed.data)
    return { data: settings }
  })

  app.get('/api/logs', adminOnly, async (request) => {
    const query = request.query as Record<string, string | undefined>
    const limit = parsePositiveInteger(query.limit ?? null, 200, 5_000)
    return { data: { logs: await storage.listLogs(limit) } }
  })

  app.delete('/api/logs', adminOnly, async () => {
    await storage.clearLogs()
    return { data: { cleared: true } }
  })

  app.get('/api/usage', adminOnly, async (request) => {
    const query = request.query as Record<string, string | undefined>
    const limit = parsePositiveInteger(query.limit ?? null, 200, 10_000)
    const records = await storage.listUsage(limit)
    const dayStart = new Date().setHours(0, 0, 0, 0)
    const today = records.filter((record) => record.timestamp >= dayStart)
    return {
      data: {
        records,
        summary: {
          requests: today.length,
          inputTokens: today.reduce((sum, record) => sum + record.inputTokens, 0),
          outputTokens: today.reduce((sum, record) => sum + record.outputTokens, 0),
          totalTokens: today.reduce((sum, record) => sum + record.totalTokens, 0),
          errors: today.filter((record) => record.status >= 400).length,
          averageDurationMs: today.length === 0
            ? 0
            : Math.round(today.reduce((sum, record) => sum + record.durationMs, 0) / today.length),
        },
      },
    }
  })

  app.delete('/api/usage', adminOnly, async () => {
    await storage.clearUsage()
    return { data: { cleared: true } }
  })

  app.get('/api/scheduler', adminOnly, async () => ({
    data: {
      running: schedulerRunning,
      intervalMs: options.config.schedulerIntervalMs,
      lastRunAt: lastSchedulerRunAt,
      lastManualRunAt: lastManualSchedulerRunAt,
      lastBalanceRefreshAt,
      lastBalanceRefreshAttemptAt,
      balanceRefreshMinutes: options.config.balanceRefreshMinutes,
      startedAt: options.startedAt,
    },
  }))

  app.post('/api/scheduler/run', adminOnly, async (_request, reply) => {
    if (schedulerRunning) return sendAdminError(reply, 409, 'scheduler_busy', '巡检任务正在执行。')
    try {
      const tokenResult = await runScheduler(true)
      const balanceResult = options.config.balanceRefreshMinutes > 0
        ? await refreshAllBalances(true)
        : { accounts: 0, failed: 0, completedAt: Date.now() }
      return {
        data: {
          ...tokenResult,
          balanceAccounts: balanceResult.accounts,
          balanceFailures: balanceResult.failed,
        },
      }
    } catch (error) {
      return sendAdminError(reply, 502, 'scheduler_run_failed', errorMessage(error))
    }
  })

  app.post('/api/accounts/:accountId/credits/refresh', adminOnly, async (request, reply) => {
    const params = request.params as { accountId: string }
    if (!isSafePathId(params.accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    const provider = (request.query as Record<string, string | undefined>).provider
    if (provider === undefined || provider.length === 0) {
      return sendAdminError(reply, 400, 'invalid_request', '缺少服务商参数。')
    }
    try {
      const value = await jetHub.call(
        'credits.balances',
        { provider, accountId: params.accountId },
      )
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'credits_refresh_failed', errorMessage(error))
    }
  })

  app.get('/api/backup/status', adminOnly, async (_request, reply) => {
    try {
      const value = await jetHub.call('backup.status', {})
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'backup_status_failed', errorMessage(error))
    }
  })

  app.get('/api/automation', adminOnly, async (_request, reply) => {
    try {
      const value = await jetHub.call<AutomationStatusResult>('automation.status', {})
      return { data: { ...value, lastPollAt: lastAutomationPollAt } }
    } catch (error) {
      return sendAdminError(reply, 502, 'automation_status_failed', errorMessage(error))
    }
  })

  app.post('/api/automation/run', adminOnly, async (request, reply) => {
    const parsed = automationRunSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '自动化任务参数无效。')
    try {
      const value = await jetHub.call('automation.run', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'automation_run_failed', errorMessage(error))
    }
  })

  app.patch('/api/automation/config', adminOnly, async (request, reply) => {
    const parsed = automationConfigSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '自动化配置无效。')
    try {
      const value = await jetHub.call('automation.config', { config: parsed.data })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'automation_config_failed', errorMessage(error))
    }
  })

  app.patch('/api/automation/jobs/:jobId/schedule', adminOnly, async (request, reply) => {
    const params = request.params as { jobId: string }
    if (params.jobId !== 'all_daily_signin') {
      return sendAdminError(reply, 400, 'invalid_job', '当前仅支持修改全服务商每日签到的执行时间。')
    }
    const parsed = automationScheduleSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '执行时间必须是 HH:mm 格式。')
    try {
      const value = await jetHub.call('automation.schedule', {
        jobId: params.jobId,
        schedule: parsed.data.schedule,
      })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'automation_schedule_failed', errorMessage(error))
    }
  })

  app.get('/api/automation/tasks/:accountId', adminOnly, async (request, reply) => {
    const accountId = (request.params as { accountId: string }).accountId
    if (!isSafePathId(accountId)) {
      return sendAdminError(reply, 400, 'invalid_request', '账号 ID 无效。')
    }
    try {
      const value = await jetHub.call('automation.tasks', { accountId })
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'automation_tasks_failed', errorMessage(error))
    }
  })

  app.get('/api/backup/export', adminOnly, async (_request, reply) => {
    try {
      const value = await jetHub.call('backup.export', {})
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'backup_export_failed', errorMessage(error))
    }
  })

  app.post('/api/backup/import', adminOnly, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body)
    if (!parsed.success) return sendAdminError(reply, 400, 'invalid_request', '备份载荷无效。')
    try {
      const value = await jetHub.call('backup.import', parsed.data)
      return { data: value }
    } catch (error) {
      return sendAdminError(reply, 502, 'backup_import_failed', errorMessage(error))
    }
  })
}
