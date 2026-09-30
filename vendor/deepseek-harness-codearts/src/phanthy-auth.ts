/**
 * PhanthyCode 认证服务。
 *
 * 登录采用 PKCE 两步式：startLogin 返回授权页 URL，用户在浏览器完成登录后
 * 回到管理界面粘贴 code，再由 exchangeLogin 完成令牌交换。
 */

import { Service } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { ClaimOutcome, CreditBalance } from './credits.js'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { RefreshTokenExpiredError } from './oauth.js'
import {
  PHANTHY_CLIENT_ID,
  PHANTHY_LOGIN_TIMEOUT_MS,
  PHANTHY_OAUTH_BETA,
  PHANTHY_REQUEST_TIMEOUT_MS,
  decodePhanthyJwtExpMs,
  extractPhanthyCode,
  isPhanthyExpired,
  isPhanthyRefreshable,
  parsePhanthyCredential,
  phanthyCredentialExpiresAtMs,
  createPhanthyPkceState,
  randomToken,
  type PhanthyCredential,
  type PhanthyPkceState,
} from './phanthy.js'
import { PHANTHY, type PhanthyProduct } from './phanthy-product.js'
import {
  fetchPhanthyCreditBalance,
  fetchPhanthyCreditBalanceDetailed,
  uidFromAccessToken,
  claimPhanthyDailyLogin,
} from './phanthy-credits.js'
import { readPhanthyJson } from './phanthy-runtime.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import type { AccountPool } from './account-pool.js'

/** 账号池有效期提取器。 */
const PHANTHY_EXPIRY_ACCESSORS: ExpiryAccessors<PhanthyCredential> = {
  expiresAtOf: (credential) => phanthyCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isPhanthyRefreshable(credential),
  identityOf: (credential) => credential.access_token,
}

/** 已启动的两步登录。 */
export interface StartedPhanthyLogin {
  loginUrl: string
  state: string
  verifier: string
}

/** 登录完成结果。 */
export interface PhanthyLoginResult {
  access: string
  expires: number
  ref: CredentialRef
  refreshable: boolean
}

/** 登录状态。 */
export interface PhanthyLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/** PhanthyCode 认证与积分服务。 */
export class PhanthyAuth extends Service {
  readonly product: PhanthyProduct
  readonly credentialRefName: string
  private lastRefreshError: string | undefined

  constructor(ctx: ConstructorParameters<typeof Service>[0], options: {
    product?: PhanthyProduct
    credentialRefName?: string
    serviceName?: string
    fetcher?: typeof fetch
    dataDir?: string
  } = {}) {
    super(ctx, options.serviceName ?? 'phanthyAuth')
    this.product = options.product ?? PHANTHY
    this.credentialRefName = options.credentialRefName ?? this.product.defaultCredentialRef
    this.fetcher = options.fetcher ?? fetch
    this.dataDir = options.dataDir ?? join(process.cwd(), 'data')
  }

  private fetcher: typeof fetch
  private dataDir: string

  /** 启动 PKCE 登录：返回授权页 URL。 */
  async startLogin(): Promise<StartedPhanthyLogin> {
    const pkce = createPhanthyPkceState()
    const redirectUri = 'https://code.phanthy.com/oauth/code/success'
    const url = new URL(`${this.product.apiBase}/oauth/authorize`)
    url.searchParams.set('client_id', PHANTHY_CLIENT_ID)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', 'user:inference user:profile user:sessions:claude_code')
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', pkce.state)
    return { loginUrl: url.toString(), state: pkce.state, verifier: pkce.verifier }
  }

