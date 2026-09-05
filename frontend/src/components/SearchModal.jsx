import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, Loader2, Crosshair, AlertTriangle, CornerDownRight } from 'lucide-react'
import CopyButton from './CopyButton'

// 高级搜索弹窗（v2 风格统一版）：跨 UI / 跨节点 / C# 文本穿透 / 类型搜
// 详见 docs/history/31_设计方案书_LuaUiInspector_AdvancedSearch.md
//
// 交互：
//   - 整行 click 不触发跳转（避免误触 + 文本可选中复制）
//   - 第一列 UI: cell click → 跳转，hover 时 cell 末尾出现 ↳ 跳转图标
//   - 第二列 Lua 路径: hover 出现 📋 复制按钮
//   - 第三列 GO 路径: hover 出现 📋 复制 + 🎯 跳 Hierarchy 按钮
//   - 所有单元格文本 cursor:text，便于鼠标拖选复制

const COL_WIDTHS_KEY = 'luaui_search_col_widths'
const DEFAULT_COL_WIDTHS = { ui: 120, luaPath: 240, goPath: 280, hit: 280 }
const MIN_COL_WIDTH = 60
const RESULT_RENDER_BATCH = 1000
const SCAN_BUDGETS = {
    standard: { key: 'standard', label: '标准', maxFields: 5000 },
    deep: { key: 'deep', label: '深度', maxFields: 15000 },
    max: { key: 'max', label: '最大', maxFields: 30000 },
}

function loadColWidths() {
    try {
        const raw = localStorage.getItem(COL_WIDTHS_KEY)
        return raw ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) } : DEFAULT_COL_WIDTHS
    } catch { return DEFAULT_COL_WIDTHS }
}

function middleEllipsisPath(path, separator = '/') {
    if (!path || path === '(根)') return path || '(根)'
    const parts = String(path).split(separator).filter(Boolean)
    if (parts.length <= 2) return path
    if (separator === '.') return `${parts[0]}...${parts[parts.length - 1]}`
    return `${parts[0]}${separator}...${separator}${parts[parts.length - 1]}`
}

