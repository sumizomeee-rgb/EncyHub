import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import {
  Search, RotateCw, Package, PanelRight, Columns3,
  ChevronDown, ChevronRight, ExternalLink, Filter, X, Copy
} from 'lucide-react'
import { copyText } from '../utils/clipboard'

// ============================================================================
// Constants
// ============================================================================

// XEnumConst.SUBPACKAGE.DOWNLOAD_STATE (来自 XEnumConst.lua:1398-1405)
const STATE_CONFIG = {
  1: { label: '未下载',  color: 'var(--coffee-muted)', bg: 'rgba(168,155,145,0.15)' },
  2: { label: '准备中',  color: 'var(--caramel)',      bg: 'rgba(212,165,116,0.15)' },
  3: { label: '已暂停',  color: 'var(--amber)',        bg: 'var(--warning-soft)' },
  4: { label: '下载中',  color: 'var(--sky)',          bg: 'var(--info-soft)' },
  5: { label: '已完成',  color: 'var(--sage)',         bg: 'var(--success-soft)' },
  6: { label: '已卸载',  color: 'var(--coffee-light)', bg: 'rgba(139,125,114,0.15)' },
}
const FALLBACK_STATE = { label: '未知', color: 'var(--coffee-muted)', bg: 'rgba(168,155,145,0.15)' }

const ALL_STATES = new Set([1, 2, 3, 4, 5, 6])
const DETAIL_LIST_MIN_WIDTH = 340
const DETAIL_LIST_DEFAULT_WIDTH = 360

const LS_KEYS = {
  viewMode:   'subpkg_monitor_view_mode',
  perspective:'subpkg_monitor_perspective',
  interval:   'subpkg_monitor_refresh_interval',
  autoRefresh:'subpkg_monitor_auto_refresh',
  leftWidth:  'subpkg_monitor_left_width',
}

function lsGet(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback } catch { return fallback }
}
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)) } catch {} }
function clampDetailListWidth(value) {
  const width = Number(value)
  return Math.min(Math.max(Number.isFinite(width) ? width : DETAIL_LIST_DEFAULT_WIDTH, DETAIL_LIST_MIN_WIDTH), 500)
}

// ============================================================================
// Helpers
// ============================================================================

function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function stateOf(s) { return STATE_CONFIG[s] || FALLBACK_STATE }

function formatFilesText(files) {
  if (!files?.length) return ''
  const rows = files.map(f => [f.name, f.asset || '', formatSize(f.size), f.sha1 || ''])
  const widths = [0, 0, 0, 0]
  for (const r of rows) r.forEach((c, i) => { if (c.length > widths[i]) widths[i] = c.length })
  return rows.map(r => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n')
}

// 智能尺寸显示：已完成只显示总大小，已卸载显示 "—"
function sizeText(dlSize, totalSize, state) {
  if (state === 6) return '—'                                         // 已卸载
  if (state === 5) return formatSize(totalSize)                       // 已完成
  if (state === 1 && dlSize === 0) return formatSize(totalSize)       // 未下载
  return `${formatSize(dlSize)} / ${formatSize(totalSize)}`           // 其他
}

// ============================================================================
// Sub-components
// ============================================================================

function StateBadge({ state, mini, error = false }) {
  const cfg = error
    ? { ...stateOf(state), color: 'var(--terracotta)', bg: 'rgba(193,102,107,0.10)' }
    : stateOf(state)
  if (mini) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold flex-shrink-0 whitespace-nowrap"
        style={{ color: cfg.color }}>
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg.color }} />
        {cfg.label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
      style={{ background: cfg.bg, color: cfg.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.color,
        ...(state === 4 ? { boxShadow: '0 0 0 3px var(--info-soft)', animation: 'pulse-success 2s ease-in-out infinite' } : {}) }} />
      {cfg.label}
    </span>
  )
}

function ProgressBar({ progress, state, mini }) {
  const pct = Math.min(100, Math.max(0, (progress || 0) * 100))
  const cfg = stateOf(state)
  if (mini) {
    // Compact: just the bar, no text
    return (
      <div className="h-1 rounded-full bg-[var(--cream-warm)] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${Math.max(pct, state === 5 ? 100 : 0)}%`,
            background: state === 4
              ? 'linear-gradient(90deg, var(--sky) 0%, var(--sky-soft) 50%, var(--sky) 100%)'
              : cfg.color,
            ...(state === 4 ? { backgroundSize: '200% 100%', animation: 'shimmer 2s linear infinite' } : {}),
          }} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--cream-warm)] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: state === 4
              ? 'linear-gradient(90deg, var(--sky) 0%, var(--sky-soft) 50%, var(--sky) 100%)'
              : cfg.color,
            ...(state === 4 ? { backgroundSize: '200% 100%', animation: 'shimmer 2s linear infinite' } : {}),
          }} />
      </div>
      <span className="text-[10px] font-mono text-[var(--coffee-muted)] w-8 text-right flex-shrink-0">
        {state === 5 ? '✓' : state === 6 ? '—' : `${Math.round(pct)}%`}
      </span>
    </div>
  )
}

function SharedPopover({ ids, type, onJump, onClose }) {
  return (
    <div className="absolute z-50 mt-1 p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--cream-soft)] shadow-lg min-w-[140px]"
      onClick={e => e.stopPropagation()}>
      <div className="text-[10px] text-[var(--coffee-muted)] mb-1 font-semibold">共享此项的 {type}</div>
      {ids.map(id => (
        <button key={id} onClick={() => { onJump(String(id)); onClose() }}
          className="flex items-center gap-1 w-full px-1.5 py-1 rounded text-xs hover:bg-[var(--cream-warm)] text-[var(--coffee-deep)] transition-colors">
          <span className="font-mono font-semibold">{type} {id}</span>
          <ExternalLink size={10} className="ml-auto text-[var(--sky)]" />
        </button>
      ))}
    </div>
  )
}

