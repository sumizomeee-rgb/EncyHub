# Animator Live Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runtime Animator state viewer that works with AB-loaded resources, delivering both a Unity EditorWindow and a Web-based viewer integrated into EncyHub GM Console.

**Architecture:** Shared C# data collection layer (`AnimatorDataService`) feeds two frontends: EditorWindow reads directly, Web viewer receives data via TCP:12581 bridge (Lua thin-forward to C#) → EncyHub GM Console (FastAPI + WebSocket) → React dashboard.

**Tech Stack:** C# (Unity Editor IMGUI), Lua (XMain.lua TCP extension), Python (FastAPI + asyncio), React 18 + Tailwind CSS 4

**Spec:** `E:\Such_Proj\Other\EncyHub\requirement_doc\20_施工方案书_AnimatorViewer_运行时动画状态查看器.md`

---

## File Map

### C# Files (Create)

All under `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\`:

| File | Responsibility |
|------|---------------|
| `AnimatorDataSnapshot.cs` | Serializable data structures for snapshot, layer, state, transition, clip, parameter |
| `AnimatorGraphExtractor.cs` | Extract state machine graph from AnimatorController (Editor API), build hash→name map, handle AnimatorOverrideController |
| `AnimatorTracker.cs` | Track single Animator, take snapshots with null-safety, detect state changes |
| `AnimatorDataService.cs` | Singleton service, manage trackers, scene scanning, web subscription control |
| `AnimatorTcpBridge.cs` | Static class, handle ANIM_* messages from Lua, queue outgoing messages, Update-driven push |
| `AnimatorViewerGraphRenderer.cs` | IMGUI graph renderer with cached layout, viewport culling, zoom/pan |
| `AnimatorViewerEditorWindow.cs` | EditorWindow with MenuItem, left panel (list+params), center (graph), bottom (clip timeline) |

### C# Files (Existing, no modify)

| File | Note |
|------|------|
| `XClientAnimatorEditor.cs` | Keep as-is, not deprecated yet |

### Lua Files (Modify)

| File | Change |
|------|--------|
| `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` | Add ANIM_* message forwarding in `ProcessPacket()` (~line 611) and outgoing poll in `Update()` (~line 583) |

### Python Files (Modify)

| File | Change |
|------|--------|
| `E:\Such_Proj\Other\EncyHub\tools\gm_console\server_mgr.py` | Add ANIM_* packet types in `_process_packet()`, add animator WebSocket broadcast, add send helpers |
| `E:\Such_Proj\Other\EncyHub\tools\gm_console\main.py` | Add `/animators` routes, `/ws/animator` WebSocket endpoint |

### React Files (Create)

All under `E:\Such_Proj\Other\EncyHub\frontend\src\pages\`:

| File | Responsibility |
|------|---------------|
| `AnimatorViewer.jsx` | Main Animator Viewer panel component (selector + dashboard + history) |

### React Files (Modify)

| File | Change |
|------|--------|
| `E:\Such_Proj\Other\EncyHub\frontend\src\pages\GmConsole.jsx` | Add "Animator" tab button and render AnimatorViewer component |

---

## Phase 1: C# Data Collection Layer + EditorWindow

### Task 1.1: Data Structures (`AnimatorDataSnapshot.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorDataSnapshot.cs`

- [ ] **Step 1: Create the snapshot data structures file**

```csharp
using System;
using System.Collections.Generic;

namespace AnimatorLiveMonitor
{
    [Serializable]
    public class AnimatorBriefInfo
    {
        public int id;
        public string name;
        public string controllerName;
    }

    [Serializable]
    public class AnimatorDataSnapshot
    {
        public int animatorId;
        public string gameObjectName;
        public string controllerName;
        public float timestamp;
        public List<LayerSnapshot> layers;
        public List<ParameterSnapshot> parameters;
    }

    [Serializable]
    public class LayerSnapshot
    {
        public int index;
        public string name;
        public float weight;
        public StateSnapshot currentState;
        public StateSnapshot nextState;
        public TransitionSnapshot transition;
        public List<ClipSnapshot> currentClips;
    }

    [Serializable]
    public class StateSnapshot
    {
        public int nameHash;
        public string name;
        public float normalizedTime;
        public float length;
        public float speed;
        public bool isLooping;
    }

    [Serializable]
    public class TransitionSnapshot
    {
        public bool isInTransition;
        public float normalizedTime;
        public float duration;
        public string sourceName;
        public string targetName;
    }

    [Serializable]
    public class ClipSnapshot
    {
        public string clipName;
        public float clipLength;
        public float clipWeight;
    }

    [Serializable]
    public class ParameterSnapshot
    {
        public string name;
        public string type; // "Float", "Int", "Bool", "Trigger"
        public float floatValue;
        public int intValue;
        public bool boolValue;
    }

    // Graph data for EditorWindow visualization
    [Serializable]
    public class AnimatorGraphData
    {
        public int layerIndex;
        public string layerName;
        public List<GraphNodeData> nodes;
        public List<GraphTransitionData> transitions;
        public List<GraphNodeData> anyStateTransitions;
    }

    [Serializable]
    public class GraphNodeData
    {
        public string name;
        public int nameHash;
        public float posX;
        public float posY;
        public bool isDefault;
        public string motion; // clip or blendtree name
        public bool isSubStateMachine;
    }

    [Serializable]
    public class GraphTransitionData
    {
        public string sourceName;
        public string targetName;
        public bool hasExitTime;
        public float exitTime;
        public float duration;
        public List<string> conditions;
    }
}
```

- [ ] **Step 2: Verify file compiles in Unity**

Open Unity, wait for compilation. Check Console for errors in `AnimatorDataSnapshot.cs`.

---

### Task 1.2: Graph Extractor (`AnimatorGraphExtractor.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorGraphExtractor.cs`

- [ ] **Step 1: Create the graph extractor**

```csharp
using System.Collections.Generic;
using UnityEditor.Animations;
using UnityEngine;

namespace AnimatorLiveMonitor
{
    public static class AnimatorGraphExtractor
    {
        /// <summary>
        /// 从 RuntimeAnimatorController 提取完整状态机图谱（支持 AB 加载和 OverrideController）
        /// </summary>
        public static List<AnimatorGraphData> Extract(RuntimeAnimatorController controller)
        {
            var ac = GetAnimatorController(controller);
            if (ac == null) return null;

            var result = new List<AnimatorGraphData>();
            for (int i = 0; i < ac.layers.Length; i++)
            {
                var layer = ac.layers[i];
                var graphData = new AnimatorGraphData
                {
                    layerIndex = i,
                    layerName = layer.name,
                    nodes = new List<GraphNodeData>(),
                    transitions = new List<GraphTransitionData>(),
                    anyStateTransitions = new List<GraphNodeData>()
                };

                ExtractStateMachine(layer.stateMachine, graphData, "");
                ExtractAnyStateTransitions(layer.stateMachine, graphData);
                result.Add(graphData);
            }
            return result;
        }

        /// <summary>
        /// 构建 hash → name 映射表（供 AnimatorTracker 使用）
        /// </summary>
        public static Dictionary<int, string> BuildHashToNameMap(RuntimeAnimatorController controller)
        {
            var map = new Dictionary<int, string>();
            var ac = GetAnimatorController(controller);
            if (ac == null) return map;

            foreach (var layer in ac.layers)
            {
                CollectStateNames(layer.stateMachine, map, "");
            }
            return map;
        }

        private static AnimatorController GetAnimatorController(RuntimeAnimatorController controller)
        {
            if (controller is AnimatorController ac)
                return ac;

            if (controller is AnimatorOverrideController overrideCtrl)
            {
                // 递归处理嵌套 Override
                var baseController = overrideCtrl.runtimeAnimatorController;
                return GetAnimatorController(baseController);
            }

            return null;
        }

        private static void ExtractStateMachine(AnimatorStateMachine sm, AnimatorGraphData graphData, string prefix)
        {
            // 提取所有 State
            foreach (var childState in sm.states)
            {
                var state = childState.state;
                var fullName = string.IsNullOrEmpty(prefix) ? state.name : prefix + "." + state.name;
                var node = new GraphNodeData
                {
                    name = fullName,
                    nameHash = Animator.StringToHash(fullName),
                    posX = childState.position.x,
                    posY = childState.position.y,
                    isDefault = sm.defaultState == state,
                    motion = state.motion != null ? state.motion.name : "",
                    isSubStateMachine = false
                };
                graphData.nodes.Add(node);

                // 提取该 State 的所有 Transition
                foreach (var transition in state.transitions)
                {
                    var targetName = transition.destinationState != null
                        ? transition.destinationState.name
                        : (transition.destinationStateMachine != null
                            ? transition.destinationStateMachine.name
                            : "Exit");

                    var conditions = new List<string>();
                    foreach (var cond in transition.conditions)
                    {
                        conditions.Add($"{cond.parameter} {cond.mode} {cond.threshold}");
                    }

                    graphData.transitions.Add(new GraphTransitionData
                    {
                        sourceName = fullName,
                        targetName = targetName,
                        hasExitTime = transition.hasExitTime,
                        exitTime = transition.exitTime,
                        duration = transition.duration,
                        conditions = conditions
                    });
                }
            }

            // 递归处理子状态机
            foreach (var childSm in sm.stateMachines)
            {
                var subSmName = string.IsNullOrEmpty(prefix) ? childSm.stateMachine.name : prefix + "." + childSm.stateMachine.name;
                graphData.nodes.Add(new GraphNodeData
                {
                    name = subSmName,
                    nameHash = Animator.StringToHash(subSmName),
                    posX = childSm.position.x,
                    posY = childSm.position.y,
                    isDefault = false,
                    motion = "",
                    isSubStateMachine = true
                });
                ExtractStateMachine(childSm.stateMachine, graphData, subSmName);
            }
        }

