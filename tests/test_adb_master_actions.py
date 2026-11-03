import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from tools.adb_master import main


def test_logcat_folder_uses_active_serial_without_recording(monkeypatch, tmp_path):
    device = SimpleNamespace(hardware_id='device-id', active_serial='10.0.0.1:5555')
    manager = SimpleNamespace(get_unified_devices=AsyncMock(return_value=[device]))
    opened = AsyncMock(return_value={'message': 'opened'})
    monkeypatch.setattr(main, 'adb_mgr', manager)
    monkeypatch.setattr(main, 'ensure_device_dirs', lambda serial: {'logs_dir': str(tmp_path / serial.replace(':', '_'))})
    monkeypatch.setattr(main, 'open_folder', opened)
    assert asyncio.run(main.open_logcat_folder('device-id')) == {'message': 'opened'}
    assert opened.await_args.args[0].path == str(tmp_path / '10.0.0.1_5555')


def test_screenshot_offline_reports_authorization(monkeypatch):
    monkeypatch.setattr(main, 'adb_mgr', SimpleNamespace(get_unified_devices=AsyncMock(return_value=[])))
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.take_device_screenshot('offline'))
    assert error.value.status_code == 400
    assert '离线或未授权' in error.value.detail


def test_logcat_folder_prefers_recording_serial(monkeypatch, tmp_path):
    device = SimpleNamespace(hardware_id='device-id', active_serial='new-serial')
    monkeypatch.setattr(main, 'adb_mgr', SimpleNamespace(get_unified_devices=AsyncMock(return_value=[device])))
    monkeypatch.setattr(main, 'logcat_serials', {'device-id': 'recording-serial'})
    monkeypatch.setattr(main, 'ensure_device_dirs', lambda serial: {'logs_dir': str(tmp_path / serial)})
    opened = AsyncMock(return_value={'message': 'opened'})
    monkeypatch.setattr(main, 'open_folder', opened)
    asyncio.run(main.open_logcat_folder('device-id'))
    assert opened.await_args.args[0].path == str(tmp_path / 'recording-serial')


@pytest.mark.parametrize('returncode,image,error,expected', [
    (0, b'\x89PNG\r\n\x1a\ncontent', b'', None),
    (0, b'not png', b'', '有效 PNG'),
    (1, b'', b'error: device unauthorized', '未授权'),
    (1, b'', b'error: device offline', '离线'),
])
def test_screenshot_returns_fresh_binary_or_error(monkeypatch, returncode, image, error, expected):
    device = SimpleNamespace(hardware_id='device-id', active_serial='serial')
    manager = SimpleNamespace(get_unified_devices=AsyncMock(return_value=[device]), adb_path='adb', _SUBPROCESS_KWARGS={})
    process = SimpleNamespace(returncode=returncode, communicate=AsyncMock(return_value=(image, error)))
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(main, 'adb_mgr', manager)
    monkeypatch.setattr(main.asyncio, 'create_subprocess_exec', spawn)
    if expected:
        with pytest.raises(HTTPException) as exception:
            asyncio.run(main.take_device_screenshot('device-id'))
        assert expected in exception.value.detail
    else:
        response = asyncio.run(main.take_device_screenshot('device-id'))
        assert response.body == image
        assert response.media_type == 'image/png'
        assert response.headers['cache-control'] == 'no-store'
    assert spawn.await_args.args == ('adb', '-s', 'serial', 'exec-out', 'screencap', '-p')
