"""从 HaruRoot 生成跨平台 Table Viewer 所需的配表目录。"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any


_ALIAS_RE = re.compile(r"^local\s+(\w+)\s*=\s*\{(.*)\}\s*$")
_TABLE_START_RE = re.compile(r"^\s{4}(\w+)\s*=\s*\{\s*$")
_FIELD_RE = re.compile(r"^\s{8}(\w+)\s*=\s*(\w+),?\s*$")


class TableCatalog:
    """解析生成后的 XTable.lua，并把表定义映射到 BuildBytes 逻辑路径。"""

    def __init__(self) -> None:
        self._cache_key: tuple[str, int, int] | None = None
        self._entries: dict[str, dict[str, Any]] = {}

    def load(self, haruroot: str) -> dict[str, dict[str, Any]]:
        root = Path(haruroot)
        schema_file = root / "Product" / "Lua" / "Matrix" / "XCommon" / "XTable.lua"
        table_root = root / "Dev" / "Client" / "BuildBytes" / "Table"
        if not schema_file.is_file() or not table_root.is_dir():
            self._entries = {}
            self._cache_key = None
            return self._entries

        stat = schema_file.stat()
        key = (str(root.resolve()), stat.st_mtime_ns, stat.st_size)
        if key == self._cache_key:
            return self._entries

        schemas = self._parse_schemas(schema_file)
        paths = self._scan_paths(table_root, schemas)
        entries: dict[str, dict[str, Any]] = {}
        for name, fields in schemas.items():
            path = paths.get(name)
            if not path:
                continue
            pk_field, pk_is_string = self._primary_key(fields)
            entries[name] = {
                "name": name,
                "path": path,
                "pathFound": True,
                "fieldCount": len(fields),
                "hasPK": pk_field is not None,
                "pkField": pk_field,
                "pkIsString": pk_is_string,
                "fields": fields,
            }

        self._cache_key = key
        self._entries = entries
        return entries

    def summaries(self, haruroot: str) -> list[dict[str, Any]]:
        hidden = {"fields"}
        return [
            {key: value for key, value in entry.items() if key not in hidden}
            for entry in self.load(haruroot).values()
        ]

    def get(self, haruroot: str, table_name: str) -> dict[str, Any] | None:
        return self.load(haruroot).get(table_name)

    @staticmethod
    def _parse_descriptor(body: str) -> dict[str, Any]:
        descriptor: dict[str, Any] = {}
        value_type = re.search(r'ValueType\s*=\s*"([^"]+)"', body)
        key_type = re.search(r'KeyType\s*=\s*"([^"]+)"', body)
        collection_type = re.search(r"Type\s*=\s*(\d+)", body)
        if value_type:
            descriptor["ValueType"] = value_type.group(1)
        if key_type:
            descriptor["KeyType"] = key_type.group(1)
        if collection_type:
            descriptor["Type"] = int(collection_type.group(1))
        if re.search(r"PrimaryKey\s*=\s*true", body):
            descriptor["PrimaryKey"] = True
        return descriptor

    def _parse_schemas(self, schema_file: Path) -> dict[str, dict[str, dict[str, Any]]]:
        aliases: dict[str, dict[str, Any]] = {}
        schemas: dict[str, dict[str, dict[str, Any]]] = {}
        current_name: str | None = None
        current_fields: dict[str, dict[str, Any]] = {}

        with schema_file.open("r", encoding="utf-8-sig") as source:
            for raw_line in source:
                line = raw_line.rstrip("\r\n")
                alias_match = _ALIAS_RE.match(line)
                if alias_match:
                    aliases[alias_match.group(1)] = self._parse_descriptor(alias_match.group(2))
                    continue

                if current_name is None:
                    table_match = _TABLE_START_RE.match(line)
                    if table_match:
                        current_name = table_match.group(1)
                        current_fields = {}
                    continue

                if line == "    },":
                    schemas[current_name] = current_fields
                    current_name = None
                    current_fields = {}
                    continue

                field_match = _FIELD_RE.match(line)
                if field_match and field_match.group(2) in aliases:
                    current_fields[field_match.group(1)] = dict(aliases[field_match.group(2)])

        return schemas

    @staticmethod
    def _primary_key(fields: dict[str, dict[str, Any]]) -> tuple[str | None, bool]:
        for field_name, descriptor in fields.items():
            if descriptor.get("PrimaryKey"):
                return field_name, descriptor.get("ValueType") == "string"
        return None, False

    def _scan_paths(
        self,
        table_root: Path,
        schemas: dict[str, dict[str, dict[str, Any]]],
    ) -> dict[str, str]:
        candidates: dict[str, list[tuple[str, Path]]] = {}
        for scope in ("Share", "Client"):
            scope_root = table_root / scope
            if not scope_root.is_dir():
                continue
            for directory, _, files in os.walk(scope_root):
                for file_name in files:
                    if not file_name.lower().endswith(".tab"):
                        continue
                    stem = file_name[:-4]
                    absolute_path = Path(directory) / file_name
                    relative_path = f"{scope}/{absolute_path.relative_to(scope_root).as_posix()}"
                    for name in (f"XTable{stem}", stem):
                        if name in schemas:
                            candidates.setdefault(name, []).append((relative_path, absolute_path))

        result: dict[str, str] = {}
        for name, items in candidates.items():
            if len(items) == 1:
                result[name] = items[0][0]
                continue
            fields = schemas[name]
            result[name] = max(items, key=lambda item: self._header_score(item[1], fields))[0]
        return result

    @staticmethod
    def _header_score(path: Path, fields: dict[str, dict[str, Any]]) -> int:
        try:
            with path.open("r", encoding="gb18030", errors="replace") as source:
                columns = source.readline().rstrip("\r\n").split("\t")
        except OSError:
            return 0
        names = {column.split("[", 1)[0] for column in columns if column}
        score = len(names.intersection(fields))
        pk_field, _ = TableCatalog._primary_key(fields)
        if pk_field in names:
            score += 100
        return score


table_catalog = TableCatalog()