        private static void ExtractAnyStateTransitions(AnimatorStateMachine sm, AnimatorGraphData graphData)
        {
            foreach (var transition in sm.anyStateTransitions)
            {
                var targetName = transition.destinationState != null
                    ? transition.destinationState.name
                    : "Unknown";

                var conditions = new List<string>();
                foreach (var cond in transition.conditions)
                {
                    conditions.Add($"{cond.parameter} {cond.mode} {cond.threshold}");
                }

                graphData.transitions.Add(new GraphTransitionData
                {
                    sourceName = "Any State",
                    targetName = targetName,
                    hasExitTime = transition.hasExitTime,
                    exitTime = transition.exitTime,
                    duration = transition.duration,
                    conditions = conditions
                });
            }
        }

        private static void CollectStateNames(AnimatorStateMachine sm, Dictionary<int, string> map, string prefix)
        {
            foreach (var childState in sm.states)
            {
                var fullName = string.IsNullOrEmpty(prefix) ? childState.state.name : prefix + "." + childState.state.name;
                var hash = Animator.StringToHash(fullName);
                map[hash] = fullName;

                // 同时用短名注册（Unity 有时用 shortNameHash）
                var shortHash = Animator.StringToHash(childState.state.name);
                if (!map.ContainsKey(shortHash))
                    map[shortHash] = childState.state.name;
            }

            foreach (var childSm in sm.stateMachines)
            {
                var subPrefix = string.IsNullOrEmpty(prefix) ? childSm.stateMachine.name : prefix + "." + childSm.stateMachine.name;
                CollectStateNames(childSm.stateMachine, map, subPrefix);
            }
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

Open Unity, check for errors. This file uses `UnityEditor.Animations` namespace which is Editor-only — file is in Editor folder so this is correct.

---

### Task 1.3: Animator Tracker (`AnimatorTracker.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorTracker.cs`

- [ ] **Step 1: Create the tracker**

```csharp
using System.Collections.Generic;
using UnityEngine;

namespace AnimatorLiveMonitor
{
    public class AnimatorTracker
    {
        private Animator _animator;
        private Dictionary<int, string> _stateNameCache;
        private int _instanceId;

        // 上一帧状态，用于检测状态变更
        private int[] _lastStateHashes;

        public int InstanceId => _instanceId;
        public bool IsValid => _animator != null && _animator.gameObject != null && _animator.gameObject.activeInHierarchy;

        public AnimatorTracker(Animator animator)
        {
            _animator = animator;
            _instanceId = animator.GetInstanceID();
            _stateNameCache = AnimatorGraphExtractor.BuildHashToNameMap(animator.runtimeAnimatorController);
            _lastStateHashes = new int[animator.layerCount];
        }

        public AnimatorBriefInfo GetBriefInfo()
        {
            if (!IsValid) return null;
            return new AnimatorBriefInfo
            {
                id = _instanceId,
                name = _animator.gameObject.name.Replace("(Clone)", "").Trim(),
                controllerName = _animator.runtimeAnimatorController != null
                    ? _animator.runtimeAnimatorController.name
                    : "None"
            };
        }

        public AnimatorDataSnapshot TakeSnapshot()
        {
            if (!IsValid) return null;

            var snapshot = new AnimatorDataSnapshot
            {
                animatorId = _instanceId,
                gameObjectName = _animator.gameObject.name.Replace("(Clone)", "").Trim(),
                controllerName = _animator.runtimeAnimatorController != null
                    ? _animator.runtimeAnimatorController.name : "None",
                timestamp = Time.time,
                layers = new List<LayerSnapshot>(),
                parameters = new List<ParameterSnapshot>()
            };

            // 采集各 Layer
            for (int i = 0; i < _animator.layerCount; i++)
            {
                snapshot.layers.Add(TakeLayerSnapshot(i));
            }

            // 采集所有参数
            foreach (var param in _animator.parameters)
            {
                snapshot.parameters.Add(TakeParameterSnapshot(param));
            }

            return snapshot;
        }

        /// <summary>
        /// 检测是否发生了状态变更（供状态历史记录使用）
        /// </summary>
        public List<StateChangeEvent> DetectStateChanges()
        {
            if (!IsValid) return null;

            var changes = new List<StateChangeEvent>();
            for (int i = 0; i < _animator.layerCount; i++)
            {
                var stateInfo = _animator.GetCurrentAnimatorStateInfo(i);
                var currentHash = stateInfo.shortNameHash;

                if (i < _lastStateHashes.Length && _lastStateHashes[i] != currentHash && _lastStateHashes[i] != 0)
                {
                    changes.Add(new StateChangeEvent
                    {
                        layerIndex = i,
                        layerName = _animator.GetLayerName(i),
                        fromState = ResolveStateName(_lastStateHashes[i]),
                        toState = ResolveStateName(currentHash),
                        timestamp = Time.time
                    });
                }

                if (i < _lastStateHashes.Length)
                    _lastStateHashes[i] = currentHash;
            }
            return changes;
        }

        public void SetParameter(string paramName, string paramType, float floatVal, int intVal, bool boolVal)
        {
            if (!IsValid) return;

            switch (paramType)
            {
                case "Float":
                    _animator.SetFloat(paramName, floatVal);
                    break;
                case "Int":
                    _animator.SetInteger(paramName, intVal);
                    break;
                case "Bool":
                    _animator.SetBool(paramName, boolVal);
                    break;
                case "Trigger":
                    _animator.SetTrigger(paramName);
                    break;
            }
        }

        private LayerSnapshot TakeLayerSnapshot(int layerIndex)
        {
            var stateInfo = _animator.GetCurrentAnimatorStateInfo(layerIndex);
            var transInfo = _animator.GetAnimatorTransitionInfo(layerIndex);
            var clipInfos = _animator.GetCurrentAnimatorClipInfo(layerIndex);

            var layer = new LayerSnapshot
            {
                index = layerIndex,
                name = _animator.GetLayerName(layerIndex),
                weight = _animator.GetLayerWeight(layerIndex),
                currentState = new StateSnapshot
                {
                    nameHash = stateInfo.shortNameHash,
                    name = ResolveStateName(stateInfo.shortNameHash),
                    normalizedTime = stateInfo.normalizedTime,
                    length = stateInfo.length,
                    speed = stateInfo.speed,
                    isLooping = stateInfo.loop
                },
                transition = new TransitionSnapshot
                {
                    isInTransition = _animator.IsInTransition(layerIndex),
                    normalizedTime = transInfo.normalizedTime,
                    duration = transInfo.duration
                },
                currentClips = new List<ClipSnapshot>()
            };

            // 过渡目标
            if (_animator.IsInTransition(layerIndex))
            {
                var nextInfo = _animator.GetNextAnimatorStateInfo(layerIndex);
                layer.nextState = new StateSnapshot
                {
                    nameHash = nextInfo.shortNameHash,
                    name = ResolveStateName(nextInfo.shortNameHash),
                    normalizedTime = nextInfo.normalizedTime,
                    length = nextInfo.length,
                    speed = nextInfo.speed,
                    isLooping = nextInfo.loop
                };
                layer.transition.sourceName = layer.currentState.name;
                layer.transition.targetName = layer.nextState.name;
            }

            // Clip 信息
            foreach (var clipInfo in clipInfos)
            {
                layer.currentClips.Add(new ClipSnapshot
                {
                    clipName = clipInfo.clip.name,
                    clipLength = clipInfo.clip.length,
                    clipWeight = clipInfo.weight
                });
            }

            return layer;
        }

        private ParameterSnapshot TakeParameterSnapshot(AnimatorControllerParameter param)
        {
            var snapshot = new ParameterSnapshot { name = param.name };
            switch (param.type)
            {
                case AnimatorControllerParameterType.Float:
                    snapshot.type = "Float";
                    snapshot.floatValue = _animator.GetFloat(param.name);
                    break;
                case AnimatorControllerParameterType.Int:
                    snapshot.type = "Int";
                    snapshot.intValue = _animator.GetInteger(param.name);
                    break;
                case AnimatorControllerParameterType.Bool:
                    snapshot.type = "Bool";
                    snapshot.boolValue = _animator.GetBool(param.name);
                    break;
                case AnimatorControllerParameterType.Trigger:
                    snapshot.type = "Trigger";
                    snapshot.boolValue = _animator.GetBool(param.name);
                    break;
            }
            return snapshot;
        }

        private string ResolveStateName(int hash)
        {
            if (_stateNameCache.TryGetValue(hash, out var name))
                return name;
            return $"Unknown_{hash}";
        }
    }

    public class StateChangeEvent
    {
        public int layerIndex;
        public string layerName;
        public string fromState;
        public string toState;
        public float timestamp;
    }
}
```

- [ ] **Step 2: Verify compilation**

---

### Task 1.4: Data Service (`AnimatorDataService.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorDataService.cs`

- [ ] **Step 1: Create the singleton service**

```csharp
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AnimatorLiveMonitor
{
    public class AnimatorDataService
    {
        private static AnimatorDataService _instance;
        public static AnimatorDataService Instance => _instance ??= new AnimatorDataService();

        private Dictionary<int, AnimatorTracker> _trackers = new Dictionary<int, AnimatorTracker>();

        // Web 订阅状态
        private int _subscribedAnimatorId = -1;
        private bool _isWebSubscribed = false;
        private float _pushInterval = 0.1f; // 10fps
        private float _lastPushTime;
        private float _lastScanTime;
        private float _scanInterval = 2.0f; // 每2秒重新扫描

        // EditorWindow 订阅
        private int _editorSelectedAnimatorId = -1;
        private bool _editorWindowOpen = false;

        // 状态变更历史（供 Web 端使用）
        private List<StateChangeEvent> _recentChanges = new List<StateChangeEvent>();
        private const int MaxHistorySize = 50;

        public void Reset()
        {
            _trackers.Clear();
            _subscribedAnimatorId = -1;
            _isWebSubscribed = false;
            _editorSelectedAnimatorId = -1;
            _recentChanges.Clear();
        }

        // === 场景扫描 ===

        public void ScanSceneAnimators()
        {
            // 找到场景中所有活跃的 Animator
            var allAnimators = Object.FindObjectsOfType<Animator>();

            // 移除已失效的 tracker
            var invalidIds = _trackers
                .Where(kvp => !kvp.Value.IsValid)
                .Select(kvp => kvp.Key)
                .ToList();

            foreach (var id in invalidIds)
            {
                _trackers.Remove(id);
            }

            // 注册新发现的 Animator
            foreach (var animator in allAnimators)
            {
                if (animator.runtimeAnimatorController == null) continue;
                var id = animator.GetInstanceID();
                if (!_trackers.ContainsKey(id))
                {
                    _trackers[id] = new AnimatorTracker(animator);
                }
            }
        }

        // === 追踪管理 ===

        public List<AnimatorBriefInfo> GetAvailableAnimators()
        {
            ScanSceneAnimators();
            var list = new List<AnimatorBriefInfo>();
            foreach (var tracker in _trackers.Values)
            {
                var info = tracker.GetBriefInfo();
                if (info != null) list.Add(info);
            }
            return list;
        }

        // === 数据获取 ===

        public AnimatorDataSnapshot GetSnapshot(int animatorId)
        {
            if (_trackers.TryGetValue(animatorId, out var tracker))
                return tracker.TakeSnapshot();
            return null;
        }

        // === EditorWindow 支持 ===

        public void SetEditorWindowOpen(bool open)
        {
            _editorWindowOpen = open;
        }

        public void SetEditorSelectedAnimator(int animatorId)
        {
            _editorSelectedAnimatorId = animatorId;
        }

        // === Web 推送控制 ===

        public void OnWebSubscribe(int animatorId)
        {
            _subscribedAnimatorId = animatorId;
            _isWebSubscribed = true;
            _lastPushTime = Time.realtimeSinceStartup;
        }

        public void OnWebUnsubscribe()
        {
            _isWebSubscribed = false;
            _subscribedAnimatorId = -1;
        }

        /// <summary>
        /// 每帧调用：定时采集 + 推送 + 检测状态变更
        /// </summary>
        public void Update()
        {
            float now = Time.realtimeSinceStartup;

            // 定期扫描新 Animator
            if (_editorWindowOpen || _isWebSubscribed)
            {
                if (now - _lastScanTime > _scanInterval)
                {
                    _lastScanTime = now;
                    ScanSceneAnimators();
                }
            }

            // Web 推送
            if (_isWebSubscribed && now - _lastPushTime >= _pushInterval)
            {
                _lastPushTime = now;

                if (_trackers.TryGetValue(_subscribedAnimatorId, out var tracker))
                {
                    if (tracker.IsValid)
                    {
                        var snapshot = tracker.TakeSnapshot();
                        var changes = tracker.DetectStateChanges();
                        AnimatorTcpBridge.EnqueueSnapshot(snapshot, changes);
                    }
                    else
                    {
                        // Animator 被销毁
                        AnimatorTcpBridge.EnqueueRemoved(_subscribedAnimatorId);
                        _trackers.Remove(_subscribedAnimatorId);
                        OnWebUnsubscribe();
                    }
                }
            }

            // 检测所有被追踪 Animator 的状态变更（供 EditorWindow 历史面板使用）
            if (_editorWindowOpen)
            {
                foreach (var tracker in _trackers.Values)
                {
                    if (!tracker.IsValid) continue;
                    var changes = tracker.DetectStateChanges();
                    if (changes != null)
                    {
                        _recentChanges.AddRange(changes);
                        while (_recentChanges.Count > MaxHistorySize)
                            _recentChanges.RemoveAt(0);
                    }
                }
            }
        }

        public List<StateChangeEvent> GetRecentChanges() => _recentChanges;
        public void ClearHistory() => _recentChanges.Clear();

        // === 参数编辑 ===

        public void SetParameter(int animatorId, string paramName, string paramType, float floatVal, int intVal, bool boolVal)
        {
            if (_trackers.TryGetValue(animatorId, out var tracker))
            {
                tracker.SetParameter(paramName, paramType, floatVal, intVal, boolVal);
            }
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

---

### Task 1.5: TCP Bridge (`AnimatorTcpBridge.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorTcpBridge.cs`

- [ ] **Step 1: Create the TCP bridge static class**

```csharp
using System.Collections.Generic;
using UnityEngine;

namespace AnimatorLiveMonitor
{
    /// <summary>
    /// Lua 薄转发桥：Lua 调用 HandleMessage 传入 ANIM_* 消息，
    /// C# 处理后将响应放入队列，Lua 通过 PollOutgoingMessage 拉取并发送。
    /// </summary>
    public static class AnimatorTcpBridge
    {
        private static readonly Queue<string> _outgoing = new Queue<string>();
        private static bool _initialized = false;

        public static void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;
            // EditorApplication.update 注册在 EditorWindow 中完成
        }

        /// <summary>
        /// Lua 调用入口：接收 ANIM_* JSON 消息
        /// </summary>
        public static void HandleMessage(string json)
        {
            EnsureInitialized();

            var parsed = JsonUtility.FromJson<TcpMessageHeader>(json);
            if (parsed == null) return;

            switch (parsed.type)
            {
                case "ANIM_LIST":
                    HandleAnimList();
                    break;
                case "ANIM_SUBSCRIBE":
                    var subMsg = JsonUtility.FromJson<AnimSubscribeMessage>(json);
                    HandleSubscribe(subMsg.animatorId);
                    break;
                case "ANIM_UNSUBSCRIBE":
                    HandleUnsubscribe();
                    break;
                case "ANIM_SET_PARAM":
                    var paramMsg = JsonUtility.FromJson<AnimSetParamMessage>(json);
                    HandleSetParam(paramMsg);
                    break;
            }
        }

        /// <summary>
        /// Lua 定时拉取：获取待发送消息，无消息时返回空字符串
        /// </summary>
        public static string PollOutgoingMessage()
        {
            if (_outgoing.Count > 0)
                return _outgoing.Dequeue();
            return "";
        }

        /// <summary>
        /// 由 AnimatorDataService.Update() 调用：将快照入队
        /// </summary>
        public static void EnqueueSnapshot(AnimatorDataSnapshot snapshot, List<StateChangeEvent> changes)
        {
            if (snapshot == null) return;

            var msg = new AnimDataMessage
            {
                type = "ANIM_DATA",
                snapshot = snapshot
            };

            if (changes != null && changes.Count > 0)
            {
                msg.stateChanges = new List<StateChangeEventDto>();
                foreach (var c in changes)
                {
                    msg.stateChanges.Add(new StateChangeEventDto
                    {
                        layerName = c.layerName,
                        fromState = c.fromState,
                        toState = c.toState,
                        timestamp = c.timestamp
                    });
                }
            }

            _outgoing.Enqueue(JsonUtility.ToJson(msg));
        }

        public static void EnqueueRemoved(int animatorId)
        {
            var msg = $"{{\"type\":\"ANIM_REMOVED\",\"animatorId\":{animatorId}}}";
            _outgoing.Enqueue(msg);
        }

        // === 内部处理 ===

        private static void HandleAnimList()
        {
            var animators = AnimatorDataService.Instance.GetAvailableAnimators();
            var resp = new AnimListResponse { type = "ANIM_LIST_RESP", animators = animators };
            _outgoing.Enqueue(JsonUtility.ToJson(resp));
        }

        private static void HandleSubscribe(int animatorId)
        {
            AnimatorDataService.Instance.OnWebSubscribe(animatorId);
        }

        private static void HandleUnsubscribe()
        {
            AnimatorDataService.Instance.OnWebUnsubscribe();
        }

        private static void HandleSetParam(AnimSetParamMessage msg)
        {
            AnimatorDataService.Instance.SetParameter(
                msg.animatorId, msg.paramName, msg.paramType,
                msg.floatValue, msg.intValue, msg.boolValue);
        }

        /// <summary>
        /// EditorApplication.update 回调
        /// </summary>
        public static void EditorUpdate()
        {
            if (!Application.isPlaying) return;
            AnimatorDataService.Instance.Update();
        }

        // === 消息 DTO ===

        [System.Serializable]
        private class TcpMessageHeader { public string type; }

        [System.Serializable]
        private class AnimSubscribeMessage { public string type; public int animatorId; }

        [System.Serializable]
        private class AnimSetParamMessage
        {
            public string type;
            public int animatorId;
            public string paramName;
            public string paramType;
            public float floatValue;
            public int intValue;
            public bool boolValue;
        }

        [System.Serializable]
        private class AnimListResponse
        {
            public string type;
            public List<AnimatorBriefInfo> animators;
        }

        [System.Serializable]
        private class AnimDataMessage
        {
            public string type;
            public AnimatorDataSnapshot snapshot;
            public List<StateChangeEventDto> stateChanges;
        }

        [System.Serializable]
        private class StateChangeEventDto
        {
            public string layerName;
            public string fromState;
            public string toState;
            public float timestamp;
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

---

### Task 1.6: Graph Renderer (`AnimatorViewerGraphRenderer.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorViewerGraphRenderer.cs`

- [ ] **Step 1: Create the IMGUI graph renderer**

```csharp
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AnimatorLiveMonitor
{
    public class AnimatorViewerGraphRenderer
    {
        // 缓存的图谱数据
        private AnimatorGraphData _graphData;
        private Dictionary<string, Rect> _nodeRects = new Dictionary<string, Rect>();

        // 视口控制
        private Vector2 _scrollOffset = Vector2.zero;
        private float _zoom = 1.0f;
        private bool _isDragging = false;
        private Vector2 _dragStart;

        // 节点尺寸
        private const float NodeWidth = 160f;
        private const float NodeHeight = 40f;
        private const float SubSmNodeHeight = 30f;

        // 颜色定义
        private static readonly Color NodeBg = new Color(0.25f, 0.25f, 0.25f, 1f);
        private static readonly Color NodeBorder = new Color(0.5f, 0.5f, 0.5f, 1f);
        private static readonly Color ActiveNodeBg = new Color(0.2f, 0.5f, 0.8f, 1f);
        private static readonly Color TransitionNodeBg = new Color(0.8f, 0.6f, 0.2f, 1f);
        private static readonly Color DefaultNodeBg = new Color(0.6f, 0.35f, 0.1f, 1f);
        private static readonly Color SubSmBg = new Color(0.3f, 0.4f, 0.3f, 1f);
        private static readonly Color TransitionLine = new Color(1f, 1f, 1f, 0.4f);
        private static readonly Color ActiveTransitionLine = new Color(1f, 0.8f, 0.2f, 1f);

        public void SetGraphData(AnimatorGraphData data)
        {
            if (_graphData == data) return;
            _graphData = data;
            RebuildLayout();
        }

        public void Draw(Rect area, AnimatorDataSnapshot snapshot, int layerIndex)
        {
            if (_graphData == null)
            {
                EditorGUI.LabelField(area, "No graph data available", EditorStyles.centeredGreyMiniLabel);
                return;
            }

            // 输入处理：缩放和平移
            HandleInput(area);

            GUI.BeginGroup(area);

            // 绘制背景网格
            DrawGrid(area);

            // 应用变换
            var matrix = GUI.matrix;
            var pivot = new Vector2(area.width / 2, area.height / 2);
            GUIUtility.ScaleAroundPivot(new Vector2(_zoom, _zoom), pivot);

            // 获取当前状态信息
            string currentStateName = null;
            string nextStateName = null;
            float transitionProgress = 0f;
            bool isInTransition = false;

            if (snapshot != null && layerIndex < snapshot.layers.Count)
            {
                var layer = snapshot.layers[layerIndex];
                currentStateName = layer.currentState?.name;
                if (layer.transition != null && layer.transition.isInTransition)
                {
                    isInTransition = true;
                    nextStateName = layer.nextState?.name;
                    transitionProgress = layer.transition.normalizedTime;
                }
            }

            // 绘制过渡连线
            DrawTransitions(currentStateName, nextStateName, isInTransition, transitionProgress);

            // 绘制节点
            DrawNodes(currentStateName, nextStateName);

            GUI.matrix = matrix;
            GUI.EndGroup();
        }

        private void RebuildLayout()
        {
            _nodeRects.Clear();
            if (_graphData == null) return;

            foreach (var node in _graphData.nodes)
            {
                float h = node.isSubStateMachine ? SubSmNodeHeight : NodeHeight;
                _nodeRects[node.name] = new Rect(node.posX + 400, node.posY + 200, NodeWidth, h);
            }
        }

        private void HandleInput(Rect area)
        {
            var e = Event.current;
            if (!area.Contains(e.mousePosition)) return;

            // 滚轮缩放
            if (e.type == EventType.ScrollWheel)
            {
                _zoom -= e.delta.y * 0.05f;
                _zoom = Mathf.Clamp(_zoom, 0.3f, 2.0f);
                e.Use();
            }

            // 中键拖拽平移
            if (e.type == EventType.MouseDown && e.button == 2)
            {
                _isDragging = true;
                _dragStart = e.mousePosition;
                e.Use();
            }
            if (e.type == EventType.MouseDrag && _isDragging)
            {
                var delta = e.mousePosition - _dragStart;
                _scrollOffset += delta;
                _dragStart = e.mousePosition;

                // 更新所有节点位置
                foreach (var key in new List<string>(_nodeRects.Keys))
                {
                    var r = _nodeRects[key];
                    r.x += delta.x / _zoom;
                    r.y += delta.y / _zoom;
                    _nodeRects[key] = r;
                }
                e.Use();
            }
            if (e.type == EventType.MouseUp && e.button == 2)
            {
                _isDragging = false;
                e.Use();
            }
        }

        private void DrawGrid(Rect area)
        {
            float gridSize = 20f * _zoom;
            Handles.color = new Color(0.5f, 0.5f, 0.5f, 0.1f);
            for (float x = 0; x < area.width; x += gridSize)
                Handles.DrawLine(new Vector3(x, 0), new Vector3(x, area.height));
            for (float y = 0; y < area.height; y += gridSize)
                Handles.DrawLine(new Vector3(0, y), new Vector3(area.width, y));
        }

        private void DrawNodes(string currentState, string nextState)
        {
            foreach (var node in _graphData.nodes)
            {
                if (!_nodeRects.TryGetValue(node.name, out var rect)) continue;

                // 确定节点颜色
                Color bg;
                if (node.name == currentState)
                    bg = ActiveNodeBg;
                else if (node.name == nextState)
                    bg = TransitionNodeBg;
                else if (node.isDefault)
                    bg = DefaultNodeBg;
                else if (node.isSubStateMachine)
                    bg = SubSmBg;
                else
                    bg = NodeBg;

                // 绘制节点背景
                EditorGUI.DrawRect(rect, bg);
                // 绘制边框
                DrawRectBorder(rect, node.name == currentState ? Color.cyan : NodeBorder);

                // 绘制文本
                var style = new GUIStyle(EditorStyles.label)
                {
                    alignment = TextAnchor.MiddleCenter,
                    normal = { textColor = Color.white },
                    fontSize = 11
                };
                GUI.Label(rect, node.name, style);
            }
        }

        private void DrawTransitions(string currentState, string nextState, bool isInTransition, float progress)
        {
            if (_graphData.transitions == null) return;

            foreach (var trans in _graphData.transitions)
            {
                if (!_nodeRects.TryGetValue(trans.sourceName, out var srcRect)) continue;
                if (!_nodeRects.TryGetValue(trans.targetName, out var dstRect)) continue;

                var from = new Vector3(srcRect.center.x, srcRect.center.y, 0);
                var to = new Vector3(dstRect.center.x, dstRect.center.y, 0);

                bool isActive = isInTransition && trans.sourceName == currentState && trans.targetName == nextState;

                Handles.color = isActive ? ActiveTransitionLine : TransitionLine;
                float width = isActive ? 3f : 1f;
                Handles.DrawAAPolyLine(width, from, to);

                // 绘制箭头
                DrawArrow(from, to, Handles.color);

                // 活跃过渡显示进度点
                if (isActive)
                {
                    var progressPoint = Vector3.Lerp(from, to, progress);
                    Handles.color = Color.yellow;
                    Handles.DrawSolidDisc(progressPoint, Vector3.forward, 4f);
                }
            }
        }

        private void DrawArrow(Vector3 from, Vector3 to, Color color)
        {
            var dir = (to - from).normalized;
            var perp = new Vector3(-dir.y, dir.x, 0) * 5f;
            var arrowTip = to - dir * 15f;

            Handles.color = color;
            Handles.DrawAAPolyLine(2f, arrowTip + perp, to, arrowTip - perp);
        }

        private void DrawRectBorder(Rect rect, Color color)
        {
            Handles.color = color;
            var tl = new Vector3(rect.xMin, rect.yMin);
            var tr = new Vector3(rect.xMax, rect.yMin);
            var br = new Vector3(rect.xMax, rect.yMax);
            var bl = new Vector3(rect.xMin, rect.yMax);
            Handles.DrawAAPolyLine(2f, tl, tr, br, bl, tl);
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

---

### Task 1.7: EditorWindow (`AnimatorViewerEditorWindow.cs`)

**Files:**
- Create: `F:\HaruTrunk\Dev\Client\Assets\Editor\AnimatorTools\ClientAnimator\AnimatorViewerEditorWindow.cs`

- [ ] **Step 1: Create the EditorWindow**

```csharp
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AnimatorLiveMonitor
{
    public class AnimatorViewerEditorWindow : EditorWindow
    {
        [MenuItem("Tool/动画/Animator Live Monitor")]
        public static void ShowWindow()
        {
            var window = GetWindow<AnimatorViewerEditorWindow>("Animator Live Monitor");
            window.minSize = new Vector2(800, 500);
            window.Show();
        }

        // 状态
        private List<AnimatorBriefInfo> _animatorList = new List<AnimatorBriefInfo>();
        private int _selectedIndex = -1;
        private int _selectedLayerIndex = 0;
        private string _searchFilter = "";
        private AnimatorDataSnapshot _currentSnapshot;
        private List<AnimatorGraphData> _graphDataCache;
        private AnimatorViewerGraphRenderer _graphRenderer = new AnimatorViewerGraphRenderer();

        // 布局
        private float _leftPanelWidth = 220f;
        private float _bottomPanelHeight = 60f;
        private Vector2 _animatorListScroll;
        private Vector2 _paramScroll;
        private Vector2 _historyScroll;
        private bool _showHistory = false;

        private void OnEnable()
        {
            EditorApplication.update += OnEditorUpdate;
            AnimatorDataService.Instance.SetEditorWindowOpen(true);
            AnimatorTcpBridge.EnsureInitialized();
        }

        private void OnDisable()
        {
            EditorApplication.update -= OnEditorUpdate;
            AnimatorDataService.Instance.SetEditorWindowOpen(false);
        }

        private void OnEditorUpdate()
        {
            if (!Application.isPlaying) return;

            AnimatorTcpBridge.EditorUpdate();

            // 刷新快照
            if (_selectedIndex >= 0 && _selectedIndex < _animatorList.Count)
            {
                _currentSnapshot = AnimatorDataService.Instance.GetSnapshot(_animatorList[_selectedIndex].id);
            }

            Repaint();
        }

        private void OnGUI()
        {
            if (!Application.isPlaying)
            {
                DrawCenteredMessage("请进入 Play 模式后使用 Animator Live Monitor");
                return;
            }

            // 刷新 Animator 列表
            _animatorList = AnimatorDataService.Instance.GetAvailableAnimators();

            EditorGUILayout.BeginHorizontal();

            // 左侧面板
            DrawLeftPanel();

            // 中间分隔线
            GUILayout.Box("", GUILayout.Width(2), GUILayout.ExpandHeight(true));

            // 右侧主区域
            EditorGUILayout.BeginVertical();
            DrawMainArea();
            DrawBottomBar();
            EditorGUILayout.EndVertical();

            EditorGUILayout.EndHorizontal();
        }

        private void DrawLeftPanel()
        {
            EditorGUILayout.BeginVertical(GUILayout.Width(_leftPanelWidth));

            // === Animator 列表 ===
            EditorGUILayout.LabelField("Animator 列表", EditorStyles.boldLabel);

            // 搜索框
            _searchFilter = EditorGUILayout.TextField(_searchFilter, EditorStyles.toolbarSearchField);

            // 刷新按钮
            if (GUILayout.Button("刷新", EditorStyles.miniButton))
            {
                AnimatorDataService.Instance.ScanSceneAnimators();
                _animatorList = AnimatorDataService.Instance.GetAvailableAnimators();
            }

            // 列表
            _animatorListScroll = EditorGUILayout.BeginScrollView(_animatorListScroll, GUILayout.Height(200));
            for (int i = 0; i < _animatorList.Count; i++)
            {
                var info = _animatorList[i];
                if (!string.IsNullOrEmpty(_searchFilter) &&
                    !info.name.ToLower().Contains(_searchFilter.ToLower()))
                    continue;

                var isSelected = _selectedIndex == i;
                var style = isSelected ? EditorStyles.selectionRect : EditorStyles.label;

                if (GUILayout.Button($"{(isSelected ? "● " : "○ ")}{info.name}", style))
                {
                    _selectedIndex = i;
                    _selectedLayerIndex = 0;
                    AnimatorDataService.Instance.SetEditorSelectedAnimator(info.id);

                    // 提取图谱
                    var animator = EditorUtility.InstanceIDToObject(info.id) as Component;
                    if (animator != null)
                    {
                        var anim = (animator as Animator) ?? animator.GetComponent<Animator>();
                        if (anim != null && anim.runtimeAnimatorController != null)
                        {
                            _graphDataCache = AnimatorGraphExtractor.Extract(anim.runtimeAnimatorController);
                        }
                    }
                }
            }
            EditorGUILayout.EndScrollView();

            EditorGUILayout.Space(10);

            // === 参数面板 ===
            DrawParameterPanel();

            EditorGUILayout.EndVertical();
        }

        private void DrawParameterPanel()
        {
            EditorGUILayout.LabelField("Parameters", EditorStyles.boldLabel);

            if (_currentSnapshot == null || _currentSnapshot.parameters == null)
            {
                EditorGUILayout.HelpBox("选择一个 Animator 查看参数", MessageType.Info);
                return;
            }

            _paramScroll = EditorGUILayout.BeginScrollView(_paramScroll);

            foreach (var param in _currentSnapshot.parameters)
            {
                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField(param.name, GUILayout.Width(100));
                EditorGUILayout.LabelField(param.type, EditorStyles.miniLabel, GUILayout.Width(40));

                switch (param.type)
                {
                    case "Float":
                        var newFloat = EditorGUILayout.FloatField(param.floatValue);
                        if (newFloat != param.floatValue)
                        {
                            AnimatorDataService.Instance.SetParameter(
                                _currentSnapshot.animatorId, param.name, "Float", newFloat, 0, false);
                        }
                        break;
                    case "Int":
                        var newInt = EditorGUILayout.IntField(param.intValue);
                        if (newInt != param.intValue)
                        {
                            AnimatorDataService.Instance.SetParameter(
                                _currentSnapshot.animatorId, param.name, "Int", 0, newInt, false);
                        }
                        break;
                    case "Bool":
                        var newBool = EditorGUILayout.Toggle(param.boolValue);
                        if (newBool != param.boolValue)
                        {
                            AnimatorDataService.Instance.SetParameter(
                                _currentSnapshot.animatorId, param.name, "Bool", 0, 0, newBool);
                        }
                        break;
                    case "Trigger":
                        if (GUILayout.Button("Fire", EditorStyles.miniButton, GUILayout.Width(40)))
                        {
                            AnimatorDataService.Instance.SetParameter(
                                _currentSnapshot.animatorId, param.name, "Trigger", 0, 0, true);
                        }
                        break;
                }

                EditorGUILayout.EndHorizontal();
            }

            EditorGUILayout.EndScrollView();
        }

        private void DrawMainArea()
        {
            if (_currentSnapshot == null)
            {
                DrawCenteredMessage("从左侧选择一个 Animator");
                return;
            }

            // Layer 选择栏
            if (_currentSnapshot.layers != null && _currentSnapshot.layers.Count > 0)
            {
                EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
                for (int i = 0; i < _currentSnapshot.layers.Count; i++)
                {
                    var layer = _currentSnapshot.layers[i];
                    var isActive = _selectedLayerIndex == i;
                    if (GUILayout.Toggle(isActive, layer.name, EditorStyles.toolbarButton))
                    {
                        if (!isActive)
                        {
                            _selectedLayerIndex = i;
                            if (_graphDataCache != null && i < _graphDataCache.Count)
                            {
                                _graphRenderer.SetGraphData(_graphDataCache[i]);
                            }
                        }
                    }
                }

                // 过渡信息
                var currentLayer = _currentSnapshot.layers[_selectedLayerIndex];
                if (currentLayer.transition != null && currentLayer.transition.isInTransition)
                {
                    GUILayout.FlexibleSpace();
                    var progress = currentLayer.transition.normalizedTime;
                    EditorGUILayout.LabelField(
                        $"Transition: {Mathf.RoundToInt(progress * 100)}%",
                        GUILayout.Width(120));
                    var rect = GUILayoutUtility.GetRect(100, 16);
                    EditorGUI.ProgressBar(rect, progress, "");
                }

                // 历史按钮
                GUILayout.FlexibleSpace();
                _showHistory = GUILayout.Toggle(_showHistory, "History", EditorStyles.toolbarButton);

                EditorGUILayout.EndHorizontal();
            }

            // 图谱区域
            if (_showHistory)
            {
                DrawHistory();
            }
            else
            {
                var graphRect = GUILayoutUtility.GetRect(10, 10, GUILayout.ExpandWidth(true), GUILayout.ExpandHeight(true));
                if (_graphDataCache != null && _selectedLayerIndex < _graphDataCache.Count)
                {
                    _graphRenderer.SetGraphData(_graphDataCache[_selectedLayerIndex]);
                }
                _graphRenderer.Draw(graphRect, _currentSnapshot, _selectedLayerIndex);
            }
        }

        private void DrawBottomBar()
        {
            if (_currentSnapshot == null) return;
            if (_selectedLayerIndex >= _currentSnapshot.layers.Count) return;

            var layer = _currentSnapshot.layers[_selectedLayerIndex];

            EditorGUILayout.BeginHorizontal(EditorStyles.helpBox, GUILayout.Height(_bottomPanelHeight));

            // 状态信息
            EditorGUILayout.LabelField($"State: {layer.currentState?.name ?? "None"}", EditorStyles.boldLabel, GUILayout.Width(200));

            // Clip 进度条
            if (layer.currentClips != null && layer.currentClips.Count > 0)
            {
                var clip = layer.currentClips[0];
                var currentTime = layer.currentState != null ? layer.currentState.normalizedTime * clip.clipLength : 0;
                var progress = clip.clipLength > 0 ? currentTime / clip.clipLength : 0;

                EditorGUILayout.BeginVertical();
                EditorGUILayout.LabelField($"Clip: {clip.clipName}  {currentTime:F2}/{clip.clipLength:F2}s  Speed: {layer.currentState?.speed:F1}x");
                var rect = GUILayoutUtility.GetRect(200, 14, GUILayout.ExpandWidth(true));
                EditorGUI.ProgressBar(rect, progress % 1f, "");
                EditorGUILayout.EndVertical();
            }

            EditorGUILayout.EndHorizontal();
        }

        private void DrawHistory()
        {
            EditorGUILayout.BeginVertical();

            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("State History", EditorStyles.boldLabel);
            if (GUILayout.Button("Clear", EditorStyles.miniButton, GUILayout.Width(50)))
            {
                AnimatorDataService.Instance.ClearHistory();
            }
            EditorGUILayout.EndHorizontal();

            _historyScroll = EditorGUILayout.BeginScrollView(_historyScroll, GUILayout.ExpandHeight(true));

            // 表头
            EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
            EditorGUILayout.LabelField("Time", GUILayout.Width(60));
            EditorGUILayout.LabelField("From", GUILayout.Width(120));
            EditorGUILayout.LabelField("To", GUILayout.Width(120));
            EditorGUILayout.LabelField("Layer", GUILayout.Width(100));
            EditorGUILayout.EndHorizontal();

            var history = AnimatorDataService.Instance.GetRecentChanges();
            for (int i = history.Count - 1; i >= 0; i--)
            {
                var entry = history[i];
                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField($"{entry.timestamp:F1}", GUILayout.Width(60));
                EditorGUILayout.LabelField(entry.fromState, GUILayout.Width(120));
                EditorGUILayout.LabelField(entry.toState, GUILayout.Width(120));
                EditorGUILayout.LabelField(entry.layerName, GUILayout.Width(100));
                EditorGUILayout.EndHorizontal();
            }

            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();
        }

        private void DrawCenteredMessage(string message)
        {
            GUILayout.FlexibleSpace();
            EditorGUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            EditorGUILayout.LabelField(message, EditorStyles.centeredGreyMiniLabel, GUILayout.Width(400));
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();
            GUILayout.FlexibleSpace();
        }
    }
}
```

- [ ] **Step 2: Verify compilation in Unity**

- [ ] **Step 3: Manual smoke test**

1. Open Unity Editor
2. Menu → Tool → 动画 → Animator Live Monitor
3. Verify: Window opens, shows "请进入 Play 模式后使用 Animator Live Monitor"
4. Enter Play Mode
5. Verify: Animator list populates with scene animators
6. Select an animator
7. Verify: Graph renders, parameters display, clip timeline shows

**Phase 1 checkpoint: EditorWindow fully functional before proceeding.**

---

## Phase 2: TCP Protocol Extension + Web Backend

### Task 2.1: Lua TCP Bridge Integration

**Files:**
- Modify: `F:\HaruTrunk\Product\Lua\Matrix\XMain.lua` (lines ~583 and ~611)

- [ ] **Step 1: Add ANIM_* message forwarding in ProcessPacket**

In `XMain.lua`, locate `RuntimeGMClient.ProcessPacket()` (line ~585). After the existing `EXEC_GM` handler (line ~610), add:

```lua
    elseif type and type:sub(1, 5) == "ANIM_" then
        -- 转发给 C# AnimatorTcpBridge 处理
        local ok, err = pcall(function()
            CS.AnimatorLiveMonitor.AnimatorTcpBridge.HandleMessage(line)
        end)
        if not ok then
            origin_print("[RuntimeGM] ANIM bridge error: " .. tostring(err))
        end
```

- [ ] **Step 2: Add outgoing message polling in Update**

In `RuntimeGMClient.Update()` (line ~536), at the end of the function (before the final `end`), add:

```lua
    -- 拉取 C# 侧待发送的 ANIM 消息
    if RuntimeGMClient.Socket then
        local pollOk, pollResult = pcall(function()
            return CS.AnimatorLiveMonitor.AnimatorTcpBridge.PollOutgoingMessage()
        end)
        if pollOk and pollResult and #pollResult > 0 then
            local sendOk, sendErr = pcall(function()
                RuntimeGMClient.Socket:settimeout(0.05)
                RuntimeGMClient.Socket:send(pollResult .. "\n")
            end)
            if not sendOk then
                local errStr = tostring(sendErr)
                if errStr:find("closed") or errStr:find("refused") then
                    RuntimeGMClient.Close()
                end
            end
        end
    end
```

- [ ] **Step 3: Verify in Unity Play Mode**

Enter Play mode, check Unity Console for no Lua errors related to `AnimatorTcpBridge`.

---

### Task 2.2: GM Console Backend - ServerMgr Extension

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\tools\gm_console\server_mgr.py`

- [ ] **Step 1: Add ANIM message handling to _process_packet**

In `server_mgr.py`, locate `_process_packet()` (line ~214). Add new type handlers after the existing `GM_LIST` handler:

Add to the Client dataclass or store in ServerMgr:
```python
# Add these instance variables to ServerMgr.__init__():
self._animator_list_cache = {}      # client_id -> animator list
self._animator_ws_clients = set()   # WebSocket connections subscribed to animator data
self.on_animator_data = None        # Callback for ANIM_DATA
self.on_animator_list = None        # Callback for ANIM_LIST_RESP
self.on_animator_removed = None     # Callback for ANIM_REMOVED
```

Add to `_process_packet()` method:
```python
        elif t == "ANIM_LIST_RESP":
            self._animator_list_cache[cid] = pkt.get("animators", [])
            if self.on_animator_list:
                self.on_animator_list(cid, self._animator_list_cache[cid])
        elif t == "ANIM_DATA":
            if self.on_animator_data:
                self.on_animator_data(cid, pkt)
        elif t == "ANIM_REMOVED":
            if self.on_animator_removed:
                self.on_animator_removed(cid, pkt.get("animatorId"))
```

- [ ] **Step 2: Add send helpers for ANIM messages**

Add these methods to the `ServerMgr` class:

```python
    async def send_anim_list_request(self, client_id: str):
        """向游戏客户端请求 Animator 列表"""
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_LIST"}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_LIST failed: {e}", client_id)

    async def send_anim_subscribe(self, client_id: str, animator_id: int):
        """订阅某个 Animator 的数据"""
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_SUBSCRIBE", "animatorId": animator_id}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_SUBSCRIBE failed: {e}", client_id)

    async def send_anim_unsubscribe(self, client_id: str):
        """取消订阅"""
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_UNSUBSCRIBE"}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_UNSUBSCRIBE failed: {e}", client_id)

    async def send_anim_set_param(self, client_id: str, animator_id: int, param_name: str, param_type: str, float_val: float = 0, int_val: int = 0, bool_val: bool = False):
        """远程修改 Animator 参数"""
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({
            "type": "ANIM_SET_PARAM",
            "animatorId": animator_id,
            "paramName": param_name,
            "paramType": param_type,
            "floatValue": float_val,
            "intValue": int_val,
            "boolValue": bool_val
        }) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_SET_PARAM failed: {e}", client_id)

    def get_cached_animator_list(self, client_id: str):
        """获取缓存的 Animator 列表"""
        return self._animator_list_cache.get(client_id, [])
```

---

### Task 2.3: GM Console Backend - API Routes

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\tools\gm_console\main.py`

- [ ] **Step 1: Add Animator API routes and WebSocket**

Add these routes to `main.py`, after the existing custom-gm routes:

```python
# === Animator Viewer API ===

animator_ws_connections: list = []

async def broadcast_animator_event(data: dict):
    """推送 Animator 数据到所有订阅的 WebSocket"""
    dead = []
    for ws in animator_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        animator_ws_connections.remove(ws)

@app.get("/animators/{client_id}")
async def get_animators(client_id: str):
    """请求指定客户端的 Animator 列表"""
    await server_mgr.send_anim_list_request(client_id)
    # 等待短暂时间让游戏响应
    await asyncio.sleep(0.3)
    animators = server_mgr.get_cached_animator_list(client_id)
    return {"animators": animators}

@app.post("/animators/{client_id}/subscribe/{animator_id}")
async def subscribe_animator(client_id: str, animator_id: int):
    """订阅某个 Animator 的实时数据"""
    await server_mgr.send_anim_subscribe(client_id, animator_id)
    return {"status": "subscribed", "animatorId": animator_id}

@app.post("/animators/{client_id}/unsubscribe")
async def unsubscribe_animator(client_id: str):
    """取消订阅"""
    await server_mgr.send_anim_unsubscribe(client_id)
    return {"status": "unsubscribed"}

@app.post("/animators/{client_id}/set-param/{animator_id}")
async def set_animator_param(client_id: str, animator_id: int, request: Request):
    """远程修改 Animator 参数"""
    body = await request.json()
    await server_mgr.send_anim_set_param(
        client_id, animator_id,
        body.get("paramName", ""),
        body.get("paramType", ""),
        body.get("floatValue", 0),
        body.get("intValue", 0),
        body.get("boolValue", False)
    )
    return {"status": "sent"}

@app.websocket("/ws/animator")
async def websocket_animator(websocket: WebSocket):
    """Animator 数据专用 WebSocket 通道"""
    await websocket.accept()
    animator_ws_connections.append(websocket)
    try:
        while True:
            # 保持连接，接收心跳
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in animator_ws_connections:
            animator_ws_connections.remove(websocket)
```

- [ ] **Step 2: Register ANIM callbacks**

In `main.py`, where other callbacks are registered (after `server_mgr.on_log = ...`), add:

```python
# Animator data callbacks
def on_animator_data(client_id, pkt):
    asyncio.create_task(broadcast_animator_event({
        "type": "animator_data",
        "client_id": client_id,
        "snapshot": pkt.get("snapshot"),
        "stateChanges": pkt.get("stateChanges")
    }))

def on_animator_list(client_id, animators):
    asyncio.create_task(broadcast_animator_event({
        "type": "animator_list",
        "client_id": client_id,
        "animators": animators
    }))

def on_animator_removed(client_id, animator_id):
    asyncio.create_task(broadcast_animator_event({
        "type": "animator_removed",
        "client_id": client_id,
        "animatorId": animator_id
    }))

server_mgr.on_animator_data = on_animator_data
server_mgr.on_animator_list = on_animator_list
server_mgr.on_animator_removed = on_animator_removed
```

- [ ] **Step 3: Add missing imports**

Ensure these imports exist at the top of `main.py`:
```python
import asyncio
from starlette.requests import Request
from starlette.websockets import WebSocket, WebSocketDisconnect
```

- [ ] **Step 4: Verify backend starts**

```bash
cd E:/Such_Proj/Other/EncyHub && python -c "from tools.gm_console.main import app; print('Import OK')"
```

**Phase 2 checkpoint: TCP protocol + Web API functional before proceeding.**

---

## Phase 3: React Frontend

### Task 3.1: AnimatorViewer Component

**Files:**
- Create: `E:\Such_Proj\Other\EncyHub\frontend\src\pages\AnimatorViewer.jsx`

- [ ] **Step 1: Create the AnimatorViewer component**

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { Activity, RefreshCw, Trash2, Play, ChevronRight } from 'lucide-react'

export default function AnimatorViewer({ clients, selectedClient, broadcastMode }) {
  // 状态
  const [animators, setAnimators] = useState([])
  const [selectedAnimator, setSelectedAnimator] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [stateHistory, setStateHistory] = useState([])
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [paramSearch, setParamSearch] = useState('')

  const wsRef = useRef(null)
  const historyRef = useRef([])

  // 获取 Animator 列表
  const fetchAnimators = useCallback(async () => {
    if (!selectedClient) return
    try {
      const res = await fetch(`/api/gm_console/animators/${selectedClient.id}`)
      if (res.ok) {
        const data = await res.json()
        setAnimators(data.animators || [])
      }
    } catch (e) {
      console.error('Failed to fetch animators:', e)
    }
  }, [selectedClient])

  // 订阅 Animator
  const subscribe = useCallback(async (animatorId) => {
    if (!selectedClient) return

    // 先取消旧订阅
    if (selectedAnimator) {
      await fetch(`/api/gm_console/animators/${selectedClient.id}/unsubscribe`, { method: 'POST' })
    }

    // 订阅新的
    await fetch(`/api/gm_console/animators/${selectedClient.id}/subscribe/${animatorId}`, { method: 'POST' })
    setSelectedAnimator(animatorId)
    setSnapshot(null)
    historyRef.current = []
    setStateHistory([])
  }, [selectedClient, selectedAnimator])

  // 取消订阅
  const unsubscribe = useCallback(async () => {
    if (!selectedClient) return
    await fetch(`/api/gm_console/animators/${selectedClient.id}/unsubscribe`, { method: 'POST' })
    setSelectedAnimator(null)
    setSnapshot(null)
  }, [selectedClient])

  // 修改参数
  const setParam = useCallback(async (paramName, paramType, value) => {
    if (!selectedClient || !selectedAnimator) return
    const body = {
      paramName,
      paramType,
      floatValue: paramType === 'Float' ? value : 0,
      intValue: paramType === 'Int' ? value : 0,
      boolValue: paramType === 'Bool' || paramType === 'Trigger' ? value : false,
    }
    await fetch(`/api/gm_console/animators/${selectedClient.id}/set-param/${selectedAnimator}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }, [selectedClient, selectedAnimator])

  // WebSocket 连接
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/gm_console/ws/animator`

    const connect = () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => setWsStatus('connected')

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'animator_data') {
            setSnapshot(data.snapshot)
            if (data.stateChanges && data.stateChanges.length > 0) {
              historyRef.current = [...historyRef.current, ...data.stateChanges].slice(-50)
              setStateHistory([...historyRef.current])
            }
          } else if (data.type === 'animator_removed') {
            if (data.animatorId === selectedAnimator) {
              setSelectedAnimator(null)
              setSnapshot(null)
            }
            setAnimators(prev => prev.filter(a => a.id !== data.animatorId))
          } else if (data.type === 'animator_list') {
            setAnimators(data.animators || [])
          }
        } catch (e) {
          console.error('WS parse error:', e)
        }
      }

      ws.onclose = () => {
        setWsStatus('disconnected')
        setTimeout(connect, 3000)
      }

      ws.onerror = () => ws.close()
    }

    connect()

    // 心跳
    const heartbeat = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('ping')
      }
    }, 30000)

    return () => {
      clearInterval(heartbeat)
      wsRef.current?.close()
    }
  }, [selectedAnimator])

  // 切换客户端时刷新
  useEffect(() => {
    fetchAnimators()
    return () => { unsubscribe() }
  }, [selectedClient])

  // 选中的 Animator 信息
  const selectedInfo = animators.find(a => a.id === selectedAnimator)

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Selector Bar */}
      <div className="flex items-center gap-3 p-3 bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)]">
        <Activity size={16} className="text-[var(--coffee-accent)]" />
        <select
          className="px-2 py-1 rounded text-sm bg-[var(--coffee-bg)] border border-[var(--coffee-border)]"
          value={selectedAnimator || ''}
          onChange={e => {
            const id = parseInt(e.target.value)
            if (id) subscribe(id)
          }}
        >
          <option value="">-- Select Animator --</option>
          {animators.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.controllerName})</option>
          ))}
        </select>
        <button onClick={fetchAnimators} className="p-1 hover:bg-[var(--coffee-hover)] rounded" title="Refresh">
          <RefreshCw size={14} />
        </button>
        <div className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
          wsStatus === 'connected' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
        }`}>
          {wsStatus}
        </div>
      </div>

