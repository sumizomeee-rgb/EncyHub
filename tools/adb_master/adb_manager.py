"""
ADB Manager for Kuro ADB Master.
Provides async ADB command execution and device management.
"""

import asyncio
import re
from dataclasses import dataclass
from typing import Optional, Callable, List
from .path_utils import get_adb_path, get_logcat_filename


@dataclass
class DeviceConnection:
    """Represents a single ADB connection (USB or WiFi)."""
    serial: str  # ADB identifier (may be IP:port for WiFi or USB serial)
    status: str  # 'device', 'offline', 'unauthorized'
    model: Optional[str] = None
    hardware_id: Optional[str] = None  # ro.serialno - the TRUE hardware identifier
    
    @property
    def is_online(self) -> bool:
        return self.status == 'device'
    
    @property
    def is_wifi_connection(self) -> bool:
        """Check if this is a WiFi connection (IP:port format)."""
        return ':' in self.serial and self.serial.split(':')[-1].isdigit()
    
    @property
    def connection_type(self) -> str:
        """Return 'WiFi' or 'USB' based on serial format."""
        return 'WiFi' if self.is_wifi_connection else 'USB'


@dataclass
class UnifiedDevice:
    """
    Represents a single physical device that may have multiple connections.
    Uses hardware_id (ro.serialno) as the primary key for identity.
    """
    hardware_id: str  # The TRUE unique identifier (ro.serialno)
    model: Optional[str] = None
    usb_serial: Optional[str] = None  # USB connection serial if available
    wifi_address: Optional[str] = None  # WiFi connection (IP:port) if available
    wifi_ip: Optional[str] = None  # Just the IP part for display
    
    @property
    def is_online(self) -> bool:
        """Device is online if any connection is active."""
        return self.usb_serial is not None or self.wifi_address is not None
    
    @property
    def connection_status(self) -> str:
        """Return human-readable connection status."""
        if self.usb_serial and self.wifi_address:
            return "WiFi & USB"
        elif self.wifi_address:
            return "WiFi only"
        elif self.usb_serial:
            return "USB only"
        else:
            return "Offline"
    
    @property
    def active_serial(self) -> Optional[str]:
        """
        Return the best available serial for ADB commands.
        Prefers USB for stability, falls back to WiFi.
        """
        return self.usb_serial or self.wifi_address
    
    @property
    def display_name(self) -> str:
        """Display name for UI (use USB serial or IP)."""
        if self.usb_serial:
            return self.usb_serial
        elif self.wifi_address:
            return self.wifi_address
        return self.hardware_id


# Keep DeviceInfo as alias for backward compatibility
DeviceInfo = DeviceConnection


