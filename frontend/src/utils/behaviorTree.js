export const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('-')
export const emptyTree = () => ({ schemaVersion: 1, id: newId(), name: '新行为树', root: '', nodes: [], blackboard: {}, roles: {} })

export function addNode(tree, definition, parentId) {
  const params = Object.fromEntries(Object.entries(definition.params?.properties || {}).filter(([, s]) => s.default !== undefined).map(([key, s]) => [key, structuredClone(s.default)]))
  const node = { id: newId(), type: definition.id, version: definition.version, params, children: [] }
  const nodes = tree.nodes.map(n => n.id === parentId ? { ...n, children: [...n.children, node.id] } : n)
  return { ...tree, root: tree.root || node.id, nodes: [...nodes, node] }
}

export function connectNode(tree, parentId, childId) {
  if (parentId === childId) throw new Error('节点不能连接自己')
  if (tree.root === childId) throw new Error('根节点不能作为子节点，请先设置新的根')
  const descendants = new Set()
  const visit = id => {
    if (descendants.has(id)) return
    descendants.add(id)
    tree.nodes.find(n => n.id === id)?.children.forEach(visit)
  }
  visit(childId)
  if (descendants.has(parentId)) throw new Error('连接会产生循环')
  return { ...tree, nodes: tree.nodes.map(n => ({ ...n, children: n.id === parentId ? [...n.children.filter(id => id !== childId), childId] : n.children.filter(id => id !== childId) })) }
}

export function removeNode(tree, nodeId) {
  return { ...tree, root: tree.root === nodeId ? '' : tree.root, nodes: tree.nodes.filter(n => n.id !== nodeId).map(n => ({ ...n, children: n.children.filter(id => id !== nodeId) })) }
}

export function treeLayout(tree) {
  const positions = {}, visited = new Set()
  let row = 0
  function visit(id, depth) {
    if (visited.has(id)) return
    visited.add(id)
    positions[id] = { x: 40 + depth * 230, y: 40 + row++ * 100 }
    tree.nodes.find(n => n.id === id)?.children.forEach(child => visit(child, depth + 1))
  }
  visit(tree.root, 0)
  tree.nodes.forEach(n => visit(n.id, 0))
  return positions
}

export function outline(tree) {
  const rows = [], seen = new Set()
  function visit(id, depth) {
    const node = tree.nodes.find(n => n.id === id)
    if (!node || seen.has(id)) return
    seen.add(id); rows.push({ node, depth })
    node.children.forEach(child => visit(child, depth + 1))
  }
  visit(tree.root, 0)
  tree.nodes.forEach(n => visit(n.id, 0))
  return rows
}

