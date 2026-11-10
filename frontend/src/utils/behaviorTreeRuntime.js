// 优先当前活跃运行；结束后保留正在查看的记录，不依赖Lua pairs返回顺序。
export function selectRuntimeRun(runs = [], preferredId) {
  const active = runs.filter(run => ['running', 'awaiting_decision'].includes(run.state))
  const candidates = active.length ? active : runs
  return candidates.find(run => run.runId === preferredId)
    || [...candidates].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.runId.localeCompare(a.runId))[0]
}

// 开始前核对客户端能力，旧运行器不能静默把自主运行当成30秒租约。
export function executionOptions(runMode, duration, supportedModes = []) {
  const seconds = Number(duration)
  if (!['autonomous', 'debug'].includes(runMode)) throw new Error('请选择有效的运行方式')
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('最长运行时间须在1～86400秒之间')
  if (!supportedModes.includes(runMode)) throw new Error('客户端运行器尚不支持此运行方式，请更新游戏内行为树运行器后开始')
  return { runMode, maxRunSeconds: seconds, ...(runMode === 'debug' ? { leaseSeconds: 30 } : {}) }
}

export function restoreEditorDraft(raw) {
  try {
    const draft = JSON.parse(raw)
    return draft?.schemaVersion === 1 && draft.tree?.schemaVersion === 1 && Array.isArray(draft.tree.nodes) ? draft : null
  } catch { return null }
}
