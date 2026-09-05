# 实施计划：GM Console — 分包监控页签

> 基于：26_设计方案书_GmConsole_分包监控页签.md
> 日期：2026-03-30

---

## 实施顺序总览

```
Step 1: 后端 server_mgr.py       ← 通信基础
Step 2: 后端 main.py              ← 接口层
Step 3: 游戏侧 Lua 参考实现        ← 数据源（可与 Step 4 并行）
Step 4: 前端 SubPackageMonitor.jsx ← 核心 UI
Step 5: 前端 GmConsole.jsx 注册    ← 接入
Step 6: 联调验证                   ← 端到端
```

依赖关系：
- Step 1 → Step 2 → Step 4 → Step 5（串行）
- Step 3 可与 Step 4 并行
- Step 6 依赖所有前置步骤

---

## Step 1: 后端 — server_mgr.py 扩展

**目标**：新增 `SUBPKG_MONITOR_RESP` 包分发 + 发送方法

**文件**：`tools/gm_console/server_mgr.py`

### 1.1 新增 packet 分发

在 `_process_packet` 方法中（约 L275 `CS_MONITOR_RESP` 之后），新增：

```python
elif t == "SUBPKG_MONITOR_RESP":
    if self.on_subpkg_monitor_data:
        self.on_subpkg_monitor_data(cid, pkt)
```

### 1.2 新增发送方法

在 `send_timeline_request` 方法之后（约 L554），新增：

```python
async def send_subpkg_monitor_request(self, client_id: str, action: str, params: dict):
    """发送 SubPackage Monitor 命令到客户端"""
    c = self.clients.get(client_id)
    if not c:
        return
    pkt = {"type": "SUBPKG_MONITOR", "action": action}
    pkt.update(params)
    msg = json.dumps(pkt, ensure_ascii=False) + "\n"
    try:
        c.writer.write(msg.encode())
        await c.writer.drain()
    except Exception as e:
        self._add_log("error", f"Send SUBPKG_MONITOR failed: {e}", client_id)
```

### 苏格拉底自检 — Step 1

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | `_process_packet` 中 packet type 字符串是否与 Lua 侧 `RuntimeGMClient.Send` 的 type 完全一致？ | 是，都是 `"SUBPKG_MONITOR_RESP"` |
| 2 | `send_subpkg_monitor_request` 的参数签名是否与 `send_cs_monitor_request` / `send_timeline_request` 一致？ | 是，`(self, client_id, action, params)` |
| 3 | callback 属性 `on_subpkg_monitor_data` 是否需要在 `__init__` 中初始化为 None？ | 检查现有模式 — 其他 callback（on_inspector_data 等）是否在 `__init__` 中声明。如果没有则不需要（Python 的 `hasattr` / `getattr` 都能处理）。但要确保 `if self.on_subpkg_monitor_data` 不会 AttributeError |
| 4 | `ensure_ascii=False` 是否必要？ | 是，其他 send 方法没加但我们的 sub name 可能含中文。检查其他方法是否有此问题 — 如果统一不加也可以去掉保持一致 |

---

## Step 2: 后端 — main.py 扩展

**目标**：新增 WebSocket 端点、HTTP 端点、broadcast 函数、callback 注册

**文件**：`tools/gm_console/main.py`

### 2.1 Callback 注册

在 lifespan 函数中（约 L135 `server_mgr.on_cs_monitor_data` 之后、L137 启动监听之前），新增：

```python
def on_subpkg_monitor_data(client_id, pkt):
    asyncio.create_task(broadcast_subpkg_monitor_event({
        "type": pkt.get("action", "unknown"),
        "client_id": client_id,
        "data": pkt.get("data", {})
    }))

server_mgr.on_subpkg_monitor_data = on_subpkg_monitor_data
```

### 2.2 Broadcast + HTTP + WebSocket

在文件末尾（约 L470 timeline WebSocket 之后），新增完整的 API 区块：

```python
# === SubPackage Monitor API ===

subpkg_monitor_ws_connections: list = []

async def broadcast_subpkg_monitor_event(data: dict):
    dead = []
    for ws in subpkg_monitor_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        subpkg_monitor_ws_connections.remove(ws)

@app.post("/subpkg_monitor/{client_id}/command")
async def subpkg_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_subpkg_monitor_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/subpkg_monitor")
async def websocket_subpkg_monitor(websocket: WebSocket):
    await websocket.accept()
    subpkg_monitor_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in subpkg_monitor_ws_connections:
            subpkg_monitor_ws_connections.remove(websocket)
```

