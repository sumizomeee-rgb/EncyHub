import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, Loader2, Crosshair, Clipboard, AlertTriangle, CornerDownRight } from 'lucide-react'
import { copyText } from '../utils/clipboard'

const COL_WIDTHS_KEY = 'hierarchy_search_col_widths'
const DEFAULT_COL_WIDTHS = { path: 420, comp: 180, hit: 340 }
const MIN_COL_WIDTH = 80

function loadColWidths() {
    try {
        const raw = localStorage.getItem(COL_WIDTHS_KEY)
        return raw ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) } : DEFAULT_COL_WIDTHS
    } catch { return DEFAULT_COL_WIDTHS }
}

function middleEllipsisPath(path) {
    if (!path) return path
    const parts = String(path).split('/').filter(Boolean)
    if (parts.length <= 2) return path
    return `${parts[0]}/.../${parts[parts.length - 1]}`
}

export default function HierarchySearchModal({ open, onClose, scenes, onSearch, onLocateHit }) {
    const [query, setQuery] = useState('')
    const [scope, setScope] = useState('all')
    const [includeInactive, setIncludeInactive] = useState(true)
    const [searchGoName, setSearchGoName] = useState(true)
    const [searchMembers, setSearchMembers] = useState(true)
    const [showAdvanced, setShowAdvanced] = useState(false)

    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState(null)
    const [error, setError] = useState(null)
    const [colWidths, setColWidths] = useState(() => loadColWidths())

    const inputRef = useRef(null)
    const dragColRef = useRef(null)

    const doSearch = useCallback(() => {
        const q = query.trim()
        if (!q) { setError('请输入搜索内容'); return }
        setLoading(true)
        setError(null)
        setResult(null)
        onSearch({
            query: q,
            scope,
            includeInactive,
            searchGoName,
            searchMembers,
        }, (data) => {
            setLoading(false)
            if (!data || data.error) { setError(data?.error || '搜索失败'); return }
            setResult(data)
        })
    }, [query, scope, includeInactive, searchGoName, searchMembers, onSearch])

    useEffect(() => {
        if (!open) return
        const onKey = (e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && document.activeElement === inputRef.current) doSearch()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, onClose, doSearch])

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50)
    }, [open])

    useEffect(() => {
        const onMove = (e) => {
            if (!dragColRef.current) return
            const { col, startX, startW } = dragColRef.current
            const nw = Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX))
            setColWidths(prev => ({ ...prev, [col]: nw }))
        }
        const onUp = () => {
            if (dragColRef.current) {
                dragColRef.current = null
                try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths)) } catch {}
            }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
    }, [colWidths])

    const startResize = (col) => (e) => {
        e.preventDefault()
        dragColRef.current = { col, startX: e.clientX, startW: colWidths[col] }
    }

    if (!open) return null

    return createPortal((
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
            <div className="glass-card flex flex-col w-[min(1040px,92vw)]"
                style={{ animation: 'slideUp 0.25s ease', maxHeight: '85vh' }}>
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--glass-border)] flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                            <Search size={18} className="text-white" />
                        </div>
                        <h3 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">Hierarchy 高级搜索</h3>
                    </div>
                    <button onClick={onClose}
                        className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="px-5 py-3 border-b border-[var(--glass-border)] space-y-2 flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
                            placeholder='指挥官  /  CueId=55  /  t:*Button  /  go:*Title*'
                            className="!flex-1 !min-w-0 !px-3 !py-2 !text-sm !rounded-lg !border !border-[var(--glass-border)] !bg-white/60 focus:!border-[var(--caramel)]"
                        />
                        <button onClick={doSearch} disabled={loading || !query.trim()}
                            className="btn-primary !py-2 !px-5 !text-sm flex-shrink-0">
                            {loading ? <Loader2 size={14} className="animate-spin" /> : '搜索'}
                        </button>
                    </div>
                    <div className="flex items-center flex-wrap gap-2 text-[10px] text-[var(--coffee-muted)]">
                        <span className="opacity-60">语法:</span>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">CueId=55</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">指挥官</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">t:*Button</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">go:*Title*</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">active:false</code>
                        <button onClick={() => setShowAdvanced(s => !s)}
                            className="ml-auto text-[var(--coffee-deep)] hover:text-[var(--caramel)]">
                            {showAdvanced ? '▼ 高级选项' : '▶ 高级选项'}
                        </button>
                    </div>
                    {showAdvanced && (
                        <div className="flex items-center flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--coffee-muted)] pt-1">
                            <label className="flex items-center gap-2 whitespace-nowrap">
                                <span>范围:</span>
                                <select value={scope} onChange={e => setScope(e.target.value)}
                                    className="!w-auto !min-w-[160px] !px-2 !py-1 !text-xs !rounded-md !border !border-[var(--glass-border)] !bg-white/70">
                                    <option value="all">全部场景</option>
                                    {(scenes || []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                    <option value="DontDestroyOnLoad">DontDestroyOnLoad</option>
                                </select>
                            </label>
                            <Toggle checked={includeInactive} onChange={setIncludeInactive} label="包含 inactive" />
                            <Toggle checked={searchGoName} onChange={setSearchGoName} label="搜索 GO 名/路径" />
                            <Toggle checked={searchMembers} onChange={setSearchMembers} label="搜索 Component 字段" />
                        </div>
                    )}
                </div>

                {result && (
                    <div className="px-5 py-2 border-b border-[var(--glass-border)] text-xs text-[var(--coffee-muted)] bg-[var(--cream-warm)]/30 flex-shrink-0">
                        找到 <span className="font-semibold text-[var(--coffee-deep)]">{result.hits.length}</span> 条
                        · 扫描 {result.objectCount || 0} GO / {result.componentCount || 0} Component / {result.totalScanned || 0} 字段
                        · {result.elapsedMs || 0}ms
                        {result.truncated && (
                            <div className="mt-1.5 flex items-start gap-1.5 px-2 py-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-[11px]">
                                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                                <span>扫描达到上限，结果可能不全 — 请收紧 query 或缩小范围</span>
                            </div>
                        )}
                    </div>
                )}
                {error && (
                    <div className="px-5 py-2 border-b border-[var(--glass-border)] text-xs text-[var(--terracotta)] bg-[var(--terracotta)]/5 flex-shrink-0">
                        ✗ {error}
                    </div>
                )}

                <div className="overflow-auto bg-[var(--cream-soft)]/30" style={{ minHeight: 0 }}>
                    {!result && !loading && !error && (
                        <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                            输入 query 后回车或点搜索
                        </div>
                    )}
                    {loading && (
                        <div className="flex items-center justify-center gap-2 h-32 text-[var(--coffee-muted)]">
                            <Loader2 size={16} className="animate-spin" /> 搜索中...
                        </div>
                    )}
                    {result && result.hits.length === 0 && !loading && (
                        <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                            无匹配
                        </div>
                    )}
                    {result && result.hits.length > 0 && (
                        <ResultsTable
                            hits={result.hits}
                            colWidths={colWidths}
                            onResize={startResize}
                            onLocate={(hit) => { onLocateHit(hit); onClose() }}
                        />
                    )}
                </div>
            </div>
        </div>
    ), document.body)
}

