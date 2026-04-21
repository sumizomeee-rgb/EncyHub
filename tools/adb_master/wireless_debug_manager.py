"""
Wireless Debug Manager for ADB Master.
Handles Android 11+ wireless debugging: mDNS discovery, adb pair, identity verification.
"""

import asyncio
import re
import sys
from dataclasses import dataclass, field
from typing import Optional, Callable, Awaitable


@dataclass
class MdnsService:
    service_name: str
    service_type: str
    ip: str
    port: int


@dataclass
class WirelessScanResult:
    mdns_available: bool
    pairing_services: list[MdnsService] = field(default_factory=list)
    connect_services: list[MdnsService] = field(default_factory=list)
    error: Optional[str] = None


class WirelessDebugManager:

    _SUBPROCESS_KWARGS = {"creationflags": 0x08000000} if sys.platform == "win32" else {}

    def __init__(self, run_command: Callable[..., Awaitable[tuple[int, str, str]]], adb_path: str):
        self._run = run_command
        self._adb_path = adb_path

    async def check_adb_version(self) -> tuple[bool, str]:
        returncode, stdout, stderr = await self._run('version', timeout=5.0)
        output = stdout + stderr
        match = re.search(r'Version\s+(\d+\.\d+\.\d+)', output)
        if not match:
            return False, output.strip()
        version_str = match.group(1)
        parts = version_str.split('.')
        try:
            major = int(parts[0])
            minor = int(parts[1]) if len(parts) >= 2 else 0
            revision = int(parts[2]) if len(parts) >= 3 else 0
        except ValueError:
            return False, version_str
        meets = (major, minor, revision) >= (1, 0, 41)
        return meets, version_str

    async def check_mdns_available(self) -> tuple[bool, str]:
        returncode, stdout, stderr = await self._run('mdns', 'check', timeout=3.0)
        output = (stdout + stderr).strip()
        if 'running' in output.lower() and 'not' not in output.lower():
            return True, output
        if returncode == 0 and 'mdns daemon' in output.lower():
            return True, output
        # adb 35+ has built-in mDNS that works even when "mdns check" reports
        # daemon unavailable or times out — verify with "mdns services"
        rc2, out2, err2 = await self._run('mdns', 'services', timeout=10.0)
        combined = (out2 + err2).strip().lower()
        if rc2 == 0 and 'timed out' not in combined and 'error' not in combined:
            return True, 'builtin'
        if 'timed out' in output.lower() or 'timed out' in combined:
            return False, 'timeout'
        return False, 'unavailable'

    async def scan_mdns_services(self) -> WirelessScanResult:
        available, msg = await self.check_mdns_available()
        if not available:
            return WirelessScanResult(
                mdns_available=False,
                error=msg,
            )

        returncode, stdout, stderr = await self._run('mdns', 'services', timeout=10.0)
        output = stdout + stderr
        services = self._parse_mdns_output(output)

        pairing = [s for s in services if 'pairing' in s.service_type]
        connect = [s for s in services if 'connect' in s.service_type]

        return WirelessScanResult(
            mdns_available=True,
            pairing_services=pairing,
            connect_services=connect,
        )

    @staticmethod
    def _parse_mdns_output(output: str) -> list[MdnsService]:
        services = []
        for line in output.strip().split('\n'):
            line = line.strip()
            match = re.match(
                r'(\S+)\s+(_adb-tls-(?:pairing|connect)\._tcp\.?)\s+(\d+\.\d+\.\d+\.\d+):(\d+)',
                line,
            )
            if match:
                services.append(MdnsService(
                    service_name=match.group(1),
                    service_type=match.group(2),
                    ip=match.group(3),
                    port=int(match.group(4)),
                ))
        return services

    async def pair_device(self, ip: str, port: int, code: str) -> tuple[bool, str]:
        address = f'{ip}:{port}'
        try:
            process = await asyncio.create_subprocess_exec(
                self._adb_path, 'pair', address,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **self._SUBPROCESS_KWARGS,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(input=f'{code}\n'.encode()),
                timeout=60.0,
            )
        except asyncio.TimeoutError:
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass
            return False, '配对超时，请确认手机上的配对码仍然有效'
        except Exception as e:
            return False, str(e)

        stdout = stdout_bytes.decode('utf-8', errors='replace')
        stderr = stderr_bytes.decode('utf-8', errors='replace')
        output = stdout + stderr

        if 'Successfully paired' in output:
            return True, output.strip()
        if 'Failed' in output or 'failed' in output or 'error' in output.lower():
            return False, f'配对失败: {output.strip()}'
        return False, f'未知结果: {output.strip()}'

    async def find_connect_port_via_mdns(self, ip: str) -> Optional[int]:
        for _ in range(3):
            scan = await self.scan_mdns_services()
            if scan.mdns_available:
                for svc in scan.connect_services:
                    if svc.ip == ip:
                        return svc.port
            await asyncio.sleep(2)
        return None

    async def connect_device(self, ip: str, port: int) -> tuple[bool, str]:
        address = f'{ip}:{port}'
        returncode, stdout, stderr = await self._run('connect', address, timeout=15.0)
        output = (stdout + stderr).strip()
        success = 'connected' in output.lower() and 'cannot' not in output.lower()
        return success, output

    async def verify_device_identity(
        self, serial: str, expected_hw_id: Optional[str] = None,
    ) -> tuple[bool, Optional[str]]:
        returncode, stdout, stderr = await self._run(
            '-s', serial, 'shell', 'getprop', 'ro.serialno', timeout=5.0,
        )
        actual_hw_id = stdout.strip() if returncode == 0 else None

        if not actual_hw_id:
            returncode, stdout, stderr = await self._run(
                '-s', serial, 'shell', 'settings', 'get', 'secure', 'android_id',
                timeout=5.0,
            )
            actual_hw_id = stdout.strip() if returncode == 0 else None

        if not actual_hw_id:
            return False, None

        if expected_hw_id and actual_hw_id != expected_hw_id:
            await self._run('disconnect', serial)
            return False, actual_hw_id

        return True, actual_hw_id

    async def get_device_model(self, serial: str) -> Optional[str]:
        returncode, stdout, stderr = await self._run(
            '-s', serial, 'shell', 'getprop', 'ro.product.model', timeout=5.0,
        )
        return stdout.strip() if returncode == 0 and stdout.strip() else None
