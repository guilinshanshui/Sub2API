import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_JOB_DEFINITIONS,
  normalizeAutomationJobs,
  normalizeAutomationSchedule,
  setAutomationJobSchedule,
} from './buddy-automation.js'

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
