import { useState, useCallback } from 'react'
import { ChevronRight, ChevronDown, Crosshair, Loader2 } from 'lucide-react'
import { parseNumericDraft } from '../utils/numericInput'

// 复用：Hierarchy / 未来其它反射面板共用的属性单行组件
// 接收 prop 对象：{ name, value, valueType, typeName, editable, count?, collectionKind? }
// onSet(value): 触发后端写值
// onLoadCollection(propName, offset, limit, cb): 懒加载集合元素 (仅 valueType='collection' 时)
// onLocate(instanceId): 在 Hierarchy 中定位 GO (collection 元素 🎯 按钮)
//
// 布局约定：每行第一列固定为 12px chevron 槽（无 chevron 时留空但保持占位），
// 这样 collection 行与其它行的 name 列起始位置完全对齐，避免视觉缩进不一致。

const NAME_COL = "font-mono text-[var(--coffee-muted)] text-[10px] w-28 truncate flex-shrink-0"
// 全局 index.css 的 `input { padding:10px 14px; width:100%; border-radius:12px }` 与 Tailwind 工具类同特异性但定义靠后会赢，
// 所以这里所有尺寸/内边距/圆角必须用 ! 重要修饰符强制，否则数字框会被撑成宽椭圆并 100% 撑满父容器。
const INPUT_CLS = "!h-5 !py-0 !px-1 !rounded !border !border-[var(--glass-border)] !bg-white/70 font-mono !text-[10px] focus:outline-none focus:!border-[var(--caramel)]"

const ChevronSlot = ({ children }) => (
    <span className="w-3 flex-shrink-0 inline-flex items-center justify-center text-[var(--coffee-muted)]">{children}</span>
)

function NumericInput({ value, valueType = 'float', onCommit, className }) {
    const [draft, setDraft] = useState(null)
    const isEditing = draft !== null

    const finishEdit = () => {
        if (!isEditing) return
        const parsed = parseNumericDraft(draft, valueType)
        setDraft(null)
        if (parsed !== null && parsed !== value) onCommit(parsed)
    }

    return (
        <input
            type="text"
            inputMode={valueType === 'int' ? 'numeric' : 'decimal'}
            value={isEditing ? draft : String(value ?? 0)}
            onFocus={() => setDraft(String(value ?? 0))}
            onChange={e => setDraft(e.target.value)}
            onBlur={finishEdit}
            onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className={className}
        />
    )
}

