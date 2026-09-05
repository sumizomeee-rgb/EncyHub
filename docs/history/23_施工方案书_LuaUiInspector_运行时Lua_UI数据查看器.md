# LuaUiInspector 运行时 Lua UI 数据查看器 - 施工方案书

> 版本：v1.0
> 日期：2026-03-22
> 状态：待审阅
> 工具名称：Lua UI Inspector
> Editor 菜单入口：XGame/UI工作相关/Lua UI Inspector
> Web 集成位置：EncyHub GM Console 新增 Tab

---

## 一、项目概述

### 1.1 痛点与背景

Haru 项目使用 XLua 实现业务逻辑，UI 层继承自 `XLuaUi`（`Matrix/XUi/XUiBase/XLuaUi.lua`）。与 Unity 原生 MonoBehaviour 不同，Lua UI 的 `self` 数据（业务变量、子组件引用、状态标记等）**无法在 Unity Inspector 中查看**，开发和调试时只能靠打日志或断点，效率极低。

现有工具对比：
| 工具 | 能力 | 不足 |
|------|------|------|
| XProximaInspector | 查看 Unity C# 层 GameObject/Component | 看不到 Lua table 数据 |
| XSaveUtilViewer | 查看 MVCA Model 层 SaveUtil 持久化数据 | 不覆盖 UI self 数据 |
| EmmyLua Debugger | 断点调试 Lua 变量 | 需暂停游戏，不支持实时浏览 |
| XLog.Dump() | 打印 table 到日志 | 一次性输出，不可交互 |

**核心需求**：提供一个可以在运行时浏览、查看、修改当前打开的 Lua UI 实例 `self` 数据的工具，支持组件树展开、值编辑和还原，并同时支持 Unity Editor 窗口和 GM Console Web 端（真机可用）。

### 1.2 需求总结

| 项目 | 决策 |
|------|------|
| 查看内容 | XLuaUi self 全部字段：基础类型、table、ChildNodes、Grids、DynamicTable |
| 交付形式 | Unity EditorWindow + EncyHub GM Console Web Tab |
| 数据修改 | 支持 number/string/bool 直接编辑并立即生效 |
| 还原能力 | 支持单字段还原和全部还原 |
| 展开深度 | 默认 3 层，可调节，超过深度点击懒加载 |
| TCP 通道 | 复用现有 RuntimeGMClient 12581 端口 |
| Editor 菜单 | Tools/Lua UI Inspector |
| Web 集成位置 | EncyHub GM Console 新增 "Lua UI Inspector" Tab |

### 1.3 设计目标

- **双端可用**：Editor 窗口用于本地开发，GM Console Web 端用于真机远程调试，共享同一套 Lua 数据层
- **零侵入**：纯运行时工具，不修改任何现有 XLuaUi/XUiNode 业务代码
- **按需激活，零后台开销**：`LuaUiInspector.lua` 不注册任何 Update/Timer/协程，仅由外部主动调用时才执行。Editor 窗口关闭或 Web 端不在 Inspector Tab 时，不产生任何运行时消耗
- **实时编辑**：修改值立即生效，并可一键还原

---

## 二、技术架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         游戏进程 (Editor / 真机)                         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    LuaUiInspector.lua (纯 Lua 模块)               │  │
│  │                                                                   │  │
│  │  GetOpenUiList()     → 枚举所有打开的 XLuaUi 实例                  │  │
│  │  GetUiTree(uid)      → 返回组件层级树 (ChildNodes/Grids/DynTable) │  │
│  │  GetNodeData(path)   → 序列化指定节点的 self 字段为 JSON           │  │
│  │  SetValue(path,v)    → 修改指定路径的值                            │  │
│  │  RevertValue(path)   → 还原指定路径为原始值                        │  │
│  │  RevertAll(uid)      → 还原该 UI 所有修改                         │  │
│  │                                                                   │  │
│  │  _OriginalValues{}   → 修改前的原始值快照 (用于还原)               │  │
│  └───────────┬───────────────────────────┬───────────────────────────┘  │
│              │                           │                              │
│     ┌────────▼────────┐       ┌──────────▼──────────┐                   │
│     │  C# EditorWindow │       │ RuntimeGMClient     │                   │
│     │  XLuaEngine 调用 │       │ TCP:12581 回传 JSON │                   │
│     │  (仅 Editor)     │       │ (Editor + 真机)     │                   │
│     └─────────────────┘       └──────────┬──────────┘                   │
└──────────────────────────────────────────┼──────────────────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │     EncyHub GM Console          │
                          │     (FastAPI 子进程)            │
                          │                                 │
                          │  新增 Inspector 相关             │
                          │  协议处理 + API + WS 转发       │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │     React 前端                   │
                          │     GmConsole "Lua UI" Tab      │
                          │     树形浏览 + 属性编辑面板      │
                          └─────────────────────────────────┘
