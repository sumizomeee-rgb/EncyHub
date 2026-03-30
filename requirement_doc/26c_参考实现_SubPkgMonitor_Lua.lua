------------------------------------------------------------------------
-- SubPackage Monitor -- 参考实现 (Lua)
-- 文档编号：26c
--
-- 本文件是独立参考实现，供开发者嵌入 RuntimeGMClient.ProcessPacket。
-- 在 ProcessPacket 的 if/elseif 链中添加：
--
--   elseif type == "SUBPKG_MONITOR" then
--       SubPkgMonitor.Handle(packet)
--
-- 两个 action：
--   "get_structure" — 静态结构（首次加载 / 手动刷新时调用）
--   "get_status"    — 轻量动态状态（2s 轮询）
------------------------------------------------------------------------

local SubPkgMonitor = {}

------------------------------------------------------------------------
-- 内部工具
------------------------------------------------------------------------

-- 安全地获取 XSubPackage agency，未初始化时返回 nil
local function getAgency()
    local ok, agency = pcall(function()
        return XMVCA.XSubPackage
    end)
    if not ok or not agency then
        return nil
    end
    return agency
end

-- 发送错误响应，统一格式
local function sendError(action, msg)
    RuntimeGMClient.Send({
        type   = "SUBPKG_MONITOR_RESP",
        action = action,
        error  = msg
    })
end

------------------------------------------------------------------------
-- action: get_structure
--
-- 收集完整的静态结构数据：
--   subs        — 每个 SubPackage 的名称与包含的 ResId 列表
--   resources   — 每个 Resource 归属的 SubId 列表 + 文件信息
--   sharedFiles — 被多个 Resource 共享的物理文件 (fileName -> resId[])
------------------------------------------------------------------------

function SubPkgMonitor.HandleGetStructure()
    local agency = getAgency()
    if not agency then
        sendError("get_structure", "XSubPackage agency not available")
        return
    end

    -- IsOpen 检查：DLC 管理器可能尚未初始化
    local isOpen = false
    pcall(function() isOpen = agency:IsOpen() end)
    if not isOpen then
        sendError("get_structure", "SubPackage system not open")
        return
    end

    -- 获取数据源 -------------------------------------------------------
    local subIndexInfo = nil   -- table<ResId, table<assetPath, {fileName, sha1, size}>>
    local resDict      = nil   -- table<resId, XResource>
    local subDict      = nil   -- table<subId, XSubpackage>

    pcall(function() subIndexInfo = agency:GetSubIndexInfo() end)
    pcall(function() resDict, subDict = agency:GetAllResAndSubpackageItemDic() end)

    -- 任一核心数据缺失则报错
    if not subDict then
        sendError("get_structure", "_SubpackageDict is nil (DLC not resolved?)")
        return
    end

    -- 1) 构建 subs -----------------------------------------------------
    --    key = tostring(subId)
    --    value = { name: string, resIds: number[] }
    local subs = {}
    for subId, _ in pairs(subDict) do
        local template = nil
        pcall(function() template = agency:GetSubpackageTemplate(subId) end)

        subs[tostring(subId)] = {
            name   = (template and template.Name) or ("Sub_" .. tostring(subId)),
            resIds = (template and template.ResIds) or {}
        }
    end

    -- 2) 构建 resources + 统计文件引用 ----------------------------------
    --    key = tostring(resId)
    --    value = { subIds: number[], files: fileInfo[] }
    local resources    = {}
    local fileRefCount = {}  -- fileName -> { resId1, resId2, ... }（去重）

    if subIndexInfo then
        for resId, fileDict in pairs(subIndexInfo) do
            local files  = {}
            local subIds = {}
            pcall(function()
                subIds = agency._Model:GetSubpackageIdByResId(resId) or {}
            end)

            if fileDict then
                for assetPath, info in pairs(fileDict) do
                    -- info = { [1]=physicalFileName, [2]=sha1, [3]=size }
                    local fileName = info[1]
                    local sha1     = info[2]
                    local size     = info[3]

                    files[#files + 1] = {
                        asset = assetPath,
                        name  = fileName,
                        sha1  = sha1,
                        size  = size
                    }

                    -- 统计物理文件被哪些 ResId 引用（去重）
                    if fileName then
                        if not fileRefCount[fileName] then
                            fileRefCount[fileName] = {}
                        end
                        local alreadyExists = false
                        for _, rid in ipairs(fileRefCount[fileName]) do
                            if rid == resId then
                                alreadyExists = true
                                break
                            end
                        end
                        if not alreadyExists then
                            table.insert(fileRefCount[fileName], resId)
                        end
                    end
                end
            end

            resources[tostring(resId)] = {
                subIds = subIds,
                files  = files
            }
        end
    end

    -- 3) 过滤出共享文件（引用计数 > 1）---------------------------------
    local sharedFiles = {}
    for fileName, resIds in pairs(fileRefCount) do
        if #resIds > 1 then
            sharedFiles[fileName] = resIds
        end
    end

    -- 发送响应 ----------------------------------------------------------
    RuntimeGMClient.Send({
        type   = "SUBPKG_MONITOR_RESP",
        action = "get_structure",
        data   = {
            subs        = subs,
            resources   = resources,
            sharedFiles = sharedFiles
        }
    })
