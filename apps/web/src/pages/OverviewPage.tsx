import {
  Activity,
  ArrowRight,
  KeyRound,
  RefreshCw,
  Server,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '../api.js'
import {
  Badge,
  EmptyState,
  InlineError,
  LoadingBlock,
  Metric,
  PageTitle,
  Panel,
  StatusBadge,
  formatDate,
  formatDuration,
  formatNumber,
  formatUptime,
} from '../components/ui.js'
import type {
  ApiKeyRecord,
  HealthStatus,
  ProviderSummary,
  UsageResponse,
} from '../types.js'

export function OverviewPage({
  onNavigate,
}: {
  onNavigate(page: string): void
}) {
  const [health, setHealth] = useState<HealthStatus>()
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [usage, setUsage] = useState<UsageResponse>()
  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [nextHealth, providerData, usageData, keyData] = await Promise.all([
        apiGet<HealthStatus>('/api/health'),
        apiGet<{ providers: ProviderSummary[] }>('/api/providers'),
        apiGet<UsageResponse>('/api/usage?limit=100'),
        apiGet<{ keys: ApiKeyRecord[] }>('/api/keys'),
      ])
      setHealth(nextHealth)
      setProviders(providerData.providers)
      setUsage(usageData)
      setKeys(keyData.keys)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const validAccounts = providers.reduce((sum, provider) => sum + provider.validCount, 0)
  const enabledKeys = keys.filter((key) => key.enabled).length

  return (
    <div className="page-stack">
      <PageTitle
        title="运行概览"
        description="网关、账号池与请求流量的当前状态。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            刷新
          </button>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}
      {loading && usage === undefined ? <LoadingBlock /> : (
        <>
          <div className="metric-grid">
            <Metric
              label="网关状态"
              value={health?.status === 'ok' ? '在线' : '未知'}
              detail={health === undefined ? '-' : `运行 ${formatUptime(health.uptimeMs)}`}
              tone={health?.status === 'ok' ? 'success' : 'warning'}
            />
            <Metric
              label="有效账号"
              value={formatNumber(validAccounts)}
              detail={`${providers.length} 个服务商`}
            />
            <Metric
              label="今日请求"
              value={formatNumber(usage?.summary.requests)}
              detail={`平均 ${formatDuration(usage?.summary.averageDurationMs)}`}
            />
            <Metric
              label="今日 Token"
              value={formatNumber(usage?.summary.totalTokens)}
              detail={`输入 ${formatNumber(usage?.summary.inputTokens)} / 输出 ${formatNumber(usage?.summary.outputTokens)}`}
            />
            <Metric
              label="错误请求"
              value={formatNumber(usage?.summary.errors)}
              detail="今日 HTTP 4xx / 5xx"
              tone={(usage?.summary.errors ?? 0) > 0 ? 'danger' : 'success'}
            />
            <Metric
              label="可用密钥"
              value={formatNumber(enabledKeys)}
              detail={`共 ${keys.length} 个 API Key`}
            />
          </div>

          <div className="two-column-grid">
            <Panel
              title="服务商"
              subtitle="账号池的实时分布"
              actions={(
                <button className="btn btn-ghost btn-small" type="button" onClick={() => onNavigate('accounts')}>
                  管理账号
                  <ArrowRight size={14} />
                </button>
              )}
            >
              {providers.length === 0 ? (
                <EmptyState title="暂无服务商" description="上游运行时尚未返回服务商列表。" />
              ) : (
                <div className="provider-grid">
                  {providers.map((provider) => (
                    <article key={provider.id} className="provider-card">
                      <div className="provider-card-header">
                        <div className="cell-main">{provider.name}</div>
                        <Badge tone={provider.validCount > 0 ? 'success' : 'warning'}>
                          {provider.validCount > 0
                            ? '可用'
                            : provider.accountCount > 0
                              ? '无有效账号'
                              : '待配置'}
                        </Badge>
                      </div>
                      <div className="cell-sub mono">{provider.id}</div>
                      <div className="provider-card-stats">
                        <div>
                          <span>账号</span>
                          <strong>{formatNumber(provider.accountCount)}</strong>
                        </div>
                        <div>
                          <span>有效</span>
                          <strong>{formatNumber(provider.validCount)}</strong>
                        </div>
                        <div>
                          <span>可续期</span>
                          <strong>{formatNumber(provider.refreshableCount)}</strong>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="快速操作" subtitle="常用管理入口">
              <div className="quick-actions">
                <button type="button" onClick={() => onNavigate('accounts')}>
                  <Users size={17} />
                  <span><strong>添加账号</strong><small>扫码、设备码或回调登录</small></span>
                  <ArrowRight size={15} />
                </button>
                <button type="button" onClick={() => onNavigate('models')}>
                  <Server size={17} />
                  <span><strong>模型可见性</strong><small>按服务商开关模型</small></span>
                  <ArrowRight size={15} />
                </button>
                <button type="button" onClick={() => onNavigate('keys')}>
                  <KeyRound size={17} />
                  <span><strong>创建 API Key</strong><small>设置模型白名单</small></span>
                  <ArrowRight size={15} />
                </button>
                <button type="button" onClick={() => onNavigate('usage')}>
                  <Activity size={17} />
                  <span><strong>查看用量</strong><small>Token、延迟与错误</small></span>
                  <ArrowRight size={15} />
                </button>
              </div>
            </Panel>
          </div>

          <Panel
            title="最近请求"
            subtitle="最新 10 条调用记录"
            actions={(
              <button className="btn btn-ghost btn-small" type="button" onClick={() => onNavigate('usage')}>
                全部记录
                <ArrowRight size={14} />
              </button>
            )}
          >
            {(usage?.records.length ?? 0) === 0 ? (
              <EmptyState title="暂无调用记录" description="通过 /v1/chat/completions 或 /v1/responses 发起请求后会显示在这里。" />
            ) : (
              <div className="table-wrap">
                <table className="responsive-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>模型</th>
                      <th>API Key</th>
                      <th className="number">Token</th>
                      <th className="number">耗时</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage?.records.slice(0, 10).map((record) => (
                      <tr key={record.id}>
                        <td className="nowrap" data-label="时间">{formatDate(record.timestamp)}</td>
                        <td data-label="模型">
                          <div className="cell-main mono">{record.model}</div>
                          <div className="cell-sub">{record.provider}</div>
                        </td>
                        <td data-label="API Key">{record.apiKeyName ?? '-'}</td>
                        <td className="number" data-label="Token">{formatNumber(record.totalTokens)}</td>
                        <td className="number" data-label="耗时">{formatDuration(record.durationMs)}</td>
                        <td data-label="状态">
                          {record.status < 400
                            ? <Badge tone="success">{record.status}</Badge>
                            : <Badge tone="danger">{record.status}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="运行信息">
            <div className="definition-grid">
              <div><span>网关版本</span><strong>{health?.version ?? '-'}</strong></div>
              <div>
                <span>Jet Hub RPC</span>
                <StatusBadge ok={health?.jetHubAvailable === true}>{health?.jetHubAvailable ? '可用' : '不可用'}</StatusBadge>
              </div>
              <div><span>服务商数量</span><strong>{providers.length}</strong></div>
              <div><span>请求超时</span><strong>{usage === undefined ? '-' : '由设置页配置'}</strong></div>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
