# AnimatorViewer 运行时动画状态查看器 - 施工方案书

> 版本：v1.1
> 日期：2026-03-20
> 状态：已审阅通过
> 工具名称：Animator Live Monitor
> Editor 菜单入口：Tool/动画/Animator Live Monitor

---

## 一、项目概述

### 1.1 痛点与背景

本项目（Haru）在开发中使用 AssetBundle (AB) 加载资源，导致 Unity 原生 Animator 窗口无法查看战斗中角色的动画状态。当前唯一手段是通过 `XClientAnimatorEditor.cs` 的右键菜单打印日志（代码自注释："这个写法太野了"），效率极低且无法实时观察。

**核心需求**：在 AB 加载模式下，提供接近甚至超越 Unity 原生 Animator 窗口的动画状态查看能力。

### 1.2 需求总结

| 项目 | 决策 |
|------|------|
| 查看内容 | 状态机状态/过渡、参数值、Clip信息、Layer信息 |
| 交付形式 | B: Web（集成到 EncyHub GM Console）+ D: Unity EditorWindow |
| 刷新频率 | Web端 5-10 FPS，仅激活查看时才推送 |
| C# 代码位置 | `Dev/Client/Assets/Editor/AnimatorTools/ClientAnimator/` |
| Editor 菜单 | `Tool/动画/Animator Live Monitor` |
| Web 集成位置 | EncyHub GM Console 新增 Tab |
| TCP 通道 | 复用现有 12581 端口 |

### 1.3 设计目标

- **超越原生**：不仅复刻 Unity Animator 窗口，还提供原生缺失的能力（远程查看、多Animator对比、状态变更历史、参数实时编辑）
- **按需激活**：仅在用户主动打开 Animator Viewer 时才进行数据采集和推送，零额外性能开销
- **双端协同**：EditorWindow 提供完整图谱级查看，Web 端提供远程实时仪表盘

---

## 二、技术架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Unity 游戏进程                              │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              AnimatorDataService (单例)                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │  │
│  │  │ AnimatorTracker │  │ AnimatorTracker │  │ ...更多追踪  │  │  │
│  │  │ (角色A Animator)│  │ (角色B Animator)│  │              │  │  │
│  │  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  │  │
│  │           └────────────────────┼──────────────────┘           │  │
│  │                                │ 数据汇聚                     │  │
│  │                       ┌────────▼────────┐                     │  │
│  │                       │  JSON 序列化器  │                     │  │
│  │                       └────────┬────────┘                     │  │
│  └────────────────────────────────┼──────────────────────────────┘  │
│                    ┌──────────────┼──────────────┐                  │
│                    │              │              │                  │
│           ┌────────▼──────┐  ┌───▼────────────┐                    │
│           │ EditorWindow  │  │ TCP:12581 推送  │                    │
│           │ (直接读取)    │  │ (ANIM_DATA包)  │                    │
│           └───────────────┘  └───────┬────────┘                    │
└──────────────────────────────────────┼─────────────────────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  EncyHub GM Console     │
                          │  (FastAPI 子进程)       │
                          │                         │
                          │  新增 Animator 相关      │
                          │  API + WebSocket 通道   │
                          └────────────┬────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  React 前端             │
                          │  GmConsole Animator Tab │
                          │  实时仪表盘 + 历史记录  │
                          └─────────────────────────┘