export default function PropRow({ prop, onSet, onLoadCollection, onLoadNested, onSetNested, onLocate }) {
    const [editVal, setEditVal] = useState(null)
    const p = prop
    const isEditing = editVal !== null
    const commit = (val) => { onSet(val); setEditVal(null) }

    if (p.valueType === 'bool' && p.editable) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.name}>{p.name}:</span>
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
                <ChevronSlot />
                <span className={NAME_COL} title={p.name}>{p.name}:</span>
                <NumericInput
                    value={p.value ?? 0}
                    valueType={p.valueType}
                    onCommit={onSet}
                    className={`!w-24 ${INPUT_CLS}`}
                />
            </div>
        )
    }
    if (p.valueType === 'string' && p.editable) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.name}>{p.name}:</span>
                <input type="text" value={isEditing ? editVal : (p.value ?? '')}
                    onFocus={() => setEditVal(p.value ?? '')}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => { if (isEditing) commit(editVal) }}
                    onKeyDown={e => { if (e.key === 'Enter') { commit(editVal); e.target.blur() } }}
                    className={`!flex-1 ${INPUT_CLS}`}
                />
            </div>
        )
    }
    if ((p.valueType === 'vector2' || p.valueType === 'vector3' || p.valueType === 'vector4' || p.valueType === 'color' || p.valueType === 'euler' || p.valueType === 'rect') && p.editable) {
        const arr = Array.isArray(p.value) ? p.value : [0, 0, 0, 0]
        const labels = p.valueType === 'color' ? ['R','G','B','A'] : p.valueType === 'rect' ? ['X','Y','W','H'] : ['X','Y','Z','W']
        const count = p.valueType === 'vector2' ? 2 : (p.valueType === 'vector3' || p.valueType === 'euler') ? 3 : 4
        return (
            <div className="flex items-center gap-1 py-0.5 text-xs flex-wrap">
                <ChevronSlot />
                <span className={NAME_COL} title={p.name}>{p.name}:</span>
                {p.valueType === 'color' && <span className="w-3 h-3 rounded-sm border border-black/10 flex-shrink-0" style={{ background: `rgba(${(arr[0]*255)|0},${(arr[1]*255)|0},${(arr[2]*255)|0},${arr[3]??1})` }} />}
                {Array.from({ length: count }).map((_, i) => (
                    <div key={i} className="flex items-center gap-0.5">
                        <span className="text-[9px] text-[var(--coffee-muted)] opacity-50">{labels[i]}</span>
                        <NumericInput
                            value={arr[i] ?? 0}
                            valueType="float"
                            onCommit={value => {
                                const next = [...arr.slice(0, count)]
                                next[i] = value
                                onSet(next)
                            }}
                            className={`!w-14 ${INPUT_CLS}`}
                        />
                    </div>
                ))}
            </div>
        )
    }
    if (p.valueType === 'object' && onLoadNested) {
        return <ObjectField p={p} onLoadCollection={onLoadCollection} onLoadNested={onLoadNested} onSetNested={onSetNested} onLocate={onLocate} />
    }
    if (p.valueType === 'collection' && (onLoadCollection || (p.path && onLoadNested))) {
        const loader = p.path && onLoadNested
            ? (_propName, offset, limit, cb) => onLoadNested(p.path, offset, limit, cb)
            : onLoadCollection
        return <CollectionField p={p} onLoadCollection={loader} onLoadNested={onLoadNested} onSetNested={onSetNested} onLocate={onLocate} />
    }
    if (p.valueType === 'ref' && p.instanceId != null && p.instanceId !== -1) {
        return (
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.name}>{p.name}:</span>
                <span className="text-[var(--sage)] font-medium truncate min-w-0" title={`#${p.instanceId} ${p.value}`}>
                    {p.value}
                </span>
                <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{p.actualType || p.typeName}</span>
                {onLocate && (
                    <button onClick={() => onLocate(p.instanceId)}
                        className="ml-auto p-0.5 rounded hover:bg-[var(--caramel)]/20 text-[var(--coffee-muted)] hover:text-[var(--caramel)] flex-shrink-0"
                        title={`在 Hierarchy 中定位 #${p.instanceId} (${p.value})`}>
                        <Crosshair size={10} />
                    </button>
                )}
            </div>
        )
    }
    return (
        <div className="flex items-center gap-2 py-0.5 text-xs">
            <ChevronSlot />
            <span className={NAME_COL} title={p.name}>{p.name}:</span>
            <span className="font-mono text-[var(--coffee-muted)] opacity-60 text-[10px] truncate">{String(p.value ?? 'null')}</span>
            <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{p.typeName}</span>
        </div>
    )
}

