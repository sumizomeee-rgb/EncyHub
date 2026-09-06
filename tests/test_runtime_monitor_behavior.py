"""Execute the real Lua monitor functions with instrumented Unity stand-ins.

Install lupa in the test environment to run these optional Lua behavior checks.
"""
from pathlib import Path

import pytest

lupa = pytest.importorskip('lupa')
SOURCE = (Path(__file__).resolve().parents[1] / 'tools/gm_console/runtime_gm_client.lua').read_text(encoding='utf-8')


@pytest.fixture
def lua():
    vm = lupa.LuaRuntime(unpack_returned_tuples=True)
    vm.execute('''
        origin_print = function() end
        CS = { UnityEngine = { Time = { time = 5, realtimeSinceStartup = 5 } } }
        sent = {}
        RuntimeGMClient = { Send = function(msg) sent[#sent + 1] = msg end }
        function enumerable(items)
            return { GetEnumerator = function()
                local i = 0
                return { MoveNext = function(self)
                    i = i + 1; self.Current = items[i]; return items[i] ~= nil
                end }
            end }
        end
        scans, clips, events = 0, 0, 0
        clip = { displayName = 'clip', start = 1, duration = 2 }
        track = { name = 'track', muted = false,
            GetType = function() return {Name = 'AnimationTrack'} end,
            GetClips = function() clips = clips + 1; return enumerable({clip}) end }
        asset = { name = 'same name', GetInstanceID = function(self) return self.id end, id = 2,
            GetOutputTracks = function() scans = scans + 1; return enumerable({track}) end }
        director = { playableAsset = asset, time = 1, duration = 5, state = 'Playing',
            gameObject = { name = 'director', activeInHierarchy = true },
            GetInstanceID = function() return 10 end,
            GetGenericBinding = function() return {name = 'bound'} end }
    ''')
    start = SOURCE.index('    local LuaAnimatorMonitor = {}')
    end = SOURCE.index('    -- 前置声明：供 Hierarchy', start)
    vm.execute(SOURCE[start:end] + '\nAnimator = LuaAnimatorMonitor; Timeline = LuaTimelineMonitor')
    vm.execute('Timeline.ExtractEvents = function() events = events + 1; return {} end')
    return vm


def test_runtime_compiles(lua):
    lua.compile(SOURCE)


def test_timeline_caches_static_structure_and_updates_clip_boundaries(lua):
    lua.execute('''
        first = Timeline.TakeSnapshot(director, true)
        assert(first.assetId == 2 and first.tracks[1].clips[1].name == 'clip')
        assert(first.trackStates[1].isActive[1] == true and first.events ~= nil)
        director.time = 3; track.muted = true
        next = Timeline.TakeSnapshot(director, false)
        assert(next.tracks == nil and next.events == nil)
        assert(next.trackStates[1].muted == true and next.trackStates[1].isActive[1] == false)
        assert(scans == 1 and clips == 1 and events == 1)
        director.time = 0
        assert(Timeline.TakeSnapshot(director, false).trackStates[1].isActive[1] == false)
    ''')


def test_timeline_same_name_asset_switch_empty_asset_and_forced_refresh(lua):
    lua.execute('''
        Timeline.TakeSnapshot(director, true)
        asset.id = 3; clip.displayName = 'replacement'
        replacement = Timeline.TakeSnapshot(director, false)
        assert(replacement.assetId == 3 and replacement.tracks[1].clips[1].name == 'replacement')
        clip.displayName = 'edited in place'
        refreshed = Timeline.TakeSnapshot(director, true)
        assert(refreshed.tracks[1].clips[1].name == 'edited in place')
        assert(scans == 3 and clips == 3 and events == 3)
        director.playableAsset = nil
        empty = Timeline.TakeSnapshot(director, false)
        assert(empty.assetId == 0 and #empty.tracks == 0 and #empty.trackStates == 0 and #empty.events == 0)
    ''')


def test_timeline_unsubscribe_destroy_and_subscribe_send_static(lua):
    lua.execute('''
        Timeline._directors[10] = director
        Timeline.HandleCommand({action = 'subscribe', instanceId = 10})
        assert(sent[1].data.tracks ~= nil)
        Timeline.HandleCommand({action = 'unsubscribe', instanceId = 10})
        assert(Timeline._eventCaches[10] == nil and Timeline._monitoredCount == 0)
        Timeline.HandleCommand({action = 'subscribe', instanceId = 10})
        assert(sent[2].data.tracks ~= nil)
        director.gameObject.activeInHierarchy = false
        Timeline.Update()
        assert(Timeline._eventCaches[10] == nil and Timeline._monitoredCount == 0)
        assert(sent[3].action == 'removed')
    ''')


def test_animator_reuses_layer_snapshot_without_scanning_or_reading_state(lua):
    lua.execute('''
        tracker = {instanceId = 10, stateNameCache = {[1] = 'A', [2] = 'B'}, lastStateHashes = {[0] = 1},
            animator = { gameObject = {activeInHierarchy = true} } }
        snapshot = {timestamp = 8, layers = {{index = 0, name = 'Base',
            currentState = {nameHash = 2, name = 'B'},
            nextState = {nameHash = 3, name = 'C'}, transition = {isInTransition = true} }} }
        Animator.ScanAnimators = function() error('unexpected scene scan') end
        Animator.TakeSnapshot = function() return snapshot end
        Animator._trackers[10] = tracker; Animator._subscribedId = 10
        Animator.Update()
        assert(sent[1].snapshot == snapshot and #sent[1].stateChanges == 2)
        assert(sent[1].stateChanges[1].fromState == 'A' and sent[1].stateChanges[1].toState == 'B')
        assert(sent[1].stateChanges[2].toState == 'C' and tracker.lastStateHashes[0] == 2)
        Animator.Update()
        assert(#sent == 1)
    ''')