```

### 2.2 分层职责

| 层级 | 位置 | 职责 |
|------|------|------|
| **数据采集层** | C# `AnimatorDataService` | 追踪场景中 Animator，按需采集状态、过渡、参数、Clip数据 |
| **EditorWindow** | C# `AnimatorViewerEditorWindow` | Play模式下完整状态机图谱，利用 `UnityEditor.Animations` API |
| **传输层** | TCP:12581 扩展协议 | 新增 ANIM 系列包类型，按需推送 |
| **Web 后端** | GM Console `main.py` 扩展 | 新增 Animator API 端点 + WebSocket 通道 |
| **Web 前端** | React `AnimatorViewer` 组件 | 实时仪表盘、参数面板、状态历史、Clip进度 |

---

## 三、C# 侧详细设计

### 3.1 文件结构

```
Dev/Client/Assets/Editor/AnimatorTools/ClientAnimator/
├── XClientAnimatorEditor.cs          # (已存在) 保留，后续可标记废弃
├── AnimatorDataService.cs            # 核心服务：单例，管理所有追踪器
├── AnimatorTracker.cs                # 单个 Animator 的数据采集器
├── AnimatorDataSnapshot.cs           # 数据快照结构定义
├── AnimatorGraphExtractor.cs         # 状态机图谱提取（Editor API）
├── AnimatorViewerEditorWindow.cs     # EditorWindow 主窗口
├── AnimatorViewerGraphRenderer.cs    # 状态机图谱绘制器（IMGUI）
└── AnimatorTcpBridge.cs              # TCP 协议扩展（ANIM 包处理）
```

### 3.2 AnimatorDataSnapshot - 数据结构定义

```csharp
// 单次快照的完整数据结构
[Serializable]
public class AnimatorDataSnapshot
{
    public string animatorId;           // 唯一标识（InstanceID）
    public string gameObjectName;       // GameObject 名称
    public string controllerName;       // RuntimeAnimatorController 名称
    public float timestamp;             // Time.time
    public LayerSnapshot[] layers;      // 各 Layer 数据
    public ParameterSnapshot[] parameters; // 所有参数
}

[Serializable]
public class LayerSnapshot
{
    public int index;
    public string name;
    public float weight;
    // 当前状态
    public StateSnapshot currentState;
    // 过渡中的目标状态（无过渡时为 null）
    public StateSnapshot nextState;
    // 过渡信息
    public TransitionSnapshot transition;
    // 当前播放的 Clip 信息
    public ClipSnapshot[] currentClips;
}

[Serializable]
public class StateSnapshot
{
    public int nameHash;
    public string name;                 // 通过图谱提取器反查
    public float normalizedTime;
    public float length;
    public float speed;
    public int loopCount;
    public bool isLooping;
}

[Serializable]
public class TransitionSnapshot
{
    public bool isInTransition;
    public float normalizedTime;        // 过渡进度 0~1
    public float duration;
    public string sourceName;
    public string targetName;
}

[Serializable]
public class ClipSnapshot
{
    public string clipName;
    public float clipLength;
    public float clipWeight;            // BlendTree 中的权重
}

[Serializable]
public class ParameterSnapshot
{
    public string name;
    public string type;                 // "Float", "Int", "Bool", "Trigger"
    public float floatValue;
    public int intValue;
    public bool boolValue;
}
```

### 3.3 AnimatorTracker - 单个追踪器

```csharp
// 核心逻辑伪码
public class AnimatorTracker
{
    private Animator _animator;
    private Dictionary<int, string> _stateNameCache;  // hash → name

    public AnimatorTracker(Animator animator)
    {
        _animator = animator;
        _stateNameCache = new Dictionary<int, string>();
        // 通过 AnimatorGraphExtractor 预建 hash→name 映射
        BuildStateNameCache();
    }

    public AnimatorDataSnapshot TakeSnapshot()
    {
        // 1. 遍历所有 Layer
        // 2. 获取 GetCurrentAnimatorStateInfo / GetNextAnimatorStateInfo
        // 3. 获取 GetAnimatorTransitionInfo
        // 4. 获取 GetCurrentAnimatorClipInfo
        // 5. 获取所有 Parameters
        // 6. 通过 _stateNameCache 反查 State 名称
        // 返回完整快照
    }
}
```

**State 名称反查关键点**：
- Unity 运行时只提供 `AnimatorStateInfo.shortNameHash`，不直接提供名称
- 解决方案：在 Editor 环境下，通过 `AnimatorGraphExtractor` 预先遍历 `AnimatorController.layers[].stateMachine`，建立 `Animator.StringToHash(stateName) → stateName` 的映射表
- 对 AB 加载的 Controller：通过 `RuntimeAnimatorController` → 尝试转型 `AnimatorController`（Editor 下可行），或通过 `AnimatorOverrideController.runtimeAnimatorController` 获取原始 Controller

### 3.4 AnimatorGraphExtractor - 图谱提取

```csharp
// Editor-only：提取完整状态机图谱（节点位置、所有过渡连线）
// 仅 EditorWindow 使用，Web 端不需要完整图谱
public class AnimatorGraphExtractor
{
    // 输入：RuntimeAnimatorController（AB 加载的也可以）
    // 输出：AnimatorGraphData（节点列表 + 连线列表 + 位置信息）

