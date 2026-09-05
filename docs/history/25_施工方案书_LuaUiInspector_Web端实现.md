# LuaUiInspector Web 端实现 - 施工方案书

> 版本：v1.1
> 日期：2026-03-23
> 前置文档：23号（总体设计）、24号（Phase1 Editor 优化）
> 状态：待审阅
> v1.1 变更：修复 spec review 发现的问题（API 路由统一、回调线程安全、序列化函数补全、已知限制说明）

---

## 一、背景与变更

### 1.1 与原方案（23号）的差异

| 项目 | 23号原方案 | 本方案 |
|------|-----------|--------|
| Lua 模块 | 独立文件 `Matrix/XDebug/LuaUiInspector.lua` | **已删除**，逻辑嵌入 `XMain.lua` |
| C# 改动 | 无 | 无（一致） |
| UI 枚举 | `XLuaUiManager.GetUid2NameMap()`（编辑器专用） | `CS.XUiManager.Instance:GetAllList()`（Runtime API，真机可用） |
| 通信模式 | 自定义 HandleRequest + 专用 TCP 包 | **Animator 模式**：HTTP 触发 → TCP 命令 → WS 推送 |
| Lua 加载位置 | `XMain.IsEditorDebug` 分支 require | 嵌入 `StartRuntimeGM()` 内，与 LuaAnimatorMonitor 同级 |

### 1.2 本方案范围

仅覆盖 Web 端实现（Phase 2），Unity Editor 窗口（Phase 1）已完成。

**改动文件清单**：

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `Product/Lua/Matrix/XMain.lua` | 修改 | 嵌入 LuaUiInspector 模块 |
| `EncyHub/tools/gm_console/server_mgr.py` | 修改 | 新增 UI_INSPECTOR 包处理 + 回调 |
| `EncyHub/tools/gm_console/main.py` | 修改 | 新增 Inspector API + WS 端点 |
| `EncyHub/frontend/src/pages/LuaUiInspector.jsx` | 新增 | Web 前端组件 |
| `EncyHub/frontend/src/pages/GmConsole.jsx` | 修改 | 集成第 4 个 Tab |

---

## 二、技术架构

### 2.1 通信流程（Animator 模式）

```
                 ┌─ React 前端 ─────────────────────────────────────┐
                 │                                                   │
                 │  1. fetch("/api/.../ui-list")   ──→  HTTP Request │
                 │                                                   │
                 │  4. ws.onmessage({              ←──  WebSocket    │
                 │       type: "inspector_list",                     │
                 │       data: [...]                                 │
                 │     })                                            │
                 └───────────────┬───────────────────────────────────┘
                                 │ ↑
                 ┌───────────────▼─┴─────────────────────────────────┐
                 │  FastAPI 后端 (main.py)                            │
                 │                                                   │
                 │  2. server_mgr.send_inspector_request(            │
                 │       client_id, "ui_list", {}                    │
                 │     )                                             │
                 │                                                   │
                 │  3. on_inspector_data(cid, pkt)  → broadcast WS   │
                 └───────────────┬───────────────────────────────────┘
                                 │ ↑
                 ┌───────────────▼─┴─────────────────────────────────┐
                 │  游戏客户端 (XMain.lua / RuntimeGMClient)          │
                 │                                                   │
                 │  2. ProcessPacket("UI_INSPECTOR")                 │
                 │     → LuaUiInspector.HandleCommand(packet)        │
                 │                                                   │
                 │  3. RuntimeGMClient.Send({                        │
                 │       type = "UI_INSPECTOR_RESP",                 │
                 │       action = "ui_list",                         │
                 │       data = { ... }   ← table，非 JSON string    │
                 │     })                                            │
                 └───────────────────────────────────────────────────┘
```

### 2.2 与 Animator 模式的对照

