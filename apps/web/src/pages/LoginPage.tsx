import { KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { apiPost } from '../api.js'
import type { AdminSession, AuthStatus } from '../types.js'

export function LoginPage({
  status,
  onAuthenticated,
  onRefreshStatus,
}: {
  status: AuthStatus
  onAuthenticated(session: AdminSession): void
  onRefreshStatus(): Promise<void>
}) {
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const setup = status.setupRequired

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    if (setup && password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    setBusy(true)
    try {
      const session = setup
        ? await apiPost<AdminSession>('/api/auth/setup', { token, password })
        : await apiPost<AdminSession>('/api/auth/login', { password })
      onAuthenticated(session)
      await onRefreshStatus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-mark">
          <ShieldCheck size={25} />
        </div>
        <div className="auth-heading">
          <span>SUB2API CONTROL PLANE</span>
          <h1>{setup ? '初始化管理账户' : '登录管理台'}</h1>
          <p>{setup ? '输入服务端首次启动时打印的一次性令牌。' : '使用管理员密码继续。'}</p>
        </div>
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          {setup ? (
            <label className="field">
              <span>一次性设置令牌</span>
              <span className="input-with-icon">
                <KeyRound size={15} />
                <input
                  autoFocus
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="启动日志中的 setup token"
                  required
                />
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>管理员密码</span>
            <span className="input-with-icon">
              <LockKeyhole size={15} />
              <input
                autoFocus={!setup}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={setup ? '至少 8 位' : '输入密码'}
                minLength={setup ? 8 : undefined}
                required
              />
            </span>
          </label>
          {setup ? (
            <label className="field">
              <span>确认密码</span>
              <span className="input-with-icon">
                <LockKeyhole size={15} />
                <input
                  type="password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="再次输入密码"
                  minLength={8}
                  required
                />
              </span>
            </label>
          ) : null}
          {error === undefined ? null : <div className="form-error">{error}</div>}
          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? '处理中...' : setup ? '完成初始化' : '登录'}
          </button>
        </form>
        <div className="auth-footnote">
          <span className="status-dot" />
          <span>网关服务正常，管理会话有效期为 12 小时。</span>
        </div>
      </section>
    </main>
  )
}
