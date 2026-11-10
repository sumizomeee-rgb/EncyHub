import test from 'node:test'
import assert from 'node:assert/strict'
import { requireIndependentRuntime } from './behaviorTreeRuntime.js'

test('客户端生命周期只由树决定，不再构造网页租约或全局总时限', () => {
  assert.equal(requireIndependentRuntime({ executionLifetime: 'tree' }), undefined)
})

test('拒绝仍有隐含租约或默认总时限的旧客户端，不能假装已独立运行', () => {
  for (const capability of [{}, { runModes: ['autonomous', 'debug'] }, { executionLifetime: 'lease' }]) {
    assert.throws(() => requireIndependentRuntime(capability), /更新/)
  }
})
