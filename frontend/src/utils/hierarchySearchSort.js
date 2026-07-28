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

function getGoSearchMatchRank(hit, query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return 0

    const name = String(hit?.goName || '').toLowerCase()
    const path = String(hit?.hierarchyPath || hit?.goPath || '').toLowerCase()

    if (name === q) return 0
    if (name.startsWith(q)) return 1
    if (name.includes(q)) return 2
    if (path === q) return 3
    if (path.endsWith(`/${q}`)) return 4
    return 5
}

// 普通 GO 搜索优先考虑用户输入与节点名的匹配度；
// 同匹配度下再沿用 active、层级深度和服务端稳定顺序。
export function sortHierarchyGoSearchHits(hits, query) {
    if (!Array.isArray(hits)) return []

    return hits
        .map((hit, index) => ({
            hit,
            index,
            rank: getGoSearchMatchRank(hit, query),
            depth: getHierarchySearchHitDepth(hit),
            active: isHierarchySearchHitActive(hit),
        }))
        .sort((a, b) => (
            a.rank - b.rank
            || Number(b.active) - Number(a.active)
            || b.depth - a.depth
            || a.index - b.index
        ))
        .map(entry => entry.hit)
}