| 维度 | Animator | Inspector |
|------|----------|-----------|
| 请求包类型 | `ANIM_LIST` / `ANIM_SUBSCRIBE` | `UI_INSPECTOR` (统一类型，action 区分) |
| 响应包类型 | `ANIM_LIST_RESP` / `ANIM_DATA` | `UI_INSPECTOR_RESP` (统一类型，action 区分) |
| WebSocket 端点 | `/ws/animator` | `/ws/inspector` |
| 数据推送 | 订阅后持续推送快照 | 请求式：前端请求 → 回传一次 |
| Live 刷新 | 由客户端 Update 循环推送 | 由前端定时重发请求（setInterval） |

---

## 三、Lua 侧设计（XMain.lua）

### 3.1 模块位置

嵌入 `StartRuntimeGM()` 函数内，与 `LuaAnimatorMonitor` 同级：

```lua
local function StartRuntimeGM()
    local RuntimeGMClient = {}
    -- ... 现有 RuntimeGMClient 代码 ...

    -- ========== LuaAnimatorMonitor ==========
    local LuaAnimatorMonitor = {}
    -- ... 现有代码 ...

    -- ========== LuaUiInspector: 运行时 Lua UI 数据查看 ==========
    local LuaUiInspector = {}
    -- ... 新增代码（见 3.2）...

    function RuntimeGMClient.ProcessPacket(line)
        -- ... 现有逻辑 ...
        elseif type and type == "UI_INSPECTOR" then
            local ok, err = pcall(LuaUiInspector.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] UI_INSPECTOR error: " .. tostring(err))
            end
        end
    end
end
```

### 3.2 LuaUiInspector 核心实现

```lua
local LuaUiInspector = {}

-- 不递归展开的 key（C# 对象引用，避免循环/卡顿）
local INSPECTOR_SKIP_KEYS = {
    UiProxy = true, Ui = true, Transform = true,
    GameObject = true, Parent = true,
}

-- 修改前的原始值快照
LuaUiInspector._OriginalValues = {}  -- { [uiName] = { [path] = originalValue } }
```

#### 3.2.1 UI 枚举（真机兼容）

```lua
function LuaUiInspector.GetOpenUiList()
    local result = {}
    local allList = CS.XUiManager.Instance:GetAllList()
    local seen = {}  -- 去重（同名 UI 可能有多个实例）

    for i = 0, allList.Count - 1 do
        local xui = allList[i]
        local ok, info = pcall(function()
            local uiName = xui.UiData.UiName
            if seen[uiName] then return nil end
            seen[uiName] = true

            -- 尝试获取 Lua 实例
            local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
            if not luaUi then return nil end  -- 纯 C# UI，跳过

            return {
                name = uiName,
                active = xui.IsEnable,
            }
        end)
        if ok and info then
            result[#result + 1] = info
        end
    end

    table.sort(result, function(a, b) return a.name < b.name end)
    return result
end
```

**与原 LuaUiInspector.lua 的区别**：
- 用 `CS.XUiManager.Instance:GetAllList()` 替代 `XLuaUiManager.GetUid2NameMap()`
- 不再用 uid 索引（uid 是 Editor 概念），改用 **uiName** 作为标识
- `_OriginalValues` 以 uiName 为 key

**已知限制**：`GetTopLuaUi(uiName)` 只返回同名 UI 的最顶层实例。若同一 UI 被多次打开（如弹窗堆叠），只能检查最顶层的那个。这是底层 API 的限制，暂不处理。

#### 3.2.2 组件树

```lua
function LuaUiInspector.GetUiTree(uiName)
    local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
    if not luaUi then
        return { error = "UI not found: " .. tostring(uiName) }
    end

    local function buildChildren(node, basePath)
        local children = {}
        if node._ChildNodes and #node._ChildNodes > 0 then
            for i, child in ipairs(node._ChildNodes) do
                local childPath = basePath .. "._ChildNodes." .. i
                local goName = "Unknown"
                pcall(function()
                    goName = child.GameObject and tostring(child.GameObject.name) or "Unknown"
                end)
                local cname = ""
                pcall(function() cname = child.__cname or "" end)
                local subChildren = buildChildren(child, childPath)
                children[#children + 1] = {
                    type = "ChildNode",
                    name = goName,
                    cname = cname,
                    path = childPath,
                    hasChildren = #subChildren > 0,
                    children = #subChildren > 0 and subChildren or nil,
                }
            end
        end
        return children
    end

    return {
        name = uiName,
        children = buildChildren(luaUi, ""),
    }
end
```