    public AnimatorGraphData Extract(RuntimeAnimatorController controller)
    {
        // 尝试获取 AnimatorController（Editor API）
        // AnimatorController ac = controller as AnimatorController;
        // 遍历 ac.layers[].stateMachine.states[]
        //   - 提取：state.state.name, state.position
        //   - 提取：state.state.transitions[]（条件、目标State）
        // 遍历 ac.layers[].stateMachine.anyStateTransitions[]
        // 提取 ac.parameters[]
    }

    // 同时建立 hash → name 映射表供 AnimatorTracker 使用
    public Dictionary<int, string> BuildHashToNameMap(RuntimeAnimatorController controller);
}
```

### 3.5 AnimatorDataService - 核心服务单例

```csharp
public class AnimatorDataService
{
    private static AnimatorDataService _instance;
    public static AnimatorDataService Instance => _instance ??= new AnimatorDataService();

    private Dictionary<int, AnimatorTracker> _trackers;  // InstanceID → Tracker
    private bool _isWebSubscribed = false;
    private float _pushInterval = 0.1f;  // 100ms = 10fps
    private float _lastPushTime;

    // === 追踪管理 ===
    public void RegisterAnimator(Animator animator);
    public void UnregisterAnimator(Animator animator);
    public List<AnimatorBriefInfo> GetAvailableAnimators();  // 列出场景中可追踪的 Animator

    // === 场景扫描 ===
    public void ScanSceneAnimators();  // 扫描场景中所有活跃的 Animator

    // === 数据获取 ===
    public AnimatorDataSnapshot GetSnapshot(int animatorId);  // EditorWindow 用
    public AnimatorDataSnapshot[] GetAllSnapshots();           // 批量获取

    // === Web 推送控制 ===
    public void OnWebSubscribe(int animatorId);    // Web 端订阅
    public void OnWebUnsubscribe();                 // Web 端取消订阅
    // 在 Update 中检查：如果 _isWebSubscribed 且间隔到期，采集并通过 TCP 推送
}
```

### 3.6 AnimatorTcpBridge - 协议扩展

在现有 `RuntimeGMClient`（XMain.lua 中的 TCP 客户端）基础上，新增 ANIM 系列消息处理：

**新增 TCP 包类型**：

| 方向 | 类型 | 用途 | Payload |
|------|------|------|---------|
| Web → Game | `ANIM_LIST` | 请求可用 Animator 列表 | `{}` |
| Game → Web | `ANIM_LIST_RESP` | 返回 Animator 列表 | `{animators: [{id, name, controllerName}]}` |
| Web → Game | `ANIM_SUBSCRIBE` | 订阅某 Animator 数据 | `{animatorId: int}` |
| Web → Game | `ANIM_UNSUBSCRIBE` | 取消订阅 | `{}` |
| Game → Web | `ANIM_DATA` | 推送快照数据 | `AnimatorDataSnapshot (JSON)` |
| Web → Game | `ANIM_SET_PARAM` | 远程修改参数 | `{name, type, value}` |

**实现方案（经自检修正）**：

TCP socket 由 Lua 层 `RuntimeGMClient`（XMain.lua）管理，C# 无法直接拦截。采用 **Lua 薄转发 + C# 处理** 方案：

1. Lua 侧：`RuntimeGMClient` 收到消息后检查 `type` 字段，若为 `ANIM_*` 前缀，直接调用 `CS.AnimatorTcpBridge.HandleMessage(jsonStr)` 转发给 C#，不做任何解析
2. C# 侧：`AnimatorTcpBridge` 接收 JSON 字符串，解析并执行对应逻辑
3. C# → TCP 发送：通过 `CS.AnimatorTcpBridge.PollOutgoingMessage()` 让 Lua 侧定时拉取待发送消息，由 Lua 通过现有 socket 发出

```lua
-- XMain.lua RuntimeGMClient 消息分发中新增：
if msgType and msgType:sub(1, 5) == "ANIM_" then
    CS.AnimatorTcpBridge.HandleMessage(jsonStr)
    return