### 苏格拉底自检 — Step 2

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | `broadcast_subpkg_monitor_event` 在 lifespan 注册的 callback 中被调用，但定义在文件更下方 — Python 函数声明顺序是否会导致 NameError？ | 不会。lifespan 是 async generator，`broadcast_subpkg_monitor_event` 在被调用时（运行时）已经定义。其他 monitor 也是这个模式 |
| 2 | HTTP 路由 `/subpkg_monitor/{client_id}/command` 是否需要 hub 层代理配置？ | 需要确认 hub_core/api.py 的代理规则。如果 `/api/gm_console/*` 是通配代理，则自动覆盖；否则需要新增路由。检查 vite.config.js 的 proxy 配置：`/api` → hub → 工具端口 |
| 3 | WebSocket 路由 `/ws/subpkg_monitor` 是否需要在 hub 层注册 WS 代理？ | 同上。检查现有 `/ws/cs_monitor`、`/ws/timeline` 是否在 hub 层有显式注册 |
| 4 | `subpkg_monitor_ws_connections` 是全局 list，多个 WS 客户端是否有并发问题？ | 与现有模式一致，asyncio 是单线程事件循环，不会有 race condition |

---

## Step 3: 游戏侧 Lua 参考实现

**目标**：在 RuntimeGMClient 中新增 SUBPKG_MONITOR 处理

**文件**：游戏工程中 RuntimeGMClient 所在文件（由 custom_gm.json 中的嵌入代码定义，或独立 Lua 文件）

### 3.1 定位嵌入点

需要在 `RuntimeGMClient.ProcessPacket` 的 type 分支中新增 `"SUBPKG_MONITOR"` 处理。

### 3.2 get_structure 实现

收集完整结构数据（Sub 列表 + Res 列表 + 文件 + 共享关系），参考 Spec 第 8.1 节。

关键点：
- 遍历 `_SubpackageDict` 构建 subs 字典
- 遍历 `_SubIndexInfo` 构建 resources 字典 + 统计 sharedFiles
- Sub 的 name 来自 `GetSubpackageTemplate(subId).Name`（需确认字段名）
- Sub 的 resIds 来自 `GetSubpackageTemplate(subId).ResIds`
- Res 的 subIds 来自 `_Model:GetSubpackageIdByResId(resId)`

### 3.3 get_status 实现

收集轻量状态数据，参考 Spec 第 8.2 节。

关键点：
- 遍历 `_SubpackageDict` 取 State/DownloadSize/TotalSize/Progress
- 遍历 `_ResourceDict` 取相同字段 + TaskGroup.State
- `GetTaskGroup()` 可能返回 nil（未初始化时），需做保护

### 苏格拉底自检 — Step 3

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | `XMVCA.XSubPackage` 是否就是 `XSubPackageAgency` 的全局访问点？通过 XMVCA 调用时有无额外限制（如需登录后才可用）？ | 需确认。如果在主界面前调用可能 Agency 未初始化 |
| 2 | `GetAllResAndSubpackageItemDic()` 返回的 dict 是否可能为空（分包功能关闭时 `IsOpen()` 返回 false）？ | 是。Lua 侧需先检查 `IsOpen()`，关闭时返回空数据或错误提示 |
| 3 | `_SubIndexInfo` 在 `OnInit` 中从 `_LaunchDlcManager.GetIndexInfo()` 获取，如果 DLC Manager 未初始化会怎样？ | 可能为 nil。需在收集代码中做 nil check |
| 4 | `get_structure` 数据量有多大？如果有 80 个 Res 每个 100 个文件 = 8000 条文件记录，JSON 序列化后的大小是否会导致 TCP 单包过大？ | 需评估。如果超过 64KB 可能需要分批发送，或者依赖 TCP 流式传输（现有代码按 `\n` 分隔已支持大包） |
| 5 | `GetSubpackageTemplate(subId).Name` — 字段名是 `Name` 还是 `SubPackageName`？需要读实际的 template 表配置确认 | 需在实现时确认。Spec 中的 Lua 代码是参考骨架 |
| 6 | `RuntimeGMClient.Send` 的 JSON 序列化是否支持嵌套 table？Lua 的 table 中嵌套 array 和 dict 混合时，cjson 编码是否可靠？ | 现有 UI_INSPECTOR_RESP 已有复杂嵌套数据返回，说明可以 |

