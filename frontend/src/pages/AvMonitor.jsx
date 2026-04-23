import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Play, Pause, Square, RotateCw, ChevronDown, ChevronRight,
  Copy, Check, Loader2, Film, Music, Lock, VolumeX
} from 'lucide-react'
import { copyText } from '../utils/clipboard'

// ============================================================
// VideoSlider — custom slider for precise video seeking
// ============================================================
function VideoSlider({ value, max, onSeek, onPreview, disabled, className }) {
  const trackRef = useRef(null)
  const dragging = useRef(false)

  const clamp = (v) => Math.max(0, Math.min(v, max || 1))
  const valFromEvent = (e) => {
    const rect = trackRef.current.getBoundingClientRect()
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    return clamp((x / rect.width) * (max || 1))
  }
  const pctPos = max > 0 ? `${(clamp(value) / max) * 100}%` : '0%'

  useEffect(() => {
    if (!dragging.current) return
    const onMove = (e) => {
      e.preventDefault()
      const v = valFromEvent(e)
      onPreview?.(v)
    }
    const onUp = (e) => {
      dragging.current = false
      const v = valFromEvent(e)
      onSeek?.(v)
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  })

  const startDrag = (e) => {
    if (disabled) return
    dragging.current = true
    document.body.style.userSelect = 'none'
    const v = valFromEvent(e)
    onPreview?.(v)
  }

  return (
    <div ref={trackRef} className={`relative h-4 flex items-center cursor-pointer ${disabled ? 'opacity-40 pointer-events-none' : ''} ${className || ''}`}
      onMouseDown={startDrag} onTouchStart={startDrag}>
      {/* track bg */}
      <div className="absolute left-0 right-0 h-1.5 rounded-full bg-[var(--glass-border)]" />
      {/* filled */}
      <div className="absolute left-0 h-1.5 rounded-full bg-[var(--caramel)]" style={{ width: pctPos }} />
      {/* thumb */}
      <div className="absolute h-3 w-3 rounded-full bg-[var(--caramel)] border-2 border-white shadow-sm -translate-x-1/2"
        style={{ left: pctPos }} />
    </div>
  )
}

// ============================================================
// SliderWithDebounce (for audio volume etc.)
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
      className={`h-2 rounded-full cursor-pointer accent-[var(--caramel)] disabled:opacity-40 disabled:cursor-not-allowed ${className || ''}`}
    />
  )
}

function pct(v) { return v != null ? `${Math.round(v * 100)}%` : '--' }

