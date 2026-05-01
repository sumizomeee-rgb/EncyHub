# 设计方案书：GM Console — 分包监控页签

> 文档编号：26
> 日期：2026-03-30
> 状态：待评审

---

## 1. 概述

### 1.1 目标

在 GM Console 中新增「分包监控」页签，将游戏侧 `XSubPackageAgency:PrintAllSubIndexInfo()` 和 `XSubPackageAgency:PrintAllItemInfo()` 的数据以可交互的方式呈现，替代原本在日志中查看的方式。

### 1.2 核心需求

- 查看所有 SubPackage / Resource 的下载状态与进度
- 查看 Sub ↔ Res ↔ Files 的多对多包含关系
- 查看每个文件的 Index 信息（物理文件名、sha1、size）
- 共享关系可视化 + 点击跳转
- 只读（不提供下载/暂停/卸载等操作）

### 1.3 关键约束

- **多对多关系**：一个 Res 可属于多个 Sub，一个物理文件可被多个 Res 引用。UI 不能用纯树形暗示独占归属。
- **性能**：动态数据（State/Progress/Size）轮询间隔默认 2s；静态数据（结构/文件列表）仅首次加载和手动刷新时拉取。
- **UI 风格**：沿用项目 Golden Hour 色系 + glass-card 设计系统。

---

## 2. 数据模型

### 2.1 游戏侧原始数据源

#### _SubIndexInfo（静态结构）

```
table<ResId, table<assetPath, {fileName, sha1, size}>>
```

每个 ResId 下的所有文件，key 是 assetPath，value 是 `{[1]=physicalFileName, [2]=sha1, [3]=size}`。

#### _SubpackageDict / _ResourceDict（动态状态）

| 字段 | SubPackage (XSubpackage) | Resource (XResource) |
|------|--------------------------|----------------------|
| Id | _Id | _Id |
| State | GetState() | GetState() |
| DownloadSize | GetDownloadSize() — 聚合所有子 Res | GetDownloadSize() — _TaskGroup.DownloadedBytes |
| TotalSize | GetTotalSize() — C# API 获取 | GetTotalSize() — C# API 获取 |
| Progress | GetProgress() — 聚合所有子 Res | GetProgress() — _TaskGroup.ProgressRatio |
| TaskGroupState | — | GetTaskGroup().State |

#### 关系映射

| 关系 | 数据来源 | 说明 |
|------|----------|------|
| Sub → ResId[] | template.ResIds | 一个 Sub 包含哪些 Res |
| Res → SubId[] | GetSubpackageIdByResId(resId) | 一个 Res 属于哪些 Sub |
| Res → Files | _SubIndexInfo[resId] | 一个 Res 包含哪些文件 |
| File → ResId[] | _FileToResIds[fileName] | 一个物理文件被哪些 Res 引用 |

### 2.2 State 枚举

| 值 | 名称 | 显示文案 | 颜色 | 游戏 UI 行为 |
|----|------|----------|------|-------------|
| 1 | NOT_DOWNLOAD | 未下载 | `--coffee-muted` (灰) | 显示"下载"按钮，0% |
| 2 | PREPARE_DOWNLOAD | 准备中 | `--caramel` (橙) | 灰色"准备中"按钮 |
| 3 | PAUSE | 已暂停 | `--amber` (黄) | 显示"继续"按钮，保留进度 |
| 4 | DOWNLOADING | 下载中 | `--sky` (蓝) | 显示"下载中" + 实时进度 |
| 5 | COMPLETE | 已完成 | `--sage` (绿) | 灰色"已完成"，显示 ✓ |
| 6 | UNINSTALLED | 已卸载 | `--coffee-light` (深灰) | 显示"下载"按钮，尺寸显示 — |

> 来源：`XEnumConst.SUBPACKAGE.DOWNLOAD_STATE`（XEnumConst.lua:1398-1405）

---

## 3. 通信协议

### 3.1 概览

```
Frontend ──HTTP POST──→ Backend ──TCP──→ Game Client (Lua)
Frontend ←──WebSocket──── Backend ←──TCP──── Game Client
```

