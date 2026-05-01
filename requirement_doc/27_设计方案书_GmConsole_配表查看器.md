# 设计方案书：GM Console — 配表查看器 (Table Viewer)

> 文档编号：27
> 日期：2026-04-30
> 状态：待评审

---

## 1. 概述

### 1.1 目标

在 GM Console 中新增「配表查看器」页签，让开发 / QA 人员在运行时直接查看游戏已加载的配表（XTable）数据，包括：表列表、字段定义、行数据浏览、搜索过滤，以及可选的运行时统计信息。

### 1.2 使用场景

| 角色 | 典型场景 |
|------|---------|
| 策划 / 配表人员 | 热更配表后，在真机上直接验证某行数据是否生效，不用再去翻日志或加 print |
| 客户端开发 | 排查 bug 时快速确认某个 Id 在运行时的配表值是什么、字段类型是否正确 |
| QA | 验证特定条件下配表数据是否符合预期（如活动表时间、道具表数值） |

### 1.3 核心需求

1. **表列表**：枚举所有可用的 XTable 定义，显示字段数量
2. **Schema 查看**：选中表后查看字段名、类型（int/string/bool/float/fix）、是否主键、是否 List/Dict
3. **行数据浏览**：加载表的实际运行时数据，以表格形式展示（支持分页）
4. **搜索 / 过滤**：在表列表中按名称搜索；在行数据中按任意字段值搜索
5. **运行时统计（可选）**：当 `HaruPerformanceMonitor` 可用时（仅 debug 包），显示表的加载状态、行数、内存占用、归属模块等信息

### 1.4 关键约束

- **只读**：不提供修改配表数据的功能
- **分页必须**：大表可能上万行，Lua 侧 JSON 序列化 + TCP 传输不能一次性全量。每页默认 50 行
- **加载模式兼容**：需同时兼容 Tab 模式（Editor）和 Bytes 模式（打包/真机），通过统一的 `XTableManager` API 访问
- **UI 风格**：沿用项目 Golden Hour 色系 + glass-card 设计系统

### 1.5 HaruPerformanceMonitor 可用性说明

调研结论：`HaruPerformanceMonitor` 的 Binary Config Monitor 功能**仅在 debug/开发包中可用**。

| 条件 | 说明 |
|------|------|
| 编译宏 `PERFORMANCE_MONITOR_ENABLE` | 需手动在 Unity Editor 的 Performance Monitor Window 中开启 |
| 编译宏 `BINARY_CONFIG_MONITOR_ENABLE` | 同上，需显式勾选 Binary Config Monitor |
| WRITE 方法 | 使用 `[Conditional]`，release 包中调用被编译器擦除 |
| READ 方法 | 无 `[Conditional]`，但依赖运行时 `BinaryConfigMonitor` 实例，release 包中该实例不会被创建 |
| `IsBinaryConfigMonitorEnabled()` | release 包返回 `false` |

**设计策略**：将 PerformanceMonitor 数据作为**可选增强层**。Lua 端在初始化时探测 `CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor.IsBinaryConfigMonitorReady()` 是否可用，可用时附加统计数据到响应中。前端根据响应中是否包含统计字段来决定是否渲染统计面板。

---

## 2. 数据模型

### 2.1 数据源架构

```
XTable (Lua 全局)                   ← Schema 定义（字段名、类型、主键）
    ↓
XTableManager.ReadAllByIntKey()     ← 行数据（通过 Tab/Bytes/Pack loader）
    ↓
CS.XTableManager.GetPaths()         ← 枚举磁盘上的 .tab 文件路径
    ↓
HaruPerformanceMonitor (可选)       ← 运行时统计（加载状态、内存、行数）
```

### 2.2 XTable Schema 格式

`XTable` 是 Lua 全局变量，结构为 `{ TableName = { FieldName = descriptor, ... }, ... }`。

字段描述符 (descriptor)：

| 属性 | 类型 | 说明 |
|------|------|------|
| `ValueType` | string | 字段值类型：`"int"` / `"string"` / `"bool"` / `"float"` / `"fix"` |
| `PrimaryKey` | bool? | 存在且为 `true` 时标记该字段为主键 |
| `Type` | int? | `1` = List，`2` = Dictionary。不存在时为标量 |
| `KeyType` | string? | 仅 `Type=2` 时存在，Dict 的 key 类型 |

示例：
```lua
XTable.XTableItem = {
    Id = { ValueType = "int", PrimaryKey = true },
    Name = { ValueType = "string" },
    Tags = { Type = 1, ValueType = "string" },         -- List<string>
    Attrs = { Type = 2, KeyType = "int", ValueType = "float" }  -- Dict<int, float>
}
```

### 2.3 行数据格式

通过 `XTableManager.ReadAllByIntKey(path, XTable.XTableXxx, primaryKeyField)` 获取，返回 `{ id → row }` 字典。每行 (row) 是一个 Lua table，字段通过 metatable 支持命名访问（`row.FieldName`）。

对于 Table Viewer，Lua 侧需将行数据序列化为纯 table 后传输：

```lua
-- 单行序列化示例
{ Id = 1001, Name = "铁剑", Tags = {"武器", "一星"}, Attrs = {[1] = 10.5, [2] = 3.2} }
```

### 2.4 PerformanceMonitor 统计数据（可选）

当 `IsBinaryConfigMonitorReady()` 返回 `true` 时，可通过以下 C# API 获取统计：

| API | 返回 | 说明 |
|-----|------|------|
| `GetAllConfigNames(sourceType)` | `IReadOnlyCollection<string>` | 所有已加载的表路径 |
| `GetRows(sourceType, name)` | `int` | 表的总行数 |
| `GetReadRows(sourceType, name)` | `int` | 已反序列化的行数 |
| `GetTotalSize(sourceType, name)` | `int` | 总内存占用 (bytes) |
| `GetBinarySize(sourceType, name)` | `int` | 原始二进制大小 |
| `GetModule(sourceType, name)` | `string` | 归属模块名 |
| `GetTabScope(sourceType, name)` | `string` | 缓存作用域 |

