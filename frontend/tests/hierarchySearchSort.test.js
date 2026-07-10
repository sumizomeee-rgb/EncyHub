import test from 'node:test'
import assert from 'node:assert/strict'

import {
    getHierarchySearchHitDepth,
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
