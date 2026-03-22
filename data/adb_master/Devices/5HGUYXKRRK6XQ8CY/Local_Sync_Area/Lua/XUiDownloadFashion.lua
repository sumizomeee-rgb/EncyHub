---@class XUiDownloadFashion : XLuaUi
local XUiDownloadFashion = XLuaUiManager.Register(XLuaUi, "UiDownloadFashion")

local FilterType = {
    All = 0,
    Own = 1,
    UnOwn = 2,
}

local function GetCacheKey()
    return "DownloadFashion_ResIds_" .. (XPlayer.Id or 0)
end

function XUiDownloadFashion:OnAwake()
    self:InitButton()
    self:InitDynamicTable()
end

function XUiDownloadFashion:OnStart()
    self._FilterType = FilterType.All
    self._SelectedResIds = {}
    self:CheckDownloadingState()
    self:RefreshView()
    self:UpdatePanelState()
end

function XUiDownloadFashion:OnEnable()
    XEventManager.AddEventListener(XEventId.EVENT_SUBPACKAGE_COMPLETE, self.RefreshView, self)
    XEventManager.AddEventListener(XEventId.EVENT_RES_UPDATE, self.OnResUpdate, self)
    XEventManager.AddEventListener(XEventId.EVENT_RES_COMPLETE, self.OnResComplete, self)
end

function XUiDownloadFashion:OnDisable()
    XEventManager.RemoveEventListener(XEventId.EVENT_SUBPACKAGE_COMPLETE, self.RefreshView, self)
    XEventManager.RemoveEventListener(XEventId.EVENT_RES_UPDATE, self.OnResUpdate, self)
    XEventManager.RemoveEventListener(XEventId.EVENT_RES_COMPLETE, self.OnResComplete, self)
end

function XUiDownloadFashion:InitButton()
    self.BtnTanchuangCloseBig:AddEventListener(handler(self, self.OnBtnTanchuangCloseBigClick))
    self.BtnFilterAll:AddEventListener(handler(self, self.OnBtnFilterAllClick))
    self.BtnFilterOwn:AddEventListener(handler(self, self.OnBtnFilterOwnClick))
    self.BtnFilterUnOwn:AddEventListener(handler(self, self.OnBtnFilterUnOwnClick))
    self.ToggleSelectAll:AddEventListener(handler(self, self.OnToggleSelectAllClick))
    self.BtnDownload:AddEventListener(handler(self, self.OnBtnDownloadClick))
    self.BtnUninstall:AddEventListener(handler(self, self.OnBtnUninstallClick))
    self.BtnContinue:AddEventListener(handler(self, self.OnBtnContinueClick))
    self.BtnPause:AddEventListener(handler(self, self.OnBtnPauseClick))
end

function XUiDownloadFashion:InitDynamicTable()
    local XUiGridDownloadFashion = require("XUi/XUiSubPackage/XUiGrid/XUiGridDownloadFashion")
    self.ListFashion = XUiHelper.DynamicTableNormal(self, self.ListFashion, XUiGridDownloadFashion)
    self.ListFashion:SetDynamicEventDelegate(function(event, index, grid) self:OnListFashionDynamicTableEvent(event, index, grid) end)
end

function XUiDownloadFashion:OnBtnTanchuangCloseBigClick()
    self:Close()
end

function XUiDownloadFashion:OnBtnFilterAllClick()
    self._FilterType = FilterType.All
    self:ClearSelection()
    self:RefreshView()
    self:UpdateFilterBtnState()
end

function XUiDownloadFashion:OnBtnFilterOwnClick()
    self._FilterType = FilterType.Own
    self:ClearSelection()
    self:RefreshView()
    self:UpdateFilterBtnState()
end

function XUiDownloadFashion:OnBtnFilterUnOwnClick()
    self._FilterType = FilterType.UnOwn
    self:ClearSelection()
    self:RefreshView()
    self:UpdateFilterBtnState()
end

function XUiDownloadFashion:OnToggleSelectAllClick()
    local isSelectAll = self.ToggleSelectAll:GetToggleState()
    for _, data in ipairs(self._DataList or {}) do
        data.IsSelected = isSelectAll
        self._SelectedResIds[data.ResId] = isSelectAll or nil
    end
    self:RefreshListFashionDynamicTable()
    self:UpdateBottomBtnState()