```

### 2.2 关键设计：两条独立链路

| | Unity Editor 链路 | GM Console 链路 |
|---|---|---|
| **运行环境** | 仅 Editor Play Mode | Editor + 真机 |
| **调用方式** | C# `XLuaEngine.Env.DoString("return ...")` 调用 Lua 并获取返回值 | RuntimeGMClient 收到 EXEC 包后执行 Lua |
| **数据回传** | `DoString` 返回 `object[]`，取 `[0]` 转 string 得到 JSON | Lua JSON 序列化后通过 TCP 回传 |
| **C# 依赖** | `UnityEditor` 命名空间 | **零 C# 依赖**，纯 Lua + TCP |
| **延迟** | ~0ms（同进程） | ~10-50ms（网络往返） |

两条链路共用同一个 `LuaUiInspector.lua` 模块，区别仅在调用入口。

---

## 三、Lua 模块设计

### 3.1 LuaUiInspector.lua

位置：`F:\HaruTrunk\Product\Lua\Matrix\XDebug\LuaUiInspector.lua`

**加载方式**：参照 RuntimeGMClient 模式，通过 `rawset(_G, "LuaUiInspector", ...)` 注册到全局以绕过 `LuaLockG()`。
- Editor 侧：在 Step1 的 `XMain.IsEditorDebug` 分支中 `require("XDebug/LuaUiInspector")`
- GM Console 侧（真机）：首次 EXEC 调用时通过 RuntimeGMClient 动态加载

```lua
-- 核心数据结构
local LuaUiInspector = {
    _OriginalValues = {},   -- { [uid] = { [path] = originalValue } }
    MAX_DEPTH = 3,          -- 默认序列化深度
}

