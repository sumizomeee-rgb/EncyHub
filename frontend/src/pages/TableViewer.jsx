import { useState, useEffect, useRef, useCallback, useMemo, Fragment, memo } from 'react'
import {
  Search, RefreshCw, Loader2, Table2, ChevronLeft, ChevronRight, ChevronDown,
  Star, Eye, ArrowUpDown, ArrowUp, ArrowDown, X
} from 'lucide-react'

const API = '/api/gm_console'
const PAGE_SIZES = [20, 50, 100]
const SCHEMA_COL_DEFAULTS = { field: 145, type: 88, key: 48, collection: 118 }
const QUICK_LIST_PREVIEW_LIMIT = 10
const COLUMN_TINTS = [
  '123, 163, 201', // sky
  '125, 155, 118', // sage
  '212, 165, 116', // caramel
  '193, 102, 107', // terracotta
  '232, 163, 23',  // amber
  '139, 125, 114', // coffee
]

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function defaultDataColWidth(fieldDef) {
  const nameLen = fieldDef?.name?.length || 8
  if (fieldDef?.primaryKey) return clamp(nameLen * 8 + 42, 92, 180)
  if (fieldDef?.collectionType) return clamp(nameLen * 8 + 56, 150, 260)
  const vt = fieldDef?.valueType
  if (vt === 'bool') return clamp(nameLen * 8 + 34, 72, 120)
  if (vt === 'int' || vt === 'float' || vt === 'fix') return clamp(nameLen * 8 + 38, 88, 150)
  return clamp(nameLen * 8 + 56, 140, 280)
}

function formatSize(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function stripPrefix(name) {
  if (name.startsWith('XTable')) return name.slice(6)
  return name
}

function columnTint(index, alpha = 0.06) {
  return `rgba(${COLUMN_TINTS[index % COLUMN_TINTS.length]}, ${alpha})`
}

function humanStatsReason(reason) {
  const map = {
    'BinaryConfigMonitor disabled': '宏未开启',
    'PerformanceMonitorAgent not exposed to Lua': 'Reader 未暴露给 Lua',
    'BinaryConfigMonitor reader not ready': 'Reader 未就绪',
    'GetBinaryConfigMonitorReader failed': 'Reader 获取失败',
    'IsBinaryConfigMonitorReady failed': 'Ready 检查失败',
    'BinaryConfigSourceType unavailable': 'SourceType 不可用',
  }
  return map[reason] || reason || '等待游戏端返回状态'
}

function useLocalStorage(key, def) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s != null ? JSON.parse(s) : def } catch { return def }
  })
  const set = useCallback(v => {
    setVal(prev => {
      const resolved = typeof v === 'function' ? v(prev) : v
      try { localStorage.setItem(key, JSON.stringify(resolved)) } catch {}
      return resolved
    })
  }, [key])
  return [val, set]
}

