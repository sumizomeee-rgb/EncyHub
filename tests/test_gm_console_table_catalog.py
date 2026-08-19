from pathlib import Path

from tools.gm_console.table_catalog import TableCatalog


def test_table_catalog_parses_schema_and_maps_logical_path(tmp_path: Path):
    schema_dir = tmp_path / "Product" / "Lua" / "Matrix" / "XCommon"
    table_dir = tmp_path / "Dev" / "Client" / "BuildBytes" / "Table" / "Share" / "Role"
    schema_dir.mkdir(parents=True)
    table_dir.mkdir(parents=True)
    (schema_dir / "XTable.lua").write_text(
        '\n'.join([
            'local ValueTypestring = {ValueType = "string"}',
            'local ValueTypeintPrimaryKey = {ValueType = "int",PrimaryKey=true}',
            'local Type1ValueTypebool = {Type = 1, ValueType = "bool"}',
            'XTable = {',
            '    XTableRole = {',
            '        Id = ValueTypeintPrimaryKey,',
            '        Name = ValueTypestring,',
            '        Flags = Type1ValueTypebool,',
            '    },',
            '}',
        ]),
        encoding="utf-8",
    )
    (table_dir / "Role.tab").write_text("Id\tName\tFlags[1]\n", encoding="utf-8")

    catalog = TableCatalog()
    entry = catalog.get(str(tmp_path), "XTableRole")

    assert entry is not None
    assert entry["path"] == "Share/Role/Role.tab"
    assert entry["pkField"] == "Id"
    assert entry["fields"]["Flags"] == {"Type": 1, "ValueType": "bool"}
    assert "fields" not in catalog.summaries(str(tmp_path))[0]


def test_table_catalog_returns_empty_when_haruroot_is_incomplete(tmp_path: Path):
    assert TableCatalog().load(str(tmp_path)) == {}
