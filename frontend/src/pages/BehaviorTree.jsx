import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Download, FolderOpen, GitBranch, LayoutGrid, Minus, Maximize, MoreHorizontal, MousePointerClick, Plus, Save, Search, ShieldCheck, Trash2, Upload, Workflow, X } from 'lucide-react'
import { useToast } from '../components/Toast'
import { addNode, bindingHealth, fitText, cancelModeLabel, connectNode, enumLabel, editableTreeErrors, emptyTree, friendlyError, jsonDraftErrors, jsonInputText, kindLabel, mergeObjects, newId, nodeKindLabel, outline, paramLabel, parameterErrors, rangeHint, recordJsonDraft, removeNode, runEffects, sideEffectLabel, startBlockers, targetFit, treeLayout, treeSlots } from '../utils/behaviorTree'
import { executionOptions, restoreEditorDraft, selectRuntimeRun } from '../utils/behaviorTreeRuntime'
import RunPanel, { STATE } from './BehaviorTreeRun'
import useTreeViewport from '../utils/useTreeViewport'
import ViewportTools from './BehaviorTreeViewport'
import './BehaviorTree.css'

const API = '/api/gm_console/behavior-tree'
async function request(path, body, method) {
  const response = await fetch(`${API}${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : JSON.stringify(value.detail || value))
  return value
}
const NODE_W = 190, NODE_H = 65
const KIND_ORDER = ['composite', 'decorator', 'condition', 'action']
const FX_TAG = { debug_state: '改动', gameplay_input: '输入' }
const fxTag = effect => FX_TAG[effect] || '控制'
const without = (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

function JsonField({ value, draft, label, onDraftChange }) {
  return <div className="bt-field">{label}<textarea aria-label={label} value={draft ? draft.text : jsonInputText(value)} rows={4} onChange={e => onDraftChange(e.target.value)} />{draft?.error && <span className="bt-error">{draft.error}</span>}</div>
}

function BehaviorTree({ selectedClient, broadcastMode, active, expanded = false, draftKey = 'bt.editorDraft' }) {
  const toast = useToast()
  const [draft] = useState(() => restoreEditorDraft(localStorage.getItem(draftKey)))
  const [tree, setTree] = useState(() => draft?.tree || emptyTree())
  const [layout, setLayout] = useState(() => draft?.layout || {})
  const [catalog, setCatalog] = useState([])
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [objects, setObjects] = useState([])
  const [bound, setBound] = useState({})
  const [forced, setForced] = useState({})
  const [discovered, setDiscovered] = useState({})
  const [selectors, setSelectors] = useState(() => draft?.targetSelectors || {})
  const [sessionId, setSessionId] = useState(null)
  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState(() => draft?.presetId || '')
  const [dirty, setDirty] = useState(() => draft?.dirty || false)
  const [jsonDrafts, setJsonDrafts] = useState(() => draft?.jsonDrafts || {})
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [observe, setObserve] = useState(false)
  const [runMode, setRunMode] = useState('autonomous')
  const [maxRunSeconds, setMaxRunSeconds] = useState('3600')
  const [importDraft, setImportDraft] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [lastError, setLastError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorOpen, setEditorOpen] = useState(() => expanded || localStorage.getItem('bt.editorOpen') !== '0')
  const [edgeFrom, setEdgeFrom] = useState('')
  const drag = useRef(null)
  const canvasRef = useRef(null)
  const menuRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [folded, setFolded] = useState(() => { try { return JSON.parse(localStorage.getItem('bt.foldedGroups') || '[]') } catch { return [] } })
  const snapshotRef = useRef(null)
  snapshotRef.current = snapshot
  const diagnosticsRef = useRef(false)
  const scanStatusAt = useRef(0)
  const observeRef = useRef(false)
  observeRef.current = observe
  const sessionRef = useRef(null)
  const statusSerial = useRef(0)
  const scansRef = useRef({ fight: 0, gameobject: 0 })
  const currentClient = useRef(selectedClient?.id)
  currentClient.current = selectedClient?.id
  const online = !!selectedClient && selectedClient.online !== false && !broadcastMode
  const definition = useMemo(() => Object.fromEntries(catalog.map(n => [n.id, n])), [catalog])
  const node = tree.nodes.find(n => n.id === selected)
  const spec = definition[node?.type]
  const positions = useMemo(() => ({ ...treeLayout(tree), ...layout }), [tree, layout])
  const running = snapshot?.state === 'running' || snapshot?.state === 'awaiting_decision'
  const slots = useMemo(() => treeSlots(tree, definition), [tree, definition])
  const bindings = useMemo(() => Object.fromEntries(slots.filter(slot => bound[slot.name]).map(slot => [slot.name, bound[slot.name].object.token])), [slots, bound])
  const boundObjects = useMemo(() => Object.fromEntries(Object.entries(bound).map(([name, item]) => [name, item.object])), [bound])
  const health = useMemo(() => Object.fromEntries(slots.filter(slot => bound[slot.name]).map(slot => {
    const item = bound[slot.name]
    return [slot.name, forced[slot.name] || bindingHealth(item.object, slot, objects, scansRef.current[item.object.token?.kind] > item.scan)]
  })), [slots, bound, objects, forced])
  const effects = useMemo(() => runEffects(tree, definition), [tree, definition])

  const jsonErrors = jsonDraftErrors(jsonDrafts)
  function changeJsonDraft(key, text, schema, onValue) {
    const result = recordJsonDraft(jsonDrafts, key, text, schema)
    setJsonDrafts(result.drafts); setDirty(true)
    if (!result.error) onValue(result.value)
  }
  function requireValidDraft() { if (Object.keys(jsonErrors).length) throw new Error('JSON草稿尚未有效，请修正后再保存、导出、校验或开始') }

  const blockers = [
    ...(tree.nodes.length ? [] : ['画布上还没有节点：从节点库添加，或在顶部打开预设']),
    ...(snapshot?.state === 'unknown' && snapshot.clientId === selectedClient?.id ? ['启动状态未知'] : []),
    ...startBlockers({ slots, bound: boundObjects, health })
  ]
  const blockerNotes = [
    ...(tree.nodes.length ? [] : ['画布上还没有节点：从节点库添加，或在顶部打开预设']),
    ...(snapshot?.state === 'unknown' && snapshot.clientId === selectedClient?.id ? ['启动状态未知'] : []),
    ...startBlockers({ slots, bound: boundObjects, health, includeBroken: false })
  ]

  function edit(next) { setTree(next); setDirty(true); setValidation(null) }
  function markFailure(message) {
    const text = String(message || '')
    const role = text.match(/binding_invalid:([^\s"']+)/)?.[1]
    const nodeId = text.match(/binding_capability:([^\s"']+)/)?.[1]
    const failed = nodeId ? tree.nodes.find(n => n.id === nodeId) : null
    const roles = role ? [role] : failed ? (definition[failed.type]?.roles || []).map(r => failed.params[r.parameter]).filter(Boolean) : []
    if (!roles.length) return false
    setForced(old => ({ ...old, ...Object.fromEntries(roles.map(name => [name, { level: role ? 'stale' : 'blocked', text: friendlyError(text) }])) }))
    return true
  }
  async function perform(callback) {
    setBusy(true); setNotice('')
    try { return await callback() } catch (e) { setLastError(e.message); if (!markFailure(e.message)) setNotice(friendlyError(e.message)) } finally { setBusy(false) }
  }
  async function runtime(action, payload = {}) {
    if (!online) throw new Error('请选单个在线客户端，行为树不支持广播')
    const clientId = selectedClient.id
    const response = await request(`/clients/${encodeURIComponent(clientId)}/${action}`, { requestId: newId(), sessionId: sessionRef.current, payload, timeout: 10 })
    if (currentClient.current !== clientId) throw new Error('客户端已切换，请重新选择目标')
    if (!response.ok) {
      const failure = new Error(response.error?.message || (typeof response.error === 'string' ? response.error : JSON.stringify(response.error || response.errors || response)))
      failure.unknown = response.state === 'unknown'
      throw failure
    }
    const nextSession = response.sessionId || response.data?.sessionId
    if (nextSession) { sessionRef.current = nextSession; setSessionId(nextSession) }
    return response.data
  }
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ schemaVersion: 1, tree, layout, targetSelectors: selectors, presetId, dirty, jsonDrafts })) }
    catch { setNotice('编辑草稿未能保存到浏览器，请先导出，避免刷新丢失。') }
  }, [tree, layout, selectors, presetId, dirty, jsonDrafts])

  async function loadPresets() { const result = await request('/presets'); setPresets(result.presets) }
  useEffect(() => { perform(async () => { const result = await request('/nodes'); setCatalog(result.nodes); await loadPresets() }) }, [])
  useEffect(() => {
    sessionRef.current = null; setSessionId(null); setObjects([]); setBound({}); setForced({}); setDiscovered({}); setConfirming(false); setObserve(false)
    statusSerial.current++; setSnapshot(null); snapshotRef.current = null; scanStatusAt.current = 0
    if (active && online) perform(async () => { const data = await runtime('capabilities'); setCatalog(data.nodes) })
  }, [selectedClient?.id, online, broadcastMode])
  useEffect(() => {
    if (!active || !online) return
    let stopped = false, timer
    const poll = async () => {
      try { if (!document.hidden || observeRef.current) await queryStatus(() => stopped) }
      catch (e) { if (!stopped) { setObserve(false); setNotice(friendlyError(e.message)); setSnapshot(old => old ? { ...old, state: 'unknown', reason: friendlyError(e.message) } : null) } }
      if (!stopped) timer = setTimeout(poll, ['running', 'awaiting_decision'].includes(snapshotRef.current?.state) ? 1000 : 3000)
    }
    poll(); return () => { stopped = true; clearTimeout(timer) }
  }, [active, online, selectedClient?.id])

  async function discover(kind, search = '') {
    const data = await runtime('discover', kind === 'gameobject' ? { kind, search } : { kind })
    const found = (data.objects || []).filter(o => o.token?.kind === kind)
    scansRef.current = { ...scansRef.current, [kind]: (scansRef.current[kind] || 0) + 1 }
    setObjects(old => mergeObjects(old, found, kind === 'fight' ? 'fight' : undefined))
    setDiscovered(old => ({ ...old, [kind]: { count: found.length, query: search } }))
    return found
  }
  function choose(name, object) {
    setBound(old => ({ ...old, [name]: { object, scan: scansRef.current[object.token?.kind] || 0 } }))
    setForced(old => without(old, name))
  }
  function clear(name) { setBound(old => without(old, name)); setForced(old => without(old, name)) }
  async function bindSelectors() {
    const missed = []
    for (const slot of slots) {
      const selector = selectors[slot.name]
      if (!selector || bound[slot.name]) continue
      const found = await discover(slot.kind, selector.name || '')
      const matches = selector.kind === slot.kind ? found.filter(o => (slot.kind === 'fight' || o.name === selector.name) && targetFit(o, slot).usable) : []
      if (matches.length === 1) { choose(slot.name, matches[0]) } else missed.push(selector.name || kindLabel(slot.kind))
    }
    if (missed.length) setNotice(`没找到唯一可用的目标：${missed.join('、')}，请手动选择。`)
  }
  async function check() { requireValidDraft(); const result = await request('/validate', { tree }); setValidation(result); return result }
  async function start() {
    setConfirming(false)
    const previousSnapshot = snapshot
    if (snapshot?.state === 'unknown' && snapshot.clientId === selectedClient.id) throw new Error('上次启动状态未知，请先点「查询状态」或停止该运行')
    const capability = await runtime('capabilities')
    const options = executionOptions(runMode, maxRunSeconds, capability.runModes)
    const result = await check(); if (!result.ok) throw new Error(`树校验失败：${result.errors?.[0] ? `${result.errors[0].path}：${result.errors[0].message}` : '请修正画布上标出的节点'}`)
    for (const slot of slots) if (!bindings[slot.name]) throw new Error(`还没选择目标「${kindLabel(slot.kind)}」`)
    const validated = await runtime('validate', { tree, bindings })
    if (validated.ok !== true) { setValidation(validated); throw new Error('游戏内树校验失败，未安装或启动') }
    const installed = await runtime('install', { tree })
    if (installed.ok !== true) { setValidation(installed); throw new Error('游戏内安装失败，未启动') }
    const runId = newId()
    setSnapshot({ runId, treeId: tree.id, state: 'unknown', reason: '正在等待游戏启动回执；超时后请点「查询状态」，不要重复启动', clientId: selectedClient.id })
    let run
    try { run = await runtime('start', { treeId: tree.id, bindings, runId, ...options }) } catch (e) { if (!e.unknown) setSnapshot(previousSnapshot); throw e }
    statusSerial.current++; snapshotRef.current = { ...run, clientId: selectedClient.id }; scanStatusAt.current = 0
    setSnapshot(snapshotRef.current); setObserve(run.state === 'running' && run.runMode === 'debug')
    if (run.state !== 'running') throw new Error(`游戏返回：${STATE[run.state] || run.state}；不会自动重试`)
  }
  async function stop() { statusSerial.current++; const data = await runtime('stop', { runId: snapshot?.runId }); const run = data.runs?.find(r => r.runId === snapshot?.runId); if (!run) throw new Error('没有收到当前运行的停止回执，请重新查询'); snapshotRef.current = { ...run, clientId: selectedClient.id }; setSnapshot(snapshotRef.current); setObserve(false) }
  async function queryStatus(cancelled = () => false) {
    const serial = ++statusSerial.current
    const stale = () => cancelled() || serial !== statusSerial.current
    const previous = snapshotRef.current
    let run = previous
    // 只定期发现新的活跃运行；每秒只读当前一份，历史目录不带节点轨迹。
    if (!previous || Date.now() >= scanStatusAt.current) {
      const data = await runtime('status', { summary: true })
      if (stale()) return
      run = selectRuntimeRun(data.runs, previous?.runId)
      scanStatusAt.current = Date.now() + 5000
    }
    if (!run) { snapshotRef.current = null; setSnapshot(null); setObserve(false); return }
    const sameRun = previous?.clientId === selectedClient.id && previous?.sessionId === run.sessionId && previous?.runId === run.runId
    const detail = await runtime('status', { runId: run.runId, includeTree: !sameRun || !previous?.tree, renewLease: sameRun && run.runMode === 'debug' && observeRef.current, includeEvents: diagnosticsRef.current, includeBlackboard: diagnosticsRef.current })
    if (stale()) return
    run = detail.runs?.find(item => item.runId === run.runId)
    if (!run) { snapshotRef.current = null; setSnapshot(null); setObserve(false); return }
    if (!sameRun || !['running', 'awaiting_decision'].includes(run.state)) setObserve(false)
    const next = { ...run, tree: run.tree || (sameRun ? previous.tree : null), clientId: selectedClient.id }
    snapshotRef.current = next
    setSnapshot(old => sameRun && old?.eventSeq !== undefined && old.eventSeq === next.eventSeq && old.state === next.state && old.revision === next.revision && old.tree === next.tree && !!old.events === !!next.events && !!old.blackboard === !!next.blackboard ? old : next)
  }
  async function save(asCopy = false) {
    requireValidDraft()
    const targetSelectors = { ...selectors }
    for (const [name, item] of Object.entries(bound)) if (item.object.token?.kind === 'gameobject') targetSelectors[name] = { kind: 'gameobject', name: item.object.name }
    const preset = { schema_version: 1, ...(presetId && !asCopy ? { id: presetId } : {}), name: tree.name, tree: asCopy ? { ...tree, id: newId() } : tree, layout, targetSelectors }
    const saved = await request(presetId && !asCopy ? `/presets/${encodeURIComponent(presetId)}` : '/presets', preset, presetId && !asCopy ? 'PUT' : 'POST')
    setPresetId(saved.id); setTree(saved.tree); setSelectors(saved.targetSelectors || {}); setDirty(false); await loadPresets(); toast.success('预设已保存')
  }
  function loadPreset(preset) {
    const errors = editableTreeErrors(preset.tree)
    if (errors.length) { setNotice(`预设原始数据已保留，编辑器不能打开畸形结构：${errors.join('；')}`); return }
    if (dirty && !window.confirm('放弃当前未保存改动并打开预设？')) return
    setJsonDrafts({}); setTree(preset.tree); setLayout(preset.layout || {}); setSelectors(preset.targetSelectors || {}); setPresetId(preset.id); setSelected(preset.tree.root); setDirty(false); setValidation(null); setBound({}); setForced({}); setConfirming(false)
    setSearchText(Object.values(preset.targetSelectors || {}).find(s => s.kind === 'gameobject')?.name || '')
  }
  function exportTree() {
    requireValidDraft()
    const blob = new Blob([JSON.stringify({ schema_version: 1, ...(presetId ? { id: presetId } : {}), name: tree.name, tree, layout, targetSelectors: selectors }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${tree.name}.json`; anchor.click(); URL.revokeObjectURL(url)
  }
  function patchParams(key, value) { edit({ ...tree, nodes: tree.nodes.map(n => n.id === selected ? { ...n, params: { ...n.params, [key]: value } } : n) }) }
  function addRole(requirement) {
    const base = requirement.kind === 'fight' ? 'player' : 'target'
    let name = base, index = 2
    while (tree.roles[name] && tree.roles[name].kind !== requirement.kind) name = `${base}${index++}`
    edit({ ...tree, roles: { ...tree.roles, [name]: { kind: requirement.kind } }, nodes: tree.nodes.map(n => n.id === selected ? { ...n, params: { ...n.params, [requirement.parameter]: name } } : n) })
  }

  const [sideTab, setSideTab] = useState('nodes')
  const needle = query.toLowerCase()
  const visibleCatalog = catalog.filter(d => `${d.name} ${d.id} ${d.kind} ${(d.tags || []).join(' ')}`.toLowerCase().includes(needle))
  const groups = [...KIND_ORDER, ...new Set(visibleCatalog.map(d => d.kind).filter(kind => !KIND_ORDER.includes(kind)))]
    .map(kind => ({ kind, items: visibleCatalog.filter(d => d.kind === kind) })).filter(group => group.items.length)
  const canvasWidth = Math.max(900, ...Object.values(positions).map(p => p.x + NODE_W + 60))
  const canvasHeight = Math.max(480, ...Object.values(positions).map(p => p.y + NODE_H + 80))
  useEffect(() => {
    if (!menuOpen) return
    const close = event => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])
  const removeById = id => { setJsonDrafts(old => Object.fromEntries(Object.entries(old).filter(([key]) => key === 'blackboard' || JSON.parse(key)[0] !== id))); edit(removeNode(tree, id)); setSelected('') }
  useEffect(() => {
    if (!edgeFrom) return
    const cancel = event => { if (event.key === 'Escape') setEdgeFrom('') }
    window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel)
  }, [edgeFrom])
  const toggleGroup = kind => setFolded(old => { const next = old.includes(kind) ? old.filter(k => k !== kind) : [...old, kind]; localStorage.setItem('bt.foldedGroups', JSON.stringify(next)); return next })
  const viewport = useTreeViewport(canvasRef, canvasWidth, canvasHeight, editorOpen)
  const { zoom } = viewport
  const fitView = viewport.fit
  useEffect(() => { if (presetId && editorOpen && active) fitView() }, [presetId, editorOpen, active])
  const parentOf = node ? tree.nodes.find(n => n.children.includes(selected))?.id || '' : ''
  const addFromCatalog = d => { const parent = selected && definition[node?.type]?.maxChildren > 0 ? selected : undefined; const next = addNode(tree, d, parent); edit(next); setSelected(next.nodes.at(-1).id) }
  const reorderChild = (index, offset) => { const children = [...node.children]; [children[index + offset], children[index]] = [children[index], children[index + offset]]; edit({ ...tree, nodes: tree.nodes.map(n => n.id === selected ? { ...n, children } : n) }) }
  function expandEditor() {
    // 独立草稿避免两个页签互相覆盖；保存后的预设仍然共享。
    const key = `bt.editorDraft.${newId()}`
    try {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, tree, layout, targetSelectors: selectors, presetId, dirty, jsonDrafts }))
      const params = new URLSearchParams({ draft: key, client: broadcastMode ? '' : selectedClient?.id || '' })
      window.open(`/gm_console/behavior-tree?${params}`, '_blank', 'noopener')
    } catch { setNotice('无法打开独立草稿，请先导出当前树。') }
  }
  const newTree = () => { if (!dirty || window.confirm('放弃未保存改动并新建？')) { setJsonDrafts({}); setTree(emptyTree()); setPresetId(''); setLayout({}); setSelected(''); setSelectors({}); setBound({}); setForced({}); setConfirming(false); setDirty(false) } }

  const editorGraph = useMemo(() => (<svg width={canvasWidth * zoom} height={canvasHeight * zoom}>
              <defs><clipPath id="bt-node-clip"><rect width={NODE_W} height={NODE_H} rx="10"/></clipPath></defs>
              <g transform={`scale(${zoom})`}>
                {tree.nodes.flatMap(n => n.children.map(child => {
                  if (!positions[child] || !positions[n.id]) return null
                  const sx = positions[n.id].x + NODE_W, sy = positions[n.id].y + NODE_H / 2, ex = positions[child].x, ey = positions[child].y + NODE_H / 2
                  const bend = Math.max(36, Math.abs(ex - sx) / 2), d = `M ${sx} ${sy} C ${sx + bend} ${sy}, ${ex - bend} ${ey}, ${ex} ${ey}`
                  return <g key={`${n.id}-${child}`} className={`bt-edge-g ${selected === n.id || selected === child ? 'hot' : ''}`} onClick={() => edit({ ...tree, nodes: tree.nodes.map(item => item.id === n.id ? { ...item, children: item.children.filter(id => id !== child) } : item) })}>
                    <path d={d} className="bt-edge-hit"/><path d={d} className="bt-edge"/><title>点击断开连线</title>
                  </g>
                }))}
                {tree.nodes.map(n => {
                  const d = definition[n.type], fx = d?.sideEffect && d.sideEffect !== 'none'
                  const name = d?.name || `未知：${n.type}`
                  return <g key={n.id} transform={`translate(${positions[n.id].x},${positions[n.id].y})`} data-kind={d?.kind || 'unknown'} className={`bt-node ${selected === n.id ? 'selected' : ''} ${fx ? 'fx' : ''}`} tabIndex={0} role="button" aria-label={name} onKeyDown={e => { if (e.key === 'Enter') setSelected(n.id); else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeById(n.id) } }} onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setSelected(n.id); drag.current = { id: n.id, x: e.clientX, y: e.clientY, original: positions[n.id] } }} onClick={() => { if (edgeFrom) { try { edit(connectNode(tree, edgeFrom, n.id)) } catch (e) { toast.error(e.message) } setEdgeFrom('') } setSelected(n.id) }}>
                    <title>{name}</title>
                    <rect className="bt-node-card" width={NODE_W} height={NODE_H} rx="10"/>
                    <g clipPath="url(#bt-node-clip)"><rect className="bt-node-bar" width="6" height={NODE_H}/></g>
                    <text className="bt-node-kind" x="17" y="19">{d ? nodeKindLabel(d.kind) : '未知版本'}{fx ? ` · ${fxTag(d.sideEffect)}` : ''}</text>
                    <text className="bt-node-name" x="17" y="40">{fitText(name, 10.5)}</text>
                    <text className="bt-node-sub" x="17" y="56">{n.children.length} 个子节点</text>
                    {n.id === tree.root && <g className="bt-root-tag" transform={`translate(${NODE_W - 46},7)`}><rect width="38" height="15" rx="7.5"/><text x="19" y="11" textAnchor="middle">ROOT</text></g>}
                    <g className={edgeFrom === n.id ? 'bt-port selected' : 'bt-port'} transform={`translate(${NODE_W},${NODE_H / 2})`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setEdgeFrom(edgeFrom === n.id ? '' : n.id) }}>
                      <circle r="13" className="bt-port-hit"/><circle r="6.5" className="bt-port-dot"/><title>连接子节点</title>
                    </g>
                  </g>
                })}
              </g>
            </svg>), [tree, positions, definition, selected, edgeFrom, zoom, toast])

  const runPanel = <RunPanel selectedClient={selectedClient} online={online} broadcastMode={broadcastMode} tree={tree} slots={slots} definition={definition}
      objects={objects} bound={boundObjects} health={health} discovered={discovered} searchText={searchText} onSearchText={setSearchText} selectors={selectors}
      busy={busy} running={running} locked={running} snapshot={snapshot} observe={observe} onObserve={setObserve} runMode={runMode} onRunMode={setRunMode} maxRunSeconds={maxRunSeconds} onMaxRunSeconds={setMaxRunSeconds} blockers={blockers} blockerNotes={blockerNotes} effects={effects} confirming={confirming} onConfirm={setConfirming}
      onStart={() => perform(start)} onStop={() => perform(stop)} onQuery={() => perform(() => { scanStatusAt.current = 0; return queryStatus() })} onDiscover={(kind, search) => perform(() => discover(kind, search))} onChoose={choose} onClear={clear} onBindSelectors={() => perform(bindSelectors)}
      onDiagnosticsOpen={open => { diagnosticsRef.current = open }} sessionId={sessionId} lastError={lastError} notice={notice} onDismissNotice={() => setNotice('')}/>

  return <div className="bt-workbench">
    <div className="bt-topbar">
      <div className="bt-title"><GitBranch size={16}/><input aria-label="行为树名称" value={tree.name} onChange={e => edit({ ...tree, name: e.target.value })}/>{dirty && <span className="bt-chip warn">未保存</span>}</div>
      <div className="bt-preset"><FolderOpen size={14}/>
        <select aria-label="打开预设" value={presetId} onChange={event => { const p = presets.find(p => p.id === event.target.value); if (p) loadPreset(p) }}><option value="">选择预设…</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
        {presetId && <button className="bt-icon-btn" aria-label="删除预设" title="删除当前预设（编辑器中的树保留）" onClick={() => { if (window.confirm('删除当前预设？当前树仍保留在编辑器中。')) perform(async () => { await request(`/presets/${encodeURIComponent(presetId)}`, null, 'DELETE'); setPresetId(''); await loadPresets() }) }}><Trash2 size={13}/></button>}
      </div>
      {!expanded && <button className="bt-expand-editor" onClick={expandEditor}><Maximize size={14}/>新开页签放大编辑</button>}
      <div className="bt-file-actions">
        <button onClick={newTree}><Plus size={14}/>新建</button>
        <button className="bt-primary" disabled={busy} onClick={() => perform(() => save())}><Save size={14}/>保存</button>
        <div className="bt-menu" ref={menuRef}><button className="bt-icon-btn" aria-label="更多操作" aria-expanded={menuOpen} title="导入 / 导出 / 另存" onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={15}/></button>
          {menuOpen && <div className="bt-menu-pop">
  <label className="bt-button"><Upload size={14}/>导入<input hidden type="file" accept="application/json,.json" onChange={e => { const file = e.target.files[0]; if (file) perform(async () => { const preset = JSON.parse(await file.text()); const preview = await request('/presets/preview', { preset }); setImportDraft(preview) }); e.target.value = ''; setMenuOpen(false) }}/></label>
  <button onClick={() => { setMenuOpen(false); perform(exportTree) }}><Download size={14}/>导出</button>
  <button disabled={busy} onClick={() => { setMenuOpen(false); perform(() => save(true)) }}><Copy size={14}/>另存</button>
          </div>}
        </div>
      </div>
    </div>
    {Object.keys(jsonErrors).length > 0 && <div className="bt-notice">JSON 草稿无效：保存、导出、校验和开始已暂停，请先修正标红的输入。</div>}
    {expanded ? <details className="bt-expanded-runtime"><summary>运行准备与实时状态 · {STATE[snapshot?.state] || '未运行'}（展开可绑定、启停）</summary>{runPanel}</details> : runPanel}
    <section className="bt-editor">
    <div className="bt-editor-heading">
    <button className="bt-editor-head" aria-expanded={editorOpen} onClick={() => { localStorage.setItem('bt.editorOpen', editorOpen ? '0' : '1'); setEditorOpen(!editorOpen) }}>
      <ChevronDown size={14} className={`bt-chev ${editorOpen ? '' : 'closed'}`}/>树编辑器<span className="bt-chip">{tree.nodes.length} 个节点</span>
      <span className="bt-editor-hint">{editorOpen ? '点击收起' : '已收起，点击展开'}</span>
    </button>
    {!expanded && <button className="bt-expand-editor" onClick={expandEditor}><Maximize size={14}/>新开页签放大编辑</button>}
    </div>
    <div className="bt-stage" hidden={!editorOpen}>
      <aside className="bt-rail">
        <div className="bt-rail-tabs" role="tablist">
          <button role="tab" aria-selected={sideTab === 'nodes'} className={sideTab === 'nodes' ? 'on' : ''} onClick={() => setSideTab('nodes')}>节点库<span>{catalog.length}</span></button>
          <button role="tab" aria-selected={sideTab === 'outline'} className={sideTab === 'outline' ? 'on' : ''} onClick={() => setSideTab('outline')}>大纲<span>{tree.nodes.length}</span></button>
        </div>
        {sideTab === 'nodes' ? <>
          <label className="bt-search"><Search size={14}/><input aria-label="搜索节点" placeholder="名称 / 标签" value={query} onChange={e => setQuery(e.target.value)}/></label>
          <div className="bt-library">
            {groups.map(group => <section className={`bt-group ${!query && folded.includes(group.kind) ? 'folded' : ''}`} data-kind={group.kind} key={group.kind}>
              <h4><button className="bt-group-head" aria-expanded={!!query || !folded.includes(group.kind)} onClick={() => toggleGroup(group.kind)}><ChevronDown size={12} className="bt-chev"/><i/>{nodeKindLabel(group.kind)}<span>{group.items.length}</span></button></h4>
              {(query || !folded.includes(group.kind)) && group.items.map(d => <button className="bt-lib-item" key={d.id} title={`${d.id} · ${cancelModeLabel(d.cancelMode)}${d.sideEffect && d.sideEffect !== 'none' ? ` · ${sideEffectLabel(d.sideEffect)}` : ''}`} onClick={() => addFromCatalog(d)}>
                <span className="bt-lib-name">{d.name}</span>{d.sideEffect && d.sideEffect !== 'none' && <em className="bt-fx-tag">{fxTag(d.sideEffect)}</em>}<Plus size={13}/>
              </button>)}
            </section>)}
            {!groups.length && <p className="bt-muted bt-pad">{catalog.length ? '没有匹配的节点' : '节点目录加载中…'}</p>}
          </div>
        </> : <div className="bt-outline">
          {!tree.nodes.length && <p className="bt-muted bt-pad">还没有节点</p>}
          {outline(tree).map(({ node: n, depth }) => <button key={n.id} data-kind={definition[n.type]?.kind || 'unknown'} className={selected === n.id ? 'selected' : ''} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setSelected(n.id)}>
            <i/><span>{definition[n.type]?.name || n.type}</span>{n.id === tree.root && <em className="bt-root-mark">ROOT</em>}<small>{n.children.length ? `${n.children.length} 子节点` : ''}</small>
          </button>)}
        </div>}
      </aside>
      <main className="bt-center">
        <div className="bt-canvas-wrap">
          <div ref={canvasRef} tabIndex={0} aria-label="编辑树画布" className={`bt-canvas ${edgeFrom ? 'linking' : ''}`} {...viewport.handlers} onPointerMove={e => { viewport.handlers.onPointerMove(e); if (drag.current) { const { id, x, y, original } = drag.current; setLayout(old => ({ ...old, [id]: { x: Math.max(0, Math.round((original.x + (e.clientX - x) / zoom) / 10) * 10), y: Math.max(0, Math.round((original.y + (e.clientY - y) / zoom) / 10) * 10) } })); setDirty(true) } }} onPointerUp={() => { drag.current = null; viewport.handlers.onPointerUp() }} onPointerCancel={() => { drag.current = null; viewport.handlers.onPointerCancel() }}>
            {editorGraph}
          </div>
          {!tree.nodes.length && <div className="bt-empty"><Workflow size={30}/><b>画布还是空的</b><span>从左侧节点库点一个节点作为根节点，或在上方打开预设。</span></div>}
          <div className="bt-hud bt-hud-tl">
            <button onClick={() => { setLayout(treeLayout(tree)); setDirty(true) }}><LayoutGrid size={13}/>自动布局</button>
            {edgeFrom
              ? <span className="bt-pill live">选择要连接的子节点 · Esc 取消<button className="bt-icon-btn" aria-label="取消连接" onClick={() => setEdgeFrom('')}><X size={12}/></button></span>
              : <span className="bt-pill">滚轮缩放 · 拖动空白平移 · 输出端连线</span>}
          </div>
          <ViewportTools viewport={viewport}/>
        </div>
      </main>
      <aside className="bt-inspector">
        <div className="bt-pane-title">节点属性</div>
        {node ? <>
          <header className="bt-insp-head" data-kind={spec?.kind || 'unknown'}>
            <span className="bt-kind-tag">{nodeKindLabel(spec?.kind)}</span>
            <strong>{spec?.name || node.type}</strong>
            <small>{sideEffectLabel(spec?.sideEffect)}</small>
          </header>
          {!spec && <p className="bt-error">未知节点无损保留，不能运行。</p>}
          <div className="bt-row"><button disabled={selected === tree.root} onClick={() => edit({ ...tree, root: selected })}>设为根</button><button className="bt-danger" onClick={() => removeById(selected)}><Trash2 size={14}/>删除节点</button></div>
          <section className="bt-section"><h5>结构</h5>
            <label className="bt-field">父节点<select value={parentOf} onChange={e => { try { edit(e.target.value ? connectNode(tree, e.target.value, selected) : { ...tree, nodes: tree.nodes.map(n => ({ ...n, children: n.children.filter(id => id !== selected) })) }) } catch (e) { toast.error(e.message) } }}><option value="">未连接 / 根</option>{tree.nodes.filter(n => n.id !== selected && definition[n.type]?.maxChildren > 0).map(n => <option key={n.id} value={n.id}>{definition[n.type]?.name} · {n.id.slice(0, 8)}</option>)}</select></label>
            {node.children.length > 0 && <div className="bt-children">{node.children.map((id, index) => <div className="bt-child" key={id}><b>{index + 1}</b><span>{definition[tree.nodes.find(n => n.id === id)?.type]?.name || id}</span><button className="bt-icon-btn" aria-label="上移" disabled={!index} onClick={() => reorderChild(index, -1)}><ChevronUp size={13}/></button><button className="bt-icon-btn" aria-label="下移" disabled={index === node.children.length - 1} onClick={() => reorderChild(index, 1)}><ChevronDown size={13}/></button></div>)}</div>}
          </section>
          <section className="bt-section"><h5>参数</h5>
            {!Object.keys(spec?.params?.properties || {}).length && <p className="bt-muted">这个节点没有参数。</p>}
            {Object.entries(spec?.params?.properties || {}).map(([key, schema]) => { const requirement = spec.roles?.find(r => r.parameter === key), value = node.params[key]; return <label className={`bt-field ${schema.type === 'boolean' && !requirement ? 'inline' : ''}`} key={key}>{paramLabel(key, schema)}{spec.params.required?.includes(key) ? ' *' : ''}{requirement ? <><select value={value || ''} onChange={e => patchParams(key, e.target.value)}><option value="">选择目标槽</option>{Object.entries(tree.roles).filter(([, r]) => r.kind === requirement.kind).map(([name]) => <option key={name} value={name}>{kindLabel(requirement.kind)} · {name}</option>)}</select><button onClick={() => addRole(requirement)}><Plus size={13}/>新增一个「{kindLabel(requirement.kind)}」目标槽</button></> : schema.enum ? <select value={value ?? ''} onChange={e => patchParams(key, schema.enum.find(v => String(v) === e.target.value))}><option value="">请选择</option>{schema.enum.map(v => <option key={String(v)} value={String(v)}>{enumLabel(key, v)}</option>)}</select> : schema.type === 'boolean' ? <input type="checkbox" checked={value ?? false} onChange={e => patchParams(key, e.target.checked)}/> : ['number', 'integer'].includes(schema.type) ? <input type="number" step={schema.type === 'integer' ? 1 : 'any'} min={schema.minimum} max={schema.maximum} value={value ?? ''} onChange={e => patchParams(key, e.target.value === '' ? undefined : Number(e.target.value))}/> : schema.type === 'string' ? <input value={value ?? ''} onChange={e => patchParams(key, e.target.value)}/> : <JsonField key={JSON.stringify([node.id, key])} value={value} draft={jsonDrafts[JSON.stringify([node.id, key])]} onDraftChange={text => changeJsonDraft(JSON.stringify([node.id, key]), text, schema, v => patchParams(key, v))} label={`${paramLabel(key, schema)}（JSON）`}/>}{(schema.description || rangeHint(schema)) && <small>{schema.description || rangeHint(schema)}</small>}</label> })}
            {parameterErrors(node.params, spec?.params).map(error => <p className="bt-error" key={error}>{error}</p>)}
          </section>
          <details className="bt-details"><summary>技术信息</summary><small>节点 ID {node.id}<br/>版本 v{node.version} · {cancelModeLabel(spec?.cancelMode)}</small></details>
        </> : <div className="bt-insp-empty"><MousePointerClick size={24}/><b>还没有选中节点</b><span>点击画布或大纲里的节点，在这里编辑它的参数和连接。</span></div>}
        <section className="bt-section bt-tree-section"><h5>整棵树</h5>
          <details className="bt-details"><summary>初始黑板（JSON，可编辑）</summary><JsonField key={tree.id} value={tree.blackboard} draft={jsonDrafts.blackboard} onDraftChange={text => changeJsonDraft('blackboard', text, { type: 'object' }, blackboard => edit({ ...tree, blackboard }))} label="黑板 JSON"/></details>
          <button disabled={busy} onClick={() => perform(check)}><ShieldCheck size={14}/>校验完整树</button>
          {validation && <div className={validation.ok ? 'bt-valid' : 'bt-error'}>{validation.ok ? '树结构与参数校验通过' : validation.errors.map((e, i) => <p key={i}>{e.path}：{e.message}</p>)}</div>}
        </section>
      </aside>
    </div>
    </section>
    {importDraft && <div className="bt-modal"><div className="bt-modal-card"><h3>导入预览：{importDraft.preset.name}</h3><p>{importDraft.preset.tree.nodes?.length} 节点 · {importDraft.validation.ok ? '校验通过' : '草稿有问题，保存后仍需修正才能运行'}</p>{importDraft.validation.errors?.length > 0 && <pre>{JSON.stringify(importDraft.validation.errors, null, 2)}</pre>}<details className="bt-details"><summary>树数据（高级）</summary><pre>{JSON.stringify(importDraft.preset.tree, null, 2)}</pre></details><div className="bt-modal-actions"><button onClick={() => setImportDraft(null)}>取消</button>{[['error', '导入'], ['copy', '另存副本'], ['overwrite', '明确覆盖']].map(([conflict, label]) => <button key={conflict} className={conflict === 'error' ? 'bt-primary' : ''} disabled={busy} onClick={() => perform(async () => { const saved = await request('/presets/import', { preset: importDraft.preset, conflict }); await loadPresets(); loadPreset(saved); setImportDraft(null) })}>{label}</button>)}</div></div></div>}
  </div>
}

// 全局GM日志/时钟更新不必重绘整棵编辑树；这里仅消费客户端身份与在线状态。
export default memo(BehaviorTree, (a, b) => a.selectedClient?.id === b.selectedClient?.id && a.selectedClient?.online === b.selectedClient?.online && a.broadcastMode === b.broadcastMode && a.active === b.active && a.expanded === b.expanded && a.draftKey === b.draftKey)