#### 3.2.3 节点数据序列化

```lua
function LuaUiInspector.GetNodeData(uiName, path, depth)
    local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
    if not luaUi then return { error = "UI not found" } end

    depth = depth or 3
    local target = luaUi

    -- 解析路径
    if path and path ~= "" then
        for seg in string.gmatch(path, "[^%.]+") do
            local key = tonumber(seg) or seg
            if type(target) ~= "table" then return { error = "Path invalid" } end
            target = target[key]
        end
    end

    if type(target) ~= "table" then
        return { fields = { serializeValue(target, 0, {}, nil) } }
    end

    -- 序列化所有字段
    local fields = {}
    local visited = { [target] = true }
    local originals = LuaUiInspector._OriginalValues[uiName] or {}

    for _, k in ipairs(getSortedKeys(target)) do
        local v = target[k]
        local keyStr = tostring(k)
        local fieldPath = (not path or path == "") and keyStr or (path .. "." .. keyStr)
        local desc = serializeValue(v, INSPECTOR_SKIP_KEYS[k] and 0 or (depth - 1), visited, k)
        desc.key = keyStr
        desc.modified = originals[fieldPath] ~= nil
        fields[#fields + 1] = desc
    end

    return { fields = fields }
end
```

#### 3.2.x 内部工具函数（完整实现）

以下函数在 `StartRuntimeGM()` 内定义，为 Inspector 模块的内部依赖：

```lua
--- 获取 Lua 值的类型名（对 userdata 尝试获取 C# 类型名）
local function inspectorGetTypeName(v)
    local t = type(v)
    if t == "userdata" then
        local ok, typeName = pcall(function() return tostring(v:GetType()) end)
        if ok and typeName then return "userdata", typeName end
        return "userdata", "userdata"
    end
    return t, nil
end

--- 统计 table 的 key 数量
local function inspectorTableKeyCount(t)
    local count = 0
    for _ in pairs(t) do count = count + 1 end
    return count
end

--- 收集并排序 table 的 keys（数字 key 在前，字符串 key 在后）
local function inspectorGetSortedKeys(t)
    local numKeys, strKeys = {}, {}
    for k in pairs(t) do
        if type(k) == "number" then numKeys[#numKeys + 1] = k
        elseif type(k) == "string" then strKeys[#strKeys + 1] = k end
    end
    table.sort(numKeys)
    table.sort(strKeys)
    local result = {}
    for _, k in ipairs(numKeys) do result[#result + 1] = k end
    for _, k in ipairs(strKeys) do result[#result + 1] = k end
    return result
end

--- 通过路径字符串定位 table 中的值
--- path: "key1.key2.3"（数字自动转为 number key）
local function inspectorResolvePath(root, path)
    if not path or path == "" then return root, nil, nil end
    local current = root
    local segments = {}
    for seg in string.gmatch(path, "[^%.]+") do
        segments[#segments + 1] = tonumber(seg) or seg
    end
    for i = 1, #segments - 1 do
        local key = segments[i]
        if type(current) ~= "table" then return nil, nil, nil end
        current = current[key]
    end
    local lastKey = segments[#segments]
    return current, lastKey, current and current[lastKey]
end

--- 序列化单个值为描述对象
local function inspectorSerializeValue(value, depth, visited, key)
    local t, displayName = inspectorGetTypeName(value)
    if t == "nil" then return { type = "nil", value = "nil", editable = false }
    elseif t == "number" then return { type = "number", value = value, editable = true }
    elseif t == "string" then return { type = "string", value = value, editable = true }
    elseif t == "boolean" then return { type = "boolean", value = value, editable = true }
    elseif t == "function" then return { type = "function", value = "function", editable = false }
    elseif t == "userdata" then return { type = "userdata", value = displayName or "userdata", editable = false }
    elseif t == "table" then
        if visited[value] then return { type = "ref", value = "[circular]", editable = false } end
        local childCount = inspectorTableKeyCount(value)
        if depth <= 0 or (key and INSPECTOR_SKIP_KEYS[key]) then
            return { type = "table", childCount = childCount, expandable = true, editable = false }
        end
        visited[value] = true
        local fields = {}
        local keys = inspectorGetSortedKeys(value)
        local shown, truncated = 0, false
        local MAX_ARRAY = 100
        for _, k in ipairs(keys) do
            if shown >= MAX_ARRAY then truncated = true; break end
            local v = value[k]
            local childKey = type(k) == "number" and tostring(k) or k
            local childDesc = inspectorSerializeValue(v, INSPECTOR_SKIP_KEYS[k] and 0 or (depth - 1), visited, k)
            childDesc.key = childKey
            fields[#fields + 1] = childDesc
            shown = shown + 1
        end
        visited[value] = nil
        local result = { type = "table", childCount = childCount, expandable = true, editable = false, fields = fields }
        if truncated then result.truncated = true; result.total = childCount; result.shown = shown end
        return result
    else
        return { type = t, value = tostring(value), editable = false }
    end
end
```