end
```

```csharp
// AnimatorTcpBridge.cs
public static class AnimatorTcpBridge
{
    private static Queue<string> _outgoingMessages = new Queue<string>();

    // Lua 调用入口：接收 ANIM_* 消息
    public static void HandleMessage(string json) { /* 解析并分发 */ }

    // Lua 定时拉取：获取待发送的 ANIM_DATA 等消息
    public static string PollOutgoingMessage()
    {
        return _outgoingMessages.Count > 0 ? _outgoingMessages.Dequeue() : null;
    }

    // Update 中：若已订阅 → 采集快照 → 序列化 → 入队 _outgoingMessages
}
```

**优势**：Lua 侧改动极小（3行），数据采集和序列化全在 C#，避免 Lua GC 压力。

### 3.7 EditorWindow 设计

`AnimatorViewerEditorWindow.cs` - 完整的 Unity EditorWindow，Play 模式下使用。

**菜单入口**：`[MenuItem("Tool/动画/Animator Live Monitor")]`

**功能区域**：

```
┌──────────────────────────────────────────────────────────────┐
│ AnimatorViewer                                      [≡] [×] │
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│  Animator    │         State Machine Graph                   │
│  列表        │                                               │
│              │    ┌─────────┐      ┌─────────┐              │
│ ● PlayerA   │    │  Idle   │─────→│  Run    │              │
│ ○ MonsterB  │    │ ██████  │      │         │              │
│ ○ NPC_C     │    └────┬────┘      └─────────┘              │
│              │         │                                     │
│  ─────────   │    ┌────▼────┐      ┌─────────┐              │
│  Parameters  │    │ Attack  │─────→│  Die    │              │
│              │    │         │      │         │              │
│  Speed: 1.0  │    └─────────┘      └─────────┘              │
│  IsGround: ✓ │                                               │
│  HP: 85      │    Layer: [Base ▼]  Transition: 45% ████░░░  │
│              │                                               │
├──────────────┴───────────────────────────────────────────────┤
│ Clip: attack_01  ████████░░░░░░░ 0.55/1.2s  Speed: 1.0     │
│ Events: HitFrame(0.4s) EffectSpawn(0.6s)                    │
└──────────────────────────────────────────────────────────────┘
```

**关键能力**：
1. **自动扫描**：Play 模式启动时自动扫描场景中所有 Animator（包括 AB 加载的）
2. **完整图谱**：利用 `UnityEditor.Animations.AnimatorController` 提取节点位置和连线，绘制可视化图
3. **实时高亮**：当前 State 高亮显示，过渡时显示连线动画
4. **参数编辑**：直接在面板中修改参数值，实时影响动画状态
5. **Layer 切换**：下拉选择不同 Layer 查看
6. **Clip 时间轴**：底部显示当前 Clip 播放进度和事件标记
7. **搜索过滤**：Animator 列表支持名称搜索

**相比 Unity 原生 Animator 的增强**：
- 支持 AB 加载的 AnimatorController
- 左侧集成参数面板（原生需要单独查看）
- 底部 Clip 时间轴（原生 Animator 窗口不显示）
- 多 Animator 快速切换（原生需要在 Hierarchy 中逐个选择）

---

## 四、Web 侧详细设计

### 4.1 GM Console 后端扩展

在 `tools/gm_console/main.py` 中新增 Animator 相关 API：

```python
# === Animator Viewer API ===

@app.get("/animators")
# 向已连接的游戏客户端发送 ANIM_LIST 请求，返回可用 Animator 列表

@app.post("/animators/{animator_id}/subscribe")
# 向游戏发送 ANIM_SUBSCRIBE，开启数据推送
# 后端将收到的 ANIM_DATA 转发到 WebSocket

@app.post("/animators/unsubscribe")
# 发送 ANIM_UNSUBSCRIBE，停止推送

@app.post("/animators/{animator_id}/set-param")
# 远程修改 Animator 参数（调试用）
# Body: {name: str, type: str, value: any}