沿用现有 CsComponentMonitor / LuaUiInspector 的通信模式：
- 请求路径：`POST /api/gm_console/subpkg_monitor/{client_id}/command`
- 响应通道：`WebSocket /ws/subpkg_monitor`
- 游戏侧 packet type：`SUBPKG_MONITOR` (请求) / `SUBPKG_MONITOR_RESP` (响应)

### 3.2 Action: get_structure（静态数据 — 首次/手动刷新）

**请求**：
```json
{ "action": "get_structure" }
```

**游戏侧响应**：
```json
{
  "type": "SUBPKG_MONITOR_RESP",
  "action": "get_structure",
  "data": {
    "subs": {
      "1": { "name": "必要资源", "resIds": [101, 102, 103] },
      "2": { "name": "角色涂装A", "resIds": [102, 104, 105] }
    },
    "resources": {
      "101": {
        "subIds": [1],
        "files": [
          { "asset": "Assets/Res/Model/xxx.prefab", "name": "a1b2c3d4.dat", "sha1": "abc123...", "size": 1234567 },
          { "asset": "Assets/Res/Texture/yyy.png", "name": "e5f6g7h8.dat", "sha1": "def456...", "size": 234567 }
        ]
      },
      "102": {
        "subIds": [1, 2],
        "files": [...]
      }
    },
    "sharedFiles": {
      "a1b2c3d4.dat": [101, 103],
      "x9y0z1.dat": [102, 104, 105]
    }
  }
}
```

字段说明：
- `subs[id].name`：SubPackage 显示名称（来自 `_Model:GetSubPackageName(id)`）
- `subs[id].resIds`：该 Sub 包含的 ResId 列表
- `resources[id].subIds`：该 Res 所属的 SubId 列表
- `resources[id].files`：文件列表，含 assetPath、物理文件名、sha1、size
- `sharedFiles`：被多个 Res 引用的物理文件名 → ResId 列表（仅包含 `len > 1` 的条目，减少传输量）

### 3.3 Action: get_status（动态数据 — 2s 轮询）

**请求**：
```json
{ "action": "get_status" }
```

**游戏侧响应**：
```json
{
  "type": "SUBPKG_MONITOR_RESP",
  "action": "get_status",
  "data": {
    "subs": {
      "1": { "state": 3, "dlSize": 5242880, "totalSize": 10485760, "progress": 0.5 },
      "2": { "state": 0, "dlSize": 0, "totalSize": 8388608, "progress": 0.0 }
    },
    "resources": {
      "101": { "state": 3, "tgState": 2, "dlSize": 2621440, "totalSize": 5242880, "progress": 0.5 },
      "102": { "state": 1, "tgState": 3, "dlSize": 5242880, "totalSize": 5242880, "progress": 1.0 }
    }
  }
}
```

字段说明：
- `state`：下载状态枚举值
- `tgState`：TaskGroup.State（仅 Resource 层有）
- `dlSize`：已下载字节数
- `totalSize`：总字节数
- `progress`：进度 0.0 ~ 1.0

> 此 payload 不含文件列表和关系数据，保证轮询轻量。

---

## 4. UI 设计

### 4.1 页签注册

- Tab key: `subpkg_monitor`
- Tab label: `分包监控`
- Tab icon: `Package` (lucide-react)
- 无 gridSlider
- Props: `{ clients, selectedClient, broadcastMode, active }`

### 4.2 整体布局

页面分为三个区域：

```
┌─ 工具栏 ─────────────────────────────────────────────────┐
│ [搜索框] [状态过滤▼] [模式: A|B] [自动刷新⟳ 2s] [手动刷新] │
├──────────────────────────────────────────────────────────┤
│ 统计概览栏                                                │
├──────────────────────────────────────────────────────────┤
│ 主内容区（根据模式 A 或 B 渲染）                            │
└──────────────────────────────────────────────────────────┘
```

### 4.3 统计概览栏

一行紧凑的统计卡片，始终可见：

