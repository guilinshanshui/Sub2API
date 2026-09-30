import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

interface ToastContextValue {
  notify(message: string, tone?: ToastTone): void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, tone }].slice(-4))
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 4_200)
  }, [])
  const value = useMemo(() => ({ notify }), [notify])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx('toast', `toast-${toast.tone}`)}>
            {toast.tone === 'success' ? <Check size={16} /> : toast.tone === 'error' ? <TriangleAlert size={16} /> : null}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (value === undefined) throw new Error('useToast must be used inside ToastProvider')
  return value
}

interface ConfirmOptions {
  title: string
  description: string
  confirmText?: string
  danger?: boolean
}

interface ConfirmRequest {
  options: ConfirmOptions
  resolve(value: boolean): void
}

interface ConfirmContextValue {
  confirm(options: ConfirmOptions): Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | undefined>(undefined)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined)
  const confirm = useCallback((options: ConfirmOptions) => (
    new Promise<boolean>((resolve) => {
      setRequest({ options, resolve })
    })
  ), [])
  const close = (value: boolean) => {
    request?.resolve(value)
    setRequest(undefined)
  }
  const value = useMemo(() => ({ confirm }), [confirm])
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={request !== undefined}
        title={request?.options.title ?? '确认操作'}
        onClose={() => close(false)}
        footer={(
          <>
            <button className="btn btn-secondary" type="button" onClick={() => close(false)}>取消</button>
            <button
              className={cx('btn', request?.options.danger ? 'btn-danger' : 'btn-primary')}
              type="button"
              onClick={() => close(true)}
            >
              {request?.options.confirmText ?? '确认'}
            </button>
          </>
        )}
      >
        <p className="modal-description">{request?.options.description}</p>
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmContextValue {
  const value = useContext(ConfirmContext)
  if (value === undefined) throw new Error('useConfirm must be used inside ConfirmProvider')
  return value
}

interface ModalProps {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ open, title, onClose, children, footer, wide }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={cx('modal', wide && 'modal-wide')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer === undefined ? null : <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  )
}

export function PageTitle({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </div>
  )
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('panel', className)}>
      {title === undefined ? null : (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle === undefined ? null : <p>{subtitle}</p>}
          </div>
          {actions === undefined ? null : <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: ReactNode
  detail?: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}) {
  return (
    <div className={cx('metric', tone !== undefined && tone !== 'default' && `metric-${tone}`)}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {detail === undefined ? null : <span className="metric-detail">{detail}</span>}
    </div>
  )
}

export function StatusBadge({
  ok,
  children,
}: {
  ok: boolean
  children?: ReactNode
}) {
  return (
    <span className={cx('badge', ok ? 'badge-success' : 'badge-danger')}>
      <span className="status-dot" />
      {children ?? (ok ? '正常' : '停用')}
    </span>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  children: ReactNode
}) {
  return <span className={cx('badge', `badge-${tone}`)}>{children}</span>
}

export function LevelBadge({ level }: { level: 'debug' | 'info' | 'warn' | 'error' }) {
  const labels = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' }
  return <span className={cx('badge', `badge-level-${level}`)}>{labels[level]}</span>
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {description === undefined ? null : <p>{description}</p>}
      {action === undefined ? null : <div>{action}</div>}
    </div>
  )
}

export function LoadingBlock({ label = '正在加载' }: { label?: string }) {
  return (
    <div className="loading-block">
      <LoaderCircle size={18} className="spin" />
      <span>{label}</span>
    </div>
  )
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-error">
      <TriangleAlert size={16} />
      <span>{message}</span>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange(checked: boolean): void
  disabled?: boolean
  label?: string
}) {
  return (
    <label className={cx('toggle', disabled && 'is-disabled')} title={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label === undefined ? null : <span className="toggle-label">{label}</span>}
    </label>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索',
}: {
  value: string
  onChange(value: string): void
  placeholder?: string
}) {
  return (
    <label className="search-input">
      <Search size={15} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  )
}

export interface SelectMenuOption {
  value: string
  label: string
  description?: string
}

