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


def test_runtime_gm_inject_replaces_legacy_raw_runtime_instead_of_appending(tmp_path):
    from tools.gm_console.inject_runtime_gm import inject_one

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


def test_runtime_gm_bridge_button_icon_stays_simple():
    source = _read_repo_file("frontend", "src", "pages", "GmConsole.jsx")
    start = source.index("function RuntimeGmBridgeIcon")
    end = source.index("const LOG_TYPE_FILTERS", start)
    icon_source = source[start:end]

    assert 'viewBox="0 0 24 24"' in icon_source
    assert icon_source.count("<path") <= 3