// ============================================================
// VolumeSlider — custom slider for volume (0-1)
// ============================================================
function VolumeSlider({ value, onChange, disabled, readOnly, className }) {
  const trackRef = useRef(null)
  const dragging = useRef(false)

  const clamp = (v) => Math.max(0, Math.min(1, v))
  const valFromEvent = (e) => {
    const rect = trackRef.current.getBoundingClientRect()
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    return clamp(x / rect.width)
  }
  const pctPos = `${(clamp(value ?? 0)) * 100}%`

  useEffect(() => {
    if (!dragging.current) return
    const onMove = (e) => {
      e.preventDefault()
      onChange?.(valFromEvent(e))
    }
    const onUp = (e) => {
      dragging.current = false
      onChange?.(valFromEvent(e))
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  })

  const startDrag = (e) => {
    if (disabled || readOnly) return
    dragging.current = true
    document.body.style.userSelect = 'none'
    onChange?.(valFromEvent(e))
  }

  return (
    <div ref={trackRef}
      className={`relative h-3 flex items-center ${readOnly || disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'} ${className || ''}`}
      onMouseDown={startDrag} onTouchStart={startDrag}>
      <div className="absolute left-0 right-0 h-1.5 rounded-full bg-[var(--glass-border)]" />
      <div className={`absolute left-0 h-1.5 rounded-full ${readOnly ? 'bg-[var(--coffee-muted)]/40' : 'bg-[var(--caramel)]'}`}
        style={{ width: pctPos }} />
      {!readOnly && (
        <div className="absolute h-2.5 w-2.5 rounded-full bg-[var(--caramel)] border-2 border-white shadow-sm -translate-x-1/2"
          style={{ left: pctPos }} />
      )}
    </div>
  )
}

// ============================================================
// VolumeRow
// ============================================================
function VolumeRow({ label, value, readOnly, aisacMuted, onAisacToggle, onChange }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="w-20 flex-shrink-0 text-[var(--coffee-muted)]">{label}</span>
      <div className="flex-1 flex items-center gap-2">
        <VolumeSlider className="flex-1" value={value ?? 0} onChange={onChange} readOnly={readOnly} />
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
function AudioTab({ audioSnap, audioLog, copiedFile, expandedAudio, setExpandedAudio,
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

  const playTypeBadge = (pt) => {
    if (pt === 'Music') return 'bg-[var(--caramel)]/20 text-[var(--caramel)]'
    if (pt === 'SFX') return 'bg-blue-100 text-blue-600'
    return 'bg-purple-100 text-purple-600'
  }

  return (
    <div className="space-y-3">
      {/* 1. BGM Card (with quick actions) */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="flex items-center gap-1.5 mb-2 font-semibold text-[var(--coffee-deep)]">
          <Music size={12} />当前 BGM
        </div>
        {!bgm || (!bgm.name && !bgm.cueId) ? (
          <div className="text-[var(--coffee-muted)]">-- 无播放 --</div>
        ) : (
          <div className="space-y-1.5">
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
        {/* BGM actions — integrated into card */}
        <div className="flex gap-1.5 mt-2 pt-2 border-t border-[var(--glass-border)]">
          <button onClick={() => sendCmd('play_bgm')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--sage)]/15 text-[var(--coffee-deep)] hover:bg-[var(--sage)]/25 transition-colors">
            <Play size={10} />播放
          </button>
          <button onClick={() => sendCmd('stop_bgm')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--terracotta)]/10 text-[var(--coffee-deep)] hover:bg-[var(--terracotta)]/20 transition-colors">
            <Square size={10} />停止
          </button>
          <button onClick={() => sendCmd('reload_sound')}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--cream-warm)] text-[var(--coffee-deep)] hover:bg-[var(--caramel)]/15 transition-colors">
            <RotateCw size={10} />重载
          </button>
        </div>
      </section>

      {/* 2. Volume Mixer */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 p-3 text-xs">
        <div className="font-semibold text-[var(--coffee-deep)] mb-2">音量调节</div>

        <button onClick={toggleMasterMute}
          className={`w-full mb-3 py-1.5 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${audioSnap?.masterMute
            ? 'bg-[var(--terracotta)] text-white'
            : 'bg-[var(--cream-warm)] text-[var(--coffee-deep)] hover:bg-[var(--caramel)]/15'}`}>
          <VolumeX size={12} />
          {audioSnap?.masterMute ? 'Master Mute: ON' : 'Master Mute: OFF — 点击静音'}
        </button>

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

        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mt-3 mb-1.5">
          Aisac / 二次音量 (Second)
        </div>
        {secLabels.map(([key, label]) => (
          <VolumeRow key={key} label={label}
            value={vols?.second?.[key]}
            onChange={v => setSecVol(key, v)}
          />
        ))}

        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mt-3 mb-1.5 flex items-center gap-1">
          <Lock size={9} />Source 音量 (只读)
        </div>
        <VolumeRow label="Music Src" value={vols?.source?.music} readOnly />
        <VolumeRow label="Default Src" value={vols?.source?.default} readOnly />
      </section>

      {/* 3. Active Audio List */}
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
                  <span className={`text-[10px] px-1 rounded flex-shrink-0 ${playTypeBadge(item.playType)}`}>
                    {item.playType}
                  </span>
                  <span className="font-medium truncate text-[var(--coffee-deep)]">{item.name}</span>
                  <span className="ml-auto text-[var(--coffee-muted)] flex-shrink-0">{pct(item.volume)}</span>
                  <span className={`text-[10px] flex-shrink-0 ${item.status === 'Playing' ? 'text-[var(--sage)]' : 'text-[var(--coffee-muted)]'}`}>
                    {item.status}
                  </span>
                </button>
                {expandedAudio === i && (
                  <div className="px-3 pb-2 pt-1 border-t border-[var(--glass-border)] text-[var(--coffee-muted)]">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                      <div className="flex gap-2">
                        <span className="w-14 flex-shrink-0">CueId</span>
                        <span className="font-mono text-[var(--coffee-deep)]">{item.cueId ?? '--'}</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="w-14 flex-shrink-0">Volume</span>
                        <span className="font-mono text-[var(--coffee-deep)]">{pct(item.volume)}</span>
                      </div>
                      {item.duration != null && (
                        <div className="flex gap-2">
                          <span className="w-14 flex-shrink-0">Duration</span>
                          <span className="font-mono text-[var(--coffee-deep)]">{item.duration}ms</span>
                        </div>
                      )}
                      {item.time != null && item.time >= 0 && (
                        <div className="flex gap-2">
                          <span className="w-14 flex-shrink-0">Time</span>
                          <span className="font-mono text-[var(--coffee-deep)]">{item.time}ms</span>
                        </div>
                      )}
                      {item.startTime != null && item.startTime >= 0 && (
                        <div className="flex gap-2">
                          <span className="w-14 flex-shrink-0">Start</span>
                          <span className="font-mono text-[var(--coffee-deep)]">{item.startTime}s</span>
                        </div>
                      )}
                      {item.endTime != null && item.endTime >= 0 && (
                        <div className="flex gap-2">
                          <span className="w-14 flex-shrink-0">End</span>
                          <span className="font-mono text-[var(--coffee-deep)]">{item.endTime}s</span>
                        </div>
                      )}
                      {item.lastFor != null && item.lastFor >= 0 && (
                        <div className="flex gap-2">
                          <span className="w-14 flex-shrink-0">LastFor</span>
                          <span className="font-mono text-[var(--coffee-deep)]">{item.lastFor}s</span>
                        </div>
                      )}
                      {item.sourceName && (
                        <div className="flex gap-2 col-span-2">
                          <span className="w-14 flex-shrink-0">Source</span>
                          <span className="font-mono text-[var(--coffee-deep)] truncate">{item.sourceName}</span>
                        </div>
                      )}
                    </div>
                    {(item.acbPath || item.awbPath) && (
                      <div className="mt-1 pt-1 border-t border-[var(--glass-border)] space-y-0.5">
                        {item.acbPath && (
                          <div className="flex items-center gap-1">
                            <span className="w-14 flex-shrink-0">ACB</span>
                            <button className={`flex items-center gap-1 transition-colors ${copiedFile === `acb_${i}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`}
                              onClick={() => handleCopy(item.acbPath.split(/[/\\]/).pop(), `acb_${i}`)} title={item.acbPath}>
                              {copiedFile === `acb_${i}` ? <Check size={10} /> : <Copy size={10} />}
                              <span className="truncate">…/{item.acbPath.split(/[/\\]/).pop()}</span>
                            </button>
                          </div>
                        )}
                        {item.awbPath && (
                          <div className="flex items-center gap-1">
                            <span className="w-14 flex-shrink-0">AWB</span>
                            <button className={`flex items-center gap-1 transition-colors ${copiedFile === `awb_${i}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`}
                              onClick={() => handleCopy(item.awbPath.split(/[/\\]/).pop(), `awb_${i}`)} title={item.awbPath}>
                              {copiedFile === `awb_${i}` ? <Check size={10} /> : <Copy size={10} />}
                              <span className="truncate">…/{item.awbPath.split(/[/\\]/).pop()}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Audio Play Log */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 text-xs overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--glass-border)]">
          <span className="font-semibold text-[var(--coffee-deep)]">播放日志</span>
          <span className="text-[var(--coffee-muted)] text-[10px]">({audioLog?.length ?? 0})</span>
        </div>
        <div className="max-h-40 overflow-y-auto">
          {!audioLog?.length ? (
            <div className="px-3 py-3 text-[var(--coffee-muted)] text-center">活跃列表变化时自动记录</div>
          ) : (
            <div className="divide-y divide-[var(--glass-border)]">
              {audioLog.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1 hover:bg-[var(--cream-warm)]/30">
                  <span className="font-mono text-[10px] text-[var(--coffee-muted)] flex-shrink-0">{entry.time}</span>
                  <span className={`text-[10px] font-semibold flex-shrink-0 ${entry.action === 'Play' ? 'text-[var(--sage)]' : 'text-[var(--terracotta)]'}`}>
                    {entry.action === 'Play' ? '▶' : '■'}
                  </span>
                  <span className="truncate text-[var(--coffee-deep)]">{entry.name}</span>
                  <button className="font-mono text-[10px] text-[var(--caramel)] hover:text-[var(--coffee-deep)] flex-shrink-0 cursor-pointer transition-colors"
                    onClick={() => sendCmd('play_cue', { cueId: entry.cueId })} title="点击播放">
                    ▶{entry.cueId}
                  </button>
                  <span className={`text-[10px] px-1 rounded flex-shrink-0 ml-auto ${playTypeBadge(entry.playType)}`}>
                    {entry.playType}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 5. CueId Query */}
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

      {/* 6. Debug Flags */}
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

      {/* 7. CRI Stats (collapsible) */}
      <section className="rounded-lg border border-[var(--glass-border)] bg-white/40 text-xs overflow-hidden">
        <button className="w-full flex items-center gap-1.5 px-3 py-2 hover:bg-[var(--cream-warm)]/50 transition-colors"
          onClick={() => setCriExpanded(v => !v)}>
          {criExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-semibold text-[var(--coffee-deep)]">CRI 资源指标</span>
          {audioSnap?.criStats && (
            <span className="ml-2 text-[var(--coffee-muted)]">
              Binds: {audioSnap.criStats.bindsCur ?? '?'}/{audioSnap.criStats.bindsLimit ?? '?'} &nbsp;/&nbsp; Loaders: {audioSnap.criStats.loadersCur ?? '?'}/{audioSnap.criStats.loadersLimit ?? '?'}
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
  videoCmd, sendCmd, handleCopy, copiedFile }) {

  const videoStatusStyle = (status) => {
    if (status === 'Playing')           return { label: 'Playing',   color: '#7D9B76', bg: 'rgba(125,155,118,0.15)', active: true }
    if (status === 'ReadyForRendering') return { label: 'Rendering', color: '#7D9B76', bg: 'rgba(125,155,118,0.15)', active: true }
    if (status === 'Prep' || status === 'WaitPrep' || status === 'Dechead')
                                        return { label: status,      color: '#D4A574', bg: 'rgba(212,165,116,0.15)', active: false }
    if (status === 'Ready')             return { label: 'Ready',     color: '#7BA3C9', bg: 'rgba(123,163,201,0.15)', active: false }
    if (status === 'Error')             return { label: 'Error',     color: '#C1666B', bg: 'rgba(193,102,107,0.15)', active: false }
    if (status === 'PlayEnd')           return { label: 'PlayEnd',   color: '#E8A317', bg: 'rgba(232,163,23,0.15)',  active: false }
    if (status === 'StopProcessing')    return { label: 'Stopping',  color: '#A89B91', bg: 'rgba(168,155,145,0.15)', active: false }
    return { label: status || 'Stop',    color: '#A89B91', bg: 'rgba(168,155,145,0.15)', active: false }
  }

  function VideoStatusBadge({ status, mini }) {
    const cfg = videoStatusStyle(status)
    if (mini) {
      return (
        <span className="inline-flex items-center gap-0.5 text-[8px] font-semibold flex-shrink-0 whitespace-nowrap"
          style={{ color: cfg.color }}>
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{
            background: cfg.color,
            ...(cfg.active ? { animation: 'pulse-success 2s ease-in-out infinite' } : {})
          }} />
          {cfg.label}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0"
        style={{ background: cfg.bg, color: cfg.color }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{
          background: cfg.color,
          ...(cfg.active ? { boxShadow: `0 0 0 3px ${cfg.bg}`, animation: 'pulse-success 2s ease-in-out infinite' } : {})
        }} />
        {cfg.label}
      </span>
    )
  }

  const [leftWidth, setLeftWidth] = useState(200)
  const [moreInfoExpanded, setMoreInfoExpanded] = useState(false)
  const [speedLocal, setSpeedLocal] = useState('1')
  const [editingTime, setEditingTime] = useState(false)
  const [timeInput, setTimeInput] = useState('')
  const [displayTime, setDisplayTime] = useState(0)
  const [previewTime, setPreviewTime] = useState(null)
  const isDragging = useRef(false)
  const anchorRef = useRef({ time: 0, ts: 0, speed: 1, playing: false, total: 0 })
  const rafRef = useRef(null)

  const players = videoSnap?.players || []
  const player = players.find(p => p.id === selectedPlayer)

  useEffect(() => {
    if (player?.speed != null) setSpeedLocal(String(player.speed))
  }, [player?.speed])

  // Sync anchor when snapshot arrives
  useEffect(() => {
    if (!player) return
    const isPlaying = player.status === 'Playing' && !player.isPaused
    anchorRef.current = {
      time: player.currentTime ?? 0,
      ts: performance.now(),
      speed: player.speed ?? 1,
      playing: isPlaying,
      total: player.totalTime ?? 0,
    }
    if (!isPlaying) setDisplayTime(player.currentTime ?? 0)
  }, [player?.currentTime, player?.status, player?.isPaused, player?.speed])

  // rAF loop for smooth interpolation while playing
  useEffect(() => {
    let lastUpdate = 0
    const tick = (now) => {
      const a = anchorRef.current
      if (a.playing && a.total > 0) {
        if (now - lastUpdate > 250) {
          const elapsed = (performance.now() - a.ts) / 1000
          const t = Math.min(a.time + a.speed * elapsed, a.total)
          setDisplayTime(t)
          lastUpdate = now
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])

  const sortedPlayers = [...players].sort((a, b) => {
    const aActive = videoStatusStyle(a.status).active
    const bActive = videoStatusStyle(b.status).active
    if (aActive && !bActive) return -1
    if (bActive && !aActive) return 1
    return 0
  })

  const fmtTime = (s) => {
    if (s == null || isNaN(s)) return '--:--'
    const m = Math.floor(s / 60)
    const sec = String(Math.floor(s % 60)).padStart(2, '0')
    const ds = String(Math.floor((s % 1) * 10))
    return `${m}:${sec}.${ds}`
  }

  // Parse user-friendly time input: "MM:SS", "MM:SS.s", "SS.s", or plain seconds
  const parseTimeInput = (str) => {
    const trimmed = str.trim()
    if (!trimmed) return NaN
    // MM:SS.s or MM:SS
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':')
      if (parts.length !== 2) return NaN
      const mm = parseFloat(parts[0])
      const ss = parseFloat(parts[1])
      if (isNaN(mm) || isNaN(ss)) return NaN
      return mm * 60 + ss
    }
    // Plain seconds
    return parseFloat(trimmed)
  }

  const handleTimeSubmit = () => {
    const t = parseTimeInput(timeInput)
    if (!isNaN(t) && t >= 0) {
      setDisplayTime(t)
      anchorRef.current = { ...anchorRef.current, time: t, ts: performance.now() }
      videoCmd('video_seek', { time: t })
    }
    setEditingTime(false)
    setTimeInput('')
  }

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
            ) : sortedPlayers.map(p => {
              const vs = videoStatusStyle(p.status)
              return (
              <button key={p.id} onClick={() => setSelectedPlayer(p.id)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition-colors ${selectedPlayer === p.id
                  ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]'
                  : 'hover:bg-[var(--cream-warm)]/60 text-[var(--coffee-deep)]'}`}>
                <Film size={11} className="flex-shrink-0" style={{ color: vs.active ? vs.color : '#A89B91', opacity: vs.active ? 1 : 0.4 }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[11px]">
                    {p.name || p.id}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <VideoStatusBadge status={p.status} mini />
                    <span className="text-[var(--coffee-muted)]">
                      {fmtTime(p.currentTime)}{p.totalTime > 0 ? ` / ${fmtTime(p.totalTime)}` : ''}
                    </span>
                  </div>
                </div>
              </button>
            )})}
          </div>
        </div>

        {/* Drag handle */}
        <div className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--caramel)]/40 active:bg-[var(--caramel)]/60 transition-colors"
          onMouseDown={e => { e.preventDefault(); isDragging.current = true }} />

        {/* Right: Player detail */}
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 space-y-2.5 text-xs">
          {!selectedPlayer || !player ? (
            <div className="flex items-center justify-center h-40 text-[var(--coffee-muted)]">
              点击左侧选择播放器
            </div>
          ) : (
            <>
              {/* Header: status + name */}
              <div className="flex items-center gap-2 flex-wrap">
                <VideoStatusBadge status={player.status} />
                <span className="font-semibold text-[var(--coffee-deep)] truncate">{player.name || player.id}</span>
              </div>

              {/* Player control bar — single compact row */}
              <div className="flex items-center gap-1.5 h-6">
                {/* Play / Pause toggle */}
                {(player.status === 'Playing' && !player.isPaused) ? (
                  <button onClick={() => videoCmd('video_pause')} title="暂停"
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--coffee-deep)] bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15 transition-colors">
                    <Pause size={10} />
                  </button>
                ) : (
                  <button onClick={() => videoCmd(player.isPaused ? 'video_resume' : 'video_play')} title={player.isPaused ? '继续' : '播放'}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--coffee-deep)] bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15 transition-colors">
                    <Play size={10} />
                  </button>
                )}
                {/* Stop */}
                <button onClick={() => videoCmd('video_stop')} title="停止"
                  className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--coffee-muted)] bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15 hover:text-[var(--coffee-deep)] transition-colors">
                  <Square size={8} />
                </button>
                {/* Replay */}
                <button onClick={() => videoCmd('video_replay')} title="重播"
                  className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--coffee-muted)] bg-[var(--cream-warm)] hover:bg-[var(--caramel)]/15 hover:text-[var(--coffee-deep)] transition-colors">
                  <RotateCw size={10} />
                </button>

                {/* Current time (click to edit in-place) */}
                <span className="relative font-mono flex-shrink-0 inline-block"
                  style={{ minWidth: '3.2em', fontSize: 10, lineHeight: '16px' }}>
                  <span className={`${editingTime ? 'invisible' : ''} text-[var(--coffee-muted)] cursor-pointer hover:text-[var(--coffee-deep)] transition-colors`}
                    onClick={() => { setEditingTime(true); setTimeInput(fmtTime(previewTime ?? displayTime)) }}
                    title="点击跳转">
                    {fmtTime(previewTime ?? displayTime)}
                  </span>
                  {editingTime && (
                    <input
                      type="text"
                      value={timeInput}
                      onChange={e => setTimeInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleTimeSubmit()
                        if (e.key === 'Escape') { setEditingTime(false); setTimeInput('') }
                      }}
                      onBlur={handleTimeSubmit}
                      placeholder="秒/m:ss"
                      className="absolute inset-0 w-full h-full bg-transparent border-b border-[var(--caramel)] focus:outline-none font-mono text-[var(--coffee-deep)] text-center"
                      style={{ padding: 0, margin: 0, fontSize: 10, lineHeight: '16px' }}
                      autoFocus
                    />
                  )}
                </span>

                {/* Progress slider */}
                <VideoSlider
                  value={previewTime ?? displayTime}
                  max={player.totalTime || 1}
                  onPreview={v => setPreviewTime(v)}
                  onSeek={v => {
                    setPreviewTime(null)
                    setDisplayTime(v)
                    anchorRef.current = { ...anchorRef.current, time: v, ts: performance.now() }
                    videoCmd('video_seek', { time: v })
                  }}
                  disabled={!player.totalTime}
                  className="flex-1"
                />

                {/* Total time */}
                <span className="font-mono text-[var(--coffee-muted)] flex-shrink-0"
                  style={{ fontSize: 10, lineHeight: '16px' }}>
                  {fmtTime(player.totalTime)}
                </span>

                {/* Speed selector */}
                <select value={speedLocal} onChange={e => { setSpeedLocal(e.target.value); videoCmd('video_speed', { speed: parseFloat(e.target.value) }) }}
                  className="h-5 bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:bg-[var(--caramel)]/15 hover:text-[var(--coffee-deep)] rounded font-mono cursor-pointer focus:outline-none flex-shrink-0"
                  style={{ padding: '0 2px', border: 'none', fontSize: 10, width: 46 }}>
                  {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map(s => (
                    <option key={s} value={String(s)}>{s % 1 === 0 ? s.toFixed(1) : String(s)}x</option>
                  ))}
                </select>
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
                    <InfoRow label="Status" value={player.status} />
                    <InfoRow label="IsPaused" value={player.isPaused != null ? (player.isPaused ? 'Yes' : 'No') : null} />
                    <InfoRow label="Speed" value={player.speed != null ? `${player.speed}x` : null} />
                    <InfoRow label="Loop" value={player.isLoop != null ? (player.isLoop ? 'Yes' : 'No') : null} />
                    <InfoRow label="Movie" value={player.movieName} />
                    <InfoRow label="VideoId" value={player.videoConfigId} />
                    <InfoRow label="Resolution" value={player.width && player.height ? `${player.width}x${player.height}` : null} />
                    <InfoRow label="FrameRate" value={player.frameRate != null ? `${player.frameRate} fps` : null} />
                    <InfoRow label="TotalFrames" value={player.totalFrames} />
                    <div className="col-span-2 flex items-center gap-1 pt-1 text-[10px]">
                      <span className="text-[var(--coffee-muted)] flex-shrink-0">Url:</span>
                      {player.url ? (
                        <button className={`flex items-center gap-1 transition-colors ${copiedFile === 'video_url' ? 'text-[#7D9B76]' : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}
                          onClick={() => handleCopy(player.url, 'video_url')} title={player.url}>
                          {copiedFile === 'video_url' ? <Check size={10} /> : <Copy size={10} />}
                          <span className="truncate max-w-[280px]">…/{player.url.split(/[/\\]/).pop()}</span>
                        </button>
                      ) : <span className="text-[var(--coffee-deep)]">--</span>}
                    </div>
                    <InfoRow label="字幕轨" value={player.numSubtitleChannels != null
                      ? `${player.numSubtitleChannels} 条${player.subtitleChannel != null ? ` · 当前: ${player.subtitleChannel === -1 ? '关闭' : `#${player.subtitleChannel}`}` : ''}`
                      : null} />
                    <InfoRow label="音频轨" value={player.numAudioStreams != null
                      ? `${player.numAudioStreams} 条${player.subAudioTrack != null ? ` · 当前: #${player.subAudioTrack}` : ''}`
                      : null} />
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
          <button onClick={() => sendCmd('toggle_video_log', { enabled: !videoSnap?.logEnabled })}
            className={`ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
              videoSnap?.logEnabled
                ? 'bg-[var(--sage)]/15 text-[var(--sage)] border border-[var(--sage)]/30'
                : 'bg-[var(--cream-warm)] text-[var(--coffee-muted)] border border-[var(--glass-border)] hover:text-[var(--coffee-deep)]'}`}>
            {videoSnap?.logEnabled ? '监听中' : '开启监听'}
          </button>
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

  // Audio play log (derived from activeList diffs)
  const [audioLog, setAudioLog] = useState([])
  const prevActiveRef = useRef(null)

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
            const data = msg.data || {}
            // Video updates bypass throttle (game side already rate-limits)
            if (data.video) {
              setVideoSnap(data.video)
              if (data.video.events?.length) {
                setEventLog(prev => [...prev, ...data.video.events].slice(-200))
              }
            }
            // Audio updates follow user-configured refresh interval
            if (now - lastUpdateRef.current < refreshIntervalRef.current * 1000) return
            lastUpdateRef.current = now
            if (data.audio) {
              // Diff activeList for audio play log
              const curList = data.audio.activeList || []
              const prevList = prevActiveRef.current
              if (prevList) {
                const prevIds = new Set(prevList.map(a => `${a.cueId}:${a.name}`))
                const curIds = new Set(curList.map(a => `${a.cueId}:${a.name}`))
                const now = new Date().toLocaleTimeString('en-GB', { hour12: false })
                const newEntries = []
                for (const a of curList) {
                  if (!prevIds.has(`${a.cueId}:${a.name}`)) {
                    newEntries.push({ time: now, action: 'Play', name: a.name, cueId: a.cueId, playType: a.playType })
                  }
                }
                for (const a of prevList) {
                  if (!curIds.has(`${a.cueId}:${a.name}`)) {
                    newEntries.push({ time: now, action: 'Stop', name: a.name, cueId: a.cueId, playType: a.playType })
                  }
                }
                if (newEntries.length) setAudioLog(prev => [...newEntries, ...prev].slice(0, 100))
              }
              prevActiveRef.current = curList
              setAudioSnap(data.audio)
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
    if (['video_play','video_pause','video_resume','video_stop','video_seek','video_replay'].includes(action)) {
      setTimeout(() => sendCmd('snapshot'), 300)
    }
  }, [sendCmd, selectedPlayer])

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
            audioLog={audioLog}
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
            videoCmd={videoCmd}
            sendCmd={sendCmd}
            handleCopy={handleCopy}
            copiedFile={copiedFile}
          />
        )}
      </div>
    </div>
  )
}
