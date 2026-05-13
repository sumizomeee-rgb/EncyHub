# LuaUiInspector — 高级搜索（Advanced Search）设计方案书

> 版本：v1.0
> 日期：2026-05-13
> 状态：待审阅
> 模块：GM Console / LuaUiInspector
> 入口：LuaUi Tab 顶部 `🔍 搜索` 按钮 → 独立 Modal 弹窗

---

## 一、概述

### 1.1 痛点

当前 `LuaUiInspector` 是 **纯人工浏览模式**：必须先选 UI → 再选节点 → 再人眼找字段。无法回答以下高频问题：

| 提问 | 现状 |
|------|------|
| "Id=55 的 UI 在哪？" | 必须挨个点开每个 UI 翻 self | 不可能 |
| "哪些 UI 显示了 'hello' 文本？" | 同上 + 还要点开每个 Component | 不可能 |
| "`*Count` 这种字段在哪些 self 里？" | 同上 + 字段名匹配 | 不可能 |

### 1.2 目标

提供一个 **跨 UI / 跨节点 / 跨 C# 引用** 的统一搜索入口：

- 搜 Lua self.\* 表内所有可枚举字段
- 自动穿透到 self 持有的 C# Text/InputField/Label 等 Component 的文本字段
- 命中后能 **一键跳到对应 UI 节点 + 字段** + 短暂高亮
- 命中行附带 **该字段所属 GameObject 的 Hierarchy 绝对路径**，便于横向定位

### 1.3 决策摘要（已对齐）

| 项 | 决策 | 备注 |
|---|---|---|
| 形态 | 独立 Modal 弹窗 | 不挤 Inspector 视觉空间 |
| 默认深度 | 20 | 大多数 self 树 ≤ 5 层就到底，深度上限不等于真实反射量 |
| 范围 | 弹窗内可选「全部 UI」/「单个 UI」 | 单 UI 模式开销除以 N |
| 命中数量 | **不限**，一次返回全部 | 删除"加载更多"机制，前端直接渲染 |
| 服务端字段扫描上限 | `maxFields=5000` | 仅在扫描总字段达 5000 时截断 + 警告，不限命中数 |
| C# 穿透 | 默认 ON，白名单仅 5 类（不可扩） | 仅作用于"值搜"，详见 §四.4 |
| `t:TypeName` 类型搜 | 支持 | 与白名单**完全独立**，对所有 C# 类型开放 |
| 跳转后弹窗 | **关闭**（不挡视线） | 用户明确："你挡着你挡住我看啥" |
| 结果展示 | **4 列表格 + 列宽可拖** | UI / Lua路径 / GO路径 / 命中字段 |
| GO 路径列交互 | 截断 + hover 全路径 tooltip + click 复制 + 🎯 跳到 Hierarchy | 复用现有 Hierarchy Locate |
| 字段高亮颜色 | `var(--caramel)` | 与 Hierarchy `flashHighlight` / Tab 拖动指示符一致 |
| 复合查询 | 不做 | 如 `t:Text 第x章` 太复杂，分两次搜即可 |
| 大小写 | 默认敏感 | 与 C# 反射、Lua 字段名约定一致 |

---

## 二、查询语法

| 输入 | 模式 | 行为 |
|---|---|---|
| `Id=55` | kv 精确 | `key=="Id"` AND `value==55` |
| `Name="Foo"` | kv 精确（强 string） | `key=="Name"` AND `value=="Foo"` |
| `*Count` / `Lv*` | key glob | 仅匹配字段名（值任意） |
| `hello` | string contains + number 精确 fallback | string 字段含 "hello"；若 query 可解析为数字也尝试 number == |
| `55` | number 精确 + string contains | number == 55 或 string 含 "55" |
| `"hello"` | 强 string 精确 | string == "hello" |
| `55*` / `*55*` | 强 number 模糊 | tostring(number) contains "55" |
| **`t:XUiButton`** | **type 精确** | **userdata 字段，`GetType().Name == "XUiButton"`** |
| **`t:*Button`** / **`t:XUi*`** | **type glob** | **类型名后缀/前缀匹配** |

