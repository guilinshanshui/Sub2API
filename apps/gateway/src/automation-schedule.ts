/**
 * 后台自动化调度：决定「这一分钟该跑哪些任务」。
 *
 * 抽成纯函数是为了让「到点即跑、错过补跑」的语义可被单测覆盖 —— 这段逻辑
 * 曾经因为一个共用的早退分支让「全服务商每日签到」永远不执行（2026-10-04）。
 */

const AUTOMATION_TIMEZONE = 'Asia/Shanghai'

export interface AutomationScheduleJob {
  id: string
  schedule: readonly string[]
  enabled: boolean
}

export interface AutomationScheduleRun {
  jobId: string
  provider?: string
  task?: string
  completedAt: number
}

export interface AutomationScheduleConfig {
  enabled: boolean
  signinSchedules?: Record<string, string>
}

export interface AutomationDispatch {
  jobId: string
  /** 仅「全服务商每日签到」按服务商逐个触发时有值。 */
  provider?: string
  /** 命中的调度时刻，形如 `10:10`。 */
  slot: string
}

/** 调度时间一律按北京时间理解：返回当天日期与「当天第几分钟」。 */
export function shanghaiClock(now: number): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUTOMATION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now))
  const read = (kind: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === kind)?.value ?? ''
  const hour = read('hour') === '24' ? '00' : read('hour')
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    minutes: Number(hour) * 60 + Number(read('minute')),
  }
}

/** `HH:mm` → 当天第几分钟；非法值返回 undefined。 */
export function slotMinutes(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 计算本轮应补跑的任务。
 *
 * 规则：
 * - 任务/服务商取**今天已经到点的最后一个**调度时刻；
 * - 该时刻之后已有运行记录则跳过（避免重复执行、避免风控）；
 * - 因此网关晚启动或机器休眠恢复后，当天错过的那一次会被补上；
 * - 多时刻任务（09:00 + 21:00）在第二个时刻之后会再次触发。
 */
export function planAutomationDispatches(input: {
  now: number
  config: AutomationScheduleConfig
  jobs: readonly AutomationScheduleJob[]
  runs: readonly AutomationScheduleRun[]
  signinProviders: readonly string[]
}): AutomationDispatch[] {
  const { now, config, jobs, runs, signinProviders } = input
  if (config.enabled !== true) return []
  const { minutes: nowMinutes } = shanghaiClock(now)
  const slotStartMs = (minutes: number): number => now - (nowMinutes - minutes) * 60_000
  const latestSlot = (schedule: readonly string[]): { minutes: number; value: string } | undefined => {
    let best: { minutes: number; value: string } | undefined
    for (const value of schedule) {
      const minutes = slotMinutes(value)
      if (minutes === undefined || minutes > nowMinutes) continue
      if (best === undefined || minutes > best.minutes) best = { minutes, value }
    }
    return best
  }
  const ranJobAfter = (jobId: string, sinceMs: number): boolean =>
    runs.some((run) => run.jobId === jobId && run.completedAt >= sinceMs)
  const ranProviderAfter = (provider: string, sinceMs: number): boolean =>
    runs.some((run) =>
      run.jobId === 'all_daily_signin'
      && (run.provider ?? '') === provider
      && run.completedAt >= sinceMs)

  const dispatches: AutomationDispatch[] = []
  for (const job of jobs) {
    if (job.id === 'all_daily_signin' || job.enabled !== true) continue
    const slot = latestSlot(job.schedule)
    if (slot === undefined || ranJobAfter(job.id, slotStartMs(slot.minutes))) continue
    dispatches.push({ jobId: job.id, slot: slot.value })
  }

  const signinJob = jobs.find((job) => job.id === 'all_daily_signin')
  if (signinJob === undefined || signinJob.enabled !== true) return dispatches
  const defaultSlot = signinJob.schedule[0] ?? '09:10'
  for (const provider of signinProviders) {
    const value = config.signinSchedules?.[provider] ?? defaultSlot
    const minutes = slotMinutes(value)
    if (minutes === undefined || minutes > nowMinutes) continue
    if (ranProviderAfter(provider, slotStartMs(minutes))) continue
    dispatches.push({ jobId: 'all_daily_signin', provider, slot: value })
  }
  return dispatches
}