**稀疏数组注意**：`jsonEncode` 使用 `#val > 0` 检测数组，稀疏数组（如 `{[1]="a", [3]="b"}`）会被当作数组处理但只序列化连续索引。这是 XMain.lua 中 `jsonEncode` 的已知限制，Inspector 的序列化引擎在上层已按 key 遍历，不受此影响。

#### 3.2.4 值修改与还原

```lua
function LuaUiInspector.SetValue(uiName, path, value, valueType)
    local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
    if not luaUi then return { success = false, error = "UI not found" } end
    if not path or path == "" then return { success = false, error = "Path is empty" } end

    -- 类型转换
    local typedValue = value
    if valueType == "number" then
        typedValue = tonumber(value)
        if not typedValue then return { success = false, error = "Invalid number" } end
    elseif valueType == "boolean" then
        typedValue = (type(value) == "string") and (value == "true") or (not not value)
    elseif valueType == "string" then
        typedValue = tostring(value)
    else
        return { success = false, error = "Unsupported type: " .. tostring(valueType) }
    end

    -- 路径解析
    local parent, lastKey, oldValue = inspectorResolvePath(luaUi, path)
    if not parent or not lastKey then return { success = false, error = "Path not found" } end

    -- 快照原始值（仅首次修改时）
    LuaUiInspector._OriginalValues[uiName] = LuaUiInspector._OriginalValues[uiName] or {}
    if LuaUiInspector._OriginalValues[uiName][path] == nil then
        LuaUiInspector._OriginalValues[uiName][path] = oldValue
    end

    parent[lastKey] = typedValue
    return { success = true, path = path, oldValue = oldValue, newValue = typedValue }
end

function LuaUiInspector.RevertValue(uiName, path)
    local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
    if not luaUi then return { success = false, error = "UI not found" } end

    local originals = LuaUiInspector._OriginalValues[uiName]
    if not originals or originals[path] == nil then
        return { success = false, error = "No original value for: " .. path }
    end

    local parent, lastKey = inspectorResolvePath(luaUi, path)
    if not parent or not lastKey then return { success = false, error = "Path not found" } end

    local originalValue = originals[path]
    parent[lastKey] = originalValue
    originals[path] = nil
    if next(originals) == nil then LuaUiInspector._OriginalValues[uiName] = nil end
    return { success = true, path = path, revertedTo = originalValue }
end

function LuaUiInspector.RevertAll(uiName)
    local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
    if not luaUi then return { success = false, error = "UI not found" } end

    local originals = LuaUiInspector._OriginalValues[uiName]
    if not originals then return { success = true, count = 0 } end

    local count = 0
    for path, originalValue in pairs(originals) do
        local parent, lastKey = inspectorResolvePath(luaUi, path)
        if parent and lastKey then parent[lastKey] = originalValue; count = count + 1 end
    end
    LuaUiInspector._OriginalValues[uiName] = nil
    return { success = true, count = count }
end
```

#### 3.2.5 命令处理入口

