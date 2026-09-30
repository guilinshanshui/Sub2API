export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function errorMessage(body: unknown, fallback: string): { message: string; code?: string } {
  if (typeof body !== 'object' || body === null) return { message: fallback }
  const record = body as Record<string, unknown>
  const error = typeof record.error === 'object' && record.error !== null
    ? record.error as Record<string, unknown>
    : undefined
  return {
    message: typeof error?.message === 'string' ? error.message : fallback,
    code: typeof error?.code === 'string' ? error.code : undefined,
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const details = errorMessage(parsed, `请求失败（HTTP ${response.status}）`)
    throw new ApiError(details.message, response.status, details.code)
  }
  if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
    return (parsed as { data: T }).data
  }
  return parsed as T
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path)
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'DELETE' })
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