**设计原则**：
- string 默认 contains（找文本就是要模糊）
- number 默认精确（找 ID 通常是确定的）
- 引号 `"..."` 锁精确字符串
- `*` 强制模糊 / glob
- `t:` 前缀切换到类型搜，不依赖白名单（对所有 C# 类型开放）

无配置项，纯靠输入语法切换，简洁。

### 2.1 走查例子

#### 例 1：搜 `第x章`（值搜，命中 C# 文本）

```
mode = string contains, pattern = "第x章"
遍历每个 UI 的 self.* 树
  遇到 self.LblTitle (userdata, type=Text)
    "Text" 在白名单 → 反射读 .text → "第3章"
    "第3章" contains "第x章"? 不含 → ✗ (但 contains "第" 会命中 → 实际取决于 query)
```
（如果 query 真是 `第3章` 这种含数字的精确文本，contains 会命中。如果 query 是 `第x章` 字面 — 实际不存在该字符串 — 应该写正则才行，但 v1 不支持。建议用户搜 `第3章` 或 `章` 或 `"第3章"`。）

#### 例 2：搜 `t:XUiButton`（类型搜）

```
mode = type, query = "XUiButton"
遍历每个 UI 的 self.* 树
  遇到 self.BtnSubmit (userdata)
    GetType().Name == "XUiButton" ✓ → HIT
    结果列：_BtnSubmit  ::  XUiButton
  遇到 self.MyImage (userdata)
    GetType().Name == "Image" ≠ ✗ → 跳过（不读 .text 不读任何）
```
不依赖白名单，任意 userdata 都参与判定。

#### 例 3：搜 `Id=55`（kv 精确）

```
mode = kv, key="Id", val=55
遍历每个 UI 的 self.* 树
  for k, v in pairs(table) do
    if k == "Id" and v == 55 then HIT end
  end
```
不接触 userdata，不反射，最快。

---

## 三、通信协议

走现有 `/api/gm_console/inspector/{client_id}/command` 通道，新增 action：

```ts
// Request
{
    action: "search",
    query: string,                 // 例: "Id=55", "第3章", "t:XUiButton", "*Count"
    scope: "all" | string,         // "all" 或具体 uiName
    depth: number,                 // 默认 20，硬上限 30
    probeComponentText: boolean,   // 默认 true（值搜走白名单穿透）
    // 注意：无 maxHits，命中数不限；服务端 maxFields=5000 隐式约束总扫描量
}

// Response (CS_INSPECTOR_RESP { action: "search", data: ... })
{
    hits: [
        {
            uiName: string,             // 主 UI 名
            luaPath: string,            // Lua 内路径 "_Data._UserList[2]"
            key: string,                // 命中字段名 "Id"
            valueDisplay: string,       // "55" / "hello..." / "XUiButton" (type 模式时为类型名)
            valueType: "number" | "string" | "bool" | "compText" | "type",
            via?: string,               // C# 文本穿透时填 "Text.text" / "TMP_Text.text"；type 模式不填
            goPath?: string,            // 该字段所属 GO 的 Hierarchy 绝对路径
            goInstanceId?: number,      // 该 GO 的 instanceId（点 🎯 用）
        },
        ...
    ],
    truncated: boolean,            // true 表示扫描达到 maxFields=5000 被截断
    totalScanned: number,          // 实际扫描的字段总数
    elapsedMs: number,
}
```

### 3.1 Query 解析模式

| 输入特征 | 解析为 | mode 字段（内部） |
|---|---|---|
| `t:` 前缀 | 类型搜 | `type` |
| 含 `=` 且左边是合法标识符 | kv 精确 | `kv` |
| 含 `*` 且无 `=` | glob | `key_glob` 或 `value_fuzzy`（带数字/引号判断）|
| 引号包裹 | 强 string 精确 | `string_exact` |
| 纯数字 | 数字精确 + string contains | `number_or_contains` |
| 其他 | string contains + 数字 fallback | `string_contains` |

---

## 四、Lua 端实现

新增 `LuaUiInspector.Search(packet)`，与现有 `GetNodeData` 共享 `inspectorSerializeValue` 工具。

### 4.1 函数签名

```lua
function LuaUiInspector.Search(packet)
    -- packet: { query, scope, depth, probeComponentText }
    -- 返回 { hits, truncated, totalScanned, elapsedMs }
end
```

