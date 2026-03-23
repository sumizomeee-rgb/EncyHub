import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, RotateCw, ChevronRight, ChevronDown, Undo2, Play, Pause, Eye } from 'lucide-react'

// ============================================================================
// WebSocket 通信 Hook
// ============================================================================
function useInspectorWs(selectedClient) {
    const listenersRef = useRef({})
    const wsRef = useRef(null)

    useEffect(() => {
        if (!selectedClient) return
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(
            `${protocol}//${window.location.host}/api/gm_console/ws/inspector`
        )
        socket.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            if (msg.client_id !== selectedClient?.id) return
            const cb = listenersRef.current[msg.type]
            if (cb) cb(msg.data)
        }
        wsRef.current = socket
        return () => { socket.close(); wsRef.current = null }
    }, [selectedClient?.id])

    const request = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/inspector/${selectedClient.id}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).catch(err => console.error('[Inspector] request failed:', err))
    }, [selectedClient?.id])

    return { request, wsRef }
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
    // --- 数据状态 ---
    const [uiList, setUiList] = useState([])
    const [uiTree, setUiTree] = useState(null)
    const [nodeData, setNodeData] = useState(null)

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

    // --- 分类折叠状态 ---
    const [collapsedCategories, setCollapsedCategories] = useState(new Set())

    // --- 通信 ---
    const { request } = useInspectorWs(selectedClient)

    // --- 请求 UI 列表 ---
    const refreshUiList = useCallback(() => {
        request('ui_list', {}, (data) => {
            if (data.error) { console.error(data.error); return }
            setUiList(data)
        })
    }, [request])

    // --- 请求 UI 树 ---
    const loadUiTree = useCallback((uiName) => {
        setSelectedUi(uiName)
        setSelectedPath('')
        setBreadcrumb([{ name: uiName, path: '' }])
        setNodeData(null)
        setExpandedNodes(new Set())
        setExpandedFields(new Set())
        request('ui_tree', { uiName }, (data) => {
            if (data.error) { setUiTree(null); return }
            setUiTree(data)
        })
        // 同时请求根节点数据
        request('node_data', { uiName, path: '', depth }, (data) => {
            if (!data.error) setNodeData(data)
        })
    }, [request, depth])

    // --- 请求节点数据 ---
    const loadNodeData = useCallback((uiName, path, nodeName) => {
        setSelectedPath(path)
        setExpandedFields(new Set())
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
        request('node_data', { uiName, path, depth }, (data) => {
            if (data.error) {
                setNodeData(null)
                if (data.error.includes('not found')) {
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
        <div className="flex h-full" style={{ minHeight: '500px' }}>
            {/* ===== 左栏 ===== */}
            <div className="w-72 flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col">
                {/* UI 列表头部 */}
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-[var(--coffee-deep)]">Open UIs</span>
                        <button
                            onClick={refreshUiList}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors"
                            title="刷新 UI 列表"
                        >
                            <RotateCw size={14} />
                        </button>
                    </div>
                    <div className="relative">
                        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                        <input
                            type="text"
                            value={leftFilter}
                            onChange={e => setLeftFilter(e.target.value)}
                            placeholder="搜索 UI..."
                            className="w-full pl-8 pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                        />
                    </div>
                </div>

                {/* UI 列表 + 树 */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {filteredUiList.length === 0 && (
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
                            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                            <input
                                type="text"
                                value={rightFilter}
                                onChange={e => setRightFilter(e.target.value)}
                                placeholder="过滤字段..."
                                className="w-full pl-8 pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
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
                    {!nodeData ? (
                        <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                            {selectedUi ? '选择一个节点查看数据' : '选择一个 UI 开始'}
                        </div>
                    ) : nodeData.fields ? (
                        <FieldList
                            fields={nodeData.fields}
                            filter={rightFilter}
                            expandedFields={expandedFields}
                            collapsedCategories={collapsedCategories}
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
                                setCollapsedCategories(prev => {
                                    const next = new Set(prev)
                                    next.has(cat) ? next.delete(cat) : next.add(cat)
                                    return next
                                })
                            }}
                            onSetValue={setValue}
                            onRevert={revertValue}
                            onNavigate={(path, name) => loadNodeData(selectedUi, path, name)}
                        />
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
function FieldList({ fields, filter, expandedFields, collapsedCategories, selectedUi, parentPath, onToggleField, onToggleCategory, onSetValue, onRevert, onNavigate }) {
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
                const isCollapsed = collapsedCategories.has(catKey)
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
function FieldRow({ field, catColor, expanded, canExpand = true, selectedUi, parentPath, onToggle, onSetValue, onRevert, onNavigate }) {
    const [editValue, setEditValue] = useState(String(field.value ?? ''))
    const [isEditing, setIsEditing] = useState(false)
    const f = field
    const fieldPath = parentPath ? `${parentPath}.${f.key}` : f.key

    // Live 刷新时同步外部值（仅在非编辑状态下）
    useEffect(() => {
        if (!isEditing) setEditValue(String(f.value ?? ''))
    }, [f.value, isEditing])

    // 值编辑提交
    const submitEdit = () => {
        if (!isEditing) return
        setIsEditing(false)
        onSetValue(fieldPath, editValue, f.type)
    }

    return (
        <div>
            <div
                className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors hover:bg-[var(--cream-warm)]/30 ${
                    f.modified ? 'border-l-2' : ''
                }`}
                style={f.modified ? { borderLeftColor: '#E8A317' } : {}}
            >
                {/* Key */}
                <span className="w-32 flex-shrink-0 font-mono truncate" style={{ color: catColor }} title={f.key}>
                    {f.type === 'table' && canExpand && (
                        <button onClick={onToggle} className="inline mr-1">
                            {expanded ? <ChevronDown size={10} className="inline" /> : <ChevronRight size={10} className="inline" />}
                        </button>
                    )}
                    {f.key}
                </span>

                {/* Value */}
                <div className="flex-1 min-w-0">
                    {f.editable ? (
                        f.type === 'boolean' ? (
                            <input
                                type="checkbox"
                                checked={!!f.value}
                                onChange={e => onSetValue(fieldPath, e.target.checked ? 'true' : 'false', 'boolean')}
                                className="accent-[var(--sage)]"
                            />
                        ) : (
                            <input
                                type={f.type === 'number' ? 'number' : 'text'}
                                value={editValue}
                                onFocus={() => setIsEditing(true)}
                                onChange={e => setEditValue(e.target.value)}
                                onBlur={submitEdit}
                                onKeyDown={e => { if (e.key === 'Enter') { submitEdit(); e.target.blur() } }}
                                className="w-full px-1.5 py-0.5 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-xs focus:outline-none focus:border-[var(--caramel)]"
                            />
                        )
                    ) : f.type === 'table' ? (
                        <button
                            onClick={() => onNavigate(fieldPath, f.key)}
                            className="text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:underline"
                        >
                            {'{' + (f.childCount || '?') + ' fields}'}
                        </button>
                    ) : (
                        <span className="text-[var(--coffee-muted)] font-mono truncate block">
                            {String(f.value)}
                        </span>
                    )}
                </div>

                {/* Revert 按钮 */}
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
