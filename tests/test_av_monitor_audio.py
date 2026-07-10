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
    assert 'if not current[key] then _av_queueAudioEvent("Stop", previous[key]) end' in lua
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
    assert "if not entry then entry = _av_audioEntry(info, i) end" in lua