// ============================================================================
// 集合字段（懒加载 + 元素行 + 🎯 Locate）
// ============================================================================
function CollectionField({ p, onLoadCollection, onLoadNested, onSetNested, onLocate }) {
    const [expanded, setExpanded] = useState(false)
    const [items, setItems] = useState(null)
    const [total, setTotal] = useState(p.count ?? 0)
    const [kind, setKind] = useState(p.collectionKind || 'list')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const PAGE = 20
    const isEmpty = (p.count ?? 0) === 0

    const loadPage = useCallback((offset) => {
        setLoading(true)
        setError(null)
        onLoadCollection(p.name, offset, PAGE, (data) => {
            setLoading(false)
            if (!data || data.error) { setError(data?.error || '加载失败'); return }
            setTotal(data.total ?? 0)
            setKind(data.kind || 'list')
            setItems(prev => offset === 0 ? (data.items || []) : [...(prev || []), ...(data.items || [])])
        })
    }, [onLoadCollection, p.name])

    const toggleExpand = useCallback(() => {
        if (isEmpty) return
        if (!expanded && items === null) loadPage(0)
        setExpanded(!expanded)
    }, [expanded, items, isEmpty, loadPage])

    return (
        <div className="py-0.5 text-xs">
            <div className="flex items-center gap-2">
                <ChevronSlot>
                    <button onClick={toggleExpand} disabled={isEmpty}
                        className={`p-0 ${isEmpty ? 'opacity-25 cursor-default' : 'cursor-pointer hover:text-[var(--coffee-deep)]'}`}
                        title={isEmpty ? '空集合' : (expanded ? '折叠' : '展开')}>
                        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                </ChevronSlot>
                <span className={`${NAME_COL} ${isEmpty ? '' : 'cursor-pointer hover:text-[var(--coffee-deep)]'}`}
                    title={p.name}
                    onClick={isEmpty ? undefined : toggleExpand}>{p.name}:</span>
                <span className="font-mono text-[var(--coffee-muted)] opacity-60 text-[10px] truncate">{p.value}</span>
                <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{p.typeName}</span>
            </div>
            {expanded && (
                <div className="ml-5 mt-0.5 border-l border-[var(--glass-border)] pl-2 space-y-0.5">
                    {error && <div className="text-[var(--terracotta)] text-[10px]">⚠ {error}</div>}
                    {!error && items && items.length === 0 && !loading && (
                        <div className="text-[var(--coffee-muted)] opacity-50 text-[10px]">(empty)</div>
                    )}
                    {items && items.map(it => (
                        kind === 'dict'
                            ? <DictRow key={it.index} item={it} onLocate={onLocate} />
                            : <ListRow key={it.index} item={it}
                                onLoadNested={onLoadNested}
                                onSetNested={onSetNested}
                                onLocate={onLocate}
                            />
                    ))}
                    {loading && (
                        <div className="flex items-center gap-1 text-[var(--coffee-muted)] text-[10px]">
                            <Loader2 size={10} className="animate-spin" /> 加载中...
                        </div>
                    )}
                    {!loading && items && items.length < total && (
                        <button onClick={() => loadPage(items.length)}
                            className="text-[10px] text-[var(--caramel)] hover:underline">
                            加载更多 ({items.length}/{total})
                        </button>
                    )}
                    {!loading && items && items.length >= total && total > PAGE && (
                        <div className="text-[9px] text-[var(--coffee-muted)] opacity-40">已全部加载 ({total})</div>
                    )}
                </div>
            )}
        </div>
    )
}