@app.websocket("/ws/animator")
# 专用 WebSocket 通道，转发 ANIM_DATA 到前端
# 仅在有订阅时活跃
```

**ServerMgr 扩展**：
- `server_mgr.py` 中新增 ANIM 消息类型识别和转发
- 收到 `ANIM_LIST_RESP` → 缓存 Animator 列表
- 收到 `ANIM_DATA` → 通过 `/ws/animator` 推送到前端

### 4.2 React 前端组件设计

在 `GmConsole.jsx` 中新增 **Animator Viewer** Tab。

**组件层级**：

```
GmConsole (现有)
├── [现有 Tabs: GM Tree | Lua | Custom GM | Log]
└── [新增 Tab: Animator Viewer]
    └── AnimatorViewerPanel
        ├── AnimatorSelector          # 选择要查看的 Animator
        │   ├── ClientDropdown        # 选择游戏客户端（多设备）
        │   └── AnimatorDropdown      # 选择具体 Animator
        ├── AnimatorDashboard         # 主仪表盘
        │   ├── LayerTabs             # Layer 切换标签
        │   ├── StatePanel            # 当前状态 + 过渡信息
        │   │   ├── CurrentState      # 状态名、时间、速度
        │   │   ├── TransitionBar     # 过渡进度条（可视化）
        │   │   └── NextState         # 目标状态（过渡中）
        │   ├── ClipTimeline          # Clip 播放进度可视化
        │   │   ├── ProgressBar       # 播放位置指示器
        │   │   └── ClipInfo          # 名称、长度、权重
        │   └── ParameterPanel        # 参数列表
        │       ├── FloatParam        # 滑动条 + 数值
        │       ├── IntParam          # 数值输入
        │       ├── BoolParam         # 开关
        │       └── TriggerParam      # 触发按钮
        └── StateHistory              # 状态变更历史记录
            └── HistoryTimeline       # 时间轴式历史回看
```

### 4.3 Web 前端交互设计

#### 4.3.1 Animator Selector 区域

```
┌─────────────────────────────────────────────────────────────┐
│ 🎮 Client: [WindowsEditor - PID:12345 ▼]                   │
│ 🎭 Animator: [Player_Main (HumanoidController) ▼] [刷新]   │
└─────────────────────────────────────────────────────────────┘
```

- 选择客户端后自动拉取 Animator 列表
- 选择 Animator 后自动订阅数据流
- 切换 Animator 时自动取消旧订阅

#### 4.3.2 State Dashboard 区域

```
┌─────────────────────────────────────────────────────────────┐
│ Layers: [Base Layer] [Upper Body] [Face]                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Current State                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 🔵 Attack_Combo_01                                    │  │
│  │ Time: 0.55 / 1.20s (45.8%)  Speed: 1.5x  Loop: No   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Transition                                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Attack_Combo_01 ──▶ Idle                              │  │
│  │ ████████████░░░░░░░░░░░░░░░░░░░░░ 38%                │  │
│  │ Duration: 0.25s                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Clips Playing                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ attack_combo_01.anim                                  │  │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░ 0.55/1.20s  w:1.0  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 4.3.3 Parameters 区域

```
┌─────────────────────────────────────────────────────────────┐
│ Parameters                                    [搜索过滤...] │
├──────────────┬──────┬────────────────────────────────────────┤
│ Name         │ Type │ Value                                  │
├──────────────┼──────┼────────────────────────────────────────┤
│ Speed        │Float │ ━━━━━━━━━━━━━●━━━━━━ 1.50             │
│ IsGrounded   │Bool  │ [✓]                                    │
│ AttackIndex  │Int   │ [2    ]                                │
│ JumpTrigger  │Trig  │ [Fire ▶]                               │
│ HP_Ratio     │Float │ ━━━━━━━━━━━━━━━━━●━━ 0.85             │
├──────────────┴──────┴────────────────────────────────────────┤
│ ⚡ 参数可编辑：修改后实时同步到游戏                           │
└─────────────────────────────────────────────────────────────┘
```

- Float：滑动条 + 数值输入
- Bool：复选框
- Int：数值输入框
- Trigger：触发按钮
- 修改后通过 `ANIM_SET_PARAM` 同步到游戏

#### 4.3.4 State History 区域（超越原生的功能）

