# GM Console — Hierarchy + Inspector（替换 C# Component Monitor）

> 版本：v1.0
> 日期：2026-05-13
> 状态：待审阅
> 工具名称：Hierarchy（替换原 "C# Component"）
> Web 集成位置：EncyHub GM Console 现有 `cs_monitor` Tab（直接替换）
> 复用基础：`tools/gm_console/`、`frontend/src/pages/CsComponentMonitor.jsx`、`LuaUiInspector.jsx`、`LuaCsMonitor`（运行时 Lua）

---

## 1. 概述

### 1.1 痛点与背景

现有 `CsComponentMonitor`（前端 `frontend/src/pages/CsComponentMonitor.jsx`、后端 `tools/gm_console/main.py:491-513`、运行时 `LuaCsMonitor`）只支持"输入类型名 → 平面扫描 → 多 Pin 卡片"的工作流，存在以下问题：

| 痛点 | 表现 |
|------|------|
| 无场景全貌 | 必须先猜组件类型名才能找到目标，没有 Hierarchy 直觉 |
| 找不到具体那一个 | 同类型多个时只能靠 `goName + sameTypeIndex` 区分，路径模糊 |
| 与 Unity Editor 体验断层 | 真机调试时与 Editor 习惯完全不同，学习成本高 |
| 改完字段无法在场景里反向定位 | 没有"这是场景中哪个对象的下一个子节点是谁"信息 |

`LuaUiInspector` 已经验证了"左树 + 右属性 + 联动 + 懒加载"模式在 Web 端可用且性能可接受。本方案将这一模式迁移到 C# 侧，复刻 Unity Editor 的 Hierarchy / Inspector 双面板。

### 1.2 决策摘要（已对齐）

| 项目 | 决策 |
|------|------|
| Tab 关系 | **直接替换**现有 `cs_monitor` Tab；旧的 `CsComponentMonitor.jsx` 整体下线 |
| Inspector 模式 | **Unity Editor 同款**：选中 GO → 一次性列出该 GO 上所有 Component（含 Transform/RectTransform） |
| 默认刷新 | **60s**；功能保留，UI 仍提供秒数输入与手动刷新按钮 |
| 联动入口 | LuaUiInspector "📌 Pin to Monitor" 改名 **"Locate in Hierarchy"**，行为：定位到对应 GO 节点 → 自动展开父链 → 高亮 → 加载所有 Component |
| 旧"按类型名搜索" | 不丢，作为树过滤框的一种模式保留（详见 §7.2） |
| Tab 显示名 | "Hierarchy"（替换原 "C# Component"） |

### 1.3 设计目标

- **零侵入运行时**：不改任何业务代码，只在 `RuntimeGMClient` 内新增 `LuaHierarchy` 模块。
- **大场景友好**：树严格按需懒加载（点击展开才请求子节点），单次序列化数据规模可控。
- **复用现有资产**：协议层、PropRow 编辑组件、WebSocket Hook、面包屑、拖拽分栏全部复用。
- **保留旧能力**：按类型名搜索、Component 属性编辑、无参方法调用一个不少。

---

## 2. 现状与改造范围

### 2.1 保留（直接复用）

| 资产 | 位置 | 说明 |
|------|------|------|
| WebSocket 路由 | `tools/gm_console/main.py:500-513` | `/ws/cs_monitor` 路径不变 |
| HTTP Command 路由 | `tools/gm_console/main.py:491-498` | `/cs_monitor/{client_id}/command` 不变 |
| Lua 反射读写 | `LuaCsMonitor` `readComponentDetail` / `setProp` / `callMethod` | 整段保留并重命名为 `LuaHierarchy.ReadComponent / SetProp / CallMethod` |
| 属性编辑 UI | `CsComponentMonitor.jsx:407-489` `PropRow` | 整组件抽出到 `frontend/src/components/PropRow.jsx`，Hierarchy/Inspector 共用 |
| WebSocket Hook 模式 | `LuaUiInspector.jsx:20-101` `useInspectorWs` | 新建 `useCsMonitorWs`，结构 100% 镜像 |
| 树/字段展开/面包屑 | `LuaUiInspector.jsx:150-220` | 直接搬代码 |
| 拖拽分栏 | `CsComponentMonitor.jsx:184-186, 256-257` | 保留 |

