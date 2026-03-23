# LuaUiInspector Web 端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lua UI Inspector 从 Unity Editor 窗口扩展到 EncyHub GM Console Web 端，实现真机远程调试。

**Architecture:** Lua 侧在 XMain.lua 的 RuntimeGMClient 内嵌入 Inspector 模块，通过 TCP 与 EncyHub 后端通信。后端接收 UI_INSPECTOR_RESP 包并通过 WebSocket 推送给 React 前端。前端以新 Tab 形式集成到 GmConsole 页面。

**Tech Stack:** Lua (XLua) / Python (FastAPI + asyncio) / React + Tailwind CSS

**Spec:** `E:\Such_Proj\Other\EncyHub\requirement_doc\25_施工方案书_LuaUiInspector_Web端实现.md`

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|---------|
| `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` | 嵌入 LuaUiInspector 模块到 StartRuntimeGM() | 修改 |
| `E:\Such_Proj\Other\EncyHub\tools\gm_console\server_mgr.py` | 新增 UI_INSPECTOR_RESP 包处理 + send 方法 | 修改 |
| `E:\Such_Proj\Other\EncyHub\tools\gm_console\main.py` | 新增 Inspector API + WS 端点 + 回调注册 | 修改 |
| `E:\Such_Proj\Other\EncyHub\frontend\src\pages\LuaUiInspector.jsx` | Inspector 前端组件（双栏布局） | 新增 |
| `E:\Such_Proj\Other\EncyHub\frontend\src\pages\GmConsole.jsx` | 集成第 4 个 Tab | 修改 |

---

## Task 1: XMain.lua — 嵌入 Inspector 工具函数

**Files:**
- Modify: `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua:947` (在 LuaAnimatorMonitor.Update 结束后、RuntimeGMClient.Update 之前)

- [ ] **Step 1: 添加 LuaUiInspector 局部模块和工具函数**

在 `StartRuntimeGM()` 内、`LuaAnimatorMonitor` 代码块结束后（约 947 行），`RuntimeGMClient.Update` 之前，插入：

```lua
    -- ========== LuaUiInspector: 运行时 Lua UI 数据查看 (真机兼容) ==========
    local LuaUiInspector = {}
    LuaUiInspector._OriginalValues = {}  -- { [uiName] = { [path] = originalValue } }

    local INSPECTOR_SKIP_KEYS = {
        UiProxy = true, Ui = true, Transform = true,
        GameObject = true, Parent = true,
        UiAnimation = true, UiSceneInfo = true, UiModel = true, UiModelGo = true,
        SignalData = true, ChildSignalDatas = true,
    }
    local INSPECTOR_MAX_ARRAY = 100

    local function inspectorGetTypeName(v)
        local t = type(v)
        if t == "userdata" then
            local ok, typeName = pcall(function() return tostring(v:GetType()) end)
            if ok and typeName then return "userdata", typeName end
            return "userdata", "userdata"
        end
        return t, nil
    end

    local function inspectorTableKeyCount(t)
        local count = 0
        for _ in pairs(t) do count = count + 1 end
        return count
    end

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
            for _, k in ipairs(keys) do
                if shown >= INSPECTOR_MAX_ARRAY then truncated = true; break end
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

    origin_print("[RuntimeGM] LuaUiInspector module initialized")
```

- [ ] **Step 2: 验证语法**

在 Unity Editor 中 Play Mode 启动游戏，确认 Console 输出 `[RuntimeGM] LuaUiInspector module initialized`，无语法错误。

---

## Task 2: XMain.lua — 嵌入 Inspector 核心 API

**Files:**
- Modify: `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` (紧接 Task 1 代码之后)

- [ ] **Step 1: 添加 GetOpenUiList**

```lua
    function LuaUiInspector.GetOpenUiList()
        local result = {}
        local ok, allList = pcall(function() return CS.XUiManager.Instance:GetAllList() end)
        if not ok or not allList then
            return { error = "Failed to get UI list: " .. tostring(allList) }
        end
        local seen = {}
        for i = 0, allList.Count - 1 do
            local xok, info = pcall(function()
                local xui = allList[i]
                local uiName = xui.UiData.UiName
                if seen[uiName] then return nil end
                seen[uiName] = true
                local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
                if not luaUi then return nil end
                return { name = uiName, active = xui.IsEnable }
            end)
            if xok and info then result[#result + 1] = info end
        end
        table.sort(result, function(a, b) return a.name < b.name end)
        -- 清理已关闭 UI 的 _OriginalValues
        local validNames = {}
        for _, info in ipairs(result) do validNames[info.name] = true end
        for uiName in pairs(LuaUiInspector._OriginalValues) do
            if not validNames[uiName] then LuaUiInspector._OriginalValues[uiName] = nil end
        end
        return result
    end
```

