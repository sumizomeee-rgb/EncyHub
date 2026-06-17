"""GM Console 游戏端日志缓存回归测试。"""
import os
import sys


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)


def setup_function():
    from tools.gm_console import main

    main.game_log_cache.clear()


def teardown_function():
    from tools.gm_console import main

    main.game_log_cache.clear()


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


def test_runtime_lua_sends_game_log_entries_in_chunks():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    assert "LuaGameLogTail._sendChunkBytes = 512 * 1024" in content
    assert "LuaGameLogTail._sendChunkEntries = 100" in content
    assert "sendChunkBytes" in content
    assert "sendChunkEntries" in content
    assert "RuntimeGMClient.LuaGameLogTail = LuaGameLogTail" in content


def test_runtime_lua_resends_gm_list_after_tcp_reconnect():
    runtime_lua = os.path.join(BASE_DIR, "tools", "gm_console", "runtime_gm_client.lua")
    with open(runtime_lua, "r", encoding="utf-8") as f:
        content = f.read()

    assert "RuntimeGMClient.GMLoaded and RuntimeGMClient.SendGMList" in content
    assert "RuntimeGMClient.SendGMList() end" in content