-- 绕过 LuaLockG
rawset(_G, "LuaUiInspector", LuaUiInspector)
```

**内存管理**：当 UI 被关闭时，自动清理 `_OriginalValues[uid]`。通过监听 UI 关闭或在每次 `GetOpenUiList()` 时检查已失效的 uid 并清理。

### 3.2 核心 API

#### `GetOpenUiList()` → JSON string
枚举所有打开的 XLuaUi 实例，返回列表：
```json
[
  { "uid": 10042, "name": "UiMain", "active": true },
  { "uid": 10043, "name": "UiShop", "active": true },
  { "uid": 10044, "name": "UiBag", "active": false }
]
```
**实现**：遍历 `XLuaUiManager` 的 `Uid2NameMap`（编辑器）或通过 C# `XUiManager.Instance` 枚举（需确认真机可用的枚举方式）。

#### `GetUiTree(uid)` → JSON string
返回指定 UI 的组件层级树：
```json
{
  "uid": 10042,
  "name": "UiMain",
  "children": [
    {
      "type": "ChildNode",
      "name": "PanelTop",
      "path": "_ChildNodes.1",
      "childCount": 3,
      "hasChildren": true
    },
    {
      "type": "GridGroup",
      "name": "_DefaultGrids",
      "path": "_GridsDic._DefaultGrids",
      "count": 5
    },
    {
      "type": "DynamicTable",
      "name": "DynamicTable",
      "path": "DynamicTable",
      "proxyCount": 8
    }
  ]
}
```

#### `GetNodeData(uid, path, depth)` → JSON string
序列化指定节点的 self 字段，`path` 为空则查看 UI 根 self：
```json
{
  "fields": [
    { "key": "_Uid", "type": "number", "value": 10042, "editable": false },
    { "key": "Name", "type": "string", "value": "UiMain", "editable": false },
    { "key": "_CurTab", "type": "number", "value": 3, "editable": true, "modified": false },
    { "key": "_IsInit", "type": "boolean", "value": true, "editable": true, "modified": false },
    { "key": "_Data", "type": "table", "childCount": 12, "expandable": true },
    { "key": "Transform", "type": "userdata", "display": "RectTransform", "editable": false },
    { "key": "OnEnable", "type": "function", "editable": false }
  ]
}
```

**字段分类规则**：
| Lua 类型 | editable | 展示方式 |
|----------|----------|----------|
| number | true | 输入框 |
| string | true | 文本框 |
| boolean | true | Checkbox |
| table | - | 可展开子树（递归 GetNodeData） |
| userdata | false | 只读，显示 C# 类型名 |
| function | false | 只读，显示 "function" |
| nil | false | 只读，显示 "nil" |

#### `SetValue(uid, path, value, valueType)` → JSON string
修改指定字段的值：
- 首次修改时自动快照原始值到 `_OriginalValues[uid][path]`
- 通过 path 定位 table 嵌套字段（如 `"_Data.subTable.count"`）
- 返回 `{ "success": true, "path": "...", "oldValue": ..., "newValue": ... }`

#### `RevertValue(uid, path)` → JSON string
还原指定字段为原始值：
- 从 `_OriginalValues` 读取并写回
- 返回 `{ "success": true, "path": "...", "revertedTo": ... }`

#### `RevertAll(uid)` → JSON string
还原该 UI 的所有修改。

### 3.3 序列化策略

- **深度控制**：递归序列化 table 时受 `depth` 参数限制，超过深度返回 `{ "type": "table", "childCount": N, "expandable": true }` 占位
- **循环引用检测**：维护 visited set，遇到循环引用返回 `{ "type": "ref", "display": "[circular]" }`
- **大数组截断**：数组超过 100 个元素时截断，返回 `{ "truncated": true, "total": N, "shown": 100 }`
- **排除内部引用**：`UiProxy`、`Ui`、`Transform`、`GameObject` 等 userdata 字段只显示类型名，不递归
- **排序**：字段按 key 排序输出，方便前端展示稳定

### 3.4 枚举 UI 实例的真机兼容方案

`Uid2NameMap` 仅编辑器可用。真机需要通过 Lua 侧的 `XLuaUiManager` 内部数据获取：

```lua
-- XLuaUiManager 内部维护的打开 UI 列表
-- 需要确认真机侧可用的获取方式，优先方案：
-- 1. 读取 XLuaUiManager._UiDict 或类似内部字典（需确认字段名）
-- 2. 通过 CsXUiManager.Instance 的 C# API 枚举后传回 Lua
-- 3. 最后方案：hook XLuaUiManager.Open/Close 维护自己的列表
```

> **待确认**：需要检查 `XLuaUiManager` 内部是否有真机可访问的 UI 实例字典。如果没有，方案 3（hook Open/Close）是最稳妥的备选。

---

## 四、TCP 协议设计 (GM Console 链路)

### 4.1 新增协议包类型

复用 RuntimeGMClient 现有 TCP 通道（端口 12581），新增以下包类型：

#### 请求方向：Server → Client (EncyHub → 游戏)

使用现有 `EXEC` 包类型，发送 Lua 调用代码：
```json
{
  "type": "EXEC",
  "id": 2001,
  "cmd": "LuaUiInspector.GetOpenUiList()"
}
```

#### 响应方向：Client → Server (游戏 → EncyHub)

新增 `UI_INSPECTOR` 包类型，回传 Inspector 数据：
```json
{
  "type": "UI_INSPECTOR",
  "action": "ui_list",
  "ref_id": 2001,
  "data": [ ... ]
}
```

### 4.2 Action 定义

| action | 触发方式 | data 内容 |
|--------|---------|-----------|
| `ui_list` | GetOpenUiList() | UI 实例数组 |
| `ui_tree` | GetUiTree(uid) | 组件层级树 |
| `node_data` | GetNodeData(uid, path, depth) | 节点字段列表 |
| `set_result` | SetValue(uid, path, value, type) | 修改结果 |
| `revert_result` | RevertValue(uid, path) | 还原结果 |
| `revert_all_result` | RevertAll(uid) | 全部还原结果 |
| `error` | 任何 API 出错时 | `{ "message": "..." }` |

### 4.3 LuaUiInspector 的 TCP 集成

在 `LuaUiInspector.lua` 中提供一个 `HandleRequest(actionStr)` 方法，RuntimeGMClient 收到 EXEC 后调用它，结果通过 `RuntimeGMClient.Send()` 回传：

```lua
function LuaUiInspector.HandleRequest(json)
    local req = Json.decode(json)
    local action = req.action
    local result

    if action == "ui_list" then
        result = LuaUiInspector.GetOpenUiList()
    elseif action == "ui_tree" then
        result = LuaUiInspector.GetUiTree(req.uid)
    elseif action == "node_data" then
        result = LuaUiInspector.GetNodeData(req.uid, req.path, req.depth)
    elseif action == "set_value" then
        result = LuaUiInspector.SetValue(req.uid, req.path, req.value, req.valueType)
    elseif action == "revert" then
        result = LuaUiInspector.RevertValue(req.uid, req.path)
    elseif action == "revert_all" then
        result = LuaUiInspector.RevertAll(req.uid)
    end

    RuntimeGMClient.Send({
        type = "UI_INSPECTOR",
        action = action,
        ref_id = req.ref_id,
        data = result
    })