```lua
function LuaUiInspector.HandleCommand(packet)
    local action = packet.action
    local result

    if action == "ui_list" then
        result = LuaUiInspector.GetOpenUiList()
    elseif action == "ui_tree" then
        result = LuaUiInspector.GetUiTree(packet.uiName)
    elseif action == "node_data" then
        result = LuaUiInspector.GetNodeData(packet.uiName, packet.path, packet.depth)
    elseif action == "set_value" then
        result = LuaUiInspector.SetValue(packet.uiName, packet.path, packet.value, packet.valueType)
    elseif action == "revert" then
        result = LuaUiInspector.RevertValue(packet.uiName, packet.path)
    elseif action == "revert_all" then
        result = LuaUiInspector.RevertAll(packet.uiName)
    else
        result = { error = "Unknown action: " .. tostring(action) }
    end

    -- 直接传 table 给 Send（避免双重编码）
    RuntimeGMClient.Send({
        type = "UI_INSPECTOR_RESP",
        action = action,
        data = result
    })
end
```

**关键区别**：所有内部函数返回 **table** 而非 JSON 字符串，由 `RuntimeGMClient.Send()` 统一 JSON 编码。彻底避免原 `LuaUiInspector.lua` 中的双重编码问题。

**UI 关闭清理**：`GetOpenUiList` 执行时顺带清理 `_OriginalValues` 中已失效的 uiName：

```lua
-- 在 GetOpenUiList 末尾
local validNames = {}
for _, info in ipairs(result) do validNames[info.name] = true end
for uiName in pairs(LuaUiInspector._OriginalValues) do
    if not validNames[uiName] then LuaUiInspector._OriginalValues[uiName] = nil end
end
```

若 `GetUiTree` / `GetNodeData` 等 API 检测到 UI 已关闭（`GetTopLuaUi` 返回 nil），返回 `{ error = "UI not found" }`，前端收到后清除选中状态并提示 "该 UI 已关闭"。Live 刷新模式下自动暂停。

---

## 四、后端设计

### 4.1 server_mgr.py 扩展

新增 Inspector 包处理，完全参照 Animator 模式：

```python
# === 新增属性 ===
self.on_inspector_data: Optional[Callable] = None  # 回调

# === _process_packet 新增分支 ===
elif t == "UI_INSPECTOR_RESP":
    if self.on_inspector_data:
        self.on_inspector_data(cid, pkt)

# === 新增发送方法 ===
async def send_inspector_request(self, client_id: str, action: str, params: dict):
    """发送 Inspector 命令到客户端"""
    pkt = {"type": "UI_INSPECTOR", "action": action}
    pkt.update(params)
    await self._send_to_client(client_id, pkt)
```

### 4.2 main.py 扩展

#### WebSocket 端点

```python
# Inspector WebSocket 连接池
inspector_ws_connections: list[WebSocket] = []

async def broadcast_inspector_event(event: dict):
    for ws in inspector_ws_connections[:]:
        try:
            await ws.send_json(event)
        except:
            inspector_ws_connections.remove(ws)

# 回调注册
def on_inspector_data(client_id, pkt):
    asyncio.create_task(
        broadcast_inspector_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        })
    )

server_mgr.on_inspector_data = on_inspector_data

@router.websocket("/ws/inspector")
async def ws_inspector(websocket: WebSocket):
    await websocket.accept()
    inspector_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in inspector_ws_connections:
            inspector_ws_connections.remove(websocket)
```

#### REST API 端点（统一命令入口）

采用单一 POST 端点，与 Lua 侧 `HandleCommand` 统一的 action 分发模式对齐，避免 action 名与 URL 路径的映射问题：

```python
class InspectorCommandRequest(BaseModel):
    action: str       # ui_list / ui_tree / node_data / set_value / revert / revert_all
    uiName: str = ""
    path: str = ""
    depth: int = 3
    value: Any = None
    valueType: str = ""

@app.post("/inspector/{client_id}/command")
async def inspector_command(client_id: str, body: InspectorCommandRequest):
    params = body.dict(exclude_none=True)
    action = params.pop("action")
    await server_mgr.send_inspector_request(client_id, action, params)
    return {"status": "requested"}
```