class AdbManager:
    """Async ADB command manager with unified device identity tracking."""
    
    def __init__(self):
        self.adb_path = get_adb_path()
        self._logcat_tasks: dict[str, asyncio.Task] = {}
        self._logcat_stop_flags: dict[str, bool] = {}
        
        # Hardware ID mapping: ADB serial -> hardware_id (ro.serialno)
        # This allows tracking device identity across USB/WiFi connection changes
        self._hardware_id_map: dict[str, str] = {}
        
        # Reverse mapping: hardware_id -> list of active ADB serials
        self._active_connections: dict[str, list[str]] = {}
    
    async def _run_command(self, *args, timeout: float = 30.0) -> tuple[int, str, str]:
        """
        Run an ADB command asynchronously.
        
        Args:
            *args: Command arguments (will be prefixed with adb path)
            timeout: Command timeout in seconds
            
        Returns:
            Tuple of (return_code, stdout, stderr)
        """
        cmd = [self.adb_path] + list(args)
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=0x08000000  # CREATE_NO_WINDOW on Windows
            )
            
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )
            
            return (
                process.returncode,
                stdout.decode('utf-8', errors='replace'),
                stderr.decode('utf-8', errors='replace')
            )
        except asyncio.TimeoutError:
            process.kill()
            return (-1, '', 'Command timed out')
        except Exception as e:
            return (-1, '', str(e))
    
    async def get_raw_connections(self) -> List[DeviceConnection]:
        """
        Get list of raw ADB connections (not deduplicated).
        
        Returns:
            List of DeviceConnection objects
        """
        returncode, stdout, stderr = await self._run_command('devices', '-l')
        
        if returncode != 0:
            return []
        
        connections = []
        lines = stdout.strip().split('\n')[1:]  # Skip header line
        
        for line in lines:
            if not line.strip():
                continue
            
            parts = line.split()
            if len(parts) >= 2:
                serial = parts[0]
                status = parts[1]
                
                # Extract model if available
                model = None
                for part in parts[2:]:
                    if part.startswith('model:'):
                        model = part.split(':')[1]
                        break
                
                connections.append(DeviceConnection(
                    serial=serial,
                    status=status,
                    model=model
                ))
        
        # Enrich with hardware IDs
        for conn in connections:
            if conn.is_online:
                conn.hardware_id = await self.get_hardware_id(conn.serial)
                # Update mapping
                if conn.hardware_id:
                    self._hardware_id_map[conn.serial] = conn.hardware_id
        
        return connections
    
    async def get_devices(self) -> List[DeviceConnection]:
        """
        Get list of connected ADB devices (backward compatible).
        
        Returns:
            List of DeviceConnection objects
        """
        return await self.get_raw_connections()
    
    async def get_unified_devices(self) -> List[UnifiedDevice]:
        """
        Get list of unified devices, deduplicated by hardware_id.
        Same physical device with USB + WiFi connections appears as one entry.
        
        Returns:
            List of UnifiedDevice objects
        """
        connections = await self.get_raw_connections()
        
        # Group connections by hardware_id
        device_map: dict[str, UnifiedDevice] = {}
        
        for conn in connections:
            if not conn.hardware_id or not conn.is_online:
                continue
            
            hw_id = conn.hardware_id
            
            if hw_id not in device_map:
                device_map[hw_id] = UnifiedDevice(
                    hardware_id=hw_id,
                    model=conn.model
                )
            
            device = device_map[hw_id]
            
            if conn.is_wifi_connection:
                device.wifi_address = conn.serial
                # Extract IP from "IP:port" format
                device.wifi_ip = conn.serial.split(':')[0]
            else:
                device.usb_serial = conn.serial
                # Also get WiFi IP for USB device (to show in UI)
                ip = await self.get_device_ip(conn.serial)
                if ip:
                    device.wifi_ip = ip
        
        # Update active connections mapping
        self._active_connections.clear()
        for hw_id, device in device_map.items():
            serials = []
            if device.usb_serial:
                serials.append(device.usb_serial)
            if device.wifi_address:
                serials.append(device.wifi_address)
            self._active_connections[hw_id] = serials
        
        return list(device_map.values())
    
    def get_hardware_id_for_serial(self, serial: str) -> Optional[str]:
        """
        Get cached hardware_id for a given ADB serial.
        
        Args:
            serial: ADB serial (USB or WiFi address)
            
        Returns:
            Hardware ID or None
        """
        return self._hardware_id_map.get(serial)
    
    def get_active_serials_for_hardware_id(self, hardware_id: str) -> List[str]:
        """
        Get all active ADB serials for a hardware_id.
        
        Args:
            hardware_id: Device hardware ID (ro.serialno)
            
        Returns:
            List of active serials (could be USB, WiFi, or both)
        """
        return self._active_connections.get(hardware_id, [])
    
    def get_fallback_serial(self, hardware_id: str, current_serial: str) -> Optional[str]:
        """
        Find an alternative serial if current one is unavailable.
        Used for hot-switching when USB disconnects but WiFi is still active.
        
        Args:
            hardware_id: Device hardware ID
            current_serial: The serial that became unavailable
            
        Returns:
            Alternative serial or None
        """
        serials = self.get_active_serials_for_hardware_id(hardware_id)
        for serial in serials:
            if serial != current_serial:
                return serial
        return None
    
    async def get_hardware_id(self, serial: str) -> Optional[str]:
        """
        Get unique hardware identifier for a device.
        Uses ro.serialno as the PRIMARY identifier (per user requirement).
        
        Args:
            serial: Device ADB serial
            
        Returns:
            Hardware ID string (ro.serialno) or None
        """
        # Check cache first
        if serial in self._hardware_id_map:
            return self._hardware_id_map[serial]
        
        # PRIMARY: Use ro.serialno (as per user requirement)
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell',
            'getprop', 'ro.serialno',
            timeout=5.0
        )
        
        if returncode == 0 and stdout.strip():
            hw_id = stdout.strip()
            self._hardware_id_map[serial] = hw_id
            return hw_id
        
        # Fallback to Android ID if ro.serialno not available
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 
            'settings', 'get', 'secure', 'android_id',
            timeout=5.0
        )
        
        if returncode == 0 and stdout.strip():
            hw_id = stdout.strip()
            self._hardware_id_map[serial] = hw_id
            return hw_id
        
        return None
    
    async def disconnect_offline_devices(self) -> List[str]:
        """
        Disconnect all offline/zombie WiFi connections.
        
        Returns:
            List of disconnected addresses
        """
        devices = await self.get_devices()
        disconnected = []
        
        for device in devices:
            if device.is_wifi_connection and not device.is_online:
                # This is an offline WiFi connection - disconnect it
                await self.disconnect_wifi(device.serial)
                disconnected.append(device.serial)
        
        return disconnected
    
    async def check_wifi_reachable(self, ip: str, timeout: float = 2.0) -> bool:
        """
        Check if a WiFi IP is reachable via ping.
        
        Args:
            ip: IP address to check
            timeout: Timeout in seconds
            
        Returns:
            True if reachable
        """
        import subprocess
        try:
            # Windows ping with 1 packet and timeout
            result = subprocess.run(
                ['ping', '-n', '1', '-w', str(int(timeout * 1000)), ip],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout + 1,
                creationflags=0x08000000  # CREATE_NO_WINDOW
            )
            return result.returncode == 0
        except Exception:
            return False
    
    async def get_device_ip(self, serial: str) -> Optional[str]:
        """
        Get the WiFi IP address of a device.
        
        Args:
            serial: Device serial number
            
        Returns:
            IP address string or None if not found
        """
        # Try wlan0 interface first
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'ip', 'route'
        )
        
        if returncode == 0:
            # Parse IP from route output
            # Example: "192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.100"
            match = re.search(r'src\s+(\d+\.\d+\.\d+\.\d+)', stdout)
            if match:
                return match.group(1)
        
        # Fallback: try ifconfig
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'ifconfig', 'wlan0'
        )
        
        if returncode == 0:
            match = re.search(r'inet\s+addr:(\d+\.\d+\.\d+\.\d+)', stdout)
            if match:
                return match.group(1)
        
        return None
    
    async def enable_tcpip(self, serial: str, port: int = 5555) -> bool:
        """
        Enable TCP/IP mode on a device.
        
        Args:
            serial: Device serial number
            port: TCP port to use
            
        Returns:
            True if successful
        """
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'tcpip', str(port),
            timeout=10.0
        )
        
        # Give device time to restart adbd
        await asyncio.sleep(2)
        
        return returncode == 0 or 'restarting' in stdout.lower()
    
    async def connect_wifi(self, ip: str, port: int = 5555) -> tuple[bool, str]:
        """
        Connect to a device over WiFi.
        
        Args:
            ip: Device IP address
            port: TCP port
            
        Returns:
            Tuple of (success, message)
        """
        address = f'{ip}:{port}'
        returncode, stdout, stderr = await self._run_command(
            'connect', address,
            timeout=15.0
        )
        
        output = stdout + stderr
        success = 'connected' in output.lower() and 'cannot' not in output.lower()
        
        return success, output.strip()
    
    async def disconnect_wifi(self, address: str) -> bool:
        """
        Disconnect a WiFi-connected device.
        
        Args:
            address: Device address (IP:port)
            
        Returns:
            True if successful
        """
        returncode, stdout, stderr = await self._run_command('disconnect', address)
        return returncode == 0
    
    async def wifi_handshake(self, serial: str) -> tuple[bool, str, Optional[str]]:
        """
        Perform complete WiFi handshake: get IP -> enable tcpip -> connect.
        
        Args:
            serial: USB-connected device serial
            
        Returns:
            Tuple of (success, message, wifi_address)
        """
        # Step 1: Get device IP
        ip = await self.get_device_ip(serial)
        if not ip:
            return False, 'Failed to get device IP. Is WiFi enabled?', None
        
        # Step 2: Enable TCP/IP mode
        if not await self.enable_tcpip(serial):
            return False, 'Failed to enable TCP/IP mode', None
        
        # Step 3: Connect via WiFi
        success, message = await self.connect_wifi(ip)
        
        if success:
            wifi_address = f'{ip}:5555'
            return True, f'Connected to {wifi_address}', wifi_address
        else:
            return False, f'Connection failed: {message}', None
    
    async def start_logcat(
        self,
        serial: str,
        on_line: Optional[Callable[[str], None]] = None
    ) -> str:
        """
        Start capturing logcat output.
        
        Args:
            serial: Device serial
            on_line: Optional callback for each log line
            
        Returns:
            Path to the log file
        """
        log_file = get_logcat_filename(serial)
        self._logcat_stop_flags[serial] = False
        
        async def capture_logcat():
            cmd = [self.adb_path, '-s', serial, 'logcat', '-v', 'time']
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=0x08000000  # CREATE_NO_WINDOW
            )
            
            try:
                with open(log_file, 'w', encoding='utf-8') as f:
                    while not self._logcat_stop_flags.get(serial, True):
                        try:
                            line = await asyncio.wait_for(
                                process.stdout.readline(),
                                timeout=0.5
                            )
                            if line:
                                decoded = line.decode('utf-8', errors='replace')
                                f.write(decoded)
                                f.flush()
                                if on_line:
                                    on_line(decoded.strip())
                        except asyncio.TimeoutError:
                            continue
                        except Exception:
                            break
            finally:
                process.kill()
                await process.wait()
        
        task = asyncio.create_task(capture_logcat())
        self._logcat_tasks[serial] = task
        
        return log_file
    
    def stop_logcat(self, serial: str):
        """Stop logcat capture for a device."""
        self._logcat_stop_flags[serial] = True
        
        if serial in self._logcat_tasks:
            task = self._logcat_tasks.pop(serial)
            task.cancel()
    
    def is_logcat_running(self, serial: str) -> bool:
        """Check if logcat is running for a device."""
        return serial in self._logcat_tasks and not self._logcat_tasks[serial].done()
    
    async def push_file(
        self,
        serial: str,
        local_path: str,
        remote_path: str,
        on_progress: Optional[Callable[[str], None]] = None
    ) -> tuple[bool, str]:
        """
        Push a file or folder to device.
        
        Args:
            serial: Device serial
            local_path: Local file/folder path
            remote_path: Remote destination path
            on_progress: Optional progress callback
            
        Returns:
            Tuple of (success, message)
        """
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'push', local_path, remote_path,
            timeout=300.0  # 5 minutes for large files
        )
        
        output = stdout + stderr
        success = returncode == 0 and 'error' not in output.lower()
        
        return success, output.strip()
    
    async def pull_file(
        self,
        serial: str,
        remote_path: str,
        local_path: str,
        on_progress: Optional[Callable[[str], None]] = None
    ) -> tuple[bool, str]:
        """
        Pull a file or folder from device.
        
        Args:
            serial: Device serial
            remote_path: Remote file/folder path
            local_path: Local destination path
            on_progress: Optional progress callback
            
        Returns:
            Tuple of (success, message)
        """
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'pull', remote_path, local_path,
            timeout=300.0  # 5 minutes for large files
        )
        
        output = stdout + stderr
        success = returncode == 0 and 'error' not in output.lower()
        
        return success, output.strip()
    
    async def get_current_app_package(self, serial: str) -> Optional[str]:
        """
        Get the package name of the currently focused app.
        
        Args:
            serial: Device serial
            
        Returns:
            Package name or None if not found
        """
        # Try mCurrentFocus (works on most devices)
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'dumpsys', 'window', 'displays'
        )
        
        if returncode == 0:
            # Look for "mCurrentFocus=Window{... u0 com.example.package/...}"
            # Pattern: mCurrentFocus=Window{<token> <user> <package>/<activity>}
            # Capture <package>
            match = re.search(r'mCurrentFocus=Window\{.*?\s+(?:u\d+\s+)?([a-zA-Z0-9_.]+)/', stdout)
            if match:
                return match.group(1)
        
        # Fallback: mResumedActivity
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'dumpsys', 'activity', 'activities'
        )
        
        if returncode == 0:
            # Look for "ResumedActivity: ActivityRecord{... u0 com.example.package/...}"
            match = re.search(r'ResumedActivity:.*?\s+(?:u\d+\s+)?([a-zA-Z0-9_.]+)/', stdout)
            if match:
                return match.group(1)
                
        return None

    async def stop_app(self, serial: str, package_name: str) -> bool:
        """
        Force stop an application.
        
        Args:
            serial: Device serial
            package_name: Package name to stop
            
        Returns:
            True if successful
        """
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'am', 'force-stop', package_name
        )
        return returncode == 0

    async def start_app(self, serial: str, package_name: str) -> bool:
        """
        Start an application (Launch Main Activity).
        Uses monkey tool to launch the package without knowing activity name.
        
        Args:
            serial: Device serial
            package_name: Package name to start
            
        Returns:
            True if successful
        """
        # "monkey -p <package> -c android.intent.category.LAUNCHER 1"
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'shell', 'monkey',
            '-p', package_name,
            '-c', 'android.intent.category.LAUNCHER',
            '1'
        )
        
        output = stdout + stderr
        # Monkey output usually contains "Events injected: 1" on success
        # Or no error means it ran.
        return returncode == 0 and 'error' not in output.lower() and 'No activities found' not in output

    async def restart_app(self, serial: str) -> tuple[bool, str, Optional[str]]:
        """
        Restart the current app (Stop -> Start).
        
        Args:
            serial: Device serial
            
        Returns:
            Tuple of (success, message, package_name)
        """
        package = await self.get_current_app_package(serial)
        
        if not package:
            return False, "No active app found (Launcher or Unknown)", None
        
        # Check against common Launcher packages if needed, but "mCurrentFocus" usually returns generic launcher name
        # if on home screen. We might want to filter common launchers if user requested "friendly prompt".
        # For now, we will perform the action. If it is a launcher, it just restarts the launcher.
        # User requirement: "如果当前设备桌面没有任何 App 运行（如在 Launcher 界面），点击重启按钮时应友好提示"
        # Common launcher keywords: "launcher", "home". But packages vary wildly (com.sec.android.app.launcher, com.google.android.apps.nexuslauncher)
        
        if 'launcher' in package.lower() or 'home' in package.lower():
             return False, f"Detected Launcher ({package}). Please open an App first.", package

        # Stop
        if not await self.stop_app(serial, package):
            return False, f"Failed to stop {package}", package
            
        # Small delay to ensure process death
        await asyncio.sleep(0.5)
        
        # Start
        if await self.start_app(serial, package):
            return True, f"Restarted {package}", package
        else:
            return False, f"Stopped but failed to start {package}", package

    async def install_apk(self, serial: str, apk_path: str) -> tuple[bool, str]:
        """
        Install an APK on the device.
        Uses -r flag to allow reinstall/overwrite.
        """
        returncode, stdout, stderr = await self._run_command(
            '-s', serial, 'install', '-r', apk_path,
            timeout=120.0
        )

        output = (stdout + stderr).strip()
        success = returncode == 0 and 'Success' in output

        return success, output


# Global instance
adb_manager = AdbManager()
