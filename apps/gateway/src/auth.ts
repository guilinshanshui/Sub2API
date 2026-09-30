import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { jwtVerify, SignJWT } from 'jose'
import { atomicWriteFile } from './utils.js'

const scrypt = promisify(scryptCallback)
const SESSION_COOKIE = 'sub2api_session'

interface AdminFile {
  version: 1
  username: string
  passwordSalt: string
  passwordHash: string
  jwtSecret: string
  createdAt: number
}

export interface AdminSession {
  username: string
  expiresAt: number
}

export interface CreatedAdminSession extends AdminSession {
  token: string
}

async function passwordHash(password: string, salt: Buffer): Promise<Buffer> {
  return await scrypt(password, salt, 64) as Buffer
}

function parseAdminFile(raw: string): AdminFile {
  const parsed = JSON.parse(raw) as Partial<AdminFile>
  if (parsed.version !== 1
    || typeof parsed.username !== 'string'
    || typeof parsed.passwordSalt !== 'string'
    || typeof parsed.passwordHash !== 'string'
    || typeof parsed.jwtSecret !== 'string') {
    throw new Error('Invalid admin.json')
  }
  return parsed as AdminFile
}

function cookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return result
}

export class AdminAuth {
  readonly sessionCookie = SESSION_COOKIE
  private readonly filePath: string
  private admin: AdminFile | undefined
  private setupToken: string | undefined

  constructor(
    dataDir: string,
    private readonly publicUrl: string,
    private readonly bootstrapPassword: string,
  ) {
    this.filePath = path.join(dataDir, 'admin.json')
  }

  async initialize(): Promise<void> {
    try {
      this.admin = parseAdminFile(await fs.readFile(this.filePath, 'utf8'))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (this.bootstrapPassword.length > 0) {
      await this.setPassword(this.bootstrapPassword)
      return
    }
    this.setupToken = randomBytes(24).toString('base64url')
  }

  status(): { configured: boolean; setupRequired: boolean } {
    return {
      configured: this.admin !== undefined,
      setupRequired: this.admin === undefined,
    }
  }

  oneTimeSetupToken(): string | undefined {
    return this.setupToken
  }

  async setup(token: string, password: string): Promise<CreatedAdminSession> {
    if (this.admin !== undefined) throw new Error('Administrator account is already configured')
    if (this.setupToken === undefined) throw new Error('Setup is not available')
    const expected = Buffer.from(this.setupToken)
    const supplied = Buffer.from(token)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new Error('Invalid setup token')
    }
    await this.setPassword(password)
    this.setupToken = undefined
    return await this.createSession()
  }

  async login(password: string): Promise<CreatedAdminSession> {
    if (this.admin === undefined) throw new Error('Administrator account is not configured')
    const salt = Buffer.from(this.admin.passwordSalt, 'base64')
    const expected = Buffer.from(this.admin.passwordHash, 'base64')
    const actual = await passwordHash(password, salt)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid username or password')
    }
    return await this.createSession()
  }

  async changePassword(password: string): Promise<CreatedAdminSession> {
    if (this.admin === undefined) throw new Error('Administrator account is not configured')
    await this.setPassword(password)
    return await this.createSession()
  }

  async verifySession(token: string | undefined): Promise<AdminSession | undefined> {
    if (token === undefined || this.admin === undefined) return undefined
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.admin.jwtSecret), {
        issuer: 'sub2api',
        audience: 'sub2api-admin',
      })
      if (payload.sub !== this.admin.username || typeof payload.exp !== 'number') return undefined
      return { username: payload.sub, expiresAt: payload.exp * 1000 }
    } catch {
      return undefined
    }
  }

  sessionFromRequest(request: Request): Promise<AdminSession | undefined> {
    return this.sessionFromCookieHeader(request.headers.get('cookie') ?? undefined)
  }

  sessionFromCookieHeader(cookieHeader: string | undefined): Promise<AdminSession | undefined> {
    return this.verifySession(cookies(cookieHeader)[SESSION_COOKIE])
  }

  sessionCookieHeader(token: string, maxAgeSeconds: number): string {
    const secure = this.publicUrl.startsWith('https://') ? '; Secure' : ''
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
  }

  clearCookieHeader(): string {
    const secure = this.publicUrl.startsWith('https://') ? '; Secure' : ''
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  }

  private async setPassword(password: string): Promise<void> {
    if (password.length < 8) throw new Error('Administrator password must be at least 8 characters')
    const salt = randomBytes(16)
    const hash = await passwordHash(password, salt)
    this.admin = {
      version: 1,
      username: 'admin',
      passwordSalt: salt.toString('base64'),
      passwordHash: hash.toString('base64'),
      jwtSecret: randomBytes(48).toString('base64url'),
      createdAt: Date.now(),
    }
    await atomicWriteFile(this.filePath, `${JSON.stringify(this.admin, null, 2)}\n`)
  }

  private async createSession(): Promise<CreatedAdminSession> {
    if (this.admin === undefined) throw new Error('Administrator account is not configured')
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + 12 * 60 * 60
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('sub2api')
      .setAudience('sub2api-admin')
      .setSubject(this.admin.username)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(this.admin.jwtSecret))
    return { username: this.admin.username, expiresAt: expiresAt * 1000, token }
  }
}

export function createApiKeyValue(): string {
  return `sk-sub2api-${randomBytes(32).toString('base64url')}`
}

export function hashApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