### 4.2 算法

```
1. 解析 query → { mode, key?, value?, valuePattern?, valueType?, typePattern? }
2. 决定遍历目标 UI 列表（全部 / 单个）
3. 对每个 UI：
   3a. 取 luaUi（XLuaUiManager.GetTopLuaUi(name)）
   3b. recurse(luaUi, "", depth, visitedSet)：
       for k, v in pairs(target) do
           判定命中(k, v) → push 到 hits  -- 命中数不限
           if isTable(v) and depth > 0 and not visited and not skip:
               recurse(v, path+"."+k, depth-1, visited)
           if isUserdata(v):
               if mode == "type":
                   typePattern 匹配 GetType().Name → 命中  -- 不依赖白名单
               elif probeComponentText and mode is value-search:
                   GetType().Name 在 TEXT_PROBE 白名单 → 反射 .text → 比较
4. 扫描总字段数达到 maxFields=5000 时返回 truncated=true 并 break
5. 提取每个 hit 所属的 GameObject 路径（见 §4.3）
6. 返回结果
```

### 4.3 GameObject 路径提取

对每个 hit 的所在 table 进行二次扫描（仅平铺一层），找：
- 该 table 上是否有 `Transform` / `GameObject` 字段
- 或其本身是 userdata Component

提取 `getHierarchyPath(go)`（已经在 `LuaCsMonitor` 实现），写入 `goPath` + `goInstanceId`。

如果一个 hit 的所在 table 没有任何 GO 引用 → `goPath` 不返回（前端列空）。

### 4.4 C# 文本穿透白名单（仅作用于"值搜"）

```lua
local TEXT_PROBE = {
    Text = "text",
    TMP_Text = "text",
    TextMeshProUGUI = "text",
    InputField = "text",
    TMP_InputField = "text",
    UILabel = "text",
}
```

**机制范围**：**仅当用户做值搜**（如 `第3章` / `Id=55`）时启用。遇到 userdata 字段时：
- `GetType().Name` 在白名单 → 反射对应属性（固定为 `.text`）→ 当 string 命中规则比较
- 命中则记 `valueType="compText"` + `via="Text.text"`
- 不在白名单的类型 → 跳过反射，节省开销

**为什么白名单**：如果对每个 userdata 反射所有可能的字符串属性（几十个），几百字段 × 几十属性 × 0.5ms ≈ 数秒。卡飞。限定 5 类 + 仅读 `.text`：几百字段 × 0.5ms ≈ 200ms。可控。

**为什么不可扩**：用户已确认（"白名单不需要再扩"）。其他文本组件如 `Slider.value`/`Toggle.isOn` 不在范围内 — 如真有需要可走 `t:` 类型搜定位再人工查。

### 4.5 `t:` 类型搜模式（与白名单完全独立）

**触发条件**：query 以 `t:` 开头（如 `t:XUiButton` / `t:*Button`）。

**机制**：
- 解析 `t:` 后内容为 typePattern（精确字符串或 glob）
- 递归 self.* 时，对每个 userdata 字段读取 `GetType().Name` 一次
- 匹配 typePattern → 命中
- **任意 C# 类型都可命中**，不查 TEXT_PROBE

**与白名单的关系**：完全独立两套机制。
- 白名单：值搜路径上"是否反射 .text"的开关
- `t:` 搜：直接看类型名，根本不读字段值

| 场景 | 用什么 |
|---|---|
| "找显示『第3章』的 UI" | 值搜 `第3章` → 走白名单穿透 |
| "找所有持有 XUiButton 的 self" | 类型搜 `t:XUiButton` → 不走白名单 |
| "找 .text 含『章』的 Text 组件 + 知道挂哪" | 值搜 `章` → 命中行的 GO 路径列就告诉你挂哪 |
| "找所有 Image 引用" | 类型搜 `t:Image`（白名单不含 Image，但 t: 可以）|

### 4.6 性能保护

