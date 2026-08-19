"""
inject_runtime_gm.py — 一键注入 RuntimeGMClient 到游戏 Launch 空壳 Lua 文件

使用方法:
  1. 在下方 TARGET_LUA_FILES 列表中维护要注入的 Launch 空壳 Lua 文件路径
     - 所有分支统一连同一个固定握手端口 GM_PORT（多设备靠 IP+pid 会话标识区分，可同时挂载）
  2. 自动探测本机 LAN IPv4，并写入 RuntimeGM 连接地址
  3. 运行: python inject_runtime_gm.py

脚本会对列表里的每个文件依次执行:
  0. 目标文件不存在但父目录存在时，先创建专用注入空壳
  1. 移除旧的 EncyHub RuntimeGM 注入块（不回滚入口文件本身）
  2. 读取 runtime_gm_client.lua 权威 Lua 源文件
  3. 替换代码中的 IP 和端口为你的配置（所有分支统一为 GM_PORT）
  4. 追加到目标文件末尾
单文件失败（缺失/IO 错误）不会阻断后续文件，最终输出汇总。
"""

import os
import subprocess
import sys
from pathlib import PureWindowsPath

try:
    from .runtime_gm_code import RUNTIME_GM_LUA_PATH, build_runtime_gm_code, detect_local_lan_ip, read_runtime_gm_source
except ImportError:
    from runtime_gm_code import RUNTIME_GM_LUA_PATH, build_runtime_gm_code, detect_local_lan_ip, read_runtime_gm_source

# ============================================================
# ★★★ 修改这里 ★★★
# ============================================================

# 目标 Lua 文件的绝对路径列表。
# 注意：这里指向专用注入空壳，不再直接改真实业务启动脚本 XLaunchModule.lua。
TARGET_LUA_FILES = [
    r"F:\HaruTrunk\Product\Lua\Launch\XLaunchRuntimeGmInject.lua",
]

GM_PORT = 12581  # 固定握手端口：所有分支 / 所有设备统一连接此端口

INJECT_SHELL_TEMPLATE = """-- EncyHub RuntimeGM 注入占位文件。
-- XLaunchModule 会通过 pcall(require, "XLaunchRuntimeGmInject") 触发本文件。
-- inject_runtime_gm.py 会把 RuntimeGMClient 代码追加到下方的自动注入块里。
"""

AUTO_INJECT_SEPARATOR = "\n\n-- ========== [EncyHub] RuntimeGMClient Auto-Injected ==========\n\n"


def build_inject_file_content(lua_code: str) -> str:
    """生成可直接覆盖 XLaunchRuntimeGmInject.lua 的完整内容。"""
    return INJECT_SHELL_TEMPLATE.rstrip("\n") + AUTO_INJECT_SEPARATOR + lua_code.rstrip("\n") + "\n"


def get_primary_target_relative_path(targets=None) -> str:
    """从第一条注入路径提取 HaruRoot 下的 Product/Lua 相对路径。"""
    target_list = TARGET_LUA_FILES if targets is None else targets
    if not target_list or not target_list[0]:
        raise ValueError("TARGET_LUA_FILES 第一条路径为空")

    parts = PureWindowsPath(target_list[0]).parts
    for index in range(len(parts) - 1):
        if parts[index].casefold() == "product" and parts[index + 1].casefold() == "lua":
            return str(PureWindowsPath(*parts[index:]))

    raise ValueError("TARGET_LUA_FILES 第一条路径不包含 Product/Lua")


