"""
GM Console client disconnect state regression tests.
"""
import os
import asyncio
import sys


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
GM_MAIN_PY = os.path.join(BASE_DIR, "tools", "gm_console", "main.py")
SERVER_MGR_PY = os.path.join(BASE_DIR, "tools", "gm_console", "server_mgr.py")
GM_CONSOLE_JSX = os.path.join(BASE_DIR, "frontend", "src", "pages", "GmConsole.jsx")
RUNTIME_GM_LUA = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")


def read_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class TestClientListRevision:
    """Client list snapshots must not be able to resurrect stale cards."""

    def setup_method(self):
        self.server_mgr = read_file(SERVER_MGR_PY)
        self.main = read_file(GM_MAIN_PY)
        self.frontend = read_file(GM_CONSOLE_JSX)

    def test_server_tracks_client_state_revision(self):
        assert "client_state_rev" in self.server_mgr
        assert "def _mark_clients_changed" in self.server_mgr

    def test_server_read_timeout_matches_client_heartbeat_window(self):
        assert "CLIENT_READ_TIMEOUT = 45" in self.server_mgr

    def test_http_clients_response_includes_revision(self):
        assert '"clientStateRev": server_mgr.client_state_rev' in self.main

    def test_ws_update_response_includes_revision(self):
        assert '"clientStateRev": server_mgr.client_state_rev' in self.main

    def test_frontend_ignores_stale_client_snapshots(self):
        assert "clientStateRevRef" in self.frontend
        assert "applyClientSnapshot" in self.frontend
        assert "rev <= clientStateRevRef.current" in self.frontend

    def test_frontend_ignores_duplicate_client_snapshots(self):
        assert "rev <= clientStateRevRef.current" in self.frontend


class TestRuntimeGmEditorDisconnect:
    """RuntimeGM must hook XLuaBehaviour's real destroy callback."""

    def setup_method(self):
        self.runtime_lua = read_file(RUNTIME_GM_LUA)

    def test_uses_xlua_on_destroy_callback(self):
        assert "behaviour.LuaOnDestroy = function()" in self.runtime_lua
        assert "behaviour.LuaDestroy = function()" not in self.runtime_lua


class FakeReader:
    async def readline(self):
        return b""


class FakeWriter:
    def __init__(self):
        self.closed = False
        self.waited = False

    def get_extra_info(self, name):
        if name == "peername":
            return ("127.0.0.1", 12345)
        if name == "socket":
            return None
        return None

    def close(self):
        self.closed = True

    async def wait_closed(self):
        self.waited = True


def test_handle_client_closes_transport_after_disconnect():
    from tools.gm_console.server_mgr import ServerMgr

    async def run_case():
        mgr = ServerMgr()
        writer = FakeWriter()
        await mgr._handle_client(FakeReader(), writer, 12581)
        assert writer.closed
        assert writer.waited

    asyncio.run(run_case())