`sourceType`：`0` = Lua 侧加载，`1` = C# 侧加载。

---

## 3. 交互设计

### 3.1 整体布局

```
┌─ 工具栏 ─────────────────────────────────────────────────────────────────┐
│ 🔍 [搜索表名...]  [仅已加载 ☐]  [Stats ☐]              [↻ 刷新表列表]   │
├──────────────────┬───────────────────────────────────────────────────────┤
│                  │ ┌─ Schema 栏 ───────────────────────────────────────┐ │
│                  │ │ XTableItem (12 fields)           [加载数据 ▶]     │ │
│   表列表          │ │ ┌────────┬────────┬──────┬──────┐               │ │
│   (侧栏)         │ │ │ Field  │ Type   │ Key  │ Coll │               │ │
│                  │ │ ├────────┼────────┼──────┼──────┤               │ │
│  ┌────────────┐  │ │ │ Id     │ int    │  ✦   │      │               │ │
│  │■ Character │  │ │ │ Name   │ string │      │      │               │ │
│  │  Equip     │  │ │ │ Tags   │ string │      │ List │               │ │
│  │  Fashion   │  │ │ │ Attrs  │ float  │      │ Dict │               │ │
│  │  Fuben     │  │ │ └────────┴────────┴──────┴──────┘               │ │
│  │  Item ←    │  │ ├─ 行数据表格 ──────────────────────────────────────┤ │
│  │  ...       │  │ │ 🔍 [搜索字段值...]  共 2,340 行  页 1/47  [< >]  │ │
│  │  (共 326)  │  │ │ ┌────┬──────┬────────┬───────────┐              │ │
│  └────────────┘  │ │ │ Id │ Name │ Tags   │ Attrs     │              │ │
│                  │ │ ├────┼──────┼────────┼───────────┤              │ │
│                  │ │ │1001│ 铁剑 │ 武器,… │ {1:10.5,…}│              │ │
│                  │ │ │1002│ 钢盾 │ 防具,… │ {1:5.0,…} │              │ │
│                  │ │ │... │ ...  │ ...    │ ...       │              │ │
│                  │ │ └────┴──────┴────────┴───────────┘              │ │
│                  │ └──────────────────────────────────────────────────┘ │
└──────────────────┴───────────────────────────────────────────────────────┘
```

### 3.2 表列表侧栏

#### 布局

- 固定宽度 240px，可拖拽调整（最小 180px，最大 400px），宽度持久化到 localStorage
- 顶部搜索框 + 底部统计（"共 326 个表"）
- 表项按字母顺序排列，选中态左侧边框 `--caramel`

#### 表项显示

```
┌─ XTableItem ────────────┐
│ 12 fields               │  ← 字段数
│ ● loaded  2,340 rows    │  ← 仅 Stats 模式，加载状态 + 行数
└─────────────────────────┘
```

- 表名去掉 `XTable` 前缀显示（如 `XTableItem` → `Item`），hover tooltip 显示完整名
- 字段数始终显示
- 加载状态和行数仅在 Stats 模式开启 + PerformanceMonitor 可用时显示：
  - `● loaded` — 绿色点，已加载
  - `○ not loaded` — 灰色空心圆，未加载
  - 行数为 `GetRows()` 返回值

#### 搜索（参考 PlayerPrefsViewer 的搜索交互）

搜索框采用 **收藏 + 最近访问** 的友好搜索模式：

- 300ms debounce，大小写不敏感，模糊匹配表名
- 匹配关键字用 `<mark>` 高亮

**Focus 下拉面板**：
- 搜索框获得焦点时展开下拉面板，合并显示收藏表 + 最近访问表
- 收藏表排在最前，带 `★` 图标；最近访问表带 `recent` 标签
- 点击下拉项直接选中该表（等同于在列表中点击）
- 点击外部关闭下拉

**收藏**：
- 每个表项右侧有收藏星标按钮（hover 时显示，已收藏时常驻）
- 点击切换收藏/取消收藏
- 收藏列表持久化到 localStorage: `table_monitor_favorites`

**最近访问**：
- 每次选中表或加载数据时，自动记录到最近访问列表（MRU 顺序，最多 20 条）
- 持久化到 localStorage: `table_monitor_recents`
- 与收藏去重：下拉面板中同一个表只出现一次，收藏优先

#### "仅已加载" 过滤

- 开关（checkbox），默认关闭
- 开启后仅显示 PerformanceMonitor 报告为已加载的表
- 当 PerformanceMonitor 不可用时此开关禁用并 tooltip 提示 "需要 debug 包"

### 3.3 Schema 面板

#### 布局

- 占据右侧区域的上半部分
- 标题行：表名（全称） + 字段数 + [加载数据] 按钮

#### Schema 表格

| 列 | 内容 | 宽度 |
|----|------|------|
| Field | 字段名 | flex |
| Type | 值类型（int/string/bool/float/fix） | 80px |
| Key | 主键标记 `✦`（仅主键字段显示，表示该字段是表的索引键） | 40px |
| Collection | 集合类型标记：`List` / `Dict<K>` / 空 | 90px |

- 主键行背景色 `--cream-warm`，轻微区分
- 列头 tooltip：Key 列 hover 显示 "Primary Key — 该字段是表的唯一索引键"
- 类型列用 monospace 字体
- Dict 类型在 Collection 列显示 `Dict<int>` 或 `Dict<string>` 标注 KeyType

### 3.4 行数据表格

#### 加载触发

- 用户点击 [加载数据 ▶] 按钮后才发起数据请求（避免选中表就自动加载大表）
- 加载时按钮变为 spinner + "加载中..."
- 加载完成后按钮变为 [重新加载 ↻]

#### 表格布局

- 占据右侧区域的下半部分（Schema 与行数据之间可拖拽调整比例）
- 列头 = Schema 中的字段名，列顺序与 Schema 一致（主键列固定在最左）
- 列宽自适应内容，最小 60px，可拖拽调整

#### 单元格渲染

