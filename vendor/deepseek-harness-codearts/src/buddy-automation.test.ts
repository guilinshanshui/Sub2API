import { describe, expect, it } from 'vitest'
import type { AutomationDeps } from './buddy-automation.js'
import {
  AUTOMATION_JOB_DEFINITIONS,
  normalizeAutomationJobs,
  normalizeAutomationSchedule,
  setAutomationJobSchedule,
} from './buddy-automation.js'
import { runAutomationJob } from './buddy-automation.js'
import type { AutomationJobRecord, AutomationRunRecord } from './types.js'

describe('buddy automation schedules', () => {
  it('keeps valid HH:mm values and removes duplicates', () => {
    expect(normalizeAutomationSchedule(['10:30', '10:30', 'invalid', '23:59']))
      .toEqual(['10:30', '23:59'])
    expect(normalizeAutomationSchedule(['09:00', 12, null])).toEqual(['09:00'])
    expect(normalizeAutomationSchedule(['9:00', '24:00'])).toBeUndefined()
  })

  it('updates the persisted schedule for the all-provider sign-in job', () => {
    const jobs = setAutomationJobSchedule(
      AUTOMATION_JOB_DEFINITIONS,
      'all_daily_signin',
      ['10:15'],
    )

    expect(jobs?.find((job) => job.id === 'all_daily_signin')?.schedule)
      .toEqual(['10:15'])
    expect(setAutomationJobSchedule(
      AUTOMATION_JOB_DEFINITIONS,
      'all_daily_signin',
      ['26:00'],
    )).toBeUndefined()
  })

  it('preserves a persisted sign-in schedule while normalizing jobs', () => {
    const jobs = normalizeAutomationJobs([
      {
        ...AUTOMATION_JOB_DEFINITIONS[0]!,
        id: 'all_daily_signin',
        schedule: ['10:45'],
      },
    ])

    expect(jobs.find((job) => job.id === 'all_daily_signin')?.schedule)
      .toEqual(['10:45'])
  })
})

describe('all-provider sign-in run summary', () => {
  it('keeps earlier providers in the same day when a later one succeeds', async () => {
    // 调度器按服务商分别触发签到：每次运行只产生一条记录。若直接把单条记录
    // 覆盖任务状态，最后跑成功的服务商会把当天早些时候的失败藏起来。
    const runs: AutomationRunRecord[] = []
    let jobs: AutomationJobRecord[] = normalizeAutomationJobs(undefined)
    const deps = {
      accounts: [],
      credentials: { resolve: async () => undefined, set: async () => {} },
      appendRuns: async (records: readonly AutomationRunRecord[]) => {
        runs.unshift(...records)
      },
      runs: async () => runs,
      jobs: async () => jobs,
      setJobs: async (next: readonly AutomationJobRecord[]) => { jobs = [...next] },
      config: async () => ({ enabled: true, enabledJobs: {}, reserveCredits: 0 }),
      claimProviderCredits: async (provider: string) => provider === 'qoder'
        ? { results: [], summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 1 } }
        : { results: [], summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 0 } },
      logger: { warn: () => {} },
    } as unknown as AutomationDeps

    await runAutomationJob(deps, 'all_daily_signin', { provider: 'qoder' })
    await runAutomationJob(deps, 'all_daily_signin', { provider: 'trae' })

    const job = jobs.find((item) => item.id === 'all_daily_signin')
    expect(job?.lastStatus).toBe('error')
    expect(job?.lastMessage).toContain('1 个服务商成功')
    expect(job?.lastMessage).toContain('1 个失败')
    expect(job?.lastMessage).toContain('Qoder')
  })
})
