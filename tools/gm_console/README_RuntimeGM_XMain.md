# RuntimeGMClient - XMain.lua 嵌入代码

## 说明

将以下代码追加到任意客户端分支的 `Product/Lua/Matrix/XMain.lua` 文件末尾即可启用 EncyHub GM Console 的全部功能：

- **GM Console**: 远程执行 Lua 代码、GM 按钮面板
- **Animator Viewer**: 远程查看 Animator 状态机、参数、转场（真机可用）
- **Lua UI Inspector**: 远程查看/编辑 Lua UI（XLuaUi）实例的 self 表数据（真机可用）
  - `INSPECTOR_MAX_FIELDS = 200` — 限制根级字段数量，防止大型 UI 返回过大响应
  - `CallMethod` — 可从 Web Inspector 调用 Lua 方法（实例方法 + 元表 class 方法）
  - `GetNodeData` 返回 `truncated`/`totalKeys`/`shownKeys` 字段截断信息
- **PlayerPrefs Viewer**: 远程查看/编辑 PlayerPrefs 持久化数据
- **AV Monitor**: 远程监控 CRI Audio（音量/静音/活跃音频列表/CueId 查询/Debug 开关）和视频播放器（状态/时间轴/Seek/速度/事件日志）
  - Windows (Editor/Standalone): 通过注册表枚举所有 key，支持过滤搜索
  - Android: 通过读取 SharedPreferences XML 枚举所有 key
  - iOS: 仅支持手动输入 key 查询（无法枚举），支持收藏和最近记录
- **Log 截获**: 远程查看 `print()` 输出
- **TCP 心跳保活**: 每 15 秒发送 PING，防止 NAT/防火墙超时断开连接
- **断线自动重连**: 超过 45 秒无响应自动断开并每 3 秒重试，服务端重启后无需重启游戏

## 使用方法

1. 打开目标分支的 `Product/Lua/Matrix/XMain.lua`
2. 将下方代码块完整粘贴到文件末尾
3. **修改 IP 和端口**为你的开发机地址（运行 EncyHub 的电脑）
4. 热更或重新打包

## 注意事项

- IP 地址 `10.101.0.8` 需改为你自己运行 EncyHub 的电脑 IP
- 端口 `12581` 对应 EncyHub GM Console 的 TCP 端口（`main.py` 中 `DEFAULT_TCP_PORT = 12581`）
- 代码使用 `rawget`/`rawset` 绕过 `LuaLockG()`，兼容任意分支
- 代码使用 `pcall` 保护所有外部调用，不会影响游戏正常运行
- 如果 `socket.core` 不可用（部分裁剪包），RuntimeGM 会静默跳过

## 代码