end

------------------------------------------------------------------------
-- action: get_status
--
-- 收集轻量动态状态（供 2s 轮询）：
--   subs      — 每个 Sub 的 state / dlSize / totalSize / progress
--   resources — 每个 Res 的 state / tgState / dlSize / totalSize / progress
------------------------------------------------------------------------

function SubPkgMonitor.HandleGetStatus()
    local agency = getAgency()
    if not agency then
        sendError("get_status", "XSubPackage agency not available")
        return
    end

    local isOpen = false
    pcall(function() isOpen = agency:IsOpen() end)
    if not isOpen then
        sendError("get_status", "SubPackage system not open")
        return
    end

    local resDict  = nil  -- table<resId, XResource>
    local subDict  = nil  -- table<subId, XSubpackage>
    pcall(function() resDict, subDict = agency:GetAllResAndSubpackageItemDic() end)

    if not subDict and not resDict then
        sendError("get_status", "Item dictionaries are nil")
        return
    end

    -- SubPackage 状态 --------------------------------------------------
    local subsStatus = {}
    if subDict then
        for subId, subItem in pairs(subDict) do
            local entry = {}
            pcall(function() entry.state     = subItem:GetState() end)
            pcall(function() entry.dlSize    = subItem:GetDownloadSize() end)
            pcall(function() entry.totalSize = subItem:GetTotalSize() end)
            pcall(function() entry.progress  = subItem:GetProgress() end)
            subsStatus[tostring(subId)] = entry
        end
    end

    -- Resource 状态 ----------------------------------------------------
    local resStatus = {}
    if resDict then
        for resId, resItem in pairs(resDict) do
            local entry = {}
            pcall(function() entry.state     = resItem:GetState() end)
            pcall(function()
                local tg = resItem:GetTaskGroup()
                entry.tgState = tg and tg.State or -1
            end)
            pcall(function() entry.dlSize    = resItem:GetDownloadSize() end)
            pcall(function() entry.totalSize = resItem:GetTotalSize() end)
            pcall(function() entry.progress  = resItem:GetProgress() end)
            resStatus[tostring(resId)] = entry
        end
    end

    -- 发送响应 ----------------------------------------------------------
    RuntimeGMClient.Send({
        type   = "SUBPKG_MONITOR_RESP",
        action = "get_status",
        data   = {
            subs      = subsStatus,
            resources = resStatus
        }
    })
end

------------------------------------------------------------------------
-- 统一入口 — 在 RuntimeGMClient.ProcessPacket 中调用
--
-- 用法：
--   elseif type == "SUBPKG_MONITOR" then
--       SubPkgMonitor.Handle(packet)
------------------------------------------------------------------------

function SubPkgMonitor.Handle(packet)
    local action = packet and packet.action
    if not action then
        sendError("unknown", "missing action field")
        return
    end

    local ok, err = pcall(function()
        if action == "get_structure" then
            SubPkgMonitor.HandleGetStructure()
        elseif action == "get_status" then
            SubPkgMonitor.HandleGetStatus()
        else
            sendError(action, "unknown action: " .. tostring(action))
        end
    end)

    if not ok then
        sendError(action, "unhandled error: " .. tostring(err))
    end
end

return SubPkgMonitor
