import { randomUUID } from 'node:crypto'

import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
} from './credits.js'
import { CODEBUDDY } from './product.js'
import type {
  AutomationConfig,
  AutomationJobRecord,
  AutomationRunRecord,
  RpcCreditsClaimAllResponse,
  GrowthTaskView,
  RpcAutomationTasksResponse,
} from './types.js'

export const AUTOMATION_TIMEZONE = 'Asia/Shanghai'
export const AUTOMATION_JOB_DEFINITIONS: readonly AutomationJobRecord[] = [
  {
    id: 'cn_daily',
    name: 'CodeBuddy 每日自动化',
    description: '签到、对话活跃、成长任务、猫猫旅行与保活。',
    schedule: ['09:00', '21:00'],
    enabled: true,
  },
  {
    id: 'intl_daily',
    name: 'WorkBuddy 国际版活跃',
    description: '每日活跃对话上报与账号保活。',
    schedule: ['09:00', '21:00'],
    enabled: true,
  },
  {
    id: 'night_owl',
    name: '夜猫子任务',
    description: '23:00 后补足 glm-5.2 对话事件。',
    schedule: ['01:00'],
    enabled: true,
  },
  {
    id: 'all_daily_signin',
    name: '全服务商每日签到',
    description: '统一执行所有支持签到的服务商，重复签到会自动识别。',
    schedule: ['09:10'],
    enabled: true,
  },
]

const DAILY_SIGNIN_PROVIDERS = [
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'loomy',
  'phanthy',
] as const

const DAILY_SIGNIN_SKIP_REASONS: Readonly<Record<string, string>> = {
  cline: 'Cline 没有每日签到接口',
  raccoon: 'Raccoon Work 每日积分由服务端自动发放，无需签到',
}

const HTTP_TIMEOUT_MS = 30_000
const WEB_TURN_TIMEOUT_MS = 120_000
const WEB_TURN_POLL_INTERVAL_MS = 3_000
const WORKBUDDY_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
const DESKTOP_BASE = 'https://copilot.tencent.com'
const BILLING_BASE = 'https://www.codebuddy.cn'
const WORKBUDDY_WEB_BASE = 'https://www.workbuddy.ai'
const WEB_BASE = 'https://www.workbuddy.cn'
const SCHOOL_BASE = `${BILLING_BASE}/portal/activity/school`
const SCHOOL_OPEN_DAY_ACTIVITY_ID = 'school_open_day_2026'
const MP_TASK_CODES = new Set([
  'school_season',
  'Sequential_Tasks_1',
  'Sequential_Tasks_2',
  'Sequential_Tasks_3',
  'Sequential_Tasks_4',
  'Sequential_Tasks_5',
  'Sequential_Tasks_6',
  'Sequential_Tasks_7',
])

export interface AutomationAccountSnapshot {
  id: string
  provider: string
  nickname: string
  enabled: boolean
  credentialRef: string
  reserveCredits?: number
  balanceSnapshots?: Record<string, unknown>
  credential?: BuddyAutomationCredential
}

export interface AutomationCredentialStore {
  resolve(refName: string): Promise<{ value: string } | undefined>
  set(refName: string, value: string): Promise<void>
}

export interface AutomationDeps {
  accounts: readonly AutomationAccountSnapshot[]
  credentials: AutomationCredentialStore
  appendRuns(records: readonly AutomationRunRecord[]): Promise<void>
  /** 读取已落盘的运行记录（最新在前），用于合并同一天的分服务商签到结果。 */
  runs?(): Promise<readonly AutomationRunRecord[]>
  jobs(): Promise<readonly AutomationJobRecord[]>
  setJobs(jobs: readonly AutomationJobRecord[]): Promise<void>
  config(): Promise<AutomationConfig>
  claimProviderCredits?(provider: string): Promise<RpcCreditsClaimAllResponse>
  fetcher?: typeof fetch
  logger?: { info?(message: string): void; warn?(message: string): void }
  now?: () => number
}

export interface BuddyAutomationCredential {
  access_token?: unknown
  refresh_token?: unknown
  user_id?: unknown
  enterprise_id?: unknown
  domain?: unknown
  nickname?: unknown
}

interface AutomationAccount extends AutomationAccountSnapshot {
  credential: BuddyAutomationCredential
}

export function normalizeAutomationJobs(
  persisted: readonly AutomationJobRecord[] | undefined,
): AutomationJobRecord[] {
  const persistedById = new Map((persisted ?? []).map((job) => [job.id, job]))
  return AUTOMATION_JOB_DEFINITIONS.map((definition) => {
    const saved = persistedById.get(definition.id)
    return {
      ...definition,
      schedule: normalizeAutomationSchedule(saved?.schedule) ?? definition.schedule,
      enabled: saved?.enabled ?? definition.enabled,
      lastRunAt: saved?.lastRunAt,
      lastStatus: saved?.lastStatus,
      lastMessage: saved?.lastMessage,
    }
  })
}

/** 保留合法的 HH:mm 调度点，并去重。 */
export function normalizeAutomationSchedule(schedule: unknown): string[] | undefined {
  if (!Array.isArray(schedule)) return undefined
  const values = schedule
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
  const unique = [...new Set(values)]
  return unique.length === 0 ? undefined : unique
}

/** 更新指定自动化任务的调度点，返回新任务列表。 */
export function setAutomationJobSchedule(
  jobs: readonly AutomationJobRecord[],
  jobId: string,
  schedule: readonly string[],
): AutomationJobRecord[] | undefined {
  const normalized = normalizeAutomationSchedule(schedule)
  if (normalized === undefined || !jobs.some((job) => job.id === jobId)) return undefined
  return jobs.map((job) => job.id === jobId ? { ...job, schedule: normalized } : job)
}

export function enabledJobIds(config: AutomationConfig): string[] {
  return AUTOMATION_JOB_DEFINITIONS
    .filter((job) => config.enabled && config.enabledJobs[job.id] !== false)
  .map((job) => job.id)
}

export function automationEnabledAccounts(deps: AutomationDeps): AutomationAccount[] {
  return (deps.accounts as AutomationAccount[]).filter((account) => {
    if (account.enabled !== true) return false
    if (account.provider !== CODEBUDDY.id && account.provider !== 'workbuddy') return false
    if (account.credentialRef.length === 0) return false
    const reserve = typeof account.reserveCredits === 'number' ? account.reserveCredits : 0
    if (reserve <= 0) return true
    const total = totalBalance(account)
    return total === undefined ? true : total > reserve
  })
}

