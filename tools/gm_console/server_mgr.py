"""
GM Console - 服务器管理模块
从原 gm_console.py 提取的核心逻辑
"""
import asyncio
import json
import socket
import os
import sys
import time
from datetime import datetime
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Callable, Tuple

import psutil


@dataclass
class Client:
    """客户端连接"""
    id: str
    port: int
    writer: asyncio.StreamWriter
    ip: str = ""
    device: str = "Unknown"
    platform: str = "Unknown"
    pid: int = 0
    package_name: str = ""
    persistent_data_path: str = ""
    app_version: str = ""
    svn_author: str = ""
    svn_url: str = ""
    svn_branch: str = ""
    svn_revision: str = ""
    svn_detection: str = ""
    gm_tree: List[Any] = field(default_factory=list)
    ui_states: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "port": self.port,
            "ip": self.ip,
            "device": self.device,
            "platform": self.platform,
            "pid": self.pid,
            "packageName": self.package_name,
            "persistentDataPath": self.persistent_data_path,
            "appVersion": self.app_version,
            "gm_tree": self.gm_tree,
            "svnAuthor": self.svn_author,
            "svnUrl": self.svn_url,
            "svnBranch": self.svn_branch,
            "svnRevision": self.svn_revision,
            "svnDetection": self.svn_detection,
            "online": True,
        }


@dataclass
class Log:
    """日志条目"""
    time: datetime
    level: str
    msg: str
    client_id: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "time": self.time.strftime("%Y-%m-%d %H:%M:%S"),
            "level": self.level,
            "msg": self.msg,
            "client_id": self.client_id,
        }