```
┌──────────┬──────────┬────────────┬──────────────┬───────────────┐
│ Sub 总数  │ Res 总数  │ 已完成/总数 │ 下载中       │ 总大小         │
│    20    │    80    │  12 / 20   │  3 个 Sub    │ 2.3 / 8.1 GB  │
└──────────┴──────────┴────────────┴──────────────┴───────────────┘
```

- 使用 glass-card 样式，内部用 flex 布局分列
- 数字用 `font-display` 加大字号，标签用 `font-body` 小字号
- 「已完成」数字使用 `--sage` 色，「下载中」使用 `--sky` 色

### 4.4 模式 A — 双列表 + 详情面板

**整体结构**：左侧列表面板 + 右侧详情面板，中间可拖拽调整宽度。

#### 4.4.1 左侧列表面板

顶部有「Sub 视角 / Res 视角」切换按钮（SegmentedControl 样式），控制列表内容：

**Sub 视角**：

```
┌─ Sub 列表 ──────────────────────┐
│ [Sub 视角 ● | Res 视角 ○]       │
│                                 │
│ ┌─ Sub 1 — 必要资源 ──────────┐ │
│ │ ██████████████████████ 100%  │ │
│ │ State: 已完成  5.2 GB        │ │
│ └──────────────────────────────┘ │
│ ┌─ Sub 2 — 角色涂装A ─────────┐ │
│ │ █████████████░░░░░░░░  62%   │ │
│ │ State: 下载中  1.9 / 3.1 GB  │ │
│ └──────────────────────────────┘ │
│ ┌─ Sub 3 — 语音包JP ──────────┐ │
│ │ ░░░░░░░░░░░░░░░░░░░░   0%   │ │
│ │ State: 未下载  0 / 1.8 GB    │ │
│ └──────────────────────────────┘ │
└─────────────────────────────────┘
```

每行是一个可点击的卡片，包含：
- SubId + 名称
- 进度条（颜色跟随 State）
- State badge + 已下载/总大小
- 选中态：左侧边框高亮 `--caramel`

**Res 视角**：

```
┌─ Res 列表 ──────────────────────┐
│ [Sub 视角 ○ | Res 视角 ●]       │
│                                 │
│ ┌─ Res 101 ───────────────────┐ │
│ │ ██████████████████████ 100%  │ │
│ │ State: 已完成  2.1 GB        │ │
│ └──────────────────────────────┘ │
│ ┌─ Res 102 ───────────────────┐ │
│ │ █████████░░░░░░░░░░░░  45%  │ │
│ │ State: 下载中  800MB  ×2Sub  │ │
│ └──────────────────────────────┘ │
└─────────────────────────────────┘
```

Res 视角卡片额外显示 `×N Sub` badge，表示被 N 个 Sub 引用。

#### 4.4.2 右侧详情面板

根据左侧选中项动态渲染：

**选中 Sub 时**：

```
┌─ 详情：Sub 2 — 角色涂装A ──────────────────────────┐
│                                                    │
│ ── 基本信息 ──                                      │
│ SubId: 2                                           │
│ State: 下载中                                       │
│ Progress: █████████████░░░░░░░  62%                 │
│ Size: 1.9 / 3.1 GB                                 │
│                                                    │
│ ── 包含的 Resource (3) ──                           │
│ ┌──────┬────────┬──────────────┬───────┬──────────┐│
│ │ResId │ State  │ Progress     │ Size  │ 共享     ││
│ ├──────┼────────┼──────────────┼───────┼──────────┤│
│ │ 102  │ 下载中 │ ████░░ 45%   │800 MB │ ×2 Sub ➜ ││
│ │ 104  │ 已完成 │ ██████ 100%  │1.1 GB │          ││
│ │ 105  │ 未下载 │ ░░░░░░ 0%    │1.2 GB │          ││
│ └──────┴────────┴──────────────┴───────┴──────────┘│
│                                                    │
│ ── 文件列表（点击 Res 行展开）──                     │
│ ▾ Res 102 的文件 (15)                              │
│ ┌───────────────────┬──────┬───────────┬──────────┐│
│ │ 物理文件名         │ Size │ sha1      │ 共享     ││
│ ├───────────────────┼──────┼───────────┼──────────┤│
│ │ a1b2c3d4.dat      │12 MB │ abc123... │ ×2 Res ➜ ││
│ │ e5f6g7h8.dat      │ 8 MB │ def456... │          ││
│ │ ...               │      │           │          ││
│ └───────────────────┴──────┴───────────┴──────────┘│
│                                                    │
│ (asset path 以 tooltip 形式显示在文件名 hover 时)     │
└────────────────────────────────────────────────────┘
```

