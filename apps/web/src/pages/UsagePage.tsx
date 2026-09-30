import { Download, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, errorText } from '../api.js'
import {
  Badge,
  EmptyState,
  InlineError,
  LoadingBlock,
  Metric,
  PageTitle,
  Panel,
  SearchInput,
  formatDate,
  formatDuration,
  formatNumber,
  useConfirm,
  useToast,
} from '../components/ui.js'
import type { UsageRecord, UsageResponse } from '../types.js'

function usageCsv(records: UsageRecord[]): string {
  const header = ['时间', '服务商', '模型', 'API Key', '状态', '流式', '输入 Token', '输出 Token', '总 Token', '耗时 ms', '错误码']
  const rows = records.map((record) => [
    new Date(record.timestamp).toISOString(),
    record.provider,
    record.model,
    record.apiKeyName ?? '',
    record.status,
    record.stream ? '是' : '否',
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
    record.durationMs,
    record.errorCode ?? '',
  ])
  return [header, ...rows]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n')
}

export function UsagePage() {
  const { notify } = useToast()
  const { confirm } = useConfirm()
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [summary, setSummary] = useState<UsageResponse['summary']>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState<'all' | 'success' | 'error'>('all')

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await apiGet<UsageResponse>('/api/usage?limit=1000')
      setRecords(result.records)
      setSummary(result.summary)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const providers = useMemo(
    () => [...new Set(records.map((record) => record.provider))].sort(),
    [records],
  )

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return records.filter((record) => {
      if (provider !== '' && record.provider !== provider) return false
      if (status === 'success' && record.status >= 400) return false
      if (status === 'error' && record.status < 400) return false
      if (needle === '') return true
      return record.model.toLowerCase().includes(needle)
        || record.provider.toLowerCase().includes(needle)
        || record.apiKeyName?.toLowerCase().includes(needle)
        || record.errorCode?.toLowerCase().includes(needle)
    })
  }, [provider, records, search, status])

  const clear = async () => {
    const accepted = await confirm({
      title: '清空用量记录',
      description: '将删除全部 Token、延迟和请求状态记录，此操作无法撤销。',
      confirmText: '清空',
      danger: true,
    })
    if (!accepted) return
    try {
      await apiDelete('/api/usage')
      setRecords([])
      setSummary({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        errors: 0,
        averageDurationMs: 0,
      })
      notify('用量记录已清空。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const exportCsv = () => {
    const blob = new Blob([`\uFEFF${usageCsv(filtered)}\n`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `sub2api-usage-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page-stack">
      <PageTitle
        title="用量统计"
        description="查看请求量、Token 消耗、延迟和错误分布。"
        actions={(
          <>
            <button className="btn btn-secondary" type="button" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download size={15} />
              导出 CSV
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : undefined} />
              刷新
            </button>
            <button className="btn btn-danger-soft" type="button" onClick={() => void clear()} disabled={records.length === 0}>
              <Trash2 size={15} />
              清空记录
            </button>
          </>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <div className="metric-grid">
        <Metric label="今日请求" value={formatNumber(summary?.requests)} detail="本地记录" />
        <Metric label="今日 Token" value={formatNumber(summary?.totalTokens)} detail={`输入 ${formatNumber(summary?.inputTokens)} / 输出 ${formatNumber(summary?.outputTokens)}`} />
        <Metric label="平均耗时" value={formatDuration(summary?.averageDurationMs)} detail="今日成功和失败请求" />
        <Metric
          label="错误请求"
          value={formatNumber(summary?.errors)}
          detail="HTTP 4xx / 5xx"
          tone={(summary?.errors ?? 0) > 0 ? 'danger' : 'success'}
        />
      </div>

      <Panel>
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索模型、服务商、密钥或错误码" />
          <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">全部服务商</option>
            {providers.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="select" value={status} onChange={(event) => setStatus(event.target.value as 'all' | 'success' | 'error')}>
            <option value="all">全部状态</option>
            <option value="success">仅成功</option>
            <option value="error">仅错误</option>
          </select>
          <span className="toolbar-spacer" />
          <span className="toolbar-count">{filtered.length} / {records.length} 条记录</span>
        </div>

        {loading && records.length === 0 ? <LoadingBlock /> : filtered.length === 0 ? (
          <EmptyState
            title={records.length === 0 ? '暂无调用记录' : '没有匹配的记录'}
            description={records.length === 0 ? '调用 /v1/chat/completions 或 /v1/responses 后会在这里显示。' : '调整筛选条件或搜索关键词。'}
          />
        ) : (
          <div className="usage-list">
            {filtered.map((record) => (
              <article key={record.id} className="usage-item">
                <div className="usage-item-main">
                  <div className="usage-item-heading">
                    <div className="cell-main mono">{record.model}</div>
                    {record.status < 400 ? <Badge tone="success">{record.status}</Badge> : <Badge tone="danger">{record.status}</Badge>}
                  </div>
                  <div className="usage-item-meta">
                    <span>{formatDate(record.timestamp)}</span>
                    <span>{record.provider}</span>
                    <span>{record.apiKeyName ?? '-'}</span>
                    <span>{record.stream ? '流式请求' : '普通请求'}</span>
                    {record.errorCode === undefined ? null : <span className="mono">{record.errorCode}</span>}
                  </div>
                </div>
                <div className="usage-item-stats">
                  <div><span>输入</span><strong>{formatNumber(record.inputTokens)}</strong></div>
                  <div><span>输出</span><strong>{formatNumber(record.outputTokens)}</strong></div>
                  <div><span>总计</span><strong>{formatNumber(record.totalTokens)}</strong></div>
                  <div><span>耗时</span><strong>{formatDuration(record.durationMs)}</strong></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
