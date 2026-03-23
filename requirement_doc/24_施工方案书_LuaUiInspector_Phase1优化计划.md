# 施工方案书：LuaUiInspector Phase 1 优化计划

> 前置文档：`23_施工方案书_LuaUiInspector_运行时Lua_UI数据查看器.md`
> 目标文件：`Dev/Client/Assets/Editor/LuaUiInspector/LuaUiInspectorWindow.cs`
> 日期：2026-03-23

---

## 概览

Phase 1 Editor 功能已验收通过，本计划为 8 项体验与功能优化。所有改动仅涉及 `LuaUiInspectorWindow.cs` 一个文件（纯 C# IMGUI）。

### 施工顺序与依赖关系

```
Step 1: #9  增量刷新（基础架构改造，#6 和 #10 的前置依赖）
Step 2: #6  变更高亮（依赖 #9 的 oldValue/newValue 对比）
Step 3: #3  搜索/过滤 UE 重构（左侧树搜索 + 右侧 Filter 移到顶部）
Step 4: #1  StateFlag 生命周期指示器
Step 5: #4  复制字段值到剪贴板
Step 6: #8  跳转 Lua 源文件
Step 7: #10 Snapshot 快照对比（依赖 #9 的增量结构）
Step 8: #11 Lua 方法调用
```

---

## Step 1：增量刷新（无感架构优化）

**目的**：Auto-refresh 不再每次重建 FieldEntry 列表，改为原地更新 value，从根本上解决子表展开丢失问题，并为 #6 和 #10 提供 oldValue 基础。

**当前问题**：
- `Update()` → `ReadFields()` → `CollectFields()` 每次创建全新 `List<FieldEntry>`
- 子表展开状态因对象重建而丢失（当前有 L408 workaround）
- 无法对比 old/new value

**改造方案**：

1. `FieldEntry` 新增字段：
   ```csharp
   public object previousValue;  // 上一次刷新的值，用于变更检测
   public bool isChanged;        // 本次刷新值是否发生变化
   public double changeTime;     // 变化发生的时间戳
   ```

2. 新增 `_fieldCache`（按当前选中节点隔离）：
   ```csharp
   // key = fieldKey（仅当前选中节点的字段）
   private Dictionary<string, FieldEntry> _fieldCache = new Dictionary<string, FieldEntry>();
   private LuaTable _cachedOwner;  // 缓存所属的 LuaTable，切换节点时清空重建
   ```

3. `ReadFields()` 改造逻辑（切换节点时清空缓存）：
   ```
   a. 遍历 LuaTable 的当前 key-value
   b. 对每个 key，在 _fieldCache 中查找
      - 命中 → 更新 value 相关字段（numberValue 等），设置 previousValue = 旧值
      - 未命中 → 创建新 FieldEntry，加入 cache
   c. 遍历结束后，标记 cache 中不再存在的 key 为 removed
   d. 重建 _fields 列表（排序），但复用 FieldEntry 对象
   ```

4. 移除 L408-409 的 `exp && subFields == null` workaround（不再需要）

**验收标准**：
- Auto-refresh 时子表展开不丢失
- 切换节点时字段正常重建
- 性能：字段数 > 50 时刷新无卡顿

---

## Step 2：变更高亮

**目的**：Auto-refresh 时，值发生变化的字段短暂高亮，帮助追踪运行时状态变化。

**依赖**：Step 1（需要 `previousValue` 和 `isChanged`）

**方案**：

1. 在 Step 1 的增量刷新中，检测值变化时设置：
   ```csharp
   f.isChanged = true;
   f.changeTime = EditorApplication.timeSinceStartup;
   ```

2. `DrawField()` 中，当 `f.isChanged` 为 true 时：
   - 计算 `elapsed = now - f.changeTime`
   - `elapsed < 2.0s`：绘制黄色半透明背景（alpha 从 0.3 渐变到 0）
   - `elapsed >= 2.0s`：重置 `isChanged = false`

3. 视觉效果：
   ```
   ┌─────────────────────────────────────────┐
   │  ███ Level    │  12        │  (was: 10) │  ← 黄色背景渐隐
   │     Name      │  "Player"  │            │  ← 无变化，正常显示
   └─────────────────────────────────────────┘
   ```
   - 高亮期间在值右侧显示 `(was: {oldValue})`，渐隐后隐藏

**验收标准**：
- 手动修改值后刷新，该行黄色高亮 2 秒后渐隐
- 外部 Lua 代码修改值后，Auto-refresh 能捕获并高亮
- 不影响手动编辑操作

---

## Step 3：搜索/过滤 UE 重构

**目的**：左侧树增加搜索，右侧 Filter 从底栏移到右侧面板顶部，改善交互体验。

**当前问题**：
- 左侧树无搜索，UI 多时难以定位
- 右侧 Filter 放在底栏位置不直觉

**方案**：

