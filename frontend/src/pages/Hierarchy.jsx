import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { RotateCw, ChevronRight, ChevronDown, Loader2, Search, Clipboard, Crosshair } from 'lucide-react'
import { copyText } from '../utils/clipboard'
import PropRow from '../components/PropRow'
import HierarchySearchModal from '../components/HierarchySearchModal'

// ============================================================================
// WebSocket Hook（与 LuaUiInspector 同款）
// ============================================================================
function useHierarchyWs(selectedClient) {
    const listenersRef = useRef({})
    const wsRef = useRef(null)
    const [wsConnected, setWsConnected] = useState(false)

    useEffect(() => {
        if (!selectedClient) return
        let closed = false
        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/hierarchy`)
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
    }, [selectedClient?.id])

    const request = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        if (onResponse) listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/hierarchy/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).catch(e => console.error('[Hierarchy] sendCmd error:', e))
    }, [selectedClient?.id])

    return { request, wsConnected }
}

// ============================================================================
// 主组件
// ============================================================================
export default function Hierarchy({ clients, selectedClient, pendingLocate, onPendingLocateConsumed, active }) {
    const { request, wsConnected } = useHierarchyWs(selectedClient)

    // --- 拖拽分栏 ---
    const [leftWidth, setLeftWidth] = useState(280)
    const isDragging = useRef(false)

    // --- 树数据 ---
    const [tree, setTree] = useState(null)               // { scenes:[{name,roots:[]}], dontDestroy:[] }
    const [childrenMap, setChildrenMap] = useState({})   // instanceId → HierarchyNode[]
    const [expanded, setExpanded] = useState(new Set())  // Set<instanceId>
    const [loadingTree, setLoadingTree] = useState(false)
    const [loadingChildren, setLoadingChildren] = useState({}) // instanceId → bool

    // --- 选中 / Inspector ---
    const [selectedId, setSelectedId] = useState(null)
    const [goDetail, setGoDetail] = useState(null)
    const [loadingDetail, setLoadingDetail] = useState(false)
    const [highlightCompIndex, setHighlightCompIndex] = useState(null)

    // --- 过滤 ---
    const [filterText, setFilterText] = useState('')
    const [filterMode, setFilterMode] = useState('name') // 'name' | 'type'
    const [scanResults, setScanResults] = useState(null)  // type 模式结果列表
    const [scanInfo, setScanInfo] = useState(null)
    const [scanning, setScanning] = useState(false)
    const [searchOpen, setSearchOpen] = useState(false)

    // --- 刷新控制 ---
    const [refreshInterval, setRefreshInterval] = useState(60)
    const [autoRefresh, setAutoRefresh] = useState(true) // 默认开启 60s

    // --- Component 类型展开状态（按 typeName 持久化，默认全折叠） ---
    const COMP_EXPAND_KEY = 'hierarchy_expanded_comp_types'
    const [expandedCompTypes, setExpandedCompTypes] = useState(() => {
        try {
            const raw = localStorage.getItem(COMP_EXPAND_KEY)
            return raw ? new Set(JSON.parse(raw)) : new Set()
        } catch { return new Set() }
    })
    const toggleCompType = useCallback((typeName) => {
        setExpandedCompTypes(prev => {
            const next = new Set(prev)
            next.has(typeName) ? next.delete(typeName) : next.add(typeName)
            try { localStorage.setItem(COMP_EXPAND_KEY, JSON.stringify([...next])) } catch {}
            return next
        })
    }, [])

    // --- 加载树 ---
    const loadTree = useCallback(() => {
        setLoadingTree(true)
        request('scene_roots', {}, (data) => {
            setLoadingTree(false)
            if (data?.error) { setTree({ scenes: [], dontDestroy: [], error: data.error }); return }
            setTree(data || { scenes: [], dontDestroy: [] })
        })
    }, [request])

    // --- 加载子节点 ---
    const loadChildren = useCallback((instanceId) => {
        setLoadingChildren(prev => ({ ...prev, [instanceId]: true }))
        request('children', { instanceId }, (data) => {
            setLoadingChildren(prev => { const n = { ...prev }; delete n[instanceId]; return n })
            if (data?.error) return
            setChildrenMap(prev => ({ ...prev, [instanceId]: data.children || [] }))
        })
    }, [request])

    // --- 加载 GO 详情 ---
    const loadDetail = useCallback((instanceId) => {
        if (!instanceId) return
        setLoadingDetail(true)
        request('go_detail', { instanceId }, (data) => {
            setLoadingDetail(false)
            if (data?.error) { setGoDetail({ error: data.error, instanceId }); return }
            setGoDetail(data)
        })
    }, [request])

    // --- 加载集合元素（懒加载，传给 PropRow 使用） ---
    const loadCollectionItems = useCallback((compIndex, propName, offset, limit, cb) => {
        if (!selectedId) { cb && cb({ error: '未选中 GameObject' }); return }
        request('collection_items', {
            goInstanceId: selectedId, compIndex, propName, offset, limit,
        }, cb)
    }, [request, selectedId])

    // --- 高亮 + 2s 淡出（避免 Locate 命中后边框常驻） ---
    const highlightTimerRef = useRef(null)
    const flashHighlight = useCallback((compIndex) => {
        if (highlightTimerRef.current) { clearTimeout(highlightTimerRef.current); highlightTimerRef.current = null }
        setHighlightCompIndex(compIndex)
        if (compIndex != null) {
            highlightTimerRef.current = setTimeout(() => {
                setHighlightCompIndex(null)
                highlightTimerRef.current = null
            }, 2000)
        }
    }, [])
    useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current) }, [])

    // --- 切换展开 ---
    const toggleExpand = useCallback((node) => {
        const id = node.instanceId
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
                if (!childrenMap[id] && (node.childCount ?? 0) > 0) loadChildren(id)
            }
            return next
        })
    }, [childrenMap, loadChildren])

    // --- 选中节点 ---
    const selectNode = useCallback((id) => {
        setSelectedId(id)
        setHighlightCompIndex(null)
        loadDetail(id)
    }, [loadDetail])

    // --- 修改属性 ---
    const setProp = useCallback((compIndex, propName, value, valueType) => {
        if (!selectedId) return
        request('set_prop', { goInstanceId: selectedId, compIndex, propName, value, valueType }, () => {
            loadDetail(selectedId)
        })
    }, [request, selectedId, loadDetail])

    // --- 调用方法 ---
    const [methodResults, setMethodResults] = useState({}) // "compIdx_methodName" → {result,error}
    const callMethod = useCallback((compIndex, methodName) => {
        if (!selectedId) return
        const rKey = `${compIndex}_${methodName}`
        request('call_method', { goInstanceId: selectedId, compIndex, methodName }, (data) => {
            setMethodResults(prev => ({ ...prev, [rKey]: data }))
            setTimeout(() => setMethodResults(prev => { const n = { ...prev }; delete n[rKey]; return n }), 8000)
        })
    }, [request, selectedId])

    // --- Type 模式扫描 ---
    const runTypeScan = useCallback(() => {
        const tn = filterText.trim()
        if (!tn) { setScanResults(null); setScanInfo(null); return }
        setScanning(true)
        setScanResults([])
        setScanInfo(null)
        request('scan', { typeName: tn }, (data) => {
            setScanning(false)
            if (data?.error) { setScanResults([]); setScanInfo({ error: data.error }); return }
            setScanResults(data?.results || [])
            if (data?.truncated) setScanInfo({ truncated: true, total: data.total, shown: data.shown })
        })
    }, [filterText, request])

    // --- 高级搜索：复用 Hierarchy 通道，结果点击后走现有 Locate 流程 ---
    const handleSearch = useCallback((params, cb) => {
        request('search', params, (data) => cb && cb(data))
    }, [request])

    // --- Locate 流程：展开父链 + 选中目标 ---
    const [locating, setLocating] = useState(false)
    const locateAndSelect = useCallback((locateParams, onDone) => {
        setLocating(true)
        const finish = (success) => { setLocating(false); onDone && onDone(success) }
        request('locate', locateParams, (data) => {
            if (data?.error || !data?.found) { finish(false); return }
            const chain = data.ancestorChain || []
            const target = data.instanceId

            // 依次拉取链路上每个节点的 children（前一个未拉取过的）
            const fetchChain = async () => {
                const newExpanded = new Set(expanded)
                for (let i = 0; i < chain.length - 1; i++) {
                    const id = chain[i]
                    newExpanded.add(id)
                    if (!childrenMap[id]) {
                        await new Promise(resolve => {
                            setLoadingChildren(prev => ({ ...prev, [id]: true }))
                            request('children', { instanceId: id }, (resp) => {
                                setLoadingChildren(prev => { const n = { ...prev }; delete n[id]; return n })
                                if (!resp?.error) {
                                    setChildrenMap(prev => ({ ...prev, [id]: resp.children || [] }))
                                }
                                resolve()
                            })
                        })
                    }
                }
                setExpanded(newExpanded)
                setSelectedId(target)
                loadDetail(target)
                finish(true)
            }
            fetchChain()
        })
    }, [request, expanded, childrenMap, loadDetail])

    const locateSearchHit = useCallback((hit) => {
        const compIndex = hit?.compIndex
        const params = { instanceId: hit.goInstanceId }
        if (compIndex != null) params.compIndex = compIndex
        const run = () => locateAndSelect(params, (success) => {
            if (success && compIndex != null) flashHighlight(compIndex)
        })
        if (tree) {
            run()
            return
        }
        setLoadingTree(true)
        request('scene_roots', {}, (data) => {
            setLoadingTree(false)
            if (!data?.error) setTree(data || { scenes: [], dontDestroy: [] })
            run()
        })
    }, [tree, request, locateAndSelect, flashHighlight])

    // --- 接收 pendingLocate（来自 LuaUiInspector 的"Locate in Hierarchy"） ---
    useEffect(() => {
        if (!pendingLocate || !wsConnected) return
        // 若树未加载，先加载根
        const ensureTree = tree ? Promise.resolve() : new Promise(resolve => {
            setLoadingTree(true)
            request('scene_roots', {}, (data) => {
                setLoadingTree(false)
                if (!data?.error) setTree(data || { scenes: [], dontDestroy: [] })
                resolve()
            })
        })
        ensureTree.then(() => {
            locateAndSelect(pendingLocate, (success) => {
                if (success && pendingLocate.compIndex != null) {
                    flashHighlight(pendingLocate.compIndex)
                }
                onPendingLocateConsumed && onPendingLocateConsumed()
            })
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingLocate, wsConnected])

    // --- 客户端切换 / Tab 激活时初次加载 ---
    useEffect(() => {
        setTree(null); setChildrenMap({}); setExpanded(new Set())
        setSelectedId(null); setGoDetail(null); setScanResults(null); setScanInfo(null)
    }, [selectedClient?.id])

    useEffect(() => {
        if (active && selectedClient && !tree && wsConnected) loadTree()
    }, [active, selectedClient?.id, wsConnected]) // eslint-disable-line react-hooks/exhaustive-deps

    // --- Auto-refresh：仅刷新选中 GO 的 detail ---
    useEffect(() => {
        if (!autoRefresh || !active || !selectedId || refreshInterval <= 0) return
        const timer = setInterval(() => loadDetail(selectedId), refreshInterval * 1000)
        return () => clearInterval(timer)
    }, [autoRefresh, active, selectedId, refreshInterval, loadDetail])

    // --- 渲染：树根列表（按 Scene 分组 + DontDestroyOnLoad） ---
    const sceneSections = useMemo(() => {
        if (!tree) return []
        const sections = (tree.scenes || []).map(s => ({ key: `scene:${s.name}`, label: `Scene: ${s.name}`, roots: s.roots || [] }))
        if (tree.dontDestroy && tree.dontDestroy.length > 0) {
            sections.push({ key: 'ddol', label: 'DontDestroyOnLoad', roots: tree.dontDestroy, isDdol: true })
        }
        return sections
    }, [tree])

    return (
        <div className="relative flex h-full" style={{ minHeight: '500px' }}
            onMouseMove={e => { if (!isDragging.current) return; const r = e.currentTarget.getBoundingClientRect(); setLeftWidth(Math.min(Math.max(e.clientX - r.left, 200), 520)) }}
            onMouseUp={() => { isDragging.current = false }}
            onMouseLeave={() => { isDragging.current = false }}>

            {/* ===== Left Panel ===== */}
            <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col" style={{ width: leftWidth }}>
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />
                        <span className="text-sm font-semibold text-[var(--coffee-deep)]">Hierarchy</span>
                        <div className="ml-auto flex items-center gap-0.5 text-[var(--coffee-muted)]" title={`Inspector 自动刷新间隔 ${refreshInterval}s（设 0 关闭）`}>
                            <button onClick={() => setSearchOpen(true)} disabled={!selectedClient}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--caramel)] disabled:opacity-30 disabled:pointer-events-none transition-colors mr-1" title="全场景高级搜索 (GO / Component / 字段 / 文本)">
                                <Search size={13} />
                            </button>
                            <button onClick={loadTree} disabled={!selectedClient || loadingTree}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--coffee-deep)] disabled:opacity-30 disabled:pointer-events-none transition-colors" title="刷新整树">
                                <RotateCw size={13} className={loadingTree ? 'animate-spin' : ''} />
                            </button>
                            <input type="text" inputMode="numeric" value={refreshInterval}
                                onChange={e => { const v = parseInt(e.target.value); const n = isNaN(v) ? 0 : Math.max(0, Math.min(600, v)); setRefreshInterval(n); setAutoRefresh(n > 0) }}
                                style={{ width: 28, padding: '0 1px', fontSize: 10, lineHeight: '18px', ...(autoRefresh ? { borderColor: 'var(--sage)', boxShadow: '0 0 3px var(--sage-soft)' } : {}) }}
                                className="h-5 rounded border border-[var(--glass-border)] bg-white/70 text-center font-mono focus:outline-none focus:border-[var(--caramel)] appearance-none"
                            /><span className="text-[10px]">s</span>
                        </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                        <input type="text" value={filterText} onChange={e => setFilterText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && filterMode === 'type') runTypeScan() }}
                            placeholder={filterMode === 'name' ? '过滤已加载节点名...' : '组件类型名 (回车搜索)'}
                            className="flex-1 px-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                        />
                        <button onClick={() => { setFilterMode(m => m === 'name' ? 'type' : 'name'); setScanResults(null); setScanInfo(null) }}
                            className={`px-1.5 py-1 rounded text-[10px] font-medium border transition-colors ${
                                filterMode === 'type'
                                    ? 'bg-[var(--caramel)]/20 text-[var(--caramel)] border-[var(--caramel)]/40'
                                    : 'bg-black/5 text-[var(--coffee-muted)] border-transparent hover:bg-black/10'
                            }`}
                            title={filterMode === 'name' ? '切到按 C# 组件类型搜索' : '切回按节点名过滤'}
                        >
                            {filterMode === 'name' ? 'Name' : 'Type'}
                        </button>
                    </div>
                </div>

                {/* 树 / 扫描结果 */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {loadingTree && <div className="flex items-center justify-center gap-1.5 py-4 text-[var(--coffee-muted)]"><Loader2 size={14} className="animate-spin" /><span>加载场景...</span></div>}
                    {!loadingTree && tree?.error && <div className="px-2 py-1.5 mb-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs">{tree.error}</div>}

                    {/* Type 模式：扫描结果列表 */}
                    {filterMode === 'type' && scanResults != null && (
                        <div className="mb-2">
                            {scanInfo?.error && <div className="px-2 py-1.5 mb-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs">{scanInfo.error}</div>}
                            {scanning && <div className="flex items-center gap-1.5 py-2 text-[var(--coffee-muted)]"><Loader2 size={12} className="animate-spin" /><span>搜索中...</span></div>}
                            {!scanning && scanResults.length === 0 && !scanInfo?.error && (
                                <div className="text-center text-[var(--coffee-muted)] py-2">无结果</div>
                            )}
                            {scanResults.map((r, i) => (
                                <button key={i} onClick={() => locateAndSelect({ goInstanceId: r.goInstanceId, compIndex: r.compIndex }, (ok) => { if (ok) flashHighlight(r.compIndex) })}
                                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left hover:bg-[var(--cream-warm)]/50 mb-0.5">
                                    <Crosshair size={10} className="text-[var(--coffee-muted)] opacity-40 flex-shrink-0" />
                                    <span className="truncate font-medium text-[var(--coffee-deep)]">{r.goName}</span>
                                    {r.parentName && <span className="text-[var(--coffee-muted)] opacity-50 text-[10px] truncate">{r.parentName}</span>}
                                    <span className="ml-auto text-[10px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">#{r.goInstanceId}</span>
                                </button>
                            ))}
                            {scanInfo?.truncated && (
                                <div className="mt-1 px-2 py-1 rounded bg-[var(--caramel)]/10 text-[var(--coffee-muted)] text-[10px]">
                                    截断: 显示 {scanInfo.shown}/{scanInfo.total}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Name 模式 / 默认：场景树 */}
                    {filterMode === 'name' && tree && sceneSections.map(section => (
                        <SceneSection key={section.key} section={section}
                            selectedId={selectedId}
                            expanded={expanded}
                            childrenMap={childrenMap}
                            loadingChildren={loadingChildren}
                            filterText={filterText}
                            onToggle={toggleExpand}
                            onSelect={selectNode}
                        />
                    ))}
                </div>
            </div>

            {/* ===== Drag Handle ===== */}
            <div className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
                onMouseDown={e => { e.preventDefault(); isDragging.current = true }} />

            {/* ===== Right Panel: Inspector ===== */}
            <div className="flex-1 min-w-0 overflow-y-auto p-3">
                {!selectedId && (
                    <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                        {wsConnected ? '在左侧选中一个 GameObject 查看其 Component' : 'WebSocket 连接中...'}
                    </div>
                )}
                {selectedId && (
                    <Inspector
                        detail={goDetail}
                        loading={loadingDetail}
                        highlightCompIndex={highlightCompIndex}
                        expandedCompTypes={expandedCompTypes}
                        onToggleCompType={toggleCompType}
                        methodResults={methodResults}
                        onRefresh={() => loadDetail(selectedId)}
                        onSetProp={setProp}
                        onCallMethod={callMethod}
                        onLoadCollection={loadCollectionItems}
                        onLocate={(instanceId) => locateAndSelect({ instanceId }, () => {})}
                    />
                )}
            </div>

            {/* Locate 进行中的遮罩 — 避免点 🎯 后界面看似无反应 */}
            {locating && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/40 backdrop-blur-[2px] pointer-events-auto cursor-wait">
                    <div className="px-4 py-2 rounded-lg bg-white shadow-lg border border-[var(--glass-border)] flex items-center gap-2">
                        <Loader2 size={16} className="animate-spin text-[var(--caramel)]" />
                        <span className="text-sm text-[var(--coffee-deep)]">定位中...</span>
                    </div>
                </div>
            )}

            <HierarchySearchModal
                open={searchOpen}
                onClose={() => setSearchOpen(false)}
                scenes={tree?.scenes || []}
                onSearch={handleSearch}
                onLocateHit={locateSearchHit}
            />
        </div>
    )
}

// ============================================================================
// 左侧场景分段 + 递归节点
// ============================================================================
function SceneSection({ section, selectedId, expanded, childrenMap, loadingChildren, filterText, onToggle, onSelect }) {
    const [open, setOpen] = useState(true)
    const filterLower = filterText.toLowerCase()

    return (
        <div className="mb-1">
            <button onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--cream-warm)]/40 text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide">
                {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <span>{section.label}</span>
                <span className="ml-auto opacity-40">{section.roots.length}</span>
            </button>
            {open && section.roots.map(node => (
                <TreeNode key={node.instanceId} node={node} depth={0}
                    selectedId={selectedId}
                    expanded={expanded}
                    childrenMap={childrenMap}
                    loadingChildren={loadingChildren}
                    filterLower={filterLower}
                    onToggle={onToggle}
                    onSelect={onSelect}
                />
            ))}
        </div>
    )
}

function TreeNode({ node, depth, selectedId, expanded, childrenMap, loadingChildren, filterLower, onToggle, onSelect }) {
    const isExpanded = expanded.has(node.instanceId)
    const hasChildren = (node.childCount ?? 0) > 0
    const children = childrenMap[node.instanceId]
    const isSelected = selectedId === node.instanceId
    const isLoading = !!loadingChildren[node.instanceId]
    const matchSelf = !filterLower || node.name.toLowerCase().includes(filterLower)

    // 过滤策略：自身命中 → 显示自身；否则若子节点已加载，递归仅显示有命中后代的链
    const filteredChildren = useMemo(() => {
        if (!filterLower || !children) return children
        return children.filter(c => nodeMatches(c, filterLower, childrenMap))
    }, [children, filterLower, childrenMap])

    if (filterLower && !matchSelf && (!filteredChildren || filteredChildren.length === 0)) {
        return null
    }

    return (
        <div>
            <div className={`flex items-center gap-1 py-0.5 pr-1 rounded text-xs cursor-pointer select-none ${
                isSelected ? 'bg-[var(--caramel)]/20 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
            }`}
                style={{ paddingLeft: 4 + depth * 12 }}
                onClick={() => onSelect(node.instanceId)}>
                {hasChildren ? (
                    <button onClick={(e) => { e.stopPropagation(); onToggle(node) }} className="flex-shrink-0 p-0 text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]">
                        {isLoading ? <Loader2 size={10} className="animate-spin" /> : (isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
                    </button>
                ) : (
                    <span className="w-2.5 flex-shrink-0" />
                )}
                <span className={`truncate ${node.activeInHierarchy === false ? 'opacity-40' : ''}`} title={`#${node.instanceId} ${node.name}`}>
                    {node.name}
                </span>
                {hasChildren && <span className="ml-auto text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{node.childCount}</span>}
            </div>
            {isExpanded && filteredChildren && filteredChildren.map(c => (
                <TreeNode key={c.instanceId} node={c} depth={depth + 1}
                    selectedId={selectedId}
                    expanded={expanded}
                    childrenMap={childrenMap}
                    loadingChildren={loadingChildren}
                    filterLower={filterLower}
                    onToggle={onToggle}
                    onSelect={onSelect}
                />
            ))}
        </div>
    )
}

// 仅在子节点已经加载的范围内做过滤判断（不主动拉取）
function nodeMatches(node, filterLower, childrenMap) {
    if (node.name.toLowerCase().includes(filterLower)) return true
    const cs = childrenMap[node.instanceId]
    if (!cs) return false
    return cs.some(c => nodeMatches(c, filterLower, childrenMap))
}

// ============================================================================
// 右侧 Inspector
// ============================================================================
function Inspector({ detail, loading, highlightCompIndex, expandedCompTypes, onToggleCompType, methodResults, onRefresh, onSetProp, onCallMethod, onLoadCollection, onLocate }) {
    if (loading && !detail) {
        return <div className="flex items-center justify-center gap-2 h-32 text-[var(--coffee-muted)] text-sm"><Loader2 size={16} className="animate-spin" /> 加载中...</div>
    }
    if (!detail) return null
    if (detail.error) {
        return (
            <div className="px-3 py-2 rounded-md bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs font-mono">
                {detail.error}
                <button onClick={onRefresh} className="ml-3 underline opacity-70 hover:opacity-100">重试</button>
            </div>
        )
    }

    return (
        <div className="space-y-2">
            {/* 顶部：GO 信息 */}
            <div className="rounded-lg border border-[var(--glass-border)] bg-white/40 px-3 py-2">
                <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${detail.activeInHierarchy ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'}`} />
                    <span className="text-sm font-semibold text-[var(--coffee-deep)] truncate select-text" title={detail.hierarchyPath}>{detail.name}</span>
                    {detail.activeInHierarchy === false && <span className="text-[10px] text-[var(--caramel)] flex-shrink-0">(inactive)</span>}
                    <button onClick={onRefresh} className="ml-auto p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] flex-shrink-0" title="刷新 Inspector">
                        <RotateCw size={12} className={loading ? 'animate-spin' : ''} />
                    </button>
                    <span className="text-[10px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">#{detail.instanceId}</span>
                </div>
                {detail.hierarchyPath && (
                    <div className="mt-1 text-[10px] text-[var(--coffee-muted)] opacity-60 truncate select-text" title={detail.hierarchyPath}>{detail.hierarchyPath}</div>
                )}
                <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--coffee-muted)]">
                    <span>layer: <span className="font-mono">{detail.layer ?? '-'}</span></span>
                    <span>tag: <span className="font-mono">{detail.tag || '-'}</span></span>
                    <span>components: <span className="font-mono">{detail.components?.length || 0}</span></span>
                </div>
            </div>

            {/* Component 列表 */}
            {(detail.components || []).map(comp => (
                <ComponentCard key={comp.compIndex} comp={comp}
                    highlight={highlightCompIndex === comp.compIndex}
                    expanded={expandedCompTypes.has(comp.typeName) || highlightCompIndex === comp.compIndex}
                    onToggleExpanded={() => onToggleCompType(comp.typeName)}
                    methodResults={methodResults}
                    onSetProp={onSetProp}
                    onCallMethod={onCallMethod}
                    onLoadCollection={onLoadCollection}
                    onLocate={onLocate}
                />
            ))}
        </div>
    )
}

function ComponentCard({ comp, highlight, expanded, onToggleExpanded, methodResults, onSetProp, onCallMethod, onLoadCollection, onLocate }) {
    const [filter, setFilter] = useState('')
    const [propsCollapsed, setPropsCollapsed] = useState(false)
    const [methodsCollapsed, setMethodsCollapsed] = useState(true)

    const lf = filter.toLowerCase()
    const filteredProps = (comp.properties || []).filter(p => !lf || p.name.toLowerCase().includes(lf))
    const filteredMethods = (comp.methods || []).filter(m => !lf || m.name.toLowerCase().includes(lf))

    return (
        <div className={`rounded-lg border overflow-hidden ${highlight ? 'border-[var(--caramel)] shadow-[0_0_0_2px_var(--caramel-soft)]' : 'border-[var(--glass-border)]'} bg-white/30`}>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--cream-warm)]/30 cursor-pointer select-none" onClick={onToggleExpanded}>
                {expanded ? <ChevronDown size={14} className="text-[var(--coffee-muted)]" /> : <ChevronRight size={14} className="text-[var(--coffee-muted)]" />}
                <span className="text-sm font-medium text-[var(--coffee-deep)]">{comp.typeName}</span>
                {comp.enabled === false && <span className="text-[10px] text-[var(--caramel)] flex-shrink-0">(disabled)</span>}
                {comp.error && <span className="text-[10px] text-[var(--terracotta)] flex-shrink-0" title={comp.error}>⚠</span>}
                {comp.fullTypeName && comp.fullTypeName !== comp.typeName && (
                    <span className="text-[10px] text-[var(--coffee-muted)] opacity-40 truncate min-w-0" title={comp.fullTypeName}>{comp.fullTypeName}</span>
                )}
                <span className="ml-auto text-[10px] text-[var(--coffee-muted)] opacity-30 flex-shrink-0">#{comp.compIndex}</span>
            </div>

            {expanded && (
                <div className="p-2">
                    {comp.error && <div className="text-[var(--terracotta)] text-xs py-1">{comp.error}</div>}
                    {!comp.error && (
                        <>
                            <div className="mb-1">
                                <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                                    placeholder="搜索属性 / 方法..."
                                    className="w-full px-2 py-1 text-[10px] rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                                />
                            </div>

                            <div className="mb-1">
                                <button onClick={() => setPropsCollapsed(!propsCollapsed)}
                                    className="flex items-center gap-1 text-[10px] font-semibold text-[#7D9B76] mb-0.5 hover:opacity-80">
                                    {propsCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                    属性 ({filteredProps.length}{filter ? ' / ' + (comp.properties?.length || 0) : ''})
                                </button>
                                {!propsCollapsed && (
                                    <div className="space-y-0.5 max-h-[400px] overflow-y-auto">
                                        {filteredProps.map((p, i) => (
                                            <PropRow key={`${p.name}_${i}`} prop={p}
                                                onSet={(val) => onSetProp(comp.compIndex, p.name, val, p.valueType)}
                                                onLoadCollection={(propName, offset, limit, cb) => onLoadCollection && onLoadCollection(comp.compIndex, propName, offset, limit, cb)}
                                                onLocate={onLocate}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div>
                                <button onClick={() => setMethodsCollapsed(!methodsCollapsed)}
                                    className="flex items-center gap-1 text-[10px] font-semibold text-[#9B7DBF] mb-0.5 hover:opacity-80">
                                    {methodsCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                    方法 ({filteredMethods.length}{filter ? ' / ' + (comp.methods?.length || 0) : ''})
                                </button>
                                {!methodsCollapsed && (
                                    <div className="space-y-0.5 max-h-60 overflow-y-auto">
                                        {filteredMethods.map((m, i) => {
                                            const rKey = `${comp.compIndex}_${m.name}`
                                            const result = methodResults[rKey]
                                            return (
                                                <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
                                                    <span className="font-mono text-[var(--coffee-deep)] truncate min-w-0">{m.name}({m.params?.map(p => p.name).join(', ')})</span>
                                                    <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                                                        {result && (
                                                            <>
                                                                <span className={`text-[10px] font-mono truncate max-w-[160px] ${result.error ? 'text-[var(--terracotta)]' : 'text-[var(--sage)]'}`}>
                                                                    {result.error ? `✗ ${result.error}` : `→ ${result.result}`}
                                                                </span>
                                                                {result.result && !result.error && (
                                                                    <button onClick={() => copyText(result.result)}
                                                                        className="p-0.5 rounded hover:bg-black/5 text-[var(--coffee-muted)]" title="复制返回值">
                                                                        <Clipboard size={10} />
                                                                    </button>
                                                                )}
                                                            </>
                                                        )}
                                                        {m.paramCount === 0 && m.callable !== false && (
                                                            <button onClick={() => onCallMethod(comp.compIndex, m.name)}
                                                                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--sage)]/10 text-[var(--sage)] hover:bg-[var(--sage)]/20">
                                                                ▶ Call
                                                            </button>
                                                        )}
                                                    </div>
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