      {!selectedAnimator ? (
        <div className="flex-1 flex items-center justify-center text-[var(--coffee-muted)] text-sm">
          {selectedClient ? '选择一个 Animator 开始监视' : '请先在左侧选择一个游戏客户端'}
        </div>
      ) : !snapshot ? (
        <div className="flex-1 flex items-center justify-center text-[var(--coffee-muted)] text-sm">
          等待数据...
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-3 overflow-auto">
          {/* Layer Tabs + State Dashboard */}
          <LayerDashboard snapshot={snapshot} />

          {/* Parameters */}
          <ParameterPanel
            parameters={snapshot.parameters}
            search={paramSearch}
            onSearchChange={setParamSearch}
            onSetParam={setParam}
          />

          {/* State History */}
          <StateHistoryPanel
            history={stateHistory}
            onClear={() => { historyRef.current = []; setStateHistory([]) }}
          />
        </div>
      )}
    </div>
  )
}

// === Sub-components ===

function LayerDashboard({ snapshot }) {
  const [activeLayer, setActiveLayer] = useState(0)

  if (!snapshot?.layers?.length) return null
  const layer = snapshot.layers[Math.min(activeLayer, snapshot.layers.length - 1)]

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      {/* Layer Tabs */}
      <div className="flex gap-1 mb-3">
        {snapshot.layers.map((l, i) => (
          <button
            key={i}
            onClick={() => setActiveLayer(i)}
            className={`px-3 py-1 text-xs rounded-md transition-all ${
              activeLayer === i
                ? 'bg-[var(--coffee-accent)] text-white'
                : 'bg-[var(--coffee-hover)] text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
            }`}
          >
            {l.name} {l.weight < 1 ? `(${l.weight.toFixed(1)})` : ''}
          </button>
        ))}
      </div>

      {/* Current State */}
      <div className="space-y-2">
        <div className="p-2 rounded bg-blue-500/10 border border-blue-500/30">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="font-mono font-medium text-blue-300">{layer.currentState?.name || 'None'}</span>
          </div>
          <div className="text-xs text-[var(--coffee-muted)] mt-1 font-mono">
            Time: {(layer.currentState?.normalizedTime * (layer.currentState?.length || 0)).toFixed(2)}s / {layer.currentState?.length?.toFixed(2)}s
            ({(layer.currentState?.normalizedTime * 100).toFixed(1)}%)
            &nbsp;&middot;&nbsp; Speed: {layer.currentState?.speed?.toFixed(1)}x
            &nbsp;&middot;&nbsp; Loop: {layer.currentState?.isLooping ? 'Yes' : 'No'}
          </div>
        </div>

        {/* Transition */}
        {layer.transition?.isInTransition && (
          <div className="p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-yellow-300">{layer.transition.sourceName}</span>
              <ChevronRight size={14} className="text-yellow-400" />
              <span className="font-mono text-yellow-300">{layer.transition.targetName}</span>
            </div>
            <div className="mt-1.5 h-2 bg-[var(--coffee-bg)] rounded-full overflow-hidden">
              <div
                className="h-full bg-yellow-400 rounded-full transition-all"
                style={{ width: `${(layer.transition.normalizedTime * 100)}%` }}
              />
            </div>
            <div className="text-xs text-[var(--coffee-muted)] mt-1">
              {(layer.transition.normalizedTime * 100).toFixed(0)}% &middot; Duration: {layer.transition.duration?.toFixed(3)}s
            </div>
          </div>
        )}

        {/* Clips */}
        {layer.currentClips?.length > 0 && (
          <div className="p-2 rounded bg-[var(--coffee-hover)]">
            {layer.currentClips.map((clip, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-[var(--coffee-deep)]">{clip.clipName}</span>
                <span className="text-[var(--coffee-muted)]">{clip.clipLength?.toFixed(2)}s</span>
                {clip.clipWeight < 1 && <span className="text-[var(--coffee-muted)]">w:{clip.clipWeight?.toFixed(2)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ParameterPanel({ parameters, search, onSearchChange, onSetParam }) {
  if (!parameters?.length) return null

  const filtered = parameters.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-[var(--coffee-deep)]">Parameters</span>
        <input
          type="text"
          placeholder="Filter..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="px-2 py-0.5 text-xs rounded bg-[var(--coffee-bg)] border border-[var(--coffee-border)] w-32"
        />
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {filtered.map(p => (
          <div key={p.name} className="flex items-center gap-2 text-xs py-0.5">
            <span className="w-28 truncate font-mono text-[var(--coffee-deep)]">{p.name}</span>
            <span className="w-10 text-[var(--coffee-muted)]">{p.type}</span>
            <div className="flex-1">
              {p.type === 'Float' && (
                <input
                  type="range"
                  min={-10} max={10} step={0.01}
                  value={p.floatValue}
                  onChange={e => onSetParam(p.name, 'Float', parseFloat(e.target.value))}
                  className="w-full h-1"
                />
              )}
              {p.type === 'Int' && (
                <input
                  type="number"
                  value={p.intValue}
                  onChange={e => onSetParam(p.name, 'Int', parseInt(e.target.value) || 0)}
                  className="w-16 px-1 py-0.5 rounded bg-[var(--coffee-bg)] border border-[var(--coffee-border)]"
                />
              )}
              {p.type === 'Bool' && (
                <button
                  onClick={() => onSetParam(p.name, 'Bool', !p.boolValue)}
                  className={`px-2 py-0.5 rounded text-xs ${
                    p.boolValue ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {p.boolValue ? 'true' : 'false'}
                </button>
              )}
              {p.type === 'Trigger' && (
                <button
                  onClick={() => onSetParam(p.name, 'Trigger', true)}
                  className="px-2 py-0.5 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                >
                  <Play size={10} className="inline" /> Fire
                </button>
              )}
            </div>
            {p.type === 'Float' && <span className="w-12 text-right font-mono text-[var(--coffee-muted)]">{p.floatValue?.toFixed(2)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function StateHistoryPanel({ history, onClear }) {
  if (!history?.length) return null

  return (
    <div className="bg-[var(--coffee-card)] rounded-lg border border-[var(--coffee-border)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-[var(--coffee-deep)]">State History ({history.length})</span>
        <button onClick={onClear} className="p-1 hover:bg-[var(--coffee-hover)] rounded" title="Clear">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {[...history].reverse().map((h, i) => (
          <div key={i} className="flex items-center gap-2 text-xs font-mono py-0.5">
            <span className="w-12 text-[var(--coffee-muted)]">{h.timestamp?.toFixed(1)}s</span>
            <span className="text-red-300">{h.fromState}</span>
            <ChevronRight size={10} className="text-[var(--coffee-muted)]" />
            <span className="text-green-300">{h.toState}</span>
            <span className="text-[var(--coffee-muted)] ml-auto">{h.layerName}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

### Task 3.2: Integrate into GmConsole.jsx

**Files:**
- Modify: `E:\Such_Proj\Other\EncyHub\frontend\src\pages\GmConsole.jsx`

- [ ] **Step 1: Add import at top of file**

```javascript
import AnimatorViewer from './AnimatorViewer'
```

- [ ] **Step 2: Add Animator tab button**

Locate the tab buttons section (around line 638-665). After the last existing tab button, add:

```jsx
<button
  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
    activeTab === 'animator'
      ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
      : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
  }`}
  onClick={() => setActiveTab('animator')}
>
  <span className="flex items-center gap-1.5">
    <Activity size={14} />
    Animator
  </span>
</button>
```

- [ ] **Step 3: Add import for Activity icon**

Locate the lucide-react import line and add `Activity`:

```javascript
import { ..., Activity } from 'lucide-react'
```

- [ ] **Step 4: Add Animator tab content render**

After the last tab content render block (after Custom GM), add:

```jsx
{activeTab === 'animator' && (
  <AnimatorViewer
    clients={clients}
    selectedClient={selectedClient}
    broadcastMode={broadcastMode}
  />
)}
```

- [ ] **Step 5: Verify frontend builds**

```bash
cd E:/Such_Proj/Other/EncyHub/frontend && npm run build
```

Expected: Build succeeds with no errors.

**Phase 3 checkpoint: Full Web viewer functional.**

---

## Phase 4: Polish & Enhancement

### Task 4.1: Connection Resilience

- [ ] **Step 1: Add auto-reconnect for WebSocket in AnimatorViewer**

Already handled in the WebSocket `onclose` handler with `setTimeout(connect, 3000)`.

- [ ] **Step 2: Add unsubscribe cleanup on component unmount**

Already handled in the `useEffect` cleanup.

- [ ] **Step 3: Handle animator destruction gracefully**

Already handled: `ANIM_REMOVED` event clears selection and removes from list.

### Task 4.2: Frontend Build for Production

- [ ] **Step 1: Build production frontend**

```bash
cd E:/Such_Proj/Other/EncyHub/frontend && npm run build
```

- [ ] **Step 2: Verify via EncyHub**

```bash
cd E:/Such_Proj/Other/EncyHub && python main.py
```

Open browser to `http://localhost:9524`, navigate to GM Console, verify Animator tab appears.

---

## Integration Test Checklist

### End-to-End Verification

1. [ ] Start EncyHub: `cd E:/Such_Proj/Other/EncyHub && python main.py`
2. [ ] Open Unity, enter Play Mode
3. [ ] Verify: GM Console shows connected client
4. [ ] Click "Animator" tab in GM Console
5. [ ] Click refresh, verify Animator list populates
6. [ ] Select an Animator, verify snapshot data streams at ~10fps
7. [ ] Verify: Layer tabs, state info, transition bars, clip info all display
8. [ ] Modify a parameter (e.g., Float slider), verify game responds
9. [ ] Trigger a state change in game, verify State History updates
10. [ ] Open `Tool/动画/Animator Live Monitor` in Unity Editor
11. [ ] Verify: EditorWindow shows same data with graph visualization
12. [ ] Verify: Both viewers work simultaneously without conflict
13. [ ] Kill a character in game, verify ANIM_REMOVED handled in both viewers
14. [ ] Close Animator tab in Web, verify game stops pushing data (check performance)
