import test from 'node:test'
import assert from 'node:assert/strict'
import { clampZoom, fitZoom, zoomAnchor } from './treeViewport.js'

test('滚轮缩放保留光标下图坐标，边界不产生负滚动', () => {
  const next = zoomAnchor(240, 120, .5, .8)
  assert.equal((next + 120) / .8, (240 + 120) / .5)
  assert.equal(zoomAnchor(0, 120, 1, .5), 0)
  assert.equal(clampZoom(.001), .08)
  assert.equal(clampZoom(10), 2.5)
  assert.equal(fitZoom(2000, 1000, 1000, 800), .5)
})
