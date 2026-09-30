import { CheckCheck, ChevronDown, Power, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, errorText } from '../api.js'
import {
  Badge,
  EmptyState,
  InlineError,
  LoadingBlock,
  PageTitle,
  Panel,
  SearchInput,
  Toggle,
  useToast,
} from '../components/ui.js'
import type { ModelGroup } from '../types.js'

export function ModelsPage() {
  const { notify } = useToast()
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string>()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await apiGet<{ groups: ModelGroup[] }>('/api/models')
      setGroups(result.groups)
      setCollapsed(Object.fromEntries(result.groups.map((group) => [group.provider, true])))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return groups
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) => (
          model.id.toLowerCase().includes(needle)
          || model.name.toLowerCase().includes(needle)
          || group.name.toLowerCase().includes(needle)
        )),
      }))
      .filter((group) => group.models.length > 0)
  }, [groups, search])

  const toggleCollapsed = (provider: string) => {
    setCollapsed((current) => ({ ...current, [provider]: !current[provider] }))
  }

  const setModelDisabled = async (provider: string, modelId: string, disabled: boolean) => {
    const key = `${provider}:${modelId}`
    setBusy(key)
    try {
      await apiPost('/api/models/disabled', { provider, modelId, disabled })
      setGroups((current) => current.map((group) => group.provider === provider ? {
        ...group,
        models: group.models.map((model) => model.id === modelId ? { ...model, disabled } : model),
      } : group))
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  const setAllDisabled = async (provider: string, disabled: boolean) => {
    setBusy(`${provider}:all`)
    try {
      await apiPost('/api/models/disabled-all', { provider, disabled })
      setGroups((current) => current.map((group) => group.provider === provider ? {
        ...group,
        models: group.models.map((model) => ({ ...model, disabled })),
      } : group))
      notify(disabled ? '已关闭该服务商全部模型。' : '已开启该服务商全部模型。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)
  const enabledModels = groups.reduce((sum, group) => sum + group.models.filter((model) => !model.disabled).length, 0)

  return (
    <div className="page-stack">
      <PageTitle
        title="模型可见性"
        description="控制 OpenAI 兼容接口与上游选号中可见的模型集合。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            刷新目录
          </button>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <div className="metric-grid metric-grid-compact">
        <div className="metric"><span className="metric-label">服务商</span><strong className="metric-value">{groups.length}</strong></div>
        <div className="metric"><span className="metric-label">模型总数</span><strong className="metric-value">{totalModels}</strong></div>
        <div className="metric metric-success"><span className="metric-label">当前可见</span><strong className="metric-value">{enabledModels}</strong></div>
        <div className="metric metric-warning"><span className="metric-label">已关闭</span><strong className="metric-value">{totalModels - enabledModels}</strong></div>
      </div>

      <div className="toolbar toolbar-panel">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value)
            if (value.trim() !== '') setCollapsed({})
          }}
          placeholder="搜索模型名称或 ID"
        />
        <span className="toolbar-spacer" />
        <button
          className="btn btn-secondary btn-small"
          type="button"
          onClick={() => setCollapsed(Object.fromEntries(visibleGroups.map((group) => [group.provider, true])))}
        >
          全部收起
        </button>
        <button
          className="btn btn-secondary btn-small"
          type="button"
          onClick={() => setCollapsed({})}
        >
          全部展开
        </button>
        <Badge tone="info"><SlidersHorizontal size={13} /> 关闭后不会出现在 /v1/models</Badge>
      </div>

      {loading && groups.length === 0 ? <LoadingBlock label="正在读取上游模型目录" /> : visibleGroups.length === 0 ? (
        <Panel><EmptyState title="没有匹配的模型" description="调整搜索条件，或检查上游账号是否已登录。" /></Panel>
      ) : (
        <div className="model-groups">
          {visibleGroups.map((group) => {
            const disabledCount = group.models.filter((model) => model.disabled).length
            const isCollapsed = collapsed[group.provider] === true
            return (
              <section key={group.provider} className="collapsible-panel">
                <div className="collapsible-header">
                  <button
                    className="collapsible-toggle"
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapsed(group.provider)}
                  >
                    <ChevronDown size={16} className={isCollapsed ? 'collapsed' : undefined} />
                    <span className="cell-main">{group.name}</span>
                    <span className="cell-sub">{group.models.length - disabledCount} 可见 / {group.models.length} 个模型</span>
                  </button>
                  <div className="panel-actions">
                    <button className="btn btn-secondary btn-small" type="button" disabled={busy === `${group.provider}:all`} onClick={() => void setAllDisabled(group.provider, false)}>
                      <CheckCheck size={14} />
                      全部开启
                    </button>
                    <button className="btn btn-danger-soft btn-small" type="button" disabled={busy === `${group.provider}:all`} onClick={() => void setAllDisabled(group.provider, true)}>
                      <Power size={14} />
                      全部关闭
                    </button>
                  </div>
                </div>
                {isCollapsed ? null : (
                  <div className="collapsible-body">
                    <div className="model-list">
                      {group.models.map((model) => (
                        <div className="model-row" key={model.id}>
                          <div className="model-identity">
                            <strong>{model.name}</strong>
                            <span className="mono">{model.id}</span>
                          </div>
                          <div className="model-state">
                            {model.disabled ? <Badge tone="warning">已关闭</Badge> : <Badge tone="success">可见</Badge>}
                            <Toggle
                              checked={!model.disabled}
                              disabled={busy === `${group.provider}:${model.id}`}
                              onChange={(checked) => void setModelDisabled(group.provider, model.id, !checked)}
                              label=""
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
