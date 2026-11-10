import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("behavior_tree_presets", Path(__file__).parents[1] / "tools/gm_console/behavior_tree_presets.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BehaviorTreePresetsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = MODULE.BehaviorTreePresetManager(self.temp.name)
        self.preset = {"schema_version": 1, "name": "安全观察", "tree": {"nodes": [{"id": "n1", "type": "unknown.extension", "params": {"中文": True}}], "root": "n1"}}

    def test_crud_restart_and_unknown_node_roundtrip(self):
        saved = self.manager.save(self.preset)
        restarted = MODULE.BehaviorTreePresetManager(self.temp.name)
        self.assertEqual(restarted.export_preset(saved["id"]), saved)
        self.assertEqual(saved["tree"], self.preset["tree"])
        changed = restarted.save({**saved, "name": "已改名"}, saved["id"])
        self.assertEqual(changed["name"], "已改名")
        self.assertTrue(restarted.delete(saved["id"]))
        self.assertFalse(restarted.delete(saved["id"]))

    def test_import_conflict(self):
        saved = self.manager.save(self.preset)
        with self.assertRaises(MODULE.PresetError):
            self.manager.import_preset(saved)
        copied = self.manager.import_preset(saved, "copy")
        self.assertNotEqual(copied["id"], saved["id"])
        self.assertNotEqual(copied["name"], saved["name"])
        self.manager.import_preset({**saved, "tree": {"root": "new"}}, "overwrite")
        self.assertEqual(len(self.manager.list()), 2)

    def test_failed_atomic_replace_retains_original(self):
        self.manager.save(self.preset)
        before = self.manager.path.read_bytes()
        with patch.object(MODULE.os, "replace", side_effect=OSError("磁盘写入失败")):
            with self.assertRaises(OSError):
                self.manager.save({**self.preset, "name": "写不进去"})
        self.assertEqual(self.manager.path.read_bytes(), before)
        self.assertEqual(list(Path(self.temp.name).glob("*.tmp")), [])

    def test_corrupt_and_unknown_version_not_overwritten(self):
        self.manager.path.write_text("坏文件", encoding="utf-8")
        with self.assertRaises(MODULE.PresetError):
            self.manager.save(self.preset)
        self.assertEqual(self.manager.path.read_text(encoding="utf-8"), "坏文件")
        with self.assertRaises(MODULE.PresetError):
            self.manager.import_preset({**self.preset, "schema_version": 99})

    def test_router_crud_preview_and_errors(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(MODULE.create_router(self.temp.name, lambda tree: {"ok": False, "errors": [{"path": "tree", "message": "unknown_node"}]}))
        client = TestClient(app)
        base = "/behavior-tree/presets"
        preview = client.post(base + "/preview", json={"preset": self.preset})
        self.assertEqual(preview.status_code, 200)
        self.assertFalse(preview.json()["validation"]["ok"])
        saved = client.post(base, json=self.preset).json()
        self.assertEqual(client.get(base).json()["presets"], [saved])
        self.assertEqual(client.get(base + "/" + saved["id"]).json(), saved)
        self.assertEqual(client.post(base + "/import", json={"preset": saved}).status_code, 400)
        self.assertEqual(client.post(base + "/preview", json={"preset": {"schema_version": 2}}).status_code, 400)
        with patch.object(MODULE.os, "replace", side_effect=OSError("写入失败")):
            self.assertEqual(client.put(base + "/" + saved["id"], json=saved).status_code, 500)
        self.assertEqual(client.delete(base + "/" + saved["id"]).status_code, 200)
        self.assertEqual(client.get(base + "/" + saved["id"]).status_code, 404)


if __name__ == "__main__":
    unittest.main()
