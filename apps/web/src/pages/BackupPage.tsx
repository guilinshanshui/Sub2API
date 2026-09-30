import { ArchiveRestore, Download, FileUp, LockKeyhole, RefreshCw, ShieldAlert, Upload } from 'lucide-react'
import { useEffect, useState, type ChangeEvent } from 'react'
import { apiGet, apiPost, errorText } from '../api.js'
import { decryptBackup, downloadJson, encryptBackup, isEncryptedBackup } from '../backup.js'
import {
  Badge,
  InlineError,
  LoadingBlock,
  PageTitle,
  Panel,
  formatDate,
  useConfirm,
  useToast,
} from '../components/ui.js'
import type { BackupExport, BackupImportResult, BackupStatus } from '../types.js'

export function BackupPage() {
  const { notify } = useToast()
  const { confirm } = useConfirm()
  const [status, setStatus] = useState<BackupStatus>()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string>()
  const [password, setPassword] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [result, setResult] = useState<BackupImportResult>()
  const [fileName, setFileName] = useState('')

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setStatus(await apiGet<BackupStatus>('/api/backup/status'))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const exportBackup = async () => {
    setExporting(true)
    setError(undefined)
    setWarnings([])
    try {
      const exported = await apiGet<BackupExport>('/api/backup/export')
      setWarnings(exported.warnings ?? [])
      if (password.trim() === '') {
        downloadJson(`sub2api-backup-${new Date().toISOString().slice(0, 10)}.json`, exported.payload)
        notify('明文备份已下载，请妥善保管。', 'success')
      } else {
        const encrypted = await encryptBackup(exported.payload, password)
        downloadJson(`sub2api-backup-${new Date().toISOString().slice(0, 10)}.encrypted.json`, encrypted)
        notify('加密备份已下载。', 'success')
      }
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setExporting(false)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setFileName(file.name)
    setImporting(true)
    setError(undefined)
    setResult(undefined)
    try {
      const raw = JSON.parse(await file.text()) as unknown
      let payload = raw
      if (isEncryptedBackup(raw)) {
        if (password.trim() === '') throw new Error('该文件已加密，请先输入备份密码。')
        payload = await decryptBackup(raw, password)
      }
      const accepted = await confirm({
        title: '导入备份',
        description: `将用“${file.name}”整体替换当前账号池、凭据和模型黑名单。当前数据会被覆盖。`,
        confirmText: '覆盖导入',
        danger: true,
      })
      if (!accepted) return
      const imported = await apiPost<BackupImportResult>('/api/backup/import', { payload })
      setResult(imported)
      notify('备份已导入。', 'success')
      await load()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="page-stack">
      <PageTitle
        title="备份与迁移"
        description="导出账号池与凭据，或从备份文件整体恢复。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            刷新状态
          </button>
        )}
      />
      {error === undefined ? null : <InlineError message={error} />}

      <div className="metric-grid metric-grid-compact">
        <div className="metric"><span className="metric-label">账号总数</span><strong className="metric-value">{status?.accounts ?? '-'}</strong></div>
        <div className="metric metric-warning"><span className="metric-label">缺少有效期</span><strong className="metric-value">{status?.withoutExpiry ?? '-'}</strong></div>
        <div className="metric"><span className="metric-label">备份格式</span><strong className="metric-value">JSON v1</strong></div>
        <div className="metric metric-success"><span className="metric-label">加密方式</span><strong className="metric-value">AES-GCM</strong></div>
      </div>

      <div className="two-column-grid">
        <Panel title="导出备份" subtitle="备份文件包含账号索引、凭据原文和模型黑名单">
          {loading && status === undefined ? <LoadingBlock /> : (
            <div className="form-stack">
              <div className="callout callout-warning">
                <ShieldAlert size={17} />
                <span>备份包含可用的上游凭据。建议设置密码后再下载，并只保存在可信位置。</span>
              </div>
              <label className="field">
                <span>加密密码（可选）</span>
                <span className="input-with-icon">
                  <LockKeyhole size={15} />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="至少 8 位；留空则导出明文"
                  />
                </span>
                <small>密码只在浏览器本地用于 PBKDF2 + AES-GCM 加密，不会发送到服务端。</small>
              </label>
              <div className="form-actions">
                <button className="btn btn-primary" type="button" onClick={() => void exportBackup()} disabled={exporting}>
                  <Download size={15} />
                  {exporting ? '导出中...' : '导出备份'}
                </button>
              </div>
              {warnings.length === 0 ? null : (
                <div className="warning-list">
                  <strong>导出时发现 {warnings.length} 个问题</strong>
                  {warnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="导入备份" subtitle="导入会整体覆盖当前账号池，不是合并">
          <div className="form-stack">
            <div className="callout callout-danger">
              <ArchiveRestore size={17} />
              <span>导入前请先导出当前数据。过期账号仍可导入，但可能需要重新登录。</span>
            </div>
            <label className="file-drop">
              <FileUp size={22} />
              <strong>{fileName === '' ? '选择备份文件' : fileName}</strong>
              <span>支持明文 JSON 或 Sub2API 加密备份</span>
              <input type="file" accept="application/json,.json" onChange={(event) => void importFile(event)} disabled={importing} />
            </label>
            <div className="file-action">
              <Upload size={15} />
              <span>{importing ? '正在读取并导入...' : '选择文件后会自动校验并请求确认。'}</span>
            </div>
          </div>
        </Panel>
      </div>

      {result === undefined ? null : (
        <Panel title="导入结果" subtitle={`文件：${fileName}`}>
          <div className="result-grid">
            <div><span>导入凭据</span><strong>{result.credentialsImported}</strong></div>
            <div><span>导入账号</span><strong>{result.accountsImported}</strong></div>
            <div><span>跳过凭据</span><strong>{result.skipped.length}</strong></div>
            <div><span>过期账号</span><strong>{result.expiredAccounts}</strong></div>
            <div><span>缺失凭据</span><strong>{result.missingCredentials}</strong></div>
          </div>
          {result.skipped.length === 0 ? null : (
            <div className="warning-list">
              <strong>跳过的凭据引用</strong>
              {result.skipped.map((item) => <span className="mono" key={item}>{item}</span>)}
            </div>
          )}
          {result.missingCredentials === 0 ? null : (
            <p className="muted">有 {result.missingCredentials} 个账号没有可用凭据，请在账号池中重新登录。</p>
          )}
        </Panel>
      )}

      <Panel title="数据位置" subtitle="备份状态来自当前账号池快照">
        <div className="definition-grid">
          <div><span>账号数量</span><strong>{status?.accounts ?? '-'}</strong></div>
          <div><span>缺少有效期</span><strong>{status?.withoutExpiry ?? '-'}</strong></div>
          <div><span>生成时间</span><strong>{formatDate(Date.now())}</strong></div>
          <div><span>加密算法</span><Badge tone="info">AES-GCM 256</Badge></div>
        </div>
      </Panel>
    </div>
  )
}