| 保护 | 阈值 | 行为 |
|---|---|---|
| `depth` 硬上限 | 30 | 用户可在弹窗里改但不超过 |
| `maxFields` 硬上限 | **5000** | 扫描总字段达此即停，置 `truncated=true` |
| 命中数 | **不限** | 不再有 maxHits 概念 |
| `INSPECTOR_SKIP_KEYS` | 沿用现有 | Transform / Parent / UiAnimation / UiSceneInfo 等 |
| 循环引用 | 用 visited set | 与 GetNodeData 同款 |

### 4.7 路由

`LuaUiInspector.HandleCommand` 增加分支：

```lua
elseif action == "search" then
    result = LuaUiInspector.Search(packet)
```

---

## 五、前端 UI 设计

### 5.1 入口

`LuaUiInspector.jsx` 顶部右侧（"Open UIs" 标题旁）加按钮 `🔍 搜索`，点开 SearchModal。

### 5.2 SearchModal 布局

```
┌─ 🔍 高级搜索 ──────────────────────────────── [✕] ┐
│                                                    │
│ 搜索: [t:XUiButton                        ] [搜索]│
│       提示: Id=55 / "hello" / *Count / t:Text     │
│                                                    │
│ ▼ 高级选项                                         │
│   范围: ⦿ 全部打开的 UI                            │
│         ○ 仅 [UiMain ▼]                            │
│   深度: [20]   ☑ 穿透 C# Text/InputField 内容     │
│                                                    │
│ ─────────────────────────────────────────────     │
│ 找到 287 条 in 5 UIs (扫描 2347 字段, 230ms)      │
│ ⚠ 扫描达上限 5000 被截断，可能不全 — 请收紧 query │
│ (← 仅在 truncated=true 时出现)                     │
│                                                    │
│ ┌──────┬──────────────┬─────────────────┬──────┐ │
│ │ UI   │ Lua 路径     │ GameObject 路径 │ 命中 │ │
│ ├──────┼──────────────┼─────────────────┼──────┤ │
│ │UiMain│ _Data._U…[2] │ Canvas/Pan…/Btn │Id=55 │ │
│ │UiShop│ _CurItem     │ Canvas/Item     │Id=55 │ │
│ │UiBag │ _LblTitle    │ Canvas/…/LblT   │"Hi"  │ │
│ │      │              │                 │ via  │ │
│ │      │              │                 │ Text │ │
│ │UiTeam│ _BtnSubmit   │ Canvas/Btn      │ ::   │ │
│ │      │              │                 │XUiBtn│ │
│ └──────┴──────────────┴─────────────────┴──────┘ │
│   ↑ 列分隔条 (cursor:col-resize) 拖动改列宽       │
│                                                    │
│ (无"加载更多"按钮 — 默认就返回全部命中)           │
└────────────────────────────────────────────────────┘

(点行 → 弹窗关闭 → LuaUi Tab 跳到该 UI + 展开 luaPath + 高亮 2s)
```

### 5.3 表格列详解

| # | 标题 | 内容 | 默认宽 | 拖动 | 行内交互 |
|---|---|---|---|---|---|
| 1 | UI | `uiName` | 120px | ✓ | 单击 → 整行触发跳转 |
| 2 | Lua 路径 | `luaPath`（如 `_Data._UserList[2]`） | 弹性 1fr | ✓ | 同上；hover 全路径 tooltip |
| 3 | GameObject 路径 | `goPath`（截断显示） | 弹性 1fr | ✓ | hover 全路径 tooltip / 行内 📋 复制 / 🎯 跳 Hierarchy |
| 4 | 命中字段 | 见下表 | 弹性 1fr | ✓ | 同上 |

**第 4 列内容按 `valueType` 不同**：

| valueType | 显示模板 | 例 |
|---|---|---|
| `number` / `string` / `bool` | `{key} = {valueDisplay}` | `_Id = 55` |
| `compText` | `{key} = "{valueDisplay}"` 标签 `via {via}` | `_LblTitle = "第3章"  via Text.text` |
| `type` (来自 `t:` 搜) | `{key}  ::  {valueDisplay}` | `_BtnSubmit  ::  XUiButton` |

### 5.3.1 统计行格式

`truncated=false` 时：
```
找到 287 条 in 5 UIs (扫描 2347 字段, 230ms)
```

`truncated=true` 时（追加警告行）：
```
找到 287 条 in 5 UIs (扫描 5000 字段, 510ms)
⚠ 扫描达上限 5000，结果可能不全 — 请收紧 query 或减小范围/深度
```

