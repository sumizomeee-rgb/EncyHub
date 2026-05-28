import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import {
    Search, ChevronDown, ChevronRight, X, Loader2, Send, Star, Trash2,
    Upload, Check, FileText, Bookmark, AlertCircle, Plus, FolderOpen, Copy, ClipboardPaste,
    ArrowUp, ArrowDown, PlayCircle
} from 'lucide-react'

const LS_PRESETS_KEY = 'proto_presets'

function loadPresets() {
    try { return JSON.parse(localStorage.getItem(LS_PRESETS_KEY)) || {} } catch { return {} }
}
function savePresets(presets) {
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets))
}

// ============================================================================
// 主组件
// ============================================================================
function ProtoRequester({ clients, selectedClient, active, haruRootInfo }) {
    const [protocols, setProtocols] = useState([])
    const [searchQuery, setSearchQuery] = useState('')
    const [showDropdown, setShowDropdown] = useState(false)
    const [cards, setCards] = useState([])
    const [loading, setLoading] = useState(false)
    const [protoLoaded, setProtoLoaded] = useState(false)
    const [protoCount, setProtoCount] = useState(0)
    const [presets, setPresets] = useState(loadPresets)
    const [importModal, setImportModal] = useState(null) // {fileName, entries} | null
    const [importLoading, setImportLoading] = useState(false)
    const [toast, setToast] = useState(null) // {message, type: 'error'|'success'|'info'} | null

    const [codeImportModal, setCodeImportModal] = useState(null)

    const searchRef = useRef(null)
    const dropdownRef = useRef(null)
    const wsRef = useRef(null)
    const listenersRef = useRef({})
    const wsConnectedRef = useRef(false)
    const cardIdCounter = useRef(0)
    const pendingRequestsRef = useRef({}) // reqId -> cardId
    const lastImportTargetRef = useRef(null)

    // --- Toast ---
    const showToast = useCallback((message, type = 'error') => {
        setToast({ message, type })
        setTimeout(() => setToast(null), 4000)
    }, [])

    // --- HaruRoot 状态 ---
    const hasHaruroot = haruRootInfo?.valid === true

    // HaruRoot 状态变化时清理协议数据
    useEffect(() => {
        if (!hasHaruroot) {
            setProtocols([])
            setProtoLoaded(false)
            setProtoCount(0)
        }
    }, [hasHaruroot])

    // --- WebSocket for PROTO_CALL_RESP ---
    useEffect(() => {
        if (!selectedClient || !active) return
        let closed = false
        const connect = () => {
            if (closed) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/proto_call`)
            wsRef.current = ws
            let pingTimer = null
            ws.onopen = () => {
                wsConnectedRef.current = true
                pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 25000)
            }
            ws.onmessage = (event) => {
                if (event.data === 'pong') return
                try {
                    const msg = JSON.parse(event.data)
                    if (msg.client_id !== selectedClient?.id) return
                    const cb = listenersRef.current[msg.type]
                    if (cb) cb(msg)
                } catch {}
            }
            ws.onclose = () => {
                if (pingTimer) clearInterval(pingTimer)
                wsConnectedRef.current = false
                wsRef.current = null
                if (!closed) setTimeout(connect, 2000)
            }
            ws.onerror = () => ws.close()
        }
        connect()
        return () => { closed = true; wsRef.current?.close(); wsRef.current = null }
    }, [selectedClient?.id, active])

    // --- 加载协议列表（如果已解析） ---
    useEffect(() => {
        if (!active) return
        fetch('/api/gm_console/proto/config')
            .then(r => r.json())
            .then(data => {
                if (data.protocolCount > 0) {
                    setProtoCount(data.protocolCount)
                    setProtoLoaded(true)
                    fetchProtocols()
                }
            })
            .catch(() => {})
    }, [active])

    const fetchProtocols = useCallback(() => {
        setLoading(true)
        fetch('/api/gm_console/proto/search?limit=2000')
            .then(r => r.json())
            .then(data => {
                setProtocols(data.results || [])
                setProtoCount(data.total || 0)
                setProtoLoaded(true)
            })
            .catch(() => {})
            .finally(() => setLoading(false))
    }, [])

    // --- 解析协议 ---
    const handleParse = useCallback(() => {
        setLoading(true)
        fetch('/api/gm_console/proto/parse', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.errors && data.errors.length > 0) {
                    console.warn('[Proto] 解析警告:', data.errors)
                }
                setProtoCount(data.requests || 0)
                setProtoLoaded(true)
                fetchProtocols()
            })
            .catch(e => showToast('解析失败: ' + e.message))
            .finally(() => setLoading(false))
    }, [fetchProtocols])

    // --- 搜索过滤 ---
    const filteredProtocols = useMemo(() => {
        const q = searchQuery.toLowerCase().trim()
        if (!q) return protocols.slice(0, 50)
        return protocols
            .filter(p => p.name.toLowerCase().includes(q))
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1
                const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1
                return aStart - bStart || a.name.localeCompare(b.name)
            })
            .slice(0, 50)
    }, [protocols, searchQuery])

    // --- 添加卡片 ---
    const addCard = useCallback((protocolName) => {
        // 获取协议详情
        fetch(`/api/gm_console/proto/detail?name=${encodeURIComponent(protocolName)}`)
            .then(r => r.json())
            .then(detail => {
                const id = `card_${++cardIdCounter.current}`
                // 查找预设
                const protoPresets = presets[protocolName]
                let initialFieldStates = {}
                let currentPresetId = null
                if (protoPresets?._lastUsed) {
                    initialFieldStates = protoPresets._lastUsed.fieldStates || {}
                    currentPresetId = '_lastUsed'
                }
                const card = {
                    id,
                    protocol: protocolName,
                    detail,
                    fieldStates: buildInitialFieldStates(detail.fields, initialFieldStates),
                    currentPresetId,
                    responses: [],
                    lastResponse: null,
                    collapsed: false,
                    sending: false,
                }
                setCards(prev => [...prev, card])
            })
        setShowDropdown(false)
        setSearchQuery('')
    }, [presets])



    // --- 关闭下拉 ---
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

    // --- 持久 PROTO_CALL_RESP 监听器（按 reqId 分发到对应卡片） ---
    useEffect(() => {
        listenersRef.current['PROTO_CALL_RESP'] = (msg) => {
            const reqId = msg.reqId
            if (!reqId) return
            const cardId = pendingRequestsRef.current[reqId]
            if (cardId == null) return
            delete pendingRequestsRef.current[reqId]
            setCards(prev => prev.map(c =>
                c.id === cardId ? {
                    ...c,
                    sending: false,
                    lastResponse: msg,
                    responses: [...c.responses.slice(-19), msg],
                } : c
            ))
        }
        return () => { delete listenersRef.current['PROTO_CALL_RESP'] }
    }, [])

    // --- 发送请求 ---
    const sendRequest = useCallback((cardId) => {
        const card = cards.find(c => c.id === cardId)
        if (!card || !selectedClient) return

        const { params, markTableFields, nilFields } = buildRequestParams(card.fieldStates)

        // 自动保存为"上次使用"预设
        const protoPresets = presets[card.protocol] || {}
        protoPresets._lastUsed = { name: '上次使用', fieldStates: { ...card.fieldStates } }
        const newPresets = { ...presets, [card.protocol]: protoPresets }
        setPresets(newPresets)
        savePresets(newPresets)

        setCards(prev => prev.map(c =>
            c.id === cardId ? { ...c, sending: true, currentPresetId: '_lastUsed' } : c
        ))

        // 30s 超时
        const timeoutId = setTimeout(() => {
            setCards(prev => prev.map(c =>
                c.id === cardId && c.sending ? { ...c, sending: false } : c
            ))
        }, 30000)

        fetch('/api/gm_console/proto/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: selectedClient.id,
                protocol: card.protocol,
                params,
                markTableFields,
                nilFields,
            })
        }).then(r => r.json()).then(data => {
            if (data.reqId) {
                pendingRequestsRef.current[data.reqId] = cardId
            }
        }).catch(e => {
            console.error('[Proto] 发送失败:', e)
            clearTimeout(timeoutId)
            setCards(prev => prev.map(c => c.id === cardId ? { ...c, sending: false } : c))
        })
    }, [cards, selectedClient, presets])

    const sendAll = useCallback(() => {
        if (!selectedClient || cards.length === 0) return
        for (const card of cards) {
            sendRequest(card.id)
        }
    }, [cards, selectedClient, sendRequest])

    const moveCard = useCallback((cardId, direction) => {
        setCards(prev => {
            const idx = prev.findIndex(c => c.id === cardId)
            if (idx < 0) return prev
            const targetIdx = idx + direction
            if (targetIdx < 0 || targetIdx >= prev.length) return prev
            const next = [...prev]
            ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
            return next
        })
    }, [])

    // --- 导入日志 ---
    const handleImportLog = useCallback(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.txt,.log'
        input.onchange = async (e) => {
            const file = e.target.files[0]
            if (!file) return
            setImportLoading(true)
            const formData = new FormData()
            formData.append('file', file)
            try {
                const resp = await fetch('/api/gm_console/proto/import-log', {
                    method: 'POST',
                    body: formData,
                })
                const data = await resp.json()
                if (data.error) {
                    showToast(data.error, 'error')
                } else {
                    setImportModal(data)
                }
            } catch (e) {
                showToast('导入失败: ' + e.message, 'error')
            } finally {
                setImportLoading(false)
            }
        }
        input.click()
    }, [])

    // --- 导入确认 ---
    const confirmImport = useCallback((entries, targets) => {
        const newPresets = { ...presets }
        const duplicates = [] // {protocol, existingPresetName}
        let cardCount = 0
        let presetCount = 0

        for (const [idxStr, target] of Object.entries(targets)) {
            const idx = parseInt(idxStr)
            const entry = entries[idx]
            if (!entry) continue
            if (!target.card && !target.preset) continue

            // 自动给非基本类型字段标记 MarkTable
            const fieldStates = { ...entry.fieldStates }
            for (const key of Object.keys(fieldStates)) {
                if (fieldStates[key].mode === 'table' && fieldStates[key].markTable === undefined) {
                    fieldStates[key].markTable = true
                }
            }

            // 卡片：直接创建，不去重
            if (target.card) {
                const id = `card_${++cardIdCounter.current}`
                if (hasHaruroot && protoLoaded) {
                    fetch(`/api/gm_console/proto/detail?name=${encodeURIComponent(entry.protocol)}`)
                        .then(r => r.json())
                        .then(detail => {
                            const card = {
                                id, protocol: entry.protocol, detail,
                                fieldStates: buildInitialFieldStates(detail.fields || [], fieldStates),
                                currentPresetId: null, responses: [], lastResponse: null,
                                collapsed: false, sending: false,
                            }
                            setCards(prev => [...prev, card])
                        })
                        .catch(() => {
                            const card = {
                                id, protocol: entry.protocol, detail: null,
                                fieldStates, currentPresetId: null,
                                responses: [], lastResponse: null,
                                collapsed: false, sending: false,
                            }
                            setCards(prev => [...prev, card])
                        })
                } else {
                    const card = {
                        id, protocol: entry.protocol, detail: null,
                        fieldStates, currentPresetId: null,
                        responses: [], lastResponse: null,
                        collapsed: false, sending: false,
                    }
                    setCards(prev => [...prev, card])
                }
                cardCount++
            }

            // 预设：内容去重
            if (target.preset) {
                const entryFsStr = JSON.stringify(fieldStates)
                const protoPresets = newPresets[entry.protocol] || {}
                let foundDup = null
                for (const [pId, pVal] of Object.entries(protoPresets)) {
                    if (JSON.stringify(pVal.fieldStates) === entryFsStr) {
                        foundDup = { id: pId, name: pVal.name }
                        break
                    }
                }

                if (foundDup) {
                    duplicates.push({ protocol: entry.protocol, existingPresetName: foundDup.name })
                } else {
                    // 生成预设名: 文件名_协议名_序号
                    const sameProtocolInFile = entries.filter((e, i) => i <= idx && e.protocol === entry.protocol)
                    const seqNum = sameProtocolInFile.length
                    let presetName = `${importModal.fileName}_${entry.protocol}`
                    if (seqNum > 1 || entries.filter(e => e.protocol === entry.protocol).length > 1) {
                        presetName += `_${seqNum}`
                    }
                    let finalName = presetName
                    let counter = 1
                    while (protoPresets[`import_${finalName}`]) {
                        finalName = `${presetName}_${counter++}`
                    }

                    protoPresets[`import_${finalName}`] = { name: finalName, fieldStates }
                    protoPresets._lastUsed = { name: '上次使用', fieldStates }
                    newPresets[entry.protocol] = protoPresets
                    presetCount++
                }
            }
        }

        setPresets(newPresets)
        savePresets(newPresets)
        setImportModal(null)

        // 汇总提示
        const tips = []
        if (cardCount > 0) tips.push(`${cardCount} 张卡片`)
        if (presetCount > 0) tips.push(`${presetCount} 个预设`)
        if (tips.length > 0) {
            showToast(`已导入: ${tips.join('、')}`, 'success')
        }
        if (duplicates.length > 0) {
            const dupTips = duplicates.map(d => `${d.protocol} 已有"${d.existingPresetName}"`).join('，')
            showToast(`跳过 ${duplicates.length} 条重复预设: ${dupTips}`, 'info')
        }
    }, [presets, importModal, showToast, hasHaruroot, protoLoaded])

    // --- 代码导入（粘贴 Lua 代码） ---
    const handlePasteImport = useCallback(() => {
        setCodeImportModal({ step: 'input', code: '' })
    }, [])

    const processCodeImport = useCallback((code) => {
        const result = parseLuaImportCode(code)
        if (result.error) {
            setCodeImportModal(prev => ({ ...prev, code, parseError: result.error }))
            return
        }
        // 校验
        const warnings = []
        if (hasHaruroot && protoLoaded) {
            const known = protocols.some(p => p.name === result.protocol)
            if (!known) {
                warnings.push(`协议 ${result.protocol} 不在已解析列表中`)
            }
        }
        setCodeImportModal({ step: 'confirm', ...result, warnings })
    }, [hasHaruroot, protoLoaded, protocols, showToast])

    const confirmCodeImport = useCallback((target, presetName) => {
        const { protocol, fieldStates, markTableFields } = codeImportModal
        // 确保 markTable 标记
        const fs = { ...fieldStates }
        for (const path of markTableFields) {
            if (fs[path]) fs[path].markTable = true
        }

        if (target === 'card' || target === 'both') {
            const id = `card_${++cardIdCounter.current}`
            // 尝试获取 detail（有 HaruRoot 时）
            if (hasHaruroot && protoLoaded) {
                fetch(`/api/gm_console/proto/detail?name=${encodeURIComponent(protocol)}`)
                    .then(r => r.json())
                    .then(detail => {
                        const card = {
                            id, protocol, detail,
                            fieldStates: buildInitialFieldStates(detail.fields || [], fs),
                            currentPresetId: null, responses: [], lastResponse: null,
                            collapsed: false, sending: false,
                        }
                        setCards(prev => [...prev, card])
                    })
                    .catch(() => {
                        // fallback: 手动模式卡片
                        const card = {
                            id, protocol, detail: null,
                            fieldStates: fs, currentPresetId: null,
                            responses: [], lastResponse: null,
                            collapsed: false, sending: false,
                        }
                        setCards(prev => [...prev, card])
                    })
            } else {
                const card = {
                    id, protocol, detail: null,
                    fieldStates: fs, currentPresetId: null,
                    responses: [], lastResponse: null,
                    collapsed: false, sending: false,
                }
                setCards(prev => [...prev, card])
            }
        }

        if (target === 'preset' || target === 'both') {
            const name = presetName || protocol
            const newPresets = { ...presets }
            const protoPresets = newPresets[protocol] || {}
            // 内容去重
            const fsStr = JSON.stringify(fs)
            let dupName = null
            for (const [, pVal] of Object.entries(protoPresets)) {
                if (JSON.stringify(pVal.fieldStates) === fsStr) { dupName = pVal.name; break }
            }
            if (dupName) {
                showToast(`${protocol} 已有相同内容的预设"${dupName}"，跳过保存`, 'info')
            } else {
                const id = `custom_${Date.now()}`
                protoPresets[id] = { name, fieldStates: fs }
                protoPresets._lastUsed = { name: '上次使用', fieldStates: fs }
                newPresets[protocol] = protoPresets
                setPresets(newPresets)
                savePresets(newPresets)
            }
        }

        setCodeImportModal(null)
    }, [codeImportModal, presets, hasHaruroot, protoLoaded])

    return (
        <div className="flex flex-col h-full" style={{ minHeight: '400px' }}>
            {/* Header */}
            <div className="p-3 border-b border-[var(--glass-border)]">
                <div className="flex items-center gap-2 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasHaruroot ? (protoLoaded ? 'bg-[var(--sage)]' : 'bg-[var(--caramel)]') : 'bg-[var(--terracotta)]'}`} />
                    <span className="text-sm font-semibold text-[var(--coffee-deep)]">Proto</span>
                    {hasHaruroot && protoLoaded && (
                        <span className="text-[10px] text-[var(--coffee-muted)]">已加载 {protoCount} 协议</span>
                    )}
                    {hasHaruroot && !protoLoaded && !loading && (
                        <span className="text-[10px] text-[var(--caramel)]">请点击解析按钮加载协议</span>
                    )}
                    {!hasHaruroot && (
                        <span className="text-[10px] text-[var(--terracotta)]">未配置 HaruRoot · 手动模式</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                        {cards.length > 1 && (
                            <button onClick={sendAll} disabled={!selectedClient}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-[var(--sage)]/15 text-[var(--sage)] hover:bg-[var(--sage)]/25 disabled:opacity-30 transition-colors" title="并行发送所有卡片">
                                <PlayCircle size={10} /> 全部发送
                            </button>
                        )}
                        {cards.length > 0 && (
                            <button onClick={() => setCards([])}
                                className="p-1 rounded hover:bg-[var(--terracotta)]/10 text-[var(--coffee-muted)] hover:text-[var(--terracotta)] transition-colors" title="清除所有卡片">
                                <Trash2 size={13} />
                            </button>
                        )}
                        <button onClick={handlePasteImport}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors" title="粘贴 Lua 代码导入">
                            <ClipboardPaste size={13} />
                        </button>
                        <button onClick={handleImportLog} disabled={importLoading}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] disabled:opacity-30 transition-colors" title="从日志导入预设">
                            {importLoading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                        </button>
                        {hasHaruroot && (
                            <button onClick={handleParse} disabled={loading}
                                className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] disabled:opacity-30 transition-colors" title="重新解析协议">
                                <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Search / Guide area */}
                {hasHaruroot && protoLoaded ? (
                    /* 完整模式：搜索下拉 */
                    <div className="relative">
                        <div className="flex items-center gap-1">
                            <div className="relative flex-1">
                                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                                <input ref={searchRef} type="text" value={searchQuery}
                                    onChange={e => { setSearchQuery(e.target.value); setShowDropdown(true) }}
                                    onFocus={() => setShowDropdown(true)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && filteredProtocols.length > 0) {
                                            addCard(filteredProtocols[0].name)
                                        }
                                    }}
                                    placeholder="搜索协议 (Enter添加第一个)"
                                    style={{ paddingLeft: '1.75rem' }}
                                    className="w-full pr-2 py-1 text-xs rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                                />
                            </div>
                        </div>
                        {showDropdown && filteredProtocols.length > 0 && (
                            <div ref={dropdownRef}
                                className="absolute z-20 top-full left-0 right-0 mt-1 rounded-md border border-[var(--glass-border)] bg-white/95 backdrop-blur-sm shadow-lg max-h-56 overflow-y-auto">
                                {filteredProtocols.map(p => (
                                    <button key={p.name}
                                        onClick={() => addCard(p.name)}
                                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--cream-warm)]/50 text-left">
                                        <span className="font-mono truncate text-[var(--coffee-deep)]">{p.name}</span>
                                        {p.route && (
                                            <span className="text-[10px] px-1 rounded bg-[var(--sage)]/10 text-[var(--sage)] flex-shrink-0">{p.route}</span>
                                        )}
                                        {p.comment && (
                                            <span className="text-[10px] text-[var(--coffee-muted)] truncate">{p.comment}</span>
                                        )}
                                    </button>
                                ))}
                                {protocols.length > 50 && !searchQuery && (
                                    <div className="px-3 py-1 text-[10px] text-[var(--coffee-muted)] text-center">
                                        显示前50条，输入关键字精确搜索
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    /* 降级模式：引导提示 */
                    <div className="rounded-lg border border-[var(--glass-border)]/60 bg-[var(--cream-warm)]/20 p-2.5">
                        <div className="flex items-start gap-2">
                            <FolderOpen size={14} className="text-[var(--caramel)] flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[10px] font-medium text-[var(--coffee-deep)] mb-0.5">配置 HaruRoot 以启用协议自动解析</div>
                                <div className="text-[9px] text-[var(--coffee-muted)] leading-relaxed">
                                    在右侧日志区下方填写项目根路径 (含 Dev/Client 和 Product/Lua)
                                    <br />未配置时可通过粘贴 Lua 代码或从日志导入来创建请求卡片
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Card list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {loading && !protoLoaded && (
                    <div className="flex items-center justify-center gap-1.5 py-8 text-[var(--coffee-muted)]">
                        <Loader2 size={14} className="animate-spin" /><span className="text-xs">加载中...</span>
                    </div>
                )}
                {!loading && cards.length === 0 && (
                    <div className="text-center text-[var(--coffee-muted)] text-xs py-8">
                        {hasHaruroot && protoLoaded ? '搜索并选择协议添加请求卡片' : '从日志导入或粘贴 Lua 代码来添加请求卡片'}
                    </div>
                )}
                {cards.map((card, cardIdx) => (
                    <ProtoCard key={card.id} card={card} clients={clients} selectedClient={selectedClient}
                        presets={presets[card.protocol] || {}}
                        isFirst={cardIdx === 0} isLast={cardIdx === cards.length - 1}
                        onMoveUp={() => moveCard(card.id, -1)}
                        onMoveDown={() => moveCard(card.id, 1)}
                        onRemove={() => setCards(prev => prev.filter(c => c.id !== card.id))}
                        onSend={() => sendRequest(card.id)}
                        onCopy={() => {
                            const { params, markTableFields, nilFields } = buildRequestParams(card.fieldStates)
                            const lua = generateLuaCode(card.protocol, params, markTableFields, nilFields)
                            navigator.clipboard.writeText(lua).then(
                                () => showToast('Lua 代码已复制到剪贴板', 'success'),
                                () => showToast('复制失败', 'error')
                            )
                        }}
                        onUpdateFieldStates={(fs) => setCards(prev => prev.map(c => c.id === card.id ? { ...c, fieldStates: fs } : c))}
                        onToggleCollapse={() => setCards(prev => prev.map(c => c.id === card.id ? { ...c, collapsed: !c.collapsed } : c))}
                        onLoadPreset={(presetId) => {
                            const p = presets[card.protocol]?.[presetId]
                            if (p?.fieldStates) {
                                setCards(prev => prev.map(c => c.id === card.id ? { ...c, fieldStates: { ...c.fieldStates, ...p.fieldStates }, currentPresetId: presetId } : c))
                            }
                        }}
                        onSavePreset={(name) => {
                            const newPresets = { ...presets }
                            const protoPresets = newPresets[card.protocol] || {}
                            const id = `custom_${Date.now()}`
                            protoPresets[id] = { name, fieldStates: { ...card.fieldStates } }
                            newPresets[card.protocol] = protoPresets
                            setPresets(newPresets)
                            savePresets(newPresets)
                        }}
                        onDeletePreset={(presetId) => {
                            const newPresets = { ...presets }
                            const protoPresets = newPresets[card.protocol] || {}
                            delete protoPresets[presetId]
                            newPresets[card.protocol] = protoPresets
                            setPresets(newPresets)
                            savePresets(newPresets)
                        }}
                    />
                ))}
            </div>

            {/* Import modal */}
            {importModal && (
                <ImportModal data={importModal} defaultTarget={lastImportTargetRef.current} onConfirm={(entries, targets) => { const anyPreset = Object.values(targets).some(t => t.preset); const anyCard = Object.values(targets).some(t => t.card); lastImportTargetRef.current = anyPreset && anyCard ? 'both' : anyPreset ? 'preset' : 'card'; confirmImport(entries, targets) }} onClose={() => setImportModal(null)} hasHaruroot={hasHaruroot} />
            )}

            {/* Code import modal */}
            {codeImportModal && (
                <ImportCodeModal data={codeImportModal}
                    defaultTarget={lastImportTargetRef.current}
                    onParse={processCodeImport}
                    onReset={() => setCodeImportModal({ step: 'input', code: '' })}
                    onConfirm={(target, presetName) => { lastImportTargetRef.current = target; confirmCodeImport(target, presetName) }}
                    onClose={() => setCodeImportModal(null)}
                />
            )}

            {/* Toast */}
            {toast && (
                <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg text-xs font-medium transition-all ${
                    toast.type === 'error' ? 'bg-[var(--terracotta)]/90 text-white' :
                    toast.type === 'success' ? 'bg-[var(--sage)]/90 text-white' :
                    'bg-[var(--coffee-deep)]/90 text-white'
                }`}>
                    {toast.type === 'error' && <AlertCircle size={14} />}
                    <span>{toast.message}</span>
                </div>
            )}
        </div>
    )
}


// ============================================================================
// Proto Card — 折叠卡片
// ============================================================================
function ProtoCard({ card, clients, selectedClient, presets, isFirst, isLast, onMoveUp, onMoveDown, onRemove, onSend, onUpdateFieldStates, onToggleCollapse, onLoadPreset, onSavePreset, onDeletePreset, onCopy }) {
    const [showSaveInput, setShowSaveInput] = useState(false)
    const [presetName, setPresetName] = useState('')
    const [showPresetDropdown, setShowPresetDropdown] = useState(false)
    const presetDropRef = useRef(null)
    const [sendCount, setSendCount] = useState(1)
    const [sendMode, setSendMode] = useState('independent') // 'independent' | 'waitcb'
    const [sendInterval, setSendInterval] = useState(100) // ms, only for independent mode
    const [batchProgress, setBatchProgress] = useState(null) // { current, total } | null
    const batchAbortRef = useRef(false)
    const waitCbResolveRef = useRef(null)

    // Detect response arrival: card.sending went from true→false
    const prevSendingRef = useRef(card.sending)
    useEffect(() => {
        if (prevSendingRef.current && !card.sending && waitCbResolveRef.current) {
            waitCbResolveRef.current()
            waitCbResolveRef.current = null
        }
        prevSendingRef.current = card.sending
    }, [card.sending])

    const waitForResponse = () => new Promise(resolve => { waitCbResolveRef.current = resolve })

    const handleSend = async () => {
        if (sendCount <= 1) { onSend(); return }
        if (sendMode === 'independent') {
            batchAbortRef.current = false
            setBatchProgress({ current: 0, total: sendCount })
            const runNext = (i) => {
                if (i >= sendCount || batchAbortRef.current) { setBatchProgress(null); return }
                setBatchProgress({ current: i + 1, total: sendCount })
                onSend()
                setTimeout(() => runNext(i + 1), sendInterval)
            }
            runNext(0)
        } else {
            batchAbortRef.current = false
            for (let i = 0; i < sendCount; i++) {
                if (batchAbortRef.current) break
                setBatchProgress({ current: i + 1, total: sendCount })
                onSend()
                await waitForResponse()
            }
            setBatchProgress(null)
        }
    }

    // 关闭预设下拉
    useEffect(() => {
        const handler = (e) => {
            if (presetDropRef.current && !presetDropRef.current.contains(e.target)) {
                setShowPresetDropdown(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [])

    const presetList = Object.entries(presets).filter(([id]) => id !== '_lastUsed')
    const currentPresetName = card.currentPresetId ? (presets[card.currentPresetId]?.name || '上次使用') : '无预设'

    return (
        <div className="rounded-lg border border-[var(--glass-border)] bg-white/30 overflow-hidden group">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--cream-warm)]/30 cursor-pointer" onClick={onToggleCollapse}>
                {card.collapsed ? <ChevronRight size={14} className="text-[var(--coffee-muted)]" /> : <ChevronDown size={14} className="text-[var(--coffee-muted)]" />}
                <span className="text-xs font-medium text-[var(--coffee-deep)] font-mono select-text" onClick={e => e.stopPropagation()}>{card.protocol}</span>
                {card.detail?.route && (
                    <span className="text-[10px] px-1 rounded bg-[var(--sage)]/10 text-[var(--sage)]">{card.detail.route}</span>
                )}
                {card.detail?.comment && (
                    <span className="text-[10px] text-[var(--coffee-muted)] truncate">{card.detail.comment}</span>
                )}
                {card.sending && <Loader2 size={12} className="animate-spin text-[var(--caramel)]" />}
                {card.lastResponse && (
                    <span className={`text-[10px] font-mono ${card.lastResponse.code === 0 ? 'text-[var(--sage)]' : 'text-[var(--terracotta)]'}`}>
                        Code:{card.lastResponse.code}
                    </span>
                )}
                <span className="ml-auto flex-shrink-0 flex items-center gap-0.5">
                    <span className="hidden group-hover:flex items-center gap-0.5">
                        {!isFirst && (
                            <button onClick={e => { e.stopPropagation(); onMoveUp() }}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]" title="上移"><ArrowUp size={12} /></button>
                        )}
                        {!isLast && (
                            <button onClick={e => { e.stopPropagation(); onMoveDown() }}
                                className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]" title="下移"><ArrowDown size={12} /></button>
                        )}
                    </span>
                    {card.collapsed && (
                        <button onClick={e => { e.stopPropagation(); handleSend() }}
                            disabled={card.sending || !selectedClient || batchProgress !== null}
                            className="p-0.5 rounded hover:bg-[var(--sage)]/15 text-[var(--coffee-muted)] hover:text-[var(--sage)] disabled:opacity-30"
                            title={sendCount > 1 ? `发送 x${sendCount} (${sendMode === 'independent' ? '独立发' : '等回调'})` : '发送请求'}><Send size={13} /></button>
                    )}
                    <button onClick={e => { e.stopPropagation(); onRemove() }}
                        className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={14} /></button>
                </span>
            </div>

            {!card.collapsed && (
                <div className="p-2 space-y-2">
                    {/* Preset selector */}
                    <div className="flex items-center gap-1 text-xs">
                        <div className="relative">
                            <button onClick={() => setShowPresetDropdown(!showPresetDropdown)}
                                className="flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--glass-border)] bg-white/50 text-[var(--coffee-deep)] hover:bg-[var(--cream-warm)]/30">
                                <Bookmark size={10} />
                                <span>{currentPresetName}</span>
                                <ChevronDown size={10} />
                            </button>
                            {showPresetDropdown && (
                                <div ref={presetDropRef}
                                    className="absolute z-10 top-full left-0 mt-1 w-64 rounded-md border border-[var(--glass-border)] bg-white/95 backdrop-blur-sm shadow-lg max-h-48 overflow-y-auto">
                                    {presets._lastUsed && (
                                        <button onClick={() => { onLoadPreset('_lastUsed'); setShowPresetDropdown(false) }}
                                            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-[var(--cream-warm)]/50 text-left">
                                            <span className="text-[var(--coffee-muted)]">🕐</span>
                                            <span className="text-[var(--coffee-deep)]">上次使用</span>
                                            <button onClick={e => { e.stopPropagation(); onDeletePreset('_lastUsed') }}
                                                className="ml-auto p-0.5 rounded hover:bg-[var(--terracotta)]/10 text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={10} /></button>
                                        </button>
                                    )}
                                    {presetList.map(([id, p]) => (
                                        <button key={id} onClick={() => { onLoadPreset(id); setShowPresetDropdown(false) }}
                                            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-[var(--cream-warm)]/50 text-left">
                                            <span className="text-[var(--coffee-muted)]">📌</span>
                                            <span className="text-[var(--coffee-deep)] truncate">{p.name}</span>
                                            <button onClick={e => { e.stopPropagation(); onDeletePreset(id) }}
                                                className="ml-auto p-0.5 rounded hover:bg-[var(--terracotta)]/10 text-[var(--coffee-muted)] hover:text-[var(--terracotta)]"><X size={10} /></button>
                                        </button>
                                    ))}
                                    {Object.keys(presets).length === 0 && (
                                        <div className="px-2 py-2 text-[10px] text-[var(--coffee-muted)] text-center">无预设</div>
                                    )}
                                </div>
                            )}
                        </div>

                        {showSaveInput ? (
                            <div className="flex items-center gap-1 flex-1">
                                <input type="text" value={presetName} autoFocus placeholder="预设名称"
                                    onChange={e => setPresetName(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && presetName.trim()) {
                                            onSavePreset(presetName.trim())
                                            setPresetName('')
                                            setShowSaveInput(false)
                                        }
                                        if (e.key === 'Escape') setShowSaveInput(false)
                                    }}
                                    className="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-[var(--glass-border)] bg-white/70 focus:outline-none focus:border-[var(--caramel)]"
                                />
                                <button onClick={() => { if (presetName.trim()) { onSavePreset(presetName.trim()); setPresetName(''); setShowSaveInput(false) } }}
                                    className="p-0.5 rounded hover:bg-[var(--sage)]/20 text-[var(--sage)]"><Check size={12} /></button>
                                <button onClick={() => setShowSaveInput(false)}
                                    className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]"><X size={12} /></button>
                            </div>
                        ) : (
                            <button onClick={() => setShowSaveInput(true)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors">
                                <Bookmark size={10} /> 存为预设
                            </button>
                        )}
                    </div>

                    {/* Fields */}
                    <div className="space-y-0">
                        <FieldForm
                            fields={card.detail?.fields || fieldStatesToFields(card.fieldStates)}
                            fieldStates={card.fieldStates} path=""
                            onChange={(path, state) => {
                                const newFs = { ...card.fieldStates, [path]: state }
                                onUpdateFieldStates(newFs)
                            }}
                            onRemoveField={(path) => {
                                const newFs = { ...card.fieldStates }
                                delete newFs[path]
                                onUpdateFieldStates(newFs)
                            }}
                            onTypeChange={!card.detail ? (path, newType) => {
                                const newFs = { ...card.fieldStates }
                                newFs[path] = { ...newFs[path], fieldType: newType }
                                if (newType === 'table' && newFs[path].mode === 'value') {
                                    newFs[path] = { ...newFs[path], mode: 'table', markTable: true }
                                } else if (newType !== 'table' && newFs[path].mode === 'table') {
                                    const hasChildren = Object.keys(newFs).some(k =>
                                        k.startsWith(path + '.') || k.startsWith(path + '[')
                                    )
                                    if (!hasChildren) newFs[path] = { ...newFs[path], mode: 'nil' }
                                }
                                onUpdateFieldStates(newFs)
                            } : undefined}
                            onAddField={(parentPath, name, fieldType, directPath, directType) => {
                                if (directPath) {
                                    const isTable = directType === 'table'
                                    const newFs = {
                                        ...card.fieldStates,
                                        [directPath]: {
                                            mode: isTable ? 'table' : 'nil',
                                            markTable: isTable,
                                            ...(isTable ? {} : { fieldType: directType }),
                                        },
                                    }
                                    onUpdateFieldStates(newFs)
                                } else if (!card.detail) {
                                    const childPath = parentPath ? `${parentPath}.${name}` : name
                                    const isTable = fieldType === 'table'
                                    const newFs = {
                                        ...card.fieldStates,
                                        [childPath]: {
                                            mode: isTable ? 'table' : 'nil',
                                            markTable: isTable,
                                            ...(isTable ? {} : { fieldType }),
                                        },
                                    }
                                    onUpdateFieldStates(newFs)
                                }
                            }}
                        />
                    </div>
                    {/* 添加字段按钮 — 仅降级模式（顶层） */}
                    {!card.detail && (
                        <AddFieldButton onAdd={(name, fieldType) => {
                            const isTable = fieldType === 'table'
                            const newFs = {
                                ...card.fieldStates,
                                [name]: {
                                    mode: isTable ? 'table' : 'nil',
                                    markTable: isTable,
                                    ...(isTable ? {} : { fieldType }),
                                },
                            }
                            onUpdateFieldStates(newFs)
                        }} existingKeys={new Set(Object.keys(card.fieldStates).filter(k => !k.includes('.') && !k.includes('[')))} />
                    )}

                    {/* Send + Copy buttons */}
                    <div className="space-y-1 pt-1 border-t border-[var(--glass-border)]/50">
                        <div className="flex items-center gap-2">
                            <button onClick={handleSend}
                                disabled={card.sending || !selectedClient || batchProgress !== null}
                                className="flex items-center gap-1 px-3 py-1 rounded text-xs bg-[var(--sage)]/20 text-[var(--sage)] hover:bg-[var(--sage)]/30 disabled:opacity-30 transition-colors">
                                <Send size={11} /> {batchProgress ? `${batchProgress.current}/${batchProgress.total}` : card.sending ? '发送中...' : sendCount > 1 ? `发送 x${sendCount}` : '发送请求'}
                            </button>
                            {batchProgress && (
                                <button onClick={() => { batchAbortRef.current = true }}
                                    className="px-2 py-1 rounded text-xs text-[var(--terracotta)] hover:bg-[var(--terracotta)]/10 transition-colors">
                                    停止
                                </button>
                            )}
                            {/* Send count stepper */}
                            <div className="flex items-center border border-[var(--glass-border)]/60 rounded h-[20px]">
                                <button onClick={() => setSendCount(c => Math.max(1, c - 1))}
                                    className="px-1 text-[10px] text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)] rounded-l h-full">&minus;</button>
                                <input type="number" value={sendCount} min={1} max={999}
                                    onChange={e => { const v = parseInt(e.target.value); if (v >= 1 && v <= 999) setSendCount(v) }}
                                    className="w-[32px] text-center text-[10px] font-mono h-full border-x border-[var(--glass-border)]/60 bg-transparent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                                />
                                <button onClick={() => setSendCount(c => Math.min(999, c + 1))}
                                    className="px-1 text-[10px] text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)] rounded-r h-full">+</button>
                            </div>
                            <button onClick={onCopy}
                                className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors">
                                <Copy size={11} /> 复制Lua
                            </button>
                            {!selectedClient && (
                                <span className="text-[10px] text-[var(--terracotta)]">请先连接客户端</span>
                            )}
                        </div>
                        {/* Batch settings — only show when count > 1 */}
                        {sendCount > 1 && (
                            <div className="flex items-center gap-2 pl-1 whitespace-nowrap">
                                <div className="flex items-center border border-[var(--glass-border)]/60 rounded h-[18px] text-[10px]">
                                    <button onClick={() => setSendMode('independent')}
                                        className={`px-1.5 h-full rounded-l transition-colors ${sendMode === 'independent' ? 'bg-[var(--sage)]/15 text-[var(--sage)] font-semibold' : 'text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
                                        独立发
                                    </button>
                                    <button onClick={() => setSendMode('waitcb')}
                                        className={`px-1.5 h-full rounded-r border-l border-[var(--glass-border)]/60 transition-colors ${sendMode === 'waitcb' ? 'bg-[var(--sage)]/15 text-[var(--sage)] font-semibold' : 'text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
                                        等回调
                                    </button>
                                </div>
                                {sendMode === 'independent' && (
                                    <div className="flex items-center gap-1 text-[10px] text-[var(--coffee-muted)] whitespace-nowrap">
                                        <span>间隔</span>
                                        <input type="number" value={sendInterval} min={0} max={60000}
                                            onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0) setSendInterval(v) }}
                                            className="w-[48px] px-1 h-[18px] text-[10px] font-mono rounded border border-[var(--glass-border)]/60 bg-transparent focus:outline-none text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                                        />
                                        <span>ms</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Response */}
                    {card.lastResponse && (
                        <div className="mt-1">
                            <div className="text-[10px] font-semibold text-[var(--coffee-muted)] mb-0.5">响应:</div>
                            <div className="rounded border border-[var(--glass-border)] bg-[var(--coffee-deep)]/5 p-2 max-h-40 overflow-auto">
                                <div className={`text-xs font-mono ${card.lastResponse.code === 0 ? 'text-[var(--sage)]' : 'text-[var(--terracotta)]'}`}>
                                    Code: {card.lastResponse.code}{card.lastResponse.code === 0 ? ' (Success)' : ''}
                                </div>
                                <pre className="text-[10px] font-mono text-[var(--coffee-deep)] mt-1 whitespace-pre-wrap break-all">
                                    {formatResponse(card.lastResponse.data)}
                                </pre>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}


// ============================================================================
// TypeLabel — 可点击切换类型的类型标签（降级模式）
// ============================================================================
function TypeLabel({ type, onChange }) {
    const [showMenu, setShowMenu] = useState(false)
    const menuRef = useRef(null)

    useEffect(() => {
        if (!showMenu) return
        const handler = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showMenu])

    const displayType = type.length > 15 ? type.slice(0, 12) + '...' : type

    return (
        <div className="relative flex-shrink-0" ref={menuRef}>
            <button onClick={() => setShowMenu(!showMenu)}
                className="text-[9px] text-[var(--coffee-muted)] opacity-60 hover:opacity-100 hover:bg-[var(--cream-warm)]/50 px-0.5 rounded"
                title={`${type} — 点击切换类型`}>
                {displayType}
            </button>
            {showMenu && (
                <div className="absolute z-20 top-full left-0 mt-0.5 bg-white/95 border border-[var(--glass-border)] rounded shadow-sm py-0.5 flex flex-col min-w-[56px]">
                    {['string', 'int', 'bool', 'table'].map(t => (
                        <button key={t} onClick={() => { onChange(t); setShowMenu(false) }}
                            className={`px-2 py-0.5 text-[9px] text-left hover:bg-[var(--cream-warm)]/50 ${type === t ? 'text-[var(--sage)] font-semibold' : 'text-[var(--coffee-deep)]'}`}>
                            {t}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

// ============================================================================
// AddFieldInline — table 标题栏上的小 + 按钮（弹窗添加命名字段）
// ============================================================================
function AddFieldInline({ onAdd, existingKeys }) {
    const [showModal, setShowModal] = useState(false)
    return (
        <>
            <button onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
                className="flex items-center justify-center w-4 h-4 rounded text-[var(--coffee-muted)] hover:bg-[var(--sage)]/15 hover:text-[var(--sage)] transition-colors"
                title="添加字段">
                <Plus size={10} />
            </button>
            {showModal && (
                <AddFieldModal existingKeys={existingKeys} onAdd={(name, fieldType) => { onAdd(name, fieldType); setShowModal(false) }} onClose={() => setShowModal(false)} />
            )}
        </>
    )
}

// ============================================================================
// AddFieldButton — 降级模式卡片底部的添加字段按钮
// ============================================================================
function AddFieldButton({ onAdd, existingKeys }) {
    const [showModal, setShowModal] = useState(false)

    const handleAdd = (name, fieldType) => {
        onAdd(name, fieldType)
        setShowModal(false)
    }

    return (
        <>
            <button onClick={() => setShowModal(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]/50 hover:text-[var(--coffee-deep)] transition-colors mt-0.5">
                <Plus size={9} /> 添加字段
            </button>
            {showModal && (
                <AddFieldModal existingKeys={existingKeys} onAdd={handleAdd} onClose={() => setShowModal(false)} />
            )}
        </>
    )
}

function AddFieldModal({ existingKeys, onAdd, onClose }) {
    const [name, setName] = useState('')
    const [fieldType, setFieldType] = useState('string')

    const handleAdd = () => {
        if (!name.trim() || existingKeys.has(name.trim())) return
        onAdd(name.trim(), fieldType)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="glass-card p-4 w-[300px]" style={{ animation: 'slideUp 0.15s ease' }}>
                <div className="text-xs font-semibold text-[var(--coffee-deep)] mb-3">添加字段</div>
                <div className="space-y-2">
                    <div>
                        <label className="text-[10px] text-[var(--coffee-muted)] mb-0.5 block">字段名</label>
                        <input type="text" value={name} autoFocus
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) handleAdd() }}
                            placeholder="如 TeamName"
                            className="w-full px-2 py-1 text-xs font-mono rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-[var(--coffee-muted)] mb-0.5 block">字段类型</label>
                        <div className="flex gap-2">
                            {['string', 'int', 'bool', 'table'].map(t => (
                                <button key={t} onClick={() => setFieldType(t)}
                                    className={`px-2 py-1 rounded text-[10px] ${fieldType === t ? 'bg-[var(--sage)]/20 text-[var(--sage)] font-semibold' : 'text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]/50 border border-[var(--glass-border)]/40'}`}>
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                    {existingKeys.has(name.trim()) && (
                        <div className="text-[10px] text-[var(--terracotta)]">该字段名已存在</div>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-[var(--glass-border)]">
                    <button onClick={onClose} className="px-2 py-1 rounded text-xs text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]">取消</button>
                    <button onClick={handleAdd}
                        disabled={!name.trim() || existingKeys.has(name.trim())}
                        className="ml-auto px-3 py-1 rounded text-xs bg-[var(--sage)]/20 text-[var(--sage)] hover:bg-[var(--sage)]/30 disabled:opacity-30">
                        添加
                    </button>
                </div>
            </div>
        </div>
    )
}

/** 从 fieldStates 推断 fields 结构，供降级模式 FieldForm 使用 */
function fieldStatesToFields(fieldStates) {
    const allKeys = Object.keys(fieldStates)
    // 顶层 key：不含 . 和 [ 的，或者是 Key[N] 形式的数组元素（其父 Key 不在 fieldStates 中）
    const topKeys = []
    const arrayPattern = /^(\w+)\[\d+\]$/
    const parentHasState = new Set()

    // 先收集所有有自己 state 的 key
    for (const k of allKeys) {
        if (!k.includes('.') && !k.includes('[')) {
            parentHasState.add(k)
        }
        const m = k.match(arrayPattern)
        if (m) parentHasState.add(m[1])
    }

    for (const k of allKeys) {
        if (!k.includes('.') && !k.includes('[')) {
            topKeys.push(k)
        } else {
            const m = k.match(arrayPattern)
            if (m && !parentHasState.has(k)) {
                // 数组元素，但其父不在 topKeys（如 EquipData[0] 但没有 EquipData 条目）
                // 需要添加父级
                if (!topKeys.includes(m[1])) topKeys.push(m[1])
            }
        }
    }

    return topKeys.map(key => buildFieldFromState(key, fieldStates))
}

function buildFieldFromState(key, fieldStates, displayName) {
    const state = fieldStates[key]
    const directChildren = getDirectChildren(key, fieldStates)
    const hasChildren = directChildren.length > 0
    // 有子元素一定是 table；或者 state 标记了 table
    const isTable = hasChildren || state?.mode === 'table' || guessFieldType(fieldStates, key) === 'table'

    // 数组索引子元素：显示 [N] 而非 ParentKey[N]
    const getChildDisplayName = (childKey) => {
        const arrMatch = childKey.match(/\[(\d+)\]$/)
        if (arrMatch) return `[${arrMatch[1]}]`
        // 普通子字段：取最后一段
        const lastDot = childKey.lastIndexOf('.')
        return lastDot >= 0 ? childKey.slice(lastDot + 1) : childKey
    }

    if (isTable && hasChildren) {
        return {
            name: displayName || key,
            type: state?.fieldType || 'table',
            isPrimitive: false,
            subFields: directChildren.map(ck => buildFieldFromState(ck, fieldStates, getChildDisplayName(ck))),
        }
    }

    if (isTable) {
        return {
            name: displayName || key,
            type: state?.fieldType || 'table',
            isPrimitive: false,
            genericInfo: { container: 'list' },
        }
    }

    const ft = state?.fieldType || guessFieldType(fieldStates, key)
    return {
        name: displayName || key,
        type: ft,
        isPrimitive: true,
    }
}

/** 获取某个 key 的直接子字段 key */
function getDirectChildren(parentKey, fieldStates) {
    const prefix1 = parentKey + '.'
    const prefix2 = parentKey + '['
    return Object.keys(fieldStates).filter(k => {
        if (!k.startsWith(prefix1) && !k.startsWith(prefix2)) return false
        const parentDepth = (parentKey.match(/[.\[]/g) || []).length
        const childDepth = (k.match(/[.\[]/g) || []).length
        return childDepth === parentDepth + 1
    })
}

/** 从 fieldStates 推断字段类型 */
function guessFieldType(fieldStates, key) {
    const state = fieldStates[key]
    if (state?.fieldType) return state.fieldType
    if (state?.mode === 'table') return 'table'
    const val = state?.value
    if (typeof val === 'number') return Number.isInteger(val) ? 'int' : 'number'
    if (typeof val === 'boolean') return 'bool'
    return 'string'
}


// ============================================================================
// Field Form — 递归字段表单（Grid 对齐布局）
// ============================================================================
function FieldForm({ fields, fieldStates, path, onChange, onRemoveField, onTypeChange, onAddField, depth = 0 }) {
    return (
        <div>
            {fields.map((field, idx) => {
                const fullPath = path ? (field.name.startsWith('[') ? `${path}${field.name}` : `${path}.${field.name}`) : field.name
                const state = fieldStates[fullPath] || { mode: 'nil', markTable: true }
                const isPrimitive = field.isPrimitive
                const isGenericList = field.genericInfo?.container === 'list'
                const isGenericDict = field.genericInfo?.container === 'dict'
                const isNonPrimitive = !isPrimitive || isGenericList || isGenericDict

                // For generic containers without subFields, dynamically infer from fieldStates
                const dynamicSubFields = isNonPrimitive
                    ? getDirectChildren(fullPath, fieldStates).map(ck => {
                        const arrMatch = ck.match(/\[(\d+)\]$/)
                        const dn = arrMatch ? `[${arrMatch[1]}]` : ck.slice(ck.lastIndexOf('.') + 1)
                        return buildFieldFromState(ck, fieldStates, dn)
                    })
                    : null
                const mergedSubFields = (() => {
                    const proto = field.subFields?.length > 0 ? field.subFields : []
                    const dynamic = dynamicSubFields || []
                    if (!proto.length) return dynamic.length ? dynamic : null
                    if (!dynamic.length) return proto
                    const protoNames = new Set(proto.map(f => f.name))
                    const extra = dynamic.filter(f => !protoNames.has(f.name))
                    return extra.length ? [...proto, ...extra] : proto
                })()
                const effectiveSubFields = mergedSubFields
                const hasSubFields = effectiveSubFields && effectiveSubFields.length > 0
                const isArrayIndex = /^\[\d+\]$/.test(field.name)
                const isExpanded = isNonPrimitive && state.mode === 'table'
                const isArrayParent = isGenericList || (hasSubFields && effectiveSubFields.every(f => /^\[\d+\]$/.test(f.name)))

                return (
                    <div key={field.name + idx}>
                        <div className="flex items-center h-[22px] text-xs gap-1"
                            style={{ paddingLeft: `${depth * 14 + 4}px` }}>
                            {/* Expand arrow + field name */}
                            <div className="flex items-center gap-0.5 min-w-0 flex-shrink-0">
                                {isNonPrimitive ? (
                                    <button onClick={() => onChange(fullPath, { ...state, mode: isExpanded ? 'nil' : 'table', markTable: state.markTable !== false })}
                                        className="flex-shrink-0 w-3 h-3 flex items-center justify-center text-[var(--coffee-muted)]">
                                        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                    </button>
                                ) : (
                                    <span className="w-3 flex-shrink-0" />
                                )}
                                <span className={`font-mono text-[var(--coffee-deep)] text-[10px] truncate ${isArrayIndex ? 'opacity-60' : ''}`} title={fullPath}>
                                    {field.name}
                                </span>
                            </div>

                            {/* Type badge */}
                            {onTypeChange ? (
                                <TypeLabel type={field.type} onChange={(newType) => onTypeChange(fullPath, newType)} />
                            ) : (
                                <span className="text-[9px] text-[var(--coffee-muted)] opacity-50 rounded bg-black/[0.03] px-0.5 flex-shrink-0" title={field.type}>
                                    {field.type.length > 6 ? field.type.slice(0, 5) + '..' : field.type}
                                </span>
                            )}

                            {/* Value / controls */}
                            <div className="min-w-0 flex-1 flex items-center">
                                {isPrimitive && !isGenericList && !isGenericDict && (
                                    <input type={getInputType(field.type)} value={state.mode === 'nil' ? '' : (state.value ?? '')}
                                        onChange={e => {
                                            const val = e.target.value
                                            onChange(fullPath, { ...state, mode: val === '' ? 'nil' : 'value', value: parseInputValue(val, field.type) })
                                        }}
                                        placeholder={field.type}
                                        className={`w-full px-1 text-[10px] font-mono h-[16px] rounded border bg-white/50 focus:outline-none focus:border-[var(--caramel)] leading-[14px] ${state.mode === 'nil' ? 'border-[var(--glass-border)]/40 opacity-40' : 'border-[var(--glass-border)]'}`}
                                    />
                                )}
                                {isNonPrimitive && !isExpanded && (
                                    <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 italic">nil</span>
                                )}
                                {isNonPrimitive && isExpanded && (
                                    <span className="text-[9px] text-[var(--coffee-muted)] opacity-40">
                                        {hasSubFields ? '{' + effectiveSubFields.length + '}' : '{empty}'}
                                    </span>
                                )}
                            </div>

                            {/* Trailing controls: + button for arrays, Mark, etc. */}
                            <div className="flex items-center gap-1 flex-shrink-0">
                                {isNonPrimitive && isExpanded && isArrayParent && onAddField && (
                                    <button onClick={() => {
                                        const subs = effectiveSubFields || []
                                        const maxIdx = subs.reduce((max, f) => {
                                            const m = f.name.match(/^\[(\d+)\]$/)
                                            return m ? Math.max(max, parseInt(m[1])) : max
                                        }, -1)
                                        const nextName = `[${maxIdx + 1}]`
                                        const firstChild = subs[0]
                                        const elType = field.genericInfo?.elementType
                                        const elIsPrimitive = field.genericInfo?.isPrimitive
                                        const childType = firstChild
                                            ? (firstChild.isPrimitive ? (firstChild.type || 'string') : 'table')
                                            : (elIsPrimitive ? (elType || 'string') : 'table')
                                        const childPath = `${fullPath}${nextName}`
                                        const isTable = childType === 'table'
                                        onAddField(null, null, null, childPath, isTable ? 'table' : childType)
                                    }}
                                        className="flex items-center justify-center w-4 h-4 rounded text-[var(--coffee-muted)] hover:bg-[var(--sage)]/15 hover:text-[var(--sage)] transition-colors"
                                        title="添加数组元素">
                                        <Plus size={10} />
                                    </button>
                                )}
                                {isNonPrimitive && isExpanded && !isArrayParent && onAddField && onTypeChange && (
                                    <AddFieldInline onAdd={(name, fieldType) => onAddField(fullPath, name, fieldType)}
                                        existingKeys={new Set(hasSubFields ? effectiveSubFields.map(f => f.name) : [])} />
                                )}
                                {isNonPrimitive && isExpanded && (
                                    <button onClick={() => onChange(fullPath, { ...state, markTable: state.markTable === false })}
                                        className={`text-[9px] font-mono px-1 h-4 rounded transition-colors ${state.markTable !== false ? 'bg-[var(--sage)]/15 text-[var(--sage)]' : 'text-[var(--coffee-muted)] opacity-40 hover:opacity-70'}`}
                                        title={`MarkAsTable: ${state.markTable !== false ? 'ON' : 'OFF'}`}>
                                        M
                                    </button>
                                )}
                                {field.typeComment && !isNonPrimitive && (
                                    <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 truncate" title={field.typeComment}>
                                        {field.typeComment}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Sub-fields (expanded) */}
                        {isExpanded && hasSubFields && (
                            <div className="border-l border-[var(--glass-border)]/30" style={{ marginLeft: `${depth * 14 + 10}px` }}>
                                <FieldForm fields={effectiveSubFields} fieldStates={fieldStates} path={fullPath}
                                    onChange={onChange} onRemoveField={onRemoveField} onTypeChange={onTypeChange}
                                    onAddField={onAddField} depth={depth + 1}
                                />
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}


// ============================================================================
// Import Modal — 日志导入弹窗
// ============================================================================
function ImportModal({ data, defaultTarget, onConfirm, onClose, hasHaruroot }) {
    // importTargets[idx] = { card: bool, preset: bool }
    const [targets, setTargets] = useState(() => {
        const init = {}
        const defaultCard = defaultTarget !== 'preset'
        const defaultPreset = defaultTarget === 'preset' || defaultTarget === 'both'
        data.entries.forEach((_, i) => {
            init[i] = { card: defaultCard, preset: defaultPreset }
        })
        return init
    })
    const [expandedIdx, setExpandedIdx] = useState(new Set())

    const selectedCount = Object.values(targets).filter(t => t.card || t.preset).length
    const cardCount = Object.values(targets).filter(t => t.card).length
    const presetCount = Object.values(targets).filter(t => t.preset).length
    const allCard = data.entries.length > 0 && cardCount === data.entries.length
    const allPreset = data.entries.length > 0 && presetCount === data.entries.length

    const toggleAllCard = () => {
        const next = {}
        data.entries.forEach((_, i) => { next[i] = { ...targets[i], card: !allCard } })
        setTargets(next)
    }

    const toggleAllPreset = () => {
        const next = {}
        data.entries.forEach((_, i) => { next[i] = { ...targets[i], preset: !allPreset } })
        setTargets(next)
    }

    const toggleTarget = (idx, key) => {
        setTargets(prev => ({
            ...prev,
            [idx]: { ...prev[idx], [key]: !prev[idx][key] }
        }))
    }

    const toggleExpand = (idx) => {
        const next = new Set(expandedIdx)
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
        setExpandedIdx(next)
    }

    const handleConfirm = () => {
        onConfirm(data.entries, targets)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="glass-card p-5 w-[720px] max-h-[80vh] flex flex-col" style={{ animation: 'slideUp 0.2s ease' }}>
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--amber)] flex items-center justify-center">
                        <FileText size={16} className="text-white" />
                    </div>
                    <div>
                        <h3 className="font-display text-sm font-semibold text-[var(--coffee-deep)]">从日志导入</h3>
                        <p className="text-[10px] text-[var(--coffee-muted)]">
                            {data.fileName} — 提取到 {data.entries.length} 条请求记录 (Send_Call={data.sendCallCount}, Recv_Call={data.recvCallCount})
                        </p>
                    </div>
                    <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]"><X size={16} /></button>
                </div>

                {/* Column headers — 与行内 checkbox 对齐 */}
                <div className="flex items-center gap-2 mb-2 px-2 text-[10px]">
                    <button onClick={toggleAllCard}
                        className={`w-[52px] py-0.5 rounded text-center flex items-center justify-center gap-1 transition-colors ${allCard ? 'bg-[var(--sage)]/20 text-[var(--sage)] font-semibold' : 'text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
                        <Send size={9} /> 卡片
                    </button>
                    <button onClick={toggleAllPreset}
                        className={`w-[52px] py-0.5 rounded text-center flex items-center justify-center gap-1 transition-colors ${allPreset ? 'bg-[var(--caramel)]/20 text-[var(--caramel)] font-semibold' : 'text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
                        <Bookmark size={9} /> 预设
                    </button>
                    <span className="text-[var(--coffee-muted)] opacity-40">点击切换全选</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                    {data.entries.map((entry, idx) => {
                        const isExpanded = expandedIdx.has(idx)
                        const t = targets[idx] || { card: false, preset: false }
                        const fs = entry.fieldStates || {}
                        const fsKeys = Object.keys(fs)
                        const displayKeys = fsKeys.slice(0, 30)
                        const truncated = fsKeys.length > 30
                        const anySelected = t.card || t.preset

                        return (
                            <div key={idx}>
                                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${anySelected ? 'bg-[var(--caramel)]/10' : 'hover:bg-[var(--cream-warm)]/30'}`}>
                                    {/* Card checkbox — 宽度与列头「卡片」按钮对齐 */}
                                    <span onClick={() => toggleTarget(idx, 'card')}
                                        className={`w-[52px] flex items-center justify-center gap-1 cursor-pointer rounded py-0.5 transition-colors ${t.card ? 'bg-[var(--sage)]/20' : 'hover:bg-[var(--cream-warm)]/30'}`}
                                        title="添加为卡片">
                                        <span className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center ${t.card ? 'bg-[var(--sage)] border-[var(--sage)]' : 'border-[var(--glass-border)]'}`}>
                                            {t.card && <Check size={8} className="text-white" />}
                                        </span>
                                    </span>
                                    {/* Preset checkbox — 宽度与列头「预设」按钮对齐 */}
                                    <span onClick={() => toggleTarget(idx, 'preset')}
                                        className={`w-[52px] flex items-center justify-center gap-1 cursor-pointer rounded py-0.5 transition-colors ${t.preset ? 'bg-[var(--caramel)]/20' : 'hover:bg-[var(--cream-warm)]/30'}`}
                                        title="存为预设">
                                        <span className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center ${t.preset ? 'bg-[var(--caramel)] border-[var(--caramel)]' : 'border-[var(--glass-border)]'}`}>
                                            {t.preset && <Check size={8} className="text-white" />}
                                        </span>
                                    </span>
                                    {/* Row body — click to expand */}
                                    <button onClick={() => toggleExpand(idx)} className="flex items-center gap-2 flex-1 text-left min-w-0">
                                        {isExpanded
                                            ? <ChevronDown size={10} className="text-[var(--coffee-muted)] flex-shrink-0" />
                                            : <ChevronRight size={10} className="text-[var(--coffee-muted)] flex-shrink-0" />}
                                        <span className="text-[10px] text-[var(--coffee-muted)] w-6">#{entry.index}</span>
                                        <span className="font-mono text-[var(--coffee-deep)] truncate">{entry.protocol}</span>
                                        {!entry.known && <AlertCircle size={10} className="text-[var(--caramel)] flex-shrink-0" title="未知协议" />}
                                        <span className="text-[10px] text-[var(--coffee-muted)] truncate">{entry.contentPreview}</span>
                                        <span className="text-[9px] text-[var(--coffee-muted)] opacity-40 flex-shrink-0">{entry.timestamp}</span>
                                        {entry.parseError && <span className="text-[9px] text-[var(--terracotta)] flex-shrink-0">⚠解析失败</span>}
                                    </button>
                                </div>
                                {/* Expanded preview */}
                                {isExpanded && (
                                    <div className="ml-5 mr-2 mb-1 rounded border border-[var(--glass-border)]/50 bg-white/30 p-2 max-h-48 overflow-y-auto">
                                        {fsKeys.length === 0 ? (
                                            <span className="text-[10px] text-[var(--coffee-muted)] italic">
                                                {entry.contentPreview === 'nil' ? 'nil (无参数)' : entry.parseError ? '解析失败，无法预览' : '空'}
                                            </span>
                                        ) : (
                                            <>
                                                {truncated && (
                                                    <div className="text-[9px] text-[var(--caramel)] mb-1">共 {fsKeys.length} 个字段，仅显示前 30</div>
                                                )}
                                                {displayKeys.map(key => {
                                                    const s = fs[key]
                                                    const depth = (key.match(/[.\[]/g) || []).length
                                                    const indent = depth * 12
                                                    const isNil = s.mode === 'nil'
                                                    const isTable = s.mode === 'table'
                                                    return (
                                                        <div key={key} className="flex items-baseline gap-1.5 text-[10px] font-mono" style={{ paddingLeft: indent }}>
                                                            <span className="text-[var(--coffee-deep)] truncate" title={key}>{key.split(/[.\[]/).pop()}</span>
                                                            <span className="text-[var(--coffee-muted)] opacity-40">=</span>
                                                            {isNil ? (
                                                                <span className="text-[var(--coffee-muted)] italic">nil</span>
                                                            ) : isTable ? (
                                                                <span className="text-[var(--sage)]">{'{}'}</span>
                                                            ) : (
                                                                <span className="text-[var(--coffee-deep)] truncate" title={String(s.value)}>{JSON.stringify(s.value)}</span>
                                                            )}
                                                            {s.markTable && !isNil && (
                                                                <span className="text-[8px] px-0.5 rounded bg-[var(--sage)]/10 text-[var(--sage)]">Mark</span>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>

                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--glass-border)]">
                    <div className="ml-auto flex items-center gap-2">
                        <button onClick={onClose} className="px-3 py-1 rounded text-xs text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]">取消</button>
                        <button onClick={handleConfirm}
                            disabled={cardCount === 0 && presetCount === 0}
                            className="px-3 py-1 rounded text-xs bg-[var(--sage)]/20 text-[var(--sage)] hover:bg-[var(--sage)]/30 disabled:opacity-30">
                            {cardCount > 0 && presetCount > 0 ? `导入 ${cardCount} 张卡片 / ${presetCount} 个预设`
                                : cardCount > 0 ? `导入 ${cardCount} 张卡片`
                                : presetCount > 0 ? `导入 ${presetCount} 个预设`
                                : '请选择'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}


// ============================================================================
// Import Code Modal — 粘贴 Lua 代码导入
// ============================================================================
function ImportCodeModal({ data, defaultTarget, onParse, onReset, onConfirm, onClose }) {
    const [code, setCode] = useState(data.code || '')
    const [presetName, setPresetName] = useState('')
    const [importTarget, setImportTarget] = useState(defaultTarget || 'card')

    const isStep1 = data.step === 'input'
    const isStep2 = data.step === 'confirm'

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="glass-card p-5 w-[600px] max-h-[80vh] flex flex-col" style={{ animation: 'slideUp 0.2s ease' }}>
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--sage)] to-[var(--caramel)] flex items-center justify-center">
                        <ClipboardPaste size={16} className="text-white" />
                    </div>
                    <div>
                        <h3 className="font-display text-sm font-semibold text-[var(--coffee-deep)]">粘贴 Lua 代码导入</h3>
                        <p className="text-[10px] text-[var(--coffee-muted)]">
                            {isStep1 ? '粘贴包含 XNetwork.Call 的 Lua 代码' : `解析成功: ${data.protocol}`}
                        </p>
                    </div>
                    <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)]"><X size={16} /></button>
                </div>

                {isStep1 && (
                    <>
                        <textarea value={code} onChange={e => setCode(e.target.value)}
                            placeholder={`粘贴 Lua 代码，例如:\ndo\n    local _request = {\n        ["Uin"] = 10001,\n        ["Name"] = "test"\n    }\n    XNetwork.Call("LoginRequest", _request, function(response)\n        ...\n    end)\nend`}
                            className="flex-1 min-h-[200px] p-3 text-[11px] font-mono rounded-lg border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)] resize-none"
                        />
                        {data.parseError && (
                            <div className="flex items-center gap-1.5 mt-2 px-2 py-1.5 rounded-lg bg-[var(--terracotta)]/10 text-[var(--terracotta)] text-[10px]">
                                <AlertCircle size={12} className="flex-shrink-0" />
                                <span>{data.parseError}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--glass-border)]">
                            <div className="ml-auto flex items-center gap-2">
                                <button onClick={onClose} className="px-3 py-1 rounded text-xs text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]">取消</button>
                                <button onClick={() => onParse(code)}
                                    disabled={!code.trim()}
                                    className="px-3 py-1 rounded text-xs bg-[var(--sage)]/20 text-[var(--sage)] hover:bg-[var(--sage)]/30 disabled:opacity-30">
                                    解析代码
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {isStep2 && (
                    <>
                        {/* 解析结果预览 */}
                        <div className="rounded-lg border border-[var(--glass-border)]/50 bg-white/30 p-3 max-h-48 overflow-y-auto mb-3">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs font-semibold text-[var(--coffee-deep)] font-mono">{data.protocol}</span>
                                <span className="text-[10px] text-[var(--coffee-muted)]">{Object.keys(data.fieldStates).length} 个字段</span>
                            </div>
                            {data.warnings.length > 0 && (
                                <div className="mb-2 space-y-0.5">
                                    {data.warnings.map((w, i) => (
                                        <div key={i} className="flex items-center gap-1 text-[10px] text-[var(--caramel)]">
                                            <AlertCircle size={10} /> {w}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {Object.keys(data.fieldStates).length === 0 ? (
                                <span className="text-[10px] text-[var(--coffee-muted)] italic">nil (无参数)</span>
                            ) : (
                                <div className="space-y-0.5">
                                    {Object.entries(data.fieldStates).slice(0, 20).map(([key, s]) => (
                                        <div key={key} className="flex items-baseline gap-1.5 text-[10px] font-mono">
                                            <span className="text-[var(--coffee-deep)] truncate">{key}</span>
                                            <span className="text-[var(--coffee-muted)] opacity-40">=</span>
                                            {s.mode === 'nil' ? (
                                                <span className="text-[var(--coffee-muted)] italic">nil</span>
                                            ) : s.mode === 'table' ? (
                                                <span className="text-[var(--sage)]">{'{}'}</span>
                                            ) : (
                                                <span className="text-[var(--coffee-deep)] truncate">{JSON.stringify(s.value)}</span>
                                            )}
                                            {s.markTable && s.mode !== 'nil' && (
                                                <span className="text-[8px] px-0.5 rounded bg-[var(--sage)]/10 text-[var(--sage)]">Mark</span>
                                            )}
                                        </div>
                                    ))}
                                    {Object.keys(data.fieldStates).length > 20 && (
                                        <div className="text-[9px] text-[var(--coffee-muted)]">...共 {Object.keys(data.fieldStates).length} 个字段</div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 目标选择 */}
                        <div className="mb-3">
                            <div className="flex items-center gap-4">
                                <span className="text-[10px] font-semibold text-[var(--coffee-deep)] whitespace-nowrap">导入为</span>
                                <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                                    <input type="radio" name="importTarget" checked={importTarget === 'card'}
                                        onChange={() => setImportTarget('card')} className="w-2.5 h-2.5" />
                                    <span className="text-[10px] text-[var(--coffee-deep)]">添加为卡片</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                                    <input type="radio" name="importTarget" checked={importTarget === 'preset'}
                                        onChange={() => setImportTarget('preset')} className="w-2.5 h-2.5" />
                                    <span className="text-[10px] text-[var(--coffee-deep)]">存为预设</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                                    <input type="radio" name="importTarget" checked={importTarget === 'both'}
                                        onChange={() => setImportTarget('both')} className="w-2.5 h-2.5" />
                                    <span className="text-[10px] text-[var(--coffee-deep)]">两者都要</span>
                                </label>
                            </div>
                            {(importTarget === 'preset' || importTarget === 'both') && (
                                <input type="text" value={presetName}
                                    onChange={e => setPresetName(e.target.value)}
                                    placeholder="预设名称 (默认用协议名)"
                                    className="w-full mt-2 px-2 py-1 text-[10px] rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                                />
                            )}
                        </div>

                        <div className="flex items-center gap-2 pt-3 border-t border-[var(--glass-border)]">
                            <button onClick={onReset}
                                className="px-3 py-1 rounded text-xs text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]">返回修改</button>
                            <div className="ml-auto">
                                <button onClick={() => onConfirm(importTarget, presetName.trim() || data.protocol)}
                                    className="px-3 py-1 rounded text-xs bg-[var(--sage)]/20 text-[var(--sage)] hover:bg-[var(--sage)]/30">
                                    确认导入
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}


// ============================================================================
// 工具函数
// ============================================================================

function RotateCw(props) {
    return <svg xmlns="http://www.w3.org/2000/svg" width={props.size || 24} height={props.size || 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
}

// ============================================================================
// Lua 代码生成（前端版，与 Python 端 generate_lua_code 一致）
// ============================================================================

function generateLuaCode(protocolName, params, markTableFields = [], nilFields = []) {
    const reqId = `proto_${Math.floor(Date.now() / 1000)}_${Math.floor(Math.random() * 9000 + 1000)}`
    const requestLua = buildLuaTable(params, nilFields, '    ')

    const markLines = [...markTableFields].sort().map(
        path => `    XMessagePack.MarkAsTable(_request.${path})`
    )
    const markCode = markLines.join('\n')

    return `do
    local _reqId = "${reqId}"
    local _request = ${requestLua}
${markCode}
    XNetwork.Call("${protocolName}", _request, function(response)
        if RuntimeGMClient then
            RuntimeGMClient.Send({
                type = "PROTO_CALL_RESP",
                reqId = _reqId,
                protocol = "${protocolName}",
                code = response.Code,
                data = response
            })
        else
            print("[EncyHub] PROTO_CALL_RESP reqId=" .. _reqId .. " protocol=${protocolName} code=" .. tostring(response.Code))
        end
    end)
end`
}

function buildLuaTable(data, nilFields, indent) {
    if (data === null || data === undefined) return 'nil'
    if (typeof data === 'boolean') return data ? 'true' : 'false'
    if (typeof data === 'number') {
        if (Number.isFinite(data) && data === Math.floor(data)) return String(data)
        return String(data)
    }
    if (typeof data === 'string') {
        const escaped = data.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
        return `"${escaped}"`
    }
    if (Array.isArray(data)) {
        if (data.length === 0) return '{}'
        const items = data.map(item => buildLuaTable(item, nilFields, indent + '    '))
        if (items.length <= 5 && items.every(x => /^(\d+|"[^"]*"|true|false|nil)$/.test(x))) {
            return '{' + items.join(', ') + '}'
        }
        const inner = items.join(`,\n${indent}`)
        return `{\n${indent}${inner}\n${indent.slice(0, -4)}}`
    }
    if (typeof data === 'object') {
        const entries = Object.entries(data)
        if (entries.length === 0) return '{}'
        const lines = []
        for (const [key, val] of entries) {
            if (nilFields.includes(key)) continue
            const valLua = buildLuaTable(val, nilFields, indent + '    ')
            lines.push(`${indent}["${key}"] = ${valLua}`)
        }
        if (lines.length === 0) return '{}'
        const inner = lines.join(',\n')
        return `{\n${inner}\n${indent.slice(0, -4)}}`
    }
    return 'nil'
}

// ============================================================================
// Lua 代码解析（从粘贴的代码中提取协议名、参数、MarkTable）
// ============================================================================

function parseLuaImportCode(code) {
    if (!code || !code.trim()) {
        return { error: '请输入 Lua 代码' }
    }

    // 提取协议名: XNetwork.Call("ProtocolName", ...)
    const callMatch = code.match(/XNetwork\.Call\s*\(\s*"(\w+)"\s*,/)
    if (!callMatch) {
        return { error: '未找到 XNetwork.Call 调用，请确认代码格式' }
    }
    const protocol = callMatch[1]

    // 提取 _request 赋值: local _request = {...}
    // 找到 local _request = 后的 table
    const requestMatch = code.match(/local\s+_request\s*=\s*/)
    if (!requestMatch) {
        return { error: '未找到 _request 变量定义' }
    }

    const tableStart = requestMatch.index + requestMatch[0].length
    const tableText = extractBraceBlock(code, tableStart)
    if (!tableText) {
        return { error: '无法解析 _request 的 table 内容' }
    }

    // 解析 Lua table → JS 对象
    let parsedTable
    try {
        parsedTable = parseLuaTableText(tableText)
    } catch (e) {
        return { error: `解析 Lua table 失败: ${e.message}` }
    }

    // 转为 fieldStates
    const fieldStates = luaObjectToFieldStates(parsedTable)

    // 提取 MarkAsTable 路径
    const markTableFields = []
    const markRegex = /XMessagePack\.MarkAsTable\s*\(\s*_request\.([\w.[\]]+)\s*\)/g
    let markMatch
    while ((markMatch = markRegex.exec(code)) !== null) {
        markTableFields.push(markMatch[1])
    }

    return {
        protocol,
        fieldStates,
        markTableFields,
        warnings: [],
    }
}

function extractBraceBlock(text, start) {
    if (text[start] !== '{') return null
    let depth = 0
    let i = start
    let inString = false
    let stringChar = ''
    while (i < text.length) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') { i += 2; continue }
            if (ch === stringChar) inString = false
        } else {
            if (ch === '"' || ch === "'") { inString = true; stringChar = ch }
            else if (ch === '{') depth++
            else if (ch === '}') {
                depth--
                if (depth === 0) return text.slice(start, i + 1)
            }
        }
        i++
    }
    return null
}

function parseLuaTableText(text) {
    // 简化的 Lua table 解析器 → JS 对象
    text = text.trim()
    if (text === 'nil' || text === '') return null

    // 递归下降解析
    const parser = new SimpleLuaTableParser(text)
    return parser.parseValue()
}

class SimpleLuaTableParser {
    constructor(text) {
        this.text = text
        this.pos = 0
    }

    parseValue() {
        this.skipWS()
        if (this.pos >= this.text.length) return null

        const ch = this.text[this.pos]
        if (ch === '{') return this.parseTable()
        if (ch === '"' || ch === "'") return this.parseString()
        if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber()
        if (this.text.substr(this.pos, 4) === 'true') { this.pos += 4; return true }
        if (this.text.substr(this.pos, 5) === 'false') { this.pos += 5; return false }
        if (this.text.substr(this.pos, 3) === 'nil') { this.pos += 3; return null }
        return null
    }

    parseTable() {
        this.pos++ // skip {
        this.skipWS()
        const result = {}
        let arrayIdx = 1

        while (this.pos < this.text.length) {
            this.skipWS()
            if (this.pos >= this.text.length) break
            if (this.text[this.pos] === '}') { this.pos++; break }

            // Check for ["key"] = value or [num] = value
            if (this.text[this.pos] === '[') {
                this.pos++ // skip [
                this.skipWS()
                let key
                if (this.text[this.pos] === '"' || this.text[this.pos] === "'") {
                    key = this.parseString()
                } else if (this.text[this.pos] === '-' || (this.text[this.pos] >= '0' && this.text[this.pos] <= '9')) {
                    key = this.parseNumber()
                    if (Number.isFinite(key) && key === Math.floor(key)) key = String(key)
                } else {
                    // skip to ]
                    while (this.pos < this.text.length && this.text[this.pos] !== ']') this.pos++
                    key = null
                }
                this.skipWS()
                if (this.text[this.pos] === ']') this.pos++
                this.skipWS()
                if (this.text[this.pos] === '=' || this.text[this.pos] === '=') this.pos++
                this.skipWS()
                const val = this.parseValue()
                if (key !== null) result[String(key)] = val
                else result[String(arrayIdx++)] = val
            } else {
                // Array-style value
                const val = this.parseValue()
                result[String(arrayIdx++)] = val
            }

            this.skipWS()
            if (this.pos < this.text.length && (this.text[this.pos] === ',' || this.text[this.pos] === ';')) this.pos++
        }

        // Check if pure array
        const keys = Object.keys(result)
        if (keys.length > 0 && keys.every((k, i) => k === String(i + 1))) {
            return keys.map(k => result[k])
        }
        return result
    }

    parseString() {
        const quote = this.text[this.pos]
        this.pos++
        let result = ''
        while (this.pos < this.text.length && this.text[this.pos] !== quote) {
            if (this.text[this.pos] === '\\') {
                this.pos++
                if (this.pos < this.text.length) {
                    const esc = this.text[this.pos]
                    if (esc === 'n') result += '\n'
                    else if (esc === 't') result += '\t'
                    else if (esc === '\\') result += '\\'
                    else if (esc === quote) result += quote
                    else result += esc
                }
            } else {
                result += this.text[this.pos]
            }
            this.pos++
        }
        if (this.pos < this.text.length) this.pos++ // skip closing quote
        return result
    }

    parseNumber() {
        const start = this.pos
        if (this.text[this.pos] === '-') this.pos++
        while (this.pos < this.text.length && ((this.text[this.pos] >= '0' && this.text[this.pos] <= '9') || this.text[this.pos] === '.')) this.pos++
        if (this.pos < this.text.length && (this.text[this.pos] === 'e' || this.text[this.pos] === 'E')) {
            this.pos++
            if (this.pos < this.text.length && (this.text[this.pos] === '+' || this.text[this.pos] === '-')) this.pos++
            while (this.pos < this.text.length && (this.text[this.pos] >= '0' && this.text[this.pos] <= '9')) this.pos++
        }
        const numStr = this.text.slice(start, this.pos)
        const num = Number(numStr)
        return isNaN(num) ? 0 : num
    }

    skipWS() {
        while (this.pos < this.text.length && ' \t\n\r'.includes(this.text[this.pos])) this.pos++
    }
}

function luaObjectToFieldStates(obj, prefix = '') {
    const fs = {}
    if (obj === null || obj === undefined) return fs

    if (typeof obj !== 'object') {
        // primitive at root level shouldn't happen but handle it
        return fs
    }

    if (Array.isArray(obj)) {
        if (prefix) {
            fs[prefix] = { mode: 'table', markTable: true }
        }
        obj.forEach((item, i) => {
            const childPrefix = `${prefix}[${i + 1}]`
            if (typeof item === 'object' && item !== null) {
                fs[childPrefix] = { mode: 'table', markTable: true }
                Object.assign(fs, luaObjectToFieldStates(item, childPrefix))
            } else {
                fs[childPrefix] = { mode: 'value', value: item }
            }
        })
        return fs
    }

    // dict
    for (const [key, val] of Object.entries(obj)) {
        const isNumericKey = /^\d+$/.test(key)
        const childPrefix = isNumericKey
            ? `${prefix}[${key}]`
            : (prefix ? `${prefix}.${key}` : key)
        if (val === null || val === undefined) {
            fs[childPrefix] = { mode: 'nil', markTable: true }
        } else if (typeof val === 'object') {
            fs[childPrefix] = { mode: 'table', markTable: true }
            Object.assign(fs, luaObjectToFieldStates(val, childPrefix))
        } else {
            const isNonPrimitive = typeof val !== 'number' && typeof val !== 'boolean' && typeof val !== 'string'
            fs[childPrefix] = {
                mode: 'value',
                value: val,
                markTable: isNonPrimitive,
                ...(isNonPrimitive ? {} : {}),
            }
        }
    }
    return fs
}

function buildInitialFieldStates(fields, savedStates, parentPath = '') {
    const fs = { ...savedStates }
    for (const f of fields) {
        const path = parentPath ? `${parentPath}.${f.name}` : f.name
        if (!fs[path]) {
            fs[path] = {
                mode: 'nil',
                markTable: !f.isPrimitive,
            }
        }
        if (f.subFields) {
            const subFs = buildInitialFieldStates(f.subFields, {}, path)
            for (const [k, v] of Object.entries(subFs)) {
                if (!fs[k]) fs[k] = v
            }
        }
    }
    return fs
}

function buildRequestParams(fieldStates) {
    const params = {}
    const markTableFields = []
    const nilFields = []

    const entries = Object.entries(fieldStates).sort((a, b) => a[0].length - b[0].length)

    for (const [path, state] of entries) {
        if (state.mode === 'nil') {
            if (!path.includes('.')) {
                nilFields.push(path)
            }
            continue
        }

        if (state.mode === 'table') {
            ensureNestedPath(params, path)
        } else {
            setNestedValue(params, path, state.value)
        }

        // 收集 markTable 字段
        if (state.markTable && state.mode !== 'nil') {
            markTableFields.push(path)
        }
    }

    return { params, markTableFields, nilFields }
}

function setNestedValue(obj, path, value) {
    const segments = []
    for (const part of path.split('.')) {
        const m = part.match(/^([^\[]+)(\[(\d+)\])$/)
        if (m) {
            segments.push({ key: m[1], isArrayParent: true })
            segments.push({ key: Number(m[3]), isIndex: true })
        } else {
            segments.push({ key: part })
        }
    }
    let current = obj
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]
        if (current[seg.key] == null) {
            current[seg.key] = {}
        }
        current = current[seg.key]
    }
    current[segments[segments.length - 1].key] = value
}

function ensureNestedPath(obj, path) {
    const segments = []
    for (const part of path.split('.')) {
        const m = part.match(/^([^\[]+)(\[(\d+)\])$/)
        if (m) {
            segments.push({ key: m[1] })
            segments.push({ key: Number(m[3]) })
        } else {
            segments.push({ key: part })
        }
    }
    let current = obj
    for (const seg of segments) {
        if (current[seg.key] == null) {
            current[seg.key] = {}
        }
        current = current[seg.key]
    }
}

function getInputType(type) {
    if (type === 'bool') return 'text'
    if (type === 'int' || type === 'long' || type === 'short' || type === 'byte' ||
        type === 'uint' || type === 'ulong' || type === 'ushort' || type === 'sbyte') return 'number'
    if (type === 'float' || type === 'double' || type === 'decimal') return 'number'
    return 'text'
}

function parseInputValue(val, type) {
    if (val === '') return undefined
    if (type === 'bool') return val === 'true'
    if (['int', 'long', 'short', 'byte', 'uint', 'ulong', 'ushort', 'sbyte'].includes(type)) return parseInt(val) || 0
    if (['float', 'double', 'decimal'].includes(type)) return parseFloat(val) || 0
    return val
}

function formatResponse(data) {
    if (!data) return '(无数据)'
    try {
        const json = typeof data === 'string' ? JSON.parse(data) : data
        return JSON.stringify(json, null, 2)
    } catch {
        return String(data)
    }
}

export default memo(ProtoRequester)