end

function XUiDownloadFashion:OnBtnDownloadClick()
    -- 只下载未下载完成的ResId
    local resIds = {}
    for resId, _ in pairs(self._SelectedResIds) do
        if not XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            table.insert(resIds, resId)
        end
    end
    if XTool.IsTableEmpty(resIds) then
        XUiManager.TipText("SelectFashionToDownload")
        return
    end
    -- 保存到缓存
    self:SaveDownloadingResIds(resIds)
    -- 加入下载队列
    for _, resId in ipairs(resIds) do
        XMVCA.XSubPackage:AddResToDownload(resId)
    end
    self._IsDownloading = true
    self._DownloadingResIds = resIds
    self:ClearSelection()
    self:RefreshView()
    self:UpdatePanelState()
end

function XUiDownloadFashion:OnBtnUninstallClick()
    -- 正在下载中，不允许卸载（避免遮罩问题）
    if XMVCA.XSubPackage:IsDownloading() then
        XUiManager.TipText("SubpackageUninstallRejectDownloading")
        return
    end

    -- 只卸载已下载完成的ResId
    local resIds = {}
    for resId, _ in pairs(self._SelectedResIds) do
        if XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            table.insert(resIds, resId)
        end
    end
    if XTool.IsTableEmpty(resIds) then
        XUiManager.TipText("SelectFashionToUninstall")
        return
    end
    local sureCb = function()
        self.DeleteMask.gameObject:SetActiveEx(true)
        local uninstallCount = #resIds
        local finishedCount = 0
        for _, resId in ipairs(resIds) do
            XMVCA.XSubPackage:UninstallResourceById(resId, function()
                finishedCount = finishedCount + 1
                if finishedCount >= uninstallCount then
                    self.DeleteMask.gameObject:SetActiveEx(false)
                    self:ClearSelection()
                    self:RefreshView()
                end
            end)
        end
    end
    XUiManager.DialogTip(XUiHelper.GetText("TipTitle"), XUiHelper.GetText("UninstallFashionConfirm"), nil, nil, sureCb)
end

function XUiDownloadFashion:OnBtnContinueClick()
    -- 重新加入下载队列
    for _, resId in ipairs(self._DownloadingResIds or {}) do
        if not XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            XMVCA.XSubPackage:AddResToDownload(resId)
        end
    end
    -- 切换到"下载中"UI状态
    self._IsPaused = false
    self:UpdateDownloadBtnState()
end

function XUiDownloadFashion:OnBtnPauseClick()
    -- 从下载队列移除
    XMVCA.XSubPackage:PauseResListDownload(self._DownloadingResIds)
    -- 切换到"已暂停"UI状态
    self._IsPaused = true
    self:UpdateDownloadBtnState()
end

function XUiDownloadFashion:OnListFashionDynamicTableEvent(event, index, grid)
    if event == DYNAMIC_DELEGATE_EVENT.DYNAMIC_GRID_ATINDEX then
        grid:Refresh(self.ListFashion.DataSource[index])
    elseif event == DYNAMIC_DELEGATE_EVENT.DYNAMIC_GRID_TOUCHED then
        self:OnGridClick(grid)
    end
end

function XUiDownloadFashion:RefreshListFashionDynamicTable(index)
    self.ListFashion:ReloadDataSync(index or 1)
end

function XUiDownloadFashion:RefreshView()
    self._DataList = self:GetFashionDownloadList()
    self.ListFashion:SetDataSource(self._DataList)
    self:RefreshListFashionDynamicTable(1)
    self:UpdateFilterBtnState()
    self:UpdateBottomBtnState()
end

