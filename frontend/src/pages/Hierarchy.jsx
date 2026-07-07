import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { RotateCw, ChevronRight, ChevronDown, Loader2, Search, Clipboard, Crosshair, X, Eye, EyeOff } from 'lucide-react'
import { copyText } from '../utils/clipboard'
import PropRow from '../components/PropRow'
import HierarchySearchModal from '../components/HierarchySearchModal'

const GO_SEARCH_MAX_OBJECTS = 20000

function waitForNextPaint() {
    return new Promise(resolve => {
        if (typeof window !== 'undefined' && window.requestAnimationFrame) {
            window.requestAnimationFrame(() => window.setTimeout(resolve, 0))
            return
        }
        setTimeout(resolve, 0)
    })
}

function patchNodeActive(node, instanceId, active, activeInHierarchy) {
    if (!node) return node
    if (node.instanceId === instanceId) {
        return { ...node, active, activeInHierarchy }
    }
    return node
}

function patchNodeListActive(list, instanceId, active, activeInHierarchy) {
    if (!Array.isArray(list)) return list
    let changed = false
    const next = list.map(node => {
        const patched = patchNodeActive(node, instanceId, active, activeInHierarchy)
        if (patched !== node) changed = true
        return patched
    })
    return changed ? next : list
}

// ============================================================================
// WebSocket Hook（与 LuaUiInspector 同款）
// ============================================================================
function useHierarchyWs(selectedClient, active) {
    const listenersRef = useRef({})
    const wsRef = useRef(null)
    const [wsConnected, setWsConnected] = useState(false)

    useEffect(() => {
        if (!active || !selectedClient) return
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
    }, [selectedClient?.id, active])

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
function Hierarchy({ clients, selectedClient, pendingLocate, onPendingLocateConsumed, active }) {
    const { request, wsConnected } = useHierarchyWs(selectedClient, active)

    // --- 拖拽分栏 ---
    const [leftWidth, setLeftWidth] = useState(280)
    const isDragging = useRef(false)

    // --- 树数据 ---
    const [tree, setTree] = useState(null)               // { scenes:[{name,roots:[]}], dontDestroy:[] }
    const [childrenMap, setChildrenMap] = useState({})   // instanceId → HierarchyNode[]
    const [expanded, setExpanded] = useState(new Set())  // Set<instanceId>
    const childrenMapRef = useRef({})
    const expandedRef = useRef(new Set())
    const [loadingTree, setLoadingTree] = useState(false)
    const [loadingChildren, setLoadingChildren] = useState({}) // instanceId → bool

    // --- 选中 / Inspector ---
    const [selectedId, setSelectedId] = useState(null)
    const [goDetail, setGoDetail] = useState(null)
    const [loadingDetail, setLoadingDetail] = useState(false)
    const [highlightCompIndex, setHighlightCompIndex] = useState(null)

    // --- GO 搜索（普通搜索只负责按 GO 名/路径定位，Component/字段/类型交给高级搜索） ---
    const [filterText, setFilterText] = useState('')
    const [goSearchQuery, setGoSearchQuery] = useState('')
    const [goSearchResults, setGoSearchResults] = useState(null)
    const [goSearchInfo, setGoSearchInfo] = useState(null)
    const [goSearching, setGoSearching] = useState(false)
    const goSearchSeqRef = useRef(0)
    const [searchOpen, setSearchOpen] = useState(false)

    // --- 刷新控制 ---
    const [refreshInterval, setRefreshInterval] = useState(60)
    const [autoRefresh, setAutoRefresh] = useState(true) // 默认开启 60s

    useEffect(() => { childrenMapRef.current = childrenMap }, [childrenMap])
    useEffect(() => { expandedRef.current = expanded }, [expanded])

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
    const resetTreeViewState = useCallback(() => {
        childrenMapRef.current = {}
        expandedRef.current = new Set()
        setChildrenMap({})
        setExpanded(new Set())
        setLoadingChildren({})
        setSelectedId(null)
        setGoDetail(null)
        setHighlightCompIndex(null)
        setFilterText('')
        setGoSearchQuery('')
        setGoSearching(false)
        setGoSearchResults(null)
        setGoSearchInfo(null)
    }, [])

    const loadTree = useCallback((options = {}) => {
        if (options?.reset) resetTreeViewState()
        setLoadingTree(true)
        request('scene_roots', {}, (data) => {
            setLoadingTree(false)
            if (data?.error) { setTree({ scenes: [], dontDestroy: [], error: data.error }); return }
            setTree(data || { scenes: [], dontDestroy: [] })
        })
    }, [request, resetTreeViewState])

    const clearGoSearch = useCallback(() => {
        setFilterText('')
        setGoSearchQuery('')
        setGoSearchResults(null)
        setGoSearchInfo(null)
        setGoSearching(false)
    }, [])

    const submitGoSearch = useCallback(() => {
        const q = filterText.trim()
        setGoSearchQuery(q)
        if (!q) {
            setGoSearchResults(null)
            setGoSearchInfo(null)
            setGoSearching(false)
        }
    }, [filterText])

    // --- 加载子节点 ---
    const requestChildren = useCallback((instanceId, options = {}) => new Promise(resolve => {
        setLoadingChildren(prev => ({ ...prev, [instanceId]: true }))
        request('children', { instanceId }, (data) => {
            setLoadingChildren(prev => { const n = { ...prev }; delete n[instanceId]; return n })
            if (data?.error) {
                if (options.dropOnError) {
                    setChildrenMap(prev => {
                        if (!Object.prototype.hasOwnProperty.call(prev, instanceId)) return prev
                        const next = { ...prev }
                        delete next[instanceId]
                        childrenMapRef.current = next
                        return next
                    })
                    setExpanded(prev => {
                        if (!prev.has(instanceId)) return prev
                        const next = new Set(prev)
                        next.delete(instanceId)
                        expandedRef.current = next
                        return next
                    })
                }
                resolve(data)
                return
            }
            setChildrenMap(prev => {
                const next = { ...prev, [instanceId]: data.children || [] }
                childrenMapRef.current = next
                return next
            })
            resolve(data)
        })
    }), [request])

    const loadChildren = useCallback((instanceId) => {
        requestChildren(instanceId)
    }, [requestChildren])

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

    const refreshLoadedChildrenSequentially = useCallback(async (expandedIds) => {
        for (const id of expandedIds) {
            if (!childrenMapRef.current[id]) continue
            await requestChildren(id, { dropOnError: true })
            await waitForNextPaint()
        }
    }, [requestChildren])

    const refreshTreePreservingView = useCallback(() => {
        const expandedIds = [...expandedRef.current]
        const selectedBeforeRefresh = selectedId
        setLoadingTree(true)
        request('scene_roots', {}, async (data) => {
            if (data?.error) {
                setTree({ scenes: [], dontDestroy: [], error: data.error })
                setLoadingTree(false)
                return
            }
            setTree(data || { scenes: [], dontDestroy: [] })
            await refreshLoadedChildrenSequentially(expandedIds)
            if (selectedBeforeRefresh) loadDetail(selectedBeforeRefresh)
            setLoadingTree(false)
        })
    }, [request, refreshLoadedChildrenSequentially, selectedId, loadDetail])

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
                if (!childrenMapRef.current[id] && (node.childCount ?? 0) > 0) loadChildren(id)
            }
            return next
        })
    }, [loadChildren])

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

    const applyGoActiveState = useCallback((instanceId, active, activeInHierarchy = active) => {
        setTree(prev => {
            if (!prev) return prev
            return {
                ...prev,
                scenes: (prev.scenes || []).map(scene => ({
                    ...scene,
                    roots: patchNodeListActive(scene.roots, instanceId, active, activeInHierarchy),
                })),
                dontDestroy: patchNodeListActive(prev.dontDestroy, instanceId, active, activeInHierarchy),
            }
        })
        setChildrenMap(prev => {
            let changed = false
            const next = {}
            for (const [key, list] of Object.entries(prev)) {
                const patched = patchNodeListActive(list, instanceId, active, activeInHierarchy)
                next[key] = patched
                if (patched !== list) changed = true
            }
            if (changed) childrenMapRef.current = next
            return changed ? next : prev
        })
        setGoSearchResults(prev => prev
            ? prev.map(row => row.goInstanceId === instanceId ? { ...row, active, activeInHierarchy } : row)
            : prev
        )
        setGoDetail(prev => prev?.instanceId === instanceId ? { ...prev, active, activeInHierarchy } : prev)
    }, [])

    const setGoActiveById = useCallback((instanceId, active) => {
        if (!instanceId) return
        request('set_go_active', { instanceId, active }, (data) => {
            if (data?.error) return
            const nextActive = data?.active ?? active
            const nextActiveInHierarchy = data?.activeInHierarchy ?? nextActive
            applyGoActiveState(instanceId, nextActive, nextActiveInHierarchy)
            if (selectedId === instanceId) loadDetail(instanceId)
        })
    }, [request, selectedId, loadDetail, applyGoActiveState])

    const setGoActive = useCallback((active) => {
        if (!selectedId) return
        setGoActiveById(selectedId, active)
    }, [selectedId, setGoActiveById])

    const setComponentEnabled = useCallback((compIndex, enabled) => {
        if (!selectedId) return
        request('set_component_enabled', { instanceId: selectedId, compIndex, enabled }, () => {
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

    // --- 高级搜索：复用 Hierarchy 通道，结果点击后走现有 Locate 流程 ---
    const handleSearch = useCallback((params, cb) => {
        request('search', params, (data) => cb && cb(data))
    }, [request])

    // --- 普通搜索：全场景 GO 名/路径搜索，语义贴近 Unity Hierarchy ---
    useEffect(() => {
        const q = goSearchQuery.trim()
        const seq = goSearchSeqRef.current + 1
        goSearchSeqRef.current = seq

        if (!q) {
            setGoSearching(false)
            setGoSearchResults(null)
            setGoSearchInfo(null)
            return
        }

        if (!selectedClient || !wsConnected) {
            setGoSearching(false)
            setGoSearchResults([])
            setGoSearchInfo({ error: 'Hierarchy 未连接' })
            return
        }

        setGoSearching(true)
        setGoSearchResults([])
        setGoSearchInfo(null)

        const normalizeResults = (data) => {
            const rows = data?.results || data?.hits || []
            return rows.filter(r => {
                if (r.goInstanceId == null || r.goInstanceId === -1) return false
                return !r.memberKind || r.memberKind === 'go'
            })
        }

        const applyResult = (data) => {
            if (seq !== goSearchSeqRef.current) return
            if (data?.query && data.query !== q) return
            setGoSearching(false)
            if (data?.error) {
                setGoSearchResults([])
                setGoSearchInfo({ error: data.error })
                return
            }
            setGoSearchResults(normalizeResults(data))
            setGoSearchInfo({
                objectCount: data?.objectCount || 0,
                elapsedMs: data?.elapsedMs || 0,
                truncated: !!data?.truncated,
                maxObjects: data?.maxObjects || GO_SEARCH_MAX_OBJECTS,
            })
        }

        const timer = setTimeout(() => {
            request('go_search', {
                query: q,
                scope: 'all',
                includeInactive: true,
                maxObjects: GO_SEARCH_MAX_OBJECTS,
            }, applyResult)
        }, 250)

        return () => clearTimeout(timer)
    }, [goSearchQuery, selectedClient?.id, wsConnected, request])

    // --- Locate 流程：展开父链 + 选中目标 ---
    const [locating, setLocating] = useState(false)
    const fetchChildrenForLocate = useCallback((instanceId) => new Promise(resolve => {
        if (childrenMapRef.current[instanceId]) { resolve(); return }
        setLoadingChildren(prev => ({ ...prev, [instanceId]: true }))
        request('children', { instanceId }, (resp) => {
            setLoadingChildren(prev => { const n = { ...prev }; delete n[instanceId]; return n })
            if (!resp?.error) {
                setChildrenMap(prev => {
                    const next = { ...prev, [instanceId]: resp.children || [] }
                    childrenMapRef.current = next
                    return next
                })
            }
            resolve()
        })
    }), [request])

    const locateAndSelect = useCallback((locateParams, onDone, options = {}) => {
        const resetExpanded = !!options.resetExpanded
        const finish = (success) => { setLocating(false); onDone && onDone(success) }
        const applyLocate = (data) => {
            if (data?.error || !data?.found) { finish(false); return }
            const chain = data.ancestorChain || []
            const target = data.instanceId
            const parentChain = chain.slice(0, -1)

            setSelectedId(target)
            setHighlightCompIndex(null)
            loadDetail(target)
            finish(true)

            // 模拟手动逐层展开：每展开一层就让浏览器完成一次绘制，避免整条父链在同一帧压垮 WebView。
            const fetchChain = async () => {
                let baseExpanded = resetExpanded ? new Set() : new Set(expandedRef.current)
                for (let i = 0; i < parentChain.length; i++) {
                    const id = parentChain[i]
                    baseExpanded = resetExpanded ? new Set(parentChain.slice(0, i + 1)) : new Set(baseExpanded).add(id)
                    expandedRef.current = baseExpanded
                    setExpanded(baseExpanded)
                    await fetchChildrenForLocate(id)
                    await waitForNextPaint()
                }
            }
            fetchChain()
        }

        const directTarget = locateParams?.instanceId || locateParams?.goInstanceId
        if (directTarget && locateParams?.ancestorChain) {
            applyLocate({ found: true, instanceId: directTarget, ancestorChain: locateParams.ancestorChain })
            return
        }

        setLocating(true)
        request('locate', locateParams, applyLocate)
    }, [request, loadDetail, fetchChildrenForLocate])

    const locateSearchHit = useCallback((hit) => {
        const compIndex = hit?.compIndex
        const params = { instanceId: hit.goInstanceId }
        if (compIndex != null) params.compIndex = compIndex
        const run = () => locateAndSelect(params, (success) => {
            if (success && compIndex != null) flashHighlight(compIndex)
        }, { resetExpanded: true })
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
        childrenMapRef.current = {}
        expandedRef.current = new Set()
        setTree(null); setChildrenMap({}); setExpanded(new Set())
        setSelectedId(null); setGoDetail(null); setGoSearchResults(null); setGoSearchInfo(null); setFilterText(''); setGoSearchQuery('')
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
                            <button onClick={() => refreshTreePreservingView()} disabled={!selectedClient || loadingTree}
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
                            onKeyDown={e => {
                                if (e.nativeEvent?.isComposing) return
                                if (e.key === 'Escape') clearGoSearch()
                                if (e.key === 'Enter') submitGoSearch()
                            }}
                            placeholder="搜索 GO 名或路径..."
                            className="flex-1 px-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                        />
                        {filterText && (
                            <button onClick={clearGoSearch}
                                className="p-1 rounded text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:bg-black/5"
                                title="清空 GO 搜索">
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </div>

                {/* 树 / 扫描结果 */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {loadingTree && <div className="flex items-center justify-center gap-1.5 py-4 text-[var(--coffee-muted)]"><Loader2 size={14} className="animate-spin" /><span>加载场景...</span></div>}
                    {!loadingTree && tree?.error && <div className="px-2 py-1.5 mb-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs">{tree.error}</div>}

                    {goSearchQuery.trim() && (
                        <GoSearchResults
                            query={goSearchQuery.trim()}
                            results={goSearchResults}
                            info={goSearchInfo}
                            loading={goSearching}
                            onLocate={(hit) => {
                                clearGoSearch()
                                locateAndSelect({ instanceId: hit.goInstanceId, ancestorChain: hit.ancestorChain }, () => {}, { resetExpanded: true })
                            }}
                            onSetActive={(hit, active) => setGoActiveById(hit.goInstanceId, active)}
                            onOpenAdvanced={() => setSearchOpen(true)}
                        />
                    )}

                    {!goSearchQuery.trim() && tree && sceneSections.map(section => (
                        <SceneSection key={section.key} section={section}
                            selectedId={selectedId}
                            expanded={expanded}
                            childrenMap={childrenMap}
                            loadingChildren={loadingChildren}
                            filterText=""
                            onToggle={toggleExpand}
                            onSelect={selectNode}
                            onSetActive={setGoActiveById}
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
                        onSetGoActive={setGoActive}
                        onSetProp={setProp}
                        onSetComponentEnabled={setComponentEnabled}
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

function compactHierarchyPath(path) {
    if (!path) return ''
    const parts = String(path).split('/').filter(Boolean)
    if (parts.length <= 3) return path
    return `${parts[0]}/.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function GoSearchResults({ query, results, info, loading, onLocate, onSetActive, onOpenAdvanced }) {
    const rows = results || []
    return (
        <div className="mb-2">
            <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] text-[var(--coffee-muted)]">
                <Search size={10} className={loading ? 'animate-pulse text-[var(--caramel)]' : ''} />
                <span className="truncate">GO: {query}</span>
                {info && !info.error && (
                    <span className="ml-auto flex-shrink-0">
                        {rows.length} 条 · {info.objectCount || 0} GO · {info.elapsedMs || 0}ms
                    </span>
                )}
            </div>

            {info?.error && (
                <div className="px-2 py-1.5 mb-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs">
                    {info.error}
                </div>
            )}

            {loading && (
                <div className="flex items-center gap-1.5 py-2 text-[var(--coffee-muted)]">
                    <Loader2 size={12} className="animate-spin" />
                    <span>搜索 GO...</span>
                </div>
            )}

            {!loading && rows.length === 0 && !info?.error && (
                <div className="px-2 py-3 text-center text-[var(--coffee-muted)]">
                    <div>无匹配 GO</div>
                    <button onClick={onOpenAdvanced}
                        className="mt-1 text-[10px] text-[var(--caramel)] hover:underline">
                        打开高级搜索
                    </button>
                </div>
            )}

            {rows.map((r, i) => {
                const path = r.hierarchyPath || r.goName || `#${r.goInstanceId}`
                const compactPath = compactHierarchyPath(path)
                return (
                    <div key={`${r.goInstanceId}_${i}`} role="button" tabIndex={0}
                        onClick={() => onLocate(r)}
                        onKeyDown={e => { if (e.key === 'Enter') onLocate(r) }}
                        className="group/go-result w-full px-2 py-1.5 rounded text-left hover:bg-[var(--cream-warm)]/55 mb-0.5 border border-transparent hover:border-[var(--glass-border)] transition-colors cursor-pointer">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <Crosshair size={10} className="text-[var(--coffee-muted)] opacity-40 flex-shrink-0" />
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.activeInHierarchy === false ? 'bg-[var(--coffee-muted)]/30' : 'bg-[var(--sage)]'}`} />
                            <span className="truncate font-medium text-[var(--coffee-deep)]">{r.goName || compactPath}</span>
                            {r.sceneName && <span className="px-1 rounded bg-black/5 text-[9px] text-[var(--coffee-muted)] flex-shrink-0">{r.sceneName}</span>}
                            <button
                                type="button"
                                onClick={e => {
                                    e.stopPropagation()
                                    onSetActive(r, r.active === false)
                                }}
                                className="ml-auto p-0.5 rounded text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:bg-black/10 opacity-0 group-hover/go-result:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
                                title={r.active === false ? '显示 GameObject' : '隐藏 GameObject'}
                            >
                                {r.active === false ? <Eye size={11} /> : <EyeOff size={11} />}
                            </button>
                            <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">#{r.goInstanceId}</span>
                        </div>
                        {path && (
                            <div className="mt-0.5 pl-4 font-mono text-[10px] text-[var(--coffee-muted)] truncate" title={path}>
                                {compactPath}
                            </div>
                        )}
                    </div>
                )
            })}

            {info?.truncated && (
                <div className="mt-1 px-2 py-1 rounded bg-[var(--caramel)]/10 text-[var(--coffee-muted)] text-[10px]">
                    GO 扫描达到 {info.maxObjects || GO_SEARCH_MAX_OBJECTS}，结果可能不全
                </div>
            )}
        </div>
    )
}

// ============================================================================
// 左侧场景分段 + 递归节点
// ============================================================================
function SceneSection({ section, selectedId, expanded, childrenMap, loadingChildren, filterText, onToggle, onSelect, onSetActive }) {
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
                    onSetActive={onSetActive}
                />
            ))}
        </div>
    )
}

function TreeNode({ node, depth, selectedId, expanded, childrenMap, loadingChildren, filterLower, onToggle, onSelect, onSetActive }) {
    const rowRef = useRef(null)
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

    useEffect(() => {
        if (!isSelected || filterLower) return
        const timer = setTimeout(() => rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
        return () => clearTimeout(timer)
    }, [isSelected, filterLower])

    if (filterLower && !matchSelf && (!filteredChildren || filteredChildren.length === 0)) {
        return null
    }

    return (
        <div>
            <div className={`group/tree-node flex items-center gap-1 py-0.5 pr-1 rounded text-xs cursor-pointer select-none ${
                isSelected ? 'bg-[var(--caramel)]/20 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
            }`}
                ref={rowRef}
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
                <button
                    type="button"
                    onClick={e => {
                        e.stopPropagation()
                        onSetActive(node.instanceId, node.active === false)
                    }}
                    className="ml-auto p-0.5 rounded text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:bg-black/10 opacity-0 group-hover/tree-node:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
                    title={node.active === false ? '显示 GameObject' : '隐藏 GameObject'}
                >
                    {node.active === false ? <Eye size={10} /> : <EyeOff size={10} />}
                </button>
                {hasChildren && <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{node.childCount}</span>}
            </div>
            {isExpanded && filteredChildren && (
                <>
                    {filteredChildren.map(c => (
                        <TreeNode key={c.instanceId} node={c} depth={depth + 1}
                            selectedId={selectedId}
                            expanded={expanded}
                            childrenMap={childrenMap}
                            loadingChildren={loadingChildren}
                            filterLower={filterLower}
                            onToggle={onToggle}
                            onSelect={onSelect}
                            onSetActive={onSetActive}
                        />
                    ))}
                </>
            )}
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
function Inspector({ detail, loading, highlightCompIndex, expandedCompTypes, onToggleCompType, methodResults, onRefresh, onSetGoActive, onSetProp, onSetComponentEnabled, onCallMethod, onLoadCollection, onLocate }) {
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
                    <input type="checkbox"
                        checked={!!detail.active}
                        onChange={e => onSetGoActive(e.target.checked)}
                        className="!w-3.5 !h-3.5 !p-0 accent-[var(--sage)] flex-shrink-0"
                        title={detail.active ? '隐藏 GameObject (SetActive false)' : '显示 GameObject (SetActive true)'}
                    />
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${detail.activeInHierarchy ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'}`} title={detail.activeInHierarchy ? 'activeInHierarchy: true' : 'activeInHierarchy: false'} />
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
                    onSetEnabled={onSetComponentEnabled}
                    onCallMethod={onCallMethod}
                    onLoadCollection={onLoadCollection}
                    onLocate={onLocate}
                />
            ))}
        </div>
    )
}

function ComponentCard({ comp, highlight, expanded, onToggleExpanded, methodResults, onSetProp, onSetEnabled, onCallMethod, onLoadCollection, onLocate }) {
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
                {typeof comp.enabled === 'boolean' && (
                    <input type="checkbox"
                        checked={comp.enabled}
                        onClick={e => e.stopPropagation()}
                        onChange={e => onSetEnabled(comp.compIndex, e.target.checked)}
                        className="!w-3.5 !h-3.5 !p-0 accent-[var(--sage)] flex-shrink-0"
                        title={comp.enabled ? '禁用组件' : '启用组件'}
                    />
                )}
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

export default memo(Hierarchy)
