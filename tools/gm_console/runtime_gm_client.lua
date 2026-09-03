-- 2. RuntimeGMClient 核心逻辑 (内嵌版)
-- 将 RuntimeGMClient 的内容封装在这里，避免污染全局，但最后会 rawset 到 _G 以供调用
local existingRuntimeGM = rawget(_G, "RuntimeGMClient")
if existingRuntimeGM and existingRuntimeGM.IsRunning then
    print("[RuntimeGM] Existing client is already running, skip duplicate initialization")
    return existingRuntimeGM
end

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

    -- SVN 信息会在连接成功后延迟查询，避免拖慢 RuntimeGM 初始化。
    -- 优先复用项目 XExternalTool + bundled svn.exe 获取当前工作副本，再按仓库 realm 精确匹配认证账号。
    RuntimeGMClient.SvnAuthor = ""
    RuntimeGMClient.SvnUrl = ""
    RuntimeGMClient.SvnBranch = ""
    RuntimeGMClient.SvnRevision = ""
    RuntimeGMClient.SvnDetection = ""

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
                -- Lua 允许 NaN/Infinity，但它们不是合法 JSON 数字。任何一个非法值都会让服务端丢弃整包。
                if val ~= val or val == math.huge or val == -math.huge then
                    return "null"
                end
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

    function RuntimeGMClient.Send(data, timeout)
        if not RuntimeGMClient.Socket then return end
        local success, packet = pcall(jsonEncode, data)
        if not success then
            origin_print("[RuntimeGM] JSON Encode Error: " .. tostring(packet))
            return
        end
        local payload = packet .. "\n"
        local len = #payload
        -- 小包直接发，大包用更长超时 + 更多重试
        local sendTimeout = timeout or ( len > 65536 and 5.0 or 0.1 )
        local maxRetries = len > 65536 and 15 or 3
        local ok, err = pcall(function()
            local lastByte = 0
            local retries = 0
            while lastByte < len do
                RuntimeGMClient.Socket:settimeout(sendTimeout)
                local sent, sendErr, partialByte = RuntimeGMClient.Socket:send(payload, lastByte + 1)
                if sent then
                    lastByte = sent
                    retries = 0
                else
                    if sendErr == "closed" then error("closed") end
                    -- timeout: partialByte 是绝对索引
                    if partialByte and partialByte > lastByte then
                        lastByte = partialByte
                        retries = 0
                    else
                        retries = retries + 1
                        if retries > maxRetries then
                            error("timeout after " .. maxRetries .. " retries at byte " .. lastByte .. "/" .. len)
                        end
                    end
                end
            end
            RuntimeGMClient.Socket:settimeout(0)
        end)
        if not ok then
            pcall(function() RuntimeGMClient.Socket:settimeout(0) end)
            local errStr = tostring(err)
            if errStr:find("closed") or errStr:find("refused") or errStr:find("reset") then
                origin_print("[RuntimeGM] Send Fatal: " .. errStr)
                RuntimeGMClient.Close()
            else
                origin_print("[RuntimeGM] Send warning (packet discarded): " .. errStr)
            end
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

    local function trimString(value)
        return tostring(value or ""):match("^%s*(.-)%s*$") or ""
    end

    local function normalizeSvnOrigin(value)
        local text = trimString(value):lower()
        local origin = text:match("^([%a][%w%+%.%-]*://[^/]+)")
        if not origin then return "" end
        if origin:match("^https://") then
            origin = origin:gsub(":443$", "")
        elseif origin:match("^http://") then
            origin = origin:gsub(":80$", "")
        end
        return origin
    end

    local function pickMostLikelyUser(counts)
        local bestUser, bestCount = "", 0
        for user, count in pairs(counts or {}) do
            if count > bestCount or (count == bestCount and #user > #bestUser) then
                bestUser = user
                bestCount = count
            end
        end
        return bestUser
    end

    -- 查询当前工作副本信息，并将认证缓存限定到当前仓库 realm。
    -- XExternalTool 不可用（非 Windows/非调试包）时，无声回退旧的认证缓存统计方式。
    local function decodeXmlText(value)
        return trimString(value)
            :gsub("&lt;", "<")
            :gsub("&gt;", ">")
            :gsub("&quot;", '"')
            :gsub("&apos;", "'")
            :gsub("&amp;", "&")
    end

    local function tryGetSvnInfo(svnInfoXml)
        local info = { author = "", url = "", branch = "", revision = "", detection = "" }
        pcall(function()
            local dataPath = trimString(CS.UnityEngine.Application.dataPath)
            if dataPath == "" then return end

            local function hasSvnAbove(rawPath)
                local path = rawPath:gsub("\\", "/")
                for _ = 1, 12 do
                    if path == "" then return false end
                    local ok2, exists = pcall(function()
                        return CS.System.IO.Directory.Exists(path .. "/.svn")
                    end)
                    if ok2 and exists then return true end
                    local parent = path:match("^(.+)/[^/]+$")
                    if not parent or parent == path then return false end
                    path = parent
                end
                return false
            end
            if not hasSvnAbove(dataPath) then return end

            svnInfoXml = trimString(svnInfoXml)
            if svnInfoXml ~= "" then
                info.url = decodeXmlText(svnInfoXml:match("<url>(.-)</url>"))
                info.revision = trimString(svnInfoXml:match('<entry.-revision="(%d+)"'))
            end

            if info.url ~= "" then
                local okTool, svnTool = pcall(function() return CS.XExternalTool end)
                if okTool and svnTool then
                    local okBranch, branch = pcall(function()
                        return svnTool.GetCurrentSvnBranch(info.url)
                    end)
                    if okBranch then info.branch = trimString(branch) end
                end
                if info.branch == "" then
                    local normalizedUrl = info.url:gsub("\\", "/"):gsub("/+$", "")
                    info.branch = normalizedUrl:match("/branches/([^/]+)") or ""
                    if info.branch == "" and
                        (normalizedUrl:find("/trunk/", 1, true) or normalizedUrl:sub(-6) == "/trunk") then
                        info.branch = "trunk"
                    end
                end
            end

            local appdata = os.getenv("APPDATA") or ""
            if appdata == "" then return end
            local authDir = appdata .. "/Subversion/auth/svn.simple"
            local okAuthDir, authDirExists = pcall(function()
                return CS.System.IO.Directory.Exists(authDir)
            end)
            if not okAuthDir or not authDirExists then return end

            local urlOrigin = normalizeSvnOrigin(info.url)
            local allCounts, realmCounts = {}, {}
            local files = CS.System.IO.Directory.GetFiles(authDir)
            for i = 0, files.Length - 1 do
                local txt = CS.System.IO.File.ReadAllText(files[i])
                txt = txt:gsub("\r\n", "\n"):gsub("\r", "\n")
                local _, user = txt:match("username\nV (%d+)\n([^\n]+)")
                local _, realm = txt:match("svn:realmstring\nV (%d+)\n([^\n]+)")
                user = trimString(user)
                realm = trimString(realm)
                if user ~= "" then
                    allCounts[user] = (allCounts[user] or 0) + 1
                    local realmUrl = realm:match("<([^>]+)>") or realm
                    local realmOrigin = normalizeSvnOrigin(realmUrl)
                    if urlOrigin ~= "" and realmOrigin == urlOrigin then
                        realmCounts[user] = (realmCounts[user] or 0) + 1
                    end
                end
            end

            info.author = pickMostLikelyUser(realmCounts)
            if info.author ~= "" then
                info.detection = "cli_realm"
            else
                info.author = pickMostLikelyUser(allCounts)
                if info.author ~= "" then
                    info.detection = info.url ~= "" and "cli_auth_fallback" or "auth_fallback"
                elseif info.url ~= "" then
                    info.detection = "cli"
                end
            end
        end)
        return info
    end

    local function applySvnInfo(info)
        info = info or {}
        if trimString(info.author) ~= "" then RuntimeGMClient.SvnAuthor = trimString(info.author) end
        if trimString(info.url) ~= "" then RuntimeGMClient.SvnUrl = trimString(info.url) end
        if trimString(info.branch) ~= "" then RuntimeGMClient.SvnBranch = trimString(info.branch) end
        if trimString(info.revision) ~= "" then RuntimeGMClient.SvnRevision = trimString(info.revision) end
        if trimString(info.detection) ~= "" then RuntimeGMClient.SvnDetection = trimString(info.detection) end
    end

    local function setSvnRetryAfter(seconds)
        RuntimeGMClient._svnRetryAfter = (function()
            local now = 0
            pcall(function() now = CS.UnityEngine.Time.realtimeSinceStartup end)
            return now + (seconds or 10)
        end)()
    end

    local function finishSvnQuery(serial, info)
        if serial ~= RuntimeGMClient._svnQuerySerial then return end
        RuntimeGMClient._svnQueryPending = false
        applySvnInfo(info)
        if RuntimeGMClient.Socket and (RuntimeGMClient.SvnAuthor ~= "" or RuntimeGMClient.SvnUrl ~= "") then
            RuntimeGMClient.SendHello()
        end
        if RuntimeGMClient.SvnAuthor == "" and (RuntimeGMClient._svnRetryCount or 0) < 1 then
            setSvnRetryAfter(10)
        else
            RuntimeGMClient._svnRetryAfter = nil
        end
    end

    local function beginSvnQuery()
        if RuntimeGMClient._svnQueryPending then return end
        RuntimeGMClient._svnQueryPending = true
        RuntimeGMClient._svnQuerySerial = (RuntimeGMClient._svnQuerySerial or 0) + 1
        local serial = RuntimeGMClient._svnQuerySerial
        local dataPath = trimString(CS.UnityEngine.Application.dataPath)

        -- 复用 XExternalTool 的后台线程执行器，避免 svn.exe 冷启动阻塞 Unity 主线程。
        local okStarted = pcall(function()
            local svnTool = CS.XExternalTool
            local svnPath = trimString(svnTool.SvnPath)
            if svnPath == "" then error("XExternalTool.SvnPath is empty") end
            svnTool.RunToolInNewThread(
                svnPath,
                'info --xml "' .. dataPath .. '"',
                false,
                function(output)
                    finishSvnQuery(serial, tryGetSvnInfo(trimString(output)))
                end
            )
        end)

        if okStarted then
            -- 同时充当后台线程无回调时的看门狗；正常完成后会被 finishSvnQuery 清除或重置。
            if (RuntimeGMClient._svnRetryCount or 0) < 1 then
                setSvnRetryAfter(10)
            else
                RuntimeGMClient._svnRetryAfter = nil
            end
        else
            -- 非 Windows、裁剪包或 XExternalTool 不可用时，保留旧认证缓存能力。
            finishSvnQuery(serial, tryGetSvnInfo(""))
        end
    end

    -- 每次 HELLO 都重新读取，因为版本号可能在运行期被 GM 面板的"改版本号"改动。
    local function getAppVersion()
        local version = ""
        pcall(function() version = tostring(CS.XRemoteConfig.ApplicationVersion) end)
        return version
    end

    function RuntimeGMClient.SendHello()
        RuntimeGMClient.Send({
            type = "HELLO",
            pid = RuntimeGMClient.DeviceInfo.pid,
            device = RuntimeGMClient.DeviceInfo.device,
            platform = RuntimeGMClient.DeviceInfo.platform,
            packageName = RuntimeGMClient.DeviceInfo.packageName,
            persistentDataPath = RuntimeGMClient.DeviceInfo.persistentDataPath,
            appVersion = getAppVersion(),
            svn_author = RuntimeGMClient.SvnAuthor or "",
            svn_url = RuntimeGMClient.SvnUrl or "",
            svn_branch = RuntimeGMClient.SvnBranch or "",
            svn_revision = RuntimeGMClient.SvnRevision or "",
            svn_detection = RuntimeGMClient.SvnDetection or ""
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
            RuntimeGMClient.Socket = tcp
            pcall(function() RuntimeGMClient.LastRecvTime = CS.UnityEngine.Time.realtimeSinceStartup end)
            -- HELLO: 用短暂阻塞超时确保能发出去
            tcp:settimeout(0.5)
            RuntimeGMClient.SendHello()
            if RuntimeGMClient.GMLoaded and RuntimeGMClient.SendGMList then
                pcall(function() RuntimeGMClient.SendGMList() end)
            end
            -- 发完 HELLO 后切回非阻塞
            tcp:settimeout(0)
            -- 始终重置 SVN 标记，让 Update() 在首帧尝试获取（可能立即补发 HELLO）
            RuntimeGMClient._svnFetched = false
            RuntimeGMClient._svnRetryAfter = nil
            RuntimeGMClient._svnRetryCount = 0
            RuntimeGMClient._svnQueryPending = false
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
    local HIER_BINDING_INSTANCE_ALL = 52          -- Instance | Public | NonPublic
    local HIER_BINDING_DECLARED_INSTANCE_ALL = 54 -- DeclaredOnly | Instance | Public | NonPublic

    local function hierAttributeName(attr)
        local name = ""
        pcall(function() name = tostring(attr:GetType().Name) end)
        return name:gsub("Attribute$", "")
    end

    local function hierReadFieldMetadata(field)
        local meta = {}
        local attrs
        pcall(function() attrs = field:GetCustomAttributes(true) end)
        if attrs then
            local count = 0
            pcall(function() count = attrs.Length end)
            for i = 0, count - 1 do
                local attr = attrs[i]
                local name = hierAttributeName(attr)
                if name == "SerializeField" then
                    meta.serializeField = true
                elseif name == "SerializeReference" then
                    meta.serializeReference = true
                elseif name == "HideInInspector" then
                    meta.hidden = true
                elseif name == "NonSerialized" then
                    meta.nonSerialized = true
                elseif name == "Header" then
                    pcall(function() meta.header = tostring(attr.header) end)
                elseif name == "Tooltip" then
                    pcall(function() meta.tooltip = tostring(attr.tooltip) end)
                elseif name == "Range" then
                    pcall(function()
                        meta.rangeMin = tonumber(attr.min)
                        meta.rangeMax = tonumber(attr.max)
                    end)
                elseif name == "Min" then
                    pcall(function() meta.min = tonumber(attr.min) end)
                elseif name == "Space" then
                    pcall(function() meta.space = tonumber(attr.height) or 8 end)
                elseif name == "TextArea" then
                    pcall(function()
                        meta.textArea = true
                        meta.minLines = tonumber(attr.minLines)
                        meta.maxLines = tonumber(attr.maxLines)
                    end)
                elseif name == "Multiline" then
                    pcall(function()
                        meta.textArea = true
                        meta.lines = tonumber(attr.lines)
                    end)
                end
            end
        end
        -- 某些 IL2CPP/XLua 组合无法稳定枚举 Attribute 数组，关键筛选属性再用 IsDefined 兜底。
        pcall(function()
            if field:IsDefined(typeof(CS.UnityEngine.SerializeField), true) then meta.serializeField = true end
        end)
        pcall(function()
            if field:IsDefined(typeof(CS.UnityEngine.SerializeReference), true) then meta.serializeReference = true end
        end)
        pcall(function()
            if field:IsDefined(typeof(CS.UnityEngine.HideInInspector), true) then meta.hidden = true end
        end)
        pcall(function()
            if field:IsDefined(typeof(CS.System.NonSerializedAttribute), true) then meta.nonSerialized = true end
        end)
        return meta
    end

    local function hierNicifyFieldName(name)
        local value = tostring(name or "")
        value = value:gsub("^m_", "")
        value = value:gsub("^_", "")
        value = value:gsub("_", " ")
        value = value:gsub("(%l)(%u)", "%1 %2")
        value = value:gsub("(%a)(%d)", "%1 %2")
        value = value:gsub("(%d)(%a)", "%1 %2")
        if #value > 0 then value = value:sub(1, 1):upper() .. value:sub(2) end
        return value
    end

    local function hierIsUnityBaseComponentType(t)
        local fullName = ""
        pcall(function() fullName = tostring(t.FullName) end)
        return fullName == "UnityEngine.Object"
            or fullName == "UnityEngine.Component"
            or fullName == "UnityEngine.Behaviour"
            or fullName == "UnityEngine.MonoBehaviour"
            or fullName == "System.Object"
    end

    local function hierCollectSerializableFields(targetType)
        local chain = {}
        local current = targetType
        while current and not hierIsUnityBaseComponentType(current) do
            chain[#chain + 1] = current
            local nextType
            pcall(function() nextType = current.BaseType end)
            current = nextType
        end

        local result = {}
        for ci = #chain, 1, -1 do
            local fields
            pcall(function() fields = chain[ci]:GetFields(HIER_BINDING_DECLARED_INSTANCE_ALL) end)
            local declared = {}
            if fields then
                for i = 0, fields.Length - 1 do declared[#declared + 1] = fields[i] end
            end
            table.sort(declared, function(a, b)
                local at, bt = 0, 0
                pcall(function() at = tonumber(a.MetadataToken) or 0 end)
                pcall(function() bt = tonumber(b.MetadataToken) or 0 end)
                return at < bt
            end)
            for _, field in ipairs(declared) do
                local meta = hierReadFieldMetadata(field)
                local isStatic, isLiteral, isInitOnly, isNotSerialized = false, false, false, false
                pcall(function() isStatic = field.IsStatic end)
                pcall(function() isLiteral = field.IsLiteral end)
                pcall(function() isInitOnly = field.IsInitOnly end)
                pcall(function() isNotSerialized = field.IsNotSerialized end)
                local include = (field.IsPublic or meta.serializeField or meta.serializeReference)
                    and not isStatic and not isLiteral and not isInitOnly
                    and not isNotSerialized and not meta.nonSerialized and not meta.hidden
                if include then
                    result[#result + 1] = { field = field, meta = meta }
                end
            end
        end
        return result
    end

    local function hierCountSerializableFields(targetType)
        local ok, fields = pcall(hierCollectSerializableFields, targetType)
        return ok and #fields or 0
    end

    local function hierEnumOptions(enumType)
        local options = {}
        pcall(function()
            local names = CS.System.Enum.GetNames(enumType)
            for i = 0, names.Length - 1 do options[#options + 1] = tostring(names[i]) end
        end)
        return options
    end

    local function hierApplyValueExtra(entry, valueType, extra)
        if not extra then return end
        if valueType == "collection" then
            entry.count = extra.count
            entry.collectionKind = extra.kind
        elseif valueType == "ref" then
            entry.instanceId = extra.instanceId
            entry.refKind = extra.refKind
            entry.actualType = extra.actualType
        elseif valueType == "material" then
            entry.materialInstanceId = extra.materialInstanceId
            entry.shaderName = extra.shaderName
        end
    end

    local function hierBuildSerializedFieldEntry(owner, field, meta)
        local fieldName = tostring(field.Name)
        local typeName = tostring(field.FieldType.Name)
        local value = field:GetValue(owner)
        local serialized, valueType, extra = inspectorSerializePropValue(value, typeName)
        if value ~= nil and valueType == "readonly" then
            local memberCount = hierCountSerializableFields(field.FieldType)
            if memberCount > 0 then
                valueType = "object"
                serialized = typeName
                extra = { memberCount = memberCount }
            end
        end
        local entry = {
            name = fieldName,
            displayName = hierNicifyFieldName(fieldName),
            typeName = typeName,
            valueType = valueType,
            value = serialized,
            editable = valueType ~= "readonly" and valueType ~= "collection"
                and valueType ~= "object" and valueType ~= "ref" and valueType ~= "material",
            isField = true,
            serializedField = true,
            path = {},
        }
        for key, val in pairs(meta or {}) do entry[key] = val end
        if valueType == "object" and extra then entry.memberCount = extra.memberCount end
        local isEnum = false
        pcall(function() isEnum = field.FieldType.IsEnum end)
        if isEnum then entry.enumOptions = hierEnumOptions(field.FieldType) end
        hierApplyValueExtra(entry, valueType, extra)
        return entry
    end

    local function readSerializedFields(comp)
        local result = {}
        local fields = hierCollectSerializableFields(comp:GetType())
        for _, item in ipairs(fields) do
            pcall(function()
                result[#result + 1] = hierBuildSerializedFieldEntry(comp, item.field, item.meta)
            end)
        end
        return result
    end

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
        local result = {
            serializedFields = readSerializedFields(comp),
            properties = {},
            methods = {},
            _debug = { propCount = 0, tried = 0, failed = 0 },
        }

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
                    value = serialized, editable = prop.CanWrite and valueType ~= "readonly"
                        and valueType ~= "collection" and valueType ~= "ref" and valueType ~= "material",
                }
                hierApplyValueExtra(entry, valueType, extra)
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
                    value = serialized, editable = (not fld.IsInitOnly) and valueType ~= "readonly"
                        and valueType ~= "collection" and valueType ~= "ref" and valueType ~= "material", isField = true,
                }
                hierApplyValueExtra(entry, valueType, extra)
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
    LuaHierarchy._materialRefs = setmetatable({}, { __mode = "v" }) -- instanceId(number) → Material

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
                entry.serializedFields = {}
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
                    entry.serializedFields = {}
                    entry.properties = {}
                    entry.methods = {}
                else
                    entry.serializedFields = det.serializedFields or {}
                    entry.properties = det.properties or {}
                    entry.methods = det.methods or {}
                    -- Unity 默认 Inspector 保留序列化声明顺序；高级运行时成员仍按名称排序便于检索。
                    table.sort(entry.methods, function(a, b) return a.name < b.name end)

                    -- Renderer 的 sharedMaterials 与 UI Graphic 的 material 不是普通序列化字段，
                    -- 但属于 Unity Inspector 的通用材质入口。只读取不会隐式实例化的引用。
                    local seenMaterials = {}
                    for _, field in ipairs(entry.serializedFields) do
                        if field.materialInstanceId then seenMaterials[field.materialInstanceId] = true end
                    end
                    local function appendMaterial(material, label)
                        if not material then return end
                        local id = -1
                        pcall(function() id = material:GetInstanceID() end)
                        if id == -1 or seenMaterials[id] then return end
                        seenMaterials[id] = true
                        LuaHierarchy._materialRefs[id] = material
                        local materialName, shaderName = "Material", ""
                        pcall(function() materialName = tostring(material.name) end)
                        pcall(function() shaderName = tostring(material.shader.name) end)
                        entry.serializedFields[#entry.serializedFields + 1] = {
                            name = label,
                            displayName = label,
                            typeName = "Material",
                            valueType = "material",
                            value = materialName,
                            materialInstanceId = id,
                            shaderName = shaderName,
                            editable = false,
                            serializedField = true,
                            synthetic = true,
                            path = {},
                        }
                    end
                    pcall(function()
                        local shared = c.sharedMaterials
                        if shared then
                            for mi = 0, shared.Length - 1 do
                                appendMaterial(shared[mi], shared.Length > 1 and ("Material " .. mi) or "Material")
                            end
                        end
                    end)
                    local isGraphic = false
                    pcall(function()
                        local ct = c:GetType()
                        while ct do
                            if tostring(ct.FullName) == "UnityEngine.UI.Graphic" then isGraphic = true; break end
                            ct = ct.BaseType
                        end
                    end)
                    if isGraphic then pcall(function() appendMaterial(c.material, "Material") end) end

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
            local function tryResolveGo(candidate)
                if not candidate then return nil end
                local ok, goObj = pcall(function() return candidate.gameObject end)
                if ok and goObj then return goObj end
                local ok2, ah = pcall(function() return candidate.activeInHierarchy end)
                if ok2 and type(ah) == "boolean" then return candidate end
                return nil
            end
            pcall(function()
                go = tryResolveGo(target)
                if (not go) and type(target) == "table" then
                    local keys = { "GameObject", "Transform", "Obj", "gameObject", "transform" }
                    for _, key in ipairs(keys) do
                        local ok, candidate = pcall(function() return target[key] end)
                        if ok and candidate then
                            go = tryResolveGo(candidate)
                            if go then break end
                        end
                    end
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
    local function hierClonePath(path)
        local cloned = {}
        for i = 1, #(path or {}) do
            local seg = path[i]
            cloned[i] = { kind = seg.kind, name = seg.name, index = seg.index }
        end
        return cloned
    end

    local function hierAppendPath(path, segment)
        local nextPath = hierClonePath(path)
        nextPath[#nextPath + 1] = segment
        return nextPath
    end

    local function hierDescribeItem(el, accessPath, editable, declaredTypeName)
        if el == nil then return { kind = "value", display = "nil", typeName = declaredTypeName or "nil", path = accessPath } end
        local lt = type(el)
        if lt == "boolean" then return { kind = "value", display = tostring(el), value = el, valueType = "bool", typeName = declaredTypeName or "Boolean", editable = editable == true, path = accessPath } end
        if lt == "number" then
            local tn = declaredTypeName or "Number"
            local isInt = tn == "Int32" or tn == "Int64" or tn == "Byte" or tn == "Int16"
            return { kind = "value", display = tostring(el), value = el, valueType = isInt and "int" or "float", typeName = tn, editable = editable == true, path = accessPath }
        end
        if lt == "string" then return { kind = "value", display = el, value = el, valueType = "string", typeName = declaredTypeName or "String", editable = editable == true, path = accessPath } end
        if lt ~= "userdata" then return { kind = "value", display = tostring(el), typeName = lt } end

        local typeName = declaredTypeName or "?"
        if not declaredTypeName then pcall(function() typeName = tostring(el:GetType().Name) end) end

        -- GameObject
        if typeName == "GameObject" then
            local id = -1; pcall(function() id = el:GetInstanceID() end)
            local name = "?"; pcall(function() name = el.name end)
            hierCacheGo(el)
            return {
                kind = "go", instanceId = id, name = name, display = name, value = name,
                typeName = "GameObject", actualType = "GameObject",
                valueType = "ref", path = accessPath,
            }
        end

        -- Component（Transform / 任意 MonoBehaviour 子类等）有 .gameObject 反指 GO
        local goObj
        pcall(function() goObj = el.gameObject end)
        if goObj then
            local id = -1; pcall(function() id = goObj:GetInstanceID() end)
            local name = "?"; pcall(function() name = goObj.name end)
            hierCacheGo(goObj)
            return {
                kind = "comp", instanceId = id, name = name, display = name, value = name,
                typeName = typeName, actualType = typeName,
                valueType = "ref", path = accessPath,
            }
        end

        -- 可直接编辑的 Unity struct / 基础 CLR 值。
        local serialized, valueType, extra = inspectorSerializePropValue(el, typeName)
        if valueType == "material" and extra then
            return {
                kind = "material", display = serialized, value = serialized,
                valueType = "material", typeName = "Material",
                materialInstanceId = extra.materialInstanceId,
                shaderName = extra.shaderName,
                editable = false, path = accessPath,
            }
        end
        if valueType == "vector2" or valueType == "vector3" or valueType == "vector4"
            or valueType == "color" or valueType == "rect" or valueType == "euler"
            or valueType == "bool" or valueType == "int" or valueType == "float"
            or valueType == "string" then
            return {
                kind = "value", display = tostring(el), value = serialized,
                valueType = valueType, typeName = typeName,
                editable = editable == true, path = accessPath,
            }
        end
        if valueType == "collection" and extra then
            return {
                kind = "collection", display = serialized, value = serialized,
                valueType = "collection", typeName = typeName,
                count = extra.count, collectionKind = extra.kind,
                editable = false, path = accessPath,
            }
        end

        -- 其他 userdata 作为可展开自定义对象返回，不再退化为地址式 tostring。
        local memberCount = 0
        pcall(function() memberCount = hierCountSerializableFields(el:GetType()) end)
        local s = "?"; pcall(function() s = tostring(el) end)
        return {
            kind = "object", display = s, value = typeName,
            valueType = "object", typeName = typeName,
            memberCount = memberCount, editable = false, path = accessPath,
        }
    end

    local function hierGetMemberValue(owner, name)
        local value
        local ok = pcall(function() value = owner[name] end)
        if ok and value ~= nil then return value end
        local found = false
        pcall(function()
            local t = owner:GetType()
            while t do
                local fld = t:GetField(name, HIER_BINDING_INSTANCE_ALL)
                if fld then value = fld:GetValue(owner); found = true; return end
                t = t.BaseType
            end
            t = owner:GetType()
            local prop = t:GetProperty(name, HIER_BINDING_INSTANCE_ALL)
            if prop and prop.CanRead then value = prop:GetValue(owner, nil); found = true end
        end)
        if found then return value end
        error("成员不存在或不可读: " .. tostring(name))
    end

    local function hierSetMemberValue(owner, name, value)
        local setOk = false
        local directOk = pcall(function() owner[name] = value; setOk = true end)
        if directOk and setOk then return end
        local reflectOk, reflectErr = pcall(function()
            local t = owner:GetType()
            while t do
                local fld = t:GetField(name, HIER_BINDING_INSTANCE_ALL)
                if fld and not fld.IsInitOnly then
                    local converted = value
                    local isEnum = false
                    pcall(function() isEnum = fld.FieldType.IsEnum end)
                    if isEnum and type(value) == "string" then
                        converted = CS.System.Enum.Parse(fld.FieldType, value)
                    end
                    fld:SetValue(owner, converted)
                    setOk = true
                    return
                end
                t = t.BaseType
            end
            t = owner:GetType()
            local prop = t:GetProperty(name, HIER_BINDING_INSTANCE_ALL)
            if prop and prop.CanWrite then prop:SetValue(owner, value, nil); setOk = true; return end
            error("成员不存在或不可写: " .. tostring(name))
        end)
        if not reflectOk then error(reflectErr) end
        if not setOk then error("成员不存在或不可写: " .. tostring(name)) end
    end

    local function hierGetPathValue(root, path)
        local current = root
        for i = 1, #(path or {}) do
            local seg = path[i]
            if seg.kind == "index" then
                current = current[tonumber(seg.index)]
            elseif seg.kind == "member" then
                current = hierGetMemberValue(current, seg.name)
            else
                error("未知路径段: " .. tostring(seg.kind))
            end
        end
        return current
    end

    local function hierGetRootValue(comp, propName)
        return hierGetMemberValue(comp, propName)
    end

    local function hierSetPathValue(comp, propName, path, value, valueType)
        if not path or #path == 0 then
            hierSetMemberValue(comp, propName, convertTypedValue(value, valueType))
            return
        end

        local root = hierGetRootValue(comp, propName)
        local current = root
        local frames = {}
        for i = 1, #path - 1 do
            local seg = path[i]
            frames[#frames + 1] = { owner = current, segment = seg }
            if seg.kind == "index" then
                current = current[tonumber(seg.index)]
            elseif seg.kind == "member" then
                current = hierGetMemberValue(current, seg.name)
            else
                error("未知路径段: " .. tostring(seg.kind))
            end
        end

        local leaf = path[#path]
        local converted = convertTypedValue(value, valueType)
        if leaf.kind == "index" then
            current[tonumber(leaf.index)] = converted
        elseif leaf.kind == "member" then
            hierSetMemberValue(current, leaf.name, converted)
        else
            error("未知路径段: " .. tostring(leaf.kind))
        end

        -- 将可能被装箱的值类型逐层写回；对引用类型重复赋值同样安全。
        local updated = current
        for i = #frames, 1, -1 do
            local frame = frames[i]
            if frame.segment.kind == "index" then
                frame.owner[tonumber(frame.segment.index)] = updated
            else
                hierSetMemberValue(frame.owner, frame.segment.name, updated)
            end
            updated = frame.owner
        end
        hierSetMemberValue(comp, propName, updated)
    end

    local function hierGetComponentRef(goId, compIndex)
        local key = goId .. "_" .. compIndex
        local ref = LuaHierarchyCore._compRefs[key]
        if not ref or not ref.comp then
            return nil, { error = "Component 缓存丢失，请重新选中 GameObject" }
        end
        return ref, nil
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

        local ref, refErr = hierGetComponentRef(goId, compIndex)
        if not ref then return refErr end

        -- 同时支持公开运行时成员和私有 [SerializeField]。
        local val
        local ok = pcall(function() val = hierGetRootValue(ref.comp, propName) end)
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
                        local d = hierDescribeItem(val[i], { { kind = "index", index = i } }, true)
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
                        local d = hierDescribeItem(val[i], { { kind = "index", index = i } }, true)
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
                    local d = hierDescribeItem(cur, { { kind = "index", index = idx } }, true)
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

    -- 懒加载集合元素或自定义对象的公开字段。
    -- path 相对组件顶层 propName，使用 {kind="index"|"member", ...} 分段，避免解析字符串表达式。
    function LuaHierarchy.GetValueChildren(packet)
        local goId = packet.goInstanceId
        local compIndex = packet.compIndex
        local propName = packet.propName
        local path = packet.path or {}
        local offset = tonumber(packet.offset) or 0
        local limit = tonumber(packet.limit) or 50
        if limit < 1 then limit = 1 end
        if limit > 200 then limit = 200 end
        if #path > 12 then return { error = "嵌套层级超过上限" } end

        local ref, refErr = hierGetComponentRef(goId, compIndex)
        if not ref then return refErr end

        local ok, target = pcall(function()
            return hierGetPathValue(hierGetRootValue(ref.comp, propName), path)
        end)
        if not ok then return { error = "读取嵌套值失败: " .. tostring(target) } end
        if target == nil then return { error = "嵌套值为 nil" } end

        local targetType
        pcall(function() targetType = target:GetType() end)
        if not targetType then return { error = "该值没有可展开成员" } end

        local items = {}
        local total = 0

        -- 嵌套 Array / List<T>。
        local isArray = false
        pcall(function() isArray = targetType.IsArray end)
        local count
        if isArray then
            pcall(function() count = target.Length end)
        else
            pcall(function() count = target.Count end)
        end
        if count ~= nil then
            total = tonumber(count) or 0
            local maxI = math.min(offset + limit, total)
            for i = offset, maxI - 1 do
                pcall(function()
                    local childPath = hierAppendPath(path, { kind = "index", index = i })
                    local d = hierDescribeItem(target[i], childPath, true)
                    d.index = i
                    items[#items + 1] = d
                end)
            end
            return {
                total = total, kind = "list", offset = offset, limit = limit, items = items,
            }
        end

        -- 自定义对象按 Unity 序列化规则枚举字段，并携带 Header/Tooltip/Range 等元数据。
        local fieldsOk, fieldList = pcall(hierCollectSerializableFields, targetType)
        if not fieldsOk or not fieldList then
            return { error = "读取对象字段失败: " .. tostring(fieldList) }
        end
        total = #fieldList

        local maxI = math.min(offset + limit, total)
        for i = offset + 1, maxI do
            local item = fieldList[i]
            local fld = item.field
            pcall(function()
                local name = tostring(fld.Name)
                local childPath = hierAppendPath(path, { kind = "member", name = name })
                local d = hierBuildSerializedFieldEntry(target, fld, item.meta)
                d.path = childPath
                items[#items + 1] = d
            end)
        end

        return {
            total = total, kind = "object", offset = offset, limit = limit, items = items,
        }
    end

    function LuaHierarchy.SetNestedProp(packet)
        local path = packet.path or {}
        if #path > 12 then return { error = "嵌套层级超过上限" } end

        local ref, refErr = hierGetComponentRef(packet.goInstanceId, packet.compIndex)
        if not ref then return refErr end
        local ok, err = pcall(function()
            hierSetPathValue(ref.comp, packet.propName, path, packet.value, packet.valueType)
        end)
        if not ok then return { error = "写入嵌套值失败: " .. tostring(err) } end
        return { success = true }
    end

    local function hierGetMaterial(materialInstanceId)
        local id = tonumber(materialInstanceId)
        if not id then return nil end
        local material = LuaHierarchy._materialRefs[id]
        if not material then return nil end
        local alive = false
        pcall(function() alive = material.name ~= nil end)
        if not alive then
            LuaHierarchy._materialRefs[id] = nil
            return nil
        end
        return material
    end

    function LuaHierarchy.GetMaterialDetail(packet)
        local material = hierGetMaterial(packet.materialInstanceId)
        if not material then return { error = "材质引用已失效，请刷新 Inspector" } end

        local result = {
            materialInstanceId = tonumber(packet.materialInstanceId),
            name = "Material",
            shaderName = "",
            renderQueue = 0,
            properties = {},
        }
        pcall(function() result.name = tostring(material.name) end)
        pcall(function() result.shaderName = tostring(material.shader.name) end)
        pcall(function() result.renderQueue = tonumber(material.renderQueue) or 0 end)

        local shader
        pcall(function() shader = material.shader end)
        if not shader then return result end
        local count = 0
        local countOk, countErr = pcall(function() count = shader:GetPropertyCount() end)
        if not countOk then
            return { error = "当前真机未暴露 Shader 属性枚举 API: " .. tostring(countErr) }
        end

        -- 不同 Unity/XLua 版本对 ShaderPropertyType 的 tostring 表现不一致：
        -- 有的返回 "Float"，有的返回 "Float: 2"，当前真机则只返回 "2"。
        -- 统一映射为稳定名称，避免所有参数落入“不支持”分支。
        local shaderPropertyTypeNames = {
            ["0"] = "Color",
            ["1"] = "Vector",
            ["2"] = "Float",
            ["3"] = "Range",
            ["4"] = "Texture",
            ["5"] = "Int",
        }
        for i = 0, count - 1 do
            pcall(function()
                local name = tostring(shader:GetPropertyName(i))
                local displayName = name
                pcall(function() displayName = tostring(shader:GetPropertyDescription(i)) end)
                local propertyType = tostring(shader:GetPropertyType(i))
                propertyType = propertyType:match("([%w_]+)$") or propertyType
                propertyType = shaderPropertyTypeNames[propertyType] or propertyType
                local flags = ""
                pcall(function() flags = tostring(shader:GetPropertyFlags(i)) end)
                if flags:find("HideInInspector", 1, true) then return end
                local entry = {
                    name = name,
                    displayName = displayName,
                    propertyType = propertyType,
                    editable = true,
                    flags = flags,
                    noScaleOffset = flags:find("NoScaleOffset", 1, true) ~= nil,
                }

                if propertyType == "Color" then
                    local value = material:GetColor(name)
                    entry.value = { value.r, value.g, value.b, value.a }
                elseif propertyType == "Vector" then
                    local value = material:GetVector(name)
                    entry.value = { value.x, value.y, value.z, value.w }
                elseif propertyType == "Float" or propertyType == "Range" then
                    entry.value = tonumber(material:GetFloat(name)) or 0
                    if propertyType == "Range" then
                        pcall(function()
                            local limits = shader:GetPropertyRangeLimits(i)
                            entry.rangeMin = tonumber(limits.x)
                            entry.rangeMax = tonumber(limits.y)
                        end)
                    end
                elseif propertyType == "Int" or propertyType == "Integer" then
                    local intOk, intValue = pcall(function() return material:GetInt(name) end)
                    entry.value = intOk and tonumber(intValue) or tonumber(material:GetFloat(name)) or 0
                    entry.propertyType = "Int"
                elseif propertyType == "Texture" then
                    local texture
                    pcall(function() texture = material:GetTexture(name) end)
                    entry.editable = false
                    entry.textureName = texture and tostring(texture.name) or "None"
                    if texture then
                        pcall(function() entry.textureWidth = tonumber(texture.width) end)
                        pcall(function() entry.textureHeight = tonumber(texture.height) end)
                    end
                    local offset = material:GetTextureOffset(name)
                    local scale = material:GetTextureScale(name)
                    entry.offset = { offset.x, offset.y }
                    entry.scale = { scale.x, scale.y }
                else
                    entry.editable = false
                    entry.value = "(暂不支持)"
                end
                result.properties[#result.properties + 1] = entry
            end)
        end
        return result
    end

    function LuaHierarchy.SetMaterialProperty(packet)
        local material = hierGetMaterial(packet.materialInstanceId)
        if not material then return { error = "材质引用已失效，请刷新 Inspector" } end
        local name = tostring(packet.propertyName or "")
        if name == "" then return { error = "缺少材质属性名" } end
        local propertyType = tostring(packet.propertyType or "")
        local value = packet.value
        local ok, err = pcall(function()
            if propertyType == "Color" then
                material:SetColor(name, CS.UnityEngine.Color(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 1))
            elseif propertyType == "Vector" then
                material:SetVector(name, CS.UnityEngine.Vector4(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 0))
            elseif propertyType == "Float" or propertyType == "Range" then
                material:SetFloat(name, tonumber(value) or 0)
            elseif propertyType == "Int" or propertyType == "Integer" then
                material:SetInt(name, math.floor(tonumber(value) or 0))
            elseif propertyType == "TextureOffset" then
                material:SetTextureOffset(name, CS.UnityEngine.Vector2(value[1] or 0, value[2] or 0))
            elseif propertyType == "TextureScale" then
                material:SetTextureScale(name, CS.UnityEngine.Vector2(value[1] or 1, value[2] or 1))
            else
                error("不支持的材质属性类型: " .. propertyType)
            end
        end)
        if not ok then return { error = tostring(err) } end
        return { success = true }
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
        elseif action == "value_children" then
            result = LuaHierarchy.GetValueChildren(packet)
        elseif action == "set_nested_prop" then
            result = LuaHierarchy.SetNestedProp(packet)
        elseif action == "material_detail" then
            result = LuaHierarchy.GetMaterialDetail(packet)
        elseif action == "material_set_prop" then
            result = LuaHierarchy.SetMaterialProperty(packet)
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
        local seen = {}
        local activeMap = {}

        local allOk, allList = pcall(function() return CS.XUiManager.Instance:GetAllList() end)
        if allOk and allList then
            for i = 0, allList.Count - 1 do
                pcall(function()
                    local xui = allList[i]
                    local uiName = tostring(xui.UiData.UiName)
                    activeMap[uiName] = xui.IsEnable
                end)
            end
        end

        local function pushUi(uiName)
            uiName = tostring(uiName or "")
            if uiName == "" or seen[uiName] then return end
            seen[uiName] = true
            local luaUi = nil
            pcall(function() luaUi = XLuaUiManager.GetTopLuaUi(uiName) end)
            if not luaUi then return end
            result[#result + 1] = {
                name = uiName,
                active = activeMap[uiName] ~= false,
            }
        end

        local stackOk, stack = pcall(function() return XLuaUiManager:GetUiStack() end)
        if stackOk and stack then
            for i = 0, stack.Count - 1 do
                pcall(function()
                    local item = stack[i]
                    if item and item.Name then pushUi(item.Name) end
                end)
            end
        end

        if #result == 0 then
            if not allOk or not allList then
                return { error = "Failed to get UI list: " .. tostring(allList) }
            end
            for i = 0, allList.Count - 1 do
                pcall(function()
                    local xui = allList[i]
                    if xui and xui.UiData then pushUi(xui.UiData.UiName) end
                end)
            end
        end

        -- 兜底补齐：保留 GetUiStack 的真实栈顺序，同时追加栈里缺失但仍打开的 UI。
        if allOk and allList then
            for i = 0, allList.Count - 1 do
                pcall(function()
                    local xui = allList[i]
                    if xui and xui.UiData then pushUi(xui.UiData.UiName) end
                end)
            end
        end

        for i, info in ipairs(result) do info.order = i end

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
            -- Material 是资源引用，没有 gameObject，单独缓存后交给按需材质面板处理。
            if tName == "Material" then
                local id = -1; pcall(function() id = val:GetInstanceID() end)
                local name = "Material"; pcall(function() name = tostring(val.name) end)
                local shaderName = ""; pcall(function() shaderName = tostring(val.shader.name) end)
                if id ~= -1 then LuaHierarchy._materialRefs[id] = val end
                return {
                    display = name,
                    materialInstanceId = id,
                    shaderName = shaderName,
                    actualType = "Material",
                    isMaterial = true,
                }
            end
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
        if rOk and rInfo and rInfo.isMaterial and rInfo.materialInstanceId ~= -1 then
            return rInfo.display, "material", rInfo
        end
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
    local LuaGameLogTail = {}

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
        -- 连接建立后再查询 SVN，避免阻塞 RuntimeGM 初始化和首个 HELLO。
        if not RuntimeGMClient._svnFetched then
            RuntimeGMClient._svnFetched = true
            beginSvnQuery()
        elseif RuntimeGMClient._svnRetryAfter then
            -- 延迟重试，同时作为后台 SVN 查询的超时看门狗。
            local now = 0
            pcall(function() now = CS.UnityEngine.Time.realtimeSinceStartup end)
            if now >= RuntimeGMClient._svnRetryAfter then
                RuntimeGMClient._svnRetryAfter = nil
                RuntimeGMClient._svnQueryPending = false
                RuntimeGMClient._svnRetryCount = (RuntimeGMClient._svnRetryCount or 0) + 1
                beginSvnQuery()
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

        -- 游戏端物理日志 tail：只有 Web 端订阅时才激活
        local glOk, glErr = pcall(LuaGameLogTail.Update)
        if not glOk then
            origin_print("[RuntimeGM] LuaGameLogTail error: " .. tostring(glErr))
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

    local function _spm_safeNumber(value, fallback)
        if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
            return fallback
        end
        return value
    end

    local function _spm_getAgency()
        local ok, agency = pcall(function() return XMVCA.XSubPackage end)
        if not ok or not agency then return nil end
        return agency
    end

    -- SubPackage.tab 的运行态完整模板是展示权威。_SubpackageDict 只包含已实例化对象，
    -- _SubIndexInfo 只包含实际进入资源索引的 Res，都不能用于决定配置项是否展示。
    local function _spm_getSubpackageTemplates(agency)
        local templates = nil
        pcall(function()
            local model = agency and agency._Model
            local initFn = model and model.InitSubpackage
            if not model or not model._ConfigUtil or type(initFn) ~= "function" then return end

            local tableKey = nil
            for i = 1, 20 do
                local name, value = debug.getupvalue(initFn, i)
                if not name then break end
                if name == "TableKey" and type(value) == "table" then
                    tableKey = value
                    break
                end
            end
            if tableKey and tableKey.SubPackage then
                templates = model._ConfigUtil:GetByTableKey(tableKey.SubPackage)
            end
        end)
        return templates
    end

    local function _spm_fileCount(fileDict)
        local count = 0
        if fileDict then for _ in pairs(fileDict) do count = count + 1 end end
        return count
    end

    local function _spm_addUniqueId(ids, id)
        for _, existing in ipairs(ids) do
            if existing == id then return end
        end
        ids[#ids + 1] = id
    end

    local function _spm_buildCrossSubFileCounts(subs, subIndexInfo, fileToResIds)
        local resToSubIds = {}
        for subId, sub in pairs(subs) do
            if sub.configured ~= false then
                for _, resId in pairs(sub.resIds or {}) do
                    local key = tonumber(resId) or resId
                    resToSubIds[key] = resToSubIds[key] or {}
                    resToSubIds[key][tostring(subId)] = true
                end
            end
        end
        for subId, sub in pairs(subs) do
            local currentResSet = {}
            for _, resId in pairs(sub.resIds or {}) do
                currentResSet[tonumber(resId) or resId] = true
            end

            local counts = {}
            for _, resId in pairs(sub.resIds or {}) do
                local fileDict = subIndexInfo and subIndexInfo[tonumber(resId)]
                local seenFiles = {}
                local crossSubFileCount = 0
                for _, info in pairs(fileDict or {}) do
                    local fileName = info and info[1]
                    if fileName and not seenFiles[fileName] then
                        seenFiles[fileName] = true
                        for _, ownerResId in ipairs(fileToResIds[fileName] or {}) do
                            local ownerKey = tonumber(ownerResId) or ownerResId
                            local belongsToOtherSub = false
                            for ownerSubId in pairs(resToSubIds[ownerKey] or {}) do
                                if ownerSubId ~= tostring(subId) then
                                    belongsToOtherSub = true
                                    break
                                end
                            end
                            if not currentResSet[ownerKey] and belongsToOtherSub then
                                crossSubFileCount = crossSubFileCount + 1
                                break
                            end
                        end
                    end
                end
                if crossSubFileCount > 0 then
                    counts[tostring(resId)] = crossSubFileCount
                end
            end
            sub.crossSubFileCounts = counts
        end
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
        local fileToResIds = agency:GetFileToResIds() or {}
        local templates = _spm_getSubpackageTemplates(agency)
        if not templates and not subDict then _spm_sendError("get_structure", "SubPackage templates and item dict are nil"); return end

        -- 1) SubPackage.tab 是 Sub 关系权威；运行态表外实例追加为孤儿，且不反推 Res 关系。
        local subs = {}
        if templates then
            for key, template in pairs(templates) do
                local subId = template.Id or key
                local resIds = template.ResIds or {}
                local configuredResCount = 0
                local indexedResCount = 0
                for _, resId in pairs(resIds) do
                    if type(resId) == "number" and resId > 0 then
                        configuredResCount = configuredResCount + 1
                        if subIndexInfo and subIndexInfo[resId] then indexedResCount = indexedResCount + 1 end
                    end
                end
                subs[tostring(subId)] = {
                    name = template.Name or ("Sub_" .. tostring(subId)),
                    resIds = resIds,
                    configured = true,
                    instantiated = subDict and subDict[subId] ~= nil or false,
                    configuredResCount = configuredResCount,
                    indexedResCount = indexedResCount,
                    missingResCount = configuredResCount - indexedResCount
                }
            end
        elseif subDict then
            -- 兼容无法读取完整模板的旧分支。
            for subId, _ in pairs(subDict) do
                local template = nil
                pcall(function() template = agency:GetSubpackageTemplate(subId) end)
                subs[tostring(subId)] = {
                    name = (template and template.Name) or ("Sub_" .. tostring(subId)),
                    resIds = (template and template.ResIds) or {},
                    configured = template ~= nil,
                    instantiated = true
                }
            end
        end

        -- 只读字典，不调用 GetSubpackageItem，避免监控本身创建实例。
        if subDict then
            for subId, _ in pairs(subDict) do
                local key = tostring(subId)
                if not subs[key] then
                    subs[key] = {
                        name = "Sub_" .. key,
                        resIds = {},
                        configured = false,
                        instantiated = true,
                        configuredResCount = 0,
                        indexedResCount = 0,
                        missingResCount = 0
                    }
                end
            end
        end

        -- 2) Resource 取“配置、索引、实例”并集；三种来源独立标记。
        local resources = {}
        for subId, sub in pairs(subs) do
            for _, resId in pairs(sub.resIds or {}) do
                if type(resId) == "number" and resId > 0 then
                    local key = tostring(resId)
                    local fileDict = subIndexInfo and subIndexInfo[resId]
                    local resource = resources[key]
                    if not resource then
                        resource = {
                            subIds = {}, fileCount = _spm_fileCount(fileDict),
                            configured = true, indexed = fileDict ~= nil,
                            instantiated = resDict and resDict[resId] ~= nil or false
                        }
                        resources[key] = resource
                    end
                    _spm_addUniqueId(resource.subIds, tonumber(subId) or subId)
                end
            end
        end
        if subIndexInfo then
            for resId, fileDict in pairs(subIndexInfo) do
                local key = tostring(resId)
                if not resources[key] then
                    local subIds = {}
                    pcall(function() subIds = agency._Model:GetSubpackageIdByResId(resId) or {} end)
                    resources[key] = {
                        subIds = subIds, fileCount = _spm_fileCount(fileDict),
                        configured = false, indexed = true,
                        instantiated = resDict and resDict[resId] ~= nil or false
                    }
                end
            end
        end
        -- 只读字典，不调用 GetResourceItem，避免监控本身创建实例。
        if resDict then
            for resId, _ in pairs(resDict) do
                local key = tostring(resId)
                local resource = resources[key]
                if resource then
                    resource.instantiated = true
                else
                    local fileDict = subIndexInfo and subIndexInfo[resId]
                    resources[key] = {
                        subIds = {}, fileCount = _spm_fileCount(fileDict),
                        configured = false, indexed = fileDict ~= nil,
                        instantiated = true
                    }
                end
            end
        end

        _spm_buildCrossSubFileCounts(subs, subIndexInfo, fileToResIds)

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
        local fileToResIds = agency:GetFileToResIds() or {}

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
                local ownerResIds = fileToResIds[fileName]
                if ownerResIds and #ownerResIds > 1 then
                    sharedFiles[fileName] = {}
                    for _, ownerResId in ipairs(ownerResIds) do
                        sharedFiles[fileName][#sharedFiles[fileName] + 1] = ownerResId
                    end
                end
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

        -- 状态只返回真实实例；不要用未知状态预填配置项，否则前端无法识别“缺实例”。
        local subsStatus = {}
        if subDict then
            for subId, item in pairs(subDict) do
                local e = {}
                pcall(function() e.state = item:GetState() end)
                pcall(function() e.dlSize = item:GetDownloadSize() end)
                pcall(function() e.totalSize = item:GetTotalSize() end)
                pcall(function() e.progress = item:GetProgress() end)
                e.state = _spm_safeNumber(e.state, -1)
                e.dlSize = _spm_safeNumber(e.dlSize, 0)
                e.totalSize = _spm_safeNumber(e.totalSize, 0)
                e.progress = _spm_safeNumber(e.progress, 0)
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
                e.state = _spm_safeNumber(e.state, -1)
                e.tgState = _spm_safeNumber(e.tgState, -1)
                e.dlSize = _spm_safeNumber(e.dlSize, 0)
                e.totalSize = _spm_safeNumber(e.totalSize, 0)
                e.progress = _spm_safeNumber(e.progress, 0)
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
    LuaAvMonitor._pendingAudioEvents = {} -- 高频采集到的音频状态变化，随快照批量发送
    LuaAvMonitor._audioKnown       = nil  -- instance Id -> AudioInfo 快照
    LuaAvMonitor._audioKnownOrder  = nil
    LuaAvMonitor._audioEventSeq    = 0
    LuaAvMonitor._lastAudioPollTime = -9999
    LuaAvMonitor._audioPollInterval = 0.0 -- Update 每帧采集；短 UI 音效通常不足 1 秒
    LuaAvMonitor._isActive        = false -- 前端订阅时为 true，超时或 stop 命令后归 false
    LuaAvMonitor._lastActivateTime = -9999
    LuaAvMonitor._activeTimeout   = 30.0  -- 30s 内没有 start/snapshot 心跳则自动停止

    local function _av_sendResp(action, data, err)
        local pkt = { type = "AV_MONITOR_RESP", action = action }
        if err then pkt.error = err else pkt.data = data end
        RuntimeGMClient.Send(pkt)
    end

    -- 控制命令必须把客户端侧异常回传给 Web。旧实现逐个 pcall 后丢弃错误，
    -- 即使 API 已改名，页面仍会表现成“点击成功但游戏没有反应”。
    local function _av_runCommand(action, callback)
        local ok, result = pcall(callback)
        if not ok then
            _av_sendResp(action, nil, tostring(result))
            return false
        end
        if result == false then
            _av_sendResp(action, nil, action .. " returned false")
            return false
        end
        if result == nil then
            result = { ok = true }
        elseif type(result) ~= "table" then
            result = { ok = true, result = result }
        elseif result.ok == nil then
            result.ok = true
        end
        _av_sendResp(action, result)
        return true
    end

    -- 对齐 XAudioManager.InitCriGameObject 中持有的独立 CriAtomSource。
    -- AnalyzerSource 与 MusicSource 指向同一个组件，不重复暴露第二个控制项。
    local function _av_getAudioSource(sourceName)
        local manager = CS.XAudioManager
        if     sourceName == "default"         then return manager.DefaultSource
        elseif sourceName == "ambient"         then return manager.AmbientSource
        elseif sourceName == "music"           then return manager.MusicSource
        elseif sourceName == "voice"           then return manager.VoiceSource
        elseif sourceName == "lipsShape"       then return manager.LipsShapeSource
        elseif sourceName == "gameplaySpecial" then return manager.GamePlaySpecialSource
        end
        return nil
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

    local function _av_audioEntry(info, fallbackId)
        if not info then return nil end
        local entry = {
            id       = info.Id or fallbackId,
            cueId    = info.CueId,
            name     = info.CueName or tostring(info.CueId),
            playType = "Unknown",
            acbPath  = info.AcbFile,
            awbPath  = info.AwbFile,
            status   = "Unknown",
            volume   = 1.0,
        }
        if info.Pausing then entry.status = "Paused"
        elseif info.Playing then entry.status = "Playing" end
        pcall(function()
            if info.CueTemplate then
                local rawPlayType = tonumber(info.CueTemplate.PlayType)
                local playTypeNames = { [1] = "Music", [2] = "SFX", [4] = "Voice" }
                entry.playType = playTypeNames[rawPlayType] or tostring(info.CueTemplate.PlayType)
            end
        end)
        pcall(function()
            entry.volume = info.Source and info.Source.volume or 1.0
        end)
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
        return entry
    end

    local function _av_audioEventEnabled(action)
        local enabled = false
        pcall(function()
            if not CS.XAudioManager.IsLogCollect then return end
            if action == "Play" then
                enabled = CS.XAudioManager.IsAudioPlayLogInConsole and true or false
            else
                enabled = CS.XAudioManager.IsAudioStopLogInConsole and true or false
            end
        end)
        return enabled
    end

    local function _av_queueAudioEvent(action, entry)
        if not entry or not _av_audioEventEnabled(action) then return end
        LuaAvMonitor._audioEventSeq = LuaAvMonitor._audioEventSeq + 1
        local events = LuaAvMonitor._pendingAudioEvents
        events[#events + 1] = {
            seq        = LuaAvMonitor._audioEventSeq,
            time       = _av_fmtClock(),
            action     = action,
            instanceId = entry.id,
            cueId      = entry.cueId,
            name       = entry.name,
            playType   = entry.playType,
            sourceName = entry.sourceName,
        }
        -- 页面最多保留 500 条；断网时也限制客户端队列，避免无限增长。
        if #events > 500 then table.remove(events, 1) end
    end

    -- 不能依赖低频 snapshot 比较：常见 UI 音效不足 1 秒，2 秒采样必然漏掉。
    -- 这里在 AV Monitor 激活期间按 AudioInfo.Id（播放实例唯一 Id）追踪状态变化。
    local function _av_captureAudioTransitions(now)
        if now - LuaAvMonitor._lastAudioPollTime < LuaAvMonitor._audioPollInterval then return end
        LuaAvMonitor._lastAudioPollTime = now

        local ok, list = pcall(function() return CS.XAudioManager.GetAudioInfoList() end)
        if not ok or not list then return end

        local previous = LuaAvMonitor._audioKnown
        local current = {}
        local currentOrder = {}
        for i = 0, list.Count - 1 do
            local info = list[i]
            if info then
                -- 每帧只跨 Lua/C# 边界读取实例 Id；完整详情只在新实例出现时构造。
                local instanceId = info.Id
                local key = tostring(instanceId or i)
                -- 极旧客户端若没有实例 Id，仍避免同 Cue 并发时互相覆盖。
                if current[key] then key = key .. ":" .. tostring(i) end
                local entry = previous and previous[key] or nil
                if not entry then entry = _av_audioEntry(info, i) end
                current[key] = entry
                currentOrder[#currentOrder + 1] = key
            end
        end

        if previous then
            for _, key in ipairs(currentOrder) do
                if not previous[key] then _av_queueAudioEvent("Play", current[key]) end
            end
            for _, key in ipairs(LuaAvMonitor._audioKnownOrder or {}) do
                if not current[key] then _av_queueAudioEvent("Stop", previous[key]) end
            end
        end
        LuaAvMonitor._audioKnown = current
        LuaAvMonitor._audioKnownOrder = currentOrder
    end

    -- 收集音频快照
    local function _av_collectAudio()
        local audio = {}
        pcall(function()
            -- BGM 信息。AudioInfo.Id 是播放实例 Id，真实 Cue 必须读取 CueId/CueName。
            local bgm = {}
            pcall(function()
                local info = nil
                local luaAudioManager = rawget(_G, "XLuaAudioManager")
                if luaAudioManager and type(luaAudioManager.GetCurrentMusicAudioInfo) == "function" then
                    local ok, current = pcall(luaAudioManager.GetCurrentMusicAudioInfo)
                    if ok then info = current end
                end
                if not info then info = CS.XAudioManager.CurrentMusicAudioInfo1 end
                if info then
                    bgm = _av_audioEntry(info, nil) or {}
                    bgm.instanceId = bgm.id
                    bgm.id = nil
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
                local sourceNames = {
                    "music", "default", "ambient", "voice", "lipsShape", "gameplaySpecial",
                }
                for _, sourceName in ipairs(sourceNames) do
                    local source = _av_getAudioSource(sourceName)
                    if source then vols.source[sourceName] = source.volume end
                end
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
                    local ok, res = pcall(function() return CS.XAudioManager.GetIsMuteAisacByPlayType(v) end)
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
                            activeList[#activeList + 1] = _av_audioEntry(info, i)
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
        -- eventStream 告诉新版前端不要再用低频列表差分推断日志。
        audio.eventStream = true
        audio.events = LuaAvMonitor._pendingAudioEvents
        LuaAvMonitor._pendingAudioEvents = {}
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
            LuaAvMonitor._audioKnown = nil
            LuaAvMonitor._audioKnownOrder = nil
            return
        end
        _av_captureAudioTransitions(now)
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
            LuaAvMonitor._lastAudioPollTime = -9999
            LuaAvMonitor._audioKnown = nil
            LuaAvMonitor._audioKnownOrder = nil
            LuaAvMonitor._pendingAudioEvents = {}

        elseif action == "stop" then
            LuaAvMonitor._isActive = false
            LuaAvMonitor._audioKnown = nil
            LuaAvMonitor._audioKnownOrder = nil
            LuaAvMonitor._pendingAudioEvents = {}

        elseif action == "snapshot" then
            -- 激活 + 强制立即推送
            LuaAvMonitor._isActive = true
            LuaAvMonitor._lastPushTime = -9999

        elseif action == "set_volume" then
            local cat = packet.category
            local val = tonumber(packet.value)
            _av_runCommand(action, function()
                if not val or val < 0 or val > 1 then error("volume must be between 0 and 1") end
                if     cat == "music" then CS.XAudioManager.ChangeMusicVolume(val)
                elseif cat == "sfx"   then CS.XAudioManager.ChangeSFXVolume(val)
                elseif cat == "cv" or cat == "voice" then CS.XAudioManager.ChangeVoiceVolume(val)
                else error("unknown audio category: " .. tostring(cat)) end
                return { category = cat, value = val }
            end)

        elseif action == "set_second_volume" then
            local cat = packet.category
            local val = tonumber(packet.value)
            _av_runCommand(action, function()
                if not val or val < 0 or val > 1 then error("second volume must be between 0 and 1") end
                if     cat == "music" then CS.XAudioManager.ChangeMusicVolumeSecond(val)
                elseif cat == "sfx"   then CS.XAudioManager.ChangeSFXVolumeSecond(val)
                elseif cat == "voice" or cat == "cv" then CS.XAudioManager.ChangeVoiceVolumeSecond(val)
                else error("unknown second-volume category: " .. tostring(cat)) end
                return { category = cat, value = val }
            end)

        elseif action == "set_source_volume" then
            local sourceName = packet.source
            local val = tonumber(packet.value)
            _av_runCommand(action, function()
                if not val or val < 0 or val > 1 then error("source volume must be between 0 and 1") end
                local source = _av_getAudioSource(sourceName)
                if not source then error("unknown or unavailable CriAtomSource: " .. tostring(sourceName)) end
                source.volume = val
                return { source = sourceName, value = val }
            end)

        elseif action == "set_master_mute" then
            local enabled = packet.enabled and true or false
            _av_runCommand(action, function()
                CS.XAudioManager.Mute(enabled)
                return { enabled = enabled }
            end)

        elseif action == "set_aisac_mute" then
            local playType = tostring(packet.playType or ""):lower()
            local enabled = packet.enabled and true or false
            _av_runCommand(action, function()
                local pt = CS.XAudioManager.PlayType
                local playTypes = {
                    music = pt.Music,
                    sfx = pt.SFX,
                    voice = pt.Voice,
                    cv = pt.Voice,
                }
                local value = playTypes[playType]
                if value == nil then error("unknown play type: " .. tostring(packet.playType)) end
                CS.XAudioManager.MuteAisacByPlayType(value, enabled)
                return { playType = playType, enabled = enabled }
            end)

        elseif action == "query_cue" then
            local cueId = tonumber(packet.cueId)
            if not cueId then _av_sendResp("query_cue", nil, "invalid cueId"); return end
            local result
            local ok, err = pcall(function()
                local cue = CS.XAudioManager.GetCueTemplate(cueId)
                if cue then
                    local rawPlayType = tonumber(cue.PlayType)
                    local playTypeNames = { [1] = "Music", [2] = "SFX", [4] = "Voice" }
                    local sheet = CS.XAudioManager.GetCueSheetTemplate(cue.CueSheetId)
                    result = {
                        cueId         = cueId,
                        cueName       = cue.CueName,
                        playType      = playTypeNames[rawPlayType] or tostring(cue.PlayType),
                        playTypeValue = rawPlayType,
                        durationMs    = cue.Duration,
                        cueSheetId    = cue.CueSheetId,
                    }
                    if sheet then
                        result.acbPath = sheet.CueSheetName
                        result.awbPath = sheet.HasAwb and sheet.CueAwb or ""
                        result.hasAwb = sheet.HasAwb and true or false
                    end
                end
            end)
            if not ok then _av_sendResp("query_cue", nil, tostring(err))
            elseif not result then _av_sendResp("query_cue", nil, "CueId " .. cueId .. " not found")
            else _av_sendResp("query_cue", result) end
            return

        elseif action == "set_debug_flag" then
            local flag, en = packet.flag, packet.enabled
            local applied = _av_runCommand(action, function()
                if     flag == "logCollect"   then CS.XAudioManager.IsLogCollect                = en
                elseif flag == "playLog"      then CS.XAudioManager.IsAudioPlayLogInConsole     = en
                elseif flag == "stopLog"      then CS.XAudioManager.IsAudioStopLogInConsole     = en
                elseif flag == "componentLog" then CS.XAudioManager.IsComponentLogInConsole     = en
                elseif flag == "selectorLog"  then CS.XAudioManager.IsSelectorLogInConsole      = en
                elseif flag == "aisacLog"     then CS.XAudioManager.IsAisacLogInConsole         = en
                else error("unknown debug flag: " .. tostring(flag)) end
                return { flag = flag, enabled = en and true or false }
            end)
            if applied then
                -- 切换采集开关后以当前列表为新基线，避免补出开关前的伪 Play/Stop。
                LuaAvMonitor._audioKnown = nil
                LuaAvMonitor._audioKnownOrder = nil
                LuaAvMonitor._lastAudioPollTime = -9999
            end

        elseif action == "play_bgm" then
            _av_runCommand(action, function()
                local cueId = tonumber(packet.cueId)
                if not cueId then error("play_bgm requires cueId") end
                local audioManager = rawget(_G, "XLuaAudioManager")
                if not audioManager or type(audioManager.PlayAudioByType) ~= "function" then
                    error("XLuaAudioManager.PlayAudioByType is unavailable")
                end
                local musicType = audioManager.SoundType and audioManager.SoundType.Music
                if musicType == nil then error("XLuaAudioManager.SoundType.Music is unavailable") end
                audioManager.PlayAudioByType(musicType, cueId)
                return { cueId = cueId }
            end)

        elseif action == "play_cue" then
            _av_runCommand(action, function()
                local cid = tonumber(packet.cueId)
                if not cid then error("play_cue requires cueId") end
                local tpl = CS.XAudioManager.GetCueTemplate(cid)
                if not tpl then error("CueId " .. cid .. " not found") end
                local audioManager = rawget(_G, "XLuaAudioManager")
                if not audioManager or type(audioManager.PlayAudioByType) ~= "function" then
                    error("XLuaAudioManager.PlayAudioByType is unavailable")
                end
                audioManager.PlayAudioByType(tpl.PlayType, cid)
                return { cueId = cid, playType = tonumber(tpl.PlayType) }
            end)

        elseif action == "stop_bgm" then
            _av_runCommand(action, function() CS.XAudioManager.StopMusic() end)

        elseif action == "reload_sound" then
            _av_runCommand(action, function() return CS.XAudioManager.InitConfig() end)

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

        -- Bytes/Pack 模式下 XMain 会刻意保留空 XTable；Table Viewer 需要按需加载客户端自带的 Schema。
        if type(XTable) ~= "table" or not next(XTable) then
            local ok, err = pcall(require, "XCommon/XTable")
            if not ok then
                origin_print("[RuntimeGM] TableMonitor: load runtime XTable failed: " .. tostring(err))
                return
            end
        end

        -- 直接从客户端运行时路由器枚举当前可用的表。
        -- GetPaths 已经统一了 Tab/Bytes/Pack 及热更路径，不依赖 EncyHub 本地 HaruRoot。
        local candidates = {}
        local function addCandidate(tableName, relPath)
            if not candidates[tableName] then candidates[tableName] = {} end
            for _, item in ipairs(candidates[tableName]) do
                if item.path == relPath then return end
            end
            candidates[tableName][#candidates[tableName] + 1] = { path = relPath }
        end

        local function addPath(relPath)
            relPath = tostring(relPath):gsub("\\", "/"):gsub("^%s+", ""):gsub("%s+$", "")
            if string.lower(relPath:sub(-4)) ~= ".tab" then return end
            local fileName = relPath:match("([^/]+)%.tab$")
            if not fileName then return end
            local candidateNames = { "XTable" .. fileName, fileName }
            for _, candidate in ipairs(candidateNames) do
                if XTable[candidate] then
                    addCandidate(candidate, relPath)
                end
            end
        end

        local function scoreCandidate(item, xTableDef)
            if not item or not item.path or not xTableDef then return 0 end

            local header
            local ok = pcall(function()
                local fullPath = CS.XTableManager.GetFullPath(item.path)
                local sr = CS.System.IO.File.OpenText(fullPath)
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

        for _, scope in ipairs({ "Share", "Client" }) do
            local ok, paths = pcall(function() return CS.XTableManager.GetPaths(scope) end)
            if ok and paths then
                local count = 0
                pcall(function() count = paths.Count or paths.Length or 0 end)
                for i = 0, count - 1 do
                    addPath(paths[i])
                end
            else
                origin_print("[RuntimeGM] TableMonitor: GetPaths failed for " .. scope .. ": " .. tostring(paths))
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

    function LuaTableMonitor.HandleListTables(packet)
        LuaTableMonitor._pathCache = nil
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
                if not ok1 then va = nil end
                if not ok2 then vb = nil end
                if va == nil and vb == nil then return tostring(a) < tostring(b) end
                if va == nil then return sortDir == "desc" end
                if vb == nil then return sortDir ~= "desc" end

                local typeA, typeB = type(va), type(vb)
                local compareA, compareB
                if typeA == typeB and (typeA == "number" or typeA == "string") then
                    compareA, compareB = va, vb
                elseif typeA == "boolean" and typeB == "boolean" then
                    compareA, compareB = va and 1 or 0, vb and 1 or 0
                else
                    compareA, compareB = tostring(va), tostring(vb)
                end
                if compareA == compareB then return tostring(a) < tostring(b) end
                if sortDir == "desc" then return compareA > compareB else return compareA < compareB end
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
            LuaTableMonitor.HandleListTables(packet)
        elseif action == "get_schema" then
            LuaTableMonitor.HandleGetSchema(packet.tableName)
        elseif action == "get_data" then
            LuaTableMonitor.HandleGetData(packet)
        else
            _tm_sendResp(action or "unknown", nil, "unknown action: " .. tostring(action))
        end
    end

    LuaTableMonitor.Init()

    -- ========== LuaGameLogTail: 游戏物理日志 tail ==========
    -- 只在 Web 端打开“游戏端日志”时启动；读取真实日志文件，不截获 print/write 调用。
    LuaGameLogTail._isActive = false
    LuaGameLogTail._path = nil
    LuaGameLogTail._dir = nil
    LuaGameLogTail._offset = 0
    LuaGameLogTail._lastFileSize = 0
    LuaGameLogTail._seq = 0
    LuaGameLogTail._lastPoll = 0
    LuaGameLogTail._pollInterval = 0.3
    LuaGameLogTail._bootstrapBytes = 0
    LuaGameLogTail._maxEntries = 2000
    LuaGameLogTail._readChunkBytes = 64 * 1024
    LuaGameLogTail._sendChunkBytes = 512 * 1024
    LuaGameLogTail._sendChunkEntries = 100
    LuaGameLogTail._partialLine = ""
    LuaGameLogTail._currentLines = {}
    LuaGameLogTail._accepting = false
    LuaGameLogTail._lastMetaPath = nil
    LuaGameLogTail._lastSendEntries = 0
    LuaGameLogTail._lastSendChunks = 0

    local function _glt_toNumber(v, fallback)
        local n = tonumber(tostring(v))
        if n == nil then return fallback or 0 end
        return n
    end

    local function _glt_normPath(path)
        if not path then return "" end
        return tostring(path):gsub("\\", "/"):gsub("/+$", "")
    end

    local function _glt_parent(path)
        path = _glt_normPath(path)
        return path:match("^(.+)/[^/]+$") or ""
    end

    local function _glt_dirExists(path)
        if not path or path == "" then return false end
        local ok, exists = pcall(function()
            return CS.System.IO.Directory.Exists(path)
        end)
        return ok and exists
    end

    local function _glt_fileExists(path)
        if not path or path == "" then return false end
        local ok, exists = pcall(function()
            return CS.System.IO.File.Exists(path)
        end)
        return ok and exists
    end

    local function _glt_findSvnRoot(startPath)
        local path = _glt_normPath(startPath)
        for _ = 1, 12 do
            if path == "" then return nil end
            if _glt_dirExists(path .. "/.svn") then return path end
            local parent = _glt_parent(path)
            if parent == "" or parent == path then return nil end
            path = parent
        end
        return nil
    end

    local function _glt_getPlatform()
        local platform = "Unknown"
        pcall(function() platform = CS.UnityEngine.Application.platform:ToString() end)
        return tostring(platform)
    end

    local function _glt_resolveLogDir()
        local platform = _glt_getPlatform()
        local dataPath = ""
        local persistentDataPath = ""
        pcall(function() dataPath = _glt_normPath(CS.UnityEngine.Application.dataPath) end)
        pcall(function() persistentDataPath = _glt_normPath(CS.UnityEngine.Application.persistentDataPath) end)

        local candidates = {}
        local function add(path)
            path = _glt_normPath(path)
            if path == "" then return end
            for _, existing in ipairs(candidates) do
                if existing == path then return end
            end
            candidates[#candidates + 1] = path
        end

        if platform == "Android" or platform == "IPhonePlayer" then
            add(persistentDataPath .. "/log")
            add(persistentDataPath .. "/Log")
        elseif platform == "WindowsEditor" or platform == "OSXEditor" then
            local root = dataPath:match("^(.*)/Dev/Client/Assets$")
            if root then add(root .. "/Dev/Client/Log") end
            local svnRoot = _glt_findSvnRoot(dataPath)
            if svnRoot then add(svnRoot .. "/Dev/Client/Log") end
            add(_glt_parent(dataPath) .. "/Log")
        else
            local exeDir = _glt_parent(dataPath)
            add(exeDir .. "/Log")
            local svnRoot = _glt_findSvnRoot(dataPath)
            if svnRoot then add(svnRoot .. "/Product/Bin/Client/Win/Debug/Log") end
            add(persistentDataPath .. "/log")
            add(persistentDataPath .. "/Log")
        end

        for _, dir in ipairs(candidates) do
            if _glt_dirExists(dir) then
                return dir, platform
            end
        end
        return nil, platform
    end

    local function _glt_getFileSize(path)
        local ok, size = pcall(function()
            return CS.System.IO.FileInfo(path).Length
        end)
        if not ok then return 0 end
        return _glt_toNumber(size, 0)
    end

    local function _glt_getWriteTicks(path)
        local ok, ticks = pcall(function()
            return CS.System.IO.File.GetLastWriteTime(path).Ticks
        end)
        if not ok then return 0 end
        return _glt_toNumber(ticks, 0)
    end

    local function _glt_findLatestLogFile(dir)
        if not _glt_dirExists(dir) then return nil end
        local ok, files = pcall(function()
            return CS.System.IO.Directory.GetFiles(dir, "*.log")
        end)
        if not ok or not files or files.Length == 0 then return nil end

        local latest = nil
        local latestTicks = -1
        for i = 0, files.Length - 1 do
            local path = _glt_normPath(files[i])
            local ticks = _glt_getWriteTicks(path)
            if ticks > latestTicks then
                latest = path
                latestTicks = ticks
            end
        end
        return latest
    end

    local function _glt_readRange(path, offset, maxBytes)
        -- Android 的 xLua 对 FileStream + Byte[] 大段读取偶发不稳定；ReadAllText 在当前项目环境更稳。
        -- 这里仍按 offset/maxBytes 只把需要展示的窗口喂给解析器，外层通过 FileInfo.Length 变化控制轮询频率。
        local ok, textOrErr = pcall(function()
            return tostring(CS.System.IO.File.ReadAllText(path))
        end)
        if not ok then error(textOrErr) end

        local text = textOrErr or ""
        local length = #text
        local startOffset = math.max(0, math.floor(offset or 0))
        local window = math.max(1, math.floor(maxBytes or LuaGameLogTail._readChunkBytes))
        if startOffset > length then
            startOffset = math.max(0, length - window)
        end
        if length <= startOffset then return "", 0, length, startOffset end
        local endOffset = math.min(length, startOffset + window)
        return text:sub(startOffset + 1, endOffset), endOffset - startOffset, length, startOffset
    end

    local function _glt_sendStatus(state, err)
        local path = LuaGameLogTail._path
        RuntimeGMClient.Send({
            type = "GAME_LOG_STATUS",
            state = state,
            error = err or "",
            path = path or "",
            offset = LuaGameLogTail._offset or 0,
            fileSize = path and _glt_getFileSize(path) or 0,
            lastFileSize = LuaGameLogTail._lastFileSize or 0,
            seq = LuaGameLogTail._seq or 0,
            active = LuaGameLogTail._isActive and true or false,
            partialBytes = #(LuaGameLogTail._partialLine or ""),
            lastSendEntries = LuaGameLogTail._lastSendEntries or 0,
            lastSendChunks = LuaGameLogTail._lastSendChunks or 0
        })
    end

    local function _glt_sendMeta()
        local path = LuaGameLogTail._path
        RuntimeGMClient.Send({
            type = "GAME_LOG_META",
            path = path or "",
            dir = LuaGameLogTail._dir or "",
            platform = _glt_getPlatform(),
            fileSize = path and _glt_getFileSize(path) or 0,
            offset = LuaGameLogTail._offset or 0,
            seq = LuaGameLogTail._seq or 0
        })
    end

    local function _glt_levelFromHeader(header)
        local raw = tostring(header or ""):match("^<([^>]+)>") or "Log"
        raw = raw:lower()
        if raw:find("error") or raw:find("exception") or raw:find("assert") then return "error" end
        if raw:find("warn") then return "warn" end
        return "info"
    end

    local function _glt_timeFromHeader(header)
        header = tostring(header or "")
        return header:match("%[(%d%d%d%d/%d%d/%d%d%s+%d%d:%d%d:%d%d%.%d+)%]")
            or header:match("%[(%d%d%d%d%-%d%d%-%d%d%s+%d%d:%d%d:%d%d[^%]]*)%]")
            or ""
    end

    local function _glt_submitCurrent(entries)
        local lines = LuaGameLogTail._currentLines
        if not lines or #lines == 0 then return end

        local first = 1
        local last = #lines
        while first <= last and tostring(lines[first]):match("^%s*$") do first = first + 1 end
        while last >= first and tostring(lines[last]):match("^%s*$") do last = last - 1 end
        if first > last then
            LuaGameLogTail._currentLines = {}
            return
        end

        local out = {}
        local header = ""
        for i = first, last do
            local line = tostring(lines[i])
            out[#out + 1] = line
            if header == "" and not line:match("^%s*$") then header = line end
        end

        LuaGameLogTail._seq = LuaGameLogTail._seq + 1
        entries[#entries + 1] = {
            seq = LuaGameLogTail._seq,
            level = _glt_levelFromHeader(header),
            time = _glt_timeFromHeader(header),
            header = header,
            text = table.concat(out, "\n"),
            fileOffset = LuaGameLogTail._offset or 0
        }
        LuaGameLogTail._currentLines = {}
    end

    local function _glt_feedText(text, entries, flushTail)
        if not text or text == "" then return end
        text = tostring(text):gsub("\r\n", "\n"):gsub("\r", "\n")
        local data = (LuaGameLogTail._partialLine or "") .. text
        local start = 1

        while true do
            local nl = data:find("\n", start, true)
            if not nl then break end
            local line = data:sub(start, nl - 1)
            if line:match("^=+$") and #line >= 16 then
                if LuaGameLogTail._accepting then
                    _glt_submitCurrent(entries)
                else
                    LuaGameLogTail._accepting = true
                    LuaGameLogTail._currentLines = {}
                end
            elseif LuaGameLogTail._accepting then
                LuaGameLogTail._currentLines[#LuaGameLogTail._currentLines + 1] = line
            end
            start = nl + 1
        end

        LuaGameLogTail._partialLine = data:sub(start)
        if flushTail and LuaGameLogTail._partialLine ~= "" and LuaGameLogTail._accepting then
            LuaGameLogTail._currentLines[#LuaGameLogTail._currentLines + 1] = LuaGameLogTail._partialLine
            LuaGameLogTail._partialLine = ""
        end
        if flushTail then
            _glt_submitCurrent(entries)
        end
    end

    local function _glt_sendEntries(entries)
        if not entries or #entries == 0 then return end
        if #entries > LuaGameLogTail._maxEntries then
            local trimmed = {}
            for i = #entries - LuaGameLogTail._maxEntries + 1, #entries do
                trimmed[#trimmed + 1] = entries[i]
            end
            entries = trimmed
        end

        local chunk = {}
        local chunkBytes = 0
        local chunkCount = 0
        local sentEntries = 0
        local sentChunks = 0
        local maxBytes = math.max(4096, tonumber(LuaGameLogTail._sendChunkBytes) or 524288)
        local maxEntries = math.max(1, tonumber(LuaGameLogTail._sendChunkEntries) or 100)

        local function estimateEntryBytes(entry)
            if not entry then return 128 end
            local text = tostring(entry.text or "")
            local header = tostring(entry.header or "")
            local time = tostring(entry.time or "")
            return #text + #header + #time + 256
        end

        local function flushChunk()
            if chunkCount <= 0 then return end
            RuntimeGMClient.Send({ type = "GAME_LOG_ENTRIES", entries = chunk }, 5.0)
            sentEntries = sentEntries + chunkCount
            sentChunks = sentChunks + 1
            chunk = {}
            chunkBytes = 0
            chunkCount = 0
        end

        for _, entry in ipairs(entries) do
            local entryBytes = estimateEntryBytes(entry)
            if chunkCount > 0 and (chunkBytes + entryBytes > maxBytes or chunkCount >= maxEntries) then
                flushChunk()
            end
            chunk[#chunk + 1] = entry
            chunkBytes = chunkBytes + entryBytes
            chunkCount = chunkCount + 1
        end
        flushChunk()
        LuaGameLogTail._lastSendEntries = sentEntries
        LuaGameLogTail._lastSendChunks = sentChunks
    end

    function LuaGameLogTail._bootstrap()
        local dir, platform = _glt_resolveLogDir()
        if not dir then
            _glt_sendStatus("error", "未找到日志目录: " .. tostring(platform))
            return false
        end

        local path = _glt_findLatestLogFile(dir)
        if not path then
            LuaGameLogTail._dir = dir
            _glt_sendMeta()
            _glt_sendStatus("waiting", "日志目录存在，但没有 .log 文件")
            return false
        end

        LuaGameLogTail._dir = dir
        LuaGameLogTail._path = path
        LuaGameLogTail._offset = math.max(0, _glt_getFileSize(path) - LuaGameLogTail._bootstrapBytes)
        LuaGameLogTail._lastFileSize = _glt_getFileSize(path)
        LuaGameLogTail._partialLine = ""
        LuaGameLogTail._currentLines = {}
        LuaGameLogTail._accepting = LuaGameLogTail._bootstrapBytes <= 0 or LuaGameLogTail._offset == 0
        LuaGameLogTail._lastMetaPath = path

        _glt_sendMeta()

        local entries = {}
        while _glt_fileExists(path) do
            local text, read, length, actualOffset = _glt_readRange(path, LuaGameLogTail._offset, LuaGameLogTail._readChunkBytes)
            if read <= 0 then break end
            LuaGameLogTail._offset = actualOffset + read
            _glt_feedText(text, entries, LuaGameLogTail._offset >= length)
            if LuaGameLogTail._offset >= length then break end
        end
        _glt_sendEntries(entries)
        _glt_sendStatus("running", "")
        return true
    end

    function LuaGameLogTail.Start(packet)
        LuaGameLogTail._bootstrapBytes = tonumber(packet.bootstrapBytes) or LuaGameLogTail._bootstrapBytes
        LuaGameLogTail._maxEntries = tonumber(packet.maxEntries) or LuaGameLogTail._maxEntries
        LuaGameLogTail._pollInterval = math.max(0.1, (tonumber(packet.pollIntervalMs) or 300) / 1000)
        LuaGameLogTail._readChunkBytes = math.max(4096, tonumber(packet.readChunkBytes) or LuaGameLogTail._readChunkBytes)
        LuaGameLogTail._sendChunkBytes = math.max(4096, tonumber(packet.sendChunkBytes) or LuaGameLogTail._sendChunkBytes)
        LuaGameLogTail._sendChunkEntries = math.max(1, tonumber(packet.sendChunkEntries) or LuaGameLogTail._sendChunkEntries)
        LuaGameLogTail._isActive = true
        LuaGameLogTail._lastPoll = 0
        local ok, err = pcall(LuaGameLogTail._bootstrap)
        if not ok then
            LuaGameLogTail._isActive = false
            _glt_sendStatus("error", tostring(err))
        end
    end

    function LuaGameLogTail.Stop()
        LuaGameLogTail._isActive = false
        _glt_sendStatus("stopped", "")
    end

    function LuaGameLogTail.Update()
        if not LuaGameLogTail._isActive then return end
        local okNow, now = pcall(function() return CS.UnityEngine.Time.realtimeSinceStartup end)
        if not okNow then return end
        if now - LuaGameLogTail._lastPoll < LuaGameLogTail._pollInterval then return end
        LuaGameLogTail._lastPoll = now

        if not LuaGameLogTail._path or not _glt_fileExists(LuaGameLogTail._path) then
            pcall(LuaGameLogTail._bootstrap)
            return
        end

        local latest = _glt_findLatestLogFile(LuaGameLogTail._dir)
        if latest and latest ~= LuaGameLogTail._path then
            pcall(LuaGameLogTail._bootstrap)
            return
        end

        local byteLength = _glt_getFileSize(LuaGameLogTail._path)
        if LuaGameLogTail._lastFileSize > 0 and byteLength < LuaGameLogTail._lastFileSize then
            pcall(LuaGameLogTail._bootstrap)
            return
        end
        if byteLength == LuaGameLogTail._lastFileSize then return end

        local entries = {}
        while _glt_fileExists(LuaGameLogTail._path) do
            local text, read, fileLength, actualOffset = _glt_readRange(
                LuaGameLogTail._path,
                LuaGameLogTail._offset,
                LuaGameLogTail._readChunkBytes
            )
            if read <= 0 then break end
            LuaGameLogTail._offset = actualOffset + read
            _glt_feedText(text, entries, LuaGameLogTail._offset >= fileLength)
            if LuaGameLogTail._offset >= fileLength then break end
        end
        LuaGameLogTail._lastFileSize = byteLength
        _glt_sendEntries(entries)
    end

    function LuaGameLogTail.HandleCommand(packet)
        local action = packet.action
        if action == "start" then
            LuaGameLogTail.Start(packet)
        elseif action == "stop" then
            LuaGameLogTail.Stop()
        else
            _glt_sendStatus("error", "unknown action: " .. tostring(action))
        end
    end

    RuntimeGMClient.LuaGameLogTail = LuaGameLogTail

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
        if packet.type == "HIERARCHY"
            and packet.action == "locate"
            and packet.uiName
            and packet.uiName ~= ""
            and (packet.path == nil or packet.path == "") then
            packet.path = "GameObject"
        end
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
                _tm_sendResp(packet.action or "unknown", nil, "command failed: " .. tostring(err))
            end
        elseif type == "GAME_LOG" then
            local ok, err = pcall(LuaGameLogTail.HandleCommand, packet)
            if not ok then
                origin_print("[RuntimeGM] GAME_LOG command error: " .. tostring(err))
            end
        elseif type == "SCREENSHOT" then
            pcall(function()
                local w = CS.UnityEngine.Screen.width
                local h = CS.UnityEngine.Screen.height
                origin_print("[RuntimeGM] SCREENSHOT: start " .. w .. "x" .. h)
                local tex = nil

                -- 方案1: CaptureScreenshotAsTexture (Windows/Editor xLua 导出)
                local ok1, tex1 = pcall(function()
                    return CS.UnityEngine.ScreenCapture.CaptureScreenshotAsTexture()
                end)
                if ok1 and tex1 then
                    tex = tex1
                    origin_print("[RuntimeGM] SCREENSHOT: CaptureAsTexture ok")
                else
                    -- 方案2: ReadPixels 从屏幕缓冲区
                    -- 注意：ReadPixels 在渲染帧外调用会有 Unity warning，但仍能获取截图数据
                    CS.UnityEngine.RenderTexture.active = nil
                    tex = CS.UnityEngine.Texture2D(w, h, CS.UnityEngine.TextureFormat.RGB24, false)
                    pcall(function()
                        tex:ReadPixels(CS.UnityEngine.Rect(0, 0, w, h), 0, 0)
                    end)
                    tex:Apply()
                    origin_print("[RuntimeGM] SCREENSHOT: ReadPixels fallback")
                end

                if tex then
                    local jpgStr = tex:EncodeToJPG(60)
                    CS.UnityEngine.Object.Destroy(tex)
                    origin_print("[RuntimeGM] SCREENSHOT: EncodeToJPG size=" .. tostring(jpgStr and #jpgStr or 0))
                    if jpgStr and #jpgStr > 0 then
                        -- 大包分片发送：每片 256KB base64
                        local base64 = CS.System.Convert.ToBase64String(jpgStr)
                        local b64len = #base64
                        local PART = 256 * 1024
                        local totalParts = math.ceil(b64len / PART)
                        origin_print("[RuntimeGM] SCREENSHOT: base64 size=" .. b64len .. " parts=" .. totalParts)
                        for i = 1, totalParts do
                            local s = (i - 1) * PART + 1
                            local e = math.min(i * PART, b64len)
                            local chunk = base64:sub(s, e)
                            RuntimeGMClient.Send({
                                type = "SCREENSHOT_RESP",
                                image = chunk,
                                width = w,
                                height = h,
                                part = i,
                                totalParts = totalParts
                            })
                        end
                        origin_print("[RuntimeGM] SCREENSHOT: all parts sent")
                    else
                        origin_print("[RuntimeGM] SCREENSHOT: EncodeToJPG returned empty")
                    end
                else
                    origin_print("[RuntimeGM] SCREENSHOT: no texture")
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
        local oldGo = CS.UnityEngine.GameObject.Find(goName)
        if oldGo then
            -- Launch 模块更新会重建 Lua 环境，但 DontDestroyOnLoad 的 Updater 仍在。
            -- 先销毁旧 Updater，让旧 LuaOnDestroy 主动关闭 Socket，避免新旧客户端短暂并存互踢。
            CS.UnityEngine.Object.Destroy(oldGo)
        end
        local go = CS.UnityEngine.GameObject(goName)
        CS.UnityEngine.Object.DontDestroyOnLoad(go)
        local behaviour = go:GetComponent(typeof(CS.XLuaBehaviour))
        if not behaviour then behaviour = go:AddComponent(typeof(CS.XLuaBehaviour)) end
        local startDelayFrames = oldGo and 2 or 0
        behaviour.LuaUpdate = function()
            if startDelayFrames > 0 then
                startDelayFrames = startDelayFrames - 1
                return
            end
            RuntimeGMClient.Update()
        end
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
