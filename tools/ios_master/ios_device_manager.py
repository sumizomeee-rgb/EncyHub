"""
iOS Device Manager for iOS Master.
Wraps pymobiledevice3 to provide async device management.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Callable


@dataclass
class iOSDevice:
    udid: str
    name: str = ""
    product_type: str = ""
    ios_version: str = ""
    connection_type: str = "USB"

    @property
    def display_name(self) -> str:
        return self.name or self.product_type or self.udid[:16]


class iOSDeviceManager:

    def __init__(self):
        self._syslog_tasks: dict[str, asyncio.Task] = {}
        self._syslog_stop_events: dict[str, asyncio.Event] = {}

    # ── Device Discovery ──

    async def get_devices(self) -> List[iOSDevice]:
        return await asyncio.to_thread(self._get_devices_sync)

    def _get_devices_sync(self) -> List[iOSDevice]:
        import asyncio as _aio
        try:
            from pymobiledevice3.usbmux import list_devices
            mux_devices = _aio.run(list_devices())
        except Exception:
            return []

        devices = []
        for mux_dev in mux_devices:
            udid = mux_dev.serial
            dev = iOSDevice(udid=udid)
            try:
                lockdown = _aio.run(self._create_lockdown_async(udid))
                all_vals = lockdown.all_values
                dev.name = all_vals.get('DeviceName', '')
                dev.product_type = all_vals.get('ProductType', '')
                dev.ios_version = all_vals.get('ProductVersion', '')
                dev.connection_type = 'USB'
            except Exception:
                pass
            devices.append(dev)
        return devices

    @staticmethod
    async def _create_lockdown_async(udid: str):
        from pymobiledevice3.lockdown import create_using_usbmux
        return await create_using_usbmux(serial=udid)

    def _create_lockdown_sync(self, udid: str):
        import asyncio as _aio
        return _aio.run(self._create_lockdown_async(udid))

    # ── Device Info ──

    async def get_device_info(self, udid: str) -> Dict[str, Any]:
        return await asyncio.to_thread(self._get_device_info_sync, udid)

    def _get_device_info_sync(self, udid: str) -> Dict[str, Any]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            vals = lockdown.all_values
            return {
                'DeviceName': vals.get('DeviceName', ''),
                'ProductType': vals.get('ProductType', ''),
                'ProductVersion': vals.get('ProductVersion', ''),
                'BuildVersion': vals.get('BuildVersion', ''),
                'UniqueDeviceID': vals.get('UniqueDeviceID', udid),
                'SerialNumber': vals.get('SerialNumber', ''),
                'WiFiAddress': vals.get('WiFiAddress', ''),
                'BluetoothAddress': vals.get('BluetoothAddress', ''),
                'PhoneNumber': vals.get('PhoneNumber', ''),
                'ModelNumber': vals.get('ModelNumber', ''),
                'RegionInfo': vals.get('RegionInfo', ''),
                'TimeZone': vals.get('TimeZone', ''),
                'TotalDiskCapacity': vals.get('TotalDiskCapacity', 0),
                'TotalDataAvailable': vals.get('TotalDataAvailable', 0),
                'BatteryCurrentCapacity': vals.get('BatteryCurrentCapacity', -1),
                'BatteryIsCharging': vals.get('BatteryIsCharging', False),
                'CPUArchitecture': vals.get('CPUArchitecture', ''),
                'HardwareModel': vals.get('HardwareModel', ''),
                'ProductName': vals.get('ProductName', ''),
                'DeviceClass': vals.get('DeviceClass', ''),
                'DeviceColor': vals.get('DeviceColor', ''),
            }
        except Exception as e:
            return {'error': str(e)}

    # ── App Management ──

    async def list_apps(self, udid: str, app_type: str = "User") -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._list_apps_sync, udid, app_type)

    def _list_apps_sync(self, udid: str, app_type: str) -> List[Dict[str, Any]]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.installation_proxy import InstallationProxyService
            with InstallationProxyService(lockdown=lockdown) as proxy:
                apps = proxy.get_apps(app_type)

            result = []
            for bundle_id, info in apps.items():
                result.append({
                    'bundle_id': bundle_id,
                    'name': info.get('CFBundleDisplayName', info.get('CFBundleName', bundle_id)),
                    'version': info.get('CFBundleShortVersionString', info.get('CFBundleVersion', '')),
                    'bundle_version': info.get('CFBundleVersion', ''),
                    'size': info.get('StaticDiskUsage', 0) + info.get('DynamicDiskUsage', 0),
                    'app_type': info.get('ApplicationType', 'User'),
                    'path': info.get('Path', ''),
                    'signer_identity': info.get('SignerIdentity', ''),
                    'is_system': info.get('ApplicationType', '') == 'System',
                })
            result.sort(key=lambda x: x['name'].lower())
            return result
        except Exception as e:
            return [{'error': str(e)}]

    async def uninstall_app(self, udid: str, bundle_id: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._uninstall_app_sync, udid, bundle_id)

    def _uninstall_app_sync(self, udid: str, bundle_id: str) -> tuple[bool, str]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.installation_proxy import InstallationProxyService
            with InstallationProxyService(lockdown=lockdown) as proxy:
                proxy.uninstall(bundle_id)
            return True, f"已卸载 {bundle_id}"
        except Exception as e:
            return False, str(e)

    async def install_ipa(self, udid: str, ipa_path: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._install_ipa_sync, udid, ipa_path)

    def _install_ipa_sync(self, udid: str, ipa_path: str) -> tuple[bool, str]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.installation_proxy import InstallationProxyService
            with InstallationProxyService(lockdown=lockdown) as proxy:
                proxy.install_from_local(ipa_path)
            return True, "安装成功"
        except Exception as e:
            return False, str(e)

    # ── File Transfer (AFC - Media) ──

    async def afc_ls(self, udid: str, path: str = "/") -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._afc_ls_sync, udid, path)

    def _afc_ls_sync(self, udid: str, path: str) -> List[Dict[str, Any]]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.afc import AfcService
            with AfcService(lockdown=lockdown) as afc:
                entries = afc.listdir(path)
                result = []
                for name in entries:
                    if name in ('.', '..'):
                        continue
                    full_path = f"{path.rstrip('/')}/{name}"
                    try:
                        stat = afc.stat(full_path)
                        result.append({
                            'name': name,
                            'path': full_path,
                            'is_dir': stat.get('st_ifmt') == 'S_IFDIR',
                            'size': int(stat.get('st_size', 0)),
                        })
                    except Exception:
                        result.append({
                            'name': name,
                            'path': full_path,
                            'is_dir': False,
                            'size': 0,
                        })
                return result
        except Exception as e:
            return [{'error': str(e)}]

    async def afc_push(self, udid: str, local_path: str, remote_path: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._afc_push_sync, udid, local_path, remote_path)

    def _afc_push_sync(self, udid: str, local_path: str, remote_path: str) -> tuple[bool, str]:
        import os
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.afc import AfcService
            with AfcService(lockdown=lockdown) as afc:
                if os.path.isfile(local_path):
                    afc.push(local_path, remote_path)
                    return True, f"已推送: {os.path.basename(local_path)}"
                elif os.path.isdir(local_path):
                    count = 0
                    for root, dirs, files in os.walk(local_path):
                        rel = os.path.relpath(root, local_path)
                        target_dir = f"{remote_path.rstrip('/')}/{rel}" if rel != '.' else remote_path
                        try:
                            afc.makedirs(target_dir)
                        except Exception:
                            pass
                        for fname in files:
                            src = os.path.join(root, fname)
                            dst = f"{target_dir.rstrip('/')}/{fname}"
                            afc.push(src, dst)
                            count += 1
                    return True, f"已推送 {count} 个文件"
                else:
                    return False, f"路径不存在: {local_path}"
        except Exception as e:
            return False, str(e)

    async def afc_pull(self, udid: str, remote_path: str, local_path: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._afc_pull_sync, udid, remote_path, local_path)

    def _afc_pull_sync(self, udid: str, remote_path: str, local_path: str) -> tuple[bool, str]:
        import os
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.afc import AfcService
            with AfcService(lockdown=lockdown) as afc:
                os.makedirs(os.path.dirname(local_path) or '.', exist_ok=True)
                afc.pull(remote_path, local_path)
                return True, f"已拉取到: {local_path}"
        except Exception as e:
            return False, str(e)

    # ── File Transfer (App Sandbox via HouseArrest) ──

    async def app_afc_ls(self, udid: str, bundle_id: str, path: str = "/") -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._app_afc_ls_sync, udid, bundle_id, path)

    def _app_afc_ls_sync(self, udid: str, bundle_id: str, path: str) -> List[Dict[str, Any]]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.house_arrest import HouseArrestService
            with HouseArrestService(lockdown=lockdown, bundle_id=bundle_id) as afc:
                entries = afc.listdir(path)
                result = []
                for name in entries:
                    if name in ('.', '..'):
                        continue
                    full_path = f"{path.rstrip('/')}/{name}"
                    try:
                        stat = afc.stat(full_path)
                        result.append({
                            'name': name,
                            'path': full_path,
                            'is_dir': stat.get('st_ifmt') == 'S_IFDIR',
                            'size': int(stat.get('st_size', 0)),
                        })
                    except Exception:
                        result.append({
                            'name': name,
                            'path': full_path,
                            'is_dir': False,
                            'size': 0,
                        })
                return result
        except Exception as e:
            return [{'error': str(e)}]

    async def app_afc_push(self, udid: str, bundle_id: str, local_path: str, remote_path: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._app_afc_push_sync, udid, bundle_id, local_path, remote_path)

    def _app_afc_push_sync(self, udid: str, bundle_id: str, local_path: str, remote_path: str) -> tuple[bool, str]:
        import os
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.house_arrest import HouseArrestService
            with HouseArrestService(lockdown=lockdown, bundle_id=bundle_id) as afc:
                if os.path.isfile(local_path):
                    afc.push(local_path, remote_path)
                    return True, f"已推送到 {bundle_id}: {os.path.basename(local_path)}"
                elif os.path.isdir(local_path):
                    count = 0
                    for root, dirs, files in os.walk(local_path):
                        rel = os.path.relpath(root, local_path)
                        target_dir = f"{remote_path.rstrip('/')}/{rel}" if rel != '.' else remote_path
                        try:
                            afc.makedirs(target_dir)
                        except Exception:
                            pass
                        for fname in files:
                            src = os.path.join(root, fname)
                            dst = f"{target_dir.rstrip('/')}/{fname}"
                            afc.push(src, dst)
                            count += 1
                    return True, f"已推送 {count} 个文件到 {bundle_id}"
                else:
                    return False, f"路径不存在: {local_path}"
        except Exception as e:
            return False, str(e)

    async def app_afc_pull(self, udid: str, bundle_id: str, remote_path: str, local_path: str) -> tuple[bool, str]:
        return await asyncio.to_thread(self._app_afc_pull_sync, udid, bundle_id, remote_path, local_path)

    def _app_afc_pull_sync(self, udid: str, bundle_id: str, remote_path: str, local_path: str) -> tuple[bool, str]:
        import os
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.house_arrest import HouseArrestService
            with HouseArrestService(lockdown=lockdown, bundle_id=bundle_id) as afc:
                os.makedirs(os.path.dirname(local_path) or '.', exist_ok=True)
                afc.pull(remote_path, local_path)
                return True, f"已从 {bundle_id} 拉取到: {local_path}"
        except Exception as e:
            return False, str(e)

    # ── Syslog ──

    async def start_syslog(self, udid: str, on_line: Callable[[str], None]):
        if udid in self._syslog_tasks:
            return

        stop_event = asyncio.Event()
        self._syslog_stop_events[udid] = stop_event

        task = asyncio.create_task(self._syslog_loop(udid, on_line, stop_event))
        self._syslog_tasks[udid] = task

    async def _syslog_loop(self, udid: str, on_line: Callable, stop_event: asyncio.Event):
        try:
            lockdown = await self._create_lockdown_async(udid)
            from pymobiledevice3.services.syslog import SyslogService
            syslog_service = SyslogService(lockdown=lockdown)

            def _watch():
                for entry in syslog_service.watch():
                    if stop_event.is_set():
                        break
                    if entry:
                        on_line(str(entry))

            await asyncio.to_thread(_watch)
        except Exception as e:
            on_line(f"[Syslog Error] {e}")
        finally:
            self._syslog_tasks.pop(udid, None)
            self._syslog_stop_events.pop(udid, None)

    def stop_syslog(self, udid: str):
        event = self._syslog_stop_events.get(udid)
        if event:
            event.set()
        task = self._syslog_tasks.get(udid)
        if task:
            task.cancel()

    # ── Screenshot ──

    async def take_screenshot(self, udid: str) -> Optional[bytes]:
        return await asyncio.to_thread(self._take_screenshot_sync, udid)

    def _take_screenshot_sync(self, udid: str) -> Optional[bytes]:
        try:
            lockdown = self._create_lockdown_sync(udid)
            from pymobiledevice3.services.screenshot import ScreenshotService
            with ScreenshotService(lockdown=lockdown) as screenshot:
                return screenshot.take_screenshot()
        except Exception:
            try:
                lockdown = self._create_lockdown_sync(udid)
                from pymobiledevice3.services.dvt.dvt_secure_socket_proxy import DvtSecureSocketProxyService
                from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot
                with DvtSecureSocketProxyService(lockdown=lockdown) as dvt:
                    return Screenshot(dvt).get_screenshot()
            except Exception:
                return None
