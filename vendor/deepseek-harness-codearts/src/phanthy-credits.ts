/**
 * PhanthyCode 每日登录奖励与积分余额。
 *
 * 桌面端活动接口需要 Ed25519 签名；签名、注册、领取均为幂等路径。
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
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

/** 从 JWT access token 解出服务端账号 uid（sub 字段）。 */
export function uidFromAccessToken(accessToken: string): string {
  const parts = accessToken.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>
    return typeof payload.sub === 'string' ? payload.sub : ''
  } catch {
    return ''
  }
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
    'User-Agent': product.desktopUserAgent,
    'x-phanthy-client-source': 'desktop',
  }
}

/** 读取 activities summary。 */
export async function fetchPhanthyActivitiesSummary(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
  dataDir: string = join(process.cwd(), 'data'),
): Promise<PhanthyActivitiesSummary | null> {
  const result = await fetchPhanthyActivitiesSummaryDetailed(product, credential, fetcher, dataDir)
  return result.summary
}

/** 读取 activities summary，失败时返回具体原因。 */
export async function fetchPhanthyActivitiesSummaryDetailed(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
  dataDir: string = join(process.cwd(), 'data'),
): Promise<{ summary: PhanthyActivitiesSummary | null; error?: string }> {
  try {
    const uid = credential.uid.trim().length > 0 ? credential.uid : uidFromAccessToken(credential.access_token)
    if (uid.length === 0) return { summary: null, error: '凭据缺少 uid 且无法从 access_token 解析' }
    const identity = await loadOrCreatePhanthyDesktopIdentity(uid, dataDir)
    const registered = await ensurePhanthyDesktopInstallation(product, credential, identity, fetcher)
    if (!registered.ok) return { summary: null, error: registered.message }
    const timestampMs = Date.now()
    const nonce = randomNonce()
    const path = '/api/oauth/activities/summary'
    const signature = signPhanthyDesktop(identity.privateKey, {
      method: 'GET',
      path,
      timestampMs,
      nonce,
      body: Buffer.alloc(0),
    })
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: 'GET',
      headers: {
        ...activityHeaders(credential, product),
        'Content-Type': 'application/json',
        'x-desktop-installation-id': identity.installationId,
        'x-desktop-timestamp': String(timestampMs),
        'x-desktop-nonce': nonce,
        'x-desktop-signature': signature,
      },
      signal: AbortSignal.timeout(20_000),
    })
    const result = await readPhanthyJson<PhanthyActivitiesSummary>(response)
    return result.ok
      ? { summary: result.body }
      : { summary: null, error: `查询失败（HTTP ${result.status}）：${result.text.slice(0, 120)}` }
  } catch (error) {
    return { summary: null, error: error instanceof Error ? error.message : String(error) }
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

/** 钱包里的一个额度池（套餐或某类奖励批次聚合）。 */
export interface PhanthyWalletPool {
  key: string
  label: string
  total: number
  remaining: number
  used: number
  lots?: number
  /** ISO 时间；套餐是重置时间，奖励是最近到期批次。 */
  expiresAt?: string
  /** 奖励池的已用为 FIFO 估算。 */
  estimate?: boolean
}

/** 官网「套餐」页风格的钱包视图。 */
export interface PhanthyWallet {
  pools: PhanthyWalletPool[]
  total: number
  remaining: number
  used: number
  approximate: boolean
  pending: number
}

/** 每日开工奖励的台账 + summary 合并视图。 */
export interface PhanthyDailyReward {
  /** 北京时间业务日，如 2026-09-30。 */
  today?: string
  grantedToday: boolean
  todayPoints: number
  streakDays: number
  totalGranted: number
  grantedDays?: number
  lastGrantedAt?: string
  nextPoints?: number
  source: 'ledger' | 'summary' | 'none'
}

/** PhanthyCode 特有的积分明细，进入账号池快照与备份链路。 */
export interface PhanthyCreditDetail {
  wallet: PhanthyWallet
  daily: PhanthyDailyReward
  planName?: string
  planExpiresAt?: string
  /** 单个附属端点失败时仍尽量返回可用数据。 */
  errors?: string[]
}

interface PhanthyCreditLot {
  kind: string
  points: number
  used: number
  grantedAt?: Date
  expiresAt?: Date
}

const PHANTHY_REWARD_LABELS: Record<string, string> = {
  daily_login: '每日登录奖励',
  long_task_feedback: '活动奖励',
  token_factory_activation: '代币工厂奖励',
  referral_inviter: '推荐奖励',
}

function toFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : undefined
}

