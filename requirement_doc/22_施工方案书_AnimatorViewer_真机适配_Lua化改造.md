# AnimatorViewer 真机适配 - Lua 化改造方案

## 1. 背景与动机

### 1.1 现状问题

当前 AnimatorViewer 的 Web 端（EncyHub GM Console → Animator 标签页）的数据采集完全依赖 C# Editor 代码：

```
Lua RuntimeGMClient.ProcessPacket()
  → CS.AnimatorLiveMonitor.AnimatorTcpBridge.HandleMessage()    ← Editor/目录下

Lua RuntimeGMClient.Update()
  → CS.AnimatorLiveMonitor.AnimatorTcpBridge.PollOutgoingMessage() ← Editor/目录下
```

**所有 C# 代码均位于 `Dev/Client/Assets/Editor/AnimatorTools/ClientAnimator/`，真机包不包含 Editor 代码。** 因此 Animator 查看功能在真机上完全不可用。

### 1.2 改造目标

将 Animator 数据采集逻辑从 C# Editor 迁移到 **纯 Lua 实现**，嵌入 `XMain.lua` 的 `RuntimeGMClient` 中。改造后：

- **真机**: Lua 直接通过 `CS.UnityEngine.Animator` 运行时 API 采集数据 → TCP 发送 → EncyHub 显示
- **Editor**: Unity EditorWindow（图形化窗口）继续使用 C# 代码，与 Lua 路径互不干扰
- **EncyHub Web 前端**: 无需任何修改，接收的 JSON 格式保持不变

### 1.3 改造范围

| 组件 | 是否需要改动 | 说明 |
|------|-------------|------|
| `XMain.lua` (RuntimeGMClient) | **需要** | 新增 Lua 版 Animator 数据采集模块 |
| C# Editor 代码 | **不动** | EditorWindow 继续使用，Web 路径不再经过 |
| EncyHub Python 后端 | **不动** | 接收 JSON 格式不变 |
| EncyHub React 前端 | **不动** | 展示逻辑不变 |

## 2. 技术可行性分析

### 2.1 运行时可用的 Unity Animator API

以下 API 均为 `UnityEngine.Animator` 运行时 API，真机可通过 XLua 的 `CS.UnityEngine.Animator` 访问：

| API | 用途 | 真机可用 |
|-----|------|---------|
| `Object.FindObjectsOfType(typeof(Animator))` | 场景扫描 | YES |
| `animator.layerCount` | 层数 | YES |
| `animator.GetLayerName(i)` | 层名 | YES |
| `animator.GetLayerWeight(i)` | 层权重 | YES |
| `animator.GetCurrentAnimatorStateInfo(i)` | 当前状态信息 | YES |
| `animator.GetNextAnimatorStateInfo(i)` | 下一状态信息 | YES |
| `animator.GetAnimatorTransitionInfo(i)` | 转场信息 | YES |
| `animator.IsInTransition(i)` | 是否在转场中 | YES |
| `animator.GetCurrentAnimatorClipInfo(i)` | 当前播放Clip | YES |
| `animator.parameters` | 参数列表 | YES |
| `animator.GetFloat/GetInteger/GetBool` | 读参数值 | YES |
| `animator.SetFloat/SetInteger/SetBool/SetTrigger` | 写参数值 | YES |
| `animator.runtimeAnimatorController.animationClips` | 所有Clip | YES |
| `animator.HasState(layer, hash)` | 验证状态存在 | YES |
| `Animator.StringToHash(name)` | 名称→Hash | YES |

**结论**: Web 端 AnimatorViewer 当前展示的所有信息（当前状态、转场、参数、Clip、状态历史）均可通过运行时 API 获取。

### 2.2 不可用 API（仅影响 EditorWindow）

| API | 用途 | 真机可用 |
|-----|------|---------|
| `AnimatorController.layers` | 静态图提取 | NO (Editor-only) |
| `AnimatorState/AnimatorStateTransition` | 图节点/连线 | NO (Editor-only) |

