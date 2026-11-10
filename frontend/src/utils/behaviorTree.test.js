import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addNode, bindingHealth, connectNode, editableTreeErrors, emptyTree, friendlyError, jsonDraftErrors, jsonInputText, mergeObjects, newId, outline, parameterErrors, parseJsonInput, reasonText, recordJsonDraft, removeNode, runEffects, slotTitle, startBlockers, targetFit, treeLayout, treeSlots } from './behaviorTree.js'

const composite = { id: 'sequence', version: 1, params: { properties: { reactive: { default: false } } } }
const leaf = { id: 'wait', version: 1, params: { properties: { seconds: { default: 1 } } } }
test('目录默认值、父子、大纲和画布使用同一树模型', () => {
  let tree = addNode(emptyTree(), composite)
  const root = tree.root
  tree = addNode(tree, leaf, root)
  const child = tree.nodes[1].id
  assert.deepEqual(tree.nodes[0].children, [child])
  assert.equal(tree.nodes[1].params.seconds, 1)
  assert.deepEqual(outline(tree).map(row => row.depth), [0, 1])
  assert.ok(treeLayout(tree)[child].x > treeLayout(tree)[root].x)
  assert.equal(removeNode(tree, child).nodes[0].children.length, 0)
})
test('连接拒绝循环和根节点被当子节点；重新挂载仅一个父节点', () => {
  let tree = addNode(emptyTree(), composite)
  tree = addNode(tree, composite, tree.root)
  tree = addNode(tree, leaf, tree.nodes[1].id)
  assert.throws(() => connectNode(tree, tree.nodes[2].id, tree.nodes[1].id), /循环/)
  assert.throws(() => connectNode(tree, tree.nodes[1].id, tree.root), /根节点/)
  tree = connectNode(tree, tree.root, tree.nodes[2].id)
  assert.equal(tree.nodes[1].children.length, 0)
})
test('数字范围、必填与枚举校验', () => {
  assert.equal(parameterErrors({ n: 1.5, mode: 'wrong' }, { required: ['missing'], properties: { n: { type: 'integer', minimum: 2 }, mode: { enum: ['a'] } } }).length, 4)
})
test('新增ID不依赖LAN HTTP禁用的randomUUID', () => {
  assert.notEqual(newId(), newId())
})

test('JSON字段区分未填、null、空对象、数组和空字符串，嵌套值往返保真', () => {
  assert.equal(jsonInputText(undefined), '')
  for (const value of [null, {}, [], '', false, 0, { nil: null, list: [null, {}, [], false, 0, ''] }]) {
    const parsed = parseJsonInput(jsonInputText(value))
    assert.equal(parsed.error, '')
    assert.deepEqual(parsed.value, value)
  }
})
test('JSON草稿拒绝语法错误、非有限数和不匹配的对象/数组形状', () => {
  assert.ok(parseJsonInput('{"unfinished":').error)
  assert.ok(parseJsonInput('{"huge":[1e999]}').error)
  assert.ok(parseJsonInput('null', { type: 'object' }).error)
  assert.ok(parseJsonInput('[]', { type: 'object' }).error)
  assert.ok(parseJsonInput('{}', { type: 'array' }).error)
  assert.equal(parseJsonInput('[]', { type: 'array' }).error, '')
})
test('required只要求提供值，无类型约束的null和字符串空值不被当成缺失', () => {
  assert.deepEqual(parameterErrors({ value: null, text: '' }, { required: ['value', 'text'], properties: { value: {}, text: { type: 'string' } } }), [])
  assert.ok(parameterErrors({ value: null }, { properties: { value: { type: 'number' } } }).length)
  assert.ok(parameterErrors({}, { required: ['value'] }).length)
})
test('畸形预设保留但拒绝打开；未知扩展节点的正确结构可编辑', () => {
  const tree = addNode(emptyTree(), { id: 'future-node', version: 9, params: {} })
  assert.deepEqual(editableTreeErrors(tree), [])
  assert.ok(editableTreeErrors({ ...tree, nodes: {} }).length)
  assert.ok(editableTreeErrors({ ...tree, nodes: [{ ...tree.nodes[0], params: null }] }).length)
  assert.ok(editableTreeErrors({ ...tree, roles: [] }).length)
  assert.ok(editableTreeErrors({ ...tree, blackboard: [] }).length)
})