function totalBalance(account: AutomationAccountSnapshot): number | undefined {
  const snapshots = account.balanceSnapshots
  if (typeof snapshots !== 'object' || snapshots === null) return undefined
  let total = 0
  let found = false
  for (const value of Object.values(snapshots as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    const amount = typeof record.total === 'number' ? record.total : Number(record.amount)
    if (Number.isFinite(amount)) {
      total += amount
      found = true
    }
  }
  return found ? total : undefined
}

export async function ensureAutomationJobs(deps: AutomationDeps): Promise<void> {
  const persisted = await deps.jobs()
  const next = normalizeAutomationJobs(persisted)
  const same = JSON.stringify(next) === JSON.stringify(persisted)
  if (!same) await deps.setJobs(next)
}

export function currentShanghaiTime(now: number | Date = Date.now()): {
  date: string
  time: string
} {
  const date = new Date(now)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUTOMATION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const read = (kind: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === kind)?.value ?? ''
  const hour = read('hour') === '24' ? '00' : read('hour')
  return { date: `${read('year')}-${read('month')}-${read('day')}`, time: `${hour}:${read('minute')}` }
}

export function dueAutomationJobIds(now: number, jobs: readonly AutomationJobRecord[]): string[] {
  const { time } = currentShanghaiTime(now)
  return jobs.filter((job) => job.enabled && job.schedule.includes(time)).map((job) => job.id)
}

/**
 * 当前应执行签到记录的服务商列表。每个服务商可用 `signinSchedules` 覆盖
 * 全局 `all_daily_signin` 时间；未配置的服务商沿用全局调度点。
 */
export function dueDailySigninProviders(
  now: number,
  config: AutomationConfig,
  jobSchedule: readonly string[] = [],
): string[] {
  const { time } = currentShanghaiTime(now)
  const fallback = jobSchedule[0] ?? '09:10'
  return DAILY_SIGNIN_PROVIDERS.filter((provider) =>
    (config.signinSchedules?.[provider] ?? fallback) === time,
  )
}

async function fetchText(
  url: string,
  credential: BuddyAutomationCredential,
  headers: Record<string, string> = {},
  method: 'GET' | 'POST' = 'POST',
  body: unknown = {},
): Promise<Record<string, unknown>> {
  const fetcher = depsFetcher
  const response = await fetcher(url, {
    method,
    headers: {
      ...headers,
      Authorization: `Bearer ${asToken(credential.access_token)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-User-Id': asText(credential.user_id),
      'X-Domain': asText(credential.domain) || DESKTOP_BASE.replace('https://', ''),
      'X-CodeBuddy-Request': '1',
      'Accept-Language': 'zh-CN',
      'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(response.status === 401 || response.status === 403
      ? `凭据已失效（HTTP ${response.status}），请重新登录`
      : `非 JSON 响应（HTTP ${response.status}）`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('响应格式无效')
  return parsed as Record<string, unknown>
}

let depsFetcher: typeof fetch = fetch
export function setAutomationFetcher(fetcher: typeof fetch): void {
  depsFetcher = fetcher
}

async function requestJson(
  deps: AutomationDeps,
  credential: BuddyAutomationCredential,
  url: string,
  method: 'GET' | 'POST' = 'POST',
  body: unknown = {},
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const previous = depsFetcher
  depsFetcher = deps.fetcher ?? fetch
  try {
    return await fetchText(url, credential, extraHeaders, method, body)
  } finally {
    depsFetcher = previous
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asToken(value: unknown): string {
  const value2 = asText(value)
  if (value2.length === 0) throw new Error('凭据缺失 access_token')
  return value2
}

function expectOk(body: Record<string, unknown>, action: string): Record<string, unknown> {
  if (body.code !== 0) {
    throw new Error(`${action}失败：${asText(body.msg) || asText(body.message) || asText(body.code)}`)
  }
  const data = body.data
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

function stableId(account: AutomationAccount, purpose: string): string {
  const value = `${account.id}:${purpose}`
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

export async function runAutomationJob(
  deps: AutomationDeps,
  jobId: string,
  filter: { provider?: string; accountId?: string } = {},
): Promise<AutomationRunRecord[]> {
  await ensureAutomationJobs(deps)
  const config = await deps.config()
  if (!config.enabled || config.enabledJobs[jobId] === false) {
    return []
  }
  const jobs = normalizeAutomationJobs(await deps.jobs())
  const job = jobs.find((item) => item.id === jobId)
  if (job === undefined) return []

  // 全服务商签到是逐账号串行的长流程（每账号最多 15~30s 超时，可能跑几分钟），
  // 且调度器会按服务商分别触发。运行期间必须让卡片显示「执行中」，
  // 否则用户点完只能看到上一次的失败结果，以为点击没生效。
  if (RUNNING_JOBS.has(jobId)) {
    throw new Error('该任务正在执行中，请等当前一轮结束后再试')
  }
  RUNNING_JOBS.add(jobId)
  try {
    await persistJobRunning(deps, jobs, jobId)

    if (jobId === 'all_daily_signin') {
      const records = await runAllDailySignin(deps, jobId, filter.provider)
      await deps.appendRuns(records)
      await persistJobRun(deps, jobs, jobId, records)
      return records
    }

    const accounts = automationEnabledAccounts(deps).filter((account) =>
      (filter.provider === undefined || filter.provider === account.provider) &&
      (filter.accountId === undefined || filter.accountId === account.id),
    )
    const records: AutomationRunRecord[] = []
    for (const account of accounts) {
      records.push(await runAccountJob(deps, jobId, account))
      await sleep(250)
    }
    if (records.length === 0) {
      records.push(makeRun(jobId, 'all', 'skipped', Date.now(), '没有可执行的启用账号', {}))
    }
    await deps.appendRuns(records)
    await persistJobRun(deps, jobs, jobId, records)
    return records
  } finally {
    RUNNING_JOBS.delete(jobId)
  }
}

/**
 * 进程内运行中标记。
 *
 * 只需防同一进程内的重复点击/调度重叠：定时器每 60s 轮询一次，而一次
 * 全服务商签到可能更久，没有这个锁就会出现两轮并发签到（触发风控）。
 */
const RUNNING_JOBS = new Set<string>()

/** 把任务标成「执行中」，使前端在长流程期间不再展示上一次的结论。 */
async function persistJobRunning(
  deps: AutomationDeps,
  jobs: readonly AutomationJobRecord[],
  jobId: string,
): Promise<void> {
  const nextJobs = jobs.map((item) => item.id === jobId
    ? {
        ...item,
        lastRunAt: Date.now(),
        lastStatus: 'running' as const,
        lastMessage: '正在执行…',
      }
    : item)
  await deps.setJobs(nextJobs)
}

async function persistJobRun(
  deps: AutomationDeps,
  jobs: readonly AutomationJobRecord[],
  jobId: string,
  records: readonly AutomationRunRecord[],
): Promise<void> {
  const completedAt = Date.now()
  const summarized = jobId === 'all_daily_signin'
    ? await aggregateDailySigninRuns(deps, records, completedAt)
    : records
  const { status, message } = summarizeJobRun(summarized)
  const nextJobs = jobs.map((item) => item.id === jobId
    ? {
        ...item,
        lastRunAt: completedAt,
        lastStatus: status,
        lastMessage: message,
      }
    : item)
  await deps.setJobs(nextJobs)
}

/**
 * 把本次签到结果与**同一天已落盘**的其它服务商结果合并。
 *
 * 为什么需要：调度器按服务商分别触发「全服务商每日签到」（每个服务商可配
 * 自己的时间），每次只产生一条记录。若直接用它覆盖任务状态，最后一个跑的
 * 服务商就决定了整张卡片的成败 —— 实测表现为「其余服务商都成功，卡片却
 * 显示失败」（真实报障 2026-10-02）。
 *
 * 一次性的全量运行（不带 provider 过滤）本就是完整快照，直接返回。
 */
async function aggregateDailySigninRuns(
  deps: AutomationDeps,
  records: readonly AutomationRunRecord[],
  completedAt: number,
): Promise<readonly AutomationRunRecord[]> {
  if (records.length > 1 || deps.runs === undefined) return records
  let persisted: readonly AutomationRunRecord[]
  try {
    persisted = await deps.runs()
  } catch {
    return records
  }
  const today = currentShanghaiTime(completedAt).date
  // 同一服务商只保留当天最后一次结果（后写入的生效）。
  // `automationRuns()` 是**最新在前**，所以从末尾向前遍历，让新的覆盖旧的。
  const merged = new Map<string, AutomationRunRecord>()
  for (let index = persisted.length - 1; index >= 0; index -= 1) {
    const record = persisted[index]
    if (record === undefined) continue
    if (record.jobId !== 'all_daily_signin') continue
    if (currentShanghaiTime(record.completedAt).date !== today) continue
    merged.set(record.provider ?? record.task, record)
  }
  for (const record of records) merged.set(record.provider ?? record.task, record)
  return [...merged.values()]
}

function summarizeJobRun(
  records: readonly AutomationRunRecord[],
): { status: ReturnType<typeof summarizeStatus>; message: string } {
  const status = summarizeStatus(records)
  const succeeded = records.filter((record) => record.status === 'success')
  const skipped = records.filter((record) => record.status === 'skipped')
  const failed = records.filter((record) => record.status === 'error')
  const summary = `${succeeded.length} 个服务商成功，${skipped.length} 个跳过，${failed.length} 个失败`

  if (records.length === 1) {
    return { status, message: records[0]?.message ?? summary }
  }
  if (failed.length > 0) {
    return {
      status,
      message: `${summary}；${failed.map((record) => summarizeRun(record)).join('；')}`,
    }
  }
  if (succeeded.length > 0) {
    return {
      status,
      message: `${summary}：${succeeded.map((record) => summarizeRun(record)).join('；')}`,
    }
  }
  return { status, message: summary }
}

function summarizeRun(record: AutomationRunRecord): string {
  const label = PROVIDER_LABELS[record.task] ?? record.task
  const message = record.message ?? '已完成'
  return `${label}：${message}`
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  codearts: '华为 CodeArts',
  buddy: '腾讯 CodeBuddy',
  workbuddy: 'WorkBuddy (国际版)',
  lobsterai: '有道 LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder 中国版',
  trae: 'TRAE',
  loomy: '讯飞 Loomy',
  phanthy: 'PhanthyCode',
  cline: 'Cline',
  raccoon: 'Raccoon Work',
}

async function runAllDailySignin(
  deps: AutomationDeps,
  jobId: string,
  providerFilter?: string,
): Promise<AutomationRunRecord[]> {
  const candidates = providerFilter === undefined
    ? [...DAILY_SIGNIN_PROVIDERS, ...Object.keys(DAILY_SIGNIN_SKIP_REASONS)]
    : [providerFilter]
  const records: AutomationRunRecord[] = []

  for (const provider of candidates) {
    const startedAt = Date.now()
    const skipReason = DAILY_SIGNIN_SKIP_REASONS[provider]
    if (skipReason !== undefined) {
      records.push(withProvider(makeRun(jobId, provider, 'skipped', startedAt, skipReason), provider))
      continue
    }
    if (!DAILY_SIGNIN_PROVIDERS.includes(provider as typeof DAILY_SIGNIN_PROVIDERS[number])) {
      records.push(withProvider(makeRun(jobId, provider, 'skipped', startedAt, `不支持每日签到任务：${provider}`), provider))
      continue
    }
    if (deps.claimProviderCredits === undefined) {
      records.push(withProvider(makeRun(jobId, provider, 'error', startedAt, '签到执行器未配置'), provider))
      continue
    }

    try {
      const result = await deps.claimProviderCredits(provider)
      const summary = result.summary
      const status: AutomationRunRecord['status'] = summary.failed > 0
        ? 'error'
        : summary.claimed > 0 || summary.alreadyClaimed > 0
          ? 'success'
          : 'skipped'
      // ⚠️ **失败必须出现在文案里**。旧实现只在 claimed/alreadyClaimed/inactive
      // 都为空时回一句「没有可执行账号」，于是「账号存在但凭据失效、全部请求
      // 被拒」这种最常见的故障被伪装成「没账号」（真实报障 2026-10-02：用户
      // 看到 Qoder/TRAE 报「没有可执行账号」，以为任务没跑完）。
      const parts: string[] = []
      if (summary.claimed > 0) parts.push(`新增 ${summary.claimed} 个签到，获得 ${summary.totalCredit} 积分`)
      if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个账号今日已签到`)
      if (summary.inactive > 0) parts.push(`${summary.inactive} 个账号当前不可签到`)
      if (summary.failed > 0) parts.push(`${summary.failed} 个账号执行失败`)
      const message = parts.length > 0 ? parts.join('；') : '没有可执行账号'
      const details = {
        summary,
        results: result.results,
      }
      records.push(withProvider(makeRun(jobId, provider, status, startedAt, message, details), provider))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      records.push(withProvider(makeRun(jobId, provider, 'error', startedAt, message), provider))
    }
    await sleep(350)
  }

  return records
}

function withProvider(record: AutomationRunRecord, provider: string): AutomationRunRecord {
  return { ...record, provider }
}

function summarizeStatus(records: readonly AutomationRunRecord[]): 'success' | 'skipped' | 'unverified' | 'error' {
  if (records.some((record) => record.status === 'error')) return 'error'
  if (records.some((record) => record.status === 'unverified')) return 'unverified'
  if (records.some((record) => record.status === 'success')) return 'success'
  return 'skipped'
}

function makeRun(
  jobId: string,
  task: string,
  status: AutomationRunRecord['status'],
  startedAt: number,
  message?: string,
  details?: Record<string, unknown>,
): AutomationRunRecord {
  return {
    id: randomUUID(),
    jobId,
    task,
    status,
    startedAt,
    completedAt: Date.now(),
    ...message === undefined ? {} : { message },
    ...details === undefined ? {} : { details },
  }
}

async function runAccountJob(
  deps: AutomationDeps,
  jobId: string,
  account: AutomationAccount,
): Promise<AutomationRunRecord> {
  const startedAt = Date.now()
  try {
    if (jobId === 'cn_daily') return await runCnDaily(deps, jobId, account, startedAt)
    if (jobId === 'intl_daily') return await runIntlDaily(deps, jobId, account, startedAt)
    if (jobId === 'night_owl') return await runNightOwl(deps, jobId, account, startedAt)
    return makeRun(jobId, account.id, 'skipped', startedAt, `未知任务：${jobId}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return makeRun(jobId, account.id, 'error', startedAt, message)
  }
}

async function runCnDaily(deps: AutomationDeps, jobId: string, account: AutomationAccount, startedAt: number): Promise<AutomationRunRecord> {
  if (account.provider !== CODEBUDDY.id) {
    return makeRun(jobId, account.id, 'skipped', startedAt, '国际版账号，跳过国内任务')
  }
  const details: Record<string, unknown> = {}
  let message = ''

  const statusBody = await requestJson(deps, account.credential, `${CODEBUDDY.endpoint}/v2/billing/meter/checkin-activity-status`)
  if (statusBody.code === 0) {
    const status = expectOk(statusBody, '查询签到状态')
    if (status.today_checked_in !== true) {
    const claimBody = await requestJson(deps, account.credential, `${CODEBUDDY.endpoint}/v2/billing/meter/daily-checkin`)
      if (claimBody.code === 0) {
        const data = expectOk(claimBody, '每日签到')
        details.checkin = { credit: data.credit ?? 0 }
        message += '每日签到成功。'
      } else {
        details.checkin = { code: claimBody.code, message: claimBody.msg ?? claimBody.message }
      }
    } else {
      details.checkin = { skipped: 'already-claimed' }
    }
  } else {
    details.checkin = { code: statusBody.code, message: statusBody.msg ?? statusBody.message }
  }

  const conversation = randomId('wb2api')
  const activeEvents = [desktopChatSequence(conversation)]
  await reportDesktop(deps, account, activeEvents)
  await sleep(1_050)
  message += '对话活跃已上报。'

  const growth = await runGrowthTasks(deps, account)
  details.growth = growth.details
  message += growth.message

  const travel = await runTravel(deps, account)
  details.travel = travel.details
  message += travel.message

  details.streakBonus = await runStreakBonus(deps, account)

  const balanceBody = await requestJson(deps, account.credential, `${CODEBUDDY.endpoint}/v2/billing/meter/get-user-resource`)
  if (balanceBody.code === 0) details.balance = summarizeBalance(balanceBody)

  return makeRun(jobId, account.id, 'success', startedAt, message || '国内自动化已完成', details)
}

async function runIntlDaily(deps: AutomationDeps, jobId: string, account: AutomationAccount, startedAt: number): Promise<AutomationRunRecord> {
  if (account.provider !== 'workbuddy') return makeRun(jobId, account.id, 'skipped', startedAt, '不是国际版账号')
  const conversation = randomId('wb2api-intl')
  await reportDesktop(deps, account, [desktopChatSequence(conversation)])
  const details: Record<string, unknown> = { desktopActivity: true }
  try {
    const web = await runWorkbuddyWebDaily(deps, account)
    details.webConversation = web
    const chunks = asNumberValue(web.chunks) ?? 0
    const status = asText(web.status)
    if (web.ok === true && status === 'completed') {
      return makeRun(jobId, account.id, 'success', startedAt, `网页通道活跃会话已完成，输出 ${chunks} 段`, details)
    }
    return makeRun(jobId, account.id, 'unverified', startedAt, `网页通道未完成：${asText(web.error) || status || '状态未知'}`, details)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    details.webConversation = { ok: false, error: message }
    return makeRun(jobId, account.id, 'unverified', startedAt, `网页通道执行失败：${message}`, details)
  }
}

async function runNightOwl(deps: AutomationDeps, jobId: string, account: AutomationAccount, startedAt: number): Promise<AutomationRunRecord> {
  if (account.provider !== CODEBUDDY.id) {
    return makeRun(jobId, account.id, 'skipped', startedAt, '国际版账号，跳过夜猫任务')
  }
  const { time } = currentShanghaiTime()
  const hourNumber = Number(time.slice(0, 2))
  if (!(hourNumber >= 23 || hourNumber < 8)) {
    return makeRun(jobId, account.id, 'skipped', startedAt, '不在 23:00-08:00 窗口')
  }
  const task = await getTask(deps, account, 'black_cat', false)
  if (task === undefined) return makeRun(jobId, account.id, 'skipped', startedAt, '夜猫任务未下发')
  if (task.acceptStatus === 'claimed') return makeRun(jobId, account.id, 'success', startedAt, '夜猫任务已领奖')
  if (task.acceptStatus === '' || task.acceptStatus === 'not_accepted') {
    await acceptTask(deps, account, 'black_cat', false)
  }
  const target = task.target || 3
  const need = Math.max(1, target - task.current)
  const events = desktopChatSequence(randomId('wb2api-night'), 'glm-5.2', 'GLM-5.2')
  for (const event of events) {
    if ((event as Record<string, unknown>).eventCode === 'chat_request_send') {
      ;(event as Record<string, unknown>).mode = 'night'
    }
  }
  await reportDesktop(deps, account, events)
  const refreshed = await waitTaskCompletion(deps, account, { ...task, current: task.current + 1 }, false)
  if (refreshed.current >= (refreshed.target || target)) {
    await claimTask(deps, account, 'black_cat', false)
    return makeRun(jobId, account.id, 'success', startedAt, '夜猫任务达标并已领奖', { progress: `${refreshed.current}/${refreshed.target || target}` })
  }
  return makeRun(jobId, account.id, 'unverified', startedAt, `夜猫进度 ${refreshed.current}/${refreshed.target || target}，明晚继续累计`)
}

function desktopChatSequence(conversationId: string, modelId = 'fast-model', modelName = 'fast-model'): Record<string, unknown>[] {
  const messageId = randomId('msg')
  const now = Date.now()
  const base = {
    traceId: conversationId,
    rootRequestId: conversationId,
    parentConversationId: conversationId,
    agentName: 'cli',
    agentType: 'main',
  }
  return [
    {
      eventCode: 'agent_task_created',
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [], has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '', has_expert: false,
      expert_id: '', expert_name: '', expert_industry_id: '', has_skill: false,
      skill_names: [], conversationId, messageId, buddyId: '', buddyName: '',
    },
    { eventCode: 'chat_message_send', messageId: `${messageId}-assistant`, historyCount: 0, isContextTruncated: false, currentStepCount: 1, ...base },
    {
      eventCode: 'chat_request_send', inputLength: 24, isPlan: false,
      isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
      maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: '',
      mentionContextCount: 0, command: '', recommendId: '', skillId: '',
      skillCount: 0, totalCount: 0, ...base,
      requestModelId: modelId, requestModelName: modelName,
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': conversationId,
    },
    {
      eventCode: 'chat_message_response', messageId: `${messageId}-assistant`,
      responseModelId: modelId, inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0, isSuccessful: true,
      messageErrorCode: '', finishReason: 'stop', firstTokenAt: now, conversationId, ...base,
    },
    { eventCode: 'chat_message_status', messageId: `${messageId}-assistant`, messageErrorCode: '0', ...base },
    {
      eventCode: 'chat_request_response', mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200, cachedTokens: 0,
      cachedWriteTokens: 0, cachedMissTokens: 0, isSuccessful: true,
      messageErrorCode: '', finishReason: 'stop', conversationId,
    },
  ]
}

/** 国际版每日活跃要走网页 agent 会话；只创建会话不接沙箱不会被计为有效对话。 */
async function runWorkbuddyWebDaily(deps: AutomationDeps, account: AutomationAccount): Promise<Record<string, unknown>> {
  const webHeaders = {
    Authorization: `Bearer ${asToken(account.credential.access_token)}`,
    'X-User-Id': asText(account.credential.user_id),
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: WORKBUDDY_WEB_BASE,
    Referer: `${WORKBUDDY_WEB_BASE}/app`,
    'User-Agent': WORKBUDDY_WEB_USER_AGENT,
  }
  const fetcher = deps.fetcher ?? fetch
  const webJson = async (url: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      method,
      headers: webHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      throw new Error(`非 JSON 响应（HTTP ${response.status}）`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('响应格式无效')
    const record = parsed as Record<string, unknown>
    if (record.code !== 0 && record.code !== undefined && record.code !== null) {
      throw new Error(`${asText(record.msg) || asText(record.message) || asText(record.code)}`)
    }
    return record
  }

  const conversationBody = await webJson(`${WORKBUDDY_WEB_BASE}/console/as/conversations/`, 'POST', {
    conversationOrigin: 'workbuddy-app',
    model: 'deepseek-v4.1-flash',
    plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
    prompt: 'Hi',
  })
  const conversation = asText(expectOk(conversationBody, '创建网页会话').id)
  if (conversation.length === 0) throw new Error('创建网页会话成功但未返回 id')

  const encodedConversation = encodeURIComponent(conversation)
  const sessionBody = await webJson(
    `${WORKBUDDY_WEB_BASE}/console/as/conversations/${encodedConversation}/session`,
    'GET',
  )
  const session = expectOk(sessionBody, '查询网页会话沙箱')
  const link = asText(session.link) || asText(session.endpoint)
  const token = asText(session.token)
  const sessionId = asText(session.sessionId) || asText(session.session_id) || conversation
  const cwd = asText(session.cwd) || '/workspace'
  if (link.length === 0 || token.length === 0) {
    return { ok: false, conversation, error: '沙箱未就绪（缺少 link 或 token）' }
  }

  const turn = await driveAcpTurn(
    deps,
    link,
    token,
    sessionId,
    cwd,
    'Hi',
    webHeaders['User-Agent'],
    async () => {
      const body = await webJson(
        `${WORKBUDDY_WEB_BASE}/console/as/conversations/${encodedConversation}`,
        'GET',
      )
      return asText(expectOk(body, '查询网页会话状态').status)
    },
  )
  return { ...turn, conversation }
}

interface AcpTurn {
  ok?: boolean
  status?: string
  events?: number
  chunks?: number
  elapsedMs?: number
  error?: string
}

let acpChunkCount = 0

async function readAcpStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload.length > 0 && payload !== '[DONE]') {
            try {
              const message = JSON.parse(payload) as { params?: { update?: { sessionUpdate?: unknown } } }
              if (message.params?.update?.sessionUpdate === 'agent_message_chunk') acpChunkCount += 1
            } catch { /* 忽略非 JSON 事件 */ }
          }
        }
        index = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 网页沙箱采用 streamable HTTP：GET 建立一条 SSE 事件流，POST 发送 JSON-RPC。
 * 这里不取沙箱里的响应正文，只确保 prompt 这一轮真正驱动到 completed。
 */
async function driveAcpTurn(
  deps: AutomationDeps,
  linkText: string,
  token: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  userAgent: string,
  readStatus: () => Promise<string>,
): Promise<AcpTurn> {
  let link: URL
  try {
    link = new URL(linkText)
  } catch {
    throw new Error('沙箱地址不可用')
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') throw new Error('沙箱地址协议不可用')

  const startedAt = Date.now()
  const fetcher = deps.fetcher ?? fetch
  acpChunkCount = 0
  let error = ''
  let status = ''

  try {
    const stream = await fetcher(link, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      },
    })
    if (!stream.ok) throw new Error(`SSE 通道返回 HTTP ${stream.status}`)
    const connectionId = stream.headers.get('Acp-Connection-Id') ?? ''
    if (connectionId.length === 0) throw new Error('SSE 通道没有返回 Acp-Connection-Id')
    if (stream.body !== null) void readAcpStream(stream.body).catch(() => undefined)

    const request = async (id: number, method: string, params: Record<string, unknown>): Promise<void> => {
      const response = await fetcher(link, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          'Acp-Connection-Id': connectionId,
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`${method} 返回 HTTP ${response.status}`)
    }

    await request(1, 'initialize', { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, protocolVersion: 1 })
    await request(2, 'session/load', { cwd: cwd || '/workspace', mcpServers: [], sessionId })
    await request(3, 'session/prompt', { prompt: [{ text: prompt, type: 'text' }], sessionId })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const deadline = Date.now() + WEB_TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      status = await readStatus()
      if (status === 'completed') return { ok: true, status, chunks: acpChunkCount, elapsedMs: Date.now() - startedAt }
      if (status === 'failed' || status === 'error') {
        return { ok: false, status, chunks: acpChunkCount, elapsedMs: Date.now() - startedAt, error: `会话状态=${status}` }
      }
    } catch { /* 状态查询暂时失败不终止等待 */ }
    await sleep(WEB_TURN_POLL_INTERVAL_MS)
  }
  return {
    ok: false,
    status: status || 'unknown',
    chunks: acpChunkCount,
    elapsedMs: Date.now() - startedAt,
    error: error.length > 0 ? error : `会话在 ${WEB_TURN_TIMEOUT_MS / 1000}s 内没有跑完`,
  }
}

function desktopFingerprint(account: AutomationAccount): Record<string, unknown> {
  const now = Date.now()
  return {
    timestamp: now, presentAt: now,
    userId: asText(account.credential.user_id),
    userNickname: asText(account.credential.nickname) || account.nickname,
    ideName: 'WorkBuddy', ideType: 'WorkBuddy', ideVersion: '5.5.6',
    machineId: stableId(account, 'machine'), sessionId: stableId(account, 'session'),
    extName: 'workbuddy-desktop', extVersion: '5.5.6',
    os: 'win32', arch: 'x64', osVersion: '10.0.26220',
    cpuCores: 20, memorySize: 24,
  }
}

function mergeFingerprint(event: unknown, account: AutomationAccount): Record<string, unknown> {
  const base = desktopFingerprint(account)
  const value = typeof event === 'object' && event !== null ? { ...(event as Record<string, unknown>) } : {}
  for (const [key, item] of Object.entries(base)) {
    if (value[key] === undefined) value[key] = item
  }
  return value
}

async function reportDesktop(deps: AutomationDeps, account: AutomationAccount, events: readonly unknown[]): Promise<void> {
  const body = events.map((event) => mergeFingerprint(event, account))
  await requestJson(deps, account.credential, `${DESKTOP_BASE}/v2/report`, 'POST', body, {
    'Content-Type': 'application/json;charset=UTF-8',
    'X-Product': 'SaaS',
    'X-Domain': DESKTOP_BASE.replace('https://', ''),
  })
}

function parseGrowthTasks(data: Record<string, unknown>): GrowthTask[] {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  return tasks.map((item): GrowthTask => {
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    let current = asNumberValue(record.current) ?? 0
    let target = asNumberValue(record.target) ?? 0
    const progress = typeof record.progress === 'object' && record.progress !== null ? record.progress as Record<string, unknown> : undefined
    if (progress !== undefined) {
      current = asNumberValue(progress.current) ?? current
      target = asNumberValue(progress.target) ?? target
    }
    const acceptStatus = asText(record.accept_status)
    return {
      taskCode: asText(record.task_code),
      title: asText(record.title) || asText(record.name) || asText(record.task_code),
      ...(asText(record.description).length > 0 || asText(record.desc).length > 0
        ? { description: asText(record.description) || asText(record.desc) }
        : {}),
      current, target, acceptStatus,
      ...(asText(record.reward).length > 0 || asNumberValue(record.reward_points) !== undefined
        ? { reward: asText(record.reward) || `${asNumberValue(record.reward_points)} 积分` }
        : {}),
      ...(asText(record.tag).length > 0 ? { tag: asText(record.tag) } : {}),
      ...(asText(record.jump_url).length > 0 ? { jumpUrl: asText(record.jump_url) } : {}),
      locked: record.locked === true,
      status: asText(record.status),
    }
  })
}

function asNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

interface GrowthTask {
  taskCode: string
  title: string
  description?: string
  current: number
  target: number
  acceptStatus: string
  reward?: string
  tag?: string
  jumpUrl?: string
  locked: boolean
  status: string
}

interface MarketExpert {
  expert_id: string
  expert_type: string
  display_name_zh: string
  profession_zh: string
  version: string
  categories: unknown[]
}

async function runGrowthTasks(deps: AutomationDeps, account: AutomationAccount): Promise<{ message: string; details: Record<string, unknown> }> {
  const lists = await Promise.allSettled([
    listTasks(deps, account, false),
    listTasks(deps, account, true),
  ])
  const tasks = new Map<string, GrowthTask>()
  for (const result of lists) {
    if (result.status !== 'fulfilled') continue
    for (const task of result.value) tasks.set(task.taskCode, task)
  }
  if (lists.every((result) => result.status === 'rejected')) throw new Error('成长任务列表获取失败')
  const claimed: string[] = []
  const events: string[] = []
  let claimedRewards = 0
  for (const task of tasks.values()) {
    if (task.taskCode.length === 0 || task.locked) continue
    if (task.acceptStatus === 'claimed') continue
    const isMp = MP_TASK_CODES.has(task.taskCode)
    if (task.acceptStatus === '' || task.acceptStatus === 'not_accepted') {
      if (isMp) {
        const accepted = await acceptTaskWithVerification(deps, account, task.taskCode)
        if (!accepted) {
          events.push(`${task.taskCode}:accept-unverified`)
          continue
        }
      } else {
        await acceptTask(deps, account, task.taskCode, false)
      }
    }
    if (task.target > 0 && task.current < task.target) {
      const generated = await emitTaskEvents(deps, account, task.taskCode, task.target - task.current)
      events.push(`${task.taskCode}:${generated}`)
    }
    const refreshed = await waitTaskCompletion(deps, account, { ...task, taskCode: task.taskCode }, isMp)
    const current = refreshed?.current ?? task.current
    const target = refreshed?.target || task.target || 1
    if (refreshed?.acceptStatus === 'claimed') continue
    if (current >= target || refreshed?.status === 'completed') {
      try {
        await claimTask(deps, account, task.taskCode, isMp)
        claimed.push(task.taskCode)
        claimedRewards += 1
      } catch (error) {
        events.push(`${task.taskCode}:claim-failed:${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(250)
    } else {
      events.push(`${task.taskCode}:${current}/${target}`)
    }
  }
  return {
    message: claimedRewards > 0 ? ` 成长任务已领奖 ${claimedRewards} 项。` : ' 成长任务已巡检。',
    details: { claimed, events },
  }
}

async function listTasks(deps: AutomationDeps, account: AutomationAccount, mp: boolean): Promise<GrowthTask[]> {
  const body = await requestJson(
    deps,
    account.credential,
    `${DESKTOP_BASE}/v2/activity/growth/tasks`,
    'GET',
    undefined,
    mp ? { 'X-Client-Platform': 'miniprogram' } : {},
  )
  return parseGrowthTasks(expectOk(body, '读取成长任务'))
}

/** 只读查询成长任务，桌面端与小程序分开返回；不接任务、不领奖。 */
export async function collectAutomationTasks(
  deps: AutomationDeps,
  accountId: string,
): Promise<RpcAutomationTasksResponse> {
  const account = deps.accounts.find((item): item is AutomationAccount =>
    item.id === accountId && typeof (item as AutomationAccount).credential?.access_token === 'string')
  if (account === undefined) {
    throw new Error('账号不可用或凭据缺失 access_token')
  }
  const lists = await Promise.allSettled([
    listTasks(deps, account, false),
    listTasks(deps, account, true),
  ])
  const toView = (task: GrowthTask): GrowthTaskView => ({
    taskCode: task.taskCode,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    current: task.current,
    target: task.target,
    ...(task.reward === undefined ? {} : { reward: task.reward }),
    acceptStatus: task.acceptStatus,
    status: task.status,
    locked: task.locked,
    ...(task.tag === undefined ? {} : { tag: task.tag }),
    ...(task.jumpUrl === undefined ? {} : { jumpUrl: task.jumpUrl }),
  })
  return {
    accountId,
    nickname: account.nickname,
    desktop: lists[0]?.status === 'fulfilled' ? lists[0].value.map(toView) : [],
    miniprogram: lists[1]?.status === 'fulfilled' ? lists[1].value.map(toView) : [],
    errors: lists.flatMap((result) => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []),
  }
}

async function getTask(deps: AutomationDeps, account: AutomationAccount, code: string, mp: boolean): Promise<GrowthTask | undefined> {
  return (await listTasks(deps, account, mp)).find((task) => task.taskCode === code)
}

async function acceptTask(deps: AutomationDeps, account: AutomationAccount, code: string, mp: boolean): Promise<void> {
  await requestJson(deps, account.credential, `${DESKTOP_BASE}/v2/activity/growth/tasks/accept`, 'POST', { task_codes: [code] }, mpHeaders(mp))
}

function mpHeaders(mp: boolean): Record<string, string> {
  return mp ? { 'X-Client-Platform': 'miniprogram' } : {}
}

async function claimTask(deps: AutomationDeps, account: AutomationAccount, code: string, mp: boolean): Promise<void> {
  const mpHeadersValue = { ...mpHeaders(mp), ...(mp ? {} : { 'x-client-platform': 'web' }) }
  const endpoint = mp ? `${DESKTOP_BASE}` : `${WEB_BASE}`
  try {
    await requestJson(deps, account.credential, `${endpoint}/activity/growth/tasks/${encodeURIComponent(code)}/claim`, 'POST', undefined, mpHeadersValue)
  } catch (error) {
    if (mp) {
      await requestJson(deps, account.credential, `${WEB_BASE}/activity/growth/tasks/${encodeURIComponent(code)}/claim`, 'POST', undefined, mpHeadersValue)
      return
    }
    throw error
  }
}

async function waitTaskCompletion(
  deps: AutomationDeps,
  account: AutomationAccount,
  task: GrowthTask,
  mp: boolean,
): Promise<GrowthTask> {
  let latest = task
  const target = latest.target || 1
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(3_000)
    const refreshed = await getTask(deps, account, latest.taskCode, mp)
    if (refreshed === undefined) continue
    latest = refreshed
    if ((latest.target || target) > 0 && latest.current >= (latest.target || target)) break
    if (latest.status === 'completed' || latest.acceptStatus === 'claimed') break
  }
  return latest
}

async function acceptTaskWithVerification(
  deps: AutomationDeps,
  account: AutomationAccount,
  code: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await acceptTask(deps, account, code, true)
    await sleep(2_000)
    const task = await getTask(deps, account, code, true)
    if (task !== undefined && task.acceptStatus !== '' && task.acceptStatus !== 'not_accepted') return true
  }
  return false
}