---

## Step 4: 前端 — SubPackageMonitor.jsx

**目标**：实现完整的分包监控 UI 组件

**文件**：`frontend/src/pages/SubPackageMonitor.jsx`（新建）

这是实现量最大的步骤，拆分为子步骤：

### 4.1 基础骨架 + WebSocket + 数据获取

**内容**：
- 组件签名：`export default function SubPackageMonitor({ clients, selectedClient, broadcastMode, active })`
- WebSocket 连接（连接 `/api/gm_console/ws/subpkg_monitor`，25s ping，自动重连）
- `sendCmd(action, params, onResponse)` — 采用 `listenersRef` 回调模式
- `structure` / `status` 两块 state
- 首次激活时发送 `get_structure`
- 自动轮询 `get_status`（默认 2s），`active === false` 时暂停

**参考**：CsComponentMonitor.jsx 的 WebSocket + sendCmd 模式

### 4.2 工具栏 (SubPkgToolbar)

**内容**：
- 搜索框：`searchQuery` state，300ms debounce via `useRef` + `setTimeout`
- 状态过滤：多选下拉，`stateFilter` state（Set）
- 模式切换：`viewMode` state（`'detail'` | `'columns'`），图标按钮组
- 自动刷新开关 + 间隔下拉（1s/2s/5s/10s）
- 手动刷新按钮（click = get_status, Shift+click = get_structure）
- 所有持久化 state 存入 localStorage

### 4.3 统计概览栏 (SubPkgOverview)

**内容**：
- 从 `structure` + `status` 合并计算：Sub 总数、Res 总数、已完成数、下载中数、总大小
- 一行 flex 布局，glass-card 样式
- 数字用 `font-display`，标签用 `font-body` 小字号
- 已完成 `--sage`，下载中 `--sky`

### 4.4 模式 A — 详情视图 (SubPkgDetailView)

#### 4.4a 左侧列表面板

- **视角切换**：`perspective` state（`'sub'` | `'res'`），SegmentedControl 样式
- **列表渲染**：根据 perspective 渲染 Sub 卡片 或 Res 卡片
- **卡片内容**：ID + 名称、进度条（颜色跟随 state）、State badge、已下载/总大小、共享标记
- **选中态**：`selectedId` state，左侧边框高亮
- **过滤**：根据 searchQuery 和 stateFilter 过滤列表
- **可拖拽宽度**：`leftWidth` state + onMouseDown/Move/Up

#### 4.4b 右侧详情面板

- **选中 Sub 时**：
  - 基本信息区（SubId、State badge、大进度条、Size）
  - 包含的 Res 表格（ResId、State、Progress、Size、共享 badge）
  - 点击 Res 行展开该 Res 的文件列表
  - 共享 badge `×N Sub ➜` 可点击跳转

- **选中 Res 时**：
  - 基本信息区（ResId、State、TaskGroupState、大进度条、Size）
  - 所属 Sub 表格（SubId、名称、State、`➜` 跳转按钮）
  - 文件列表表格（物理文件名、Size、sha1、共享 badge）
  - 文件名 hover 显示 tooltip（asset path）

### 4.5 模式 B — 三列视图 (SubPkgColumnView)

- **三列布局**：flex，每列独立滚动（`overflow-y: auto`）
- **联动逻辑**：
  - `selectedSub` → 过滤 Res 列
  - `selectedRes` → 过滤 File 列 + 高亮关联 Sub
  - 面包屑标题 + 清除按钮
- **每列卡片样式**：与模式 A 的列表卡片一致
- **共享 badge 点击**：滚动并高亮对应列中的项

### 4.6 公共子组件 / 工具函数

- `formatSize(bytes)` — 字节数格式化为人类可读
- `ProgressBar({ progress, state })` — 进度条组件（颜色跟随 state）
- `StateBadge({ state })` — 状态标签组件
- `SharedBadge({ count, type, onClick })` — 共享标记组件
- `highlightFlash` CSS 动画
- `STATE_CONFIG` — 状态 → 颜色/文案/图标 的映射表