test('无效JSON草稿跨节点切换仍保留文本并阻止提交，修正后解除', () => {
  const firstKey = JSON.stringify(['first', 'value'])
  const nextKey = JSON.stringify(['second', 'value'])
  let result = recordJsonDraft({}, firstKey, '{"未完":', {})
  assert.ok(result.error)
  assert.equal(result.value, undefined)
  result = recordJsonDraft(result.drafts, nextKey, 'null', {})
  assert.equal(result.value, null)
  assert.equal(result.drafts[firstKey].text, '{"未完":')
  assert.equal(Object.keys(jsonDraftErrors(result.drafts)).length, 1)
  result = recordJsonDraft(result.drafts, firstKey, '{"未完": []}', {})
  assert.deepEqual(result.value, { 未完: [] })
  assert.deepEqual(jsonDraftErrors(result.drafts), {})
  assert.equal(result.drafts[nextKey].text, 'null')
})

test('r3正式新节点沿通用目录加载默认参数、范围与必填，不猜技能ID', () => {
  const catalog = JSON.parse(readFileSync(new URL('../../../tools/gm_console/behavior_tree_nodes.json', import.meta.url), 'utf8'))
  const definition = catalog.find(node => node.id === 'fight_normal_attack')
  assert.ok(definition)
  const node = addNode(emptyTree(), definition).nodes[0]
  assert.equal(node.params.timeout, 2)
  assert.equal(node.params.expectedSkillId, undefined)
  assert.ok(parameterErrors(node.params, definition.params).some(error => error.startsWith('expectedSkillId')))
  assert.deepEqual(parameterErrors({ role: 'player', output: 'attack', timeout: 2, expectedSkillId: 1 }, definition.params), [])
  assert.ok(parameterErrors({ role: 'player', output: 'attack', timeout: 11, expectedSkillId: 0 }, definition.params).length >= 2)
})

const catalog = JSON.parse(readFileSync(new URL('../../../tools/gm_console/behavior_tree_nodes.json', import.meta.url), 'utf8'))
const definitions = Object.fromEntries(catalog.map(item => [item.id, item]))
const attackTree = () => {
  let tree = addNode(emptyTree(), definitions.fight_normal_attack)
  tree = { ...tree, roles: { player: { kind: 'fight' } }, nodes: tree.nodes.map(node => ({ ...node, params: { ...node.params, role: 'player' } })) }
  return tree
}
const token = (kind, id, generation = 1) => ({ sessionId: 's', scene: 'scene-1', kind, id, generation })
const player = (capabilities, extra = {}) => ({ name: '当前玩家 1', token: token('fight', 'fight:1'), capabilities, controllable: capabilities.includes('fight.normal_attack'), valid: true, ...extra })