```
┌─────────────────────────────────────────────────────────────┐
│ State History (最近 50 条)                        [清除]     │
├──────┬──────────────┬──────────────┬──────────────┬──────────┤
│ 时间  │ From         │ To           │ Layer        │ Duration │
├──────┼──────────────┼──────────────┼──────────────┼──────────┤
│14:32 │ Idle         │ Run          │ Base Layer   │ 0.25s    │
│14:33 │ Run          │ Attack_01    │ Base Layer   │ 0.10s    │
│14:33 │ Attack_01    │ Attack_02    │ Base Layer   │ 0.05s    │
│14:34 │ Attack_02    │ Idle         │ Base Layer   │ 0.25s    │
│14:35 │ -            │ Smile        │ Face         │ 0.30s    │
└──────┴──────────────┴──────────────┴──────────────┴──────────┘
```

- 自动记录所有状态切换事件
- 时间戳、来源、目标、Layer、过渡时长
- 前端本地缓存，最多保留 50 条
- Unity 原生 Animator 完全没有这个功能

---

## 五、数据流时序

### 5.1 Web 端订阅流程

```
Browser                  EncyHub                    Game (C#)
   │                        │                           │
   │ 1. GET /animators      │                           │
   │───────────────────────→│                           │
   │                        │ 2. TCP: ANIM_LIST         │
   │                        │──────────────────────────→│
   │                        │                           │ 3. ScanSceneAnimators()
   │                        │ 4. TCP: ANIM_LIST_RESP    │
   │                        │←──────────────────────────│
   │ 5. Animator列表        │                           │
   │←───────────────────────│                           │
   │                        │                           │
   │ 6. POST /subscribe     │                           │
   │───────────────────────→│                           │
   │                        │ 7. TCP: ANIM_SUBSCRIBE    │
   │                        │──────────────────────────→│
   │                        │                           │ 8. 启动定时采集(10fps)
   │ 9. WS /ws/animator     │                           │
   │◄══════════════════════►│                           │
   │                        │                           │
   │                        │ 10. TCP: ANIM_DATA (×10/s)│
   │                        │←──────────────────────────│
   │ 11. WS: animator_data  │                           │
   │←═══════════════════════│                           │
   │    (持续推送 10fps)     │                           │
   │                        │                           │
   │ 12. POST /unsubscribe  │                           │
   │───────────────────────→│                           │
   │                        │ 13. TCP: ANIM_UNSUBSCRIBE │
   │                        │──────────────────────────→│
   │                        │                           │ 14. 停止采集
```

### 5.2 参数编辑流程

```
Browser                  EncyHub                    Game (C#)
   │                        │                           │
   │ POST /set-param        │                           │
   │ {name:"Speed",         │                           │
   │  type:"Float",         │                           │
   │  value: 2.0}           │                           │
   │───────────────────────→│                           │
   │                        │ TCP: ANIM_SET_PARAM       │
   │                        │──────────────────────────→│
   │                        │                           │ animator.SetFloat("Speed", 2.0)
   │                        │                           │
   │                        │ 下一帧 ANIM_DATA 会反映   │
   │ WS: 更新后的 snapshot  │ 新参数值                  │
   │←═══════════════════════│←──────────────────────────│
```

---

## 六、性能设计

### 6.1 按需激活策略

| 场景 | 数据采集 | TCP 推送 | 性能影响 |
|------|----------|----------|----------|
| 未打开 Animator Viewer | ❌ | ❌ | 零开销 |
| 打开 EditorWindow | ✅ (RepaintOnUpdate) | ❌ | 极低（Editor内直接读取） |
| Web 端订阅单个 Animator | ✅ 单个 | ✅ 10fps | 每帧 ~1KB JSON |
| Web 端未订阅 | ❌ | ❌ | 零开销 |

### 6.2 数据量估算

单个 Animator 快照（3 Layer, 10 Parameters）：
- JSON 序列化后约 **500B - 1.5KB**
- 10fps 推送：**5-15 KB/s**
- 对 TCP:12581 带宽影响可忽略

### 6.3 优化手段

1. **增量更新**：仅推送发生变化的字段（对比上一帧快照）
2. **State 名称缓存**：hash→name 映射仅初始化时建立一次
3. **图谱数据缓存**：状态机结构仅在 Controller 变化时重新提取
4. **WebSocket 背压**：前端消费不及时则丢弃中间帧，保证最新数据