end
```

---

## 五、Unity Editor 窗口设计

### 5.1 文件位置

`F:\HaruTrunk\Dev\Client\Assets\Editor\LuaUiInspector\LuaUiInspectorWindow.cs`

### 5.2 菜单入口

`[MenuItem("XGame/UI工作相关/Lua UI Inspector")]`

### 5.3 窗口布局

```
┌─────────────────────────────────────────────────────┐
│ Lua UI Inspector                    [▼ Auto 1s] [⟳] │
├──────────────────┬──────────────────────────────────┤
│  UI / Tree 面板  │         Inspector 属性面板        │
│  (TreeView)      │                                  │
│                  │  选中节点的 self 字段列表          │
│  ▶ UiMain        │  可编辑字段带输入控件 + ↩️ 按钮    │
│  ▶ UiShop        │  table 字段可折叠展开             │
│  ▶ UiBag         │                                  │
│                  │                                  │
├──────────────────┴──────────────────────────────────┤
│ Filter: [________]  Depth: [3 ▼]  Show nil: ☐      │
│                                    [Revert All]     │
└─────────────────────────────────────────────────────┘
```

### 5.4 实现要点

- 使用 Unity 内置 `TreeView` API 渲染左侧层级树
- 使用 `EditorGUILayout` 渲染右侧属性面板
- 通过 `XLuaEngine.Env.DoString("return LuaUiInspector.XXX(...)")` 调用 Lua API 并获取返回值
- `DoString` 返回 `object[]`，取 `[0]` 转 `string` 得到 JSON，C# 侧用 `JsonUtility` 或手动解析
- Auto Refresh：可选的定时刷新（默认 1 秒间隔），仅刷新当前选中节点的数据
- **窗口关闭时完全停止**：不注册 EditorApplication.update 等全局回调，OnDisable 时清理所有定时刷新
- 仅在 Play Mode 下可用，非 Play Mode 显示提示文字

### 5.5 刷新策略

- UI 列表：每次打开窗口或手动点击刷新时获取
- 组件树：选中 UI 时获取，切换 UI 时刷新
- 属性数据：选中节点时获取，Auto Refresh 开启时定时刷新当前节点
- 修改值后立即刷新当前节点数据以确认生效

---

## 六、EncyHub GM Console Web 端设计

### 6.1 后端扩展

**文件**：`E:\Such_Proj\Other\EncyHub\tools\gm_console\main.py`

新增 API：

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/inspector/{client_id}/ui-list` | 请求 UI 列表 |
| GET | `/inspector/{client_id}/ui-tree/{uid}` | 请求 UI 组件树 |
| POST | `/inspector/{client_id}/node-data` | 请求节点数据 `{ uid, path, depth }` |
| POST | `/inspector/{client_id}/set-value` | 修改值 `{ uid, path, value, valueType }` |
| POST | `/inspector/{client_id}/revert` | 还原值 `{ uid, path }` |
| POST | `/inspector/{client_id}/revert-all` | 还原所有 `{ uid }` |

