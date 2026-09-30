/**
 * PhanthyCode 协议常量与纯函数。
 *
 * 协议依据 `guilinshanshui/phanthycode2api` 的 Go 参考实现。
 */

import { createHash, randomBytes } from 'node:crypto'

/** API 基址。 */
export const PHANTHY_API_BASE = 'https://code.phanthy.com'

/** 请求超时（毫秒）。 */
export const PHANTHY_REQUEST_TIMEOUT_MS = 60_000

/** 登录流程整体超时（毫秒）。 */
export const PHANTHY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 授权页轮询间隔。 */
export const PHANTHY_AUTH_POLL_INTERVAL_MS = 1_000

/** OAuth beta 标识；token 与桌面端活动接口都要带。 */
export const PHANTHY_OAUTH_BETA = 'oauth-2025-04-20'

/** OAuth client_id。 */
export const PHANTHY_CLIENT_ID = 'phanthy-code-cli'

/**
 * 模型后缀规范化表。
 *
 * 用户可能沿用上游配置里的 `[1m]` / `[2m]` / `:1m` / `:2m` 后缀，真实模型 id
 * 没有这些尾巴。
 */
const MODEL_SUFFIXES = ['[1m]', '[2m]', ':1m', ':2m'] as const

/** PhanthyCode 凭据；字段名与上游实现一致。 */
export interface PhanthyCredential {
  access_token: string
  refresh_token: string
  /** 过期时间（毫秒时间戳字符串）。 */
  expires_at?: string
  /** 用户 id；也是桌面端安装密钥的存储键来源。 */
  uid: string
  nickname?: string
}

/** 安全解析 JWT payload；不验签，只取续期所需的声明。 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    return payload as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 解码 JWT `exp` 为毫秒；解析失败返回 undefined。 */
export function decodePhanthyJwtExpMs(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
}

/** 优先读显式 expires_at，缺失或非法时回退 JWT exp。 */
export function phanthyCredentialExpiresAtMs(credential: PhanthyCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return decodePhanthyJwtExpMs(credential.access_token)
}

/** 无过期信息视为不过期，由 401 触发刷新。 */
export function isPhanthyExpired(credential: PhanthyCredential): boolean {
  const expiresAt = phanthyCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/** refresh_token 非空即可续期。 */
export function isPhanthyRefreshable(credential: PhanthyCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/** 规范化请求/展示用模型 id。 */
export function normalizePhanthyModel(model: string): string {
  let result = model.trim()
  for (const suffix of MODEL_SUFFIXES) {
    if (result.toLowerCase().endsWith(suffix)) {
      result = result.slice(0, result.length - suffix.length)
      break
    }
  }
  return result
}

/** 兜底目录未收录时的别名回退。 */
export function resolvePhanthyModel(model: string): string {
  const normalized = normalizePhanthyModel(model)
  return PHANTHY_FALLBACK_MODEL_IDS.has(normalized.toLowerCase()) ? normalized.toLowerCase() : normalized
}

/** 兜底模型 id 集合（与 product 文件保持同一份真值）。 */
export const PHANTHY_FALLBACK_MODEL_IDS = new Set([
  'phanthy-fast',
  'phanthy-pro',
  'phanthy-ultra',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'deepseek-v4.1-flash',
])

/** 首选模型顺序；仅用于登录后的可用性探测。 */
export const PHANTHY_PREFERRED_MODELS = [
  'phanthy-pro',
  'phanthy-fast',
  'glm-5.3-flash',
  'kimi-k3',
] as const

/** 授权 URL 使用的 state / verifier 载荷。 */
export interface PhanthyPkceState {
  verifier: string
  challenge: string
  state: string
}

/** 生成 PKCE state。 */
export function createPhanthyPkceState(): PhanthyPkceState {
  const verifier = randomToken()
  const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url')
  const state = randomToken()
  return { verifier, challenge, state }
}

/** 生成 base64url 随机串。 */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

/** 解析并校验凭据 JSON；缺 access_token 即视为无效。 */
export function parsePhanthyCredential(value: string): PhanthyCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.access_token !== 'string' || record.access_token.trim().length === 0) return undefined
    return {
      access_token: record.access_token,
      refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : '',
      ...(typeof record.expires_at === 'string' ? { expires_at: record.expires_at } : {}),
      uid: typeof record.uid === 'string' ? record.uid : '',
      ...(typeof record.nickname === 'string' && record.nickname.length > 0
        ? { nickname: record.nickname }
        : {}),
    }
  } catch {
    return undefined
  }
}
