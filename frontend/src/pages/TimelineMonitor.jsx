import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, RotateCw, X, ChevronDown, ChevronRight, Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX, Loader2 } from 'lucide-react'

// ============================================================================
// 常量
// ============================================================================
const TRACK_COLORS = {
    AnimationTrack: '#4A86C8',
    AudioTrack: '#8A5EBF',
    ActivationTrack: '#5EA85E',
    ControlTrack: '#4AB8B8',
    SignalTrack: '#D4A574',
    GroupTrack: '#A89B91',
}
const DEFAULT_TRACK_COLOR = '#888888'

function trackColor(trackType) {
    return TRACK_COLORS[trackType] || DEFAULT_TRACK_COLOR
}

function formatTime(t) {
    if (!t || !isFinite(t)) return '0:00.00'
    const m = Math.floor(t / 60)
    const s = t % 60
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`
}

// ============================================================================
// 主组件
// ============================================================================
export default function TimelineMonitor({ clients, selectedClient, broadcastMode, active }) {
    const [directors, setDirectors] = useState([])
    const [monitored, setMonitored] = useState(new Set())
    const [snapshots, setSnapshots] = useState({})
    const [collapsed, setCollapsed] = useState(new Set())
    const [filter, setFilter] = useState('')
    const [wsConnected, setWsConnected] = useState(false)
    const [loading, setLoading] = useState(false)
    const [refreshInterval, setRefreshInterval] = useState(2)
    const [autoRefresh, setAutoRefresh] = useState(true)
    const [leftWidth, setLeftWidth] = useState(220)
    const isDragging = useRef(false)

    const wsRef = useRef(null)
    const activeRef = useRef(active)
    const autoRefreshRef = useRef(autoRefresh)
    const refreshIntervalRef = useRef(refreshInterval)
    const lastUpdateRef = useRef(0)

    // --- WebSocket ---
    useEffect(() => {
        if (!selectedClient) return
        let closed = false
        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/timeline`)
            wsRef.current = ws
            let pingTimer = null
            ws.onopen = () => {
                setWsConnected(true)
                pingTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send('ping')
                }, 25000)
            }
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data)
                    if (msg.client_id !== selectedClient?.id) return
                    if (msg.type === 'scan') {
                        setDirectors(msg.data || [])
                        setLoading(false)
                    } else if (msg.type === 'snapshot' && msg.data) {
                        // Throttle: skip state updates when inactive or too frequent
                        if (!activeRef.current || !autoRefreshRef.current) return
                        const now = Date.now()
                        if (now - lastUpdateRef.current < refreshIntervalRef.current * 1000) return
                        lastUpdateRef.current = now
                        setSnapshots(prev => ({ ...prev, [msg.data.instanceId]: msg.data }))
                        const snapId = msg.data.instanceId
                        const snapPlaying = msg.data.playState === 'Playing'
                        setDirectors(prev => prev.map(d => d.instanceId === snapId ? { ...d, isPlaying: snapPlaying } : d))
                    } else if (msg.type === 'removed' && msg.data) {
                        const rid = msg.data.instanceId
                        setMonitored(prev => { const n = new Set(prev); n.delete(rid); return n })
                        setSnapshots(prev => { const n = { ...prev }; delete n[rid]; return n })
                    }
                } catch (e) { console.error('[Timeline WS] parse error:', e) }
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

    // --- Commands ---
    const sendCmd = useCallback(async (action, params = {}) => {
        if (!selectedClient) return
        try {
            await fetch(`/api/gm_console/timeline/${encodeURIComponent(selectedClient.id)}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...params })
            })
        } catch (e) { console.error('[Timeline] sendCmd error:', e) }
    }, [selectedClient?.id])

    const scan = useCallback(() => { setLoading(true); sendCmd('scan') }, [sendCmd])

    const toggleMonitor = useCallback((id) => {
        setMonitored(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
                sendCmd('unsubscribe', { instanceId: id })
                setSnapshots(p => { const n = { ...p }; delete n[id]; return n })
            } else {
                next.add(id)
                sendCmd('subscribe', { instanceId: id })
            }
            return next
        })
    }, [sendCmd])

    const removeMonitor = useCallback((id) => {
        sendCmd('unsubscribe', { instanceId: id })
        setMonitored(prev => { const n = new Set(prev); n.delete(id); return n })
        setSnapshots(prev => { const n = { ...prev }; delete n[id]; return n })
    }, [sendCmd])

    const clearAll = useCallback(() => {
        sendCmd('unsubscribe_all')
        setMonitored(new Set())
        setSnapshots({})
    }, [sendCmd])

    useEffect(() => { activeRef.current = active }, [active])
    useEffect(() => { autoRefreshRef.current = autoRefresh }, [autoRefresh])
    useEffect(() => { refreshIntervalRef.current = refreshInterval }, [refreshInterval])

    const manualRefresh = useCallback(() => { lastUpdateRef.current = 0 }, [])

    // --- Cleanup on client change ---
    useEffect(() => {
        setMonitored(new Set())
        setSnapshots({})
        setDirectors([])
    }, [selectedClient?.id])

    // --- No client ---
    if (!selectedClient) {
        return <div className="flex items-center justify-center h-64 text-[var(--coffee-muted)]">请先在左侧选择一个客户端</div>
    }

    const filteredDirs = filter
        ? directors.filter(d => {
            const f = filter.toLowerCase()
            return d.gameObjectName.toLowerCase().includes(f) || d.rootName.toLowerCase().includes(f) || (d.parentName || '').toLowerCase().includes(f)
        })
        : directors

    return (
        <div
            className="flex h-full" style={{ minHeight: '500px' }}
            onMouseMove={e => { if (!isDragging.current) return; const r = e.currentTarget.getBoundingClientRect(); setLeftWidth(Math.min(Math.max(e.clientX - r.left, 140), 400)) }}
            onMouseUp={() => { isDragging.current = false }}
            onMouseLeave={() => { isDragging.current = false }}
        >
            {/* ===== Left Panel ===== */}
            <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col" style={{ width: leftWidth }}>
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />
                        <span className="text-sm font-semibold text-[var(--coffee-deep)]">Directors</span>
                        <div className="ml-auto flex items-center gap-0.5 text-[var(--coffee-muted)]" title={`自动刷新间隔 ${refreshInterval}s（设 0 关闭）`}>
                            <button onClick={() => { scan(); manualRefresh() }} disabled={loading}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--coffee-deep)] disabled:opacity-30 transition-colors" title="刷新">
                                <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
                            </button>
                            <input type="text" inputMode="numeric" value={refreshInterval}
                                onChange={e => { const v = parseInt(e.target.value); setRefreshInterval(isNaN(v) ? 0 : Math.max(0, Math.min(60, v))); setAutoRefresh(v > 0) }}
                                style={{ width: 24, padding: '0 1px', fontSize: 10, lineHeight: '18px' }} className="h-5 rounded border border-[var(--glass-border)] bg-white/70 text-center font-mono focus:outline-none focus:border-[var(--caramel)] appearance-none"
                            /><span className="text-[10px]">s</span>
                        </div>
                    </div>
                    <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                        placeholder="搜索 Director..."
                        className="w-full mt-2 px-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                    />
                </div>
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {loading && <div className="flex items-center justify-center gap-1.5 py-4 text-[var(--coffee-muted)]"><Loader2 size={14} className="animate-spin" /><span>扫描中...</span></div>}
                    {!loading && filteredDirs.length === 0 && (
                        <div className="text-center text-[var(--coffee-muted)] py-4">{directors.length === 0 ? '点击 Refresh 扫描' : '无匹配'}</div>
                    )}
                    {filteredDirs.map(d => (
                        <button key={d.instanceId} onClick={() => toggleMonitor(d.instanceId)}
                            className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition-colors mb-0.5 ${
                                monitored.has(d.instanceId) ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                            }`}>
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                !d.hasAsset ? 'bg-[var(--coffee-muted)]/30' : d.isPlaying ? 'bg-[var(--sage)]' : 'bg-[var(--caramel)]'
                            }`} />
                            <span className="truncate min-w-0">
                                {d.parentName && <span className="text-[var(--coffee-muted)] opacity-50 text-[10px]">{d.parentName} / </span>}
                                <span className="font-medium">{d.gameObjectName}</span>
                            </span>
                        </button>
                    ))}
                </div>
                {(directors.length > 0 || monitored.size > 0) && (
                    <div className="p-2 border-t border-[var(--glass-border)] flex items-center justify-between text-[10px] text-[var(--coffee-muted)]">
                        <span>扫描: {directors.length} 监控: {monitored.size}</span>
                        {monitored.size > 0 && <button onClick={clearAll} className="hover:text-[var(--terracotta)]">清除全部</button>}
                    </div>
                )}
            </div>

            {/* ===== Drag Handle ===== */}
            <div className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
                onMouseDown={e => { e.preventDefault(); isDragging.current = true }} />

            {/* ===== Right Panel ===== */}
            <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
                {monitored.size === 0 && (
                    <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                        {wsConnected ? '点击左侧 Director 开始监控' : 'WebSocket 连接中...'}
                    </div>
                )}
                {monitored.size > 5 && (
                    <div className="px-3 py-2 rounded-md bg-[var(--caramel)]/10 text-[var(--coffee-muted)] text-xs">
                        监控数量 &gt; 5，可能影响性能
                    </div>
                )}
                {[...monitored].map(id => {
                    const snap = snapshots[id]
                    const isCollapsed = collapsed.has(id)
                    return (
                        <MonitorCard key={id} instanceId={id} snapshot={snap} isCollapsed={isCollapsed}
                            onToggleCollapse={() => setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })}
                            onRemove={() => removeMonitor(id)}
                            onRefresh={manualRefresh}
                            onControl={(cmd, value) => sendCmd('control', { instanceId: id, cmd, value })}
                            onMuteTrack={(trackIndex) => sendCmd('mute_track', { instanceId: id, trackIndex })}
                            onInvokeSignal={(eventIndex) => sendCmd('invoke_signal', { instanceId: id, eventIndex })}
                            onScrub={(time) => sendCmd('control', { instanceId: id, cmd: 'set_time', value: time })}
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
function MonitorCard({ instanceId, snapshot, isCollapsed, onToggleCollapse, onRemove, onRefresh, onControl, onMuteTrack, onInvokeSignal, onScrub }) {
    if (!snapshot) {
        return (
            <div className="rounded-lg border border-[var(--glass-border)] bg-white/30 p-3">
                <div className="flex items-center gap-2 text-sm text-[var(--coffee-muted)]">
                    <Loader2 size={14} className="animate-spin" />
                    <span>等待数据... (ID: {instanceId})</span>
                    <button onClick={onRemove} className="ml-auto p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]"><X size={14} /></button>
                </div>
            </div>
        )
    }

    const isPlaying = snapshot.playState === 'Playing'

    return (
        <div className="rounded-lg border border-[var(--glass-border)] bg-white/30 overflow-hidden">
            {/* Title Bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--cream-warm)]/30 cursor-pointer select-none" onClick={onToggleCollapse}>
                {isCollapsed ? <ChevronRight size={14} className="text-[var(--coffee-muted)] flex-shrink-0" /> : <ChevronDown size={14} className="text-[var(--coffee-muted)] flex-shrink-0" />}
                <span className={`text-sm truncate ${isPlaying ? 'font-semibold text-[var(--coffee-deep)]' : 'text-[var(--coffee-deep)]'}`}>
                    {snapshot.gameObjectName}
                </span>
                {snapshot.assetName && <span className="text-xs text-[var(--coffee-muted)] opacity-60 truncate">{snapshot.assetName}</span>}
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                    isPlaying ? 'bg-[var(--sage)]/20 text-[var(--sage)]' : 'bg-[var(--caramel)]/20 text-[var(--caramel)]'
                }`}>
                    {snapshot.playState}
                </span>
                <button onClick={e => { e.stopPropagation(); onRefresh() }}
                    className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] flex-shrink-0" title="刷新">
                    <RotateCw size={12} />
                </button>
                <button onClick={e => { e.stopPropagation(); onRemove() }}
                    className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)] flex-shrink-0">
                    <X size={14} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {/* Timeline View */}
                    <TimelineView snapshot={snapshot} onScrub={onScrub} onMuteTrack={onMuteTrack} />

                    {/* Control Bar */}
                    <ControlBar snapshot={snapshot} onControl={onControl} />

                    {/* Events Panel */}
                    {snapshot.events && snapshot.events.length > 0 && (
                        <EventPanel events={snapshot.events} onInvoke={onInvokeSignal}
                            onJump={(time) => onControl('set_time', time)} />
                    )}
                </>
            )}
        </div>
    )
}

