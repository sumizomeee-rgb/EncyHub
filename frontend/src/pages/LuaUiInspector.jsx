import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, RotateCw, ChevronRight, ChevronDown, Undo2, Play, Pause, Eye, PlayCircle, Loader2 } from 'lucide-react'

// localStorage 持久化分类展开状态
const CATEGORY_STORAGE_KEY = 'inspector_expanded_categories'
function loadExpandedCategories() {
    try {
        const saved = localStorage.getItem(CATEGORY_STORAGE_KEY)
        return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch { return new Set() }
}
function saveExpandedCategories(set) {
    try { localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify([...set])) } catch {}
}

// ============================================================================
// WebSocket 通信 Hook
// ============================================================================
function useInspectorWs(selectedClient) {
    const listenersRef = useRef({})
    const wsRef = useRef(null)
    const [wsConnected, setWsConnected] = useState(false)
    const reconnectTimer = useRef(null)

    useEffect(() => {
        if (!selectedClient) return
        let closed = false

        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const socket = new WebSocket(
                `${protocol}//${window.location.host}/api/gm_console/ws/inspector`
            )
            let pingTimer = null
            socket.onopen = () => {
                console.log('[Inspector WS] connected')
                setWsConnected(true)
                wsRef.current = socket
                // WS 心跳保活，每25秒发一次ping
                pingTimer = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send('ping')
                    }
                }, 25000)
            }
            socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data)
                    if (msg.client_id !== selectedClient?.id) return
                    const cb = listenersRef.current[msg.type]
                    if (cb) cb(msg.data)
                } catch (e) {
                    console.error('[Inspector WS] parse error:', e)
                }
            }
            socket.onerror = (err) => {
                console.error('[Inspector WS] error:', err)
            }
            socket.onclose = () => {
                console.log('[Inspector WS] closed')
                if (pingTimer) clearInterval(pingTimer)
                setWsConnected(false)
                wsRef.current = null
                if (!closed) {
                    reconnectTimer.current = setTimeout(connect, 2000)
                }
            }
        }

        connect()
        return () => {
            closed = true
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
            if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
            setWsConnected(false)
        }
    }, [selectedClient?.id])

    const request = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/inspector/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).then(resp => {
            if (!resp.ok) {
                console.error(`[Inspector] HTTP ${resp.status} for ${action}`)
                onResponse({ error: `HTTP ${resp.status}` })
            }
        }).catch(err => {
            console.error('[Inspector] request failed:', err)
            onResponse({ error: String(err) })
        })
    }, [selectedClient?.id])

    return { request, wsRef, wsConnected }
}

// ============================================================================
// 类型色彩
// ============================================================================
const TYPE_COLORS = {
    number: '#7D9B76',
    string: '#7D9B76',
    boolean: '#7D9B76',
    table: '#6B8FBF',
    userdata: '#D4A574',
    function: '#9B7DBF',
    nil: '#A89B91',
    ref: '#A89B91',
}