**选中 Res 时**：

```
┌─ 详情：Res 102 ────────────────────────────────────┐
│                                                    │
│ ── 基本信息 ──                                      │
│ ResId: 102                                         │
│ State: 下载中    TaskGroupState: 2                  │
│ Progress: █████████░░░░░░░░░░░  45%                │
│ Size: 800 MB / 1.8 GB                              │
│                                                    │
│ ── 所属 SubPackage (2) ──                          │
│ ┌──────┬─────────────┬────────┬──────────────────┐ │
│ │SubId │ 名称         │ State  │ 跳转             │ │
│ ├──────┼─────────────┼────────┼──────────────────┤ │
│ │  1   │ 必要资源     │ 已完成  │ ➜               │ │
│ │  2   │ 角色涂装A    │ 下载中  │ ➜               │ │
│ └──────┴─────────────┴────────┴──────────────────┘ │
│                                                    │
│ ── 文件列表 (15) ──                                 │
│ ┌───────────────────┬──────┬───────────┬──────────┐│
│ │ 物理文件名         │ Size │ sha1      │ 共享     ││
│ ├───────────────────┼──────┼───────────┼──────────┤│
│ │ a1b2c3d4.dat      │12 MB │ abc123... │ ×2 Res ➜ ││
│ │ e5f6g7h8.dat      │ 8 MB │ def456... │          ││
│ └───────────────────┴──────┴───────────┴──────────┘│
└────────────────────────────────────────────────────┘
```

#### 4.4.3 跳转行为

所有 `➜` 标记处均为可点击跳转：

| 触发位置 | 跳转行为 |
|---------|---------|
| Res 行的 `×N Sub ➜` badge | 切换到 Sub 视角，选中第一个关联 Sub，详情面板高亮该 Res |
| Sub 行的 `➜` | 切换到 Sub 视角，选中该 Sub |
| File 行的 `×N Res ➜` badge | 切换到 Res 视角，选中第一个关联 Res，详情面板高亮该 File |

跳转时目标项有 **0.6s 高亮闪烁动画**（背景色渐变 `--caramel-light` → 透明），并自动滚动到可见区域。

### 4.5 模式 B — 三列联动面板

**整体结构**：三列等宽（可拖拽调整），每列有独立滚动。

```
┌─ Sub 列表 ──────────┬─ Res 列表 ──────────┬─ Files 列表 ─────────────┐
│                      │                     │                          │
│ Sub 1 — 必要资源     │ Res 101 ██████ 100% │  a1b2c3d4.dat   12 MB   │
│ ██████████████ 100%  │  ×1 Sub             │    sha1: abc123...       │
│ 5.2 GB               │                     │    ×2 Res                │
│                      │ Res 102 ████░░  45% │                          │
│ Sub 2 — 角色涂装A    │  ×2 Sub  🔗          │  e5f6g7h8.dat    8 MB   │
│ █████████░░░░  62%   │                     │    sha1: def456...       │
│ 1.9 / 3.1 GB        │ Res 103 ░░░░░░   0% │                          │
│                      │  ×1 Sub             │  (共 15 个文件)           │
│ Sub 3 — 语音包JP     │                     │                          │
│ ░░░░░░░░░░░░   0%   │ (共 3 个 Res)       │                          │
│ 0 / 1.8 GB          │                     │                          │
└──────────────────────┴─────────────────────┴──────────────────────────┘
```

#### 4.5.1 联动逻辑

