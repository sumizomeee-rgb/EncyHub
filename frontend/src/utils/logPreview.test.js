import test from 'node:test'
import assert from 'node:assert/strict'
import { logPreview } from './logPreview.js'

test('百万字采样日志只生成有界预览，原始证据保留用于复制', () => {
  const raw = '  HFE_JSON=' + 'x'.repeat(986543)
  assert.ok(logPreview(raw).length < 2100)
  assert.ok(logPreview(raw, 16000).length < 16100)
  assert.equal(raw.length, 986554)
  assert.ok(logPreview(raw).startsWith('HFE_JSON='))
  assert.match(logPreview(raw), /986552/)
})

test('普通短日志继续完整显示', () => {
  assert.equal(logPreview('  hello\nworld'), 'hello\nworld')
  assert.equal(logPreview(null), '')
  assert.equal(logPreview('abcd', 4), 'abcd')
})
