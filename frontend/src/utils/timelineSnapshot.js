const asArray = value => Array.isArray(value) ? value : []

// Legacy clients identify assets by name; new clients send the actual asset instance ID.
export function mergeTimelineSnapshot(previous, incoming) {
    const sameAsset = previous && (incoming.assetId !== undefined || previous.assetId !== undefined
        ? incoming.assetId === previous.assetId
        : incoming.assetName === previous.assetName)
    const base = sameAsset ? previous : undefined
    const tracks = Object.hasOwn(incoming, 'tracks') ? asArray(incoming.tracks) : asArray(base?.tracks)
    const states = Object.hasOwn(incoming, 'trackStates') ? asArray(incoming.trackStates) : null
    return {
        ...base,
        ...incoming,
        tracks: tracks.map((track, ti) => ({
            ...track,
            muted: states ? Boolean(states[ti]?.muted) : Boolean(track.muted),
            clips: asArray(track.clips).map((clip, ci) => ({
                ...clip,
                isActive: states ? Boolean(asArray(states[ti]?.isActive)[ci]) : Boolean(clip.isActive),
            })),
        })),
        events: Object.hasOwn(incoming, 'events') ? asArray(incoming.events) : asArray(base?.events),
    }
}
