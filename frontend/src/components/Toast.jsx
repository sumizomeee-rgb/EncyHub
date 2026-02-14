import { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'

const ToastContext = createContext(null)

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const COLORS = {
  success: {
    bg: 'bg-[var(--success-soft)]',
    border: 'border-[var(--sage)]',
    icon: 'text-[var(--sage)]',
    text: 'text-[var(--coffee-deep)]',
  },
  error: {
    bg: 'bg-[var(--error-soft)]',
    border: 'border-[var(--terracotta)]',
    icon: 'text-[var(--terracotta)]',
    text: 'text-[var(--coffee-deep)]',
  },
  warning: {
    bg: 'bg-[var(--warning-soft)]',
    border: 'border-[var(--amber)]',
    icon: 'text-[var(--amber)]',
    text: 'text-[var(--coffee-deep)]',
  },
  info: {
    bg: 'bg-[var(--info-soft)]',
    border: 'border-[var(--sky)]',
    icon: 'text-[var(--sky)]',
    text: 'text-[var(--coffee-deep)]',
  },
}

let toastId = 0

function ToastItem({ toast, onRemove }) {
  const [exiting, setExiting] = useState(false)
  const colors = COLORS[toast.type] || COLORS.info
  const Icon = ICONS[toast.type] || Info

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true)
      setTimeout(() => onRemove(toast.id), 300)
    }, toast.duration || 3000)
    return () => clearTimeout(timer)
  }, [toast, onRemove])

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl border-l-4 shadow-lg backdrop-blur-sm max-w-sm w-full transition-all duration-300 ${colors.bg} ${colors.border} ${
        exiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0'
      }`}
      style={{ animation: exiting ? 'none' : 'slideInRight 0.3s ease' }}
    >
      <Icon size={18} className={`${colors.icon} mt-0.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        {toast.title && (
          <div className={`text-sm font-semibold ${colors.text} mb-0.5`}>{toast.title}</div>
        )}
        <div className={`text-sm ${colors.text} opacity-90 break-words`}>{toast.message}</div>
      </div>
      <button
        onClick={() => {
          setExiting(true)
          setTimeout(() => onRemove(toast.id), 300)
        }}
        className="p-0.5 rounded hover:bg-black/5 transition-colors shrink-0"
      >
        <X size={14} className="text-[var(--coffee-muted)]" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((type, message, options = {}) => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, type, message, ...options }])
    return id
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useMemo(() => ({
    success: (msg, opts) => addToast('success', msg, opts),
    error: (msg, opts) => addToast('error', msg, { duration: 5000, ...opts }),
    warning: (msg, opts) => addToast('warning', msg, opts),
    info: (msg, opts) => addToast('info', msg, opts),
  }), [addToast])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onRemove={removeToast} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