- [ ] **Step 2: 添加 GetUiTree**

```lua
    function LuaUiInspector.GetUiTree(uiName)
        local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
        if not luaUi then return { error = "UI not found: " .. tostring(uiName) } end

        local function buildChildren(node, basePath)
            local children = {}
            if node._ChildNodes and #node._ChildNodes > 0 then
                for i, child in ipairs(node._ChildNodes) do
                    local childPath = basePath == "" and ("_ChildNodes." .. i) or (basePath .. "._ChildNodes." .. i)
                    local goName = "Unknown"
                    pcall(function() goName = child.GameObject and tostring(child.GameObject.name) or "Unknown" end)
                    local cname = ""
                    pcall(function() cname = child.__cname or "" end)
                    local subChildren = buildChildren(child, childPath)
                    children[#children + 1] = {
                        type = "ChildNode", name = goName, cname = cname, path = childPath,
                        hasChildren = #subChildren > 0,
                        children = #subChildren > 0 and subChildren or nil,
                    }
                end
            end
            return children
        end

        return { name = uiName, children = buildChildren(luaUi, "") }
    end
```

- [ ] **Step 3: 添加 GetNodeData**

```lua
    function LuaUiInspector.GetNodeData(uiName, path, depth)
        local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
        if not luaUi then return { error = "UI not found" } end
        depth = depth or 3
        local target = luaUi
        if path and path ~= "" then
            for seg in string.gmatch(path, "[^%.]+") do
                local key = tonumber(seg) or seg
                if type(target) ~= "table" then return { error = "Path invalid" } end
                target = target[key]
            end
        end
        if type(target) ~= "table" then
            return { fields = { inspectorSerializeValue(target, 0, {}, nil) } }
        end
        local fields = {}
        local visited = { [target] = true }
        local originals = LuaUiInspector._OriginalValues[uiName] or {}
        for _, k in ipairs(inspectorGetSortedKeys(target)) do
            local v = target[k]
            local keyStr = tostring(k)
            local fieldPath = (not path or path == "") and keyStr or (path .. "." .. keyStr)
            local desc = inspectorSerializeValue(v, INSPECTOR_SKIP_KEYS[k] and 0 or (depth - 1), visited, k)
            desc.key = keyStr
            desc.modified = originals[fieldPath] ~= nil
            fields[#fields + 1] = desc
        end
        return { fields = fields }
    end
```

- [ ] **Step 4: 添加 SetValue / RevertValue / RevertAll**

```lua
    function LuaUiInspector.SetValue(uiName, path, value, valueType)
        local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
        if not luaUi then return { success = false, error = "UI not found" } end
        if not path or path == "" then return { success = false, error = "Path is empty" } end
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
        local parent, lastKey, oldValue = inspectorResolvePath(luaUi, path)
        if not parent or not lastKey then return { success = false, error = "Path not found" } end
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

- [ ] **Step 5: 验证编译**

Play Mode 启动游戏，确认无语法错误。

---

## Task 3: XMain.lua — HandleCommand + ProcessPacket 路由

**Files:**
- Modify: `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` (紧接 Task 2 代码之后 + 修改 ProcessPacket)

- [ ] **Step 1: 添加 HandleCommand**

紧接 RevertAll 之后添加：

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
        RuntimeGMClient.Send({ type = "UI_INSPECTOR_RESP", action = action, data = result })
    end
```

- [ ] **Step 2: 修改 ProcessPacket 添加路由**

在 `RuntimeGMClient.ProcessPacket` 中，找到（约 1029 行）：

```lua
        elseif type and type:sub(1, 5) == "ANIM_" then
```

在它**之前**插入：

```lua
        elseif type == "UI_INSPECTOR" then
            local ok, err = pcall(LuaUiInspector.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] UI_INSPECTOR error: " .. tostring(err))
            end
```

- [ ] **Step 3: 端到端 Lua 测试**

启动游戏 + EncyHub，在 GM Console 的 Lua 执行框输入：

```
RuntimeGMClient.ProcessPacket('{"type":"UI_INSPECTOR","action":"ui_list"}')
```

确认 EncyHub 日志输出收到 `UI_INSPECTOR_RESP` 包（此时后端还没处理，只需确认客户端发包成功）。

