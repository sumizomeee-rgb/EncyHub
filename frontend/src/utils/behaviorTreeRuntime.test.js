import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreEditorDraft, selectRuntimeRun } from './behaviorTreeRuntime.js'

test('发现外部运行，活跃运行优先，历史按开始时间而非返回顺序选择', () => {
  const old = { runId: 'z', state: 'succeeded', startedAt: 1 }
  const recent = { runId: 'a', state: 'stopped', startedAt: 9 }
  const live = { runId: 'external', state: 'running', startedAt: 5 }
  assert.equal(selectRuntimeRun([old, recent, live], old.runId), live)
  assert.equal(selectRuntimeRun([recent, old]), recent)
  assert.equal(selectRuntimeRun([recent, old], old.runId), old)
  assert.equal(selectRuntimeRun([]), undefined)
})

test('刷新可恢复未保存草稿，包括尚未有效的参数输入，目标绑定不存入草稿', () => {
  const draft = { schemaVersion: 1, tree: { schemaVersion: 1, nodes: [] }, dirty: true, jsonDrafts: { x: { text: '{', error: 'invalid' } } }
  assert.deepEqual(restoreEditorDraft(JSON.stringify(draft)), draft)
  assert.equal(restoreEditorDraft('{'), null)
  assert.equal(restoreEditorDraft(JSON.stringify({ schemaVersion: 2 })), null)
})
