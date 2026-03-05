"""
Scrcpy Web Manager for ADB Master.
将 scrcpy 投屏剥离外部 UI，实现真正的内置视频流与控制流。
"""

import asyncio
import json
import os
import random
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

from fastapi import WebSocket

from .path_utils import get_scrcpy_server_path, get_adb_path

SCRCPY_VERSION = "2.5"

@dataclass
class ScrcpyWebSession:
    """单个设备的 scrcpy Web 投屏会话"""
    hw_id: str
    serial: str
    scid: int
    video_port: int
    control_port: int
    server_process: asyncio.subprocess.Process
    video_reader: asyncio.StreamReader
    video_writer: asyncio.StreamWriter
    control_writer: asyncio.StreamWriter

    # 获取到的设备信息
    device_name: str = ""
    codec: str = "h264"
    width: int = 0
    height: int = 0

    start_time: float = field(default_factory=time.time)
    _running: bool = True

    @property
    def is_running(self) -> bool:
        if self.server_process and self.server_process.returncode is not None:
            return False
        return self._running


def _find_free_port() -> int:
    """动态分配空闲的本地端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


class ScrcpyWebManager:
    """
    Scrcpy Web 投屏管理器。
    """

    def __init__(self):
        self._sessions: Dict[str, ScrcpyWebSession] = {}

    async def start(self, hw_id: str, serial: str, config: dict) -> dict:
        """
        启动 scrcpy-server 并建立 TCP 连接，返回屏幕视频元数据。
        """
        print(f"[ScrcpyWebManager] 开始启动投屏: hw_id={hw_id}, serial={serial}")

        # 防止重复启动
        if hw_id in self._sessions and self._sessions[hw_id].is_running:
            return {"success": False, "message": "该设备投屏已在运行中"}

        # 清理旧会话并启动新的
        await self.stop(hw_id)  # 清理可能残留的死会话

        # scrcpy-server 用 Integer.parseInt(value, 16) 解析 scid
        # 即十六进制解析，所以 08x 格式化后的值必须 <= 0x7FFFFFFF
        scid = random.randint(0, 0x0FFFFFFF)
        print(f"[ScrcpyWebManager] scid={scid:08x}")

        # 1. 部署 scrcpy-server
        print("[ScrcpyWebManager] 步骤1: 部署 scrcpy-server...")
        if not await self._deploy_server(serial):
            return {"success": False, "message": "部署 scrcpy-server 失败"}
        print("[ScrcpyWebManager] 步骤1完成")

        # 1.5. 获取设备实际屏幕分辨率
        actual_width = config.get('max_size', 800)
        actual_height = config.get('max_size', 800)
        try:
            adb = get_adb_path()
            env = os.environ.copy()
            env["MSYS_NO_PATHCONV"] = "1"
            result_proc = await asyncio.create_subprocess_exec(
                adb, "-s", serial, "shell", "wm size",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env
            )
            stdout, _ = await result_proc.communicate()
            if stdout and b'x' in stdout:
                # 解析 Physical size: 1920x1080 格式
                size_part = stdout.decode().split('Physical size:')[1].strip()
                width_part, height_part = size_part.split('x')
                actual_width = int(width_part)
                actual_height = int(height_part)
                print(f"[ScrcpyWebManager] 获取到设备实际分辨率: {actual_width}x{actual_height}")
        except Exception as e:
            print(f"[ScrcpyWebManager] 获取设备分辨率失败，使用默认值: {e}")

        # 2. 建立 ADB forward 隧道
        # scrcpy 协议: video 和 control 共用同一个 localabstract socket,
        # 通过两次顺序 TCP connect 分别建立 video socket 和 control socket
        socket_name = f"scrcpy_{scid:08x}"
        video_port = _find_free_port()
        print(f"[ScrcpyWebManager] 步骤2: 建立 forward {socket_name} -> tcp:{video_port}")

        adb = get_adb_path()
        env = os.environ.copy()
        env["MSYS_NO_PATHCONV"] = "1"
        fwd_proc = await asyncio.create_subprocess_exec(
            adb, "-s", serial, "forward",
            f"tcp:{video_port}", f"localabstract:{socket_name}",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env=env
        )
        await fwd_proc.wait()
        print(f"[ScrcpyWebManager] 步骤2完成, video_port={video_port}")

        # 3. 启动设备侧 scrcpy-server
        print("[ScrcpyWebManager] 步骤3: 启动 scrcpy-server...")
        proc = await self._launch_server(serial, scid, config)
        print(f"[ScrcpyWebManager] 步骤3完成, server_pid={proc.pid}")

        # 4. 连接 Video Socket (按协议这是第1个连接)
        # 只读取 dummy byte，device meta 会在 control socket 连接后发送
        print("[ScrcpyWebManager] 步骤4: 连接 video socket...")
        video_reader = None
        video_writer = None
        control_writer = None
        try:
            video_reader, video_writer = await self._connect_socket(video_port, read_dummy_byte=True)
            print("[ScrcpyWebManager] 步骤4完成: video socket 已连接")
        except Exception as e:
            print(f"[ScrcpyWebManager] 步骤4失败: {e}")
            proc.kill()
            await proc.wait()
            return {"success": False, "message": f"连接视频流失败: {e}"}

        # 5. 连接 Control Socket (第2个连接，不读取 dummy byte)
        # 关键：必须先连接 control socket，服务器才会发送 device meta
        print("[ScrcpyWebManager] 步骤5: 连接 control socket...")
        try:
            _, control_writer = await self._connect_socket(video_port, read_dummy_byte=False)
            print("[ScrcpyWebManager] 步骤5完成: control socket 已连接")
        except Exception as e:
            print(f"[ScrcpyWebManager] 步骤5失败: {e}")
            if video_writer:
                video_writer.close()
            proc.kill()
            await proc.wait()
            return {"success": False, "message": f"连接控制流失败: {e}"}

        # 6. 现在 control socket 已连接，读取 device meta 和 codec meta
        print("[ScrcpyWebManager] 步骤6: 读取设备元数据...")
        try:
            device_name, codec_name, meta_width, meta_height = await self._read_device_meta(video_reader)
            if meta_width > 0 and meta_height > 0:
                actual_width = meta_width
                actual_height = meta_height
            print(f"[ScrcpyWebManager] 步骤6完成: {device_name}, {actual_width}x{actual_height}, codec={codec_name}")
        except Exception as e:
            print(f"[ScrcpyWebManager] 步骤6失败: {e}")
            if video_writer:
                video_writer.close()
            if control_writer:
                control_writer.close()
            proc.kill()
            await proc.wait()
            return {"success": False, "message": f"读取设备元数据失败: {e}"}

        # 7. 保存会话
        session = ScrcpyWebSession(
            hw_id=hw_id,
            serial=serial,
            scid=scid,
            video_port=video_port,
            control_port=0,
            server_process=proc,
            video_reader=video_reader,
            video_writer=video_writer,
            control_writer=control_writer,
            device_name=device_name,
            codec=codec_name,
            width=actual_width,
            height=actual_height
        )
        self._sessions[hw_id] = session

        print(f"[ScrcpyWebManager] 投屏会话已建立: {hw_id} ({actual_width}x{actual_height})")
        return {
            "success": True,
            "message": "启动成功",
            "width": actual_width,
            "height": actual_height,
            "codec": codec_name
        }

    async def stream(self, hw_id: str, websocket: WebSocket):
        """处理 WebSocket 双向流: 下行发视频帧, 上行收控制JSON"""
        print(f"[Scrcpy] stream: 收到连接请求, hw_id={hw_id}")

        session = self._sessions.get(hw_id)
        if not session or not session.is_running:
            print(f"[Scrcpy] stream: 会话不存在或已停止")
            await websocket.close(reason="会话不存在或已停止")
            return

        print(f"[Scrcpy] stream: 会话有效, 屏幕: {session.width}x{session.height}")

        # 创建一个队列用于处理视频帧
        video_queue = asyncio.Queue(maxsize=10)

        # 视频帧采集任务（从 TCP 读取并放入队列）
        async def video_collector():
            try:
                reader = session.video_reader
                frame_count = 0
                buffer = bytearray()

                print(f"[Scrcpy] 视频采集任务已启动")
                while session._running:
                    # 读取数据块
                    try:
                        chunk = await reader.read(8192)
                    except asyncio.CancelledError:
                        raise
                    except Exception as read_e:
                        print(f"[Scrcpy] 视频读取错误 {hw_id}: {read_e}")
                        break

                    if not chunk:
                        # EOF - 视频流结束
                        print(f"[Scrcpy] 视频流到达 EOF: {hw_id}")
                        break

                    buffer.extend(chunk)

                    # 解析 H.264 NALU 帧（寻找起始码 00 00 00 01）
                    while len(buffer) > 0:
                        # 查找 NALU 起始码
                        nalu_start = buffer.find(b'\x00\x00\x00\x01')
                        if nalu_start == -1:
                            # 保留最后 3 字节（可能是不完整的起始码）
                            if len(buffer) > 3:
                                buffer = buffer[-3:]
                            break

                        # 跳过起始码之前的垃圾数据
                        if nalu_start > 0:
                            buffer = buffer[nalu_start:]

                        # 查找下一个起始码（帧结束位置）
                        next_start = buffer.find(b'\x00\x00\x00\x01', 4)
                        if next_start == -1:
                            # 帧不完整，等待更多数据
                            break

                        # 提取完整 NALU
                        nalu_data = buffer[4:next_start]
                        buffer = buffer[next_start:]

                        # 分析 NALU 类型
                        if len(nalu_data) > 0:
                            nalu_type = nalu_data[0] & 0x1F
                            is_keyframe = (nalu_type == 5)  # IDR slice
                            is_config = (nalu_type == 7 or nalu_type == 8)  # SPS/PPS

                            frame_count += 1

                            # 封装消息: [Flags(1Byte)][PTS(8Byte)][Length(4Byte)][NALU...]
                            flags_byte = (0x01 if is_config else 0) | (0x02 if is_keyframe else 0)
                            pts = frame_count * 33333
                            msg = struct.pack('>BQI', flags_byte, pts, len(nalu_data)) + nalu_data

                            if is_keyframe:
                                print(f"[Scrcpy] 采集关键帧 #{frame_count}, NALU类型={nalu_type}, 大小={len(nalu_data)}")

                            # 放入队列（如果队列满，丢弃旧帧）
                            try:
                                video_queue.put_nowait(msg)
                            except asyncio.QueueFull:
                                pass  # 丢弃队列中最旧的帧
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"[Scrcpy] 视频采集中断 {hw_id}: {e}")
            finally:
                video_queue.put_nowait(None)  # 信号结束

        # WebSocket 处理任务（发送视频帧，接收控制消息）
        async def websocket_handler():
            try:
                print(f"[Scrcpy] WebSocket 已连接")

                writer = session.control_writer
                screen_w, screen_h = session.width, session.height

                print(f"[Scrcpy] WebSocket 处理任务已启动, 屏幕: {screen_w}x{screen_h}")

                # 注意: 绝对不能向 control socket 发送任何测试/垃圾字节！
                # 任何额外字节都会破坏 scrcpy-server 的消息解析状态机

                # 创建两个任务
                video_task = asyncio.create_task(video_queue.get())
                ws_task = asyncio.create_task(websocket.receive())

                while session._running:
                    # 等待任一任务完成，无超时
                    done, pending = await asyncio.wait([video_task, ws_task], return_when=asyncio.FIRST_COMPLETED)

                    # 取消未完成的任务
                    for task in pending:
                        task.cancel()

                    # 处理完成的任务
                    for task in done:
                        if task.exception():
                            print(f"[Scrcpy] 任务异常: {task.exception()}")
                            break

                        result = task.result()

                        # 视频帧：发送
                        if result is None:
                            # 视频采集结束
                            print(f"[Scrcpy] 视频采集结束")
                            break
                        elif isinstance(result, bytes) or isinstance(result, bytearray):
                            await websocket.send_bytes(result)
                        # WebSocket 消息：处理控制
                        elif isinstance(result, dict):
                            msg_type = result.get("type")
                            if msg_type == "websocket.disconnect":
                                print(f"[Scrcpy] 前端断开连接")
                                break

                            text = result.get("text")
                            if text:
                                try:
                                    event = json.loads(text)
                                    if event["type"] == "touch":
                                        action = event["action"]
                                        # scrcpy v2.5 Position: x/y 是像素坐标 (int32), 不是归一化值
                                        x = max(0, min(screen_w - 1, int(event["x"])))
                                        y = max(0, min(screen_h - 1, int(event["y"])))
                                        # pressure: u16 定点数, 0xFFFF 表示最大压力, 0 表示无压力
                                        pressure = 0xFFFF if action != 1 else 0

                                        # 普通的主触摸点，必须使用正数 ID 也就是 0。
                                        # (不能使用 -2 GENERIC_FINGER，否则会被当作无源虚拟副手指或导致无响应)
                                        POINTER_ID = 0

                                        # scrcpy v2.5 INJECT_TOUCH_EVENT = 32 字节:
                                        # Type(B=1) + Action(B=1) + PointerId(q=8)
                                        # + X(i=4) + Y(i=4) + ScreenW(H=2) + ScreenH(H=2)
                                        # + Pressure(H=2) + ActionButton(I=4) + Buttons(I=4)
                                        payload = struct.pack('>BBqiiHHHII',
                                            0x02,       # type: INJECT_TOUCH_EVENT
                                            action,     # action: 0=DOWN, 1=UP, 2=MOVE
                                            POINTER_ID, # pointer_id (有符号 int64)
                                            x, y,       # 像素坐标 (int32)
                                            screen_w,   # 屏幕宽度 (uint16)
                                            screen_h,   # 屏幕高度 (uint16)
                                            pressure,   # 压力 (uint16 定点数)
                                            0,          # actionButton (int32)
                                            0,          # buttons (int32)
                                        )
                                        print(f"[Scrcpy] 触摸: action={action} x={x} y={y} screen={screen_w}x{screen_h} payload_len={len(payload)} hex={payload.hex()}")
                                        writer.write(payload)
                                        await writer.drain()

                                    elif event["type"] == "keycode":
                                        action = event["action"]
                                        keycode = event["keycode"]
                                        # scrcpy v2.5 INJECT_KEYCODE = 14 字节:
                                        # Type(B=1) + Action(B=1) + Keycode(I=4) + Repeat(I=4) + MetaState(I=4)
                                        payload = struct.pack('>BBIII', 0x00, action, keycode, 0, 0)
                                        writer.write(payload)
                                        await writer.drain()
                                        print(f"[Scrcpy] 按键: keycode={keycode} action={action} payload_len={len(payload)}")

                                except Exception as parse_e:
                                    print(f"[Scrcpy] 控制消息解析错误: {parse_e}")

                    # 创建新任务继续循环
                    video_task = asyncio.create_task(video_queue.get())
                    ws_task = asyncio.create_task(websocket.receive())

            except Exception as e:
                print(f"[Scrcpy] WebSocket 处理中断 {hw_id}: {e}")

        try:
            # 并行运行视频采集和 WebSocket 处理
            t1 = asyncio.create_task(video_collector())
            t2 = asyncio.create_task(websocket_handler())

            done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        except Exception as e:
            print(f"[Scrcpy] stream: 异常 {e}")
            import traceback
            traceback.print_exc()
        finally:
            # WebSocket 断开或视频流结束，立即停止整个会话
            print(f"[Scrcpy] stream 结束，停止会话: {hw_id}")
            await self._stop_internal(hw_id)
            try:
                await websocket.close()
            except:
                pass

    async def stop(self, hw_id: str) -> dict:
        """停止投屏"""
        await self._stop_internal(hw_id)
        return {"success": True, "message": "已停止"}

    async def stop_all(self):
        hw_ids = list(self._sessions.keys())
        for hw_id in hw_ids:
            await self.stop(hw_id)

    def get_status(self, hw_id: str) -> dict:
        """获取投屏状态"""
        session = self._sessions.get(hw_id)
        if not session:
            return {"running": False}

        # 检查进程是否还在运行
        if session.server_process and session.server_process.returncode is not None:
            # 进程已退出，清理会话
            asyncio.create_task(self._stop_internal(hw_id))
            return {"running": False}

        return {"running": session.is_running}

    async def _stop_internal(self, hw_id: str) -> None:
        """内部停止方法，不返回响应"""
        session = self._sessions.get(hw_id)
        if not session:
            return

        session._running = False

        # 1. 关闭 TCP
        if session.video_writer:
            try:
                session.video_writer.close()
            except:
                pass
        if session.control_writer:
            try:
                session.control_writer.close()
            except:
                pass

        # 2. 终止 Process
        if session.server_process:
            try:
                session.server_process.terminate()
                await asyncio.wait_for(session.server_process.wait(), timeout=2.0)
            except:
                try:
                    session.server_process.kill()
                except:
                    pass

        # 3. 删除 Forward
        if session.video_port:
            try:
                adb = get_adb_path()
                env = os.environ.copy()
                env["MSYS_NO_PATHCONV"] = "1"
                await asyncio.create_subprocess_exec(
                    adb, "-s", session.serial, "forward", "--remove", f"tcp:{session.video_port}",
                    env=env
                )
            except:
                pass

        self._sessions.pop(hw_id, None)
        print(f"[ScrcpyWebManager] 投屏已停止: {hw_id}")

    # =========== 内部辅助方法 ===========
    async def _deploy_server(self, serial: str) -> bool:
        server_path = get_scrcpy_server_path()
        adb = get_adb_path()
        remote_path = "/data/local/tmp/scrcpy-server.jar"
        env = os.environ.copy()
        env["MSYS_NO_PATHCONV"] = "1"
        proc = await asyncio.create_subprocess_exec(
            adb, "-s", serial, "push", server_path, remote_path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env=env
        )
        await proc.wait()
        return proc.returncode == 0

    async def _launch_server(self, serial: str, scid: int, config: dict):
        adb = get_adb_path()
        st_awake = "true" if config.get("stay_awake", True) else "false"
        touch = "true" if config.get("show_touches", True) else "false"

        args = [
            adb, "-s", serial, "shell",
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
            "app_process",
            "/", "com.genymobile.scrcpy.Server",
            SCRCPY_VERSION,
            f"scid={scid:08x}",
            "tunnel_forward=true",
            "audio=false",
            "control=true",
            f"max_size={config.get('max_size', 800)}",
            f"max_fps={config.get('max_fps', 30)}",
            f"video_bit_rate={config.get('video_bit_rate', 4000000)}",
            "send_device_meta=true",
            "send_frame_meta=false",
            "send_codec_meta=true",
            "send_dummy_byte=true",
            f"show_touches={touch}",
            f"stay_awake={st_awake}",
            "cleanup=true",
            "power_off_on_close=false",
            "clipboard_autosync=false",
        ]
        env = os.environ.copy()
        env["MSYS_NO_PATHCONV"] = "1"
        return await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )

    async def _connect_socket(self, port: int, read_dummy_byte: bool = False) -> Tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """连接到 scrcpy socket。

        注意：dummy byte 只在第一个 socket (video) 连接时由服务器发送。
        control socket 不会收到 dummy byte，所以不需要读取。

        Args:
            port: 本地端口
            read_dummy_byte: 是否读取 dummy byte（仅 video socket 需要）
        """
        print(f"[_connect_socket] 尝试连接端口 {port}, read_dummy_byte={read_dummy_byte}")
        for attempt in range(30):
            try:
                print(f"[_connect_socket] 尝试 #{attempt+1}/30")
                reader, writer = await asyncio.open_connection("127.0.0.1", port)

                if read_dummy_byte:
                    # 只有 video socket 需要读取 dummy byte
                    try:
                        dummy_byte = await asyncio.wait_for(reader.readexactly(1), timeout=3.0)
                        print(f"[_connect_socket] video socket 连接成功, dummy_byte={dummy_byte.hex()}")
                        return reader, writer
                    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError) as e:
                        print(f"[_connect_socket] video socket 验证失败: {e}, 等待重试...")
                        writer.close()
                        await writer.wait_closed()
                        await asyncio.sleep(0.5)
                        continue
                else:
                    # control socket 不需要读取 dummy byte
                    print(f"[_connect_socket] control socket 连接成功")
                    return reader, writer
            except ConnectionRefusedError:
                await asyncio.sleep(0.5)
            except Exception as e:
                print(f"[_connect_socket] 连接异常: {e}")
                await asyncio.sleep(0.5)

        raise ConnectionError("Timeout connecting to scrcpy tunnel")

    async def _read_device_meta(self, reader: asyncio.StreamReader) -> Tuple[str, str, int, int]:
        """
        读取设备元数据和编解码器元数据。

        注意：只有在 video 和 control socket 都连接后，服务器才会发送这些数据！

        scrcpy v2.5 协议顺序（当 send_device_meta=true, send_codec_meta=true 时）：
        1. Device name (64 bytes) - UTF-8 编码，以 \0 填充
        2. Codec meta (12 bytes) - codec_id(4) + width(4) + height(4)

        Returns:
            (device_name, codec_name, width, height)
        """
        # 读取 device name = 64 bytes
        print("[_read_device_meta] 读取设备名称 (64 bytes)...")
        device_name_raw = await asyncio.wait_for(reader.readexactly(64), timeout=5.0)
        device_name = device_name_raw.rstrip(b'\x00').decode('utf-8', errors='replace')
        print(f"[_read_device_meta] 设备名称: {device_name}")

        # 读取 codec meta = 12 bytes
        print("[_read_device_meta] 读取编解码器元数据 (12 bytes)...")
        codec_meta = await asyncio.wait_for(reader.readexactly(12), timeout=5.0)
        codec_id = struct.unpack('>I', codec_meta[0:4])[0]
        width = struct.unpack('>I', codec_meta[4:8])[0]
        height = struct.unpack('>I', codec_meta[8:12])[0]
        print(f"[_read_device_meta] Codec ID: 0x{codec_id:08x}, 分辨率: {width}x{height}")

        codec_map = {0x68323634: "h264", 0x68323635: "h265", 0x00617631: "av1"}
        codec_name = codec_map.get(codec_id, "h264")

        return device_name, codec_name, width, height