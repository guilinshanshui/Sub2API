import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, errorText } from '../api.js'
import {
  Badge,
  EmptyState,
  InlineError,
  LevelBadge,
  LoadingBlock,
  PageTitle,
  Panel,
  SearchInput,
  formatDate,
  formatDuration,
  useConfirm,
  useToast,
} from '../components/ui.js'
import type { LogRecord } from '../types.js'

const LEVELS: Array<{ value: '' | LogRecord['level']; label: string }> = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'DEBUG' },
  { value: 'info', label: 'INFO' },
  { value: 'warn', label: 'WARN' },
  { value: 'error', label: 'ERROR' },
]

export function LogsPage() {
  const { notify } = useToast()
  const { confirm } = useConfirm()
  const [logs, setLogs] = useState<LogRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<'' | LogRecord['level']>('')

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await apiGet<{ logs: LogRecord[] }>('/api/logs?limit=1000')
      setLogs(result.logs)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return logs.filter((record) => {
      if (level !== '' && record.level !== level) return false
      if (needle === '') return true
      return record.event.toLowerCase().includes(needle)
        || record.message.toLowerCase().includes(needle)
        || record.requestId?.toLowerCase().includes(needle)
        || record.provider?.toLowerCase().includes(needle)
        || record.model?.toLowerCase().includes(needle)
    })
  }, [level, logs, search])

  const clear = async () => {
    const accepted = await confirm({
      title: '清空运行日志',
      description: '将删除当前保存的全部日志记录，此操作无法撤销。',
      confirmText: '清空',
      danger: true,
    })
    if (!accepted) return
    try {
      await apiDelete('/api/logs')
      setLogs([])
      notify('运行日志已清空。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const errorCount = logs.filter((record) => record.level === 'error').length
  const warnCount = logs.filter((record) => record.level === 'warn').length

  return (
    <div className="page-stack">
      <PageTitle
        title="运行日志"
        description="查看网关请求、认证和上游调用事件。"
        actions={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : undefined} />
              刷新
            </button>
            <button className="btn btn-danger-soft" type="button" onClick={() => void clear()} disabled={logs.length === 0}>
              <Trash2 size={15} />
              清空日志
            </button>
          </>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <div className="metric-grid metric-grid-compact">
        <div className="metric"><span className="metric-label">日志总数</span><strong className="metric-value">{logs.length}</strong></div>
        <div className="metric metric-warning"><span className="metric-label">WARN</span><strong className="metric-value">{warnCount}</strong></div>
        <div className="metric metric-danger"><span className="metric-label">ERROR</span><strong className="metric-value">{errorCount}</strong></div>
        <div className="metric"><span className="metric-label">当前筛选</span><strong className="metric-value">{filtered.length}</strong></div>
      </div>

      <Panel>
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索事件、消息、请求 ID、模型或服务商" />
          <select className="select" value={level} onChange={(event) => setLevel(event.target.value as '' | LogRecord['level'])}>
            {LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <span className="toolbar-spacer" />
          <span className="toolbar-count">{filtered.length} / {logs.length} 条日志</span>
        </div>

        {loading && logs.length === 0 ? <LoadingBlock /> : filtered.length === 0 ? (
          <EmptyState
            title={logs.length === 0 ? '暂无运行日志' : '没有匹配的日志'}
            description={logs.length === 0 ? '服务启动、请求完成和异常事件会记录在这里。' : '调整级别或搜索条件。'}
          />
        ) : (
          <div className="log-list">
            {filtered.map((record) => (
              <article className="log-entry" key={record.id}>
                <div className="log-entry-main">
                  <div className="log-entry-time">
                    <LevelBadge level={record.level} />
                    <span className="nowrap">{formatDate(record.timestamp)}</span>
                  </div>
                  <div className="log-entry-message">
                    <div className="log-entry-heading">
                      <strong>{record.event}</strong>
                      {record.status === undefined ? null : <Badge tone={record.status >= 400 ? 'danger' : 'success'}>{record.status}</Badge>}
                      {record.durationMs === undefined ? null : <span className="cell-sub">{formatDuration(record.durationMs)}</span>}
                    </div>
                    <p>{record.message}</p>
                    <div className="log-entry-meta">
                      {record.requestId === undefined ? null : <span className="mono">请求 {record.requestId}</span>}
                      {record.provider === undefined ? null : <span>{record.provider}</span>}
                      {record.model === undefined ? null : <span className="mono">{record.model}</span>}
                    </div>
                  </div>
                </div>
                {record.metadata === undefined ? null : (
                  <details className="log-details">
                    <summary>元数据</summary>
                    <pre>{JSON.stringify(record.metadata, null, 2)}</pre>
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
