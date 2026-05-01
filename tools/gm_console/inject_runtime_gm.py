"""
inject_runtime_gm.py — 一键注入 RuntimeGMClient 到游戏 Lua 入口文件

使用方法:
  1. 修改下方 TARGET_LUA_FILE 为你的 Lua 入口文件绝对路径
  2. 修改下方 GM_HOST / GM_PORT 为你运行 EncyHub 的电脑 IP 和端口
  3. 运行: python inject_runtime_gm.py

脚本会:
  1. 对目标文件执行 svn revert（还原到干净状态）
  2. 从 README_RuntimeGM_Client.md 中提取 Lua 代码块
  3. 替换代码中的 IP 和端口为你的配置
  4. 追加到目标文件末尾
"""

import os
import re
import subprocess
import sys

# ============================================================
# ★★★ 修改这里 ★★★
# ============================================================

# 目标 Lua 文件的绝对路径
TARGET_LUA_FILE = r"F:\HaruTrunk\Product\Lua\Launch\XLaunchModule.lua"

# EncyHub GM Console 的连接地址
GM_HOST = "10.101.0.8"
GM_PORT = 12581

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


def main():
    if not os.path.isfile(TARGET_LUA_FILE):
        print(f"[ERROR] 目标文件不存在: {TARGET_LUA_FILE}")
        sys.exit(1)

    if not os.path.isfile(README_PATH):
        print(f"[ERROR] README 不存在: {README_PATH}")
        sys.exit(1)

    # 1. svn revert
    svn_revert(TARGET_LUA_FILE)

    # 2. 提取 Lua 代码
    lua_code = extract_lua_from_readme(README_PATH)
    print(f"[EXTRACT] 提取了 {len(lua_code)} 字符的 Lua 代码")

    # 3. 替换 IP/端口
    lua_code = patch_host_port(lua_code, GM_HOST, GM_PORT)

    # 4. 追加到目标文件
    with open(TARGET_LUA_FILE, "r", encoding="utf-8") as f:
        original = f.read()

    separator = "\n\n-- ========== [EncyHub] RuntimeGMClient Auto-Injected ==========\n\n"

    with open(TARGET_LUA_FILE, "w", encoding="utf-8") as f:
        f.write(original.rstrip("\n"))
        f.write(separator)
        f.write(lua_code)
        f.write("\n")

    final_lines = original.count("\n") + separator.count("\n") + lua_code.count("\n") + 1
    print(f"[DONE] 已注入到 {TARGET_LUA_FILE}")
    print(f"       原始 {original.count(chr(10))+1} 行 → 注入后 ~{final_lines} 行")
    print(f"       连接地址: {GM_HOST}:{GM_PORT}")


if __name__ == "__main__":
    main()