| 数据类型 | 渲染方式 |
|---------|---------|
| int / float / fix | 右对齐，monospace 字体 |
| string | 左对齐，超长截断 + tooltip 显示全文 |
| bool | `✓` (true) / `✗` (false)，居中 |
| List | 逗号分隔，如 `武器, 一星`。超过 3 项显示 `武器, 一星, ...+2`，tooltip 显示全部 |
| Dict | `{k:v, k:v}`，超过 3 项截断。tooltip 显示全部 |
| nil / 空 | 灰色 `—` |

#### 分页

```
共 2,340 行  页 1 / 47  [◀ 上一页] [▶ 下一页]  每页 [50 ▼]
```

- 每页行数可选：20 / 50 / 100（默认 50）
- 分页在 **Lua 侧** 执行（读取全量后截取 offset+limit），避免反复磁盘读取
- 持久化 `每页行数` 到 localStorage

#### 行数据搜索

- 搜索框位于行数据表格的工具栏
- 300ms debounce
- 搜索在 **Lua 侧** 执行：遍历所有行的所有字段，`tostring(value)` 后模糊匹配
- 搜索时返回匹配的行 + 总匹配数，仍支持分页
- 输入搜索词后分页重置到第 1 页
- 清空搜索框恢复全量分页浏览

#### 列点击排序

- 点击列头切换排序：无 → 升序 ↑ → 降序 ↓ → 无
- 排序在 **Lua 侧** 执行（`table.sort` by field value）
- 排序后分页重置到第 1 页

#### 行选中与详情

- 点击行高亮选中
- 选中行在表格下方展开一个详情卡片，以 key-value 形式完整展示该行所有字段（不截断），方便复制长文本

### 3.5 Stats 面板（可选增强）

#### 触发

- 工具栏中的 [Stats] 开关控制
- 当 PerformanceMonitor 不可用时自动隐藏此开关

#### 布局

选中表后，在 Schema 面板上方显示一行统计卡片：

```
┌──────────┬────────────┬──────────┬───────────┬──────────┬────────────┐
│ 状态      │ 总行数      │ 已读行数  │ 内存占用   │ 归属模块  │ 缓存作用域  │
│ ● Loaded │    2,340   │    156   │  1.2 MB   │ XItem    │ Normal     │
└──────────┴────────────┴──────────┴───────────┴──────────┴────────────┘
```

- 卡片使用 glass-card 样式
- "已读行数" < "总行数" 时用 `--caramel` 色标注（表示部分懒加载）
- 内存占用格式化（KB/MB）

#### 全局统计视图

当未选中任何表时，右侧主区域显示全局统计概览：

```
┌─────────────────────────────────────────────────────────┐
│              配表运行时统计 (PerformanceMonitor)          │
│                                                         │
│  ┌──────────┬──────────┬──────────┬──────────────────┐  │
│  │ Lua 表数  │ C# 表数  │ 总内存    │ 总行数           │  │
│  │   186    │   42     │  28.3 MB │  124,560         │  │
│  └──────────┴──────────┴──────────┴──────────────────┘  │
│                                                         │
│  Top 10 内存占用：                                       │
│  ┌───────────────────┬──────────┬────────┬────────────┐ │
│  │ 表名               │ 内存     │ 行数    │ 已读行数   │ │
│  ├───────────────────┼──────────┼────────┼────────────┤ │
│  │ Item               │ 4.2 MB  │ 8,320  │ 342        │ │
│  │ Skill              │ 3.1 MB  │ 5,100  │ 5,100      │ │
│  │ CharacterLevel     │ 2.8 MB  │ 12,000 │ 600        │ │
│  │ ...                │ ...     │ ...    │ ...        │ │
│  └───────────────────┴──────────┴────────┴────────────┘ │
│                                                         │
│  (点击表名跳转到该表)                                     │
└─────────────────────────────────────────────────────────┘
```

- Top 10 按内存占用降序
- 当 PerformanceMonitor 不可用时，显示提示："运行时统计需要 debug 包（编译宏 PERFORMANCE_MONITOR_ENABLE + BINARY_CONFIG_MONITOR_ENABLE）。当前仅支持浏览表定义和数据。"

### 3.6 激活 / 零开销机制（参考 AV Monitor）

Table Viewer 采用与 AV Monitor 相同的三层开关模式，确保页签不活跃时游戏侧零开销：

#### Lua 侧：_isActive + 自动超时

```lua
LuaTableMonitor._isActive = false          -- 默认关闭
LuaTableMonitor._lastActivateTime = 0
LuaTableMonitor._activeTimeout = 30        -- 30 秒无命令自动休眠
```

- `HandleCommand` 入口：任何命令到达时刷新 `_lastActivateTime`，设置 `_isActive = true`
- 无 Update 轮询：Table Viewer 不需要 per-frame 推送（不像 AV Monitor 有视频帧），所有数据都是请求-响应模式
- `_isActive` 的意义：控制是否保持 `_dataCache`（当前加载的表数据缓存）。超时后自动释放缓存，释放内存
- 超时检测：挂在 RuntimeGMClient 的 Update 中，仅一个 boolean 检查 + 时间比较

```lua
-- 在 RuntimeGMClient.Update 中
if LuaTableMonitor._isActive then
    local now = CS.UnityEngine.Time.realtimeSinceStartup
    if now - LuaTableMonitor._lastActivateTime > LuaTableMonitor._activeTimeout then
        LuaTableMonitor._isActive = false
        LuaTableMonitor._dataCache = nil  -- 释放表数据缓存
    end
end
```

#### 前端侧：active prop + start/stop

- `active` prop 为 `false`（用户切换到其他页签）时：
  - 发送 `{ action: "stop" }` 到 Lua 端
  - 断开 `/ws/table_monitor` WebSocket
  - 停止一切网络请求
- `active` 变为 `true` 时：
  - 建立 WebSocket 连接
  - 发送 `{ action: "start" }` 激活 Lua 端
  - 如果之前已有表列表数据，恢复上次状态；否则请求 `list_tables`

#### 开销对比