### 5.4 列宽拖动

- 列头之间放一个 1px 分隔条，hover 时变 caramel 色
- `onMouseDown` 记录起始 X，`onMouseMove` 改对应列的 width
- 状态结构：`columnWidths = { ui: 120, luaPath: 240, goPath: 280, hit: 240 }`
- 拖动同时更新；松开后存 `localStorage('luaui_search_col_widths')`
- 最小列宽 60px，避免拖到不可见

### 5.5 GameObject 路径列单元格 — 复合交互

参考 ADB Master 等页签的"截断 + 复制"模式：

```
┌─ 表格单元格 ─────────────────────────────┐
│ Canvas/PanelTop/Sub…/Btn 📋 🎯           │
│                          ↑   ↑           │
│                          │   └ 跳 Hierarchy │
│                          └ 复制全路径    │
│ (整段 hover → 浏览器 tooltip 全路径)     │
└──────────────────────────────────────────┘
```

- 文本：`overflow:hidden text-overflow:ellipsis whitespace:nowrap`
- HTML 原生 `title={goPath}` 属性提供 tooltip
- 📋 按钮：调 `copyText(goPath)` + Toast 提示"已复制"
- 🎯 按钮：调 GmConsole 的 `setPendingLocate({instanceId})` + `setActiveTab('cs_monitor')`（与现有"📌 → 🎯"链路同款）

### 5.6 跳转到 LuaUi 字段

点击行（除 📋 / 🎯 子按钮外）触发：

1. `closeModal()` — **立即关闭弹窗**（不挡视线）
2. 父组件 `LuaUiInspector` 接收回调 `onJumpToHit({uiName, luaPath, key})`
3. `loadUiTree(uiName)` 切到该 UI
4. 沿 `luaPath` 拆分逐级 `loadNodeData` 拉取每个父节点（如已缓存则跳过），最后 `loadNodeData(uiName, luaPath)`
5. `setExpandedFields` 把目标字段所在 path 加入展开集
6. `flashHighlightField(key, 2000)` — 在 FieldRow 上加临时高亮 class（`var(--caramel)` 边框 / 背景，2s 淡出）

### 5.7 命中数 & 截断处理

**核心改变**：v2 起**不限命中数**，搜索一次返回全部命中。

- 服务端 `maxFields=5000` 仅约束**扫描总字段数**，命中数随其自然产生（典型场景 1-300 条）
- 没有"加载更多"按钮 — 一次到位
- 真截断时：统计行追加 ⚠ 提示，建议用户收紧 query
- 前端表格直接渲染全部行（普通 `<table>`，不上虚拟列表 — 几百行性能足够）

---

## 六、文件清单

| 操作 | 路径 | 说明 |
|---|---|---|
| 改 | `tools/gm_console/README_RuntimeGM_Client.md` | 新增 `LuaUiInspector.Search` + 白名单常量 + HandleCommand 路由 |
| 新 | `frontend/src/pages/LuaUiInspector/SearchModal.jsx` | 弹窗主组件（输入 / 高级选项 / 表格 / 拖宽） |
| 新 | `frontend/src/pages/LuaUiInspector/SearchResultsTable.jsx` | 表格 + 列拖宽（可选拆出） |
| 改 | `frontend/src/pages/LuaUiInspector.jsx` | 顶部加 🔍 按钮；接收 `onJumpToHit` 回调；新增字段高亮临时 class |
| 改 | `frontend/src/pages/GmConsole.jsx` | 把 SearchModal 跳到 Hierarchy 的 🎯 联动接到现有 `setPendingLocate` |

---

## 七、性能与边界

| 风险 | 缓解 |
|---|---|
| 大场景（>10 个 UI）单次反射卡帧 | `maxFields=5000` 硬上限 + 单 UI 模式 + 用户主动收紧 query |
| C# 穿透爆炸 | 严格白名单（5-6 个文本组件类型），不对所有 userdata 反射 |
| Lua table 循环引用 | visited set |
| 字段名重复（如多个 _Id） | 命中条目按 luaPath + key 唯一标识，不去重 |
| 字符串太长（如长文本字段） | `valueDisplay` 截断到 80 字符，前端 hover 看完整 |
| 表格列宽极端值 | 最小 60px 防误操作 |

