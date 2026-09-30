import { AlertTriangle, Clock3, Play, RefreshCw, Save, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, apiPatch, apiPost, errorText } from '../api.js'
import {
  Badge,
  InlineError,
  EmptyState,
  LoadingBlock,
  PageTitle,
  Panel,
  TimeSelect,
  Toggle,
  formatDate,
  useToast,
} from '../components/ui.js'
import type { AutomationStatus } from '../types.js'

const STATUS_LABELS: Record<AutomationStatus['runs'][number]['status'], string> = {
  success: '成功',
  skipped: '跳过',
  unverified: '未确认',
  error: '失败',
}

const STATUS_TONES: Record<AutomationStatus['runs'][number]['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  success: 'success',
  skipped: 'neutral',
  unverified: 'warning',
  error: 'danger',
}

const SIGNIN_COVERAGE = [
  { id: 'codearts', name: '华为 CodeArts' },
  { id: 'buddy', name: '腾讯 CodeBuddy' },
  { id: 'workbuddy', name: 'WorkBuddy (国际版)' },
  { id: 'lobsterai', name: '有道 LobsterAI' },
  { id: 'qoder', name: 'Qoder' },
  { id: 'qodercn', name: 'Qoder 中国版' },
  { id: 'trae', name: 'TRAE' },
  { id: 'loomy', name: '讯飞 Loomy' },
  { id: 'phanthy', name: 'PhanthyCode' },
] as const

const SIGNIN_SKIPS = [
  { name: 'Cline', reason: '没有每日签到接口' },
  { name: 'Raccoon Work', reason: '每日积分由服务端自动发放' },
] as const

function taskLabel(jobId: string, run: AutomationStatus['runs'][number]): string {
  if (run.accountId === undefined) return run.task
  return `${jobId} · ${run.task}`
}

function formatSchedule(schedule: readonly string[]): string {
  return schedule.length === 0 ? '未设置' : `每天 ${schedule.join('、')}`
}

