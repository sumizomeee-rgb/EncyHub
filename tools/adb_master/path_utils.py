"""
Path utilities for ADB Master.
Handles path resolution for both EncyHub and standalone/PyInstaller environments.
"""

import os
import sys
from datetime import datetime


def get_base_path() -> str:
    """
    Get the base path for the application.
    - PyInstaller: sys.executable directory
    - EncyHub mode: DATA_DIR environment variable
    - Standalone: parent of tools/adb_master/
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        # Running as PyInstaller bundle
        return os.path.dirname(sys.executable)

    # Check for EncyHub mode
    data_dir = os.environ.get("DATA_DIR")
    if data_dir:
        return data_dir

    # Standalone mode - return tools/adb_master directory
    return os.path.dirname(os.path.abspath(__file__))


def get_adb_path() -> str:
    """
    Get the path to adb.exe.
    - PyInstaller: bundled in _MEIPASS
    - EncyHub mode: EncyHub/assets/adb.exe
    - Standalone: assets/adb.exe relative to base
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'adb.exe')

    # Check for EncyHub mode
    if os.environ.get("ENCYHUB_MODE"):
        # EncyHub root is 3 levels up from tools/adb_master/
        encyhub_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(encyhub_root, 'assets', 'adb.exe')

    # Standalone mode
    return os.path.join(get_base_path(), 'assets', 'adb.exe')


def get_devices_dir() -> str:
    """Get the Devices directory path."""
    return os.path.join(get_base_path(), 'Devices')


def ensure_device_dirs(serial: str) -> dict:
    """
    Create device-specific directories.
    
    Args:
        serial: Device serial number or connection identifier
        
    Returns:
        Dictionary containing paths:
        - device_dir: Base device directory
        - sync_area: Local_Sync_Area for file transfers
        - logs_dir: Directory for logcat logs
    """
    # Sanitize serial for filesystem (replace : with _)
    safe_serial = serial.replace(':', '_').replace('.', '_')
    
    device_dir = os.path.join(get_devices_dir(), safe_serial)
    sync_area = os.path.join(device_dir, 'Local_Sync_Area')
    logs_dir = os.path.join(device_dir, 'logs')
    
    # Create directories
    os.makedirs(sync_area, exist_ok=True)
    os.makedirs(logs_dir, exist_ok=True)
    
    return {
        'device_dir': device_dir,
        'sync_area': sync_area,
        'logs_dir': logs_dir
    }


def get_logcat_filename(serial: str) -> str:
    """
    Generate a timestamped logcat filename.
    
    Args:
        serial: Device serial number
        
    Returns:
        Full path to the logcat file
    """
    dirs = ensure_device_dirs(serial)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    return os.path.join(dirs['logs_dir'], f'logcat_{timestamp}.log')


def get_scrcpy_dir() -> str:
    """
    获取内置 scrcpy 目录路径。
    - PyInstaller: bundled in _MEIPASS/scrcpy
    - EncyHub mode: EncyHub/assets/scrcpy/
    - Standalone: assets/scrcpy/ relative to base
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'scrcpy')

    if os.environ.get("ENCYHUB_MODE"):
        encyhub_root = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        return os.path.join(encyhub_root, 'assets', 'scrcpy')

    # Standalone mode
    return os.path.join(get_base_path(), 'assets', 'scrcpy')


def get_scrcpy_server_path() -> str:
    """获取 scrcpy-server 的完整路径。"""
    return os.path.join(get_scrcpy_dir(), 'scrcpy-server')