function XUiDownloadFashion:GetFashionDownloadList()
    local result = {}
    local configs = XMVCA.XSubPackage._Model:GetAllFashionDownloadConfigs()

    for _, config in pairs(configs) do
        local fashionId = config.FashionId
        local resId = config.ResId

        if XDataCenter.FashionManager.IsFashionInTime(fashionId) then
            local isOwn = XDataCenter.FashionManager.CheckHasFashion(fashionId)
            local isDownloaded = XMVCA.XSubPackage:CheckResDownloadComplete(resId)

            local shouldAdd = false
            if self._FilterType == FilterType.All then
                shouldAdd = true
            elseif self._FilterType == FilterType.Own and isOwn then
                shouldAdd = true
            elseif self._FilterType == FilterType.UnOwn and not isOwn then
                shouldAdd = true
            end

            if shouldAdd then
                local template = XDataCenter.FashionManager.GetFashionTemplate(fashionId)
                table.insert(result, {
                    FashionId = fashionId,
                    ResId = resId,
                    IsOwn = isOwn,
                    IsDownloaded = isDownloaded,
                    CharacterId = template and template.CharacterId or 0,
                    Name = template and template.Name or "",
                    IsSelected = self._SelectedResIds[resId] or false,
                })
            end
        end
    end

    table.sort(result, function(a, b)
        if a.IsOwn ~= b.IsOwn then
            return a.IsOwn
        end
        return a.FashionId < b.FashionId
    end)

    return result
end

function XUiDownloadFashion:UpdateFilterBtnState()
    self.BtnFilterAll:SetButtonState(self._FilterType == FilterType.All and CS.UiButtonState.Select or CS.UiButtonState.Normal)
    self.BtnFilterOwn:SetButtonState(self._FilterType == FilterType.Own and CS.UiButtonState.Select or CS.UiButtonState.Normal)
    self.BtnFilterUnOwn:SetButtonState(self._FilterType == FilterType.UnOwn and CS.UiButtonState.Select or CS.UiButtonState.Normal)
end

function XUiDownloadFashion:UpdateBottomBtnState()
    -- 计算可下载和可卸载的大小
    local downloadSize = 0
    local uninstallSize = 0
    for resId, _ in pairs(self._SelectedResIds) do
        local size = XMVCA.XSubPackage:GetResTotalSize(resId)
        if XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            uninstallSize = uninstallSize + size
        else
            downloadSize = downloadSize + size
        end
    end

    -- 转换为MB显示
    local downloadMB = string.format("%.1fMB", downloadSize / 1024 / 1024)
    local uninstallMB = string.format("%.1fMB", uninstallSize / 1024 / 1024)

    self.BtnDownload:SetNameByGroup(1, downloadMB)
    self.BtnUninstall:SetNameByGroup(1, uninstallMB)
end

function XUiDownloadFashion:OnResUpdate(resId, progress)
    -- 更新格子进度
    local grids = self.ListFashion:GetGrids()
    for _, grid in pairs(grids) do
        if grid.Data and grid.Data.ResId == resId then
            grid:RefreshProgress(progress)
            break
        end
    end

    -- 更新下载进度条
    if self._IsDownloading then
        self:UpdateDownloadProgress()
        self:CheckDownloadComplete()
    end
end

function XUiDownloadFashion:OnResComplete(resId)
    self:RefreshView()
    self:CheckDownloadComplete()
end

-- 格子点击事件
function XUiDownloadFashion:OnGridClick(grid)
    if not grid or not grid.Data then return end
    local resId = grid.Data.ResId
    local isSelected = not grid.Data.IsSelected
    grid:UpdateSelectState(isSelected)
    self:OnGridSelectChanged(resId, isSelected)
end

function XUiDownloadFashion:OnGridSelectChanged(resId, isSelected)
    self._SelectedResIds[resId] = isSelected or nil
    self:UpdateBottomBtnState()
end

-- 清除选中状态
function XUiDownloadFashion:ClearSelection()
    self._SelectedResIds = {}
    if self.ToggleSelectAll then
        self.ToggleSelectAll:SetButtonState(CS.UiButtonState.Normal)
    end
end

-- 更新面板显示状态（PanelSelecting和PanelDownloading互斥）
function XUiDownloadFashion:UpdatePanelState()
    self.PanelSelecting.gameObject:SetActiveEx(not self._IsDownloading)
    self.PanelDownloading.gameObject:SetActiveEx(self._IsDownloading)

    if self._IsDownloading then
        self:UpdateDownloadProgress()
        self:UpdateDownloadBtnState()
    end
end

-- 更新暂停/继续按钮可见性（互斥显示）
function XUiDownloadFashion:UpdateDownloadBtnState()
    self.BtnPause.gameObject:SetActiveEx(not self._IsPaused)
    self.BtnContinue.gameObject:SetActiveEx(self._IsPaused)