### 左侧面板
在 `Open UIs` 标题下方加搜索框：
```
┌─ Left Panel ──────────────┐
│ Open UIs                  │
│ [🔍 搜索 UI/节点...]      │  ← 新增
│ ● UiTask                  │
│   ▸ ChildNodes (5)        │
│ ● UiChat                  │
└───────────────────────────┘
```

- 实时过滤 UI 名称，匹配不区分大小写
- 同时匹配树节点名：若子节点匹配，父 UI 保留显示且自动展开到匹配节点
- 空搜索框显示全部
- 新增 `_leftFilter` 字段

### 右侧面板
将底栏的 Filter 移到右侧标题行下方：
```
┌─ Right Panel ─────────────────────────────────┐
│ Inspector: PanelTaskCanLiver (21)             │
│ [🔍 过滤字段...] Depth:[3] ☐Show nil          │  ← 从底栏移到这里
│ ┃ ▼ 可编辑属性 (8)                             │
│ ┃   Level  │ 12                                │
│ ...                                            │
└────────────────────────────────────────────────┘
```

- `_filter`、`_depth`、`_showNil` 从 `DrawBottomBar()` 移到 `DrawRightPanel()` 顶部
- 底栏仅保留 `Revert All` 按钮（和后续的 Snap 按钮）

**验收标准**：
- 左侧搜索能过滤 UI 名 + 树节点名
- 右侧 Filter 在标题下方，使用体验更直觉
- 底栏简化

---

## Step 4：StateFlag 生命周期指示器

**目的**：在左侧树节点旁显示 `_StateFlag` 状态，一眼看出哪些子节点的 `OnStart` 还没调用。

**方案**：

1. 读取每个子节点 LuaTable 的 `_StateFlag` 值：
   ```csharp
   // 注意：SafeGet<T> 有 where T : class 约束，int 是值类型
   // 需用 SafeGet<object> 再 Convert，或新增 SafeGetInt 辅助方法
   object flagObj = SafeGet<object>(node, "_StateFlag");
   int stateFlag = flagObj != null ? Convert.ToInt32(flagObj) : 0;
   ```

2. `TreeNode` 新增 `stateFlag` 字段

3. `DrawTreeNode()` 中，在节点名后面绘制状态标记：
   ```
   ◆ PanelTaskCanLiver ●      ← 绿色圆点 = OnStart 已调用
   ◆ PanelTaskDrawCanLiver ○  ← 灰色圆点 = OnStart 未调用（_StateFlag == 0）
   ```

4. Tooltip：鼠标悬停显示 `"StateFlag: None (OnStart 未调用，相关字段可能不存在)"`

**验收标准**：
- ChildNodes 中每个节点显示对应状态标记
- StateFlag == 0 的节点灰色圆点且有 tooltip 提示
- 不影响树节点的点击和展开

---

## Step 5：复制字段值到剪贴板

**目的**：方便调试时快速复制 key/value。

**方案**：

1. 每个字段行末尾加 `📋` 小按钮（紧凑，Width=20）：
   ```csharp
   if (GUILayout.Button("📋", EditorStyles.miniLabel, GUILayout.Width(20)))
       EditorGUIUtility.systemCopyBuffer = $"{f.key} = {FormatValueForCopy(f)}";
   ```

2. `FormatValueForCopy()` 格式化规则：
   - number → `12.5`
   - string → `"hello"`
   - bool → `true`
   - table → `{12 fields}`（仅摘要）
   - unityobject → `GameObject(Name)`
   - function → `function`

3. 复制后短暂显示 `✓` 替代 `📋`（0.5 秒）

**验收标准**：
- 点击后剪贴板内容正确
- 所有类型字段都可复制

---

## Step 6：跳转 Lua 源文件

**目的**：从 Inspector 直接跳转到节点对应的 Lua 源文件。

**方案**：

1. 读取节点 LuaTable 的 `__cname` 字段（XClass 注册的类名）：
   ```csharp
   string cname = SafeGet<string>(node, "__cname");  // e.g. "XUiPanelTaskCanLiver"
   ```

2. 在 `DrawTreeNode()` 中，如果 `__cname` 非空，显示 `→` 按钮：
   ```
   ◆ PanelTaskCanLiver ● [→]
   ```

3. 点击时通过文件系统搜索定位路径：
   ```csharp
   // Lua 文件在 Product/Lua/ 下，不在 Unity Assets/ 内，AssetDatabase 无法索引
   // 使用 System.IO.Directory.GetFiles() 搜索
   string luaRoot = Path.Combine(Application.dataPath, "../../Product/Lua");
   var files = Directory.GetFiles(luaRoot, cname + ".lua", SearchOption.AllDirectories);
   // 找到后用 InternalEditorUtility.OpenFileAtLineExternal() 或 System.Diagnostics.Process.Start() 打开
   ```

4. 右侧面板标题行也显示 `__cname`：
   ```
   Inspector: PanelTaskCanLiver [XUiPanelTaskCanLiver] (21)  [→]
   ```