---

## 七、实施计划

### Phase 1：C# 数据采集层 + EditorWindow（核心）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1.1 | `AnimatorDataSnapshot.cs` | 数据结构定义 |
| 1.2 | `AnimatorGraphExtractor.cs` | 状态机图谱提取、hash→name 映射 |
| 1.3 | `AnimatorTracker.cs` | 单 Animator 数据采集 |
| 1.4 | `AnimatorDataService.cs` | 服务单例、追踪器管理、场景扫描 |
| 1.5 | `AnimatorViewerGraphRenderer.cs` | IMGUI 状态机图谱绘制 |
| 1.6 | `AnimatorViewerEditorWindow.cs` | EditorWindow 集成 |

**Phase 1 交付**：可在 Unity Editor Play 模式下查看 AB 加载角色的完整 Animator 状态。

### Phase 2：TCP 协议扩展 + Web 后端

| 步骤 | 文件 | 内容 |
|------|------|------|
| 2.1 | `AnimatorTcpBridge.cs` | C# 侧 ANIM 消息处理 |
| 2.2 | `server_mgr.py` 扩展 | ANIM 消息类型识别和转发 |
| 2.3 | `main.py` 扩展 | Animator API 端点 + WebSocket |

**Phase 2 交付**：数据通道打通，可通过 API 获取 Animator 数据。

### Phase 3：React 前端

| 步骤 | 文件 | 内容 |
|------|------|------|
| 3.1 | `AnimatorViewer.jsx` | 主组件 + Tab 集成 |
| 3.2 | `AnimatorSelector` | 客户端 + Animator 选择器 |
| 3.3 | `AnimatorDashboard` | 状态面板 + 过渡进度 + Clip 时间轴 |
| 3.4 | `ParameterPanel` | 参数列表 + 实时编辑 |
| 3.5 | `StateHistory` | 状态变更历史记录 |

**Phase 3 交付**：完整的 Web 端 Animator Viewer。

### Phase 4：打磨与增强

| 步骤 | 内容 |
|------|------|
| 4.1 | 增量更新优化 |
| 4.2 | 多 Animator 对比查看 |
| 4.3 | 状态历史导出 |
| 4.4 | 连接断开/重连处理 |

---

## 八、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| AB 加载的 Controller 无法转型为 AnimatorController | EditorWindow 无法绘制完整图谱 | 降级为 Dashboard 模式（仅显示运行时状态，不画图谱）；同时尝试通过 AB 路径手动加载 Editor 资源 |
| hash→name 映射不完整 | State 名称显示为 hash 值 | 提供手动输入名称的 fallback；或通过运行时遍历已知动画名称暴力匹配 |
| 战斗中 Animator 数量多，场景扫描慢 | 列表更新延迟 | 支持按名称过滤、手动刷新；扫描操作异步执行 |
| TCP 通道上 ANIM_DATA 与现有 EXEC/LOG 消息混合 | 消息处理延迟 | ANIM 消息使用独立的处理优先级；或在 C# 侧直接处理不经过 Lua |
| RuntimeGMClient 仅在 Editor Debug 模式下启用 | 正式构建无法使用 Web Viewer | 明确 Web Viewer 仅支持 Editor/Development Build 环境 |

---

## 九、技术选型确认

| 决策点 | 选择 | 理由 |
|--------|------|------|
| ANIM 消息处理层 | Lua 薄转发 + C# 处理 | Lua 仅做 type 判断和转发（3行），数据采集序列化全在 C# |
| EditorWindow 绘制 | IMGUI (OnGUI) | 与现有 Editor 代码风格一致，无额外依赖 |
| Web 前端 | 扩展现有 GmConsole.jsx | 复用客户端选择、WebSocket 基础设施 |
| 数据推送 | WebSocket | 实时性要求高，HTTP 轮询不适合 5-10fps |
| State 名称解析 | Editor API 预建映射 | 运行时 API 不提供名称，唯一可靠方案 |

---

## 十、验收标准

