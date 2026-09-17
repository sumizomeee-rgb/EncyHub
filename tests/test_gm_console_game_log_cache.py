"""GM Console 游戏端日志缓存回归测试。"""
import os
import sys
import asyncio


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)


def setup_function():
    from tools.gm_console import main

    main.game_log_cache.clear()


def teardown_function():
    from tools.gm_console import main

    main.game_log_cache.clear()
    main.pending_game_log_probes.clear()


def test_game_log_cache_keeps_same_text_with_different_seq():
    from tools.gm_console import main

    cid = "127.0.0.1-100"
    entries = main._cache_game_log_entries(cid, [
        {"seq": 1, "fileOffset": 100, "text": "print 1"},
        {"seq": 2, "fileOffset": 200, "text": "print 1"},
    ])

    assert [entry["seq"] for entry in entries] == [1, 2]
    assert [entry["text"] for entry in main.game_log_cache[cid]["entries"]] == ["print 1", "print 1"]


def test_game_log_cache_accepts_seq_reset_after_runtime_reload():
    from tools.gm_console import main

    cid = "127.0.0.1-100"
    assert main._cache_game_log_entries(cid, [
        {"seq": 120, "fileOffset": 1000, "text": "before reload"},
    ])

    entries = main._cache_game_log_entries(cid, [
        {"seq": 1, "fileOffset": 2000, "text": "after reload"},
    ])

    assert len(entries) == 1
    assert entries[0]["text"] == "after reload"
    assert [entry["text"] for entry in main.game_log_cache[cid]["entries"]] == [
        "before reload",
        "after reload",
    ]


def test_game_log_cache_skips_exact_duplicate_entry():
    from tools.gm_console import main

    cid = "127.0.0.1-100"
    raw = {"seq": 7, "fileOffset": 700, "time": "2026/06/17 16:00:00.0000", "text": "same packet"}

    assert len(main._cache_game_log_entries(cid, [raw])) == 1
    assert main._cache_game_log_entries(cid, [raw]) == []


def test_game_log_cache_skips_same_file_entry_after_rebootstrap_with_new_seq():
    from tools.gm_console import main

    cid = "127.0.0.1-100"
    first = {"seq": 7, "fileOffset": 700, "time": "2026/06/17 16:00:00.0000", "text": "same file line"}
    replay = {"seq": 8, "fileOffset": 700, "time": "2026/06/17 16:00:00.0000", "text": "same file line"}

    assert len(main._cache_game_log_entries(cid, [first])) == 1
    assert main._cache_game_log_entries(cid, [replay]) == []


def test_runtime_lua_sends_game_log_entries_in_chunks():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    assert "LuaGameLogTail._sendChunkBytes = 512 * 1024" in content
    assert "LuaGameLogTail._sendChunkEntries = 100" in content
    assert "sendChunkBytes" in content
    assert "sendChunkEntries" in content
    assert "RuntimeGMClient.LuaGameLogTail = LuaGameLogTail" in content


def test_game_log_starts_without_history_bootstrap():
    from tools.gm_console import main

    assert main.GAME_LOG_BOOTSTRAP_BYTES == 0


def test_game_log_probe_routes_correlated_meta_to_waiter():
    from tools.gm_console import main

    async def run_case():
        future = asyncio.get_running_loop().create_future()
        main.pending_game_log_probes["127.0.0.1-100"] = [future]
        handled = main._complete_game_log_probe("127.0.0.1-100", {
            "type": "GAME_LOG_META",
            "found": True,
            "path": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log/latest.log",
            "dir": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log",
            "detection": "application_data_sibling",
        })
        assert handled is True
        result = await future
        assert result["found"] is True
        assert result["detection"] == "application_data_sibling"
        assert "requestId" not in result

    asyncio.run(run_case())


def test_runtime_lua_supports_one_shot_game_log_probe():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    assert 'elseif action == "probe" then' in content
    assert "LuaGameLogTail.Probe(packet)" in content
    assert '"application_data_sibling"' in content
    assert 'requestId = requestId or ""' in content
    assert "if ticks > latestTicks then" in content


def test_runtime_lua_reports_not_found_meta_before_error_status():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    branch_start = content.index("        if not dir then")
    branch_end = content.index("        end", branch_start)
    branch = content[branch_start:branch_end]
    assert branch.index("_glt_sendMeta()") < branch.index("_glt_sendStatus(")


def test_game_log_meta_endpoint_uses_existing_start_command_for_compatibility():
    from tools.gm_console import main

    class FakeManager:
        def __init__(self):
            self.clients = {"127.0.0.1-100": object()}
            self.actions = []

        async def send_game_log_request(self, client_id, action, params):
            self.actions.append(action)
            if action == "start":
                asyncio.get_running_loop().call_soon(
                    main._complete_game_log_probe,
                    client_id,
                    {
                        "type": "GAME_LOG_META",
                        "path": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log/latest.log",
                        "dir": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log",
                        "platform": "WindowsPlayer",
                    },
                )
            return True, "sent"

    async def run_case():
        old_manager = main.server_mgr
        fake = FakeManager()
        main.server_mgr = fake
        try:
            result = await main.get_client_game_log_meta("127.0.0.1-100", timeout=1)
            assert result["found"] is True
            assert result["detection"] == "runtime_resolved"
            assert fake.actions == ["start", "stop"]
        finally:
            main.server_mgr = old_manager

    asyncio.run(run_case())


def test_game_log_meta_endpoint_reuses_active_stream_meta_without_restart():
    from tools.gm_console import main

    class FakeManager:
        def __init__(self):
            self.clients = {"127.0.0.1-100": object()}
            self.actions = []

        async def send_game_log_request(self, client_id, action, params):
            self.actions.append(action)
            return True, "sent"

    async def run_case():
        old_manager = main.server_mgr
        fake = FakeManager()
        main.server_mgr = fake
        main.game_log_ws_connections["127.0.0.1-100"] = [object()]
        main._get_game_log_state("127.0.0.1-100")["meta"] = {
            "path": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log/latest.log",
            "dir": "F:/HaruTrunk/Product/Bin/Client/Win/Debug/Log",
            "platform": "WindowsPlayer",
            "detection": "application_data_sibling",
        }
        try:
            result = await main.get_client_game_log_meta("127.0.0.1-100", timeout=1)
            assert result["found"] is True
            assert result["detection"] == "application_data_sibling"
            assert fake.actions == []
        finally:
            main.game_log_ws_connections.clear()
            main.server_mgr = old_manager

    asyncio.run(run_case())


def test_runtime_lua_resends_gm_list_after_tcp_reconnect():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    assert "RuntimeGMClient.GMLoaded and RuntimeGMClient.SendGMList" in content
    assert "RuntimeGMClient.SendGMList() end" in content