| 状态 | 游戏侧开销 |
|------|-----------|
| 页签未打开 / 不活跃 | 零（`_isActive = false`，无任何检查，不存在于 Update） |
| 页签活跃但未操作 | 接近零（Update 中一个 boolean + 时间比较） |
| 用户浏览表列表 / Schema | 仅响应请求时有瞬时开销（遍历 XTable keys / 读取字段定义） |
| 用户加载行数据 | 一次性开销（ReadAll + 缓存），后续翻页/搜索/排序从缓存读取 |

### 3.7 HaruPerformanceMonitor 交互设计

#### 可用性分层

| PerformanceMonitor 状态 | 前端表现 |
|------------------------|---------|
| **不可用**（release 包 / 未开编译宏） | 表列表仅显示表名 + 字段数；无 Stats 开关；无「仅已加载」过滤；行数据浏览完全可用 |
| **可用**（debug 包 + 编译宏已开） | 表列表附加加载状态徽章 + 行数；Stats 开关可用；「仅已加载」过滤可用；全局统计概览可用 |

交互上不是"只有一个筛选按钮"，而是整体 UI 会根据可用性动态丰富：

**不可用时**（基础模式）：

```
┌─ 工具栏 ────────────────────────────────────────────┐
│ 🔍 [搜索表名...]                    [↻ 刷新表列表]   │
├──────────────────┬──────────────────────────────────┤
│ 表列表            │ Schema + 行数据                   │
│                  │                                   │
│ Item        12f  │  (完整的 Schema + 数据浏览功能)     │
│ Character    8f  │                                   │
│ Equip       15f  │                                   │
└──────────────────┴──────────────────────────────────┘
```

**可用时**（增强模式）：

```
┌─ 工具栏 ────────────────────────────────────────────────────┐
│ 🔍 [搜索表名...]  [仅已加载 ☐]  [Stats ☐]  [↻ 刷新表列表]   │
├──────────────────┬──────────────────────────────────────────┤
│ 表列表            │ ┌─ Stats 卡片 ─────────────────────────┐│
│                  │ │ ● Loaded │ 2340行 │ 156已读 │ 1.2MB  ││
│ ● Item    12f    │ ├─ Schema ──────────────────────────────┤│
│   2340 rows      │ │ ...                                   ││
│ ○ Char     8f    │ ├─ 行数据 ──────────────────────────────┤│
│   not loaded     │ │ ...                                   ││
│ ● Equip   15f    │ └───────────────────────────────────────┘│
└──────────────────┴──────────────────────────────────────────┘
```

#### 关键增强能力

Stats 可用时提供的额外信息：

| 信息 | 说明 | 对开发的价值 |
|------|------|-------------|
| **已读行数 vs 总行数** | `GetReadRows` / `GetRows` | 体现懒加载效果：如 8320 行的 Item 表只反序列化了 342 行，说明 BinaryTable 懒加载生效 |
| **内存占用** | `GetTotalSize` | 快速定位内存大户 |
| **归属模块** | `GetModule` | 知道哪个业务模块加载了这张表 |
| **缓存作用域** | `GetTabScope` | Normal/Private/Temp/Preload — 了解表的生命周期管理 |
| **全局 Top10 排行** | 汇总所有已加载表 | 内存优化的切入点 |

#### 副作用隔离 — "我们的读取会不会污染 Monitor 数据？"

**会。** `XTableManager.ReadAllByIntKey` 走的是与游戏业务代码相同的加载路径，如果目标表此前未被游戏加载过，我们的查看操作会导致：
1. BinaryTable handle 被创建并缓存到 `AllTables`
2. 行数据被反序列化
3. PerformanceMonitor 记录到 `OnLoadBinary` / `UpdateBinaryRows` 等事件

**应对策略**：

1. **标记隔离**：在 `get_data` 的响应中附加 `loadedByViewer: true` 标记，表示该表是由 Table Viewer 触发加载的（而非游戏自身逻辑）。前端在 Stats 面板中用特殊样式标注：

   ```
   ● Item  2340 rows  1.2MB          ← 游戏自身加载，正常显示
   ◆ Skill  5100 rows  3.1MB  [👁]    ← 被 Viewer 加载，显示眼睛图标
   ```

   `◆` 菱形 + `[👁]` 图标表示 "此表是因为你在 Table Viewer 中查看而被加载的"，与游戏自身加载的表视觉区分。

2. **缓存释放**：当用户切换到另一个表时，Lua 侧释放前一个 Viewer 加载的表缓存（`_dataCache = nil`），但注意 **不主动释放 AllTables 中的 BinaryTable handle**，因为无法确定游戏侧是否也在使用。仅释放 Viewer 自己持有的二次缓存。

3. **只读统计提示**：Stats 面板顶部添加说明文字："统计数据来自 HaruPerformanceMonitor，包含游戏侧 + Viewer 侧的加载。标记 ◆ 的表为 Viewer 触发加载。"

4. **Viewer 前的快照比较**（进阶，可选 v2）：在用户首次点击 [加载数据] 前，先查一次 `GetReadRows`，加载后再查一次。如果之前是 0（未加载）而现在有值，标记为 Viewer 触发。

### 3.8 交互流程总结

```
用户切换到 Table Viewer 页签
  │
  ├─ 前端建立 WebSocket，发送 { action: "start" }
  ├─ Lua 端 _isActive = true，开始接受命令
  ├─ 前端请求 list_tables → 返回所有表名 + 字段数 + 可选统计
  │
  ├─ 用户在侧栏搜索/滚动/从收藏下拉选择，选中一个表
  │   │
  │   ├─ 自动请求 get_schema → 显示字段定义
  │   ├─ 如 Stats 可用 → 显示统计卡片（标注是否 Viewer 加载）
  │   │
  │   └─ 用户点击 [加载数据]
  │       │
  │       ├─ 请求 get_data (page=1, pageSize=50) → 显示行数据表格
  │       │
  │       ├─ 用户翻页 → 请求 get_data (page=N)（从 Lua 缓存读取，无磁盘 IO）
  │       ├─ 用户搜索 → 请求 get_data (page=1, search="xxx")
  │       ├─ 用户排序 → 请求 get_data (page=1, sortField="Name", sortDir="asc")
  │       └─ 用户点击行 → 展开行详情卡片
  │
  ├─ 用户选中另一个表 → 释放前一个表缓存，重复上述流程
  │
  └─ 用户切换到其他页签
      ├─ 前端发送 { action: "stop" }
      ├─ 断开 WebSocket
      └─ Lua 端释放 _dataCache，_isActive = false（或等 30s 超时自动释放）
```