function parsePhanthyTime(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** 上游按北京时间划分业务日。 */
export function phanthyBusinessDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function phanthyMidnight(date: Date): Date {
  return new Date(`${phanthyBusinessDate(date)}T00:00:00+08:00`)
}

function isDailyLoginReward(reward: Record<string, unknown>): boolean {
  return ['reward_type', 'reward_code', 'reason_code'].some(
    (key) => reward[key] === 'daily_login',
  )
}

/** 台账里的每日开工奖励：今日到账、连续天数与累计。 */
export function analyzePhanthyDailyRewards(
  rewards: readonly Record<string, unknown>[],
  now: Date = new Date(),
): PhanthyDailyReward {
  const pointsByDay = new Map<string, number>()
  let lastGranted: Date | undefined
  let lastPoints = 0
  let totalGranted = 0

  for (const reward of rewards) {
    if (!isDailyLoginReward(reward) || reward.status !== 'granted') continue
    const points = toFiniteNumber(reward.points)
    if (points === undefined || points <= 0) continue
    const grantedAt = parsePhanthyTime(reward.granted_at)
    if (grantedAt === undefined) continue
    const day = phanthyBusinessDate(grantedAt)
    pointsByDay.set(day, (pointsByDay.get(day) ?? 0) + points)
    totalGranted += points
    if (lastGranted === undefined || grantedAt.getTime() > lastGranted.getTime()) {
      lastGranted = grantedAt
      lastPoints = points
    }
  }

  const today = phanthyBusinessDate(now)
  let cursor = phanthyMidnight(now)
  if (!pointsByDay.has(phanthyBusinessDate(cursor))) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000)
  }
  let streakDays = 0
  while (pointsByDay.has(phanthyBusinessDate(cursor))) {
    streakDays += 1
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000)
  }

  return {
    today,
    grantedToday: pointsByDay.has(today),
    todayPoints: pointsByDay.get(today) ?? 0,
    streakDays,
    totalGranted,
    grantedDays: pointsByDay.size,
    ...(lastGranted === undefined ? {} : { lastGrantedAt: lastGranted.toISOString() }),
    source: rewards.length > 0 ? 'ledger' : 'none',
  }
}

function extractPhanthyUsage(raw: Record<string, unknown>): Record<string, unknown> {
  const plan = raw.current_plan ?? raw.seven_day
  if (typeof plan !== 'object' || plan === null) return {}
  const source = plan as Record<string, unknown>
  return {
    credits_remaining: source.remaining_credits,
    credits_total: source.total_credits,
    credits_used: source.used_credits,
    credits_reset_at: source.resets_at,
  }
}

interface PhanthyUsageDay {
  start: Date
  end: Date
  cost: number
}

function phanthyUsageDays(summary: Record<string, unknown> | undefined): PhanthyUsageDay[] {
  const rows = summary?.usage_by_day_and_model
  if (!Array.isArray(rows)) return []
  const days = new Map<string, PhanthyUsageDay>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    const date = typeof item.date === 'string' ? item.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const start = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(start.getTime())) continue
    const bucket = days.get(date) ?? { start, end: new Date(start.getTime() + 86_400_000), cost: 0 }
    bucket.cost += toFiniteNumber(item.cost_points) ?? 0
    days.set(date, bucket)
  }
  return [...days.values()]
}

