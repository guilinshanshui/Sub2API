import {
  ArrowDown,
  ArrowUp,
  BadgeDollarSign,
  Coins,
  ExternalLink,
  ListChecks,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost, errorText } from '../api.js'
import {
  Badge,
  EmptyState,
  InlineError,
  LoadingBlock,
  Modal,
  PageTitle,
  Panel,
  SearchInput,
  cx,
  formatDate,
  formatNumber,
  formatShortDate,
  useConfirm,
  useToast,
} from '../components/ui.js'
import type {
  AutomationTasks,
  CreateAccountResult,
  CreditsBalanceAccount,
  CreditsClaimResult,
  LoginPollResult,
  OnboardingClaimResult,
  OnboardingStatus,
  ProviderAccount,
  ProviderSummary,
  RefreshResult,
  ResetResult,
  RetestResult,
} from '../types.js'

function taskState(task: AutomationTasks['desktop'][number]): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  if (task.acceptStatus === 'claimed' || task.status === 'claimed') return { label: '已领取', tone: 'success' }
  if (task.locked) return { label: '未解锁', tone: 'neutral' }
  if (task.status === 'completed' || (task.target > 0 && task.current >= task.target)) return { label: '可领取', tone: 'warning' }
  if (task.acceptStatus === '' || task.acceptStatus === 'not_accepted') return { label: '未接取', tone: 'info' }
  return { label: '进行中', tone: 'neutral' }
}

interface LoginState extends CreateAccountResult {
  provider: string
  polling: boolean
  phone: string
  code: string
  popup?: Window | null
}

function expirationBadge(account: ProviderAccount) {
  if (account.expiresAt === undefined || !Number.isFinite(account.expiresAt)) {
    return <Badge tone="warning">有效期未知</Badge>
  }
  const remaining = account.expiresAt - Date.now()
  if (remaining <= 0) return <Badge tone="danger">已过期</Badge>
  if (remaining < 24 * 60 * 60 * 1_000) return <Badge tone="warning">即将到期</Badge>
  return <Badge tone="success">有效</Badge>
}

function expirationDetail(account: ProviderAccount): string {
  if (account.expiresAt === undefined || !Number.isFinite(account.expiresAt)) return '上游未返回有效期'
  const date = formatDate(account.expiresAt)
  return account.refreshable && account.refreshError === undefined ? `${date} · 自动续期` : date
}

interface BalanceSummary {
  total: number
  queriedAt: number
  expiredTotal?: number
  packages?: Array<Record<string, unknown>>
  detail?: PhanthyWalletDetail
}

interface GenericCreditPackage {
  name?: unknown
  label?: unknown
  remaining?: unknown
  total?: unknown
  used?: unknown
  active?: unknown
  expiredTime?: unknown
  cycleEndTime?: unknown
  expiresAt?: unknown
  estimate?: unknown
}

interface PhanthyWalletPool {
  key?: unknown
  label?: unknown
  total?: unknown
  remaining?: unknown
  used?: unknown
  lots?: unknown
  expiresAt?: unknown
  estimate?: unknown
}