function ObjectField({ p, onLoadCollection, onLoadNested, onSetNested, onLocate }) {
    const [expanded, setExpanded] = useState(false)
    const [items, setItems] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const isEmpty = (p.memberCount ?? 0) === 0

    const load = useCallback(() => {
        setLoading(true)
        setError(null)
        onLoadNested(p.path, 0, 200, data => {
            setLoading(false)
            if (!data || data.error) {
                setError(data?.error || '加载失败')
                return
            }
            setItems(data.items || [])
        })
    }, [onLoadNested, p.path])

    const toggleExpand = useCallback(() => {
        if (isEmpty) return
        if (!expanded && items === null) load()
        setExpanded(!expanded)
    }, [expanded, items, isEmpty, load])

    return (
        <div className="py-0.5 text-xs">
            <div className="flex items-center gap-2">
                <ChevronSlot>
                    <button onClick={toggleExpand} disabled={isEmpty}
                        className={`p-0 ${isEmpty ? 'opacity-25 cursor-default' : 'cursor-pointer hover:text-[var(--coffee-deep)]'}`}
                        title={isEmpty ? '无公开字段' : (expanded ? '折叠' : '展开对象')}>
                        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                </ChevronSlot>
                <span className={`${NAME_COL} ${isEmpty ? '' : 'cursor-pointer hover:text-[var(--coffee-deep)]'}`}
                    title={p.name}
                    onClick={isEmpty ? undefined : toggleExpand}>{p.name}:</span>
                <span className="font-mono text-[var(--coffee-deep)] text-[10px] truncate">{p.typeName}</span>
                <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{p.memberCount ?? 0} fields</span>
            </div>
            {expanded && (
                <div className="ml-5 mt-0.5 border-l border-[var(--glass-border)] pl-2 space-y-0.5">
                    {error && <div className="text-[var(--terracotta)] text-[10px]">⚠ {error}</div>}
                    {loading && (
                        <div className="flex items-center gap-1 text-[var(--coffee-muted)] text-[10px]">
                            <Loader2 size={10} className="animate-spin" /> 加载中...
                        </div>
                    )}
                    {items && items.map((member, index) => (
                        <PropRow
                            key={`${member.name || member.index}_${index}`}
                            prop={member}
                            onSet={value => onSetNested?.(member.path, value, member.valueType, data => {
                                if (data?.error) {
                                    setError(data.error)
                                    return
                                }
                                load()
                            })}
                            onLoadCollection={onLoadCollection}
                            onLoadNested={onLoadNested}
                            onSetNested={onSetNested}
                            onLocate={onLocate}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function ListRow({ item, onLoadNested, onSetNested, onLocate }) {
    const isLocatable = (item.kind === 'go' || item.kind === 'comp') && item.instanceId != null && item.instanceId !== -1 && onLocate
    if ((item.valueType === 'object' || item.valueType === 'collection') && onLoadNested) {
        return (
            <PropRow
                prop={{ ...item, name: `[${item.index}]` }}
                onSet={value => onSetNested?.(item.path, value, item.valueType)}
                onLoadNested={onLoadNested}
                onSetNested={onSetNested}
                onLocate={onLocate}
            />
        )
    }
    return (
        <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-[var(--coffee-muted)] opacity-40 font-mono w-6 flex-shrink-0">[{item.index}]</span>
            <ItemBody item={item} onLocate={onLocate} canLocate={isLocatable} />
        </div>
    )
}

function DictRow({ item, onLocate }) {
    const keyLocatable = (item.key.kind === 'go' || item.key.kind === 'comp') && item.key.instanceId != null && item.key.instanceId !== -1 && onLocate
    const valLocatable = (item.value.kind === 'go' || item.value.kind === 'comp') && item.value.instanceId != null && item.value.instanceId !== -1 && onLocate
    return (
        <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
            <span className="text-[var(--coffee-muted)] opacity-40 font-mono w-6 flex-shrink-0">[{item.index}]</span>
            <ItemBody item={item.key} onLocate={onLocate} canLocate={keyLocatable} />
            <span className="text-[var(--coffee-muted)] opacity-40">→</span>
            <ItemBody item={item.value} onLocate={onLocate} canLocate={valLocatable} />
        </div>
    )
}

function ItemBody({ item, onLocate, canLocate }) {
    if (item.kind === 'go' || item.kind === 'comp') {
        return (
            <span className="inline-flex items-center gap-1 min-w-0">
                <span className="text-[var(--sage)] font-medium truncate" title={`#${item.instanceId} ${item.name}`}>
                    {item.name}
                </span>
                <span className="text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{item.typeName}</span>
                {canLocate && (
                    <button onClick={() => onLocate(item.instanceId)}
                        className="p-0.5 rounded hover:bg-[var(--caramel)]/20 text-[var(--coffee-muted)] hover:text-[var(--caramel)] flex-shrink-0"
                        title={`在 Hierarchy 中定位 #${item.instanceId}`}>
                        <Crosshair size={9} />
                    </button>
                )}
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-1 min-w-0">
            <span className="font-mono text-[var(--coffee-deep)] truncate" title={String(item.display)}>{String(item.display)}</span>
            <span className="text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{item.typeName}</span>
        </span>
    )
}
