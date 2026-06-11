import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import websockets

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hub_core import api


class FakeWebSocket:
    def __init__(self):
        self.scope = {"query_string": b""}
        self.accepted = False
        self.closed = False
        self.sent_text = []

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=None):
        self.closed = True

    async def send_text(self, message):
        self.sent_text.append(message)

    async def receive(self):
        await asyncio.Future()


class WebSocketProxyLargeMessageTests(unittest.TestCase):
    def test_proxy_connects_with_large_message_limit(self):
        captured = {}

        async def fake_connect(url, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            raise RuntimeError("stop after connect kwargs are captured")

        fake_tool = SimpleNamespace(port=1374)
        fake_websocket = FakeWebSocket()

        with patch.object(api.registry, "get", return_value=fake_tool), \
             patch.object(api.process_manager, "check_health", return_value=True), \
             patch.object(api.websockets, "connect", side_effect=fake_connect), \
             patch("builtins.print"):
            asyncio.run(api.proxy_websocket(fake_websocket, "gm_console", "ws/events"))

        self.assertEqual(captured["url"], "ws://127.0.0.1:1374/ws/events")
        self.assertIn("max_size", captured["kwargs"])
        self.assertGreaterEqual(captured["kwargs"]["max_size"], 8 * 1024 * 1024)

    def test_proxy_forwards_messages_larger_than_websockets_default(self):
        async def run_case():
            payload = "x" * (2 * 1024 * 1024)

            async def handler(websocket):
                await websocket.send(payload)
                await websocket.wait_closed()

            server = await websockets.serve(handler, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            fake_tool = SimpleNamespace(port=port)
            fake_websocket = FakeWebSocket()

            async def send_text_and_stop(message):
                fake_websocket.sent_text.append(message)
                raise api.WebSocketDisconnect()

            fake_websocket.send_text = send_text_and_stop

            try:
                with patch.object(api.registry, "get", return_value=fake_tool), \
                     patch.object(api.process_manager, "check_health", return_value=True), \
                     patch("builtins.print"):
                    await api.proxy_websocket(fake_websocket, "gm_console", "ws/events")
            finally:
                server.close()
                await server.wait_closed()

            return fake_websocket.sent_text

        sent_text = asyncio.run(run_case())
        self.assertEqual(len(sent_text), 1)
        self.assertEqual(len(sent_text[0]), 2 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
