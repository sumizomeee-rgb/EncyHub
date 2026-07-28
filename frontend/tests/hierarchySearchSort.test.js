import test from 'node:test'
import assert from 'node:assert/strict'

import {
    getHierarchySearchHitDepth,
    sortHierarchyGoSearchHits,
    sortHierarchySearchHits,
} from '../src/utils/hierarchySearchSort.js'

test('sorts deeper hierarchy hits before shallower hits', () => {
    const hits = [
        { id: 'root', hierarchyPath: 'Root', activeInHierarchy: true },
        { id: 'child', hierarchyPath: 'Root/Child', activeInHierarchy: true },
        { id: 'leaf', hierarchyPath: 'Root/Child/Leaf', activeInHierarchy: false },
    ]

    assert.deepEqual(
        sortHierarchySearchHits(hits).map(hit => hit.id),
        ['leaf', 'child', 'root'],
    )
})

test('sorts active hits first at the same depth and keeps ties stable', () => {
    const hits = [
        { id: 'inactive-1', hierarchyPath: 'Root/A', activeInHierarchy: false },
        { id: 'active-1', hierarchyPath: 'Root/B', activeInHierarchy: true },
        { id: 'active-2', hierarchyPath: 'Root/C', activeInHierarchy: true },
        { id: 'inactive-2', hierarchyPath: 'Root/D', activeInHierarchy: false },
    ]

    assert.deepEqual(
        sortHierarchySearchHits(hits).map(hit => hit.id),
        ['active-1', 'active-2', 'inactive-1', 'inactive-2'],
    )
})

test('prefers explicit depth, then ancestor chain, then hierarchy path', () => {
    assert.equal(getHierarchySearchHitDepth({ depth: 7, ancestorChain: [1], hierarchyPath: 'Root' }), 7)
    assert.equal(getHierarchySearchHitDepth({ ancestorChain: [1, 2, 3], hierarchyPath: 'Root' }), 2)
    assert.equal(getHierarchySearchHitDepth({ hierarchyPath: '/Root/Panel/Button/' }), 2)
    assert.equal(getHierarchySearchHitDepth({ goPath: 'Root/Panel' }), 1)
})

test('does not mutate the response hit array', () => {
    const hits = [
        { id: 'root', hierarchyPath: 'Root' },
        { id: 'leaf', hierarchyPath: 'Root/Leaf' },
    ]

    const sorted = sortHierarchySearchHits(hits)

    assert.notEqual(sorted, hits)
    assert.deepEqual(hits.map(hit => hit.id), ['root', 'leaf'])
})

test('普通 GO 搜索把名称精确匹配排在路径匹配之前', () => {
    const hits = [
        { id: 'deep-path', goName: 'Panel', hierarchyPath: 'Root/BtnTerminal/Panel', activeInHierarchy: true },
        { id: 'name-contains', goName: 'MyBtnTerminal(Clone)', hierarchyPath: 'Root/MyBtnTerminal(Clone)', activeInHierarchy: true },
        { id: 'exact', goName: 'BtnTerminal', hierarchyPath: 'Root/BtnTerminal', activeInHierarchy: false },
        { id: 'prefix', goName: 'BtnTerminalExtra', hierarchyPath: 'Root/BtnTerminalExtra', activeInHierarchy: true },
    ]

    assert.deepEqual(
        sortHierarchyGoSearchHits(hits, 'BtnTerminal').map(hit => hit.id),
        ['exact', 'prefix', 'name-contains', 'deep-path'],
    )
})

test('普通 GO 搜索在同匹配度下仍优先 active 和更深节点', () => {
    const hits = [
        { id: 'shallow-active', goName: 'MyBtnTerminal', hierarchyPath: 'Root/MyBtnTerminal', activeInHierarchy: true },
        { id: 'deep-inactive', goName: 'MyBtnTerminal', hierarchyPath: 'Root/Panel/MyBtnTerminal', activeInHierarchy: false },
        { id: 'deep-active', goName: 'MyBtnTerminal', hierarchyPath: 'Root/Panel/MyBtnTerminal', activeInHierarchy: true },
    ]

    assert.deepEqual(
        sortHierarchyGoSearchHits(hits, 'BtnTerminal').map(hit => hit.id),
        ['deep-active', 'shallow-active', 'deep-inactive'],
    )
})