function Toggle({ checked, onChange, label }) {
    return (
        <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
                className="!w-3.5 !h-3.5 !p-0 accent-[var(--caramel)]" />
            <span>{label}</span>
        </label>
    )
}

function ResultsTable({ hits, colWidths, onResize, onLocate }) {
    const totalWidth = colWidths.path + colWidths.comp + colWidths.hit + 8
    return (
        <div className="text-xs" style={{ minWidth: totalWidth }}>
            <div className="flex items-stretch sticky top-0 bg-[var(--cream-warm)] border-b border-[var(--glass-border)] font-semibold text-[var(--coffee-deep)] z-10 shadow-sm">
                <HeaderCell w={colWidths.path} label="GameObject 路径" />
                <Resizer onMouseDown={onResize('path')} />
                <HeaderCell w={colWidths.comp} label="Component" />
                <Resizer onMouseDown={onResize('comp')} />
                <HeaderCell w={colWidths.hit} label="命中字段" />
            </div>
            {hits.map((hit, i) => (
                <Row key={i} hit={hit} colWidths={colWidths} onLocate={onLocate} alt={i % 2 === 1} />
            ))}
        </div>
    )
}

const HeaderCell = ({ w, label }) => (
    <div style={{ width: w, padding: '8px 10px' }} className="flex-shrink-0 truncate">{label}</div>
)

const Resizer = ({ onMouseDown }) => (
    <div onMouseDown={onMouseDown}
        className="flex-shrink-0 w-1 cursor-col-resize hover:bg-[var(--caramel)]/60 active:bg-[var(--caramel)] self-stretch transition-colors"
    />
)