### 2.2 废弃

| 现有功能 | 处理 |
|----------|------|
| `CsComponentMonitor.jsx` 的"Pin/Unpin 多卡"工作流 | 删除，改为单选 GO + 整组 Component 卡片列表 |
| `LuaCsMonitor.Scan(typeName)` 平面 FindObjectsOfType 扫描 | 保留为"按类型搜索模式"的底层实现，UI 入口降级到树过滤框的子模式 |
| 现有 `_compRefs` 缓存键 `"goId_compIdx"` | 改为以 `goInstanceId` 为唯一索引，Component 索引按需求时重新枚举 |

### 2.3 新增

| 模块 | 位置 |
|------|------|
| `LuaHierarchy.GetSceneRoots()` / `GetChildren(goInstanceId)` | `tools/gm_console/README_RuntimeGM_Client.md` 内新章节 |
| `LuaHierarchy.GetGameObject(goInstanceId)` | 返回该 GO 的所有 Component 详情（一次拉满） |
| `LuaHierarchy.LocatePath(goInstanceId)` → 父链 instanceId 列表 | 用于 Pin 联动定位时一次性拉父链做展开 |
| 后端新增 actions：`scene_roots / children / go_detail / locate / set_prop / call_method / scan_by_type` | `main.py` `cs_monitor_command` 透传，无需改协议 |
| 前端新组件 `Hierarchy.jsx`（替换 `CsComponentMonitor.jsx`） | `frontend/src/pages/Hierarchy.jsx` |

---

## 3. 数据模型

### 3.1 Tree Node（懒加载单元）

```ts
type HierarchyNode = {
  instanceId: number       // GameObject.GetInstanceID()
  name: string             // GameObject.name
  active: boolean          // activeSelf
  activeInHierarchy: boolean
  childCount: number       // transform.childCount，前端据此决定是否显示展开箭头
  scene?: string           // 仅 Scene 根节点 / DontDestroyOnLoad 根节点附带
  isDontDestroy?: boolean
}
```

### 3.2 GO Detail（选中 GO 时一次性返回）

```ts
type GoDetail = {
  instanceId: number
  name: string
  active: boolean
  layer: number
  tag: string
  hierarchyPath: string             // 用于面包屑/title
  components: ComponentDetail[]
  parentInstanceId: number | null   // 用于面包屑反查
}

type ComponentDetail = {
  compIndex: number                 // GO.GetComponents() 返回的索引（用于后续 set_prop）
  typeName: string                  // 简短名
  fullTypeName: string              // 命名空间全限定（折叠展示）
  enabled: boolean | null           // 仅 Behaviour 子类有
  isMonoBehaviour: boolean
  scriptAssetGuid?: string          // 预留，后续可做"打开脚本"
  properties: Property[]            // 复用现有结构
  methods: Method[]
  error?: string                    // 单 component 反射失败时不影响其他
}
```

`Property` / `Method` 字段结构与现 `LuaCsMonitor.readComponentDetail` 输出完全一致，避免改 PropRow。

### 3.3 Locate Response（Pin 联动专用）

```ts
type LocateResponse = {
  found: boolean
  instanceId?: number
  ancestorChain?: number[]   // 自顶向下，例如 [sceneRootId, parent1, parent2, targetId]
  hierarchyPath?: string
  error?: string
}
```

---

## 4. 通信协议（Action 清单）

均通过 `POST /cs_monitor/{client_id}/command`，响应通过 `WS /ws/cs_monitor` 广播。`type` 字段沿用 action 名，前端按 type 注册回调（与现有 `listenersRef` 机制一致）。

