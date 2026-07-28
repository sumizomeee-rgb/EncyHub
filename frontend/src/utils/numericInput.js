export function parseNumericDraft(rawValue, valueType) {
    const text = String(rawValue ?? '').trim()
    if (!text) return null

    const value = Number(text)
    if (!Number.isFinite(value)) return null
    return valueType === 'int' ? Math.trunc(value) : value
}