前端统一调用方式：
```javascript
fetch(`/api/gm_console/inspector/${clientId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'node_data', uiName: 'UiShop', path: '_CurTab', depth: 3 })
})
```

所有请求采用 fire-and-forget 模式，实际数据通过 WebSocket 异步返回。

---

## 五、前端设计

### 5.1 UX 设计理念

以 **Chrome DevTools Elements 面板** 为灵感，同时融入 EncyHub 的 Golden Hour 设计系统。核心原则：

1. **双栏布局**：左侧导航（UI 列表 + 组件树），右侧属性面板
2. **渐进式信息展示**：选 UI → 展开树 → 选节点 → 查看字段 → 展开子表
3. **即时反馈**：编辑值后立即提交，已修改字段高亮 + 还原按钮
4. **类型视觉区分**：不同数据类型用色彩编码，一眼识别

### 5.2 布局结构

```
┌─ Lua UI Inspector ─────────────────────────────────────────────────┐
│ ┌─ 左栏 (280px, 可拖拽调整) ──┐ ┌─ 右栏 ──────────────────────────┐│
│ │                              │ │                                ││
│ │ ┌─ UI 列表 ───────────────┐  │ │ 📍 UiShop > ChildNodes > Top  ││
│ │ │ [🔍 搜索...]            │  │ │                                ││
│ │ │ 🟢 UiMain               │  │ │ [🔍 过滤字段...] Depth:[3 ▾]  ││
│ │ │ 🟢 UiShop          ← ●  │  │ │                                ││
│ │ │ ⚫ UiBag                │  │ │ ┌─ 可编辑 (5) ──────────────┐  ││
│ │ └──────────────────────────┘  │ │ │ _CurTab    [ 3 ]    ↩️   │  ││
│ │                              │ │ │ _IsShow     ☑        ↩️   │  ││
│ │ ┌─ 组件树 ────────────────┐  │ │ │ _Count     [ 0 ]         │  ││
│ │ │ ▼ UiShop                │  │ │ └────────────────────────────┘  ││
│ │ │   ▼ ChildNodes          │  │ │                                ││
│ │ │     ▶ PanelTop     ← ●  │  │ │ ┌─ 子表 (3) ───────────────┐  ││
│ │ │     ▶ PanelBottom       │  │ │ │ ▶ _Data       {12 fields} │  ││
│ │ │   ▶ Grids (2)           │  │ │ │ ▶ _Config     {4 fields}  │  ││
│ │ │   ▶ DynTable (8)        │  │ │ └────────────────────────────┘  ││
│ │ └──────────────────────────┘  │ │                                ││
│ │                              │ │ ┌─ Unity 引用 (4) ──────────┐  ││
│ │                              │ │ │ Transform  RectTransform   │  ││
│ │                              │ │ │ BtnClose   XUiButton       │  ││
│ │                              │ │ └────────────────────────────┘  ││
│ │                              │ │                                ││
│ │                              │ │ ┌─ 方法 (8) ────────────────┐  ││
│ │                              │ │ │ OnEnable    function       │  ││
│ │                              │ │ │ Refresh     function       │  ││
│ │                              │ │ └────────────────────────────┘  ││
│ │                              │ │                                ││
│ └──────────────────────────────┘ │ [↩️ Revert All]  [🔄 Live 1s]  ││
│                                  └────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
```

### 5.3 视觉设计

#### 类型色彩编码

| 类型 | 颜色 | 用途 |
|------|------|------|
| 可编辑 (number/string/bool) | `#7D9B76` (sage) | 带编辑控件的行 |
| 子表 (table) | `#6B8FBF` (blue) | 可展开/折叠 |
| Unity 引用 (userdata) | `#D4A574` (caramel) | 只读 |
| 方法 (function) | `#9B7DBF` (purple) | 只读 |
| 已修改 | `#E8A317` (amber) 左边框 | 编辑过的字段高亮 |

#### 状态指示