**注意事项**：
- Lua 文件在 Unity 中可能是 `.lua.txt` 后缀，需兼容两种
- 搜索结果缓存到 `Dictionary<string, string>`，避免重复搜索

**验收标准**：
- 点击跳转到正确的 Lua 文件
- __cname 为空时不显示按钮
- 跳转失败时在 Console 输出提示

---

## Step 7：Snapshot 快照对比

**目的**：保存某一时刻的字段快照，与当前状态做 diff，排查"哪些字段在操作前后发生了变化"。

**依赖**：Step 1（增量结构提供稳定的 FieldEntry 引用）

**方案**：

### 数据结构
```csharp
private Dictionary<string, object> _snapshot;  // key = "ownerHash.fieldKey", value = 快照时的值
private bool _diffMode;
```

### UI 交互

底栏新增按钮：
```
┌─ Bottom Bar ──────────────────────────────────────────┐
│ [Revert All]          [📷 Snap] [Diff ☐] [Clear Snap] │
└───────────────────────────────────────────────────────┘
```

- `📷 Snap`：保存当前选中节点的所有字段值到 `_snapshot`
- `Diff` Toggle：开启/关闭对比模式
- `Clear Snap`：清除快照

### Diff 模式显示

```
┌──────────────────────────────────────────────┐
│  * Level    │  12        │  was: 10          │  ← 黄色，值变了
│    Name     │  "Player"  │                   │  ← 无标记，未变
│  + NewField │  true      │  (new)            │  ← 绿色，新增字段
│  - OldField │            │  (removed)        │  ← 红色，已移除
└──────────────────────────────────────────────┘
```

- `*` 黄色背景：值变化，右侧显示旧值
- `+` 绿色前缀：快照时不存在，现在有了
- `-` 红色前缀：快照时存在，现在没了
- 无标记：未变化（Diff 模式下可用 Toggle 隐藏）

### 实现要点
- 快照存储用 `Dictionary<string, object>`，key 与 `_fieldCache` 一致
- Diff 计算在 `DrawField()` 中实时比较 `_snapshot[key]` vs `f.rawValue`
- 切换节点时快照不清除（key 包含 ownerHash，天然隔离）
- removed 字段需要额外渲染一行（不在当前 _fields 中，需从 _snapshot 遍历）

**验收标准**：
- Snap → 操作游戏 → 开 Diff，能看到变化/新增/删除
- 切换节点再切回来，快照仍有效
- Clear Snap 后回到正常模式

---

## Step 8：Lua 方法调用

**目的**：对 Function 类型字段提供 Invoke 按钮，可直接调用无参方法，加速调试。

**方案**：

1. `DrawField()` 中，当 `f.luaType == "function"` 时，在 "function" 标签旁增加 `▶ Call` 按钮：
   ```
   │  Refresh    │  function  [▶ Call]  │
   │  OnEnable   │  function  [▶ Call]  │
   ```

2. 点击时执行：
   ```csharp
   try
   {
       var func = f.owner.Get<LuaFunction>(f.key);
       // 以 self 方式调用：func.Call(f.owner)
       func.Call(f.owner);
       Debug.Log($"[LuaUiInspector] Called {f.key}() on {_selectedNodeName}");
   }
   catch (Exception e)
   {
       Debug.LogError($"[LuaUiInspector] Call {f.key}() failed: {e.Message}");
   }
   ```

3. 安全措施：
   - 危险方法黑名单（不显示 Call 按钮）：`Destroy`, `Close`, `Release`, `Dispose`, `Delete`
   - `__` 前缀元方法过滤（不显示 Call 按钮）：`__index`, `__newindex`, `__tostring`, `__gc` 等所有 `__` 开头的 key
   - 调用前弹确认框（可选，`EditorUtility.DisplayDialog`）
   - 调用后自动刷新字段（观察副作用）

4. 扩展（可选）：支持传入一个简单参数的输入框，但初版只做无参调用。

**验收标准**：
- 点击 Call 能正确调用 Lua 方法
- 黑名单方法不显示 Call 按钮
- 调用失败在 Console 显示错误
- 调用后自动刷新字段

---

## 底栏布局最终形态

优化完成后，底栏从现在的：
```
[Filter: ____] [Depth: 3] [☐ Show nil]              [Revert All]
```

变为（Filter/Depth/ShowNil 移到右侧面板顶部后）：
```
[Revert All]              [📷 Snap] [Diff ☐] [Clear Snap]
```

---

## 工时估算

| Step | 内容 | 复杂度 |
|------|------|--------|
| 1 | 增量刷新 | 高（架构改造） |
| 2 | 变更高亮 | 低（基于 Step 1） |
| 3 | 搜索/过滤 UE 重构 | 中 |
| 4 | StateFlag 指示器 | 低 |
| 5 | 复制字段值 | 低 |
| 6 | 跳转 Lua 源文件 | 中 |
| 7 | Snapshot 对比 | 中 |
| 8 | Lua 方法调用 | 低 |