function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/.exec(value.trim())
  if (match === null) return '09:10'
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function TimeSelect({
  value,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: string
  onChange(value: string): void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const time = normalizeTime(value)
  const [hour = 9, minute = 10] = time.split(':').map(Number)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const updateTime = (nextHour: number, nextMinute: number) => {
    onChange(`${String(nextHour).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`)
  }

  const hours = Array.from({ length: 24 }, (_, index) => index)
  const minutes = Array.from({ length: 60 }, (_, index) => index)

  return (
    <div
      ref={rootRef}
      className={cx('time-select-menu', open && 'is-open', disabled && 'is-disabled', className)}
    >
      <button
        className="select-menu-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <Clock3 size={14} />
        <span className="select-menu-value">{time}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="time-select-popover" role="dialog" aria-label="选择时间">
          <div className="time-select-column">
            <button type="button" aria-label="减少小时" onClick={() => updateTime((hour + 23) % 24, minute)}>
              <ChevronLeft size={13} />
            </button>
            <strong>{String(hour).padStart(2, '0')}</strong>
            <button type="button" aria-label="增加小时" onClick={() => updateTime((hour + 1) % 24, minute)}>
              <ChevronRight size={13} />
            </button>
          </div>
          <span className="time-select-separator">:</span>
          <div className="time-select-column">
            <button type="button" aria-label="减少分钟" onClick={() => updateTime(hour, (minute + 59) % 60)}>
              <ChevronLeft size={13} />
            </button>
            <strong>{String(minute).padStart(2, '0')}</strong>
            <button type="button" aria-label="增加分钟" onClick={() => updateTime(hour, (minute + 1) % 60)}>
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="time-select-list">
            {[...hours].sort((left, right) => {
              const leftOffset = (left - hour + 24) % 24
              const rightOffset = (right - hour + 24) % 24
              return leftOffset - rightOffset
            }).slice(0, 12).map((hourOption) => (
              <button
                key={`hour-${hourOption}`}
                className={cx('time-select-option', hourOption === hour && 'is-selected')}
                type="button"
                onClick={() => updateTime(hourOption, minute)}
              >
                {String(hourOption).padStart(2, '0')} 时
              </button>
            ))}
          </div>
          <div className="time-select-list">
            {[...minutes].sort((left, right) => {
              const leftOffset = (left - minute + 60) % 60
              const rightOffset = (right - minute + 60) % 60
              return leftOffset - rightOffset
            }).slice(0, 12).map((minuteOption) => (
              <button
                key={`minute-${minuteOption}`}
                className={cx('time-select-option', minuteOption === minute && 'is-selected')}
                type="button"
                onClick={() => updateTime(hour, minuteOption)}
              >
                {String(minuteOption).padStart(2, '0')} 分
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary btn-small time-select-done"
            type="button"
            onClick={() => setOpen(false)}
          >
            完成
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function SelectMenu({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled,
  className,
  ariaLabel,
}: {
  value: string
  options: readonly SelectMenuOption[]
  onChange(value: string): void
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={cx('select-menu', open && 'is-open', disabled && 'is-disabled', className)}
    >
      <button
        className="select-menu-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected === undefined ? 'select-menu-placeholder' : 'select-menu-value'}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="select-menu-popover" role="listbox">
          {options.map((option) => {
            const isSelected = option.value === value
            return (
              <button
                key={option.value === '' ? '__empty__' : option.value}
                className={cx('select-menu-option', isSelected && 'is-selected')}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.description === undefined ? null : <small>{option.description}</small>}
                </span>
                {isSelected ? <Check size={15} /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const { notify } = useToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      notify('已复制到剪贴板。', 'success')
    } catch {
      notify('复制失败，请手动选择文本。', 'error')
    }
  }
  return (
    <button className="btn btn-secondary btn-small" type="button" onClick={() => void copy()} title={label}>
      <Clipboard size={14} />
      {label}
    </button>
  )
}

export function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

export function formatDate(value: number | undefined): string {
  if (value === undefined || value <= 0) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function formatShortDate(value: number | undefined): string {
  if (value === undefined || value <= 0) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined || value < 0) return '-'
  if (value < 1_000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

export function formatUptime(value: number): string {
  const totalSeconds = Math.floor(value / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  return `${minutes}分`
}

export function parseLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