| Action | Request | Response data | 说明 |
|--------|---------|---------------|------|
| `scene_roots` | `{}` | `{ scenes:[{name,roots:[HierarchyNode]}], dontDestroy:[HierarchyNode] }` | 初次进入或手动整树刷新 |
| `children` | `{ instanceId }` | `{ instanceId, children:[HierarchyNode] }` | 展开节点时调用 |
| `go_detail` | `{ instanceId }` | `GoDetail` | 选中节点时调用 |
| `set_prop` | `{ instanceId, compIndex, propName, value, valueType }` | `{ success, error? }` | 复用现有逻辑 |
| `call_method` | `{ instanceId, compIndex, methodName }` | `{ result?, error? }` | 复用现有逻辑 |
| `locate` | `{ goName?, hierarchyPath?, instanceId? }` | `LocateResponse` | Pin 联动：从 LuaUi 传 `goName + hierarchyPath` 模糊定位 |
| `scan_by_type` | `{ typeName, max? }` | `{ results:[{instanceId,goName,hierarchyPath,sameTypeIndex}], truncated, total }` | 树搜索框切到"类型模式"时使用，复用 `LuaCsMonitor.Scan` |

**截断/限流约定**：
- `scene_roots` 每个 Scene 的根节点不限量（通常 ≤50）。
- `children` 单次返回不超过 200 个；超过则附带 `truncated:true, total:N`，前端显示"+N 更多"按钮（点击回传 `offset`）。
- `go_detail` 单 GO 的 Component 通常 ≤20，无需分页；但每个 Component 的 `properties` 列表沿用现有反射白名单。

---

## 5. 运行时 Lua 模块设计

### 5.1 模块归属

新建 `LuaHierarchy` 模块，**与 `LuaCsMonitor` 并存**（后者保留供 `scan_by_type` 复用其反射工具函数 `getComponents` / `readComponentDetail`）。位置：`README_RuntimeGM_Client.md` 现有 LuaCsMonitor 章节之后追加。

### 5.2 核心 API

```lua
-- 返回所有 Scene 的根 GO + DontDestroyOnLoad 根
function LuaHierarchy.GetSceneRoots()
    local SceneManager = CS.UnityEngine.SceneManagement.SceneManager
    local count = SceneManager.sceneCount
    local scenes = {}
    for i = 0, count - 1 do
        local s = SceneManager.GetSceneAt(i)
        if s.isLoaded then
            local roots = s:GetRootGameObjects()  -- C# 数组
            scenes[#scenes+1] = { name = s.name, roots = serializeNodes(roots) }
        end
    end
    -- DontDestroyOnLoad：通过创建临时 GO + DontDestroyOnLoad 后取其 scene
    local ddol = getDontDestroyRoots()  -- 见下方
    return JSON.encode({ scenes = scenes, dontDestroy = ddol })
end

-- 懒加载子节点
function LuaHierarchy.GetChildren(instanceId)
    local go = findGoByInstanceId(instanceId)  -- 见 §5.3
    if not go then return JSON.encode({ error = "GameObject not found" }) end
    local t = go.transform
    local n = t.childCount
    local children = {}
    for i = 0, n - 1 do
        local c = t:GetChild(i).gameObject
        children[#children+1] = nodeOf(c)
    end
    return JSON.encode({ instanceId = instanceId, children = children })
end

function LuaHierarchy.GetGoDetail(instanceId)
    local go = findGoByInstanceId(instanceId)
    if not go then return JSON.encode({ error = "GameObject not found" }) end
    local comps = go:GetComponents(typeof(CS.UnityEngine.Component))
    local list = {}
    for ci = 0, comps.Length - 1 do
        local c = comps[ci]
        local ok, detail = pcall(LuaCsMonitor.ReadComponentDetail, c, ci)
        if ok then list[#list+1] = detail
        else list[#list+1] = { compIndex = ci, error = tostring(detail) } end
    end
    return JSON.encode({
        instanceId = instanceId,
        name = go.name, active = go.activeSelf,
        layer = go.layer, tag = go.tag,
        hierarchyPath = getHierarchyPath(go),
        components = list,
    })
end

function LuaHierarchy.Locate(query)
    -- 优先级：instanceId > hierarchyPath 精确 > goName 模糊
    -- 返回 ancestorChain（含目标 id 自身）便于前端逐级展开
end
```

### 5.3 InstanceId → GameObject 反查