function lotOrderKey(lot: PhanthyCreditLot): number {
  return lot.grantedAt?.getTime() ?? lot.expiresAt?.getTime() ?? 0
}

function chargePhanthyLots(lots: PhanthyCreditLot[], days: readonly PhanthyUsageDay[]): void {
  for (const day of days) {
    let remaining = day.cost
    for (const lot of lots) {
      if (remaining <= 0) break
      if (lot.expiresAt !== undefined && lot.expiresAt.getTime() <= day.start.getTime()) continue
      if (lot.grantedAt !== undefined && lot.grantedAt.getTime() >= day.end.getTime()) continue
      const capacity = lot.points - lot.used
      if (capacity <= 0) continue
      const take = Math.min(remaining, capacity)
      lot.used += take
      remaining -= take
    }
  }
}

/** 套餐 + 奖励批次组合成钱包视图；奖励池按 FIFO 消耗估算已用。 */
export function buildPhanthyWallet(
  usage: Record<string, unknown>,
  rewards: readonly Record<string, unknown>[],
  usageSummary: Record<string, unknown> | undefined,
  planName?: string,
): PhanthyWallet {
  const pools: PhanthyWalletPool[] = []
  const extracted = extractPhanthyUsage(usage)
  const remaining = toFiniteNumber(extracted.credits_remaining)
  if (remaining !== undefined) {
    const total = toFiniteNumber(extracted.credits_total) ?? remaining
    const used = toFiniteNumber(extracted.credits_used) ?? 0
    pools.push({
      key: 'plan',
      label: planName?.length ? planName : '套餐额度',
      total,
      remaining,
      used,
      lots: 1,
    ...(typeof extracted.credits_reset_at === 'string' && extracted.credits_reset_at
      ? { expiresAt: extracted.credits_reset_at }
        : {}),
    })
  }

  const lots: PhanthyCreditLot[] = []
  let pending = 0
  for (const reward of rewards) {
    const points = toFiniteNumber(reward.points)
    if (points === undefined || points <= 0) continue
    const status = typeof reward.status === 'string' ? reward.status : ''
    if (status !== 'granted') {
      if (status === 'pending') pending += points
      continue
    }
    const kind = typeof reward.reward_type === 'string' && reward.reward_type
      ? reward.reward_type
      : 'other'
    lots.push({
      kind,
      points,
      used: 0,
      ...(parsePhanthyTime(reward.granted_at) === undefined ? {} : { grantedAt: parsePhanthyTime(reward.granted_at) }),
      ...(parsePhanthyTime(reward.expires_at) === undefined ? {} : { expiresAt: parsePhanthyTime(reward.expires_at) }),
    })
  }
  if (lots.length > 0) {
    lots.sort((left, right) => lotOrderKey(left) - lotOrderKey(right))
    chargePhanthyLots(lots, phanthyUsageDays(usageSummary))
  }

  const groups = new Map<string, { total: number; used: number; lots: number; earliest?: Date }>()
  for (const lot of lots) {
    if (lot.expiresAt !== undefined && lot.expiresAt.getTime() <= Date.now()) continue
    const group = groups.get(lot.kind) ?? { total: 0, used: 0, lots: 0 }
    group.total += lot.points
    group.used += lot.used
    group.lots += 1
    if (lot.expiresAt !== undefined && (group.earliest === undefined || lot.expiresAt < group.earliest)) {
      group.earliest = lot.expiresAt
    }
    groups.set(lot.kind, group)
  }
  for (const [kind, group] of [...groups.entries()].sort((left, right) => {
    const leftTime = left[1].earliest?.getTime() ?? Number.MAX_SAFE_INTEGER
    const rightTime = right[1].earliest?.getTime() ?? Number.MAX_SAFE_INTEGER
    return leftTime - rightTime
  })) {
    pools.push({
      key: kind,
      label: PHANTHY_REWARD_LABELS[kind] ?? kind,
      total: group.total,
      remaining: group.total - group.used,
      used: group.used,
      lots: group.lots,
      ...(group.earliest === undefined ? {} : { expiresAt: group.earliest.toISOString() }),
      estimate: true,
    })
  }

  const total = pools.reduce((sum, pool) => sum + pool.total, 0)
  const left = pools.reduce((sum, pool) => sum + pool.remaining, 0)
  return {
    pools,
    total,
    remaining: left,
    used: total - left,
    approximate: pools.some((pool) => pool.estimate === true),
    pending,
  }
}

