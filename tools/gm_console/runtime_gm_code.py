"""
RuntimeGM Lua 代码读取与连接地址生成。
"""
import ipaddress
import os
import re
import socket
import subprocess
from functools import lru_cache


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_GM_LUA_PATH = os.path.join(SCRIPT_DIR, "runtime_gm_client.lua")


def read_runtime_gm_source(path: str = RUNTIME_GM_LUA_PATH) -> str:
    """读取唯一权威 RuntimeGM Lua 源文件。"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _is_usable_ipv4(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return (
        ip.version == 4
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_multicast
        and not ip.is_unspecified
    )


def _pick_preferred_ipv4(candidates: list[str]) -> str:
    usable = []
    seen = set()
    for candidate in candidates:
        if candidate in seen or not _is_usable_ipv4(candidate):
            continue
        seen.add(candidate)
        usable.append(candidate)
    if not usable:
        raise ValueError("未检测到可用 LAN IPv4")

    private_ips = [ip for ip in usable if ipaddress.ip_address(ip).is_private]
    return (private_ips or usable)[0]


def _parse_ipconfig_ipv4(ipconfig_output: str) -> list[str]:
    return re.findall(r"IPv4[^\r\n:]*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})", ipconfig_output)


def _detect_local_lan_ip_uncached(ipconfig_output: str | None = None, include_socket: bool = True) -> str:
    candidates = []
    if ipconfig_output is None:
        try:
            result = subprocess.run(
                ["ipconfig"],
                capture_output=True,
                text=True,
                encoding="mbcs",
                errors="ignore",
                timeout=3,
            )
            ipconfig_output = result.stdout or ""
        except (FileNotFoundError, subprocess.SubprocessError, LookupError):
            ipconfig_output = ""

    candidates.extend(_parse_ipconfig_ipv4(ipconfig_output or ""))

    if include_socket:
        try:
            candidates.extend(socket.gethostbyname_ex(socket.gethostname())[2])
        except OSError:
            pass

    return _pick_preferred_ipv4(candidates)


@lru_cache(maxsize=1)
def _detect_local_lan_ip_cached() -> str:
    return _detect_local_lan_ip_uncached()


def detect_local_lan_ip(ipconfig_output: str | None = None, include_socket: bool = True) -> str:
    """探测当前部署机的 LAN IPv4，默认结果缓存，避免高频请求反复调用 ipconfig。"""
    if ipconfig_output is None and include_socket:
        return _detect_local_lan_ip_cached()
    return _detect_local_lan_ip_uncached(ipconfig_output, include_socket)


def _normalize_host(host: str) -> str:
    host = (host or "").strip()
    if not host:
        raise ValueError("host 不能为空")
    if "\n" in host or "\r" in host:
        raise ValueError("host 不能包含换行")
    return host.replace("\\", "\\\\").replace('"', '\\"')


def _normalize_port(port: int | str) -> int:
    try:
        normalized = int(port)
    except (TypeError, ValueError) as exc:
        raise ValueError("port 必须是整数") from exc
    if normalized < 1 or normalized > 65535:
        raise ValueError("port 必须在 1-65535 之间")
    return normalized


def patch_runtime_gm_code(lua_code: str, host: str, port: int | str) -> str:
    """把 RuntimeGM 源码末尾启动参数替换成目标连接地址。"""
    normalized_host = _normalize_host(host)
    normalized_port = _normalize_port(port)

    patched, count = re.subn(
        r'gmClient\.Start\(\s*gmClient\.Host\s*,\s*gmClient\.Port\s*\)',
        f'gmClient.Start("{normalized_host}", {normalized_port})',
        lua_code,
        count=1,
    )
    if count:
        return patched

    patched, count = re.subn(
        r'(gmClient\.Start\()"[^"]*",\s*\d+\)',
        lambda m: f'{m.group(1)}"{normalized_host}", {normalized_port})',
        lua_code,
        count=1,
    )
    if count:
        return patched

    raise ValueError("RuntimeGM 源码中未找到 gmClient.Start 启动调用")


def build_runtime_gm_code(host: str, port: int | str = 12581) -> str:
    """读取权威 Lua 源并生成可直接粘贴的 RuntimeGM 代码。"""
    return patch_runtime_gm_code(read_runtime_gm_source(), host, port)