---

## 4. 通信协议

### 4.1 概览

```
Frontend ──HTTP POST──→ Backend ──TCP──→ Game Client (Lua)
Frontend ←──WebSocket──── Backend ←──TCP──── Game Client
```

- 请求路径：`POST /api/gm_console/table_monitor/{client_id}/command`
- 响应通道：`WebSocket /ws/table_monitor`
- 游戏侧 packet type：`TABLE_MONITOR` (请求) / `TABLE_MONITOR_RESP` (响应)

### 4.2 Action: list_tables

枚举所有 XTable 定义 + 可选运行时统计。

**请求**：
```json
{ "action": "list_tables" }
```

**响应**：
```json
{
  "type": "TABLE_MONITOR_RESP",
  "action": "list_tables",
  "data": {
    "tables": [
      { "name": "XTableItem", "fieldCount": 12 },
      { "name": "XTableCharacter", "fieldCount": 8 },
      ...
    ],
    "stats": {
      "available": true,
      "lua": {
        "XTableItem": { "rows": 2340, "readRows": 156, "totalSize": 1258000, "module": "XItem", "tabScope": "Normal" },
        ...
      },
      "csharp": {
        "XTableNpc": { "rows": 500, "readRows": 500, "totalSize": 320000, "module": "", "tabScope": "" },
        ...
      },
      "summary": {
        "luaCount": 186,
        "csharpCount": 42,
        "totalMemory": 29675520,
        "totalRows": 124560
      }
    }
  }
}
```

- `tables`：从 `XTable` 全局变量遍历所有 key 生成，始终可用
- `stats`：当 `IsBinaryConfigMonitorReady()` 返回 `true` 时填充，否则 `{ "available": false }`
- `stats.lua` / `stats.csharp`：分别对应 sourceType 0 和 1 的已加载表统计

### 4.3 Action: get_schema

获取指定表的字段定义。

**请求**：
```json
{ "action": "get_schema", "tableName": "XTableItem" }
```

**响应**：
```json
{
  "type": "TABLE_MONITOR_RESP",
  "action": "get_schema",
  "data": {
    "tableName": "XTableItem",
    "fields": [
      { "name": "Id", "valueType": "int", "primaryKey": true },
      { "name": "Name", "valueType": "string" },
      { "name": "Tags", "valueType": "string", "collectionType": 1 },
      { "name": "Attrs", "valueType": "float", "collectionType": 2, "keyType": "int" }
    ]
  }
}
```

- `collectionType`：`1` = List, `2` = Dict, 不存在则为标量
- `primaryKey`：`true` 仅在主键字段出现

### 4.4 Action: get_data

获取表的行数据（分页 + 可选搜索/排序）。

**请求**：
```json
{
  "action": "get_data",
  "tableName": "XTableItem",
  "page": 1,
  "pageSize": 50,
  "search": "",
  "sortField": "",
  "sortDir": "asc"
}
```

**响应**：
```json
{
  "type": "TABLE_MONITOR_RESP",
  "action": "get_data",
  "data": {
    "tableName": "XTableItem",
    "totalRows": 2340,
    "matchedRows": 2340,
    "page": 1,
    "pageSize": 50,
    "rows": [
      { "Id": 1001, "Name": "铁剑", "Tags": ["武器", "一星"], "Attrs": {"1": 10.5, "2": 3.2} },
      { "Id": 1002, "Name": "钢盾", "Tags": ["防具", "一星"], "Attrs": {"1": 5.0} },
      ...
    ]
  }
}
```

字段说明：
- `totalRows`：表的总行数
- `matchedRows`：搜索过滤后的匹配行数（无搜索时 = totalRows）
- `page` / `pageSize`：当前页码和页大小
- `rows`：当前页的行数据数组，每行为 `{ fieldName: value }` 的 plain object

### 4.5 路径解析

XTable 定义名（如 `XTableItem`）与磁盘路径（如 `Share/Item/Item`）之间的映射需要在 Lua 侧解析。策略：

1. 使用 `CS.XTableManager.GetPaths("Share")` + `GetPaths("Client")` 枚举所有磁盘路径
2. 路径最后一段（如 `Item`）与 `XTable` key 去掉 `XTable` 前缀后匹配
3. 对于无法自动匹配的表，用户可在前端手动输入路径（fallback）

Lua 侧在 `list_tables` 时预构建 `tableName → path` 映射缓存，后续 `get_data` 直接使用。

---

## 5. UI 设计

### 5.1 页签注册

- Tab key: `table_monitor`
- Tab label: `Table`
- Tab icon: `Table2` (lucide-react)
- 无 gridSlider
- Props: `{ clients, selectedClient, broadcastMode, active }`

### 5.2 组件树

```
TableViewer (主组件)
├── TableToolbar                    # 工具栏：搜索、过滤开关、Stats 开关、刷新
├── TableListSidebar                # 左侧表列表
│   ├── TableListSearch             # 搜索框
│   └── TableListItem               # 单个表项（名称、字段数、可选统计）
└── TableMainPanel                  # 右侧主区域
    ├── TableGlobalStats            # 未选中表时：全局统计概览（Stats 模式）
    ├── TableStatsBar               # 选中表时：单表统计卡片（Stats 模式）
    ├── TableSchema                 # Schema 表格 + [加载数据] 按钮
    ├── TableDataGrid               # 行数据表格
    │   ├── TableDataToolbar        # 搜索 + 分页控件 + 排序状态
    │   └── TableDataRow            # 表格行
    └── TableRowDetail              # 选中行详情卡片
```