end

-- 更新下载进度显示
function XUiDownloadFashion:UpdateDownloadProgress()
    local totalSize = 0
    local downloadedSize = 0

    for _, resId in ipairs(self._DownloadingResIds or {}) do
        local resItem = XMVCA.XSubPackage:GetResourceItem(resId)
        if resItem then
            totalSize = totalSize + resItem:GetTotalSize()
            downloadedSize = downloadedSize + resItem:GetDownloadSize()
        end
    end

    -- 进度条
    local progress = totalSize > 0 and (downloadedSize / totalSize) or 0
    if self.ImgFillBar then
        self.ImgFillBar.fillAmount = progress
    end

    -- 进度文本（例如：99.9MB/999.9MB）
    if self.TxtTotalProgressNum then
        local downloadedMB = string.format("%.1f", downloadedSize / 1024 / 1024)
        local totalMB = string.format("%.1f", totalSize / 1024 / 1024)
        self.TxtTotalProgressNum.text = downloadedMB .. "MB/" .. totalMB .. "MB"
    end
end

-- 检查下载状态（进入界面时调用）
function XUiDownloadFashion:CheckDownloadingState()
    local cachedResIds = self:LoadDownloadingResIds()
    if XTool.IsTableEmpty(cachedResIds) then
        self._IsDownloading = false
        self._IsPaused = false
        self._DownloadingResIds = {}
        return
    end

    -- 过滤无效 resId（跨版本残留脏数据）
    local validResIds = {}
    for _, resId in ipairs(cachedResIds) do
        if XMVCA.XSubPackage:GetResourceItem(resId) then
            table.insert(validResIds, resId)
        end
    end
    if XTool.IsTableEmpty(validResIds) then
        self:ClearDownloadingCache()
        self._IsDownloading = false
        self._IsPaused = false
        self._DownloadingResIds = {}
        return
    end

    -- 检查是否全部完成
    local allComplete = true
    for _, resId in ipairs(validResIds) do
        if not XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            allComplete = false
            break
        end
    end

    if allComplete then
        -- 全部完成，清除缓存，进入选择模式
        self:ClearDownloadingCache()
        self._IsDownloading = false
        self._IsPaused = false
        self._DownloadingResIds = {}
    else
        -- 有未完成的，进入下载中模式
        self._IsDownloading = true
        self._DownloadingResIds = validResIds
        -- 检测所有未完成res是否全部处于PAUSE状态（区分"暂停中"和"下载中"）
        local allPaused = true
        for _, resId in ipairs(validResIds) do
            if not XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
                local resItem = XMVCA.XSubPackage:GetResourceItem(resId)
                if resItem and resItem:GetState() ~= XEnumConst.SUBPACKAGE.DOWNLOAD_STATE.PAUSE then
                    allPaused = false
                    break
                end
            end
        end
        self._IsPaused = allPaused
    end
end

-- 保存下载中的ResId到缓存
function XUiDownloadFashion:SaveDownloadingResIds(resIds)
    local cachedResIds = self:LoadDownloadingResIds() or {}
    for _, resId in ipairs(resIds) do
        if not table.contains(cachedResIds, resId) then
            table.insert(cachedResIds, resId)
        end
    end
    XSaveTool.SaveData(GetCacheKey(), cachedResIds)
end

-- 从缓存加载下载中的ResId
function XUiDownloadFashion:LoadDownloadingResIds()
    return XSaveTool.GetData(GetCacheKey())
end

-- 清除下载缓存
function XUiDownloadFashion:ClearDownloadingCache()
    XSaveTool.SaveData(GetCacheKey(), nil)
end

-- 检查下载是否全部完成
function XUiDownloadFashion:CheckDownloadComplete()
    if XTool.IsTableEmpty(self._DownloadingResIds) then
        return
    end

    for _, resId in ipairs(self._DownloadingResIds) do
        if not XMVCA.XSubPackage:CheckResDownloadComplete(resId) then
            return
        end
    end

    -- 全部完成，清除缓存，返回选择模式
    self:ClearDownloadingCache()
    self._IsDownloading = false
    self._DownloadingResIds = {}
    self:RefreshView()
    self:UpdatePanelState()
end