async function emitTaskEvents(deps: AutomationDeps, account: AutomationAccount, code: string, need: number): Promise<number> {
  const count = Math.max(1, need)
  const handled = await emitDesktopTaskEvents(deps, account, code, count)
  if (handled !== undefined) return handled
  const mpHandled = await emitMiniProgramTaskEvents(deps, account, code)
  if (mpHandled !== undefined) return mpHandled
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const conversation = randomId('wb2api-task')
    const events = code === 'Model_chat_GLM5.2'
      ? desktopChatSequence(conversation, 'glm-5.2', 'GLM-5.2')
      : desktopChatSequence(conversation)
    await reportDesktop(deps, account, events)
    if (index < count - 1) await sleep(1_050)
  }
  return Math.min(count, 5)
}

async function emitDesktopTaskEvents(
  deps: AutomationDeps,
  account: AutomationAccount,
  code: string,
  need: number,
): Promise<number | undefined> {
  if (code === 'Buddy_App' || code === 'Buddy_App_QQ') {
    await reportDesktop(deps, account, buddyAppSequence('cb_y5Dy46tPQGGWtueMxXbe', '企鹅教师助手'))
    return 1
  }
  if (code === 'automation_1' || code === 'Sequential_Tasks_4') {
    await reportDesktop(deps, account, [automationCreateEvent('Sub2API 自动化')])
    return 1
  }
  if (code === 'Library_read') {
    await reportWeb(deps, account, 'web_element_click', `${WEB_BASE}/space/d/o0KWYeynteVv06UnAZqIFm`, 'library_doc_intro_click', 'WorkBuddy资料库介绍')
    return 1
  }
  if (code === 'template_5') {
    const templates = [['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审']]
    const groups = Math.min(need, templates.length)
    for (let index = 0; index < groups; index += 1) {
      const conversationId = randomId('wb2api-tpl')
      const requestId = randomId('wb2api-tpl-req')
      await reportDesktop(deps, account, desktopTemplateUseSequence(conversationId, requestId, templates[index]![0], templates[index]![1]))
      await sleep(300)
    }
    return groups
  }
  if (code === 'playbook_prompt' || code === 'Sequential_Tasks_7') {
    const conversationId = randomId('wb2api-pb')
    const requestId = randomId('wb2api-pb-req')
    await reportDesktop(deps, account, desktopPlaybookPromptSequence(conversationId, requestId, 'pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸'))
    if (code === 'Sequential_Tasks_7') {
      await reportMiniProgram(deps, account, miniPlaybookEvents('pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸'))
    }
    return 1
  }
  if (code === 'create_canvas') {
    const conversationId = randomId('wb2api-canvas')
    const requestId = randomId('wb2api-canvas-req')
    await reportDesktop(deps, account, desktopDesignCanvasSequence(conversationId, requestId))
    return 1
  }
  if (code === 'Hp_Appearance') {
    const themeKey = 'theme-tkmw7j'
    await requestJson(deps, account.credential, `${DESKTOP_BASE}/v2/user-asset/appearance/set`, 'POST', { kind: 'theme', resource_key: themeKey })
    await sleep(2_000)
    await reportDesktop(deps, account, [{ eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close', id: themeKey, vipLevel: 0, series: '', type: 'unknown' }])
    return 1
  }
  if (code === 'skill_1') {
    const result = await desktopChatWithExpert(deps, account, '')
    if (result === undefined) return 0
    const { conversationId, requestId } = result
    const messageId = `msg-${requestId.slice(-8)}`
    const events = desktopChatSequence(conversationId, requestId, messageId).map((event) => {
      if ((event as Record<string, unknown>).eventCode === 'chat_message_response') {
        return { ...event, finishReason: 'tool_calls' }
      }
      return event
    })
    events.push({
      eventCode: 'skill_info', id: '润泽小馆·日报撰写', skillId: 'skill_2097350077599879168',
      skillVersion: '1.0.0', toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
      conversationId, requestId, messageId, requestModelId: 'fast-model', requestModelName: 'fast-model', traceId: requestId,
    })
    await reportDesktop(deps, account, events)
    return 1
  }
  if (code === 'expert_5' || code === 'Expert_team_use_3' || code === 'Expert_lighthouse') {
    const expertType = code === 'Expert_team_use_3' ? 'team' : 'agent'
    const experts = await marketExpertList(deps, account, expertType)
    if (experts.length === 0) return 0
    let completed = 0
    for (const expert of experts) {
      if (completed >= need) break
      if (code === 'Expert_lighthouse' && expert.expert_id !== 'ex_2cvvUZQhDyeJ') continue
      await reportDesktop(deps, account, desktopExpertSummonSequence(expert))
      const result = await desktopChatWithExpert(deps, account, expert.expert_id)
      if (result === undefined) continue
      const { conversationId, requestId } = result
      const events = desktopChatSequence(conversationId, requestId, `msg-${requestId.slice(-8)}`)
      for (const event of events) {
        const record = event as Record<string, unknown>
        if (record.eventCode === 'agent_task_created') {
          record.has_expert = true
          record.expert_id = expert.expert_id
          record.expert_name = expert.display_name_zh
          record.expert_industry_id = ''
        }
      }
      const useEvent = code === 'Expert_lighthouse'
        ? desktopExpertActualUseLocal(expert, conversationId, requestId)
        : desktopExpertActualUse(expert, conversationId, requestId)
      if (code === 'Expert_lighthouse') {
        useEvent.type = ''
        useEvent.cost = 0
      }
      events.push(useEvent)
      await reportDesktop(deps, account, events)
      completed += 1
      await sleep(6_000)
    }
    return completed
  }
  if (code === 'first_buddy') {
    await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/agreement`, 'POST', {})
    await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/first`, 'POST', {})
    return 1
  }
  return undefined
}

async function emitMiniProgramTaskEvents(deps: AutomationDeps, account: AutomationAccount, code: string): Promise<number | undefined> {
  if (code === 'school_season' || code === 'Sequential_Tasks_1' || code === 'Sequential_Tasks_3' || code === 'Sequential_Tasks_6') {
    const task = await getTask(deps, account, code, true)
    const target = task?.target || (code === 'Sequential_Tasks_3' ? 5 : code === 'Sequential_Tasks_6' ? 10 : 1)
    const current = task?.current ?? 0
    const need = Math.max(0, target - current)
    const gap = code === 'Sequential_Tasks_3' || code === 'Sequential_Tasks_6' ? 45_000 : 1_050
    for (let index = 0; index < Math.min(need, 10); index += 1) {
      if (index > 0 || current > 0) await sleep(gap + Math.floor(Math.random() * 10_000))
      const conversationId = randomId('wb2api-mp')
      const event = code === 'school_season'
        ? { ...miniChatEvent(conversationId), activityId: SCHOOL_OPEN_DAY_ACTIVITY_ID }
        : miniChatEvent(conversationId)
      await reportMiniProgram(deps, account, [event])
    }
    return Math.min(need, 10)
  }
  if (code === 'Sequential_Tasks_2') {
    const experts = await marketExpertList(deps, account, '')
    if (experts.length === 0) return 0
    const expert = experts[0]!
    const name = expert.display_name_zh || expert.profession_zh
    await reportMiniProgram(deps, account, [miniExpertUseEvent(expert.expert_id, name, expert.expert_type)])
    return 1
  }
  if (code === 'Sequential_Tasks_5') {
    await reportMiniProgram(deps, account, [miniChatModelEvent(randomId('wb2api-mp-glm'), 'glm-5.2', 'GLM-5.2')])
    return 1
  }
  return undefined
}

function buddyAppSequence(buddyId: string, buddyName: string): Record<string, unknown>[] {
  const make = (eventCode: string, extra: Record<string, unknown> = {}) => ({ eventCode, mode: 'LOCAL', buddyId, buddyName, ...extra })
  return [
    make('buddyapp_discover_click'),
    make('buddyapp_show', { elementId: buddyId, elementName: buddyName, position: 2 }),
    make('buddyapp_enter_click', { elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: '1' }),
    make('buddyapp_auth_confirm_click', { elementId: buddyId, elementName: buddyName }),
    make('buddyapp_bindaccount_skip_click', { elementId: buddyId, elementName: buddyName }),
  ]
}

async function reportWeb(deps: AutomationDeps, account: AutomationAccount, eventCode: string, pageUrl: string, elementId: string, elementName: string): Promise<void> {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  const event = {
    eventCode, timestamp: Date.now(), reportDelay: 0, pageURL: pageUrl,
    elementId, elementName, os: 'Win32', arch: '', osVersion: '10.0',
    userAgent, machineId: stableId(account, 'webmachine'),
    userId: asText(account.credential.user_id),
    userNickname: asText(account.credential.nickname) || account.nickname,
    enterpriseId: asText(account.credential.enterprise_id),
  }
  await requestJson(deps, account.credential, `${WEB_BASE}/v2/report`, 'POST', [event], {
    'x-client-platform': 'web', Origin: WEB_BASE, Referer: pageUrl, 'User-Agent': userAgent,
  })
}

async function runTravel(deps: AutomationDeps, account: AutomationAccount): Promise<{ message: string; details: Record<string, unknown> }> {
  try {
    const infoBody = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/info`, 'GET', undefined)
    const info = expectOk(infoBody, '读取猫猫信息')
    if (info.has_buddy !== true) {
      try {
        await reportDesktop(deps, account, desktopChatSequence(randomId('wb2api-adopt')))
        await sleep(1_050)
        await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/agreement`, 'POST', {})
        await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/first`, 'POST', {})
        return { message: ' 已完成领养流程。', details: { adopted: true } }
      } catch {
        return { message: ' 未领养猫猫，领养门槛未过，已重试。', details: { skipped: 'adopt-threshold' } }
      }
    }
    const statusBody = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/travel/status`, 'GET')
    const status = expectOk(statusBody, '读取旅行状态')
    const state = asText(status.state)
    if (state === 'arrived') {
      const recordId = asNumberValue(status.record_id) ?? 0
      if (recordId <= 0) return { message: '', details: { skipped: 'missing-record' } }
      const claim = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/travel/claim`, 'POST', { record_id: recordId })
      const data = expectOk(claim, '旅行领奖')
      return { message: ' 猫猫旅行奖励已领取。', details: { reward: data.reward ?? data.credit ?? 0 } }
    }
    if (state === 'idle' && status.daily_limit_reached !== true) {
      await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/buddy/travel/depart`, 'POST', { location_id: 4 })
      return { message: ' 猫猫已派出。', details: { state: 'traveling' } }
    }
    return { message: '', details: { state } }
  } catch (error) {
    return { message: ` 猫猫旅行处理失败：${error instanceof Error ? error.message : String(error)}。`, details: { error: true } }
  }
}

