"""
Scrcpy Manager for ADB Master.
管理 scrcpy 投屏进程的生命周期。

核心设计:
- 将 scrcpy 文件内置于 EncyHub/assets/scrcpy/ 目录
- 通过 ADB 环境变量强制 scrcpy 使用 EncyHub 的 adb.exe (防止版本冲突)
- 通过 SCRCPY_SERVER_PATH 环境变量指定内置 scrcpy-server 路径
- 每个设备独立进程、独立窗口，支持多设备同时投屏
"""

import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Optional, Dict

from .path_utils import get_scrcpy_exe_path, get_scrcpy_server_path, get_adb_path


@dataclass
class ScrcpySession:
    """单个设备的 scrcpy 投屏会话"""
    hw_id: str                           # 设备 hardware_id
    serial: str                          # ADB serial (用于 -s 参数)
    process: asyncio.subprocess.Process  # scrcpy 子进程
    start_time: float                    # 启动时间戳
    config: dict = field(default_factory=dict)  # 启动参数

    @property
    def is_running(self) -> bool:
        return self.process.returncode is None

    @property
    def uptime_seconds(self) -> float:
        if self.is_running:
            return time.time() - self.start_time
        return 0


class ScrcpyManager:
    """
    Scrcpy 进程管理器。

    职责:
    1. 启动 scrcpy.exe 子进程 (独立窗口投屏)
    2. 管理多设备投屏会话的生命周期
    3. 自动检测进程退出并清理状态
    4. 提供状态查询接口
    """

    def __init__(self):
        self._sessions: Dict[str, ScrcpySession] = {}  # hw_id → session

    async def start(
        self,
        hw_id: str,
        serial: str,
        device_name: str = "",
        max_size: int = 800,
        max_fps: int = 30,
        video_bit_rate: str = "4M",
        stay_awake: bool = True,
        show_touches: bool = True,
        turn_screen_off: bool = False,
        no_audio: bool = True,
    ) -> dict:
        """
        启动 scrcpy 投屏。

        Args:
            hw_id: 设备 hardware_id
            serial: ADB serial (如 abc123 或 192.168.1.5:5555)
            device_name: 显示名称 (用于窗口标题)
            max_size: 最大分辨率 (宽或高, 0=原始分辨率)
            max_fps: 最大帧率
            video_bit_rate: 视频码率 (如 "4M")
            stay_awake: 保持亮屏
            show_touches: 显示触摸点
            turn_screen_off: 关闭设备屏幕 (仅投屏到窗口)
            no_audio: 禁用音频 (降低延迟)

        Returns:
            {"success": bool, "message": str, "pid": int|None}
        """
        # 1. 检查是否已有投屏运行
        if hw_id in self._sessions and self._sessions[hw_id].is_running:
            session = self._sessions[hw_id]
            return {
                "success": False,
                "message": f"设备已在投屏中 (PID: {session.process.pid})",
                "pid": session.process.pid,
            }

        # 2. 验证 scrcpy.exe 存在
        scrcpy_exe = get_scrcpy_exe_path()
        if not os.path.exists(scrcpy_exe):
            return {
                "success": False,
                "message": f"scrcpy 未找到: {scrcpy_exe}",
                "pid": None,
            }

        # 3. 构建启动命令
        cmd = [scrcpy_exe, "-s", serial]

        if max_size > 0:
            cmd.extend(["-m", str(max_size)])
        cmd.extend(["--max-fps", str(max_fps)])
        cmd.extend(["-b", video_bit_rate])

        if stay_awake:
            cmd.append("--stay-awake")
        if show_touches:
            cmd.append("--show-touches")
        if turn_screen_off:
            cmd.append("--turn-screen-off")
        if no_audio:
            cmd.append("--no-audio")

        # 窗口标题: 包含设备名以便区分多设备
        window_title = f"[EncyHub] {device_name or serial}"
        cmd.extend(["--window-title", window_title])

        # 4. 设置环境变量
        env = os.environ.copy()
        # 关键: 强制 scrcpy 使用 EncyHub 的 ADB (防止 ADB 版本冲突)
        env["ADB"] = get_adb_path()
        # 关键: 指定内置的 scrcpy-server 路径
        env["SCRCPY_SERVER_PATH"] = get_scrcpy_server_path()

        # 5. 启动进程
        # Windows: CREATE_NO_WINDOW (0x08000000) 抑制黑色控制台窗口
        # 注: 不影响 scrcpy 的 SDL 图形窗口
        creation_flags = 0x08000000 if sys.platform == "win32" else 0

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=creation_flags,
            )
        except FileNotFoundError:
            return {
                "success": False,
                "message": f"无法执行 scrcpy: {scrcpy_exe}",
                "pid": None,
            }
        except Exception as e:
            return {
                "success": False,
                "message": f"启动 scrcpy 失败: {e}",
                "pid": None,
            }

        # 6. 等待短暂时间，检查是否立即崩溃
        # scrcpy 如果设备不存在、ADB 异常等，通常在 1 秒内退出
        try:
            await asyncio.wait_for(proc.wait(), timeout=1.5)
            # 1.5 秒内就退出了，说明启动失败
            stderr_data = b""
            try:
                stderr_data = await asyncio.wait_for(proc.stderr.read(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            error_msg = stderr_data.decode("utf-8", errors="replace").strip()
            # 截取错误信息的关键部分
            if len(error_msg) > 200:
                error_msg = error_msg[:200] + "..."
            return {
                "success": False,
                "message": f"scrcpy 启动后立即退出: {error_msg or '未知错误'}",
                "pid": None,
            }
        except asyncio.TimeoutError:
            # 1.5 秒内没退出 = 启动成功
            pass

        # 7. 记录会话
        config = {
            "max_size": max_size,
            "max_fps": max_fps,
            "video_bit_rate": video_bit_rate,
            "show_touches": show_touches,
            "turn_screen_off": turn_screen_off,
            "no_audio": no_audio,
        }
        session = ScrcpySession(
            hw_id=hw_id,
            serial=serial,
            process=proc,
            start_time=time.time(),
            config=config,
        )
        self._sessions[hw_id] = session

        # 8. 后台监控进程退出 (用户手动关窗口时自动清理)
        asyncio.create_task(self._monitor_exit(hw_id, proc))

        print(f"[ScrcpyManager] 投屏已启动: {device_name or serial} (PID: {proc.pid})")
        return {
            "success": True,
            "message": f"投屏已启动 (PID: {proc.pid})",
            "pid": proc.pid,
        }

    async def stop(self, hw_id: str) -> dict:
        """
        停止指定设备的 scrcpy 投屏。

        Returns:
            {"success": bool, "message": str}
        """
        session = self._sessions.get(hw_id)
        if not session or not session.is_running:
            self._sessions.pop(hw_id, None)
            return {"success": True, "message": "投屏已停止 (未运行)"}

        pid = session.process.pid
        try:
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                # terminate 无效则强制 kill
                session.process.kill()
                await session.process.wait()
        except ProcessLookupError:
            pass  # 进程已退出

        self._sessions.pop(hw_id, None)
        print(f"[ScrcpyManager] 投屏已停止: {hw_id} (PID: {pid})")
        return {"success": True, "message": "投屏已停止"}

    def get_status(self, hw_id: str) -> dict:
        """
        获取指定设备的投屏状态。

        Returns:
            {"running": bool, "pid": int|None, "uptime": float, "config": dict}
        """
        session = self._sessions.get(hw_id)
        if not session or not session.is_running:
            # 清理已退出的会话
            self._sessions.pop(hw_id, None)
            return {"running": False, "pid": None, "uptime": 0, "config": {}}

        return {
            "running": True,
            "pid": session.process.pid,
            "uptime": round(session.uptime_seconds, 1),
            "config": session.config,
        }

    def get_all_sessions(self) -> dict:
        """获取所有活跃投屏会话的状态摘要。"""
        result = {}
        dead_keys = []
        for hw_id, session in self._sessions.items():
            if session.is_running:
                result[hw_id] = {
                    "pid": session.process.pid,
                    "serial": session.serial,
                    "uptime": round(session.uptime_seconds, 1),
                }
            else:
                dead_keys.append(hw_id)
        # 清理已退出的会话
        for k in dead_keys:
            self._sessions.pop(k, None)
        return result

    async def stop_all(self):
        """停止所有投屏 (用于应用关闭时清理，防止僵尸进程)。"""
        hw_ids = list(self._sessions.keys())
        for hw_id in hw_ids:
            await self.stop(hw_id)
        if hw_ids:
            print(f"[ScrcpyManager] 已清理 {len(hw_ids)} 个投屏会话")

    async def _monitor_exit(self, hw_id: str, proc: asyncio.subprocess.Process):
        """
        后台监控 scrcpy 进程退出。
        当用户手动关闭 scrcpy 窗口或设备断连导致退出时，自动清理会话记录。
        """
        await proc.wait()
        session = self._sessions.get(hw_id)
        if session and session.process is proc:
            self._sessions.pop(hw_id, None)
            print(f"[ScrcpyManager] 投屏进程已退出: {hw_id} (PID: {proc.pid})")
