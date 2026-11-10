"""行为树用户预设；与自定义 GM 共用数据目录，独立保存。"""
import copy
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path


class PresetError(ValueError):
    pass


def validate_preset(preset):
    if not isinstance(preset, dict):
        raise PresetError("预设必须是对象")
    if preset.get("schema_version") != 1:
        raise PresetError("未知预设版本；原文件不会被修改")
    if not isinstance(preset.get("name"), str) or not preset["name"].strip():
        raise PresetError("请填写预设名称")
    tree = preset.get("tree")
    if not isinstance(tree, dict):
        raise PresetError("缺少完整树数据")
    # 节点目录和运行校验由游戏内核负责，预设保留未知节点。
    return copy.deepcopy(preset)


class BehaviorTreePresetManager:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / "behavior_tree_presets.json"
        self._lock = threading.RLock()

    def _read(self):
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise PresetError(f"读取预设失败：{exc}") from exc
        if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("presets"), list):
            raise PresetError("预设文件格式错误；不会覆盖原文件")
        return data["presets"]

    def _write(self, presets):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=".behavior_tree_", suffix=".tmp", delete=False) as stream:
                temp_path = stream.name
                json.dump({"schema_version": 1, "presets": presets}, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, self.path)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)

    def list(self):
        with self._lock:
            return copy.deepcopy(self._read())

    def get(self, preset_id):
        with self._lock:
            return next((copy.deepcopy(p) for p in self._read() if p.get("id") == preset_id), None)

    def save(self, preset, preset_id=None):
        item = validate_preset(preset)
        with self._lock:
            items = self._read()
            item["id"] = preset_id or item.get("id") or str(uuid.uuid4())
            index = next((i for i, p in enumerate(items) if p.get("id") == item["id"]), None)
            if index is None:
                items.append(item)
            else:
                items[index] = item
            self._write(items)
            return copy.deepcopy(item)

    def delete(self, preset_id):
        with self._lock:
            items = self._read()
            remaining = [p for p in items if p.get("id") != preset_id]
            if len(items) == len(remaining):
                return False
            self._write(remaining)
            return True

    def import_preset(self, preset, conflict="error"):
        item = validate_preset(preset)
        if conflict not in ("error", "copy", "overwrite"):
            raise PresetError("未知冲突策略")
        with self._lock:
            collisions = [p for p in self._read() if p.get("id") == item.get("id") or p.get("name") == item["name"]]
            if collisions and conflict == "error":
                raise PresetError("预设 ID 或名称冲突，请选择另存或覆盖")
            if conflict == "copy":
                item.pop("id", None)
                names = {p.get("name") for p in self._read()}
                base = item["name"]
                number = 1
                while item["name"] in names:
                    item["name"] = f"{base}（副本 {number}）"
                    number += 1
            elif collisions:
                item["id"] = collisions[0]["id"]
            return self.save(item)

    def export_preset(self, preset_id):
        item = self.get(preset_id)
        if item is None:
            raise PresetError("预设不存在")
        return item


def create_router(data_dir, validate_tree):
    from fastapi import APIRouter, Body, HTTPException

    router = APIRouter(prefix="/behavior-tree/presets", tags=["行为树预设"])
    manager = BehaviorTreePresetManager(data_dir)

    def invoke(callback):
        try:
            return callback()
        except PresetError as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, f"保存预设失败：{exc}") from exc

    @router.get("")
    def list_presets():
        return {"presets": invoke(manager.list)}

    @router.post("")
    def save_preset(preset: dict = Body(...)):
        return invoke(lambda: manager.save(preset))

    @router.post("/import")
    def import_preset(body: dict = Body(...)):
        # 未知节点允许保存，导入预览提供与运行一致的校验信息。
        return invoke(lambda: manager.import_preset(body.get("preset"), body.get("conflict", "error")))

    @router.post("/preview")
    def preview_preset(body: dict = Body(...)):
        item = invoke(lambda: validate_preset(body.get("preset")))
        return {"preset": item, "validation": validate_tree(item["tree"])}

    @router.get("/{preset_id}")
    def get_preset(preset_id: str):
        item = invoke(lambda: manager.get(preset_id))
        if item is None:
            raise HTTPException(404, "预设不存在")
        return item

    @router.put("/{preset_id}")
    def update_preset(preset_id: str, preset: dict = Body(...)):
        if invoke(lambda: manager.get(preset_id)) is None:
            raise HTTPException(404, "预设不存在")
        return invoke(lambda: manager.save(preset, preset_id))

    @router.delete("/{preset_id}")
    def delete_preset(preset_id: str):
        if not invoke(lambda: manager.delete(preset_id)):
            raise HTTPException(404, "预设不存在")
        return {"success": True}

    return router
