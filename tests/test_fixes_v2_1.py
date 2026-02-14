"""
修复计划书2.1 单元测试
覆盖 5 项修复
"""
import os
import re
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
GM_MAIN_PY = os.path.join(BASE_DIR, "tools", "gm_console", "main.py")


def read_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ============================================================================
# 1.1 [P0] Push 改为路径输入
# ============================================================================

class TestPushPathInput:
    """Fix 1.1: Push 应使用路径输入而非文件上传"""

    def setup_method(self):
        self.frontend = read_file(ADB_MASTER_JSX)
        self.backend = read_file(ADB_MAIN_PY)

    def test_no_file_upload_input(self):
        assert 'type="file"' not in self.frontend or \
               self.frontend.count('type="file"') <= 1, \
            "Push 区域不应有 file upload (仅 APK 安装可保留一个)"

    def test_no_push_file_state(self):
        assert "setPushFile" not in self.frontend, \
            "不应有 pushFile 状态"

    def test_push_local_path_state(self):
        assert "pushLocalPath" in self.frontend, \
            "应有 pushLocalPath 状态"

    def test_push_uses_json_body(self):
        assert "JSON.stringify({ local_path: pushLocalPath" in self.frontend, \
            "Push 应发送 JSON body 而非 FormData"

    def test_push_disabled_by_path(self):
        assert "!pushLocalPath.trim()" in self.frontend, \
            "Push 按钮应根据路径是否为空来禁用"

    def test_backend_push_request_model(self):
        assert "class PushRequest" in self.backend, \
            "后端应有 PushRequest 模型"

    def test_backend_push_accepts_local_path(self):
        assert "req.local_path" in self.backend, \
            "后端 Push API 应使用 req.local_path"

    def test_backend_validates_path_exists(self):
        assert "os.path.exists(req.local_path)" in self.backend, \
            "后端应验证本地路径存在"

    def test_backend_no_upload_file_in_push(self):
        # Push endpoint should not use UploadFile anymore
        # Find the push function and check it doesn't use UploadFile
        push_match = re.search(
            r'async def push_file\(.*?\)',
            self.backend,
            re.DOTALL
        )
        assert push_match, "应有 push_file 函数"
        assert "UploadFile" not in push_match.group(), \
            "Push API 不应使用 UploadFile"

    def test_frontend_path_input_label(self):
        assert "本地路径" in self.frontend, \
            "应有本地路径输入标签"


# ============================================================================
# 1.2 [P0] Logcat 连接失败修复
# ============================================================================

class TestLogcatConnectionFix:
    """Fix 1.2: Logcat WS 链路错误处理"""

    def setup_method(self):
        self.frontend = read_file(ADB_MASTER_JSX)
        self.backend = read_file(ADB_MAIN_PY)
        self.hub = read_file(HUB_API_PY)

    def test_frontend_parses_json_error(self):
        assert "JSON.parse(e.data)" in self.frontend, \
            "前端应解析 WS 消息中的 JSON 错误"

    def test_frontend_checks_error_field(self):
        assert "json.error" in self.frontend, \
            "前端应检查 JSON 中的 error 字段"

    def test_backend_logcat_try_catch(self):
        assert "Logcat 启动失败" in self.backend, \
            "后端 logcat 应有启动失败错误处理"

    def test_backend_sends_error_on_failure(self):
        # Check that start_logcat is wrapped in try-except
        assert re.search(
            r'try:\s+await adb_mgr\.start_logcat',
            self.backend,
            re.DOTALL
        ), "start_logcat 应被 try-except 包裹"

    def test_hub_ws_proxy_error_feedback(self):
        assert "无法连接到工具服务" in self.hub, \
            "Hub WS 代理应在连接失败时发送错误消息"

    def test_hub_ws_proxy_logs_error(self):
        assert "WS 代理连接失败" in self.hub, \
            "Hub WS 代理应记录连接失败日志"


# ============================================================================
# 2.1 [P1] GM 按钮高度降低
# ============================================================================

class TestGmButtonHeightReduced:
    """Fix 2.1: GM 按钮从 h-24 降低到 h-16"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_no_h24_remaining(self):
        assert "h-24" not in self.content, \
            "不应有残留的 h-24"

    def test_has_h16(self):
        assert "h-16" in self.content, \
            "应使用 h-16"

    def test_btn_has_h16(self):
        assert re.search(
            r'h-16.*rounded-xl.*hover:bg-\[var\(--caramel\)\]',
            self.content
        ), "Btn 类型应有 h-16"

    def test_subbox_has_h16(self):
        assert re.search(
            r'h-16.*rounded-xl.*hover:bg-\[var\(--caramel-light\)\]',
            self.content
        ), "SubBox 类型应有 h-16"


# ============================================================================
# 2.2 [P1] 滑块视觉优化
# ============================================================================

class TestSliderVisual:
    """Fix 2.2: 滑块宽度增加"""

    def setup_method(self):
        self.content = read_file(GM_CONSOLE_JSX)

    def test_slider_width_w28(self):
        assert "w-28" in self.content, \
            "滑块应使用 w-28 宽度"

    def test_no_old_w20(self):
        # Check range input specifically
        lines = self.content.split('\n')
        for line in lines:
            if 'type="range"' in line or 'type=\\"range\\"' in line:
                assert "w-20" not in line, "range input 不应使用旧的 w-20"


# ============================================================================
# 2.3 [P0] GM Console WS 事件链路
# ============================================================================

class TestGmConsoleWsEventChain:
    """Fix 2.3: GM Console WS 事件链路修复"""

    def setup_method(self):
        self.frontend = read_file(GM_CONSOLE_JSX)
        self.backend = read_file(GM_MAIN_PY)
        self.hub = read_file(HUB_API_PY)

    def test_broadcast_event_proper_except(self):
        assert "except Exception as e:" in self.backend, \
            "broadcast_event 应使用 except Exception as e 而非 bare except"

    def test_broadcast_event_logs_error(self):
        assert "WS 广播失败" in self.backend, \
            "broadcast_event 应记录错误日志"

    def test_no_bare_except_in_broadcast(self):
        # Find broadcast_event function and check no bare except
        lines = self.backend.split('\n')
        in_broadcast = False
        for line in lines:
            if 'async def broadcast_event' in line:
                in_broadcast = True
            if in_broadcast and line.strip() == 'except:':
                pytest.fail("broadcast_event 不应有 bare except")
            if in_broadcast and line.strip() and not line.startswith(' ') and 'async def broadcast_event' not in line:
                break

    def test_frontend_ws_status_state(self):
        assert "wsStatus" in self.frontend, \
            "前端应有 WS 连接状态"

    def test_frontend_ws_status_connected(self):
        assert "setWsStatus('connected')" in self.frontend, \
            "WS 连接成功时应设置 connected 状态"

    def test_frontend_ws_status_disconnected(self):
        assert "setWsStatus('disconnected')" in self.frontend, \
            "WS 断开时应设置 disconnected 状态"

    def test_frontend_ws_status_indicator(self):
        assert "已连接" in self.frontend and "已断开" in self.frontend, \
            "前端应显示连接状态文字"

    def test_fallback_interval_3s(self):
        assert "fetchDataHttp, 3000)" in self.frontend, \
            "HTTP fallback 轮询应为 3 秒"

    def test_no_10s_fallback(self):
        assert "fetchDataHttp, 10000)" not in self.frontend, \
            "不应有旧的 10 秒 fallback"