function mergePhanthyDailySummary(
  ledger: PhanthyDailyReward,
  summary: PhanthyActivitiesSummary,
): PhanthyDailyReward {
  const daily = summary.daily
  const merged: PhanthyDailyReward = {
    ...ledger,
    today: daily?.server_date || ledger.today,
    nextPoints: toFiniteNumber(daily?.next_points) ?? ledger.nextPoints,
    source: daily === undefined ? ledger.source : 'summary',
  }
  const summaryStreak = toFiniteNumber(daily?.streak_days)
  if (summaryStreak !== undefined && summaryStreak > 0) merged.streakDays = summaryStreak
  if (daily?.status === 'granted_today') {
    merged.grantedToday = true
    const points = toFiniteNumber(daily.points)
    if (points !== undefined && points > 0) merged.todayPoints = points
  }
  return merged
}

/** 附属 GET：普通授权请求，无需桌面签名。 */
async function fetchPhanthyPlainJson(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  path: string,
  fetcher: typeof fetch,
): Promise<{ body?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: 'GET',
      headers: {
        ...activityHeaders(credential, product),
        'Content-Type': 'application/json',
        'x-app': 'cli',
      },
      signal: AbortSignal.timeout(20_000),
    })
    const result = await readPhanthyJson<Record<string, unknown>>(response)
    if (!result.ok) {
      return {
        error: `${path} 查询失败（HTTP ${result.status}）：${result.text.slice(0, 100)}`,
      }
    }
    return { body: result.body }
  } catch (error) {
    return { error: `${path} 查询失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 拉取奖励台账并自动翻页。 */
export async function fetchPhanthyRewards(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
): Promise<{ rewards: Record<string, unknown>[]; error?: string }> {
  const rewards: Record<string, unknown>[] = []
  let cursor = ''
  let firstError: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const result = await fetchPhanthyPlainJson(
      product,
      credential,
      cursor.length > 0 ? `/api/oauth/rewards?cursor=${encodeURIComponent(cursor)}` : '/api/oauth/rewards',
      fetcher,
    )
    if (result.error !== undefined) {
      firstError ??= result.error
      break
    }
    const list = Array.isArray(result.body?.rewards) ? result.body?.rewards : []
    for (const item of list) {
      if (typeof item === 'object' && item !== null) rewards.push(item as Record<string, unknown>)
    }
    const next = typeof result.body?.next_cursor === 'string' ? result.body.next_cursor : ''
    if (list.length === 0 || next.length === 0) break
    cursor = next
  }
  return { rewards, ...(firstError === undefined ? {} : { error: firstError }) }
}

/**
 * 一次读齐 PhanthyCode 积分明细。
 *
 * summary 需要桌面身份签名；usage / usage summary / rewards 是普通授权 GET。
 * 任一附属端点失败不阻断其他数据，errors 里保留具体原因。
 */
export async function fetchPhanthyCreditDetail(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
  dataDir: string = join(process.cwd(), 'data'),
): Promise<{ detail: PhanthyCreditDetail | null; balance: CreditBalance | null; error?: string }> {
  const uid = credential.uid.trim().length > 0 ? credential.uid : uidFromAccessToken(credential.access_token)
  if (uid.length === 0) return { detail: null, balance: null, error: '凭据缺少 uid 且无法从 access_token 解析' }
  const errors: string[] = []

  let summary: PhanthyActivitiesSummary | null = null
  try {
    const identity = await loadOrCreatePhanthyDesktopIdentity(uid, dataDir)
    const registered = await ensurePhanthyDesktopInstallation(product, credential, identity, fetcher)
    if (!registered.ok) {
      errors.push(registered.message)
    } else {
      summary = await fetchPhanthyActivitiesSummary(product, credential, fetcher, dataDir)
      if (summary === null) errors.push('活动状态查询失败')
    }
  } catch (error) {
    errors.push(`桌面身份读取失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const usageResult = await fetchPhanthyPlainJson(product, credential, '/api/oauth/usage', fetcher)
  if (usageResult.error !== undefined) errors.push(usageResult.error)
  const usageSummaryResult = await fetchPhanthyPlainJson(product, credential, '/api/oauth/usage/summary', fetcher)
  if (usageSummaryResult.error !== undefined) errors.push(usageSummaryResult.error)
  const rewardsResult = await fetchPhanthyRewards(product, credential, fetcher)
  if (rewardsResult.error !== undefined) errors.push(rewardsResult.error)

  const usage = extractPhanthyUsage(usageResult.body ?? {})
  const usageSummary = usageSummaryResult.body
  const plan = typeof usageSummary?.plan === 'object' && usageSummary.plan !== null
    ? usageSummary.plan as Record<string, unknown>
    : undefined
  const planName = typeof plan?.name === 'string' && plan.name ? plan.name : undefined
  const planExpiresAt = typeof plan?.expires_at === 'string' && plan.expires_at ? plan.expires_at : undefined
  const wallet = buildPhanthyWallet(usage, rewardsResult.rewards, usageSummary, planName)
  let daily = analyzePhanthyDailyRewards(rewardsResult.rewards)
  if (summary !== null) daily = mergePhanthyDailySummary(daily, summary)

  const available = toFiniteNumber(summary?.credits?.available)
  const total = available ?? wallet.remaining
  const detail: PhanthyCreditDetail = {
    wallet,
    daily,
    ...(planName === undefined ? {} : { planName }),
    ...(planExpiresAt === undefined ? {} : { planExpiresAt }),
    ...(errors.length === 0 ? {} : { errors }),
  }
  const balance: CreditBalance = { total, packages: [], expiredTotal: 0 }
  return {
    detail,
    balance,
    ...(Number.isFinite(total) && (summary !== null || wallet.pools.length > 0)
      ? {}
      : { error: errors[0] ?? '积分数据不可用' }),
  }
}

/** summary → CreditBalance 的便捷封装。 */
export async function fetchPhanthyCreditBalance(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
  dataDir: string = join(process.cwd(), 'data'),
): Promise<CreditBalance | null> {
  const summary = await fetchPhanthyActivitiesSummary(product, credential, fetcher, dataDir)
  return summary === null ? null : parsePhanthyCreditBalance(summary)
}

/** summary → CreditBalance，失败时带具体原因。 */
export async function fetchPhanthyCreditBalanceDetailed(
  product: PhanthyProduct,
  credential: PhanthyCredential,
  fetcher: typeof fetch,
  dataDir: string = join(process.cwd(), 'data'),
): Promise<{ balance: CreditBalance | null; error?: string }> {
  const result = await fetchPhanthyActivitiesSummaryDetailed(product, credential, fetcher, dataDir)
  return result.summary === null
    ? { balance: null, error: result.error }
    : { balance: parsePhanthyCreditBalance(result.summary) }
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
  const uid = credential.uid.trim().length > 0 ? credential.uid : uidFromAccessToken(credential.access_token)
  if (uid.length === 0) {
    return { kind: 'failed', code: -1, message: '凭据缺少 uid，无法领取每日奖励' }
  }

  let identity: PhanthyDesktopIdentity
  try {
    identity = await loadOrCreatePhanthyDesktopIdentity(uid, dataDir)
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
