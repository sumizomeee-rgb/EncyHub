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


def test_runtime_gm_queries_svn_by_working_copy_and_reports_structured_fields():
    content = read_file(RUNTIME_GM_LUA)

    assert "CS.XExternalTool" in content
    assert "RunToolInNewThread" in content
    assert "info --xml" in content
    assert "GetCurrentSvnBranch(info.url)" in content
    assert 'svnInfoXml:match(\'<entry.-revision="(%d+)"\')' in content
    assert 'txt:match("svn:realmstring\\nV (%d+)\\n([^\\n]+)")' in content
    assert "realmOrigin == urlOrigin" in content
    assert 'svn_author = RuntimeGMClient.SvnAuthor or ""' in content
    assert 'svn_url = RuntimeGMClient.SvnUrl or ""' in content
    assert 'svn_branch = RuntimeGMClient.SvnBranch or ""' in content
    assert 'svn_revision = RuntimeGMClient.SvnRevision or ""' in content


def test_build_runtime_gm_code_patches_host_and_port():
    from tools.gm_console.runtime_gm_code import build_runtime_gm_code

    code = build_runtime_gm_code("192.168.31.24", 12666)

    assert 'RuntimeGMClient.Host = "192.168.31.24"' not in code
    assert "RuntimeGMClient.Port = 12666" not in code
    assert 'RuntimeGMClient.Host = "localhost"' in code
    assert 'gmClient.Start("192.168.31.24", 12666)' in code


def test_patch_runtime_gm_code_rejects_source_without_start_call():
    from tools.gm_console.runtime_gm_code import patch_runtime_gm_code

    with pytest.raises(ValueError, match="未找到 gmClient.Start"):
        patch_runtime_gm_code("print('missing start')", "192.168.31.24", 12581)


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


def test_download_target_relative_path_follows_first_inject_target():
    from tools.gm_console.inject_runtime_gm import get_primary_target_relative_path

    relative_path = get_primary_target_relative_path([
        r"F:\HaruTrunk\Product\Lua\Launch\XLaunchRuntimeGmInject.lua",
        r"F:\HaruBranchV4.8\Product\Lua\Launch\TemporaryRuntimeGm.lua",
    ])

    assert relative_path == r"Product\Lua\Launch\XLaunchRuntimeGmInject.lua"


def test_download_target_relative_path_requires_product_lua_marker():
    from tools.gm_console.inject_runtime_gm import get_primary_target_relative_path

    with pytest.raises(ValueError, match="不包含 Product/Lua"):
        get_primary_target_relative_path([r"F:\HaruTrunk\Dev\Client\Wrong.lua"])


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
    assert '"runtimeGmDownload"' in content
    assert "get_primary_target_relative_path()" in content
    assert '"targetPath"' not in content


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
    assert "new Blob([code]" in content
    assert "下载替换文件" in content
    assert "<目标客户端 HaruRoot>" in content
    assert "你想接入当前 GM Console 的那份客户端工程根目录" in content
    assert "copyText(downloadInfo.relativePath)" in content
    assert "downloadInfo.targetPath" not in content
    assert "haruRootInfo={haruRootInfo}" in content
    assert "XLaunchRuntimeGmInject.lua" not in content


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


def test_hierarchy_manual_refresh_preserves_expanded_tree_state():
    content = read_file(HIERARCHY_JSX)

    assert "const refreshTreePreservingView = useCallback" in content
    assert "const expandedIds = [...expandedRef.current]" in content
    assert "await refreshLoadedChildrenSequentially(expandedIds)" in content
    assert "onClick={() => refreshTreePreservingView()}" in content
    assert "onClick={() => loadTree({ reset: true })}" not in content


def test_hierarchy_go_search_requires_enter_to_submit():
    content = read_file(HIERARCHY_JSX)

    assert "const [goSearchQuery, setGoSearchQuery] = useState('')" in content
    assert "const submitGoSearch = useCallback" in content
    assert "const q = goSearchQuery.trim()" in content
    assert "if (e.key === 'Enter') submitGoSearch()" in content
    assert "[goSearchQuery, selectedClient?.id, wsConnected, request]" in content
    assert "[filterText, selectedClient?.id, wsConnected, request]" not in content


def test_lua_ui_root_locate_falls_back_to_common_root_go_fields():
    content = read_file(RUNTIME_GM_LUA)

    assert "local function tryResolveGo(candidate)" in content
    assert 'local keys = { "GameObject", "Transform", "Obj", "gameObject", "transform" }' in content
    assert "go = tryResolveGo(target)" in content
    assert 'packet.path = "GameObject"' in content
