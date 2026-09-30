import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth } from '../auth.js'

export interface AdminErrorBody {
  error: {
    code: string
    message: string
  }
}

export function sendAdminError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({
    error: { code, message },
  } satisfies AdminErrorBody)
}

export function requireAdmin(auth: AdminAuth) {
  return async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = await auth.sessionFromCookieHeader(request.headers.cookie)
    if (session === undefined) {
      sendAdminError(reply, 401, 'unauthorized', '管理员登录已失效，请重新登录。')
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
