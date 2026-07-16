"""GM Console 客户端 SVN 元数据协议回归测试。"""

from tools.gm_console.server_mgr import Client, ServerMgr


class DummyWriter:
    def close(self):
        pass


def test_client_serializes_structured_svn_info():
    client = Client(
        id="127.0.0.1-123",
        port=12581,
        writer=DummyWriter(),
        svn_author="huangyongxi",
        svn_url="https://svn.example.com/svn/haru/trunk/Dev/Client/Assets",
        svn_branch="trunk",
        svn_revision="1541437",
        svn_detection="cli_realm",
    )

    assert client.to_dict() == {
        "id": "127.0.0.1-123",
        "port": 12581,
        "ip": "",
        "device": "Unknown",
        "platform": "Unknown",
        "pid": 0,
        "packageName": "",
        "persistentDataPath": "",
        "appVersion": "",
        "gm_tree": [],
        "svnAuthor": "huangyongxi",
        "svnUrl": "https://svn.example.com/svn/haru/trunk/Dev/Client/Assets",
        "svnBranch": "trunk",
        "svnRevision": "1541437",
        "svnDetection": "cli_realm",
    }


def test_hello_packet_accepts_app_version():
    mgr = ServerMgr()
    client = Client(id="temp:127.0.0.1:50002:3", port=12581, writer=DummyWriter(), ip="127.0.0.1")
    mgr.clients[client.id] = client

    mgr._process_packet(client, {
        "type": "HELLO",
        "pid": 125,
        "device": "Editor",
        "platform": "WindowsEditor",
        "appVersion": "1.2.3",
    })

    assert client.app_version == "1.2.3"


def test_hello_packet_accepts_new_svn_fields_and_keeps_old_clients_compatible():
    mgr = ServerMgr()
    client = Client(id="temp:127.0.0.1:50000:1", port=12581, writer=DummyWriter(), ip="127.0.0.1")
    mgr.clients[client.id] = client

    mgr._process_packet(client, {
        "type": "HELLO",
        "pid": 123,
        "device": "Editor",
        "platform": "WindowsEditor",
        "svn_author": "huangyongxi",
        "svn_url": "https://svn.example.com/svn/haru/branches/feature-a/Dev/Client/Assets",
        "svn_branch": "feature-a",
        "svn_revision": 1541437,
        "svn_detection": "cli_realm",
    })

    assert client.id == "127.0.0.1-123"
    assert client.svn_author == "huangyongxi"
    assert client.svn_branch == "feature-a"
    assert client.svn_revision == "1541437"
    assert client.svn_detection == "cli_realm"

    legacy = Client(id="temp:127.0.0.1:50001:2", port=12581, writer=DummyWriter(), ip="127.0.0.1")
    mgr.clients[legacy.id] = legacy
    mgr._process_packet(legacy, {"type": "HELLO", "pid": 124, "svn_author": "legacy"})

    assert legacy.svn_author == "legacy"
    assert legacy.svn_url == ""
    assert legacy.svn_branch == ""
    assert legacy.svn_revision == ""
