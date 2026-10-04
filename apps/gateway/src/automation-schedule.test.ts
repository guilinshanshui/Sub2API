import { describe, expect, it } from 'vitest'
import { planAutomationDispatches, shanghaiClock, slotMinutes } from './automation-schedule.js'

const PROVIDERS = ['codearts', 'buddy', 'qoder'] as const

/** 北京时间 = UTC+8；用 Date.UTC 构造，避免受宿主机时区影响。 */
function shanghaiAt(hour: number, minute: number, day = 4): number {
  return Date.UTC(2026, 9, day, hour - 8, minute, 30)
}

const jobs = [
  { id: 'cn_daily', schedule: ['09:00', '21:00'], enabled: true },
  { id: 'intl_daily', schedule: ['09:00', '21:00'], enabled: true },
  { id: 'night_owl', schedule: ['01:00'], enabled: true },
  { id: 'all_daily_signin', schedule: ['10:10'], enabled: true },
]

describe('automation schedule helpers', () => {
  it('reads the Shanghai clock regardless of host timezone', () => {
    expect(shanghaiClock(shanghaiAt(10, 10)).minutes).toBe(10 * 60 + 10)
    expect(slotMinutes('10:10')).toBe(610)
    expect(slotMinutes('9:10')).toBeUndefined()
    expect(slotMinutes('24:00')).toBeUndefined()
  })
})

describe('planAutomationDispatches', () => {
  it('runs the all-provider sign-in even when no account-level job is due', () => {
    // 回归：账号级任务只在 09:00/21:00/01:00 命中，早期实现用同一个早退分支
    // 把 10:10 的签到一起 return 掉了，导致签到永远不执行。
    // 账号级任务当天都已经跑过 → 等价于早期实现里的 `dueIds.length === 0`，
    // 而那正是签到被早退跳过的场景。
    const dispatches = planAutomationDispatches({
      now: shanghaiAt(10, 10),
      config: { enabled: true },
      jobs,
      runs: [
        { jobId: 'cn_daily', task: 'buddy-1', completedAt: shanghaiAt(9, 5) },
        { jobId: 'intl_daily', task: 'workbuddy-1', completedAt: shanghaiAt(9, 5) },
        { jobId: 'night_owl', task: 'buddy-1', completedAt: shanghaiAt(1, 5) },
      ],
      signinProviders: PROVIDERS,
    })

    expect(dispatches).toEqual(PROVIDERS.map((provider) => ({
      jobId: 'all_daily_signin',
      provider,
      slot: '10:10',
    })))
  })

  it('catches up a missed slot later in the day', () => {
    const dispatches = planAutomationDispatches({
      now: shanghaiAt(14, 30),
      config: { enabled: true },
      jobs,
      runs: [],
      signinProviders: PROVIDERS,
    })

    expect(dispatches.filter((item) => item.jobId === 'all_daily_signin')).toHaveLength(PROVIDERS.length)
    // 09:00 的账号级任务同样补跑；01:00 的夜猫子也已到点。
    expect(dispatches.map((item) => item.jobId)).toContain('cn_daily')
  })

  it('does not dispatch a slot that has not arrived yet', () => {
    const dispatches = planAutomationDispatches({
      now: shanghaiAt(9, 59),
      config: { enabled: true },
      jobs,
      runs: [],
      signinProviders: PROVIDERS,
    })

    expect(dispatches.filter((item) => item.jobId === 'all_daily_signin')).toHaveLength(0)
    expect(dispatches.map((item) => item.jobId)).toEqual(['cn_daily', 'intl_daily', 'night_owl'])
  })

  it('skips providers that already ran after the slot', () => {
    const now = shanghaiAt(10, 20)
    const slot = shanghaiAt(10, 12)
    const dispatches = planAutomationDispatches({
      now,
      config: { enabled: true },
      jobs,
      runs: [
        { jobId: 'all_daily_signin', provider: 'codearts', completedAt: slot },
        { jobId: 'all_daily_signin', provider: 'qoder', completedAt: slot },
      ],
      signinProviders: PROVIDERS,
    })

    expect(dispatches.filter((item) => item.jobId === 'all_daily_signin')).toEqual([
      { jobId: 'all_daily_signin', provider: 'buddy', slot: '10:10' },
    ])
  })

  it('re-arms an account job for its second slot of the day', () => {
    const morning = shanghaiAt(9, 30)
    const morningRuns = [{ jobId: 'cn_daily', task: 'buddy-1', completedAt: morning }]
    expect(planAutomationDispatches({
      now: morning,
      config: { enabled: true },
      jobs,
      runs: morningRuns,
      signinProviders: PROVIDERS,
    }).map((item) => item.jobId)).not.toContain('cn_daily')

    const evening = shanghaiAt(21, 5)
    expect(planAutomationDispatches({
      now: evening,
      config: { enabled: true },
      jobs,
      runs: morningRuns,
      signinProviders: PROVIDERS,
    }).map((item) => item.jobId)).toContain('cn_daily')
  })

  it('honours per-provider sign-in times and the global switch', () => {
    const now = shanghaiAt(10, 40)
    const dispatches = planAutomationDispatches({
      now,
      config: { enabled: true, signinSchedules: { qoder: '10:40' } },
      jobs,
      runs: [],
      signinProviders: PROVIDERS,
    })

    // 全局 10:10 已过（codearts/buddy 补跑），qoder 用自己的 10:40。
    expect(dispatches.filter((item) => item.jobId === 'all_daily_signin')).toEqual([
      { jobId: 'all_daily_signin', provider: 'codearts', slot: '10:10' },
      { jobId: 'all_daily_signin', provider: 'buddy', slot: '10:10' },
      { jobId: 'all_daily_signin', provider: 'qoder', slot: '10:40' },
    ])

    expect(planAutomationDispatches({
      now,
      config: { enabled: false },
      jobs,
      runs: [],
      signinProviders: PROVIDERS,
    })).toEqual([])
  })
})