| 操作 | 效果 |
|------|------|
| 点击 Sub | Res 列表过滤为该 Sub 包含的 Res；Files 列表清空 |
| 点击 Res | Files 列表过滤为该 Res 的文件；Sub 列表中高亮包含该 Res 的所有 Sub |
| 不选 Sub | Res 列表显示全部 Res |
| 不选 Res | Files 列表为空，显示提示 "请选择一个 Resource 查看文件" |
| 点击 Res 的 `×N Sub` badge | Sub 列表滚动并高亮对应的 Sub 项 |
| 点击 File 的 `×N Res` badge | Res 列表滚动并高亮对应的 Res 项 |

#### 4.5.2 筛选态视觉

- 列表处于筛选态时，列标题显示面包屑：`Res 列表 ← Sub 2` + 清除按钮 `×`
- 被联动高亮但非选中的项：背景色 `--info-soft`，左侧边框 `--sky`

### 4.6 模式切换

工具栏中放置一个 SegmentedControl / 图标按钮组：

```
[ 📋 详情模式 | ☰ 三列模式 ]
```

- 图标用 lucide 的 `PanelRight`（模式 A）和 `Columns3`（模式 B）
- 切换时保留当前搜索条件和过滤状态
- 选中状态持久化到 localStorage: `subpkg_monitor_view_mode`
- 切换有短暂 fade 过渡动画

### 4.7 工具栏

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔍 [搜索 SubId / ResId / 文件名...] [状态▼] [A|B] [⟳ 2s ▼] [↻] │
└──────────────────────────────────────────────────────────────────┘
```

| 控件 | 说明 |
|------|------|
| 搜索框 | 模糊匹配 SubId、Sub 名称、ResId、物理文件名。实时过滤，300ms debounce |
| 状态过滤 | 下拉多选：已完成 / 下载中 / 暂停 / 未下载 / 准备中 / 已卸载。默认全选 |
| 模式切换 | 详情模式(A) / 三列模式(B) |
| 自动刷新 | 开关 + 间隔下拉（1s / 2s / 5s / 10s），默认开启 2s。仅轮询 `get_status` |
| 手动刷新 | 点击立即执行一次 `get_status`；长按（或 Shift+点击）执行 `get_structure`（全量刷新结构） |

### 4.8 进度条设计

```css
/* 进度条容器 */
height: 6px;
border-radius: 3px;
background: var(--cream-warm);

/* 进度条填充 — 颜色跟随 State */
NOT_DOWNLOAD:     background: var(--coffee-muted);    /* 灰 — 无进度 */
DOWNLOADING:      background: linear-gradient(90deg, var(--sky) 0%, var(--sky-soft) 100%);
                  + shimmer 动画（微光从左到右流动）
