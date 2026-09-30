import {
  Activity,
  ArchiveRestore,
  Bot,
  Boxes,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost, errorText } from './api.js'
import { LoadingBlock } from './components/ui.js'
import { AccountsPage } from './pages/AccountsPage.js'
import { AutomationPage } from './pages/AutomationPage.js'
import { BackupPage } from './pages/BackupPage.js'
import { KeysPage } from './pages/KeysPage.js'
import { LoginPage } from './pages/LoginPage.js'
import { LogsPage } from './pages/LogsPage.js'
import { ModelsPage } from './pages/ModelsPage.js'
import { OverviewPage } from './pages/OverviewPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { UsagePage } from './pages/UsagePage.js'
import type { AdminSession, AuthStatus, HealthStatus } from './types.js'

type PageId = 'overview' | 'accounts' | 'automation' | 'models' | 'keys' | 'usage' | 'logs' | 'settings' | 'backup'

interface NavItem {
  id: PageId
  label: string
  icon: typeof LayoutDashboard
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'accounts', label: '账号池', icon: Users },
  { id: 'automation', label: '积分自动化', icon: Bot },
  { id: 'models', label: '模型', icon: Boxes },
  { id: 'keys', label: 'API 密钥', icon: KeyRound },
  { id: 'usage', label: '用量', icon: Activity },
  { id: 'logs', label: '日志', icon: ScrollText },
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'backup', label: '备份', icon: ArchiveRestore },
]

function pageFromHash(): PageId {
  const value = window.location.hash.replace(/^#\/?/, '')
  return NAV_ITEMS.some((item) => item.id === value) ? value as PageId : 'overview'
}

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>()
  const [session, setSession] = useState<AdminSession>()
  const [health, setHealth] = useState<HealthStatus>()
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refreshAuth = useCallback(async () => {
    const status = await apiGet<AuthStatus>('/api/auth/status')
    setAuthStatus(status)
    if (!status.configured) {
      setSession(undefined)
      return
    }
    try {
      setSession(await apiGet<AdminSession>('/api/auth/me'))
    } catch {
      setSession(undefined)
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await refreshAuth()
        if (active) {
          try {
            setHealth(await apiGet<HealthStatus>('/api/health'))
          } catch {
            setHealth(undefined)
          }
        }
      } catch (reason) {
        if (active) setError(errorText(reason))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [refreshAuth])

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((nextPage: string) => {
    const next = NAV_ITEMS.some((item) => item.id === nextPage) ? nextPage as PageId : 'overview'
    window.location.hash = `#/${next}`
    setPage(next)
  }, [])

  const logout = async () => {
    await apiPost('/api/auth/logout')
    setSession(undefined)
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark"><ShieldCheck size={22} /></div>
        <LoadingBlock label="正在连接管理网关" />
      </main>
    )
  }

  if (error !== undefined && authStatus === undefined) {
    return (
      <main className="boot-screen">
        <div className="boot-error">
          <strong>无法连接管理服务</strong>
          <p>{error}</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </main>
    )
  }

  if (authStatus === undefined) {
    return <main className="boot-screen"><LoadingBlock /></main>
  }

  if (session === undefined) {
    return (
      <LoginPage
        status={authStatus}
        onAuthenticated={setSession}
        onRefreshStatus={refreshAuth}
      />
    )
  }

  const content = (() => {
    switch (page) {
      case 'accounts':
        return <AccountsPage />
      case 'automation':
        return <AutomationPage />
      case 'models':
        return <ModelsPage />
      case 'keys':
        return <KeysPage />
      case 'usage':
        return <UsagePage />
      case 'logs':
        return <LogsPage />
      case 'settings':
        return <SettingsPage />
      case 'backup':
        return <BackupPage />
      default:
        return <OverviewPage onNavigate={navigate} />
    }
  })()

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="app-brand" type="button" onClick={() => navigate('overview')}>
          <span className="brand-mark"><ShieldCheck size={19} /></span>
          <span>
            <strong>Sub2API</strong>
            <small>OpenAI 兼容网关</small>
          </span>
        </button>
        <div className="header-status">
          <span className={health?.status === 'ok' ? 'status-dot' : 'status-dot status-dot-danger'} />
          <span>{health?.status === 'ok' ? '网关在线' : '状态未知'}</span>
          <span className="header-divider" />
          <span className="header-user">{session.username}</span>
          <button className="icon-btn" type="button" title="退出登录" aria-label="退出登录" onClick={() => void logout()}>
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className="app-sidebar">
          <nav aria-label="管理导航">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className={page === item.id ? 'nav-item is-active' : 'nav-item'}
                  type="button"
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="sidebar-footer">
            <span>管理会话</span>
            <strong>{new Date(session.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 到期</strong>
          </div>
        </aside>

        <main className="app-main">{content}</main>
      </div>
    </div>
  )
}
