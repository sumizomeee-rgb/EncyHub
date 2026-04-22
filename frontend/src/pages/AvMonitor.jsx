import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Play, Square, RotateCw, ChevronDown, ChevronRight,
  Copy, Check, Loader2, Film, Music, Lock, VolumeX
} from 'lucide-react'
import { copyText } from '../utils/clipboard'

// ============================================================
// SliderWithDebounce
// ============================================================
function SliderWithDebounce({ value, min = 0, max = 1, step = 0.01, onChange, disabled, className }) {
  const [local, setLocal] = useState(value ?? 0)
  const timerRef = useRef(null)
  useEffect(() => { setLocal(value ?? 0) }, [value])
  return (
    <input type="range" min={min} max={max} step={step}
      value={local} disabled={disabled}
      onChange={e => {
        const v = parseFloat(e.target.value)
        setLocal(v)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => onChange(v), 120)
      }}
      className={`h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--caramel)] disabled:opacity-40 disabled:cursor-not-allowed ${className || ''}`}
    />
  )
}

function pct(v) { return v != null ? `${Math.round(v * 100)}%` : '--' }

// ============================================================
// VolumeRow
// ============================================================
function VolumeRow({ label, value, readOnly, aisacMuted, onAisacToggle, onChange }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="w-20 flex-shrink-0 text-[var(--coffee-muted)]">{label}</span>
      <div className="flex-1 flex items-center gap-2">
        {readOnly ? (
          <div className="flex-1 relative h-1.5 rounded-full overflow-hidden bg-[var(--glass-border)]">
            <div className="absolute left-0 top-0 h-full bg-[var(--coffee-muted)]/40 rounded-full"
              style={{ width: `${(value ?? 0) * 100}%` }} />
          </div>
        ) : (
          <SliderWithDebounce className="flex-1" value={value ?? 0} onChange={onChange} />
        )}
        <span className={`w-9 text-right font-mono text-[10px] flex-shrink-0 ${readOnly ? 'text-[var(--coffee-muted)] opacity-60' : 'text-[var(--coffee-deep)]'}`}>
          {pct(value)}{readOnly && <Lock size={8} className="inline ml-0.5 opacity-60" />}
        </span>
        {onAisacToggle && (
          <button onClick={onAisacToggle} title="Aisac Mute"
            className={`flex-shrink-0 p-0.5 rounded transition-colors ${aisacMuted ? 'bg-[var(--terracotta)] text-white' : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}>
            <VolumeX size={10} />
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================
// InfoRow (video detail)
// ============================================================
function InfoRow({ label, value }) {
  return (
    <div className="flex gap-1 pt-1 text-[10px]">
      <span className="text-[var(--coffee-muted)] flex-shrink-0">{label}:</span>
      <span className="text-[var(--coffee-deep)] truncate">{value != null && value !== '' ? String(value) : '--'}</span>
    </div>
  )
}

// ============================================================
// AudioTab
// ============================================================
function AudioTab({ audioSnap, copiedFile, expandedAudio, setExpandedAudio,
  cueQuery, setCueQuery, cueResult, cueLoading, criExpanded, setCriExpanded,
  handleCopy, setCatVol, setSecVol, toggleMasterMute, toggleAisacMute,
  toggleDebugFlag, queryCue, sendCmd }) {

  const bgm = audioSnap?.bgm
  const vols = audioSnap?.volumes
  const debugFlags = audioSnap?.debugFlags || {}

  const catLabels = [['music', 'Music'], ['sfx', 'SFX'], ['cv', 'CV']]
  const secLabels = [['music', '2nd Music'], ['sfx', '2nd SFX'], ['voice', '2nd Voice']]
  const debugFlagLabels = [
    ['logCollect', 'Log Collect'],
    ['playLog', 'Play Log'],
    ['stopLog', 'Stop Log'],
    ['componentLog', 'Component Log'],
    ['selectorLog', 'Selector Log'],
    ['aisacLog', 'Aisac Log'],
  ]

  return (
    <div className="space-y-3">
      {/* BGM Card */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="flex items-center gap-1.5 mb-2 font-semibold text-[var(--coffee-deep)]">
          <Music size={12} />当前 BGM
        </div>
        {!bgm ? (
          <div className="text-[var(--coffee-muted)]">-- 无播放 --</div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-[var(--coffee-deep)] truncate max-w-[200px]">{bgm.name || '--'}</span>
              <span className="text-[var(--coffee-muted)]">CueId: <span className="font-mono text-[var(--coffee-deep)]">{bgm.cueId ?? '--'}</span></span>
              {bgm.playType && <span className="text-[10px] px-1 rounded bg-[var(--caramel)]/15 text-[var(--caramel)]">{bgm.playType}</span>}
            </div>
            {bgm.acbPath && (
              <div className="flex items-center gap-1">
                <span className="text-[var(--coffee-muted)] w-8 flex-shrink-0">ACB</span>
                <button className={`flex items-center gap-1 transition-colors ${copiedFile === 'bgm_acb' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}
                  onClick={() => handleCopy(bgm.acbPath.split(/[/\\]/).pop(), 'bgm_acb')} title={bgm.acbPath}>
                  {copiedFile === 'bgm_acb' ? <Check size={10} /> : <Copy size={10} />}
                  <span className="truncate max-w-[280px]">…/{bgm.acbPath.split(/[/\\]/).pop()}</span>
                </button>
              </div>
            )}
            {bgm.awbPath && (
              <div className="flex items-center gap-1">
                <span className="text-[var(--coffee-muted)] w-8 flex-shrink-0">AWB</span>
                <button className={`flex items-center gap-1 transition-colors ${copiedFile === 'bgm_awb' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}
                  onClick={() => handleCopy(bgm.awbPath.split(/[/\\]/).pop(), 'bgm_awb')} title={bgm.awbPath}>
                  {copiedFile === 'bgm_awb' ? <Check size={10} /> : <Copy size={10} />}
                  <span className="truncate max-w-[280px]">…/{bgm.awbPath.split(/[/\\]/).pop()}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Volume Mixer */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">音量调节</div>

        {/* Master Mute — prominent full-width */}
        <button onClick={toggleMasterMute}
          className={`w-full mb-3 py-1.5 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${audioSnap?.masterMute
            ? 'bg-[var(--terracotta)] text-white'
            : 'bg-[var(--cream-warm)] text-[var(--coffee-deep)] hover:bg-[var(--caramel)]/15'}`}>
          <VolumeX size={12} />
          {audioSnap?.masterMute ? 'Master Mute: ON (DSP Snapshot 已生效)' : 'Master Mute: OFF — 点击静音'}
        </button>

        {/* Category volumes */}
        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mb-1.5">
          分类音量 (Category) <span className="normal-case font-normal">· Aisac Mute ⇒</span>
        </div>
        {catLabels.map(([key, label]) => (
          <VolumeRow key={key} label={label}
            value={vols?.category?.[key]}
            aisacMuted={audioSnap?.aisacMute?.[key]}
            onAisacToggle={() => toggleAisacMute(key)}
            onChange={v => setCatVol(key, v)}
          />
        ))}

        {/* Second / Aisac volumes */}
        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mt-3 mb-1.5">
          Aisac / 二次音量 (Second)
        </div>
        {secLabels.map(([key, label]) => (
          <VolumeRow key={key} label={label}
            value={vols?.second?.[key]}
            onChange={v => setSecVol(key, v)}
          />
        ))}

        {/* Source volumes — read-only */}
        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mt-3 mb-1.5 flex items-center gap-1">
          <Lock size={9} />Source 音量 (只读)
        </div>
        <VolumeRow label="Music Src" value={vols?.source?.music} readOnly />
        <VolumeRow label="Default Src" value={vols?.source?.default} readOnly />
      </section>

      {/* Active Audio List */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">
          活跃音频列表
          <span className="ml-1.5 text-[var(--coffee-muted)] font-normal">({audioSnap?.activeList?.length ?? 0})</span>
        </div>
        {!audioSnap?.activeList?.length ? (
          <div className="text-[var(--coffee-muted)]">暂无活跃音频</div>
        ) : (
          <div className="space-y-0.5">
            {audioSnap.activeList.map((item, i) => (
              <div key={i} className="rounded border border-[var(--glass-border)] bg-white/30 overflow-hidden">
                <button className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                  onClick={() => setExpandedAudio(expandedAudio === i ? null : i)}>
                  {expandedAudio === i ? <ChevronDown size={10} className="flex-shrink-0" /> : <ChevronRight size={10} className="flex-shrink-0" />}
                  <span className={`text-[10px] px-1 rounded flex-shrink-0 ${
                    item.playType === 'Music' ? 'bg-[var(--caramel)]/20 text-[var(--caramel)]'
                    : item.playType === 'SFX' ? 'bg-blue-100 text-blue-600'
                    : 'bg-purple-100 text-purple-600'}`}>
                    {item.playType}
                  </span>
                  <span className="font-medium truncate text-[var(--coffee-deep)]">{item.name}</span>
                  <span className="ml-auto text-[var(--coffee-muted)] flex-shrink-0">{pct(item.volume)}</span>
                  <span className={`text-[10px] flex-shrink-0 ${item.status === 'Playing' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)]'}`}>
                    {item.status}
                  </span>
                </button>
                {expandedAudio === i && (
                  <div className="px-3 pb-2 pt-1 space-y-1 border-t border-[var(--glass-border)] text-[var(--coffee-muted)]">
                    <div className="flex gap-2">
                      <span className="w-10 flex-shrink-0">CueId</span>
                      <span className="font-mono text-[var(--coffee-deep)]">{item.cueId ?? '--'}</span>
                    </div>
                    {item.acbPath && (
                      <div className="flex items-center gap-1">
                        <span className="w-10 flex-shrink-0">ACB</span>
                        <button className={`flex items-center gap-1 transition-colors ${copiedFile === `acb_${i}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`}
                          onClick={() => handleCopy(item.acbPath.split(/[/\\]/).pop(), `acb_${i}`)} title={item.acbPath}>
                          {copiedFile === `acb_${i}` ? <Check size={10} /> : <Copy size={10} />}
                          <span>…/{item.acbPath.split(/[/\\]/).pop()}</span>
                        </button>
                      </div>
                    )}
                    {item.awbPath && (
                      <div className="flex items-center gap-1">
                        <span className="w-10 flex-shrink-0">AWB</span>
                        <button className={`flex items-center gap-1 transition-colors ${copiedFile === `awb_${i}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`}
                          onClick={() => handleCopy(item.awbPath.split(/[/\\]/).pop(), `awb_${i}`)} title={item.awbPath}>
                          {copiedFile === `awb_${i}` ? <Check size={10} /> : <Copy size={10} />}
                          <span>…/{item.awbPath.split(/[/\\]/).pop()}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* CueId Query */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">CueId 精确查询</div>
        <div className="flex gap-1.5">
          <input type="number" value={cueQuery} onChange={e => setCueQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && queryCue()}
            placeholder="输入 CueId..."
            className="flex-1 px-2 py-1 rounded border border-[var(--glass-border)] bg-white/60 focus:outline-none focus:border-[var(--caramel)] font-mono appearance-none"
          />
          <button onClick={queryCue} disabled={!cueQuery.trim()}
            className="px-3 py-1 rounded bg-[var(--caramel)] text-white text-xs hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none transition-opacity flex items-center gap-1">
            {cueLoading ? <Loader2 size={12} className="animate-spin" /> : '查询'}
          </button>
        </div>
        {cueResult && !cueResult.error && (
          <div className="mt-2 p-2 rounded bg-[var(--cream-warm)]/60 border border-[var(--glass-border)] space-y-0.5 font-mono text-[10px]">
            {Object.entries(cueResult).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-[var(--coffee-muted)] w-28 flex-shrink-0">{k}</span>
                <span className="text-[var(--coffee-deep)] break-all">{String(v)}</span>
              </div>
            ))}
          </div>
        )}
        {cueResult?.error && (
          <div className="mt-2 text-[var(--terracotta)] text-[10px]">{cueResult.error}</div>
        )}
      </section>

      {/* Debug Flags */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">Debug 开关</div>
        <div className="grid grid-cols-2 gap-1.5">
          {debugFlagLabels.map(([flag, label]) => (
            <button key={flag} onClick={() => toggleDebugFlag(flag)}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded border transition-colors text-left ${debugFlags[flag]
                ? 'border-[var(--sage)] bg-[var(--sage)]/10 text-[var(--coffee-deep)]'
                : 'border-[var(--glass-border)] bg-white/30 text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${debugFlags[flag] ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/30'}`} />
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Quick Actions */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">快捷操作</div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => sendCmd('play_bgm')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--sage)]/15 text-[var(--coffee-deep)] hover:bg-[var(--sage)]/25 transition-colors">
            <Play size={11} />播放 BGM
          </button>
          <button onClick={() => sendCmd('stop_bgm')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--terracotta)]/10 text-[var(--coffee-deep)] hover:bg-[var(--terracotta)]/20 transition-colors">
            <Square size={11} />停止 BGM
          </button>
          <button onClick={() => sendCmd('reload_sound')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--cream-warm)] text-[var(--coffee-deep)] hover:bg-[var(--caramel)]/15 transition-colors">
            <RotateCw size={11} />重载音频
          </button>
        </div>
      </section>

      {/* CRI Stats (collapsible) */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 text-xs overflow-hidden">
        <button className="w-full flex items-center gap-1.5 px-3 py-2 hover:bg-[var(--cream-warm)]/50 transition-colors"
          onClick={() => setCriExpanded(v => !v)}>
          {criExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-semibold text-[var(--coffee-deep)]">CRI 资源指标</span>
          {audioSnap?.criStats && (
            <span className="ml-2 text-[var(--coffee-muted)]">
              Binds: {audioSnap.criStats.binds} &nbsp;/&nbsp; Loaders: {audioSnap.criStats.loaders}
            </span>
          )}
        </button>
        {criExpanded && audioSnap?.criStats && (
          <div className="px-4 pb-2 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-[var(--glass-border)]">
            {Object.entries(audioSnap.criStats).map(([k, v]) => (
              <div key={k} className="flex justify-between pt-1">
                <span className="text-[var(--coffee-muted)]">{k}</span>
                <span className="font-mono font-medium text-[var(--coffee-deep)]">{v}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ============================================================
// VideoTab
// ============================================================
function VideoTab({ videoSnap, selectedPlayer, setSelectedPlayer, eventLog, eventFilter, setEventFilter,
  seekInput, setSeekInput, handleSeek, videoCmd }) {

  const [leftWidth, setLeftWidth] = useState(200)
  const [moreInfoExpanded, setMoreInfoExpanded] = useState(false)
  const [speedLocal, setSpeedLocal] = useState(1)
  const isDragging = useRef(false)

  const players = videoSnap?.players || []
  const player = players.find(p => p.id === selectedPlayer)

  useEffect(() => {
    if (player?.speed != null) setSpeedLocal(player.speed)
  }, [player?.speed])

  const sortedPlayers = [...players].sort((a, b) => {
    if (a.status === 'Playing' && b.status !== 'Playing') return -1
    if (b.status === 'Playing' && a.status !== 'Playing') return 1
    return 0
  })

  const fmtTime = (s) => {
    if (s == null || isNaN(s)) return '--:--'
    const m = Math.floor(s / 60)
    const sec = String(Math.floor(s % 60)).padStart(2, '0')
    const ds = String(Math.floor((s % 1) * 10))
    return `${m}:${sec}.${ds}`
  }

  const progress = player?.totalTime > 0 ? (player.currentTime / player.totalTime) * 100 : 0

  return (
    <div className="flex flex-col gap-3">
      {/* Split panel */}
      <div className="flex rounded-lg border border-[var(--glass-border)] bg-white/30 overflow-hidden"
        style={{ minHeight: 360 }}
        onMouseMove={e => {
          if (!isDragging.current) return
          const r = e.currentTarget.getBoundingClientRect()
          setLeftWidth(Math.min(Math.max(e.clientX - r.left, 140), 340))
        }}
        onMouseUp={() => { isDragging.current = false }}
        onMouseLeave={() => { isDragging.current = false }}>

        {/* Left: Player list */}
        <div className="flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col" style={{ width: leftWidth }}>
          <div className="px-2 py-1.5 border-b border-[var(--glass-border)] text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide">
            Players ({players.length})
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 text-xs">
            {sortedPlayers.length === 0 ? (
              <div className="text-center text-[var(--coffee-muted)] py-6">暂无播放器</div>
            ) : sortedPlayers.map(p => (
              <button key={p.id} onClick={() => setSelectedPlayer(p.id)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition-colors ${selectedPlayer === p.id
                  ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]'
                  : 'hover:bg-[var(--cream-warm)]/60 text-[var(--coffee-deep)]'}`}>
                <Film size={11} className={`flex-shrink-0 ${p.status === 'Playing' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)] opacity-40'}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[11px] flex items-center gap-1">
                    {p.name || p.id}
                    {p.status === 'Playing' && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-semibold bg-[var(--sage)]/15 text-[var(--sage)]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
                        LIVE
                      </span>
                    )}
                  </div>
                  <div className={`text-[10px] ${p.status === 'Playing' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)]'}`}>
                    {p.status}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Drag handle */}
        <div className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
          onMouseDown={e => { e.preventDefault(); isDragging.current = true }} />

        {/* Right: Player detail */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-2.5 text-xs">
          {!selectedPlayer || !player ? (
            <div className="flex items-center justify-center h-40 text-[var(--coffee-muted)]">
              点击左侧选择播放器
            </div>
          ) : (
            <>
              {/* Status + progress */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${player.status === 'Playing'
                    ? 'bg-[var(--sage)]/20 text-[var(--sage)]'
                    : player.status === 'Paused' ? 'bg-[var(--amber)]/20 text-[var(--amber)]'
                    : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'}`}>
                    {player.status}
                  </span>
                  <span className="font-semibold text-[var(--coffee-deep)] truncate">{player.name || player.id}</span>
                </div>
                <div>
                  <div className="flex justify-between text-[var(--coffee-muted)] mb-0.5 font-mono text-[10px]">
                    <span>{fmtTime(player.currentTime)}</span>
                    <span>{fmtTime(player.totalTime)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--glass-border)] overflow-hidden">
                    <div className="h-full bg-[var(--caramel)] rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </div>

              {/* Controls */}
              <div className="flex gap-1.5 flex-wrap">
                {[
                  ['video_play',   <Play size={10} />,   '播放',  'bg-[var(--sage)]/15 hover:bg-[var(--sage)]/25'],
                  ['video_stop',   <Square size={10} />, '停止',  'bg-[var(--terracotta)]/10 hover:bg-[var(--terracotta)]/20'],
                  ['video_pause',  null,                 '暂停',  'bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15'],
                  ['video_resume', null,                 '继续',  'bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15'],
                ].map(([action, icon, label, cls]) => (
                  <button key={action} onClick={() => videoCmd(action)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[var(--coffee-deep)] transition-colors ${cls}`}>
                    {icon}{label}
                  </button>
                ))}
              </div>

              {/* Seek */}
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--coffee-muted)] flex-shrink-0">跳转 (s)</span>
                <input type="number" value={seekInput} onChange={e => setSeekInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSeek()}
                  step="0.1" placeholder="0.0"
                  className="w-20 px-2 py-0.5 rounded border border-[var(--glass-border)] bg-white/60 focus:outline-none focus:border-[var(--caramel)] font-mono text-center appearance-none"
                />
                <button onClick={handleSeek}
                  className="px-2 py-0.5 rounded bg-[var(--caramel)] text-white hover:opacity-90 transition-opacity">
                  跳转
                </button>
              </div>

              {/* Speed */}
              <div className="flex items-center gap-2">
                <span className="text-[var(--coffee-muted)] flex-shrink-0">速度</span>
                <SliderWithDebounce className="flex-1" value={speedLocal} min={0.1} max={3} step={0.1}
                  onChange={v => { setSpeedLocal(v); videoCmd('video_speed', { speed: v }) }} />
                <span className="font-mono text-[var(--coffee-deep)] w-8 text-right flex-shrink-0">
                  {speedLocal.toFixed(1)}x
                </span>
              </div>

              {/* More info (collapsible) */}
              <div className="rounded border border-[var(--glass-border)] overflow-hidden">
                <button className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[var(--cream-warm)]/50 transition-colors"
                  onClick={() => setMoreInfoExpanded(v => !v)}>
                  {moreInfoExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="font-semibold text-[var(--coffee-deep)]">更多信息</span>
                </button>
                {moreInfoExpanded && (
                  <div className="px-3 pb-2 grid grid-cols-2 gap-x-4 border-t border-[var(--glass-border)]">
                    <InfoRow label="Movie" value={player.movieName} />
                    <InfoRow label="Loop" value={player.isLoop != null ? (player.isLoop ? 'Yes' : 'No') : null} />
                    <InfoRow label="Speed" value={player.speed != null ? `${player.speed}x` : null} />
                    <InfoRow label="FrameRate" value={player.frameRate} />
                    <InfoRow label="TotalFrames" value={player.totalFrames} />
                    <InfoRow label="Width" value={player.width} />
                    <InfoRow label="Height" value={player.height} />
                    <InfoRow label="RetainMusic" value={player.retainMusic != null ? (player.retainMusic ? 'Yes' : 'No') : null} />
                    <InfoRow label="RetainSound" value={player.retainSound != null ? (player.retainSound ? 'Yes' : 'No') : null} />
                    <InfoRow label="RetainCv" value={player.retainCv != null ? (player.retainCv ? 'Yes' : 'No') : null} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Event Log */}
      <div className="rounded-lg border border-[var(--glass-border)] bg-white/40 overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--glass-border)]">
          <span className="font-semibold text-[var(--coffee-deep)]">事件日志</span>
          <span className="text-[var(--coffee-muted)] text-[10px]">({eventLog.length})</span>
          <div className="ml-auto flex gap-1">
            {[['all', '全部'], ['STATUS', 'Status'], ['ACTION', 'Action']].map(([v, l]) => (
              <button key={v} onClick={() => setEventFilter(v)}
                className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${eventFilter === v
                  ? 'bg-[var(--caramel)] text-white'
                  : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-y-auto font-mono" style={{ maxHeight: 200 }}>
          {eventLog.length === 0 ? (
            <div className="text-center text-[var(--coffee-muted)] py-4">暂无事件</div>
          ) : [...eventLog].reverse().map((ev, i) => (
            <div key={i} className={`flex gap-2 px-3 py-0.5 border-l-2 ${ev.type === 'STATUS'
              ? 'border-blue-400 bg-blue-50/30'
              : 'border-orange-400 bg-orange-50/30'}`}>
              <span className="text-[var(--coffee-muted)] text-[10px] flex-shrink-0 w-16">{ev.time}</span>
              <span className={`text-[10px] font-semibold flex-shrink-0 w-12 ${ev.type === 'STATUS' ? 'text-blue-500' : 'text-orange-500'}`}>
                {ev.type}
              </span>
              <span className="text-[var(--coffee-deep)] text-[10px] truncate">{ev.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// AvMonitor (main export)
// ============================================================
export default function AvMonitor({ clients, selectedClient, active }) {
  const [subTab, setSubTab] = useState('audio')
  const [wsConnected, setWsConnected] = useState(false)
  const [refreshInterval, setRefreshInterval] = useState(2)
  const [autoRefresh, setAutoRefresh] = useState(true)

  // Audio state
  const [audioSnap, setAudioSnap] = useState(null)
  const [copiedFile, setCopiedFile] = useState(null)
  const [expandedAudio, setExpandedAudio] = useState(null)
  const [cueQuery, setCueQuery] = useState('')
  const [cueResult, setCueResult] = useState(null)
  const [cueLoading, setCueLoading] = useState(false)
  const [criExpanded, setCriExpanded] = useState(false)

  // Video state
  const [videoSnap, setVideoSnap] = useState(null)
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [eventLog, setEventLog] = useState([])
  const [eventFilter, setEventFilter] = useState('all')
  const [seekInput, setSeekInput] = useState('')

  const wsRef = useRef(null)
  const listenersRef = useRef({})
  const activeRef = useRef(active)
  const autoRefreshRef = useRef(autoRefresh)
  const refreshIntervalRef = useRef(refreshInterval)
  const lastUpdateRef = useRef(0)

  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { autoRefreshRef.current = autoRefresh }, [autoRefresh])
  useEffect(() => { refreshIntervalRef.current = refreshInterval }, [refreshInterval])

  // --- WebSocket ---
  useEffect(() => {
    if (!selectedClient || !active) { setWsConnected(false); return }
    let closed = false
    const connect = () => {
      if (closed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/gm_console/ws/av_monitor`)
      wsRef.current = ws
      let pingTimer = null
      ws.onopen = () => {
        setWsConnected(true)
        pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 25000)
        // 通知游戏侧开始推送
        fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start' })
        }).catch(() => {})
      }
      ws.onmessage = (event) => {
        if (event.data === 'pong') return
        try {
          const msg = JSON.parse(event.data)
          if (msg.client_id !== selectedClient?.id) return
          if (msg.type === 'snapshot') {
            if (!activeRef.current || !autoRefreshRef.current) return
            const now = Date.now()
            if (now - lastUpdateRef.current < refreshIntervalRef.current * 1000) return
            lastUpdateRef.current = now
            const data = msg.data || {}
            if (data.audio) setAudioSnap(data.audio)
            if (data.video) {
              setVideoSnap(data.video)
              if (data.video.events?.length) {
                setEventLog(prev => [...prev, ...data.video.events].slice(-200))
              }
            }
          } else {
            const cb = listenersRef.current[msg.type]
            if (cb) { cb(msg.data); delete listenersRef.current[msg.type] }
          }
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
    return () => {
      closed = true
      // 通知游戏侧停止推送（best-effort，断连前发）
      if (selectedClient) {
        fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' })
        }).catch(() => {})
      }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [selectedClient?.id, active])

  // --- Command helper ---
  const sendCmd = useCallback((action, params = {}, onResponse) => {
    if (!selectedClient) return
    if (onResponse) listenersRef.current[action] = onResponse
    fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params })
    }).catch(e => console.error('[AvMonitor] sendCmd error:', e))
  }, [selectedClient?.id])

  const manualRefresh = useCallback(() => {
    lastUpdateRef.current = 0
    sendCmd('snapshot')
  }, [sendCmd])

  const handleCopy = useCallback((text, id) => {
    copyText(text)
    setCopiedFile(id)
    setTimeout(() => setCopiedFile(null), 800)
  }, [])

  // Volume setters (optimistic update)
  const setCatVol = useCallback((cat, val) => {
    sendCmd('set_volume', { category: cat, value: val })
    setAudioSnap(prev => prev ? {
      ...prev, volumes: { ...prev.volumes, category: { ...prev.volumes?.category, [cat]: val } }
    } : prev)
  }, [sendCmd])

  const setSecVol = useCallback((cat, val) => {
    sendCmd('set_second_volume', { category: cat, value: val })
    setAudioSnap(prev => prev ? {
      ...prev, volumes: { ...prev.volumes, second: { ...prev.volumes?.second, [cat]: val } }
    } : prev)
  }, [sendCmd])

  const toggleMasterMute = useCallback(() => {
    const next = !audioSnap?.masterMute
    sendCmd('set_master_mute', { enabled: next })
    setAudioSnap(prev => prev ? { ...prev, masterMute: next } : prev)
  }, [sendCmd, audioSnap?.masterMute])

  const toggleAisacMute = useCallback((playType) => {
    const next = !audioSnap?.aisacMute?.[playType]
    sendCmd('set_aisac_mute', { playType, enabled: next })
    setAudioSnap(prev => prev ? { ...prev, aisacMute: { ...prev.aisacMute, [playType]: next } } : prev)
  }, [sendCmd, audioSnap?.aisacMute])

  const toggleDebugFlag = useCallback((flag) => {
    const next = !audioSnap?.debugFlags?.[flag]
    sendCmd('set_debug_flag', { flag, enabled: next })
    setAudioSnap(prev => prev ? { ...prev, debugFlags: { ...prev.debugFlags, [flag]: next } } : prev)
  }, [sendCmd, audioSnap?.debugFlags])

  const queryCue = useCallback(() => {
    if (!cueQuery.trim()) return
    setCueLoading(true)
    setCueResult(null)
    sendCmd('query_cue', { cueId: parseInt(cueQuery) }, (data) => {
      setCueResult(data)
      setCueLoading(false)
    })
    // Timeout fallback
    setTimeout(() => setCueLoading(false), 5000)
  }, [sendCmd, cueQuery])

  const videoCmd = useCallback((action, params = {}) => {
    if (!selectedPlayer) return
    sendCmd(action, { playerId: selectedPlayer, ...params })
  }, [sendCmd, selectedPlayer])

  const handleSeek = useCallback(() => {
    const t = parseFloat(seekInput)
    if (!isNaN(t)) videoCmd('video_seek', { time: t })
  }, [videoCmd, seekInput])

  const filteredLog = eventFilter === 'all' ? eventLog : eventLog.filter(e => e.type === eventFilter)

  if (!selectedClient) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--coffee-muted)] text-sm">
        请先选择设备
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--glass-border)] flex-shrink-0">
        {/* Sub-tab switcher */}
        <div className="flex rounded-md overflow-hidden border border-[var(--glass-border)] text-xs">
          {[['audio', 'Audio'], ['video', 'Video']].map(([id, label]) => (
            <button key={id} onClick={() => setSubTab(id)}
              className={`px-3 py-1 transition-colors ${subTab === id
                ? 'bg-[var(--caramel)] text-white'
                : 'bg-white/50 text-[var(--coffee-muted)] hover:bg-[var(--cream-warm)]'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* WS indicator */}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-[var(--sage)]' : 'bg-[var(--terracotta)]'}`} />

        {/* Breathing-light refresh interval */}
        <div className="flex items-center gap-0.5 text-[var(--coffee-muted)]" title={`自动推送间隔 ${refreshInterval}s（0=关闭）`}>
          <button onClick={manualRefresh}
            className="p-0.5 rounded hover:bg-[var(--cream-warm)] hover:text-[var(--coffee-deep)] transition-colors"
            title="手动刷新">
            <RotateCw size={13} />
          </button>
          <input type="text" inputMode="numeric" value={refreshInterval}
            onChange={e => {
              const v = parseInt(e.target.value)
              setRefreshInterval(isNaN(v) ? 0 : Math.max(0, Math.min(60, v)))
              setAutoRefresh(v > 0)
            }}
            style={{
              width: 24, padding: '0 1px', fontSize: 10, lineHeight: '18px',
              ...(autoRefresh ? { borderColor: 'var(--sage)', boxShadow: '0 0 3px var(--sage-soft)' } : {})
            }}
            className="h-5 rounded border border-[var(--glass-border)] bg-white/70 text-center font-mono focus:outline-none focus:border-[var(--caramel)] appearance-none"
          />
          <span className="text-[10px]">s</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {subTab === 'audio' ? (
          <AudioTab
            audioSnap={audioSnap}
            copiedFile={copiedFile}
            expandedAudio={expandedAudio}
            setExpandedAudio={setExpandedAudio}
            cueQuery={cueQuery}
            setCueQuery={setCueQuery}
            cueResult={cueResult}
            cueLoading={cueLoading}
            criExpanded={criExpanded}
            setCriExpanded={setCriExpanded}
            handleCopy={handleCopy}
            setCatVol={setCatVol}
            setSecVol={setSecVol}
            toggleMasterMute={toggleMasterMute}
            toggleAisacMute={toggleAisacMute}
            toggleDebugFlag={toggleDebugFlag}
            queryCue={queryCue}
            sendCmd={sendCmd}
          />
        ) : (
          <VideoTab
            videoSnap={videoSnap}
            selectedPlayer={selectedPlayer}
            setSelectedPlayer={setSelectedPlayer}
            eventLog={filteredLog}
            eventFilter={eventFilter}
            setEventFilter={setEventFilter}
            seekInput={seekInput}
            setSeekInput={setSeekInput}
            handleSeek={handleSeek}
            videoCmd={videoCmd}
          />
        )}
      </div>
    </div>
  )
}
