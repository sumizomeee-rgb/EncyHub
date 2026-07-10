function hierarchyPathDepth(path) {
    if (!path) return 0
    const segmentCount = String(path).split('/').filter(Boolean).length
    return Math.max(0, segmentCount - 1)
}

export function getHierarchySearchHitDepth(hit) {
    if (hit?.depth != null) {
        const depth = Number(hit.depth)
        if (Number.isFinite(depth)) return depth
    }

    if (Array.isArray(hit?.ancestorChain) && hit.ancestorChain.length > 0) {
        return hit.ancestorChain.length - 1
    }

    return hierarchyPathDepth(hit?.hierarchyPath || hit?.goPath)
}

function isHierarchySearchHitActive(hit) {
    if (typeof hit?.activeInHierarchy === 'boolean') return hit.activeInHierarchy
    if (typeof hit?.active === 'boolean') return hit.active
    return true
}

export function sortHierarchySearchHits(hits) {
    if (!Array.isArray(hits)) return []

    return hits
        .map((hit, index) => ({
            hit,
            index,
            depth: getHierarchySearchHitDepth(hit),
            active: isHierarchySearchHitActive(hit),
        }))
        .sort((a, b) => (
            b.depth - a.depth
            || Number(b.active) - Number(a.active)
            || a.index - b.index
        ))
        .map(entry => entry.hit)
}
