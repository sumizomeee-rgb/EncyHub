import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, RotateCw, X, ChevronDown, ChevronRight, Pin, Loader2, Clipboard, Play } from 'lucide-react'

// ============================================================================
// 主组件
// ============================================================================
export default function CsComponentMonitor({ clients, selectedClient, pendingPin, onPendingPinConsumed, active }) {
    const [searchType, setSearchType] = useState('')
    const [scanResults, setScanResults] = useState([])
    const [scanInfo, setScanInfo] = useState(null) // {truncated, total, shown}
    const [monitored, setMonitored] = useState({}) // key → {goInstanceId, compIndex, goName, parentName, compTypeName, sameTypeIndex, sameTypeCount}
    const [details, setDetails] = useState({})      // key → detail data
    const [detailLoading, setDetailLoading] = useState({}) // key → bool
    const [methodResults, setMethodResults] = useState({}) // "key_methodName" → {result, error}
    const [wsConnected, setWsConnected] = useState(false)
    const [loading, setLoading] = useState(false)
    const [refreshInterval, setRefreshInterval] = useState(3)
    const [autoRefresh, setAutoRefresh] = useState(false)
    const [leftWidth, setLeftWidth] = useState(280)
    const isDragging = useRef(false)

    const wsRef = useRef(null)
    const listenersRef = useRef({})

    // --- WebSocket ---
    useEffect(() => {
        if (!selectedClient) return
        let closed = false
        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/cs_monitor`)
            wsRef.current = ws
            let pingTimer = null
            ws.onopen = () => {
                setWsConnected(true)
                pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 25000)
            }
            ws.onmessage = (event) => {
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
    }, [selectedClient?.id])

    // --- Command helper ---
    const sendCmd = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        if (onResponse) listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/cs_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).catch(e => console.error('[CsMonitor] sendCmd error:', e))
    }, [selectedClient?.id])

    // --- Scan ---
    const handleScan = useCallback(() => {
        if (!searchType.trim()) return
        setLoading(true)
        setScanResults([])
        setScanInfo(null)
        sendCmd('scan', { typeName: searchType.trim() }, (data) => {
            setLoading(false)
            if (data?.error) { setScanResults([]); setScanInfo({ error: data.error }); return }
            setScanResults(data?.results || [])
            if (data?.truncated) setScanInfo({ truncated: true, total: data.total, shown: data.shown })
        })
    }, [searchType, sendCmd])

    // --- Pin/Unpin ---
    const makeKey = (r) => `${r.goInstanceId}_${r.compIndex}`

    const togglePin = useCallback((entry) => {
        const key = makeKey(entry)
        setMonitored(prev => {
            if (prev[key]) {
                const next = { ...prev }
                delete next[key]
                setDetails(d => { const n = { ...d }; delete n[key]; return n })
                return next
            }
            // Pin: add and load detail
            const next = { ...prev, [key]: entry }
            setDetailLoading(dl => ({ ...dl, [key]: true }))
            sendCmd('get_detail', { goInstanceId: entry.goInstanceId, compIndex: entry.compIndex }, (data) => {
                setDetailLoading(dl => ({ ...dl, [key]: false }))
                setDetails(d => ({ ...d, [key]: data }))
            })
            return next
        })
    }, [sendCmd])

    // --- Refresh detail ---
    const refreshDetail = useCallback((key, entry) => {
        setDetailLoading(dl => ({ ...dl, [key]: true }))
        sendCmd('get_detail', { goInstanceId: entry.goInstanceId, compIndex: entry.compIndex }, (data) => {
            setDetailLoading(dl => ({ ...dl, [key]: false }))
            setDetails(d => ({ ...d, [key]: data }))
        })
    }, [sendCmd])

    // --- Set prop ---
    const setProp = useCallback((key, entry, propName, value, valueType) => {
        sendCmd('set_prop', { goInstanceId: entry.goInstanceId, compIndex: entry.compIndex, propName, value, valueType }, () => {
            refreshDetail(key, entry)
        })
    }, [sendCmd, refreshDetail])

    // --- Call method ---
    const callMethod = useCallback((key, entry, methodName) => {
        const rKey = `${key}_${methodName}`
        sendCmd('call_method', { goInstanceId: entry.goInstanceId, compIndex: entry.compIndex, methodName }, (data) => {
            setMethodResults(prev => ({ ...prev, [rKey]: data }))
            setTimeout(() => setMethodResults(prev => { const n = { ...prev }; delete n[rKey]; return n }), 8000)
        })
    }, [sendCmd])

    // --- Handle pin from Inspector（等 WS 连上再发）---
    useEffect(() => {
        if (!pendingPin || !selectedClient || !wsConnected) return
        sendCmd('cache_from_inspector', {
            uiName: pendingPin.uiName, path: pendingPin.path, compIndex: pendingPin.compIndex
        }, (data) => {
            if (data?.success && data.entry) {
                const entry = data.entry
                const key = `${entry.goInstanceId}_${entry.compIndex}`
                // 重复 pin 防护
                setMonitored(prev => {
                    if (prev[key]) return prev
                    return { ...prev, [key]: entry }
                })
                setDetailLoading(dl => ({ ...dl, [key]: true }))
                sendCmd('get_detail', { goInstanceId: entry.goInstanceId, compIndex: entry.compIndex }, (detail) => {
                    setDetailLoading(dl => ({ ...dl, [key]: false }))
                    setDetails(d => ({ ...d, [key]: detail }))
                })
            }
        })
        onPendingPinConsumed && onPendingPinConsumed()
    }, [pendingPin, wsConnected])

    // --- Auto-refresh monitored cards ---
    useEffect(() => {
        if (!autoRefresh || !active || refreshInterval <= 0) return
        const keys = Object.keys(monitored)
        if (keys.length === 0) return
        const timer = setInterval(() => {
            keys.forEach(key => {
                const entry = monitored[key]
                if (entry) refreshDetail(key, entry)
            })
        }, refreshInterval * 1000)
        return () => clearInterval(timer)
    }, [autoRefresh, active, refreshInterval, monitored, refreshDetail])

    // --- Cleanup on client change ---
    useEffect(() => {
        setMonitored({}); setDetails({}); setScanResults([]); setScanInfo(null)
    }, [selectedClient?.id])

    const monitoredKeys = Object.keys(monitored)

    return (
        <div className="flex h-full" style={{ minHeight: '500px' }}
            onMouseMove={e => { if (!isDragging.current) return; const r = e.currentTarget.getBoundingClientRect(); setLeftWidth(Math.min(Math.max(e.clientX - r.left, 180), 450)) }}
            onMouseUp={() => { isDragging.current = false }}
            onMouseLeave={() => { isDragging.current = false }}>

            {/* ===== Left Panel ===== */}
            <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col" style={{ width: leftWidth }}>
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />
                        <span className="text-sm font-semibold text-[var(--coffee-deep)]">C# Component</span>
                        <div className="ml-auto flex items-center gap-0.5 text-[var(--coffee-muted)]" title={`自动刷新间隔 ${refreshInterval}s（设 0 关闭）`}>
                            <button onClick={() => monitoredKeys.forEach(key => refreshDetail(key, monitored[key]))}
                                disabled={monitoredKeys.length === 0 || !selectedClient}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--coffee-deep)] disabled:opacity-30 disabled:pointer-events-none transition-colors" title="刷新">
                                <RotateCw size={13} />
                            </button>
                            <input type="text" inputMode="numeric" value={refreshInterval}
                                onChange={e => { const v = parseInt(e.target.value); setRefreshInterval(isNaN(v) ? 0 : Math.max(0, Math.min(60, v))); setAutoRefresh(v > 0) }}
                                style={{ width: 24, padding: '0 1px', fontSize: 10, lineHeight: '18px' }} className="h-5 rounded border border-[var(--glass-border)] bg-white/70 text-center font-mono focus:outline-none focus:border-[var(--caramel)] appearance-none"
                            /><span className="text-[10px]">s</span>
                        </div>
                    </div>
                    <input type="text" value={searchType} onChange={e => setSearchType(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                        placeholder="组件类型名 (回车搜索, 如 Image)"
                        className="w-full mt-2 px-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                    />
                </div>

                {/* Scan Results */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {scanInfo?.error && (
                        <div className="px-2 py-1.5 mb-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs">{scanInfo.error}</div>
                    )}
                    {loading && <div className="flex items-center justify-center gap-1.5 py-4 text-[var(--coffee-muted)]"><Loader2 size={14} className="animate-spin" /><span>搜索中...</span></div>}
                    {!loading && scanResults.length === 0 && !scanInfo?.error && (
                        <div className="text-center text-[var(--coffee-muted)] py-4">{searchType ? '无结果' : '输入组件类型名搜索'}</div>
                    )}
                    {scanResults.map((r, i) => {
                        const key = makeKey(r)
                        const isPinned = !!monitored[key]
                        const typeLabel = r.sameTypeCount > 1 ? `${r.compTypeName} #${r.sameTypeIndex}` : r.compTypeName
                        return (
                            <button key={i} onClick={() => togglePin(r)}
                                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition-colors mb-0.5 ${
                                    isPinned ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                                }`}>
                                <Pin size={10} className={`flex-shrink-0 ${isPinned ? 'text-[var(--caramel)]' : 'text-[var(--coffee-muted)] opacity-30'}`} />
                                <span className="truncate font-medium">{r.goName}</span>
                                {r.parentName && <span className="text-[var(--coffee-muted)] opacity-50 text-[10px] truncate">{r.parentName}</span>}
                                <span className="ml-auto text-[10px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">#{r.goInstanceId}</span>
                            </button>
                        )
                    })}
                    {scanInfo?.truncated && (
                        <div className="mt-1 px-2 py-1 rounded bg-[var(--caramel)]/10 text-[var(--coffee-muted)] text-[10px]">
                            截断: 显示 {scanInfo.shown}/{scanInfo.total}
                        </div>
                    )}
                </div>

                {(scanResults.length > 0 || monitoredKeys.length > 0) && (
                    <div className="p-2 border-t border-[var(--glass-border)] flex items-center justify-between text-[10px] text-[var(--coffee-muted)]">
                        <span>搜索: {scanResults.length} 监控: {monitoredKeys.length}</span>
                        {monitoredKeys.length > 0 && (
                            <button onClick={() => { setMonitored({}); setDetails({}) }} className="hover:text-[var(--terracotta)]">清除全部</button>
                        )}
                    </div>
                )}
            </div>

            {/* ===== Drag Handle ===== */}
            <div className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
                onMouseDown={e => { e.preventDefault(); isDragging.current = true }} />

            {/* ===== Right Panel: Monitor Cards ===== */}
            <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
                {monitoredKeys.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                        搜索组件类型后点击条目 📌 添加监控
                    </div>
                )}
                {monitoredKeys.map(key => {
                    const entry = monitored[key]
                    const detail = details[key]
                    const isLoading = detailLoading[key]
                    return (
                        <MonitorCard key={key} cardKey={key} entry={entry} detail={detail} isLoading={isLoading}
                            methodResults={methodResults}
                            onRemove={() => {
                                setMonitored(prev => { const n = { ...prev }; delete n[key]; return n })
                                setDetails(prev => { const n = { ...prev }; delete n[key]; return n })
                            }}
                            onRefresh={() => refreshDetail(key, entry)}
                            onSetProp={(propName, value, valueType) => setProp(key, entry, propName, value, valueType)}
                            onCallMethod={(methodName) => callMethod(key, entry, methodName)}
                        />
                    )
                })}
            </div>
        </div>
    )
}

// ============================================================================
// 监控卡片
// ============================================================================
function MonitorCard({ cardKey, entry, detail, isLoading, methodResults, onRemove, onRefresh, onSetProp, onCallMethod }) {
    const [collapsed, setCollapsed] = useState(false)
    const [filter, setFilter] = useState('')
    const [propsCollapsed, setPropsCollapsed] = useState(false)
    const [methodsCollapsed, setMethodsCollapsed] = useState(false)
    const typeLabel = entry.sameTypeCount > 1 ? `${entry.compTypeName} #${entry.sameTypeIndex}` : entry.compTypeName

    const lf = filter.toLowerCase()
    const filteredProps = detail?.properties?.filter(p => !lf || p.name.toLowerCase().includes(lf)) || []
    const filteredMethods = detail?.methods?.filter(m => !lf || m.name.toLowerCase().includes(lf)) || []

    return (
        <div className="rounded-lg border border-[var(--glass-border)] bg-white/30 overflow-hidden">
            {/* Title */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--cream-warm)]/30 cursor-pointer select-none" onClick={() => setCollapsed(!collapsed)}>
                {collapsed ? <ChevronRight size={14} className="text-[var(--coffee-muted)]" /> : <ChevronDown size={14} className="text-[var(--coffee-muted)]" />}
                <span className="text-sm font-medium text-[var(--coffee-deep)]">{typeLabel}</span>
                <span className="text-xs text-[var(--coffee-muted)]">on "{entry.goName}"</span>
                {entry.parentName && <span className="text-[10px] text-[var(--coffee-muted)] opacity-50">({entry.parentName})</span>}
                {detail?.isActive === false && <span className="text-[10px] text-[var(--caramel)]">(inactive)</span>}
                {detail?.error && <span className="text-[10px] text-[var(--terracotta)]">⚠</span>}
                <span className="ml-auto text-[10px] text-[var(--coffee-muted)] opacity-30">#{entry.goInstanceId}</span>
                <button onClick={e => { e.stopPropagation(); onRefresh() }} className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]" title="刷新"><RotateCw size={12} /></button>
                <button onClick={e => { e.stopPropagation(); onRemove() }} className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={14} /></button>
            </div>

            {!collapsed && (
                <div className="p-2">
                    {isLoading && <div className="flex items-center gap-1 py-2 text-[var(--coffee-muted)] text-xs"><Loader2 size={12} className="animate-spin" /> 加载中...</div>}
                    {detail?.error && <div className="text-[var(--terracotta)] text-xs py-1">{detail.error}</div>}
                    {detail && !detail.error && !isLoading && (
                        <>
                            {/* Search */}
                            <div className="mb-2">
                                <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                                    placeholder="搜索属性/方法..."
                                    className="w-full px-2 py-1 text-[10px] rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                                />
                            </div>

                            {/* Properties (collapsible) */}
                            <div className="mb-1">
                                <button onClick={() => setPropsCollapsed(!propsCollapsed)}
                                    className="flex items-center gap-1 text-[10px] font-semibold text-[#7D9B76] mb-0.5 hover:opacity-80">
                                    {propsCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                    属性 ({filteredProps.length}{filter ? ' / ' + (detail.properties?.length || 0) : ''})
                                </button>
                                {!propsCollapsed && (
                                    <div className="space-y-0.5 max-h-60 overflow-y-auto">
                                        {filteredProps.map((p, i) => (
                                            <PropRow key={i} prop={p} onSet={(val) => onSetProp(p.name, val, p.valueType)} />
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Methods (collapsible) */}
                            <div>
                                <button onClick={() => setMethodsCollapsed(!methodsCollapsed)}
                                    className="flex items-center gap-1 text-[10px] font-semibold text-[#9B7DBF] mb-0.5 hover:opacity-80">
                                    {methodsCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                    方法 ({filteredMethods.length}{filter ? ' / ' + (detail.methods?.length || 0) : ''})
                                </button>
                                {!methodsCollapsed && (
                                    <div className="space-y-0.5 max-h-48 overflow-y-auto">
                                        {filteredMethods.map((m, i) => {
                                            const rKey = `${cardKey}_${m.name}`
                                            const result = methodResults[rKey]
                                            return (
                                                <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
                                                    <span className="font-mono text-[var(--coffee-deep)] truncate">{m.name}({m.params?.map(p => p.name).join(', ')})</span>
                                                    {m.paramCount === 0 && (
                                                        <button onClick={() => onCallMethod(m.name)}
                                                            className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--sage)]/10 text-[var(--sage)] hover:bg-[var(--sage)]/20 flex-shrink-0">
                                                            ▶ Call
                                                        </button>
                                                    )}
                                                    {result && (
                                                        <>
                                                            <span className={`text-[10px] font-mono truncate ${result.error ? 'text-[var(--terracotta)]' : 'text-[var(--sage)]'}`}>
                                                                {result.error ? `✗ ${result.error}` : `→ ${result.result}`}
                                                            </span>
                                                            {result.result && !result.error && (
                                                                <button onClick={() => { navigator.clipboard.writeText(result.result) }}
                                                                    className="p-0.5 rounded hover:bg-black/5 text-[var(--coffee-muted)] flex-shrink-0" title="复制返回值">
                                                                    <Clipboard size={10} />
                                                                </button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

// ============================================================================
// 属性行（复用 Inspector 的 CompPropRow 逻辑）
// ============================================================================
function PropRow({ prop, onSet }) {
    const [editVal, setEditVal] = useState(null)
    const p = prop
    const isEditing = editVal !== null
    const commit = (val) => { onSet(val); setEditVal(null) }

    if (p.valueType === 'bool' && p.editable) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <span className="font-mono text-[var(--coffee-muted)] w-36 truncate text-[10px]">{p.name}</span>
                <button onClick={() => onSet(!p.value)}
                    className={`relative inline-flex items-center h-4 w-7 flex-shrink-0 rounded-full transition-colors ${p.value ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/30'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${p.value ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                </button>
            </div>
        )
    }
    if ((p.valueType === 'int' || p.valueType === 'float') && p.editable) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <span className="font-mono text-[var(--coffee-muted)] w-36 truncate text-[10px]">{p.name}</span>
                <input type="number" step={p.valueType === 'float' ? 0.01 : 1}
                    value={isEditing ? editVal : (p.value ?? 0)}
                    onFocus={() => setEditVal(p.value ?? 0)}
                    onChange={e => setEditVal(parseFloat(e.target.value) || 0)}
                    onBlur={() => { if (isEditing) commit(editVal) }}
                    onKeyDown={e => { if (e.key === 'Enter') { commit(editVal); e.target.blur() } }}
                    className="w-20 h-5 px-1 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-[10px] focus:outline-none focus:border-[var(--caramel)]"
                />
            </div>
        )
    }
    if (p.valueType === 'string' && p.editable) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <span className="font-mono text-[var(--coffee-muted)] w-36 truncate text-[10px]">{p.name}</span>
                <input type="text" value={isEditing ? editVal : (p.value ?? '')}
                    onFocus={() => setEditVal(p.value ?? '')}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => { if (isEditing) commit(editVal) }}
                    onKeyDown={e => { if (e.key === 'Enter') { commit(editVal); e.target.blur() } }}
                    className="flex-1 h-5 px-1 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-[10px] focus:outline-none focus:border-[var(--caramel)]"
                />
            </div>
        )
    }
    if ((p.valueType === 'vector2' || p.valueType === 'vector3' || p.valueType === 'vector4' || p.valueType === 'color' || p.valueType === 'euler' || p.valueType === 'rect') && p.editable) {
        const arr = Array.isArray(p.value) ? p.value : [0, 0, 0, 0]
        const labels = p.valueType === 'color' ? ['R','G','B','A'] : p.valueType === 'rect' ? ['X','Y','W','H'] : ['X','Y','Z','W']
        const count = p.valueType === 'vector2' ? 2 : (p.valueType === 'vector3' || p.valueType === 'euler') ? 3 : 4
        const current = isEditing ? editVal : arr.slice(0, count)
        return (
            <div className="flex items-center gap-1 py-0.5 text-xs flex-wrap">
                <span className="font-mono text-[var(--coffee-muted)] w-36 truncate text-[10px]">{p.name}</span>
                {p.valueType === 'color' && <span className="w-3 h-3 rounded-sm border border-black/10 flex-shrink-0" style={{ background: `rgba(${(arr[0]*255)|0},${(arr[1]*255)|0},${(arr[2]*255)|0},${arr[3]??1})` }} />}
                {Array.from({ length: count }).map((_, i) => (
                    <div key={i} className="flex items-center gap-0.5">
                        <span className="text-[9px] text-[var(--coffee-muted)] opacity-50">{labels[i]}</span>
                        <input type="number" step={0.01}
                            value={isEditing ? current[i] : (arr[i] ?? 0)}
                            onFocus={() => { if (!isEditing) setEditVal([...arr.slice(0, count)]) }}
                            onChange={e => { const n = [...(editVal || arr.slice(0, count))]; n[i] = parseFloat(e.target.value) || 0; setEditVal(n) }}
                            onBlur={() => { if (isEditing) commit(editVal) }}
                            onKeyDown={e => { if (e.key === 'Enter') { commit(editVal); e.target.blur() } }}
                            className="w-14 h-5 px-1 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-[10px] focus:outline-none focus:border-[var(--caramel)]"
                        />
                    </div>
                ))}
            </div>
        )
    }
    // readonly
    return (
        <div className="flex items-center gap-2 py-0.5 text-xs">
            <span className="font-mono text-[var(--coffee-muted)] w-36 truncate text-[10px]">{p.name}</span>
            <span className="font-mono text-[var(--coffee-muted)] opacity-60 text-[10px] truncate">{String(p.value ?? 'null')}</span>
            <span className="text-[9px] text-[var(--coffee-muted)] opacity-40">{p.typeName}</span>
        </div>
    )
}