// ============================================================================
// 主组件
// ============================================================================
export default function LuaUiInspector({ clients, selectedClient, broadcastMode }) {
    // --- 左栏宽度（可拖拽） ---
    const [leftWidth, setLeftWidth] = useState(208)
    const isDragging = useRef(false)

    // --- Loading 状态 ---
    const [loadingList, setLoadingList] = useState(false)
    const [loadingNode, setLoadingNode] = useState(false)

    // --- 数据状态 ---
    const [uiList, setUiList] = useState([])
    const [uiTree, setUiTree] = useState(null)
    const [nodeData, setNodeData] = useState(null)
    const [lastError, setLastError] = useState(null)

    // --- 选中状态 ---
    const [selectedUi, setSelectedUi] = useState(null)
    const [selectedPath, setSelectedPath] = useState('')
    const [breadcrumb, setBreadcrumb] = useState([])

    // --- UI 控件 ---
    const [leftFilter, setLeftFilter] = useState('')
    const [rightFilter, setRightFilter] = useState('')
    const [depth, setDepth] = useState(3)
    const [liveMode, setLiveMode] = useState(false)
    const [liveInterval, setLiveInterval] = useState(1)

    // --- 树展开状态 ---
    const [expandedNodes, setExpandedNodes] = useState(new Set())

    // --- 字段展开状态 ---
    const [expandedFields, setExpandedFields] = useState(new Set())

    // --- 分类展开状态（默认全部折叠，localStorage 记忆） ---
    const [expandedCategories, setExpandedCategories] = useState(() => loadExpandedCategories())

    // --- 通信 ---
    const { request, wsConnected } = useInspectorWs(selectedClient)

    // --- 请求 UI 列表 ---
    const refreshUiList = useCallback(() => {
        setLastError(null)
        setLoadingList(true)
        request('ui_list', {}, (data) => {
            setLoadingList(false)
            if (data.error) { setLastError('ui_list: ' + data.error); return }
            setUiList(data)
        })
    }, [request])

    // --- 请求 UI 树 ---
    const loadUiTree = useCallback((uiName) => {
        setSelectedUi(uiName)
        setSelectedPath('')
        setBreadcrumb([{ name: uiName, path: '' }])
        setNodeData(null)
        setLastError(null)
        setExpandedNodes(new Set())
        setExpandedFields(new Set())
        setLoadingNode(true)
        let pending = 2
        const done = () => { if (--pending <= 0) setLoadingNode(false) }
        request('ui_tree', { uiName }, (data) => {
            done()
            if (data.error) { setUiTree(null); setLastError('ui_tree: ' + data.error); return }
            setUiTree(data)
        })
        // 同时请求根节点数据
        request('node_data', { uiName, path: '', depth }, (data) => {
            done()
            if (data.error) { setLastError('node_data: ' + data.error); return }
            setNodeData(data)
        })
    }, [request, depth])

    // --- 请求节点数据 ---
    const loadNodeData = useCallback((uiName, path, nodeName) => {
        setSelectedPath(path)
        setExpandedFields(new Set())
        setLastError(null)
        // 更新面包屑
        if (path === '') {
            setBreadcrumb([{ name: uiName, path: '' }])
        } else {
            const parts = path.split('.')
            const crumbs = [{ name: uiName, path: '' }]
            let p = ''
            for (const part of parts) {
                p = p ? p + '.' + part : part
                crumbs.push({ name: part, path: p })
            }
            setBreadcrumb(crumbs)
        }
        setLoadingNode(true)
        request('node_data', { uiName, path, depth }, (data) => {
            setLoadingNode(false)
            if (data.error) {
                setNodeData(null)
                setLastError('node_data: ' + data.error)
                if (String(data.error).includes('not found')) {
                    setLiveMode(false)
                }
                return
            }
            setNodeData(data)
        })
    }, [request, depth])

    // --- Live 刷新 ---
    useEffect(() => {
        if (!liveMode || !selectedUi) return
        const timer = setInterval(() => {
            request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (data) => {
                if (data.error) { setLiveMode(false); return }
                setNodeData(data)
            })
        }, liveInterval * 1000)
        return () => clearInterval(timer)
    }, [liveMode, liveInterval, selectedUi, selectedPath, depth, request])

    // --- 修改值 ---
    const setValue = useCallback((path, value, valueType) => {
        request('set_value', { uiName: selectedUi, path, value, valueType }, (data) => {
            if (data.success) {
                // 刷新当前节点
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    // --- 还原 ---
    const revertValue = useCallback((path) => {
        request('revert', { uiName: selectedUi, path }, (data) => {
            if (data.success) {
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    const revertAll = useCallback(() => {
        if (!selectedUi) return
        request('revert_all', { uiName: selectedUi }, (data) => {
            if (data.success) {
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    // --- 调用方法 ---
    const callMethod = useCallback((methodName, onResult) => {
        if (!selectedUi) return
        request('call_method', { uiName: selectedUi, path: selectedPath, methodName }, (data) => {
            if (onResult) onResult(data)
        })
    }, [request, selectedUi, selectedPath])

    // --- 无客户端时提示 ---
    if (!selectedClient) {
        return (
            <div className="flex items-center justify-center h-64 text-[var(--coffee-muted)]">
                请先在左侧选择一个客户端
            </div>
        )
    }

    // --- 左侧过滤 ---
    const filteredUiList = leftFilter
        ? uiList.filter(ui => ui.name.toLowerCase().includes(leftFilter.toLowerCase()))
        : uiList

    return (
        <div
            className="flex h-full"
            style={{ minHeight: '500px' }}
            onMouseMove={e => {
                if (!isDragging.current) return
                const container = e.currentTarget.getBoundingClientRect()
                const newWidth = Math.min(Math.max(e.clientX - container.left, 120), 400)
                setLeftWidth(newWidth)
            }}
            onMouseUp={() => { isDragging.current = false }}
            onMouseLeave={() => { isDragging.current = false }}
        >
            {/* ===== 左栏 ===== */}
            <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col" style={{ width: leftWidth }}>
                {/* UI 列表头部 */}
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center justify-between mb-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--coffee-deep)]">
                            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} title={wsConnected ? 'WS 已连接' : 'WS 未连接'} />
                            Open UIs
                        </span>
                        <button
                            onClick={refreshUiList}
                            disabled={loadingList}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors disabled:opacity-50"
                            title="刷新 UI 列表"
                        >
                            <RotateCw size={14} className={loadingList ? 'animate-spin' : ''} />
                        </button>
                    </div>
                    <div className="relative">
                        {!leftFilter && <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)] pointer-events-none" />}
                        <input
                            type="text"
                            value={leftFilter}
                            onChange={e => setLeftFilter(e.target.value)}
                            className={`w-full pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)] ${leftFilter ? 'pl-2' : 'pl-8'}`}
                        />
                    </div>
                </div>

                {/* UI 列表 + 树 */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {loadingList && (
                        <div className="flex items-center justify-center gap-1.5 py-4 text-[var(--coffee-muted)]">
                            <Loader2 size={14} className="animate-spin" />
                            <span>加载中...</span>
                        </div>
                    )}
                    {!loadingList && filteredUiList.length === 0 && (
                        <div className="text-center text-[var(--coffee-muted)] py-4">
                            {uiList.length === 0 ? '点击 Refresh 加载' : '无匹配'}
                        </div>
                    )}
                    {filteredUiList.map(ui => (
                        <UiTreeItem
                            key={ui.name}
                            ui={ui}
                            isSelected={selectedUi === ui.name}
                            selectedPath={selectedPath}
                            tree={selectedUi === ui.name ? uiTree : null}
                            expandedNodes={expandedNodes}
                            onSelectUi={() => loadUiTree(ui.name)}
                            onSelectNode={(path, name) => loadNodeData(ui.name, path, name)}
                            onToggleNode={(path) => {
                                setExpandedNodes(prev => {
                                    const next = new Set(prev)
                                    next.has(path) ? next.delete(path) : next.add(path)
                                    return next
                                })
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* ===== 拖拽条 ===== */}
            <div
                className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
                onMouseDown={e => { e.preventDefault(); isDragging.current = true }}
            />

            {/* ===== 右栏 ===== */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* 面包屑 + 控件 */}
                <div className="p-3 border-b border-[var(--glass-border)]">
                    {/* 面包屑 */}
                    <div className="flex items-center gap-1 text-xs text-[var(--coffee-muted)] mb-2 flex-wrap">
                        <Eye size={12} />
                        {breadcrumb.map((crumb, i) => (
                            <span key={crumb.path} className="flex items-center gap-1">
                                {i > 0 && <ChevronRight size={10} />}
                                <button
                                    onClick={() => loadNodeData(selectedUi, crumb.path, crumb.name)}
                                    className={`hover:text-[var(--coffee-deep)] hover:underline ${
                                        crumb.path === selectedPath ? 'text-[var(--coffee-deep)] font-medium' : ''
                                    }`}
                                >
                                    {crumb.name}
                                </button>
                            </span>
                        ))}
                    </div>

                    {/* 过滤 + Depth + Live */}
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                            {!rightFilter && <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)] pointer-events-none" />}
                            <input
                                type="text"
                                value={rightFilter}
                                onChange={e => setRightFilter(e.target.value)}
                                className={`w-full pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)] ${rightFilter ? 'pl-2' : 'pl-8'}`}
                            />
                        </div>
                        <label className="flex items-center gap-1 text-xs text-[var(--coffee-muted)]">
                            Depth
                            <select
                                value={depth}
                                onChange={e => setDepth(Number(e.target.value))}
                                className="px-1 py-0.5 rounded border border-[var(--glass-border)] text-xs bg-white"
                            >
                                {[1,2,3,4,5].map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </label>
                    </div>
                </div>

                {/* 属性面板 */}
                <div className="flex-1 overflow-y-auto p-3">
                    {lastError && (
                        <div className="mb-2 px-3 py-2 rounded-md bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-xs font-mono">
                            {lastError}
                        </div>
                    )}
                    {loadingNode && (
                        <div className="flex items-center justify-center gap-2 py-6 text-[var(--coffee-muted)] text-sm">
                            <Loader2 size={16} className="animate-spin" />
                            <span>加载中...</span>
                        </div>
                    )}
                    {!loadingNode && !nodeData ? (
                        <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                            {selectedUi ? (wsConnected ? '选择一个节点查看数据' : 'WebSocket 连接中...') : '选择一个 UI 开始'}
                        </div>
                    ) : !loadingNode && nodeData?.fields ? (
                        <>
                            <FieldList
                                fields={nodeData.fields}
                                filter={rightFilter}
                                expandedFields={expandedFields}
                                expandedCategories={expandedCategories}
                                selectedUi={selectedUi}
                                parentPath={selectedPath}
                                onToggleField={(key) => {
                                    setExpandedFields(prev => {
                                        const next = new Set(prev)
                                        next.has(key) ? next.delete(key) : next.add(key)
                                        return next
                                    })
                                }}
                                onToggleCategory={(cat) => {
                                    setExpandedCategories(prev => {
                                        const next = new Set(prev)
                                        next.has(cat) ? next.delete(cat) : next.add(cat)
                                        saveExpandedCategories(next)
                                        return next
                                    })
                                }}
                                onSetValue={setValue}
                                onRevert={revertValue}
                                onNavigate={(path, name) => loadNodeData(selectedUi, path, name)}
                                onCallMethod={callMethod}
                            />
                            {nodeData.truncated && (
                                <div className="mt-2 px-3 py-2 rounded-md bg-[var(--caramel)]/10 text-[var(--coffee-muted)] text-xs">
                                    已截断：显示 {nodeData.shownKeys}/{nodeData.totalKeys} 个字段
                                </div>
                            )}
                        </>
                    ) : null}
                </div>

                {/* 底栏 */}
                <div className="p-3 border-t border-[var(--glass-border)] flex items-center justify-between">
                    <button
                        onClick={revertAll}
                        disabled={!selectedUi}
                        className="px-3 py-1.5 text-xs rounded-md border border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)] hover:border-[var(--terracotta)] disabled:opacity-40 transition-colors"
                    >
                        <span className="flex items-center gap-1"><Undo2 size={12} /> Revert All</span>
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setLiveMode(!liveMode)}
                            className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-1 transition-colors ${
                                liveMode
                                    ? 'bg-[var(--sage)] text-white'
                                    : 'border border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                            }`}
                        >
                            {liveMode ? <Pause size={12} /> : <Play size={12} />}
                            {liveMode ? 'Live' : 'Paused'}
                        </button>
                        <select
                            value={liveInterval}
                            onChange={e => setLiveInterval(Number(e.target.value))}
                            className="px-1 py-1 rounded border border-[var(--glass-border)] text-xs bg-white"
                        >
                            {[0.5, 1, 2, 3].map(s => <option key={s} value={s}>{s}s</option>)}
                        </select>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ============================================================================
// 左侧 UI 树节点
// ============================================================================
function UiTreeItem({ ui, isSelected, selectedPath, tree, expandedNodes, onSelectUi, onSelectNode, onToggleNode }) {
    return (
        <div className="mb-0.5">
            {/* UI 名行 */}
            <button
                onClick={onSelectUi}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                    isSelected ? 'bg-[var(--cream-warm)] text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                }`}
            >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ui.active ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'}`} />
                <span className="truncate font-medium">{ui.name}</span>
            </button>

            {/* 展开的组件树 */}
            {isSelected && tree && tree.children && (
                <div className="ml-3">
                    {tree.children.map((child, i) => (
                        <TreeNode
                            key={child.path || i}
                            node={child}
                            selectedPath={selectedPath}
                            expandedNodes={expandedNodes}
                            onSelect={onSelectNode}
                            onToggle={onToggleNode}
                            indent={0}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function TreeNode({ node, selectedPath, expandedNodes, onSelect, onToggle, indent }) {
    const isExpanded = expandedNodes.has(node.path)
    const isSelected = selectedPath === node.path
    const hasChildren = node.hasChildren || (node.children && node.children.length > 0)

    return (
        <div>
            <button
                onClick={() => {
                    onSelect(node.path, node.name)
                    if (hasChildren) onToggle(node.path)
                }}
                className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-left transition-colors ${
                    isSelected ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                }`}
                style={{ paddingLeft: `${indent * 12 + 4}px` }}
            >
                {hasChildren ? (
                    isExpanded ? <ChevronDown size={12} className="flex-shrink-0 text-[var(--coffee-muted)]" /> : <ChevronRight size={12} className="flex-shrink-0 text-[var(--coffee-muted)]" />
                ) : (
                    <span className="w-3 flex-shrink-0" />
                )}
                <span className="truncate">{node.name}</span>
                {node.cname && <span className="text-[var(--coffee-muted)] opacity-60 ml-1 truncate">{node.cname}</span>}
            </button>
            {isExpanded && node.children && node.children.map((child, i) => (
                <TreeNode
                    key={child.path || i}
                    node={child}
                    selectedPath={selectedPath}
                    expandedNodes={expandedNodes}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    indent={indent + 1}
                />
            ))}
        </div>
    )
}

// ============================================================================
// 右侧属性列表
// ============================================================================
function FieldList({ fields, filter, expandedFields, expandedCategories, selectedUi, parentPath, onToggleField, onToggleCategory, onSetValue, onRevert, onNavigate, onCallMethod }) {
    if (!fields || fields.length === 0) return <div className="text-center text-[var(--coffee-muted)] text-xs py-4">无字段</div>

    // 按类型分组
    const categories = {
        editable: { label: '可编辑属性', color: TYPE_COLORS.number, items: [] },
        table: { label: '子表', color: TYPE_COLORS.table, items: [] },
        userdata: { label: 'Unity 引用', color: TYPE_COLORS.userdata, items: [] },
        func: { label: '方法', color: TYPE_COLORS.function, items: [] },
        other: { label: '其他', color: TYPE_COLORS.nil, items: [] },
    }

    const lowerFilter = filter.toLowerCase()
    for (const f of fields) {
        if (filter && !f.key.toLowerCase().includes(lowerFilter)) continue
        if (f.editable) categories.editable.items.push(f)
        else if (f.type === 'table') categories.table.items.push(f)
        else if (f.type === 'userdata') categories.userdata.items.push(f)
        else if (f.type === 'function') categories.func.items.push(f)
        else categories.other.items.push(f)
    }

    return (
        <div className="space-y-2">
            {Object.entries(categories).map(([catKey, cat]) => {
                if (cat.items.length === 0) return null
                const isCollapsed = !expandedCategories.has(catKey)
                return (
                    <div key={catKey}>
                        <button
                            onClick={() => onToggleCategory(catKey)}
                            className="flex items-center gap-1.5 text-xs font-semibold mb-1 hover:opacity-80"
                            style={{ color: cat.color }}
                        >
                            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            {cat.label} ({cat.items.length})
                        </button>
                        {!isCollapsed && (
                            <div className="space-y-0.5">
                                {cat.items.map(f => (
                                    <FieldRow
                                        key={f.key}
                                        field={f}
                                        catColor={cat.color}
                                        expanded={expandedFields.has(f.key)}
                                        selectedUi={selectedUi}
                                        parentPath={parentPath}
                                        onToggle={() => onToggleField(f.key)}
                                        onSetValue={onSetValue}
                                        onRevert={onRevert}
                                        onNavigate={onNavigate}
                                        onCallMethod={onCallMethod}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

// ============================================================================
// 单行字段
// ============================================================================
function FieldRow({ field, catColor, expanded, canExpand = true, selectedUi, parentPath, onToggle, onSetValue, onRevert, onNavigate, onCallMethod }) {
    const [editValue, setEditValue] = useState(String(field.value ?? ''))
    const [isEditing, setIsEditing] = useState(false)
    const [callResult, setCallResult] = useState(null)
    const f = field
    const fieldPath = parentPath ? `${parentPath}.${f.key}` : f.key

    // Live 刷新时同步外部值（仅在非编辑状态下）
    useEffect(() => {
        if (!isEditing) setEditValue(String(f.value ?? ''))
    }, [f.value, isEditing])

    // 值编辑提交（仅在值真正改变时才提交）
    const submitEdit = () => {
        if (!isEditing) return
        setIsEditing(false)
        if (editValue !== String(f.value ?? '')) {
            onSetValue(fieldPath, editValue, f.type)
        }
    }

    // 调用方法
    const handleCall = () => {
        if (onCallMethod) {
            onCallMethod(f.key, (result) => {
                setCallResult(result)
                setTimeout(() => setCallResult(null), 5000)
            })
        }
    }

    return (
        <div>
            <div
                className={`grid items-center px-2 rounded text-xs transition-colors hover:bg-[var(--cream-warm)]/30 ${
                    f.modified ? 'border-l-2' : ''
                }`}
                style={{
                    gridTemplateColumns: 'minmax(80px, 35%) 44px 1fr 24px',
                    minHeight: '28px',
                    ...(f.modified ? { borderLeftColor: '#E8A317' } : {}),
                }}
            >
                {/* Key */}
                <span className="font-mono truncate pr-1" style={{ color: catColor }} title={f.key}>
                    {f.type === 'table' && canExpand && (
                        <button onClick={onToggle} className="inline mr-1">
                            {expanded ? <ChevronDown size={10} className="inline" /> : <ChevronRight size={10} className="inline" />}
                        </button>
                    )}
                    {f.key}
                </span>

                {/* Type */}
                <span className="text-center text-[10px] rounded bg-black/5 text-[var(--coffee-muted)] leading-4 self-center mx-0.5">
                    {f.type}
                </span>

                {/* Value */}
                <div className="min-w-0 flex items-center h-7 pl-1">
                    {f.editable ? (
                        f.type === 'boolean' ? (
                            <button
                                onClick={() => onSetValue(fieldPath, f.value ? 'false' : 'true', 'boolean')}
                                className={`relative inline-flex items-center h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                                    f.value ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/30'
                                }`}
                            >
                                <span className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
                                    f.value ? 'translate-x-[18px]' : 'translate-x-[3px]'
                                }`} />
                            </button>
                        ) : (
                            <input
                                type={f.type === 'number' ? 'number' : 'text'}
                                value={editValue}
                                onFocus={() => setIsEditing(true)}
                                onChange={e => setEditValue(e.target.value)}
                                onBlur={submitEdit}
                                onKeyDown={e => { if (e.key === 'Enter') { submitEdit(); e.target.blur() } }}
                                className="w-full h-6 px-1.5 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-xs focus:outline-none focus:border-[var(--caramel)]"
                            />
                        )
                    ) : f.type === 'table' ? (
                        <button
                            onClick={() => onNavigate(fieldPath, f.key)}
                            className="text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:underline truncate"
                        >
                            {'{' + (f.childCount || '?') + ' fields}'}
                        </button>
                    ) : f.type === 'function' ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[var(--coffee-muted)] font-mono truncate flex-1 min-w-0">{String(f.value)}</span>
                            {onCallMethod && (
                                <button
                                    onClick={handleCall}
                                    className="p-0.5 rounded hover:bg-[var(--sage)]/20 text-[var(--sage)] flex-shrink-0"
                                    title={`调用 ${f.key}()`}
                                >
                                    <PlayCircle size={14} />
                                </button>
                            )}
                        </div>
                    ) : f.type === 'userdata' ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                            {f.goActive != null && (
                                <span
                                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                        f.goActive ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'
                                    }`}
                                    title={`activeSelf: ${f.goSelf}\nactiveInHierarchy: ${f.goActive}`}
                                />
                            )}
                            <span className="text-[var(--coffee-muted)] font-mono truncate">
                                {String(f.value).replace(/^UnityEngine\.(UI\.)?/, '')}
                            </span>
                            {f.goName && (
                                <span className="text-[var(--coffee-muted)] opacity-50 text-[10px] truncate ml-0.5">
                                    {f.goName}
                                </span>
                            )}
                        </div>
                    ) : (
                        <span className="text-[var(--coffee-muted)] font-mono truncate block">
                            {String(f.value)}
                        </span>
                    )}
                </div>

                {/* Action */}
                <div className="flex items-center justify-center w-6">
                    {f.modified && (
                        <button
                            onClick={() => onRevert(fieldPath)}
                            className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--amber)]"
                            title="还原"
                        >
                            <Undo2 size={12} />
                        </button>
                    )}
                </div>
            </div>
            {/* 方法调用结果 */}
            {callResult && (
                <div className="ml-[140px] pl-2 py-1 text-xs font-mono text-[var(--coffee-muted)] bg-black/3 rounded mx-2 mb-0.5">
                    {callResult.error ? (
                        <span className="text-[var(--terracotta)]">{callResult.error}</span>
                    ) : (
                        <span>→ {String(callResult.result ?? 'nil')}</span>
                    )}
                </div>
            )}

            {/* 展开的子表 */}
            {expanded && f.type === 'table' && f.fields && (
                <div className="ml-6 mt-0.5 pl-2 border-l border-[var(--glass-border)]">
                    {f.fields.map(sub => (
                        <FieldRow
                            key={sub.key}
                            field={sub}
                            catColor={TYPE_COLORS[sub.type] || TYPE_COLORS.nil}
                            expanded={false}
                            canExpand={false}
                            selectedUi={selectedUi}
                            parentPath={fieldPath}
                            onToggle={() => {}}
                            onSetValue={onSetValue}
                            onRevert={onRevert}
                            onNavigate={onNavigate}
                        />
                    ))}
                    {f.truncated && (
                        <div className="text-[var(--coffee-muted)] text-xs py-1 italic">
                            ... 已截断，共 {f.total} 项，显示 {f.shown} 项
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
