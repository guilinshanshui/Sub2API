import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminAuth } from '../auth.js'
import { errorMessage, sendAdminError } from './helpers.js'

const setupSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})

const loginSchema = z.object({
  password: z.string().min(1),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

export function registerAuthRoutes(app: FastifyInstance, auth: AdminAuth): void {
  app.get('/api/auth/status', async () => ({
    data: auth.status(),
  }))

  app.post('/api/auth/setup', async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendAdminError(reply, 400, 'invalid_request', '设置令牌和新密码均不能为空，密码至少 8 位。')
    }
    try {
      const session = await auth.setup(parsed.data.token, parsed.data.password)
      reply.header('set-cookie', auth.sessionCookieHeader(session.token, 12 * 60 * 60))
      return {
        data: {
          username: session.username,
          expiresAt: session.expiresAt,
          token: session.token,
        },
      }
    } catch (error) {
      return sendAdminError(reply, 409, 'setup_failed', errorMessage(error))
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendAdminError(reply, 400, 'invalid_request', '请输入管理员密码。')
    }
    try {
      const session = await auth.login(parsed.data.password)
      reply.header('set-cookie', auth.sessionCookieHeader(session.token, 12 * 60 * 60))
      return {
        data: {
          username: session.username,
          expiresAt: session.expiresAt,
          token: session.token,
        },
      }
    } catch {
      return sendAdminError(reply, 401, 'invalid_credentials', '管理员密码错误。')
    }
  })

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.header('set-cookie', auth.clearCookieHeader())
    return { data: { loggedOut: true } }
  })

  app.post('/api/auth/password', async (request, reply) => {
    const session = await auth.sessionFromCookieHeader(request.headers.cookie)
    if (session === undefined) {
      return sendAdminError(reply, 401, 'unauthorized', '管理员登录已失效，请重新登录。')
    }
    const parsed = changePasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendAdminError(reply, 400, 'invalid_request', '请输入当前密码，新密码至少 8 位。')
    }
    try {
      await auth.login(parsed.data.currentPassword)
      const nextSession = await auth.changePassword(parsed.data.newPassword)
      reply.header('set-cookie', auth.sessionCookieHeader(nextSession.token, 12 * 60 * 60))
      return {
        data: {
          username: nextSession.username,
          expiresAt: nextSession.expiresAt,
          token: nextSession.token,
        },
      }
    } catch {
      return sendAdminError(reply, 401, 'invalid_credentials', '当前密码错误或新密码不满足要求。')
    }
  })

  app.get('/api/auth/me', async (request, reply) => {
    const session = await auth.sessionFromCookieHeader(request.headers.cookie)
    if (session === undefined) {
      return sendAdminError(reply, 401, 'unauthorized', '管理员登录已失效，请重新登录。')
    }
    return { data: session }
  })
}
