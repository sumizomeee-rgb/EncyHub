import { useState } from 'react'
import RuntimeTree from './BehaviorTreeRuntime'
import RuntimeViewer from './BehaviorTreeViewer'
import { Check, Maximize, Play, RefreshCw, Search, Square } from 'lucide-react'
import { capabilityLabel, kindLabel, objectLocation, outline, reasonText, runEffects, slotTitle, targetFit } from '../utils/behaviorTree'

export const STATE = { running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', stopped: '已停止', error: '出错', awaiting_decision: '等待你判断', unknown: '状态未知', idle: '未运行' }
const MAX_LISTED = 8

function Chip({ tone = 'plain', children, title }) {
  return <span className={`bt-chip ${tone}`} title={title}>{children}</span>
}

function TargetCard({ object, fit, selected, health, onChoose, showKind = false }) {
  const usable = fit ? fit.usable : true
  const tone = !usable ? 'bad' : object.controllable ? 'good' : 'warn'
  const label = !usable ? '不可用' : object.controllable ? '可控制' : '只读'
  const staleHealth = health && health.level !== 'ok'
  return <div className={`bt-target ${usable ? '' : 'off'} ${selected ? 'selected' : ''} ${staleHealth ? 'broken' : ''}`}>
    <div className="bt-target-main">
      <b>{object.name}</b>
      {showKind && <Chip>{kindLabel(object.token?.kind)}</Chip>}
      <Chip tone={staleHealth ? 'bad' : tone} title={object.controllable ? '调试可操作：节点可以改变游戏状态' : '只能读取，不能控制'}>{staleHealth ? '需处理' : label}</Chip>
    </div>
    <small>{objectLocation(object)} · {object.token?.id} · {(object.capabilities || []).map(capabilityLabel).join('、') || '无可用能力'}</small>
    {!usable && fit.reasons.map(reason => <small className="bt-why" key={reason}>{reason}</small>)}
    {staleHealth && <small className="bt-why">{health.text}</small>}
    {onChoose && usable && !selected && <button className="bt-pick" onClick={onChoose}>选用</button>}
  </div>
}

function Finder({ kind, info, hasCandidates, online, busy, searchText, onSearchText, selector, onDiscover }) {
  const isFight = kind === 'fight'
  const submitSearch = () => { if (searchText.trim()) onDiscover('gameobject', searchText.trim()) }
  return <>
    {isFight
      ? <div className="bt-finder"><button className="bt-find" disabled={!online || busy} onClick={() => onDiscover('fight')}><RefreshCw size={13} />{info ? '刷新当前玩家' : '发现当前玩家'}</button>
</div>
      : <div className="bt-finder"><input aria-label="对象名称" placeholder={selector?.name ? `预设记录的对象：${selector.name}` : '输入对象名称，如 EncyBT_SafeProbe'} value={searchText} onChange={event => onSearchText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') submitSearch() }} />
        <button className="bt-find" disabled={!online || busy || !searchText.trim()} onClick={submitSearch}><Search size={13} />搜索</button></div>}
    {online && info && !hasCandidates && <small className="bt-why">{isFight ? '没有发现战斗玩家。请先在游戏里进入战斗，等战斗加载完成后再点刷新。' : `没有找到名称包含「${info.query}」的对象，换个名称试试。`}</small>}
  </>
}

function Browse({ objects, discovered, searchText, onSearchText, online, busy, onDiscover }) {
  const [kind, setKind] = useState('fight')
  const list = objects.filter(object => object.token?.kind === kind)
  return <div className="bt-slot bt-browse">
    <div className="bt-seg">{['fight', 'gameobject'].map(item => <button key={item} className={kind === item ? 'bt-tab on' : 'bt-tab'} onClick={() => setKind(item)}>{kindLabel(item)}</button>)}</div>
    <Finder kind={kind} info={discovered[kind]} hasCandidates={list.length > 0} online={online} busy={busy} searchText={searchText} onSearchText={onSearchText} onDiscover={onDiscover} />
    {list.slice(0, MAX_LISTED).map(object => <TargetCard key={JSON.stringify(object.token)} object={object} showKind />)}
    {list.length > 0 && <small className="bt-muted">打开预设后，在对应位置选用。</small>}
  </div>
}

function SlotPicker({ slot, slots, boundObject, health, objects, discovered, searchText, onSearchText, selector, online, busy, locked, onDiscover, onChoose, onClear }) {
  const [forceOpen, setForceOpen] = useState(false)
  const title = slotTitle(slot, slots)
  const broken = boundObject && health.level !== 'ok'
  const open = !boundObject || broken || forceOpen
  const candidates = objects.filter(object => object.token?.kind === slot.kind && object.token?.id !== boundObject?.token?.id).map(object => ({ object, fit: targetFit(object, slot) }))
  const usable = candidates.filter(item => item.fit.usable).sort((a, b) => a.object.name.localeCompare(b.object.name))
  const unusable = candidates.filter(item => !item.fit.usable)
  const info = discovered[slot.kind]
  return <div className={`bt-slot ${broken ? 'broken' : ''}`}>
    <div className="bt-slot-head">
      <b>{title}</b>
      <small>{slot.nodes.length ? `用于：${[...new Set(slot.nodes.map(node => node.name))].join('、')}` : '树里暂无节点使用'}{slot.requirements.length ? ` · 需要：${slot.requirements.map(capabilityLabel).join('、')}` : ''}</small>
    </div>
    {boundObject && <TargetCard object={boundObject} selected health={broken ? health : null} />}
    {boundObject && !locked && <div className="bt-row"><button onClick={() => setForceOpen(!forceOpen)}>{open ? '收起候选' : '更换目标'}</button><button onClick={onClear}>取消选择</button>{!open && <button disabled={!online || busy} title="重新读取这个目标当前的能力。游戏停在暂停菜单时不要点，否则会被读成只读" onClick={() => onDiscover(slot.kind, slot.kind === 'gameobject' ? boundObject.name : '')}><RefreshCw size={13} />重新读取状态</button>}</div>}
    {boundObject && locked && <small className="bt-muted">运行中不能更换目标，请先停止。</small>}
    {open && !locked && <div className="bt-picker">
      <Finder kind={slot.kind} info={info} hasCandidates={objects.some(object => object.token?.kind === slot.kind)} online={online} busy={busy} searchText={searchText} onSearchText={onSearchText} selector={selector} onDiscover={onDiscover} />
      {usable.slice(0, MAX_LISTED).map(item => <TargetCard key={JSON.stringify(item.object.token)} object={item.object} fit={item.fit} onChoose={() => { onChoose(item.object); setForceOpen(false) }} />)}
      {usable.length > MAX_LISTED && <small className="bt-muted">还有 {usable.length - MAX_LISTED} 个可用对象，输入更具体的名称缩小范围。</small>}
      {unusable.length > 0 && (usable.length || boundObject
        ? <details className="bt-more"><summary>另有 {unusable.length} 个不可用目标</summary>{unusable.slice(0, MAX_LISTED).map(item => <TargetCard key={JSON.stringify(item.object.token)} object={item.object} fit={item.fit} />)}</details>
        : unusable.slice(0, MAX_LISTED).map(item => <TargetCard key={JSON.stringify(item.object.token)} object={item.object} fit={item.fit} />))}
    </div>}
  </div>
}

function LazyDetails({ title, className = 'bt-details', onOpen, children }) {
  const [open, setOpen] = useState(false)
  return <details className={className} onToggle={event => { const next = event.currentTarget.open; setOpen(next); onOpen?.(next) }}><summary>{title}</summary>{open && children()}</details>
}

function Observation({ tree, definition, snapshot }) {
  const cleanup = snapshot.cleanupErrors || []
  return <div className="bt-observation">
    {snapshot.reason && <p className={`bt-hint ${snapshot.state === 'unknown' || snapshot.state === 'awaiting_decision' ? 'warn' : ''}`}>{reasonText(snapshot.reason)}</p>}
    {snapshot.state === 'failed' && <p className="bt-hint warn">有节点失败。若是普攻类节点：游戏停在暂停菜单、未处于战斗中或角色倒下时会失败；回到战斗后再开始。</p>}
    {cleanup.length > 0 && <p className="bt-hint bad">清理出现问题：{cleanup.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('；')}</p>}
    {snapshot.nodes && <LazyDetails title={`逐节点状态（${tree.nodes.length}）`}>{() => <ul className="bt-node-states">{outline(tree).map(({ node, depth }) => <li key={node.id} style={{ paddingLeft: depth * 16 }}><span>{definition[node.type]?.name || node.type}</span><Chip tone={snapshot.nodes[node.id] === 'succeeded' ? 'good' : snapshot.nodes[node.id] === 'running' ? 'info' : snapshot.nodes[node.id] ? 'bad' : 'plain'}>{STATE[snapshot.nodes[node.id]] || snapshot.nodes[node.id] || '尚未执行'}</Chip></li>)}</ul>}</LazyDetails>}
  </div>
}

export default function RunPanel(props) {
  const [viewingRun, setViewingRun] = useState(null)
  const { selectedClient, online, broadcastMode, tree, slots, definition, objects, bound, health, discovered, searchText, onSearchText, selectors, busy, running, locked, snapshot, observe, onObserve, blockers, effects, confirming, onConfirm, onStart, onStop, onQuery, onDiscover, onChoose, onClear, onBindSelectors, sessionId, lastError, notice, onDismissNotice, blockerNotes, runMode, onRunMode, maxRunSeconds, onMaxRunSeconds, onDiagnosticsOpen } = props
  const clientText = broadcastMode ? '行为树不支持广播，请先选择单个客户端。'
    : !selectedClient ? '请先选择一个客户端。'
      : selectedClient.online === false ? '当前客户端已离线，运行需等它重新上线；仍可编辑。' : ''
  const slotsReady = slots.length > 0 && slots.every(slot => bound[slot.name] && health[slot.name]?.level === 'ok')
  const pendingSelectors = slots.some(slot => selectors[slot.name] && !bound[slot.name])
  const state = snapshot ? STATE[snapshot.state] || snapshot.state : STATE.idle
  const stateTone = snapshot?.state === 'running' ? 'info' : snapshot?.state === 'succeeded' ? 'good' : snapshot?.state === 'failed' || snapshot?.state === 'error' ? 'bad' : snapshot?.state === 'unknown' || snapshot?.state === 'awaiting_decision' ? 'warn' : 'plain'
  const displayedEffects = snapshot?.tree ? runEffects(snapshot.tree, definition) : effects
  const canStart = online && !busy && !running && blockers.length === 0
  return <section className="bt-run" aria-label="运行准备">
    {!online && <p className="bt-hint warn">{clientText}</p>}
    {notice && <p className="bt-hint bad" role="alert">{notice}<button className="bt-dismiss" onClick={onDismissNotice}>知道了</button></p>}
    <div className="bt-runbar">
      <div className="bt-run-status">
        <span className={`bt-state ${stateTone}`}><i />{state}</span>
        {(snapshot?.tree || tree.nodes.length > 0) && <Chip tone={displayedEffects.controls ? 'warn' : 'good'}>{displayedEffects.controls ? `会控制游戏：${displayedEffects.labels.join('、')}` : '只读观察'}</Chip>}
      </div>
      <div className="bt-actions">
        {running && snapshot?.runMode !== 'autonomous' && <label className="bt-observe" title="勾选后本页持续续租。没有任何页面或工具续租时，最后一次续租约30秒后，客户端停止本树并释放输入；其他端仍续租时，关闭本页不会停止。状态查询本身不续租。"><input type="checkbox" checked={observe} onChange={event => onObserve(event.target.checked)} />调试续租（断开约30秒停止）</label>}
        {confirming && <span className="bt-confirm">确认对「{slots.map(slot => bound[slot.name]?.name).filter(Boolean).join('、') || '游戏'}」开始？</span>}
        <button disabled={!online || busy} onClick={onQuery}>查询状态</button>
        <button className="bt-stop" disabled={!online || busy || !(running || snapshot?.state === 'unknown')} onClick={onStop}><Square size={12} fill="currentColor" />停止</button>
        {confirming
          ? <><button onClick={() => onConfirm(false)}>取消</button><button className="bt-primary" disabled={busy} onClick={onStart}><Play size={14} />确认开始</button></>
          : <button className="bt-primary" disabled={!canStart} onClick={() => effects.controls ? onConfirm(true) : onStart()}><Play size={14} />开始</button>}
      </div>
    </div>
    {!running && <div className="bt-run-options">
      <label>运行方式<select aria-label="运行方式" value={runMode} disabled={busy} onChange={e => onRunMode(e.target.value)}><option value="autonomous">自主运行（关闭网页仍继续）</option><option value="debug">联机调试（断联约30秒停止）</option></select></label>
      <label>最长运行（秒）<input aria-label="最长运行秒数" type="number" min="1" max="86400" value={maxRunSeconds} disabled={busy} onChange={e => onMaxRunSeconds(e.target.value)}/></label>
      <small>{runMode === 'autonomous' ? '树在客户端执行；关闭或刷新网页不会停止，重新打开可继续查看。' : '需要页面或工具续租；无人续租约30秒后停止。'}树结束、达到总时限或目标失效时停止。</small>
    </div>}
    {running && <small>{snapshot?.runMode === 'autonomous' ? '自主运行：关闭网页后继续。' : '联机调试：无人续租约30秒后停止。'}{snapshot?.maxRunSeconds && ` 本次最长${snapshot.maxRunSeconds}秒。`}</small>}
    {((effects.input && !running) || (!canStart && !running && blockerNotes.length > 0)) && <div className="bt-notes">
      {effects.input && !running && <small>普攻需要战斗进行中：停在暂停菜单时，先关闭暂停再开始。</small>}
      {!canStart && !running && blockerNotes.length > 0 && <small className="bt-block">还不能开始：{blockerNotes.join('；')}</small>}
    </div>}
    <div className="bt-targets">
      <div className="bt-targets-head">
        <h4>可执行目标</h4>
        {slotsReady && <Chip tone="good"><Check size={11} />已就绪</Chip>}
        {pendingSelectors && online && !locked && <button disabled={busy} onClick={onBindSelectors}>按预设记录自动匹配</button>}
      </div>
      {!slots.length
        ? (tree.nodes.length ? <p className="bt-muted">这棵树不需要游戏里的目标，可直接开始。</p>
          : <Browse objects={objects} discovered={discovered} searchText={searchText} onSearchText={onSearchText} online={online} busy={busy} onDiscover={onDiscover} />)
        : <div className="bt-slots">{slots.map(slot => <SlotPicker key={slot.name} slot={slot} slots={slots} boundObject={bound[slot.name]} health={health[slot.name] || { level: 'ok' }} objects={objects} discovered={discovered} searchText={searchText} onSearchText={onSearchText} selector={selectors[slot.name]} online={online} busy={busy} locked={locked} onDiscover={onDiscover} onChoose={object => onChoose(slot.name, object)} onClear={() => onClear(slot.name)} />)}</div>}
    </div>
    {snapshot && <section aria-label="客户端实际运行树">
      <div className="bt-runtime-heading"><h4>游戏里的运行情况：{snapshot.tree?.name || snapshot.treeId}</h4>{snapshot.tree && <button className="bt-view-runtime" onClick={() => setViewingRun(snapshot.runId)}><Maximize size={14}/>放大查看运行树</button>}</div>
      <p className="bt-muted">{running ? (snapshot.runMode === 'autonomous' ? '客户端独立执行；本页仅查看，关闭后可重新打开查看同一次运行。' : observe ? '本页正在续租；树仍会按自身的结束条件停止。' : '本页只查看、不续租；没有其他页面或工具续租时，约30秒后自动停止。') : ''}这是游戏里实际运行的那一份树，和下方编辑器里的草稿互不影响。</p>
      {snapshot.tree ? <>{viewingRun === snapshot.runId ? <RuntimeViewer snapshot={snapshot} definition={definition} labels={STATE} onClose={() => setViewingRun(null)}/> : <RuntimeTree key={snapshot.runId} tree={snapshot.tree} definition={definition} snapshot={snapshot} labels={STATE} />}<Observation tree={snapshot.tree} definition={definition} snapshot={snapshot} /></>
        : <p className="bt-hint warn">客户端未返回实际树，请更新游戏内行为树运行器后查看；不会用同名预设代替。</p>}
    </section>}
    <LazyDetails className="bt-adv" title="高级诊断" onOpen={onDiagnosticsOpen}>{() => <>
      <div className="bt-adv-grid">
        <small>会话：{sessionId || '尚未连接游戏'}</small>
        <small>运行 ID：{snapshot?.runId || '无'}</small>
        {lastError && <small>最近一次错误原文：{lastError}</small>}
      </div>
      <h5>已选目标完整身份</h5><pre>{JSON.stringify(Object.fromEntries(Object.entries(bound).map(([role, object]) => [role, object.token])), null, 2)}</pre>
      {snapshot && <><h5>黑板</h5><pre>{JSON.stringify(snapshot.blackboard, null, 2)}</pre><h5>节点与事件</h5><pre>{JSON.stringify({ nodes: snapshot.nodes, events: snapshot.events, cleanupErrors: snapshot.cleanupErrors }, null, 2)}</pre></>}
    </>}</LazyDetails>
  </section>
}
