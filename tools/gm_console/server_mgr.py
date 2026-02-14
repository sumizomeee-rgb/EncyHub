"""
GM Console - 服务器管理模块
从原 gm_console.py 提取的核心逻辑
"""
import asyncio
import json
import socket
import os
from datetime import datetime
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Callable


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

    async def add_listener(self, port: int) -> tuple[bool, str]:
        """添加监听端口"""
        if port in self.listeners:
            return False, f"端口 {port} 已在监听"

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
            except:
                pass

        self.clients[cid] = Client(id=cid, port=port, writer=writer)
        self._add_log("info", f"客户端连接: {cid}", cid)
        if self.on_update:
            self.on_update()

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    pkt = json.loads(line.decode().strip())
                    self._process_packet(cid, pkt)
                except:
                    pass
        except:
            pass
        finally:
            if cid in self.clients:
                del self.clients[cid]
            self._add_log("info", f"客户端断开: {cid}", cid)
            if self.on_update:
                self.on_update()

    def _process_packet(self, cid: str, pkt: dict):
        """处理客户端数据包"""
        t = pkt.get("type")
        c = self.clients.get(cid)
        if not c:
            return

        if t == "HELLO":
            c.device = pkt.get("device", "Unknown")
            c.platform = pkt.get("platform", "Unknown")
            if self.on_update:
                self.on_update()
        elif t == "LOG":
            self._add_log(pkt.get("level", "info"), pkt.get("msg", ""), cid)
        elif t == "GM_LIST":
            c.gm_tree = pkt.get("data", [])
            if self.on_client_data_update:
                self.on_client_data_update(cid)

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
            self.cmd_id += 1
            client.writer.write(data.encode())
            await client.writer.drain()
            return True, f"已发送到 {client.device}"
        except Exception as e:
            return False, str(e)

    async def send_to_client(self, client_id: str, cmd: str) -> tuple[bool, str]:
        """发送命令到指定客户端"""
        client = self.clients.get(client_id)
        if not client:
            return False, f"客户端 {client_id} 不存在"

        try:
            data = json.dumps({"type": "EXEC", "id": self.cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
            self.cmd_id += 1
            client.writer.write(data.encode())
            await client.writer.drain()
            return True, f"已发送到 {client.device}"
        except Exception as e:
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
            client.writer.write(data.encode())
            await client.writer.drain()
            return True, f"GM 指令已发送到 {client.device}"
        except Exception as e:
            return False, str(e)

    async def broadcast(self, cmd: str):
        """广播命令到所有客户端"""
        for c in self.clients.values():
            try:
                data = json.dumps({"type": "EXEC", "id": self.cmd_id, "cmd": cmd}, ensure_ascii=False) + "\n"
                c.writer.write(data.encode())
                await c.writer.drain()
            except:
                pass
        self.cmd_id += 1

    async def broadcast_gm(self, gm_id: str, val: Any = None):
        """广播 GM 指令到所有客户端"""
        for c in self.clients.values():
            try:
                data = json.dumps({"type": "EXEC_GM", "id": gm_id, "value": val}, ensure_ascii=False) + "\n"
                c.writer.write(data.encode())
                await c.writer.drain()
            except:
                pass

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
        """关闭所有连接"""
        for port in list(self.listeners.keys()):
            await self.remove_listener(port)