**这些仅影响 Unity EditorWindow 的图形化节点视图，Web 前端不使用此数据。**

## 3. 架构设计

### 3.1 改造前后对比

**改造前（Editor-only）:**
```
[Unity C# Editor]                      [XMain.lua]                    [EncyHub]
AnimatorTracker ─┐                        │                              │
AnimatorDataService ─┤                    │                              │
AnimatorTcpBridge ───┘                    │                              │
   │                                      │                              │
   └── PollOutgoingMessage() ──────► RuntimeGMClient.Update() ──TCP──► Python → React
   ◄── HandleMessage() ◄────────── RuntimeGMClient.ProcessPacket() ◄─TCP──
```

**改造后（Lua Runtime）:**
```
[Unity C# Editor]              [XMain.lua]                         [EncyHub]
AnimatorTracker ─┐                │                                   │
AnimatorDataService ─┤ (仅EditorWindow用)                             │
AnimatorTcpBridge ───┘            │                                   │
                                  │                                   │
                     LuaAnimatorMonitor ──► RuntimeGMClient ──TCP──► Python → React
                     (纯Lua数据采集)        (消息收发)            (无需改动)
```

### 3.2 新增 Lua 模块: `LuaAnimatorMonitor`

嵌入 `XMain.lua` 的 `RuntimeGMClient` 内部（与现有 GM 逻辑同级），主要职责：

1. **场景扫描** — 定期扫描所有 Animator 对象
2. **状态快照** — 采集指定 Animator 的各层状态、转场、Clip 信息
3. **参数采集** — 读取所有参数当前值
4. **状态变化检测** — 帧间 hash 比较 + IsInTransition 双重检测
5. **消息处理** — 响应 ANIM_LIST / ANIM_SUBSCRIBE / ANIM_UNSUBSCRIBE / ANIM_SET_PARAM
6. **数据序列化** — 构造与现有 C# 版完全一致的 JSON 格式

### 3.3 数据结构（JSON 格式保持一致）

#### ANIM_LIST_RESP
```json
{
  "type": "ANIM_LIST_RESP",
  "animators": [
    { "id": 12345, "name": "Player", "controllerName": "PlayerController" }
  ]
}
```

#### ANIM_DATA
```json
{
  "type": "ANIM_DATA",
  "snapshot": {
    "animatorId": 12345,
    "gameObjectName": "Player",
    "controllerName": "PlayerController",
    "timestamp": 123.456,
    "layers": [
      {
        "index": 0,
        "name": "Base Layer",
        "weight": 1.0,
        "currentState": {
          "nameHash": 12345,
          "name": "Idle",
          "normalizedTime": 0.5,
          "length": 1.2,
          "speed": 1.0,
          "isLooping": true
        },
        "transition": {
          "isInTransition": false,
          "normalizedTime": 0,
          "duration": 0
        },
        "currentClips": [
          { "clipName": "Idle_01", "clipLength": 1.2, "clipWeight": 1.0 }
        ]
      }
    ],
    "parameters": [
      { "name": "Speed", "type": "Float", "floatValue": 0.0, "intValue": 0, "boolValue": false }
    ]
  },
  "stateChanges": [
    { "layerName": "Base Layer", "fromState": "Idle", "toState": "Walk", "timestamp": 123.4 }
  ]
}
```

## 4. 实施计划

### Phase 1: Lua 数据采集模块（核心）

**文件**: `XMain.lua` 内 `RuntimeGMClient` 代码块

**新增内容**:

```
LuaAnimatorMonitor = {}
LuaAnimatorMonitor._trackers = {}           -- instanceId → tracker
LuaAnimatorMonitor._subscribedId = -1       -- 当前订阅的 animator id
LuaAnimatorMonitor._scanTimer = 0
LuaAnimatorMonitor._pushTimer = 0
LuaAnimatorMonitor._scanInterval = 2.0      -- 扫描间隔(秒)
LuaAnimatorMonitor._pushInterval = 0.1      -- 推送间隔(秒)
```

