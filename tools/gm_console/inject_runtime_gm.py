"""
inject_runtime_gm.py — 一键注入 RuntimeGMClient 到游戏 Lua 入口文件

使用方法:
  1. 在下方 TARGET_LUA_FILES 列表中维护要注入的 Lua 入口文件路径（支持多分支）
     - 临时跳过某个分支：把对应行注释掉即可
     - 所有分支统一连同一个固定握手端口 GM_PORT（多设备靠 IP+pid 会话标识区分，可同时挂载）
  2. 修改下方 GM_HOST / GM_PORT 为你运行 EncyHub 的电脑 IP 和握手端口
  3. 运行: python inject_runtime_gm.py

脚本会对列表里的每个文件依次执行:
  1. svn revert（还原到干净状态）
  2. 从 README_RuntimeGM_Client.md 中提取 Lua 代码块（仅一次）
  3. 替换代码中的 IP 和端口为你的配置（所有分支统一为 GM_PORT）
  4. 追加到目标文件末尾
单文件失败（缺失/IO 错误）不会阻断后续文件，最终输出汇总。
"""

import os
import re
import subprocess
import sys

# ============================================================
# ★★★ 修改这里 ★★★
# ============================================================

# 目标 Lua 文件的绝对路径列表 — 添加/注释行即可增减分支
TARGET_LUA_FILES = [
    r"F:\HaruTrunk\Product\Lua\Launch\XLaunchModule.lua",
    r"E:\WorkProject\branches\HaruBranchV4.7_w_FullDev\Product\Lua\Launch\XLaunchModule.lua",
    # r"F:\HaruBranch_Bar\Product\Lua\Launch\XLaunchModule.lua",
]

# EncyHub GM Console 的连接地址
GM_HOST = "10.101.0.8"
GM_PORT = 12581  # 固定握手端口：所有分支 / 所有设备统一连接此端口

# ============================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
README_PATH = os.path.join(SCRIPT_DIR, "README_RuntimeGM_Client.md")


def extract_lua_from_readme(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    match = re.search(r"```lua\n(.*?)```", content, re.DOTALL)
    if not match:
        # fallback: 从 ```lua 到文件末尾
        idx = content.find("```lua\n")
        if idx == -1:
            print("[ERROR] README 中未找到 ```lua 代码块")
            sys.exit(1)
        lua_code = content[idx + len("```lua\n"):]
        # 去掉末尾可能的 ```
        if lua_code.rstrip().endswith("```"):
            lua_code = lua_code.rstrip()[:-3]
    else:
        lua_code = match.group(1)

    return lua_code


def patch_host_port(lua_code: str, host: str, port: int) -> str:
    # 替换 Start("x.x.x.x", 12581) 中的 IP 和端口
    lua_code = re.sub(
        r'(gmClient\.Start\()"[^"]*",\s*\d+\)',
        rf'\1"{host}", {port})',
        lua_code,
    )
    # 也替换 RuntimeGMClient.Host / .Port 默认值（如果存在）
    lua_code = re.sub(
        r'(RuntimeGMClient\.Host\s*=\s*)"[^"]*"',
        rf'\1"{host}"',
        lua_code,
    )
    lua_code = re.sub(
        r'(RuntimeGMClient\.Port\s*=\s*)\d+',
        rf'\g<1>{port}',
        lua_code,
    )
    return lua_code


def svn_revert(filepath: str):
    print(f"[SVN] revert {filepath}")
    try:
        result = subprocess.run(
            ["svn", "revert", filepath],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            print(f"[SVN] OK: {result.stdout.strip() or 'reverted'}")
        else:
            stderr = result.stderr.strip()
            if "is not a working copy" in stderr or "is not under version control" in stderr:
                print(f"[SVN] 跳过（非 SVN 工作副本）: {stderr}")
            else:
                print(f"[SVN] 警告: {stderr}")
    except FileNotFoundError:
        print("[SVN] 未找到 svn 命令，跳过 revert")
    except subprocess.TimeoutExpired:
        print("[SVN] revert 超时，跳过")


def inject_one(target: str, base_lua_code: str, host: str, port: int) -> tuple[bool, str]:
    """对单个目标文件执行注入。返回 (成功?, 描述)。失败时只记录、不抛异常。"""
    if not os.path.isfile(target):
        return False, "文件不存在"

    try:
        svn_revert(target)
        # 所有分支统一 patch 成固定握手端口（多设备靠 IP+pid 区分，无需按分支分端口）
        lua_code = patch_host_port(base_lua_code, host, port)
        with open(target, "r", encoding="utf-8") as f:
            original = f.read()

        separator = "\n\n-- ========== [EncyHub] RuntimeGMClient Auto-Injected ==========\n\n"
        with open(target, "w", encoding="utf-8") as f:
            f.write(original.rstrip("\n"))
            f.write(separator)
            f.write(lua_code)
            f.write("\n")

        return True, f"原 {original.count(chr(10))+1} 行 → +{lua_code.count(chr(10))+1} 行 @ port {port}"
    except Exception as e:
        return False, f"IO 错误: {e}"


def main():
    targets = [p for p in TARGET_LUA_FILES if p]  # 过滤空字符串
    if not targets:
        print("[ERROR] TARGET_LUA_FILES 为空，请至少配置一个目标文件")
        sys.exit(1)

    if not os.path.isfile(README_PATH):
        print(f"[ERROR] README 不存在: {README_PATH}")
        sys.exit(1)

    # 提取一次（所有目标共享同一份原始 Lua，统一 patch 成固定握手端口）
    base_lua_code = extract_lua_from_readme(README_PATH)
    print(f"[EXTRACT] 提取了 {len(base_lua_code)} 字符的 Lua 代码")
    print(f"[PLAN] {len(targets)} 个目标文件，统一握手端口 {GM_PORT}（多设备靠 IP+pid 区分）")
    print()

    results = []
    for i, target in enumerate(targets):
        print(f"--- [{i+1}/{len(targets)}] {target}  (port={GM_PORT}) ---")
        ok, info = inject_one(target, base_lua_code, GM_HOST, GM_PORT)
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
    print(f"连接地址: {GM_HOST}:{GM_PORT}")

    # 全部失败时返回非零退出码，便于脚本化串联
    if ok_count == 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