interface PhanthyWalletDetail {
  wallet?: {
    pools?: unknown
    remaining?: unknown
    used?: unknown
    approximate?: unknown
    pending?: unknown
  }
  daily?: {
    grantedToday?: unknown
    todayPoints?: unknown
    streakDays?: unknown
    totalGranted?: unknown
  }
  planName?: unknown
  planExpiresAt?: unknown
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parsePhanthyDetail(value: unknown): PhanthyWalletDetail | undefined {
  const candidate = value as Partial<PhanthyWalletDetail> | null
  if (typeof value !== 'object' || candidate === null) return undefined
  if (candidate.wallet === undefined && candidate.daily === undefined && candidate.planName === undefined && candidate.planExpiresAt === undefined) {
    return undefined
  }
  return candidate as PhanthyWalletDetail
}

function latestBalance(account: ProviderAccount): BalanceSummary | undefined {
  const snapshots = account.balanceSnapshots
  if (typeof snapshots !== 'object' || snapshots === null) return undefined
  const values = Object.values(snapshots)
    .flatMap((value): BalanceSummary[] => {
      if (typeof value !== 'object' || value === null) return []
      const record = value as Record<string, unknown>
      const total = typeof record.total === 'number' ? record.total : Number(record.amount)
      const queriedAt = typeof record.queriedAt === 'number' ? record.queriedAt : 0
      const detail = parsePhanthyDetail(record.detail)
      const detailRecord = record.detail === undefined || typeof record.detail !== 'object' || record.detail === null
        ? undefined
        : record.detail as Record<string, unknown>
      const packageSource = Array.isArray(record.packages) ? record.packages : Array.isArray(detailRecord?.packages) ? detailRecord?.packages : []
      const packages = packageSource
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      const expiredTotal = asFiniteNumber(record.expiredTotal) ?? asFiniteNumber(detailRecord?.expiredTotal)
      if (!Number.isFinite(total) || record.lastError !== undefined) return []
      return [{
        total,
        queriedAt,
        ...(expiredTotal === undefined ? {} : { expiredTotal }),
        ...(packages.length === 0 ? {} : { packages }),
        ...(detail === undefined ? {} : { detail }),
      }]
    })
    .sort((left, right) => right.queriedAt - left.queriedAt)
  return values[0]
}

function accountRateLimitCount(account: ProviderAccount): number {
  return Object.values(account.modelRateLimits ?? {}).filter((value) => value > Date.now()).length
}

function phanthyRewardLine(detail: PhanthyWalletDetail | undefined): string | undefined {
  const daily = detail?.daily
  if (typeof daily !== 'object' || daily === null) return undefined
  const todayPoints = asFiniteNumber(daily.todayPoints)
  const streakDays = asFiniteNumber(daily.streakDays)
  const totalGranted = asFiniteNumber(daily.totalGranted)
  if (todayPoints === undefined && streakDays === undefined && totalGranted === undefined) return undefined
  const grantedToday = daily.grantedToday === true
  const parts = [grantedToday ? '今日已到账' : '今日未到账']
  if (todayPoints !== undefined && todayPoints > 0) parts.push(`今日 +${formatNumber(todayPoints)}`)
  if (streakDays !== undefined) parts.push(`连续 ${formatNumber(streakDays)} 天`)
  if (totalGranted !== undefined) parts.push(`累计 ${formatNumber(totalGranted)}`)
  return parts.join(' · ')
}

function genericPackageLabel(entry: GenericCreditPackage): string {
  return asString(entry.name) ?? asString(entry.label) ?? '额度池'
}

function genericPackageDate(entry: GenericCreditPackage): string | undefined {
  const raw = asString(entry.expiresAt) ?? asString(entry.expiredTime) ?? asString(entry.cycleEndTime)
  if (raw === undefined) return undefined
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : raw
}

function CreditPackageDetails({ packages, expiredTotal }: { packages?: Array<Record<string, unknown>>; expiredTotal?: number }) {
  if (packages === undefined || packages.length === 0) return null
  // CodeBuddy 会把每日任务产生的几十个小额裂变包都单独返回；直接铺开反而
  // 掩盖主要额度，所以同名小额包先聚合，再保留原始明细用于精确剩余。
  const keyed = new Map<string, { name: string; remaining: number; total: number; used: number; active: boolean; nearestExpiry?: string; entries: GenericCreditPackage[] }>()
  for (const raw of packages) {
    const entry = raw as GenericCreditPackage
    const name = genericPackageLabel(entry)
    const active = entry.active !== false
    const remaining = asFiniteNumber(entry.remaining) ?? 0
    const total = asFiniteNumber(entry.total) ?? 0
    const used = asFiniteNumber(entry.used) ?? 0
    const expiry = genericPackageDate(entry)
    const aggregate = keyed.get(name)
    if (aggregate === undefined) {
      keyed.set(name, { name, remaining, total, used, active, nearestExpiry: expiry, entries: [entry] })
      continue
    }
    aggregate.remaining += remaining
    aggregate.total += total
    aggregate.used += used
    aggregate.active = aggregate.active && active
    if (expiry !== undefined && (aggregate.nearestExpiry === undefined || Date.parse(expiry.replace(' ', 'T')) < Date.parse(aggregate.nearestExpiry.replace(' ', 'T')))) {
      aggregate.nearestExpiry = expiry
    }
    aggregate.entries.push(entry)
  }
  const rows = [...keyed.values()].sort((left, right) => right.remaining - left.remaining)
  return (
    <div className="phanthy-credit-details">
      {rows.map((row, index) => {
        const label = row.name
        const remaining = row.remaining
        const total = row.total
        const used = row.used
        const active = row.active
        const expiry = row.nearestExpiry
        const percent = remaining !== undefined && total !== undefined && total > 0
          ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
          : undefined
        const subParts = [
          used === undefined ? null : `已用 ${formatNumber(used)}`,
          expiry === undefined ? null : `${expiry} 到期`,
          active ? null : '已失效',
          row.entries.length > 1 ? `${row.entries.length} 个包` : null,
          (row.entries[0] as GenericCreditPackage | undefined)?.estimate === true ? '估算' : null,
        ].filter((item): item is string => item !== null)
        return (
          <div key={`${label}-${index}`} className={active ? 'phanthy-pool' : 'phanthy-pool is-expired'}>
            <div className="phanthy-pool-top">
              <span>{label}</span>
              <strong>{formatNumber(remaining ?? 0)}{total === undefined ? '' : ` / ${formatNumber(total)}`}</strong>
            </div>
            {percent === undefined ? null : (
              <div className="phanthy-pool-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
            )}
            {subParts.length === 0 ? null : <div className="phanthy-pool-sub">{subParts.join(' · ')}</div>}
          </div>
        )
      })}
      {packages.length > 0 && packages.every((raw) => asFiniteNumber((raw as GenericCreditPackage).total) === undefined) ? (
        <div className="phanthy-pool-sub">总量上游未提供，仅展示剩余</div>
      ) : null}
      {expiredTotal === undefined || expiredTotal <= 0 ? null : (
        <div className="phanthy-pool-sub">另有 {formatNumber(expiredTotal)} 已失效</div>
      )}
    </div>
  )
}

function PhanthyCreditDetails({ detail }: { detail: PhanthyWalletDetail | undefined }) {
  if (detail === undefined) return null
  const wallet = detail.wallet
  const pools = Array.isArray(wallet?.pools)
    ? wallet?.pools.filter((pool): pool is PhanthyWalletPool => typeof pool === 'object' && pool !== null)
    : []
  const rewardLine = phanthyRewardLine(detail)
  const planName = asString(detail.planName)
  const planExpiresAt = asString(detail.planExpiresAt)
  const pending = asFiniteNumber(wallet?.pending)
  const approximate = wallet?.approximate === true
  const rewardPools = pools.filter((pool) => pool.key !== 'plan')
  if (pools.length === 0 && rewardLine === undefined && planName === undefined && pending === undefined) return null
  return (
    <div className="phanthy-credit-details">
      {rewardLine === undefined ? null : <div className="phanthy-reward-line">{rewardLine}</div>}
      {pools.map((pool, index) => {
        const label = asString(pool.label) ?? '额度池'
        const remaining = asFiniteNumber(pool.remaining)
        const total = asFiniteNumber(pool.total)
        const used = asFiniteNumber(pool.used)
        const expiry = asString(pool.expiresAt)
        const lots = asFiniteNumber(pool.lots)
        const percent = remaining !== undefined && total !== undefined && total > 0
          ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
          : undefined
        const subParts = [
          used !== undefined ? `已用 ${formatNumber(used)}` : undefined,
          expiry !== undefined ? `${Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toLocaleDateString() : expiry} 到期` : undefined,
          lots !== undefined && lots > 1 ? `${formatNumber(lots)} 批` : undefined,
          pool.estimate === true ? '估算' : undefined,
        ].filter((item): item is string => item !== undefined)
        return (
          <div key={`${label}-${index}`} className="phanthy-pool">
            <div className="phanthy-pool-top">
              <span>{label}</span>
              <strong>{formatNumber(remaining ?? 0)}{total === undefined ? '' : ` / ${formatNumber(total)}`}</strong>
            </div>
            {percent === undefined ? null : (
              <div className="phanthy-pool-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
            )}
            {subParts.length === 0 ? null : <div className="phanthy-pool-sub">{subParts.join(' · ')}{approximate ? ' · 已用为估算' : ''}</div>}
          </div>
        )
      })}
      {pending === undefined || pending <= 0 ? null : <div className="phanthy-pool-sub">待发放 {formatNumber(pending)}</div>}
      {planExpiresAt === undefined ? null : <div className="phanthy-pool-sub">{planName ?? '套餐'} 到期 {planExpiresAt}</div>}
    </div>
  )
}

function CreditDetails({ balance }: { balance: BalanceSummary | undefined }) {
  if (balance === undefined) return null
  if (balance.detail?.wallet !== undefined) return <PhanthyCreditDetails detail={balance.detail} />
  return <CreditPackageDetails packages={balance.packages} expiredTotal={balance.expiredTotal} />
}

function cooldownRemainingText(account: ProviderAccount): string | undefined {
  const remaining = (account.cooldownUntil ?? 0) - Date.now()
  if (remaining <= 0) return undefined
  const minutes = Math.ceil(remaining / 60_000)
  return minutes < 1 ? '不足 1 分钟' : `${minutes} 分钟`
}

function cooldownText(until: number | undefined): string | undefined {
  const remaining = (until ?? 0) - Date.now()
  if (remaining <= 0) return undefined
  const minutes = Math.ceil(remaining / 60_000)
  return minutes < 1 ? '不足 1 分钟' : `${minutes} 分钟`
}

export function AccountsPage() {
  const { notify } = useToast()
  const { confirm } = useConfirm()
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addProvider, setAddProvider] = useState('')
  const [login, setLogin] = useState<LoginState>()
  const [editAccount, setEditAccount] = useState<ProviderAccount>()
  const [editNickname, setEditNickname] = useState('')
  const [editReserveCredits, setEditReserveCredits] = useState('0')
  const [onboardingAccount, setOnboardingAccount] = useState<ProviderAccount>()
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>()
  const [tasksAccount, setTasksAccount] = useState<ProviderAccount>()
  const [tasksData, setTasksData] = useState<AutomationTasks>()
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksBusy, setTasksBusy] = useState(false)
  const [creditResult, setCreditResult] = useState<CreditsClaimResult>()
  const [balanceResult, setBalanceResult] = useState<CreditsBalanceAccount[]>()
  const [autoBalanceRefreshing, setAutoBalanceRefreshing] = useState(false)

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true)
    setError(undefined)
    try {
      const [providerData, accountData] = await Promise.all([
        apiGet<{ providers: ProviderSummary[] }>('/api/providers'),
        apiGet<{ accounts: ProviderAccount[] }>('/api/accounts'),
      ])
      setProviders(providerData.providers)
      setAccounts(accountData.accounts)
      setAddProvider((current) => current || providerData.providers[0]?.id || '')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  const refreshVisibleBalances = async (activeProviderFilter: string) => {
    if (autoBalanceRefreshing) return
    setAutoBalanceRefreshing(true)
    try {
      if (activeProviderFilter !== '') {
        await apiPost(`/api/providers/${encodeURIComponent(activeProviderFilter)}/credits/balances`, {})
      } else {
        const accountData = await apiGet<{ accounts: ProviderAccount[] }>('/api/accounts')
        const providers = [...new Set(accountData.accounts.filter((account) => account.enabled).map((account) => account.provider))]
        for (const provider of providers) {
          await apiPost(`/api/providers/${encodeURIComponent(provider)}/credits/balances`, {})
        }
      }
      await load(true)
    } catch {
      // Page load should not become an error banner just because an upstream is temporarily unavailable.
    } finally {
      setAutoBalanceRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    void refreshVisibleBalances(providerFilter)
  }, [providerFilter])

  useEffect(() => {
    const timer = window.setInterval(() => void load(true), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // 兼容旧版返回：未显式给 loginMode 的 URL 登录一律按 url 轮询。
    if (login === undefined || (login.loginMode !== undefined && login.loginMode !== 'url')) return
    let active = true
    let timer: number | undefined
    let consecutiveFailures = 0
    const poll = async () => {
      try {
        const result = await apiPost<LoginPollResult>('/api/login/poll', {
          accountId: login.accountId,
          provider: login.provider,
        })
        if (!active) return
        if (result.done) {
          if (result.success === false) {
            setLogin((current) => current === undefined ? current : { ...current, polling: false })
            notify(result.error ?? '账号登录失败。', 'error')
            return
          }
          setLogin(undefined)
          setAddOpen(false)
          notify('账号登录成功。', 'success')
          await refreshAccountCredits(login.accountId, login.provider, { quiet: true })
          return
        }
        consecutiveFailures = 0
      } catch {
        // Login polling can transiently fail while the upstream callback is active.
        consecutiveFailures += 1
        if (consecutiveFailures >= 10) {
          setLogin((current) => current === undefined ? current : { ...current, polling: false })
          notify('登录状态查询失败，请手动关闭或重试。', 'error')
          return
        }
      }
      if (active && login.popup?.closed) {
        setLogin((current) => current === undefined ? current : { ...current, polling: false })
        notify('登录页已关闭。若刚完成授权，请稍候几秒；否则请重新登录。', 'info')
        return
        }
      if (active) timer = window.setTimeout(() => void poll(), 2_000)
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [login?.accountId, login?.loginMode, login?.provider, notify])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return accounts.filter((account) => {
      if (providerFilter !== '' && account.provider !== providerFilter) return false
      if (needle === '') return true
      return account.id.toLowerCase().includes(needle)
        || account.nickname.toLowerCase().includes(needle)
        || account.provider.toLowerCase().includes(needle)
    })
  }, [accounts, providerFilter, search])

  const runAccountAction = async (
    account: ProviderAccount,
    action: 'refresh' | 'retest' | 'reset',
  ) => {
    setBusyId(account.id)
    try {
      if (action === 'refresh') {
        const result = await apiPost<RefreshResult>(`/api/accounts/${encodeURIComponent(account.id)}/refresh`)
        if (!result.success) throw new Error(result.error ?? '刷新失败')
        notify('账号凭据已刷新。', 'success')
      } else if (action === 'retest') {
        const result = await apiPost<RetestResult>(`/api/accounts/${encodeURIComponent(account.id)}/retest`)
        const detail = result.accounts[0]
        notify(`重测完成：清除 ${result.clearedCount} 个限流标记${detail?.stillLimited.length ? `，仍有 ${detail.stillLimited.length} 个受限` : ''}。`, 'success')
      } else {
        const result = await apiPost<ResetResult>(`/api/accounts/${encodeURIComponent(account.id)}/reset`)
        notify(`已清除 ${result.clearedCount} 个限流标记。`, 'success')
      }
      await load(true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const setEnabled = async (account: ProviderAccount, enabled: boolean) => {
    setBusyId(account.id)
    try {
      await apiPatch(`/api/accounts/${encodeURIComponent(account.id)}`, { enabled })
      setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, enabled } : item))
      notify(enabled ? '账号已启用。' : '账号已停用。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const toggleAccount = async (account: ProviderAccount) => {
    await setEnabled(account, !account.enabled)
  }

  const deleteAccount = async (account: ProviderAccount) => {
    const accepted = await confirm({
      title: '删除账号',
      description: `确定删除“${account.nickname}”吗？对应凭据也会从账号池中移除。`,
      confirmText: '删除',
      danger: true,
    })
    if (!accepted) return
    setBusyId(account.id)
    try {
      await apiDelete(`/api/accounts/${encodeURIComponent(account.id)}`)
      notify('账号已删除。', 'success')
      await load(true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const moveAccount = async (account: ProviderAccount, direction: -1 | 1) => {
    const group = accounts.filter((item) => item.provider === account.provider)
    const index = group.findIndex((item) => item.id === account.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= group.length) return
    const next = [...group]
    const [item] = next.splice(index, 1)
    if (item === undefined) return
    next.splice(target, 0, item)
    setBusyId(account.id)
    try {
      await apiPost('/api/accounts/reorder', {
        provider: account.provider,
        orderedIds: next.map((entry) => entry.id),
      })
      setAccounts((current) => [
        ...current.filter((entry) => entry.provider !== account.provider),
        ...next,
      ])
      notify('账号优先级已更新。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const startLogin = async (event: FormEvent) => {
    event.preventDefault()
    if (addProvider === '') return
    const popup = window.open('about:blank', '_blank')
    try {
      const result = await apiPost<CreateAccountResult>('/api/accounts', { provider: addProvider })
      if (result.loginMode === 'sms' || result.loginMode === 'code') {
        if (result.loginMode === 'code' && result.loginUrl.length > 0) {
          if (popup !== null) popup.location.href = result.loginUrl
          else window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
        } else {
          popup?.close()
        }
        setLogin({
          ...result,
          provider: addProvider,
          polling: false,
          phone: '',
          code: '',
        })
        return
      }
      if (result.loginUrl.length > 0) {
        if (popup !== null) popup.location.href = result.loginUrl
        else window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
      } else {
        popup?.close()
      }
      setLogin({
        ...result,
        provider: addProvider,
        polling: true,
        phone: '',
        code: '',
        popup,
      })
    } catch (reason) {
      popup?.close()
      notify(errorText(reason), 'error')
    }
  }

  const sendSms = async () => {
    if (login === undefined) return
    try {
      await apiPost('/api/login/send-sms', {
        accountId: login.accountId,
        provider: login.provider,
        phone: login.phone,
      })
      notify('验证码已发送。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const submitSms = async () => {
    if (login === undefined) return
    try {
      const result = await apiPost<LoginPollResult>('/api/login/submit-sms', {
        accountId: login.accountId,
        provider: login.provider,
        code: login.code,
      })
      if (!result.done) throw new Error(result.error ?? '验证码验证失败。')
      setLogin(undefined)
      setAddOpen(false)
      notify('账号登录成功。', 'success')
      await load(true)
      await refreshAccountCredits(login.accountId, login.provider)
      await load(true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const providerAction = async (provider: string, action: 'retest' | 'reset' | 'claim' | 'balances') => {
    setBusyId(provider)
    try {
      if (action === 'retest') {
        const result = await apiPost<RetestResult>(`/api/providers/${encodeURIComponent(provider)}/retest`)
        notify(`批量重测完成：清除 ${result.clearedCount} 个限流标记。`, 'success')
      } else if (action === 'reset') {
        const result = await apiPost<ResetResult>(`/api/providers/${encodeURIComponent(provider)}/reset`)
        notify(`已清除 ${result.clearedCount} 个限流标记。`, 'success')
      } else if (action === 'claim') {
        const result = await apiPost<CreditsClaimResult>(`/api/providers/${encodeURIComponent(provider)}/credits/claim`)
        setCreditResult(result)
      } else {
        const result = await apiPost<{ accounts: CreditsBalanceAccount[] }>(`/api/providers/${encodeURIComponent(provider)}/credits/balances`)
        setBalanceResult(result.accounts)
      }
      if (action !== 'claim' && action !== 'balances') await load(true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const refreshAccountCredits = async (
    accountId: string,
    provider: string,
    options: { quiet?: boolean } = {},
  ) => {
    setBusyId(accountId)
    try {
      const result = await apiPost<{ accounts: CreditsBalanceAccount[] }>(
        `/api/accounts/${encodeURIComponent(accountId)}/credits/refresh?provider=${encodeURIComponent(provider)}`,
      )
      const item = result.accounts[0]
      if (item === undefined) throw new Error('未返回积分结果。')
      if (item.error !== undefined && item.balance === null) {
        if (!options.quiet) notify(`积分查询失败：${item.error}`, 'error')
        return
      }
      await load(true)
      if (!options.quiet) notify(`积分查询完成：${formatNumber(item.balance?.total ?? 0)}。`, 'success')
    } catch (reason) {
      if (!options.quiet) notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const queryAccountBalance = async (account: ProviderAccount) => {
    await refreshAccountCredits(account.id, account.provider)
  }

  const openOnboarding = async (account: ProviderAccount) => {
    setOnboardingAccount(account)
    setOnboardingStatus(undefined)
    try {
      setOnboardingStatus(await apiPost<OnboardingStatus>('/api/onboarding/status', {
        accountId: account.id,
        provider: account.provider,
      }))
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const claimOnboarding = async () => {
    if (onboardingAccount === undefined) return
    try {
      const result = await apiPost<OnboardingClaimResult>('/api/onboarding/claim', {
        accountId: onboardingAccount.id,
        provider: onboardingAccount.provider,
      })
      notify(`领取完成：新增 ${result.claimed.length} 项，共 ${result.earned}/${result.total} 积分。`, 'success')
      setOnboardingStatus({
        tasks: Object.fromEntries(Object.entries(onboardingStatus?.tasks ?? {}).map(([key]) => [key, true])),
        earned: result.earned,
        total: result.total,
        titles: onboardingStatus?.titles,
        points: onboardingStatus?.points,
      })
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const loadTasks = async (account: ProviderAccount, quiet = false) => {
    setTasksAccount(account)
    setTasksLoading(!quiet)
    try {
      setTasksData(await apiGet<AutomationTasks>(`/api/automation/tasks/${encodeURIComponent(account.id)}`))
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setTasksLoading(false)
    }
  }

  const runBuddyTasks = async (account: ProviderAccount) => {
    setTasksBusy(true)
    try {
      const result = await apiPost<{ message?: string; status?: string }>('/api/automation/run', {
        jobId: 'cn_daily',
        provider: account.provider,
        accountId: account.id,
      })
      notify(result.message || 'CodeBuddy 自动化任务已执行。', 'success')
      await loadTasks(account, true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setTasksBusy(false)
    }
  }

  const disablePendingAccount = async () => {
    if (login === undefined) return
    setBusyId(login.accountId)
    try {
      await apiPatch(`/api/accounts/${encodeURIComponent(login.accountId)}`, { enabled: false })
      setLogin(undefined)
      setAddOpen(false)
      setAccounts((current) => current.map((item) => item.id === login.accountId ? { ...item, enabled: false } : item))
      notify('账号已停用并关闭授权窗口。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const saveNickname = async () => {
    if (editAccount === undefined) return
    try {
      const reserve = Number(editReserveCredits)
      await apiPatch(`/api/accounts/${encodeURIComponent(editAccount.id)}`, {
        nickname: editNickname.trim(),
        reserveCredits: Number.isFinite(reserve) && reserve >= 0 ? reserve : 0,
      })
      setEditAccount(undefined)
      notify('账号名称与保留积分已保存。', 'success')
      await load(true)
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  return (
    <div className="page-stack">
      <PageTitle
        title="账号池"
        description="管理上游账号、登录状态、续期与限流恢复。"
        actions={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : undefined} />
              刷新
            </button>
            <button className="btn btn-primary" type="button" onClick={() => { setLogin(undefined); setAddOpen(true) }}>
              <Plus size={15} />
              添加账号
            </button>
          </>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <Panel
        title="服务商总览"
        subtitle="点击卡片筛选账号，再次点击取消筛选"
        actions={providerFilter === '' ? undefined : (
          <button className="btn btn-secondary btn-small" type="button" onClick={() => setProviderFilter('')}>
            清除筛选
          </button>
        )}
      >
        <div className="provider-grid">
          {providers.map((provider) => {
            const active = providerFilter === provider.id
            return (
              <button
                key={provider.id}
                className={cx('provider-card', active && 'is-active')}
                type="button"
                aria-pressed={active}
                onClick={() => setProviderFilter((current) => current === provider.id ? '' : provider.id)}
              >
                <div className="provider-card-header">
                  <div>
                    <div className="cell-main">{provider.displayName}</div>
                    <div className="cell-sub mono">{provider.id}</div>
                  </div>
                  {active ? (
                    <Badge tone="info">已筛选</Badge>
                  ) : provider.accountCount === 0 ? (
                    <Badge tone="neutral">未添加</Badge>
                  ) : provider.validCount === 0 ? (
                    <Badge tone="warning">无有效账号</Badge>
                  ) : (
                    <Badge tone="success">有效账号</Badge>
                  )}
                </div>
                <div className="provider-card-stats">
                  <div><span>账号</span><strong>{provider.accountCount}</strong></div>
                  <div><span>有效</span><strong>{provider.validCount}</strong></div>
                  <div><span>可续期</span><strong>{provider.refreshableCount}</strong></div>
                </div>
              </button>
            )
          })}
        </div>
      </Panel>

      <Panel>
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索账号、昵称或服务商" />
          <select className="select" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
            <option value="">全部服务商</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          {providerFilter === '' ? null : (
            <>
              <button className="btn btn-secondary btn-small" type="button" disabled={busyId === providerFilter} onClick={() => void providerAction(providerFilter, 'retest')}>
                <SearchCheck size={14} />
                重测限流
              </button>
              <button className="btn btn-secondary btn-small" type="button" disabled={busyId === providerFilter} onClick={() => void providerAction(providerFilter, 'reset')}>
                <RotateCcw size={14} />
                清除限流
              </button>
              <button className="btn btn-secondary btn-small" type="button" disabled={busyId === providerFilter} onClick={() => void providerAction(providerFilter, 'claim')}>
                <BadgeDollarSign size={14} />
                一键签到
              </button>
              <button className="btn btn-secondary btn-small" type="button" disabled={busyId === providerFilter} onClick={() => void providerAction(providerFilter, 'balances')}>
                <Coins size={14} />
                查询余额
              </button>
            </>
          )}
          <span className="toolbar-spacer" />
          <span className="toolbar-count">{filtered.length} / {accounts.length} 个账号</span>
        </div>

        {loading && accounts.length === 0 ? <LoadingBlock /> : filtered.length === 0 ? (
          <EmptyState
            title={accounts.length === 0 ? '尚未添加账号' : '没有匹配的账号'}
            description={accounts.length === 0 ? '添加一个上游账号后即可开始转发请求。' : '调整服务商筛选或搜索条件。'}
          />
        ) : (
          <div className="account-grid">
            {filtered.map((account) => {
              const rateLimits = accountRateLimitCount(account)
              const balance = latestBalance(account)
              const failureCount = account.consecutiveFailures ?? 0
              const cooldown = cooldownRemainingText(account)
              const softCooldown = cooldownText(account.softRateCooldownUntil)
              const degradeCooldown = cooldownText(account.degradeCooldownUntil)
              const canOnboard = account.provider === 'loomy' || account.provider === 'raccoon'
              return (
                <article key={account.id} className={cx('account-card', !account.enabled && 'is-disabled')}>
                  <div className="account-card-header">
                    <div className="account-card-identity">
                      <div className="account-card-title">
                        <div className="cell-main">{account.nickname}</div>
                        <Badge tone="info">{providers.find((item) => item.id === account.provider)?.name ?? account.provider}</Badge>
                      </div>
                      <div className="cell-sub mono">{account.id}</div>
                    </div>
                    <div className="account-card-status">
                      <button
                        className={account.enabled ? 'btn btn-secondary btn-small account-status-btn is-on' : 'btn btn-secondary btn-small account-status-btn is-off'}
                        type="button"
                        disabled={busyId === account.id}
                        onClick={() => void toggleAccount(account)}
                      >
                        <Power size={13} />
                        {account.enabled ? '停用' : '启用'}
                      </button>
                    </div>
                  </div>
                  <div className="account-card-details">
                    <div className="account-detail-row">
                      <span className="account-detail-label">凭据</span>
                      <div className="account-detail-value">
                        <code className="inline-code account-detail-code" title={account.credentialRef}>
                          {account.credentialRef || '-'}
                        </code>
                      </div>
                    </div>
                    <div className="account-detail-row">
                      <span className="account-detail-label">有效期</span>
                      <div className="account-detail-value">
                        <span className="account-detail-main">{expirationDetail(account)}</span>
                        {expirationBadge(account)}
                        {account.refreshError === undefined ? null : <Badge tone="danger">续期异常</Badge>}
                      </div>
                    </div>
                    <div className="account-detail-row">
                      <span className="account-detail-label">积分</span>
                      <div className="account-detail-value">
                        {balance === undefined ? (
                          <span className="cell-sub">尚未查询</span>
                        ) : (
                          <>
                            <strong className="account-balance">{formatNumber(balance.total)}</strong>
                            <span className="cell-sub">{formatShortDate(balance.queriedAt)} 查询</span>
                          </>
                        )}
                        {(account.reserveCredits ?? 0) > 0 ? <Badge tone="warning">保留 {account.reserveCredits}</Badge> : null}
                      </div>
                    </div>
                    {balance === undefined || (balance.detail === undefined && (balance.packages === undefined || balance.packages.length === 0)) ? null : (
                      <div className="account-detail-row account-detail-row-wide">
                        <span className="account-detail-label">明细</span>
                        <div className="account-detail-value">
                          <CreditDetails balance={balance} />
                        </div>
                      </div>
                    )}
                    {rateLimits === 0 ? null : (
                      <div className="account-detail-row">
                        <span className="account-detail-label">限流</span>
                        <div className="account-detail-value">
                          <Badge tone="warning">{rateLimits} 个模型受限</Badge>
                        </div>
                      </div>
                    )}
                    {failureCount === 0 && cooldown === undefined ? null : (
                      <div className="account-detail-row">
                        <span className="account-detail-label">熔断</span>
                        <div className="account-detail-value">
                          {failureCount > 0 ? <Badge tone="warning">连续失败 {failureCount}</Badge> : null}
                          {cooldown !== undefined ? <Badge tone="danger">冷却 {cooldown}</Badge> : null}
                        </div>
                      </div>
                    )}
                    {account.inFlight === undefined || account.inFlight === 0 ? null : (
                      <div className="account-detail-row">
                        <span className="account-detail-label">在途</span>
                        <div className="account-detail-value">
                          <Badge tone="info">{account.inFlight} 个请求</Badge>
                        </div>
                      </div>
                    )}
                    {softCooldown === undefined && degradeCooldown === undefined ? null : (
                      <div className="account-detail-row">
                        <span className="account-detail-label">治理</span>
                        <div className="account-detail-value">
                          {softCooldown === undefined ? null : <Badge tone="warning">限流 {softCooldown}</Badge>}
                          {degradeCooldown === undefined ? null : <Badge tone="warning">降权 {degradeCooldown}</Badge>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="account-card-actions">
                    <div className="account-action-group">
                      <button className="icon-btn" type="button" title="上移" aria-label="上移" disabled={busyId === account.id} onClick={() => void moveAccount(account, -1)}>
                        <ArrowUp size={15} />
                      </button>
                      <button className="icon-btn" type="button" title="下移" aria-label="下移" disabled={busyId === account.id} onClick={() => void moveAccount(account, 1)}>
                        <ArrowDown size={15} />
                      </button>
                      <button className="icon-btn" type="button" title="编辑名称与保留积分" aria-label="编辑账号" onClick={() => { setEditAccount(account); setEditNickname(account.nickname); setEditReserveCredits(String(account.reserveCredits ?? 0)) }}>
                        <Pencil size={15} />
                      </button>
                    </div>
                    <div className="account-action-group account-action-group-main">
                      <button className="btn btn-secondary btn-small" type="button" title="刷新账号凭据" disabled={busyId === account.id} onClick={() => void runAccountAction(account, 'refresh')}>
                        <RefreshCw size={14} className={busyId === account.id ? 'spin' : undefined} />
                        续期
                      </button>
                      <button className="btn btn-secondary btn-small" type="button" title="查询该账号积分" disabled={busyId === account.id} onClick={() => void queryAccountBalance(account)}>
                        <Coins size={14} />
                        查积分
                      </button>
                      <button className="btn btn-secondary btn-small" type="button" disabled={busyId === account.id} onClick={() => void runAccountAction(account, 'retest')}>
                        <SearchCheck size={14} />
                        重测
                      </button>
                      <button className="btn btn-secondary btn-small" type="button" disabled={busyId === account.id} onClick={() => void runAccountAction(account, 'reset')}>
                        <RotateCcw size={14} />
                        {failureCount > 0 || cooldown !== undefined ? '恢复' : '重置'}
                      </button>
                      {canOnboard ? (
                        <button className="btn btn-secondary btn-small" type="button" onClick={() => void openOnboarding(account)}>
                          <Sparkles size={14} />
                          新手任务
                        </button>
                      ) : null}
                      {account.provider === 'buddy' ? (
                        <button className="btn btn-secondary btn-small" type="button" onClick={() => void loadTasks(account)}>
                          <ListChecks size={14} />
                          积分任务
                        </button>
                      ) : null}
                      <button className="btn btn-secondary btn-small account-action-delete" type="button" disabled={busyId === account.id} onClick={() => void deleteAccount(account)}>
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </Panel>

      <Modal
        open={addOpen}
        title="添加上游账号"
        onClose={() => {
          setAddOpen(false)
          setLogin(undefined)
        }}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => { setAddOpen(false); setLogin(undefined) }}>关闭</button>
            {login?.loginMode === 'sms' || login?.loginMode === 'code' ? (
              <button className="btn btn-primary" type="button" onClick={() => void submitSms()} disabled={login.code.length === 0}>验证并登录</button>
            ) : login === undefined ? (
              <button className="btn btn-primary" type="submit" form="add-account-form" disabled={addProvider === ''}>开始登录</button>
            ) : null}
          </>
        )}
      >
        {login === undefined ? (
          <form id="add-account-form" className="form-stack" onSubmit={(event) => void startLogin(event)}>
            <label className="field">
              <span>服务商</span>
              <select className="select" value={addProvider} onChange={(event) => setAddProvider(event.target.value)} required>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}（{provider.enabledCount}/{provider.accountCount} 启用）</option>
                ))}
              </select>
            </label>
            <p className="modal-description">将打开上游登录页。授权完成后，本窗口会自动检测凭据并刷新账号池。</p>
          </form>
        ) : login.loginMode === 'code' ? (
          <div className="form-stack">
            <div className="login-progress">
              <div>
                <strong>PhanthyCode 授权码</strong>
                <p>先生成并打开授权链接；授权成功后，把浏览器显示的授权码粘贴到下面。</p>
              </div>
            </div>
            <label className="field">
              <span>授权链接</span>
              <textarea className="oauth-url" readOnly value={login.loginUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <div className="oauth-actions">
              <button className="btn btn-secondary" type="button" onClick={() => window.open(login.loginUrl, '_blank', 'noopener,noreferrer')}>
                <ExternalLink size={14} />
                打开链接
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void navigator.clipboard.writeText(login.loginUrl).then(() => notify('授权链接已复制。', 'success')).catch(() => notify('复制失败，请手动选择链接。', 'error'))}
              >
                复制链接
              </button>
            </div>
            <label className="field">
              <span>授权码（Authorization code）</span>
              <textarea
                value={login.code}
                onChange={(event) => setLogin({ ...login, code: event.target.value })}
                placeholder="粘贴浏览器里显示的 code"
                autoFocus
              />
            </label>
          </div>
        ) : login.loginMode === 'sms' ? (
          <div className="form-stack">
            <label className="field">
              <span>手机号</span>
              <input value={login.phone} onChange={(event) => setLogin({ ...login, phone: event.target.value })} placeholder="11 位手机号" />
            </label>
            <button className="btn btn-secondary" type="button" onClick={() => void sendSms()} disabled={login.phone.length !== 11}>发送验证码</button>
            <label className="field">
              <span>短信验证码</span>
              <input value={login.code} onChange={(event) => setLogin({ ...login, code: event.target.value })} placeholder="输入验证码" />
            </label>
          </div>
        ) : (
          <div className="login-progress">
            <span className="loading-spinner"><RefreshCw size={18} className="spin" /></span>
            <div>
              <strong>等待上游授权</strong>
              <p>若浏览器拦截了登录页，请使用下方链接继续。</p>
            </div>
            <a className="login-link" href={login.loginUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              {login.loginUrl}
            </a>
          </div>
        )}
      </Modal>

      <Modal
        open={editAccount !== undefined}
        title="编辑账号"
        onClose={() => setEditAccount(undefined)}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setEditAccount(undefined)}>取消</button>
            <button className="btn btn-primary" type="button" onClick={() => void saveNickname()} disabled={editNickname.trim() === ''}>保存</button>
          </>
        )}
      >
        <label className="field">
          <span>账号名称</span>
          <input value={editNickname} onChange={(event) => setEditNickname(event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>保留积分</span>
          <input
            type="number"
            min="0"
            value={editReserveCredits}
            onChange={(event) => setEditReserveCredits(event.target.value)}
          />
          <small>余额不高于该值时自动任务暂停接单；填 0 关闭。从未查询过余额的账号不受影响。</small>
        </label>
      </Modal>

      <Modal
        open={onboardingAccount !== undefined}
        title="新手任务与一次性奖励"
        onClose={() => setOnboardingAccount(undefined)}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setOnboardingAccount(undefined)}>关闭</button>
            <button className="btn btn-primary" type="button" onClick={() => void claimOnboarding()} disabled={onboardingStatus === undefined}>领取可领奖励</button>
          </>
        )}
      >
        {onboardingStatus === undefined ? <LoadingBlock label="正在查询任务状态" /> : (
          <div className="task-list">
            <div className="task-summary">
              <span>累计进度</span>
              <strong>{onboardingStatus.earned} / {onboardingStatus.total}</strong>
            </div>
            {Object.entries(onboardingStatus.tasks).map(([key, complete]) => (
              <div className="task-row" key={key}>
                <span className={complete ? 'task-state is-done' : 'task-state'}>{complete ? '已完成' : '可领取'}</span>
                <strong>{onboardingStatus.titles?.[key] ?? key}</strong>
                <span>{onboardingStatus.points?.[key] ?? 0} 分</span>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={tasksAccount !== undefined}
        title="CodeBuddy 成长任务"
        onClose={() => { setTasksAccount(undefined); setTasksData(undefined) }}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => { setTasksAccount(undefined); setTasksData(undefined) }}>关闭</button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={tasksBusy || tasksAccount === undefined}
              onClick={() => tasksAccount === undefined ? undefined : void runBuddyTasks(tasksAccount)}
            >
              {tasksBusy ? '执行中' : '一键执行可自动任务'}
            </button>
          </>
        )}
      >
        {tasksLoading || tasksData === undefined ? <LoadingBlock label="正在读取桌面端与小程序任务" /> : (
          <div className="task-list">
            {tasksData.errors.map((message) => (
              <InlineError key={message} message={message} />
            ))}
            {[{ key: 'desktop', label: '桌面端' }, { key: 'miniprogram', label: '小程序' }].map((group) => (
              <div key={group.key}>
                <div className="task-summary">
                  <span>{group.label}</span>
                  <strong>{tasksData[group.key as 'desktop' | 'miniprogram'].length} 项</strong>
                </div>
                {tasksData[group.key as 'desktop' | 'miniprogram'].map((task) => {
                  const state = taskState(task)
                  return (
                    <div className="task-row" key={`${group.key}-${task.taskCode}`}>
                      <Badge tone={state.tone}>{state.label}</Badge>
                      <div>
                        <strong>{task.title || task.taskCode}</strong>
                        {task.description === undefined ? null : <div className="cell-sub">{task.description}</div>}
                      </div>
                      <span>{task.current}/{task.target || 1}</span>
                      {task.reward === undefined ? null : <span>{task.reward}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal open={creditResult !== undefined} title="签到结果" onClose={() => setCreditResult(undefined)} wide>
        {creditResult === undefined ? null : (
          <>
            <div className="definition-grid">
              <div><span>成功领取</span><strong>{creditResult.summary.claimed}</strong></div>
              <div><span>新增积分</span><strong>{creditResult.summary.totalCredit}</strong></div>
              <div><span>已领取</span><strong>{creditResult.summary.alreadyClaimed}</strong></div>
              <div><span>失败</span><strong>{creditResult.summary.failed}</strong></div>
            </div>
            <div className="table-wrap modal-table">
              <table className="responsive-table">
                <thead><tr><th>账号</th><th>结果</th></tr></thead>
                <tbody>
                  {creditResult.results.map((item) => (
                    <tr key={item.accountId}>
                      <td data-label="账号"><div className="cell-main">{item.nickname}</div><div className="cell-sub mono">{item.accountId}</div></td>
                      <td data-label="结果"><code className="inline-code">{JSON.stringify(item.outcome)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>

      <Modal open={balanceResult !== undefined} title="积分余额" onClose={() => setBalanceResult(undefined)} wide>
        {balanceResult === undefined ? null : (
          <div className="table-wrap modal-table">
            <table className="responsive-table">
              <thead><tr><th>账号</th><th>余额</th><th>说明</th></tr></thead>
              <tbody>
                {balanceResult.map((item) => (
                <tr key={item.accountId}>
                  <td data-label="账号"><div className="cell-main">{item.nickname}</div><div className="cell-sub mono">{item.accountId}</div></td>
                  <td data-label="余额"><code className="inline-code">{item.balance === null ? '-' : JSON.stringify(item.balance)}</code></td>
                  <td data-label="说明">{item.error ?? '正常'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}
