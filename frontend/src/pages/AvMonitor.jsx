import { useState, useEffect, useRef, useCallback, memo } from 'react'
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

function audioTiming(item) {
  const duration = Number(item?.duration)
  const time = Number(item?.time)
  const hasDuration = Number.isFinite(duration) && duration > 0
  const isLoop = Number.isFinite(duration) && duration < 0
  const hasElapsed = Number.isFinite(time) && time >= 0
  const progress = hasDuration && hasElapsed
    ? Math.min(1, Math.max(0, time / duration))
    : null

  return { duration, time, hasDuration, isLoop, hasElapsed, progress }
}

function formatAudioSeconds(ms) {
  const value = Number(ms)
  return Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(2)}s` : '--'
}

function audioFormatLabel(format) {
  if (!format) return '--'
  const parts = [format.codec]
  if (format.samplingRate > 0) parts.push(`${format.samplingRate / 1000}kHz`)
  if (format.channels > 0) parts.push(format.channels === 1 ? 'Mono' : format.channels === 2 ? 'Stereo' : `${format.channels}ch`)
  return parts.filter(Boolean).join(' · ')
}

function AudioStatusBadge({ paused, status }) {
  const baseClass = 'inline-flex w-[58px] items-center justify-end gap-1 whitespace-nowrap text-[9px] font-medium'
  if (paused) {
    return <span title="已暂停" className={`${baseClass} text-[var(--amber)]`}><Pause size={9} fill="currentColor" />已暂停</span>
  }
  if (status === 'Prep') {
    return <span title="准备中" className={`${baseClass} text-[var(--caramel)]`}><Loader2 size={9} className="animate-spin" />准备中</span>
  }
  if (status === 'Removed') {
    return <span title="已结束" className={`${baseClass} text-[var(--coffee-muted)]`}><Check size={9} />已结束</span>
  }
  if (status === 'Playing') {
    return <span title="播放中" className={`${baseClass} text-[var(--sage)]`}><span className="w-1.5 h-1.5 rounded-full bg-current shadow-[0_0_0_2px_rgba(125,155,118,0.12)]" />播放中</span>
  }
  return <span title={status || '状态未知'} className={`${baseClass} text-[var(--coffee-muted)]`}><span className="w-1.5 h-1.5 rounded-full border border-current" />{status || '未知'}</span>
}

function CollapsibleSection({ title, meta, expanded, onToggle, actions, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-[var(--glass-border)] bg-white/40 text-xs overflow-hidden [overflow-anchor:none] ${className}`}>
      <div className={`flex items-center min-h-9 px-3 ${expanded ? 'border-b border-[var(--glass-border)]' : ''}`}>
        <button className="flex flex-1 min-w-0 items-center gap-1.5 py-2 text-left hover:text-[var(--coffee-deep)]"
          onClick={onToggle} aria-expanded={expanded}>
          <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
          <span className="font-semibold text-[var(--coffee-deep)] truncate">{title}</span>
          {meta != null && <span className="text-[var(--coffee-muted)] text-[10px] font-normal flex-shrink-0">{meta}</span>}
        </button>
        {actions && <div className="flex items-center gap-1 pl-2" onClick={e => e.stopPropagation()}>{actions}</div>}
      </div>
      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="p-3">{children}</div>
        </div>
      </div>
    </section>
  )
}

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

