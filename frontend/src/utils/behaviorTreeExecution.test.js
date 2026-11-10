import test from 'node:test'
import assert from 'node:assert/strict'
import { executionOptions } from './behaviorTreeRuntime.js'

test('自主运行无需租约，联机调试显式续租，两者都带独立总时限', () => {
  const modes = ['autonomous', 'debug']
  const autonomous = executionOptions('autonomous', '90', modes)
  assert.equal(autonomous.runMode, 'autonomous')
  assert.equal(autonomous.maxRunSeconds, 90)
  assert.equal('leaseSeconds' in autonomous, false)
  assert.equal(executionOptions('debug', 90, modes).leaseSeconds, 30)
})

test('旧运行器与非法时限不能静默开始', () => {
  assert.throws(() => executionOptions('autonomous', 90), /更新/)
  for (const seconds of ['', 'abc', 0, -1, 86401, Infinity]) {
    assert.throws(() => executionOptions('autonomous', seconds, ['autonomous']), /时/)
  }
})