function Row({ hit, colWidths, onLocate, alt }) {
    const [hovered, setHovered] = useState(false)
    return (
        <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
            className={`flex items-stretch border-b border-[var(--glass-border)]/40 ${
                hovered ? 'bg-[var(--cream-warm)]/40' : (alt ? 'bg-white/40' : 'bg-transparent')
            } transition-colors`}>
            <PathCell w={colWidths.path} hit={hit} hovered={hovered} onLocate={onLocate} />
            <span className="w-1 flex-shrink-0" />
            <ComponentCell w={colWidths.comp} hit={hit} />
            <span className="w-1 flex-shrink-0" />
            <HitCell w={colWidths.hit} hit={hit} />
        </div>
    )
}

const cellBase = "flex-shrink-0 flex items-center gap-1.5 min-w-0 overflow-hidden"

function PathCell({ w, hit, hovered, onLocate }) {
    const path = hit.hierarchyPath || hit.goName || `#${hit.goInstanceId}`
    const displayPath = middleEllipsisPath(path)
    return (
        <div style={{ width: w, padding: '6px 10px' }}
            className={`${cellBase} cursor-pointer group/path hover:bg-[var(--caramel)]/15`}
            onClick={() => onLocate(hit)}
            title={`定位到 #${hit.goInstanceId} ${path}`}>
            <CornerDownRight size={11} className={`flex-shrink-0 transition-opacity ${hovered ? 'text-[var(--caramel)] opacity-100' : 'text-[var(--coffee-muted)] opacity-30'}`} />
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hit.activeInHierarchy === false ? 'bg-[var(--coffee-muted)]/30' : 'bg-[var(--sage)]'}`} />
            {hit.sceneName && <span className="px-1 rounded bg-black/5 text-[9px] text-[var(--coffee-muted)] flex-shrink-0">{hit.sceneName}</span>}
            <span className="font-mono text-[var(--coffee-muted)] truncate min-w-0 select-text" style={{ cursor: 'text' }}>{displayPath}</span>
            {hovered && (
                <>
                    <button onClick={(e) => { e.stopPropagation(); copyText(path) }}
                        className="p-0.5 rounded hover:bg-black/10 text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] flex-shrink-0"
                        title="复制 GameObject 全路径">
                        <Clipboard size={11} />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onLocate(hit) }}
                        className="p-0.5 rounded hover:bg-[var(--caramel)]/20 text-[var(--coffee-muted)] hover:text-[var(--caramel)] flex-shrink-0"
                        title={`在 Hierarchy 中定位 #${hit.goInstanceId}`}>
                        <Crosshair size={11} />
                    </button>
                </>
            )}
        </div>
    )
}

function ComponentCell({ w, hit }) {
    return (
        <div style={{ width: w, padding: '6px 10px' }} className={cellBase}>
            <span className="font-mono text-[var(--coffee-deep)] truncate min-w-0 select-text" style={{ cursor: 'text' }}
                title={hit.typeName || 'GameObject'}>{hit.typeName || 'GameObject'}</span>
            {hit.compIndex != null && (
                <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">#{hit.compIndex}</span>
            )}
        </div>
    )
}

function HitCell({ w, hit }) {
    return (
        <div style={{ width: w, padding: '6px 10px' }} className={cellBase}>
            <HitContent hit={hit} />
        </div>
    )
}

function HitContent({ hit }) {
    if (hit.valueType === 'type') {
        return (
            <span className="font-mono truncate min-w-0 select-text" style={{ cursor: 'text' }}>
                <span className="text-[var(--coffee-deep)]">{hit.memberName || 'Component'}</span>
                <span className="text-[var(--coffee-muted)] opacity-60 mx-1">::</span>
                <span className="text-[var(--sage)] font-medium">{hit.valueDisplay}</span>
            </span>
        )
    }
    if (hit.valueType === 'compText') {
        return (
            <span className="font-mono truncate min-w-0 select-text" title={hit.valueDisplay} style={{ cursor: 'text' }}>
                <span className="text-[var(--coffee-deep)]">{hit.memberName}</span>
                <span className="text-[var(--coffee-muted)] mx-1">=</span>
                <span className="text-[var(--coffee-deep)]">"{hit.valueDisplay}"</span>
                {hit.via && <span className="ml-1 px-1 rounded bg-[var(--caramel)]/15 text-[var(--caramel)] text-[9px]" title={hit.via}>{hit.via}</span>}
            </span>
        )
    }
    return (
        <span className="font-mono truncate min-w-0 select-text" title={hit.valueDisplay} style={{ cursor: 'text' }}>
            <span className="text-[var(--coffee-deep)]">{hit.memberName}</span>
            <span className="text-[var(--coffee-muted)] mx-1">=</span>
            <span className="text-[var(--coffee-deep)]">{hit.valueDisplay}</span>
        </span>
    )
}