### 5.3 核心 State

```javascript
// 表列表
const [tableList, setTableList] = useState([])         // list_tables 响应
const [stats, setStats] = useState(null)               // 可选运行时统计

// UI 状态
const [selectedTable, setSelectedTable] = useState(null)
const [schema, setSchema] = useState(null)
const [tableSearch, setTableSearch] = useState('')      // 表名搜索
const [onlyLoaded, setOnlyLoaded] = useState(false)    // 仅已加载过滤
const [showStats, setShowStats] = useState(false)       // Stats 面板开关

// 行数据
const [rows, setRows] = useState(null)                  // 当前页行数据
const [totalRows, setTotalRows] = useState(0)
const [matchedRows, setMatchedRows] = useState(0)
const [page, setPage] = useState(1)
const [pageSize, setPageSize] = useState(50)
const [dataSearch, setDataSearch] = useState('')         // 行数据搜索
const [sortField, setSortField] = useState('')
const [sortDir, setSortDir] = useState('asc')
const [selectedRow, setSelectedRow] = useState(null)     // 展开详情的行
const [dataLoaded, setDataLoaded] = useState(false)     // 是否已手动加载过数据

// WebSocket
const [wsStatus, setWsStatus] = useState('disconnected')
```

### 5.4 localStorage 持久化

| Key | 内容 |
|-----|------|
| `table_monitor_sidebar_width` | 侧栏宽度 (px) |
| `table_monitor_page_size` | 每页行数 |
| `table_monitor_show_stats` | Stats 开关状态 |
| `table_monitor_favorites` | 收藏的表名数组 (JSON) |
| `table_monitor_recents` | 最近访问的表名数组 (JSON, max 20) |

### 5.5 空状态与加载

| 场景 | 展示 |
|------|------|
| 未选择客户端 | 居中图标 + "请选择客户端" |
| 等待表列表 | 侧栏 skeleton 占位 |
| 未选中表 | 右侧主区域显示全局统计（Stats 模式）或提示 "请在左侧选择一个配表" |
| 选中表未加载数据 | 仅显示 Schema + [加载数据] 按钮 |
| 加载数据中 | 表格区域 spinner + "正在从游戏端读取数据..." |
| 行数据为空 | "该表无数据" |
| 搜索无结果 | "未找到匹配的行" |
| PerformanceMonitor 不可用 | Stats 开关旁灰色提示 "debug 包可用" |

---

## 6. Lua 端设计

### 6.1 LuaTableMonitor 模块

在 RuntimeGMClient（XMain.lua）中新增 `LuaTableMonitor`，约 200 行。

```lua
local LuaTableMonitor = {}
LuaTableMonitor._pathCache = nil           -- tableName → path 映射缓存
LuaTableMonitor._dataCache = nil           -- 当前加载的表数据缓存 { name, allRows, keys }
LuaTableMonitor._perfMonitorReady = false  -- PerformanceMonitor 是否可用
LuaTableMonitor._isActive = false          -- 激活状态（零开销开关）
LuaTableMonitor._lastActivateTime = 0
LuaTableMonitor._activeTimeout = 30        -- 30 秒无命令自动休眠
LuaTableMonitor._viewerLoadedTables = {}   -- 被 Viewer 触发加载的表集合
```

### 6.2 初始化

```lua
function LuaTableMonitor.Init()
    -- 探测 HaruPerformanceMonitor 可用性
    pcall(function()
        local monitor = CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor
        LuaTableMonitor._perfMonitorReady = monitor.IsBinaryConfigMonitorReady()
    end)
end
```

### 6.3 HandleCommand 入口

```lua
function LuaTableMonitor.HandleCommand(packet)
    local action = packet.action

    -- start/stop 控制激活状态
    if action == "start" then
        LuaTableMonitor._isActive = true
        LuaTableMonitor._lastActivateTime = CS.UnityEngine.Time.realtimeSinceStartup
        return
    elseif action == "stop" then
        LuaTableMonitor._isActive = false
        LuaTableMonitor._dataCache = nil  -- 释放缓存
        return
    end

    -- 任何其他命令都刷新激活时间
    LuaTableMonitor._isActive = true
    pcall(function() LuaTableMonitor._lastActivateTime = CS.UnityEngine.Time.realtimeSinceStartup end)

    if action == "list_tables" then
        LuaTableMonitor.HandleListTables()
    elseif action == "get_schema" then
        LuaTableMonitor.HandleGetSchema(packet.tableName)
    elseif action == "get_data" then
        LuaTableMonitor.HandleGetData(packet)
    end
end
```

### 6.4 Update — 超时自动休眠

```lua
-- 挂在 RuntimeGMClient.Update 中
function LuaTableMonitor.Update()
    if not LuaTableMonitor._isActive then return end  -- 零开销
    local ok, now = pcall(function() return CS.UnityEngine.Time.realtimeSinceStartup end)
    if not ok then return end
    if now - LuaTableMonitor._lastActivateTime > LuaTableMonitor._activeTimeout then
        LuaTableMonitor._isActive = false
        LuaTableMonitor._dataCache = nil
        origin_print("[RuntimeGM] LuaTableMonitor auto-deactivated (timeout)")
    end
end
```

Packet 路由（在 RuntimeGMClient 的 ProcessPacket 中新增）：

```lua
elseif type == "TABLE_MONITOR" then
    local ok, err = pcall(LuaTableMonitor.HandleCommand, packet)
    if not ok then
        origin_print("[RuntimeGM] TABLE_MONITOR error: " .. tostring(err))
    end
```

### 6.4 list_tables 实现要点