**后端处理逻辑**：
1. 收到 HTTP 请求 → 构造 `LuaUiInspector.HandleRequest(json)` 调用 → 通过 TCP EXEC 发送给游戏客户端
2. 游戏回传 `UI_INSPECTOR` 包 → 缓存到 `server_mgr` → 通过 WebSocket 推送给前端
3. API 请求采用异步等待模式：发送后等待对应 `ref_id` 的响应（超时 3 秒）

**ServerMgr 扩展**：
```python
# server_mgr.py 新增
def _process_packet(self, cid, pkt):
    t = pkt.get("type")
    # ... 现有逻辑 ...
    elif t == "UI_INSPECTOR":
        ref_id = pkt.get("ref_id")
        action = pkt.get("action")
        data = pkt.get("data")
        # 存入等待队列，供 API await
        self._resolve_pending(ref_id, pkt)
        # 同时广播给 WebSocket 订阅者
        if self.on_inspector_update:
            self.on_inspector_update(cid, action, data)
```

### 6.2 前端组件

**文件**：`E:\Such_Proj\Other\EncyHub\frontend\src\pages\LuaUiInspector.jsx`

#### 布局结构

```
┌─ Lua UI Inspector ──────────────────────────────────────┐
│ Client: [iPhone-12581 ▼]        [🔄 Live] [⏸ Pause]    │
├────────────────────┬────────────────────────────────────┤
│                    │ 📍 UiShop > _ChildNodes > PanelTop │
│  ── Open UIs ──   │                                    │
│  🟢 UiMain        │ ┌─ self fields ─────────────────┐  │
│  🟢 UiShop ←      │ │                               │  │
│  🟢 UiBag         │ │ _Uid    10043      readonly   │  │
│                    │ │ Name    "UiShop"   readonly   │  │
│  ── Tree ──        │ │ _CurTab  [  3  ]        ↩️   │  │
│  ▼ UiShop          │ │ _IsShow   ☑ true        ↩️   │  │
│    ▼ ChildNodes    │ │ _Count   [  0  ]        ↩️   │  │
│      ▼ PanelTop ←  │ │                               │  │
│        PanelItem   │ │ ── table: _Data ──            │  │
│      PanelBottom   │ │ ▶ subConfig  {3 fields}      │  │
│    ▶ Grids (2)     │ │ ▶ itemList   [5 items]       │  │
│    ▶ DynTable (8)  │ │                               │  │
│                    │ │ ── userdata ──                │  │
│                    │ │ Transform  RectTransform  📋  │  │
│                    │ │ BtnClose   XUiButton     📋  │  │
│                    │ └───────────────────────────────┘  │
│                    │                                    │
│ Filter: [________] │ Depth: [3]  [Revert All]          │
└────────────────────┴────────────────────────────────────┘
```

#### 交互功能

- **左上：UI 列表**：绿点表示 active，点击选中后自动加载树
- **左下：组件树**：展开/折叠，选中节点后右侧显示数据
- **右上：面包屑导航**：显示当前选中路径，可点击跳转到父级
- **右侧：属性面板**：
  - 可编辑字段：输入框/checkbox，修改后 Enter 提交
  - 已修改字段高亮标记，旁边出现 ↩️ 还原按钮
  - table 字段显示摘要（N fields / N items），可展开子树
  - userdata/function 只读，📋 可复制类型名
- **Live / Pause**：Live 模式每秒自动刷新当前选中节点的数据，Pause 冻结
- **Revert All**：还原当前 UI 所有被修改的字段

### 6.3 GmConsole.jsx 集成

在 GmConsole 页面新增 Tab：
```jsx
// Tab 定义
{ id: "lua_inspector", label: "Lua UI", icon: <Code2 /> }

// Tab 内容
{activeTab === "lua_inspector" && (
    <LuaUiInspector
        selectedClient={selectedClient}
        broadcastMode={broadcastMode}
    />
)}
```

