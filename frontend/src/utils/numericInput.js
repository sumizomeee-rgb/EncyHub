export function parseNumericDraft(rawValue, valueType) {
    const text = String(rawValue ?? '').trim()
    if (!text) return null

    const value = Number(text)
    if (!Number.isFinite(value)) return null
    return valueType === 'int' ? Math.trunc(value) : value
}

export function stepNumericValue(rawValue, valueType, direction, step = 1) {
    const current = parseNumericDraft(rawValue, valueType)
    if (current === null) return null
    const amount = Number(step)
    if (!Number.isFinite(amount) || amount <= 0 || direction === 0) return current
    const next = current + (direction > 0 ? amount : -amount)
    return valueType === 'int' ? Math.trunc(next) : next
}
