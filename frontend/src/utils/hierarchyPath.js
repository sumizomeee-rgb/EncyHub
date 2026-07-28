export function splitHierarchyPathForDisplay(path) {
    const fullPath = String(path || '')
    const parts = fullPath.split('/').filter(Boolean)
    if (parts.length <= 1) {
        return { prefix: '', leaf: fullPath }
    }

    const leaf = parts[parts.length - 1]
    const prefix = parts.length <= 3
        ? parts.slice(0, -1).join('/')
        : `${parts[0]}/.../${parts[parts.length - 2]}`
    return { prefix, leaf }
}