```lua
-- 2. RuntimeGMClient 核心逻辑 (内嵌版)
-- 将 RuntimeGMClient 的内容封装在这里，避免污染全局，但最后会 rawset 到 _G 以供调用
local function StartRuntimeGM()
    local RuntimeGMClient = {}
    RuntimeGMClient.Socket = nil
    RuntimeGMClient.Host = "localhost"
    RuntimeGMClient.Port = 12581
    RuntimeGMClient.IsRunning = false
    RuntimeGMClient.ReconnectTimer = 0
    RuntimeGMClient.SocketLibrary = nil
    RuntimeGMClient.HeartbeatTimer = 0
    RuntimeGMClient.HeartbeatInterval = 15  -- 每15秒发送一次心跳
    RuntimeGMClient.LastRecvTime = 0
    RuntimeGMClient.RecvTimeout = 45  -- 超过45秒没收到任何数据则判定断线（3次心跳周期）

    -- 安全加载 socket 库
    local function loadSocketLibrary()
        local success, socket_or_err = pcall(function()
            return require("socket.core")
        end)

        if success and socket_or_err then
            RuntimeGMClient.SocketLibrary = socket_or_err
            return true
        else
            print("[RuntimeGM] Failed to load socket.core: " .. tostring(socket_or_err))
            return false
        end
    end

    -- 获取设备信息
    local function getDeviceInfo()
        local info = {
            platform = "Unknown",
            device = "Unknown",
            pid = 0
        }

        pcall(function()
            info.platform = CS.UnityEngine.Application.platform:ToString()
            info.device = CS.UnityEngine.SystemInfo.deviceModel
            info.pid = CS.System.Diagnostics.Process.GetCurrentProcess().Id
        end)

        return info
    end

    RuntimeGMClient.DeviceInfo = getDeviceInfo()

    -- 保存原始 print
    local origin_print = print

    -- 劫持 print 以截获日志
    local function HookPrint(...)
        local args = {...}
        local msg = ""
        for i, v in ipairs(args) do
            msg = msg .. tostring(v) .. "\t"
        end
        -- 调用原始 print 确保控制台也能看到
        origin_print(...)

        -- 发送到 GM 工具
        if RuntimeGMClient.Socket then
            RuntimeGMClient.SendLog("print", msg)
        end
    end

    -- JSON 编码
    local function jsonEncode(tbl)
        local function encode(val)
            local t = type(val)
            if t == "string" then
                return '"' .. val:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t') .. '"'
            elseif t == "number" then
                return tostring(val)
            elseif t == "boolean" then
                return val and "true" or "false"
            elseif t == "nil" then
                return "null"
            elseif t == "table" then
                local parts = {}
                local isArray = #val > 0
                -- 空表统一序列化为 [] 而非 {}，避免前端 .map() 崩溃
                if not isArray and next(val) == nil then
                    return "[]"
                end
                if isArray then
                    for _, v in ipairs(val) do
                        table.insert(parts, encode(v))
                    end
                    return "[" .. table.concat(parts, ",") .. "]"
                else
                    for k, v in pairs(val) do
                        table.insert(parts, '"' .. tostring(k) .. '":' .. encode(v))
                    end
                    return "{" .. table.concat(parts, ",") .. "}"
                end
            end
            return "null"
        end
        return encode(tbl)
    end

    -- JSON 解码
    local function jsonDecode(str)
        local success, json = pcall(require, "XCommon/Json")
        if success and json and json.decode then
            local ok, result = pcall(json.decode, str)
            if ok then return result end
        end

        local result = {}
        for k, v in str:gmatch('"([^"]+)"%s*:%s*"?([^,}]+)"?') do
            if v == "true" then v = true
            elseif v == "false" then v = false
            elseif tonumber(v) then v = tonumber(v)
            else v = v:gsub('^"', ''):gsub('"$', '')
            end
            result[k] = v
        end
        return result
    end

    function RuntimeGMClient.Send(data)
        if not RuntimeGMClient.Socket then return end
        local success, packet = pcall(jsonEncode, data)
        if not success then
            origin_print("[RuntimeGM] JSON Encode Error: " .. tostring(packet))
            return
        end
        local ok, err = pcall(function()
            -- 给send一个短暂的超时窗口，避免被Update的settimeout(0)影响
            RuntimeGMClient.Socket:settimeout(0.05)
            RuntimeGMClient.Socket:send(packet .. "\n")
        end)
        if not ok then
            local errStr = tostring(err)
            if errStr:find("closed") or errStr:find("refused") or errStr:find("reset") then
                -- 连接已断开，执行关闭
                origin_print("[RuntimeGM] Send Fatal: " .. errStr)
                RuntimeGMClient.Close()
            end
            -- timeout/buffer full: 丢弃这条消息，保持连接
        end
    end

    function RuntimeGMClient.SendLog(level, msg, refId)
        RuntimeGMClient.Send({
            type = "LOG",
            level = level,
            msg = msg,
            ref_id = refId
        })
    end

    function RuntimeGMClient.Connect()
        if RuntimeGMClient.Socket then return end
        if not RuntimeGMClient.SocketLibrary then return end

        local socket = RuntimeGMClient.SocketLibrary
        -- 打印正在连接的目标，方便确认 IP 对不对
        origin_print("[RuntimeGM] 正在连接到: " .. RuntimeGMClient.Host .. ":" .. RuntimeGMClient.Port)

        local success, tcp_or_err = pcall(function() return socket.tcp() end)
        if not success or not tcp_or_err then
            origin_print("[RuntimeGM] 创建 TCP 失败: " .. tostring(tcp_or_err))
            return
        end

        local tcp = tcp_or_err
        tcp:settimeout(0.5) --稍微增加一点超时时间

        local res, err = tcp:connect(RuntimeGMClient.Host, RuntimeGMClient.Port)

        if res then
            origin_print("[RuntimeGM] 连接成功！")
            tcp:settimeout(0)
            RuntimeGMClient.Socket = tcp
            pcall(function() RuntimeGMClient.LastRecvTime = CS.UnityEngine.Time.realtimeSinceStartup end)
            RuntimeGMClient.Send({
                type = "HELLO",
                pid = RuntimeGMClient.DeviceInfo.pid,
                device = RuntimeGMClient.DeviceInfo.device,
                platform = RuntimeGMClient.DeviceInfo.platform
            })
        else
            -- 这里会打印具体的错误原因，比如 "connection refused" 或 "timeout"
            origin_print("[RuntimeGM] 连接失败，错误原因: " .. tostring(err))
            tcp:close()
        end
    end

    function RuntimeGMClient.Close()
        if RuntimeGMClient.Socket then
            pcall(function() RuntimeGMClient.Socket:close() end)
            RuntimeGMClient.Socket = nil
            origin_print("[RuntimeGM] Disconnected.")
        end
    end

    -- GM Logic
    RuntimeGMClient.GMCallbacks = {}
    RuntimeGMClient.GMStructure = {}
    RuntimeGMClient.GMIdCounter = 0
    RuntimeGMClient.GMLoaded = false

    local function GetNextGMId()
        RuntimeGMClient.GMIdCounter = RuntimeGMClient.GMIdCounter + 1
        return RuntimeGMClient.GMIdCounter
    end

    local function MockPanel(name, parent)
        return {
            name = name,
            parent = parent,
            children = {},
            isLeaf = false,
            AddChild = function(self, item) table.insert(self.children, item) end
        }
    end

    local function CreateMockContext(rootPanel)
        local context = { CurrentPanel = rootPanel, Root = rootPanel }
        function context:AddChild(type, name, cb, defaultVal)
            local id = GetNextGMId()
            local item = { id = id, type = type, name = name, default = defaultVal }
            self.CurrentPanel:AddChild(item)
            if cb then RuntimeGMClient.GMCallbacks[id] = cb end
            return item
        end
        function context:AddButton(name, cb) self:AddChild("Btn", name, cb) end
        function context:AddToggle(name, cb)
            local item = self:AddChild("Toggle", name, cb, false)
            return { isOn = false, onValueChanged = { AddListener = function() end } }
        end
        function context:AddInput(name, cb) self:AddChild("Input", name, cb); return { text = "" } end
        function context:AddText(name, cb) self:AddChild("Text", name, cb); return { text = "" } end
        function context:AddSubMenu(name, func, isAsync)
            local subPanel = MockPanel(name, self.CurrentPanel)
            local item = { type = "SubBox", name = name, children = subPanel.children }
            self.CurrentPanel:AddChild(item)
            local old = self.CurrentPanel
            self.CurrentPanel = subPanel
            local oldG = rawget(_G, "Panel")
            rawset(_G, "Panel", self)
            if func then pcall(func, self) end
            rawset(_G, "Panel", oldG)
            self.CurrentPanel = old
        end
        return context
    end

    function RuntimeGMClient.ReloadGM(force)
        if RuntimeGMClient.GMLoaded and not force then return end
        origin_print("[RuntimeGM] Reloading GM Config via Reflection...")
        RuntimeGMClient.GMCallbacks = {}
        RuntimeGMClient.GMStructure = {}
        RuntimeGMClient.GMIdCounter = 0
        local rootPanel = MockPanel("Root", nil)
        local context = CreateMockContext(rootPanel)
        local oldXDebugManager = CS.XDebugManager
        local mockXDebugManager = {
            DebuggerGm = context,
            ReLogin = function(...) if oldXDebugManager.ReLogin then oldXDebugManager.ReLogin(...) end end,
            ReloadLuaTable = function(...) if oldXDebugManager.ReloadLuaTable then oldXDebugManager.ReloadLuaTable(...) end end
        }
        CS.XDebugManager = mockXDebugManager
        local ok, err = pcall(function()
            if not XGmTestManager then require("XManager/XGmTestManager") end
            if XGmTestManager and XGmTestManager.Init then XGmTestManager.Init() end
        end)
        CS.XDebugManager = oldXDebugManager
        if ok then
            RuntimeGMClient.GMStructure = rootPanel.children
            origin_print("[RuntimeGM] GM Config Loaded.")
            RuntimeGMClient.SendGMList()
            RuntimeGMClient.GMLoaded = true
        else
            origin_print("[RuntimeGM] Failed to load GM: " .. tostring(err))
        end
    end

    function RuntimeGMClient.SendGMList()
        if not RuntimeGMClient.Socket then return end
        local nodes = {}
        for _, node in ipairs(RuntimeGMClient.GMStructure) do
            local function clean(n)
                local t = { type = tostring(n.type), name = tostring(n.name), id = n.id }
                if n.children then
                    t.children = {}
                    for _, k in ipairs(n.children) do table.insert(t.children, clean(k)) end
                end
                return t
            end
            table.insert(nodes, clean(node))
        end
        local jsonStr = jsonEncode({ type = "GM_LIST", data = nodes })
        pcall(function() RuntimeGMClient.Socket:send(jsonStr .. "\n") end)
    end

    function RuntimeGMClient.ExecuteGM(id, value)
        local cb = RuntimeGMClient.GMCallbacks[id]
        if cb then
            -- origin_print("[RuntimeGM] Executing GM ID: " .. tostring(id))
            local status, err = pcall(cb, value)
            if not status then RuntimeGMClient.SendLog("error", "GM Exec Error: " .. tostring(err))
            else RuntimeGMClient.SendLog("info", "GM Executed") end
        end
    end

    -- ========== LuaAnimatorMonitor: Animator 数据采集 (纯 Lua, 真机兼容) ==========
    -- 替代 C# Editor 侧的 AnimatorTcpBridge / AnimatorDataService / AnimatorTracker
    -- 使真机包也能通过 EncyHub Web 查看 Animator 状态
    local LuaAnimatorMonitor = {}
    LuaAnimatorMonitor._trackers = {}           -- instanceId → tracker table
    LuaAnimatorMonitor._subscribedId = nil      -- 当前订阅的 animator id (nil=未订阅)
    LuaAnimatorMonitor._lastScanTime = 0
    LuaAnimatorMonitor._lastPushTime = 0
    LuaAnimatorMonitor._scanInterval = 2.0      -- 扫描间隔(秒)
    LuaAnimatorMonitor._pushInterval = 0.1      -- 推送间隔(秒)

    origin_print("[RuntimeGM] LuaAnimatorMonitor module initialized")

    -- 解析状态名称
    local function _resolveStateName(tracker, hash)
        return tracker.stateNameCache[hash] or ("Unknown_" .. hash)
    end

    -- 扫描场景所有 Animator
    function LuaAnimatorMonitor.ScanAnimators()
        local scanOk, allAnimators = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.Animator))
        end)
        if not scanOk or not allAnimators then
            origin_print("[RuntimeGM] ScanAnimators failed: " .. tostring(allAnimators))
            return
        end

        -- 清理无效 tracker
        local toRemove = {}
        for id, tracker in pairs(LuaAnimatorMonitor._trackers) do
            local validOk, valid = pcall(function()
                return tracker.animator.gameObject.activeInHierarchy
            end)
            if not (validOk and valid) then
                toRemove[#toRemove + 1] = id
            end
        end
        for _, id in ipairs(toRemove) do
            LuaAnimatorMonitor._trackers[id] = nil
        end

        -- 添加新发现的 Animator
        for i = 0, allAnimators.Length - 1 do
            local animator = allAnimators[i]
            if animator and animator.runtimeAnimatorController then
                local id = animator:GetInstanceID()
                if not LuaAnimatorMonitor._trackers[id] then
                    LuaAnimatorMonitor._trackers[id] = LuaAnimatorMonitor.CreateTracker(animator)
                end
            end
        end
    end

    -- 为单个 Animator 创建跟踪器
    function LuaAnimatorMonitor.CreateTracker(animator)
        local tracker = {
            animator = animator,
            instanceId = animator:GetInstanceID(),
            stateNameCache = {},   -- hash → name
            lastStateHashes = {},  -- layerIndex → lastHash
        }

        -- 初始化各层最后状态 hash
        for i = 0, animator.layerCount - 1 do
            local stateInfo = animator:GetCurrentAnimatorStateInfo(i)
            tracker.lastStateHashes[i] = stateInfo.shortNameHash
        end

        -- 发现所有状态名称
        LuaAnimatorMonitor.DiscoverStates(tracker)

        return tracker
    end

    -- 利用 animationClips + HasState 发现所有可探测的状态
    function LuaAnimatorMonitor.DiscoverStates(tracker)
        local animator = tracker.animator
        if not animator.runtimeAnimatorController then return end

        local ok, clips = pcall(function()
            return animator.runtimeAnimatorController.animationClips
        end)
        if not ok or not clips then return end

        local candidateNames = {}
        for i = 0, clips.Length - 1 do
            local clip = clips[i]
            if clip and clip.name and clip.name ~= "" then
                candidateNames[clip.name] = true
            end
        end

        for layer = 0, animator.layerCount - 1 do
            for name, _ in pairs(candidateNames) do
                local hash = CS.UnityEngine.Animator.StringToHash(name)
                if animator:HasState(layer, hash) then
                    if not tracker.stateNameCache[hash] then
                        tracker.stateNameCache[hash] = name
                    end
                end
            end

            -- 记录当前播放的状态
            local stateInfo = animator:GetCurrentAnimatorStateInfo(layer)
            if stateInfo.shortNameHash ~= 0 then
                -- 用 clip 名称补充
                local clipOk, clipInfos = pcall(function()
                    return animator:GetCurrentAnimatorClipInfo(layer)
                end)
                if clipOk and clipInfos and clipInfos.Length > 0 then
                    local clipName = clipInfos[0].clip.name
                    if clipName and clipName ~= "" then
                        if not tracker.stateNameCache[stateInfo.shortNameHash] then
                            tracker.stateNameCache[stateInfo.shortNameHash] = clipName
                        end
                    end
                end
            end
        end
    end

    -- 采集单层快照
    local function _takeLayerSnapshot(tracker, animator, layerIndex)
        local stateInfo = animator:GetCurrentAnimatorStateInfo(layerIndex)
        local transInfo = animator:GetAnimatorTransitionInfo(layerIndex)
        local clipInfos = animator:GetCurrentAnimatorClipInfo(layerIndex)

        -- 用 clip 名称补充 stateNameCache（AB 加载时 hash map 可能为空）
        if clipInfos.Length > 0 then
            local clipName = clipInfos[0].clip.name
            local curHash = stateInfo.shortNameHash
            if clipName and clipName ~= "" then
                local cached = tracker.stateNameCache[curHash]
                if not cached or cached:find("^Unknown_") then
                    tracker.stateNameCache[curHash] = clipName
                end
            end
        end

        local layer = {
            index = layerIndex,
            name = animator:GetLayerName(layerIndex),
            weight = animator:GetLayerWeight(layerIndex),
            currentState = {
                nameHash = stateInfo.shortNameHash,
                name = _resolveStateName(tracker, stateInfo.shortNameHash),
                normalizedTime = stateInfo.normalizedTime,
                length = stateInfo.length,
                speed = stateInfo.speed,
                isLooping = stateInfo.loop
            },
            transition = {
                isInTransition = animator:IsInTransition(layerIndex),
                normalizedTime = transInfo.normalizedTime,
                duration = transInfo.duration
            },
            currentClips = {}
        }

        -- 采集 nextState（如果正在转场）— 双重检测修复
        if animator:IsInTransition(layerIndex) then
            local nextInfo = animator:GetNextAnimatorStateInfo(layerIndex)

            -- 用 next clip 名称补充缓存
            local nextOk, nextClipInfos = pcall(function()
                return animator:GetNextAnimatorClipInfo(layerIndex)
            end)
            if nextOk and nextClipInfos and nextClipInfos.Length > 0 then
                local nextClipName = nextClipInfos[0].clip.name
                if nextClipName and nextClipName ~= "" then
                    local cached = tracker.stateNameCache[nextInfo.shortNameHash]
                    if not cached or cached:find("^Unknown_") then
                        tracker.stateNameCache[nextInfo.shortNameHash] = nextClipName
                    end
                end
            end

            layer.nextState = {
                nameHash = nextInfo.shortNameHash,
                name = _resolveStateName(tracker, nextInfo.shortNameHash),
                normalizedTime = nextInfo.normalizedTime,
                length = nextInfo.length,
                speed = nextInfo.speed,
                isLooping = nextInfo.loop
            }
            layer.transition.sourceName = layer.currentState.name
            layer.transition.targetName = layer.nextState.name
        end

        -- 采集当前 clips
        for i = 0, clipInfos.Length - 1 do
            layer.currentClips[#layer.currentClips + 1] = {
                clipName = clipInfos[i].clip.name,
                clipLength = clipInfos[i].clip.length,
                clipWeight = clipInfos[i].weight
            }
        end

        return layer
    end

    -- 采集完整快照
    function LuaAnimatorMonitor.TakeSnapshot(tracker)
        local animator = tracker.animator
        local goName = animator.gameObject.name:gsub("%(Clone%)", ""):match("^%s*(.-)%s*$")
        local ctrlName = "None"
        if animator.runtimeAnimatorController then
            ctrlName = animator.runtimeAnimatorController.name
        end

        local snapshot = {
            animatorId = tracker.instanceId,
            gameObjectName = goName,
            controllerName = ctrlName,
            timestamp = CS.UnityEngine.Time.time,
            layers = {},
            parameters = {}
        }

        -- 采集各层数据
        for i = 0, animator.layerCount - 1 do
            snapshot.layers[#snapshot.layers + 1] = _takeLayerSnapshot(tracker, animator, i)
        end

        -- 采集参数
        local paramOk, params = pcall(function() return animator.parameters end)
        if paramOk and params then
            for i = 0, params.Length - 1 do
                local param = params[i]
                -- IL2CPP 下 enum:ToString() 可能不可用，用 tostring 兜底
                local pTypeOk, pTypeStr = pcall(function() return param.type:ToString() end)
                if not pTypeOk then
                    local pTypeInt = tonumber(tostring(param.type)) or -1
                    local typeMap = {[1] = "Float", [3] = "Int", [4] = "Bool", [9] = "Trigger"}
                    pTypeStr = typeMap[pTypeInt] or "Unknown"
                end
                local paramSnap = {
                    name = param.name,
                    type = pTypeStr,
                    floatValue = 0,
                    intValue = 0,
                    boolValue = false
                }

                if pTypeStr == "Float" then
                    paramSnap.floatValue = animator:GetFloat(param.name)
                elseif pTypeStr == "Int" then
                    paramSnap.intValue = animator:GetInteger(param.name)
                elseif pTypeStr == "Bool" then
                    paramSnap.boolValue = animator:GetBool(param.name)
                elseif pTypeStr == "Trigger" then
                    paramSnap.boolValue = animator:GetBool(param.name)
                end

                snapshot.parameters[#snapshot.parameters + 1] = paramSnap
            end
        end

        return snapshot
    end

    -- 检测状态变化（双重检测：hash 比较 + IsInTransition）
    function LuaAnimatorMonitor.DetectStateChanges(tracker)
        local animator = tracker.animator
        local changes = {}

        for i = 0, animator.layerCount - 1 do
            local stateInfo = animator:GetCurrentAnimatorStateInfo(i)
            local currentHash = stateInfo.shortNameHash
            local lastHash = tracker.lastStateHashes[i] or 0

            -- 方式1: 帧间 hash 比较（捕获已完成的状态切换）
            if lastHash ~= 0 and lastHash ~= currentHash then
                changes[#changes + 1] = {
                    layerName = animator:GetLayerName(i),
                    fromState = _resolveStateName(tracker, lastHash),
                    toState = _resolveStateName(tracker, currentHash),
                    timestamp = CS.UnityEngine.Time.time
                }
            end

            -- 方式2: IsInTransition 检测（捕获进行中的状态切换）
            if animator:IsInTransition(i) then
                local nextInfo = animator:GetNextAnimatorStateInfo(i)
                if nextInfo.shortNameHash ~= 0 and nextInfo.shortNameHash ~= currentHash then
                    -- 避免与方式1重复
                    local fromName = _resolveStateName(tracker, currentHash)
                    local toName = _resolveStateName(tracker, nextInfo.shortNameHash)
                    local isDuplicate = false
                    for _, c in ipairs(changes) do
                        if c.fromState == fromName and c.toState == toName then
                            isDuplicate = true
                            break
                        end
                    end
                    if not isDuplicate then
                        changes[#changes + 1] = {
                            layerName = animator:GetLayerName(i),
                            fromState = fromName,
                            toState = toName,
                            timestamp = CS.UnityEngine.Time.time
                        }
                    end
                end
            end

            tracker.lastStateHashes[i] = currentHash
        end

        return #changes > 0 and changes or nil
    end

    -- 处理来自 EncyHub 的 ANIM 命令
    function LuaAnimatorMonitor.HandleCommand(packet)
        local cmdType = packet.type
        -- origin_print("[RuntimeGM] ANIM command received: " .. tostring(cmdType))

        if cmdType == "ANIM_LIST" then
            LuaAnimatorMonitor.ScanAnimators()
            local animators = {}
            for _, tracker in pairs(LuaAnimatorMonitor._trackers) do
                local ok, info = pcall(function()
                    local animator = tracker.animator
                    local goName = animator.gameObject.name:gsub("%(Clone%)", ""):match("^%s*(.-)%s*$")
                    local ctrlName = "None"
                    if animator.runtimeAnimatorController then
                        ctrlName = animator.runtimeAnimatorController.name
                    end
                    return { id = tracker.instanceId, name = goName, controllerName = ctrlName }
                end)
                if ok and info then
                    animators[#animators + 1] = info
                end
            end
            -- origin_print("[RuntimeGM] ANIM_LIST_RESP: found " .. #animators .. " animators")
            RuntimeGMClient.Send({ type = "ANIM_LIST_RESP", animators = animators })

        elseif cmdType == "ANIM_SUBSCRIBE" then
            origin_print("[RuntimeGM] ANIM_SUBSCRIBE id=" .. tostring(packet.animatorId))
            LuaAnimatorMonitor._subscribedId = packet.animatorId
            LuaAnimatorMonitor._lastPushTime = 0
            LuaAnimatorMonitor._lastScanTime = 0
            -- 立即扫描确保 tracker 存在
            LuaAnimatorMonitor.ScanAnimators()

        elseif cmdType == "ANIM_UNSUBSCRIBE" then
            LuaAnimatorMonitor._subscribedId = nil

        elseif cmdType == "ANIM_SET_PARAM" then
            local tracker = LuaAnimatorMonitor._trackers[packet.animatorId]
            if tracker and tracker.animator then
                local animator = tracker.animator
                local pName = packet.paramName
                local pType = packet.paramType
                if pType == "Float" then
                    animator:SetFloat(pName, packet.floatValue or 0)
                elseif pType == "Int" then
                    animator:SetInteger(pName, packet.intValue or 0)
                elseif pType == "Bool" then
                    animator:SetBool(pName, packet.boolValue or false)
                elseif pType == "Trigger" then
                    animator:SetTrigger(pName)
                end
            end
        end
    end

    -- 每帧更新：扫描 + 采集 + 推送（仅在有订阅时工作）
    function LuaAnimatorMonitor.Update()
        if not LuaAnimatorMonitor._subscribedId then return end

        local now = CS.UnityEngine.Time.realtimeSinceStartup

        -- 扫描节流
        if now - LuaAnimatorMonitor._lastScanTime >= LuaAnimatorMonitor._scanInterval then
            LuaAnimatorMonitor._lastScanTime = now
            LuaAnimatorMonitor.ScanAnimators()
        end

        -- 推送节流
        if now - LuaAnimatorMonitor._lastPushTime < LuaAnimatorMonitor._pushInterval then
            return
        end
        LuaAnimatorMonitor._lastPushTime = now

        local tracker = LuaAnimatorMonitor._trackers[LuaAnimatorMonitor._subscribedId]
        if not tracker then return end

        -- 检查 Animator 有效性（处理 Unity Object 销毁的情况）
        local validOk, valid = pcall(function()
            return tracker.animator.gameObject.activeInHierarchy
        end)

        if validOk and valid then
            local snapshot = LuaAnimatorMonitor.TakeSnapshot(tracker)
            local changes = LuaAnimatorMonitor.DetectStateChanges(tracker)
            if snapshot then
                local msg = { type = "ANIM_DATA", snapshot = snapshot }
                if changes then msg.stateChanges = changes end
                RuntimeGMClient.Send(msg)
            end
        else
            -- Animator 已销毁或不可用
            RuntimeGMClient.Send({ type = "ANIM_REMOVED", animatorId = LuaAnimatorMonitor._subscribedId })
            LuaAnimatorMonitor._trackers[LuaAnimatorMonitor._subscribedId] = nil
            LuaAnimatorMonitor._subscribedId = nil
        end
    end

    -- ========== LuaTimelineMonitor: Timeline 数据采集 (纯 Lua, 真机兼容) ==========
    local LuaTimelineMonitor = {}
    LuaTimelineMonitor._directors = {}         -- instanceId → PlayableDirector
    LuaTimelineMonitor._monitored = {}         -- instanceId → true
    LuaTimelineMonitor._monitoredCount = 0
    LuaTimelineMonitor._lastScanTime = 0
    LuaTimelineMonitor._lastPushTime = 0
    LuaTimelineMonitor._scanInterval = 2.0     -- 扫描间隔
    LuaTimelineMonitor._pushInterval = 0.1     -- 推送间隔（100ms）
    LuaTimelineMonitor._eventCaches = {}       -- instanceId → { assetName, events }

    origin_print("[RuntimeGM] LuaTimelineMonitor module initialized")

    -- 缓存 PlayState 枚举，避免 tostring 比较的 xlua 兼容性问题
    local _TL_PlayState_Playing = nil
    pcall(function() _TL_PlayState_Playing = CS.UnityEngine.Playables.PlayState.Playing end)

    local function tlIsPlaying(director)
        if _TL_PlayState_Playing then
            return director.state == _TL_PlayState_Playing
        end
        -- fallback: 尝试 tostring
        local s = tostring(director.state)
        return s == "Playing" or s == "1"
    end

    -- 迭代 C# IEnumerable → Lua table
    local function tlIter(csEnum)
        local t = {}
        if not csEnum then return t end
        pcall(function()
            local it = csEnum:GetEnumerator()
            while it:MoveNext() do t[#t + 1] = it.Current end
        end)
        return t
    end

    -- 安全数值（NaN / Infinity → 0）
    local function tlSafeNum(v)
        if v ~= v or v == math.huge or v == -math.huge then return 0 end
        return v
    end

    -- 扫描场景所有 PlayableDirector
    function LuaTimelineMonitor.ScanDirectors()
        local ok, allDirs = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.Playables.PlayableDirector))
        end)
        if not ok or not allDirs then return {} end

        local newDirs = {}
        local result = {}
        for i = 0, allDirs.Length - 1 do
            local ok2, info = pcall(function()
                local d = allDirs[i]
                if not d then return nil end
                local id = d:GetInstanceID()
                newDirs[id] = d
                local goName = d.gameObject.name
                local parentName = ""
                pcall(function()
                    local p = d.transform.parent
                    if p then parentName = p.name end
                end)
                local t = d.transform
                while t.parent do t = t.parent end
                local rootName = t.name
                return {
                    instanceId = id,
                    gameObjectName = goName,
                    parentName = (parentName ~= rootName and parentName ~= goName) and parentName or nil,
                    rootName = rootName,
                    hasAsset = (d.playableAsset ~= nil),
                    isPlaying = tlIsPlaying(d),
                }
            end)
            if ok2 and info then result[#result + 1] = info end
        end
        LuaTimelineMonitor._directors = newDirs
        return result
    end

    -- 构建完整快照
    function LuaTimelineMonitor.TakeSnapshot(d)
        local snap = {}
        local ok, err = pcall(function()
            snap.instanceId = d:GetInstanceID()
            snap.gameObjectName = d.gameObject.name
            snap.currentTime = tlSafeNum(d.time)
            snap.duration = tlSafeNum(d.duration)
            snap.playState = tlIsPlaying(d) and "Playing" or "Paused"
            snap.wrapMode = tostring(d.extrapolationMode)
            snap.speed = 1.0
            pcall(function()
                local g = d.playableGraph
                if g:IsValid() and g:GetRootPlayableCount() > 0 then
                    snap.speed = g:GetRootPlayable(0):GetSpeed()
                end
            end)
            snap.assetName = ""
            pcall(function() if d.playableAsset then snap.assetName = d.playableAsset.name end end)

            snap.tracks = {}
            if d.playableAsset then
                local tracks = tlIter(d.playableAsset:GetOutputTracks())
                for ti, track in ipairs(tracks) do
                    local td = { trackName = "", trackType = "", muted = false, boundObjectName = "", clips = {} }
                    pcall(function()
                        td.trackName = track.name or ""
                        td.trackType = tostring(track:GetType().Name)
                        td.muted = track.muted
                        pcall(function()
                            local b = d:GetGenericBinding(track)
                            if b then td.boundObjectName = tostring(b.name or b) end
                        end)
                        for _, clip in ipairs(tlIter(track:GetClips())) do
                            pcall(function()
                                local cs, cd = clip.start, clip.duration
                                td.clips[#td.clips + 1] = {
                                    name = clip.displayName,
                                    start = tlSafeNum(cs),
                                    duration = tlSafeNum(cd),
                                    isActive = (d.time >= cs and d.time < cs + cd),
                                }
                            end)
                        end
                    end)
                    snap.tracks[#snap.tracks + 1] = td
                end
            end
            -- Events（静态数据，缓存避免每帧重复提取）
            local id = d:GetInstanceID()
            local cache = LuaTimelineMonitor._eventCaches[id]
            if not cache or cache.assetName ~= snap.assetName then
                cache = { assetName = snap.assetName, events = LuaTimelineMonitor.ExtractEvents(d) }
                LuaTimelineMonitor._eventCaches[id] = cache
            end
            snap.events = cache.events
        end)
        if not ok then origin_print("[RuntimeGM] Timeline TakeSnapshot error: " .. tostring(err)); return nil end
        return snap
    end

    -- 提取所有事件（3 种来源，与 Editor 版一致，结果缓存）
    function LuaTimelineMonitor.ExtractEvents(d)
        local events = {}
        local ok, _ = pcall(function()
            if not d.playableAsset then return end
            local evtIdx = 0
            local tracks = tlIter(d.playableAsset:GetOutputTracks())
            for ti, track in ipairs(tracks) do
                local trackTypeName = ""
                pcall(function() trackTypeName = tostring(track:GetType().Name) end)

                -- 1. InfiniteClip 帧事件（AnimationTrack 无离散 Clip 时）
                if trackTypeName == "AnimationTrack" then
                    pcall(function()
                        local infClip = track.infiniteClip
                        if infClip and infClip.events then
                            for ei = 0, infClip.events.Length - 1 do
                                local evt = infClip.events[ei]
                                events[#events + 1] = {
                                    time = tlSafeNum(evt.time),
                                    methodName = evt.functionName or "",
                                    sourceName = "[InfiniteClip] " .. (track.name or ""),
                                    eventIndex = evtIdx, trackIndex = ti - 1,
                                }
                                evtIdx = evtIdx + 1
                            end
                        end
                    end)
                end

                -- 2. 离散 Clip 内的 AnimationEvent
                for _, clip in ipairs(tlIter(track:GetClips())) do
                    pcall(function()
                        local animClip = nil
                        -- AnimationPlayableAsset.clip
                        pcall(function() if clip.asset then animClip = clip.asset.clip end end)
                        -- 备选：clip.animationClip
                        if not animClip then pcall(function() animClip = clip.animationClip end) end
                        if animClip and animClip.events then
                            local clipIn = clip.clipIn or 0
                            local clipStart = clip.start
                            local clipDur = clip.duration
                            for ei = 0, animClip.events.Length - 1 do
                                local evt = animClip.events[ei]
                                local localT = evt.time
                                if localT >= clipIn and localT <= clipIn + clipDur then
                                    local globalT = clipStart + (localT - clipIn)
                                    events[#events + 1] = {
                                        time = tlSafeNum(globalT),
                                        methodName = evt.functionName or "",
                                        sourceName = "[AnimEvent] " .. (clip.displayName or ""),
                                        eventIndex = evtIdx, trackIndex = ti - 1,
                                    }
                                    evtIdx = evtIdx + 1
                                end
                            end
                        end
                    end)
                end

                -- 3. SignalEmitter 标记
                pcall(function()
                    for _, marker in ipairs(tlIter(track:GetMarkers())) do
                        pcall(function()
                            if tostring(marker:GetType().Name) == "SignalEmitter" then
                                local sName = ""
                                pcall(function() if marker.asset then sName = marker.asset.name end end)
                                local mName = sName
                                -- 在绑定对象或 Director 上查找 SignalReceiver
                                pcall(function()
                                    local recv = nil
                                    pcall(function()
                                        local b = d:GetGenericBinding(track)
                                        local go = nil
                                        if b then pcall(function() go = b.gameObject end) end
                                        if not go then pcall(function() go = b end) end -- b 本身可能是 GO
                                        if go then recv = go:GetComponent(typeof(CS.UnityEngine.Timeline.SignalReceiver)) end
                                    end)
                                    if not recv then recv = d.gameObject:GetComponent(typeof(CS.UnityEngine.Timeline.SignalReceiver)) end
                                    if recv and marker.asset then
                                        local reaction = recv:GetReaction(marker.asset)
                                        if reaction and reaction:GetPersistentEventCount() > 0 then
                                            mName = reaction:GetPersistentMethodName(0)
                                        end
                                    end
                                end)
                                events[#events + 1] = {
                                    time = tlSafeNum(marker.time), methodName = mName,
                                    sourceName = sName, eventIndex = evtIdx, trackIndex = ti - 1,
                                }
                                evtIdx = evtIdx + 1
                            end
                        end)
                    end
                end)
            end

            -- 4. 根级 markerTrack 上的 Signal（不在 GetOutputTracks 结果中）
            pcall(function()
                local mt = d.playableAsset.markerTrack
                if mt then
                    for _, marker in ipairs(tlIter(mt:GetMarkers())) do
                        pcall(function()
                            if tostring(marker:GetType().Name) == "SignalEmitter" then
                                local sName = ""
                                pcall(function() if marker.asset then sName = marker.asset.name end end)
                                local mName = sName
                                pcall(function()
                                    local recv = d.gameObject:GetComponent(typeof(CS.UnityEngine.Timeline.SignalReceiver))
                                    if recv and marker.asset then
                                        local reaction = recv:GetReaction(marker.asset)
                                        if reaction and reaction:GetPersistentEventCount() > 0 then
                                            mName = reaction:GetPersistentMethodName(0)
                                        end
                                    end
                                end)
                                events[#events + 1] = {
                                    time = tlSafeNum(marker.time), methodName = mName,
                                    sourceName = sName, eventIndex = evtIdx, trackIndex = -1,
                                }
                                evtIdx = evtIdx + 1
                            end
                        end)
                    end
                end
            end)

            -- 按时间排序 + 重新编号
            table.sort(events, function(a, b) return a.time < b.time end)
            for i, e in ipairs(events) do e.eventIndex = i - 1 end
        end)
        return events
    end

    -- 处理命令
    function LuaTimelineMonitor.HandleCommand(packet)
        local action = packet.action
        if action == "scan" then
            RuntimeGMClient.Send({ type = "TIMELINE_RESP", action = "scan", data = LuaTimelineMonitor.ScanDirectors() })

        elseif action == "subscribe" then
            local id = packet.instanceId
            if id and LuaTimelineMonitor._directors[id] then
                if not LuaTimelineMonitor._monitored[id] then
                    LuaTimelineMonitor._monitored[id] = true
                    LuaTimelineMonitor._monitoredCount = LuaTimelineMonitor._monitoredCount + 1
                end
                local snap = LuaTimelineMonitor.TakeSnapshot(LuaTimelineMonitor._directors[id])
                if snap then RuntimeGMClient.Send({ type = "TIMELINE_RESP", action = "snapshot", data = snap }) end
            end

        elseif action == "unsubscribe" then
            local id = packet.instanceId
            if id and LuaTimelineMonitor._monitored[id] then
                LuaTimelineMonitor._monitored[id] = nil
                LuaTimelineMonitor._monitoredCount = LuaTimelineMonitor._monitoredCount - 1
            end

        elseif action == "unsubscribe_all" then
            LuaTimelineMonitor._monitored = {}
            LuaTimelineMonitor._monitoredCount = 0

        elseif action == "control" then
            local d = LuaTimelineMonitor._directors[packet.instanceId]
            if d then
                pcall(function()
                    local cmd = packet.cmd
                    if cmd == "play" then
                        -- 播完的 timeline 需要先 reset 才能重播
                        if d.duration > 0 and d.time >= d.duration then d.time = 0 end
                        d:Play()
                    elseif cmd == "replay" then d.time = 0; d:Play()
                    elseif cmd == "pause" then d:Pause()
                    elseif cmd == "stop" then d:Stop(); d.time = 0; d:Evaluate()
                    elseif cmd == "set_time" then d.time = packet.value or 0; d:Evaluate()
                    elseif cmd == "set_speed" then
                        local g = d.playableGraph
                        if g:IsValid() and g:GetRootPlayableCount() > 0 then
                            g:GetRootPlayable(0):SetSpeed(packet.value or 1.0)
                        end
                    end
                end)
            end

        elseif action == "invoke_signal" then
            local id = packet.instanceId
            local d = LuaTimelineMonitor._directors[id]
            if d then
                local cache = LuaTimelineMonitor._eventCaches[id]
                local evtIdx = packet.eventIndex
                if cache and cache.events and cache.events[evtIdx + 1] then
                    local evt = cache.events[evtIdx + 1]  -- Lua 1-indexed
                    local src = evt.sourceName or ""
                    pcall(function()
                        if src:sub(1, 10) == "[AnimEvent" or src:sub(1, 14) == "[InfiniteClip]" then
                            -- AnimationEvent → SendMessage 到 Track 绑定对象
                            local tracks = tlIter(d.playableAsset:GetOutputTracks())
                            local t = tracks[evt.trackIndex + 1]
                            if t then
                                local b = d:GetGenericBinding(t)
                                local go = nil
                                pcall(function() go = b.gameObject end)
                                if not go then go = b end
                                if go and evt.methodName ~= "" then
                                    go:SendMessage(evt.methodName, CS.UnityEngine.SendMessageOptions.DontRequireReceiver)
                                end
                            end
                        else
                            -- SignalEmitter → 重新遍历 markers 匹配 time+name 触发
                            local tracks = tlIter(d.playableAsset:GetOutputTracks())
                            local allTracks = {}
                            for _, tr in ipairs(tracks) do allTracks[#allTracks + 1] = tr end
                            pcall(function() if d.playableAsset.markerTrack then allTracks[#allTracks + 1] = d.playableAsset.markerTrack end end)
                            for _, tr in ipairs(allTracks) do
                                for _, marker in ipairs(tlIter(tr:GetMarkers())) do
                                    pcall(function()
                                        if tostring(marker:GetType().Name) == "SignalEmitter"
                                            and math.abs(marker.time - evt.time) < 0.001 then
                                            local recv = nil
                                            pcall(function()
                                                local b = d:GetGenericBinding(tr)
                                                local go = nil
                                                pcall(function() go = b.gameObject end)
                                                if not go then go = b end
                                                if go then recv = go:GetComponent(typeof(CS.UnityEngine.Timeline.SignalReceiver)) end
                                            end)
                                            if not recv then recv = d.gameObject:GetComponent(typeof(CS.UnityEngine.Timeline.SignalReceiver)) end
                                            if recv and marker.asset then
                                                local reaction = recv:GetReaction(marker.asset)
                                                if reaction then reaction:Invoke() end
                                            end
                                        end
                                    end)
                                end
                            end
                        end
                    end)
                end
            end

        elseif action == "mute_track" then
            local d = LuaTimelineMonitor._directors[packet.instanceId]
            if d and d.playableAsset then
                pcall(function()
                    local tracks = tlIter(d.playableAsset:GetOutputTracks())
                    local t = tracks[packet.trackIndex + 1]
                    if t then t.muted = not t.muted end
                end)
            end
        end
    end

    -- 每帧推送（仅在有监控时）
    function LuaTimelineMonitor.Update()
        if LuaTimelineMonitor._monitoredCount <= 0 then return end
        local now = CS.UnityEngine.Time.realtimeSinceStartup

        if now - LuaTimelineMonitor._lastScanTime >= LuaTimelineMonitor._scanInterval then
            LuaTimelineMonitor._lastScanTime = now
            LuaTimelineMonitor.ScanDirectors()
        end
        if now - LuaTimelineMonitor._lastPushTime < LuaTimelineMonitor._pushInterval then return end
        LuaTimelineMonitor._lastPushTime = now

        local toRemove = {}
        for id in pairs(LuaTimelineMonitor._monitored) do
            local d = LuaTimelineMonitor._directors[id]
            if d then
                local vOk, v = pcall(function() return d.gameObject.activeInHierarchy end)
                if vOk and v then
                    local snap = LuaTimelineMonitor.TakeSnapshot(d)
                    if snap then RuntimeGMClient.Send({ type = "TIMELINE_RESP", action = "snapshot", data = snap }) end
                else
                    toRemove[#toRemove + 1] = id
                end
            else
                toRemove[#toRemove + 1] = id
            end
        end
        for _, id in ipairs(toRemove) do
            LuaTimelineMonitor._monitored[id] = nil
            LuaTimelineMonitor._monitoredCount = LuaTimelineMonitor._monitoredCount - 1
            RuntimeGMClient.Send({ type = "TIMELINE_RESP", action = "removed", data = { instanceId = id } })
        end
    end

    -- 前置声明：供 CsMonitor 和 Inspector 共用的属性值序列化函数（定义在 Inspector 区域）
    local inspectorSerializePropValue

    -- ========== 共享常量 & 工具函数 (CsMonitor + Inspector 复用) ==========
    local _PROP_BLACKLIST = {
        mesh=1, material=1, materials=1, sharedMesh=1, sharedMaterial=1, sharedMaterials=1,
        rigidbody=1, rigidbody2D=1, camera=1, light=1, animation=1, constantForce=1,
        renderer=1, audio=1, networkView=1, collider=1, collider2D=1, hingeJoint=1, particleSystem=1,
        destroyCancellationToken=1, useGUILayout=1, runInEditMode=1,
    }
    local _SKIP_METHODS = {
        Awake=1, Start=1, Update=1, LateUpdate=1, FixedUpdate=1, OnDestroy=1, OnEnable=1, OnDisable=1,
        OnApplicationFocus=1, OnApplicationPause=1, OnApplicationQuit=1, OnValidate=1, Reset=1,
        OnBecameVisible=1, OnBecameInvisible=1, OnPreRender=1, OnPostRender=1, OnRenderObject=1,
        OnWillRenderObject=1, OnRenderImage=1, OnDrawGizmos=1, OnDrawGizmosSelected=1, OnGUI=1,
        OnCollisionEnter=1, OnCollisionExit=1, OnCollisionStay=1, OnTriggerEnter=1, OnTriggerExit=1, OnTriggerStay=1,
        OnCollisionEnter2D=1, OnCollisionExit2D=1, OnTriggerEnter2D=1, OnTriggerExit2D=1,
        OnMouseDown=1, OnMouseUp=1, OnMouseEnter=1, OnMouseExit=1, OnMouseDrag=1, OnMouseOver=1,
        OnTransformParentChanged=1, OnTransformChildrenChanged=1, OnBeforeTransformParentChanged=1,
        ToString=1, GetHashCode=1, Equals=1, GetType=1, GetInstanceID=1, GetComponent=1, GetComponentInChildren=1,
        GetComponentInParent=1, GetComponents=1, GetComponentsInChildren=1, GetComponentsInParent=1,
        CompareTag=1, SendMessage=1, SendMessageUpwards=1, BroadcastMessage=1, TryGetComponent=1,
        StartCoroutine=1, StopCoroutine=1, StopAllCoroutines=1, Invoke=1, InvokeRepeating=1, CancelInvoke=1, IsInvoking=1,
    }

    local function convertTypedValue(value, valueType)
        if valueType == "bool" then return (value == true or value == "true")
        elseif valueType == "int" then return math.floor(tonumber(value) or 0)
        elseif valueType == "float" then return tonumber(value) or 0
        elseif valueType == "string" then return tostring(value or "")
        elseif valueType == "vector2" then return CS.UnityEngine.Vector2(value[1] or 0, value[2] or 0)
        elseif valueType == "vector3" then return CS.UnityEngine.Vector3(value[1] or 0, value[2] or 0, value[3] or 0)
        elseif valueType == "vector4" then return CS.UnityEngine.Vector4(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 0)
        elseif valueType == "color" then return CS.UnityEngine.Color(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 1)
        elseif valueType == "euler" then return CS.UnityEngine.Quaternion.Euler(value[1] or 0, value[2] or 0, value[3] or 0)
        else return value
        end
    end

    local function callCompMethodImpl(comp, methodName)
        local fn = comp[methodName]
        if fn and type(fn) == "function" then
            local result = fn(comp)
            return true, result ~= nil and tostring(result) or "void"
        end
        pcall(function() xlua.private_accessible(comp:GetType()) end)
        fn = comp[methodName]
        if fn and type(fn) == "function" then
            local result = fn(comp)
            return true, result ~= nil and tostring(result) or "void"
        end
        return false, "method not found: " .. tostring(methodName)
    end

    -- 读取组件的属性、字段、方法（CsMonitor.GetDetail 和 Inspector.GetComponentDetail 共用）
    local function readComponentDetail(comp)
        local result = { properties = {}, methods = {}, _debug = { propCount = 0, tried = 0, failed = 0 } }

        -- 属性 (Properties)
        local props
        pcall(function() props = comp:GetType():GetProperties(20) end)
        if not props then pcall(function() props = comp:GetType():GetProperties() end) end
        local propCount = 0
        if props then pcall(function() propCount = props.Length end) end
        result._debug.propCount = propCount
        for i = 0, propCount - 1 do
            local prop = props[i]
            pcall(function()
                if prop.IsSpecialName then return end
                local idxParams = prop:GetIndexParameters()
                if idxParams and idxParams.Length > 0 then return end
                if not prop.CanRead then return end
                local pName = tostring(prop.Name)
                if _PROP_BLACKLIST[pName] then return end
                local propTypeName = tostring(prop.PropertyType.Name)
                result._debug.tried = result._debug.tried + 1
                local valOk, val = pcall(function() return comp[pName] end)
                if not valOk then valOk, val = pcall(function() return prop:GetValue(comp) end) end
                if not valOk then valOk, val = pcall(function() return prop:GetValue(comp, nil) end) end
                if not valOk then result._debug.failed = result._debug.failed + 1; return end
                local serialized, valueType = inspectorSerializePropValue(val, propTypeName)
                result.properties[#result.properties + 1] = {
                    name = pName, typeName = propTypeName, valueType = valueType,
                    value = serialized, editable = prop.CanWrite and valueType ~= "readonly",
                }
            end)
        end

        -- 字段 (Fields)
        local fields
        pcall(function() fields = comp:GetType():GetFields(20) end)
        local fieldCount = 0
        if fields then pcall(function() fieldCount = fields.Length end) end
        for i = 0, fieldCount - 1 do
            local fld = fields[i]
            pcall(function()
                if fld.IsSpecialName then return end
                local fName = tostring(fld.Name)
                local fTypeName = tostring(fld.FieldType.Name)
                local valOk, val = pcall(function() return comp[fName] end)
                if not valOk then valOk, val = pcall(function() return fld:GetValue(comp) end) end
                if not valOk then return end
                local serialized, valueType = inspectorSerializePropValue(val, fTypeName)
                result.properties[#result.properties + 1] = {
                    name = fName, typeName = fTypeName, valueType = valueType,
                    value = serialized, editable = (not fld.IsInitOnly) and valueType ~= "readonly", isField = true,
                }
            end)
        end

        -- 方法
        local methods
        local mOk, _ = pcall(function() methods = comp:GetType():GetMethods(20) end)
        if not mOk then pcall(function() methods = comp:GetType():GetMethods() end) end
        if not methods then methods = {} end
        local methodCount = 0
        pcall(function() methodCount = methods.Length end)
        if methodCount == 0 then methodCount = #methods end
        for i = 0, methodCount - 1 do
            local m = methods[i]
            pcall(function()
                if m.IsSpecialName then return end
                if _SKIP_METHODS[m.Name] then return end
                local params = m:GetParameters()
                local paramList = {}
                for j = 0, params.Length - 1 do
                    paramList[#paramList + 1] = { name = params[j].Name, typeName = tostring(params[j].ParameterType.Name) }
                end
                local entry = { name = m.Name, paramCount = params.Length, params = paramList }
                if params.Length == 0 then
                    local canCall = false
                    pcall(function()
                        local fn = comp[m.Name]
                        if fn and type(fn) == "function" then canCall = true end
                    end)
                    if not canCall then
                        pcall(function() xlua.private_accessible(comp:GetType()) end)
                        pcall(function()
                            local fn = comp[m.Name]
                            if fn and type(fn) == "function" then canCall = true end
                        end)
                    end
                    if not canCall then entry.callable = false end
                end
                result.methods[#result.methods + 1] = entry
            end)
        end

        return result
    end

    -- ========== LuaCsMonitor: C# 组件搜索 + 监控 (真机兼容) ==========
    local LuaCsMonitor = {}
    LuaCsMonitor._compRefs = {}    -- "goId_compIdx" → {go, comp, goName, parentName, typeName}
    LuaCsMonitor._scanResults = {} -- 最近一次搜索结果

    origin_print("[RuntimeGM] LuaCsMonitor module initialized")

    local function getHierarchyPath(go)
        local parts = {}
        local t = go.transform
        while t do
            parts[#parts + 1] = t.name
            t = t.parent
        end
        -- 反转拼接
        local path = ""
        for i = #parts, 1, -1 do
            path = path .. (path ~= "" and "/" or "") .. parts[i]
        end
        return path
    end

    -- 扫描所有 GameObject，按组件类型名字符串匹配（绕过 typeof 动态解析的 xlua 兼容问题）
    function LuaCsMonitor.Scan(typeName)
        local ok, allGOs = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.GameObject))
        end)
        if not ok or not allGOs then return { error = "扫描 GameObject 失败: " .. tostring(allGOs) } end

        local results = {}
        local maxShow = 200
        local total = 0
        LuaCsMonitor._compRefs = {}

        for gi = 0, allGOs.Length - 1 do
            if #results >= maxShow then break end
            pcall(function()
                local go = allGOs[gi]
                if not go then return end
                local comps = go:GetComponents(typeof(CS.UnityEngine.Component))
                if not comps then return end

                -- 统计匹配组件数
                local sameCount, matches = 0, {}
                for ci = 0, comps.Length - 1 do
                    pcall(function()
                        local c = comps[ci]
                        if c and tostring(c:GetType().Name) == typeName then
                            sameCount = sameCount + 1
                            matches[#matches + 1] = ci
                        end
                    end)
                end
                if sameCount == 0 then return end

                local goId = go:GetInstanceID()
                local goName = go.name
                local parentName = ""
                pcall(function() local p = go.transform.parent; if p then parentName = p.name end end)
                local hPath = ""; pcall(function() hPath = getHierarchyPath(go) end)

                for si, ci in ipairs(matches) do
                    if #results >= maxShow then total = total + 1; return end
                    total = total + 1
                    local key = goId .. "_" .. ci
                    LuaCsMonitor._compRefs[key] = { go = go, comp = comps[ci], goName = goName, parentName = parentName, typeName = typeName }
                    results[#results + 1] = {
                        goInstanceId = goId, goName = goName, parentName = parentName,
                        hierarchyPath = hPath,
                        compIndex = ci, compTypeName = typeName,
                        sameTypeIndex = si - 1, sameTypeCount = sameCount,
                    }
                end
            end)
        end

        local resp = { results = results }
        if total > maxShow then resp.truncated = true; resp.total = total; resp.shown = maxShow end
        return resp
    end

    function LuaCsMonitor.GetDetail(goInstanceId, compIndex)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaCsMonitor._compRefs[key]
        if not ref or not ref.comp then return { error = "组件未找到，请重新搜索" } end
        local alive = false
        pcall(function() alive = ref.go.name ~= nil end)
        if not alive then return { error = "GameObject 已销毁" } end
        local ok, detail = pcall(readComponentDetail, ref.comp)
        if not ok then return { error = tostring(detail) } end
        detail.goName = ref.goName
        detail.typeName = ref.typeName
        detail.isActive = false
        pcall(function() detail.isActive = ref.go.activeInHierarchy end)
        table.sort(detail.properties, function(a, b) return a.name < b.name end)
        table.sort(detail.methods, function(a, b) return a.name < b.name end)
        return detail
    end

    function LuaCsMonitor.SetProp(goInstanceId, compIndex, propName, value, valueType)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaCsMonitor._compRefs[key]
        if not ref or not ref.comp then return { error = "组件未找到" } end
        local ok, err = pcall(function() ref.comp[propName] = convertTypedValue(value, valueType) end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
    end

    function LuaCsMonitor.CallMethod(goInstanceId, compIndex, methodName)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaCsMonitor._compRefs[key]
        if not ref or not ref.comp then return { error = "组件未找到" } end
        local ok, ret = pcall(function()
            local found, result = callCompMethodImpl(ref.comp, methodName)
            if not found then error(result) end
            return result
        end)
        if not ok then return { error = tostring(ret) } end
        return { success = true, result = ret }
    end

    function LuaCsMonitor.HandleCommand(packet)
        local action = packet.action
        local result
        if action == "scan" then
            result = LuaCsMonitor.Scan(packet.typeName)
        elseif action == "cache_from_inspector" then
            result = (function()
                -- 内联路径导航（不依赖 Inspector 的 local 函数，因为 CsMonitor 定义在 Inspector 之前）
                local luaUi = XLuaUiManager.GetTopLuaUi(packet.uiName)
                if not luaUi then return { error = "UI not found: " .. tostring(packet.uiName) } end
                local target = luaUi
                local path = packet.path
                if path and path ~= "" then
                    for seg in string.gmatch(path, "[^%.]+") do
                        local key = tonumber(seg) or seg
                        if type(target) ~= "table" then return { error = "path resolve failed" } end
                        target = target[key]
                    end
                end
                if not target or type(target) ~= "userdata" then return { error = "target is not userdata" } end
                -- 获取 GO
                local go
                pcall(function()
                    local ok2, goObj = pcall(function() return target.gameObject end)
                    if ok2 and goObj then go = goObj
                    else
                        local ok3, ah = pcall(function() return target.activeInHierarchy end)
                        if ok3 and type(ah) == "boolean" then go = target end
                    end
                end)
                if not go then return { error = "GO not found" } end
                local ok2, r = pcall(function()
                    local allC = go:GetComponents(typeof(CS.UnityEngine.Component))
                    local ci = packet.compIndex
                    if ci < 0 or ci >= allC.Length then error("compIndex out of range") end
                    local comp = allC[ci]
                    local goId = go:GetInstanceID()
                    local key = goId .. "_" .. ci
                    local tn = ""; pcall(function() tn = tostring(comp:GetType().Name) end)
                    local pn = ""; pcall(function() local p = go.transform.parent; if p then pn = p.name end end)
                    local hPath = ""; pcall(function() hPath = getHierarchyPath(go) end)
                    LuaCsMonitor._compRefs[key] = { go = go, comp = comp, goName = go.name, parentName = pn, typeName = tn }
                    return { success = true, entry = {
                        goInstanceId = goId, goName = go.name, parentName = pn,
                        hierarchyPath = hPath,
                        compIndex = ci, compTypeName = tn, sameTypeIndex = 0, sameTypeCount = 1,
                    }}
                end)
                if not ok2 then return { error = tostring(r) } end
                return r
            end)()
        elseif action == "get_detail" then
            result = LuaCsMonitor.GetDetail(packet.goInstanceId, packet.compIndex)
        elseif action == "set_prop" then
            result = LuaCsMonitor.SetProp(packet.goInstanceId, packet.compIndex, packet.propName, packet.value, packet.valueType)
        elseif action == "call_method" then
            result = LuaCsMonitor.CallMethod(packet.goInstanceId, packet.compIndex, packet.methodName)
        else
            result = { error = "Unknown action: " .. tostring(action) }
        end
        RuntimeGMClient.Send({ type = "CS_MONITOR_RESP", action = action, data = result })
    end

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
    local INSPECTOR_MAX_FIELDS = 200  -- GetNodeData 根级最大字段数

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
        elseif t == "function" then return { type = "function", value = "function", editable = false, addr = tostring(value) }
        elseif t == "userdata" then
            local result = { type = "userdata", value = displayName or "userdata", editable = false }
            -- 尝试读取关联 GameObject 的激活状态和名称
            pcall(function()
                local go
                -- Component 类型 → 通过 .gameObject 获取
                local ok2, goObj = pcall(function() return value.gameObject end)
                if ok2 and goObj then
                    go = goObj
                else
                    -- 可能是 GameObject 自身 → 直接检查 activeInHierarchy
                    local ok3, ah = pcall(function() return value.activeInHierarchy end)
                    if ok3 and type(ah) == "boolean" then go = value end
                end
                if go then
                    result.goName = tostring(go.name)
                    result.goActive = go.activeInHierarchy
                    result.goSelf = go.activeSelf
                end
                -- Text / TMP 组件：携带 .text 内容
                if displayName and (displayName:find("Text") or displayName:find("TMPro")) then
                    pcall(function() result.goText = tostring(value.text) end)
                end
            end)
            return result
        elseif t == "table" then
            if visited[value] then return { type = "ref", value = "[circular]", editable = false } end
            local childCount = inspectorTableKeyCount(value)
            if depth <= 0 or (key and INSPECTOR_SKIP_KEYS[key]) then
                return { type = "table", childCount = childCount, expandable = true, editable = false, addr = tostring(value) }
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
            local result = { type = "table", childCount = childCount, expandable = true, editable = false, fields = fields, addr = tostring(value) }
            if truncated then result.truncated = true; result.total = childCount; result.shown = shown end
            return result
        else
            return { type = t, value = tostring(value), editable = false }
        end
    end

    origin_print("[RuntimeGM] LuaUiInspector module initialized")

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
        local instanceKeys = {}
        local allKeys = inspectorGetSortedKeys(target)
        local totalKeys = #allKeys
        local fieldTruncated = false
        for i, k in ipairs(allKeys) do
            if #fields >= INSPECTOR_MAX_FIELDS then fieldTruncated = true; break end
            local v = target[k]
            local keyStr = tostring(k)
            instanceKeys[keyStr] = true
            local fieldPath = (not path or path == "") and keyStr or (path .. "." .. keyStr)
            local desc = inspectorSerializeValue(v, INSPECTOR_SKIP_KEYS[k] and 0 or (depth - 1), visited, k)
            desc.key = keyStr
            desc.modified = originals[fieldPath] ~= nil
            fields[#fields + 1] = desc
        end
        -- 收集元表（class）方法：通过 __index 链获取类定义的方法
        if not fieldTruncated then
            local mt = getmetatable(target)
            if mt then
                local idx = rawget(mt, "__index")
                if type(idx) == "table" then
                    local classMethods = {}
                    for k, v in pairs(idx) do
                        if type(k) == "string" and type(v) == "function" and not instanceKeys[k] then
                            classMethods[#classMethods + 1] = k
                        end
                    end
                    table.sort(classMethods)
                    for _, k in ipairs(classMethods) do
                        if #fields >= INSPECTOR_MAX_FIELDS then fieldTruncated = true; break end
                        fields[#fields + 1] = {
                            key = k, type = "function", value = "function (class)",
                            editable = false, modified = false,
                        }
                    end
                end
            end
        end
        local result = { fields = fields }
        if fieldTruncated then
            result.truncated = true
            result.totalKeys = totalKeys
            result.shownKeys = #fields
        end
        return result
    end

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

    function LuaUiInspector.CallMethod(uiName, path, methodName)
        local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
        if not luaUi then return { error = "UI not found" } end
        -- 定位到目标节点
        local target = luaUi
        if path and path ~= "" then
            for seg in string.gmatch(path, "[^%.]+") do
                local key = tonumber(seg) or seg
                if type(target) ~= "table" then return { error = "Path invalid" } end
                target = target[key]
            end
        end
        if type(target) ~= "table" then return { error = "Target is not a table" } end
        -- 查找方法：先查实例，再查元表
        local fn = target[methodName]
        if not fn then
            local mt = getmetatable(target)
            if mt then
                local idx = rawget(mt, "__index")
                if type(idx) == "table" then fn = idx[methodName] end
            end
        end
        if type(fn) ~= "function" then return { error = "Method not found: " .. tostring(methodName) } end
        -- 调用方法（以 target 作为 self）
        local ok, ret = pcall(fn, target)
        if not ok then return { error = "Call failed: " .. tostring(ret) } end
        -- 序列化返回值
        local retType = type(ret)
        if retType == "nil" then
            return { result = "nil", resultType = "nil" }
        elseif retType == "number" or retType == "string" or retType == "boolean" then
            return { result = ret, resultType = retType }
        elseif retType == "table" then
            local count = 0
            for _ in pairs(ret) do count = count + 1 end
            return { result = "table (" .. count .. " items)", resultType = "table" }
        else
            return { result = tostring(ret), resultType = retType }
        end
    end

    -- 辅助：沿路径获取 userdata 值及其 GameObject
    local function inspectorGetGoFromPath(uiName, path)
        local luaUi = XLuaUiManager.GetTopLuaUi(uiName)
        if not luaUi then return nil, nil end
        local _, _, value = inspectorResolvePath(luaUi, path)
        if not value or type(value) ~= "userdata" then return nil, nil end
        local go
        local ok2, goObj = pcall(function() return value.gameObject end)
        if ok2 and goObj then go = goObj
        else
            local ok3, ah = pcall(function() return value.activeInHierarchy end)
            if ok3 and type(ah) == "boolean" then go = value end
        end
        return value, go
    end

    function LuaUiInspector.ToggleGoVisible(uiName, path)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GameObject not found" } end
        local ok, err = pcall(function() go:SetActive(not go.activeSelf) end)
        if not ok then return { error = tostring(err) } end
        return { success = true, activeSelf = go.activeSelf }
    end

    function LuaUiInspector.SetGoText(uiName, path, text)
        local value, _ = inspectorGetGoFromPath(uiName, path)
        if not value then return { error = "Component not found" } end
        local ok, err = pcall(function() value.text = text end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
    end

    function LuaUiInspector.DestroyGo(uiName, path)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GameObject not found" } end
        local ok, err = pcall(function() CS.UnityEngine.Object.Destroy(go) end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
    end

    -- 获取 GO 上所有组件名称列表（Level 1，无反射，极快）
    function LuaUiInspector.GetComponents(uiName, path)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GameObject not found" } end
        local comps = {}
        local ok, err = pcall(function()
            local all = go:GetComponents(typeof(CS.UnityEngine.Component))
            for i = 0, all.Length - 1 do
                local c = all[i]
                if c then
                    local name = ""
                    pcall(function() name = tostring(c:GetType().Name) end)
                    comps[#comps + 1] = { index = i, typeName = name }
                end
            end
        end)
        if not ok then return { error = tostring(err) } end
        return { components = comps, gameObjectName = go.name }
    end

    -- 序列化单个属性值为 JSON 安全的 Lua 表
    inspectorSerializePropValue = function(val, typeName)
        if val == nil then return nil, "nil" end
        local tn = typeName or ""
        -- 基本类型
        if tn == "Boolean" then return val, "bool"
        elseif tn == "Int32" or tn == "Int64" or tn == "Byte" or tn == "Int16" then return val, "int"
        elseif tn == "Single" or tn == "Double" then return val, "float"
        elseif tn == "String" then return val ~= nil and tostring(val) or "", "string"
        end
        -- Unity 向量/颜色
        local ok, r, rType = pcall(function()
            if tn == "Vector2" then return {val.x, val.y}, "vector2"
            elseif tn == "Vector3" then return {val.x, val.y, val.z}, "vector3"
            elseif tn == "Vector4" then return {val.x, val.y, val.z, val.w}, "vector4"
            elseif tn == "Color" then return {val.r, val.g, val.b, val.a}, "color"
            elseif tn == "Rect" then return {val.x, val.y, val.width, val.height}, "rect"
            elseif tn == "Quaternion" then
                local e = val.eulerAngles
                return {e.x, e.y, e.z}, "euler"
            end
            return nil, nil
        end)
        if ok and r then return r, rType end
        -- 枚举
        local eOk, eVal, eType = pcall(function()
            if val:GetType().IsEnum then return tostring(val), "enum" end
            return nil, nil
        end)
        if eOk and eVal then return eVal, eType end
        -- 其他：只读显示
        local sOk, sVal = pcall(function() return tostring(val) end)
        return sOk and sVal or "(unknown)", "readonly"
    end

    -- 获取单个组件的属性 + 方法（Level 2，复用 readComponentDetail）
    function LuaUiInspector.GetComponentDetail(uiName, path, compIndex)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GameObject not found" } end
        local ok, result = pcall(function()
            local all = go:GetComponents(typeof(CS.UnityEngine.Component))
            if compIndex < 0 or compIndex >= all.Length then error("index out of range") end
            local comp = all[compIndex]
            if not comp then error("component is null") end
            local detail = readComponentDetail(comp)
            detail.typeName = tostring(comp:GetType().Name)
            return detail
        end)
        if not ok then return { error = tostring(result) } end
        return result
    end

    -- 设置组件属性
    function LuaUiInspector.SetComponentProp(uiName, path, compIndex, propName, value, valueType)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GO not found" } end
        local ok, err = pcall(function()
            local all = go:GetComponents(typeof(CS.UnityEngine.Component))
            local comp = all[compIndex]
            comp[propName] = convertTypedValue(value, valueType)
        end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
    end

    -- 调用组件方法
    function LuaUiInspector.CallComponentMethod(uiName, path, compIndex, methodName)
        local _, go = inspectorGetGoFromPath(uiName, path)
        if not go then return { error = "GO not found" } end
        local ok, ret = pcall(function()
            local all = go:GetComponents(typeof(CS.UnityEngine.Component))
            local comp = all[compIndex]
            local found, result = callCompMethodImpl(comp, methodName)
            if not found then error(result) end
            return result
        end)
        if not ok then return { error = tostring(ret) } end
        return { success = true, result = tostring(ret or "void") }
    end

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
        elseif action == "call_method" then
            result = LuaUiInspector.CallMethod(packet.uiName, packet.path, packet.methodName)
        elseif action == "toggle_go_visible" then
            result = LuaUiInspector.ToggleGoVisible(packet.uiName, packet.path)
        elseif action == "set_text" then
            result = LuaUiInspector.SetGoText(packet.uiName, packet.path, packet.value)
        elseif action == "destroy_go" then
            result = LuaUiInspector.DestroyGo(packet.uiName, packet.path)
        elseif action == "get_components" then
            result = LuaUiInspector.GetComponents(packet.uiName, packet.path)
        elseif action == "get_component_detail" then
            result = LuaUiInspector.GetComponentDetail(packet.uiName, packet.path, packet.compIndex)
        elseif action == "set_component_prop" then
            result = LuaUiInspector.SetComponentProp(packet.uiName, packet.path, packet.compIndex, packet.propName, packet.value, packet.valueType)
        elseif action == "call_component_method" then
            result = LuaUiInspector.CallComponentMethod(packet.uiName, packet.path, packet.compIndex, packet.methodName)
        else
            result = { error = "Unknown action: " .. tostring(action) }
        end
        RuntimeGMClient.Send({ type = "UI_INSPECTOR_RESP", action = action, data = result })
    end

    -- 前向声明：让 RuntimeGMClient.Update() 闭包能捕获到这个 upvalue
    local LuaAvMonitor = {}

    function RuntimeGMClient.Update()
        if not RuntimeGMClient.IsRunning then return end
        if not RuntimeGMClient.Socket then
            local now = 0
            pcall(function() now = CS.UnityEngine.Time.realtimeSinceStartup end)
            if now - RuntimeGMClient.ReconnectTimer > 3.0 then
                RuntimeGMClient.ReconnectTimer = now
                RuntimeGMClient.Connect()
            end
            return
        end
        if not RuntimeGMClient.GMLoaded then
            RuntimeGMClient.GMRetryTimer = (RuntimeGMClient.GMRetryTimer or 0) + CS.UnityEngine.Time.unscaledDeltaTime
            if RuntimeGMClient.GMRetryTimer > 1.0 then
                RuntimeGMClient.GMRetryTimer = 0
                if rawget(_G, "XLoginManager") and rawget(_G, "XUiManager") and rawget(_G, "XFunctionManager") then RuntimeGMClient.ReloadGM() end
            end
        end
        -- TCP 心跳保活
        local now = 0
        pcall(function() now = CS.UnityEngine.Time.realtimeSinceStartup end)
        if now - RuntimeGMClient.HeartbeatTimer > RuntimeGMClient.HeartbeatInterval then
            RuntimeGMClient.HeartbeatTimer = now
            RuntimeGMClient.Send({ type = "PING" })
        end
        -- 心跳超时检测：长时间未收到任何数据则主动断开触发重连
        if RuntimeGMClient.LastRecvTime > 0 and now - RuntimeGMClient.LastRecvTime > RuntimeGMClient.RecvTimeout then
            origin_print("[RuntimeGM] 心跳超时（" .. RuntimeGMClient.RecvTimeout .. "s 无响应），断开重连...")
            RuntimeGMClient.Close()
            return
        end
        local maxLoops = 5
        local loops = 0
        while loops < maxLoops do
            loops = loops + 1
            local ok, result = pcall(function()
                RuntimeGMClient.Socket:settimeout(0)
                local line, err, partial = RuntimeGMClient.Socket:receive("*l")
                return {line = line, err = err, partial = partial}
            end)
            if not ok then
                local errStr = tostring(result)
                if errStr:find("closed") or errStr:find("refused") or errStr:find("reset") then
                    RuntimeGMClient.Close()
                end
                -- 其他pcall错误(如socket临时不可用)不断连，跳出循环等下帧重试
                return
            end
            local line = result.line
            local err = result.err
            local partial = result.partial
            if not line and partial and #partial > 0 then line = partial end
            if not line then
                if err == "closed" then RuntimeGMClient.Close(); return
                elseif err == "timeout" then break
                else break end
            else
                RuntimeGMClient.LastRecvTime = now
                RuntimeGMClient.ProcessPacket(line)
            end
        end

        -- Lua 侧 Animator 数据采集 & 推送（真机兼容，不依赖 C# Editor 代码）
        local animOk, animErr = pcall(LuaAnimatorMonitor.Update)
        if not animOk then
            origin_print("[RuntimeGM] LuaAnimatorMonitor error: " .. tostring(animErr))
        end

        -- Lua 侧 Timeline 数据采集 & 推送
        local tlOk, tlErr = pcall(LuaTimelineMonitor.Update)
        if not tlOk then
            origin_print("[RuntimeGM] LuaTimelineMonitor error: " .. tostring(tlErr))
        end

        -- AV Monitor 音视频监控推送
        local avOk, avErr = pcall(LuaAvMonitor.Update)
        if not avOk then
            origin_print("[RuntimeGM] LuaAvMonitor error: " .. tostring(avErr))
        end
    end

    -- ========== SubPkgMonitor: 分包监控（只读） ==========
    -- ================================================================
    -- PlayerPrefsMonitor: 远程查看/编辑 PlayerPrefs
    -- ================================================================
    local PlayerPrefsMonitor = {}

    local function _ppm_sendResp(action, data, err)
        local pkt = { type = "PLAYER_PREFS_RESP", action = action }
        if err then pkt.error = err else pkt.data = data end
        RuntimeGMClient.Send(pkt)
    end

    function PlayerPrefsMonitor.HandleGetAll()
        local entries = {}
        local enumOk = false
        local platform = "Unknown"
        pcall(function() platform = CS.UnityEngine.Application.platform:ToString() end)

        if platform == "WindowsEditor" or platform == "WindowsPlayer" then
            local ok, err = pcall(function()
                local Registry = CS.Microsoft.Win32.Registry
                local company = CS.UnityEngine.Application.companyName
                local product = CS.UnityEngine.Application.productName
                local isEditor = CS.UnityEngine.Application.isEditor
                local path = isEditor
                    and ("Software\\Unity\\UnityEditor\\" .. company .. "\\" .. product)
                    or ("Software\\" .. company .. "\\" .. product)
                local regKey = Registry.CurrentUser:OpenSubKey(path)
                if not regKey then return end
                local names = regKey:GetValueNames()
                for i = 0, names.Length - 1 do
                    local rawName = names[i]
                    -- Strip _hXXXXXXXX suffix (8 hex digits at end)
                    local key = rawName:match("^(.-)_h%x%x%x%x%x%x%x%x$") or rawName
                    -- Detect type via PlayerPrefs API
                    local SENTINEL = "\1\2\3_NOTSTR_\3\2\1"
                    local strVal = CS.UnityEngine.PlayerPrefs.GetString(key, SENTINEL)
                    if strVal ~= SENTINEL then
                        entries[#entries + 1] = { key = key, value = strVal, type = "string" }
                    else
                        local v1 = CS.UnityEngine.PlayerPrefs.GetInt(key, -1)
                        local v2 = CS.UnityEngine.PlayerPrefs.GetInt(key, 0)
                        if v1 == -1 and v2 == 0 then
                            entries[#entries + 1] = { key = key, value = tostring(CS.UnityEngine.PlayerPrefs.GetFloat(key)), type = "float" }
                        else
                            entries[#entries + 1] = { key = key, value = tostring(CS.UnityEngine.PlayerPrefs.GetInt(key)), type = "int" }
                        end
                    end
                end
                regKey:Close()
            end)
            if ok then enumOk = true end
        elseif platform == "Android" then
            local ok, err = pcall(function()
                local id = CS.UnityEngine.Application.identifier
                local paths = {
                    "/data/data/" .. id .. "/shared_prefs/" .. id .. ".v2.playerprefs.xml",
                    "/data/data/" .. id .. "/shared_prefs/" .. id .. ".playerprefs.xml",
                }
                local content = nil
                for _, p in ipairs(paths) do
                    local fOk, fContent = pcall(function() return CS.System.IO.File.ReadAllText(p) end)
                    if fOk and fContent and fContent ~= "" then content = fContent; break end
                end
                if not content then return end
                for name, value in content:gmatch('<string%s+name="([^"]+)">(.-)</string>') do
                    entries[#entries + 1] = { key = name, value = value, type = "string" }
                end
                for name, value in content:gmatch('<int%s+name="([^"]+)"%s+value="([^"]*)"') do
                    entries[#entries + 1] = { key = name, value = value, type = "int" }
                end
                for name, value in content:gmatch('<float%s+name="([^"]+)"%s+value="([^"]*)"') do
                    entries[#entries + 1] = { key = name, value = value, type = "float" }
                end
            end)
            if ok and #entries > 0 then enumOk = true end
        end
        -- iOS or other: enumOk stays false
        _ppm_sendResp("get_all", { entries = entries, enumSupported = enumOk, platform = platform })
    end

    function PlayerPrefsMonitor.HandleGet(key)
        if not key or key == "" then _ppm_sendResp("get", { exists = false }); return end
        local exists = false
        pcall(function() exists = CS.UnityEngine.PlayerPrefs.HasKey(key) end)
        if not exists then _ppm_sendResp("get", { key = key, exists = false }); return end
        -- Detect type
        local SENTINEL = "\1\2\3_NOTSTR_\3\2\1"
        local strVal = CS.UnityEngine.PlayerPrefs.GetString(key, SENTINEL)
        if strVal ~= SENTINEL then
            _ppm_sendResp("get", { key = key, value = strVal, type = "string", exists = true })
        else
            local v1 = CS.UnityEngine.PlayerPrefs.GetInt(key, -1)
            local v2 = CS.UnityEngine.PlayerPrefs.GetInt(key, 0)
            if v1 == -1 and v2 == 0 then
                _ppm_sendResp("get", { key = key, value = tostring(CS.UnityEngine.PlayerPrefs.GetFloat(key)), type = "float", exists = true })
            else
                _ppm_sendResp("get", { key = key, value = tostring(CS.UnityEngine.PlayerPrefs.GetInt(key)), type = "int", exists = true })
            end
        end
    end

    function PlayerPrefsMonitor.HandleSet(key, value, valueType)
        if not key or key == "" then _ppm_sendResp("set", nil, "missing key"); return end
        local ok, err = pcall(function()
            if valueType == "int" then
                CS.UnityEngine.PlayerPrefs.SetInt(key, tonumber(value) or 0)
            elseif valueType == "float" then
                CS.UnityEngine.PlayerPrefs.SetFloat(key, tonumber(value) or 0)
            else
                CS.UnityEngine.PlayerPrefs.SetString(key, tostring(value or ""))
            end
            CS.UnityEngine.PlayerPrefs.Save()
        end)
        if ok then _ppm_sendResp("set", { success = true })
        else _ppm_sendResp("set", nil, "set failed: " .. tostring(err)) end
    end

    function PlayerPrefsMonitor.HandleDelete(key)
        if not key or key == "" then _ppm_sendResp("delete", nil, "missing key"); return end
        local ok, err = pcall(function()
            CS.UnityEngine.PlayerPrefs.DeleteKey(key)
            CS.UnityEngine.PlayerPrefs.Save()
        end)
        if ok then _ppm_sendResp("delete", { success = true })
        else _ppm_sendResp("delete", nil, "delete failed: " .. tostring(err)) end
    end

    function PlayerPrefsMonitor.HandleCommand(packet)
        local action = packet and packet.action
        if not action then _ppm_sendResp("unknown", nil, "missing action"); return end
        local ok, err = pcall(function()
            if action == "get_all" then PlayerPrefsMonitor.HandleGetAll()
            elseif action == "get" then PlayerPrefsMonitor.HandleGet(packet.key)
            elseif action == "set" then PlayerPrefsMonitor.HandleSet(packet.key, packet.value, packet.valueType)
            elseif action == "delete" then PlayerPrefsMonitor.HandleDelete(packet.key)
            else _ppm_sendResp(action, nil, "unknown action: " .. tostring(action)) end
        end)
        if not ok then _ppm_sendResp(action, nil, "error: " .. tostring(err)) end
    end

    origin_print("[RuntimeGM] PlayerPrefsMonitor module initialized")

    local SubPkgMonitor = {}

    local function _spm_getAgency()
        local ok, agency = pcall(function() return XMVCA.XSubPackage end)
        if not ok or not agency then return nil end
        return agency
    end

    local function _spm_sendError(action, msg)
        RuntimeGMClient.Send({ type = "SUBPKG_MONITOR_RESP", action = action, error = msg })
    end

    function SubPkgMonitor.HandleGetStructure()
        local agency = _spm_getAgency()
        if not agency then _spm_sendError("get_structure", "XSubPackage agency not available"); return end
        local isOpen = false
        pcall(function() isOpen = agency:IsOpen() end)
        if not isOpen then _spm_sendError("get_structure", "SubPackage system not open"); return end

        local subIndexInfo, resDict, subDict
        pcall(function() subIndexInfo = agency:GetSubIndexInfo() end)
        pcall(function() resDict, subDict = agency:GetAllResAndSubpackageItemDic() end)
        if not subDict then _spm_sendError("get_structure", "_SubpackageDict is nil"); return end

        -- 1) subs
        local subs = {}
        for subId, _ in pairs(subDict) do
            local template = nil
            pcall(function() template = agency:GetSubpackageTemplate(subId) end)
            subs[tostring(subId)] = {
                name   = (template and template.Name) or ("Sub_" .. tostring(subId)),
                resIds = (template and template.ResIds) or {}
            }
        end

        -- 2) resources (骨架：只含 subIds + fileCount，不含文件列表)
        local resources = {}
        if subIndexInfo then
            for resId, fileDict in pairs(subIndexInfo) do
                local subIds = {}
                pcall(function() subIds = agency._Model:GetSubpackageIdByResId(resId) or {} end)
                local fileCount = 0
                if fileDict then for _ in pairs(fileDict) do fileCount = fileCount + 1 end end
                resources[tostring(resId)] = { subIds = subIds, fileCount = fileCount }
            end
        end

        RuntimeGMClient.Send({
            type = "SUBPKG_MONITOR_RESP", action = "get_structure",
            data = { subs = subs, resources = resources }
        })
    end

    function SubPkgMonitor.HandleGetResFiles(resId)
        local agency = _spm_getAgency()
        if not agency then _spm_sendError("get_res_files", "agency not available"); return end
        local subIndexInfo
        pcall(function() subIndexInfo = agency:GetSubIndexInfo() end)
        if not subIndexInfo then _spm_sendError("get_res_files", "SubIndexInfo is nil"); return end

        local fileDict = subIndexInfo[tonumber(resId)]
        local files = {}
        local sharedFiles = {}
        if fileDict then
            -- 先收集本 Res 的文件 + 检查磁盘是否存在
            for assetPath, info in pairs(fileDict) do
                local fileName = info[1]
                local fileExists = false
                pcall(function()
                    local savePath = agency:GetSavePath(fileName)
                    fileExists = CS.System.IO.File.Exists(savePath)
                end)
                files[#files + 1] = { asset = assetPath, name = fileName, sha1 = info[2], size = info[3], exists = fileExists }
            end
            -- 检查共享：遍历其他 Res 看哪些共享同名文件
            for otherResId, otherDict in pairs(subIndexInfo) do
                if otherResId ~= tonumber(resId) and otherDict then
                    for _, info in pairs(otherDict) do
                        local fn = info[1]
                        if fn and not sharedFiles[fn] then
                            -- 检查本 Res 是否也有这个文件
                            for _, myInfo in pairs(fileDict) do
                                if myInfo[1] == fn then
                                    sharedFiles[fn] = sharedFiles[fn] or { tonumber(resId) }
                                    -- 避免重复添加
                                    local exists = false
                                    for _, rid in ipairs(sharedFiles[fn]) do if rid == otherResId then exists = true; break end end
                                    if not exists then table.insert(sharedFiles[fn], otherResId) end
                                    break
                                end
                            end
                        end
                    end
                end
            end
            -- 只保留共享的 (>1 个 Res)
            for fn, rids in pairs(sharedFiles) do
                if #rids <= 1 then sharedFiles[fn] = nil end
            end
        end

        RuntimeGMClient.Send({
            type = "SUBPKG_MONITOR_RESP", action = "get_res_files",
            data = { resId = tostring(resId), files = files, sharedFiles = sharedFiles }
        })
    end

    function SubPkgMonitor.HandleGetStatus()
        local agency = _spm_getAgency()
        if not agency then _spm_sendError("get_status", "XSubPackage agency not available"); return end
        local isOpen = false
        pcall(function() isOpen = agency:IsOpen() end)
        if not isOpen then _spm_sendError("get_status", "SubPackage system not open"); return end

        local resDict, subDict
        pcall(function() resDict, subDict = agency:GetAllResAndSubpackageItemDic() end)
        if not subDict and not resDict then _spm_sendError("get_status", "Item dicts are nil"); return end

        local subsStatus = {}
        if subDict then
            for subId, item in pairs(subDict) do
                local e = {}
                pcall(function() e.state = item:GetState() end)
                pcall(function() e.dlSize = item:GetDownloadSize() end)
                pcall(function() e.totalSize = item:GetTotalSize() end)
                pcall(function() e.progress = item:GetProgress() end)
                subsStatus[tostring(subId)] = e
            end
        end

        local resStatus = {}
        if resDict then
            for resId, item in pairs(resDict) do
                local e = {}
                pcall(function() e.state = item:GetState() end)
                pcall(function() local tg = item:GetTaskGroup(); e.tgState = tg and tg.State or -1 end)
                pcall(function() e.dlSize = item:GetDownloadSize() end)
                pcall(function() e.totalSize = item:GetTotalSize() end)
                pcall(function() e.progress = item:GetProgress() end)
                resStatus[tostring(resId)] = e
            end
        end

        RuntimeGMClient.Send({
            type = "SUBPKG_MONITOR_RESP", action = "get_status",
            data = { subs = subsStatus, resources = resStatus }
        })
    end

    function SubPkgMonitor.Handle(packet)
        local action = packet and packet.action
        if not action then _spm_sendError("unknown", "missing action"); return end
        local ok, err = pcall(function()
            if action == "get_structure" then SubPkgMonitor.HandleGetStructure()
            elseif action == "get_status" then SubPkgMonitor.HandleGetStatus()
            elseif action == "get_res_files" then SubPkgMonitor.HandleGetResFiles(packet.resId)
            else _spm_sendError(action, "unknown action: " .. tostring(action)) end
        end)
        if not ok then _spm_sendError(action, "error: " .. tostring(err)) end
    end

    origin_print("[RuntimeGM] SubPkgMonitor module initialized")

    -- ================================================================
    -- LuaAvMonitor: AV Monitor（音频 + 视频远程监控）
    -- ================================================================
    -- 注意：local LuaAvMonitor = {} 已在 RuntimeGMClient.Update() 之前前向声明，此处直接赋值

    LuaAvMonitor._pushInterval    = 2.0   -- 音频默认推送间隔（秒），snapshot 命令会立即触发
    LuaAvMonitor._videoPushInterval = 0.5  -- 有活跃视频时的推送间隔（秒）
    LuaAvMonitor._lastPushTime    = -9999
    LuaAvMonitor._pendingEvents   = {}    -- 视频事件队列（每帧采集，随 snapshot 一起发送）
    LuaAvMonitor._isActive        = false -- 前端订阅时为 true，超时或 stop 命令后归 false
    LuaAvMonitor._lastActivateTime = -9999
    LuaAvMonitor._activeTimeout   = 30.0  -- 30s 内没有 start/snapshot 心跳则自动停止

    local function _av_sendResp(action, data, err)
        local pkt = { type = "AV_MONITOR_RESP", action = action }
        if err then pkt.error = err else pkt.data = data end
        RuntimeGMClient.Send(pkt)
    end

    local function _av_getTime()
        local t = 0
        pcall(function() t = CS.UnityEngine.Time.realtimeSinceStartup end)
        return t
    end

    local function _av_fmtClock()
        local s = ""
        pcall(function()
            local dt = CS.System.DateTime.Now
            s = string.format("%02d:%02d:%02d", dt.Hour, dt.Minute, dt.Second)
        end)
        return s
    end

    -- 收集音频快照
    local function _av_collectAudio()
        local audio = {}
        pcall(function()
            -- BGM 信息
            local bgm = {}
            pcall(function()
                local info = CS.XAudioManager.CurrentMusicAudioInfo1
                if info then
                    bgm.name     = info.Name or tostring(info.Id)
                    bgm.cueId    = info.Id
                    bgm.acbPath  = info.AcbPath or info.acbPath
                    bgm.awbPath  = info.AwbPath or info.awbPath
                    bgm.playType = info.PlayType and tostring(info.PlayType) or nil
                end
            end)
            audio.bgm = bgm

            -- 分类/二次/Source 音量
            local vols = { category = {}, second = {}, source = {} }
            pcall(function()
                vols.category.music = CS.XAudioManager.MusicVolume
                vols.category.sfx   = CS.XAudioManager.SFXVolume
                vols.category.cv    = CS.XAudioManager.VoiceVolume
            end)
            pcall(function()
                vols.second.music   = CS.XAudioManager.SecondMusicVolume
                vols.second.sfx     = CS.XAudioManager.SecondSFXVolume
                vols.second.voice   = CS.XAudioManager.SecondVoiceVolume
            end)
            pcall(function()
                local ms = CS.XAudioManager.MusicSource
                local ds = CS.XAudioManager.DefaultSource
                if ms then vols.source.music   = ms.volume end
                if ds then vols.source.default = ds.volume end
            end)
            audio.volumes = vols

            -- Master Mute
            audio.masterMute = false
            pcall(function() audio.masterMute = CS.XAudioManager.CheckIsMute() end)

            -- Aisac Mute（按 PlayType）
            local aisacMute = { music = false, sfx = false, voice = false }
            pcall(function()
                local pt = CS.XAudioManager.PlayType
                local names = { music = pt.Music, sfx = pt.SFX, voice = pt.Voice }
                for k, v in pairs(names) do
                    local ok, res = pcall(function() return CS.XAudioManager.CheckIsAisacMute(v) end)
                    if ok then aisacMute[k] = res end
                end
            end)
            audio.aisacMute = aisacMute

            -- 活跃音频列表
            local activeList = {}
            pcall(function()
                local list = CS.XAudioManager.GetAudioInfoList()
                if list then
                    for i = 0, list.Count - 1 do
                        local info = list[i]
                        if info then
                            local status = "Unknown"
                            if info.Playing then status = "Playing"
                            elseif info.Pausing then status = "Paused" end
                            local vol = 1.0
                            pcall(function() vol = info.Source and info.Source.volume or 1.0 end)
                            activeList[#activeList + 1] = {
                                id       = i,
                                cueId    = info.CueId,
                                name     = info.CueName or tostring(info.CueId),
                                playType = info.CueTemplate and tostring(info.CueTemplate.PlayType) or "Unknown",
                                acbPath  = info.AcbFile,
                                awbPath  = info.AwbFile,
                                status   = status,
                                volume   = vol,
                            }
                        end
                    end
                end
            end)
            audio.activeList = activeList

            -- Debug 开关
            local flags = {}
            pcall(function()
                flags.logCollect   = CS.XAudioManager.IsLogCollect or false
                flags.playLog      = CS.XAudioManager.IsAudioPlayLogInConsole or false
                flags.stopLog      = CS.XAudioManager.IsAudioStopLogInConsole or false
                flags.componentLog = CS.XAudioManager.IsComponentLogInConsole or false
                flags.selectorLog  = CS.XAudioManager.IsSelectorLogInConsole or false
                flags.aisacLog     = CS.XAudioManager.IsAisacLogInConsole or false
            end)
            audio.debugFlags = flags

            -- CRI 资源统计
            local criStats = {}
            pcall(function()
                local ok1, cur1, max1, limit1 = CS.CriWare.CriFs.GetNumBinds()
                criStats.bindsCur   = cur1
                criStats.bindsMax   = max1
                criStats.bindsLimit = limit1
            end)
            pcall(function()
                local ok2, cur2, max2, limit2 = CS.CriWare.CriFs.GetNumUsedLoaders()
                criStats.loadersCur   = cur2
                criStats.loadersMax   = max2
                criStats.loadersLimit = limit2
            end)
            audio.criStats = criStats
        end)
        return audio
    end

    -- 收集视频快照
    local function _av_collectVideo()
        local video = { players = {} }
        pcall(function()
            local list = CS.XVideoManager.VideoUguiList
            if not list then return end
            for i = 0, list.Count - 1 do
                local p = list[i]
                if p then
                    local pi = { id = tostring(i) }
                    pcall(function() pi.name       = tostring(p) end)
                    pcall(function()
                        local player = p.VideoPlayerInst and p.VideoPlayerInst.player
                        if player then
                            local raw = tostring(player.status)
                            pi.status = raw:match("^(%a+)") or raw
                        end
                    end)
                    pcall(function()
                        local paused = p:IsPaused()
                        pi.isPaused = (paused == true)
                    end)
                    pcall(function() pi.currentTime = p:GetCurrentTime() end)
                    pcall(function() pi.totalTime  = p:GetCurMovieLength() end)
                    pcall(function() pi.isLoop     = p.IsLooping end)
                    pcall(function() pi.speed      = p.PlaybackSpeed end)
                    pcall(function()
                        local mi = p.VideoPlayerInst.player.movieInfo
                        if mi then
                            pi.movieName           = mi.moviePath
                            pi.width               = mi.width
                            pi.height              = mi.height
                            pi.frameRate           = mi.framerateN / mi.framerateD
                            pi.totalFrames         = mi.totalFrames
                            pi.numSubtitleChannels = mi.numSubtitleChannels
                            pi.numAudioStreams     = mi.numAudioStreams
                        end
                    end)
                    pcall(function() pi.subtitleChannel = p.SubtitleIndex end)
                    pcall(function() pi.subAudioTrack   = p.AudioIndex end)
                    pcall(function()
                        local ctrl = p.VideoPlayingControl
                        if ctrl then
                            local v = ctrl.value__
                            pi.retainMusic = (v % 2)              == 1
                            pi.retainSound = (math.floor(v / 2) % 2) == 1
                            pi.retainCv    = (math.floor(v / 4) % 2) == 1
                        end
                    end)
                    pcall(function() pi.url          = p.Url end)
                    pcall(function() pi.videoConfigId = p.VideoId end)
                    video.players[#video.players + 1] = pi
                end
            end
        end)
        -- 视频日志监听状态
        pcall(function()
            video.logEnabled = CS.XVideoManager.IsLogVideoStatusEventInfo or false
        end)
        -- 附带已积累的事件
        video.events = LuaAvMonitor._pendingEvents
        LuaAvMonitor._pendingEvents = {}
        return video
    end

    function LuaAvMonitor.Update()
        -- 门控：未激活时零开销直接返回
        if not LuaAvMonitor._isActive then return end
        local now = _av_getTime()
        -- 超时自动停止（前端断连后不会永远推）
        if now - LuaAvMonitor._lastActivateTime > LuaAvMonitor._activeTimeout then
            LuaAvMonitor._isActive = false
            return
        end
        -- 有活跃视频时使用更短的推送间隔
        local interval = LuaAvMonitor._pushInterval
        if LuaAvMonitor._hasActiveVideo then
            interval = LuaAvMonitor._videoPushInterval
        end
        if now - LuaAvMonitor._lastPushTime < interval then return end
        LuaAvMonitor._lastPushTime = now
        local video = _av_collectVideo()
        LuaAvMonitor._hasActiveVideo = false
        if video and video.players then
            for _, pi in ipairs(video.players) do
                if pi.status == "Playing" or pi.status == "ReadyForRendering" then
                    LuaAvMonitor._hasActiveVideo = true
                    break
                end
            end
        end
        _av_sendResp("snapshot", {
            audio = _av_collectAudio(),
            video = video,
        })
    end

    function LuaAvMonitor.HandleCommand(packet)
        local action = packet and packet.action
        if not action then return end

        -- 任何命令到来都刷新激活时间戳（相当于心跳）
        LuaAvMonitor._lastActivateTime = _av_getTime()

        if action == "start" then
            LuaAvMonitor._isActive = true
            LuaAvMonitor._lastPushTime = -9999  -- 立即推送一次

        elseif action == "stop" then
            LuaAvMonitor._isActive = false

        elseif action == "snapshot" then
            -- 激活 + 强制立即推送
            LuaAvMonitor._isActive = true
            LuaAvMonitor._lastPushTime = -9999

        elseif action == "set_volume" then
            local cat = packet.category
            local val = tonumber(packet.value) or 0
            if     cat == "music" then pcall(function() CS.XAudioManager.SetMusicVolume(val) end)
            elseif cat == "sfx"   then pcall(function() CS.XAudioManager.SetSFXVolume(val)   end)
            elseif cat == "cv"    then pcall(function() CS.XAudioManager.SetCvVolume(val)     end)
            end

        elseif action == "set_second_volume" then
            local cat = packet.category
            local val = tonumber(packet.value) or 0
            if     cat == "music" then pcall(function() CS.XAudioManager.SecondMusicVolume = val end)
            elseif cat == "sfx"   then pcall(function() CS.XAudioManager.SecondSFXVolume   = val end)
            elseif cat == "voice" then pcall(function() CS.XAudioManager.SecondVoiceVolume = val end)
            end

        elseif action == "set_master_mute" then
            if packet.enabled then
                pcall(function() CS.XAudioManager.ApplyDspBusSnapshot("mute", 0) end)
            else
                pcall(function() CS.XAudioManager.ApplyDspBusSnapshot("default", 0) end)
            end

        elseif action == "set_aisac_mute" then
            pcall(function()
                local pt = CS.XAudioManager.PlayType[packet.playType]
                CS.XAudioManager.MuteAisacByPlayType(pt, packet.enabled)
            end)

        elseif action == "query_cue" then
            local cueId = tonumber(packet.cueId)
            if not cueId then _av_sendResp("query_cue", nil, "invalid cueId"); return end
            local result, ok2, e2
            local ok, err = pcall(function()
                local info = CS.XAudioManager.FindByCueId(cueId)
                if info then
                    result = {
                        id       = info.Id,
                        name     = info.Name,
                        playType = info.PlayType and tostring(info.PlayType) or nil,
                        acbPath  = info.AcbPath or info.acbPath,
                        awbPath  = info.AwbPath or info.awbPath,
                        volume   = info.Volume,
                        status   = info.Status and tostring(info.Status) or nil,
                    }
                end
            end)
            if not ok then _av_sendResp("query_cue", nil, tostring(err))
            elseif not result then _av_sendResp("query_cue", nil, "CueId " .. cueId .. " not found")
            else _av_sendResp("query_cue", result) end
            return

        elseif action == "set_debug_flag" then
            local flag, en = packet.flag, packet.enabled
            if     flag == "logCollect"   then pcall(function() CS.XAudioManager.IsLogCollect                = en end)
            elseif flag == "playLog"      then pcall(function() CS.XAudioManager.IsAudioPlayLogInConsole     = en end)
            elseif flag == "stopLog"      then pcall(function() CS.XAudioManager.IsAudioStopLogInConsole     = en end)
            elseif flag == "componentLog" then pcall(function() CS.XAudioManager.IsComponentLogInConsole     = en end)
            elseif flag == "selectorLog"  then pcall(function() CS.XAudioManager.IsSelectorLogInConsole      = en end)
            elseif flag == "aisacLog"     then pcall(function() CS.XAudioManager.IsAisacLogInConsole         = en end)
            end

        elseif action == "play_bgm" then
            pcall(function()
                if packet.cueId then
                    CS.XLuaAudioManager.PlayAudioByType(tonumber(packet.cueId), CS.XAudioManager.PlayType.Music)
                end
            end)

        elseif action == "stop_bgm" then
            pcall(function() CS.XAudioManager.StopByPlayType(CS.XAudioManager.PlayType.Music) end)

        elseif action == "reload_sound" then
            pcall(function() CS.XAudioManager.ReloadSound() end)

        elseif action == "toggle_video_log" then
            pcall(function()
                local enabled = packet.enabled
                local curStatus = CS.XVideoManager.IsLogVideoStatusEventInfo or false
                local curAction = CS.XVideoManager.IsLogVideoActionEventInfo or false
                if enabled and not curStatus then
                    CS.XVideoManager.SetIsLogVideoStatusEventInfo()
                end
                if enabled and not curAction then
                    CS.XVideoManager.SetIsLogVideoActionEventInfo()
                end
                if not enabled and curStatus then
                    CS.XVideoManager.SetIsLogVideoStatusEventInfo()
                end
                if not enabled and curAction then
                    CS.XVideoManager.SetIsLogVideoActionEventInfo()
                end
            end)

        else
            -- 视频控制命令
            local pid = tonumber(packet.playerId)
            if pid then
                pcall(function()
                    local p = CS.XVideoManager.VideoUguiList[pid]
                    if not p then return end
                    if     action == "video_play"   then p:Play()
                    elseif action == "video_stop"   then p:Stop()
                    elseif action == "video_pause"  then p:Pause()
                    elseif action == "video_resume" then p:Resume()
                    elseif action == "video_seek"   then
                        p:SetSeekPositionByTimeSecond(tonumber(packet.time) or 0)
                    elseif action == "video_speed"  then
                        p:SetSpeed(tonumber(packet.speed) or 1)
                    end
                end)
            end
        end
    end

    origin_print("[RuntimeGM] LuaAvMonitor module initialized")

    function RuntimeGMClient.ProcessPacket(line)
        -- origin_print("[RuntimeGM] Received: " .. tostring(line))
        local json = nil
        local ok1, jsonLib = pcall(require, "XCommon/Json")
        if ok1 and jsonLib and jsonLib.Decode then
            local ok2, res = pcall(jsonLib.Decode, line)
            if ok2 then json = res end
        end
        if not json then json = jsonDecode(line) end
        if not json then return end

        local packet = json
        local type = packet.type
        if type == "EXEC" then
            local cmd = packet.cmd
            local id = packet.id
            -- origin_print("[RuntimeGM] Executing: " .. tostring(cmd))
            local loader = rawget(_G, "loadstring") or load
            local execFunc, loadErr = loader(cmd)
            if not execFunc then RuntimeGMClient.SendLog("error", "Load Error: " .. tostring(loadErr), id) return end
            local success, execErr = pcall(execFunc)
            if not success then RuntimeGMClient.SendLog("error", "Runtime Error: " .. tostring(execErr), id)
            else RuntimeGMClient.SendLog("info", "Success", id) end
        elseif type == "EXEC_GM" then
            RuntimeGMClient.ExecuteGM(tonumber(packet.id), packet.value)
        elseif type == "UI_INSPECTOR" then
            local ok, err = pcall(LuaUiInspector.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] UI_INSPECTOR error: " .. tostring(err))
            end
        elseif type and type:sub(1, 5) == "ANIM_" then
            -- Lua 侧处理 Animator 命令（真机兼容，不依赖 C# Editor 代码）
            local ok, err = pcall(LuaAnimatorMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] ANIM command error: " .. tostring(err))
            end
        elseif type == "TIMELINE" then
            local ok, err = pcall(LuaTimelineMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] TIMELINE command error: " .. tostring(err))
            end
        elseif type == "CS_MONITOR" then
            local ok, err = pcall(LuaCsMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] CS_MONITOR command error: " .. tostring(err))
            end
        elseif type == "SUBPKG_MONITOR" then
            local ok, err = pcall(SubPkgMonitor.Handle, packet)
            if not ok then
                origin_print("[RuntimeGM] SUBPKG_MONITOR command error: " .. tostring(err))
            end
        elseif type == "PLAYER_PREFS" then
            local ok, err = pcall(PlayerPrefsMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] PLAYER_PREFS command error: " .. tostring(err))
            end
        elseif type == "AV_MONITOR" then
            local ok, err = pcall(LuaAvMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] AV_MONITOR command error: " .. tostring(err))
            end
        end
    end

    function RuntimeGMClient.Start(host, port)
        if RuntimeGMClient.IsRunning then return end
        if not loadSocketLibrary() then
            origin_print("[RuntimeGM] Cannot start: socket library not available")
            return
        end
        RuntimeGMClient.Host = host or RuntimeGMClient.Host
        RuntimeGMClient.Port = port or RuntimeGMClient.Port
        RuntimeGMClient.IsRunning = true
        print = HookPrint
        local goName = "RuntimeGMUpdater"
        local go = CS.UnityEngine.GameObject.Find(goName)
        if not go then
            go = CS.UnityEngine.GameObject(goName)
            CS.UnityEngine.Object.DontDestroyOnLoad(go)
        end
        local behaviour = go:GetComponent(typeof(CS.XLuaBehaviour))
        if not behaviour then behaviour = go:AddComponent(typeof(CS.XLuaBehaviour)) end
        behaviour.LuaUpdate = function() RuntimeGMClient.Update() end
        origin_print("[RuntimeGM] Client Started (Embed in XMain).")
    end

    -- 暴露给全局，使用 rawset 绕过 XMain 的 LockG
    rawset(_G, "RuntimeGMClient", RuntimeGMClient)

    return RuntimeGMClient
end

-- 初始化并启动 RuntimeGM
local ok, gmClient = pcall(StartRuntimeGM)
local isOpen = true
if isOpen and ok and gmClient then
    -- 如果同事是在真机/其他电脑运行，这里的 localhost 可能需要改成你的 IP
    gmClient.Start("10.101.0.8", 12581)
else
    print("RuntimeGM Init Failed")
end
```
