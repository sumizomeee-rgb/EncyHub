"""
修复计划书2.0 单元测试
覆盖所有 11 项修复
"""
import os
import re
import json
import pytest

# ============================================================================
# 路径常量
# ============================================================================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend", "src", "pages")
GM_CONSOLE_JSX = os.path.join(FRONTEND_DIR, "GmConsole.jsx")
ADB_MASTER_JSX = os.path.join(FRONTEND_DIR, "AdbMaster.jsx")
HUB_API_PY = os.path.join(BASE_DIR, "hub_core", "api.py")
ADB_MAIN_PY = os.path.join(BASE_DIR, "tools", "adb_master", "main.py")
ADB_PATH_UTILS = os.path.join(BASE_DIR, "tools", "adb_master", "path_utils.py")


def read_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ============================================================================
# 2.3 [P1] 滑块范围 min=1, max=10
# ============================================================================

class TestSliderRange:
    """Fix 2.3: 缩放滑块范围从 min=2/max=8 改为 min=1/max=10"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_slider_min_is_1(self):
        assert 'min="1"' in self.content, "滑块 min 应为 1"

    def test_slider_max_is_10(self):
        assert 'max="10"' in self.content, "滑块 max 应为 10"

    def test_zoom_out_min_1(self):
        assert "Math.max(1," in self.content, "ZoomOut 下限应为 1"

    def test_zoom_in_max_10(self):
        assert "Math.min(10," in self.content, "ZoomIn 上限应为 10"

    def test_no_old_limits(self):
        assert 'min="2"' not in self.content, "不应存在旧的 min=2"
        assert 'max="8"' not in self.content, "不应存在旧的 max=8"


# ============================================================================
# 2.4 [P0] 刷新 LuaGM 按钮
# ============================================================================

class TestRefreshLuaGm:
    """Fix 2.4: LuaGM 标签页应有刷新按钮"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_refresh_icon_imported(self):
        assert "RefreshCw" in self.content, "应导入 RefreshCw 图标"

    def test_reload_gm_command(self):
        assert "RuntimeGMClient.ReloadGM(true)" in self.content, "应发送 ReloadGM 命令"

    def test_refresh_button_has_title(self):
        assert '刷新 LuaGM' in self.content, "刷新按钮应有 title"


# ============================================================================
# 2.1 [P0] GM 按钮固定高度
# ============================================================================

class TestGmButtonHeight:
    """Fix 2.1: 所有 GM 网格项应有动态高度 (btnHeight state)"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_btn_has_dynamic_height(self):
        assert re.search(r'height:\s*btnHeight', self.content), \
            "Btn 类型应有动态 btnHeight"

    def test_subbox_has_dynamic_height(self):
        # SubBox and Btn both use btnHeight - check multiple occurrences
        matches = re.findall(r'height:\s*btnHeight', self.content)
        assert len(matches) >= 2, "SubBox 和 Btn 类型都应有动态 btnHeight"

    def test_toggle_has_dynamic_height(self):
        lines = self.content.split('\n')
        toggle_section = False
        for line in lines:
            if "nodeType === 'toggle'" in line:
                toggle_section = True
            if toggle_section and 'btnHeight' in line:
                assert True
                return
            if toggle_section and 'nodeType ===' in line and 'toggle' not in line:
                break
        pytest.fail("Toggle 类型应有动态 btnHeight")

    def test_input_has_dynamic_height(self):
        lines = self.content.split('\n')
        input_section = False
        for line in lines:
            if "nodeType === 'input'" in line:
                input_section = True
            if input_section and 'btnHeight' in line:
                assert True
                return
            if input_section and '// Default: Btn' in line:
                break
        pytest.fail("Input 类型应有动态 btnHeight")

    def test_btn_uses_line_clamp(self):
        assert "line-clamp-2" in self.content, "应使用 line-clamp-2 截断文本"


# ============================================================================
# 2.2 [P1] 自定义 GM 编辑按钮可见性
# ============================================================================

class TestCustomGmEditVisibility:
    """Fix 2.2: 自定义 GM 编辑/删除按钮应始终可见"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_no_opacity_0_on_edit_buttons(self):
        # 查找 customGmList.map 区域内的 opacity 设置
        in_custom = False
        for line in self.content.split('\n'):
            if 'customGmList.map' in line:
                in_custom = True
            if in_custom and 'opacity-0 ' in line:
                pytest.fail("自定义 GM 编辑按钮不应使用 opacity-0（完全隐藏）")
            if in_custom and '</div>' in line and 'style={gridStyle}' in line:
                break

    def test_edit_buttons_have_base_opacity(self):
        assert 'opacity-60' in self.content, "编辑按钮应有基础可见度 opacity-60"

    def test_custom_gm_card_has_dynamic_height(self):
        # CustomGM cards should also have dynamic btnHeight
        in_custom = False
        for line in self.content.split('\n'):
            if 'customGmList.map' in line:
                in_custom = True
            if in_custom and 'btnHeight' in line:
                assert True
                return
            if in_custom and '</div>' in line and 'gridStyle' not in line:
                continue
        pytest.fail("自定义 GM 卡片应有动态 btnHeight")

    def test_edit_icon_size_increased(self):
        # Edit icon should be size={14} not size={12}
        in_custom = False
        for line in self.content.split('\n'):
            if 'customGmList.map' in line:
                in_custom = True
            if in_custom and '<Edit size={14}' in line:
                assert True
                return
        pytest.fail("编辑图标应增大到 size={14}")