**需要实现的函数**:

| 函数 | 说明 |
|------|------|
| `ScanAnimators()` | 遍历场景找所有Animator，创建/清理tracker |
| `CreateTracker(animator)` | 为单个Animator创建跟踪器，初始化hash缓存和clip名称映射 |
| `DiscoverStates(tracker)` | 用animationClips + HasState发现所有状态（对应C#的DiscoverAllStates） |
| `TakeSnapshot(tracker)` | 采集完整快照数据 |
| `DetectStateChanges(tracker)` | 检测状态变化，记录到历史 |
| `HandleAnimCommand(packet)` | 处理ANIM_LIST/SUBSCRIBE/UNSUBSCRIBE/SET_PARAM |
| `Update(dt)` | 每帧调用，扫描+推送节流 |

### Phase 2: RuntimeGMClient 集成

**修改内容**:

1. `ProcessPacket()` 中 `ANIM_*` 分支：
   - **改造前**: 转发给 `CS.AnimatorLiveMonitor.AnimatorTcpBridge.HandleMessage(line)`
   - **改造后**: 直接调用 `LuaAnimatorMonitor.HandleAnimCommand(packet)`

2. `Update()` 中轮询 ANIM 消息的逻辑：
   - **改造前**: `CS.AnimatorLiveMonitor.AnimatorTcpBridge.PollOutgoingMessage()`
   - **改造后**: `LuaAnimatorMonitor.Update(dt)` 直接通过 `RuntimeGMClient.Send()` 发送

3. 移除 C# `AnimatorTcpBridge` 的 Lua 调用代码

### Phase 3: 兼容性保留

1. **Unity EditorWindow 不受影响** — 它直接使用 C# `AnimatorDataService`，不走 TCP
2. **C# Editor 代码全部保留** — 仅移除 Lua 对它的调用依赖
3. **EncyHub 前后端零修改** — JSON 格式完全一致

## 5. 关键实现细节

### 5.1 状态名称解析（hash → name）

AB 加载的 Controller 无法通过 Editor API 获取状态名。Lua 版采用与 C# 修复后相同的策略：

```lua
-- 1. 从animationClips获取候选名称
local clips = animator.runtimeAnimatorController.animationClips
for i = 0, clips.Length - 1 do
    local clip = clips[i]
    if clip and clip.name then
        candidateNames[clip.name] = true
    end
end

-- 2. 用HasState验证是否存在于各layer
for name, _ in pairs(candidateNames) do
    local hash = CS.UnityEngine.Animator.StringToHash(name)
    if animator:HasState(layer, hash) then
        tracker.stateNameCache[hash] = name
    end
end

-- 3. 运行时补充：从GetCurrentAnimatorClipInfo获取clip名称
local clipInfos = animator:GetCurrentAnimatorClipInfo(layer)
if clipInfos.Length > 0 then
    local clipName = clipInfos[0].clip.name
    tracker.stateNameCache[stateHash] = clipName
end
```

### 5.2 状态变化检测（双重检测）

与 C# 修复后的逻辑一致，采用 hash 比较 + IsInTransition 双重检测：

```lua
-- 方式1: 帧间hash比较（捕获已完成的状态切换）
if lastHash ~= currentHash and lastHash ~= 0 then
    recordStateChange(layer, lastHash, currentHash)
end

-- 方式2: IsInTransition检测（捕获进行中的状态切换 — 修复了C#侧的关键bug）
if animator:IsInTransition(layer) then
    local nextInfo = animator:GetNextAnimatorStateInfo(layer)
    recordStateChange(layer, currentHash, nextInfo.shortNameHash)
end
```

### 5.3 性能控制