### 苏格拉底自检 — Step 4

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | 组件会不会太大？单文件超过 1000 行是否需要拆分？ | CsComponentMonitor.jsx 约 800 行，LuaUiInspector.jsx 约 1000 行。如果超过 1200 行考虑拆分子组件到单独文件。但项目惯例是单文件组件，先写在一起，太大再拆 |
| 2 | 搜索在模式 B 时如何工作？三列分别过滤还是联动过滤？ | Spec 4.7 说 "三列分别过滤，但保留联动关系"。实现：搜索先过滤所有 Sub/Res/File，联动时只显示过滤后的子集 |
| 3 | `structure` 和 `status` 的合并渲染会不会导致频繁 re-render？每 2s 轮询一次 setStatus 会触发整棵组件树重渲染 | 用 `useMemo` 缓存合并后的数据。列表项用 React.memo 包装。进度条动画用 CSS transition 而非 JS 驱动 |
| 4 | 模式 A 和模式 B 切换时，是否需要保持选中状态？比如在 A 中选了 Sub 3，切到 B 后 Sub 列要高亮 Sub 3 吗？ | Spec 4.6 说 "切换时保留搜索条件和过滤状态"。selectedId 也应保留。模式 B 中 selectedSub 与模式 A 的 selectedId（sub perspective）同步 |
| 5 | 跳转动画 `scrollIntoView` 在三列独立滚动容器中能否正确定位？ | 需要给每列容器设 `position: relative` 并用容器的 `scrollTop` 而非全局 scrollIntoView。或者用 `el.scrollIntoView({ block: 'nearest' })` 配合列容器的 `overflow-y: auto` — 这在现代浏览器中是支持的 |
| 6 | Shift+点击手动刷新触发 get_structure — 如果此时正在自动轮询 get_status，两个响应是否会冲突？ | 不会。两个 action 通过 `listenersRef` 的不同 key 路由：`listenersRef.current['get_structure']` 和 `listenersRef.current['get_status']` |
| 7 | 模式 A 中 Res 视角选中某 Res 后，详情面板显示 "所属 Sub" 列表。点击 Sub 行的 ➜ 跳转到 Sub 视角 — 这需要同时切换 perspective 和 selectedId。状态更新顺序是否会导致闪烁？ | 用 `flushSync` 或在一个 setState 回调中批量更新。React 18 自动批量更新 state，不会闪烁 |

---

## Step 5: 前端 — GmConsole.jsx 注册

**目标**：将新页签接入主控制器

**文件**：`frontend/src/pages/GmConsole.jsx`

### 5.1 导入

在文件顶部（约 L13 `import CsComponentMonitor` 之后）：

```javascript
import SubPackageMonitor from './SubPackageMonitor'
```

### 5.2 Tab 图标导入

在 lucide-react 导入行（约 L3-8）中新增：

```javascript
import { ..., Package } from 'lucide-react'
```

### 5.3 TAB_META 新增

在 TAB_META 对象中（约 L22 `animator` 之后）：

```javascript
subpkg_monitor: { label: '分包监控', icon: Package },
```

### 5.4 DEFAULT_TAB_ORDER 新增

```javascript
const DEFAULT_TAB_ORDER = ['lua_gm', 'custom_gm', 'lua_inspector', 'timeline', 'cs_monitor', 'animator', 'subpkg_monitor']
```

### 5.5 渲染区域新增

在 CsComponentMonitor 的 `</div>` 之后（约 L1147）：

```jsx
<div style={{ display: activeTab === 'subpkg_monitor' ? 'contents' : 'none' }}>
  <SubPackageMonitor
    clients={clients}
    selectedClient={selectedClient}
    broadcastMode={broadcastMode}
    active={activeTab === 'subpkg_monitor'}
  />
</div>
```

### 苏格拉底自检 — Step 5

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | 新增 tab 后，已有用户的 localStorage 中保存了旧的 `gm_console_tab_order`，不包含 `subpkg_monitor` — 新 tab 会不会不显示？ | **已确认安全**。`loadTabOrder()` (L31-36) 有合并逻辑：遍历 `DEFAULT_TAB_ORDER`，如果 saved 中缺失则 `order.push(id)` 追加。新 tab 会自动出现在末尾 |
| 2 | `Package` 图标是否在 lucide-react 中存在？ | 是，lucide-react 有 `Package` 图标。可用 `Package2` 作为备选 |
| 3 | SubPackageMonitor 是否需要 `broadcastMode` prop？它是只读监控，broadcast 模式在这里意味着什么？ | 保持接口一致性，传入但可以不使用。如果 broadcastMode 下无 selectedClient，显示 "请选择客户端" |

---

## Step 6: 联调验证

**目标**：端到端验证完整功能

