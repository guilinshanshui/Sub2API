/**
 * PhanthyCode 每日登录奖励与积分余额。
 *
 * 桌面端活动接口需要 Ed25519 签名；签名、注册、领取均为幂等路径。
 */

import { randomBytes } from 'node:crypto'
import type { CreditBalance, ClaimOutcome } from './credits.js'
import {
  PHANTHY_OAUTH_BETA,
  type PhanthyCredential,
} from './phanthy.js'
import type { PhanthyProduct } from './phanthy-product.js'
import {
  loadOrCreatePhanthyDesktopIdentity,
  phanthyPublicKeyB64url,
  signPhanthyDesktop,
  type PhanthyDesktopIdentity,
} from './phanthy-desktop-key.js'
import { readPhanthyJson } from './phanthy-runtime.js'

/** activities summary 的关键响应字段。 */
export interface PhanthyActivitiesSummary {
  credits: { available: number }
  daily: {
    status: string
    server_date: string
    points: number
    streak_day: boolean
    streak_days?: number
    next_points?: number
  }
  feature_flags?: { daily_enabled?: boolean }
}

/** claim 响应。 */
export interface PhanthyDailyClaimResponse {
  status: string
  points?: number
  streak_days?: number
  streak_day?: boolean
  message?: string
}

/** 活动请求公共头。 */
function activityHeaders(
  credential: PhanthyCredential,
  product: PhanthyProduct,
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    'anthropic-beta': PHANTHY_OAUTH_BETA,
    'User-Agent': `phanthycode2api/${product.desktopVersion}`,
  }
}

/** 读取 activities summary。 */
export async function fetchPhanthyActivitiesSummary(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
): Promise<PhanthyActivitiesSummary | null> {
  try {
    const response = await fetcher(`${product.apiBase}/api/oauth/activities/summary`, {
      method: 'GET',
      headers: activityHeaders(credential, product),
      signal: AbortSignal.timeout(20_000),
    })
    const result = await readPhanthyJson<PhanthyActivitiesSummary>(response)
    return result.ok ? result.body : null
  } catch {
    return null
  }
}

/** summary 映射为共享 CreditBalance。 */
export function parsePhanthyCreditBalance(summary: PhanthyActivitiesSummary): CreditBalance {
  return {
    total: Number.isFinite(summary.credits?.available) ? Number(summary.credits.available) : 0,
    packages: [],
    expiredTotal: 0,
  }
}

/** summary → CreditBalance 的便捷封装。 */
export async function fetchPhanthyCreditBalance(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
): Promise<CreditBalance | null> {
  const summary = await fetchPhanthyActivitiesSummary(product, credential, fetcher)
  return summary === null ? null : parsePhanthyCreditBalance(summary)
}

/**
 * 领取每日登录奖励。
 *
 * 先注册桌面端身份（409 视为已注册），再读 summary 拿 server_date 与当前状态，
 * 最后按安装身份做幂等 claim。
 */
export async function claimPhanthyDailyLogin(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  dataDir: string,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  if (credential.uid.trim().length === 0) {
    return { kind: 'failed', code: -1, message: '凭据缺少 uid，无法领取每日奖励' }
  }

  let identity: PhanthyDesktopIdentity
  try {
    identity = await loadOrCreatePhanthyDesktopIdentity(credential.uid, dataDir)
  } catch (error) {
    return { kind: 'failed', code: -1, message: `桌面端身份创建失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const registered = await ensurePhanthyDesktopInstallation(product, credential, identity, fetcher)
  if (!registered.ok) {
    return { kind: 'failed', code: registered.status, message: registered.message }
  }

  const summary = await fetchPhanthyActivitiesSummary(product, credential, fetcher)
  if (summary === null) {
    return { kind: 'failed', code: -1, message: '读取活动状态失败' }
  }
  if (summary.feature_flags?.daily_enabled === false) {
    return { kind: 'inactive', message: 'PhanthyCode 每日奖励未开放' }
  }

  const serverDate = summary.daily?.server_date ?? ''
  if (serverDate.length === 0) {
    return { kind: 'failed', code: -1, message: '服务端未返回奖励日期' }
  }
  if (summary.daily?.status === 'granted_today') {
    return { kind: 'already-claimed', message: '今天已领取' }
  }

  const idempotencyKey = `daily:${identity.installationId}:${serverDate}`
  const nonce = randomNonce()
  const timestampMs = Date.now()
  const body = '{}'
  const path = '/api/oauth/activities/daily-login/claim'
  const signature = signPhanthyDesktop(identity.privateKey, {
    method: 'POST',
    path,
    timestampMs,
    nonce,
    body,
    idempotencyKey,
  })

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: 'POST',
      headers: {
        ...activityHeaders(credential, product),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'x-desktop-installation-id': identity.installationId,
        'x-desktop-timestamp': String(timestampMs),
        'x-desktop-nonce': nonce,
        'x-desktop-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
  }

  const result = await readPhanthyJson<PhanthyDailyClaimResponse>(response)
  if (!result.ok) {
    if (result.status === 409) {
      return { kind: 'already-claimed', message: '今天已领取' }
    }
    if (result.status === 401 || result.status === 403) {
      return { kind: 'failed', code: result.status, message: '凭据已失效，请刷新或重新登录' }
    }
    return { kind: 'failed', code: result.status, message: `${result.message}: ${result.text.slice(0, 120)}` }
  }

  const status = typeof result.body.status === 'string' ? result.body.status : ''
  if (status === 'granted_today') {
    return { kind: 'already-claimed', message: '今天已领取' }
  }
  if (status === 'inactive' || status === 'not_eligible') {
    return { kind: 'inactive', message: result.body.message || '今天无奖励资格' }
  }
  const points = Number(result.body.points ?? summary.daily.points ?? 0)
  const streakDays = Number(result.body.streak_days ?? summary.daily.streak_days ?? 0)
  return {
    kind: 'claimed',
    credit: Number.isFinite(points) ? points : 0,
    streakDays: Number.isFinite(streakDays) ? streakDays : 0,
    isStreakDay: result.body.streak_day ?? summary.daily.streak_day === true,
  }
}

/** 注册桌面端安装身份；409 视为已存在。 */
export async function ensurePhanthyDesktopInstallation(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  identity: PhanthyDesktopIdentity,
  fetcher: typeof fetch,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const path = '/api/oauth/desktop-installations/register'
  const body = JSON.stringify({
    public_key: phanthyPublicKeyB64url(identity.privateKey),
    edition: 'phanthy_code',
    platform: product.desktopPlatform,
    version: product.desktopVersion,
  })
  const idempotencyKey = `register:${identity.installationId}`
  const timestampMs = Date.now()
  const nonce = randomNonce()
  try {
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: 'POST',
      headers: {
        ...activityHeaders(credential, product),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'x-desktop-installation-id': identity.installationId,
        'x-desktop-timestamp': String(timestampMs),
        'x-desktop-nonce': nonce,
        'x-desktop-signature': signPhanthyDesktop(identity.privateKey, {
          method: 'POST', path, timestampMs, nonce, body, idempotencyKey,
        }),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if (response.ok || response.status === 409) return { ok: true }
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status,
      message: response.status === 401 || response.status === 403
        ? '凭据已失效，请刷新或重新登录'
        : `桌面端注册失败（HTTP ${response.status}）：${text.slice(0, 120)}`,
    }
  } catch (error) {
    return { ok: false, status: -1, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 生成签名 nonce：18 字节 b64url。 */
function randomNonce(): string {
  return randomBytes(18).toString('base64url')
}
