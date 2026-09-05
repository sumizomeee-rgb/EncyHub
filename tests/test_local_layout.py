from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_runtime_paths_use_project_local_directory():
    config_source = (ROOT / "hub_core" / "config.py").read_text(encoding="utf-8")
    assert 'ROOT_DIR / ".local"' in config_source
    assert 'DATA_DIR = LOCAL_DIR / "data"' in config_source
    assert 'LOGS_DIR = LOCAL_DIR / "logs"' in config_source


def test_frontend_build_path_does_not_depend_on_logs_location():
    api_source = (ROOT / "hub_core" / "api.py").read_text(encoding="utf-8")
    assert 'frontend_dir = str(ROOT_DIR / "frontend")' in api_source
    assert 'LOGS_DIR.parent / "frontend"' not in api_source


def test_deploy_targets_are_machine_local():
    deploy_source = (ROOT / "deploy" / "encyhub.ps1").read_text(encoding="utf-8-sig")
    assert '".local/deploy/targets.json"' in deploy_source
    assert "harucode-template" not in deploy_source
    assert (ROOT / "deploy" / "targets.example.json").is_file()


def test_legacy_migration_merges_existing_directories(tmp_path):
    from hub_core.config import _migrate_legacy_dir

    legacy = tmp_path / "data"
    target = tmp_path / ".local" / "data"
    (legacy / "gm_console").mkdir(parents=True)
    (target / "gm_console").mkdir(parents=True)
    (legacy / "gm_console" / "legacy.json").write_text("legacy", encoding="utf-8")
    (target / "gm_console" / "current.json").write_text("current", encoding="utf-8")

    _migrate_legacy_dir(legacy, target)

    assert (target / "gm_console" / "legacy.json").read_text(encoding="utf-8") == "legacy"
    assert (target / "gm_console" / "current.json").read_text(encoding="utf-8") == "current"
