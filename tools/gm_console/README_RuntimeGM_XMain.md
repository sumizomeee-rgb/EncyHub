# RuntimeGMClient - XMain.lua 嵌入代码

## 说明

将以下代码追加到任意客户端分支的 `Product/Lua/Matrix/XMain.lua` 文件末尾即可启用 EncyHub GM Console 的全部功能：

- **GM Console**: 远程执行 Lua 代码、GM 按钮面板
- **Animator Viewer**: 远程查看 Animator 状态机、参数、转场（真机可用）
- **Log 截获**: 远程查看 `print()` 输出

## 使用方法

1. 打开目标分支的 `Product/Lua/Matrix/XMain.lua`
2. 将下方代码块完整粘贴到文件末尾
3. **修改 IP 和端口**为你的开发机地址（运行 EncyHub 的电脑）
4. 热更或重新打包

## 注意事项

- IP 地址 `10.101.0.8` 需改为你自己运行 EncyHub 的电脑 IP
- 端口 `12582` 对应 EncyHub GM Console 的 TCP 端口（默认 `main.py --port 9524` 启动后 TCP 端口为 `port + 3058 = 12582`）
- 代码使用 `rawget`/`rawset` 绕过 `LuaLockG()`，兼容任意分支
- 代码使用 `pcall` 保护所有外部调用，不会影响游戏正常运行
- 如果 `socket.core` 不可用（部分裁剪包），RuntimeGM 会静默跳过

## 代码