function summarizeBalance(body: Record<string, unknown>): unknown {
  const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : {}
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : Array.isArray(data.accounts) ? data.accounts : []
  let total = 0
  for (const item of accounts) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const remain = typeof record.CycleCapacityRemain === 'number' ? record.CycleCapacityRemain : Number(record.CycleCapacityRemainPrecise)
    if (Number.isFinite(remain) && record.Status !== 3) total += remain
  }
  return { total }
}

async function reportMiniProgram(deps: AutomationDeps, account: AutomationAccount, events: readonly Record<string, unknown>[]): Promise<void> {
  const base = {
    timestamp: Date.now(), ideType: 'WorkBuddy_MP', ideVersion: '2.4.0',
    extName: 'workbuddy-mp', extVersion: '2.4.0', product: 'SaaS',
    ideName: 'wx_app_cloud', platform: 'mini_program', os: 'windows', osVersion: '11',
    arch: 'x64', machineId: stableId(account, 'mpmachine'), timezone: 'Asia/Shanghai',
    userId: asText(account.credential.user_id),
    userNickname: asText(account.credential.nickname) || account.nickname,
  }
  await requestJson(deps, account.credential, `${BILLING_BASE}/v2/report`, 'POST', events.map((event) => ({ ...base, ...event })), {
    'X-Client-Product': 'workbuddy-mp',
    'X-Client-Version': '2.4.0',
    'X-Client-Platform': 'mp-weixin',
    'X-Platform': 'wechatmp',
  })
}

