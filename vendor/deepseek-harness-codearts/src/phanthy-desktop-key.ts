/**
 * PhanthyCode 桌面端 Ed25519 安装身份。
 *
 * 协议依据 phanthycode2api 的 desktop login 逻辑：
 * 本地生成密钥并注册为 desktop installation，之后所有活动请求都必须带签名头。
 */

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign } from 'node:crypto'
import { KeyObject } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PHANTHY_DESKTOP_INSTALLATION_DIR } from './phanthy-runtime.js'

/** 密钥文件结构。 */
export interface PhanthyDesktopKeyFile {
  seed_hex: string
  installation_id: string
}

/** 已解析的 Ed25519 身份。 */
export interface PhanthyDesktopIdentity {
  installationId: string
  privateKey: KeyObject
}

const ED25519_SEED_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
)
const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
)

/** b64url，无 padding。 */
function b64url(value: Buffer): string {
  return value.toString('base64url')
}

/** 账号 uid 转安全文件名。 */
function sanitizeUid(uid: string): string {
  const clean = uid.replace(/[^A-Za-z0-9._-]/g, '_')
  return clean.length > 0 ? clean : 'default'
}

/** 计算安装 id：`di_` + b64url(sha256(SPKI DER))。 */
export function phanthyInstallationIdFromSeed(seed: Buffer): string {
  const publicKey = createPublicKey(createPrivateKey({
    key: Buffer.concat([ED25519_SEED_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  }))
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const digest = createHash('sha256').update(spki).digest()
  return `di_${b64url(digest)}`
}

/** 构造 Ed25519 私钥对象。 */
export function phanthyPrivateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_SEED_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** 读取或创建一个 uid 对应的桌面端身份。 */
export async function loadOrCreatePhanthyDesktopIdentity(
  uid: string,
  dataDir: string,
): Promise<PhanthyDesktopIdentity> {
  const path = join(dataDir, PHANTHY_DESKTOP_INSTALLATION_DIR, `${sanitizeUid(uid)}.json`)
  let keyFile: PhanthyDesktopKeyFile | undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as Record<string, unknown>).seed_hex === 'string'
      && /^[0-9a-f]{64}$/i.test((parsed as Record<string, unknown>).seed_hex as string)
    ) {
      const raw = parsed as Record<string, unknown>
      keyFile = {
        seed_hex: raw.seed_hex as string,
        installation_id: typeof raw.installation_id === 'string' ? raw.installation_id : '',
      }
    }
  } catch {
    keyFile = undefined
  }

  if (keyFile === undefined) {
    const seed = randomBytes(32)
    keyFile = { seed_hex: seed.toString('hex'), installation_id: phanthyInstallationIdFromSeed(seed) }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(keyFile, null, 2)}\n`, { mode: 0o600 })
  }

  const seed = Buffer.from(keyFile.seed_hex, 'hex')
  const installationId = keyFile.installation_id.length > 0
    ? keyFile.installation_id
    : phanthyInstallationIdFromSeed(seed)
  return { installationId, privateKey: phanthyPrivateKeyFromSeed(seed) }
}

/** 构造注册请求体里的 SPKI DER 公钥。 */
export function phanthyPublicKeyB64url(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return b64url(Buffer.from(spki))
}

/**
 * 构造签名基串。
 *
 * `v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256_BODY_B64URL\nIDEMPOTENCY_KEY\n`
 */
export function phanthySignatureBase(params: {
  method: string
  path: string
  timestampMs: number
  nonce: string
  body: Buffer | string
  idempotencyKey?: string
}): string {
  const bodyHash = createHash('sha256')
    .update(typeof params.body === 'string' ? Buffer.from(params.body, 'utf8') : params.body)
    .digest()
  return [
    'v1',
    params.method.toUpperCase(),
    params.path,
    String(params.timestampMs),
    params.nonce,
    b64url(bodyHash),
    params.idempotencyKey ?? '',
    '',
  ].join('\n')
}

/** 用 Ed25519 签名并输出 b64url。 */
export function signPhanthyDesktop(
  privateKey: KeyObject,
  params: {
    method: string
    path: string
    timestampMs: number
    nonce: string
    body: Buffer | string
    idempotencyKey?: string
  },
): string {
  const base = phanthySignatureBase(params)
  const signature = edSign(null, Buffer.from(base, 'utf8'), privateKey)
  return b64url(signature)
}
