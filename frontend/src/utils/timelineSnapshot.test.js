import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTimelineSnapshot } from './timelineSnapshot.js'

const initial = () => ({
    instanceId: 1, assetId: 10, assetName: 'SameName', currentTime: 0,
    tracks: [{ trackName: 'Animation', trackType: 'AnimationTrack', boundObjectName: 'Actor',
        clips: [{ name: 'Walk', start: 0, duration: 2 }] }],
    events: [{ time: 1, methodName: 'Fire' }],
    trackStates: [{ muted: false, isActive: [true] }],
})

test('dynamic packets retain structure and events and update muted/activity, without mutating displayed snapshots', () => {
    const first = mergeTimelineSnapshot(undefined, initial())
    const next = mergeTimelineSnapshot(first, { instanceId: 1, assetId: 10, currentTime: 3,
        trackStates: [{ muted: true, isActive: [false] }] })
    assert.equal(next.tracks[0].clips[0].name, 'Walk')
    assert.equal(next.tracks[0].boundObjectName, 'Actor')
    assert.equal(next.tracks[0].muted, true)
    assert.equal(next.tracks[0].clips[0].isActive, false)
    assert.deepEqual(next.events, initial().events)
    assert.equal(first.currentTime, 0)
    assert.equal(first.tracks[0].clips[0].isActive, true)
})

test('different asset instances sharing a name cannot reuse old structure', () => {
    const first = mergeTimelineSnapshot(undefined, initial())
    const next = mergeTimelineSnapshot(first, { instanceId: 1, assetId: 11, assetName: 'SameName', trackStates: {} })
    assert.deepEqual(next.tracks, [])
    assert.deepEqual(next.events, [])
})

test('Lua empty objects normalize at all collection boundaries', () => {
    const first = mergeTimelineSnapshot(undefined, { assetId: 1, tracks: [{ clips: {} }], events: {}, trackStates: [{ isActive: {} }] })
    assert.deepEqual(first.tracks[0].clips, [])
    assert.deepEqual(first.events, [])
    assert.deepEqual(mergeTimelineSnapshot(first, { assetId: 1, tracks: {}, events: {}, trackStates: {} }).tracks, [])
})

test('legacy full snapshots preserve omitted events, update activity and reset when asset names change', () => {
    const packet = initial()
    delete packet.assetId
    delete packet.trackStates
    packet.tracks[0].muted = true
    packet.tracks[0].clips[0].isActive = true
    const first = mergeTimelineSnapshot(undefined, packet)
    assert.equal(first.tracks[0].muted, true)
    const { events, ...dynamic } = packet
    const next = mergeTimelineSnapshot(first, dynamic)
    assert.deepEqual(next.events, events)
    assert.equal(next.tracks[0].clips[0].isActive, true)
    assert.deepEqual(mergeTimelineSnapshot(next, { ...dynamic, assetName: 'Other' }).events, [])
})

test('paused display can keep its snapshot while cache receives new structure and subsequent dynamic updates', () => {
    const displayed = mergeTimelineSnapshot(undefined, initial())
    let cached = mergeTimelineSnapshot(displayed, { ...initial(), assetId: 20,
        tracks: [{ trackName: 'New', clips: [{ name: 'Run', start: 2, duration: 3 }] }] })
    cached = mergeTimelineSnapshot(cached, { assetId: 20, currentTime: 4, trackStates: [{ muted: false, isActive: [false] }] })
    assert.equal(displayed.assetId, 10)
    assert.equal(displayed.tracks[0].clips[0].name, 'Walk')
    assert.equal(cached.assetId, 20)
    assert.equal(cached.tracks[0].clips[0].name, 'Run')
    assert.equal(cached.currentTime, 4)
})

test('cleared subscriptions and reconnect full snapshots start from fresh metadata', () => {
    const next = mergeTimelineSnapshot(undefined, { ...initial(), events: {}, tracks: {} })
    assert.deepEqual(next.tracks, [])
    assert.deepEqual(next.events, [])
    const refreshed = mergeTimelineSnapshot(mergeTimelineSnapshot(undefined, initial()), { ...initial(), tracks: [{ clips: [] }] })
    assert.equal(refreshed.tracks[0].trackName, undefined)
})
