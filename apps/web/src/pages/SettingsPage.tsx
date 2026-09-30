import { KeyRound, RefreshCw, Save, Server, ShieldCheck, TimerReset } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { apiGet, apiPatch, apiPost, apiPut, errorText } from '../api.js'
import {
  Badge,
  InlineError,
  LoadingBlock,
  PageTitle,
  Panel,
  SelectMenu,
  StatusBadge,
  Toggle,
  formatDate,
  formatUptime,
  parseLines,
  useToast,
} from '../components/ui.js'
import type {
  GatewaySettings,
  LoomyLockStatus,
  ProviderSummary,
  SchedulerRunResult,
  SchedulerStatus,
  SystemInfo,
} from '../types.js'

interface ModelOption {
  id: string
  name: string
}

interface SettingsDraft {
  defaultProvider: string
  defaultModel: string
  allowedModels: string
  requestTimeoutMs: string
  logLevel: string
}

interface PasswordDraft {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

function toDraft(settings: GatewaySettings): SettingsDraft {
  return {
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
    allowedModels: settings.allowedModels.join('\n'),
    requestTimeoutMs: String(settings.requestTimeoutMs),
    logLevel: settings.logLevel,
  }
}

export function SettingsPage() {
  const { notify } = useToast()
  const [settings, setSettings] = useState<GatewaySettings>()
  const [draft, setDraft] = useState<SettingsDraft>()
  const [system, setSystem] = useState<SystemInfo>()
  const [scheduler, setScheduler] = useState<SchedulerStatus>()
  const [locked, setLocked] = useState(false)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [passwordDraft, setPasswordDraft] = useState<PasswordDraft>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [changingPassword, setChangingPassword] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(undefined)
    const [settingsResult, systemResult, schedulerResult, providersResult, lockResult] = await Promise.allSettled([
      apiGet<GatewaySettings>('/api/settings'),
      apiGet<SystemInfo>('/api/system'),
      apiGet<SchedulerStatus>('/api/scheduler'),
      apiGet<{ providers: ProviderSummary[] }>('/api/providers'),
      apiGet<LoomyLockStatus>('/api/loomy/lock'),
    ])
    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value)
      setDraft(toDraft(settingsResult.value))
    } else {
      setError(errorText(settingsResult.reason))
    }
    if (systemResult.status === 'fulfilled') setSystem(systemResult.value)
    if (schedulerResult.status === 'fulfilled') setScheduler(schedulerResult.value)
    if (providersResult.status === 'fulfilled') setProviders(providersResult.value.providers)
    if (lockResult.status === 'fulfilled') setLocked(lockResult.value.locked)
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (draft?.defaultProvider === undefined || draft.defaultProvider === '') {
      setModels([])
      return
    }
    let cancelled = false
    apiGet<{ groups: Array<{ provider: string; name: string; models: ModelOption[] }> }>(
      `/api/models?provider=${encodeURIComponent(draft.defaultProvider)}`,
    ).then((result) => {
      if (cancelled) return
      setModels(result.groups[0]?.models ?? [])
    }).catch(() => {
      if (cancelled) return
      setModels([])
    })
    return () => { cancelled = true }
  }, [draft?.defaultProvider])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (draft === undefined) return
    const timeout = Number(draft.requestTimeoutMs)
    if (!Number.isFinite(timeout) || timeout < 1_000) {
      setError('请求超时至少需要 1000 毫秒。')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const result = await apiPatch<GatewaySettings>('/api/settings', {
        defaultProvider: draft.defaultProvider.trim(),
        defaultModel: draft.defaultModel.trim(),
        allowedModels: parseLines(draft.allowedModels),
        requestTimeoutMs: Math.floor(timeout),
        logLevel: draft.logLevel,
      })
      setSettings(result)
      setDraft(toDraft(result))
      notify('设置已保存。', 'success')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const runScheduler = async () => {
    setRunning(true)
    try {
      const result = await apiPost<SchedulerRunResult>('/api/scheduler/run')
      notify(`巡检完成：刷新 ${result.refreshed} 个账号，失败 ${result.failed} 个。`, result.failed > 0 ? 'info' : 'success')
      setScheduler(await apiGet<SchedulerStatus>('/api/scheduler'))
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setRunning(false)
    }
  }

  const changePassword = async () => {
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      notify('两次输入的新密码不一致。', 'error')
      return
    }
    setChangingPassword(true)
    try {
      await apiPost('/api/auth/password', {
        currentPassword: passwordDraft.currentPassword,
        newPassword: passwordDraft.newPassword,
      })
      setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' })
      notify('管理员密码已修改。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setChangingPassword(false)
    }
  }

  const setLoomyLocked = async (next: boolean) => {
    try {
      const result = await apiPut<LoomyLockStatus>('/api/loomy/lock', { locked: next })
      setLocked(result.locked)
      notify(result.locked ? 'Loomy 永久积分已锁定。' : 'Loomy 永久积分已解锁。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  return (
    <div className="page-stack">
      <PageTitle
        title="系统设置"
        description="调整默认模型、请求策略和运行维护任务。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            重新读取
          </button>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}
      {loading && settings === undefined ? <LoadingBlock /> : (
        <div className="settings-grid">
          <Panel title="网关设置" subtitle="保存后立即影响新请求">
            {draft === undefined ? <LoadingBlock /> : (
              <form className="form-stack" onSubmit={(event) => void save(event)}>
                <div className="form-grid settings-select-grid">
                  <label className="field">
                    <span>默认服务商</span>
                    <SelectMenu
                      value={draft.defaultProvider}
                      ariaLabel="默认服务商"
                      options={[
                        { value: '', label: '自动选择', description: '由网关按可用账号自动路由' },
                        ...providers.map((provider) => ({
                          value: provider.id,
                          label: `${provider.displayName}（${provider.id}）`,
                          description: `${provider.enabledCount}/${provider.accountCount} 个账号启用`,
                        })),
                      ]}
                      onChange={(value) => setDraft({ ...draft, defaultProvider: value, defaultModel: '' })}
                    />
                  </label>
                  <label className="field">
                    <span>默认模型</span>
                    <SelectMenu
                      value={draft.defaultModel}
                      ariaLabel="默认模型"
                      placeholder={draft.defaultProvider === '' ? '先选择服务商' : '自动选择'}
                      options={models.map((model) => ({
                        value: model.id,
                        label: `${model.name}（${model.id}）`,
                      }))}
                      onChange={(value) => setDraft({ ...draft, defaultModel: value })}
                      disabled={draft.defaultProvider === '' || models.length === 0}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>全局允许模型</span>
                  <textarea
                    rows={6}
                    value={draft.allowedModels}
                    onChange={(event) => setDraft({ ...draft, allowedModels: event.target.value })}
                    placeholder={'留空表示不限制。每行一个，支持通配符：\ncodearts/*\nbuddy/claude-*'}
                  />
                  <small>该规则与 API Key 自身的模型白名单取交集。</small>
                </label>
                <div className="form-grid">
                  <label className="field">
                    <span>请求超时（毫秒）</span>
                    <input
                      type="number"
                      min={1_000}
                      step={1_000}
                      value={draft.requestTimeoutMs}
                      onChange={(event) => setDraft({ ...draft, requestTimeoutMs: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>日志级别</span>
                    <SelectMenu
                      value={draft.logLevel}
                      ariaLabel="日志级别"
                      options={[
                        { value: 'debug', label: 'debug', description: '输出完整调试信息' },
                        { value: 'info', label: 'info', description: '输出常规运行信息' },
                        { value: 'warn', label: 'warn', description: '仅输出警告与错误' },
                        { value: 'error', label: 'error', description: '仅输出错误' },
                      ]}
                      onChange={(value) => setDraft({ ...draft, logLevel: value })}
                    />
                  </label>
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary" type="submit" disabled={saving}>
                    <Save size={15} />
                    {saving ? '保存中...' : '保存设置'}
                  </button>
                  <button className="btn btn-secondary" type="button" disabled={settings === undefined} onClick={() => setDraft(settings === undefined ? undefined : toDraft(settings))}>
                    还原
                  </button>
                </div>
              </form>
            )}
          </Panel>

          <div className="settings-side">
            <Panel title="账号巡检" subtitle="手动刷新已启用账号的凭据">
              <div className="definition-grid">
                <div>
                  <span>当前状态</span>
                  <StatusBadge ok={scheduler?.running !== true}>
                    {scheduler?.running === true ? '正在执行' : '空闲'}
                  </StatusBadge>
                </div>
                <div>
                  <span>检查间隔</span>
                  <strong>{scheduler === undefined ? '-' : scheduler.intervalMs === 0 ? '已禁用' : `${Math.round(scheduler.intervalMs / 60_000)} 分钟`}</strong>
                </div>
                <div><span>上次完成</span><strong>{formatDate(scheduler?.lastRunAt)}</strong></div>
              </div>
              <div className="panel-inline-action">
                <button className="btn btn-secondary" type="button" onClick={() => void runScheduler()} disabled={running || scheduler?.running === true}>
                  <TimerReset size={15} className={running ? 'spin' : undefined} />
                  {running ? '巡检中...' : '立即巡检'}
                </button>
              </div>
            </Panel>

            <Panel title="Loomy 永久积分" subtitle="控制是否自动保持永久积分锁定">
              <div className="setting-row">
                <div className="setting-copy">
                  <KeyRound size={17} />
                  <div>
                    <strong>永久锁定</strong>
                    <p>{locked ? '已锁定，账号池会保持该策略。' : '未锁定，账号池可按上游状态处理。'}</p>
                  </div>
                </div>
                <Toggle checked={locked} onChange={(checked) => void setLoomyLocked(checked)} label={locked ? '已锁定' : '未锁定'} />
              </div>
            </Panel>

            <Panel title="管理员密码" subtitle="修改后当前会话自动续签">
              <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void changePassword() }}>
                <label className="field">
                  <span>当前密码</span>
                  <input
                    type="password"
                    value={passwordDraft.currentPassword}
                    onChange={(event) => setPasswordDraft({ ...passwordDraft, currentPassword: event.target.value })}
                    autoComplete="current-password"
                    required
                  />
                </label>
                <div className="form-grid">
                  <label className="field">
                    <span>新密码</span>
                    <input
                      type="password"
                      value={passwordDraft.newPassword}
                      onChange={(event) => setPasswordDraft({ ...passwordDraft, newPassword: event.target.value })}
                      minLength={8}
                      autoComplete="new-password"
                      required
                    />
                  </label>
                  <label className="field">
                    <span>确认新密码</span>
                    <input
                      type="password"
                      value={passwordDraft.confirmPassword}
                      onChange={(event) => setPasswordDraft({ ...passwordDraft, confirmPassword: event.target.value })}
                      minLength={8}
                      autoComplete="new-password"
                      required
                    />
                  </label>
                </div>
                <small>密码至少 8 位；修改会使旧会话令牌失效。</small>
                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={changingPassword || passwordDraft.currentPassword === '' || passwordDraft.newPassword.length < 8}
                  >
                    <Save size={15} />
                    {changingPassword ? '修改中...' : '修改密码'}
                  </button>
                </div>
              </form>
            </Panel>

            <Panel title="运行信息" subtitle="当前进程和部署参数">
              {system === undefined ? <LoadingBlock /> : (
                <div className="definition-grid">
                  <div><span>版本</span><strong>{system.version}</strong></div>
                  <div><span>监听地址</span><strong className="mono">{system.host}:{system.port}</strong></div>
                  <div><span>启动时间</span><strong>{formatDate(system.startedAt)}</strong></div>
                  <div><span>运行时长</span><strong>{formatUptime(Date.now() - system.startedAt)}</strong></div>
                  <div className="definition-wide"><span>数据目录</span><strong className="mono">{system.dataDir}</strong></div>
                  <div className="definition-wide"><span>公开地址</span><strong className="mono">{system.publicUrl}</strong></div>
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}

      <Panel title="当前约束摘要" subtitle="用于快速确认请求是否会被拒绝">
        <div className="summary-strip">
          <div><Server size={16} /><span>服务商</span><strong>{providers.length}</strong></div>
          <div><ShieldCheck size={16} /><span>全局模型规则</span><strong>{settings?.allowedModels.length === 0 ? '全部' : `${settings?.allowedModels.length ?? 0} 条`}</strong></div>
          <div><Badge tone="info">超时</Badge><strong>{settings === undefined ? '-' : `${Math.round(settings.requestTimeoutMs / 1_000)} 秒`}</strong></div>
        </div>
      </Panel>
    </div>
  )
}
