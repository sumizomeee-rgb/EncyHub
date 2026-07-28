import test from 'node:test'
import assert from 'node:assert/strict'
import { splitHierarchyPathForDisplay } from '../src/utils/hierarchyPath.js'

test('长层级路径保留根节点、父节点和末尾节点', () => {
    assert.deepEqual(
        splitHierarchyPathForDisplay('UiRoot/CanvasNormal/UiEnvelopeGuessingInvitation/FullScreenBackground'),
        { prefix: 'UiRoot/.../UiEnvelopeGuessingInvitation', leaf: 'FullScreenBackground' },
    )
})

test('短路径不插入省略号', () => {
    assert.deepEqual(
        splitHierarchyPathForDisplay('UiRoot/FullScreenBackground'),
        { prefix: 'UiRoot', leaf: 'FullScreenBackground' },
    )
})
