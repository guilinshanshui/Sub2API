import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json; charset=utf-8')
  responseHeaders.set('cache-control', 'no-store')
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

export function errorResponse(message: string, status = 400, code = 'bad_request'): Response {
  return jsonResponse({ error: { message, code, type: 'sub2api_error' } }, status)
}

export function requestId(): string {
  return randomUUID()
}

export function isSafePathId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function ensureDirectory(directory: string, mode = 0o700): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode })
  try {
    await fs.chmod(directory, mode)
  } catch {
    // Windows does not implement POSIX mode bits consistently.
  }
}

export async function atomicWriteFile(filePath: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await ensureDirectory(path.dirname(filePath))
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, data, { mode })
  await fs.rename(temporary, filePath)
  try {
    await fs.chmod(filePath, mode)
  } catch {
    // Best effort on Windows.
  }
}

export function parsePositiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

export function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForLog)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/authorization|api[-_]?key|secret|token|password|cookie|credential/i.test(key)) {
      result[key] = '[redacted]'
    } else {
      result[key] = sanitizeForLog(item)
    }
  }
  return result
}

export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
