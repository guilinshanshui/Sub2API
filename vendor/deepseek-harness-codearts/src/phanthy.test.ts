import { describe, expect, it } from 'vitest'
import { extractPhanthyCode } from './phanthy.js'
import {
  analyzePhanthyDailyRewards,
  buildPhanthyWallet,
} from './phanthy-credits.js'
import { phanthyInstallationIdFromSeed } from './phanthy-desktop-key.js'

describe('extractPhanthyCode', () => {
  const code = 'LaKU15K2Qj2HoBysON7cPsfGtHvh38Egvm95KR6qwYU'

  it.each([
    ['bare code', code, code],
    ['bare code with fragment', `${code}#p2a-login`, code],
    ['code prefix', `code=${code}`, code],
    ['query prefix', `?code=${code}`, code],
    ['full callback URL with fragment', `https://code.phanthy.com/oauth/code/success?code=${code}#p2a-login`, code],
    ['full callback URL with extra params', `https://code.phanthy.com/oauth/code/success?state=p2a-login&code=${code}`, code],
    ['empty input', '', ''],
    ['fragment only', '#p2a-login', ''],
  ])('%s', (_name, input, expected) => {
    expect(extractPhanthyCode(input)).toBe(expected)
  })
})

describe('phanthyInstallationIdFromSeed', () => {
  it('matches the official desktop identity derivation vector', () => {
    const seed = Buffer.from(
      'ABB944288E7DB56FDD184CFBDC063F64EEE40D54E160B26800EF389B0B897528',
      'hex',
    )
    expect(phanthyInstallationIdFromSeed(seed)).toBe('di_fTnh4RH5p_fBDePi-mawH4ptXGsVVsV3UyLlyI5Mlro')
  })
})

describe('analyzePhanthyDailyRewards', () => {
  const today = new Date('2026-09-30T12:00:00+08:00')

  it('counts today, streak and total by Beijing business dates', () => {
    const rewards = [
      { reward_type: 'daily_login', status: 'granted', points: 100, granted_at: '2026-09-29T16:00:00Z' },
      { reward_type: 'daily_login', status: 'granted', points: 120, granted_at: '2026-09-28T16:00:00Z' },
      { reward_type: 'daily_login', status: 'pending', points: 999, granted_at: '2026-09-30T16:00:00Z' },
      { reward_type: 'other', status: 'granted', points: 500, granted_at: '2026-09-30T16:00:00Z' },
    ]
    expect(analyzePhanthyDailyRewards(rewards, today)).toMatchObject({
      today: '2026-09-30',
      grantedToday: true,
      todayPoints: 100,
      streakDays: 2,
      totalGranted: 220,
    })
  })

  it('keeps the streak through yesterday when today has not arrived', () => {
    const rewards = [
      { reward_type: 'daily_login', status: 'granted', points: 100, granted_at: '2026-09-28T16:00:00Z' },
      { reward_type: 'daily_login', status: 'granted', points: 120, granted_at: '2026-09-27T16:00:00Z' },
    ]
    expect(analyzePhanthyDailyRewards(rewards, today)).toMatchObject({
      grantedToday: false,
      streakDays: 2,
    })
  })
})

describe('buildPhanthyWallet', () => {
  it('builds the plan pool and aggregates unexpired reward lots with FIFO usage', () => {
    const usage = { current_plan: { remaining_credits: 900, total_credits: 1000, used_credits: 100, resets_at: '2026-10-31T00:00:00Z' } }
    const rewards = [
      { reward_type: 'daily_login', status: 'granted', points: 300, granted_at: '2026-09-28T16:00:00Z', expires_at: '2027-01-01T00:00:00Z' },
      { reward_type: 'daily_login', status: 'granted', points: 200, granted_at: '2026-09-29T16:00:00Z', expires_at: '2026-12-01T00:00:00Z' },
      { reward_type: 'daily_login', status: 'pending', points: 100, granted_at: '2026-09-30T16:00:00Z' },
      { reward_type: 'other', status: 'granted', points: 50, granted_at: '2026-09-30T16:00:00Z' },
    ]
    const usageSummary = {
      usage_by_day_and_model: [
        { date: '2026-09-30', cost_points: 250 },
      ],
    }
    const wallet = buildPhanthyWallet(usage, rewards, usageSummary, '体验版')
    expect(wallet.pools[0]).toMatchObject({ key: 'plan', label: '体验版', remaining: 900, total: 1000 })
    expect(wallet.pools[1]).toMatchObject({ key: 'daily_login', lots: 2, used: 250, remaining: 250, estimate: true })
    expect(wallet.pending).toBe(100)
    expect(wallet.approximate).toBe(true)
  })
})
