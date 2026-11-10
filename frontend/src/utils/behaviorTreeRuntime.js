// 优先当前活跃运行；结束后保留正在查看的记录，不依赖Lua pairs返回顺序。
export function selectRuntimeRun(runs = [], preferredId) {
  const active = runs.filter(run => ['running', 'awaiting_decision'].includes(run.state))
  const candidates = active.length ? active : runs
  return candidates.find(run => run.runId === preferredId)
    || [...candidates].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.runId.localeCompare(a.runId))[0]
}

// 旧运行器仍有租约或默认总时限，不能把它当作独立执行。
export function requireIndependentRuntime(capability) {
  if (capability.executionLifetime !== 'tree') throw new Error('请更新游戏内行为树运行器后开始：此版本仍有旧的运行时限')
}

export function restoreEditorDraft(raw) {
  try {
    const draft = JSON.parse(raw)
    return draft?.schemaVersion === 1 && draft.tree?.schemaVersion === 1 && Array.isArray(draft.tree.nodes) ? draft : null
  } catch { return null }
}