export default function SearchModal({ open, onClose, uiList, onSearch, onJumpToHit, onLocateGo }) {
    const [query, setQuery] = useState('')
    const [scope, setScope] = useState('all')
    const [depth, setDepth] = useState(20)
    const [probeText, setProbeText] = useState(true)
    const [scanBudget, setScanBudget] = useState('standard')

    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState(null)
    const [error, setError] = useState(null)

    const [colWidths, setColWidths] = useState(() => loadColWidths())
    const dragColRef = useRef(null)
    const inputRef = useRef(null)

    useEffect(() => {
        if (!open) return
        const onKey = (e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && document.activeElement === inputRef.current) doSearch()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, onClose, query, scope, depth, probeText])  // eslint-disable-line

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50)
    }, [open])

    const doSearch = useCallback(() => {
        const q = query.trim()
        if (!q) { setError('请输入搜索内容'); return }
        const budget = SCAN_BUDGETS[scanBudget] || SCAN_BUDGETS.standard
        const scopedUi = scope === 'all'
            ? null
            : uiList?.find(ui => String(ui.id || ui.name) === String(scope))
        setLoading(true)
        setError(null)
        setResult(null)
        onSearch({
            query: q,
            scope: scopedUi?.name || scope,
            scopeId: scopedUi?.id,
            depth: Math.min(Math.max(parseInt(depth) || 20, 1), 30),
            probeComponentText: probeText,
            maxFields: budget.maxFields,
        }, (data) => {
            setLoading(false)
            if (!data || data.error) { setError(data?.error || '搜索失败'); return }
            setResult({ ...data, appliedBudget: budget })
        })
    }, [query, scope, depth, probeText, scanBudget, onSearch, uiList])

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

    // 用 Portal 渲染到 body，绕过 GmConsole 父级可能的 transform/filter 创建的 stacking context，
    // 否则 position:fixed 会被父级限制变成相对定位（视觉上只覆盖中间面板而非整屏）。
    return createPortal((
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
            <div className="glass-card flex flex-col w-[min(1100px,92vw)]"
                style={{ animation: 'slideUp 0.25s ease', height: 'min(760px, 85vh)', maxHeight: '85vh' }}>

                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--glass-border)] flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                            <Search size={18} className="text-white" />
                        </div>
                        <h3 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">LuaUi 高级搜索</h3>
                    </div>
                    <button onClick={onClose}
                        className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors">
                        <X size={18} />
                    </button>
                </div>

                {/* Search bar */}
                <div className="px-5 py-3 border-b border-[var(--glass-border)] space-y-2 flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
                            placeholder='Id=55  /  "hello"  /  *Count  /  t:XUiButton  /  第3章'
                            className="!flex-1 !min-w-0 !px-3 !py-2 !text-sm !rounded-lg !border !border-[var(--glass-border)] !bg-white/60 focus:!border-[var(--caramel)]"
                        />
                        <button onClick={doSearch} disabled={loading || !query.trim()}
                            className="btn-primary !py-2 !px-5 !text-sm flex-shrink-0">
                            {loading ? <Loader2 size={14} className="animate-spin" /> : '搜索'}
                        </button>
                    </div>
                    <div className="flex items-center flex-wrap gap-2 text-[10px] text-[var(--coffee-muted)]">
                        <span className="opacity-60">语法:</span>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">Id=55</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">{`"hello"`}</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">*Count</code>
                        <code className="px-1.5 py-0.5 bg-black/5 rounded text-[var(--coffee-deep)]">t:XUiButton</code>
                    </div>
                    <div className="flex items-center flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--coffee-muted)] pt-1">
                        <label className="flex items-center gap-2 whitespace-nowrap">
                            <span className="text-[10px] font-semibold text-[var(--coffee-deep)]">搜索范围</span>
                            <select value={scope} onChange={e => setScope(e.target.value)}
                                className="!w-auto !min-w-[160px] !px-2 !py-1 !text-xs !rounded-md !border !border-[var(--glass-border)] !bg-white/70">
                                <option value="all">全部打开的 UI</option>
                                {uiList?.map(u => (
                                    <option key={u.id || u.name} value={u.id || u.name}>
                                        {u.name}{u.id ? ` · #${u.id}` : ''}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="flex items-center gap-2 whitespace-nowrap">
                            <span className="text-[10px] font-semibold text-[var(--coffee-deep)]">扫描深度</span>
                            <input type="number" min={1} max={30} value={depth}
                                onChange={e => setDepth(parseInt(e.target.value) || 20)}
                                className="!w-16 !px-2 !py-1 !text-xs !rounded-md !border !border-[var(--glass-border)] !bg-white/70" />
                        </label>
                        <label className="flex items-center gap-2 whitespace-nowrap">
                            <span className="text-[10px] font-semibold text-[var(--coffee-deep)]">扫描预算</span>
                            <select value={scanBudget} onChange={e => setScanBudget(e.target.value)}
                                className="!w-auto !min-w-[100px] !px-2 !py-1 !text-xs !rounded-md !border !border-[var(--glass-border)] !bg-white/70">
                                {Object.values(SCAN_BUDGETS).map(b => (
                                    <option key={b.key} value={b.key}>{b.label}</option>
                                ))}
                            </select>
                        </label>
                        <span className="hidden sm:inline-block w-px h-4 bg-[var(--glass-border)]" />
                        <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" checked={probeText} onChange={e => setProbeText(e.target.checked)}
                                className="!w-3.5 !h-3.5 !p-0 accent-[var(--caramel)]" />
                            <span>C# 文本穿透</span>
                        </label>
                    </div>
                </div>

                {/* Stats */}
                {result && (
                    <div className="px-5 py-2 border-b border-[var(--glass-border)] text-xs text-[var(--coffee-muted)] bg-[var(--cream-warm)]/30 flex-shrink-0">
                        找到 <span className="font-semibold text-[var(--coffee-deep)]">{result.hits.length}</span> 条
                        in <span className="font-semibold text-[var(--coffee-deep)]">{result.uiCount}</span> UI · 扫描 {result.totalScanned} 字段 · {result.elapsedMs}ms
                        {result.truncated && (
                            <div className="mt-1.5 flex items-start gap-1.5 px-2 py-1 rounded bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-[11px]">
                                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                                <span>{getTruncatedMessage(result)}</span>
                            </div>
                        )}
                    </div>
                )}
                {error && (
                    <div className="px-5 py-2 border-b border-[var(--glass-border)] text-xs text-[var(--terracotta)] bg-[var(--terracotta)]/5 flex-shrink-0">
                        ✗ {error}
                    </div>
                )}

                {/* Results table */}
                <div className="flex-1 min-h-0 overflow-auto bg-[var(--cream-soft)]/30">
                    {!result && !loading && !error && (
                        <div className="flex items-center justify-center h-full min-h-[220px] text-[var(--coffee-muted)] text-sm">
                            输入 query 后回车或点搜索
                        </div>
                    )}
                    {loading && (
                        <div className="flex items-center justify-center gap-2 h-full min-h-[220px] text-[var(--coffee-muted)]">
                            <Loader2 size={16} className="animate-spin" /> 搜索中...
                        </div>
                    )}
                    {result && result.hits.length === 0 && !loading && (
                        <div className="flex items-center justify-center h-full min-h-[220px] text-[var(--coffee-muted)] text-sm">
                            无匹配
                        </div>
                    )}
                    {result && result.hits.length > 0 && (
                        <ResultsTable
                            hits={result.hits}
                            colWidths={colWidths}
                            onResize={startResize}
                            onJump={(hit) => { onJumpToHit(hit); onClose() }}
                            onLocateGo={(id) => { onLocateGo(id); onClose() }}
                        />
                    )}
                </div>
            </div>
        </div>
    ), document.body)
}

