import { describe, expect, it } from 'vitest'
import { extractPhanthyCode } from './phanthy.js'
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