class ServerMgr:
    """TCP 服务器管理器"""

    def __init__(self):
        self.listeners: Dict[int, asyncio.AbstractServer] = {}
        self.clients: Dict[str, Client] = {}
        self.offline_clients: Dict[str, dict] = {}
        self._offline_expiry_tasks: Dict[str, asyncio.Task] = {}
        self.offline_retention_seconds = 180.0
        self.on_client_expired: Optional[Callable[[str], None]] = None
        self.logs: List[Log] = []
        self.cmd_id = 1000
        self.on_update: Optional[Callable] = None
        self.on_disconnect: Optional[Callable] = None  # async callback: await on_disconnect(client_id)
        self.on_log: Optional[Callable[[Log], None]] = None
        self.on_client_data_update: Optional[Callable[[str], None]] = None
        self._animator_list_cache = {}      # client_id -> animator list
        self.on_animator_data = None        # Callback for ANIM_DATA
        self.on_animator_list = None        # Callback for ANIM_LIST_RESP
        self.on_animator_removed = None     # Callback for ANIM_REMOVED
        self.on_inspector_data = None       # Callback for UI_INSPECTOR_RESP
        self.on_timeline_data = None        # Callback for TIMELINE_RESP
        self.on_hierarchy_data = None       # Callback for HIERARCHY_RESP
        self.on_cs_monitor_data = None      # Legacy callback for CS_MONITOR_RESP
        self.on_subpkg_monitor_data = None  # Callback for SUBPKG_MONITOR_RESP
        self.on_player_prefs_data = None    # Callback for PLAYER_PREFS_RESP
        self.on_av_monitor_data = None      # Callback for AV_MONITOR_RESP
        self.on_proto_call_resp = None      # Callback for PROTO_CALL_RESP
        self.on_table_monitor_data = None   # Callback for TABLE_MONITOR_RESP
        self.on_screenshot = None           # Callback for SCREENSHOT_RESP
        self.on_game_log_meta = None        # Callback for GAME_LOG_META
        self.on_game_log_entries = None     # Callback for GAME_LOG_ENTRIES
        self.on_game_log_status = None      # Callback for GAME_LOG_STATUS
        self._screenshot_parts: Dict[str, dict] = {}  # 分片截图重组缓冲
        self._pending_execs: Dict[int, dict] = {}
        self._temp_seq = 0                  # 临时 ID 序号（保证 accept 阶段唯一）
        self.client_state_rev = 0

    def _kill_port_holder(self, port: int):
        """清理占用指定端口的旧进程"""
        try:
            for conn in psutil.net_connections(kind='tcp'):
                if conn.laddr.port == port and conn.status == 'LISTEN' and conn.pid:
                    if conn.pid == os.getpid():
                        continue
                    try:
                        proc = psutil.Process(conn.pid)
                        proc.kill()
                        proc.wait(timeout=3)
                        print(f"[ServerMgr] 已杀死占用端口 {port} 的旧进程 (PID={conn.pid})")
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
        except psutil.AccessDenied:
            import subprocess as _sp
            try:
                result = _sp.run(['netstat', '-aon'], capture_output=True, text=True, timeout=5,
                                 creationflags=0x08000000 if sys.platform == 'win32' else 0)
                for line in result.stdout.splitlines():
                    if f':{port} ' in line and 'LISTENING' in line:
                        pid = int(line.split()[-1])
                        if pid != os.getpid():
                            try:
                                psutil.Process(pid).kill()
                                print(f"[ServerMgr] 已杀死占用端口 {port} 的旧进程 (PID={pid})")
                            except Exception:
                                pass
            except Exception:
                pass
        except Exception as e:
            print(f"[ServerMgr] 端口 {port} 清理异常: {e}")

    def _mark_clients_changed(self):
        """递增客户端列表版本，用于前端忽略旧 HTTP/WS 快照。"""
        self.client_state_rev += 1

    def _remember_offline_client(self, client: Client):
        if client.id.startswith("temp:"):
            return
        now = time.time()
        snapshot = client.to_dict()
        snapshot.update({
            "online": False,
            "disconnectedAt": now,
            "offlineExpiresAt": now + self.offline_retention_seconds,
        })
        self.offline_clients[client.id] = snapshot
        old_task = self._offline_expiry_tasks.pop(client.id, None)
        if old_task and not old_task.done():
            old_task.cancel()

        async def expire():
            try:
                await asyncio.sleep(self.offline_retention_seconds)
                current = self.offline_clients.get(client.id)
                if (current is not snapshot
                        or self._offline_expiry_tasks.get(client.id) is not task
                        or client.id in self.clients):
                    return
                self.offline_clients.pop(client.id, None)
                self._clear_client_cache(client.id)
                self._mark_clients_changed()
                if self.on_update:
                    self.on_update()
            except asyncio.CancelledError:
                pass
            finally:
                if self._offline_expiry_tasks.get(client.id) is task:
                    self._offline_expiry_tasks.pop(client.id, None)

        task = asyncio.create_task(expire())
        self._offline_expiry_tasks[client.id] = task

    def _clear_client_cache(self, client_id: str):
        """同步清理到期状态；中途不让出事件循环，避免重连写入后被旧任务清掉。"""
        self._animator_list_cache.pop(client_id, None)
        self._screenshot_parts.pop(client_id, None)
        self.logs[:] = [log for log in self.logs if log.client_id != client_id]
        for cmd_id, pending in list(self._pending_execs.items()):
            if pending.get("client_id") == client_id:
                self._pending_execs.pop(cmd_id, None)
                pending["error"] = "client expired"
                pending["done"] = True
                pending["event"].set()
        if self.on_client_expired:
            self.on_client_expired(client_id)

    def _restore_online_client(self, client_id: str):
        self.offline_clients.pop(client_id, None)
        task = self._offline_expiry_tasks.pop(client_id, None)
        if task and not task.done():
            task.cancel()

    async def add_listener(self, port: int) -> tuple[bool, str]:
        """添加监听端口（支持重启）"""
        # 如果端口已在监听，先关闭（支持重启）
        if port in self.listeners:
            print(f"[ServerMgr] 端口 {port} 已在监听，准备重启...")
            await self.remove_listener(port)

        # 清理占用该端口的旧进程
        self._kill_port_holder(port)

        # 清理该端口的僵尸客户端
        dead_clients = [cid for cid, c in self.clients.items() if c.port == port]
        for cid in dead_clients:
            if cid in self.clients:
                c = self.clients.pop(cid)
                self._remember_offline_client(c)
                c.writer.close()
                self._add_log("info", f"清理端口 {port} 的旧客户端: {cid}", cid)
        if dead_clients:
            self._mark_clients_changed()
        if dead_clients and self.on_update:
            self.on_update()

        # 检查端口是否可用
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", port))
            sock.close()
        except Exception as e:
            return False, f"端口绑定失败: {e}"

        try:
            srv = await asyncio.start_server(
                lambda r, w: self._handle_client(r, w, port),
                "0.0.0.0",
                port,
                reuse_address=True,
                limit=4 * 1024 * 1024,  # 4MB，默认64KB不够大型UI数据
            )
            self.listeners[port] = srv
            print(f"[ServerMgr] 监听端口 {port} 成功")
            if self.on_update:
                self.on_update()
            return True, f"监听端口 {port} 成功"
        except Exception as e:
            return False, str(e)

    async def remove_listener(self, port: int) -> tuple[bool, str]:
        """移除监听端口"""
        if port not in self.listeners:
            return False, f"端口 {port} 未在监听"

        srv = self.listeners.pop(port)
        srv.close()
        try:
            await srv.wait_closed()
        except:
            pass

        # 断开该端口的所有客户端
        to_remove = [cid for cid, c in self.clients.items() if c.port == port]
        for cid in to_remove:
            c = self.clients.pop(cid, None)
            if c:
                self._remember_offline_client(c)
                try:
                    c.writer.close()
                    await c.writer.wait_closed()
                except:
                    pass

        if to_remove:
            self._mark_clients_changed()
        if self.on_update:
            self.on_update()
        return True, f"已移除监听端口 {port}"

    # 客户端 15s 发送一次 PING；超过 3 个心跳周期无任何数据则断开
    CLIENT_READ_TIMEOUT = 45

    def _set_tcp_keepalive(self, writer: asyncio.StreamWriter):
        """在已接受的 TCP socket 上启用 keepalive，加速检测半开连接"""
        try:
            sock = writer.get_extra_info('socket')
            if sock is None:
                return
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            if sys.platform == 'win32':
                # Windows: (enable, idle_ms, interval_ms)
                sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 10000, 3000))
            else:
                # Linux/macOS
                try:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 10)
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 3)
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
                except (AttributeError, OSError):
                    pass
        except Exception as e:
            print(f"[ServerMgr] 设置 TCP keepalive 失败: {e}")

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, port: int):
        """处理客户端连接"""
        # 启用 TCP keepalive 加速检测半开连接
        self._set_tcp_keepalive(writer)

        addr = writer.get_extra_info("peername")
        ip = addr[0]
        # 两段式 ID：accept 阶段先用临时 ID（唯一），等 HELLO 携带 pid 后 rekey 到 {ip}#{pid}
        self._temp_seq += 1
        temp_id = f"temp:{ip}:{addr[1]}:{self._temp_seq}"

        client_obj = Client(id=temp_id, port=port, writer=writer, ip=ip)
        self.clients[temp_id] = client_obj
        self._mark_clients_changed()
        self._add_log("info", f"客户端连接(待识别): {temp_id}", temp_id)
        print(f"[ServerMgr] TCP 客户端连接: {temp_id} (remote={ip}:{addr[1]}, port={port}), 当前客户端数={len(self.clients)}")
        if self.on_update:
            self.on_update()

        disconnect_reason = "unknown"
        try:
            while True:
                try:
                    line = await asyncio.wait_for(reader.readline(), timeout=self.CLIENT_READ_TIMEOUT)
                except asyncio.TimeoutError:
                    disconnect_reason = f"超时无数据 ({self.CLIENT_READ_TIMEOUT}s)"
                    break
                if not line:
                    disconnect_reason = "远端关闭连接"
                    break
                try:
                    pkt = json.loads(line.decode().strip())
                    self._process_packet(client_obj, pkt)
                except json.JSONDecodeError as e:
                    print(f"[ServerMgr] JSON 解析失败: {e}, data={line.decode().strip()[:200]}")
                except Exception as e:
                    print(f"[ServerMgr] 处理数据包失败: {e}")
        except ConnectionResetError:
            disconnect_reason = "连接被重置 (ConnectionReset)"
        except ConnectionAbortedError:
            disconnect_reason = "连接被中止 (ConnectionAborted)"
        except asyncio.IncompleteReadError:
            disconnect_reason = "不完整读取 (IncompleteRead)"
        except Exception as e:
            disconnect_reason = f"异常: {type(e).__name__}: {e}"
        finally:
            # 仅当 dict 中仍是本次连接的对象时才删除（用当前生效 id，rekey 后已是确定 ID），
            # 避免误删被同 IP+pid 新连接 rekey 占位的新客户端
            cur_id = client_obj.id
            removed = False
            if self.clients.get(cur_id) is client_obj:
                del self.clients[cur_id]
                self._remember_offline_client(client_obj)
                self._mark_clients_changed()
                removed = True
            self._add_log("info", f"客户端断开: {cur_id} ({disconnect_reason})", cur_id)
            print(f"[ServerMgr] TCP 客户端断开: {cur_id}, 原因={disconnect_reason}, 剩余={len(self.clients)}")
            try:
                writer.close()
                await writer.wait_closed()
            except Exception as e:
                print(f"[ServerMgr] 关闭客户端连接失败: {cur_id}, error={e}")
            # 断开时必须 await 广播，确保前端卡片立即消失
            if self.on_disconnect and removed:
                try:
                    await self.on_disconnect(cur_id)
                except Exception as e:
                    print(f"[ServerMgr] on_disconnect 回调失败: {e}")
            elif self.on_update:
                self.on_update()

    def _rekey_client(self, client_obj: "Client", new_id: str):
        """HELLO 后把客户端从临时 ID 迁移到确定 ID（严格顺序，见 spec §3.3）"""
        old_id = client_obj.id
        if new_id == old_id:
            return
        # 1) 踢除同确定 ID 的上一条残留连接（同 IP+pid 重连场景）
        existing = self.clients.get(new_id)
        if existing is not None and existing is not client_obj:
            try:
                existing.writer.close()
            except Exception:
                pass
            # 从主表移除旧对象（其读循环 finally 会因 get(new_id) is existing 为 False 而不再重复删）
            if self.clients.get(new_id) is existing:
                del self.clients[new_id]
            self._add_log("info", f"踢除同会话旧连接: {new_id}", new_id)
        # 2) 删除临时键
        if self.clients.get(old_id) is client_obj:
            del self.clients[old_id]
        # 3) 更新对象 id
        client_obj.id = new_id
        # 4) 写入确定键
        self.clients[new_id] = client_obj
        self._restore_online_client(new_id)
        # 5) 迁移以 client_id 为键的附属状态
        if old_id in self._animator_list_cache:
            self._animator_list_cache[new_id] = self._animator_list_cache.pop(old_id)
        for pe in self._pending_execs.values():
            if pe.get("client_id") == old_id:
                pe["client_id"] = new_id
        print(f"[ServerMgr] rekey: {old_id} -> {new_id}")

    def _process_packet(self, client_obj: "Client", pkt: dict):
        """处理客户端数据包"""
        t = pkt.get("type")
        c = client_obj
        cid = client_obj.id

        print(f"[ServerMgr] 收到数据包: cid={cid}, type={t}")

        if t == "PING":
            try:
                c.writer.write((json.dumps({"type": "PONG"}) + "\n").encode())
            except Exception:
                pass
            return
        elif t == "HELLO":
            c.device = pkt.get("device", "Unknown")
            c.platform = pkt.get("platform", "Unknown")
            c.pid = pkt.get("pid", 0) or 0
            c.package_name = pkt.get("packageName", "") or pkt.get("package_name", "") or ""
            c.persistent_data_path = pkt.get("persistentDataPath", "") or pkt.get("persistent_data_path", "") or ""
            c.app_version = pkt.get("appVersion", "") or pkt.get("app_version", "") or ""
            c.svn_author = pkt.get("svn_author", "") or ""
            c.svn_url = pkt.get("svn_url", "") or ""
            c.svn_branch = pkt.get("svn_branch", "") or ""
            c.svn_revision = str(pkt.get("svn_revision", "") or "")
            c.svn_detection = pkt.get("svn_detection", "") or ""
            # 计算确定 ID 并 rekey（pid 缺失时按 device 兜底，见 spec §3.4）
            # 用 "-" 分隔避免 "#" 在 HTTP 路径/代理中被误认为 fragment
            if c.pid > 0:
                new_id = f"{c.ip}-{c.pid}"
            elif c.device and c.device != "Unknown":
                new_id = f"{c.ip}-dev:{c.device}"
            else:
                new_id = None  # 无法确定身份，保留临时 ID
            if new_id:
                self._rekey_client(c, new_id)
            print(
                f"[ServerMgr] HELLO: id={c.id}, device={c.device}, platform={c.platform}, "
                f"package={c.package_name or '-'}, author={c.svn_author or '-'}, "
                f"branch={c.svn_branch or '-'}, revision={c.svn_revision or '-'}"
            )
            if self.on_update:
                self._mark_clients_changed()
                self.on_update()
            return
        elif t == "LOG":
            level = pkt.get("level", "info")
            msg = pkt.get("msg", "")
            ref_id = pkt.get("ref_id")
            self._add_log(level, msg, cid)
            if ref_id is not None and ref_id in self._pending_execs:
                pe = self._pending_execs[ref_id]
                if level == "error":
                    pe["logs"].append({"level": level, "msg": msg})
                    pe["error"] = msg
                    pe["done"] = True
                    pe["event"].set()
                elif level == "info" and msg == "Success":
                    pe["done"] = True
                    pe["event"].set()
                else:
                    pe["logs"].append({"level": level, "msg": msg})
            elif ref_id is None:
                for pe in self._pending_execs.values():
                    if pe.get("client_id") == cid and not pe["done"]:
                        pe["logs"].append({"level": level, "msg": msg})
        elif t == "GM_LIST":
            c.gm_tree = pkt.get("data", [])
            print(f"[ServerMgr] GM_LIST: {len(c.gm_tree)} 个节点")
            self._mark_clients_changed()
            if self.on_client_data_update:
                self.on_client_data_update(cid)
            else:
                print(f"[ServerMgr] ⚠ on_client_data_update 未设置!")
        elif t == "ANIM_LIST_RESP":
            self._animator_list_cache[cid] = pkt.get("animators", [])
            if self.on_animator_list:
                self.on_animator_list(cid, self._animator_list_cache[cid])
        elif t == "ANIM_DATA":
            if self.on_animator_data:
                self.on_animator_data(cid, pkt)
        elif t == "ANIM_REMOVED":
            if self.on_animator_removed:
                self.on_animator_removed(cid, pkt.get("animatorId"))
        elif t == "UI_INSPECTOR_RESP":
            if self.on_inspector_data:
                self.on_inspector_data(cid, pkt)
        elif t == "TIMELINE_RESP":
            if self.on_timeline_data:
                self.on_timeline_data(cid, pkt)
        elif t == "HIERARCHY_RESP" or t == "CS_MONITOR_RESP":
            if self.on_hierarchy_data:
                self.on_hierarchy_data(cid, pkt)
            elif self.on_cs_monitor_data:
                self.on_cs_monitor_data(cid, pkt)
        elif t == "SUBPKG_MONITOR_RESP":
            action = pkt.get("action", "?")
            data_keys = list(pkt.get("data", {}).keys()) if isinstance(pkt.get("data"), dict) else "N/A"
            print(f"[ServerMgr] SUBPKG_MONITOR_RESP: action={action}, data_keys={data_keys}, error={pkt.get('error', 'none')}")
            if self.on_subpkg_monitor_data:
                self.on_subpkg_monitor_data(cid, pkt)
        elif t == "PLAYER_PREFS_RESP":
            action = pkt.get("action", "?")
            print(f"[ServerMgr] PLAYER_PREFS_RESP: action={action}, error={pkt.get('error', 'none')}")
            if self.on_player_prefs_data:
                self.on_player_prefs_data(cid, pkt)
        elif t == "AV_MONITOR_RESP":
            action = pkt.get("action", "?")
            print(f"[ServerMgr] AV_MONITOR_RESP: action={action}, error={pkt.get('error', 'none')}")
            if self.on_av_monitor_data:
                self.on_av_monitor_data(cid, pkt)
        elif t == "PROTO_CALL_RESP":
            protocol = pkt.get("protocol", "?")
            code = pkt.get("code")
            print(f"[ServerMgr] PROTO_CALL_RESP: protocol={protocol}, code={code}")
            if self.on_proto_call_resp:
                self.on_proto_call_resp(cid, pkt)
        elif t == "TABLE_MONITOR_RESP":
            action = pkt.get("action", "?")
            print(f"[ServerMgr] TABLE_MONITOR_RESP: action={action}, error={pkt.get('error', 'none')}")
            if self.on_table_monitor_data:
                self.on_table_monitor_data(cid, pkt)
        elif t == "GAME_LOG_META":
            print(f"[ServerMgr] GAME_LOG_META: cid={cid}, path={pkt.get('path', '-')}")
            if self.on_game_log_meta:
                self.on_game_log_meta(cid, pkt)
        elif t == "GAME_LOG_ENTRIES":
            entries = pkt.get("entries", [])
            count = len(entries) if isinstance(entries, list) else 0
            print(f"[ServerMgr] GAME_LOG_ENTRIES: cid={cid}, entries={count}")
            if self.on_game_log_entries:
                self.on_game_log_entries(cid, pkt)
        elif t == "GAME_LOG_STATUS":
            print(f"[ServerMgr] GAME_LOG_STATUS: cid={cid}, state={pkt.get('state', '-')}, error={pkt.get('error', '-')}")
            if self.on_game_log_status:
                self.on_game_log_status(cid, pkt)
        elif t == "SCREENSHOT_RESP":
            part = pkt.get("part")
            totalParts = pkt.get("totalParts")
            if part and totalParts and totalParts > 1:
                # 分片截图：重组
                key = cid
                if key not in self._screenshot_parts:
                    self._screenshot_parts[key] = {"parts": {}, "total": totalParts, "width": pkt.get("width"), "height": pkt.get("height")}
                buf = self._screenshot_parts[key]
                buf["parts"][part] = pkt.get("image", "")
                print(f"[ServerMgr] SCREENSHOT_RESP part {part}/{totalParts}: cid={cid}, chunk_size={len(pkt.get('image', ''))}")
                if len(buf["parts"]) >= buf["total"]:
                    # 所有分片到达，拼接
                    full_image = ""
                    for i in range(1, buf["total"] + 1):
                        full_image += buf["parts"].get(i, "")
                    full_pkt = {"type": "SCREENSHOT_RESP", "image": full_image, "width": buf["width"], "height": buf["height"]}
                    print(f"[ServerMgr] SCREENSHOT_RESP complete: cid={cid}, total_size={len(full_image)}")
                    if self.on_screenshot:
                        self.on_screenshot(cid, full_pkt)
                    del self._screenshot_parts[key]
            else:
                # 单片截图（兼容旧客户端）
                print(f"[ServerMgr] SCREENSHOT_RESP: cid={cid}, size={len(pkt.get('image', ''))}")
                if self.on_screenshot:
                    self.on_screenshot(cid, pkt)

    def _add_log(self, level: str, msg: str, client_id: Optional[str] = None):
        """添加日志"""
        log = Log(datetime.now(), level, msg, client_id)
        self.logs.append(log)
        # 限制日志数量
        if len(self.logs) > 1000:
            self.logs = self.logs[-500:]
        if self.on_log:
            self.on_log(log)

    async def send_to_client(self, client_id: str, cmd: str) -> tuple[bool, str]:
        """发送命令到指定客户端"""
        client = self.clients.get(client_id)
        if not client:
            return False, f"客户端 {client_id} 不存在"

        try:
            data = json.dumps({"type": "EXEC", "id": self.cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
            client.writer.write(data.encode())
            await client.writer.drain()
            self.cmd_id += 1
            return True, f"已发送到 {client.device}"
        except Exception as e:
            print(f"[ServerMgr] send_to_client 发送失败: cid={client_id}, error={e}")
            # 发送失败时清理该客户端
            if self.clients.get(client_id) is client:
                self.clients.pop(client_id)
                self._remember_offline_client(client)
                client.writer.close()
                self._mark_clients_changed()
                self._add_log("warning", f"客户端断开（发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, str(e)

    async def exec_wait(self, client_id: str, cmd: str, timeout: float = 10.0) -> Tuple[bool, List[dict], Optional[str]]:
        """发送 Lua 并等待执行完成，返回 (success, logs, error)"""
        client = self.clients.get(client_id)
        if not client:
            return False, [], f"客户端 {client_id} 不存在"

        cmd_id = self.cmd_id
        pe = {"event": asyncio.Event(), "logs": [], "done": False, "error": None, "client_id": client_id}
        self._pending_execs[cmd_id] = pe

        try:
            data = json.dumps({"type": "EXEC", "id": cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
            client.writer.write(data.encode())
            await client.writer.drain()
            self.cmd_id += 1
        except Exception as e:
            self._pending_execs.pop(cmd_id, None)
            if self.clients.get(client_id) is client:
                self.clients.pop(client_id)
                self._remember_offline_client(client)
                client.writer.close()
                self._mark_clients_changed()
                self._add_log("warning", f"客户端断开（发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, [], str(e)

        try:
            await asyncio.wait_for(pe["event"].wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_execs.pop(cmd_id, None)
            return False, pe["logs"], "timeout"

        self._pending_execs.pop(cmd_id, None)
        return pe["error"] is None, pe["logs"], pe["error"]

    async def send_gm_to_client(self, client_id: str, gm_id: str, val: Any = None) -> tuple[bool, str]:
        """发送 GM 指令到指定客户端"""
        client = self.clients.get(client_id)
        if not client:
            return False, f"客户端 {client_id} 不存在"

        if val is not None:
            client.ui_states[gm_id] = val

        try:
            data = json.dumps({"type": "EXEC_GM", "id": gm_id, "value": val}, ensure_ascii=False) + "\n"
            # 调试：打印实际发送的数据
            val_type = type(val).__name__
            val_repr = repr(val) if val is not None else "None"
            print(f"[ServerMgr] send_gm_to_client: gm_id={gm_id} (type={type(gm_id).__name__}), value={val_repr} (type={val_type})")
            print(f"[ServerMgr] 发送数据: {data.strip()}")
            client.writer.write(data.encode())
            await client.writer.drain()
            return True, f"GM 指令已发送到 {client.device}"
        except Exception as e:
            print(f"[ServerMgr] send_gm_to_client 发送失败: cid={client_id}, error={e}")
            # 发送失败时清理该客户端
            if self.clients.get(client_id) is client:
                self.clients.pop(client_id)
                self._remember_offline_client(client)
                client.writer.close()
                self._mark_clients_changed()
                self._add_log("warning", f"客户端断开（GM发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, str(e)

    async def broadcast(self, cmd: str):
        """广播命令到所有客户端"""
        dead_clients = []
        for cid, c in list(self.clients.items()):
            try:
                data = json.dumps({"type": "EXEC", "id": self.cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
                c.writer.write(data.encode())
                await c.writer.drain()
            except Exception as e:
                print(f"[ServerMgr] broadcast 发送失败: cid={cid}, error={e}")
                dead_clients.append((cid, c))
        # 清理失效的客户端
        for cid, c in dead_clients:
            if self.clients.get(cid) is c:
                self.clients.pop(cid)
                self._remember_offline_client(c)
                c.writer.close()
                self._mark_clients_changed()
                self._add_log("warning", f"客户端断开（broadcast检测）: {cid}", cid)
                if self.on_update:
                    self.on_update()
        self.cmd_id += 1

    async def broadcast_gm(self, gm_id: str, val: Any = None):
        """广播 GM 指令到所有客户端"""
        # 调试：打印广播的参数
        val_type = type(val).__name__
        val_repr = repr(val) if val is not None else "None"
        print(f"[ServerMgr] broadcast_gm: gm_id={gm_id} (type={type(gm_id).__name__}), value={val_repr} (type={val_type})")

        dead_clients = []
        for cid, c in list(self.clients.items()):
            try:
                data = json.dumps({"type": "EXEC_GM", "id": gm_id, "value": val}, ensure_ascii=False) + "\n"
                c.writer.write(data.encode())
                await c.writer.drain()
            except Exception as e:
                print(f"[ServerMgr] broadcast_gm 发送失败: cid={cid}, error={e}")
                dead_clients.append((cid, c))
        # 清理失效的客户端
        for cid, c in dead_clients:
            if self.clients.get(cid) is c:
                self.clients.pop(cid)
                self._remember_offline_client(c)
                c.writer.close()
                self._mark_clients_changed()
                self._add_log("warning", f"客户端断开（broadcast GM检测）: {cid}", cid)
                if self.on_update:
                    self.on_update()

    def get_listeners_info(self) -> list:
        """获取监听端口信息"""
        result = []
        for port in self.listeners:
            client_count = sum(1 for c in self.clients.values() if c.port == port)
            result.append({
                "port": port,
                "client_count": client_count,
            })
        return result

    def get_clients_info(self) -> list:
        """获取客户端信息"""
        online = [c.to_dict() for c in self.clients.values()]
        online_ids = {item["id"] for item in online}
        offline = [item for cid, item in self.offline_clients.items() if cid not in online_ids]
        return online + offline

    def get_logs(self, limit: int = 100) -> list:
        """获取日志"""
        return [log.to_dict() for log in self.logs[-limit:]]

    async def send_anim_list_request(self, client_id: str):
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_LIST"}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_LIST failed: {e}", client_id)

    async def send_anim_subscribe(self, client_id: str, animator_id: int):
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_SUBSCRIBE", "animatorId": animator_id}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_SUBSCRIBE failed: {e}", client_id)

    async def send_anim_unsubscribe(self, client_id: str):
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({"type": "ANIM_UNSUBSCRIBE"}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_UNSUBSCRIBE failed: {e}", client_id)

    async def send_anim_set_param(self, client_id: str, animator_id: int, param_name: str, param_type: str, float_val: float = 0, int_val: int = 0, bool_val: bool = False):
        c = self.clients.get(client_id)
        if not c:
            return
        msg = json.dumps({
            "type": "ANIM_SET_PARAM",
            "animatorId": animator_id,
            "paramName": param_name,
            "paramType": param_type,
            "floatValue": float_val,
            "intValue": int_val,
            "boolValue": bool_val
        }) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send ANIM_SET_PARAM failed: {e}", client_id)

    def get_cached_animator_list(self, client_id: str):
        return self._animator_list_cache.get(client_id, [])

    async def send_inspector_request(self, client_id: str, action: str, params: dict):
        """发送 Inspector 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "UI_INSPECTOR", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send UI_INSPECTOR failed: {e}", client_id)

    async def send_hierarchy_request(self, client_id: str, action: str, params: dict):
        """发送 Hierarchy 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "HIERARCHY", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send HIERARCHY failed: {e}", client_id)

    async def send_cs_monitor_request(self, client_id: str, action: str, params: dict):
        """兼容旧调用：转发到 Hierarchy 通道"""
        await self.send_hierarchy_request(client_id, action, params)

    async def send_timeline_request(self, client_id: str, action: str, params: dict):
        """发送 Timeline 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "TIMELINE", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send TIMELINE failed: {e}", client_id)

    async def send_player_prefs_request(self, client_id: str, action: str, params: dict):
        """发送 PlayerPrefs 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "PLAYER_PREFS", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send PLAYER_PREFS failed: {e}", client_id)

    async def send_av_monitor_request(self, client_id: str, action: str, params: dict):
        """发送 AV Monitor 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "AV_MONITOR", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send AV_MONITOR failed: {e}", client_id)

    async def send_subpkg_monitor_request(self, client_id: str, action: str, params: dict):
        """发送 SubPackage Monitor 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "SUBPKG_MONITOR", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send SUBPKG_MONITOR failed: {e}", client_id)

    async def send_table_monitor_request(self, client_id: str, action: str, params: dict):
        """发送 Table Monitor 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            return
        pkt = {"type": "TABLE_MONITOR", "action": action}
        pkt.update(params)
        msg = json.dumps(pkt, ensure_ascii=False) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
        except Exception as e:
            self._add_log("error", f"Send TABLE_MONITOR failed: {e}", client_id)

    async def send_game_log_request(self, client_id: str, action: str, params: dict | None = None):
        """发送游戏日志 tail 命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            self._add_log("error", f"Send GAME_LOG failed: 客户端 {client_id} 不存在")
            return False, f"客户端 {client_id} 不存在"
        pkt = {"type": "GAME_LOG", "action": action}
        if params:
            pkt.update(params)
        msg = json.dumps(pkt, ensure_ascii=False) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
            return True, "sent"
        except Exception as e:
            self._add_log("error", f"Send GAME_LOG failed: {e}", client_id)
            return False, str(e)

    async def send_screenshot_request(self, client_id: str):
        """发送截图命令到客户端"""
        c = self.clients.get(client_id)
        if not c:
            self._add_log("error", f"Send SCREENSHOT failed: 客户端 {client_id} 不存在")
            return
        msg = json.dumps({"type": "SCREENSHOT"}) + "\n"
        try:
            c.writer.write(msg.encode())
            await c.writer.drain()
            self._add_log("info", "已发送截图请求到客户端", client_id)
        except Exception as e:
            self._add_log("error", f"Send SCREENSHOT failed: {e}", client_id)

    async def shutdown(self):
        """关闭所有连接并清理端口"""
        ports = list(self.listeners.keys())
        for port in ports:
            await self.remove_listener(port)
            self._kill_port_holder(port)