function miniChatEvent(conversationId: string): Record<string, unknown> {
  const requestId = randomId('wb2api-mp-req')
  return {
    eventCode: 'chat_request_send', inputLength: 14, isPlan: false,
    isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
    maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: '',
    mentionContextCount: 0, command: '', recommendId: '', skillId: '',
    skillCount: 0, totalCount: 0, traceId: requestId, rootRequestId: requestId,
    parentConversationId: conversationId, conversationId, messageId: `msg-${requestId.slice(-8)}`,
    agentName: 'mp', agentType: 'main',
    'codebuddy.session_id': conversationId,
    'codebuddy.conversation_request_id': requestId,
  }
}

function miniExpertUseEvent(expertId: string, expertName: string, expertType: string): Record<string, unknown> {
  return {
    eventCode: 'expert_actual_use', reportDelay: 0, extVersion: '2.2.8',
    source: 'mini_program', id: expertId, name: expertId,
    expertTitle: expertName || expertId, type: 'send_message',
    characterCount: 12, expertType: expertType || 'agent',
  }
}

function miniChatModelEvent(conversationId: string, modelId: string, modelName: string): Record<string, unknown> {
  return { ...miniChatEvent(conversationId), requestModelId: modelId, requestModelName: modelName }
}

function miniPlaybookEvents(caseId: string, caseName: string): Record<string, unknown>[] {
  const base = { id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '', skills: '', skillNames: '' }
  return [
    { ...base, eventCode: 'playbook_cta_click', source: 'discover', position: 1, extVersion: '2.2.8' },
    { ...base, eventCode: 'playbook_prompt_send', source: 'discover', promptLength: 96, isOfficial: 1, conversationId: randomId('wb2api-mp-pb'), extVersion: '2.2.8' },
  ]
}