Unity 没有官方 `Object.FindObjectFromInstanceID`（有 internal `Resources.InstanceIDToObject` 但 IL2CPP 真机不暴露）。方案：

**短期**：维护弱引用缓存 `LuaHierarchy._goCache = setmetatable({}, {__mode = "v"})`。
- `GetSceneRoots / GetChildren / Locate` 每次返回节点时把 `[instanceId] = go` 写入缓存。
- `findGoByInstanceId(id)` 先查缓存命中即返回；不命中则触发"按 ancestorChain 从根回溯"或回退 `FindObjectsOfType(GameObject)` 全场景兜底（带告警日志）。
- GO 销毁后弱引用自动清空，下次访问触发回退路径。

**取舍**：用户主要工作流是"展开 → 选中"，缓存命中率 > 95%，兜底路径只在长时间停留 + 场景切换的边界出现。可接受。

### 5.4 性能控制

| 风险 | 缓解 |
|------|------|
| 大场景 `GetSceneRoots` 扁平化即上千 | Scene 根通常 ≤100；不会有问题。真机实测验证后再决定是否分页。 |
| 单 GO 子节点上千（DynamicTable 容器） | `children` 200/页 + `+N 更多` 加载更多 |
| `go_detail` 反射成本 | Component 数量天然有限（≤20），单次 ≤20ms 可接受 |
| 60s 自动刷新引入 GC | 默认仅刷新当前选中 GO 的 `go_detail`，不重扫整树。整树需用户点刷新按钮主动触发。 |

---

## 6. 后端 Python 改造点

### 6.1 `tools/gm_console/server_mgr.py`

无需改动。`send_cs_monitor_request(client_id, action, body)` 已经做了"透传 action + body"，新 action 自动支持。

### 6.2 `tools/gm_console/main.py`

无需新建路由。仅删除/废弃：
- 与 Pin 多卡交互相关的 `cache_from_inspector` action 逻辑，由新 `locate` action 取代（在 Lua 侧改名）。

### 6.3 Lua 入口注册

在 `RuntimeGMClient` 的 `_process_packet` 已有 `CS_MONITOR` 分支里，根据 `action` 字段路由到 `LuaHierarchy.*`。逻辑等同现有 `LuaCsMonitor` 路由。

---

## 7. 前端组件设计

### 7.1 文件改动

| 操作 | 文件 |
|------|------|
| 新建 | `frontend/src/pages/Hierarchy.jsx` |
| 新建 | `frontend/src/components/PropRow.jsx`（从 CsComponentMonitor 抽出） |
| 删除 | `frontend/src/pages/CsComponentMonitor.jsx` |
| 修改 | `frontend/src/pages/GmConsole.jsx`：`import` 与 tab 标签替换；保留 `pendingCsPin` 但语义改为 `pendingLocate`，传给 `<Hierarchy>` |
| 修改 | `frontend/src/pages/LuaUiInspector.jsx`：Pin 按钮文案改 `Locate in Hierarchy`，回调载荷字段不变 |

### 7.2 布局（参考 Unity Editor）

```
┌──────────────── Hierarchy Tab ────────────────────────────────────────┐
│ ┌─ Left（树）240px 可拖拽 ──┐ ┌─ Right（Inspector） ─────────────┐  │
│ │ [●] Hierarchy   [⟳] [60s]  │ │ ▶ GameObject: UiMain/Panel/Btn  │  │
│ │ [🔍 过滤] [Type ▼]         │ │   active ☑  layer Default tag…  │  │
│ ├───────────────────────────┤ ├──────────────────────────────────┤  │
│ │ ▼ Scene: Battle           │ │ ▼ RectTransform                  │  │
│ │   ▼ UiRoot                │ │   pos  X 0  Y 0  Z 0             │  │
│ │     ▼ UiMain  ◀ 选中高亮  │ │   …PropRow 复用…                 │  │
│ │       ▶ Panel             │ │ ▶ Image (5 props)                │  │
│ │       ▶ TopBar            │ │ ▶ MyMonoScript (12 props/3 mtds)│  │
│ │     ▶ UiShop              │ │   [▶ Call] OnRefresh             │  │
│ │ ▼ DontDestroyOnLoad       │ └──────────────────────────────────┘  │
│ │   ▶ AudioMgr              │                                        │
│ │   ▶ NetMgr                │                                        │
│ └───────────────────────────┘                                        │
└────────────────────────────────────────────────────────────────────┘
```