```lua
function LuaTableMonitor.HandleListTables()
    -- 1. 遍历 XTable 全局变量
    local tables = {}
    for name, def in pairs(XTable) do
        local fieldCount = 0
        for _ in pairs(def) do fieldCount = fieldCount + 1 end
        tables[#tables + 1] = { name = name, fieldCount = fieldCount }
    end
    table.sort(tables, function(a, b) return a.name < b.name end)

    -- 2. 构建 path 映射缓存
    LuaTableMonitor._buildPathCache()

    -- 3. 可选：收集 PerformanceMonitor 统计
    local stats = { available = false }
    if LuaTableMonitor._perfMonitorReady then
        stats = LuaTableMonitor._collectStats()
    end

    RuntimeGMClient.Send({
        type = "TABLE_MONITOR_RESP",
        action = "list_tables",
        data = { tables = tables, stats = stats }
    })
end
```

### 6.6 get_data 实现要点

```lua
function LuaTableMonitor.HandleGetData(packet)
    local tableName = packet.tableName
    local page = packet.page or 1
    local pageSize = packet.pageSize or 50
    local search = packet.search or ""
    local sortField = packet.sortField or ""
    local sortDir = packet.sortDir or "asc"

    -- 1. 查找路径和 schema
    local path = LuaTableMonitor._pathCache and LuaTableMonitor._pathCache[tableName]
    local xTableDef = XTable[tableName]
    if not path or not xTableDef then
        RuntimeGMClient.Send({ type = "TABLE_MONITOR_RESP", action = "get_data",
            error = "Table not found: " .. tostring(tableName) })
        return
    end

    -- 2. 查找主键字段
    local primaryKey = "Id"
    for fieldName, desc in pairs(xTableDef) do
        if desc.PrimaryKey then primaryKey = fieldName; break end
    end

    -- 3. 加载前检测：标记是否由 Viewer 触发
    local loadedByViewer = false
    if not LuaTableMonitor._dataCache or LuaTableMonitor._dataCache.name ~= tableName then
        -- 检查该表是否已被游戏加载（通过 PerformanceMonitor 或 AllTables）
        local wasLoaded = false
        if LuaTableMonitor._perfMonitorReady then
            pcall(function()
                local monitor = CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor
                local reader = monitor:GetBinaryConfigMonitorReader()
                if reader then
                    wasLoaded = reader:GetReadRows(monitor.BinaryConfigSourceLuaType, path) > 0
                end
            end)
        end

        local allData = XTableManager.ReadAllByIntKey(path, xTableDef, primaryKey)

        if not wasLoaded then
            loadedByViewer = true
            LuaTableMonitor._viewerLoadedTables[tableName] = true
        end

        -- 将 dict 转为有序数组
        local keys = {}
        for k in pairs(allData) do keys[#keys + 1] = k end
        table.sort(keys)
        LuaTableMonitor._dataCache = { name = tableName, data = allData, keys = keys }
    else
        loadedByViewer = LuaTableMonitor._viewerLoadedTables[tableName] or false
    end

    local cache = LuaTableMonitor._dataCache
    local keys = cache.keys

    -- 4. 搜索过滤
    if search ~= "" then
        local filtered = {}
        local searchLower = string.lower(search)
        for _, k in ipairs(keys) do
            local row = cache.data[k]
            local match = false
            for fieldName, _ in pairs(xTableDef) do
                local val = row[fieldName]
                if val ~= nil and string.find(string.lower(tostring(val)), searchLower, 1, true) then
                    match = true; break
                end
            end
            if match then filtered[#filtered + 1] = k end
        end
        keys = filtered
    end

    -- 5. 排序
    if sortField ~= "" then
        table.sort(keys, function(a, b)
            local va = cache.data[a][sortField]
            local vb = cache.data[b][sortField]
            if va == nil then return false end
            if vb == nil then return true end
            if sortDir == "desc" then return va > vb else return va < vb end
        end)
    end

    -- 6. 分页截取
    local totalRows = #cache.keys
    local matchedRows = #keys
    local startIdx = (page - 1) * pageSize + 1
    local endIdx = math.min(startIdx + pageSize - 1, matchedRows)
    local rows = {}
    for i = startIdx, endIdx do
        local k = keys[i]
        local row = cache.data[k]
        local rowData = {}
        for fieldName, _ in pairs(xTableDef) do
            rowData[fieldName] = row[fieldName]
        end
        rows[#rows + 1] = rowData
    end

    RuntimeGMClient.Send({
        type = "TABLE_MONITOR_RESP", action = "get_data",
        data = {
            tableName = tableName, totalRows = totalRows, matchedRows = matchedRows,
            page = page, pageSize = pageSize, rows = rows,
            loadedByViewer = loadedByViewer
        }
    })
end
```

### 6.7 PerformanceMonitor 数据采集

```lua
function LuaTableMonitor._collectStats()
    local monitor = CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor
    local luaType = monitor.BinaryConfigSourceLuaType    -- 0
    local csType = monitor.BinaryConfigSourceCsharpType  -- 1
    local reader = monitor.GetBinaryConfigMonitorReader and monitor:GetBinaryConfigMonitorReader()
    if not reader then return { available = false } end

    local function collectSource(sourceType)
        local result = {}
        local names = reader:GetAllConfigNames(sourceType)
        if not names then return result end
        local iter = names:GetEnumerator()
        while iter:MoveNext() do
            local name = iter.Current
            result[name] = {
                rows = reader:GetRows(sourceType, name),
                readRows = reader:GetReadRows(sourceType, name),
                totalSize = reader:GetTotalSize(sourceType, name),
                module = reader:GetModule(sourceType, name) or "",
                tabScope = reader:GetTabScope(sourceType, name) or ""
            }
        end
        return result
    end

    local luaStats = collectSource(luaType)
    local csStats = collectSource(csType)

    -- 汇总
    local totalMem, totalRows, luaCount, csCount = 0, 0, 0, 0
    for _, v in pairs(luaStats) do luaCount = luaCount + 1; totalMem = totalMem + v.totalSize; totalRows = totalRows + v.rows end
    for _, v in pairs(csStats) do csCount = csCount + 1; totalMem = totalMem + v.totalSize; totalRows = totalRows + v.rows end

    return {
        available = true,
        lua = luaStats, csharp = csStats,
        summary = { luaCount = luaCount, csharpCount = csCount, totalMemory = totalMem, totalRows = totalRows }
    }
end
```

### 6.8 性能考量