| 指示 | 视觉 |
|------|------|
| UI active | 🟢 绿色圆点 |
| UI loaded but hidden | ⚫ 灰色圆点 |
| 字段已修改 | 左侧 amber 竖条 + ↩️ 按钮 |
| Live 刷新中 | 右下角脉动动画 |
| 当前选中 | 行背景 `var(--cream-warm)` |

### 5.4 交互设计

#### 值编辑

| 类型 | 控件 | 提交方式 |
|------|------|---------|
| number | `<input type="number">` | Enter 键 或 blur |
| string | `<input type="text">` | Enter 键 或 blur |
| boolean | checkbox | 点击即提交 |

提交后自动刷新当前节点数据以确认生效。

#### Live 刷新

- 右下角 toggle：`[🔄 Live 1s]` / `[⏸ Paused]`
- Live 模式下每 N 秒（默认 1s，可调 0.5/1/2/3）重发当前节点的 `node_data` 请求
- 仅刷新当前选中节点，不刷新整个 UI 列表/树
- 切换节点时自动取消旧请求、发起新请求

#### 搜索/过滤

- **左栏搜索**：过滤 UI 名称，实时匹配，不区分大小写
- **右栏过滤**：过滤字段 key 名，实时匹配

#### 面包屑导航

```
📍 UiShop > _ChildNodes > PanelTop > _Data > subConfig
```

每个层级可点击跳转回父级。

### 5.5 WebSocket 通信封装

```javascript
// 前端通信封装
function useInspectorWs(selectedClient) {
    const listenersRef = useRef({})  // action → callback

    useEffect(() => {
        if (!selectedClient) return
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(
            `${protocol}//${window.location.host}/api/gm_console/ws/inspector`
        )
        socket.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            if (msg.client_id !== selectedClient?.id) return
            const cb = listenersRef.current[msg.type]
            if (cb) cb(msg.data)
        }
        return () => socket.close()
    }, [selectedClient])

    // 发送请求并注册持久回调（Live 刷新时同 action 的回调会被覆盖，这是预期行为）
    const request = useCallback((action, params, onResponse) => {
        listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/inspector/${selectedClient.id}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        })
    }, [selectedClient])

    return { request }
}
```

**Live 刷新说明**：`setInterval` 每秒调用 `request('node_data', ...)` 时，新回调会覆盖旧回调。由于 WS 消息按 action 路由而非 ref_id，这意味着迟到的旧响应也会触发最新回调——但因为数据格式一致，前端状态总是更新为最新收到的数据，行为正确。

### 5.6 GmConsole.jsx Tab 集成

```jsx
// Tab 按钮（第 4 个）
<button
    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
        activeTab === 'lua_inspector'
            ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
            : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
    }`}
    onClick={() => setActiveTab('lua_inspector')}
>
    <span className="flex items-center gap-1.5">
        <Inspect size={14} />
        Lua UI
    </span>
</button>

// Tab 内容
{activeTab === 'lua_inspector' && (
    <LuaUiInspector
        clients={clients}
        selectedClient={selectedClient}
        broadcastMode={broadcastMode}
    />
)}
```

---

## 六、TCP 协议定义

### 6.1 请求方向：EncyHub → 游戏客户端

统一包类型 `UI_INSPECTOR`，用 `action` 区分操作：

```json
{ "type": "UI_INSPECTOR", "action": "ui_list" }
{ "type": "UI_INSPECTOR", "action": "ui_tree", "uiName": "UiShop" }
{ "type": "UI_INSPECTOR", "action": "node_data", "uiName": "UiShop", "path": "_ChildNodes.1", "depth": 3 }
{ "type": "UI_INSPECTOR", "action": "set_value", "uiName": "UiShop", "path": "_CurTab", "value": 5, "valueType": "number" }
{ "type": "UI_INSPECTOR", "action": "revert", "uiName": "UiShop", "path": "_CurTab" }
{ "type": "UI_INSPECTOR", "action": "revert_all", "uiName": "UiShop" }
```

### 6.2 响应方向：游戏客户端 → EncyHub

统一包类型 `UI_INSPECTOR_RESP`：