**左栏树过滤框**：默认按 GO 名字模糊过滤（仅过滤已加载到前端的节点；不递归请求后端）。右侧下拉切换 `Type` 模式时，回车触发 `scan_by_type`，结果以列表形式显示在树面板下方区域，点击条目等同点击树节点（自动展开父链 → 选中）。

### 7.3 状态结构

```ts
{
  treeData: { scenes: [...], dontDestroy: [...] }   // 来自 scene_roots
  childrenById: Map<instanceId, HierarchyNode[]>     // 来自 children
  expandedIds: Set<instanceId>                       // 展开节点
  selectedId: instanceId | null
  goDetail: GoDetail | null                          // 当前选中
  loadingChildren: Set<instanceId>
  loadingDetail: boolean
  filterText: string
  filterMode: 'name' | 'type'
  refreshInterval: 60   // 默认 60s
  autoRefresh: true     // 默认开启 60s 间隔
}
```

### 7.4 Auto-refresh 行为

参考 `LuaUiInspector.jsx:232-241`：
- 仅刷新当前选中 GO 的 `go_detail`（不重扫整树）。
- 当 `tab inactive` 或 `interval ≤ 0` 时停。
- 用户输入 `0` 即关闭，UI 显示"手动"。

### 7.5 Pin → Locate 联动

1. `LuaUiInspector` 的 Locate 按钮回调载荷沿用现有 `{ uiName, path, compIndex }` 结构 + 新增 `{ goName, hierarchyPath }`（Lua 侧已能拿到）。
2. `GmConsole.jsx` 切到 Hierarchy Tab 并把载荷写入 `pendingLocate`。
3. `Hierarchy.jsx` 的 useEffect 监听 `pendingLocate + wsConnected`：发 `locate` → 拿 `ancestorChain` → 依次发 `children`（可并发）展开父链 → `setSelectedId(targetId)` → 发 `go_detail`。

---

## 8. 刷新机制 & 默认值

| 项 | 默认 | 可调 |
|----|------|------|
| Inspector auto-refresh 间隔 | **60s** | 整数 0-600；输入 0 关闭 |
| Hierarchy 整树刷新 | **手动**（顶部 ⟳ 按钮触发 `scene_roots`） | 不提供 auto-refresh，显式按钮 |
| 节点子项 | 懒加载，展开时拉一次；折叠不卸载（保留缓存） | 可在节点上 `Shift+点击 ⟳` 强制重拉 |

---

## 9. 文件清单（一次到位）

| 类别 | 文件 |
|------|------|
| 新建 | `frontend/src/pages/Hierarchy.jsx` |
| 新建 | `frontend/src/components/PropRow.jsx` |
| 删除 | `frontend/src/pages/CsComponentMonitor.jsx` |
| 改 | `frontend/src/pages/GmConsole.jsx`（imports / activeTab 标签 / 联动 prop 命名） |
| 改 | `frontend/src/pages/LuaUiInspector.jsx`（按钮文案 + 回调字段） |
| 改 | `tools/gm_console/README_RuntimeGM_Client.md`（新增 LuaHierarchy 章节） |
| 改 | `tools/gm_console/main.py`（删除 `cache_from_inspector` 分支若有） |
| 不动 | `tools/gm_console/server_mgr.py` |

---

