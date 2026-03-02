"""
GM Console - 服务器管理模块
从原 gm_console.py 提取的核心逻辑
"""
import asyncio
import json
import socket
import os
import sys
from datetime import datetime
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Callable

import psutil


@dataclass
class Client:
    """客户端连接"""
    id: str
    port: int
    writer: asyncio.StreamWriter
    device: str = "Unknown"
    platform: str = "Unknown"
    gm_tree: List[Any] = field(default_factory=list)
    ui_states: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "port": self.port,
            "device": self.device,
            "platform": self.platform,
            "gm_tree": self.gm_tree,
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
        self.logs: List[Log] = []
        self.cmd_id = 1000
        self.on_update: Optional[Callable] = None
        self.on_log: Optional[Callable[[Log], None]] = None
        self.on_client_data_update: Optional[Callable[[str], None]] = None

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
                self._add_log("info", f"清理端口 {port} 的旧客户端: {cid}", cid)
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
                reuse_address=True
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
                try:
                    c.writer.close()
                    await c.writer.wait_closed()
                except:
                    pass

        if self.on_update:
            self.on_update()
        return True, f"已移除监听端口 {port}"

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, port: int):
        """处理客户端连接"""
        addr = writer.get_extra_info("peername")
        cid = f"{addr[0]}:{addr[1]}"

        # 断开同端口的旧连接
        for ocid in [k for k, v in self.clients.items() if v.port == port]:
            oc = self.clients.pop(ocid)
            try:
                oc.writer.close()
                await oc.writer.wait_closed()
                self._add_log("info", f"断开旧连接: {ocid}", ocid)
            except Exception as e:
                print(f"[ServerMgr] 断开旧连接失败 {ocid}: {e}")

        self.clients[cid] = Client(id=cid, port=port, writer=writer)
        self._add_log("info", f"客户端连接: {cid}", cid)
        print(f"[ServerMgr] TCP 客户端连接: {cid} (port={port}), 当前客户端数={len(self.clients)}")
        if self.on_update:
            self.on_update()

        try:
            while True:
                line = await reader.readline()
                if not line:
                    print(f"[ServerMgr] 客户端 {cid} 主动断开连接")
                    break
                try:
                    pkt = json.loads(line.decode().strip())
                    self._process_packet(cid, pkt)
                except json.JSONDecodeError as e:
                    print(f"[ServerMgr] JSON 解析失败: {e}, data={line.decode().strip()}")
                except Exception as e:
                    print(f"[ServerMgr] 处理数据包失败: {e}")
        except Exception as e:
            print(f"[ServerMgr] 客户端 {cid} 连接异常: {e}")
        finally:
            if cid in self.clients:
                del self.clients[cid]
            self._add_log("info", f"客户端断开: {cid}", cid)
            print(f"[ServerMgr] TCP 客户端断开: {cid}, 剩余客户端数={len(self.clients)}")
            if self.on_update:
                self.on_update()

    def _process_packet(self, cid: str, pkt: dict):
        """处理客户端数据包"""
        t = pkt.get("type")
        c = self.clients.get(cid)
        if not c:
            return

        print(f"[ServerMgr] 收到数据包: cid={cid}, type={t}")

        if t == "HELLO":
            c.device = pkt.get("device", "Unknown")
            c.platform = pkt.get("platform", "Unknown")
            print(f"[ServerMgr] HELLO: device={c.device}, platform={c.platform}")
            if self.on_update:
                self.on_update()
        elif t == "LOG":
            self._add_log(pkt.get("level", "info"), pkt.get("msg", ""), cid)
        elif t == "GM_LIST":
            c.gm_tree = pkt.get("data", [])
            print(f"[ServerMgr] GM_LIST: {len(c.gm_tree)} 个节点")
            if self.on_client_data_update:
                self.on_client_data_update(cid)
            else:
                print(f"[ServerMgr] ⚠ on_client_data_update 未设置!")

    def _add_log(self, level: str, msg: str, client_id: Optional[str] = None):
        """添加日志"""
        log = Log(datetime.now(), level, msg, client_id)
        self.logs.append(log)
        # 限制日志数量
        if len(self.logs) > 1000:
            self.logs = self.logs[-500:]
        if self.on_log:
            self.on_log(log)

    async def send_to_port(self, port: Optional[int], cmd: str) -> tuple[bool, str]:
        """发送命令到指定端口的客户端"""
        if port is None:
            await self.broadcast(cmd)
            return True, "已广播"

        client = next((c for c in self.clients.values() if c.port == port), None)
        if not client:
            return False, f"端口 {port} 无设备连接"

        try:
            data = json.dumps({"type": "EXEC", "id": self.cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
            client.writer.write(data.encode())
            await client.writer.drain()
            self.cmd_id += 1
            return True, f"已发送到 {client.device}"
        except Exception as e:
            print(f"[ServerMgr] send_to_port 发送失败: port={port}, error={e}")
            # 发送失败时清理该客户端
            client_id = next((cid for cid, c in self.clients.items() if c.port == port), None)
            if client_id and client_id in self.clients:
                self.clients.pop(client_id)
                self._add_log("warning", f"客户端断开（端口发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, str(e)

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
            if client_id in self.clients:
                self.clients.pop(client_id)
                self._add_log("warning", f"客户端断开（发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, str(e)

    async def send_gm_to_port(self, port: Optional[int], gm_id: str, val: Any = None) -> tuple[bool, str]:
        """发送 GM 指令到指定端口"""
        if port is None:
            await self.broadcast_gm(gm_id, val)
            return True, "已广播 GM 指令"

        client = next((c for c in self.clients.values() if c.port == port), None)
        if not client:
            return False, f"端口 {port} 无设备连接"

        if val is not None:
            client.ui_states[gm_id] = val

        try:
            data = json.dumps({"type": "EXEC_GM", "id": gm_id, "value": val}, ensure_ascii=False) + "\n"
            client.writer.write(data.encode())
            await client.writer.drain()
            return True, f"GM 指令已发送到 {client.device}"
        except Exception as e:
            print(f"[ServerMgr] send_gm_to_port 发送失败: port={port}, error={e}")
            # 发送失败时清理该客户端
            client_id = next((cid for cid, c in self.clients.items() if c.port == port), None)
            if client_id and client_id in self.clients:
                self.clients.pop(client_id)
                self._add_log("warning", f"客户端断开（端口GM发送失败）: {client_id}", client_id)
                if self.on_update:
                    self.on_update()
            return False, str(e)

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
            if client_id in self.clients:
                self.clients.pop(client_id)
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
                dead_clients.append(cid)
        # 清理失效的客户端
        for cid in dead_clients:
            if cid in self.clients:
                c = self.clients.pop(cid)
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
                dead_clients.append(cid)
        # 清理失效的客户端
        for cid in dead_clients:
            if cid in self.clients:
                c = self.clients.pop(cid)
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
        return [c.to_dict() for c in self.clients.values()]

    def get_logs(self, limit: int = 100) -> list:
        """获取日志"""
        return [log.to_dict() for log in self.logs[-limit:]]

    async def shutdown(self):
        """关闭所有连接并清理端口"""
        ports = list(self.listeners.keys())
        for port in ports:
            await self.remove_listener(port)
            self._kill_port_holder(port)
