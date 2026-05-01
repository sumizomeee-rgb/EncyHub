    -- ========== LuaTableMonitor: 配表数据查看器 ==========
    -- 注意：LuaTableMonitor 需要在 RuntimeGMClient.Update() 之前前向声明：
    --   local LuaTableMonitor = {}
    -- 与 LuaAvMonitor 的前向声明放在一起，确保 Update 闭包能捕获到 upvalue。
    -- 下方代码直接往已声明的 table 上挂字段，不再 local LuaTableMonitor = {}。
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

    -- path cache: tableName -> logical table path, e.g. Share/Character/Character.tab
    function LuaTableMonitor._buildPathCache()
        if LuaTableMonitor._pathCache then return end
        LuaTableMonitor._pathCache = {}

        local rootFull
        pcall(function() rootFull = CS.XTableManager.GetFullPath("Share") end)
        if not rootFull then return end

        rootFull = tostring(rootFull):gsub("\\", "/"):gsub("/+$", "")
        local tableRoot = rootFull:match("^(.*)/Share$")
        if not tableRoot then return end
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
                    -- also match the key itself
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
