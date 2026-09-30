/**
 * PhanthyCode 运行时目录与通用 HTTP 结果类型。
 */

/** 桌面端密钥在插件数据目录下的相对路径。 */
export const PHANTHY_DESKTOP_INSTALLATION_DIR = 'desktop-keys'

/** 通用 JSON HTTP 结果。 */
export type PhanthyHttpResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; message: string; text: string }

/** 解析 JSON，非 JSON 时保留状态码与文本片段。 */
export async function readPhanthyJson<T>(response: Response): Promise<PhanthyHttpResult<T>> {
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, status: response.status, message: `HTTP ${response.status}`, text }
  }
  try {
    const body = JSON.parse(text) as T
    return { ok: true, status: response.status, body }
  } catch {
    return {
      ok: false,
      status: response.status,
      message: '响应不是有效 JSON',
      text: text.trim().slice(0, 200),
    }
  }
}