function TableViewer({ clients, selectedClient, broadcastMode, active }) {
  // --- state ---
  const [tableList, setTableList] = useState([])
  const [stats, setStats] = useState(null)
  const [selectedTable, setSelectedTable] = useState(null)
  const [schema, setSchema] = useState(null)
  const [rows, setRows] = useState(null)
  const [totalRows, setTotalRows] = useState(0)
  const [matchedRows, setMatchedRows] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useLocalStorage('table_monitor_page_size', 50)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [loadedByViewer, setLoadedByViewer] = useState(false)
  const [tableSearch, setTableSearch] = useState('')
  const [dataSearch, setDataSearch] = useState('')
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState('asc')
  const [selectedRow, setSelectedRow] = useState(null)
  const [loading, setLoading] = useState(false)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [showStats, setShowStats] = useLocalStorage('table_monitor_show_stats', false)
  const [loadedOnly, setLoadedOnly] = useLocalStorage('table_monitor_loaded_only', false)
  const [favorites, setFavorites] = useLocalStorage('table_monitor_favorites', [])
  const [recents, setRecents] = useLocalStorage('table_monitor_recents', [])
  const [showDropdown, setShowDropdown] = useState(false)
  const [showAllQuickItems, setShowAllQuickItems] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useLocalStorage('table_monitor_sidebar_width', 240)
  const [schemaColWidths, setSchemaColWidths] = useLocalStorage('table_monitor_schema_col_widths', SCHEMA_COL_DEFAULTS)
  const [dataColWidths, setDataColWidths] = useLocalStorage('table_monitor_data_col_widths', {})

  const wsRef = useRef(null)
  const activeRef = useRef(active)
  const searchInputRef = useRef(null)
  const dropdownRef = useRef(null)
  const dataSearchTimerRef = useRef(null)
  const resizingRef = useRef(false)
  const colResizeRef = useRef(null)

  activeRef.current = active

  const clientId = selectedClient?.id

  // --- WS lifecycle ---
  useEffect(() => {
    if (!clientId || !active) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setWsConnected(false)
      return
    }

    let closed = false
    const capturedClientId = clientId
    const sendCmd = (action, params = {}) => {
      fetch(`${API}/table_monitor/${capturedClientId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...params }),
      }).catch(() => {})
    }

    const connect = () => {
      if (closed) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/api/gm_console/ws/table_monitor`)
      wsRef.current = ws
      let hb = null

      ws.onopen = () => {
        setWsConnected(true)
        sendCmd('start')
        sendCmd('list_tables')
        hb = setInterval(() => { if (ws.readyState === 1) ws.send('ping') }, 30000)
      }
      ws.onmessage = (e) => {
        if (!activeRef.current) return
        try {
          const msg = JSON.parse(e.data)
          handleWsMessage(msg)
        } catch {}
      }
      ws.onclose = () => {
        if (hb) clearInterval(hb)
        setWsConnected(false)
        wsRef.current = null
        if (!closed) setTimeout(connect, 2000)
      }
      ws.onerror = () => { ws.close() }
    }

    connect()

    return () => {
      closed = true
      if (dataSearchTimerRef.current) clearTimeout(dataSearchTimerRef.current)
      sendCmd('stop')
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [clientId, active])

  function sendCommand(action, params = {}) {
    if (!clientId) return
    fetch(`${API}/table_monitor/${clientId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    }).catch(() => {})
  }

  function handleWsMessage(msg) {
    const { type, data, error } = msg
    const respError = error || data?.error
    if (respError) { console.warn('[TableViewer]', type, respError); setLoading(false); setSchemaLoading(false); return }

    if (type === 'list_tables') {
      setTableList((data?.tables || []).filter(t => t?.pathFound !== false))
      setStats(data?.stats || null)
    } else if (type === 'get_schema') {
      setSchema(data)
      setSchemaLoading(false)
    } else if (type === 'get_data') {
      setRows(data?.rows || [])
      setTotalRows(data?.totalRows || 0)
      setMatchedRows(data?.matchedRows || 0)
      setPage(data?.page || 1)
      setLoadedByViewer(data?.loadedByViewer || false)
      if (data?.stats) setStats(data.stats)
      setDataLoaded(true)
      setLoading(false)
    }
  }

  // --- table selection ---
  function selectTable(tableName) {
    if (tableName === selectedTable) return
    setSelectedTable(tableName)
    setSchema(null)
    setRows(null)
    setDataLoaded(false)
    setDataSearch('')
    setSortField('')
    setSortDir('asc')
    setSelectedRow(null)
    setSchemaLoading(true)
    sendCommand('get_schema', { tableName })
    addRecent(tableName)
  }

  function getDataColWidth(fieldName, fieldDef) {
    const tableWidths = dataColWidths[selectedTable] || {}
    return tableWidths[fieldName] || defaultDataColWidth(fieldDef)
  }

  function addRecent(name) {
    setRecents(prev => {
      const filtered = prev.filter(n => n !== name)
      return [name, ...filtered].slice(0, 20)
    })
  }

  function toggleFavorite(name) {
    setFavorites(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  function removeRecentItem(name) {
    setRecents(prev => prev.filter(n => n !== name))
  }

  const tableNameSet = useMemo(() => new Set(tableList.map(t => t.name)), [tableList])
  const availableFavorites = useMemo(() => favorites.filter(name => tableNameSet.has(name)), [favorites, tableNameSet])
  const availableRecents = useMemo(() => recents.filter(name => tableNameSet.has(name)), [recents, tableNameSet])
  const unavailableFavoriteCount = favorites.length - availableFavorites.length

  function clearUnavailableFavorites() {
    setFavorites(prev => prev.filter(name => tableNameSet.has(name)))
  }

  // --- data loading ---
  function loadData(p = 1, search = dataSearch, sf = sortField, sd = sortDir, ps = pageSize) {
    setLoading(true)
    setSelectedRow(null)
    sendCommand('get_data', {
      tableName: selectedTable,
      page: p, pageSize: ps,
      search, sortField: sf, sortDir: sd,
    })
  }

  function handleDataSearch(val) {
    setDataSearch(val)
    if (dataSearchTimerRef.current) clearTimeout(dataSearchTimerRef.current)
    dataSearchTimerRef.current = setTimeout(() => {
      if (dataLoaded) loadData(1, val, sortField, sortDir)
    }, 300)
  }

  function handleSort(field) {
    let newField = field, newDir = 'asc'
    if (sortField === field) {
      if (sortDir === 'asc') newDir = 'desc'
      else { newField = ''; newDir = 'asc' }
    }
    setSortField(newField)
    setSortDir(newDir)
    if (dataLoaded) loadData(1, dataSearch, newField, newDir)
  }

  // --- 最近打开下拉 ---
  const dropdownItems = useMemo(() => availableRecents.map(name => ({ name })), [availableRecents])

  useEffect(() => {
    const handler = (e) => {
      if (searchInputRef.current && !searchInputRef.current.contains(e.target) &&
          dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false)
        setShowAllQuickItems(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // --- stats helpers ---
  const statsAvailable = stats?.available === true
  const statsReason = humanStatsReason(stats?.reason || (stats ? 'PerformanceMonitor Reader 不可用' : '等待游戏端返回状态'))
  const getTableStats = useCallback((tableInfo) => {
    if (!statsAvailable || !tableInfo?.path) return null
    const path = tableInfo.path || ''
    const pathNoExt = path.replace(/\.tab$/i, '')
    const fileName = path.split('/').pop()?.replace(/\.tab$/i, '')
    const tableName = tableInfo.name || ''
    const shortName = stripPrefix(tableName)
    const candidates = [path, pathNoExt, tableName, shortName, fileName, fileName ? `XTable${fileName}` : ''].filter(Boolean)
    const pick = (bucket) => {
      if (!bucket || typeof bucket !== 'object') return null
      for (const key of candidates) {
        if (bucket[key]) return bucket[key]
      }
      return null
    }
    return pick(stats?.lua) || pick(stats?.csharp)
  }, [stats, statsAvailable])

  // --- filtered table list ---
  const filteredTables = useMemo(() => {
    let list = tableList
    if (tableSearch) {
      const q = tableSearch.toLowerCase()
      list = list.filter(t => t.name.toLowerCase().includes(q) || stripPrefix(t.name).toLowerCase().includes(q) || (t.path || '').toLowerCase().includes(q))
    }
    if (loadedOnly && statsAvailable) {
      list = list.filter(t => {
        const s = getTableStats(t)
        return !!s
      })
    }
    const sourceOrder = new Map(tableList.map((t, index) => [t.name, index]))
    const favoriteOrder = new Map(availableFavorites.map((name, index) => [name, index]))
    return [...list].sort((a, b) => {
      const aFav = favoriteOrder.has(a.name)
      const bFav = favoriteOrder.has(b.name)
      if (aFav !== bFav) return aFav ? -1 : 1
      if (aFav && bFav) return favoriteOrder.get(a.name) - favoriteOrder.get(b.name)
      return (sourceOrder.get(a.name) ?? 0) - (sourceOrder.get(b.name) ?? 0)
    })
  }, [tableList, tableSearch, loadedOnly, statsAvailable, getTableStats, availableFavorites])

  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth

  // --- sidebar resize ---
  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startW = sidebarWidthRef.current
    const onMove = (ev) => {
      if (!resizingRef.current) return
      setSidebarWidth(Math.min(400, Math.max(180, startW + ev.clientX - startX)))
    }
    const onUp = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const handleColumnResizeStart = useCallback((e, scope, key, currentWidth) => {
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startW = currentWidth
    colResizeRef.current = { scope, key }
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      const nextW = clamp(startW + ev.clientX - startX, scope === 'schema' ? 48 : 64, scope === 'schema' ? 420 : 520)
      if (scope === 'schema') {
        setSchemaColWidths(prev => ({ ...prev, [key]: nextW }))
      } else {
        setDataColWidths(prev => ({
          ...prev,
          [selectedTable]: {
            ...(prev[selectedTable] || {}),
            [key]: nextW,
          },
        }))
      }
    }

    const onUp = () => {
      colResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = prevUserSelect
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [selectedTable, setDataColWidths, setSchemaColWidths])

  const currentTableStats = useMemo(() => {
    if (!statsAvailable || !selectedTable) return null
    return getTableStats(tableList.find(t => t.name === selectedTable))
  }, [statsAvailable, selectedTable, tableList, getTableStats])

  const currentTableInfo = useMemo(() => {
    if (!selectedTable) return null
    return tableList.find(t => t.name === selectedTable) || null
  }, [selectedTable, tableList])

  const visibleDropdownItems = showAllQuickItems
    ? dropdownItems
    : dropdownItems.slice(0, QUICK_LIST_PREVIEW_LIMIT)
  const hiddenDropdownCount = Math.max(0, dropdownItems.length - QUICK_LIST_PREVIEW_LIMIT)

  // --- no client ---
  if (!clientId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--coffee-muted)] opacity-60">
        <Table2 className="w-8 h-8 mr-3 opacity-40" />
        <span>请选择客户端</span>
      </div>
    )
  }

  const totalPages = Math.max(1, Math.ceil((matchedRows || totalRows) / pageSize))
  const schemaWidths = { ...SCHEMA_COL_DEFAULTS, ...(schemaColWidths || {}) }
  const schemaTableWidth = schemaWidths.field + schemaWidths.type + schemaWidths.key + schemaWidths.collection
  const dataTableWidth = Math.max(
    schema?.fields?.reduce((sum, f) => sum + getDataColWidth(f.name, f), 0) || 0,
    760
  )

  // --- render cell ---
  function renderCell(val, fieldDef) {
    if (val == null) return <span className="text-[var(--coffee-muted)] opacity-40">—</span>
    const vt = fieldDef?.valueType
    if (typeof val === 'boolean') return <span className="text-center">{val ? '✓' : '✗'}</span>
    if (Array.isArray(val)) {
      const display = val.length <= 3 ? val.join(', ') : `${val.slice(0, 2).join(', ')}, ...+${val.length - 2}`
      return <span title={val.join(', ')} className="cursor-help">{display}</span>
    }
    if (typeof val === 'object') {
      const entries = Object.entries(val)
      const display = entries.length <= 3
        ? entries.map(([k, v]) => `${k}:${v}`).join(', ')
        : entries.slice(0, 2).map(([k, v]) => `${k}:${v}`).join(', ') + `, ...+${entries.length - 2}`
      return <span title={JSON.stringify(val, null, 2)} className="cursor-help font-mono text-xs">{`{${display}}`}</span>
    }
    if (vt === 'int' || vt === 'float' || vt === 'fix' || typeof val === 'number') {
      return <span className="font-mono text-right block">{val}</span>
    }
    const s = String(val)
    if (s.length > 60) return <span title={s} className="cursor-help">{s.slice(0, 57)}...</span>
    return <span>{s}</span>
  }

  return (
    <div className="flex h-full min-h-0 gap-0 overflow-hidden overscroll-contain" style={{ height: 'calc(100vh - 260px)', minHeight: 360 }}>
      {/* === Sidebar === */}
      <div className="flex flex-col border-r border-[var(--cream-warm)] overflow-hidden" style={{ width: sidebarWidth, minWidth: 180, flexShrink: 0 }}>
        {/* Search */}
        <div className="p-2 border-b border-[var(--cream-warm)] relative">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)] pointer-events-none" />
            <input
              ref={searchInputRef}
              className="w-full py-1 text-xs bg-white/50 border border-[var(--cream-warm)] rounded-md focus:border-[var(--caramel)] focus:outline-none transition-colors"
              style={{ paddingLeft: '1.75rem', paddingRight: tableSearch ? '1.5rem' : '0.5rem' }}
              placeholder="搜索表名..."
              value={tableSearch}
              onChange={e => setTableSearch(e.target.value)}
              onFocus={() => dropdownItems.length > 0 && setShowDropdown(true)}
            />
            {tableSearch && (
              <button onClick={() => setTableSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)] hover:text-[var(--coffee)]">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {/* 最近打开下拉 */}
          {showDropdown && dropdownItems.length > 0 && !tableSearch && (
            <div ref={dropdownRef} className="absolute left-2 right-2 top-full mt-1 bg-white border border-[var(--cream-warm)] rounded-lg shadow-lg z-20 overflow-hidden">
              <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
                {visibleDropdownItems.map(item => (
                <div
                  key={item.name}
                  className="group/quick flex items-center gap-2 px-2 py-1 text-xs hover:bg-[var(--cream-warm)] transition-colors"
                >
                  <button
                    className="flex-1 min-w-0 text-left flex items-center gap-2"
                    title={item.name}
                    onClick={() => { selectTable(item.name); setShowDropdown(false); setShowAllQuickItems(false) }}
                  >
                    <span className="text-[8px] shrink-0 text-[var(--coffee-muted)] bg-[var(--cream-warm)] rounded px-1">recent</span>
                    <span className="truncate">{stripPrefix(item.name)}</span>
                  </button>
                  <button
                    className="shrink-0 p-1 rounded text-[var(--coffee-muted)] opacity-60 hover:opacity-100 hover:text-[var(--terracotta)] hover:bg-white/70"
                    title="从最近打开移除"
                    onClick={(e) => { e.stopPropagation(); removeRecentItem(item.name) }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                ))}
              </div>
              {hiddenDropdownCount > 0 && (
                <button
                  className="w-full border-t border-[var(--cream-warm)] px-3 py-1.5 text-[10px] text-[var(--coffee-muted)] hover:text-[var(--coffee)] hover:bg-[var(--cream-warm)]/60 transition-colors"
                  onClick={() => setShowAllQuickItems(v => !v)}
                >
                  {showAllQuickItems ? '收起' : `展开更多 ${hiddenDropdownCount} 项`}
                </button>
              )}
            </div>
          )}
          {statsAvailable && (
            <label className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--coffee-muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-3 h-3 accent-[var(--caramel)]"
                checked={loadedOnly}
                onChange={e => setLoadedOnly(e.target.checked)}
              />
              <span>仅已加载</span>
              <span className="ml-auto">{stats?.summary?.luaCount || 0} Lua / {stats?.summary?.csharpCount || 0} C#</span>
            </label>
          )}
          {!statsAvailable && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--coffee-muted)]" title={statsReason}>
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--coffee-muted)]/45 shrink-0" />
              <span className="truncate">Stats 不可用 · {statsReason}</span>
            </div>
          )}
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto overscroll-contain min-h-0">
          {unavailableFavoriteCount > 0 && (
            <div className="mx-2 my-2 rounded-md border border-[var(--cream-warm)] bg-white/55 px-2 py-1.5 text-[10px] text-[var(--coffee-muted)]">
              <div className="flex items-center gap-2">
                <Star className="w-3 h-3 shrink-0 text-[var(--caramel)]" />
                <span className="min-w-0 flex-1 truncate" title={`${unavailableFavoriteCount} 个收藏表不在当前客户端表列表中`}>
                  {unavailableFavoriteCount} 个收藏当前不可用
                </span>
                <button
                  className="shrink-0 rounded px-1 py-0.5 hover:bg-[var(--cream-warm)] hover:text-[var(--coffee)]"
                  onClick={clearUnavailableFavorites}
                  title="清理当前客户端不存在的收藏"
                >
                  清理
                </button>
              </div>
            </div>
          )}
          {filteredTables.map(t => {
            const isSel = t.name === selectedTable
            const isFav = favorites.includes(t.name)
            const tableStats = getTableStats(t)
            const isLoaded = !!tableStats
            return (
              <div
                key={t.name}
                className={`group px-2 py-1 cursor-pointer border-l-2 transition-colors text-xs leading-tight ${isSel ? 'border-[var(--caramel)] bg-[var(--cream-warm)]' : 'border-transparent hover:bg-[var(--cream-warm)]/50'}`}
                onClick={() => selectTable(t.name)}
                title={`${t.name}${t.path ? `\n${t.path}` : ''}`}
              >
                <div className="flex items-center gap-1">
                  {statsAvailable && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isLoaded ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/35'}`} />}
                  <span className="font-medium truncate flex-1 min-w-0">{stripPrefix(t.name)}</span>
                  <button
                    className={`shrink-0 transition-opacity ${isFav ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(t.name) }}
                  >
                    <Star className={`w-2.5 h-2.5 ${isFav ? 'text-[var(--caramel)] fill-[var(--caramel)]' : 'text-[var(--coffee-muted)]'}`} />
                  </button>
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-[9px] text-[var(--coffee-muted)]">
                  <span className="truncate min-w-0">{t.path || 'path missing'}</span>
                  <span className="whitespace-nowrap shrink-0">{tableStats ? `${tableStats.readRows || 0}/${tableStats.rows || 0}` : `${t.fieldCount}f`}{!t.hasPK ? ' ·nk' : ''}{t.pkIsString ? ' ·sk' : ''}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Bottom stats */}
        <div className="px-3 py-1.5 border-t border-[var(--cream-warm)] text-[10px] text-[var(--coffee-muted)] flex items-center justify-between">
          <span>{filteredTables.length} / {tableList.length} 表</span>
          <div className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-[var(--sage)]' : 'bg-red-400'}`} />
            <button onClick={() => sendCommand('list_tables')} className="hover:text-[var(--coffee)]" title="刷新表列表">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* === Resize handle === */}
      <div className="w-1 cursor-col-resize hover:bg-[var(--caramel)]/30 transition-colors flex-shrink-0" onMouseDown={handleResizeStart} />

      {/* === Main panel === */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!selectedTable ? (
          /* Global stats or placeholder */
          <div className="flex-1 flex items-center justify-center text-[var(--coffee-muted)]">
            {statsAvailable && stats?.summary ? (
              <div className="w-full max-w-xl p-6">
                <h3 className="text-sm font-semibold mb-4 text-[var(--coffee)]">配表运行时统计</h3>
                <div className="grid grid-cols-4 gap-3 mb-6">
                  {[
                    ['Lua 表数', stats.summary.luaCount],
                    ['C# 表数', stats.summary.csharpCount],
                    ['总内存', formatSize(stats.summary.totalMemory)],
                    ['总行数', stats.summary.totalRows?.toLocaleString()],
                  ].map(([label, val]) => (
                    <div key={label} className="glass-card p-3 text-center">
                      <div className="text-lg font-display text-[var(--coffee)]">{val}</div>
                      <div className="text-[10px] text-[var(--coffee-muted)]">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-[var(--coffee-muted)] text-center">选择左侧表查看 Schema 和数据</div>
              </div>
            ) : (
              <div className="text-center opacity-60">
                <Table2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <div className="text-xs">请在左侧选择一个配表</div>
                {!statsAvailable && stats && (
                  <div className="mt-2 text-[10px]" title={statsReason}>Stats: {statsReason}</div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Selected table view */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--cream-warm)] bg-white/30 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-sm text-[var(--coffee)] truncate max-w-[360px]" title={selectedTable}>{selectedTable}</span>
                <span className="text-[10px] text-[var(--coffee-muted)]">{schema?.fields?.length || '?'} fields</span>
                {currentTableInfo?.path && <span className="text-[10px] text-[var(--coffee-muted)] truncate max-w-[280px]" title={currentTableInfo.path}>{currentTableInfo.path}</span>}
                {loadedByViewer && (
                  <Eye
                    className="w-3 h-3 shrink-0 text-[var(--caramel)]"
                    title="PerformanceMonitor 记录显示：这张表在打开 Viewer 前还没有被业务代码读过，本次数据加载由 Table Viewer 触发。"
                  />
                )}
              </div>
              <div className="flex items-center gap-2">
                {statsAvailable ? (
                  <button
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${showStats ? 'bg-[var(--caramel)]/10 border-[var(--caramel)] text-[var(--caramel)]' : 'border-[var(--cream-warm)] text-[var(--coffee-muted)]'}`}
                    onClick={() => setShowStats(!showStats)}
                  >Stats</button>
                ) : (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--cream-warm)] text-[var(--coffee-muted)] bg-white/30 truncate max-w-[180px]"
                    title={statsReason}
                  >
                    Stats off · {statsReason}
                  </span>
                )}
                {!dataLoaded ? (
                  <button
                    className="text-xs px-3 py-1 rounded-md bg-[var(--caramel)] text-white hover:bg-[var(--caramel-dark)] transition-colors disabled:opacity-50"
                    onClick={() => loadData(1)}
                    disabled={loading || !schema}
                  >
                    {loading ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
                    加载数据
                  </button>
                ) : (
                  <button
                    className="text-xs px-2 py-1 rounded-md border border-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee)] hover:border-[var(--caramel)] transition-colors"
                    onClick={() => { setDataLoaded(false); setRows(null); setDataSearch(''); setSortField(''); loadData(1, '', '', 'asc') }}
                  >
                    <RefreshCw className="w-3 h-3 inline mr-1" />重新加载
                  </button>
                )}
              </div>
            </div>

            {/* Stats bar (optional) */}
            {showStats && statsAvailable && currentTableStats && (
              <div className="flex items-center gap-4 px-4 py-1.5 border-b border-[var(--cream-warm)] bg-[var(--cream-warm)]/30 text-[10px] flex-shrink-0 overflow-x-auto">
                <span><b>{currentTableStats.rows}</b> 总行</span>
                <span className={currentTableStats.readRows < currentTableStats.rows ? 'text-[var(--caramel)]' : ''}>
                  <b>{currentTableStats.readRows}</b> 已读
                </span>
                <span><b>{formatSize(currentTableStats.totalSize)}</b></span>
                {loadedByViewer && <span className="text-[var(--caramel)]">Viewer 触发加载</span>}
                {currentTableStats.module && <span>模块: {currentTableStats.module}</span>}
                {currentTableStats.tabScope && <span>作用域: {currentTableStats.tabScope}</span>}
              </div>
            )}

            {/* Schema */}
            {schemaLoading ? (
              <div className="flex items-center justify-center py-8 flex-shrink-0"><Loader2 className="w-5 h-5 animate-spin text-[var(--caramel)]" /></div>
            ) : schema ? (
              <div className="border-b border-[var(--cream-warm)] overflow-auto overscroll-contain flex-shrink-0" style={{ maxHeight: dataLoaded ? 150 : 400, scrollbarGutter: 'stable' }}>
                <table className="text-xs table-fixed border-collapse" style={{ width: schemaTableWidth }}>
                  <colgroup>
                    <col style={{ width: schemaWidths.field }} />
                    <col style={{ width: schemaWidths.type }} />
                    <col style={{ width: schemaWidths.key }} />
                    <col style={{ width: schemaWidths.collection }} />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-[10px] text-[var(--coffee-muted)] border-b border-[var(--cream-warm)]">
                      {[
                        ['field', 'Field'],
                        ['type', 'Type'],
                        ['key', 'Key'],
                        ['collection', 'Collection'],
                      ].map(([key, label]) => (
                        <th
                          key={key}
                          className={`relative px-2 py-1 font-medium ${key === 'key' ? 'text-center' : ''}`}
                          style={{ backgroundColor: columnTint(['field', 'type', 'key', 'collection'].indexOf(key), 0.13) }}
                          title={key === 'key' ? 'Primary Key — 该字段是表的唯一索引键' : undefined}
                        >
                          <span className="truncate block">{label}</span>
                          <span
                            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--caramel)]/30"
                            onMouseDown={(e) => handleColumnResizeStart(e, 'schema', key, schemaWidths[key])}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {schema.fields?.map(f => (
                      <tr key={f.name} className={`border-b border-[var(--cream-warm)]/50 ${f.primaryKey ? 'bg-[var(--cream-warm)]/40' : 'hover:bg-[var(--cream-warm)]/20'}`}>
                        <td className="px-2 py-1 truncate" style={{ backgroundColor: columnTint(0, f.primaryKey ? 0.11 : 0.055) }} title={f.name}>{f.name}</td>
                        <td className="px-2 py-1 font-mono text-[var(--coffee-muted)] truncate" style={{ backgroundColor: columnTint(1, f.primaryKey ? 0.11 : 0.055) }} title={f.valueType}>{f.valueType}</td>
                        <td className="px-2 py-1 text-center" style={{ backgroundColor: columnTint(2, f.primaryKey ? 0.11 : 0.055) }}>{f.primaryKey ? <span className="text-[var(--caramel)]" title="Primary Key">✦</span> : ''}</td>
                        <td className="px-2 py-1 text-[var(--coffee-muted)] truncate" style={{ backgroundColor: columnTint(3, f.primaryKey ? 0.11 : 0.055) }}>
                          {f.collectionType === 1 ? 'List' : f.collectionType === 2 ? `Dict<${f.keyType || '?'}>` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {/* Data grid */}
            {dataLoaded && (
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                {/* Data toolbar */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--cream-warm)] bg-white/20 flex-shrink-0 gap-2 flex-nowrap">
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)] pointer-events-none" />
                      <input
                        className="py-1 text-xs bg-white/50 border border-[var(--cream-warm)] rounded-md focus:border-[var(--caramel)] focus:outline-none w-48"
                        style={{ paddingLeft: '1.75rem', paddingRight: dataSearch ? '1.5rem' : '0.5rem' }}
                        placeholder="搜索字段值..."
                        value={dataSearch}
                        onChange={e => handleDataSearch(e.target.value)}
                      />
                      {dataSearch && <button onClick={() => handleDataSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]"><X className="w-3 h-3" /></button>}
                    </div>
                    <span className="text-[10px] text-[var(--coffee-muted)]">
                      {dataSearch ? `${matchedRows} 匹配 / ` : ''}{totalRows} 行
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] whitespace-nowrap shrink-0">
                    <span className="text-[var(--coffee-muted)]">每页</span>
                    <select
                      className="text-xs bg-white/50 border border-[var(--cream-warm)] rounded px-1 py-0.5"
                      value={pageSize}
                      onChange={e => { const ps = Number(e.target.value); setPageSize(ps); loadData(1, dataSearch, sortField, sortDir, ps) }}
                    >
                      {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <span className="text-[var(--coffee-muted)]">{page}/{totalPages}</span>
                    <button disabled={page <= 1 || loading} onClick={() => loadData(page - 1)} className="p-0.5 hover:text-[var(--coffee)] disabled:opacity-30"><ChevronLeft className="w-3 h-3" /></button>
                    <button disabled={page >= totalPages || loading} onClick={() => loadData(page + 1)} className="p-0.5 hover:text-[var(--coffee)] disabled:opacity-30"><ChevronRight className="w-3 h-3" /></button>
                  </div>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-auto overscroll-contain min-h-0" style={{ scrollbarGutter: 'stable both-edges' }}>
                  {loading ? (
                    <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-[var(--caramel)] mr-2" /><span className="text-xs text-[var(--coffee-muted)]">正在从游戏端读取数据...</span></div>
                  ) : rows && rows.length > 0 ? (
                    <table className="text-xs border-collapse table-fixed" style={{ width: dataTableWidth, minWidth: '100%' }}>
                      <colgroup>
                        {schema?.fields?.map(f => (
                          <col key={f.name} style={{ width: getDataColWidth(f.name, f) }} />
                        ))}
                      </colgroup>
                      <thead className="sticky top-0 bg-white/90 backdrop-blur-sm z-10">
                        <tr>
                          {schema?.fields?.map(f => (
                            <th
                              key={f.name}
                              className="relative px-2 py-1.5 text-left text-[10px] font-medium text-[var(--coffee-muted)] border-b border-[var(--cream-warm)] cursor-pointer hover:text-[var(--coffee)] select-none whitespace-nowrap"
                              style={{ backgroundColor: columnTint(schema.fields.indexOf(f), 0.14) }}
                              onClick={() => handleSort(f.name)}
                            >
                              <span className="inline-flex items-center gap-0.5 max-w-full">
                                <span className="truncate">{f.name}</span>
                                {sortField === f.name ? (
                                  sortDir === 'asc' ? <ArrowUp className="w-2.5 h-2.5 text-[var(--caramel)]" /> : <ArrowDown className="w-2.5 h-2.5 text-[var(--caramel)]" />
                                ) : (
                                  <ArrowUpDown className="w-2.5 h-2.5 opacity-20" />
                                )}
                              </span>
                              <span
                                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--caramel)]/30"
                                onMouseDown={(e) => handleColumnResizeStart(e, 'data', f.name, getDataColWidth(f.name, f))}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, idx) => {
                          const rowKey = schema?.fields?.find(f => f.primaryKey)?.name
                          const key = rowKey ? row[rowKey] : idx
                          const isExpanded = selectedRow === key
                          return (
                            <Fragment key={key}>
                              <tr
                                className={`border-b border-[var(--cream-warm)]/30 cursor-pointer transition-colors ${isExpanded ? 'bg-[var(--caramel)]/5' : 'hover:bg-[var(--cream-warm)]/30'}`}
                                onClick={() => setSelectedRow(isExpanded ? null : key)}
                              >
                                {schema?.fields?.map((f, colIdx) => (
                                  <td
                                    key={f.name}
                                    className="px-2 py-1 truncate"
                                    style={{ backgroundColor: columnTint(colIdx, isExpanded ? 0.105 : 0.055) }}
                                    title={row[f.name] != null && typeof row[f.name] !== 'object' ? String(row[f.name]) : undefined}
                                  >
                                    {renderCell(row[f.name], f)}
                                  </td>
                                ))}
                              </tr>
                              {isExpanded && (
                                <tr>
                                  <td colSpan={schema?.fields?.length || 1} className="p-0">
                                    <div className="bg-[var(--cream-warm)]/20 border-y border-[var(--caramel)]/20 px-4 py-2">
                                      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                        {schema?.fields?.map(f => (
                                          <div key={f.name} className="contents">
                                            <span className="font-medium text-[var(--coffee-muted)] text-right select-all">{f.name}</span>
                                            <span className="font-mono text-[var(--coffee)] break-all select-all">
                                              {row[f.name] != null ? (typeof row[f.name] === 'object' ? JSON.stringify(row[f.name]) : String(row[f.name])) : <span className="text-[var(--coffee-muted)] opacity-40">nil</span>}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex items-center justify-center py-12 text-xs text-[var(--coffee-muted)] opacity-60">
                      {dataSearch ? '未找到匹配的行' : '该表无数据'}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(TableViewer)
