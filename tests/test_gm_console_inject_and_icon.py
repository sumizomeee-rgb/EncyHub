"""GM Console 注入目标与 RuntimeGM 图标回归测试。"""

import ast
import os


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_repo_file(*parts):
    path = os.path.join(BASE_DIR, *parts)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def test_runtime_gm_inject_targets_only_required_launch_modules():
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
        r"F:\HaruTrunk\Product\Lua\Launch\XLaunchModule.lua",
        r"E:\WorkProject\branches\HaruBranchV4.8_w_FullDev\Product\Lua\Launch\XLaunchModule.lua",
    ]
    assert "HaruBranch_Bar" not in source
    assert source.count(r"Product\Lua\Launch\XLaunchModule.lua") == 2


def test_runtime_gm_bridge_button_icon_stays_simple():
    source = _read_repo_file("frontend", "src", "pages", "GmConsole.jsx")
    start = source.index("function RuntimeGmBridgeIcon")
    end = source.index("const LOG_TYPE_FILTERS", start)
    icon_source = source[start:end]

    assert 'viewBox="0 0 24 24"' in icon_source
    assert icon_source.count("<path") <= 3