| 操作 | 频率 | 说明 |
|------|------|------|
| ScanAnimators | 每2秒 | 不订阅时不扫描 |
| TakeSnapshot + DetectStateChanges | 每0.1秒 | 仅对已订阅的1个Animator |
| 数据发送 | 每0.1秒 | 仅在有订阅时发送 |

### 5.4 XLua 注意事项

- `FindObjectsOfType` 返回的是 C# 数组，Lua 中用 `arr[i]`（0-based）或 `arr:GetValue(i)` 访问
- `AnimatorStateInfo` 是值类型(struct)，XLua 会自动装箱
- `AnimatorClipInfo[]` 需要注意 GC 压力，控制调用频率
- 避免每帧创建 table，尽量复用

## 6. 测试计划

### 6.1 Editor 模式测试
- [ ] EncyHub Animator 标签页正常显示 Animator 列表
- [ ] 订阅后能看到实时状态、转场、参数
- [ ] 状态历史正确记录
- [ ] 参数修改生效
- [ ] Unity EditorWindow 功能不受影响

### 6.2 真机测试
- [ ] 真机连接 EncyHub 后能看到 Animator 列表
- [ ] 订阅后实时状态正常显示
- [ ] 状态切换时历史记录正确
- [ ] 参数修改在真机上生效

### 6.3 回归测试
- [ ] GM Console 核心功能（Lua执行、GM按钮）不受影响
- [ ] RuntimeGMClient 连接/重连/断开正常
- [ ] 无额外性能开销（未订阅时零消耗）

## 7. 风险评估

| 风险 | 级别 | 缓解措施 |
|------|------|---------|
| XLua 对 Animator API 的绑定可能缺失 | 低 | Animator 是常用类，XLua 默认生成绑定 |
| 值类型(struct) GC 压力 | 中 | 控制采集频率，仅订阅时采集 |
| FindObjectsOfType 性能 | 低 | 每2秒一次，与C#版一致 |
| JSON序列化性能 | 低 | 使用项目已有的 Json 库，数据量小 |
| 与现有 C# 代码冲突 | 无 | C# 代码保留不动，仅切断 Lua→C# 调用链 |

## 8. 交付物

### 8.1 修改文件清单

| 文件路径 | 操作 | 改动内容 |
|---------|------|---------|
| `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` | **修改** | 1. RuntimeGMClient 内新增 `LuaAnimatorMonitor` 模块（约200行）<br>2. `ProcessPacket()` 中 ANIM_* 分支改为调用 Lua 模块<br>3. `Update()` 中移除 C# PollOutgoingMessage 调用，改为 LuaAnimatorMonitor.Update() |

### 8.2 不动文件清单

| 文件路径 | 说明 |
|---------|------|
| `Dev/Client/Assets/Editor/AnimatorTools/ClientAnimator/*.cs` | C# Editor 代码全部保留，EditorWindow 继续使用 |
| `E:\Such_Proj\Other\EncyHub\tools\gm_console\*.py` | Python 后端零修改 |
| `E:\Such_Proj\Other\EncyHub\frontend\src\pages\AnimatorViewer.jsx` | React 前端零修改 |
| `E:\Such_Proj\Other\EncyHub\frontend\src\pages\GmConsole.jsx` | GM Console 页面零修改 |

### 8.3 移除内容

| 位置 | 移除内容 | 替代方案 |
|------|---------|---------|
| `XMain.lua` RuntimeGMClient.Update() | `CS.AnimatorLiveMonitor.AnimatorTcpBridge.PollOutgoingMessage()` 调用 | `LuaAnimatorMonitor.Update(dt)` |
| `XMain.lua` RuntimeGMClient.ProcessPacket() | `CS.AnimatorLiveMonitor.AnimatorTcpBridge.HandleMessage(line)` 调用 | `LuaAnimatorMonitor.HandleCommand(packet)` |