---

## 七、实施步骤

### Phase 1：Lua 核心模块
1. 实现 `LuaUiInspector.lua` — 全部 6 个 API + 序列化引擎
2. 解决真机 UI 枚举问题（确认可用方案）
3. 本地测试：通过 RuntimeGMClient 手动 EXEC 验证 API 输出

### Phase 2：GM Console Web 端 (真机可用)
4. `server_mgr.py` — 新增 `UI_INSPECTOR` 包处理 + pending 队列
5. `main.py` — 新增 6 个 REST API
6. `LuaUiInspector.jsx` — 前端组件（树 + 属性面板 + 编辑 + 还原）
7. `GmConsole.jsx` — 集成新 Tab
8. 端到端测试：Web → EncyHub → TCP → 真机 → 回传 → 显示

### Phase 3：Unity Editor 窗口
9. `LuaUiInspectorWindow.cs` — EditorWindow + TreeView + 属性面板
10. C# ↔ Lua 调用层（`XLuaEngine.InvokeStr` 封装）
11. Editor 内测试

### Phase 4：打磨
12. 性能优化：大 table 截断、懒加载
13. 异常处理：UI 关闭后的数据清理、TCP 超时
14. UX 打磨：搜索过滤、排序、键盘快捷键

---

## 八、文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `Product/Lua/Matrix/XDebug/LuaUiInspector.lua` | 新增 | 核心 Lua 模块 |
| `Dev/Client/Assets/Editor/LuaUiInspector/LuaUiInspectorWindow.cs` | 新增 | Unity Editor 窗口 |
| `EncyHub/tools/gm_console/server_mgr.py` | 修改 | 新增 UI_INSPECTOR 包处理 |
| `EncyHub/tools/gm_console/main.py` | 修改 | 新增 Inspector REST API |
| `EncyHub/frontend/src/pages/LuaUiInspector.jsx` | 新增 | Web 前端组件 |
| `EncyHub/frontend/src/pages/GmConsole.jsx` | 修改 | 集成新 Tab |

---

## 九、风险与待确认项

| # | 风险/待确认 | 应对方案 | 状态 |
|---|------------|---------|------|
| 1 | `LuaLockG()` 阻止注册新全局变量 | 使用 `rawset(_G, "LuaUiInspector", ...)` 绕过，和 RuntimeGMClient 同一模式 | 已解决 |
| 2 | `XLuaEngine.InvokeStr()` 返回 void，无法获取 Lua 返回值 | 改用 `Env.DoString("return ...")` 获取 `object[]` 返回值 | 已解决 |
| 3 | 真机无法使用 `Uid2NameMap` 枚举 UI（该字典仅编辑器可用） | Phase 1 (Editor) 使用 Uid2NameMap；Phase 2 (GM Console) 通过 C# `CsXUiManager` API 或 hook Open/Close 维护列表 | Phase 2 解决 |
| 4 | 大 table 序列化 JSON 性能问题 | 深度限制 3 层 + 数组截断 100 + 懒加载 | 已设计 |
| 5 | 循环引用导致序列化死循环（如 self.Parent → 父节点 → _ChildNodes → 回到自身） | visited set 检测，返回 `[circular]` 标记 | 已设计 |
| 6 | `_OriginalValues` 内存泄漏（UI 关闭后快照数据残留） | `GetOpenUiList()` 时检查并清理已失效 uid 的快照 | 已设计 |
| 7 | 修改 userdata 引用类型字段的安全性 | 仅允许修改基础类型（number/string/bool），table 子字段递归修改 | 已设计 |
| 8 | UI 在查看期间被关闭 | API 调用时检测 UI 是否仍存在，不存在则返回 error 并清理 | 已设计 |
| 9 | 路径中数组索引的类型处理（`_ChildNodes.1` 应为 number key 而非 string） | 路径解析时自动检测数字 key：`tonumber(segment) or segment` | 已设计 |
| 10 | 多人同时通过 GM Console 修改同一 UI | 最后写入者生效，暂不做冲突检测 | 可接受 |