// ============================================================================
// 时间轴可视化
// ============================================================================
function TimelineView({ snapshot, onScrub, onMuteTrack }) {
    const contentRef = useRef(null)
    const tracks = snapshot.tracks || []
    const dur = snapshot.duration || 1
    const current = snapshot.currentTime || 0
    const headerW = 130
    const rulerH = 22
    const trackH = 32
    const playheadPct = dur > 0 ? (current / dur) * 100 : 0

    // 点击 track content 区域 → scrub
    const handleContentClick = useCallback((e) => {
        const el = contentRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const x = e.clientX - rect.left
        if (x < 0 || rect.width <= 0) return
        onScrub(Math.max(0, Math.min((x / rect.width) * dur, dur)))
    }, [dur, onScrub])

    // 生成刻度
    const ticks = []
    if (dur > 0) {
        const raw = dur / 6
        const mag = Math.pow(10, Math.floor(Math.log10(raw)))
        const nice = [1, 2, 5, 10].find(n => n * mag >= raw) * mag
        for (let t = 0; t <= dur + nice * 0.01; t += nice) {
            if (t > dur * 1.01) break
            ticks.push(t)
        }
    }

    return (
        <div className="mx-3 my-2 rounded border border-[var(--glass-border)] overflow-hidden select-none" style={{ background: '#262626' }}>
            {/* Ruler row: header spacer + tick area */}
            <div className="flex" style={{ height: rulerH }}>
                <div style={{ width: headerW, minWidth: headerW }} className="flex-shrink-0 border-r border-white/10" />
                <div className="flex-1 relative" style={{ minWidth: 0 }}>
                    {ticks.map((t, i) => (
                        <div key={i} className="absolute top-0 h-full flex flex-col items-center" style={{ left: `${(t / dur) * 100}%` }}>
                            <div className="w-px h-2 bg-white/30" />
                            <span className="text-[9px] text-white/40 mt-px font-mono">{formatTime(t)}</span>
                        </div>
                    ))}
                    {/* Playhead triangle on ruler */}
                    <div className="absolute pointer-events-none" style={{ left: `${playheadPct}%`, top: 0, transform: 'translateX(-4px)' }}>
                        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-500" />
                    </div>
                </div>
            </div>

            {/* Track rows */}
            {tracks.length === 0 && (
                <div className="py-4 text-center text-white/30 text-xs">No tracks</div>
            )}
            {tracks.map((track, ti) => {
                const color = trackColor(track.trackType)
                return (
                    <div key={ti} className="flex" style={{ height: trackH, background: ti % 2 === 0 ? '#2E2E2E' : '#333333' }}>
                        {/* Track Header */}
                        <div className="flex-shrink-0 border-r border-white/10 px-1.5 flex flex-col justify-center overflow-hidden"
                            style={{ width: headerW, minWidth: headerW }}
                            onContextMenu={e => { e.preventDefault(); onMuteTrack(ti) }}>
                            <div className="flex items-center gap-1">
                                {track.muted && <VolumeX size={10} className="text-red-400 flex-shrink-0" />}
                                <span className="text-[10px] font-mono truncate" style={{ color: track.muted ? '#666' : color }}>
                                    {track.trackType?.replace('Track', '') || 'Track'}
                                </span>
                            </div>
                            <span className="text-[9px] text-white/30 truncate">{track.boundObjectName || track.trackName}</span>
                        </div>

                        {/* Track Content — clips + markers (clickable for scrub) */}
                        <div ref={ti === 0 ? contentRef : undefined}
                            className="flex-1 relative min-w-0 cursor-crosshair"
                            style={{ opacity: track.muted ? 0.3 : 1 }}
                            onClick={handleContentClick}>
                            {/* Clips */}
                            {track.clips?.map((clip, ci) => {
                                const left = dur > 0 ? (clip.start / dur) * 100 : 0
                                const width = dur > 0 ? (clip.duration / dur) * 100 : 0
                                const active = clip.isActive
                                return (
                                    <div key={ci} className="absolute top-1 rounded-sm overflow-hidden"
                                        title={`${clip.name}\n${formatTime(clip.start)} → ${formatTime(clip.start + clip.duration)}`}
                                        style={{
                                            left: `${left}%`, width: `${width}%`, height: trackH - 8,
                                            background: active ? lightenColor(color, 0.2) : color,
                                            border: active ? '1px solid rgba(255,255,255,0.6)' : '1px solid rgba(255,255,255,0.1)',
                                            minWidth: 2,
                                        }}>
                                        {width > 4 && <span className="absolute inset-0 px-1 text-[9px] text-white/80 truncate leading-[24px]">{clip.name}</span>}
                                    </div>
                                )
                            })}

                            {/* Signal markers */}
                            {snapshot.events?.filter(e => e.trackIndex === ti).map((evt, ei) => (
                                <div key={ei} className="absolute top-0 h-full flex flex-col items-center pointer-events-none"
                                    style={{ left: `${dur > 0 ? (evt.time / dur) * 100 : 0}%` }}
                                    title={`${evt.methodName} @ ${formatTime(evt.time)}\n${evt.sourceName}`}>
                                    <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-yellow-400 mt-1" />
                                </div>
                            ))}

                            {/* Playhead line on this track */}
                            <div className="absolute top-0 w-px h-full bg-red-500 pointer-events-none" style={{ left: `${playheadPct}%` }} />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

// 简易颜色增亮
function lightenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const lighten = (c) => Math.min(255, Math.round(c + (255 - c) * amount))
    return `rgb(${lighten(r)}, ${lighten(g)}, ${lighten(b)})`
}

// ============================================================================
// 控制栏
// ============================================================================
function ControlBar({ snapshot, onControl }) {
    const [speed, setSpeed] = useState(1)
    const isPlaying = snapshot.playState === 'Playing'
    const dur = snapshot.duration || 0
    const cur = snapshot.currentTime || 0

    // 同步速度
    useEffect(() => {
        if (snapshot.speed != null) setSpeed(snapshot.speed)
    }, [snapshot.speed])

    return (
        <div className="px-3 py-2 border-t border-[var(--glass-border)] flex items-center gap-2 flex-wrap">
            {/* Transport */}
            <div className="flex items-center gap-0.5">
                <button onClick={() => onControl('stop')} className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]" title="Stop"><Square size={14} /></button>
                <button onClick={() => onControl('pause')} className={`p-1 rounded hover:bg-[var(--cream-warm)] ${isPlaying ? 'text-[var(--caramel)]' : 'text-[var(--coffee-muted)] opacity-40'}`} title="Pause"><Pause size={14} /></button>
                <button onClick={() => onControl('play')} className={`p-1 rounded hover:bg-[var(--cream-warm)] ${isPlaying ? 'text-[var(--coffee-muted)] opacity-40' : 'text-[var(--sage)]'}`} title="Play"><Play size={14} /></button>
                <button onClick={() => onControl('replay')} className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]" title="Replay (从头播放)"><SkipBack size={14} /></button>
            </div>

            {/* Time */}
            <span className="text-xs font-mono text-[var(--coffee-muted)] min-w-[120px]">
                {formatTime(cur)} / {formatTime(dur)}
            </span>

            {/* Progress */}
            <div className="flex-1 min-w-[80px] max-w-[300px]">
                <input type="range" min={0} max={dur || 1} step={0.01} value={cur}
                    onChange={e => onControl('set_time', parseFloat(e.target.value))}
                    className="w-full h-1 accent-[var(--caramel)]"
                />
            </div>

            {/* Speed */}
            <div className="flex items-center gap-1 ml-auto">
                <span className="text-[10px] text-[var(--coffee-muted)]">Speed</span>
                <input type="range" min={0.1} max={3} step={0.1} value={speed}
                    onChange={e => { const v = parseFloat(e.target.value); setSpeed(v); onControl('set_speed', v) }}
                    className="w-16 h-1 accent-[var(--caramel)]"
                />
                <span className="text-[10px] font-mono text-[var(--coffee-muted)] w-8">{speed.toFixed(1)}x</span>
                {speed !== 1 && (
                    <button onClick={() => { setSpeed(1); onControl('set_speed', 1) }}
                        className="text-[10px] text-[var(--caramel)] hover:underline">1x</button>
                )}
            </div>
        </div>
    )
}

// ============================================================================
// 事件面板
// ============================================================================
function EventPanel({ events, onInvoke, onJump }) {
    const [expanded, setExpanded] = useState(false)

    return (
        <div className="border-t border-[var(--glass-border)]">
            <button onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]/30">
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Events ({events.length})
            </button>
            {expanded && (
                <div className="px-3 pb-2 space-y-0.5 max-h-40 overflow-y-auto">
                    {events.map((evt, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                            <span className="font-mono text-[var(--coffee-muted)] w-12 flex-shrink-0">{formatTime(evt.time)}</span>
                            <span className={`text-[9px] px-1 rounded flex-shrink-0 ${
                                evt.sourceName?.startsWith('[AnimEvent]') ? 'bg-blue-500/15 text-blue-400'
                                : evt.sourceName?.startsWith('[InfiniteClip]') ? 'bg-purple-500/15 text-purple-400'
                                : 'bg-yellow-500/15 text-yellow-500'
                            }`}>{evt.sourceName?.startsWith('[') ? evt.sourceName.match(/^\[([^\]]+)\]/)?.[1] || 'Signal' : 'Signal'}</span>
                            <span className="text-[var(--coffee-deep)] truncate flex-1 font-mono">{evt.methodName}</span>
                            <button onClick={() => onJump(evt.time)}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--caramel)]/10 text-[var(--caramel)] hover:bg-[var(--caramel)]/20 flex-shrink-0">
                                Jump
                            </button>
                            <button onClick={() => onInvoke(evt.eventIndex)}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--sage)]/10 text-[var(--sage)] hover:bg-[var(--sage)]/20 flex-shrink-0">
                                Trigger
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