function SharedBadge({ count, type, ids, onJump }) {
  if (!count || count <= 1) return null
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold transition-colors
          bg-[var(--info-soft)] text-[var(--sky)] hover:bg-[var(--sky)] hover:text-white cursor-pointer">
        ×{count} {type}
        <ExternalLink size={9} />
      </button>
      {open && <SharedPopover ids={ids || []} type={type} onJump={onJump} onClose={() => setOpen(false)} />}
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

function SubPackageMonitor({ clients, selectedClient, broadcastMode, active }) {
  // --- Data state ---
  const [structure, setStructure] = useState(null)
  const [status, setStatus] = useState(null)

  // --- UI state ---
  const [viewMode, setViewMode] = useState(() => lsGet(LS_KEYS.viewMode, 'detail'))
  const [perspective, setPerspective] = useState(() => lsGet(LS_KEYS.perspective, 'sub'))
  const [selectedId, setSelectedId] = useState(null)
  const [expandedRes, setExpandedRes] = useState(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [stateFilter, setStateFilter] = useState(() => new Set(ALL_STATES))
  const [showFilterDrop, setShowFilterDrop] = useState(false)
  const [onlyShared, setOnlyShared] = useState(false)
  const [copiedSha1, setCopiedSha1] = useState(null)
  const [copiedFile, setCopiedFile] = useState(null)
  const [onlyMissingRes, setOnlyMissingRes] = useState(false)
  const [copiedMissingRes, setCopiedMissingRes] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(() => lsGet(LS_KEYS.autoRefresh, true))
  const [refreshInterval, setRefreshInterval] = useState(() => lsGet(LS_KEYS.interval, 2))
  const [leftWidth, setLeftWidth] = useState(() => clampDetailListWidth(lsGet(LS_KEYS.leftWidth, DETAIL_LIST_DEFAULT_WIDTH)))
  const [highlightId, setHighlightId] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)

  // Mode B state
  const [colSelectedSub, setColSelectedSub] = useState(null)
  const [colSelectedRes, setColSelectedRes] = useState(null)
  const [colHighlightSubs, setColHighlightSubs] = useState(new Set())
  const [colHighlightRes, setColHighlightRes] = useState(new Set())

  // --- Refs ---
  const wsRef = useRef(null)
  const listenersRef = useRef({})
  const isDragging = useRef(false)
  const searchTimer = useRef(null)
  const highlightTimer = useRef(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // --- Persist UI state ---
  useEffect(() => { lsSet(LS_KEYS.viewMode, viewMode) }, [viewMode])
  useEffect(() => { lsSet(LS_KEYS.perspective, perspective) }, [perspective])
  useEffect(() => { lsSet(LS_KEYS.interval, refreshInterval) }, [refreshInterval])
  useEffect(() => { lsSet(LS_KEYS.autoRefresh, autoRefresh) }, [autoRefresh])
  useEffect(() => { lsSet(LS_KEYS.leftWidth, leftWidth) }, [leftWidth])

  // --- 切换选中项时收起所有展开的 Res ---
  useEffect(() => {
    setExpandedRes(new Set())
    setOnlyMissingRes(false)
    setCopiedMissingRes(false)
  }, [selectedId])

  // --- Debounced search ---
  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(searchTimer.current)
  }, [searchQuery])

  // ==========================================================================
  // WebSocket
  // ==========================================================================
  useEffect(() => {
    if (!selectedClient || !active) { setWsConnected(false); return }
    let closed = false
    const connect = () => {
      if (closed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/subpkg_monitor`)
      wsRef.current = ws
      let pingTimer = null
      ws.onopen = () => {
        setWsConnected(true)
        pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 25000)
      }
      ws.onmessage = (event) => {
        if (event.data === 'pong') return
        try {
          const msg = JSON.parse(event.data)
          if (msg.client_id !== selectedClient?.id) return
          const cb = listenersRef.current[msg.type]
          if (cb) cb(msg.data)
        } catch {}
      }
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        setWsConnected(false)
        wsRef.current = null
        if (!closed) setTimeout(connect, 2000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { closed = true; wsRef.current?.close(); wsRef.current = null }
  }, [selectedClient?.id, active])

  // ==========================================================================
  // Command helper
  // ==========================================================================
  const sendCmd = useCallback((action, params, onResponse) => {
    if (!selectedClient) return
    if (onResponse) listenersRef.current[action] = onResponse
    fetch(`/api/gm_console/subpkg_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params })
    }).catch(e => console.error('[SubPkgMonitor] sendCmd error:', e))
  }, [selectedClient?.id])

  // ==========================================================================
  // Data fetching
  // ==========================================================================
  const fetchStructure = useCallback(() => {
    sendCmd('get_structure', {}, (data) => setStructure(data))
  }, [sendCmd])

  const fetchStatus = useCallback(() => {
    sendCmd('get_status', {}, (data) => setStatus(data))
  }, [sendCmd])

  // Per-resource file loading (on demand)
  const [resFiles, setResFiles] = useState({})   // resId → { files, sharedFiles }
  const [resFilesLoading, setResFilesLoading] = useState({})

  const fetchResFiles = useCallback((resId) => {
    if (resFiles[resId]) return  // already loaded
    setResFilesLoading(prev => ({ ...prev, [resId]: true }))
    sendCmd('get_res_files', { resId }, (data) => {
      if (data?.resId) {
        setResFilesLoading(prev => ({ ...prev, [data.resId]: false }))
        setResFiles(prev => ({ ...prev, [data.resId]: { files: data.files || [], sharedFiles: data.sharedFiles || {} } }))
      }
    })
  }, [sendCmd, resFiles])

  // Initial fetch on tab activation (must wait for WS to be ready)
  useEffect(() => {
    if (!active || !selectedClient || !wsConnected) return
    fetchStructure()
    fetchStatus()
  }, [active, selectedClient?.id, wsConnected, fetchStructure, fetchStatus])

  // Auto-refresh for status
  useEffect(() => {
    if (!autoRefresh || !active || !selectedClient || refreshInterval <= 0) return
    const timer = setInterval(fetchStatus, refreshInterval * 1000)
    return () => clearInterval(timer)
  }, [autoRefresh, active, selectedClient?.id, refreshInterval, fetchStatus])

  // Reset on client change
  useEffect(() => {
    listenersRef.current = {}
    setStructure(null); setStatus(null); setSelectedId(null); setExpandedRes(new Set())
    setColSelectedSub(null); setColSelectedRes(null); setResFiles({}); setResFilesLoading({})
  }, [selectedClient?.id])

  // ==========================================================================
  // Computed data
  // ==========================================================================
  const subList = useMemo(() => {
    if (!structure?.subs) return []
    return Object.entries(structure.subs).map(([id, s]) => ({
      id, name: s.name, resIds: (s.resIds || []).map(String),
      configuredResCount: s.configuredResCount ?? (s.resIds || []).length,
      indexedResCount: s.indexedResCount ?? (s.resIds || []).length,
      missingResCount: s.missingResCount ?? 0,
      ...(status?.subs?.[id] || { state: -1, dlSize: 0, totalSize: 0, progress: 0 })
    }))
  }, [structure, status])

  const resList = useMemo(() => {
    if (!structure?.resources) return []
    return Object.entries(structure.resources).map(([id, r]) => ({
      id, subIds: (r.subIds || []).map(String), fileCount: r.fileCount || 0,
      configured: r.configured !== false, indexed: r.indexed !== false,
      ...(status?.resources?.[id] || { state: -1, dlSize: 0, totalSize: 0, progress: 0, tgState: -1 })
    }))
  }, [structure, status])

  // ==========================================================================
  // Filtering
  // ==========================================================================
  const matchesSearch = useCallback((item, type) => {
    if (!debouncedQuery) return true
    const q = debouncedQuery.toLowerCase()
    if (String(item.id).includes(q)) return true
    if (type === 'sub' && item.name?.toLowerCase().includes(q)) return true
    if (type === 'sub' && item.resIds?.some(rid => String(rid).includes(q))) return true
    if (type === 'res') {
      if (item.files?.some(f => f.name?.toLowerCase().includes(q) || f.asset?.toLowerCase().includes(q))) return true
    }
    return false
  }, [debouncedQuery])

  const filteredSubs = useMemo(() =>
    subList.filter(s => (s.state === -1 || stateFilter.has(s.state)) && matchesSearch(s, 'sub')),
  [subList, stateFilter, matchesSearch])

  const filteredRes = useMemo(() =>
    resList.filter(r => (r.state === -1 || stateFilter.has(r.state)) && matchesSearch(r, 'res') && (!onlyShared || r.subIds.length > 1)),
  [resList, stateFilter, matchesSearch, onlyShared])

  // ==========================================================================
  // Navigation / Jump
  // ==========================================================================
  const flashHighlight = useCallback((id) => {
    clearTimeout(highlightTimer.current)
    setHighlightId(id)
    highlightTimer.current = setTimeout(() => setHighlightId(null), 800)
    // Scroll to target after React renders
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-id="${id}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }, [])

  const jumpToSub = useCallback((subId) => {
    if (viewMode === 'detail') {
      setPerspective('sub')
      setSelectedId(subId)
    } else {
      setColSelectedSub(subId)
      setColSelectedRes(null)
    }
    flashHighlight(subId)
  }, [viewMode, flashHighlight])

  const jumpToRes = useCallback((resId) => {
    if (viewMode === 'detail') {
      setPerspective('res')
      setSelectedId(resId)
    } else {
      setColSelectedRes(resId)
      const res = resList.find(r => r.id === resId)
      if (res) {
        setColHighlightSubs(new Set(res.subIds))
        setTimeout(() => setColHighlightSubs(new Set()), 800)
      }
      setColHighlightRes(new Set([resId]))
      setTimeout(() => setColHighlightRes(new Set()), 800)
    }
    flashHighlight(resId)
  }, [viewMode, resList, flashHighlight])

  // ==========================================================================
  // Stats
  // ==========================================================================
  const stats = useMemo(() => {
    const subTotal = subList.length
    const resTotal = resList.length
    const subComplete = subList.filter(s => s.state === 5).length
    const subDownloading = subList.filter(s => s.state === 3).length
    const totalSize = subList.reduce((acc, s) => acc + (s.totalSize || 0), 0)
    const totalDl = subList.reduce((acc, s) => acc + (s.dlSize || 0), 0)
    return { subTotal, resTotal, subComplete, subDownloading, totalSize, totalDl }
  }, [subList, resList])

  // ==========================================================================
  // Render guards
  // ==========================================================================
  if (!selectedClient) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--coffee-muted)]">
        <Package size={48} strokeWidth={1} className="mb-3 opacity-40" />
        <span className="text-sm">请选择客户端</span>
      </div>
    )
  }

  // ==========================================================================
  // Render: Toolbar
  // ==========================================================================
  const renderToolbar = () => (
    <div className="flex items-center gap-1.5">
      {/* Left: title + connection dot */}
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />
      <span className="text-sm font-semibold text-[var(--coffee-deep)] mr-1">分包监控</span>

      {/* Search */}
      <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
        placeholder="搜索 SubId / ResId / 文件名..."
        className="flex-1 min-w-[120px] max-w-[240px] px-2 py-1 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]" />

      {/* State filter */}
      <div className="relative">
        <button onClick={() => setShowFilterDrop(v => !v)}
          className="flex items-center gap-1 px-1.5 py-1 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 hover:border-[var(--caramel)] transition-colors">
          <Filter size={11} />
          {(stateFilter.size < 6 || onlyShared) && <span className="text-[var(--caramel)] font-semibold text-[10px]">{stateFilter.size < 6 ? stateFilter.size : ''}{onlyShared ? '✦' : ''}</span>}
        </button>
        {showFilterDrop && (
          <div className="absolute top-full left-0 mt-1 z-50 p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--cream-soft)] shadow-lg min-w-[120px]"
            onClick={e => e.stopPropagation()}>
            {Object.entries(STATE_CONFIG).map(([val, cfg]) => (
              <label key={val} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--cream-warm)] cursor-pointer text-xs">
                <input type="checkbox" checked={stateFilter.has(Number(val))}
                  onChange={() => {
                    const num = Number(val)
                    const n = new Set(stateFilter)
                    n.has(num) ? n.delete(num) : n.add(num)
                    setStateFilter(n)
                  }}
                  className="rounded" />
                <span style={{ color: cfg.color }}>{cfg.label}</span>
              </label>
            ))}
            <div className="border-t border-[var(--glass-border)] mt-1 pt-1 flex gap-1">
              <button onClick={() => setStateFilter(new Set(ALL_STATES))} className="text-[10px] text-[var(--sky)] hover:underline">全选</button>
              <button onClick={() => setStateFilter(new Set())} className="text-[10px] text-[var(--terracotta)] hover:underline">清空</button>
            </div>
            {perspective === 'res' && (
              <label className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--cream-warm)] cursor-pointer text-xs border-t border-[var(--glass-border)] mt-1 pt-1">
                <input type="checkbox" checked={onlyShared} onChange={() => setOnlyShared(v => !v)} className="rounded" />
                <span className="text-[var(--sky)]">仅共享 Res</span>
              </label>
            )}
          </div>
        )}
      </div>

      {/* View mode toggle */}
      <div className="flex rounded-md border border-[var(--glass-border)] overflow-hidden">
        <button onClick={() => setViewMode('detail')}
          className={`px-1.5 py-1 transition-colors ${viewMode === 'detail' ? 'bg-[var(--caramel)] text-white' : 'bg-white/50 text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}>
          <PanelRight size={12} />
        </button>
        <button onClick={() => setViewMode('columns')}
          className={`px-1.5 py-1 transition-colors ${viewMode === 'columns' ? 'bg-[var(--caramel)] text-white' : 'bg-white/50 text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}>
          <Columns3 size={12} />
        </button>
      </div>

      {/* Right: refresh controls (same style as Hierarchy) */}
      <div className="ml-auto flex items-center gap-0.5 text-[var(--coffee-muted)]" title={`自动刷新间隔 ${refreshInterval}s（设 0 关闭）`}>
        <button onClick={(e) => { if (e.shiftKey) { fetchStructure(); fetchStatus() } else { fetchStatus() } }}
          title="刷新（Shift+点击刷新结构）"
          className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--coffee-deep)] transition-colors">
          <RotateCw size={13} />
        </button>
        <input type="text" inputMode="numeric" value={refreshInterval}
          onChange={e => { const v = parseInt(e.target.value); setRefreshInterval(isNaN(v) ? 0 : Math.max(0, Math.min(60, v))); setAutoRefresh(v > 0) }}
          style={{ width: 24, padding: '0 1px', fontSize: 10, lineHeight: '18px', ...(autoRefresh ? { borderColor: 'var(--sage)', boxShadow: '0 0 3px var(--sage-soft)' } : {}) }} className="h-5 rounded border border-[var(--glass-border)] bg-white/70 text-center font-mono focus:outline-none focus:border-[var(--caramel)] appearance-none"
        /><span className="text-[10px]">s</span>
      </div>
    </div>
  )

  // ==========================================================================
  // Render: Stats overview
  // ==========================================================================
  const renderStats = () => (
    <div className="flex items-center gap-3 text-[11px] text-[var(--coffee-muted)] border-t border-[var(--glass-border)]/50 pt-2">
      <span>Sub <b className="text-[var(--coffee-deep)]">{stats.subTotal}</b></span>
      <span>Res <b className="text-[var(--coffee-deep)]">{stats.resTotal}</b></span>
      <span className="text-[var(--sage)]">完成 <b>{stats.subComplete}</b></span>
      <span className="text-[var(--sky)]">下载中 <b>{stats.subDownloading}</b></span>
      <span className="ml-auto">{formatSize(stats.totalDl)} / {formatSize(stats.totalSize)}</span>
    </div>
  )

  // ==========================================================================
  // Render: Item card (shared by both modes)
  // ==========================================================================
  const cardCls = (isSelected, extraClass, id) =>
    `flex items-center gap-2 px-2 py-1.5 rounded-md border cursor-pointer transition-all duration-150 ${
      isSelected ? 'border-[var(--caramel)] bg-[var(--cream-warm)] shadow-sm' : 'border-transparent hover:border-[var(--glass-border)] hover:bg-white/40'
    } ${highlightId === id ? 'highlight-flash' : ''} ${extraClass}`

  const renderSubCard = (sub, isSelected, onSelect, extraClass = '') => (
    <div key={sub.id} data-id={sub.id} onClick={() => onSelect(sub.id)} className={cardCls(isSelected, extraClass, sub.id)}
      title={sub.missingResCount > 0 ? `缺失索引 ${sub.missingResCount} 个` : undefined}>
      <StateBadge state={sub.state} mini />
      <span className="text-[11px] font-mono font-semibold text-[var(--coffee-deep)] w-11 flex-shrink-0">S{sub.id}</span>
      {sub.name && <span className={`text-[11px] truncate min-w-0 flex-1 ${sub.missingResCount > 0 ? 'font-medium text-[var(--terracotta)]' : 'text-[var(--coffee-light)]'}`}>{sub.name}</span>}
      <div className="w-12 flex-shrink-0"><ProgressBar progress={sub.progress} state={sub.state} mini /></div>
      <span className="text-[10px] text-[var(--coffee-muted)] w-20 text-right flex-shrink-0 whitespace-nowrap">{sizeText(sub.dlSize, sub.totalSize, sub.state)}</span>
    </div>
  )

  const renderResCard = (res, isSelected, onSelect, extraClass = '') => (
    <div key={res.id} data-id={res.id} onClick={() => onSelect(res.id)} className={cardCls(isSelected, extraClass, res.id)}>
      <StateBadge state={res.state} mini />
      <span className="text-[11px] font-mono font-semibold text-[var(--coffee-deep)] w-11 flex-shrink-0">R{res.id}</span>
      {!res.indexed && <span className="text-[10px] font-semibold text-[var(--terracotta)] whitespace-nowrap">无索引</span>}
      <div className="w-12 flex-shrink-0"><ProgressBar progress={res.progress} state={res.state} mini /></div>
      <span className="text-[10px] text-[var(--coffee-muted)] w-20 text-right flex-shrink-0 whitespace-nowrap">{sizeText(res.dlSize, res.totalSize, res.state)}</span>
      <SharedBadge count={res.subIds.length} type="Sub" ids={res.subIds} onJump={jumpToSub} />
    </div>
  )

  // ==========================================================================
  // Render: File table
  // ==========================================================================
  const renderFileTable = (files, compact = false, fileSharedMap = {}) => (
    <div className={`${compact ? '' : 'mt-2'}`}>
      <table className={`w-full text-xs ${compact ? 'table-fixed' : ''}`}>
        <thead>
          <tr className="text-[var(--coffee-muted)] text-[10px]">
            <th className={`text-center py-1 font-medium whitespace-nowrap ${compact ? 'w-5' : 'w-8'}`}>状态</th>
            <th className="text-left py-1 font-medium whitespace-nowrap">文件名</th>
            <th className={`text-right py-1 font-medium whitespace-nowrap ${compact ? 'w-12' : 'w-16'}`}>大小</th>
            <th className={`text-left py-1 font-medium whitespace-nowrap ${compact ? 'w-14 pl-1' : 'w-20 pl-2'}`}>sha1</th>
            <th className={`text-center py-1 font-medium whitespace-nowrap ${compact ? 'w-10' : 'w-16'}`}>共享</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f, i) => {
            const refCount = fileSharedMap[f.name]?.length || 0
            return (
              <tr key={i} className="border-t border-[var(--glass-border)]/50 hover:bg-white/30">
                <td className="py-1 text-center cursor-pointer" title={`${f.exists ? '已存在' : '未下载'}\n点击复制该行信息`}
                  onClick={() => { copyText(`${f.name}  ${f.asset || ''}  ${formatSize(f.size)}  ${f.sha1 || ''}`); setCopiedFile('row_' + i + '_' + f.name); setTimeout(() => setCopiedFile(null), 800) }}>
                  <span className={`inline-block w-2 h-2 rounded-full transition-colors ${copiedFile === 'row_' + i + '_' + f.name ? 'bg-[var(--sky)]' : f.exists ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]'}`} />
                </td>
                <td className={`py-1 font-mono cursor-pointer transition-colors hover:text-[var(--sky)] truncate overflow-hidden ${compact ? '' : 'max-w-[200px]'}`}
                  title={`${f.asset || f.name}\n${f.name}\n点击复制路径`}
                  onClick={() => { copyText(f.asset || f.name); setCopiedFile(f.asset || f.name); setTimeout(() => setCopiedFile(null), 800) }}>
                  {copiedFile === (f.asset || f.name) ? '已复制 ✓' : (() => { const p = f.asset || f.name; const idx = p.lastIndexOf('/'); return idx < 0 ? p : <><span className="text-[var(--coffee-muted)] opacity-50">…/</span><span style={{ color: 'var(--coffee-deep)' }}>{p.slice(idx + 1)}</span></> })()}
                </td>
                <td className="py-1 text-right text-[var(--coffee-muted)] whitespace-nowrap">{formatSize(f.size)}</td>
                <td className={`py-1 font-mono truncate cursor-pointer transition-colors hover:text-[var(--sky)] overflow-hidden ${compact ? 'pl-1' : 'pl-2 max-w-[80px]'}`}
                  style={{ color: copiedSha1 === f.sha1 ? 'var(--sage)' : 'var(--coffee-muted)' }}
                  title={`${f.sha1}\n点击复制`}
                  onClick={() => { copyText(f.sha1); setCopiedSha1(f.sha1); setTimeout(() => setCopiedSha1(null), 800) }}>
                  {copiedSha1 === f.sha1 ? '已复制 ✓' : (compact ? f.sha1?.substring(0, 6) : `${f.sha1?.substring(0, 8)}...`)}
                </td>
                <td className="py-1 text-center">
                  <SharedBadge count={refCount} type="Res" ids={fileSharedMap[f.name]} onJump={jumpToRes} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  // ==========================================================================
  // Mode A: Detail View
  // ==========================================================================
  const renderDetailView = () => {
    const isSub = perspective === 'sub'
    const items = isSub ? filteredSubs : filteredRes
    const selectedItem = isSub
      ? subList.find(s => s.id === selectedId)
      : resList.find(r => r.id === selectedId)
    const selectedMissingResIds = isSub && selectedItem
      ? selectedItem.resIds.filter(rid => resList.find(r => r.id === String(rid))?.indexed === false)
      : []
    const visibleSelectedResIds = onlyMissingRes ? selectedMissingResIds : (selectedItem?.resIds || [])

    const copyMissingResIds = () => {
      if (selectedMissingResIds.length === 0) return
      copyText(selectedMissingResIds.join(', '))
      setCopiedMissingRes(true)
      setTimeout(() => setCopiedMissingRes(false), 900)
    }

    return (
      <div className="flex h-full"
        onMouseMove={e => { if (!isDragging.current) return; const r = e.currentTarget.getBoundingClientRect(); setLeftWidth(clampDetailListWidth(e.clientX - r.left)) }}
        onMouseUp={() => { isDragging.current = false }}
        onMouseLeave={() => { isDragging.current = false }}>

        {/* Left: Item list */}
        <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col overflow-hidden" style={{ width: leftWidth }}>
          {/* Perspective toggle */}
          <div className="p-2 border-b border-[var(--glass-border)] flex">
            <button onClick={() => { setPerspective('sub'); setSelectedId(null) }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-l-lg transition-colors ${isSub ? 'bg-[var(--caramel)] text-white' : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'}`}>
              Sub 视角
            </button>
            <button onClick={() => { setPerspective('res'); setSelectedId(null) }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-r-lg transition-colors ${!isSub ? 'bg-[var(--caramel)] text-white' : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'}`}>
              Res 视角
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {items.length === 0 && (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8">暂无数据</div>
            )}
            {isSub
              ? items.map(sub => renderSubCard(sub, selectedId === sub.id, setSelectedId))
              : items.map(res => renderResCard(res, selectedId === res.id, setSelectedId))
            }
          </div>
        </div>

        {/* Drag handle */}
        <div className="w-1 cursor-col-resize hover:bg-[var(--caramel-light)] transition-colors flex-shrink-0"
          onMouseDown={() => { isDragging.current = true }} />

        {/* Right: Detail panel */}
        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          {!selectedItem ? (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--coffee-muted)]">
              <Package size={32} strokeWidth={1} className="mb-2 opacity-30" />
              <span className="text-xs">{isSub ? '选择一个 SubPackage 查看详情' : '选择一个 Resource 查看详情'}</span>
            </div>
          ) : isSub ? (
            // Sub detail
            <div className="space-y-4 animate-fade-in">
              <div>
                <h3 className="font-display font-bold text-base text-[var(--coffee-deep)] mb-1">
                  Sub {selectedItem.id} {selectedItem.name && `— ${selectedItem.name}`}
                </h3>
                <div className="flex items-center gap-3 mb-2">
                  <StateBadge state={selectedItem.state} />
                  <span className="text-xs text-[var(--coffee-muted)]">{sizeText(selectedItem.dlSize, selectedItem.totalSize, selectedItem.state)}</span>
                </div>
                <ProgressBar progress={selectedItem.progress} state={selectedItem.state} />
              </div>

              {/* Res table */}
              <div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  <h4 className="text-xs font-semibold text-[var(--coffee-deep)] whitespace-nowrap">
                    包含的 Resource ({selectedItem.resIds.length})
                  </h4>
                  {selectedMissingResIds.length > 0 && (
                    <>
                      <button
                        onClick={() => setOnlyMissingRes(v => !v)}
                        className={`inline-flex flex-shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap transition-colors ${
                          onlyMissingRes
                            ? 'border-[var(--terracotta)]/45 bg-[var(--terracotta)]/12 text-[var(--terracotta)]'
                            : 'border-[var(--terracotta)]/25 bg-white/35 text-[var(--terracotta)]/80 hover:bg-[var(--terracotta)]/8 hover:border-[var(--terracotta)]/40'
                        }`}
                        title={onlyMissingRes ? '显示全部 Resource' : '仅显示缺失 Resource'}
                      >
                        <Filter size={9} />
                        缺失 {selectedMissingResIds.length}
                        {onlyMissingRes && <X size={9} />}
                      </button>
                      <button
                        onClick={copyMissingResIds}
                        className="p-1 rounded text-[var(--coffee-muted)] hover:text-[var(--terracotta)] hover:bg-[var(--terracotta)]/8 transition-colors"
                        title={`复制 ${selectedMissingResIds.length} 个缺失 ResId`}
                        aria-label="复制缺失 ResId"
                      >
                        {copiedMissingRes ? <span className="text-[10px] font-semibold text-[var(--sage)]">✓</span> : <Copy size={10} />}
                      </button>
                    </>
                  )}
                </div>
                <div className="space-y-1">
                  {visibleSelectedResIds.map(rid => {
                    const res = resList.find(r => r.id === String(rid))
                    if (!res) return null
                    const isMissing = !res.indexed
                    const isExpanded = expandedRes.has(res.id)
                    return (
                      <div key={res.id}>
                        <div className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                          isExpanded ? 'bg-[var(--cream-warm)]' : 'hover:bg-white/40'
                        }`} onClick={() => { setExpandedRes(prev => { const next = new Set(prev); if (next.has(res.id)) next.delete(res.id); else { next.add(res.id); fetchResFiles(res.id) } return next }) }}>
                          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="text-xs font-mono font-semibold">Res {res.id}</span>
                          {isMissing
                            ? <span className="px-1.5 py-0.5 rounded-full bg-[var(--terracotta)]/10 text-[10px] font-semibold text-[var(--terracotta)]">缺索引</span>
                            : <StateBadge state={res.state} />}
                          <div className="flex-1" />
                          {!isMissing && <span className="text-[10px] text-[var(--coffee-muted)]">{formatSize(res.dlSize)} / {formatSize(res.totalSize)}</span>}
                          {resFiles[res.id]?.files?.length > 0 && (
                            <button onClick={e => { e.stopPropagation(); copyText(formatFilesText(resFiles[res.id].files)); setCopiedFile('res_' + res.id); setTimeout(() => setCopiedFile(null), 800) }}
                              className="p-0.5 rounded hover:bg-black/5 text-[var(--coffee-muted)] hover:text-[var(--sky)] transition-colors" title="复制文件列表">
                              {copiedFile === 'res_' + res.id ? <span className="text-[10px] text-[var(--sage)]">✓</span> : <Copy size={10} />}
                            </button>
                          )}
                          <SharedBadge count={res.subIds.length} type="Sub" ids={res.subIds} onJump={jumpToSub} />
                        </div>
                        {isExpanded && (
                          <div className="ml-5 mt-1 mb-2 p-2 rounded-lg bg-white/30">
                            <div className="mb-1.5"><ProgressBar progress={res.progress} state={res.state} /></div>
                            {resFilesLoading[res.id]
                              ? <div className="text-center text-xs text-[var(--coffee-muted)] py-2"><RotateCw size={12} className="inline animate-spin mr-1" />加载文件列表...</div>
                              : resFiles[res.id] ? renderFileTable(resFiles[res.id].files, true, resFiles[res.id].sharedFiles)
                              : <div className="text-center text-xs text-[var(--coffee-muted)] py-2">点击展开加载文件</div>
                            }
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : (
            // Res detail
            <div className="space-y-4 animate-fade-in">
              <div>
                <h3 className="font-display font-bold text-base text-[var(--coffee-deep)] mb-1">Res {selectedItem.id}</h3>
                <div className="flex items-center gap-3 mb-2">
                  <StateBadge state={selectedItem.state} />
                  {selectedItem.tgState > 0 && (
                    <span className="text-[10px] text-[var(--coffee-muted)]">TaskGroup: {selectedItem.tgState}</span>
                  )}
                  <span className="text-xs text-[var(--coffee-muted)]">{sizeText(selectedItem.dlSize, selectedItem.totalSize, selectedItem.state)}</span>
                </div>
                <ProgressBar progress={selectedItem.progress} state={selectedItem.state} />
              </div>

              {/* Parent Subs */}
              <div>
                <h4 className="text-xs font-semibold text-[var(--coffee-deep)] mb-2">
                  所属 SubPackage ({selectedItem.subIds.length})
                </h4>
                <div className="space-y-1">
                  {selectedItem.subIds.map(sid => {
                    const sub = subList.find(s => s.id === String(sid))
                    if (!sub) return null
                    return (
                      <div key={sub.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-white/40 transition-colors">
                        <span className="text-xs font-mono font-semibold">Sub {sub.id}</span>
                        {sub.name && <span className="text-xs text-[var(--coffee-light)] truncate">{sub.name}</span>}
                        <StateBadge state={sub.state} />
                        <div className="flex-1" />
                        <button onClick={() => jumpToSub(sub.id)}
                          className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--sky)] transition-colors">
                          <ExternalLink size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Files */}
              <div>
                <h4 className="text-xs font-semibold text-[var(--coffee-deep)] mb-2 flex items-center gap-2">
                  文件列表 ({selectedItem.fileCount})
                  {!resFiles[selectedItem.id] && !resFilesLoading[selectedItem.id] && (
                    <button onClick={() => fetchResFiles(selectedItem.id)}
                      className="text-[10px] text-[var(--sky)] hover:underline">加载文件</button>
                  )}
                  {resFiles[selectedItem.id]?.files?.length > 0 && (
                    <button onClick={() => { copyText(formatFilesText(resFiles[selectedItem.id].files)); setCopiedFile('detail_res'); setTimeout(() => setCopiedFile(null), 800) }}
                      className="p-0.5 rounded hover:bg-black/5 text-[var(--coffee-muted)] hover:text-[var(--sky)] transition-colors" title="复制文件列表">
                      {copiedFile === 'detail_res' ? <span className="text-[10px] text-[var(--sage)]">已复制 ✓</span> : <Copy size={11} />}
                    </button>
                  )}
                </h4>
                {resFilesLoading[selectedItem.id]
                  ? <div className="text-center text-xs text-[var(--coffee-muted)] py-4"><RotateCw size={14} className="inline animate-spin mr-1" />加载中...</div>
                  : resFiles[selectedItem.id] ? renderFileTable(resFiles[selectedItem.id].files, false, resFiles[selectedItem.id].sharedFiles)
                  : <div className="text-center text-xs text-[var(--coffee-muted)] py-4">点击"加载文件"查看文件详情</div>
                }
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ==========================================================================
  // Mode B: Columns View
  // ==========================================================================
  const renderColumnsView = () => {
    // Filtered res by selected sub
    const colResList = colSelectedSub
      ? filteredRes.filter(r => {
          const sub = subList.find(s => s.id === colSelectedSub)
          return sub?.resIds?.includes(r.id)
        })
      : filteredRes

    // Files by selected res (on-demand loaded)
    const colResData = colSelectedRes ? resFiles[colSelectedRes] : null
    const colFiles = colResData?.files || []
    const colSharedFiles = colResData?.sharedFiles || {}

    return (
      <div className="flex h-full gap-0">
        {/* Sub column */}
        <div className="flex-1 min-w-0 border-r border-[var(--glass-border)] flex flex-col">
          <div className="p-2 border-b border-[var(--glass-border)] flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--coffee-deep)]">SubPackage</span>
            <span className="text-[10px] text-[var(--coffee-muted)]">({filteredSubs.length})</span>
            {colSelectedSub && (
              <button onClick={() => { setColSelectedSub(null); setColSelectedRes(null) }}
                className="ml-auto text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={12} /></button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSubs.map(sub => renderSubCard(
              sub, colSelectedSub === sub.id,
              (id) => { setColSelectedSub(id === colSelectedSub ? null : id); setColSelectedRes(null) },
              colHighlightSubs.has(sub.id) ? 'ring-2 ring-[var(--sky)]' : ''
            ))}
          </div>
        </div>

        {/* Res column */}
        <div className="flex-1 min-w-0 border-r border-[var(--glass-border)] flex flex-col">
          <div className="p-2 border-b border-[var(--glass-border)] flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--coffee-deep)]">Resource</span>
            <span className="text-[10px] text-[var(--coffee-muted)]">({colResList.length})</span>
            {colSelectedSub && (
              <span className="text-[10px] text-[var(--sky)]">← Sub {colSelectedSub}</span>
            )}
            {colSelectedRes && (
              <button onClick={() => setColSelectedRes(null)}
                className="ml-auto text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={12} /></button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {colResList.length === 0 && (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8">
                {colSelectedSub ? '该 Sub 无匹配 Resource' : '暂无数据'}
              </div>
            )}
            {colResList.map(res => renderResCard(
              res, colSelectedRes === res.id,
              (id) => {
                const next = id === colSelectedRes ? null : id
                setColSelectedRes(next)
                if (next) fetchResFiles(next)
                const r = resList.find(x => x.id === id)
                if (r) { setColHighlightSubs(new Set(r.subIds.map(String))); setTimeout(() => setColHighlightSubs(new Set()), 800) }
              },
              colHighlightRes.has(res.id) ? 'ring-2 ring-[var(--sky)]' : ''
            ))}
          </div>
        </div>

        {/* File column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-2 border-b border-[var(--glass-border)] flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--coffee-deep)]">Files</span>
            <span className="text-[10px] text-[var(--coffee-muted)]">({colFiles.length})</span>
            {colSelectedRes && (
              <span className="text-[10px] text-[var(--sky)]">← Res {colSelectedRes}</span>
            )}
            {colFiles.length > 0 && (
              <button onClick={() => { copyText(formatFilesText(colFiles)); setCopiedFile('col_files'); setTimeout(() => setCopiedFile(null), 800) }}
                className="p-0.5 rounded hover:bg-black/5 text-[var(--coffee-muted)] hover:text-[var(--sky)] transition-colors" title="复制文件列表">
                {copiedFile === 'col_files' ? <span className="text-[10px] text-[var(--sage)]">已复制 ✓</span> : <Copy size={11} />}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {!colSelectedRes ? (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8">请选择一个 Resource 查看文件</div>
            ) : resFilesLoading[colSelectedRes] ? (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8"><RotateCw size={12} className="inline animate-spin mr-1" />加载中...</div>
            ) : colFiles.length === 0 && !colResData ? (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8">加载中...</div>
            ) : colFiles.length === 0 ? (
              <div className="text-center text-xs text-[var(--coffee-muted)] py-8">该 Resource 无文件</div>
            ) : (
              renderFileTable(colFiles, true, colSharedFiles)
            )}
          </div>
        </div>
      </div>
    )
  }

  // ==========================================================================
  // Main render
  // ==========================================================================
  return (
    <div className="space-y-3" onClick={() => showFilterDrop && setShowFilterDrop(false)}>
      {/* Toolbar + Stats (merged) */}
      <div className="glass-card p-3 space-y-2">
        {renderToolbar()}
        {structure && renderStats()}
      </div>

      {/* Main content */}
      <div className="glass-card overflow-hidden" style={{ height: 'calc(100vh - 220px)', minHeight: 400 }}>
        {!structure ? (
          <div className="flex flex-col items-center justify-center py-16 text-[var(--coffee-muted)]">
            <RotateCw size={24} className="animate-spin mb-3 opacity-40" />
            <span className="text-xs">等待数据...</span>
          </div>
        ) : viewMode === 'detail' ? renderDetailView() : renderColumnsView()}
      </div>

    </div>
  )
}

export default memo(SubPackageMonitor)