### 性能预估（典型场景）

- 5 个 UI × 平均 500 字段 = 2500 三元组
- 200 个 userdata（白名单 probe）≈ 100ms
- 字符串/数字比较 ≈ 200ms
- GameObject 路径提取（仅命中 hits 上做）≈ 50ms
- **总耗时 300-500ms**，可接受
- 单 UI 模式：N×（其中 N=4-5 通常）=> 60-100ms，瞬时

---

## 八、设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 形态 | Modal 弹窗 | 不挤 Inspector 视觉，独立聚焦 |
| 跳转后 | 关闭弹窗 | 用户："你挡住我看啥" — 弹窗连续浏览反而挡视线 |
| 结果列布局 | 4 列：UI / Lua路径 / GO路径 / 命中 | 用户指定，覆盖"在哪 + 是什么"两个维度 |
| 列宽可拖 | ✓ | 用户指定 |
| 默认深度 20 | 用户指定 | 树深度通常 ≤5，20 等同于"无限" |
| 单 UI 模式 | ✓ | 大场景的成本除以 N，关键优化 |
| C# 穿透 | 默认 ON | 用户：第 4 类是痛点，必须默认开 |
| 白名单仅 5 类文本组件 | 用户确认不扩 | 防止反射爆炸；其他类型走 `t:` 搜 |
| **`t:` 类型搜** | **支持** | 用户："肯定要做"；与白名单**完全独立**，对所有 C# 类型开放 |
| **命中数不限** | **删除 maxHits/加载更多** | 用户："不能列出全部搜索结果吗" — 一次返回，几百行普通表格能扛 |
| 服务端唯一硬上限 | `maxFields=5000` | 仅约束扫描总量；超出时 ⚠ 警告 |
| 复合查询（如 `t:Text 第x章`） | 不做 | 用户确认；分两次搜即可 |
| 大小写 | 默认敏感 | 与 C# 反射、Lua 一致 |
| 字段高亮颜色 | `var(--caramel)` | 与项目其他高亮（Tab 拖动指示符 / Hierarchy Locate）一致 |
| 跳转高亮 2s | ✓ | 复用 Hierarchy 已有 `flashHighlight` 模式 |

---

## 九、未来扩展（v2+）

- [ ] 历史查询（最近 10 条，下拉记忆）
- [ ] 收藏查询模板（命名 + 一键执行）
- [ ] 命中导出 CSV
- [ ] 类型过滤芯片：仅 string / 仅 number / 仅 compText / 仅 type
- [ ] 反向引用搜：已知一个 GO，找哪些 LuaUi 的 self 持有它（需要 instanceId 反向索引）
- [ ] Regex 模式：`/Id\d+/` 直接 Lua string.match
- [ ] `t:` 模式扩展：`t:XUiButton & onClick != nil` 这种带条件的类型搜
- [ ] 跨 client 广播搜（多机同 query）

---

## 十、实施顺序（建议）

1. **Lua Search MVP**：只做 string contains + kv 精确，无 C# 穿透 — 先打通链路
2. **加 C# 文本穿透**：白名单 + reflective probe
3. **GameObject 路径提取**：在命中后追加二次扫描
4. **前端 SearchModal 基础**：输入 + 表格（无拖宽）+ 跳转
5. **加列宽拖动 + localStorage 记忆**
6. **加 GO 路径列的 📋 复制 + 🎯 跳 Hierarchy**
7. **真机验证**

预估总工时：**1 个工作日**（Lua 0.4 天 + 前端 0.5 天 + 联调 0.1 天）

---

## 附录 A：与现有 Hierarchy `Locate` 的复用关系

| 行为 | 复用点 |
|---|---|
| 🎯 跳 Hierarchy | 完全复用 `pendingLocate` + `locateAndSelect` |
| 高亮淡出 | 复用 `flashHighlight(2000)` |
| 弹窗内的 toast | 复用 `frontend/src/components/Toast.jsx`（如有） |
| Locate 期间转圈遮罩 | 复用 Hierarchy.jsx 已有 `locating` overlay |
