"""AV Monitor 音频采集链路回归测试。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_LUA = ROOT / "tools" / "gm_console" / "runtime_gm_client.lua"
AV_MONITOR_JSX = ROOT / "frontend" / "src" / "pages" / "AvMonitor.jsx"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_bgm_uses_cue_fields_and_keeps_instance_id_separate():
    lua = read(RUNTIME_LUA)

    assert 'rawget(_G, "XLuaAudioManager")' in lua
    assert "luaAudioManager.GetCurrentMusicAudioInfo" in lua
    assert "id       = info.Id or fallbackId" in lua
    assert "cueId    = info.CueId" in lua
    assert "name     = info.CueName or tostring(info.CueId)" in lua
    assert "acbPath  = info.AcbFile" in lua
    assert "awbPath  = info.AwbFile" in lua
    assert "bgm.instanceId = bgm.id" in lua
    assert "bgm.cueId    = info.Id" not in lua
    assert "bgm.name     = info.Name" not in lua


def test_audio_events_are_captured_by_instance_and_sent_with_snapshots():
    lua = read(RUNTIME_LUA)

    assert "local function _av_captureAudioTransitions(now)" in lua
    assert 'if not previous[key] then _av_queueAudioEvent("Play", current[key]) end' in lua
    assert 'if not current[key] then' in lua
    assert '_av_queueAudioEvent("Stop", previous[key])' in lua
    assert "_av_captureAudioTransitions(now)" in lua
    assert "audio.eventStream = true" in lua
    assert "audio.events = LuaAvMonitor._pendingAudioEvents" in lua
    assert "#events > 500" in lua


def test_frontend_consumes_audio_events_before_snapshot_throttle():
    jsx = read(AV_MONITOR_JSX)

    assert "{bgm.instanceId ?? '--'}" in jsx
    assert "{item.id ?? '--'}" in jsx
    event_consumer = "if (data.audio?.eventStream && data.audio.events?.length)"
    throttle = "if (now - lastUpdateRef.current < refreshIntervalRef.current * 1000) return"
    assert event_consumer in jsx
    assert jsx.index(event_consumer) < jsx.index(throttle)
    assert "if (!data.audio.eventStream && prevList)" in jsx
    assert "String(a.id ?? `${a.cueId}:${a.name}`)" in jsx
    assert "slice(0, 500)" in jsx


def test_frontend_heartbeats_keep_game_side_subscription_alive():
    jsx = read(AV_MONITOR_JSX)

    assert "游戏侧 AV 订阅 30 秒无命令会超时" in jsx
    assert "body: JSON.stringify({ action: 'snapshot' })" in jsx
    assert "}, 20000)" in jsx


def test_audio_controls_use_current_client_api_names():
    lua = read(RUNTIME_LUA)

    assert "CS.XAudioManager.ChangeMusicVolume(val)" in lua
    assert "CS.XAudioManager.ChangeSFXVolume(val)" in lua
    assert "CS.XAudioManager.ChangeVoiceVolume(val)" in lua
    assert "CS.XAudioManager.ChangeMusicVolumeSecond(val)" in lua
    assert "CS.XAudioManager.ChangeSFXVolumeSecond(val)" in lua
    assert "CS.XAudioManager.ChangeVoiceVolumeSecond(val)" in lua
    assert "CS.XAudioManager.Mute(enabled)" in lua
    assert "CS.XAudioManager.GetIsMuteAisacByPlayType(v)" in lua
    assert "CS.XAudioManager.MuteAisacByPlayType(value, enabled)" in lua
    assert "CS.XAudioManager.StopMusic()" in lua
    assert "CS.XAudioManager.InitConfig()" in lua

    assert "SetMusicVolume" not in lua
    assert "SetSFXVolume" not in lua
    assert "SetCvVolume" not in lua
    assert "CheckIsAisacMute" not in lua
    assert "StopByPlayType" not in lua
    assert "ReloadSound" not in lua


def test_play_and_query_controls_use_lua_manager_and_cue_config():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    assert 'local audioManager = rawget(_G, "XLuaAudioManager")' in lua
    assert "audioManager.PlayAudioByType(musicType, cueId)" in lua
    assert "audioManager.PlayAudioByType(tpl.PlayType, cid)" in lua
    assert "CS.XLuaAudioManager" not in lua

    assert "CS.XAudioManager.GetCueTemplate(cueId)" in lua
    assert "CS.XAudioManager.GetCueSheetTemplate(cue.CueSheetId)" in lua
    assert "CS.XAudioManager.FindByCueId" not in lua
    assert "durationMs    = cue.Duration" in lua
    assert "result.acbPath = sheet.CueSheetName" in lua

    assert "sendCmd('play_bgm', { cueId: bgm?.cueId })" in jsx
    assert "disabled={bgm?.cueId == null}" in jsx
    assert "toggleAisacMute(aisacKey)" in jsx


def test_control_failures_are_returned_and_shown_in_web():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    assert "local function _av_runCommand(action, callback)" in lua
    assert "_av_sendResp(action, nil, tostring(result))" in lua
    assert "控制命令失败：{commandError}" in jsx
    assert "if (msg.data?.error && msg.type !== 'query_cue')" in jsx


def test_all_named_cri_atom_sources_are_exposed_and_controllable():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    source_fields = {
        "default": "DefaultSource",
        "ambient": "AmbientSource",
        "music": "MusicSource",
        "voice": "VoiceSource",
        "lipsShape": "LipsShapeSource",
        "gameplaySpecial": "GamePlaySpecialSource",
    }
    for source_name, field_name in source_fields.items():
        assert f'sourceName == "{source_name}"' in lua
        assert f"manager.{field_name}" in lua
        assert f"['{source_name}'," in jsx

    assert 'elseif action == "set_source_volume" then' in lua
    assert "source.volume = val" in lua
    assert "sendCmd('set_source_volume', { source, value: val })" in jsx
    assert "setSourceVol(key, v)" in jsx
    assert "Source 音量 (CriAtomSource)" in jsx
    assert "Source 音量 (只读)" not in jsx


def test_per_frame_audio_scan_only_builds_details_for_new_instances():
    lua = read(RUNTIME_LUA)

    assert "local instanceId = info.Id" in lua
    assert "local entry = previous and previous[key] or nil" in lua
    assert "entry = _av_audioEntry(info, i)" in lua
    scan = lua[lua.index("local function _av_captureAudioTransitions"):lua.index("-- 收集音频快照")]
    assert "if not entry then" in scan
    assert "_av_refreshAudioEntry(entry, info)" not in scan
    assert "local latestTime = info.Time" in scan
    assert "if latestTime and latestTime >= 0 then" in scan
    assert "entry.time = latestTime" in scan


def test_active_audio_list_exposes_cue_and_duration_aware_progress():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    assert "Number.isFinite(duration) && duration > 0" in jsx
    assert "Number.isFinite(duration) && duration < 0" in jsx
    assert "time / duration" in jsx
    assert "Cue:{item.cueId ?? '--'}" in jsx
    assert "{timing.isLoop ? 'Loop'" in jsx
    assert "{progressPercent}%" in jsx
    assert "(value / 1000).toFixed(2)" in jsx
    assert "info.CriAtomExPlayback:IsPaused()" in lua
    assert "info.CriAtomExPlayback.status" in lua
    assert "info.Pausing" not in lua[lua.index("local function _av_audioEntry"):lua.index("local function _av_audioEventEnabled")]
    assert "<AudioStatusBadge paused={isPaused} status={playbackStatus}" in jsx
    assert "grid-cols-[12px_68px_44px_minmax(80px,1fr)_72px_138px_58px]" in jsx
    assert "{history ? compactTimestamp(item.startedAt) : '实时'}" in jsx
    assert "<Check size={9} />已结束" in jsx
    assert "SelectorLabelDic" in jsx
    assert "Source Vol." in jsx
    card_header = jsx[jsx.index('<button className="relative w-full'):jsx.index('<div className={`grid transition-[grid-template-rows,opacity]', jsx.index('<button className="relative w-full'))]
    assert "{pct(item.volume)}" not in card_header

    active_list = jsx.index("{/* 2. Active Audio List */}")
    volume_mixer = jsx.index("{/* 4. Volume Mixer */}")
    assert active_list < volume_mixer


def test_audio_history_is_owned_by_hub_and_exposed_to_frontend():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)
    main = read(ROOT / "tools" / "gm_console" / "main.py")

    assert "LuaAvMonitor._audioHistory" not in lua
    assert "audio.historyEvents = LuaAvMonitor._pendingAudioHistoryEvents" in lua
    assert "AV_AUDIO_HISTORY_MAX_ENTRIES = 100" in main
    assert 'audio["history"] = _cache_av_audio_history(client_id, audio)' in main
    assert 'title="最近音频历史"' in jsx
    assert "historyPaused" in jsx
    assert "清空视图" in jsx
    assert "useState({ active: null, history: null })" in jsx
    assert "toggleAudioEntry('active', item.id ?? i)" in jsx
    assert "toggleAudioEntry('history', item.historySeq ?? i)" in jsx


def test_audio_history_lifetime_uses_event_timestamps_when_events_arrive_together():
    from tools.gm_console import main

    client_id = "audio-lifetime-test"
    main.av_audio_history_cache.pop(client_id, None)
    history = main._cache_av_audio_history(client_id, {
        "historyEvents": [
            {"action": "Play", "instanceId": 1, "occurredAt": "2026-09-06 15:32:36.584", "entry": {"id": 1}},
            {"action": "Stop", "instanceId": 1, "occurredAt": "2026-09-06 15:32:37.124", "entry": {"id": 1}},
        ]
    })

    assert abs(history[0]["lifetimeSeconds"] - 0.54) < 0.001
    main.av_audio_history_cache.pop(client_id, None)


def test_audio_cutoff_fields_are_always_visible():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    assert "entry.durationForEndtime = info.DurationForEndtime" in lua
    assert "entry.stopRemaining = math.max(0, stopAt - CS.UnityEngine.Time.time)" in lua
    assert "audioParam(item.startTime)" in jsx
    assert "audioParam(item.endTime)" in jsx
    assert "audioParam(item.lastFor)" in jsx
    assert "audioParam(item.durationForEndtime)" in jsx
    assert "音频截取与停止" in jsx
    assert "未启用" in jsx


def test_monitor_sections_use_animated_collapsible_container():
    jsx = read(AV_MONITOR_JSX)

    assert "function CollapsibleSection" in jsx
    assert "transition-[grid-template-rows,opacity]" in jsx
    assert "[overflow-anchor:none]" in jsx
    for title in ["当前 BGM", "活跃音频列表", "最近音频历史", "音量调节", "音频事件日志", "Cue 信息查询", "Debug 开关", "CRI 资源指标", "播放器", "事件日志"]:
        assert f'title="{title}"' in jsx


def test_audio_entries_share_one_detail_component_and_persist_sections():
    jsx = read(AV_MONITOR_JSX)

    assert "function AudioEntryCard" in jsx
    assert "业务与实例" in jsx
    assert "CRI 播放参数" in jsx
    assert "生命周期" in jsx
    assert "gm_av_audio_sections" in jsx
    assert "gm_av_video_sections" in jsx


def test_audio_entry_exposes_source_transform_and_compact_history_time():
    lua = read(RUNTIME_LUA)
    jsx = read(AV_MONITOR_JSX)

    assert "detail.transformId = info.Source.transform:GetInstanceID()" in lua
    assert "transformId = detail.transformId" in lua
    assert 'label="TransformId"' in jsx
    assert "function historyTimestamp" in jsx
    assert "replace(/^\\d{4}-/, '')" in jsx


def test_cue_info_query_reuses_loaded_acb_and_releases_temporary_acb():
    lua = read(RUNTIME_LUA)

    query = lua[lua.index('elseif action == "query_cue" then'):lua.index('elseif action == "set_debug_flag" then')]
    assert "CS.CriWare.CriAtom.GetAcb(sheet.CueSheetName)" in query
    assert "CS.XAudioManager.TransformPath(sheet.CueSheetName)" in query
    assert "CS.CriWare.CriAtomExAcb.LoadAcbFile(nil, acbPath, awbPath)" in query
    assert "temporaryAcb = acb" in query
    assert "temporaryAcb:Dispose()" in query
    assert "CS.XAudioManager.GetCueInfoSync" not in query


def test_cue_info_query_returns_cri_metadata_and_first_waveform_only():
    lua = read(RUNTIME_LUA)

    for field in ["cueInfo", "pos3d", "firstWaveform", "aisacControls", "numTracks", "numRelatedWaveForms"]:
        assert field in lua
    assert "acb:GetCueInfo(cue.CueName)" in lua
    assert "acb:GetWaveFormInfo(cue.CueName)" in lua
    assert "acb:GetNumUsableAisacControls(cue.CueName)" in lua
    assert "acb:GetUsableAisacControl(cue.CueName, i)" in lua


def test_cue_info_drawer_and_audio_list_query_entry_are_exposed():
    jsx = read(AV_MONITOR_JSX)

    assert "function CueInfoDrawer" in jsx
    assert 'w-[480px]' in jsx
    assert 'aria-label="Cue 信息查询结果"' in jsx
    assert 'aria-hidden="true" className="absolute inset-0 bg-[var(--coffee-deep)]/20"' in jsx
    assert 'backdrop-blur-[1px]' not in jsx
    assert "event.key === 'Escape'" in jsx
    assert "onQueryCue(item.cueId)" in jsx
    assert "queryCue(bgm.cueId)" in jsx
    assert "首个 Track 中最先播放的 Waveform" in jsx
    assert "function cueBoolean" in jsx
    assert "function cueAisacId" in jsx
    assert "function cueProbability" in jsx
    assert "function cueSilentMode" in jsx
    assert "id === 0xFFFFFFFF ? 'Invalid'" in jsx
    assert "Number(cue?.lengthMs) >= 0" in jsx
    assert 'label="ACB 来源"' not in jsx
    assert 'label="Header Visible"' not in jsx
    assert 'label="Selector Index"' not in jsx
    for group in ["业务与资源", "Cue 基础信息", "播放策略", "3D 参数", "首个 Waveform", "AISAC"]:
        assert f'title="{group}"' in jsx