  /** 用用户粘贴的授权码完成登录并落盘。 */
  async exchangeLogin(code: string, verifier: string, refName?: string): Promise<PhanthyLoginResult> {
    const ref = refName ?? this.credentialRefName
    const authorizationCode = extractPhanthyCode(code)
    if (authorizationCode.length === 0) {
      throw new Error('授权码为空，请粘贴完整回调地址或纯授权码')
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: PHANTHY_CLIENT_ID,
      code_verifier: verifier,
      redirect_uri: 'https://code.phanthy.com/oauth/code/success',
    })
    const token = await this.requestToken(body)
    const credential = this.credentialFromToken(token)
    await this.ctx.credentials.set(credentialRef(ref), JSON.stringify(credential))
    this.lastRefreshError = undefined
    return {
      access: JSON.stringify(credential),
      expires: phanthyCredentialExpiresAtMs(credential) ?? 0,
      ref: credentialRef(ref),
      refreshable: isPhanthyRefreshable(credential),
    }
  }

  /** 只读默认凭据状态。 */
  async status(): Promise<PhanthyLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    return {
      configured: true,
      source: this.credentialRefName,
      expiresAt: phanthyCredentialExpiresAtMs(credential),
      refreshable: isPhanthyRefreshable(credential),
      ...(this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError }),
    }
  }

  /** 刷新默认单凭据。 */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new RefreshTokenExpiredError('凭据未配置，请先登录')
    if (!isPhanthyRefreshable(credential)) throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    const next = await this.refreshCredential(credential)
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
    this.lastRefreshError = undefined
  }

  /**
   * 按账号池 ref 刷新指定账号，并把过期时间同步回账号池。
   */
  async refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parsePhanthyCredential(resolved.value)
    if (credential === undefined) throw new Error('凭据解析失败')
    if (!isPhanthyRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    const next = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(next))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: next,
      accessors: PHANTHY_EXPIRY_ACCESSORS,
      accountId,
      tag: '[phanthy]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /** 批量续期所有账号；已过期或进入提前窗口才发请求。 */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      const ref = credentialRef(entry.credentialRef)
      const resolved = await this.ctx.credentials.resolve(ref)
      if (!resolved) {
        await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
        continue
      }
      const credential = parsePhanthyCredential(resolved.value)
      if (credential === undefined || !isPhanthyRefreshable(credential)) {
        await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
        continue
      }
      try {
        if (isPhanthyExpired(credential) || shouldRefreshSoon(phanthyCredentialExpiresAtMs(credential))) {
          await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
        } else {
          await syncAccountExpiry({
            pool,
            provider: this.product.id,
            credential,
            accessors: PHANTHY_EXPIRY_ACCESSORS,
            accountId: entry.id,
            current: entry,
            tag: '[phanthy]',
            warn: (message) => this.ctx.logger?.warn?.(message),
          })
        }
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
          this.ctx.logger?.warn?.(`[phanthy] 账号 ${entry.id} 的 refresh_token 已失效，需重新登录`)
        } else {
          this.ctx.logger?.warn?.(
            `[phanthy] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /** 查询积分余额。 */
  async fetchCreditBalance(credential: PhanthyCredential): Promise<CreditBalance | null> {
    const result = await this.fetchCreditBalanceDetailed(credential)
    return result.balance
  }

  /**
   * 查询积分余额；近到期或 401 后自动续期一次并重试。
   *
   * access token 只有约 30 分钟寿命，参考实现同样是 summary 401 后刷新重试。
   */
  async fetchCreditBalanceDetailed(credential: PhanthyCredential): Promise<{
    balance: CreditBalance | null
    error?: string
  }> {
    const first = await fetchPhanthyCreditBalanceDetailed(this.product, credential, this.fetcher, this.dataDir)
    if (first.balance !== null) return first
    if (!isPhanthyRefreshable(credential)) return first
    if (!this.isAccessTokenStale(credential) && !this.isCredentialRejected(first.error)) return first
    try {
      const refreshed = await this.refreshCredentialValue(credential)
      await this.persistRefreshedCredential(refreshed)
      return await fetchPhanthyCreditBalanceDetailed(this.product, refreshed, this.fetcher, this.dataDir)
    } catch (error) {
      return { balance: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 领取每日登录奖励。 */
  async claimDailyLogin(credential: PhanthyCredential): Promise<ClaimOutcome> {
    return claimPhanthyDailyLogin(this.product, credential, this.dataDir, this.fetcher)
  }

  /** 领取每日登录奖励；凭据被拒绝或近到期时自动续期一次并重试。 */
  async claimDailyLoginDetailed(credential: PhanthyCredential): Promise<ClaimOutcome> {
    const first = await claimPhanthyDailyLogin(this.product, credential, this.dataDir, this.fetcher)
    if (first.kind !== 'failed' || !isPhanthyRefreshable(credential)) return first
    if (!this.isAccessTokenStale(credential) && !this.isCredentialRejected(first.message)) return first
    try {
      const refreshed = await this.refreshCredentialValue(credential)
      await this.persistRefreshedCredential(refreshed)
      return await claimPhanthyDailyLogin(this.product, refreshed, this.dataDir, this.fetcher)
    } catch (error) {
      return { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 用 refresh_token 换新令牌（不触碰存储）。 */
  private async refreshCredential(credential: PhanthyCredential): Promise<PhanthyCredential> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh_token,
      client_id: PHANTHY_CLIENT_ID,
    })
    const token = await this.requestToken(body)
    const next = this.credentialFromToken(token)
    return { ...next, uid: credential.uid, ...(credential.nickname ? { nickname: credential.nickname } : {}) }
  }

  private async refreshCredentialValue(credential: PhanthyCredential): Promise<PhanthyCredential> {
    const next = await this.refreshCredential(credential)
    const uid = credential.uid.trim().length > 0
      ? credential.uid
      : uidFromAccessToken(next.access_token)
    return uid.length > 0 ? { ...next, uid } : next
  }

  private async persistRefreshedCredential(credential: PhanthyCredential): Promise<void> {
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(credential))
    this.lastRefreshError = undefined
  }

  private isAccessTokenStale(credential: PhanthyCredential): boolean {
    const expiresAt = phanthyCredentialExpiresAtMs(credential)
    return expiresAt === undefined || expiresAt - Date.now() <= 60 * 60 * 1000
  }

  private isCredentialRejected(error?: string): boolean {
    return error !== undefined && /凭据已失效|HTTP 401|HTTP 403/.test(error)
  }

  /** POST /oauth/token。 */
  private async requestToken(body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetcher(`${this.product.apiBase}/oauth/token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'anthropic-beta': PHANTHY_OAUTH_BETA,
        },
        body,
        signal: AbortSignal.timeout(PHANTHY_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
    const result = await readPhanthyJson<Record<string, unknown>>(response)
    if (!result.ok) {
      if (result.status === 400 || result.status === 401) {
        throw new RefreshTokenExpiredError('授权码或 refresh_token 已失效，请重新登录')
      }
      throw new Error(`${result.message}: ${result.text.slice(0, 160)}`)
    }
    return result.body
  }

  /** OAuth 响应转凭据。 */
  private credentialFromToken(token: Record<string, unknown>): PhanthyCredential {
    const accessToken = typeof token.access_token === 'string' ? token.access_token : ''
    const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : ''
    const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 0
    const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
    const uid = typeof token.uid === 'string' ? token.uid : ''
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(expiresAt === undefined ? {} : { expires_at: String(expiresAt) }),
      uid,
    }
  }

  /** 解析默认 ref。 */
  private async resolveDefaultCredential(): Promise<PhanthyCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      return resolved === undefined ? undefined : parsePhanthyCredential(resolved.value)
    } catch {
      return undefined
    }
  }
}

/** 距过期不足 1 小时则进入续期窗口。 */
function shouldRefreshSoon(expiresAtMs: number | undefined): boolean {
  return expiresAtMs === undefined || expiresAtMs - Date.now() <= 60 * 60 * 1000
}
