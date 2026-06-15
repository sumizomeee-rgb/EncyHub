"""
GM Console RuntimeGM 代码来源与复制接口回归测试。
"""
import os
import sys
import pytest


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

GM_MAIN_PY = os.path.join(BASE_DIR, "tools", "gm_console", "main.py")
INJECT_RUNTIME_GM_PY = os.path.join(BASE_DIR, "tools", "gm_console", "inject_runtime_gm.py")
RUNTIME_GM_LUA = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
RUN_INJECT_RUNTIME_GM_BAT = os.path.join(BASE_DIR, "tools", "gm_console", "run_inject_runtime_gm.bat")
GM_CONSOLE_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "GmConsole.jsx")
ANIMATOR_VIEWER_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "AnimatorViewer.jsx")
LUA_UI_INSPECTOR_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "LuaUiInspector.jsx")
HIERARCHY_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "Hierarchy.jsx")
TIMELINE_MONITOR_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "TimelineMonitor.jsx")


def read_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def test_runtime_gm_lua_is_the_authoritative_source():
    assert os.path.isfile(RUNTIME_GM_LUA)
    content = read_file(RUNTIME_GM_LUA)
    assert "local function StartRuntimeGM()" in content
    assert "RuntimeGMClient.Host" in content
    assert "RuntimeGMClient.Port" in content
    assert "gmClient.Start(" in content
    assert "```lua" not in content
    assert "10.101.0.8" not in content
    assert 'gmClient.Start(gmClient.Host, gmClient.Port)' in content


def test_build_runtime_gm_code_patches_host_and_port():
    from tools.gm_console.runtime_gm_code import build_runtime_gm_code

    code = build_runtime_gm_code("192.168.31.24", 12666)

    assert 'RuntimeGMClient.Host = "192.168.31.24"' not in code
    assert "RuntimeGMClient.Port = 12666" not in code
    assert 'RuntimeGMClient.Host = "localhost"' in code
    assert 'gmClient.Start("192.168.31.24", 12666)' in code


def test_detect_local_lan_ip_parses_windows_ipconfig():
    from tools.gm_console.runtime_gm_code import detect_local_lan_ip

    ipconfig_output = """
Windows IP 配置


以太网适配器 以太网 2:

   连接特定的 DNS 后缀 . . . . . . . :
   本地链接 IPv6 地址. . . . . . . . : fe80::ab67:e8ad:8818:a042%13
   IPv4 地址 . . . . . . . . . . . . : 10.101.0.8
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 10.101.0.254
"""

    assert detect_local_lan_ip(ipconfig_output=ipconfig_output) == "10.101.0.8"


def test_detect_local_lan_ip_does_not_fallback_to_localhost():
    from tools.gm_console.runtime_gm_code import detect_local_lan_ip

    with pytest.raises(ValueError, match="未检测到可用 LAN IPv4"):
        detect_local_lan_ip(ipconfig_output="", include_socket=False)


def test_detect_local_lan_ip_caches_auto_detection(monkeypatch):
    import tools.gm_console.runtime_gm_code as runtime_gm_code

    runtime_gm_code._detect_local_lan_ip_cached.cache_clear()
    calls = []

    class Result:
        stdout = "IPv4 地址 . . . . . . . . . . . . : 10.101.0.8"

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return Result()

    monkeypatch.setattr(runtime_gm_code.subprocess, "run", fake_run)

    try:
        assert runtime_gm_code.detect_local_lan_ip() == "10.101.0.8"
        assert runtime_gm_code.detect_local_lan_ip() == "10.101.0.8"
        assert len(calls) == 1
    finally:
        runtime_gm_code._detect_local_lan_ip_cached.cache_clear()