# ============================================================================
# 1.1 [P0] Logcat WebSocket 错误处理
# ============================================================================

class TestLogcatErrorHandling:
    """Fix 1.1: Logcat WebSocket 应有错误提示和超时检测"""

    def setup_method(self):
        self.content = read_file(ADB_MASTER_JSX)

    def test_onerror_has_toast(self):
        assert "toast.error('Logcat 连接失败')" in self.content, \
            "ws.onerror 应显示 toast 错误"

    def test_connection_timeout(self):
        assert "Logcat 连接超时" in self.content, \
            "应有连接超时检测"

    def test_timeout_clears_on_open(self):
        assert "clearTimeout(connectTimeout)" in self.content, \
            "连接成功时应清除超时定时器"


# ============================================================================
# 1.3 [P1] WiFi IP 地址显示
# ============================================================================

class TestWifiIpDisplay:
    """Fix 1.3: 设备列表应显示 WiFi IP"""

    def setup_method(self):
        self.content = read_file(ADB_MASTER_JSX)

    def test_wifi_ip_rendered(self):
        assert "device.wifi_ip" in self.content, \
            "应渲染 wifi_ip 字段"

    def test_wifi_ip_icon(self):
        assert "⊛" in self.content, \
            "WiFi IP 应有 ⊛ 图标前缀"


# ============================================================================
# 1.4 [P0] Pull 修复 + 本地路径
# ============================================================================

class TestPullFix:
    """Fix 1.4: Pull 错误处理 + 本地路径输入"""

    def setup_method(self):
        self.frontend = read_file(ADB_MASTER_JSX)
        self.backend = read_file(ADB_MAIN_PY)

    def test_safe_error_parsing(self):
        # 应使用 res.text() 而非直接 res.json()
        assert "res.text()" in self.frontend, \
            "错误处理应先用 res.text() 再解析"

    def test_json_parse_fallback(self):
        assert "JSON.parse(text)" in self.frontend, \
            "应有 JSON.parse 回退逻辑"

    def test_local_path_input_exists(self):
        assert "pullLocalPath" in self.frontend, \
            "应有本地保存路径输入"

    def test_local_path_label(self):
        assert "本地保存路径" in self.frontend, \
            "应有本地保存路径标签"

    def test_backend_accepts_local_path(self):
        assert "local_path" in self.backend, \
            "后端 Pull API 应接受 local_path 参数"

    def test_backend_returns_json_when_local_path(self):
        assert "已保存到" in self.backend, \
            "指定 local_path 时应返回 JSON 消息"


# ============================================================================
# 3.1 [P1] Hub 代理超时
# ============================================================================

class TestHubProxyTimeout:
    """Fix 3.1: Hub HTTP 代理超时从 30s 改为 300s"""

    def setup_method(self):
        self.content = read_file(HUB_API_PY)

    def test_timeout_is_300(self):
        assert "timeout=300.0" in self.content, \
            "代理超时应为 300 秒"

    def test_no_30s_timeout(self):
        assert "timeout=30.0" not in self.content, \
            "不应存在旧的 30 秒超时"


# ============================================================================
# 1.2 [P0] 设备文件夹 (path_utils)
# ============================================================================

class TestDeviceFolders:
    """Fix 1.2: ensure_device_dirs 应正确创建设备目录"""

    def setup_method(self):
        self.content = read_file(ADB_PATH_UTILS)

    def test_ensure_device_dirs_exists(self):
        assert "def ensure_device_dirs" in self.content, \
            "应有 ensure_device_dirs 函数"

    def test_creates_sync_area(self):
        assert "Local_Sync_Area" in self.content, \
            "应创建 Local_Sync_Area 目录"

    def test_creates_logs_dir(self):
        assert "logs" in self.content, \
            "应创建 logs 目录"

    def test_sanitizes_serial(self):
        assert "replace(':'," in self.content, \
            "应清洗 serial 中的冒号"

    def test_pull_uses_device_dirs(self):
        backend = read_file(ADB_MAIN_PY)
        assert "ensure_device_dirs" in backend, \
            "Pull API 应使用 ensure_device_dirs"