---

## Task 4: server_mgr.py — Inspector 包处理

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\tools\gm_console\server_mgr.py`

- [ ] **Step 1: 添加回调属性**

在 `__init__` 中（约 69 行 `self.on_animator_removed = None` 之后）添加：

```python
        self.on_inspector_data = None       # Callback for UI_INSPECTOR_RESP
```

- [ ] **Step 2: 添加 _process_packet 分支**

在 `_process_packet` 方法中，找到（约 251 行）：

```python
        elif t == "ANIM_REMOVED":
            if self.on_animator_removed:
                self.on_animator_removed(cid, pkt.get("animatorId"))
```

在其后添加：

```python
        elif t == "UI_INSPECTOR_RESP":
            if self.on_inspector_data:
                self.on_inspector_data(cid, pkt)
```

- [ ] **Step 3: 添加 send_inspector_request 方法**

在 `get_cached_animator_list` 方法（约 486 行）之后添加：

```python
    async def send_inspector_request(self, client_id: str, action: str, params: dict):
        """发送 Inspector 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "UI_INSPECTOR", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send UI_INSPECTOR failed: {e}", client_id)
```

- [ ] **Step 4: 验证后端启动**

重启 EncyHub，确认无 import 错误，服务正常启动。

---

## Task 5: main.py — Inspector API + WebSocket

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\tools\gm_console\main.py`

- [ ] **Step 1: 添加 Inspector WebSocket 连接池和广播函数**

在 `broadcast_animator_event` 函数（约 298 行）之后添加：

```python
# === Lua UI Inspector API ===

inspector_ws_connections: list = []

async def broadcast_inspector_event(data: dict):
    dead = []
    for ws in inspector_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        inspector_ws_connections.remove(ws)
```

- [ ] **Step 2: 注册 Inspector 回调**

在 `lifespan` 函数中，找到（约 108 行）：

```python
    server_mgr.on_animator_removed = on_animator_removed
```

在其后添加：

```python
    def on_inspector_data(client_id, pkt):
        asyncio.create_task(broadcast_inspector_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        }))

    server_mgr.on_inspector_data = on_inspector_data
```

- [ ] **Step 3: 添加 Inspector 命令 API**

在 Animator API 的 `set_animator_param` 端点（约 328 行）之后添加：

```python
@app.post("/inspector/{client_id}/command")
async def inspector_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_inspector_request(client_id, action, body)
    return {"status": "requested"}
```

- [ ] **Step 4: 添加 Inspector WebSocket 端点**

在 `websocket_animator` 端点（约 341 行）之后添加：

```python
@app.websocket("/ws/inspector")
async def websocket_inspector(websocket: WebSocket):
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

- [ ] **Step 5: 后端集成测试**

重启 EncyHub，用浏览器开发者工具连接 `ws://localhost:PORT/api/gm_console/ws/inspector`，然后用 curl 测试：

```bash
curl -X POST http://localhost:PORT/api/gm_console/inspector/CLIENT_ID/command \
  -H "Content-Type: application/json" \
  -d '{"action":"ui_list"}'
```

确认 WebSocket 收到 `{"type":"ui_list","client_id":"...","data":[...]}` 响应。

---

## Task 6: LuaUiInspector.jsx — 前端组件骨架

**Files:**
- Create: `E:\Such_Proj\Other\EncyHub\frontend\src\pages\LuaUiInspector.jsx`

- [ ] **Step 1: 创建组件文件，搭建双栏布局 + WebSocket 通信**

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, RotateCw, ChevronRight, ChevronDown, Undo2, Play, Pause, Eye } from 'lucide-react'

// ============================================================================
// WebSocket 通信 Hook
// ============================================================================
function useInspectorWs(selectedClient) {
    const listenersRef = useRef({})
    const wsRef = useRef(null)

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
        wsRef.current = socket
        return () => { socket.close(); wsRef.current = null }
    }, [selectedClient?.id])

    const request = useCallback((action, params, onResponse) => {
        if (!selectedClient) return
        listenersRef.current[action] = onResponse
        fetch(`/api/gm_console/inspector/${selectedClient.id}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...params })
        }).catch(err => console.error('[Inspector] request failed:', err))
    }, [selectedClient?.id])

    return { request, wsRef }
}

// ============================================================================
// 类型色彩
// ============================================================================
const TYPE_COLORS = {
    number: '#7D9B76',
    string: '#7D9B76',
    boolean: '#7D9B76',
    table: '#6B8FBF',
    userdata: '#D4A574',
    function: '#9B7DBF',
    nil: '#A89B91',
    ref: '#A89B91',
}

// ============================================================================
// 主组件
// ============================================================================
export default function LuaUiInspector({ clients, selectedClient, broadcastMode }) {
    // --- 数据状态 ---
    const [uiList, setUiList] = useState([])
    const [uiTree, setUiTree] = useState(null)
    const [nodeData, setNodeData] = useState(null)

    // --- 选中状态 ---
    const [selectedUi, setSelectedUi] = useState(null)
    const [selectedPath, setSelectedPath] = useState('')
    const [breadcrumb, setBreadcrumb] = useState([])

    // --- UI 控件 ---
    const [leftFilter, setLeftFilter] = useState('')
    const [rightFilter, setRightFilter] = useState('')
    const [depth, setDepth] = useState(3)
    const [liveMode, setLiveMode] = useState(false)
    const [liveInterval, setLiveInterval] = useState(1)

    // --- 树展开状态 ---
    const [expandedNodes, setExpandedNodes] = useState(new Set())

    // --- 字段展开状态 ---
    const [expandedFields, setExpandedFields] = useState(new Set())

    // --- 分类折叠状态 ---
    const [collapsedCategories, setCollapsedCategories] = useState(new Set())

    // --- 通信 ---
    const { request } = useInspectorWs(selectedClient)

    // --- 请求 UI 列表 ---
    const refreshUiList = useCallback(() => {
        request('ui_list', {}, (data) => {
            if (data.error) { console.error(data.error); return }
            setUiList(data)
        })
    }, [request])

    // --- 请求 UI 树 ---
    const loadUiTree = useCallback((uiName) => {
        setSelectedUi(uiName)
        setSelectedPath('')
        setBreadcrumb([{ name: uiName, path: '' }])
        setNodeData(null)
        setExpandedNodes(new Set())
        setExpandedFields(new Set())
        request('ui_tree', { uiName }, (data) => {
            if (data.error) { setUiTree(null); return }
            setUiTree(data)
        })
        // 同时请求根节点数据
        request('node_data', { uiName, path: '', depth }, (data) => {
            if (!data.error) setNodeData(data)
        })
    }, [request, depth])

    // --- 请求节点数据 ---
    const loadNodeData = useCallback((uiName, path, nodeName) => {
        setSelectedPath(path)
        setExpandedFields(new Set())
        // 更新面包屑
        if (path === '') {
            setBreadcrumb([{ name: uiName, path: '' }])
        } else {
            const parts = path.split('.')
            const crumbs = [{ name: uiName, path: '' }]
            let p = ''
            for (const part of parts) {
                p = p ? p + '.' + part : part
                crumbs.push({ name: part, path: p })
            }
            setBreadcrumb(crumbs)
        }
        request('node_data', { uiName, path, depth }, (data) => {
            if (data.error) {
                setNodeData(null)
                if (data.error.includes('not found')) {
                    setLiveMode(false)
                }
                return
            }
            setNodeData(data)
        })
    }, [request, depth])

    // --- Live 刷新 ---
    useEffect(() => {
        if (!liveMode || !selectedUi) return
        const timer = setInterval(() => {
            request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (data) => {
                if (data.error) { setLiveMode(false); return }
                setNodeData(data)
            })
        }, liveInterval * 1000)
        return () => clearInterval(timer)
    }, [liveMode, liveInterval, selectedUi, selectedPath, depth, request])

    // --- 修改值 ---
    const setValue = useCallback((path, value, valueType) => {
        request('set_value', { uiName: selectedUi, path, value, valueType }, (data) => {
            if (data.success) {
                // 刷新当前节点
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    // --- 还原 ---
    const revertValue = useCallback((path) => {
        request('revert', { uiName: selectedUi, path }, (data) => {
            if (data.success) {
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    const revertAll = useCallback(() => {
        if (!selectedUi) return
        request('revert_all', { uiName: selectedUi }, (data) => {
            if (data.success) {
                request('node_data', { uiName: selectedUi, path: selectedPath, depth }, (d) => {
                    if (!d.error) setNodeData(d)
                })
            }
        })
    }, [request, selectedUi, selectedPath, depth])

    // --- 无客户端时提示 ---
    if (!selectedClient) {
        return (
            <div className="flex items-center justify-center h-64 text-[var(--coffee-muted)]">
                请先在左侧选择一个客户端
            </div>
        )
    }

    // --- 左侧过滤 ---
    const filteredUiList = leftFilter
        ? uiList.filter(ui => ui.name.toLowerCase().includes(leftFilter.toLowerCase()))
        : uiList

    return (
        <div className="flex h-full" style={{ minHeight: '500px' }}>
            {/* ===== 左栏 ===== */}
            <div className="w-72 flex-shrink-0 border-r border-[var(--glass-border)] flex flex-col">
                {/* UI 列表头部 */}
                <div className="p-3 border-b border-[var(--glass-border)]">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-[var(--coffee-deep)]">Open UIs</span>
                        <button
                            onClick={refreshUiList}
                            className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] transition-colors"
                            title="刷新 UI 列表"
                        >
                            <RotateCw size={14} />
                        </button>
                    </div>
                    <div className="relative">
                        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                        <input
                            type="text"
                            value={leftFilter}
                            onChange={e => setLeftFilter(e.target.value)}
                            placeholder="搜索 UI..."
                            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                        />
                    </div>
                </div>

                {/* UI 列表 + 树 */}
                <div className="flex-1 overflow-y-auto p-2 text-xs">
                    {filteredUiList.length === 0 && (
                        <div className="text-center text-[var(--coffee-muted)] py-4">
                            {uiList.length === 0 ? '点击 Refresh 加载' : '无匹配'}
                        </div>
                    )}
                    {filteredUiList.map(ui => (
                        <UiTreeItem
                            key={ui.name}
                            ui={ui}
                            isSelected={selectedUi === ui.name}
                            selectedPath={selectedPath}
                            tree={selectedUi === ui.name ? uiTree : null}
                            expandedNodes={expandedNodes}
                            onSelectUi={() => loadUiTree(ui.name)}
                            onSelectNode={(path, name) => loadNodeData(ui.name, path, name)}
                            onToggleNode={(path) => {
                                setExpandedNodes(prev => {
                                    const next = new Set(prev)
                                    next.has(path) ? next.delete(path) : next.add(path)
                                    return next
                                })
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* ===== 右栏 ===== */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* 面包屑 + 控件 */}
                <div className="p-3 border-b border-[var(--glass-border)]">
                    {/* 面包屑 */}
                    <div className="flex items-center gap-1 text-xs text-[var(--coffee-muted)] mb-2 flex-wrap">
                        <Eye size={12} />
                        {breadcrumb.map((crumb, i) => (
                            <span key={crumb.path} className="flex items-center gap-1">
                                {i > 0 && <ChevronRight size={10} />}
                                <button
                                    onClick={() => loadNodeData(selectedUi, crumb.path, crumb.name)}
                                    className={`hover:text-[var(--coffee-deep)] hover:underline ${
                                        crumb.path === selectedPath ? 'text-[var(--coffee-deep)] font-medium' : ''
                                    }`}
                                >
                                    {crumb.name}
                                </button>
                            </span>
                        ))}
                    </div>

                    {/* 过滤 + Depth + Live */}
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                            <input
                                type="text"
                                value={rightFilter}
                                onChange={e => setRightFilter(e.target.value)}
                                placeholder="过滤字段..."
                                className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"
                            />
                        </div>
                        <label className="flex items-center gap-1 text-xs text-[var(--coffee-muted)]">
                            Depth
                            <select
                                value={depth}
                                onChange={e => setDepth(Number(e.target.value))}
                                className="px-1 py-0.5 rounded border border-[var(--glass-border)] text-xs bg-white"
                            >
                                {[1,2,3,4,5].map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </label>
                    </div>
                </div>

                {/* 属性面板 */}
                <div className="flex-1 overflow-y-auto p-3">
                    {!nodeData ? (
                        <div className="flex items-center justify-center h-32 text-[var(--coffee-muted)] text-sm">
                            {selectedUi ? '选择一个节点查看数据' : '选择一个 UI 开始'}
                        </div>
                    ) : nodeData.fields ? (
                        <FieldList
                            fields={nodeData.fields}
                            filter={rightFilter}
                            expandedFields={expandedFields}
                            collapsedCategories={collapsedCategories}
                            selectedUi={selectedUi}
                            parentPath={selectedPath}
                            onToggleField={(key) => {
                                setExpandedFields(prev => {
                                    const next = new Set(prev)
                                    next.has(key) ? next.delete(key) : next.add(key)
                                    return next
                                })
                            }}
                            onToggleCategory={(cat) => {
                                setCollapsedCategories(prev => {
                                    const next = new Set(prev)
                                    next.has(cat) ? next.delete(cat) : next.add(cat)
                                    return next
                                })
                            }}
                            onSetValue={setValue}
                            onRevert={revertValue}
                            onNavigate={(path, name) => loadNodeData(selectedUi, path, name)}
                        />
                    ) : null}
                </div>

                {/* 底栏 */}
                <div className="p-3 border-t border-[var(--glass-border)] flex items-center justify-between">
                    <button
                        onClick={revertAll}
                        disabled={!selectedUi}
                        className="px-3 py-1.5 text-xs rounded-md border border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--terracotta)] hover:border-[var(--terracotta)] disabled:opacity-40 transition-colors"
                    >
                        <span className="flex items-center gap-1"><Undo2 size={12} /> Revert All</span>
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setLiveMode(!liveMode)}
                            className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-1 transition-colors ${
                                liveMode
                                    ? 'bg-[var(--sage)] text-white'
                                    : 'border border-[var(--glass-border)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                            }`}
                        >
                            {liveMode ? <Pause size={12} /> : <Play size={12} />}
                            {liveMode ? 'Live' : 'Paused'}
                        </button>
                        <select
                            value={liveInterval}
                            onChange={e => setLiveInterval(Number(e.target.value))}
                            className="px-1 py-1 rounded border border-[var(--glass-border)] text-xs bg-white"
                        >
                            {[0.5, 1, 2, 3].map(s => <option key={s} value={s}>{s}s</option>)}
                        </select>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ============================================================================
// 左侧 UI 树节点
// ============================================================================
function UiTreeItem({ ui, isSelected, selectedPath, tree, expandedNodes, onSelectUi, onSelectNode, onToggleNode }) {
    return (
        <div className="mb-0.5">
            {/* UI 名行 */}
            <button
                onClick={onSelectUi}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                    isSelected ? 'bg-[var(--cream-warm)] text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                }`}
            >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ui.active ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'}`} />
                <span className="truncate font-medium">{ui.name}</span>
            </button>

            {/* 展开的组件树 */}
            {isSelected && tree && tree.children && (
                <div className="ml-3">
                    {tree.children.map((child, i) => (
                        <TreeNode
                            key={child.path || i}
                            node={child}
                            selectedPath={selectedPath}
                            expandedNodes={expandedNodes}
                            onSelect={onSelectNode}
                            onToggle={onToggleNode}
                            indent={0}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function TreeNode({ node, selectedPath, expandedNodes, onSelect, onToggle, indent }) {
    const isExpanded = expandedNodes.has(node.path)
    const isSelected = selectedPath === node.path
    const hasChildren = node.hasChildren || (node.children && node.children.length > 0)

    return (
        <div>
            <button
                onClick={() => {
                    onSelect(node.path, node.name)
                    if (hasChildren) onToggle(node.path)
                }}
                className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-left transition-colors ${
                    isSelected ? 'bg-[var(--caramel)]/15 text-[var(--coffee-deep)]' : 'hover:bg-[var(--cream-warm)]/50 text-[var(--coffee-deep)]'
                }`}
                style={{ paddingLeft: `${indent * 12 + 4}px` }}
            >
                {hasChildren ? (
                    isExpanded ? <ChevronDown size={12} className="flex-shrink-0 text-[var(--coffee-muted)]" /> : <ChevronRight size={12} className="flex-shrink-0 text-[var(--coffee-muted)]" />
                ) : (
                    <span className="w-3 flex-shrink-0" />
                )}
                <span className="truncate">{node.name}</span>
                {node.cname && <span className="text-[var(--coffee-muted)] opacity-60 ml-1 truncate">{node.cname}</span>}
            </button>
            {isExpanded && node.children && node.children.map((child, i) => (
                <TreeNode
                    key={child.path || i}
                    node={child}
                    selectedPath={selectedPath}
                    expandedNodes={expandedNodes}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    indent={indent + 1}
                />
            ))}
        </div>
    )
}

// ============================================================================
// 右侧属性列表
// ============================================================================
function FieldList({ fields, filter, expandedFields, collapsedCategories, selectedUi, parentPath, onToggleField, onToggleCategory, onSetValue, onRevert, onNavigate }) {
    if (!fields || fields.length === 0) return <div className="text-center text-[var(--coffee-muted)] text-xs py-4">无字段</div>

    // 按类型分组
    const categories = {
        editable: { label: '可编辑属性', color: TYPE_COLORS.number, items: [] },
        table: { label: '子表', color: TYPE_COLORS.table, items: [] },
        userdata: { label: 'Unity 引用', color: TYPE_COLORS.userdata, items: [] },
        func: { label: '方法', color: TYPE_COLORS.function, items: [] },
        other: { label: '其他', color: TYPE_COLORS.nil, items: [] },
    }

    const lowerFilter = filter.toLowerCase()
    for (const f of fields) {
        if (filter && !f.key.toLowerCase().includes(lowerFilter)) continue
        if (f.editable) categories.editable.items.push(f)
        else if (f.type === 'table') categories.table.items.push(f)
        else if (f.type === 'userdata') categories.userdata.items.push(f)
        else if (f.type === 'function') categories.func.items.push(f)
        else categories.other.items.push(f)
    }

    return (
        <div className="space-y-2">
            {Object.entries(categories).map(([catKey, cat]) => {
                if (cat.items.length === 0) return null
                const isCollapsed = collapsedCategories.has(catKey)
                return (
                    <div key={catKey}>
                        <button
                            onClick={() => onToggleCategory(catKey)}
                            className="flex items-center gap-1.5 text-xs font-semibold mb-1 hover:opacity-80"
                            style={{ color: cat.color }}
                        >
                            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            {cat.label} ({cat.items.length})
                        </button>
                        {!isCollapsed && (
                            <div className="space-y-0.5">
                                {cat.items.map(f => (
                                    <FieldRow
                                        key={f.key}
                                        field={f}
                                        catColor={cat.color}
                                        expanded={expandedFields.has(f.key)}
                                        selectedUi={selectedUi}
                                        parentPath={parentPath}
                                        onToggle={() => onToggleField(f.key)}
                                        onSetValue={onSetValue}
                                        onRevert={onRevert}
                                        onNavigate={onNavigate}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

// ============================================================================
// 单行字段
// ============================================================================
function FieldRow({ field, catColor, expanded, canExpand = true, selectedUi, parentPath, onToggle, onSetValue, onRevert, onNavigate }) {
    const [editValue, setEditValue] = useState(String(field.value ?? ''))
    const [isEditing, setIsEditing] = useState(false)
    const f = field
    const fieldPath = parentPath ? `${parentPath}.${f.key}` : f.key

    // Live 刷新时同步外部值（仅在非编辑状态下）
    useEffect(() => {
        if (!isEditing) setEditValue(String(f.value ?? ''))
    }, [f.value, isEditing])

    // 值编辑提交
    const submitEdit = () => {
        if (!isEditing) return
        setIsEditing(false)
        onSetValue(fieldPath, editValue, f.type)
    }

    return (
        <div>
            <div
                className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors hover:bg-[var(--cream-warm)]/30 ${
                    f.modified ? 'border-l-2' : ''
                }`}
                style={f.modified ? { borderLeftColor: '#E8A317' } : {}}
            >
                {/* Key */}
                <span className="w-32 flex-shrink-0 font-mono truncate" style={{ color: catColor }} title={f.key}>
                    {f.type === 'table' && canExpand && (
                        <button onClick={onToggle} className="inline mr-1">
                            {expanded ? <ChevronDown size={10} className="inline" /> : <ChevronRight size={10} className="inline" />}
                        </button>
                    )}
                    {f.key}
                </span>

                {/* Value */}
                <div className="flex-1 min-w-0">
                    {f.editable ? (
                        f.type === 'boolean' ? (
                            <input
                                type="checkbox"
                                checked={!!f.value}
                                onChange={e => onSetValue(fieldPath, e.target.checked ? 'true' : 'false', 'boolean')}
                                className="accent-[var(--sage)]"
                            />
                        ) : (
                            <input
                                type={f.type === 'number' ? 'number' : 'text'}
                                value={editValue}
                                onFocus={() => setIsEditing(true)}
                                onChange={e => setEditValue(e.target.value)}
                                onBlur={submitEdit}
                                onKeyDown={e => { if (e.key === 'Enter') { submitEdit(); e.target.blur() } }}
                                className="w-full px-1.5 py-0.5 rounded border border-[var(--glass-border)] bg-white/70 font-mono text-xs focus:outline-none focus:border-[var(--caramel)]"
                            />
                        )
                    ) : f.type === 'table' ? (
                        <button
                            onClick={() => onNavigate(fieldPath, f.key)}
                            className="text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:underline"
                        >
                            {'{' + (f.childCount || '?') + ' fields}'}
                        </button>
                    ) : (
                        <span className="text-[var(--coffee-muted)] font-mono truncate block">
                            {String(f.value)}
                        </span>
                    )}
                </div>

                {/* Revert 按钮 */}
                {f.modified && (
                    <button
                        onClick={() => onRevert(fieldPath)}
                        className="p-0.5 rounded hover:bg-[var(--cream-warm)] text-[var(--amber)]"
                        title="还原"
                    >
                        <Undo2 size={12} />
                    </button>
                )}
            </div>

            {/* 展开的子表 */}
            {expanded && f.type === 'table' && f.fields && (
                <div className="ml-6 mt-0.5 pl-2 border-l border-[var(--glass-border)]">
                    {f.fields.map(sub => (
                        <FieldRow
                            key={sub.key}
                            field={sub}
                            catColor={TYPE_COLORS[sub.type] || TYPE_COLORS.nil}
                            expanded={false}
                            canExpand={false}
                            selectedUi={selectedUi}
                            parentPath={fieldPath}
                            onToggle={() => {}}
                            onSetValue={onSetValue}
                            onRevert={onRevert}
                            onNavigate={onNavigate}
                        />
                    ))}
                    {f.truncated && (
                        <div className="text-[var(--coffee-muted)] text-xs py-1 italic">
                            ... 已截断，共 {f.total} 项，显示 {f.shown} 项
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
```

- [ ] **Step 2: 验证前端编译**

```bash
cd E:\Such_Proj\Other\EncyHub\frontend && npm run build
```

确认无编译错误。

---

## Task 7: GmConsole.jsx — Tab 集成

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\frontend\src\pages\GmConsole.jsx`

- [ ] **Step 1: 添加 import**

在文件顶部 import 区域添加：

```jsx
import LuaUiInspector from './LuaUiInspector'
import { Inspect } from 'lucide-react'
```

> 注：如果 lucide-react 没有 `Inspect` 图标，改用 `Eye` 或 `ScanSearch`。

- [ ] **Step 2: 添加 Tab 按钮**

找到 Animator Tab 按钮（包含 `activeTab === 'animator'` 的 `<button>`），在其**后面**添加第 4 个 Tab：

```jsx
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
```

- [ ] **Step 3: 添加 Tab 内容渲染**

找到 Animator 的条件渲染（`{activeTab === 'animator' && ...}`），在其**后面**添加：

```jsx
                    {activeTab === 'lua_inspector' && (
                        <LuaUiInspector
                            clients={clients}
                            selectedClient={selectedClient}
                            broadcastMode={broadcastMode}
                        />
                    )}
```

- [ ] **Step 4: 前端编译验证**

```bash
cd E:\Such_Proj\Other\EncyHub\frontend && npm run build
```

确认无编译错误。

---

## Task 8: 端到端验证

**Files:** 无新改动，仅验证

- [ ] **Step 1: 启动全链路**

1. 启动 EncyHub 后端
2. Unity Editor Play Mode 启动游戏
3. 确认 RuntimeGMClient 连接成功（Console 输出 `[RuntimeGM] 连接成功！`）
4. 打开浏览器访问 GM Console

- [ ] **Step 2: 验证 UI 列表**

1. 切换到 "Lua UI" Tab
2. 点击 Refresh 按钮
3. 确认显示当前打开的 UI 列表（如 UiMain、UiLogin 等）
4. 确认活跃 UI 显示绿色圆点

- [ ] **Step 3: 验证组件树 + 节点数据**

1. 点击一个 UI（如 UiMain）
2. 确认左侧展开组件树（ChildNodes）
3. 确认右侧显示根节点字段
4. 点击子节点，确认右侧切换为子节点字段
5. 确认面包屑导航正确

- [ ] **Step 4: 验证值编辑 + 还原**

1. 找到一个 number 类型字段，修改值，按 Enter
2. 确认游戏内值已变化
3. 确认该字段左侧出现 amber 高亮
4. 点击 ↩️ 还原按钮，确认值恢复
5. 测试 Revert All

- [ ] **Step 5: 验证 Live 刷新**

1. 开启 Live 模式（1s）
2. 在游戏中触发 UI 状态变化
3. 确认 Web 端数据自动更新
4. 切换 Pause，确认停止刷新

- [ ] **Step 6: 压力场景验证**

1. 打开一个层级较深的 UI，展开多层子节点
2. 在有 50+ 字段的节点上开启 Live 刷新，持续 1 分钟
3. 确认无明显卡顿或 WebSocket 断连