export function parameterErrors(params, schema) {
  const errors = []
  for (const key of schema?.required || []) if (params[key] === undefined) errors.push(`${key}：必填`)
  for (const [key, value] of Object.entries(params)) {
    const spec = schema?.properties?.[key]
    if (!spec) continue
    if (spec.type === 'string' && typeof value !== 'string') errors.push(`${key}：请输入文本`)
    if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(`${key}：请选择布尔值`)
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) errors.push(`${key}：请输入 JSON 对象`)
    if (spec.type === 'array' && !Array.isArray(value)) errors.push(`${key}：请输入 JSON 数组`)
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${key}：请选择有效值`)
    if (spec.type === 'number' || spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) errors.push(`${key}：请输入${spec.type === 'integer' ? '整数' : '数字'}`)
      if (spec.minimum !== undefined && value < spec.minimum) errors.push(`${key}：最小 ${spec.minimum}`)
      if (spec.maximum !== undefined && value > spec.maximum) errors.push(`${key}：最大 ${spec.maximum}`)
    }
  }
  return errors
}

export function jsonInputText(value) {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

export function parseJsonInput(text, schema = {}) {
  let value
  try { value = JSON.parse(text) } catch { return { error: '请输入有效 JSON' } }
  // JSON.parse允许指数溢出为Infinity，不能让序列化把它偷偷变成null。
  function finite(item, depth = 0) {
    if (depth > 64) return false
    if (typeof item === 'number') return Number.isFinite(item)
    if (item && typeof item === 'object') return Object.values(item).every(child => finite(child, depth + 1))
    return true
  }
  if (!finite(value)) return { error: 'JSON值过深或包含非有限数字' }
  const errors = parameterErrors({ value }, { properties: { value: schema } })
  if (errors.length) return { error: errors.join('；') }
  return { value, error: '' }
}

export function recordJsonDraft(drafts, key, text, schema) {
  const parsed = parseJsonInput(text, schema)
  return { ...parsed, drafts: { ...drafts, [key]: { text, error: parsed.error } } }
}

export function jsonDraftErrors(drafts) {
  return Object.fromEntries(Object.entries(drafts).filter(([, draft]) => draft.error).map(([key, draft]) => [key, draft.error]))
}

export function editableTreeErrors(tree) {
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(tree)) return ['树必须是对象']
  const errors = []
  if (typeof tree.id !== 'string' || typeof tree.name !== 'string' || typeof tree.root !== 'string') errors.push('树id、名称和根节点必须是字符串')
  if (!object(tree.roles) || Object.values(tree.roles).some(role => !object(role) || typeof role.kind !== 'string')) errors.push('角色必须是包含kind的对象')
  if (!object(tree.blackboard)) errors.push('黑板必须是对象')
  if (!Array.isArray(tree.nodes)) errors.push('nodes必须是数组')
  else tree.nodes.forEach((node, index) => {
    if (!object(node) || typeof node.id !== 'string' || typeof node.type !== 'string' || !object(node.params) || !Array.isArray(node.children) || node.children.some(id => typeof id !== 'string')) errors.push(`nodes[${index}]的节点、参数或children形状错误`)
  })
  return errors
}

export const KIND_LABEL = { fight: '战斗玩家', gameobject: 'GameObject' }
export const kindLabel = kind => KIND_LABEL[kind] || kind || '未知'
const CAPABILITY_LABEL = { 'gameobject.read': '读取对象', 'gameobject.transform.debug': '调试位移', 'fight.read': '读取战斗状态', 'fight.normal_attack': '普攻输入' }
export const capabilityLabel = id => CAPABILITY_LABEL[id] || id
const SIDE_EFFECT_LABEL = { none: '只读', debug_state: '临时改动对象（会恢复）', gameplay_input: '模拟玩家输入', unknown: '未知副作用（按会控制处理）' }
export const sideEffectLabel = value => SIDE_EFFECT_LABEL[value] || (value ? `${value}（未识别，按会控制处理）` : SIDE_EFFECT_LABEL.unknown)
const NODE_KIND_LABEL = { composite: '组合', decorator: '装饰', action: '动作', condition: '条件' }
export const nodeKindLabel = kind => NODE_KIND_LABEL[kind] || kind || '未知'

export function treeSlots(tree, definition) {
  return Object.entries(tree.roles || {}).map(([name, role]) => {
    const requirements = [], nodes = []
    for (const node of tree.nodes) {
      let used = false
      for (const requirement of definition[node.type]?.roles || []) {
        if (node.params?.[requirement.parameter] !== name) continue
        used = true
        if (requirement.capability && !requirements.includes(requirement.capability)) requirements.push(requirement.capability)
      }
      if (used) nodes.push({ id: node.id, name: definition[node.type]?.name || node.type })
    }
    return { name, kind: role.kind, requirements, nodes }
  })
}

export function slotTitle(slot, slots) {
  return slots.filter(item => item.kind === slot.kind).length > 1 ? `${kindLabel(slot.kind)} · ${slot.name}` : kindLabel(slot.kind)
}

function missingReason(capability) {
  if (capability === 'fight.normal_attack') return '现在不满足普攻条件：战斗需在进行中（暂停菜单、未进战斗、角色倒下时都不行）。回到可操作状态后点刷新'
  if (capability === 'fight.read') return '读不到战斗状态，可能不在战斗中'
  if (capability === 'gameobject.transform.debug') return '这个对象不支持调试位移'
  if (capability === 'gameobject.read') return '这个对象不可读取'
  return `缺少能力「${capabilityLabel(capability)}」`
}

export function targetFit(object, slot) {
  const reasons = []
  if (object.token?.kind !== slot.kind) reasons.push(`类型不符，这里需要${kindLabel(slot.kind)}`)
  else {
    if (object.valid === false) reasons.push('目标已失效（对象已销毁或场景已切换）')
    for (const capability of slot.requirements) if (!(object.capabilities || []).includes(capability)) reasons.push(missingReason(capability))
  }
  return { usable: reasons.length === 0, reasons, access: object.controllable ? 'control' : 'read' }
}

export function objectLocation(object) {
  return object.token?.kind === 'fight' ? '战斗中' : `场景 ${object.token?.scene ?? '?'}`
}

export function sameToken(a, b) {
  return !!a && !!b && ['sessionId', 'scene', 'kind', 'id', 'generation'].every(key => a[key] === b[key])
}

export function mergeObjects(previous, found, replaceKind) {
  const ids = new Set(found.map(object => object.token?.id))
  return [...previous.filter(object => !(replaceKind && object.token?.kind === replaceKind) && !ids.has(object.token?.id)), ...found]
}

export function bindingHealth(bound, slot, objects, rescanned) {
  const latest = objects.find(object => object.token?.id === bound.token?.id && object.token?.kind === bound.token?.kind)
  if (!latest) return bound.token?.kind === 'fight' && rescanned
    ? { level: 'stale', text: '最新发现结果里已没有这个玩家（可能已退出战斗或切换场景），请重新选择' }
    : { level: 'ok', text: '' }
  if (!sameToken(latest.token, bound.token)) return { level: 'stale', text: '这个目标已更新，之前的选择已作废，请重新选择' }
  const fit = targetFit(latest, slot)
  return fit.usable ? { level: 'ok', text: '' } : { level: 'blocked', text: fit.reasons[0] }
}

export function startBlockers({ slots, bound, health, includeBroken = true }) {
  const reasons = []
  for (const slot of slots) {
    const title = slotTitle(slot, slots)
    if (!bound[slot.name]) reasons.push(`还没选择「${title}」`)
    else if (includeBroken && health[slot.name]?.level !== 'ok') reasons.push(`「${title}」${health[slot.name].level === 'stale' ? '已失效，需重新选择' : '当前不可用'}`)
  }
  return reasons
}

export function runEffects(tree, definition) {
  const kinds = [...new Set(tree.nodes.map(node => definition[node.type]?.sideEffect || 'unknown'))]
  return { controls: kinds.some(kind => kind !== 'none'), input: kinds.includes('gameplay_input'), labels: kinds.filter(kind => kind !== 'none').map(sideEffectLabel) }
}

const REASON_TEXT = {
  user_stop: '已按你的操作停止',
  lease_expired: '联机调试无人续租约30秒，客户端已停止这棵树',
  run_timeout: '已达到本次运行的总时限，客户端已停止这棵树',
  scene_changed: '场景已切换，已自动停止',
  object_destroyed: '目标对象已失效或销毁，已自动停止',
  unknown_state: '游戏动作结果未知，需要你判断，不会自动重试',
  input_capability_lost: '操作条件中途丢失（如进入暂停菜单）',
  no_skill_start_evidence: '没有观察到预期技能开始'
}
export const reasonText = code => REASON_TEXT[code] || code

const PARAM_LABEL = {
  reactive: '响应式（每轮都从头重新检查）', successThreshold: '成功所需数量（几个子节点成功即算成功）', failureThreshold: '失败所需数量（几个子节点失败即算失败）',
  count: '重复次数', seconds: '时长（秒）', timeout: '超时（秒）', key: '黑板键', value: '值', path: '黑板路径', operator: '比较方式',
  role: '目标', output: '结果存入黑板的键', x: '位移 X', y: '位移 Y', z: '位移 Z', distance: '距离', mode: '移动方式', angleDegrees: '角度（度）',
  expectedSkillId: '期望的技能 ID', holdSeconds: '按住时长（秒）', cooldownSeconds: '冷却（秒）', direction: '方向', stageId: '关卡 ID', enemyTemplateId: '敌人模板 ID', frames: '帧数'
}
export const paramLabel = (key, schema = {}) => schema.title || PARAM_LABEL[key] || key
const ENUM_LABEL = {
  mode: { approach: '靠近', retreat: '后退', orbit: '绕圈' },
  direction: { none: '不指定', toward: '朝向目标', away: '远离目标', left: '向左', right: '向右' },
  operator: { eq: '等于', ne: '不等于', lt: '小于', le: '小于等于', gt: '大于', ge: '大于等于' }
}
export const enumLabel = (key, value) => ENUM_LABEL[key]?.[value] ? `${ENUM_LABEL[key][value]}（${value}）` : String(value)
export function rangeHint(schema = {}) {
  const parts = []
  if (schema.minimum !== undefined && schema.maximum !== undefined) parts.push(`范围 ${schema.minimum} ~ ${schema.maximum}`)
  else if (schema.minimum !== undefined) parts.push(`最小 ${schema.minimum}`)
  else if (schema.maximum !== undefined) parts.push(`最大 ${schema.maximum}`)
  if (schema.default !== undefined && typeof schema.default !== 'object') parts.push(`默认 ${schema.default}`)
  return parts.join(' · ')
}
const CANCEL_LABEL = { none: '停止时无需清理', restore_owned_transform: '停止时还原被临时改动的位移', unsubmittedOnly: '停止时撤销尚未提交的输入', release_owned_input: '停止时释放自己按下的按键' }
export const cancelModeLabel = mode => CANCEL_LABEL[mode] || mode || '未知'

export function friendlyError(message) {
  const text = String(message || '')
  const role = text.match(/binding_invalid:([^\s"']+)/)?.[1]
  if (role) return `目标「${role}」已失效（对象已销毁、切换场景或退出战斗）。请刷新目标并重新选择。`
  if (/binding_capability/.test(text)) return '所选目标现在不具备节点需要的能力（常见原因：游戏停在暂停菜单、未在战斗中）。回到可操作状态后刷新目标再选。'
  if (/object_invalid/.test(text)) return '运行中目标失效，已停止。请重新选择目标。'
  if (/run_already_active/.test(text)) return '游戏里已有一个行为树在运行，请先停止它。'
  if (/stale_session/.test(text)) return '游戏连接已重建，之前选的目标已作废。请刷新目标并重新选择。'
  if (/tree_not_installed/.test(text)) return '游戏里还没有这棵树，请重新点开始。'
  if (/server_not_ready/.test(text)) return 'Ency 服务尚未就绪，请稍后再试。'
  return text
}

export function fitText(text, max) {
  let width = 0, out = ''
  for (const ch of String(text)) { const w = ch.charCodeAt(0) > 255 ? 1 : .56; if (width + w > max) return `${out}…`; width += w; out += ch }
  return out
}