export function AutomationPage() {
  const { notify } = useToast()
  const [status, setStatus] = useState<AutomationStatus>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [runningJob, setRunningJob] = useState<string>()
  const [reserveCredits, setReserveCredits] = useState('0')
  const [failureThreshold, setFailureThreshold] = useState('3')
  const [cooldownBaseSeconds, setCooldownBaseSeconds] = useState('120')
  const [cooldownMaxSeconds, setCooldownMaxSeconds] = useState('3600')
  const [maxInFlight, setMaxInFlight] = useState('3')
  const [softRateBaseSeconds, setSoftRateBaseSeconds] = useState('600')
  const [softRateMaxSeconds, setSoftRateMaxSeconds] = useState('7200')
  const [degradeThreshold, setDegradeThreshold] = useState('5')
  const [degradeCooldownSeconds, setDegradeCooldownSeconds] = useState('600')
  const [degradeCooldownMaxSeconds, setDegradeCooldownMaxSeconds] = useState('7200')
  const [signinSchedule, setSigninSchedule] = useState('09:10')
  const [providerSchedules, setProviderSchedules] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const value = await apiGet<AutomationStatus>('/api/automation')
      setStatus(value)
      setReserveCredits(String(value.config.reserveCredits))
      setFailureThreshold(String(value.config.governance?.failureThreshold ?? 3))
      setCooldownBaseSeconds(String(Math.round((value.config.governance?.cooldownBaseMs ?? 120_000) / 1000)))
      setCooldownMaxSeconds(String(Math.round((value.config.governance?.cooldownMaxMs ?? 3_600_000) / 1000)))
      setMaxInFlight(String(value.config.governance?.maxInFlight ?? 3))
      setSoftRateBaseSeconds(String(Math.round((value.config.governance?.softRateBaseMs ?? 600_000) / 1000)))
      setSoftRateMaxSeconds(String(Math.round((value.config.governance?.softRateMaxMs ?? 7_200_000) / 1000)))
      setDegradeThreshold(String(value.config.governance?.degradeThreshold ?? 5))
      setDegradeCooldownSeconds(String(Math.round((value.config.governance?.degradeCooldownMs ?? 600_000) / 1000)))
      setDegradeCooldownMaxSeconds(String(Math.round((value.config.governance?.degradeCooldownMaxMs ?? 7_200_000) / 1000)))
      setSigninSchedule(value.jobs.find((job) => job.id === 'all_daily_signin')?.schedule[0] ?? '09:10')
      setProviderSchedules(value.config.signinSchedules ?? {})
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const saveConfig = async (next: AutomationStatus['config']) => {
    setSaving(true)
    setError(undefined)
    try {
      const value = await apiPatch<AutomationStatus>('/api/automation/config', next)
      setStatus(value)
      setReserveCredits(String(value.config.reserveCredits))
      setFailureThreshold(String(value.config.governance?.failureThreshold ?? 3))
      setCooldownBaseSeconds(String(Math.round((value.config.governance?.cooldownBaseMs ?? 120_000) / 1000)))
      setCooldownMaxSeconds(String(Math.round((value.config.governance?.cooldownMaxMs ?? 3_600_000) / 1000)))
      setMaxInFlight(String(value.config.governance?.maxInFlight ?? 3))
      setSoftRateBaseSeconds(String(Math.round((value.config.governance?.softRateBaseMs ?? 600_000) / 1000)))
      setSoftRateMaxSeconds(String(Math.round((value.config.governance?.softRateMaxMs ?? 7_200_000) / 1000)))
      setDegradeThreshold(String(value.config.governance?.degradeThreshold ?? 5))
      setDegradeCooldownSeconds(String(Math.round((value.config.governance?.degradeCooldownMs ?? 600_000) / 1000)))
      setDegradeCooldownMaxSeconds(String(Math.round((value.config.governance?.degradeCooldownMaxMs ?? 7_200_000) / 1000)))
      setProviderSchedules(value.config.signinSchedules ?? {})
      notify('自动化配置已保存。', 'success')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const runJob = async (jobId: string) => {
    setRunningJob(jobId)
    setError(undefined)
    try {
      await apiPost('/api/automation/run', { jobId })
      notify('任务已执行。', 'success')
      await load()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setRunningJob(undefined)
    }
  }

  const saveSigninSchedule = async () => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(signinSchedule)) {
      setError('执行时间必须是 HH:mm 格式。')
      return
    }
    setSavingSchedule(true)
    setError(undefined)
    try {
      const value = await apiPatch<AutomationStatus>('/api/automation/jobs/all_daily_signin/schedule', {
        schedule: [signinSchedule],
      })
      setStatus(value)
      setSigninSchedule(value.jobs.find((job) => job.id === 'all_daily_signin')?.schedule[0] ?? signinSchedule)
      notify('每日签到时间已保存。', 'success')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSavingSchedule(false)
    }
  }

  const toggleJob = (jobId: string, enabled: boolean) => {
    if (status === undefined) return
    void saveConfig({
      ...status.config,
      enabledJobs: { ...status.config.enabledJobs, [jobId]: enabled },
    })
  }

  const saveGovernance = async () => {
    if (status === undefined) return
    const reserve = Number(reserveCredits)
    const threshold = Number(failureThreshold)
    const baseSeconds = Number(cooldownBaseSeconds)
    const maxSeconds = Number(cooldownMaxSeconds)
    const inFlight = Number(maxInFlight)
    const softBase = Number(softRateBaseSeconds)
    const softMax = Number(softRateMaxSeconds)
    const degradeLimit = Number(degradeThreshold)
    const degradeBase = Number(degradeCooldownSeconds)
    const degradeMax = Number(degradeCooldownMaxSeconds)
    if (!Number.isInteger(reserve) || reserve < 0) {
      setError('全局保留积分必须是大于等于 0 的整数。')
      return
    }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 20) {
      setError('连续失败阈值必须是 1 到 20 的整数。')
      return
    }
    if (!Number.isInteger(baseSeconds) || baseSeconds < 10 || baseSeconds > 1800) {
      setError('冷却基数必须是 10 到 1800 秒的整数。')
      return
    }
    if (!Number.isInteger(maxSeconds) || maxSeconds < 60 || maxSeconds > 86400) {
      setError('冷却上限必须是 60 到 86400 秒的整数。')
      return
    }
    if (!Number.isInteger(inFlight) || inFlight < 0 || inFlight > 50) {
      setError('单账号在途上限必须是 0 到 50 的整数，0 表示不限制。')
      return
    }
    if (!Number.isInteger(softBase) || softBase < 10 || softBase > 1800) {
      setError('限流冷却基数必须是 10 到 1800 秒的整数。')
      return
    }
    if (!Number.isInteger(softMax) || softMax < 60 || softMax > 86400) {
      setError('限流冷却上限必须是 60 到 86400 秒的整数。')
      return
    }
    if (!Number.isInteger(degradeLimit) || degradeLimit < 1 || degradeLimit > 20) {
      setError('降权阈值必须是 1 到 20 的整数。')
      return
    }
    if (!Number.isInteger(degradeBase) || degradeBase < 10 || degradeBase > 43200) {
      setError('降权时长必须是 10 到 43200 秒的整数。')
      return
    }
    if (!Number.isInteger(degradeMax) || degradeMax < 60 || degradeMax > 86400) {
      setError('降权上限必须是 60 到 86400 秒的整数。')
      return
    }
    await saveConfig({
      ...status.config,
      reserveCredits: reserve,
      governance: {
        failureThreshold: threshold,
        cooldownBaseMs: baseSeconds * 1000,
        cooldownMaxMs: maxSeconds * 1000,
        maxInFlight: inFlight,
        softRateBaseMs: softBase * 1000,
        softRateMaxMs: softMax * 1000,
        degradeThreshold: degradeLimit,
        degradeCooldownMs: degradeBase * 1000,
        degradeCooldownMaxMs: degradeMax * 1000,
      },
    })
  }

  const saveProviderSchedule = async (providerId: string) => {
    if (status === undefined) return
    const schedule = providerSchedules[providerId]
    if (schedule !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule)) {
      setError('服务商签到时间必须是 HH:mm 格式。')
      return
    }
    const signinSchedules = { ...status.config.signinSchedules }
    if (schedule === undefined) delete signinSchedules[providerId]
    else signinSchedules[providerId] = schedule
    await saveConfig({
      ...status.config,
      signinSchedules,
    })
  }

  const activeJobCount = status?.jobs.filter((job) => job.enabled && status.config.enabled).length ?? 0
  const signinJob = status?.jobs.find((job) => job.id === 'all_daily_signin')
  const signinTime = signinJob?.schedule[0] ?? '09:10'

  return (
    <div className="page-stack">
      <PageTitle
        title="积分自动化"
        description="统一管理各服务商每日签到、成长任务、权益领取与账号保活。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            刷新
          </button>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      {loading && status === undefined ? <LoadingBlock label="正在加载自动化状态" /> : (
        <>
          {status?.config.enabled === false ? (
            <div className="callout callout-warning">
              <AlertTriangle size={17} />
              <div>
                <strong>自动化总开关已关闭</strong>
                <p>下面的任务开关虽然保持启用，但不会按运行时间表自动执行。打开“启用自动化”后，定时调度器才会运行这些任务。</p>
              </div>
            </div>
          ) : null}

          <div className="metric-grid metric-grid-compact">
            <div className="metric">
              <span className="metric-label">总开关</span>
              <strong className="metric-value">{status?.config.enabled === true ? '启用' : '停用'}</strong>
              <span className="metric-detail">{status?.config.enabled === true ? '定时任务按计划执行' : '任务不会自动执行'}</span>
            </div>
            <div className="metric">
              <span className="metric-label">有效任务</span>
              <strong className="metric-value">{activeJobCount} / {status?.jobs.length ?? 0}</strong>
              <span className="metric-detail">总开关与任务开关同时启用</span>
            </div>
            <div className="metric">
              <span className="metric-label">保留积分</span>
              <strong className="metric-value">{status?.config.reserveCredits ?? 0}</strong>
              <span className="metric-detail">填 0 表示关闭保护</span>
            </div>
            <div className="metric">
              <span className="metric-label">最近轮询</span>
              <strong className="metric-value metric-date">{status?.lastPollAt === undefined ? '-' : formatDate(status.lastPollAt)}</strong>
              <span className="metric-detail">调度器每分钟检查一次</span>
            </div>
            <div className="metric">
              <span className="metric-label">时区</span>
              <strong className="metric-value metric-date">Asia/Shanghai</strong>
              <span className="metric-detail">与北京时间一致</span>
            </div>
          </div>

          <Panel title="运行时间表" subtitle="所有任务按北京时间（Asia/Shanghai）执行">
            {status === undefined ? null : (
              <div className="schedule-list">
                {status.jobs.map((job) => {
                  const effective = status.config.enabled && job.enabled
                  const stateLabel = status.config.enabled === false
                    ? '总开关关闭'
                    : job.enabled
                      ? '已启用'
                      : '任务已停用'
                  const stateTone = status.config.enabled === false ? 'warning' : job.enabled ? 'success' : 'neutral'
                  return (
                    <article className={`schedule-item ${effective ? 'is-active' : ''}`} key={job.id}>
                      <div className="schedule-time">
                        <Clock3 size={15} />
                        <strong>{formatSchedule(job.schedule)}</strong>
                      </div>
                      <div className="schedule-content">
                        <div className="schedule-heading">
                          <div className="cell-main">{job.name}</div>
                          <Badge tone={stateTone}>{stateLabel}</Badge>
                        </div>
                        <p>{job.description}</p>
                        <div className="schedule-meta">
                          <span className="mono">{job.id}</span>
                          <span>上次运行：{formatDate(job.lastRunAt)}</span>
                          {job.lastStatus === undefined ? null : <span>上次结果：{STATUS_LABELS[job.lastStatus]}</span>}
                        </div>
                        {job.lastMessage === undefined ? null : <div className="schedule-message">最近消息：{job.lastMessage}</div>}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </Panel>

          <Panel
            title="每日签到覆盖范围"
            subtitle={`“全服务商每日签到”${signinJob === undefined ? '按计划时间' : formatSchedule(signinJob.schedule)}自动执行`}
          >
            <div className="coverage-grid">
              {SIGNIN_COVERAGE.map((provider) => (
                <div className="coverage-provider" key={provider.id}>
                  <div>
                    <strong>{provider.name}</strong>
                    <span className="mono">{provider.id} · 每日 {providerSchedules[provider.id] ?? signinTime}</span>
                  </div>
                  <div className="provider-schedule-editor">
                    <TimeSelect
                      className="time-select"
                      value={providerSchedules[provider.id] ?? signinTime}
                      onChange={(value) => setProviderSchedules((current) => ({ ...current, [provider.id]: value }))}
                      ariaLabel={`${provider.name}签到时间`}
                    />
                    <button
                      className="btn btn-secondary btn-small"
                      type="button"
                      disabled={saving || (providerSchedules[provider.id] ?? signinTime) === (status?.config.signinSchedules?.[provider.id] ?? signinTime)}
                      onClick={() => void saveProviderSchedule(provider.id)}
                    >
                      保存
                    </button>
                  </div>
                </div>
              ))}
              {SIGNIN_SKIPS.map((provider) => (
                <div className="coverage-provider" key={provider.name}>
                  <div>
                    <strong>{provider.name}</strong>
                    <span>{provider.reason}</span>
                  </div>
                  <Badge tone="neutral">自动跳过</Badge>
                </div>
              ))}
            </div>
            <div className="automation-task-message">
              按服务商顺序串行执行，避免触发风控；重复签到会识别为“今日已签到”，不会重复领取。
              {signinJob?.lastRunAt === undefined ? null : ` 最近一次执行：${formatDate(signinJob.lastRunAt)}，${signinJob.lastMessage ?? '已完成'}。`}
            </div>
          </Panel>

          <div className="two-column-grid">
            <Panel title="调度设置" subtitle="总开关关闭时不会执行任何定时任务">
              {status === undefined ? null : (
                <div className="form-stack">
                  <label className="field-row">
                    <span>启用自动化</span>
                    <Toggle
                      checked={status.config.enabled}
                      onChange={(enabled) => void saveConfig({ ...status.config, enabled })}
                    />
                  </label>
                  <label className="field">
                    <span>全局保留积分</span>
                    <input
                      type="number"
                      min="0"
                      value={reserveCredits}
                      onChange={(event) => setReserveCredits(event.target.value)}
                    />
                    <small>余额不高于该值时暂停接单；填 0 关闭。</small>
                  </label>
                  <div className="field-grid">
                    <label className="field">
                      <span>连续失败阈值</span>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={failureThreshold}
                        onChange={(event) => setFailureThreshold(event.target.value)}
                      />
                      <small>达到次数后自动冷却。</small>
                    </label>
                    <label className="field">
                      <span>冷却基数（秒）</span>
                      <input
                        type="number"
                        min="10"
                        max="1800"
                        step="10"
                        value={cooldownBaseSeconds}
                        onChange={(event) => setCooldownBaseSeconds(event.target.value)}
                      />
                      <small>超过阈值后按倍数递增。</small>
                    </label>
                    <label className="field">
                      <span>冷却上限（秒）</span>
                      <input
                        type="number"
                        min="60"
                        max="86400"
                        step="60"
                        value={cooldownMaxSeconds}
                        onChange={(event) => setCooldownMaxSeconds(event.target.value)}
                      />
                      <small>最长冷却 24 小时。</small>
                    </label>
                    <label className="field">
                      <span>单账号在途上限</span>
                      <input
                        type="number"
                        min="0"
                        max="50"
                        value={maxInFlight}
                        onChange={(event) => setMaxInFlight(event.target.value)}
                      />
                      <small>0 表示不限制并发。</small>
                    </label>
                  </div>
                  <div className="field-grid">
                    <label className="field">
                      <span>限流冷却基数（秒）</span>
                      <input
                        type="number"
                        min="10"
                        max="1800"
                        step="10"
                        value={softRateBaseSeconds}
                        onChange={(event) => setSoftRateBaseSeconds(event.target.value)}
                      />
                      <small>429 或限流后的短冷却起点。</small>
                    </label>
                    <label className="field">
                      <span>限流冷却上限（秒）</span>
                      <input
                        type="number"
                        min="60"
                        max="86400"
                        step="60"
                        value={softRateMaxSeconds}
                        onChange={(event) => setSoftRateMaxSeconds(event.target.value)}
                      />
                      <small>连续限流时按倍数递增。</small>
                    </label>
                    <label className="field">
                      <span>降权阈值</span>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={degradeThreshold}
                        onChange={(event) => setDegradeThreshold(event.target.value)}
                      />
                      <small>连续未知错误达到次数后降权。</small>
                    </label>
                  </div>
                  <div className="field-grid">
                    <label className="field">
                      <span>降权时长（秒）</span>
                      <input
                        type="number"
                        min="10"
                        max="43200"
                        step="60"
                        value={degradeCooldownSeconds}
                        onChange={(event) => setDegradeCooldownSeconds(event.target.value)}
                      />
                      <small>降权后临时退出自动选号。</small>
                    </label>
                    <label className="field">
                      <span>降权上限（秒）</span>
                      <input
                        type="number"
                        min="60"
                        max="86400"
                        step="60"
                        value={degradeCooldownMaxSeconds}
                        onChange={(event) => setDegradeCooldownMaxSeconds(event.target.value)}
                      />
                      <small>连续降权时按倍数递增。</small>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void saveGovernance()}
                      disabled={saving}
                    >
                      <Save size={15} />
                      保存设置
                    </button>
                  </div>
                </div>
              )}
            </Panel>

            <Panel title="任务开关" subtitle="可单独关闭任务；修改后立即保存">
              <div className="task-list">
                {status?.jobs.map((job) => {
                  const effective = status.config.enabled && job.enabled
                  const stateLabel = status.config.enabled === false
                    ? '总开关关闭'
                    : job.enabled
                      ? '已启用'
                      : '任务已停用'
                  const stateTone = status.config.enabled === false ? 'warning' : job.enabled ? 'success' : 'neutral'
                  return (
                    <div className="automation-task" key={job.id}>
                      <div className="automation-task-header">
                        <div className="cell-main">
                          <strong>{job.name}</strong>
                          <div className="cell-sub">{job.description}</div>
                        </div>
                        <Badge tone={stateTone}>{stateLabel}</Badge>
                      </div>
                      <div className="automation-task-schedule">
                        <span><Clock3 size={13} /> {formatSchedule(job.schedule)}</span>
                        <span>上次运行：{formatDate(job.lastRunAt)}</span>
                        {job.lastStatus === undefined ? null : <Badge tone={STATUS_TONES[job.lastStatus]}>{STATUS_LABELS[job.lastStatus]}</Badge>}
                      </div>
                      {job.id === 'all_daily_signin' ? (
                        <div className="automation-schedule-editor">
                          <div className="time-inline-select">
                            <Timer size={14} aria-hidden="true" />
                            <TimeSelect
                              className="time-select"
                              value={signinSchedule}
                              onChange={setSigninSchedule}
                              ariaLabel="每日执行时间"
                            />
                          </div>
                          <button
                            className="btn btn-secondary btn-small"
                            type="button"
                            disabled={savingSchedule || signinSchedule === (job.schedule[0] ?? '09:10')}
                            onClick={() => void saveSigninSchedule()}
                          >
                            <Save size={14} />
                            {savingSchedule ? '保存中' : '保存时间'}
                          </button>
                          <small>按北京时间执行，可调整到服务商实际开放签到之后。</small>
                        </div>
                      ) : null}
                      {job.lastMessage === undefined ? null : <div className="automation-task-message">{job.lastMessage}</div>}
                      <div className="automation-task-actions">
                        <button
                          className="btn btn-secondary btn-small"
                          type="button"
                          disabled={runningJob === job.id || !effective}
                          title={effective ? '立即执行一次' : '请先打开自动化总开关并启用该任务'}
                          onClick={() => void runJob(job.id)}
                        >
                          <Play size={14} />
                          {runningJob === job.id ? '执行中' : '立即执行'}
                        </button>
                        <Toggle checked={job.enabled} onChange={(enabled) => toggleJob(job.id, enabled)} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Panel>
          </div>

          <Panel title="运行记录" subtitle="最多保留最近 500 条执行明细">
            {status?.runs.length === 0 ? (
              <EmptyState
                title="暂无运行记录"
                description="启用总开关后等待定时执行，或打开总开关后手动触发一次任务。"
              />
            ) : (
              <div className="usage-list">
                {status?.runs.slice(0, 50).map((run) => (
                  <article key={run.id} className="usage-item">
                    <div className="usage-item-main">
                      <div className="usage-item-heading">
                        <div className="cell-main">{taskLabel(run.jobId, run)}</div>
                        <Badge tone={STATUS_TONES[run.status]}>{STATUS_LABELS[run.status]}</Badge>
                      </div>
                      <div className="usage-item-meta">
                        <span>{formatDate(run.completedAt)}</span>
                        <span className="run-message">{run.message ?? '-'}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