PAUSE:            background: var(--amber);
COMPLETE:         background: var(--sage);
PREPARE_DOWNLOAD: background: var(--caramel);  + pulse 动画
UNINSTALLED:      background: var(--coffee-light);
```

进度文字显示在进度条右侧，格式：`62%`（state 为 COMPLETE 时显示 `✓`）。

### 4.9 共享 Badge 设计

```
×2 Sub  或  ×3 Res
```

- 使用 `badge` 基础样式 + 自定义背景色 `--info-soft`
- 有关联可跳转时右侧显示 `➜` 图标，hover 变为 `--sky` 色 + cursor pointer
- 仅当引用数 > 1 时显示（`×1` 不显示 badge）

### 4.10 空状态与加载

| 场景 | 展示 |
|------|------|
| 未选择客户端 | 居中图标 + "请选择客户端" |
| 等待首次数据 | 骨架屏（skeleton）占位 |
| 结构数据为空 | 居中 "暂无分包数据" |
| WebSocket 断连 | 顶部 warning bar "连接断开，正在重连..." |

### 4.11 尺寸与大小格式化

所有 size 字段在前端统一格式化显示：

| 范围 | 格式 |
|------|------|
| < 1 KB | `{n} B` |
| < 1 MB | `{n} KB` |
| < 1 GB | `{n} MB` |
| >= 1 GB | `{n.nn} GB` |

保留最多 2 位小数。

---

## 5. 刷新机制

### 5.1 数据分层刷新

| 数据类型 | 触发方式 | 内容 |
|---------|---------|------|
| 结构数据 | 页签首次激活 + 手动全量刷新 | Sub/Res 列表、文件列表、关系映射 |
| 状态数据 | 自动轮询（默认 2s）+ 手动刷新 | State、Progress、DownloadSize、TotalSize |

### 5.2 轮询实现

- 使用 `setInterval` + `fetch` 模式（非 WebSocket 推送），与现有 CsMonitor 的 `autoRefresh` 一致
- 请求：`POST /api/gm_console/subpkg_monitor/{client_id}/command` → `{ action: "get_status" }`
- 响应：通过 WebSocket `/ws/subpkg_monitor` 回传
- 页签非激活状态（`active === false`）时暂停轮询，切回时立即恢复
- 每次响应后更新状态数据并合并到已有的结构数据中

### 5.3 数据合并策略

前端维护两块 state：

```javascript
const [structure, setStructure] = useState(null)   // get_structure 返回的完整结构
const [status, setStatus] = useState(null)          // get_status 返回的动态状态
```

渲染时合并：对于任意 Sub/Res 项，从 `structure` 取结构信息（名称、关系、文件），从 `status` 取动态信息（state、progress、size）。不做深拷贝合并，避免性能问题。

---

## 6. 文件结构

### 6.1 新增文件

| 文件 | 说明 |
|------|------|
| `frontend/src/pages/SubPackageMonitor.jsx` | 前端页签组件 |
| `frontend/src/pages/SubPackageMonitor.css` | 页签专用样式（如有需要，否则纯 Tailwind） |

### 6.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `frontend/src/pages/GmConsole.jsx` | 导入组件 + TAB_META 新增条目 + 渲染区域新增 |
| `tools/gm_console/main.py` | 新增 WebSocket 端点 + HTTP 端点 + broadcast 函数 + callback 注册 |
| `tools/gm_console/server_mgr.py` | 新增 `SUBPKG_MONITOR_RESP` packet 分发 + `send_subpkg_monitor_request` 方法 |

### 6.3 游戏侧新增（参考实现，由游戏侧适配）

需在 `RuntimeGMClient` 或等效模块中新增对 `SUBPKG_MONITOR` packet 的处理，收集数据并回传。

---

## 7. 后端接口设计

### 7.1 HTTP 端点

```python
@app.post("/subpkg_monitor/{client_id}/command")
async def subpkg_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_subpkg_monitor_request(client_id, action, body)
    return {"status": "requested"}
```

### 7.2 WebSocket 端点

```python
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

### 7.3 ServerMgr 扩展

```python
# _process_packet 新增分支
elif t == "SUBPKG_MONITOR_RESP":
    if self.on_subpkg_monitor_data:
        self.on_subpkg_monitor_data(cid, pkt)

# 新增发送方法
async def send_subpkg_monitor_request(self, client_id, action, params):
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

### 7.4 Callback 注册

```python
# main.py lifespan 中
def on_subpkg_monitor_data(client_id, pkt):
    asyncio.create_task(broadcast_subpkg_monitor_event({
        "type": pkt.get("action", "unknown"),
        "client_id": client_id,
        "data": pkt.get("data", {})
    }))