function automationCreateEvent(name: string): Record<string, unknown> {
  return {
    eventCode: 'automated_task_create_suc', name, source: 'manually',
    modelId: 'fast-model', modelIsThinking: true, connectorCount: 0,
    skills: '', skillCount: 0, scheduleType: 'once', mode: 'LOCAL',
  }
}

function desktopTemplateUseSequence(conversationId: string, requestId: string, templateId: string, templateName: string): Record<string, unknown>[] {
  return [
    ...desktopChatSequence(conversationId, requestId, `msg-${templateId}`),
    { eventCode: 'agent_task_created_with_template', mode: 'working', isCustomModel: false, id: templateId, name: templateName, requestId },
    { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
  ]
}

function desktopPlaybookPromptSequence(conversationId: string, requestId: string, caseId: string, caseName: string): Record<string, unknown>[] {
  const payload = { id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '' }
  return [
    ...desktopChatSequence(conversationId, requestId, 'msg-pb'),
    { eventCode: 'web_element_click', pageName: 'playbook_detail', elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover' },
    { ...payload, eventCode: 'playbook_cta_click', source: 'discover', position: 0 },
    { ...payload, eventCode: 'playbook_prompt_send', conversationId, requestId },
  ]
}

function desktopDesignCanvasSequence(conversationId: string, requestId: string): Record<string, unknown>[] {
  return [
    ...desktopChatSequence(conversationId, requestId, 'msg-canvas'),
    {
      eventCode: 'wbx_design_canvas_task_create', conversationId, requestId,
      source: 'summon_keyword', cost: 12000, isSuccessful: true,
    },
    {
      eventCode: 'wbx_design_canvas_open', conversationId, requestId,
      id: `ardot-file-${requestId.slice(-8)}`, source: 'summon_keyword',
      type: 'page', cost: 13000, isSuccessful: true,
    },
  ]
}

async function marketExpertList(deps: AutomationDeps, account: AutomationAccount, expertType: string): Promise<MarketExpert[]> {
  const body: Record<string, unknown> = { page: 1, page_size: 20, sort_by: 'reco_rank', sort_order: 'desc' }
  if (expertType.length > 0) body.expert_type = expertType
  const response = await requestJson(deps, account.credential, `${DESKTOP_BASE}/portal/operation-platform/market/expert/list`, 'POST', body)
  const experts = response.experts
  return Array.isArray(experts) ? experts.filter((item): item is MarketExpert => typeof item === 'object' && item !== null) : []
}

async function desktopChatWithExpert(deps: AutomationDeps, account: AutomationAccount, expertId: string): Promise<{ conversationId: string; requestId: string } | undefined> {
  const conversationId = randomId('wb2api-conv')
  const fetcher = deps.fetcher ?? fetch
  const response = await fetcher(`${DESKTOP_BASE}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${asToken(account.credential.access_token)}`,
      'Content-Type': 'application/json', Accept: 'text/event-stream',
      'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
      'X-Domain': DESKTOP_BASE.replace('https://', ''), 'X-Product': 'SaaS',
      'X-User-Id': asText(account.credential.user_id),
      'X-Conversation-ID': conversationId, 'X-Request-ID': Date.now().toString(),
      'X-Agent-Intent': 'craft', 'X-Agent-Type': 'main',
      'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Version': '5.5.6',
      'x-codebuddy-request': '1', ...(expertId.length === 0 ? {} : { 'X-Expert-Id': expertId }),
    },
    body: JSON.stringify({
      model: 'fast-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
        { role: 'user', content: '1+1等于几？直接回答。' },
      ],
      agent: 'cli', temperature: 1, stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const text = await response.text()
  const match = text.match(/"id":"((?:cmb-)?[0-9a-f]{32})"/)
  return match ? { conversationId, requestId: match[1]! } : undefined
}

function desktopExpertSummonSequence(expert: MarketExpert): Record<string, unknown>[] {
  const category = Array.isArray(expert.categories) && typeof expert.categories[0] === 'string'
    ? expert.categories[0] as string
    : 'expert-all'
  const version = expert.version || '1.0.0'
  const name = expert.display_name_zh || expert.profession_zh
  return [
    {
      eventCode: 'web_element_click', source: expert.expert_id, type: category, version,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click', id: expert.expert_id, name,
      expertTitle: expert.profession_zh, type: 'expert-all', position: 0,
      expertType: expert.expert_type, version, mode: 'LOCAL',
    },
    { eventCode: 'expert_summoned', id: expert.expert_id, name, expertTitle: expert.profession_zh, type: 'expert-all' },
  ]
}

function desktopExpertActualUse(expert: MarketExpert, conversationId: string, requestId: string): Record<string, unknown> {
  const category = Array.isArray(expert.categories) && typeof expert.categories[0] === 'string'
    ? expert.categories[0] as string
    : 'expert-all'
  const version = expert.version || '1.0.0'
  const name = expert.display_name_zh || expert.profession_zh
  return {
    eventCode: 'expert_actual_use', id: expert.expert_id, name,
    expertTitle: expert.profession_zh, type: category, expertType: expert.expert_type,
    source: 'builtin', version, cost: 9000, characterCount: 14,
    conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: 'fast-model', requestModelName: 'fast-model', mode: 'craft',
  }
}

function desktopExpertActualUseLocal(expert: MarketExpert, conversationId: string, requestId: string): Record<string, unknown> {
  return { ...desktopExpertActualUse(expert, conversationId, requestId), mode: 'LOCAL' }
}

async function runStreakBonus(deps: AutomationDeps, account: AutomationAccount): Promise<Record<string, unknown>> {
  const details: Record<string, unknown> = {}
  for (const path of ['/activity/growth/gift/claim', '/activity/growth/compensation/claim']) {
    try {
      const response = await requestJson(deps, account.credential, `${DESKTOP_BASE}${path}`, 'POST', {})
      if (response.code === 0) details[path] = expectOk(response, '福利领取')
    } catch { /* 一次性福利无则跳过 */ }
  }
  try {
    const status = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/streak`, 'GET', undefined)
    const data = expectOk(status, '连登状态')
    details.streak = data.streak ?? data
    const tiers = Array.isArray(data.tiers) ? data.tiers as Record<string, unknown>[] : []
    const redeemed: string[] = []
    for (const tier of tiers) {
      const id = asText(tier.tier)
      const state = asText(tier.status)
      if (id.length === 0 || state === 'locked' || state === 'claimed') continue
      const redeem = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/streak/redeem`, 'POST', { tier: id })
      if (redeem.code === 0) redeemed.push(id)
    }
    if (redeemed.length > 0) details.redeemed = redeemed
  } catch { /* 连登接口形态不同时不阻断主任务 */ }
  try {
    const summary = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/lottery/summary`, 'GET', undefined)
    const data = expectOk(summary, '抽奖次数')
    let chances = asNumberValue(data.chances) ?? asNumberValue(data.remaining) ?? 0
    const draws: unknown[] = []
    for (let index = 0; index < Math.min(chances, 20); index += 1) {
      const draw = await requestJson(deps, account.credential, `${DESKTOP_BASE}/activity/growth/lottery/draw`, 'POST', { draw_uuid: randomUUID() })
      if (draw.code !== 0) break
      draws.push(expectOk(draw, '抽奖'))
    }
    if (draws.length > 0) details.lottery = draws
  } catch { /* 抽奖接口不可用时跳过 */ }
  try {
    const share = await requestJson(deps, account.credential, `${SCHOOL_BASE}/tasks/share-complete`, 'POST', { channel: 'wechat' })
    if (share.code === 0) details.schoolShare = expectOk(share, '开学季分享')
  } catch { /* 活动结束跳过 */ }
  return details
}