### 6.1 后端验证

- 启动 EncyHub，确认无启动错误
- 使用 curl/Postman 测试 HTTP 端点响应
- 确认 WebSocket 端点可连接并收到 pong

### 6.2 前端验证（无游戏客户端）

- 确认页签出现在 GM Console 中
- 确认搜索、过滤、模式切换等 UI 交互正常
- 确认无游戏客户端时显示正确的空状态
- 确认 localStorage 持久化正常

### 6.3 端到端验证（有游戏客户端）

- 连接游戏客户端后，确认 get_structure 返回正确数据
- 确认 get_status 轮询正常
- 验证模式 A / 模式 B 的联动、跳转、高亮
- 验证大数据量时的性能（滚动流畅度、刷新无卡顿）

### 苏格拉底自检 — Step 6

| # | 自检问题 | 预期回答 |
|---|---------|---------|
| 1 | 如果游戏侧 Lua 代码未部署，发送 SUBPKG_MONITOR 请求后会发生什么？ | 游戏侧会忽略未知 packet type（或打印 warning），前端不会收到响应。需确认前端不会因为无响应而卡住 — loading 状态应有 timeout 或者用户可手动刷新 |
| 2 | 开发阶段没有真实游戏客户端时如何测试？ | 可以写一个 mock TCP client（Python 脚本）模拟游戏侧发送 HELLO + SUBPKG_MONITOR_RESP |
| 3 | 热更新（HMR）时 WebSocket 连接是否会正确清理？ | React 的 useEffect cleanup 会关闭旧连接。Vite HMR 会触发组件重新挂载，cleanup 会执行 |

---

## 全局苏格拉底自检

以下是跨步骤的系统性自检：

### 数据一致性

| # | 问题 | 回答 |
|---|------|------|
| 1 | Lua 侧 `tostring(subId)` 作为 JSON key 发送，前端用 `Object.keys(data.subs)` 获取 — key 类型一定是 string，是否有 int 比较的坑？ | 是的。所有 ID 在前端统一用 string 比较。`selectedId` 也存 string |
| 2 | State 枚举值 0-5 是 Spec 中的参考值。如果游戏侧实际枚举不同怎么办？ | 前端的 STATE_CONFIG 映射表应该以实际游戏侧值为准。实施时需对齐，或做一个 fallback（未知 state 显示 "未知" + 灰色）|
| 3 | `get_status` 返回的 SubId/ResId 集合与 `get_structure` 不一致时（如运行期间新增/删除了 Res），如何处理？ | 如果 status 中出现 structure 中没有的 ID，忽略。如果 structure 中的 ID 在 status 中缺失，显示 "无状态数据"。用户可通过 Shift+刷新重拉 structure |

### 性能

| # | 问题 | 回答 |
|---|------|------|
| 4 | 2s 轮询 × 80 Res + 20 Sub = 每次约 100 条状态数据。JSON 大小约 3-5 KB，HTTP + WS 往返，性能 OK 吗？ | OK。现有 Animator 数据每帧都在更新，数据量更大 |
| 5 | 模式 B 三列滚动，如果 Sub 20 个、Res 80 个、某 Res 下 200 个文件 — 文件列表需要虚拟滚动吗？ | 200 条 DOM 节点不需要虚拟滚动。超过 1000 条考虑。先用简单列表，性能有问题再优化 |

### 可维护性

| # | 问题 | 回答 |
|---|------|------|
| 6 | 新增一个完整的 SubPackageMonitor.jsx 预计多少行？ | 预估 800-1200 行。如果超过 1200，考虑将 ColumnView 和 DetailView 拆为子组件文件 |
| 7 | 如果未来想从只读变为可操作（加下载/暂停按钮），改动有多大？ | 需要在工具栏或详情面板加操作按钮 + 新增 action（如 `start_download`、`pause`）。后端和 Lua 侧各加一个 action 分支。结构设计已为此留有空间 |

---

## 预估工作量分布

| 步骤 | 预估比重 | 说明 |
|------|---------|------|
| Step 1 | 5% | 约 15 行代码，模板化 |
| Step 2 | 10% | 约 40 行代码，模板化 |
| Step 3 | 15% | Lua 数据收集，需对齐游戏侧 API |
| Step 4 | 55% | 核心工作量，UI + 交互 + 两种模式 |
| Step 5 | 5% | 约 10 行改动 |
| Step 6 | 10% | 验证 + 修 bug |
