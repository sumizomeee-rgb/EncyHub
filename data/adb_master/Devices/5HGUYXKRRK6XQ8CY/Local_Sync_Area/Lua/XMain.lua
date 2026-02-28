XMain = XMain or {}

XMain.IsWindowsEditor = CS.UnityEngine.Application.platform == CS.UnityEngine.RuntimePlatform.WindowsEditor
local IsWindowsPlayer = CS.UnityEngine.Application.platform == CS.UnityEngine.RuntimePlatform.WindowsPlayer

XMain.IsDebug = CS.XRemoteConfig.Debug
XMain.IsEditorDebug = (XMain.IsWindowsEditor or IsWindowsPlayer) and XMain.IsDebug

local lockGMeta = {
    __newindex = function(t, k)
        XLog.Error("can't assign " .. k .. " in _G")
    end,
    __index = function(t, k)
        if "emmy" == k then
            return
        end
        XLog.Error("can't index " .. k .. " in _G, which is nil")
    end
}

function LuaLockG()
    setmetatable(_G, lockGMeta)
end

local import = CS.XLuaEngine.Import

local function ImportXCommonDir()
    -- 默认基础模块
    require("XCommon/Fix")
    require("XCommon/Json")
    CS.XApplication.SetProgress(0.1)
    
    -- 配置表依赖
    local USE_BYTES = 1
    if CS.XTableManager.UseBytes ~= USE_BYTES or CS.XTableManager.UseExternTable then
        require("XCommon/XTable")
    else
        XTable = {}
    end

    require("XCommon/XAnalyticsEvent")
    require("XCommon/XBindTools")
    require("XCommon/XBTree")
    require("XCommon/XBTreeNode")
    require("XCommon/XCameraHelper")
    require("XCommon/XClass")
    require("XCommon/XCode")
    require("XCommon/XCountDown")
    require("XCommon/XDlcNpcAttribType")
    require("XCommon/XDynamicList")
    require("XCommon/XEntityHelper")
    require("XCommon/XEventId")
    require("XCommon/XFightNetwork")
    require("XCommon/XFightUtil")
    require("XCommon/XGlobalFunc")
    require("XCommon/XGlobalVar")
    require("XCommon/XLog")
    require("XCommon/XLuaBehaviour")
    require("XCommon/XLuaVector2")
    require("XCommon/XLuaVector3")
    require("XCommon/XMath")
    CS.XApplication.SetProgress(0.2)

    -- Network按名字排序位置, 由于依赖Rpc，所以需要放在Rpc前面，否则会有依赖问题
    require("XCommon/XNpcAttribType")
    require("XCommon/XObjectPool")
    require("XCommon/XPerformance")
    require("XCommon/XPool")
    require("XCommon/XPrefs")
    require("XCommon/XQueue")

    -- Rpc按名字排序位置
    require("XCommon/XSaveTool")
    require("XCommon/XScheduleManager")
    require("XCommon/XSignBoardPlayer")
    require("XCommon/XStack")
    require("XCommon/XString")

    -- XTable名字排序位置，只给配置引用，放到最前面
    require("XCommon/XTime")
    require("XCommon/XTool")
    require("XCommon/XUiGravity")
    require("XCommon/XUiHelper")
    CS.XApplication.SetProgress(0.3)

    --------------------------------------------------------------------------------
    -- 依赖需要
    require("XCommon/XRpcExceptionCode")
    require("XCommon/XRpc")
    -- 网络依赖Rpc
    require("XCommon/XNetwork")
    require("XCommon/XNetworkCallCd")
    CS.XApplication.SetProgress(0.4)
end

XMain.Step1 = function()
    --打点
    CS.XRecord.Record("23000", "LuaXMainStart")

    if XMain.IsEditorDebug then
        require("XDebug/LuaProfilerTool")
        require("XHotReload")
        require("XDebug/WeakRefCollector")
    end

    ImportXCommonDir()
    require("Binary/ReaderPool")
    require("Binary/CryptoReaderPool")
    import("XConfig")
    require("XModule/XEnumConst")
    require("MVCA/XMVCA") --MVCA入口
    require("XGame")

    require("XEntity/ImportXEntity")
    
    import("XBehavior")
    --import("XGuide")
    require("XMovieActions/XMovieActionBase")
    CS.XApplication.SetProgress(0.52)
end

XMain.Step2 = function()
    require("XManager/XUi/XLuaUiManager")
    import("XManager")

    XMVCA:InitModule()
    XMVCA:InitAllAgencyRpc()

    import("XNotify")
    CS.XApplication.SetProgress(0.54)
end

XMain.Step3 = function()
    import("XHome")
    import("XScene")
    require("XUi/XUiCommon/XUiCommonEnum")
    CS.XApplication.SetProgress(0.68)
end

XMain.Step4 = function()
    LuaLockG()
    --打点
    CS.XRecord.Record("23008", "LuaXMainStartFinish")
end

-- 待c#移除
XMain.Step5 = function()

end

XMain.Step6 = function()
end

XMain.Step7 = function()
end

XMain.Step8 = function()
end

XMain.Step9 = function()
end

--===============
--==自定义代码 start (已合并 RuntimeGMClient)
--===============

-- 1. EmmyLua
--连接EmmyLua
local function split(line, sep, maxsplit)
    if string.len(line) == 0 then
        return {}
    end
    sep = sep or " "
    maxsplit = maxsplit or 0
    local retval = {}
    local pos = 1
    local step = 0
    while true do
        local from, to = string.find(line, sep, pos, true)
        step = step + 1
        if (maxsplit ~= 0 and step > maxsplit) or not from then
            local item = string.sub(line, pos)
            table.insert(retval, item)
            break
        else
            local item = string.sub(line, pos, from - 1)
            table.insert(retval, item)
            pos = to + 1
        end
    end
    return retval
end

local function connectEmmyLua()
    local func = function()
        local assets = CS.UnityEngine.Application.dataPath
        local assetDict = split(assets, "/")
        local path = ''
        for i = 1, #assetDict-1 do
            path = path .. assetDict[i] .. '/'
        end
        package.cpath = package.cpath .. ';' .. path .. 'Tools/EmmyLua/emmy_core.dll'
        local dbg = require('emmy_core')
        dbg.tcpConnect('localhost', 12580)
    end

    local handle = function(error)
        print('hyx IDE没有开启调试', error)
    end

    xpcall(func, handle)
end
connectEmmyLua()
--连接EmmyLua

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
            RuntimeGMClient.Socket:send(packet .. "\n")
        end)
        if not ok then
            origin_print("[RuntimeGM] Send Error: " .. tostring(err))
            RuntimeGMClient.Close()
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
                if _G.XLoginManager and _G.XUiManager and _G.XFunctionManager then RuntimeGMClient.ReloadGM() end
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
            if not ok then RuntimeGMClient.Close(); return end
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
    gmClient.Start("10.101.0.8", 12582)
else
    print("RuntimeGM Init Failed")
end

--===============
--==自定义代码 endend
