import { useState, useCallback, useEffect, useRef } from 'react'
import { ChevronRight, ChevronDown, Crosshair, Loader2, Palette, ShieldAlert } from 'lucide-react'
import { parseNumericDraft, stepNumericValue } from '../utils/numericInput'

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

function FieldDecorations({ p, children }) {
    return (
        <>
            {!!p.space && <div style={{ height: Math.min(Number(p.space) || 8, 24) }} />}
            {p.header && (
                <div className="mt-1.5 mb-0.5 border-l-2 border-[var(--caramel)]/55 pl-1.5 text-[10px] font-semibold text-[var(--coffee-deep)]">
                    {p.header}
                </div>
            )}
            <div title={p.tooltip || undefined}>{children}</div>
        </>
    )
}

function NumericInput({ value, valueType = 'float', onCommit, className }) {
    const [draft, setDraft] = useState(null)
    const inputRef = useRef(null)
    const draftRef = useRef(null)
    const valueRef = useRef(value)
    const valueTypeRef = useRef(valueType)
    const onCommitRef = useRef(onCommit)
    const wheelCommitTimerRef = useRef(null)
    const pendingWheelValueRef = useRef(null)
    const lastWheelCommitRef = useRef(null)
    const isEditing = draft !== null

    useEffect(() => { draftRef.current = draft }, [draft])
    useEffect(() => { valueRef.current = value }, [value])
    useEffect(() => { valueTypeRef.current = valueType }, [valueType])
    useEffect(() => { onCommitRef.current = onCommit }, [onCommit])

    const finishEdit = () => {
        if (!isEditing) return
        if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
        wheelCommitTimerRef.current = null
        pendingWheelValueRef.current = null
        const parsed = parseNumericDraft(draft, valueType)
        setDraft(null)
        if (parsed !== null && parsed !== value && parsed !== lastWheelCommitRef.current) onCommit(parsed)
        lastWheelCommitRef.current = null
    }

    useEffect(() => () => {
        if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
    }, [])

    useEffect(() => {
        const input = inputRef.current
        if (!input) return
        const handleWheel = event => {
            if (document.activeElement !== input || event.deltaY === 0) return
            event.preventDefault()
            event.stopPropagation()
            const baseValue = pendingWheelValueRef.current ?? draftRef.current ?? valueRef.current ?? 0
            const next = stepNumericValue(baseValue, valueTypeRef.current, event.deltaY < 0 ? 1 : -1)
            if (next === null) return
            const nextText = String(next)
            draftRef.current = nextText
            setDraft(nextText)
            pendingWheelValueRef.current = next
            if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
            wheelCommitTimerRef.current = setTimeout(() => {
                const pending = pendingWheelValueRef.current
                wheelCommitTimerRef.current = null
                pendingWheelValueRef.current = null
                if (pending == null) return
                lastWheelCommitRef.current = pending
                onCommitRef.current(pending)
            }, 140)
        }
        input.addEventListener('wheel', handleWheel, { passive: false })
        return () => input.removeEventListener('wheel', handleWheel)
    }, [])

    return (
        <input
            ref={inputRef}
            type="text"
            inputMode={valueType === 'int' ? 'numeric' : 'decimal'}
            value={isEditing ? draft : String(value ?? 0)}
            onFocus={() => {
                const nextDraft = String(value ?? 0)
                draftRef.current = nextDraft
                setDraft(nextDraft)
            }}
            onChange={e => {
                draftRef.current = e.target.value
                setDraft(e.target.value)
            }}
            onBlur={finishEdit}
            onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className={className}
        />
    )
}