```lua
--===============
--==自定义代码 start （RuntimeGMClient + LuaAnimatorMonitor）
-- RuntimeGMClient 核心逻辑 (内嵌版)
local function StartRuntimeGM()
    local RuntimeGMClient = {}
    RuntimeGMClient.Socket = nil
    RuntimeGMClient.Host = "localhost"
    RuntimeGMClient.Port = 12582
    RuntimeGMClient.IsRunning = false
    RuntimeGMClient.ReconnectTimer = 0
    RuntimeGMClient.SocketLibrary = nil

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
        local info = { platform = "Unknown", device = "Unknown", pid = 0 }
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
        origin_print(...)
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
            RuntimeGMClient.Socket:settimeout(0.05)
            RuntimeGMClient.Socket:send(packet .. "\n")
        end)
        if not ok then
            local errStr = tostring(err)
            if errStr:find("closed") or errStr:find("refused") or errStr:find("reset") then
                origin_print("[RuntimeGM] Send Fatal: " .. errStr)
                RuntimeGMClient.Close()
            end
        end
    end

    function RuntimeGMClient.SendLog(level, msg, refId)
        RuntimeGMClient.Send({ type = "LOG", level = level, msg = msg, ref_id = refId })
    end

    function RuntimeGMClient.Connect()
        if RuntimeGMClient.Socket then return end
        if not RuntimeGMClient.SocketLibrary then return end
        local socket = RuntimeGMClient.SocketLibrary
        origin_print("[RuntimeGM] 正在连接到: " .. RuntimeGMClient.Host .. ":" .. RuntimeGMClient.Port)
        local success, tcp_or_err = pcall(function() return socket.tcp() end)
        if not success or not tcp_or_err then
            origin_print("[RuntimeGM] 创建 TCP 失败: " .. tostring(tcp_or_err))
            return
        end
        local tcp = tcp_or_err
        tcp:settimeout(0.5)
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
            origin_print("[RuntimeGM] 连接失败: " .. tostring(err))
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
            name = name, parent = parent, children = {}, isLeaf = false,
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
            self:AddChild("Toggle", name, cb, false)
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
            local status, err = pcall(cb, value)
            if not status then RuntimeGMClient.SendLog("error", "GM Exec Error: " .. tostring(err))
            else RuntimeGMClient.SendLog("info", "GM Executed") end
        end
    end

    -- ========== LuaAnimatorMonitor: Animator 数据采集 (纯 Lua, 真机兼容) ==========
    local LuaAnimatorMonitor = {}
    LuaAnimatorMonitor._trackers = {}
    LuaAnimatorMonitor._subscribedId = nil
    LuaAnimatorMonitor._lastScanTime = 0
    LuaAnimatorMonitor._lastPushTime = 0
    LuaAnimatorMonitor._scanInterval = 2.0
    LuaAnimatorMonitor._pushInterval = 0.1

    origin_print("[RuntimeGM] LuaAnimatorMonitor module initialized")

    local function _resolveStateName(tracker, hash)
        return tracker.stateNameCache[hash] or ("Unknown_" .. hash)
    end

    function LuaAnimatorMonitor.ScanAnimators()
        local scanOk, allAnimators = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.Animator))
        end)
        if not scanOk or not allAnimators then
            origin_print("[RuntimeGM] ScanAnimators failed: " .. tostring(allAnimators))
            return
        end
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

    function LuaAnimatorMonitor.CreateTracker(animator)
        local tracker = {
            animator = animator,
            instanceId = animator:GetInstanceID(),
            stateNameCache = {},
            lastStateHashes = {},
        }
        for i = 0, animator.layerCount - 1 do
            local stateInfo = animator:GetCurrentAnimatorStateInfo(i)
            tracker.lastStateHashes[i] = stateInfo.shortNameHash
        end
        LuaAnimatorMonitor.DiscoverStates(tracker)
        return tracker
    end

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
            local stateInfo = animator:GetCurrentAnimatorStateInfo(layer)
            if stateInfo.shortNameHash ~= 0 then
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

    local function _takeLayerSnapshot(tracker, animator, layerIndex)
        local stateInfo = animator:GetCurrentAnimatorStateInfo(layerIndex)
        local transInfo = animator:GetAnimatorTransitionInfo(layerIndex)
        local clipInfos = animator:GetCurrentAnimatorClipInfo(layerIndex)
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
        if animator:IsInTransition(layerIndex) then
            local nextInfo = animator:GetNextAnimatorStateInfo(layerIndex)
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
        for i = 0, clipInfos.Length - 1 do
            layer.currentClips[#layer.currentClips + 1] = {
                clipName = clipInfos[i].clip.name,
                clipLength = clipInfos[i].clip.length,
                clipWeight = clipInfos[i].weight
            }
        end
        return layer
    end

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
        for i = 0, animator.layerCount - 1 do
            snapshot.layers[#snapshot.layers + 1] = _takeLayerSnapshot(tracker, animator, i)
        end
        local paramOk, params = pcall(function() return animator.parameters end)
        if paramOk and params then
            for i = 0, params.Length - 1 do
                local param = params[i]
                local pTypeOk, pTypeStr = pcall(function() return param.type:ToString() end)
                if not pTypeOk then
                    local pTypeInt = tonumber(tostring(param.type)) or -1
                    local typeMap = {[1] = "Float", [3] = "Int", [4] = "Bool", [9] = "Trigger"}
                    pTypeStr = typeMap[pTypeInt] or "Unknown"
                end
                local paramSnap = {
                    name = param.name, type = pTypeStr,
                    floatValue = 0, intValue = 0, boolValue = false
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

    function LuaAnimatorMonitor.DetectStateChanges(tracker)
        local animator = tracker.animator
        local changes = {}
        for i = 0, animator.layerCount - 1 do
            local stateInfo = animator:GetCurrentAnimatorStateInfo(i)
            local currentHash = stateInfo.shortNameHash
            local lastHash = tracker.lastStateHashes[i] or 0
            if lastHash ~= 0 and lastHash ~= currentHash then
                changes[#changes + 1] = {
                    layerName = animator:GetLayerName(i),
                    fromState = _resolveStateName(tracker, lastHash),
                    toState = _resolveStateName(tracker, currentHash),
                    timestamp = CS.UnityEngine.Time.time
                }
            end
            if animator:IsInTransition(i) then
                local nextInfo = animator:GetNextAnimatorStateInfo(i)
                if nextInfo.shortNameHash ~= 0 and nextInfo.shortNameHash ~= currentHash then
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

    function LuaAnimatorMonitor.Update()
        if not LuaAnimatorMonitor._subscribedId then return end
        local now = CS.UnityEngine.Time.realtimeSinceStartup
        if now - LuaAnimatorMonitor._lastScanTime >= LuaAnimatorMonitor._scanInterval then
            LuaAnimatorMonitor._lastScanTime = now
            LuaAnimatorMonitor.ScanAnimators()
        end
        if now - LuaAnimatorMonitor._lastPushTime < LuaAnimatorMonitor._pushInterval then
            return
        end
        LuaAnimatorMonitor._lastPushTime = now
        local tracker = LuaAnimatorMonitor._trackers[LuaAnimatorMonitor._subscribedId]
        if not tracker then return end
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
            RuntimeGMClient.Send({ type = "ANIM_REMOVED", animatorId = LuaAnimatorMonitor._subscribedId })
            LuaAnimatorMonitor._trackers[LuaAnimatorMonitor._subscribedId] = nil
            LuaAnimatorMonitor._subscribedId = nil
        end
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
        local animOk, animErr = pcall(LuaAnimatorMonitor.Update)
        if not animOk then
            origin_print("[RuntimeGM] LuaAnimatorMonitor error: " .. tostring(animErr))
        end
    end

    function RuntimeGMClient.ProcessPacket(line)
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
            local loader = rawget(_G, "loadstring") or load
            local execFunc, loadErr = loader(cmd)
            if not execFunc then RuntimeGMClient.SendLog("error", "Load Error: " .. tostring(loadErr), id) return end
            local success, execErr = pcall(execFunc)
            if not success then RuntimeGMClient.SendLog("error", "Runtime Error: " .. tostring(execErr), id)
            else RuntimeGMClient.SendLog("info", "Success", id) end
        elseif type == "EXEC_GM" then
            RuntimeGMClient.ExecuteGM(tonumber(packet.id), packet.value)
        elseif type and type:sub(1, 5) == "ANIM_" then
            local ok, err = pcall(LuaAnimatorMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] ANIM command error: " .. tostring(err))
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

    rawset(_G, "RuntimeGMClient", RuntimeGMClient)
    return RuntimeGMClient
end

-- 初始化并启动 RuntimeGM（★★★ 修改下面的 IP 为你的开发机 IP ★★★）
local ok, gmClient = pcall(StartRuntimeGM)
if ok and gmClient then
    gmClient.Start("10.101.0.8", 12582)
else
    print("RuntimeGM Init Failed: " .. tostring(gmClient))
end
--==自定义代码 end
```