test('目标槽由树里节点的角色参数推导能力需求和使用节点', () => {
  const slots = treeSlots(attackTree(), definitions)
  assert.equal(slots.length, 1)
  assert.deepEqual(slots[0].requirements, ['fight.normal_attack'])
  assert.equal(slots[0].nodes[0].name, definitions.fight_normal_attack.name)
  assert.equal(slotTitle(slots[0], slots), '战斗玩家')
  assert.deepEqual(treeSlots({ ...emptyTree(), roles: { a: { kind: 'gameobject' }, b: { kind: 'gameobject' } } }, definitions).map(slot => slotTitle(slot, treeSlots({ ...emptyTree(), roles: { a: { kind: 'gameobject' }, b: { kind: 'gameobject' } } }, definitions))), ['GameObject · a', 'GameObject · b'])
})
test('候选目标适配：可控制、只读不满足普攻（暂停）、失效与类型不符都给出人话原因', () => {
  const [slot] = treeSlots(attackTree(), definitions)
  assert.equal(targetFit(player(['fight.read', 'fight.normal_attack']), slot).usable, true)
  const paused = targetFit(player(['fight.read']), slot)
  assert.equal(paused.usable, false)
  assert.match(paused.reasons[0], /暂停/)
  assert.match(targetFit(player(['fight.read', 'fight.normal_attack'], { valid: false }), slot).reasons[0], /失效/)
  assert.match(targetFit({ name: 'Cube', token: token('gameobject', 'go:1'), capabilities: ['gameobject.read'] }, slot).reasons[0], /类型不符/)
})
test('发现结果合并：战斗玩家整组替换，GameObject按id覆盖', () => {
  const first = player(['fight.read'])
  const go = { name: 'A', token: token('gameobject', 'go:1') }
  let list = mergeObjects([], [first, go], undefined)
  list = mergeObjects(list, [], 'fight')
  assert.deepEqual(list.map(item => item.name), ['A'])
  list = mergeObjects(list, [{ ...go, token: token('gameobject', 'go:1', 2) }])
  assert.equal(list.length, 1)
  assert.equal(list[0].token.generation, 2)
})
test('已选目标健康度：能力降级、代次更新、重扫后消失都阻止开始且不替换目标', () => {
  const tree = attackTree()
  const slots = treeSlots(tree, definitions)
  const chosen = player(['fight.read', 'fight.normal_attack'])
  assert.equal(bindingHealth(chosen, slots[0], [chosen], false).level, 'ok')
  assert.equal(bindingHealth(chosen, slots[0], [player(['fight.read'])], true).level, 'blocked')
  assert.equal(bindingHealth(chosen, slots[0], [player(['fight.read', 'fight.normal_attack'], { token: token('fight', 'fight:1', 2) })], true).level, 'stale')
  assert.equal(bindingHealth(chosen, slots[0], [], true).level, 'stale')
  assert.equal(bindingHealth(chosen, slots[0], [], false).level, 'ok')
  const health = { player: bindingHealth(chosen, slots[0], [], true) }
  assert.match(startBlockers({ slots, bound: { player: chosen }, health })[0], /已失效/)
  assert.deepEqual(startBlockers({ slots, bound: { player: chosen }, health, includeBroken: false }), [])
  assert.match(startBlockers({ slots, bound: {}, health: {} })[0], /还没选择/)
  assert.deepEqual(startBlockers({ slots, bound: { player: chosen }, health: { player: { level: 'ok' } } }), [])
})
test('运行性质、错误码与停止原因转成人话', () => {
  assert.equal(runEffects(attackTree(), definitions).controls, true)
  assert.equal(runEffects(addNode(emptyTree(), definitions.wait), definitions).controls, false)
  assert.match(friendlyError('binding_invalid:player'), /失效/)
  assert.match(friendlyError('binding_capability:abc'), /暂停/)
  assert.match(friendlyError('run_already_active'), /已有一个行为树/)
  assert.equal(friendlyError('其他错误'), '其他错误')
  assert.match(reasonText('user_stop'), /停止/)
  assert.equal(reasonText('自由文本'), '自由文本')
})

test('只有全部节点明确声明无副作用才算只读；未知节点、缺省或未识别副作用一律按会控制处理', () => {
  const readOnly = addNode(emptyTree(), definitions.wait)
  assert.equal(runEffects(readOnly, definitions).controls, false)
  assert.equal(runEffects(readOnly, {}).controls, true)
  assert.equal(runEffects(addNode(emptyTree(), { id: 'future', version: 1, params: {} }), {}).controls, true)
  const lua = { id: 'lua_script', name: 'Lua 脚本', version: 1, sideEffect: 'arbitrary_lua', params: {} }
  const withLua = addNode(readOnly, lua)
  const effects = runEffects(withLua, { ...definitions, lua_script: lua })
  assert.equal(effects.controls, true)
  assert.match(effects.labels[0], /按会控制处理/)
  assert.equal(runEffects(addNode(readOnly, { id: 'nodeclared', version: 1, params: {} }), { ...definitions, nodeclared: { id: 'nodeclared', name: 'x' } }).controls, true)
})
