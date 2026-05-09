"""
Path utilities for iOS Master.
"""

import os
import sys


def get_base_path() -> str:
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.dirname(sys.executable)

    data_dir = os.environ.get("DATA_DIR")
    if data_dir:
        return data_dir

    return os.path.dirname(os.path.abspath(__file__))


def get_devices_dir() -> str:
    return os.path.join(get_base_path(), 'Devices')


def ensure_device_dirs(udid: str) -> dict:
    safe_udid = udid.replace(':', '_').replace('.', '_').replace('-', '_')

    device_dir = os.path.join(get_devices_dir(), safe_udid)
    sync_area = os.path.join(device_dir, 'Local_Sync_Area')
    logs_dir = os.path.join(device_dir, 'logs')

    os.makedirs(sync_area, exist_ok=True)
    os.makedirs(logs_dir, exist_ok=True)

    return {
        'device_dir': device_dir,
        'sync_area': sync_area,
        'logs_dir': logs_dir,
    }