server_mgr.on_subpkg_monitor_data = on_subpkg_monitor_data
```

---

## 8. 游戏侧 Lua 代码设计（参考实现）

在 `RuntimeGMClient.ProcessPacket` 中新增 `SUBPKG_MONITOR` 处理：

### 8.1 get_structure

```lua
elseif type == "SUBPKG_MONITOR" then
    local action = packet.action
    if action == "get_structure" then
        local agency = XMVCA.XSubPackage
        local subIndexInfo = agency:GetSubIndexInfo()
        local resDict, subDict = agency:GetAllResAndSubpackageItemDic()

        -- 构建 subs
        local subs = {}
        for subId, subItem in pairs(subDict) do
            local template = agency:GetSubpackageTemplate(subId)
            subs[tostring(subId)] = {
                name = template and template.Name or ("Sub_" .. subId),
                resIds = template and template.ResIds or {}
            }
        end

        -- 构建 resources + sharedFiles
        local resources = {}
        local fileRefCount = {}  -- fileName -> {resId1, resId2, ...}

        for resId, indexInfo in pairs(subIndexInfo) do
            local files = {}
            local subIds = agency._Model:GetSubpackageIdByResId(resId) or {}

            for assetPath, info in pairs(indexInfo) do
                local fileName = info[1]
                files[#files + 1] = {
                    asset = assetPath,
                    name = fileName,
                    sha1 = info[2],
                    size = info[3]
                }
                -- 统计文件引用
                if not fileRefCount[fileName] then
                    fileRefCount[fileName] = {}
                end
                local exists = false
                for _, rid in ipairs(fileRefCount[fileName]) do
                    if rid == resId then exists = true; break end
                end
                if not exists then
                    table.insert(fileRefCount[fileName], resId)
                end
            end

            resources[tostring(resId)] = {
                subIds = subIds,
                files = files
            }
        end

        -- 仅保留共享文件（引用数 > 1）
        local sharedFiles = {}
        for fileName, resIds in pairs(fileRefCount) do
            if #resIds > 1 then
                sharedFiles[fileName] = resIds
            end
        end

        RuntimeGMClient.Send({
            type = "SUBPKG_MONITOR_RESP",
            action = "get_structure",
            data = { subs = subs, resources = resources, sharedFiles = sharedFiles }
        })
    end
```

### 8.2 get_status

```lua
    elseif action == "get_status" then
        local agency = XMVCA.XSubPackage
        local resDict, subDict = agency:GetAllResAndSubpackageItemDic()

        local subsStatus = {}
        for subId, subItem in pairs(subDict) do
            subsStatus[tostring(subId)] = {
                state = subItem:GetState(),
                dlSize = subItem:GetDownloadSize(),
                totalSize = subItem:GetTotalSize(),
                progress = subItem:GetProgress()
            }
        end

        local resStatus = {}
        for resId, resItem in pairs(resDict) do
            resStatus[tostring(resId)] = {
                state = resItem:GetState(),
                tgState = resItem:GetTaskGroup() and resItem:GetTaskGroup().State or -1,
                dlSize = resItem:GetDownloadSize(),
                totalSize = resItem:GetTotalSize(),
                progress = resItem:GetProgress()
            }
        end

        RuntimeGMClient.Send({
            type = "SUBPKG_MONITOR_RESP",
            action = "get_status",
            data = { subs = subsStatus, resources = resStatus }
        })
    end
```

> 注：以上为参考实现骨架，需根据游戏侧实际 API 和 RuntimeGMClient 接口适配调整。

---

## 9. 前端组件设计

### 9.1 组件树

```
SubPackageMonitor (主组件)
├── SubPkgToolbar                    # 工具栏：搜索、过滤、模式切换、刷新控件
├── SubPkgOverview                   # 统计概览栏
├── SubPkgDetailView (模式 A)        # 双列表 + 详情面板
│   ├── SubPkgItemList               # 左侧列表（Sub/Res 切换）
│   │   └── SubPkgItemCard           # 单个 Sub/Res 卡片
│   └── SubPkgDetailPanel            # 右侧详情面板
│       ├── SubPkgInfoSection        # 基本信息区
│       ├── SubPkgRelationTable      # 关联项表格（Sub的Res / Res的Sub）
│       └── SubPkgFileTable          # 文件列表表格
└── SubPkgColumnView (模式 B)        # 三列联动面板
    ├── SubPkgSubColumn              # Sub 列
    ├── SubPkgResColumn              # Res 列
    └── SubPkgFileColumn             # File 列
```

### 9.2 核心 State

```javascript
// 数据
const [structure, setStructure] = useState(null)       // 静态结构数据
const [status, setStatus] = useState(null)             // 动态状态数据

