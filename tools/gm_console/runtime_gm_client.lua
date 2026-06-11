-- 2. RuntimeGMClient 核心逻辑 (内嵌版)
-- 将 RuntimeGMClient 的内容封装在这里，避免污染全局，但最后会 rawset 到 _G 以供调用
local function StartRuntimeGM()
    local RuntimeGMClient = {}
    RuntimeGMClient.Socket = nil
    RuntimeGMClient.Host = "localhost"
    RuntimeGMClient.Port = 12581  -- 固定握手端口，所有分支统一，勿改
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
            pid = 0,
            packageName = "",
            persistentDataPath = ""
        }

        pcall(function() info.platform = CS.UnityEngine.Application.platform:ToString() end)
        pcall(function() info.packageName = CS.UnityEngine.Application.identifier end)
        pcall(function() info.persistentDataPath = CS.UnityEngine.Application.persistentDataPath end)
        pcall(function() info.device = CS.UnityEngine.SystemInfo.deviceModel end)
        pcall(function() info.pid = CS.System.Diagnostics.Process.GetCurrentProcess().Id end)

        return info
    end

    RuntimeGMClient.DeviceInfo = getDeviceInfo()

    -- 获取当前 SVN 认证用户名（延迟到 Connect() 成功後に実行、初期化を軽量化）
    -- 原理：%APPDATA%/Subversion/auth/svn.simple/ 下の認証キャッシュから最多出現ユーザー名を採用
    RuntimeGMClient.SvnAuthor = ""

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

    -- 获取 SVN 用户名（定义在 Connect 内，遅延実行で初期化を妨げない）
    local function tryGetSvnAuthor()
        local author = ""
        pcall(function()
            local appdata = os.getenv("APPDATA") or ""
            if appdata == "" then return end
            local authDir = appdata .. "/Subversion/auth/svn.simple"
            local ok, exists = pcall(function()
                return CS.System.IO.Directory.Exists(authDir)
            end)
            if not ok or not exists then return end
            local function hasSvnAbove(rawPath)
                local path = rawPath:gsub("\\", "/")
                for _ = 1, 12 do
                    if not path or path == "" then return false end
                    local ok2, ex2 = pcall(function()
                        return CS.System.IO.Directory.Exists(path .. "/.svn")
                    end)
                    if ok2 and ex2 then return true end
                    local parent = path:match("^(.+)/[^/]+$")
                    if not parent or parent == path then return false end
                    path = parent
                end
                return false
            end
            if not hasSvnAbove(CS.UnityEngine.Application.dataPath) then return end
            local files = CS.System.IO.Directory.GetFiles(authDir)
            local counts = {}
            local bestUser, bestCount = "", 0
            for i = 0, files.Length - 1 do
                local txt = CS.System.IO.File.ReadAllText(files[i])
                txt = txt:gsub("\r\n", "\n"):gsub("\r", "\n")
                local _, user = txt:match("username\nV (%d+)\n([^\n]+)")
                if user and #user > 0 then
                    counts[user] = (counts[user] or 0) + 1
                    if counts[user] > bestCount or (counts[user] == bestCount and #user > #bestUser) then
                        bestUser = user
                        bestCount = counts[user]
                    end
                end
            end
            author = bestUser
        end)
        return author
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
            -- HELLO: 发送已知信息（SVN 作者可能已有值——重连场景）
            RuntimeGMClient.Send({
                type = "HELLO",
                pid = RuntimeGMClient.DeviceInfo.pid,
                device = RuntimeGMClient.DeviceInfo.device,
                platform = RuntimeGMClient.DeviceInfo.platform,
                packageName = RuntimeGMClient.DeviceInfo.packageName,
                persistentDataPath = RuntimeGMClient.DeviceInfo.persistentDataPath,
                svn_author = RuntimeGMClient.SvnAuthor or ""
            })
            -- 始终重置 SVN 标记，让 Update() 在首帧尝试获取（可能立即补发 HELLO）
            RuntimeGMClient._svnFetched = false
            RuntimeGMClient._svnRetryAfter = nil
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

    -- 前置声明：供 Hierarchy 和 Inspector 共用的属性值序列化函数（定义在 Inspector 区域）
    local inspectorSerializePropValue

    -- ========== 共享常量 & 工具函数 (Hierarchy + Inspector 复用) ==========
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

    -- 读取组件的属性、字段、方法（Hierarchy.GetDetail 和 Inspector.GetComponentDetail 共用）
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
                local serialized, valueType, extra = inspectorSerializePropValue(val, propTypeName)
                local entry = {
                    name = pName, typeName = propTypeName, valueType = valueType,
                    value = serialized, editable = prop.CanWrite and valueType ~= "readonly" and valueType ~= "collection" and valueType ~= "ref",
                }
                if valueType == "collection" and extra then
                    entry.count = extra.count
                    entry.collectionKind = extra.kind
                elseif valueType == "ref" and extra then
                    entry.instanceId = extra.instanceId
                    entry.refKind = extra.refKind
                    entry.actualType = extra.actualType
                end
                result.properties[#result.properties + 1] = entry
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
                local serialized, valueType, extra = inspectorSerializePropValue(val, fTypeName)
                local entry = {
                    name = fName, typeName = fTypeName, valueType = valueType,
                    value = serialized, editable = (not fld.IsInitOnly) and valueType ~= "readonly" and valueType ~= "collection" and valueType ~= "ref", isField = true,
                }
                if valueType == "collection" and extra then
                    entry.count = extra.count
                    entry.collectionKind = extra.kind
                elseif valueType == "ref" and extra then
                    entry.instanceId = extra.instanceId
                    entry.refKind = extra.refKind
                    entry.actualType = extra.actualType
                end
                result.properties[#result.properties + 1] = entry
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

    -- ========== LuaHierarchyCore: Hierarchy 反射读写内核 (真机兼容) ==========
    local LuaHierarchyCore = {}
    LuaHierarchyCore._compRefs = {}    -- "goId_compIdx" → {go, comp, goName, parentName, typeName}
    LuaHierarchyCore._scanResults = {} -- 最近一次搜索结果

    origin_print("[RuntimeGM] LuaHierarchyCore module initialized")

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
    function LuaHierarchyCore.Scan(typeName)
        local ok, allGOs = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.GameObject))
        end)
        if not ok or not allGOs then return { error = "扫描 GameObject 失败: " .. tostring(allGOs) } end

        local results = {}
        local maxShow = 200
        local total = 0
        LuaHierarchyCore._compRefs = {}

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
                    LuaHierarchyCore._compRefs[key] = { go = go, comp = comps[ci], goName = goName, parentName = parentName, typeName = typeName }
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

    function LuaHierarchyCore.GetDetail(goInstanceId, compIndex)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaHierarchyCore._compRefs[key]
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

    function LuaHierarchyCore.SetProp(goInstanceId, compIndex, propName, value, valueType)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaHierarchyCore._compRefs[key]
        if not ref or not ref.comp then return { error = "组件未找到" } end
        local ok, err = pcall(function() ref.comp[propName] = convertTypedValue(value, valueType) end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
    end

    function LuaHierarchyCore.CallMethod(goInstanceId, compIndex, methodName)
        local key = goInstanceId .. "_" .. compIndex
        local ref = LuaHierarchyCore._compRefs[key]
        if not ref or not ref.comp then return { error = "组件未找到" } end
        local ok, ret = pcall(function()
            local found, result = callCompMethodImpl(ref.comp, methodName)
            if not found then error(result) end
            return result
        end)
        if not ok then return { error = tostring(ret) } end
        return { success = true, result = ret }
    end

    -- ========== LuaHierarchy: Unity Hierarchy + Inspector (真机兼容) ==========
    -- 复刻 Unity Editor 的 Hierarchy + Inspector 体验：
    --   * 按 Scene 列出根 GameObject，点击节点懒加载子节点
    --   * 选中 GO 后一次性返回该 GO 上所有 Component 的反射详情
    --   * Locate：从 LuaUiInspector 的 (uiName, path) 解析到 GO，返回祖先链供前端展开
    -- 与 LuaHierarchyCore 共享底层反射工具（readComponentDetail / convertTypedValue / callCompMethodImpl）
    -- 与 LuaHierarchyCore._compRefs 共享缓存：每次 GetGoDetail 时写入 goId_compIdx → comp，
    -- 让 set_prop / call_method 直接走 LuaHierarchyCore 的现有实现，不重复造轮子。
    local LuaHierarchy = {}
    LuaHierarchy._goCache = setmetatable({}, { __mode = "v" })  -- instanceId(number) → GameObject (弱引用，GO 销毁后自动回收)

    origin_print("[RuntimeGM] LuaHierarchy module initialized")

    local function hierCacheGo(go)
        if not go then return end
        pcall(function() LuaHierarchy._goCache[go:GetInstanceID()] = go end)
    end

    -- instanceId → GameObject 反查：先弱引用缓存，未命中则全场景兜底（性能较差，仅在缓存失效边界触发）
    local function hierFindGo(instanceId)
        if not instanceId then return nil end
        instanceId = tonumber(instanceId) or instanceId
        local go = LuaHierarchy._goCache[instanceId]
        if go then
            local alive = false
            pcall(function() alive = (go.name ~= nil) end)
            if alive then return go end
            LuaHierarchy._goCache[instanceId] = nil
        end
        local ok, allGOs = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.GameObject))
        end)
        if not ok or not allGOs then return nil end
        for i = 0, allGOs.Length - 1 do
            local g = allGOs[i]
            if g and g:GetInstanceID() == instanceId then
                LuaHierarchy._goCache[instanceId] = g
                return g
            end
        end
        return nil
    end

    local function hierNodeOf(go)
        if not go then return nil end
        hierCacheGo(go)
        local n = { instanceId = go:GetInstanceID(), name = go.name }
        pcall(function() n.active = go.activeSelf end)
        pcall(function() n.activeInHierarchy = go.activeInHierarchy end)
        pcall(function() n.childCount = go.transform.childCount end)
        return n
    end

    -- Android/XLua 下无参 scene:GetRootGameObjects() 可能误进 List<T> 重载并抛空引用；
    -- 先走 Editor/PC 可用的无参重载，再兜底显式传 List<GameObject>。
    local function hierCollectionCount(list)
        if not list then return 0 end
        local okLen, len = pcall(function() return list.Length end)
        if okLen and len then return tonumber(len) or 0 end
        local okCount, count = pcall(function() return list.Count end)
        if okCount and count then return tonumber(count) or 0 end
        return 0
    end

    local function hierCollectionAt(list, index)
        local ok, item = pcall(function() return list[index] end)
        if ok then return item end
        return nil
    end

    local function hierGetSceneRootGameObjects(scene)
        local roots = {}
        if not scene then return roots end

        local ok, list = pcall(function() return scene:GetRootGameObjects() end)
        if ok and list then
            local n = hierCollectionCount(list)
            for i = 0, n - 1 do
                local go = hierCollectionAt(list, i)
                if go then roots[#roots + 1] = go end
            end
            return roots
        end

        local okList, list2 = pcall(function()
            local ListGO = CS.System.Collections.Generic.List(CS.UnityEngine.GameObject)
            local l = ListGO()
            scene:GetRootGameObjects(l)
            return l
        end)
        if okList and list2 then
            local n = hierCollectionCount(list2)
            for i = 0, n - 1 do
                local go = hierCollectionAt(list2, i)
                if go then roots[#roots + 1] = go end
            end
            return roots
        end

        -- 最后一层兜底：仅用 active GO 反推根节点，覆盖极端 IL2CPP/XLua 绑定异常。
        local sceneName = ""
        pcall(function() sceneName = tostring(scene.name) end)
        local okAll, allGOs = pcall(function()
            return CS.UnityEngine.Object.FindObjectsOfType(typeof(CS.UnityEngine.GameObject))
        end)
        if okAll and allGOs then
            for i = 0, allGOs.Length - 1 do
                local go = allGOs[i]
                local isRoot = false
                local inScene = sceneName == ""
                pcall(function()
                    isRoot = go.transform.parent == nil
                    inScene = inScene or tostring(go.scene.name) == sceneName
                end)
                if go and isRoot and inScene then roots[#roots + 1] = go end
            end
        end
        return roots
    end

    -- 通过创建临时 GO 标记 DontDestroyOnLoad，借此拿到该 scene 的根列表
    local function hierGetDontDestroyRoots()
        local roots = {}
        local ok, tempScene = pcall(function()
            local tempGo = CS.UnityEngine.GameObject("___EncyHubHierTemp___")
            CS.UnityEngine.Object.DontDestroyOnLoad(tempGo)
            local s = tempGo.scene
            CS.UnityEngine.Object.Destroy(tempGo)
            return s
        end)
        if not ok or not tempScene then return roots end
        local list = hierGetSceneRootGameObjects(tempScene)
        for i = 1, #list do
            local go = list[i]
            if go and go.name ~= "___EncyHubHierTemp___" then
                local n = hierNodeOf(go)
                if n then roots[#roots + 1] = n end
            end
        end
        return roots
    end

    function LuaHierarchy.GetSceneRoots()
        local SM = CS.UnityEngine.SceneManagement.SceneManager
        local count = 0
        pcall(function() count = SM.sceneCount end)
        local scenes = {}
        for i = 0, count - 1 do
            pcall(function()
                local s = SM.GetSceneAt(i)
                if not s.isLoaded then return end
                local roots = {}
                local list = hierGetSceneRootGameObjects(s)
                for j = 1, #list do
                    local node = hierNodeOf(list[j])
                    if node then roots[#roots + 1] = node end
                end
                scenes[#scenes + 1] = { name = s.name, roots = roots }
            end)
        end
        return { scenes = scenes, dontDestroy = hierGetDontDestroyRoots() }
    end

    function LuaHierarchy.GetChildren(instanceId)
        local go = hierFindGo(instanceId)
        if not go then return { error = "GameObject not found: " .. tostring(instanceId) } end
        local children = {}
        local ok, t = pcall(function() return go.transform end)
        if not ok or not t then return { instanceId = instanceId, children = children } end
        local n = 0
        pcall(function() n = t.childCount end)
        for i = 0, n - 1 do
            pcall(function()
                local c = t:GetChild(i).gameObject
                local node = hierNodeOf(c)
                if node then children[#children + 1] = node end
            end)
        end
        return { instanceId = instanceId, children = children }
    end

    function LuaHierarchy.GetGoDetail(instanceId)
        local go = hierFindGo(instanceId)
        if not go then return { error = "GameObject not found: " .. tostring(instanceId) } end
        local detail = {
            instanceId = instanceId,
            name = go.name,
            components = {},
        }
        pcall(function() detail.active = go.activeSelf end)
        pcall(function() detail.activeInHierarchy = go.activeInHierarchy end)
        pcall(function() detail.layer = go.layer end)
        pcall(function() detail.tag = go.tag end)
        pcall(function() detail.hierarchyPath = getHierarchyPath(go) end)
        pcall(function()
            local p = go.transform.parent
            if p then detail.parentInstanceId = p.gameObject:GetInstanceID() end
        end)

        local comps
        pcall(function() comps = go:GetComponents(typeof(CS.UnityEngine.Component)) end)
        if not comps then return detail end
        local goId = detail.instanceId
        for ci = 0, comps.Length - 1 do
            local entry = { compIndex = ci }
            local c = comps[ci]
            if not c then
                entry.error = "missing component"
                entry.typeName = "<missing>"
                entry.properties = {}
                entry.methods = {}
            else
                local typeName = "<unknown>"
                local fullTypeName = ""
                pcall(function() typeName = tostring(c:GetType().Name) end)
                pcall(function() fullTypeName = tostring(c:GetType().FullName) end)
                entry.typeName = typeName
                entry.fullTypeName = fullTypeName
                -- 写入共用缓存，让 set_prop / call_method 走 LuaHierarchyCore 现有实现
                LuaHierarchyCore._compRefs[goId .. "_" .. ci] = {
                    go = go, comp = c, goName = go.name,
                    parentName = "", typeName = typeName,
                }
                local ok, det = pcall(readComponentDetail, c)
                if not ok then
                    entry.error = tostring(det)
                    entry.properties = {}
                    entry.methods = {}
                else
                    entry.properties = det.properties or {}
                    entry.methods = det.methods or {}
                    table.sort(entry.properties, function(a, b) return a.name < b.name end)
                    table.sort(entry.methods, function(a, b) return a.name < b.name end)
                    -- enabled 字段（仅 Behaviour 子类有该属性）
                    pcall(function()
                        local v = c.enabled
                        if type(v) == "boolean" then entry.enabled = v end
                    end)
                end
            end
            detail.components[#detail.components + 1] = entry
        end
        return detail
    end

    -- Locate: 三种模式
    --   1) {instanceId = N}                      → 直接定位
    --   2) {uiName = "...", path = "..."}        → 解析 LuaUi 路径到 GO
    --   3) {goInstanceId = N, compIndex = K}     → scan_by_type 结果点击后定位
    function LuaHierarchy.Locate(packet)
        local go
        if packet.instanceId then
            go = hierFindGo(packet.instanceId)
        elseif packet.goInstanceId then
            go = hierFindGo(packet.goInstanceId)
        elseif packet.uiName and packet.uiName ~= "" then
            local luaUi
            pcall(function() luaUi = XLuaUiManager.GetTopLuaUi(packet.uiName) end)
            if not luaUi then return { error = "UI not found: " .. tostring(packet.uiName) } end
            local target = luaUi
            local path = packet.path or ""
            if path ~= "" then
                for seg in string.gmatch(path, "[^%.]+") do
                    local key = tonumber(seg) or seg
                    if type(target) ~= "table" then return { error = "path resolve failed at " .. tostring(seg) } end
                    target = target[key]
                end
            end
            if not target then return { error = "path target nil" } end
            pcall(function()
                local ok, goObj = pcall(function() return target.gameObject end)
                if ok and goObj then go = goObj
                else
                    local ok2, ah = pcall(function() return target.activeInHierarchy end)
                    if ok2 and type(ah) == "boolean" then go = target end
                end
            end)
        end

        if not go then return { error = "GameObject not found" } end

        hierCacheGo(go)
        local chain = {}
        local t = go.transform
        while t do
            local g = t.gameObject
            hierCacheGo(g)
            chain[#chain + 1] = g:GetInstanceID()
            t = t.parent
        end
        local ordered = {}
        for i = #chain, 1, -1 do ordered[#ordered + 1] = chain[i] end

        return {
            found = true,
            instanceId = go:GetInstanceID(),
            ancestorChain = ordered,
            hierarchyPath = getHierarchyPath(go),
        }
    end

    -- 描述单个集合元素 → { kind:"go"|"comp"|"value", instanceId?, name?, typeName?, display? }
    -- 对 GameObject / Component 提取 instanceId 让前端可点击 Locate；其它做 tostring
    local function hierDescribeItem(el)
        if el == nil then return { kind = "value", display = "nil", typeName = "nil" } end
        local lt = type(el)
        if lt == "boolean" then return { kind = "value", display = tostring(el), typeName = "Boolean" } end
        if lt == "number" then return { kind = "value", display = tostring(el), typeName = "Number" } end
        if lt == "string" then return { kind = "value", display = el, typeName = "String" } end
        if lt ~= "userdata" then return { kind = "value", display = tostring(el), typeName = lt } end

        local typeName = "?"
        pcall(function() typeName = tostring(el:GetType().Name) end)

        -- GameObject
        if typeName == "GameObject" then
            local id = -1; pcall(function() id = el:GetInstanceID() end)
            local name = "?"; pcall(function() name = el.name end)
            hierCacheGo(el)
            return { kind = "go", instanceId = id, name = name, typeName = "GameObject" }
        end

        -- Component（Transform / 任意 MonoBehaviour 子类等）有 .gameObject 反指 GO
        local goObj
        pcall(function() goObj = el.gameObject end)
        if goObj then
            local id = -1; pcall(function() id = goObj:GetInstanceID() end)
            local name = "?"; pcall(function() name = goObj.name end)
            hierCacheGo(goObj)
            return { kind = "comp", instanceId = id, name = name, typeName = typeName }
        end

        -- 其他 userdata（struct 如 Vector3 / 自定义值类型 等）
        local s = "?"; pcall(function() s = tostring(el) end)
        return { kind = "value", display = s, typeName = typeName }
    end

    -- 获取集合元素（懒加载，按需分页）
    -- Args: { goInstanceId, compIndex, propName, offset=0, limit=20 }
    function LuaHierarchy.GetCollectionItems(packet)
        local goId = packet.goInstanceId
        local compIndex = packet.compIndex
        local propName = packet.propName
        local offset = tonumber(packet.offset) or 0
        local limit = tonumber(packet.limit) or 20
        if limit < 1 then limit = 1 end
        if limit > 200 then limit = 200 end

        local key = goId .. "_" .. compIndex
        local ref = LuaHierarchyCore._compRefs[key]
        if not ref or not ref.comp then return { error = "Component 缓存丢失，请重新选中 GameObject" } end

        -- 取属性/字段值（先尝试 xlua property accessor，失败再走反射 Field/Property GetValue）
        local val
        local ok = pcall(function() val = ref.comp[propName] end)
        if not ok or val == nil then
            -- 尝试反射 GetField / GetProperty
            pcall(function()
                local t = ref.comp:GetType()
                local fld = t:GetField(propName)
                if fld then val = fld:GetValue(ref.comp) end
            end)
            if val == nil then
                pcall(function()
                    local t = ref.comp:GetType()
                    local p = t:GetProperty(propName)
                    if p then val = p:GetValue(ref.comp, nil) end
                end)
            end
        end
        if val == nil then return { error = "属性为 nil 或无法访问: " .. tostring(propName) } end

        local items = {}
        local total = 0
        local kind = "list"

        local enumOk, enumErr = pcall(function()
            local t = val:GetType()

            -- Dictionary：通过 IDictionaryEnumerator 取 Entry.Key / Entry.Value
            if t.IsGenericType then
                local short = tostring(t.Name):gsub("`%d+$", "")
                if short == "Dictionary" or short == "SortedDictionary" or short == "ConcurrentDictionary" then
                    kind = "dict"
                    pcall(function() total = val.Count end)
                    local enum
                    pcall(function() enum = val:GetEnumerator() end)
                    if not enum then error("无法获取字典枚举器") end
                    local idx = 0
                    while true do
                        local advanced = false
                        pcall(function() advanced = enum:MoveNext() end)
                        if not advanced then break end
                        if idx >= offset and #items < limit then
                            local k, v
                            pcall(function() k = enum.Current.Key end)
                            pcall(function() v = enum.Current.Value end)
                            items[#items + 1] = { index = idx, kind = "kv", key = hierDescribeItem(k), value = hierDescribeItem(v) }
                        end
                        idx = idx + 1
                        if idx >= offset + limit and #items >= limit then break end
                    end
                    return
                end
            end

            -- Array
            if t.IsArray then
                pcall(function() total = val.Length end)
                local maxI = math.min(offset + limit, total)
                for i = offset, maxI - 1 do
                    pcall(function()
                        local d = hierDescribeItem(val[i])
                        d.index = i
                        items[#items + 1] = d
                    end)
                end
                return
            end

            -- 通用 IList / List<T>：用 .Count + 索引器 [i]
            local hasCount = false
            pcall(function() total = val.Count; hasCount = true end)
            if hasCount then
                local maxI = math.min(offset + limit, total)
                for i = offset, maxI - 1 do
                    pcall(function()
                        local d = hierDescribeItem(val[i])
                        d.index = i
                        items[#items + 1] = d
                    end)
                end
                return
            end

            -- 兜底：IEnumerable，遍历
            local enum
            pcall(function() enum = val:GetEnumerator() end)
            if not enum then error("不支持的集合类型: " .. tostring(t.Name)) end
            local idx = 0
            while true do
                local advanced = false
                pcall(function() advanced = enum:MoveNext() end)
                if not advanced then break end
                if idx >= offset and #items < limit then
                    local cur
                    pcall(function() cur = enum.Current end)
                    local d = hierDescribeItem(cur)
                    d.index = idx
                    items[#items + 1] = d
                end
                idx = idx + 1
                if idx >= offset + limit then break end
            end
            total = math.max(total, idx)
        end)

        if not enumOk then return { error = "枚举失败: " .. tostring(enumErr) } end

        return {
            total = total,
            kind = kind,
            offset = offset,
            limit = limit,
            items = items,
        }
    end

    -- ========== LuaHierarchy.Search: 全场景 GO / Component / 字段高级搜索 ==========
    local HIERARCHY_SEARCH_TEXT_PROBE = {
        Text = "text",
        TMP_Text = "text",
        TextMeshProUGUI = "text",
        InputField = "text",
        TMP_InputField = "text",
        UILabel = "text",
    }
    local HIERARCHY_SEARCH_DEFAULT_MAX_OBJECTS = 5000
    local HIERARCHY_SEARCH_DEFAULT_MAX_MEMBERS = 12000
    local HIERARCHY_SEARCH_HARD_MAX_OBJECTS = 20000
    local HIERARCHY_SEARCH_HARD_MAX_MEMBERS = 60000

    local function hierSearchGlobMatch(pattern, text)
        pattern = tostring(pattern or "")
        text = tostring(text or "")
        if pattern == text then return true end
        local luaPat = "^" .. pattern:gsub("[%(%)%.%+%-%?%[%]%^%$%%]", "%%%1"):gsub("%*", ".*") .. "$"
        return text:match(luaPat) ~= nil
    end

    local function hierSearchParseQuery(q)
        if not q or q == "" then return nil, "查询为空" end
        if q:sub(1, 2) == "t:" then
            local pat = q:sub(3)
            if pat == "" then return nil, "t: 后缺类型名" end
            return { mode = "type", typePattern = pat, isGlob = pat:find("*", 1, true) ~= nil }
        end
        if q:sub(1, 3) == "go:" then
            local pat = q:sub(4)
            if pat == "" then return nil, "go: 后缺 GameObject 名称" end
            return { mode = "go", value = pat, isGlob = pat:find("*", 1, true) ~= nil }
        end
        if q:sub(1, 5) == "path:" then
            local pat = q:sub(6)
            if pat == "" then return nil, "path: 后缺路径" end
            return { mode = "path", value = pat, isGlob = pat:find("*", 1, true) ~= nil }
        end
        if q == "active:false" or q == "active=false" or q == "active:true" or q == "active=true" then
            return { mode = "active", value = (q:match("true") ~= nil) }
        end
        local k, v = q:match("^([%w_]+)=(.+)$")
        if k then
            local strVal = v:match("^\"(.*)\"$")
            if strVal then return { mode = "kv", key = k, valueExpect = strVal, valueType = "string" } end
            local n = tonumber(v)
            if n then return { mode = "kv", key = k, valueExpect = n, valueType = "number" } end
            if v == "true" or v == "false" then return { mode = "kv", key = k, valueExpect = (v == "true"), valueType = "boolean" } end
            return { mode = "kv", key = k, valueExpect = v, valueType = "string" }
        end
        local exact = q:match("^\"(.*)\"$")
        if exact then return { mode = "string_exact", value = exact } end
        if q:find("*", 1, true) and not q:match("[%d%.]") then
            return { mode = "key_glob", pattern = q }
        end
        local numFuzzy = q:match("^%*?([%-]?%d+%.?%d*)%*$") or q:match("^%*([%-]?%d+%.?%d*)%*?$")
        if numFuzzy then return { mode = "number_fuzzy", contains = numFuzzy } end
        local n = tonumber(q)
        if n then return { mode = "value", numberExact = n, stringContains = q } end
        return { mode = "value", stringContains = q }
    end

    local function hierSearchValueInfo(v, declaredTypeName)
        local lt = type(v)
        if lt == "string" then return v, "string", v end
        if lt == "number" then return tostring(v), "number", v end
        if lt == "boolean" then return tostring(v), "bool", v end
        if lt == "userdata" then
            local ok, enumVal = pcall(function()
                if v:GetType().IsEnum then return tostring(v) end
                return nil
            end)
            if ok and enumVal then return enumVal, "enum", enumVal end
        end
        return nil, nil, nil
    end

    local function hierSearchMatchText(parsed, text)
        text = tostring(text or "")
        if parsed.isGlob then return hierSearchGlobMatch(parsed.value, text) end
        return text:find(parsed.value, 1, true) ~= nil
    end

    local function hierSearchMatchMember(parsed, memberName, display, valueType, rawValue)
        local m = parsed.mode
        if m == "kv" then
            if tostring(memberName) ~= parsed.key then return nil end
            if parsed.valueType == "number" then
                local n = type(rawValue) == "number" and rawValue or tonumber(display)
                if n == parsed.valueExpect then return true end
            elseif parsed.valueType == "boolean" then
                if type(rawValue) == "boolean" and rawValue == parsed.valueExpect then return true end
            else
                if tostring(display or "") == tostring(parsed.valueExpect) then return true end
            end
            return nil
        end
        if m == "key_glob" then
            return hierSearchGlobMatch(parsed.pattern, memberName)
        end
        if m == "string_exact" then
            return (valueType == "string" or valueType == "enum") and tostring(display or "") == parsed.value
        end
        if m == "number_fuzzy" then
            return valueType == "number" and tostring(display or ""):find(parsed.contains, 1, true) ~= nil
        end
        if m == "value" then
            if parsed.numberExact and valueType == "number" then
                local n = type(rawValue) == "number" and rawValue or tonumber(display)
                if n == parsed.numberExact then return true end
            end
            if parsed.stringContains and (valueType == "string" or valueType == "enum") then
                return tostring(display or ""):find(parsed.stringContains, 1, true) ~= nil
            end
        end
        return nil
    end

    local function hierSearchDdolRootObjects()
        local roots = {}
        local ok, tempScene = pcall(function()
            local tempGo = CS.UnityEngine.GameObject("___EncyHubHierSearchTemp___")
            CS.UnityEngine.Object.DontDestroyOnLoad(tempGo)
            local s = tempGo.scene
            CS.UnityEngine.Object.Destroy(tempGo)
            return s
        end)
        if not ok or not tempScene then return roots end
        local list = hierGetSceneRootGameObjects(tempScene)
        for i = 1, #list do
            local go = list[i]
            if go and go.name ~= "___EncyHubHierSearchTemp___" then roots[#roots + 1] = go end
        end
        return roots
    end

    -- 普通 Hierarchy 搜索：只按 GameObject 名称 / 路径搜，不解析高级语法，不扫 Component。
    function LuaHierarchy.SearchGameObjects(packet)
        local startTime = 0
        pcall(function() startTime = CS.UnityEngine.Time.realtimeSinceStartup end)

        local query = tostring(packet.query or "")
        if query == "" then return { error = "查询为空" } end

        local scope = packet.scope or "all"
        local includeInactive = packet.includeInactive ~= false
        local maxObjects = math.max(1, math.min(tonumber(packet.maxObjects) or HIERARCHY_SEARCH_HARD_MAX_OBJECTS, HIERARCHY_SEARCH_HARD_MAX_OBJECTS))
        local qLower = string.lower(query)

        local results = {}
        local visited = {}
        local objectCount = 0
        local truncated = false
        local stopObjects = false

        local function containsQuery(text)
            return string.lower(tostring(text or "")):find(qLower, 1, true) ~= nil
        end

        local function buildAncestorChain(go)
            local chain = {}
            local t = nil
            pcall(function() t = go.transform end)
            while t do
                local g = t.gameObject
                hierCacheGo(g)
                chain[#chain + 1] = g:GetInstanceID()
                t = t.parent
            end
            local ordered = {}
            for i = #chain, 1, -1 do ordered[#ordered + 1] = chain[i] end
            return ordered
        end

        local function pushGo(go, sceneName, goName, hPath, activeSelf, activeInHierarchy)
            local goId = -1
            pcall(function() goId = go:GetInstanceID() end)
            results[#results + 1] = {
                sceneName = sceneName or "",
                goName = tostring(goName or ""),
                hierarchyPath = tostring(hPath or ""),
                goInstanceId = goId,
                active = activeSelf,
                activeInHierarchy = activeInHierarchy,
                ancestorChain = buildAncestorChain(go),
            }
        end

        local function scanGo(go, sceneName)
            if stopObjects or not go then return end
            local goId = -1
            pcall(function() goId = go:GetInstanceID() end)
            if visited[goId] then return end
            visited[goId] = true

            objectCount = objectCount + 1
            if objectCount > maxObjects then
                truncated = true
                stopObjects = true
                return
            end

            hierCacheGo(go)
            local activeInHierarchy = true
            local activeSelf = false
            pcall(function() activeInHierarchy = go.activeInHierarchy end)
            pcall(function() activeSelf = go.activeSelf end)
            if not includeInactive and not activeInHierarchy then return end

            local hPath = ""
            local goName = ""
            pcall(function() hPath = getHierarchyPath(go) end)
            pcall(function() goName = go.name end)
            hPath = tostring(hPath or "")
            goName = tostring(goName or "")

            if containsQuery(goName) or containsQuery(hPath) then
                pushGo(go, sceneName, goName, hPath, activeSelf, activeInHierarchy)
            end

            local t
            pcall(function() t = go.transform end)
            if not t then return end
            local childCount = 0
            pcall(function() childCount = t.childCount end)
            for i = 0, childCount - 1 do
                if stopObjects then return end
                pcall(function() scanGo(t:GetChild(i).gameObject, sceneName) end)
            end
        end

        local SM = CS.UnityEngine.SceneManagement.SceneManager
        local sceneCount = 0
        pcall(function() sceneCount = SM.sceneCount end)
        for i = 0, sceneCount - 1 do
            if stopObjects then break end
            pcall(function()
                local s = SM.GetSceneAt(i)
                if not s.isLoaded then return end
                if scope ~= "all" and scope ~= tostring(s.name) then return end
                local roots = hierGetSceneRootGameObjects(s)
                for j = 1, #roots do
                    if stopObjects then return end
                    scanGo(roots[j], tostring(s.name))
                end
            end)
        end
        if (scope == "all" or scope == "DontDestroyOnLoad") and not stopObjects then
            local ddolRoots = hierSearchDdolRootObjects()
            for _, go in ipairs(ddolRoots) do
                if stopObjects then break end
                scanGo(go, "DontDestroyOnLoad")
            end
        end

        local elapsedMs = 0
        pcall(function()
            elapsedMs = math.floor((CS.UnityEngine.Time.realtimeSinceStartup - startTime) * 1000)
        end)
        return {
            query = query,
            results = results,
            truncated = truncated,
            objectCount = objectCount,
            elapsedMs = elapsedMs,
            maxObjects = maxObjects,
        }
    end

    function LuaHierarchy.SetGameObjectActive(packet)
        local go = hierFindGo(packet.instanceId or packet.goInstanceId)
        if not go then return { error = "GameObject not found" } end
        local active = packet.active == true
        local ok, err = pcall(function() go:SetActive(active) end)
        if not ok then return { error = tostring(err) } end
        return {
            success = true,
            instanceId = go:GetInstanceID(),
            active = go.activeSelf,
            activeInHierarchy = go.activeInHierarchy,
        }
    end

    function LuaHierarchy.SetComponentEnabled(packet)
        local go = hierFindGo(packet.instanceId or packet.goInstanceId)
        if not go then return { error = "GameObject not found" } end
        local compIndex = tonumber(packet.compIndex)
        if compIndex == nil then return { error = "Missing compIndex" } end
        local comps
        pcall(function() comps = go:GetComponents(typeof(CS.UnityEngine.Component)) end)
        if not comps or compIndex < 0 or compIndex >= comps.Length then
            return { error = "Component not found: " .. tostring(compIndex) }
        end
        local comp = comps[compIndex]
        if not comp then return { error = "Component missing: " .. tostring(compIndex) } end
        local enabled = packet.enabled == true
        local ok, err = pcall(function() comp.enabled = enabled end)
        if not ok then return { error = tostring(err) } end
        local actual = enabled
        pcall(function() actual = comp.enabled end)
        return { success = true, compIndex = compIndex, enabled = actual }
    end

    function LuaHierarchy.Search(packet)
        local startTime = 0
        pcall(function() startTime = CS.UnityEngine.Time.realtimeSinceStartup end)

        local parsed, perr = hierSearchParseQuery(packet.query)
        if not parsed then return { error = perr or "查询解析失败" } end

        local scope = packet.scope or "all"
        local includeInactive = packet.includeInactive ~= false
        local searchGoName = packet.searchGoName ~= false
        local searchMembers = packet.searchMembers ~= false
        local maxObjects = math.max(1, math.min(tonumber(packet.maxObjects) or HIERARCHY_SEARCH_DEFAULT_MAX_OBJECTS, HIERARCHY_SEARCH_HARD_MAX_OBJECTS))
        local maxMembers = math.max(1, math.min(tonumber(packet.maxMembers) or HIERARCHY_SEARCH_DEFAULT_MAX_MEMBERS, HIERARCHY_SEARCH_HARD_MAX_MEMBERS))
        local maxHits = math.max(0, tonumber(packet.maxHits) or 0)

        local hits = {}
        local visited = {}
        local objectCount = 0
        local componentCount = 0
        local totalScanned = 0
        local truncated = false
        local stopObjects = false
        local memberLimitReached = false
        local hitLimitReached = false

        local function pushHit(go, sceneName, compIndex, typeName, memberName, memberKind, valueDisplay, valueType, via)
            if hitLimitReached then return end
            local goId = -1
            local goName = "?"
            local activeInHierarchy = false
            local activeSelf = false
            local hPath = ""
            pcall(function() goId = go:GetInstanceID() end)
            pcall(function() goName = go.name end)
            pcall(function() activeInHierarchy = go.activeInHierarchy end)
            pcall(function() activeSelf = go.activeSelf end)
            pcall(function() hPath = getHierarchyPath(go) end)
            goName = tostring(goName or "")
            hPath = tostring(hPath or "")
            local entry = {
                sceneName = sceneName or "",
                goName = goName,
                hierarchyPath = hPath,
                goInstanceId = goId,
                active = activeSelf,
                activeInHierarchy = activeInHierarchy,
                typeName = typeName or "",
                memberName = memberName or "",
                memberKind = memberKind or "field",
                valueDisplay = tostring(valueDisplay or ""):sub(1, 120),
                valueType = valueType or "string",
            }
            if compIndex ~= nil and compIndex >= 0 then entry.compIndex = compIndex end
            if via then entry.via = via end
            hits[#hits + 1] = entry
            if maxHits > 0 and #hits >= maxHits then
                truncated = true
                hitLimitReached = true
                stopObjects = true
                memberLimitReached = true
            end
        end

        local function scanMember(go, sceneName, comp, compIndex, typeName, memberName, value, declaredTypeName, memberKind)
            if memberLimitReached then return end
            totalScanned = totalScanned + 1
            if totalScanned > maxMembers then
                truncated = true
                memberLimitReached = true
                return
            end
            local display, valueType, rawValue = hierSearchValueInfo(value, declaredTypeName)
            if not display then return end
            if hierSearchMatchMember(parsed, memberName, display, valueType, rawValue) then
                local via = nil
                if valueType == "string" and HIERARCHY_SEARCH_TEXT_PROBE[typeName] == memberName then
                    valueType = "compText"
                    memberKind = "text"
                    via = typeName .. "." .. memberName
                end
                pushHit(go, sceneName, compIndex, typeName, memberName, memberKind, display, valueType, via)
            end
        end

        local function scanComponent(go, sceneName, comp, compIndex)
            if not comp then return end
            componentCount = componentCount + 1
            if hitLimitReached then return end
            local typeName = "<unknown>"
            local fullTypeName = ""
            pcall(function() typeName = tostring(comp:GetType().Name) end)
            pcall(function() fullTypeName = tostring(comp:GetType().FullName) end)
            local goId = -1; pcall(function() goId = go:GetInstanceID() end)
            LuaHierarchyCore._compRefs[goId .. "_" .. compIndex] = {
                go = go, comp = comp, goName = go.name,
                parentName = "", typeName = typeName,
            }

            if parsed.mode == "type" then
                local matched = parsed.isGlob and hierSearchGlobMatch(parsed.typePattern, typeName) or typeName == parsed.typePattern
                if not matched and fullTypeName ~= "" then
                    matched = parsed.isGlob and hierSearchGlobMatch(parsed.typePattern, fullTypeName) or fullTypeName == parsed.typePattern
                end
                if matched then
                    pushHit(go, sceneName, compIndex, typeName, "Component", "type", typeName, "type")
                end
                return
            end

            local textOk, textVal = pcall(function() return comp.text end)
            if textOk and type(textVal) == "string" then
                local hitText = nil
                if parsed.mode == "value" and parsed.stringContains then
                    hitText = textVal:find(parsed.stringContains, 1, true) ~= nil
                elseif parsed.mode == "string_exact" then
                    hitText = textVal == parsed.value
                end
                if hitText then
                    pushHit(go, sceneName, compIndex, typeName, "text", "text", textVal, "compText", typeName .. ".text")
                end
            end

            if not searchMembers then return end
            if memberLimitReached then return end
            if hitLimitReached then return end

            local props
            pcall(function() props = comp:GetType():GetProperties(20) end)
            if not props then pcall(function() props = comp:GetType():GetProperties() end) end
            local propCount = 0
            if props then pcall(function() propCount = props.Length end) end
            for i = 0, propCount - 1 do
                if memberLimitReached then return end
                local prop = props[i]
                pcall(function()
                    if prop.IsSpecialName then return end
                    local idxParams = prop:GetIndexParameters()
                    if idxParams and idxParams.Length > 0 then return end
                    if not prop.CanRead then return end
                    local pName = tostring(prop.Name)
                    if _PROP_BLACKLIST[pName] then return end
                    local valOk, val = pcall(function() return comp[pName] end)
                    if not valOk then valOk, val = pcall(function() return prop:GetValue(comp) end) end
                    if not valOk then valOk, val = pcall(function() return prop:GetValue(comp, nil) end) end
                    if not valOk then return end
                    scanMember(go, sceneName, comp, compIndex, typeName, pName, val, tostring(prop.PropertyType.Name), "property")
                end)
            end

            local fields
            pcall(function() fields = comp:GetType():GetFields(20) end)
            local fieldCount = 0
            if fields then pcall(function() fieldCount = fields.Length end) end
            for i = 0, fieldCount - 1 do
                if memberLimitReached then return end
                local fld = fields[i]
                pcall(function()
                    if fld.IsSpecialName then return end
                    local fName = tostring(fld.Name)
                    local valOk, val = pcall(function() return comp[fName] end)
                    if not valOk then valOk, val = pcall(function() return fld:GetValue(comp) end) end
                    if not valOk then return end
                    scanMember(go, sceneName, comp, compIndex, typeName, fName, val, tostring(fld.FieldType.Name), "field")
                end)
            end
        end

        local function scanGo(go, sceneName)
            if stopObjects or not go then return end
            local goId = -1
            pcall(function() goId = go:GetInstanceID() end)
            if visited[goId] then return end
            visited[goId] = true
            objectCount = objectCount + 1
            if objectCount > maxObjects then
                truncated = true
                stopObjects = true
                return
            end

            hierCacheGo(go)
            local activeInHierarchy = true
            pcall(function() activeInHierarchy = go.activeInHierarchy end)
            if not includeInactive and not activeInHierarchy then return end

            local hPath = ""
            local goName = ""
            pcall(function() hPath = getHierarchyPath(go) end)
            pcall(function() goName = go.name end)
            hPath = tostring(hPath or "")
            goName = tostring(goName or "")

            if searchGoName then
                if parsed.mode == "go" and hierSearchMatchText(parsed, goName) then
                    pushHit(go, sceneName, nil, "GameObject", "name", "go", goName, "string")
                elseif parsed.mode == "path" and hierSearchMatchText(parsed, hPath) then
                    pushHit(go, sceneName, nil, "GameObject", "path", "go", hPath, "string")
                elseif parsed.mode == "value" and parsed.stringContains and (goName:find(parsed.stringContains, 1, true) or hPath:find(parsed.stringContains, 1, true)) then
                    pushHit(go, sceneName, nil, "GameObject", "name/path", "go", hPath, "string")
                elseif parsed.mode == "string_exact" and (goName == parsed.value or hPath == parsed.value) then
                    pushHit(go, sceneName, nil, "GameObject", "name/path", "go", hPath, "string")
                elseif parsed.mode == "active" then
                    local a = false; pcall(function() a = go.activeInHierarchy end)
                    if a == parsed.value then pushHit(go, sceneName, nil, "GameObject", "activeInHierarchy", "go", tostring(a), "bool") end
                end
            end

            local comps
            pcall(function() comps = go:GetComponents(typeof(CS.UnityEngine.Component)) end)
            if comps then
                for ci = 0, comps.Length - 1 do
                    if stopObjects then return end
                    if hitLimitReached then return end
                    pcall(function() scanComponent(go, sceneName, comps[ci], ci) end)
                end
            end

            local t
            pcall(function() t = go.transform end)
            if not t then return end
            local childCount = 0
            pcall(function() childCount = t.childCount end)
            for i = 0, childCount - 1 do
                if stopObjects then return end
                if hitLimitReached then return end
                pcall(function() scanGo(t:GetChild(i).gameObject, sceneName) end)
            end
        end

        local SM = CS.UnityEngine.SceneManagement.SceneManager
        local sceneCount = 0
        pcall(function() sceneCount = SM.sceneCount end)
        for i = 0, sceneCount - 1 do
            if stopObjects then break end
            pcall(function()
                local s = SM.GetSceneAt(i)
                if not s.isLoaded then return end
                if scope ~= "all" and scope ~= tostring(s.name) then return end
                local roots = hierGetSceneRootGameObjects(s)
                for j = 1, #roots do
                    if stopObjects then return end
                    scanGo(roots[j], tostring(s.name))
                end
            end)
        end
        if (scope == "all" or scope == "DontDestroyOnLoad") and not stopObjects then
            local ddolRoots = hierSearchDdolRootObjects()
            for _, go in ipairs(ddolRoots) do
                if stopObjects then break end
                scanGo(go, "DontDestroyOnLoad")
            end
        end

        local elapsedMs = 0
        pcall(function()
            elapsedMs = math.floor((CS.UnityEngine.Time.realtimeSinceStartup - startTime) * 1000)
        end)
        return {
            hits = hits,
            truncated = truncated,
            totalScanned = totalScanned,
            objectCount = objectCount,
            componentCount = componentCount,
            elapsedMs = elapsedMs,
            maxObjects = maxObjects,
            maxMembers = maxMembers,
        }
    end

    function LuaHierarchy.HandleCommand(packet)
        local action = packet.action
        local result
        if action == "scan" then
            result = LuaHierarchyCore.Scan(packet.typeName)
        elseif action == "get_detail" then
            result = LuaHierarchyCore.GetDetail(packet.goInstanceId, packet.compIndex)
        elseif action == "set_prop" then
            result = LuaHierarchyCore.SetProp(packet.goInstanceId, packet.compIndex, packet.propName, packet.value, packet.valueType)
        elseif action == "call_method" then
            result = LuaHierarchyCore.CallMethod(packet.goInstanceId, packet.compIndex, packet.methodName)
        elseif action == "scene_roots" then
            result = LuaHierarchy.GetSceneRoots()
        elseif action == "children" then
            result = LuaHierarchy.GetChildren(packet.instanceId)
        elseif action == "go_detail" then
            result = LuaHierarchy.GetGoDetail(packet.instanceId)
        elseif action == "locate" then
            result = LuaHierarchy.Locate(packet)
        elseif action == "collection_items" then
            result = LuaHierarchy.GetCollectionItems(packet)
        elseif action == "go_search" then
            result = LuaHierarchy.SearchGameObjects(packet)
        elseif action == "set_go_active" then
            result = LuaHierarchy.SetGameObjectActive(packet)
        elseif action == "set_component_enabled" then
            result = LuaHierarchy.SetComponentEnabled(packet)
        elseif action == "search" then
            result = LuaHierarchy.Search(packet)
        else
            result = { error = "Unknown action: " .. tostring(action) }
        end
        RuntimeGMClient.Send({ type = "HIERARCHY_RESP", action = action, data = result })
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
        -- 单个引用 (GameObject / Component) — 让前端可以 🎯 在 Hierarchy 中定位
        -- 注意必须放在 Vector/Color/Quaternion 之后（那些是 struct，不是引用），放在 collection 之前
        local rOk, rInfo = pcall(function()
            if type(val) ~= "userdata" then return nil end
            local t = val:GetType()
            local tName = tostring(t.Name)
            -- GameObject 自身
            if tName == "GameObject" then
                local id = -1; pcall(function() id = val:GetInstanceID() end)
                local name = "?"; pcall(function() name = val.name end)
                return { display = name, refKind = "go", instanceId = id, actualType = "GameObject" }
            end
            -- Component 子类（Transform / RectTransform / 任意 MonoBehaviour 等）有 .gameObject 反指 GO
            local goObj
            pcall(function() goObj = val.gameObject end)
            if goObj then
                local id = -1; pcall(function() id = goObj:GetInstanceID() end)
                local name = "?"; pcall(function() name = goObj.name end)
                return { display = name, refKind = "comp", instanceId = id, actualType = tName }
            end
            return nil
        end)
        if rOk and rInfo and rInfo.instanceId and rInfo.instanceId ~= -1 then
            return rInfo.display, "ref", rInfo
        end
        -- 集合 (Array / List / Dictionary / 其它带 Count 的泛型容器)
        -- C# 默认 ToString() 只返回 "FullTypeName: hashcode"，对调试无用，这里改为输出 "Type<T>(N)" 元信息
        -- 同时返回 valueType="collection" 让前端知道可以请求展开 (collection_items)
        local cOk, cInfo = pcall(function()
            local t = val:GetType()
            if t.IsArray then
                local len = 0
                pcall(function() len = val.Length end)
                local elName = "?"
                pcall(function() elName = tostring(t:GetElementType().Name) end)
                return { display = string.format("%s[%d]", elName, len), count = len, kind = "list" }
            end
            if t.IsGenericType then
                local count
                pcall(function() count = val.Count end)
                if count ~= nil then
                    local short = tostring(t.Name):gsub("`%d+$", "")
                    local args = t:GetGenericArguments()
                    local parts = {}
                    for i = 0, args.Length - 1 do parts[#parts + 1] = tostring(args[i].Name) end
                    local kind = (short == "Dictionary" or short == "SortedDictionary" or short == "ConcurrentDictionary") and "dict" or "list"
                    return { display = string.format("%s<%s>(%d)", short, table.concat(parts, ","), count), count = count, kind = kind }
                end
            end
            return nil
        end)
        if cOk and cInfo then return cInfo.display, "collection", cInfo end
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

    -- ========== LuaUiInspector.Search: 跨 UI / 跨节点 / C# 文本穿透的高级搜索 ==========
    -- 详见 doc/31_设计方案书_LuaUiInspector_AdvancedSearch.md
    --
    -- 查询语法：
    --   Id=55              kv 精确
    --   Name="Foo"         kv 精确（强 string）
    --   *Count / Lv*       key glob
    --   "hello"            强 string 精确
    --   55 / 55*           number 精确 / 强 number 模糊
    --   hello              string contains + 数字 fallback
    --   t:XUiButton        type 精确
    --   t:*Button          type glob
    --
    -- 白名单（仅作用于值搜的 C# 文本穿透，对 t: 搜不影响）
    local SEARCH_TEXT_PROBE = {
        Text = "text",
        TMP_Text = "text",
        TextMeshProUGUI = "text",
        InputField = "text",
        TMP_InputField = "text",
        UILabel = "text",
    }
    local SEARCH_DEFAULT_MAX_FIELDS = 5000   -- 默认扫描字段上限
    local SEARCH_HARD_MAX_FIELDS = 30000     -- 手动提高预算时的硬上限
    local SEARCH_MAX_DEPTH = 30              -- 深度硬上限

    -- 解析 query → { mode, ... } 内部表示
    local function searchParseQuery(q)
        if not q or q == "" then return nil, "查询为空" end
        -- t: 前缀 → type 搜
        if q:sub(1, 2) == "t:" then
            local pat = q:sub(3)
            if pat == "" then return nil, "t: 后缺类型名" end
            local hasGlob = pat:find("*", 1, true) ~= nil
            return { mode = "type", typePattern = pat, isGlob = hasGlob }
        end
        -- key=value
        local k, v = q:match("^([%w_]+)=(.+)$")
        if k then
            local strVal = v:match("^\"(.*)\"$")
            if strVal then
                return { mode = "kv", key = k, valueExpect = strVal, valueType = "string" }
            end
            local n = tonumber(v)
            if n then
                return { mode = "kv", key = k, valueExpect = n, valueType = "number" }
            end
            if v == "true" or v == "false" then
                return { mode = "kv", key = k, valueExpect = (v == "true"), valueType = "boolean" }
            end
            -- 裸字符串
            return { mode = "kv", key = k, valueExpect = v, valueType = "string" }
        end
        -- 强 string 精确
        local exact = q:match("^\"(.*)\"$")
        if exact then
            return { mode = "string_exact", value = exact }
        end
        -- key glob (*Foo / Foo*)
        if q:find("*", 1, true) and not q:match("[%d%.]") then
            return { mode = "key_glob", pattern = q }
        end
        -- 强 number 模糊：55* / *55*
        local numFuzzy = q:match("^%*?([%-]?%d+%.?%d*)%*$") or q:match("^%*([%-]?%d+%.?%d*)%*?$")
        if numFuzzy then
            return { mode = "number_fuzzy", contains = numFuzzy }
        end
        -- 纯数字 → number 精确 + string contains 双试
        local n = tonumber(q)
        if n then
            return { mode = "value", numberExact = n, stringContains = q }
        end
        -- 默认：string contains
        return { mode = "value", stringContains = q }
    end

    -- glob 匹配（支持 * 通配符）
    local function searchGlobMatch(pattern, text)
        if pattern == text then return true end
        -- 转换 glob 到 Lua pattern
        local luaPat = "^" .. pattern:gsub("[%(%)%.%+%-%?%[%]%^%$%%]", "%%%1"):gsub("%*", ".*") .. "$"
        return text:match(luaPat) ~= nil
    end

    -- 判定单个 (k, v) 是否命中
    -- 返回：nil（不命中） 或 { valueDisplay, valueType, via? }
    local function searchHit(parsed, k, v)
        local m = parsed.mode

        if m == "kv" then
            if tostring(k) ~= parsed.key then return nil end
            if parsed.valueType == "number" then
                if type(v) == "number" and v == parsed.valueExpect then
                    return { valueDisplay = tostring(v), valueType = "number" }
                end
            elseif parsed.valueType == "boolean" then
                if type(v) == "boolean" and v == parsed.valueExpect then
                    return { valueDisplay = tostring(v), valueType = "bool" }
                end
            else  -- string
                if type(v) == "string" and v == parsed.valueExpect then
                    return { valueDisplay = v, valueType = "string" }
                end
            end
            return nil
        end

        if m == "key_glob" then
            if type(k) == "string" and searchGlobMatch(parsed.pattern, k) then
                local disp = (type(v) == "string" or type(v) == "number" or type(v) == "boolean")
                    and tostring(v) or type(v)
                local vt = type(v) == "number" and "number" or (type(v) == "boolean" and "bool" or "string")
                return { valueDisplay = disp, valueType = vt }
            end
            return nil
        end

        if m == "string_exact" then
            if type(v) == "string" and v == parsed.value then
                return { valueDisplay = v, valueType = "string" }
            end
            return nil
        end

        if m == "number_fuzzy" then
            if type(v) == "number" then
                local s = tostring(v)
                if s:find(parsed.contains, 1, true) then
                    return { valueDisplay = s, valueType = "number" }
                end
            end
            return nil
        end

        if m == "value" then
            if type(v) == "string" and parsed.stringContains then
                if v:find(parsed.stringContains, 1, true) then
                    return { valueDisplay = v, valueType = "string" }
                end
            elseif type(v) == "number" and parsed.numberExact then
                if v == parsed.numberExact then
                    return { valueDisplay = tostring(v), valueType = "number" }
                end
            end
            return nil
        end

        if m == "type" then
            -- 仅 userdata 进入此判定
            if type(v) ~= "userdata" then return nil end
            local tn
            local ok = pcall(function() tn = tostring(v:GetType().Name) end)
            if not ok or not tn then return nil end
            if parsed.isGlob then
                if searchGlobMatch(parsed.typePattern, tn) then
                    return { valueDisplay = tn, valueType = "type" }
                end
            else
                if tn == parsed.typePattern then
                    return { valueDisplay = tn, valueType = "type" }
                end
            end
            return nil
        end

        return nil
    end

    -- C# 文本穿透：value 模式 + 白名单类型时，反射读 .text 后再判定
    local function searchProbeText(parsed, k, v)
        if parsed.mode ~= "value" and parsed.mode ~= "string_exact" then return nil end
        if type(v) ~= "userdata" then return nil end
        local tn
        local ok = pcall(function() tn = tostring(v:GetType().Name) end)
        if not ok or not tn then return nil end
        local prop = SEARCH_TEXT_PROBE[tn]
        if not prop then prop = "text" end
        local txt
        local ok2 = pcall(function() txt = v[prop] end)
        if not ok2 or type(txt) ~= "string" then return nil end
        -- 复用 searchHit 但伪装成 string 字段
        local fakeHit = searchHit(parsed, k, txt)
        if fakeHit then
            return {
                valueDisplay = txt:sub(1, 80),
                valueType = "compText",
                via = tn .. "." .. prop,
            }
        end
        return nil
    end

    -- 计算 GameObject 路径（找当前 table 上是否有 GO/Component 字段）
    -- selfTable 是当前递归层级的 table；hit 已确定，找其所属 GO
    -- 优先级：1) selfTable 自身是 userdata Component → 用其 .gameObject
    --        2) selfTable 有 .GameObject / .Transform / .gameObject 字段
    --        3) 找不到 → 不返回
    local function searchExtractGoPath(selfTable, hitValue)
        local function tryGo(go)
            if not go then return nil end
            local id, path
            local ok = pcall(function()
                id = go:GetInstanceID()
                local parts = {}
                local t = go.transform
                while t do
                    parts[#parts + 1] = t.name
                    t = t.parent
                end
                local p = ""
                for i = #parts, 1, -1 do
                    p = p .. (p ~= "" and "/" or "") .. parts[i]
                end
                path = p
            end)
            if ok and id and path then return id, path end
            return nil
        end

        -- 1) hitValue 本身就是 GO/Component（type 搜常见）
        if type(hitValue) == "userdata" then
            local goObj
            pcall(function()
                local tn = tostring(hitValue:GetType().Name)
                if tn == "GameObject" then
                    goObj = hitValue
                else
                    goObj = hitValue.gameObject
                end
            end)
            if goObj then
                local id, p = tryGo(goObj)
                if id then return id, p end
            end
        end

        -- 2) selfTable 平铺找
        if type(selfTable) == "table" then
            local fieldsToTry = { "GameObject", "gameObject", "Transform", "transform" }
            for _, f in ipairs(fieldsToTry) do
                local v = rawget(selfTable, f)
                if type(v) == "userdata" then
                    local goObj
                    pcall(function()
                        local tn = tostring(v:GetType().Name)
                        if tn == "GameObject" then goObj = v
                        else goObj = v.gameObject end
                    end)
                    if goObj then
                        local id, p = tryGo(goObj)
                        if id then return id, p end
                    end
                end
            end
        end

        return nil, nil
    end

    function LuaUiInspector.Search(packet)
        local startTime = 0
        pcall(function() startTime = CS.UnityEngine.Time.realtimeSinceStartup end)

        local parsed, perr = searchParseQuery(packet.query)
        if not parsed then return { error = perr or "查询解析失败" } end

        local depth = math.min(tonumber(packet.depth) or 20, SEARCH_MAX_DEPTH)
        local probeText = packet.probeComponentText ~= false  -- 默认 true
        local scope = packet.scope or "all"
        local maxFields = math.max(1, math.min(tonumber(packet.maxFields) or SEARCH_DEFAULT_MAX_FIELDS, SEARCH_HARD_MAX_FIELDS))
        local maxHits = math.max(0, tonumber(packet.maxHits) or 0)

        -- 决定要遍历的 UI 列表
        local uiNames = {}
        if scope == "all" or scope == nil or scope == "" then
            local ok, list = pcall(function() return XLuaUiManager:GetUiStack() end)
            if ok and list then
                for i = 0, list.Count - 1 do
                    pcall(function()
                        local item = list[i]
                        if item and item.Name then uiNames[#uiNames + 1] = tostring(item.Name) end
                    end)
                end
            end
        else
            uiNames[1] = tostring(scope)
        end

        local hits = {}
        local totalScanned = 0
        local truncated = false

        local function recurse(node, parentTable, path, d)
            if truncated then return end
            if type(node) ~= "table" then return end
            for k, v in pairs(node) do
                if truncated then return end
                totalScanned = totalScanned + 1
                if totalScanned > maxFields then
                    truncated = true
                    return
                end

                -- skip 黑名单
                if not (type(k) == "string" and INSPECTOR_SKIP_KEYS[k]) then
                    -- 命中判定（普通值 + type 搜）
                    local hit = searchHit(parsed, k, v)
                    if not hit and probeText then
                        hit = searchProbeText(parsed, k, v)
                    end
                    if hit then
                        local goId, goPath = searchExtractGoPath(node, v)
                        local entry = {
                            uiName = path.uiName,
                            luaPath = path.lua,
                            key = tostring(k),
                            valueDisplay = hit.valueDisplay,
                            valueType = hit.valueType,
                        }
                        if hit.via then entry.via = hit.via end
                        if goId then entry.goInstanceId = goId; entry.goPath = goPath end
                        hits[#hits + 1] = entry
                        if maxHits > 0 and #hits >= maxHits then
                            truncated = true
                            return
                        end
                    end

                    -- 递归 table
                    if type(v) == "table" and d > 0 then
                        local nextLua = path.lua == "" and tostring(k) or (path.lua .. "." .. tostring(k))
                        recurse(v, node, { uiName = path.uiName, lua = nextLua }, d - 1)
                    end
                end
            end
        end

        for _, uiName in ipairs(uiNames) do
            if truncated then break end
            local luaUi
            pcall(function() luaUi = XLuaUiManager.GetTopLuaUi(uiName) end)
            if luaUi then
                recurse(luaUi, nil, { uiName = uiName, lua = "" }, depth)
            end
        end

        local elapsedMs = 0
        pcall(function()
            elapsedMs = math.floor((CS.UnityEngine.Time.realtimeSinceStartup - startTime) * 1000)
        end)

        return {
            hits = hits,
            truncated = truncated,
            totalScanned = totalScanned,
            elapsedMs = elapsedMs,
            uiCount = #uiNames,
            maxFields = maxFields,
        }
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
        elseif action == "search" then
            result = LuaUiInspector.Search(packet)
        else
            result = { error = "Unknown action: " .. tostring(action) }
        end
        RuntimeGMClient.Send({ type = "UI_INSPECTOR_RESP", action = action, data = result })
    end

    -- 前向声明：让 RuntimeGMClient.Update() 闭包能捕获到这个 upvalue
    local LuaAvMonitor = {}
    local LuaTableMonitor = {}

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
        -- 接続確立後に SVN ユーザー名を遅延取得（connect 時のブロック防止）
        if not RuntimeGMClient._svnFetched then
            RuntimeGMClient._svnFetched = true
            RuntimeGMClient.SvnAuthor = tryGetSvnAuthor()
            if RuntimeGMClient.SvnAuthor ~= "" then
                RuntimeGMClient.Send({
                    type = "HELLO",
                    pid = RuntimeGMClient.DeviceInfo.pid,
                    device = RuntimeGMClient.DeviceInfo.device,
                    platform = RuntimeGMClient.DeviceInfo.platform,
                    packageName = RuntimeGMClient.DeviceInfo.packageName,
                    persistentDataPath = RuntimeGMClient.DeviceInfo.persistentDataPath,
                    svn_author = RuntimeGMClient.SvnAuthor
                })
            else
                -- 首次获取为空，标记 3 秒后重试一次
                RuntimeGMClient._svnRetryAfter = (function()
                    local t = 0; pcall(function() t = CS.UnityEngine.Time.realtimeSinceStartup end); return t + 10
                end)()
            end
        elseif RuntimeGMClient._svnRetryAfter then
            -- 延迟重试：连接稳定后仅再尝试 1 次
            local now = 0
            pcall(function() now = CS.UnityEngine.Time.realtimeSinceStartup end)
            if now >= RuntimeGMClient._svnRetryAfter then
                RuntimeGMClient._svnRetryAfter = nil -- 一次性，不再重试
                local author = tryGetSvnAuthor()
                if author ~= "" then
                    RuntimeGMClient.SvnAuthor = author
                    RuntimeGMClient.Send({
                        type = "HELLO",
                        pid = RuntimeGMClient.DeviceInfo.pid,
                        device = RuntimeGMClient.DeviceInfo.device,
                        platform = RuntimeGMClient.DeviceInfo.platform,
                        packageName = RuntimeGMClient.DeviceInfo.packageName,
                        persistentDataPath = RuntimeGMClient.DeviceInfo.persistentDataPath,
                        svn_author = RuntimeGMClient.SvnAuthor
                    })
                end
            end
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

        -- Table Monitor 超时自动休眠
        local tmOk, tmErr = pcall(LuaTableMonitor.Update)
        if not tmOk then
            origin_print("[RuntimeGM] LuaTableMonitor error: " .. tostring(tmErr))
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
    LuaAvMonitor._videoLogEnabled = false
    LuaAvMonitor._videoLogCallback = nil
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
                            local entry = {
                                id       = i,
                                cueId    = info.CueId,
                                name     = info.CueName or tostring(info.CueId),
                                playType = info.CueTemplate and tostring(info.CueTemplate.PlayType) or "Unknown",
                                acbPath  = info.AcbFile,
                                awbPath  = info.AwbFile,
                                status   = status,
                                volume   = vol,
                            }
                            pcall(function() entry.duration  = info.Duration end)
                            pcall(function() entry.time      = info.Time end)
                            pcall(function() entry.startTime = info.StartTime end)
                            pcall(function() entry.endTime   = info.EndTime end)
                            pcall(function() entry.lastFor   = info.LastFor end)
                            pcall(function()
                                if info.Source and info.Source.gameObject then
                                    entry.sourceName = info.Source.gameObject.name
                                end
                            end)
                            activeList[#activeList + 1] = entry
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
            video.logEnabled = LuaAvMonitor._videoLogEnabled
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

        elseif action == "play_cue" then
            pcall(function()
                local cid = tonumber(packet.cueId)
                if cid then
                    local tpl = CS.XAudioManager.GetCueTemplate(cid)
                    local typeId = tpl.PlayType
                    CS.XLuaAudioManager.PlayAudioByType(typeId, cid)
                end
            end)

        elseif action == "stop_bgm" then
            pcall(function() CS.XAudioManager.StopByPlayType(CS.XAudioManager.PlayType.Music) end)

        elseif action == "reload_sound" then
            pcall(function() CS.XAudioManager.ReloadSound() end)

        elseif action == "toggle_video_log" then
            pcall(function()
                local enabled = packet.enabled
                if enabled and not LuaAvMonitor._videoLogEnabled then
                    local statusEvents = {
                        "EVENT_VIDEO_PLAYER_STATUS_STOP",
                        "EVENT_VIDEO_PLAYER_STATUS_PREPARE",
                        "EVENT_VIDEO_PLAYER_STATUS_READY",
                        "EVENT_VIDEO_PLAYER_STATUS_PLAYING",
                        "EVENT_VIDEO_PLAYER_STATUS_PLAYEND",
                        "EVENT_VIDEO_PLAYER_STATUS_STOPPROCESSING",
                        "EVENT_VIDEO_PLAYER_STATUS_ERROR",
                    }
                    local actionEvents = {
                        "EVENT_VIDEO_ACTION_PREPARE",
                        "EVENT_VIDEO_ACTION_PLAY",
                        "EVENT_VIDEO_ACTION_STOP",
                        "EVENT_VIDEO_ACTION_PAUSE",
                        "EVENT_VIDEO_ACTION_RESUME",
                        "EVENT_VIDEO_ACTION_DISABLE",
                        "EVENT_VIDEO_ACTION_DESTROY",
                    }
                    LuaAvMonitor._videoLogCallback = function(evt, ...)
                        local evType = evt:find("ACTION") and "ACTION" or "STATUS"
                        local shortName = evt:gsub("EVENT_VIDEO_PLAYER_STATUS_", ""):gsub("EVENT_VIDEO_ACTION_", "")
                        local msg = shortName
                        local args = {...}
                        pcall(function()
                            if args[1] and type(args[1]) == "userdata" then
                                local p = args[1]
                                msg = shortName .. " | " .. tostring(p.Url or "")
                            end
                        end)
                        LuaAvMonitor._pendingEvents[#LuaAvMonitor._pendingEvents + 1] = {
                            type = evType,
                            msg  = msg,
                            time = _av_fmtClock(),
                        }
                    end
                    local mgr = CS.XGameEventManager.Instance
                    for _, ev in ipairs(statusEvents) do
                        pcall(function() mgr:RegisterEvent(ev, LuaAvMonitor._videoLogCallback) end)
                    end
                    for _, ev in ipairs(actionEvents) do
                        pcall(function() mgr:RegisterEvent(ev, LuaAvMonitor._videoLogCallback) end)
                    end
                    LuaAvMonitor._videoLogEnabled = true
                elseif not enabled and LuaAvMonitor._videoLogEnabled and LuaAvMonitor._videoLogCallback then
                    local allEvents = {
                        "EVENT_VIDEO_PLAYER_STATUS_STOP", "EVENT_VIDEO_PLAYER_STATUS_PREPARE",
                        "EVENT_VIDEO_PLAYER_STATUS_READY", "EVENT_VIDEO_PLAYER_STATUS_PLAYING",
                        "EVENT_VIDEO_PLAYER_STATUS_PLAYEND", "EVENT_VIDEO_PLAYER_STATUS_STOPPROCESSING",
                        "EVENT_VIDEO_PLAYER_STATUS_ERROR",
                        "EVENT_VIDEO_ACTION_PREPARE", "EVENT_VIDEO_ACTION_PLAY",
                        "EVENT_VIDEO_ACTION_STOP", "EVENT_VIDEO_ACTION_PAUSE",
                        "EVENT_VIDEO_ACTION_RESUME", "EVENT_VIDEO_ACTION_DISABLE",
                        "EVENT_VIDEO_ACTION_DESTROY",
                    }
                    local mgr = CS.XGameEventManager.Instance
                    for _, ev in ipairs(allEvents) do
                        pcall(function() mgr:RemoveEvent(ev, LuaAvMonitor._videoLogCallback) end)
                    end
                    LuaAvMonitor._videoLogCallback = nil
                    LuaAvMonitor._videoLogEnabled = false
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
                    elseif action == "video_replay" then p:RePlay()
                    elseif action == "video_seek"   then
                        p:PlayAtTime(tonumber(packet.time) or 0)
                    elseif action == "video_speed"  then
                        p:SetSpeed(tonumber(packet.speed) or 1)
                    end
                end)
            end
        end
    end

    origin_print("[RuntimeGM] LuaAvMonitor module initialized")

    -- ========== LuaTableMonitor: 配表数据查看器 ==========
    -- (LuaTableMonitor 已在 RuntimeGMClient.Update 前前向声明)
    LuaTableMonitor._isActive = false
    LuaTableMonitor._lastActivateTime = 0
    LuaTableMonitor._activeTimeout = 30
    LuaTableMonitor._pathCache = nil
    LuaTableMonitor._dataCache = nil
    LuaTableMonitor._perfMonitorReady = false
    LuaTableMonitor._perfAgent = nil
    LuaTableMonitor._viewerLoadedTables = {}

    function LuaTableMonitor.Init()
        pcall(function()
            local monitor = CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor
            if monitor and monitor.IsBinaryConfigMonitorEnabled then
                LuaTableMonitor._perfMonitorReady = monitor.IsBinaryConfigMonitorEnabled()
            end
        end)
        pcall(function()
            LuaTableMonitor._perfAgent = CS.HaruPerformance.Runtime.Monitor.Core.PerformanceMonitorAgent
        end)
        origin_print("[RuntimeGM] LuaTableMonitor initialized, perfMonitor=" .. tostring(LuaTableMonitor._perfMonitorReady))
    end

    function LuaTableMonitor.Update()
        if not LuaTableMonitor._isActive then return end
        local ok, now = pcall(function() return CS.UnityEngine.Time.realtimeSinceStartup end)
        if not ok then return end
        if now - LuaTableMonitor._lastActivateTime > LuaTableMonitor._activeTimeout then
            LuaTableMonitor._isActive = false
            LuaTableMonitor._dataCache = nil
            origin_print("[RuntimeGM] LuaTableMonitor auto-deactivated (timeout)")
        end
    end

    local function _tm_activate()
        LuaTableMonitor._isActive = true
        pcall(function() LuaTableMonitor._lastActivateTime = CS.UnityEngine.Time.realtimeSinceStartup end)
    end

    local function _tm_sendResp(action, data, err)
        local pkt = { type = "TABLE_MONITOR_RESP", action = action }
        if data then pkt.data = data end
        if err then pkt.error = err end
        RuntimeGMClient.Send(pkt)
    end

    function LuaTableMonitor._buildPathCache()
        if LuaTableMonitor._pathCache then return end
        LuaTableMonitor._pathCache = {}

        -- 通过 GetFullPath 获取当前表根目录，再用文件系统扫描 .tab 文件建立逻辑路径映射。
        -- 读取时传给 XTableManager 的仍是 Share/Client 下的逻辑路径，具体 Tab/Bytes/Pack 由 Haru router 决定。
        local rootFull
        pcall(function() rootFull = CS.XTableManager.GetFullPath("Share") end)
        if not rootFull then
            origin_print("[RuntimeGM] TableMonitor: GetFullPath failed, path cache empty")
            return
        end

        rootFull = tostring(rootFull):gsub("\\", "/"):gsub("/+$", "")
        local tableRoot = rootFull:match("^(.*)/Share$")
        if not tableRoot then
            origin_print("[RuntimeGM] TableMonitor: cannot resolve table root from: " .. tostring(rootFull))
            return
        end
        tableRoot = tableRoot:gsub("/+$", "")

        local IO = CS.System.IO
        local Directory = IO.Directory
        local SearchOption = IO.SearchOption
        local dirs = { "Share", "Client" }

        local roots = {}
        local function addRoot(root)
            if root and root ~= "" then
                root = tostring(root):gsub("\\", "/"):gsub("/+$", "")
                for _, existing in ipairs(roots) do
                    if existing == root then return end
                end
                roots[#roots + 1] = root
            end
        end
        addRoot(tableRoot)
        addRoot(tableRoot:gsub("/Table$", "/Bytes"))
        addRoot(tableRoot:gsub("/Bytes$", "/Table"))

        local candidates = {}
        local function addCandidate(tableName, relPath, absPath)
            if not candidates[tableName] then candidates[tableName] = {} end
            for _, item in ipairs(candidates[tableName]) do
                if item.path == relPath then return end
            end
            candidates[tableName][#candidates[tableName] + 1] = { path = relPath, absPath = absPath }
        end

        local function addPath(relPath, absPath)
            relPath = relPath:gsub("\\", "/")
            if relPath:sub(-4) ~= ".tab" then return end
            local fileName = relPath:match("([^/]+)%.tab$")
            if not fileName then return end
            local candidateNames = { "XTable" .. fileName, fileName }
            for _, candidate in ipairs(candidateNames) do
                if XTable[candidate] then
                    addCandidate(candidate, relPath, absPath)
                end
            end
        end

        local function scoreCandidate(item, xTableDef)
            if not item or not item.absPath or not xTableDef then return 0 end

            local header
            local ok = pcall(function()
                local sr = IO.File.OpenText(item.absPath)
                header = sr:ReadLine()
                sr:Close()
            end)
            if not ok or not header then return 0 end

            local score = 0
            local matched = {}
            for col in string.gmatch(header, "([^\t]+)") do
                local fieldName = col:match("^([^%[]+)") or col
                if xTableDef[fieldName] and not matched[fieldName] then
                    matched[fieldName] = true
                    score = score + 1
                end
            end
            for fieldName, desc in pairs(xTableDef) do
                if desc.PrimaryKey and matched[fieldName] then
                    score = score + 100
                    break
                end
            end
            return score
        end

        local function chooseCandidate(tableName, list)
            if #list == 1 then return list[1].path end

            local best = list[1]
            local bestScore = -1
            local xTableDef = XTable[tableName]
            for _, item in ipairs(list) do
                local score = scoreCandidate(item, xTableDef)
                if score > bestScore then
                    best = item
                    bestScore = score
                end
            end
            return best.path
        end

        for _, root in ipairs(roots) do
            for _, dir in ipairs(dirs) do
                local dirPath = root .. "/" .. dir
                local exists = false
                pcall(function() exists = Directory.Exists(dirPath) end)
                if exists then
                    local ok, files = pcall(function()
                        return Directory.GetFiles(dirPath, "*.tab", SearchOption.AllDirectories)
                    end)
                    if ok and files then
                        local prefix = dirPath:gsub("\\", "/"):gsub("/+$", "") .. "/"
                        for i = 0, files.Length - 1 do
                            local absPath = files[i]:gsub("\\", "/")
                            if absPath:sub(1, #prefix) == prefix then
                                addPath(dir .. "/" .. absPath:sub(#prefix + 1), absPath)
                            end
                        end
                    end
                end
            end
        end

        if not next(LuaTableMonitor._pathCache) then
            for _, dir in ipairs(dirs) do
                local dirPath = tableRoot .. "/" .. dir
                local ok, files = pcall(function()
                    return Directory.GetFiles(dirPath, "*.tab", SearchOption.AllDirectories)
                end)
                if ok and files then
                    for i = 0, files.Length - 1 do
                        local absPath = files[i]:gsub("\\", "/")
                        local relStart = absPath:find("/" .. dir .. "/", 1, true)
                        if relStart then
                            addPath(absPath:sub(relStart + 1), absPath)
                        end
                    end
                end
            end
        end

        for tableName, list in pairs(candidates) do
            LuaTableMonitor._pathCache[tableName] = chooseCandidate(tableName, list)
        end

        local count = 0
        for _ in pairs(LuaTableMonitor._pathCache) do count = count + 1 end
        origin_print("[RuntimeGM] TableMonitor path cache built: " .. count .. " mapped")
    end

    local function _tm_getPrimaryKeyInfo(xTableDef)
        for fieldName, desc in pairs(xTableDef) do
            if desc.PrimaryKey then
                local isString = desc.ValueType == "string"
                return fieldName, isString
            end
        end
        return nil, false
    end

    function LuaTableMonitor.HandleListTables()
        LuaTableMonitor._buildPathCache()

        local tables = {}
        for name, def in pairs(XTable) do
            local path = LuaTableMonitor._pathCache and LuaTableMonitor._pathCache[name] or nil
            if path then
                local fieldCount = 0
                for _ in pairs(def) do fieldCount = fieldCount + 1 end
                local pkField, pkIsString = _tm_getPrimaryKeyInfo(def)
                tables[#tables + 1] = {
                    name = name,
                    path = path,
                    pathFound = true,
                    fieldCount = fieldCount,
                    hasPK = pkField ~= nil,
                    pkField = pkField,
                    pkIsString = pkIsString or false,
                }
            end
        end
        table.sort(tables, function(a, b) return a.name < b.name end)

        local stats = { available = false, reason = "Stats unavailable" }
        local ok, result = pcall(LuaTableMonitor._collectStats)
        if ok and result then stats = result end

        _tm_sendResp("list_tables", { tables = tables, stats = stats })
    end

    function LuaTableMonitor.HandleGetSchema(tableName)
        if not tableName then _tm_sendResp("get_schema", nil, "missing tableName"); return end
        local xTableDef = XTable[tableName]
        if not xTableDef then _tm_sendResp("get_schema", nil, "table not found: " .. tostring(tableName)); return end

        local fields = {}
        for fieldName, desc in pairs(xTableDef) do
            local f = { name = fieldName, valueType = desc.ValueType or "unknown" }
            if desc.PrimaryKey then f.primaryKey = true end
            if desc.Type then
                f.collectionType = desc.Type
                if desc.KeyType then f.keyType = desc.KeyType end
            end
            fields[#fields + 1] = f
        end
        table.sort(fields, function(a, b)
            if a.primaryKey and not b.primaryKey then return true end
            if not a.primaryKey and b.primaryKey then return false end
            return a.name < b.name
        end)

        _tm_sendResp("get_schema", { tableName = tableName, fields = fields })
    end

    local function _tm_getPerfReader()
        if not LuaTableMonitor._perfMonitorReady then return nil, "BinaryConfigMonitor disabled" end
        local agent = LuaTableMonitor._perfAgent
        if not agent then return nil, "PerformanceMonitorAgent not exposed to Lua" end

        local okReady, ready = pcall(function()
            if agent.IsBinaryConfigMonitorReady then
                return agent.IsBinaryConfigMonitorReady()
            end
            return true
        end)
        if not okReady then return nil, "IsBinaryConfigMonitorReady failed" end
        if not ready then return nil, "BinaryConfigMonitor reader not ready" end

        local okReader, reader = pcall(function()
            return agent.GetBinaryConfigMonitorReader and agent.GetBinaryConfigMonitorReader()
        end)
        if okReader and reader then return reader, nil end
        return nil, "GetBinaryConfigMonitorReader failed"
    end

    local function _tm_getPerfSourceTypes()
        local ok, sourceType = pcall(function()
            return CS.HaruPerformance.Runtime.Monitor.BinaryConfigSourceType
        end)
        if ok and sourceType then
            return sourceType.Lua, sourceType.CSharp
        end

        local monitor = CS.HaruPerformance.Runtime.Agent.HaruPerformanceMonitor
        return monitor.BinaryConfigSourceLuaType, monitor.BinaryConfigSourceCsharpType
    end

    function LuaTableMonitor.HandleGetData(packet)
        local tableName = packet.tableName
        local page = packet.page or 1
        local pageSize = packet.pageSize or 50
        local search = packet.search or ""
        local sortField = packet.sortField or ""
        local sortDir = packet.sortDir or "asc"

        if not tableName then _tm_sendResp("get_data", nil, "missing tableName"); return end

        LuaTableMonitor._buildPathCache()
        local path = LuaTableMonitor._pathCache and LuaTableMonitor._pathCache[tableName]
        local xTableDef = XTable[tableName]
        if not xTableDef then _tm_sendResp("get_data", nil, "table not found: " .. tostring(tableName)); return end
        if not path then _tm_sendResp("get_data", nil, "path not found for: " .. tostring(tableName)); return end

        local pkField, pkIsString = _tm_getPrimaryKeyInfo(xTableDef)
        local loadedByViewer = false
        local loadedStateKnown = false

        if not LuaTableMonitor._dataCache or LuaTableMonitor._dataCache.name ~= tableName then
            -- check if already loaded by game
            local wasLoaded = false
            if LuaTableMonitor._perfMonitorReady then
                pcall(function()
                    local reader = _tm_getPerfReader()
                    local luaType = _tm_getPerfSourceTypes()
                    if reader then
                        local rows, readRows, totalSize = 0, 0, 0
                        pcall(function() rows = reader:GetRows(luaType, path) end)
                        pcall(function() readRows = reader:GetReadRows(luaType, path) end)
                        pcall(function() totalSize = reader:GetTotalSize(luaType, path) end)
                        wasLoaded = (rows or 0) > 0 or (readRows or 0) > 0 or (totalSize or 0) > 0
                        loadedStateKnown = true
                    end
                end)
            end

            local allData
            local readOk, readErr = pcall(function()
                if not pkField then
                    allData = XTableManager.ReadAllByIntKey(path, xTableDef, "Id")
                elseif pkIsString then
                    allData = XTableManager.ReadAllByStringKey(path, xTableDef, pkField)
                else
                    allData = XTableManager.ReadAllByIntKey(path, xTableDef, pkField)
                end
            end)
            if not readOk then
                _tm_sendResp("get_data", nil, "read failed: " .. tostring(readErr))
                return
            end
            if not allData then
                _tm_sendResp("get_data", nil, "table data is nil")
                return
            end

            if loadedStateKnown and not wasLoaded then
                loadedByViewer = true
                LuaTableMonitor._viewerLoadedTables[tableName] = true
            end

            local keys = {}
            for k in pairs(allData) do keys[#keys + 1] = k end
            table.sort(keys, function(a, b)
                if type(a) == type(b) then return a < b end
                return tostring(a) < tostring(b)
            end)
            LuaTableMonitor._dataCache = { name = tableName, data = allData, keys = keys, xTableDef = xTableDef }
        else
            loadedByViewer = LuaTableMonitor._viewerLoadedTables[tableName] or false
        end

        local cache = LuaTableMonitor._dataCache
        local keys = cache.keys
        local def = cache.xTableDef

        if search ~= "" then
            local filtered = {}
            local searchLower = string.lower(search)
            for _, k in ipairs(keys) do
                local row = cache.data[k]
                if row then
                    local match = false
                    if string.find(string.lower(tostring(k)), searchLower, 1, true) then
                        match = true
                    else
                        for fieldName, _ in pairs(def) do
                            local ok2, val = pcall(function() return row[fieldName] end)
                            if ok2 and val ~= nil and string.find(string.lower(tostring(val)), searchLower, 1, true) then
                                match = true; break
                            end
                        end
                    end
                    if match then filtered[#filtered + 1] = k end
                end
            end
            keys = filtered
        end

        if sortField ~= "" then
            local sortKeys = {}
            for i, k in ipairs(keys) do sortKeys[i] = k end
            table.sort(sortKeys, function(a, b)
                local rowA = cache.data[a]
                local rowB = cache.data[b]
                if not rowA or not rowB then return false end
                local ok1, va = pcall(function() return rowA[sortField] end)
                local ok2, vb = pcall(function() return rowB[sortField] end)
                if not ok1 or va == nil then return sortDir ~= "desc" and false or true end
                if not ok2 or vb == nil then return sortDir ~= "desc" and true or false end
                if sortDir == "desc" then return va > vb else return va < vb end
            end)
            keys = sortKeys
        end

        local totalRows = #cache.keys
        local matchedRows = #keys
        local startIdx = (page - 1) * pageSize + 1
        local endIdx = math.min(startIdx + pageSize - 1, matchedRows)
        local rows = {}
        for i = startIdx, endIdx do
            local k = keys[i]
            local row = cache.data[k]
            if row then
                local rowData = {}
                for fieldName, _ in pairs(def) do
                    local ok2, val = pcall(function() return row[fieldName] end)
                    if ok2 then
                        if type(val) == "userdata" then
                            rowData[fieldName] = tostring(val)
                        else
                            rowData[fieldName] = val
                        end
                    end
                end
                rows[#rows + 1] = rowData
            end
        end

        local stats = nil
        local okStats, result = pcall(LuaTableMonitor._collectStats)
        if okStats and result then stats = result end

        _tm_sendResp("get_data", {
            tableName = tableName, totalRows = totalRows, matchedRows = matchedRows,
            page = page, pageSize = pageSize, rows = rows,
            loadedByViewer = loadedByViewer,
            loadedStateKnown = loadedStateKnown,
            stats = stats
        })
    end

    function LuaTableMonitor._collectStats()
        local reader, reason = _tm_getPerfReader()
        if not reader then
            return { available = false, reason = reason or "PerformanceMonitor reader unavailable" }
        end

        local okSourceTypes, luaType, csType = pcall(_tm_getPerfSourceTypes)
        if not okSourceTypes or luaType == nil or csType == nil then
            return { available = false, reason = "BinaryConfigSourceType unavailable" }
        end

        local function collectSource(sourceType)
            local result = {}
            local ok, names = pcall(function()
                return reader:GetAllConfigNames(sourceType)
            end)
            if not ok or not names then return result end
            local iter = names:GetEnumerator()
            while iter:MoveNext() do
                local name = iter.Current
                local entry = {}
                pcall(function() entry.rows = reader:GetRows(sourceType, name) end)
                pcall(function() entry.readRows = reader:GetReadRows(sourceType, name) end)
                pcall(function() entry.totalSize = reader:GetTotalSize(sourceType, name) end)
                pcall(function() entry.module = reader:GetModule(sourceType, name) or "" end)
                pcall(function() entry.tabScope = reader:GetTabScope(sourceType, name) or "" end)
                result[name] = entry
            end
            return result
        end

        local luaStats = collectSource(luaType)
        local csStats = collectSource(csType)

        local totalMem, totalRows, luaCount, csCount = 0, 0, 0, 0
        for _, v in pairs(luaStats) do
            luaCount = luaCount + 1
            totalMem = totalMem + (v.totalSize or 0)
            totalRows = totalRows + (v.rows or 0)
        end
        for _, v in pairs(csStats) do
            csCount = csCount + 1
            totalMem = totalMem + (v.totalSize or 0)
            totalRows = totalRows + (v.rows or 0)
        end

        return {
            available = true,
            lua = luaStats, csharp = csStats,
            summary = { luaCount = luaCount, csharpCount = csCount, totalMemory = totalMem, totalRows = totalRows }
        }
    end

    function LuaTableMonitor.HandleCommand(packet)
        local action = packet.action
        if action == "start" then
            _tm_activate()
            return
        elseif action == "stop" then
            LuaTableMonitor._isActive = false
            LuaTableMonitor._dataCache = nil
            return
        end

        _tm_activate()

        if action == "list_tables" then
            LuaTableMonitor.HandleListTables()
        elseif action == "get_schema" then
            LuaTableMonitor.HandleGetSchema(packet.tableName)
        elseif action == "get_data" then
            LuaTableMonitor.HandleGetData(packet)
        else
            _tm_sendResp(action or "unknown", nil, "unknown action: " .. tostring(action))
        end
    end

    LuaTableMonitor.Init()

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
        elseif type == "HIERARCHY" or type == "CS_MONITOR" then
            local ok, err = pcall(LuaHierarchy.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] HIERARCHY command error: " .. tostring(err))
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
        elseif type == "TABLE_MONITOR" then
            local ok, err = pcall(LuaTableMonitor.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] TABLE_MONITOR command error: " .. tostring(err))
            end
        elseif type == "SCREENSHOT" then
            pcall(function()
                local tex = CS.UnityEngine.ScreenCapture.CaptureScreenshotAsTexture()
                if tex then
                    local bytes = CS.UnityEngine.ImageConversion.EncodeToJPG(tex, 60)
                    CS.UnityEngine.Object.Destroy(tex)
                    if bytes and bytes.Length > 0 then
                        local base64 = CS.System.Convert.ToBase64String(bytes)
                        RuntimeGMClient.Send({
                            type = "SCREENSHOT_RESP",
                            image = base64,
                            width = CS.UnityEngine.Screen.width,
                            height = CS.UnityEngine.Screen.height
                        })
                    end
                end
            end)
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
        behaviour.LuaOnDestroy = function()
            origin_print("[RuntimeGM] OnDestroy: closing connection")
            RuntimeGMClient.Close()
            RuntimeGMClient.IsRunning = false
        end
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
    gmClient.Start(gmClient.Host, gmClient.Port)
else
    print("RuntimeGM Init Failed")
end