function getTruncatedMessage(result) {
    const budget = result?.appliedBudget || SCAN_BUDGETS.standard
    const maxFields = result?.maxFields || budget.maxFields
    const suffix = budget.key === 'max'
        ? '已使用最大预算；请收紧 query 或减小范围/深度。'
        : '可切换到更大的扫描预算，或收紧 query / 减小范围/深度。'
    return `字段扫描达到当前预算 ${maxFields}，后续字段未继续扫描；结果可能不全。${suffix}`
}

// ============================================================================
// 结果表格
// ============================================================================
function ResultsTable({ hits, colWidths, onResize, onJump, onLocateGo }) {
    const [visibleCount, setVisibleCount] = useState(RESULT_RENDER_BATCH)

    useEffect(() => {
        setVisibleCount(RESULT_RENDER_BATCH)
    }, [hits])

    const totalWidth = colWidths.ui + colWidths.luaPath + colWidths.goPath + colWidths.hit + 12  // +12 for resizers
    const visibleHits = hits.length > visibleCount ? hits.slice(0, visibleCount) : hits
    const remaining = hits.length - visibleHits.length
    return (
        <div className="text-xs" style={{ minWidth: totalWidth }}>
            <div className="flex items-stretch sticky top-0 bg-[var(--cream-warm)] border-b border-[var(--glass-border)] font-semibold text-[var(--coffee-deep)] z-10 shadow-sm">
                <HeaderCell w={colWidths.ui} label="UI" />
                <Resizer onMouseDown={onResize('ui')} />
                <HeaderCell w={colWidths.luaPath} label="Lua 路径" />
                <Resizer onMouseDown={onResize('luaPath')} />
                <HeaderCell w={colWidths.goPath} label="GameObject 路径" />
                <Resizer onMouseDown={onResize('goPath')} />
                <HeaderCell w={colWidths.hit} label="命中字段" />
            </div>
            {visibleHits.map((hit, i) => (
                <Row key={i} hit={hit} colWidths={colWidths} onJump={onJump} onLocateGo={onLocateGo} alt={i % 2 === 1} />
            ))}
            {remaining > 0 && (
                <div className="px-3 py-2 text-[11px] text-[var(--coffee-muted)] bg-[var(--cream-warm)]/40 border-b border-[var(--glass-border)] flex items-center gap-2">
                    <span>已显示 {visibleHits.length}/{hits.length} 条。</span>
                    <button
                        type="button"
                        onClick={() => setVisibleCount(c => Math.min(c + RESULT_RENDER_BATCH, hits.length))}
                        className="px-2 py-1 rounded border border-[var(--glass-border)] bg-white/60 text-[var(--coffee-deep)] hover:bg-white"
                    >
                        再显示 {Math.min(RESULT_RENDER_BATCH, remaining)} 条
                    </button>
                </div>
            )}
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

function Row({ hit, colWidths, onJump, onLocateGo, alt }) {
    const [hovered, setHovered] = useState(false)
    return (
        <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
            className={`flex items-stretch border-b border-[var(--glass-border)]/40 ${
                hovered ? 'bg-[var(--cream-warm)]/40' : (alt ? 'bg-white/40' : 'bg-transparent')
            } transition-colors`}>
            {/* UI 列：cell click → 跳转 */}
            <UiCell w={colWidths.ui} hit={hit} hovered={hovered} onJump={onJump} />
            <span className="w-1 flex-shrink-0" />
            <LuaPathCell w={colWidths.luaPath} luaPath={hit.luaPath} hovered={hovered} />
            <span className="w-1 flex-shrink-0" />
            <GoPathCell w={colWidths.goPath} goPath={hit.goPath} goInstanceId={hit.goInstanceId}
                hovered={hovered} onLocateGo={onLocateGo} />
            <span className="w-1 flex-shrink-0" />
            <HitCell w={colWidths.hit} hit={hit} />
        </div>
    )
}

const cellBase = "flex-shrink-0 flex items-center gap-1.5 min-w-0 overflow-hidden"

function UiCell({ w, hit, hovered, onJump }) {
    return (
        <div style={{ width: w, padding: '6px 10px' }}
            className={`${cellBase} cursor-pointer group/ui hover:bg-[var(--caramel)]/15`}
            onClick={() => onJump(hit)}
            title={`跳转到 ${hit.uiName}${hit.uiId ? ` #${hit.uiId}` : ''} → ${hit.luaPath || '(根)'}`}>
            <CornerDownRight size={11} className={`flex-shrink-0 transition-opacity ${hovered ? 'text-[var(--caramel)] opacity-100' : 'text-[var(--coffee-muted)] opacity-30'}`} />
            <span className="font-medium text-[var(--coffee-deep)] truncate">{hit.uiName}</span>
            {hit.uiId && <span className="font-mono text-[9px] text-[var(--coffee-muted)]">#{hit.uiId}</span>}
        </div>
    )
}

function LuaPathCell({ w, luaPath, hovered }) {
    const path = luaPath || '(根)'
    const displayPath = middleEllipsisPath(path, '.')
    return (
        <div style={{ width: w, padding: '6px 10px' }} className={cellBase}>
            <span className="font-mono text-[var(--coffee-muted)] truncate min-w-0 select-text" title={path}
                style={{ cursor: 'text' }}>{displayPath}</span>
            {hovered && luaPath && (
                <CopyButton value={luaPath} title="复制 Lua 路径" />
            )}
        </div>
    )
}

function GoPathCell({ w, goPath, goInstanceId, hovered, onLocateGo }) {
    if (!goPath) {
        return <div style={{ width: w, padding: '6px 10px' }} className={cellBase}>
            <span className="text-[var(--coffee-muted)] opacity-30">—</span>
        </div>
    }
    const displayPath = middleEllipsisPath(goPath, '/')
    return (
        <div style={{ width: w, padding: '6px 10px' }} className={cellBase}>
            <span className="font-mono text-[var(--coffee-muted)] truncate min-w-0 select-text" title={goPath}
                style={{ cursor: 'text' }}>{displayPath}</span>
            {hovered && (
                <>
                    <CopyButton value={goPath} title="复制 GameObject 全路径" />
                    {goInstanceId != null && goInstanceId !== -1 && (
                        <button onClick={() => onLocateGo(goInstanceId)}
                            className="p-0.5 rounded hover:bg-[var(--caramel)]/20 text-[var(--coffee-muted)] hover:text-[var(--caramel)] flex-shrink-0"
                            title={`在 Hierarchy 中定位 #${goInstanceId}`}>
                            <Crosshair size={11} />
                        </button>
                    )}
                </>
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
                <span className="text-[var(--coffee-deep)]">{hit.key}</span>
                <span className="text-[var(--coffee-muted)] opacity-60 mx-1">::</span>
                <span className="text-[var(--sage)] font-medium">{hit.valueDisplay}</span>
            </span>
        )
    }
    if (hit.valueType === 'compText') {
        return (
            <span className="font-mono truncate min-w-0 select-text" title={hit.valueDisplay} style={{ cursor: 'text' }}>
                <span className="text-[var(--coffee-deep)]">{hit.key}</span>
                <span className="text-[var(--coffee-muted)] mx-1">=</span>
                <span className="text-[var(--coffee-deep)]">"{hit.valueDisplay}"</span>
                {hit.via && <span className="ml-1 px-1 rounded bg-[var(--caramel)]/15 text-[var(--caramel)] text-[9px]" title={hit.via}>{hit.via}</span>}
            </span>
        )
    }
    return (
        <span className="font-mono truncate min-w-0 select-text" title={hit.valueDisplay} style={{ cursor: 'text' }}>
            <span className="text-[var(--coffee-deep)]">{hit.key}</span>
            <span className="text-[var(--coffee-muted)] mx-1">=</span>
            <span className="text-[var(--coffee-deep)]">{hit.valueDisplay}</span>
        </span>
    )
}
