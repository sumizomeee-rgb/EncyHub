"""GM Console 注入目标与 RuntimeGM 图标回归测试。"""

import ast
import os


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_repo_file(*parts):
    path = os.path.join(BASE_DIR, *parts)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def test_runtime_gm_inject_targets_only_dedicated_launch_shells():
    source = _read_repo_file("tools", "gm_console", "inject_runtime_gm.py")
    tree = ast.parse(source)
    targets = None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for assign_target in node.targets:
                if isinstance(assign_target, ast.Name) and assign_target.id == "TARGET_LUA_FILES":
                    targets = ast.literal_eval(node.value)
                    break

    assert targets == [
        r"F:\HaruTrunk\Product\Lua\Launch\XLaunchRuntimeGmInject.lua",
    ]
    assert "HaruBranch_Bar" not in source
    assert "HaruBranchV4.8" not in source
    assert r"Product\Lua\Launch\XLaunchModule.lua" not in source
    assert source.count(r"Product\Lua\Launch\XLaunchRuntimeGmInject.lua") == 1


def test_runtime_gm_inject_creates_dedicated_shell_when_missing(tmp_path):
    from tools.gm_console.inject_runtime_gm import inject_one

    target = tmp_path / "Product" / "Lua" / "Launch" / "XLaunchRuntimeGmInject.lua"
    target.parent.mkdir(parents=True)

    ok, info = inject_one(str(target), "print('runtime gm')", 12581)

    assert ok, info
    content = target.read_text(encoding="utf-8")
    assert "EncyHub RuntimeGM 注入占位文件" in content
    assert "[EncyHub] RuntimeGMClient Auto-Injected" in content
    assert "print('runtime gm')" in content


def test_runtime_gm_inject_replaces_legacy_raw_runtime_instead_of_appending(tmp_path, monkeypatch):
    from tools.gm_console import inject_runtime_gm

    monkeypatch.setattr(inject_runtime_gm, "svn_revert", lambda _: False)
    inject_one = inject_runtime_gm.inject_one

    target = tmp_path / "Product" / "Lua" / "Launch" / "XLaunchRuntimeGmInject.lua"
    target.parent.mkdir(parents=True)
    target.write_text(
        "local function StartRuntimeGM() end\n"
        "local gmClient = StartRuntimeGM()\n"
        "gmClient.Start(gmClient.Host, gmClient.Port)\n" * 2,
        encoding="utf-8",
    )

    ok, info = inject_one(str(target), "print('new runtime gm')", 12581)

    assert ok, info
    content = target.read_text(encoding="utf-8")
    assert "已替换旧式裸 RuntimeGM" in info
    assert content.count("StartRuntimeGM") == 0
    assert content.count("print('new runtime gm')") == 1
    assert content.count("[EncyHub] RuntimeGMClient Auto-Injected") == 1


def test_runtime_gm_inject_removes_legacy_runtime_before_existing_marker(tmp_path, monkeypatch):
    from tools.gm_console import inject_runtime_gm

    monkeypatch.setattr(inject_runtime_gm, "svn_revert", lambda _: False)
    AUTO_INJECT_SEPARATOR = inject_runtime_gm.AUTO_INJECT_SEPARATOR
    inject_one = inject_runtime_gm.inject_one

    target = tmp_path / "Product" / "Lua" / "Launch" / "XLaunchRuntimeGmInject.lua"
    target.parent.mkdir(parents=True)
    target.write_text(
        "local function StartRuntimeGM() end\n"
        "gmClient.Start(gmClient.Host, gmClient.Port)\n"
        + AUTO_INJECT_SEPARATOR
        + "print('old injected runtime')\n",
        encoding="utf-8",
    )

    ok, info = inject_one(str(target), "print('new runtime gm')", 12581)

    assert ok, info
    content = target.read_text(encoding="utf-8")
    assert "已清理旧运行时并替换注入块" in info
    assert "StartRuntimeGM" not in content
    assert "old injected runtime" not in content
    assert content.count("print('new runtime gm')") == 1


def test_runtime_gm_inject_reverts_before_reading_existing_target(tmp_path, monkeypatch):
    from tools.gm_console import inject_runtime_gm

    target = tmp_path / "Product" / "Lua" / "Launch" / "XLaunchRuntimeGmInject.lua"
    target.parent.mkdir(parents=True)
    target.write_text("dirty runtime", encoding="utf-8")
    calls = []

    def fake_revert(path):
        calls.append(path)
        target.write_text("clean svn base", encoding="utf-8")
        return True

    monkeypatch.setattr(inject_runtime_gm, "svn_revert", fake_revert)
    ok, info = inject_runtime_gm.inject_one(str(target), "print('runtime gm')", 12581)

    assert ok, info
    assert calls == [str(target)]
    content = target.read_text(encoding="utf-8")
    assert content.startswith("clean svn base")
    assert "dirty runtime" not in content
    assert "已 SVN revert" in info


def test_runtime_gm_bridge_button_icon_stays_simple():
    source = _read_repo_file("frontend", "src", "pages", "GmConsole.jsx")
    start = source.index("function RuntimeGmBridgeIcon")
    end = source.index("const LOG_TYPE_FILTERS", start)
    icon_source = source[start:end]

    assert 'viewBox="0 0 24 24"' in icon_source
    assert icon_source.count("<path") <= 3


def test_sidebar_waits_for_width_transition_before_showing_expanded_content():
    source = _read_repo_file("frontend", "src", "pages", "GmConsole.jsx")

    assert "sidebarContentExpanded" in source
    assert "setSidebarCollapsed(false)" in source
    assert "setTimeout(() => setSidebarContentExpanded(true), 280)" in source
    assert "setSidebarContentExpanded(false)" in source
    assert "onClick={toggleSidebar}" in source