def test_build_runtime_gm_code_uses_detected_host():
    from tools.gm_console.runtime_gm_code import build_runtime_gm_code, detect_local_lan_ip

    detected_host = detect_local_lan_ip(ipconfig_output="IPv4 地址 . . . . . . . . . . . . : 10.101.0.8")
    code = build_runtime_gm_code(detected_host, 12581)

    assert 'RuntimeGMClient.Host = "10.101.0.8"' not in code
    assert 'gmClient.Start("10.101.0.8", 12581)' in code


def test_inject_script_uses_runtime_lua_source_not_readme():
    content = read_file(INJECT_RUNTIME_GM_PY)

    assert "runtime_gm_client.lua" in content
    assert "build_runtime_gm_code" in content
    assert "detect_local_lan_ip" in content
    assert "GM_HOST" not in content
    assert 'GM_HOST = "10.101.0.8"' not in content
    assert "extract_lua_from_readme" not in content
    assert "README_RuntimeGM_Client" not in content


def test_run_inject_runtime_gm_bat_executes_inject_script():
    assert os.path.isfile(RUN_INJECT_RUNTIME_GM_BAT)
    content = read_file(RUN_INJECT_RUNTIME_GM_BAT)

    assert "inject_runtime_gm.py" in content
    assert ".venv\\Scripts\\python.exe" in content
    assert "pushd" in content
    assert "pause" in content


def test_main_exposes_runtime_gm_code_endpoint():
    content = read_file(GM_MAIN_PY)

    assert '@app.get("/runtime-gm-code")' in content
    assert "build_runtime_gm_code" in content
    assert "detect_local_lan_ip" in content
    assert 'host: str = "localhost"' not in content


def test_frontend_exposes_runtime_gm_code_modal():
    content = read_file(GM_CONSOLE_JSX)

    assert "RuntimeGmCodeModal" in content
    assert "runtime-gm-code" in content
    assert "copyText(code)" in content
    assert "RuntimeGmBridgeIcon" in content
    assert "粘贴到客户端 Lua 入口文件" in content
    assert "window.location.hostname" not in content
    assert "cachedHostRef" in content
    assert "useEffect(() => {\n    loadRuntimeGmCode(false)" not in content


def test_animator_viewer_is_idle_when_tab_inactive():
    content = read_file(ANIMATOR_VIEWER_JSX)

    assert "if (!active || !selectedClient) return" in content
    assert "if (!active) return" in content
    assert "[selectedClient?.id, active]" in content


def test_hidden_monitor_tabs_do_not_open_websockets():
    inspector = read_file(LUA_UI_INSPECTOR_JSX)
    hierarchy = read_file(HIERARCHY_JSX)
    timeline = read_file(TIMELINE_MONITOR_JSX)

    assert "useInspectorWs(selectedClient, active)" in inspector
    assert "if (!active || !selectedClient) return" in inspector
    assert "[selectedClient?.id, active]" in inspector

    assert "useHierarchyWs(selectedClient, active)" in hierarchy
    assert "if (!active || !selectedClient) return" in hierarchy
    assert "[selectedClient?.id, active]" in hierarchy

    assert "if (!active || !selectedClient) return" in timeline
    assert "[selectedClient?.id, active]" in timeline


def test_hierarchy_manual_refresh_clears_cached_children_and_selection():
    content = read_file(HIERARCHY_JSX)

    assert "const resetTreeViewState = useCallback" in content
    assert "childrenMapRef.current = {}" in content
    assert "expandedRef.current = new Set()" in content
    assert "setSelectedId(null)" in content
    assert "setGoDetail(null)" in content
    assert "onClick={() => loadTree({ reset: true })}" in content


def test_lua_ui_root_locate_falls_back_to_common_root_go_fields():
    content = read_file(RUNTIME_GM_LUA)

    assert "local function tryResolveGo(candidate)" in content
    assert 'local keys = { "GameObject", "Transform", "Obj", "gameObject", "transform" }' in content
    assert "go = tryResolveGo(target)" in content
    assert 'packet.path = "GameObject"' in content