## 10. 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 替换还是共存 | 替换 | 旧多 Pin 工作流被 Hierarchy 单选 + 整 Component 列表覆盖；保留按类型搜索作为子模式即可 |
| Inspector 一次列全 vs 按需 | 一次列全 | 与 Unity Editor 一致，Component 数量天然小，不存在性能问题 |
| 整树自动刷新 | 不做 | 大场景反射重扫不可承受；改用"选中 GO 的 detail 60s 轮询" |
| InstanceId 反查 | 弱引用缓存 + FindObjectsOfType 兜底 | IL2CPP 真机不暴露 `InstanceIDToObject` |
| `scan_by_type` 是否保留入口 | 保留为树过滤框的子模式 | 旧工作流用户仍有需求，零成本保留 |
| Pin 联动语义 | Locate（定位）而非 Pin（钉住） | 新模型里"选中"已经等同 Pin；Locate 更准确 |

---

## 11. 风险与边界

| 风险 | 缓解 |
|------|------|
| 极端大场景（>20 万 GO 总数）首屏过重 | Scene 根本身数量少；只在用户展开时才递归。极端场景下 children 200/页足够 |
| GO 在展开过程中被销毁 | `findGoByInstanceId` 返回 null → 前端节点显示 ⚠ 灰态，提供"刷新父节点"按钮 |
| 反射访问触发 lazy-init 副作用 | 沿用 `LuaCsMonitor.readComponentDetail` 现有的属性白名单与 pcall 容错，不引入新风险 |
| Component 顺序在跨刷新时变化（AddComponent/Destroy） | `compIndex` 仍以"当次 detail 返回"为准；前端不跨刷新缓存 compIndex |
| Locate 模糊匹配多结果 | `Locate` 返回 `multiple:true, candidates:[…]` 让前端弹选择列表（MVP 可先取第一个 + Toast 提示） |

---

## 12. 实施顺序（建议）

按"后端能跑通即可前进"的次序：

1. **Lua 侧**：在 `README_RuntimeGM_Client.md` 实现 `LuaHierarchy` 三个核心 API（`GetSceneRoots / GetChildren / GetGoDetail`），用 `RuntimeGMClient` 现有 EXEC 通道在 Editor 手动验证返回 JSON 结构。
2. **抽组件**：把 `PropRow` 从 `CsComponentMonitor.jsx` 抽到 `frontend/src/components/PropRow.jsx`，原页面先临时 import 保证旧页能跑（便于对比）。
3. **新前端页**：写 `Hierarchy.jsx`，覆盖：树渲染 / 懒加载 / 选中 / Inspector 渲染 / set_prop / call_method / 树过滤（仅 name 模式）。
4. **接入 GmConsole**：替换 Tab 渲染分支与 import；删除 `CsComponentMonitor.jsx`。
5. **Locate 联动**：实现 `LuaHierarchy.Locate` + 前端 `pendingLocate` 流。
6. **`scan_by_type` 子模式**：树过滤框加 mode 切换；后端复用 `LuaCsMonitor.Scan`。
7. **Auto-refresh + 真机验证**：跑一次大场景，观察 60s 轮询的反射开销；不达标则提供 "off" 默认。

预估：步骤 1-4 一个工作日，5-7 一个工作日，含联调与真机验证共 2-3 个工作日。

---

## 13. 待定 / 未来扩展

- [ ] Component 上的 `enabled` toggle（Behaviour 子类）UI
- [ ] "打开脚本"按钮（需 Editor 链路 + assetGuid，真机 N/A）
- [ ] Hierarchy 树支持拖拽改父子（运行时改 transform.SetParent，仅作为调试能力）
- [ ] 多选 GO 同时调用方法
- [ ] 与 LuaUiInspector 反向联动：Hierarchy 选中 GO 时，若该 GO 是某 XLuaUi 的根，显示"Inspect Lua self"按钮跳过去

---

## 附录 A：旧 `cs_monitor` 工作流到新 Tab 的迁移对照

| 旧操作 | 新操作 |
|--------|--------|
| 输入 `Image` → Scan | 树过滤框切到 `Type` 模式 → 输入 `Image` → 列表点击定位 |
| 点击 📌 Pin 多个 | 选中节点查看，需要"对照"时切到分屏（暂不做，需求频次低） |
| 卡片右上 ⟳ 刷新 | Inspector 右上 ⟳ 刷新 |
| 修改 prop / call method | 完全相同 |
| 自动刷新 3s 默认 | 自动刷新 60s 默认（功能仍在） |
