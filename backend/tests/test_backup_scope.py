from pathlib import Path
from shutil import copyfile

from app.services.backup import create_backup, restore_backup
from app.workbench_store import WorkbenchStore


def test_snapshot_restores_legacy_image_and_excludes_local_drafts(tmp_path):
    root = Path(__file__).resolve().parents[2]
    project = tmp_path / "project"
    project.mkdir()
    image = "frontend/assets/pattern-studio/crane-line-blue.png"
    for name in (".env.example", "pyproject.toml", "backend/app/main.py", "scripts/serve_api.py", image):
        target = project / name
        target.parent.mkdir(parents=True, exist_ok=True)
        copyfile(root / name, target)
    drafts = ("docs/local/notes.md", "frontend/next/index.html", "frontend/next-v2-backup-20261110/index.html")
    for name in drafts:
        target = project / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("local draft", encoding="utf-8")
    WorkbenchStore(project / "storage/api")

    snapshot = tmp_path / "snapshot"
    manifest = create_backup(project, snapshot)
    assert set(drafts).isdisjoint(manifest["files"])
    assert {Path(name).parent.as_posix() for name in drafts}.issubset(manifest["excluded"])
    restored = tmp_path / "restored"
    restore_backup(snapshot, restored)
    assert (restored / image).read_bytes() == (project / image).read_bytes()
