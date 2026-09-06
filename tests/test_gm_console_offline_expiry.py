"""Exercise offline expiry against real cache state and connection replacement."""
import asyncio

import pytest

from tools.gm_console import main
from tools.gm_console.server_mgr import Client, ServerMgr


class Writer:
    def close(self):
        pass

    def write(self, data):
        pass

    async def drain(self):
        pass


@pytest.fixture
def caches(monkeypatch):
    stores = ["av_audio_history_cache", "av_monitor_snapshot_cache", "game_log_cache",
              "pending_screenshot_sessions", "game_log_stop_tasks", "game_log_ws_connections"]
    for name in stores:
        monkeypatch.setattr(main, name, {})
    mgr = ServerMgr()
    mgr.on_client_expired = main._clear_expired_client_cache
    monkeypatch.setattr(main, "server_mgr", mgr)
    return mgr


def seed(mgr, cid):
    for cache in (main.av_audio_history_cache, main.av_monitor_snapshot_cache,
                  main.game_log_cache, main.pending_screenshot_sessions,
                  mgr._animator_list_cache, mgr._screenshot_parts):
        cache[cid] = {"retained": True}


def assert_cached(mgr, cid, expected):
    for cache in (main.av_audio_history_cache, main.av_monitor_snapshot_cache,
                  main.game_log_cache, main.pending_screenshot_sessions,
                  mgr._animator_list_cache, mgr._screenshot_parts):
        assert (cid in cache) is expected


def test_expiry_clears_all_client_caches_and_stop_task(caches, monkeypatch):
    async def run():
        mgr = caches
        entered, release = asyncio.Event(), asyncio.Event()

        async def sleep(delay):
            assert delay == 180.0
            entered.set()
            await release.wait()

        monkeypatch.setattr(asyncio, "sleep", sleep)
        client = Client("client", 12581, Writer())
        seed(mgr, client.id)
        seed(mgr, "other")
        mgr._add_log("info", "expired log", client.id)
        mgr._add_log("info", "keep log", "other")
        pending = {"client_id": client.id, "event": asyncio.Event()}
        mgr._pending_execs[1] = pending
        stop = asyncio.create_task(asyncio.Event().wait())
        main.game_log_stop_tasks[client.id] = stop
        updates = []
        mgr.on_update = lambda: updates.append(mgr.get_clients_info())
        mgr._remember_offline_client(client)
        expiry = mgr._offline_expiry_tasks[client.id]
        await entered.wait()
        assert_cached(mgr, client.id, True)
        release.set()
        await expiry
        await asyncio.gather(stop, return_exceptions=True)
        assert_cached(mgr, client.id, False)
        assert_cached(mgr, "other", True)
        assert stop.cancelled()
        assert not main.game_log_stop_tasks
        assert not mgr.offline_clients
        assert not mgr._offline_expiry_tasks
        assert not mgr._pending_execs
        assert pending["event"].is_set()
        assert pending["error"] == "client expired"
        assert [log.client_id for log in mgr.logs] == ["other"]
        assert updates == [[]]
        assert mgr.client_state_rev == 1

    asyncio.run(run())


def test_reconnect_keeps_caches_and_cancels_expiry(caches, monkeypatch):
    async def run():
        mgr = caches
        entered = asyncio.Event()

        async def sleep(delay):
            entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(asyncio, "sleep", sleep)
        old = Client("client", 12581, Writer())
        seed(mgr, old.id)
        mgr._remember_offline_client(old)
        expiry = mgr._offline_expiry_tasks[old.id]
        await entered.wait()
        new = Client("temp:new", 12581, Writer())
        mgr.clients[new.id] = new
        mgr._rekey_client(new, old.id)
        await expiry
        assert mgr.clients[old.id] is new
        assert not mgr.offline_clients
        assert not mgr._offline_expiry_tasks
        assert_cached(mgr, old.id, True)

    asyncio.run(run())


def test_stale_expiry_cannot_clear_later_disconnect_at_same_timestamp(caches, monkeypatch):
    async def run():
        mgr = caches
        entered = asyncio.Event()
        release = asyncio.Event()

        async def sleep(delay):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                # Force an old task to continue despite cancellation.
                pass

        monkeypatch.setattr(asyncio, "sleep", sleep)
        monkeypatch.setattr("tools.gm_console.server_mgr.time.time", lambda: 1000.0)
        client = Client("client", 12581, Writer())
        seed(mgr, client.id)
        mgr._remember_offline_client(client)
        old_task = mgr._offline_expiry_tasks[client.id]
        await entered.wait()
        mgr._restore_online_client(client.id)
        mgr._remember_offline_client(client)
        new_task = mgr._offline_expiry_tasks[client.id]
        await old_task
        assert mgr._offline_expiry_tasks[client.id] is new_task
        assert client.id in mgr.offline_clients
        assert_cached(mgr, client.id, True)
        release.set()
        await new_task
        assert_cached(mgr, client.id, False)

    asyncio.run(run())


def test_delayed_game_log_stop_does_not_stop_replacement_connection(caches, monkeypatch):
    async def run():
        mgr = caches
        entered, release = asyncio.Event(), asyncio.Event()
        stops = []

        async def sleep(delay):
            entered.set()
            await release.wait()

        async def request(*args):
            stops.append(args)

        monkeypatch.setattr(asyncio, "sleep", sleep)
        monkeypatch.setattr(mgr, "send_game_log_request", request)
        mgr.clients["client"] = Client("client", 12581, Writer())
        main._schedule_game_log_stop("client")
        stop = main.game_log_stop_tasks["client"]
        await entered.wait()
        mgr.clients["client"] = Client("client", 12581, Writer())
        release.set()
        await stop
        assert stops == []
        assert not main.game_log_stop_tasks
        main._schedule_game_log_stop("client")
        await main.game_log_stop_tasks["client"]
        assert stops == [("client", "stop", {})]

    asyncio.run(run())


@pytest.mark.parametrize("method,args", [
    ("send_to_client", ("client", "print(1)")),
    ("exec_wait", ("client", "print(1)")),
    ("send_gm_to_client", ("client", "gm")),
    ("broadcast", ("print(1)",)),
    ("broadcast_gm", ("gm",)),
])
@pytest.mark.parametrize("reconnect", [False, True])
def test_send_failure_retains_only_original_disconnected_client(caches, method, args, reconnect):
    async def run():
        mgr = caches
        replacement = Client("client", 12581, Writer())

        class FailingWriter(Writer):
            async def drain(self):
                if reconnect:
                    mgr.clients["client"] = replacement
                raise ConnectionResetError("closed")

        mgr.clients["client"] = Client("client", 12581, FailingWriter())
        await getattr(mgr, method)(*args)
        if reconnect:
            assert mgr.clients["client"] is replacement
            assert not mgr.offline_clients
        else:
            assert not mgr.clients
            assert "client" in mgr.offline_clients
        for task in list(mgr._offline_expiry_tasks.values()):
            task.cancel()
        await asyncio.gather(*mgr._offline_expiry_tasks.values(), return_exceptions=True)

    asyncio.run(run())
