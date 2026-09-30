import { KeyRound, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost, errorText } from '../api.js'
import {
  Badge,
  CopyButton,
  EmptyState,
  InlineError,
  LoadingBlock,
  Modal,
  PageTitle,
  Panel,
  SearchInput,
  Toggle,
  formatDate,
  parseLines,
  useConfirm,
  useToast,
} from '../components/ui.js'
import type { ApiKeyRecord, CreatedApiKey } from '../types.js'

export function KeysPage() {
  const { notify } = useToast()
  const { confirm } = useConfirm()
  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [patterns, setPatterns] = useState('')
  const [created, setCreated] = useState<CreatedApiKey>()
  const [editKey, setEditKey] = useState<ApiKeyRecord>()
  const [editName, setEditName] = useState('')
  const [editPatterns, setEditPatterns] = useState('')
  const [viewKey, setViewKey] = useState<ApiKeyRecord>()

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await apiGet<{ keys: ApiKeyRecord[] }>('/api/keys')
      setKeys(result.keys)
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
    if (needle === '') return keys
    return keys.filter((key) => (
      key.name.toLowerCase().includes(needle)
      || key.prefix.toLowerCase().includes(needle)
      || key.allowedModels?.some((pattern) => pattern.toLowerCase().includes(needle))
    ))
  }, [keys, search])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const result = await apiPost<CreatedApiKey>('/api/keys', {
        name: name.trim() || 'API key',
        allowedModels: parseLines(patterns),
      })
      setCreated(result)
      setCreateOpen(false)
      setName('')
      setPatterns('')
      await load()
    } catch (reason) {
      notify(errorText(reason), 'error')
    }
  }

  const update = async (key: ApiKeyRecord, patch: { name?: string; enabled?: boolean; allowedModels?: string[] }) => {
    setBusyId(key.id)
    try {
      const result = await apiPatch<ApiKeyRecord>(`/api/keys/${encodeURIComponent(key.id)}`, patch)
      setKeys((current) => current.map((item) => item.id === key.id ? result : item))
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const saveEdit = async () => {
    if (editKey === undefined) return
    await update(editKey, {
      name: editName.trim() || editKey.name,
      allowedModels: parseLines(editPatterns),
    })
    setEditKey(undefined)
    notify('API Key 设置已保存。', 'success')
  }

  const remove = async (key: ApiKeyRecord) => {
    const accepted = await confirm({
      title: '删除 API Key',
      description: `删除“${key.name}”后，所有使用该密钥的客户端将立即失去访问权限。`,
      confirmText: '删除',
      danger: true,
    })
    if (!accepted) return
    setBusyId(key.id)
    try {
      await apiDelete(`/api/keys/${encodeURIComponent(key.id)}`)
      setKeys((current) => current.filter((item) => item.id !== key.id))
      notify('API Key 已删除。', 'success')
    } catch (reason) {
      notify(errorText(reason), 'error')
    } finally {
      setBusyId(undefined)
    }
  }

  const enabled = keys.filter((key) => key.enabled).length

  return (
    <div className="page-stack">
      <PageTitle
        title="API 密钥"
        description="为客户端创建独立密钥，并通过模型通配符限制访问范围。"
        actions={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : undefined} />
              刷新
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} />
              创建密钥
            </button>
          </>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <div className="metric-grid metric-grid-compact">
        <div className="metric"><span className="metric-label">密钥总数</span><strong className="metric-value">{keys.length}</strong></div>
        <div className="metric metric-success"><span className="metric-label">已启用</span><strong className="metric-value">{enabled}</strong></div>
        <div className="metric"><span className="metric-label">已停用</span><strong className="metric-value">{keys.length - enabled}</strong></div>
        <div className="metric"><span className="metric-label">最近使用</span><strong className="metric-value metric-date">{formatDate(Math.max(0, ...keys.map((key) => key.lastUsedAt ?? 0)))}</strong></div>
      </div>

      <Panel>
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索名称、前缀或模型规则" />
          <span className="toolbar-spacer" />
          <span className="toolbar-count">{filtered.length} / {keys.length} 个密钥</span>
        </div>
        {loading && keys.length === 0 ? <LoadingBlock /> : filtered.length === 0 ? (
          <EmptyState
            title={keys.length === 0 ? '尚未创建 API Key' : '没有匹配的密钥'}
            description={keys.length === 0 ? '创建后可通过 Bearer Token 调用 /v1 接口。' : '调整搜索条件。'}
          />
        ) : (
          <div className="account-grid">
            {filtered.map((key) => (
              <article key={key.id} className="account-card">
                <div className="account-card-header">
                  <div>
                    <div className="cell-main">{key.name}</div>
                    <div className="cell-sub">创建于 {formatDate(key.createdAt)}</div>
                  </div>
                  <Badge tone={key.enabled ? 'success' : 'neutral'}>{key.enabled ? '已启用' : '已停用'}</Badge>
                </div>
                <div className="account-card-stats">
                  <div className="account-stat">
                    <span>前缀</span>
                    <code className="inline-code">{key.prefix}...</code>
                  </div>
                  <div className="account-stat">
                    <span>最后使用</span>
                    <strong className="account-stat-main">{formatDate(key.lastUsedAt)}</strong>
                  </div>
                  <div className="account-stat account-stat-wide">
                    <span>模型范围</span>
                    {key.allowedModels === undefined || key.allowedModels.length === 0 ? (
                      <Badge tone="info">全部模型</Badge>
                    ) : (
                      <div className="badge-list">
                        {key.allowedModels.map((pattern) => <Badge key={pattern} tone="neutral">{pattern}</Badge>)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="account-card-actions">
                  {key.value === undefined ? null : (
                    <button className="btn btn-secondary btn-small" type="button" onClick={() => setViewKey(key)}>
                      <KeyRound size={14} />
                      查看密钥
                    </button>
                  )}
                  <Toggle
                    checked={key.enabled}
                    disabled={busyId === key.id}
                    onChange={(checked) => void update(key, { enabled: checked })}
                    label={key.enabled ? '启用' : '停用'}
                  />
                  <button
                    className="icon-btn"
                    type="button"
                    title="编辑"
                    onClick={() => {
                      setEditKey(key)
                      setEditName(key.name)
                      setEditPatterns(key.allowedModels?.join('\n') ?? '')
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn icon-btn-danger" type="button" title="删除" disabled={busyId === key.id} onClick={() => void remove(key)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Modal
        open={createOpen}
        title="创建 API Key"
        onClose={() => setCreateOpen(false)}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn btn-primary" type="submit" form="create-key-form">创建</button>
          </>
        )}
      >
        <form id="create-key-form" className="form-stack" onSubmit={(event) => void create(event)}>
          <label className="field">
            <span>名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Open WebUI" autoFocus />
          </label>
          <label className="field">
            <span>允许的模型（可选）</span>
            <textarea
              value={patterns}
              onChange={(event) => setPatterns(event.target.value)}
              rows={5}
              placeholder={'每行一个，支持通配符：\ncodearts/*\nbuilder/claude-*'}
            />
            <small>留空表示允许调用全部已启用模型。</small>
          </label>
        </form>
      </Modal>

      <Modal
        open={created !== undefined}
        title="API Key 已创建"
        onClose={() => setCreated(undefined)}
        footer={<button className="btn btn-primary" type="button" onClick={() => setCreated(undefined)}>我已保存</button>}
      >
        <div className="secret-reveal">
          <ShieldAlert size={20} />
          <div>
            <strong>密钥已保存到管理数据文件</strong>
            <p>关闭窗口后仍可在列表中点击“查看密钥”。请继续保护服务端数据目录。</p>
          </div>
        </div>
        <div className="secret-value">
          <code>{created?.key}</code>
          <CopyButton value={created?.key ?? ''} label="复制密钥" />
        </div>
      </Modal>

      <Modal open={viewKey !== undefined} title="查看 API Key" onClose={() => setViewKey(undefined)}>
        {viewKey === undefined ? null : (
          <>
            <div className="secret-reveal">
              <ShieldAlert size={20} />
              <div>
                <strong>完整密钥可重复查看</strong>
                <p>仅管理员接口会返回该值；请避免在前端日志或截图外泄。</p>
              </div>
            </div>
            <div className="secret-value">
              <code>{viewKey.value}</code>
              <CopyButton value={viewKey.value ?? ''} label="复制密钥" />
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={editKey !== undefined}
        title="编辑 API Key"
        onClose={() => setEditKey(undefined)}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setEditKey(undefined)}>取消</button>
            <button className="btn btn-primary" type="button" onClick={() => void saveEdit()}>保存</button>
          </>
        )}
      >
        <div className="form-stack">
          <label className="field">
            <span>名称</span>
            <input value={editName} onChange={(event) => setEditName(event.target.value)} />
          </label>
          <label className="field">
            <span>允许的模型</span>
            <textarea value={editPatterns} onChange={(event) => setEditPatterns(event.target.value)} rows={5} placeholder="留空表示全部模型" />
          </label>
        </div>
      </Modal>
    </div>
  )
}