function AudioDetailRow({ label, children, muted = false, wide = false }) {
  return (
    <div className={`flex gap-2 min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <span className="w-24 flex-shrink-0 text-[var(--coffee-muted)]">{label}</span>
      <span className={`font-mono min-w-0 break-all ${muted ? 'text-[var(--coffee-muted)]/70' : 'text-[var(--coffee-deep)]'}`}>{children}</span>
    </div>
  )
}

function audioParam(value, suffix = 's') {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? `${number}${suffix}` : '未设置'
}

function compactTimestamp(value) {
  if (!value) return '--'
  return String(value).replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
}

function historyTimestamp(value) {
  return value ? String(value).replace(/^\d{4}-/, '') : '--'
}

function loadStoredState(key, fallback) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null')
    return stored && typeof stored === 'object' ? { ...fallback, ...stored } : fallback
  } catch {
    return fallback
  }
}

function AudioEntryCard({ item, entryKey, expanded, onToggle, playTypeBadge, playTypeProgress,
  copiedFile, handleCopy, history = false }) {
  const timing = audioTiming(item)
  const progressPercent = timing.progress == null ? null : Math.round(timing.progress * 100)
  const playbackStatus = item.historyActive === false ? 'Removed' : (item.playbackStatus || item.status)
  const isPaused = item.paused ?? item.status === 'Paused'
  const cutoffActive = [item.startTime, item.endTime, item.lastFor, item.durationForEndtime].some(value => Number(value) > 0)
    || item.stopRemaining != null || item.isFadingOut
  const copyKey = `${entryKey}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  const timingLabel = timing.isLoop
    ? 'Loop'
    : progressPercent != null
      ? `${progressPercent}% · ${formatAudioSeconds(timing.time)}/${formatAudioSeconds(timing.duration)}`
      : '--'

  return (
    <div className="rounded border border-[var(--glass-border)] bg-white/30 overflow-hidden">
      <button className="relative w-full px-2 py-1.5 text-left overflow-hidden" onClick={onToggle}>
        {progressPercent != null && (
          <span aria-hidden="true" className={`absolute inset-y-0 left-0 transition-[width] duration-300 ${playTypeProgress(item.playType)}`}
            style={{ width: `${progressPercent}%` }} />
        )}
        <span className="relative z-10 grid grid-cols-[12px_68px_44px_minmax(80px,1fr)_72px_138px_58px] items-center gap-2 min-w-0">
          <ChevronRight size={10} className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
          <span className="font-mono text-[9px] tabular-nums text-[var(--coffee-muted)] whitespace-nowrap">
            {history ? compactTimestamp(item.startedAt) : '实时'}
          </span>
          <span className={`justify-self-start text-[10px] px-1 rounded ${playTypeBadge(item.playType)}`}>{item.playType}</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate text-[var(--coffee-deep)] min-w-0">{item.name}</span>
            {item.preexisting && <span title="打开监控时已在播放" className="text-[9px] text-[var(--coffee-muted)] flex-shrink-0">已在播放</span>}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-[var(--coffee-muted)] whitespace-nowrap">Cue:{item.cueId ?? '--'}</span>
          <span className={`font-mono text-[10px] tabular-nums font-semibold text-right whitespace-nowrap ${timing.isLoop ? 'text-[var(--caramel)]' : 'text-[var(--coffee-deep)]'}`}>{timingLabel}</span>
          <AudioStatusBadge paused={isPaused} status={playbackStatus} />
        </span>
      </button>
      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-2.5 pt-2 border-t border-[var(--glass-border)] text-[10px] space-y-2.5">
            {history && (
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--coffee-muted)] mb-1">生命周期</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  <AudioDetailRow label="播放时间">{historyTimestamp(item.startedAt)}</AudioDetailRow>
                  <AudioDetailRow label="停止时间" muted={!item.stoppedAt}>{item.stoppedAt ? historyTimestamp(item.stoppedAt) : (item.historyActive ? '仍在播放' : '--')}</AudioDetailRow>
                  <AudioDetailRow label="实际存活">{item.lifetimeSeconds != null ? `${Number(item.lifetimeSeconds).toFixed(2)}s` : (item.historyActive ? '计时中' : '--')}</AudioDetailRow>
                  <AudioDetailRow label="最终状态">{playbackStatus || '--'}</AudioDetailRow>
                </div>
              </div>
            )}

            <div className={history ? 'pt-2 border-t border-[var(--glass-border)]' : ''}>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--coffee-muted)] mb-1">业务与实例</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <AudioDetailRow label="InstanceId">{item.id ?? '--'}</AudioDetailRow>
                <AudioDetailRow label="CueId">{item.cueId ?? '--'}</AudioDetailRow>
                <AudioDetailRow label="PlayType">{item.playType || '--'}</AudioDetailRow>
                <AudioDetailRow label="Source">{item.sourceName || '--'}</AudioDetailRow>
                <AudioDetailRow label="TransformId">{item.transformId ?? '--'}</AudioDetailRow>
                <AudioDetailRow label="Source Vol.">{pct(item.volume)}</AudioDetailRow>
                <AudioDetailRow label="SelectorLabelDic" wide>{item.selectorLabelDic?.length ? item.selectorLabelDic.map(v => `${v.selector}=${v.label}`).join(', ') : '--'}</AudioDetailRow>
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--glass-border)]">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--coffee-muted)] mb-1">CRI 播放参数</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <AudioDetailRow label="PlaybackId">{item.playbackId ?? '--'}</AudioDetailRow>
                <AudioDetailRow label="Status">{playbackStatus || '--'}</AudioDetailRow>
                <AudioDetailRow label="Paused">{isPaused ? 'Yes' : 'No'}</AudioDetailRow>
                <AudioDetailRow label="Time">{timing.hasElapsed ? formatAudioSeconds(timing.time) : '--'}</AudioDetailRow>
                <AudioDetailRow label="Duration">{timing.isLoop ? 'Loop' : timing.hasDuration ? formatAudioSeconds(timing.duration) : '--'}</AudioDetailRow>
                <AudioDetailRow label="Progress">{progressPercent != null ? `${progressPercent}%` : '--'}</AudioDetailRow>
                <AudioDetailRow label="Format" wide>{audioFormatLabel(item.format)}</AudioDetailRow>
                <AudioDetailRow label="CueSheet" wide>{item.cueSheetId ?? '--'}{item.cueSheetName ? ` · ${item.cueSheetName}` : ''}</AudioDetailRow>
                {item.acbPath && <AudioDetailRow label="ACB" wide><button className={`inline-flex items-center gap-1 ${copiedFile === `acb_${copyKey}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`} onClick={() => handleCopy(item.acbPath.split(/[/\\]/).pop(), `acb_${copyKey}`)}>{copiedFile === `acb_${copyKey}` ? <Check size={10} /> : <Copy size={10} />}…/{item.acbPath.split(/[/\\]/).pop()}</button></AudioDetailRow>}
                {item.awbPath && <AudioDetailRow label="AWB" wide><button className={`inline-flex items-center gap-1 ${copiedFile === `awb_${copyKey}` ? 'text-[var(--sage)]' : 'hover:text-[var(--coffee-deep)]'}`} onClick={() => handleCopy(item.awbPath.split(/[/\\]/).pop(), `awb_${copyKey}`)}>{copiedFile === `awb_${copyKey}` ? <Check size={10} /> : <Copy size={10} />}…/{item.awbPath.split(/[/\\]/).pop()}</button></AudioDetailRow>}
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--glass-border)]">
              <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-[var(--coffee-muted)] mb-1">
                音频截取与停止
                <span className={`normal-case tracking-normal font-normal ${cutoffActive ? 'text-[var(--amber)]' : 'text-[var(--coffee-muted)]/70'}`}>{cutoffActive ? '生效中' : '未启用'}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <AudioDetailRow label="StartTime" muted={!(Number(item.startTime) > 0)}>{audioParam(item.startTime)}</AudioDetailRow>
                <AudioDetailRow label="EndTime" muted={!(Number(item.endTime) > 0)}>{audioParam(item.endTime)}</AudioDetailRow>
                <AudioDetailRow label="LastFor" muted={!(Number(item.lastFor) > 0)}>{audioParam(item.lastFor)}</AudioDetailRow>
                <AudioDetailRow label="DurationForEndtime" muted={!(Number(item.durationForEndtime) > 0)}>{audioParam(item.durationForEndtime)}</AudioDetailRow>
                <AudioDetailRow label="StopEndtimeStamp" muted={item.stopRemaining == null}>{item.stopRemaining != null ? `剩余 ${Number(item.stopRemaining).toFixed(2)}s` : '未设置'}</AudioDetailRow>
                <AudioDetailRow label="IsFadingOut" muted={!item.isFadingOut}>{item.isFadingOut ? 'Yes' : 'No'}</AudioDetailRow>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// AudioTab
// ============================================================
function AudioTab({ audioSnap, audioLog, copiedFile, expandedAudio, setExpandedAudio,
  cueQuery, setCueQuery, cueResult, cueLoading, criExpanded, setCriExpanded,
  handleCopy, setCatVol, setSecVol, setSourceVol, toggleMasterMute, toggleAisacMute,
  toggleDebugFlag, queryCue, sendCmd, commandError }) {

  const bgm = audioSnap?.bgm
  const vols = audioSnap?.volumes
  const debugFlags = audioSnap?.debugFlags || {}
  const [sectionOpen, setSectionOpen] = useState(() => loadStoredState('gm_av_audio_sections', { bgm: true, active: true, history: false, volume: false, log: false, cue: false, debug: false, cri: false }))
  const [historyPaused, setHistoryPaused] = useState(false)
  const [historyView, setHistoryView] = useState([])
  const [historyHiddenCount, setHistoryHiddenCount] = useState(0)
  const [historyClearedThrough, setHistoryClearedThrough] = useState(0)
  const historySeqRef = useRef(0)
  const toggleSection = key => setSectionOpen(prev => ({ ...prev, [key]: !prev[key] }))

  useEffect(() => {
    try { localStorage.setItem('gm_av_audio_sections', JSON.stringify(sectionOpen)) } catch {}
  }, [sectionOpen])

  useEffect(() => {
    const next = (audioSnap?.history || []).filter(item => (item.historySeq || 0) > historyClearedThrough)
    const newestSeq = next[0]?.historySeq || 0
    if (historyPaused) {
      setHistoryHiddenCount(Math.max(0, newestSeq - historySeqRef.current))
      return
    }
    setHistoryView(next)
    setHistoryHiddenCount(0)
    historySeqRef.current = newestSeq
  }, [audioSnap?.history, historyPaused, historyClearedThrough])

  const resumeHistory = () => {
    const next = (audioSnap?.history || []).filter(item => (item.historySeq || 0) > historyClearedThrough)
    setHistoryPaused(false)
    setHistoryView(next)
    setHistoryHiddenCount(0)
    historySeqRef.current = next[0]?.historySeq || 0
  }

  const catLabels = [['music', 'Music', 'music'], ['sfx', 'SFX', 'sfx'], ['cv', 'CV', 'voice']]
  const secLabels = [['music', '2nd Music'], ['sfx', '2nd SFX'], ['voice', '2nd Voice']]
  const sourceLabels = [
    ['music', 'Music/Analyzer'],
    ['default', 'Default'],
    ['ambient', 'Ambient'],
    ['voice', 'Voice'],
    ['lipsShape', 'Lips Shape'],
    ['gameplaySpecial', 'Gameplay'],
  ]
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

  const playTypeProgress = (pt) => {
    if (pt === 'Music') return 'bg-[var(--caramel)]/15'
    if (pt === 'SFX') return 'bg-blue-400/15'
    return 'bg-purple-400/15'
  }

  return (
    <div className="space-y-3">
      {commandError && (
        <div role="alert" className="rounded-lg border border-[var(--terracotta)]/40 bg-[var(--terracotta)]/10 px-3 py-2 text-xs text-[var(--terracotta)] break-all">
          控制命令失败：{commandError}
        </div>
      )}
      {/* 1. BGM Card (with quick actions) */}
      <CollapsibleSection title="当前 BGM" expanded={sectionOpen.bgm} onToggle={() => toggleSection('bgm')}
        meta={<Music size={12} />}>
        {!bgm || (!bgm.name && !bgm.cueId) ? (
          <div className="text-[var(--coffee-muted)]">-- 无播放 --</div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-[var(--coffee-deep)] truncate max-w-[200px]">{bgm.name || '--'}</span>
              <span className="text-[var(--coffee-muted)]">CueId: <span className="font-mono text-[var(--coffee-deep)]">{bgm.cueId ?? '--'}</span></span>
              <span className="text-[var(--coffee-muted)]">InstanceId: <span className="font-mono text-[var(--coffee-deep)]">{bgm.instanceId ?? '--'}</span></span>
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
          <button onClick={() => sendCmd('play_bgm', { cueId: bgm?.cueId })} disabled={bgm?.cueId == null}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--sage)]/15 text-[var(--coffee-deep)] hover:bg-[var(--sage)]/25 transition-colors disabled:opacity-40 disabled:pointer-events-none">
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
      </CollapsibleSection>

      {/* 2. Active Audio List */}
      <CollapsibleSection title="活跃音频列表" meta={`(${audioSnap?.activeList?.length ?? 0})`}
        expanded={sectionOpen.active} onToggle={() => toggleSection('active')}>
        {!audioSnap?.activeList?.length ? (
          <div className="text-[var(--coffee-muted)]">暂无活跃音频</div>
        ) : (
          <div className="space-y-0.5">
            {audioSnap.activeList.map((item, i) => (
              <AudioEntryCard key={item.id ?? i} item={item} entryKey={`active_${item.id ?? i}`}
                expanded={expandedAudio === `active:${item.id ?? i}`}
                onToggle={() => setExpandedAudio(expandedAudio === `active:${item.id ?? i}` ? null : `active:${item.id ?? i}`)}
                playTypeBadge={playTypeBadge} playTypeProgress={playTypeProgress}
                copiedFile={copiedFile} handleCopy={handleCopy} />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* 3. Recent Audio History */}
      <CollapsibleSection title="最近音频历史" meta={`(${historyView.length}/100${historyHiddenCount ? ` · +${historyHiddenCount}` : ''})`}
        expanded={sectionOpen.history} onToggle={() => toggleSection('history')}
        actions={<>
          <button onClick={() => historyPaused ? resumeHistory() : setHistoryPaused(true)}
            className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${historyPaused ? 'border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)]' : 'border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'}`}>
            {historyPaused ? `恢复${historyHiddenCount ? ` (+${historyHiddenCount})` : ''}` : '暂停'}
          </button>
          <button onClick={() => {
            const newestSeq = audioSnap?.history?.[0]?.historySeq || 0
            setHistoryClearedThrough(newestSeq)
            setHistoryView([])
            setHistoryHiddenCount(0)
            historySeqRef.current = newestSeq
          }}
            className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)] transition-colors">
            清空视图
          </button>
        </>}>
        {!historyView.length ? (
          <div className="text-center text-[var(--coffee-muted)] py-2">暂无播放历史</div>
        ) : (
          <div className="max-h-96 overflow-y-auto space-y-0.5">
            {historyView.map((item, i) => (
              <AudioEntryCard key={item.historySeq ?? i} item={item} entryKey={`history_${item.historySeq ?? i}`}
                expanded={expandedAudio === `history:${item.historySeq ?? i}`}
                onToggle={() => setExpandedAudio(expandedAudio === `history:${item.historySeq ?? i}` ? null : `history:${item.historySeq ?? i}`)}
                playTypeBadge={playTypeBadge} playTypeProgress={playTypeProgress}
                copiedFile={copiedFile} handleCopy={handleCopy} history />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* 4. Volume Mixer */}
      <CollapsibleSection title="音量调节" expanded={sectionOpen.volume} onToggle={() => toggleSection('volume')}>

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
        {catLabels.map(([key, label, aisacKey]) => (
          <VolumeRow key={key} label={label}
            value={vols?.category?.[key]}
            aisacMuted={audioSnap?.aisacMute?.[aisacKey]}
            onAisacToggle={() => toggleAisacMute(aisacKey)}
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

        <div className="text-[10px] font-semibold text-[var(--coffee-muted)] uppercase tracking-wide mt-3 mb-1.5">
          Source 音量 (CriAtomSource)
        </div>
        {sourceLabels.map(([key, label]) => (
          <VolumeRow key={key} label={label}
            value={vols?.source?.[key]}
            onChange={v => setSourceVol(key, v)}
          />
        ))}
      </CollapsibleSection>

      {/* 5. Audio Play Log */}
      <CollapsibleSection title="音频事件日志" meta={`(${audioLog?.length ?? 0})`}
        expanded={sectionOpen.log} onToggle={() => toggleSection('log')} className="[&>div:last-child>div>div]:p-0">
        <div className="max-h-40 overflow-y-auto">
          {!audioLog?.length ? (
            <div className="px-3 py-3 text-[var(--coffee-muted)] text-center">开启 Log Collect 及 Play Log / Stop Log 后实时记录</div>
          ) : (
            <div className="divide-y divide-[var(--glass-border)]">
              {audioLog.map((entry, i) => (
                <div key={entry.seq ?? `${entry.instanceId ?? entry.cueId}:${entry.action}:${entry.time}:${i}`} className="flex items-center gap-2 px-3 py-1 hover:bg-[var(--cream-warm)]/30">
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
      </CollapsibleSection>

      {/* 6. CueId Query */}
      <CollapsibleSection title="CueId 精确查询" expanded={sectionOpen.cue} onToggle={() => toggleSection('cue')}>
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
      </CollapsibleSection>

      {/* 7. Debug Flags */}
      <CollapsibleSection title="Debug 开关" expanded={sectionOpen.debug} onToggle={() => toggleSection('debug')}>
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
      </CollapsibleSection>

      {/* 8. CRI Stats */}
      <CollapsibleSection title="CRI 资源指标"
        meta={audioSnap?.criStats ? `Binds ${audioSnap.criStats.bindsCur ?? '?'}/${audioSnap.criStats.bindsLimit ?? '?'} · Loaders ${audioSnap.criStats.loadersCur ?? '?'}/${audioSnap.criStats.loadersLimit ?? '?'}` : null}
        expanded={sectionOpen.cri} onToggle={() => { toggleSection('cri'); setCriExpanded(v => !v) }}>
        {audioSnap?.criStats && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {Object.entries(audioSnap.criStats).map(([k, v]) => (
              <div key={k} className="flex justify-between pt-1">
                <span className="text-[var(--coffee-muted)]">{k}</span>
                <span className="font-mono font-medium text-[var(--coffee-deep)]">{v}</span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
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
  const [moreInfoExpanded, setMoreInfoExpanded] = useState(() => localStorage.getItem('gm_av_video_more_info') === 'true')
  const [videoSections, setVideoSections] = useState(() => loadStoredState('gm_av_video_sections', { players: true, log: true }))
  const [speedLocal, setSpeedLocal] = useState('1')
  const [editingTime, setEditingTime] = useState(false)
  const [timeInput, setTimeInput] = useState('')
  const [displayTime, setDisplayTime] = useState(0)
  const [previewTime, setPreviewTime] = useState(null)
  const isDragging = useRef(false)
  const anchorRef = useRef({ time: 0, ts: 0, speed: 1, playing: false, total: 0 })
  const rafRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('gm_av_video_sections', JSON.stringify(videoSections)) } catch {}
  }, [videoSections])
  useEffect(() => {
    try { localStorage.setItem('gm_av_video_more_info', String(moreInfoExpanded)) } catch {}
  }, [moreInfoExpanded])

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
      <CollapsibleSection title="播放器" meta={`(${players.length})`} expanded={videoSections.players}
        onToggle={() => setVideoSections(v => ({ ...v, players: !v.players }))} className="[&>div:last-child>div>div]:p-0">
      <div className="flex bg-white/30 overflow-hidden"
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
                <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${moreInfoExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                  <div className="min-h-0 overflow-hidden">
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
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      </CollapsibleSection>

      {/* Event Log */}
      <CollapsibleSection title="事件日志" meta={`(${eventLog.length})`} expanded={videoSections.log}
        onToggle={() => setVideoSections(v => ({ ...v, log: !v.log }))} className="[&>div:last-child>div>div]:p-0"
        actions={<>
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
        </>}>
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
      </CollapsibleSection>
    </div>
  )
}

// ============================================================
// AvMonitor (main export)
// ============================================================
function AvMonitor({ clients, selectedClient, active }) {
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
  const [audioCommandError, setAudioCommandError] = useState(null)

  // Video state
  const [videoSnap, setVideoSnap] = useState(null)
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [eventLog, setEventLog] = useState([])
  const [eventFilter, setEventFilter] = useState('all')

  // Audio play log (game-side instance event stream; old clients fall back to activeList diffs)
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
  useEffect(() => {
    setAudioSnap(null)
    setAudioLog([])
    setAudioCommandError(null)
    prevActiveRef.current = null
    lastUpdateRef.current = 0
    if (selectedClient?.id) {
      fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/state`)
        .then(response => response.ok ? response.json() : null)
        .then(result => {
          const data = result?.data
          if (data?.audio) setAudioSnap(data.audio)
          if (data?.video) setVideoSnap(data.video)
        })
        .catch(() => {})
    }
  }, [selectedClient?.id])

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
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send('ping')
          if (selectedClient.online === false) return
          // 游戏侧 AV 订阅 30 秒无命令会超时；snapshot 同时作为心跳且不会重置事件基线。
          fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'snapshot' })
          }).catch(() => {})
        }, 20000)
        // 通知游戏侧开始推送
        if (selectedClient.online !== false) {
          fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' })
          }).catch(() => {})
        }
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
            // 音频事件由游戏侧高频采集。必须在快照节流之前消费，否则视频活跃时
            // 0.5 秒快照中的事件会被 2 秒音频刷新间隔直接丢弃。
            if (data.audio?.eventStream && data.audio.events?.length) {
              const newestFirst = [...data.audio.events].reverse()
              setAudioLog(prev => [...newestFirst, ...prev].slice(0, 500))
            }
            // Audio updates follow user-configured refresh interval
            if (now - lastUpdateRef.current < refreshIntervalRef.current * 1000) return
            lastUpdateRef.current = now
            if (data.audio) {
              // 旧客户端兼容：没有事件流时才退回低频 activeList 差分。
              const curList = data.audio.activeList || []
              const prevList = prevActiveRef.current
              if (!data.audio.eventStream && prevList) {
                const identity = a => String(a.id ?? `${a.cueId}:${a.name}`)
                const prevIds = new Set(prevList.map(identity))
                const curIds = new Set(curList.map(identity))
                const now = new Date().toLocaleTimeString('en-GB', { hour12: false })
                const newEntries = []
                for (const a of curList) {
                  if (!prevIds.has(identity(a))) {
                    newEntries.push({ time: now, action: 'Play', name: a.name, cueId: a.cueId, playType: a.playType })
                  }
                }
                for (const a of prevList) {
                  if (!curIds.has(identity(a))) {
                    newEntries.push({ time: now, action: 'Stop', name: a.name, cueId: a.cueId, playType: a.playType })
                  }
                }
                if (newEntries.length) setAudioLog(prev => [...newEntries, ...prev].slice(0, 500))
              }
              prevActiveRef.current = curList
              setAudioSnap(data.audio)
            }
          } else {
            if (msg.data?.error && msg.type !== 'query_cue') {
              setAudioCommandError(`${msg.type}: ${msg.data.error}`)
            } else if (msg.data?.ok) {
              setAudioCommandError(null)
            }
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
  }, [selectedClient?.id, selectedClient?.online, active])

  // --- Command helper ---
  const sendCmd = useCallback((action, params = {}, onResponse) => {
    if (!selectedClient || selectedClient.online === false) return
    if (onResponse) listenersRef.current[action] = onResponse
    return fetch(`/api/gm_console/av_monitor/${encodeURIComponent(selectedClient.id)}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params })
    }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    }).catch(e => {
      setAudioCommandError(`${action}: ${e.message}`)
      console.error('[AvMonitor] sendCmd error:', e)
    })
  }, [selectedClient?.id, selectedClient?.online])

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

  const setSourceVol = useCallback((source, val) => {
    sendCmd('set_source_volume', { source, value: val })
    setAudioSnap(prev => prev ? {
      ...prev, volumes: { ...prev.volumes, source: { ...prev.volumes?.source, [source]: val } }
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
        {selectedClient.online === false && (
          <div className="mb-3 rounded-lg border border-[var(--coffee-muted)]/25 bg-[var(--cream-warm)]/60 px-3 py-2 text-xs text-[var(--coffee-muted)]">
            客户端已离线，当前展示 Hub 保留的最后一次快照与音频历史；控制功能暂不可用。
          </div>
        )}
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
            setSourceVol={setSourceVol}
            toggleMasterMute={toggleMasterMute}
            toggleAisacMute={toggleAisacMute}
            toggleDebugFlag={toggleDebugFlag}
            queryCue={queryCue}
            sendCmd={sendCmd}
            commandError={audioCommandError}
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

export default memo(AvMonitor)
