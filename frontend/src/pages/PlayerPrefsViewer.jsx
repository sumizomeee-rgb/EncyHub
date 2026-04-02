import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, RotateCw, Star, Trash2, Clipboard, Plus, X, Loader2, Check } from 'lucide-react'
import { copyText } from '../utils/clipboard'

const LS_FAV_KEY = 'player_prefs_favorites'
const LS_RECENT_KEY = 'player_prefs_recents'
const MAX_RECENTS = 20

function loadFavorites() {
    try { return JSON.parse(localStorage.getItem(LS_FAV_KEY)) || [] } catch { return [] }
}
function saveFavorites(favs) {
    localStorage.setItem(LS_FAV_KEY, JSON.stringify(favs))
}
function loadRecents() {
    try { return JSON.parse(localStorage.getItem(LS_RECENT_KEY)) || [] } catch { return [] }
}
function saveRecents(recents) {
    localStorage.setItem(LS_RECENT_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)))
}
function addRecent(key) {
    const recents = loadRecents().filter(k => k !== key)
    recents.unshift(key)
    saveRecents(recents)
    return recents.slice(0, MAX_RECENTS)
}

// ============================================================================
// 主组件
// ============================================================================
export default function PlayerPrefsViewer({ clients, selectedClient, active }) {
    const [entries, setEntries] = useState({})        // key → {key, value, type}
    const [search, setSearch] = useState('')
    const [favorites, setFavorites] = useState(loadFavorites)
    const [recents, setRecents] = useState(loadRecents)
    const [showDropdown, setShowDropdown] = useState(false)
    const [loading, setLoading] = useState(false)
    const [enumSupported, setEnumSupported] = useState(null) // null=unknown, true/false
    const [wsConnected, setWsConnected] = useState(false)
    const [editingKey, setEditingKey] = useState(null)
    const [editValue, setEditValue] = useState('')
    const [editType, setEditType] = useState('string')
    const [adding, setAdding] = useState(false)
    const [newKey, setNewKey] = useState('')
    const [newValue, setNewValue] = useState('')
    const [newType, setNewType] = useState('string')

    const wsRef = useRef(null)
    const listenersRef = useRef({})
    const searchRef = useRef(null)
    const dropdownRef = useRef(null)

    // --- WebSocket ---
    useEffect(() => {
        if (!selectedClient || !active) { setWsConnected(false); return }
        let closed = false
        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/player_prefs`)
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

    // --- Command helper ---
    const sendCmd = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        if (onResponse) listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/player_prefs/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).catch(e => console.error('[PlayerPrefs] sendCmd error:', e))
    }, [selectedClient?.id])

    // --- Load all on mount / client change ---
    useEffect(() => {
        if (!selectedClient || !wsConnected || !active) return
        setLoading(true)
        setEntries({})
        setEnumSupported(null)
        sendCmd('get_all', {}, (data) => {
            setLoading(false)
            if (data?.error || !data) {
                setEnumSupported(false)
                return
            }
            setEnumSupported(data.enumSupported !== false)
            const map = {}
            ;(data.entries || []).forEach(e => { map[e.key] = e })
            setEntries(map)
        })
    }, [selectedClient?.id, wsConnected, active])

    // --- Refresh all ---
    const handleRefresh = useCallback(() => {
        if (!wsConnected) return
        setLoading(true)
        sendCmd('get_all', {}, (data) => {
            setLoading(false)
            if (data?.error || !data) return
            setEnumSupported(data.enumSupported !== false)
            const map = {}
            ;(data.entries || []).forEach(e => { map[e.key] = e })
            setEntries(map)
        })
    }, [sendCmd, wsConnected])

    // --- Query single key ---
    const queryOneKey = useCallback((key) => {
        if (!key.trim()) return
        const k = key.trim()
        sendCmd('get', { key: k }, (data) => {
            if (data?.exists) {
                setEntries(prev => ({ ...prev, [k]: { key: k, value: data.value, type: data.type } }))
            } else {
                setEntries(prev => ({ ...prev, [k]: { key: k, value: null, type: null, notFound: true } }))
            }
            setRecents(addRecent(k))
        })
    }, [sendCmd])

    // --- Search submit (Enter) ---
    const handleSearchSubmit = useCallback(() => {
        if (!search.trim()) return
        queryOneKey(search)
        setShowDropdown(false)
    }, [search, queryOneKey])

    // --- Toggle favorite ---
    const toggleFav = useCallback((key) => {
        setFavorites(prev => {
            const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
            saveFavorites(next)
            return next
        })
    }, [])

    // --- Edit ---
    const startEdit = useCallback((entry) => {
        setEditingKey(entry.key)
        setEditValue(entry.value ?? '')
        setEditType(entry.type || 'string')
    }, [])

    const commitEdit = useCallback(() => {
        if (!editingKey) return
        const k = editingKey, v = editValue, t = editType
        setEntries(prev => ({ ...prev, [k]: { key: k, value: v, type: t } }))
        setRecents(addRecent(k))
        sendCmd('set', { key: k, value: v, valueType: t })
        setEditingKey(null)
    }, [editingKey, editValue, editType, sendCmd])

    // --- Delete ---
    const handleDelete = useCallback((key) => {
        setEntries(prev => { const n = { ...prev }; delete n[key]; return n })
        sendCmd('delete', { key })
    }, [sendCmd])

    // --- Add new ---
    const commitAdd = useCallback(() => {
        if (!newKey.trim()) return
        const k = newKey.trim(), v = newValue, t = newType
        setEntries(prev => ({ ...prev, [k]: { key: k, value: v, type: t } }))
        setRecents(addRecent(k))
        sendCmd('set', { key: k, value: v, valueType: t })
        setAdding(false)
        setNewKey('')
        setNewValue('')
        setNewType('string')
    }, [newKey, newValue, newType, sendCmd])

    // --- Close dropdown on outside click ---
    useEffect(() => {
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
                searchRef.current && !searchRef.current.contains(e.target)) {
                setShowDropdown(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [])

    // --- Filtered entries ---
    const filteredEntries = useMemo(() => {
        const all = Object.values(entries)
        const filtered = search.trim()
            ? all.filter(e => e.key.toLowerCase().includes(search.toLowerCase()))
            : all
        return filtered.sort((a, b) => a.key.localeCompare(b.key))
    }, [entries, search])

    // --- Dropdown items ---
    const dropdownItems = useMemo(() => {
        const items = []
        const seen = new Set()
        favorites.forEach(k => { if (!seen.has(k)) { items.push({ key: k, fav: true }); seen.add(k) } })
        recents.forEach(k => { if (!seen.has(k)) { items.push({ key: k, fav: false }); seen.add(k) } })
        return items
    }, [favorites, recents])

    const entryCount = Object.keys(entries).length

    const inputCls = "px-2 py-1 text-xs rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"

    return (
        <div className="flex flex-col h-full" style={{ minHeight: '400px' }}>
            {/* ===== Header: Search ===== */}
            <div className="p-3 border-b border-[var(--glass-border)]">
                <div className="flex items-center gap-2 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />
                    <span className="text-sm font-semibold text-[var(--coffee-deep)]">PlayerPrefs</span>
                    {enumSupported === true && (
                        <span className="text-[10px] text-[var(--coffee-muted)]">已加载 {entryCount} key</span>
                    )}
                    {enumSupported === false && (
                        <span className="text-[10px] text-[var(--caramel)]">手动查询模式</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                        <button onClick={handleRefresh} disabled={loading || !selectedClient || !wsConnected}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] disabled:opacity-30 transition-colors" title="刷新全部">
                            <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
                        </button>
                    </div>
                </div>

                {/* Search bar */}
                <div className="relative">
                    <div className="flex items-center gap-1">
                        <div className="relative flex-1">
                            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                            <input ref={searchRef} type="text" value={search}
                                onChange={e => setSearch(e.target.value)}
                                onFocus={() => { if (dropdownItems.length > 0) setShowDropdown(true) }}
                                onKeyDown={e => { if (e.key === 'Enter') handleSearchSubmit() }}
                                placeholder={enumSupported ? `过滤 (${entryCount} key)` : '输入 key 名查询 (Enter)'}
                                style={{ paddingLeft: '1.75rem' }}
                                className="w-full pr-2 py-1 text-xs rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                            />
                        </div>
                    </div>

                    {/* Dropdown: favorites + recents */}
                    {showDropdown && dropdownItems.length > 0 && (
                        <div ref={dropdownRef}
                            className="absolute z-20 top-full left-0 right-0 mt-1 rounded-md border border-[var(--glass-border)] bg-white/95 backdrop-blur-sm shadow-lg max-h-48 overflow-y-auto">
                            {dropdownItems.map(item => (
                                <button key={item.key}
                                    onClick={() => { setSearch(item.key); queryOneKey(item.key); setShowDropdown(false) }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--cream-warm)]/50 text-left">
                                    {item.fav
                                        ? <Star size={11} className="text-[var(--caramel)] fill-[var(--caramel)] flex-shrink-0" />
                                        : <span className="text-[var(--coffee-muted)] opacity-40 text-[10px] flex-shrink-0">recent</span>}
                                    <span className="font-mono truncate text-[var(--coffee-deep)]">{item.key}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ===== Main List ===== */}
            <div className="flex-1 overflow-y-auto">
                {loading && (
                    <div className="flex items-center justify-center gap-1.5 py-8 text-[var(--coffee-muted)]">
                        <Loader2 size={14} className="animate-spin" /><span className="text-xs">加载中...</span>
                    </div>
                )}
                {!loading && filteredEntries.length === 0 && (
                    <div className="text-center text-[var(--coffee-muted)] text-xs py-8">
                        {entryCount === 0
                            ? (enumSupported === false ? '输入 key 名按 Enter 查询' : '无数据')
                            : '无匹配结果'}
                    </div>
                )}
                {!loading && filteredEntries.length > 0 && (
                    <table className="w-full text-xs table-fixed">
                        <colgroup>
                            <col className="w-6" />
                            <col style={{ width: '35%' }} />
                            <col />
                            <col className="w-14" />
                            <col className="w-16" />
                        </colgroup>
                        <thead>
                            <tr className="text-[10px] text-[var(--coffee-muted)] border-b border-[var(--glass-border)]">
                                <th className="px-1 py-1.5" />
                                <th className="text-left px-2 py-1.5 font-medium">Key</th>
                                <th className="text-left px-2 py-1.5 font-medium">Value</th>
                                <th className="px-1 py-1.5 font-medium">Type</th>
                                <th className="px-1 py-1.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {filteredEntries.map(entry => {
                                const isFav = favorites.includes(entry.key)
                                const isEditing = editingKey === entry.key
                                return (
                                    <tr key={entry.key} className="border-b border-[var(--glass-border)]/50 hover:bg-[var(--cream-warm)]/30 group">
                                        {/* Favorite */}
                                        <td className="px-1 py-1 text-center">
                                            <button onClick={() => toggleFav(entry.key)}
                                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] transition-colors">
                                                <Star size={11} className={isFav ? 'text-[var(--caramel)] fill-[var(--caramel)]' : 'text-[var(--coffee-muted)] opacity-20 group-hover:opacity-50'} />
                                            </button>
                                        </td>
                                        {/* Key */}
                                        <td className="px-2 py-1 overflow-hidden">
                                            <span className="font-mono text-[var(--coffee-deep)] select-text cursor-text block truncate" title={entry.key}>{entry.key}</span>
                                        </td>
                                        {/* Value */}
                                        <td className="px-2 py-1">
                                            {entry.notFound ? (
                                                <span className="text-[var(--coffee-muted)] italic">不存在</span>
                                            ) : isEditing ? (
                                                <div className="flex items-center gap-1">
                                                    <input type="text" value={editValue} autoFocus
                                                        onChange={e => setEditValue(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingKey(null) }}
                                                        className={`flex-1 min-w-0 ${inputCls} !py-0.5`}
                                                    />
                                                    <select value={editType} onChange={e => setEditType(e.target.value)}
                                                        className={`w-16 ${inputCls} !py-0.5`}>
                                                        <option value="string">str</option>
                                                        <option value="int">int</option>
                                                        <option value="float">float</option>
                                                    </select>
                                                    <button onClick={commitEdit} className="p-0.5 rounded hover:bg-[var(--sage)]/20 text-[var(--sage)]"><Check size={12} /></button>
                                                    <button onClick={() => setEditingKey(null)} className="p-0.5 rounded hover:bg-[var(--terracotta)]/20 text-[var(--terracotta)]"><X size={12} /></button>
                                                </div>
                                            ) : (
                                                <span className="font-mono text-[var(--coffee-deep)] cursor-pointer hover:text-[var(--caramel)] select-text"
                                                    onClick={() => startEdit(entry)}
                                                    title="点击编辑">
                                                    {entry.value !== null && entry.value !== undefined
                                                        ? (String(entry.value).length > 80 ? String(entry.value).slice(0, 80) + '...' : String(entry.value))
                                                        : '(empty)'}
                                                </span>
                                            )}
                                        </td>
                                        {/* Type */}
                                        <td className="px-1 py-1 text-center">
                                            {!entry.notFound && (
                                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                                    entry.type === 'int' ? 'bg-[var(--sage)]/10 text-[var(--sage)]' :
                                                    entry.type === 'float' ? 'bg-[var(--caramel)]/10 text-[var(--caramel)]' :
                                                    'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'
                                                }`}>{entry.type || '?'}</span>
                                            )}
                                        </td>
                                        {/* Actions */}
                                        <td className="px-1 py-1">
                                            {!entry.notFound && !isEditing && (
                                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button onClick={() => copyText(entry.value ?? '')}
                                                        className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]" title="复制值">
                                                        <Clipboard size={11} />
                                                    </button>
                                                    <button onClick={() => handleDelete(entry.key)}
                                                        className="p-0.5 rounded hover:bg-[var(--terracotta)]/10 text-[var(--coffee-muted)] hover:text-[var(--terracotta)]" title="删除">
                                                        <Trash2 size={11} />
                                                    </button>
                                                </div>
                                            )}
                                            {entry.notFound && (
                                                <button onClick={() => setEntries(prev => { const n = { ...prev }; delete n[entry.key]; return n })}
                                                    className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]" title="移除">
                                                    <X size={11} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ===== Footer ===== */}
            <div className="p-2 border-t border-[var(--glass-border)] flex items-center gap-2 text-[10px] text-[var(--coffee-muted)]">
                {adding ? (
                    <div className="flex items-center gap-1 flex-1">
                        <input type="text" value={newKey} autoFocus placeholder="Key"
                            onChange={e => setNewKey(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false) }}
                            className={`w-32 ${inputCls} !text-[10px]`} />
                        <input type="text" value={newValue} placeholder="Value"
                            onChange={e => setNewValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false) }}
                            className={`flex-1 min-w-0 ${inputCls} !text-[10px]`} />
                        <select value={newType} onChange={e => setNewType(e.target.value)}
                            className={`w-14 ${inputCls} !text-[10px]`}>
                            <option value="string">str</option>
                            <option value="int">int</option>
                            <option value="float">float</option>
                        </select>
                        <button onClick={commitAdd} className="p-0.5 rounded hover:bg-[var(--sage)]/20 text-[var(--sage)]"><Check size={12} /></button>
                        <button onClick={() => setAdding(false)} className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]"><X size={12} /></button>
                    </div>
                ) : (
                    <>
                        <button onClick={() => setAdding(true)}
                            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors">
                            <Plus size={11} /> 新增
                        </button>
                        <span className="ml-auto">{filteredEntries.length === entryCount ? `共 ${entryCount} 条` : `${filteredEntries.length} / ${entryCount} 条`}</span>
                    </>
                )}
            </div>
        </div>
    )
}