// UI 状态
const [viewMode, setViewMode] = useState('detail')     // 'detail' | 'columns'
const [perspective, setPerspective] = useState('sub')   // 模式A: 'sub' | 'res'
const [selectedId, setSelectedId] = useState(null)      // 当前选中的 Sub/Res Id
const [expandedRes, setExpandedRes] = useState(null)    // 模式A详情中展开文件列表的 ResId
const [searchQuery, setSearchQuery] = useState('')
const [stateFilter, setStateFilter] = useState(new Set([0,1,2,3,4,5]))  // 全选

// 模式B
const [selectedSub, setSelectedSub] = useState(null)
const [selectedRes, setSelectedRes] = useState(null)

// 刷新
const [autoRefresh, setAutoRefresh] = useState(true)
const [refreshInterval, setRefreshInterval] = useState(2)

// WebSocket
const [wsStatus, setWsStatus] = useState('disconnected')
```

### 9.3 localStorage 持久化

| Key | 内容 |
|-----|------|
| `subpkg_monitor_view_mode` | `'detail'` \| `'columns'` |
| `subpkg_monitor_perspective` | `'sub'` \| `'res'` |
| `subpkg_monitor_refresh_interval` | number (秒) |
| `subpkg_monitor_auto_refresh` | boolean |
| `subpkg_monitor_left_width` | number (px, 模式 A 左侧面板宽度) |

### 9.4 关键交互细节

#### 搜索

- 输入框实时搜索，300ms debounce
- 搜索范围：SubId、Sub 名称、ResId、物理文件名
- 匹配逻辑：
  - 模式 A Sub 视角：匹配 Sub 自身属性 + 其包含的任意 Res/File
  - 模式 A Res 视角：匹配 Res 自身属性 + 其包含的任意 File
  - 模式 B：三列分别过滤，但保留联动关系
- 匹配高亮：命中关键字的文本片段用 `<mark>` 标签高亮

#### 跳转动画

```javascript
// 跳转目标项的高亮动画
const HIGHLIGHT_DURATION = 600 // ms

function scrollToAndHighlight(listRef, itemId) {
    const el = listRef.current?.querySelector(`[data-id="${itemId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    el.classList.add('highlight-flash')
    setTimeout(() => el.classList.remove('highlight-flash'), HIGHLIGHT_DURATION)
}
```

```css
.highlight-flash {
    animation: highlightFlash 0.6s ease;
}

@keyframes highlightFlash {
    0%   { background-color: var(--caramel-light); }
    100% { background-color: transparent; }
}
```

---

## 10. 设计决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 视图模式 | 单一视图 / 双模式切换 | 双模式 (A+B) | 用户需要两种查看维度 |
| 数据拉取 | WebSocket 推送 / HTTP 轮询 | 请求-响应（HTTP 发 + WS 回） | 与现有页签一致 |
| 刷新分层 | 全量刷新 / 结构+状态分层 | 分层 | 性能考虑，静态数据不需频繁刷 |
| Group 层级 | 展示 / 不展示 | 不展示 | 用户明确不需要 |
| 操作按钮 | 提供下载/暂停 / 只读 | 只读 | 用户明确只需监控 |
| 多对多展示 | 树形 / 双视角 / 三列联动 | 双视角 + 三列联动 | 树形会掩盖共享关系 |

---

## 附录 A：色彩映射速查

| State | 进度条色 | Badge 背景 | Badge 文字 |
|-------|---------|-----------|-----------|
| 未下载 | `--coffee-muted` | `rgba(168,155,145,0.15)` | `--coffee-muted` |
| 已完成 | `--sage` | `--success-soft` | `--sage` |
| 已暂停 | `--amber` | `--warning-soft` | `--amber` |
| 下载中 | `--sky` | `--info-soft` | `--sky` |
| 准备中 | `--caramel` | `rgba(212,165,116,0.15)` | `--caramel` |
| 已卸载 | `--coffee-light` | `rgba(139,125,114,0.15)` | `--coffee-light` |
