import { memo, useId, useMemo, useRef, useState } from 'react'
import { fitText, nodeKindLabel, treeLayout } from '../utils/behaviorTree'
import useTreeViewport from '../utils/useTreeViewport'
import ViewportTools from './BehaviorTreeViewport'

const W = 190, H = 65

const RunNode = memo(function RunNode({ node, position, spec, state, label, clipId, selected, onSelect }) {
  const name = spec?.name || node.type
  return <g transform={`translate(${position.x},${position.y})`} data-kind={spec?.kind || 'unknown'} className={`bt-node ${state} ${selected ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`${name}：${label}`} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter') onSelect(node.id) }}>
    <title>{name} · {node.id}</title>
    <rect className="bt-node-card" width={W} height={H} rx="10" />
    <g clipPath={`url(#${clipId})`}><rect className="bt-node-bar" width="6" height={H} /></g>
    <text className="bt-node-kind" x="17" y="19">{spec ? nodeKindLabel(spec.kind) : '未知版本'}</text>
    <text className="bt-node-name" x="17" y="40">{fitText(name, 10.5)}</text>
    <text className="bt-node-state" x="17" y="56">{label}</text>
  </g>
})

// 状态变化只更新对应节点；布局和连线沿用同一棵实际运行树。
export default function RuntimeTree({ tree, definition, snapshot, labels, enlarged = false }) {
  const canvasRef = useRef(null), clipId = `bt-run-${useId().replace(/:/g, '')}`
  const [selected, setSelected] = useState('')
  const positions = useMemo(() => treeLayout(tree), [tree])
  const width = Math.max(240, ...Object.values(positions).map(p => p.x + W + 30))
  const height = Math.max(100, ...Object.values(positions).map(p => p.y + H + 30))
  const viewport = useTreeViewport(canvasRef, width, height)
  const edges = useMemo(() => tree.nodes.flatMap(node => node.children.map(id => {
    const a = positions[node.id], b = positions[id]
    if (!a || !b) return null
    const sx = a.x + W, sy = a.y + H / 2, ex = b.x, ey = b.y + H / 2, bend = Math.max(36, Math.abs(ex - sx) / 2)
    return <path key={`${node.id}-${id}`} className="bt-edge" d={`M ${sx} ${sy} C ${sx + bend} ${sy}, ${ex - bend} ${ey}, ${ex} ${ey}`} />
  })), [tree, positions])
  const node = tree.nodes.find(item => item.id === selected)
  return <div className={`bt-runtime-graph ${enlarged ? 'enlarged' : ''}`}>
    <div className="bt-canvas-wrap">
      <div ref={canvasRef} className="bt-canvas bt-runtime-view" tabIndex={0} aria-label="运行树画布" {...viewport.handlers}>
        <svg aria-label="运行树只读图" role="img" width={width * viewport.zoom} height={height * viewport.zoom}>
          <defs><clipPath id={clipId}><rect width={W} height={H} rx="10" /></clipPath></defs>
          <g transform={`scale(${viewport.zoom})`}>
            {edges}
            {tree.nodes.map(node => { const state = snapshot.nodes?.[node.id] || ''; return <RunNode key={node.id} node={node} position={positions[node.id]} spec={definition[node.type]} state={state} label={labels[state] || state || '尚未执行'} clipId={clipId} selected={node.id === selected} onSelect={setSelected}/> })}
          </g>
        </svg>
      </div>
      <span className="bt-hud bt-hud-tl bt-pill">滚轮缩放 · 拖动空白平移 · 点击节点查看</span>
      <ViewportTools viewport={viewport}/>
    </div>
    {node && <div className="bt-runtime-selection"><b>{definition[node.type]?.name || node.type}</b><span>{labels[snapshot.nodes?.[node.id]] || snapshot.nodes?.[node.id] || '尚未执行'}</span><small>{node.id} · v{node.version}</small><pre>{JSON.stringify(node.params, null, 2)}</pre></div>}
  </div>
}