def svn_revert(filepath: str) -> bool:
    """尝试把目标恢复到 SVN 基线；成功返回 True。"""
    print(f"[SVN] revert {filepath}")
    try:
        result = subprocess.run(
            ["svn", "revert", filepath],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            print(f"[SVN] OK: {result.stdout.strip() or 'reverted'}")
            return True
        else:
            stderr = result.stderr.strip()
            if "is not a working copy" in stderr or "is not under version control" in stderr:
                print(f"[SVN] 跳过（非 SVN 工作副本）: {stderr}")
            else:
                print(f"[SVN] 警告: {stderr}")
            return False
    except FileNotFoundError:
        print("[SVN] 未找到 svn 命令，跳过 revert")
        return False
    except subprocess.TimeoutExpired:
        print("[SVN] revert 超时，跳过")
        return False


def inject_one(target: str, lua_code: str, port: int) -> tuple[bool, str]:
    """对单个目标文件执行注入。返回 (成功?, 描述)。失败时只记录、不抛异常。"""
    created_shell = False
    reverted = False
    if not os.path.isfile(target):
        parent = os.path.dirname(target)
        if not os.path.isdir(parent):
            return False, "目录不存在"
        try:
            with open(target, "w", encoding="utf-8", newline="\n") as f:
                f.write(INJECT_SHELL_TEMPLATE)
            created_shell = True
        except Exception as e:
            return False, f"创建空壳失败: {e}"
    else:
        # 必须先恢复 SVN 基线，再读取和追加，避免历史注入内容进入下一次基础文件。
        reverted = svn_revert(target)

    try:
        with open(target, "r", encoding="utf-8") as f:
            original = f.read()

        separator = AUTO_INJECT_SEPARATOR
        is_dedicated_shell = os.path.basename(target).casefold() == "xlaunchruntimegminject.lua"
        has_raw_runtime = "local function StartRuntimeGM()" in original and "gmClient.Start(" in original
        prefix = original.split(separator, 1)[0] if separator in original else original
        legacy_runtime_in_prefix = (
            is_dedicated_shell
            and "local function StartRuntimeGM()" in prefix
            and "gmClient.Start(" in prefix
        )
        if legacy_runtime_in_prefix:
            # 兼容曾经出现的“裸 RuntimeGM + 自动注入块”叠加文件：专用空壳不得保留旧运行时前缀。
            base = INJECT_SHELL_TEMPLATE.rstrip("\n")
        elif separator in original:
            base = prefix.rstrip("\n")
        elif is_dedicated_shell and has_raw_runtime:
            # 兼容旧版网页下载/历史追加产物：专用空壳里已经是裸 RuntimeGM 时，整段替换，不能继续追加。
            base = INJECT_SHELL_TEMPLATE.rstrip("\n")
        else:
            base = original.rstrip("\n")
        with open(target, "w", encoding="utf-8") as f:
            f.write(base)
            f.write(separator)
            f.write(lua_code)
            f.write("\n")

        created = "，已创建空壳文件" if created_shell else ""
        stripped = "，已清理旧运行时并替换注入块" if legacy_runtime_in_prefix else ("，已替换旧注入块" if separator in original else "")
        if is_dedicated_shell and has_raw_runtime and separator not in original:
            stripped = "，已替换旧式裸 RuntimeGM"
        reverted_text = "，已 SVN revert" if reverted else ""
        return True, f"原 {original.count(chr(10))+1} 行 → 基础 {base.count(chr(10))+1} 行 +{lua_code.count(chr(10))+1} 行 @ port {port}{created}{reverted_text}{stripped}"
    except Exception as e:
        return False, f"IO 错误: {e}"


def main():
    targets = [p for p in TARGET_LUA_FILES if p]  # 过滤空字符串
    if not targets:
        print("[ERROR] TARGET_LUA_FILES 为空，请至少配置一个目标文件")
        sys.exit(1)

    if not os.path.isfile(RUNTIME_GM_LUA_PATH):
        print(f"[ERROR] RuntimeGM Lua 源文件不存在: {RUNTIME_GM_LUA_PATH}")
        sys.exit(1)

    # 读取一次，所有目标共享同一份生成后的 Lua，统一 patch 成固定握手端口
    base_lua_code = read_runtime_gm_source()
    resolved_host = detect_local_lan_ip()
    lua_code = build_runtime_gm_code(resolved_host, GM_PORT)
    print(f"[SOURCE] 读取了 {len(base_lua_code)} 字符的 RuntimeGM Lua 代码")
    print(f"[PLAN] {len(targets)} 个目标文件，连接地址 {resolved_host}:{GM_PORT}（多设备靠 IP+pid 区分）")
    print()

    results = []
    for i, target in enumerate(targets):
        print(f"--- [{i+1}/{len(targets)}] {target}  (port={GM_PORT}) ---")
        ok, info = inject_one(target, lua_code, GM_PORT)
        results.append((target, GM_PORT, ok, info))
        print(f"[{'DONE' if ok else 'SKIP'}] {info}\n")

    # 汇总
    ok_count = sum(1 for _, _, ok, _ in results if ok)
    print("=" * 60)
    print(f"汇总: 成功 {ok_count}/{len(results)}")
    for target, port, ok, info in results:
        # 用 ASCII 标记避免 Windows GBK 控制台 UnicodeEncodeError
        flag = "[OK]" if ok else "[FAIL]"
        print(f"  {flag} [port {port}] {target}  ({info})")
    print(f"连接地址: {resolved_host}:{GM_PORT}")

    # 全部失败时返回非零退出码，便于脚本化串联
    if ok_count == 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