| 风险点 | 应对措施 |
|--------|---------|
| 大表 ReadAll 内存开销 | 一次只缓存一个表的数据（`_dataCache`），切换表时释放前一个 |
| JSON 序列化大 payload | 分页限制每次最多 100 行；Lua 侧 `jsonEncode` 只序列化当前页数据 |
| 搜索 / 排序遍历全表 | 在缓存的有序 keys 上操作，避免重复 ReadAll |
| 频繁请求 | 前端 debounce（搜索 300ms），翻页无需 debounce 但需等待前一次响应 |

---

## 7. 后端接口设计

### 7.1 HTTP 端点

```python
@app.post("/table_monitor/{client_id}/command")
async def table_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_table_monitor_request(client_id, action, body)
    return {"status": "requested"}
```

### 7.2 WebSocket 端点

```python
table_monitor_ws_connections: list = []

async def broadcast_table_monitor_event(data: dict):
    dead = []
    for ws in table_monitor_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        table_monitor_ws_connections.remove(ws)

@app.websocket("/ws/table_monitor")
async def websocket_table_monitor(websocket: WebSocket):
    await websocket.accept()
    table_monitor_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in table_monitor_ws_connections:
            table_monitor_ws_connections.remove(websocket)
```

### 7.3 ServerMgr 扩展

```python
# 新增 callback
self.on_table_monitor_data = None  # Callback for TABLE_MONITOR_RESP

# _process_packet 新增分支
elif t == "TABLE_MONITOR_RESP":
    action = pkt.get("action", "?")
    print(f"[ServerMgr] TABLE_MONITOR_RESP: action={action}, error={pkt.get('error', 'none')}")
    if self.on_table_monitor_data:
        self.on_table_monitor_data(cid, pkt)

# 新增发送方法
async def send_table_monitor_request(self, client_id: str, action: str, params: dict):
    c = self.clients.get(client_id)
    if not c:
        return
    pkt = {"type": "TABLE_MONITOR", "action": action}
    pkt.update(params)
    msg = json.dumps(pkt, ensure_ascii=False) + "\n"
    try:
        c.writer.write(msg.encode())
        await c.writer.drain()
    except Exception as e:
        self._add_log("error", f"Send TABLE_MONITOR failed: {e}", client_id)
```

### 7.4 Callback 注册

```python
# main.py lifespan 中
def on_table_monitor_data(client_id, pkt):
    asyncio.create_task(broadcast_table_monitor_event({
        "type": pkt.get("action", "unknown"),
        "client_id": client_id,
        "data": pkt.get("data", {}),
        "error": pkt.get("error")
    }))
server_mgr.on_table_monitor_data = on_table_monitor_data
```

---

## 8. 文件结构

### 8.1 新增文件

| 文件 | 说明 |
|------|------|
| `frontend/src/pages/TableViewer.jsx` | 前端页签组件（预估 600-900 行） |

### 8.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `frontend/src/pages/GmConsole.jsx` | 导入 TableViewer + TAB_META 新增 `table_monitor` 条目 |
| `tools/gm_console/main.py` | 新增 WS 端点 + HTTP 端点 + broadcast + callback 注册 |
| `tools/gm_console/server_mgr.py` | 新增 `TABLE_MONITOR_RESP` 分发 + `send_table_monitor_request` + `on_table_monitor_data` |

### 8.3 游戏侧新增

需在 `RuntimeGMClient`（XMain.lua）中新增 `LuaTableMonitor` 模块 + `TABLE_MONITOR` packet 路由（约 200 行）。

---

## 9. 设计决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 数据加载时机 | 选中表自动加载 / 手动点击加载 | 手动点击 | 大表可能上万行，自动加载会导致卡顿 |
| 分页层 | 前端分页 / Lua 侧分页 | Lua 侧分页 | 避免一次性传输全量数据，TCP + JSON 序列化开销过大 |
| 搜索层 | 前端搜索 / Lua 侧搜索 | Lua 侧搜索 | 数据在 Lua 内存中，前端只有当前页数据 |
| 排序层 | 前端排序 / Lua 侧排序 | Lua 侧排序 | 同上 |
| 数据缓存 | 不缓存 / 缓存当前表 / 缓存所有访问过的表 | 缓存当前表 | 控制内存占用，ReadAll 开销大但只做一次 |
| PerformanceMonitor | 必须 / 可选 | 可选增强 | release 包中不可用，不能作为核心依赖 |
| 路径映射 | 硬编码 / 运行时扫描 / 用户输入 | 运行时扫描 + fallback 手动输入 | `GetPaths` 可自动发现，少数表名不规则时允许手动指定 |
| 表名显示 | 完整名 / 去前缀 | 去 `XTable` 前缀 | 更简洁，tooltip 显示完整名 |
| 激活机制 | 始终运行 / start-stop / 超时自动休眠 | start-stop + 30s 超时自动休眠 | 参考 AV Monitor 模式，确保不活跃时零开销 |
| 搜索友好度 | 简单搜索框 / 收藏+最近下拉 | 收藏+最近下拉 | 参考 PlayerPrefsViewer，开发者常反复查同几张表 |
| Viewer 加载副作用 | 忽略 / 标记区分 | 标记区分 | 在 Stats 面板中用 ◆ 图标区分 Viewer 触发的加载，避免误判 |

---

## 附录 A：XTable 路径命名规则

表文件分布在两个根目录下：

| 目录 | 说明 | 示例路径 |
|------|------|---------|
| `Share/` | 服务端+客户端共用配表 | `Share/Item/Item.tab` |
| `Client/` | 客户端独占配表（UI配置等） | `Client/Ui/UiConfig.tab` |

路径格式：`{Dir}/{SubDir}/{TableFileName}`（不含 `.tab` 后缀）。

XTable 定义名与路径的对应关系通常为 `XTable{TableFileName}` → `{Dir}/.../TableFileName`，但存在例外（如 `XTableCharDetail` 对应 `Client/Character/CharacterDetail`），需运行时 `GetPaths` 扫描 + 模糊匹配。
