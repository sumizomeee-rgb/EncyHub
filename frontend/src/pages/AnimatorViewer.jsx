import { useState, useEffect, useRef, useCallback } from 'react'
import { Activity, RefreshCw, Trash2, Play, ChevronRight } from 'lucide-react'

export default function AnimatorViewer({ clients, selectedClient, broadcastMode }) {
  const [animators, setAnimators] = useState([])
  const [selectedAnimator, setSelectedAnimator] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [stateHistory, setStateHistory] = useState([])
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [paramSearch, setParamSearch] = useState('')

  const wsRef = useRef(null)
  const historyRef = useRef([])

  const fetchAnimators = useCallback(async () => {
    if (!selectedClient) return
    try {
      const res = await fetch(`/api/gm_console/animators/${selectedClient.id}`)
      if (res.ok) {
        const data = await res.json()
        setAnimators(data.animators || [])
      }
    } catch (e) {
      console.error('Failed to fetch animators:', e)
    }
  }, [selectedClient])

  const subscribe = useCallback(async (animatorId) => {
    if (!selectedClient) return
    if (selectedAnimator) {
      await fetch(`/api/gm_console/animators/${selectedClient.id}/unsubscribe`, { method: 'POST' })
    }
    await fetch(`/api/gm_console/animators/${selectedClient.id}/subscribe/${animatorId}`, { method: 'POST' })
    setSelectedAnimator(animatorId)
    setSnapshot(null)
    historyRef.current = []
    setStateHistory([])
  }, [selectedClient, selectedAnimator])

  const unsubscribe = useCallback(async () => {
    if (!selectedClient) return
    await fetch(`/api/gm_console/animators/${selectedClient.id}/unsubscribe`, { method: 'POST' })
    setSelectedAnimator(null)
    setSnapshot(null)
  }, [selectedClient])

  const setParam = useCallback(async (paramName, paramType, value) => {
    if (!selectedClient || !selectedAnimator) return
    const body = {
      paramName,
      paramType,
      floatValue: paramType === 'Float' ? value : 0,
      intValue: paramType === 'Int' ? value : 0,
      boolValue: paramType === 'Bool' || paramType === 'Trigger' ? value : false,
    }
    await fetch(`/api/gm_console/animators/${selectedClient.id}/set-param/${selectedAnimator}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }, [selectedClient, selectedAnimator])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/gm_console/ws/animator`

    const connect = () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => setWsStatus('connected')

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'animator_data') {
            setSnapshot(data.snapshot)
            if (data.stateChanges && data.stateChanges.length > 0) {
              historyRef.current = [...historyRef.current, ...data.stateChanges].slice(-50)
              setStateHistory([...historyRef.current])
            }
          } else if (data.type === 'animator_removed') {
            if (data.animatorId === selectedAnimator) {
              setSelectedAnimator(null)
              setSnapshot(null)
            }
            setAnimators(prev => prev.filter(a => a.id !== data.animatorId))
          } else if (data.type === 'animator_list') {
            setAnimators(data.animators || [])
          }
        } catch (e) {
          console.error('WS parse error:', e)
        }
      }

      ws.onclose = () => {
        setWsStatus('disconnected')
        setTimeout(connect, 3000)
      }

      ws.onerror = () => ws.close()
    }

    connect()

    const heartbeat = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('ping')
      }
    }, 30000)

    return () => {
      clearInterval(heartbeat)
      wsRef.current?.close()
    }
  }, [selectedAnimator])

  useEffect(() => {
    fetchAnimators()
    return () => { unsubscribe() }
  }, [selectedClient])

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Selector Bar */}
      <div className="flex items-center gap-3 p-3 bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)]">
        <Activity size={16} className="text-[var(--coffee-accent)]" />
        <select
          className="px-2 py-1 rounded text-sm bg-[var(--coffee-bg)] border border-[var(--coffee-border)]"
          value={selectedAnimator || ''}
          onChange={e => {
            const id = parseInt(e.target.value)
            if (id) subscribe(id)
          }}
        >
          <option value="">-- Select Animator --</option>
          {animators.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.controllerName})</option>
          ))}
        </select>
        <button onClick={fetchAnimators} className="p-1 hover:bg-[var(--coffee-hover)] rounded" title="Refresh">
          <RefreshCw size={14} />
        </button>
        <div className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
          wsStatus === 'connected' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
        }`}>
          {wsStatus}
        </div>
      </div>

      {!selectedAnimator ? (
        <div className="flex-1 flex items-center justify-center text-[var(--coffee-muted)] text-sm">
          {selectedClient ? 'Select an Animator to start monitoring' : 'Select a game client first'}
        </div>
      ) : !snapshot ? (
        <div className="flex-1 flex items-center justify-center text-[var(--coffee-muted)] text-sm">
          Waiting for data...
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-3 overflow-auto">
          <LayerDashboard snapshot={snapshot} />
          <ParameterPanel
            parameters={snapshot.parameters}
            search={paramSearch}
            onSearchChange={setParamSearch}
            onSetParam={setParam}
          />
          <StateHistoryPanel
            history={stateHistory}
            onClear={() => { historyRef.current = []; setStateHistory([]) }}
          />
        </div>
      )}
    </div>
  )
}

function LayerDashboard({ snapshot }) {
  const [activeLayer, setActiveLayer] = useState(0)

  if (!snapshot?.layers?.length) return null
  const layer = snapshot.layers[Math.min(activeLayer, snapshot.layers.length - 1)]

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      <div className="flex gap-1 mb-3">
        {snapshot.layers.map((l, i) => (
          <button
            key={i}
            onClick={() => setActiveLayer(i)}
            className={`px-3 py-1 text-xs rounded-md transition-all ${
              activeLayer === i
                ? 'bg-[var(--coffee-accent)] text-white'
                : 'bg-[var(--coffee-hover)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
            }`}
          >
            {l.name} {l.weight < 1 ? `(${l.weight.toFixed(1)})` : ''}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <div className="p-2 rounded bg-blue-500/10 border border-blue-500/30">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="font-mono font-medium text-blue-300">{layer.currentState?.name || 'None'}</span>
          </div>
          <div className="text-xs text-[var(--coffee-muted)] mt-1 font-mono">
            Time: {((layer.currentState?.normalizedTime || 0) * (layer.currentState?.length || 0)).toFixed(2)}s / {(layer.currentState?.length || 0).toFixed(2)}s
            ({((layer.currentState?.normalizedTime || 0) * 100).toFixed(1)}%)
            &nbsp;&middot;&nbsp; Speed: {(layer.currentState?.speed || 0).toFixed(1)}x
            &nbsp;&middot;&nbsp; Loop: {layer.currentState?.isLooping ? 'Yes' : 'No'}
          </div>
        </div>

        {layer.transition?.isInTransition && (
          <div className="p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-yellow-300">{layer.transition.sourceName}</span>
              <ChevronRight size={14} className="text-yellow-400" />
              <span className="font-mono text-yellow-300">{layer.transition.targetName}</span>
            </div>
            <div className="mt-1.5 h-2 bg-[var(--coffee-bg)] rounded-full overflow-hidden">
              <div
                className="h-full bg-yellow-400 rounded-full transition-all"
                style={{ width: `${(layer.transition.normalizedTime * 100)}%` }}
              />
            </div>
            <div className="text-xs text-[var(--coffee-muted)] mt-1">
              {(layer.transition.normalizedTime * 100).toFixed(0)}% &middot; Duration: {(layer.transition.duration || 0).toFixed(3)}s
            </div>
          </div>
        )}

        {layer.currentClips?.length > 0 && (
          <div className="p-2 rounded bg-[var(--coffee-hover)]">
            {layer.currentClips.map((clip, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-[var(--coffee-deep)]">{clip.clipName}</span>
                <span className="text-[var(--coffee-muted)]">{(clip.clipLength || 0).toFixed(2)}s</span>
                {clip.clipWeight < 1 && <span className="text-[var(--coffee-muted)]">w:{(clip.clipWeight || 0).toFixed(2)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ParameterPanel({ parameters, search, onSearchChange, onSetParam }) {
  if (!parameters?.length) return null

  const filtered = parameters.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-[var(--coffee-deep)]">Parameters</span>
        <input
          type="text"
          placeholder="Filter..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="px-2 py-0.5 text-xs rounded bg-[var(--coffee-bg)] border border-[var(--coffee-border)] w-32"
        />
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {filtered.map(p => (
          <div key={p.name} className="flex items-center gap-2 text-xs py-0.5">
            <span className="w-28 truncate font-mono text-[var(--coffee-deep)]">{p.name}</span>
            <span className="w-10 text-[var(--coffee-muted)]">{p.type}</span>
            <div className="flex-1">
              {p.type === 'Float' && (
                <input
                  type="range"
                  min={-10} max={10} step={0.01}
                  value={p.floatValue}
                  onChange={e => onSetParam(p.name, 'Float', parseFloat(e.target.value))}
                  className="w-full h-1"
                />
              )}
              {p.type === 'Int' && (
                <input
                  type="number"
                  value={p.intValue}
                  onChange={e => onSetParam(p.name, 'Int', parseInt(e.target.value) || 0)}
                  className="w-16 px-1 py-0.5 rounded bg-[var(--coffee-bg)] border border-[var(--coffee-border)]"
                />
              )}
              {p.type === 'Bool' && (
                <button
                  onClick={() => onSetParam(p.name, 'Bool', !p.boolValue)}
                  className={`px-2 py-0.5 rounded text-xs ${
                    p.boolValue ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {p.boolValue ? 'true' : 'false'}
                </button>
              )}
              {p.type === 'Trigger' && (
                <button
                  onClick={() => onSetParam(p.name, 'Trigger', true)}
                  className="px-2 py-0.5 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                >
                  <Play size={10} className="inline" /> Fire
                </button>
              )}
            </div>
            {p.type === 'Float' && <span className="w-12 text-right font-mono text-[var(--coffee-muted)]">{(p.floatValue || 0).toFixed(2)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function StateHistoryPanel({ history, onClear }) {
  if (!history?.length) return null

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-[var(--coffee-deep)]">State History ({history.length})</span>
        <button onClick={onClear} className="p-1 hover:bg-[var(--coffee-hover)] rounded" title="Clear">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {[...history].reverse().map((h, i) => (
          <div key={i} className="flex items-center gap-2 text-xs font-mono py-0.5">
            <span className="w-12 text-[var(--coffee-muted)]">{(h.timestamp || 0).toFixed(1)}s</span>
            <span className="text-red-300">{h.fromState}</span>
            <ChevronRight size={10} className="text-[var(--coffee-muted)]" />
            <span className="text-green-300">{h.toState}</span>
            <span className="text-[var(--coffee-muted)] ml-auto">{h.layerName}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