### Phase 1 验收
- [ ] Play 模式下 EditorWindow 可列出所有 AB 加载的 Animator
- [ ] 完整状态机图谱显示（节点 + 连线 + 位置）
- [ ] 当前状态高亮、过渡动画显示
- [ ] 参数面板实时更新 + 可编辑
- [ ] Clip 时间轴显示播放进度

### Phase 2 验收
- [ ] TCP ANIM 消息正常收发
- [ ] EncyHub API 可获取 Animator 列表
- [ ] WebSocket 正常推送数据

### Phase 3 验收
- [ ] GM Console 中 Animator Viewer Tab 正常显示
- [ ] 远程实时查看动画状态（5-10fps）
- [ ] 参数远程编辑生效
- [ ] 状态变更历史记录正常

### Phase 4 验收
- [ ] 未使用时零性能开销
- [ ] 连接断开后优雅降级
- [ ] 多设备同时查看正常

---

## 附录：苏格拉底自检记录

以下为方案自检中发现的问题及对策，已同步修正到方案正文：

### A.1 AnimatorOverrideController 支持

**问题**：项目可能大量使用 `AnimatorOverrideController` 做角色换皮，直接 `as AnimatorController` 转型会失败。

**对策**：`AnimatorGraphExtractor` 需处理两种情况：
- `RuntimeAnimatorController` → `AnimatorController`（直接转型）
- `AnimatorOverrideController` → `.runtimeAnimatorController` → `AnimatorController`（获取基础 Controller）
- 图谱从基础 Controller 提取，Clip 信息从 `GetCurrentAnimatorClipInfo` 获取（已是实际替换后的 Clip）

### A.2 TCP 消息入口修正

**问题**：原方案写"C#侧直接处理，绕过 Lua"，但 TCP socket 实际由 Lua `socket.core` 管理，C# 无法直接拦截。

**修正**：改为 Lua 薄转发方案（已更新 3.6 节）。Lua 侧仅新增 3 行代码做 type 前缀判断和转发，零性能影响。

### A.3 SubStateMachine 递归遍历

**问题**：Unity 状态机支持嵌套 SubStateMachine，原方案的图谱提取只考虑了平级 State。

**对策**：`AnimatorGraphExtractor.Extract()` 需递归遍历 `StateMachine.stateMachines[]`，每个子状态机作为可展开的组节点显示。BlendTree 节点显示为特殊类型，展开后列出 motion 列表和权重。

### A.4 Animator 生命周期管理

**问题**：战斗中角色被销毁，`AnimatorTracker` 持有的引用变 null。

**对策**：
- `AnimatorTracker.TakeSnapshot()` 首先检查 `_animator != null && _animator.gameObject != null`
- 失效时自动从 `AnimatorDataService` 注销，并推送 `ANIM_REMOVED` 事件
- Web 端收到后从列表中移除，EditorWindow 刷新列表
- `AnimatorDataService` 支持定期重新扫描（如每 2 秒）以发现新加载的角色

### A.5 非运行状态处理

**问题**：原方案未明确非 Play 模式和无连接状态的 UI 表现。

**对策**：
- **EditorWindow**：非 Play 模式显示居中提示文字"请进入 Play 模式后使用 Animator Live Monitor"
- **Web 端**：无客户端连接时 Animator 列表为空，显示"等待游戏连接..."占位提示
- **Web 端**：已订阅的 Animator 被销毁时，自动切换到"选择 Animator"状态

### A.6 IMGUI 图谱绘制性能

**问题**：复杂状态机（20+ State、50+ Transition）在 IMGUI OnGUI 中可能卡顿。

**对策**：
- 图谱布局（节点位置计算）仅在 Controller 切换时执行一次，结果缓存
- 每帧只更新：当前 State 高亮色、过渡进度条、参数值
- 实现视口裁剪：超出可视区域的节点和连线不绘制
- 支持缩放和平移（类似 Unity 原生 Animator 窗口的操作）

### A.7 新增 TCP 包类型 ANIM_REMOVED

**补充**：原方案 TCP 包类型表缺少 Animator 被销毁的通知。

| 方向 | 类型 | 用途 | Payload |
|------|------|------|---------|
| Game → Web | `ANIM_REMOVED` | Animator 被销毁通知 | `{animatorId: int}` |