export default function PropRow({ prop, onSet, onLoadCollection, onLoadNested, onSetNested, onLoadMaterial, onSetMaterial, onLocate }) {
    const [editVal, setEditVal] = useState(null)
    const p = prop
    const isEditing = editVal !== null
    const commit = (val) => { onSet(val); setEditVal(null) }

    if (p.valueType === 'bool' && p.editable) {
        return <FieldDecorations p={p}>
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
                <button onClick={() => onSet(!p.value)}
                    className={`relative inline-flex items-center h-4 w-7 flex-shrink-0 rounded-full transition-colors ${p.value ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/30'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${p.value ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                </button>
            </div>
        </FieldDecorations>
    }
    if ((p.valueType === 'int' || p.valueType === 'float') && p.editable) {
        const min = p.rangeMin ?? p.min
        const max = p.rangeMax
        const commitNumber = value => onSet(min != null ? Math.max(Number(min), value) : value)
        return <FieldDecorations p={p}>
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
                {min != null && max != null && (
                    <input type="range" min={min} max={max} step={p.valueType === 'int' ? 1 : 'any'}
                        value={Number(p.value ?? 0)}
                        onChange={e => commitNumber(p.valueType === 'int' ? Number.parseInt(e.target.value, 10) : Number(e.target.value))}
                        className="!w-28 !h-1 !p-0 accent-[var(--caramel)] flex-shrink-0"
                    />
                )}
                <NumericInput
                    value={p.value ?? 0}
                    valueType={p.valueType}
                    onCommit={commitNumber}
                    className={`!w-24 ${INPUT_CLS}`}
                />
            </div>
        </FieldDecorations>
    }
    if (p.valueType === 'enum' && p.editable) {
        return <FieldDecorations p={p}>
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
                <select value={String(p.value ?? '')} onChange={e => onSet(e.target.value)}
                    className="!h-5 !py-0 !px-1 !rounded !border !border-[var(--glass-border)] !bg-white/70 font-mono !text-[10px] min-w-28">
                    {(p.enumOptions || [String(p.value ?? '')]).map(option => <option key={option} value={option}>{option}</option>)}
                </select>
            </div>
        </FieldDecorations>
    }
    if (p.valueType === 'string' && p.editable) {
        return <FieldDecorations p={p}>
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
                {p.textArea ? <textarea value={isEditing ? editVal : (p.value ?? '')}
                    rows={p.lines || p.minLines || 3}
                    onFocus={() => setEditVal(p.value ?? '')}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => { if (isEditing) commit(editVal) }}
                    className="!flex-1 !min-h-14 !py-1 !px-1 !rounded !border !border-[var(--glass-border)] !bg-white/70 font-mono !text-[10px]"
                /> : <input type="text" value={isEditing ? editVal : (p.value ?? '')}
                    onFocus={() => setEditVal(p.value ?? '')}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => { if (isEditing) commit(editVal) }}
                    onKeyDown={e => { if (e.key === 'Enter') { commit(editVal); e.target.blur() } }}
                    className={`!flex-1 ${INPUT_CLS}`}
                />}
            </div>
        </FieldDecorations>
    }
    if ((p.valueType === 'vector2' || p.valueType === 'vector3' || p.valueType === 'vector4' || p.valueType === 'color' || p.valueType === 'euler' || p.valueType === 'rect') && p.editable) {
        const arr = Array.isArray(p.value) ? p.value : [0, 0, 0, 0]
        const labels = p.valueType === 'color' ? ['R','G','B','A'] : p.valueType === 'rect' ? ['X','Y','W','H'] : ['X','Y','Z','W']
        const count = p.valueType === 'vector2' ? 2 : (p.valueType === 'vector3' || p.valueType === 'euler') ? 3 : 4
        return <FieldDecorations p={p}>
            <div className="grid grid-cols-[12px_7rem_minmax(0,1fr)] items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
                <div className="flex min-w-0 items-center gap-1.5">
                    <span
                        className={`h-3 w-3 flex-shrink-0 rounded-sm border ${p.valueType === 'color' ? 'border-black/10' : 'invisible border-transparent'}`}
                        style={p.valueType === 'color' ? { background: `rgba(${(arr[0]*255)|0},${(arr[1]*255)|0},${(arr[2]*255)|0},${arr[3]??1})` } : undefined}
                    />
                    <div className="grid grid-flow-col auto-cols-[4.25rem] gap-1">
                        {Array.from({ length: count }).map((_, i) => (
                            <label key={i} className="grid grid-cols-[10px_3.5rem] items-center gap-0.5">
                                <span className="text-center text-[9px] text-[var(--coffee-muted)] opacity-50">{labels[i]}</span>
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
                            </label>
                        ))}
                    </div>
                </div>
            </div>
        </FieldDecorations>
    }
    if (p.valueType === 'object' && onLoadNested) {
        return <FieldDecorations p={p}><ObjectField p={p} onLoadCollection={onLoadCollection} onLoadNested={onLoadNested} onSetNested={onSetNested} onLoadMaterial={onLoadMaterial} onSetMaterial={onSetMaterial} onLocate={onLocate} /></FieldDecorations>
    }
    if (p.valueType === 'collection' && (onLoadCollection || (p.path && onLoadNested))) {
        const loader = p.path && onLoadNested
            ? (_propName, offset, limit, cb) => onLoadNested(p.path, offset, limit, cb)
            : onLoadCollection
        return <FieldDecorations p={p}><CollectionField p={p} onLoadCollection={loader} onLoadNested={onLoadNested} onSetNested={onSetNested} onLoadMaterial={onLoadMaterial} onSetMaterial={onSetMaterial} onLocate={onLocate} /></FieldDecorations>
    }
    if (p.valueType === 'material' && p.materialInstanceId != null) {
        return <FieldDecorations p={p}><MaterialField p={p} onLoadMaterial={onLoadMaterial} onSetMaterial={onSetMaterial} /></FieldDecorations>
    }
    if (p.valueType === 'ref' && p.instanceId != null && p.instanceId !== -1) {
        return <FieldDecorations p={p}>
            <div className="flex items-center gap-2 py-0.5 text-xs">
                <ChevronSlot />
                <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
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
        </FieldDecorations>
    }
    return <FieldDecorations p={p}>
        <div className="flex items-center gap-2 py-0.5 text-xs">
            <ChevronSlot />
            <span className={NAME_COL} title={p.tooltip || p.name}>{p.displayName || p.name}:</span>
            <span className="font-mono text-[var(--coffee-muted)] opacity-60 text-[10px] truncate">{String(p.value ?? 'null')}</span>
            <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{p.typeName}</span>
        </div>
    </FieldDecorations>
}

// ============================================================================
// 材质字段（显式按需加载；不访问 Renderer.material，避免隐式实例化）
// ============================================================================
function MaterialField({ p, onLoadMaterial, onSetMaterial }) {
    const [expanded, setExpanded] = useState(false)
    const [detail, setDetail] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)

    const load = useCallback(() => {
        if (!onLoadMaterial) return
        setLoading(true)
        setError(null)
        onLoadMaterial(p.materialInstanceId, data => {
            setLoading(false)
            if (!data || data.error) {
                setError(data?.error || '加载材质参数失败')
                return
            }
            setDetail(data)
        })
    }, [onLoadMaterial, p.materialInstanceId])

    const toggle = () => {
        if (!expanded && !detail) load()
        setExpanded(value => !value)
    }

    const setProperty = (propertyName, propertyType, value) => {
        if (!onSetMaterial) return
        setError(null)
        onSetMaterial(p.materialInstanceId, propertyName, propertyType, value, data => {
            if (data?.error) {
                setError(data.error)
                return
            }
            load()
        })
    }

    return (
        <div className="py-0.5 text-xs">
            <div className="flex items-center gap-2">
                <ChevronSlot>
                    <button onClick={toggle} className="p-0 hover:text-[var(--coffee-deep)]" title={expanded ? '收起材质参数' : '加载材质参数'}>
                        {loading ? <Loader2 size={10} className="animate-spin" /> : expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                </ChevronSlot>
                <span className={`${NAME_COL} cursor-pointer hover:text-[var(--coffee-deep)]`} onClick={toggle} title={p.name}>
                    {p.displayName || p.name}:
                </span>
                <Palette size={11} className="text-[var(--caramel)] flex-shrink-0" />
                <span className="font-medium text-[var(--coffee-deep)] truncate min-w-0">{p.value || 'Material'}</span>
                <span className="text-[9px] text-[var(--coffee-muted)] opacity-45 truncate min-w-0">{p.shaderName}</span>
                {!expanded && (
                    <button onClick={toggle} className="ml-auto rounded border border-[var(--caramel)]/25 px-1.5 py-0.5 text-[9px] text-[var(--caramel)] hover:bg-[var(--caramel)]/10">
                        加载参数
                    </button>
                )}
            </div>
            {expanded && (
                <div className="ml-5 mt-1 overflow-hidden rounded-md border border-[var(--caramel)]/20 bg-[var(--cream-warm)]/20">
                    <div className="flex items-start gap-1.5 border-b border-[var(--caramel)]/15 bg-[var(--caramel)]/[0.045] px-2 py-1.5 text-[9px] text-[var(--coffee-muted)]">
                        <ShieldAlert size={11} className="mt-0.5 flex-shrink-0 text-[var(--caramel)]" />
                        <span>运行时直接编辑当前材质引用；共享材质的变化会影响所有使用者，刷新或退出游戏后不会保存。</span>
                    </div>
                    {error && <div className="px-2 py-1 text-[10px] text-[var(--terracotta)]">⚠ {error}</div>}
                    {loading && !detail && (
                        <div className="flex items-center gap-1 px-2 py-2 text-[10px] text-[var(--coffee-muted)]">
                            <Loader2 size={10} className="animate-spin" /> 正在读取 Shader 参数...
                        </div>
                    )}
                    {detail && (
                        <>
                            <div className="flex items-center gap-2 border-b border-[var(--glass-border)]/60 px-2 py-1 text-[9px] text-[var(--coffee-muted)]">
                                <span className="font-medium text-[var(--coffee-deep)]">{detail.shaderName || 'Unknown Shader'}</span>
                                <span className="ml-auto">Queue {detail.renderQueue}</span>
                                <button onClick={load} className="hover:text-[var(--caramel)]">刷新</button>
                            </div>
                            <div className="max-h-80 space-y-0.5 overflow-y-auto px-2 py-1">
                                {(detail.properties || []).map(prop => (
                                    <MaterialPropertyRow key={prop.name} prop={prop} onSet={setProperty} />
                                ))}
                                {(detail.properties || []).length === 0 && (
                                    <div className="py-2 text-center text-[10px] text-[var(--coffee-muted)] opacity-50">Shader 没有可枚举参数</div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

function MaterialPropertyRow({ prop, onSet }) {
    const label = prop.displayName || prop.name
    const propertyType = prop.propertyType
    if (propertyType === 'Float' || propertyType === 'Range' || propertyType === 'Int') {
        const isInt = propertyType === 'Int'
        return (
            <div className="flex items-center gap-1.5 py-0.5">
                <span className="w-32 flex-shrink-0 truncate font-mono text-[10px] text-[var(--coffee-muted)]" title={`${label} (${prop.name})`}>{label}</span>
                {propertyType === 'Range' && prop.rangeMin != null && prop.rangeMax != null && (
                    <input type="range" min={prop.rangeMin} max={prop.rangeMax} step="any" value={Number(prop.value ?? 0)}
                        onChange={e => onSet(prop.name, propertyType, Number(e.target.value))}
                        className="!h-1 !w-28 !p-0 accent-[var(--caramel)]"
                    />
                )}
                <NumericInput value={prop.value ?? 0} valueType={isInt ? 'int' : 'float'}
                    onCommit={value => onSet(prop.name, propertyType, value)}
                    className={`!w-20 ${INPUT_CLS}`}
                />
            </div>
        )
    }
    if (propertyType === 'Color' || propertyType === 'Vector') {
        const values = Array.isArray(prop.value) ? prop.value : [0, 0, 0, propertyType === 'Color' ? 1 : 0]
        const labels = propertyType === 'Color' ? ['R', 'G', 'B', 'A'] : ['X', 'Y', 'Z', 'W']
        return (
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5 py-0.5">
                <span className="w-32 flex-shrink-0 truncate font-mono text-[10px] text-[var(--coffee-muted)]" title={`${label} (${prop.name})`}>{label}</span>
                <div className="flex min-w-0 items-center gap-1">
                    <span
                        className={`h-3 w-3 flex-shrink-0 rounded-sm border ${propertyType === 'Color' ? 'border-black/10' : 'invisible border-transparent'}`}
                        style={propertyType === 'Color' ? { background: `rgba(${(values[0] * 255) | 0},${(values[1] * 255) | 0},${(values[2] * 255) | 0},${values[3] ?? 1})` } : undefined}
                    />
                    <div className="grid grid-flow-col auto-cols-[3.75rem] gap-1">
                        {labels.map((axis, index) => (
                            <label key={axis} className="grid grid-cols-[9px_3rem] items-center gap-0.5">
                                <span className="text-center text-[8px] text-[var(--coffee-muted)] opacity-45">{axis}</span>
                                <NumericInput value={values[index] ?? 0} valueType="float"
                                    onCommit={value => {
                                        const next = [...values]
                                        next[index] = value
                                        onSet(prop.name, propertyType, next)
                                    }}
                                    className={`!w-12 ${INPUT_CLS}`}
                                />
                            </label>
                        ))}
                    </div>
                </div>
            </div>
        )
    }
    if (propertyType === 'Texture') {
        return (
            <div className="border-b border-[var(--glass-border)]/30 py-1 last:border-0">
                <div className="flex items-center gap-1.5">
                    <span className="w-32 flex-shrink-0 truncate font-mono text-[10px] text-[var(--coffee-muted)]" title={`${label} (${prop.name})`}>{label}</span>
                    <span className="truncate font-mono text-[10px] text-[var(--coffee-deep)]">{prop.textureName || 'None'}</span>
                    {prop.textureWidth != null && <span className="text-[8px] text-[var(--coffee-muted)] opacity-45">{prop.textureWidth}×{prop.textureHeight}</span>}
                </div>
                {!prop.noScaleOffset && <div className="ml-32 mt-0.5 flex items-center gap-2 pl-1.5">
                    <MaterialVector2 label="Offset" value={prop.offset} onCommit={value => onSet(prop.name, 'TextureOffset', value)} />
                    <MaterialVector2 label="Scale" value={prop.scale} onCommit={value => onSet(prop.name, 'TextureScale', value)} />
                </div>}
            </div>
        )
    }
    return (
        <div className="flex items-center gap-1.5 py-0.5 text-[10px] text-[var(--coffee-muted)]">
            <span className="w-32 truncate font-mono">{label}</span>
            <span className="opacity-45">{String(prop.value ?? propertyType)}</span>
        </div>
    )
}

function MaterialVector2({ label, value, onCommit }) {
    const values = Array.isArray(value) ? value : [0, 0]
    return (
        <span className="inline-grid grid-cols-[2rem_auto_auto] items-center gap-1">
            <span className="text-[8px] text-[var(--coffee-muted)] opacity-45">{label}</span>
            {[0, 1].map(index => (
                <NumericInput key={index} value={values[index] ?? 0} valueType="float"
                    onCommit={nextValue => {
                        const next = [...values]
                        next[index] = nextValue
                        onCommit(next)
                    }}
                    className={`!w-11 ${INPUT_CLS}`}
                />
            ))}
        </span>
    )
}

// ============================================================================
// 集合字段（懒加载 + 元素行 + 🎯 Locate）
// ============================================================================
function CollectionField({ p, onLoadCollection, onLoadNested, onSetNested, onLoadMaterial, onSetMaterial, onLocate }) {
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
                    onClick={isEmpty ? undefined : toggleExpand}>{p.displayName || p.name}:</span>
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
                                onLoadMaterial={onLoadMaterial}
                                onSetMaterial={onSetMaterial}
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

function ObjectField({ p, onLoadCollection, onLoadNested, onSetNested, onLoadMaterial, onSetMaterial, onLocate }) {
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
                    onClick={isEmpty ? undefined : toggleExpand}>{p.displayName || p.name}:</span>
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
                            onLoadMaterial={onLoadMaterial}
                            onSetMaterial={onSetMaterial}
                            onLocate={onLocate}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function ListRow({ item, onLoadNested, onSetNested, onLoadMaterial, onSetMaterial, onLocate }) {
    const isLocatable = (item.kind === 'go' || item.kind === 'comp') && item.instanceId != null && item.instanceId !== -1 && onLocate
    if (((item.valueType === 'object' || item.valueType === 'collection') && onLoadNested) || item.valueType === 'material') {
        return (
            <PropRow
                prop={{ ...item, name: `[${item.index}]` }}
                onSet={value => onSetNested?.(item.path, value, item.valueType)}
                onLoadNested={onLoadNested}
                onSetNested={onSetNested}
                onLoadMaterial={onLoadMaterial}
                onSetMaterial={onSetMaterial}
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