```json
{
    "type": "UI_INSPECTOR_RESP",
    "action": "ui_list",
    "data": [
        { "name": "UiMain", "active": true },
        { "name": "UiShop", "active": true }
    ]
}

{
    "type": "UI_INSPECTOR_RESP",
    "action": "ui_tree",
    "data": {
        "name": "UiShop",
        "children": [
            {
                "type": "ChildNode",
                "name": "PanelTop",
                "cname": "XUiPanelShopTop",
                "path": "_ChildNodes.1",
                "hasChildren": true,
                "children": [...]
            }
        ]
    }
}

{
    "type": "UI_INSPECTOR_RESP",
    "action": "node_data",
    "data": {
        "fields": [
            { "key": "_CurTab", "type": "number", "value": 3, "editable": true, "modified": false },
            { "key": "_IsShow", "type": "boolean", "value": true, "editable": true, "modified": false },
            { "key": "_Data", "type": "table", "childCount": 12, "expandable": true, "editable": false }
        ]
    }
}

{
    "type": "UI_INSPECTOR_RESP",
    "action": "set_value",
    "data": { "success": true, "path": "_CurTab", "oldValue": 3, "newValue": 5 }
}
```

---

## 七、实施步骤

### Step 1：XMain.lua — 嵌入 Inspector 模块
- 在 `StartRuntimeGM()` 中添加 `LuaUiInspector` 本地模块（预估新增 ~250 行）
- 实现工具函数 + 6 个核心 API + `HandleCommand` 入口
- `ProcessPacket` 新增 `UI_INSPECTOR` 路由（放在 `ANIM_` 分支**之前**）
- 本地验证：通过 EncyHub 现有 EXEC 功能发送以下测试命令：
  ```
  RuntimeGMClient.ProcessPacket('{"type":"UI_INSPECTOR","action":"ui_list"}')
  RuntimeGMClient.ProcessPacket('{"type":"UI_INSPECTOR","action":"ui_tree","uiName":"UiMain"}')
  RuntimeGMClient.ProcessPacket('{"type":"UI_INSPECTOR","action":"node_data","uiName":"UiMain","path":"","depth":2}')
  ```

### Step 2：server_mgr.py — 包处理 + 回调
- `_process_packet` 新增 `UI_INSPECTOR_RESP` 分支
- 新增 `send_inspector_request()` 方法
- 新增 `on_inspector_data` 回调属性

### Step 3：main.py — API + WebSocket
- 新增 6 个 REST API 端点
- 新增 `/ws/inspector` WebSocket 端点
- 注册 `on_inspector_data` 回调 → 广播到 WS

### Step 4：LuaUiInspector.jsx — 前端组件
- 双栏布局：UI 列表 + 组件树 | 属性面板
- WebSocket 通信封装
- 类型色彩编码 + 编辑控件
- Live 刷新 + Revert

### Step 5：GmConsole.jsx — Tab 集成
- 新增第 4 个 Tab "Lua UI"
- 传递 clients / selectedClient / broadcastMode props

### Step 6：端到端验证
- Web → EncyHub → TCP → 客户端 → 回传 → Web 显示
- 编辑值 → 确认生效 → 还原
- Live 刷新稳定性（连续运行 1 分钟无内存泄漏、无 WS 断连）
- 压力场景：嵌套层级 > 5 的 UI 树、含 50+ 字段的节点、快速切换 UI

---

## 八、风险与应对

| # | 风险 | 应对 |
|---|------|------|
| 1 | 大 table 序列化导致 TCP 包过大 | 深度限制 3 层 + 数组截断 100 + 前端懒加载展开 |
| 2 | 循环引用导致序列化死循环 | visited set 检测，返回 `[circular]` |
| 3 | UI 在查看期间被关闭 | API 返回 error，前端清理选中状态 |
| 4 | XMain.lua 文件变大 | Inspector 模块作为独立代码块，有清晰的注释分隔 |
| 5 | Live 刷新频率过高导致性能问题 | 默认 1s，可调节，仅刷新当前节点 |
| 6 | 多客户端同时操作同一 UI | 最后写入者生效，暂不做冲突检测 |
