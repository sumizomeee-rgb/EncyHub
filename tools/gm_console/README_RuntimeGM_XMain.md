# RuntimeGMClient - XMain.lua 嵌入代码

## 说明

将以下代码追加到任意客户端分支的 `Product/Lua/Matrix/XMain.lua` 文件末尾即可启用 EncyHub GM Console 的全部功能：

- **GM Console**: 远程执行 Lua 代码、GM 按钮面板
- **Animator Viewer**: 远程查看 Animator 状态机、参数、转场（真机可用）
- **Lua UI Inspector**: 远程查看/编辑 Lua UI（XLuaUi）实例的 self 表数据（真机可用）
  - `INSPECTOR_MAX_FIELDS = 200` — 限制根级字段数量，防止大型 UI 返回过大响应
  - `CallMethod` — 可从 Web Inspector 调用 Lua 方法（实例方法 + 元表 class 方法）
  - `GetNodeData` 返回 `truncated`/`totalKeys`/`shownKeys` 字段截断信息
- **Log 截获**: 远程查看 `print()` 输出
- **TCP 心跳保活**: 每 15 秒发送 PING，防止 NAT/防火墙超时断开连接

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
        origin_print("[RuntimeGM] ANIM command received: " .. tostring(cmdType))

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
            origin_print("[RuntimeGM] ANIM_LIST_RESP: found " .. #animators .. " animators")
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
        elseif t == "function" then return { type = "function", value = "function", editable = false }
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
            end)
            return result
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
        else
            result = { error = "Unknown action: " .. tostring(action) }
        end
        RuntimeGMClient.Send({ type = "UI_INSPECTOR_RESP", action = action, data = result })
    end

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
    end

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
if ok and gmClient then
    -- 如果同事是在真机/其他电脑运行，这里的 localhost 可能需要改成你的 IP
    gmClient.Start("10.101.0.8", 12581)
else
    print("RuntimeGM Init Failed")
end
```
