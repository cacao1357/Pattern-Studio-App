"""Offline, verified project snapshots; never load credentials or start workers."""

from contextlib import closing
from datetime import datetime, timezone
import hashlib
from importlib import metadata as packages
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import tomllib
from uuid import UUID, uuid4


FORMAT = "pattern-studio-backup-v1"
MANIFEST = "backup-manifest.json"
DATABASE = "storage/api/s0.sqlite3"
ROOT_FILES = {"pyproject.toml", "README.md", ".env.example", ".gitignore",
              "中期检查前实施方案_V1.2_单人分阶段融合版.md"}
SOURCE_TYPES = {
    "backend": {".py"}, "frontend": {".html", ".css", ".js", ".mjs", ".svg"},
    "scripts": {".py", ".ps1", ".mjs"}, "docs": {".md"},
    "samples": {".md", ".csv", ".json", ".jsonl"},
}
REQUIRED = {"pyproject.toml", ".env.example", "backend/app/main.py", "scripts/serve_api.py", DATABASE}
TABLES = {"assets", "provider_calls", "images", "local_jobs", "local_keys", "asset_relations",
          "local_pipelines", "feedback", "consents", "ai_flows", "repair_decisions"}


class BackupError(ValueError):
    """A snapshot is incomplete, unsafe, or not supported by this tool."""


def _overlaps(first, second):
    return first == second or first in second.parents or second in first.parents


def _resolve(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink() or part.exists() and part.resolve() != part:
            raise BackupError("Symbolic links and redirected directories are not supported")
    return path.resolve()


def _relative(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or "\0" in name:
        raise BackupError("Invalid snapshot path")
    value = PurePosixPath(name)
    if value.is_absolute() or any(p in {".", ".."} for p in name.split("/")) or str(value) != name:
        raise BackupError("Invalid snapshot path")
    if re.search(r'[<>"|?*\x00-\x1f]', name) or any(
            p.endswith((" ", ".")) or PureWindowsPath(p).is_reserved() for p in value.parts):
        raise BackupError("Snapshot path is not a regular Windows filename")
    return value


def _allowed_source(name):
    relative = _relative(name)
    if len(relative.parts) == 1:
        return name in ROOT_FILES
    return (relative.parts[0] in SOURCE_TYPES
            and relative.suffix in SOURCE_TYPES[relative.parts[0]]
            and not any(p.startswith(".") or p in {"node_modules", "__pycache__", "dist", "build"}
                        for p in relative.parts[1:]))


def _asset_name(identifier, suffix):
    try:
        if str(UUID(identifier)) != identifier or suffix not in {".png", ".jpg", ".svg", ".zip"}:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise BackupError("Invalid registered asset filename") from None
    return f"storage/api/assets/{identifier}{suffix}"


def _file(root, name):
    relative = _relative(name)
    candidate = root.joinpath(*relative.parts)
    resolved = _resolve(candidate)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise BackupError(f"Missing regular file: {name}")
    return resolved


def _fingerprint(path):
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
            count += len(block)
    return {"bytes": count, "sha256": digest.hexdigest()}


def _readonly(path):
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)


def _audit_database(path):
    with closing(_readonly(path)) as db:
        db.row_factory = sqlite3.Row
        if [row[0] for row in db.execute("PRAGMA integrity_check")] != ["ok"]:
            raise BackupError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise BackupError("SQLite contains broken source/history relations")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # The live store may not have been opened since the S2 -> S3 update.
        # Accept that known additive schema only when no repair history exists.
        if not (TABLES - {"repair_decisions"}) <= tables:
            raise BackupError("Unsupported workbench database schema")
        has_repairs = "repair_decisions" in tables
        if not has_repairs and db.execute("SELECT 1 FROM local_jobs WHERE kind='repair' LIMIT 1").fetchone():
            raise BackupError("Missing repair history table in a database containing repairs")
        assets = {}
        parents = []
        for row in db.execute("SELECT id,suffix,metadata FROM assets"):
            name = _asset_name(row["id"], row["suffix"])
            item = json.loads(row["metadata"])
            if (item.get("asset_id") != row["id"] or type(item.get("bytes")) is not int
                    or item["bytes"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", ""))):
                raise BackupError("Invalid immutable asset metadata")
            assets[name] = {"bytes": item["bytes"], "sha256": item["sha256"]}
            parents.extend(p["asset_id"] for p in item.get("parents", []))
        identifiers = {PurePosixPath(name).stem for name in assets}
        if any(identifier not in identifiers for identifier in parents):
            raise BackupError("An asset references a missing source")
        for row in db.execute("SELECT result_json FROM local_jobs"):
            if any(a.get("asset_id") not in identifiers for a in json.loads(row[0]).get("assets", [])):
                raise BackupError("A historical job references a missing asset")
        return assets, {
            "schema": "s3" if has_repairs else "s2-before-repair",
            "assets": len(assets),
            "images": db.execute("SELECT count(*) FROM images").fetchone()[0],
            "source_relations": db.execute("SELECT count(*) FROM asset_relations").fetchone()[0],
            "consents": db.execute("SELECT count(*) FROM consents").fetchone()[0],
            "unfinished_jobs": [dict(row) for row in db.execute(
                "SELECT id,kind,state FROM local_jobs WHERE state IN ('queued','running') ORDER BY id")],
            "waiting_for_layer_selection": [row[0] for row in db.execute(
                "SELECT f.id FROM ai_flows f JOIN local_jobs j ON j.id=f.decomposition_job_id "
                "WHERE j.state='succeeded' AND f.continuation_job_id IS NULL AND f.decision_json IS NULL "
                "AND f.state!='rejected' ORDER BY f.id")],
            "waiting_for_repair_decision": [row[0] for row in db.execute(
                "SELECT j.id FROM local_jobs j LEFT JOIN repair_decisions d ON d.job_id=j.id "
                "WHERE j.kind='repair' AND j.state='succeeded' AND d.job_id IS NULL ORDER BY j.id")] if has_repairs else [],
            "calls_needing_review": [dict(row) for row in db.execute(
                "SELECT id,state,reservation_cents,actual_cost_cents FROM provider_calls "
                "WHERE actual_cost_cents IS NULL OR state IN ('running','outcome_unknown','output_invalid') ORDER BY id")],
        }


def _template_is_private(path):
    # Never read .env to decide what to exclude. Only the explicit template is copied.
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip().removeprefix("export ") in {"ARK_API_KEY", "PATTERN_STUDIO_API_TOKEN"}:
            if value.strip().strip("\"'"):
                raise BackupError("The configuration template must not contain credentials")


def _environment(project):
    spec = tomllib.loads((project / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    versions = {}
    for dependency in spec.get("dependencies", []):
        name = re.split(r"[<>=!~;\[]", dependency, maxsplit=1)[0].strip()
        try:
            versions[name] = packages.version(name)
        except packages.PackageNotFoundError:
            versions[name] = None
    try:
        node = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        node_version = node.stdout.strip() if node.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        node_version = None
    return {"application_version": spec["version"], "python": sys.version,
            "node": node_version, "platform": platform.platform(), "installed_packages": versions}


def _copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as reader, target.open("xb") as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())


def _stage(destination):
    if destination.exists():
        raise BackupError("Destination already exists; choose a new directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.partial-{uuid4().hex}")
    temporary.mkdir()
    return temporary


def _publish(temporary, destination):
    if destination.exists():
        raise BackupError("Destination appeared during the operation; refusing to overwrite it")
    temporary.rename(destination)


def _discard(temporary, destination):
    # Only the unique staging directory created by this operation can be removed.
    if temporary.parent == destination.parent and temporary.name.startswith(f".{destination.name}.partial-"):
        if temporary.exists() and not temporary.is_symlink() and temporary.resolve() == temporary:
            shutil.rmtree(temporary)


def _files_in(root):
    def failed(error):
        raise BackupError("Cannot enumerate all snapshot files") from error
    for current, directories, filenames in os.walk(root, followlinks=False, onerror=failed):
        for directory in directories:
            _resolve(Path(current) / directory)
        for filename in filenames:
            name = (Path(current) / filename).relative_to(root).as_posix()
            yield name, _file(root, name)


def verify_backup(backup):
    backup = _resolve(backup)
    manifest = json.loads(_file(backup, MANIFEST).read_text(encoding="utf-8"))
    files = manifest.get("files")
    if manifest.get("format") != FORMAT or not isinstance(files, dict) or not REQUIRED <= files.keys():
        raise BackupError("Unsupported or incomplete backup manifest")
    if len({name.casefold() for name in files}) != len(files):
        raise BackupError("Snapshot contains conflicting Windows filenames")
    for name, expected in files.items():
        _relative(name)
        if not (_allowed_source(name) or name == DATABASE or name.startswith("storage/api/assets/")):
            raise BackupError("Snapshot contains a file outside its supported scope")
        if not isinstance(expected, dict) or _fingerprint(_file(backup, name)) != expected:
            raise BackupError(f"Snapshot file changed: {name}")
    actual = {name for name, _ in _files_in(backup)}
    if actual != set(files) | {MANIFEST}:
        raise BackupError("Snapshot has unexpected or missing files")
    _template_is_private(_file(backup, ".env.example"))
    assets, summary = _audit_database(_file(backup, DATABASE))
    included = {name: value for name, value in files.items() if name.startswith("storage/api/assets/")}
    if included != assets:
        raise BackupError("Snapshot assets do not match the registered database assets")
    if summary != manifest.get("database_summary"):
        raise BackupError("Snapshot database summary changed")
    return manifest


def create_backup(project, destination, *, storage_root=None):
    project, destination = _resolve(project), _resolve(destination)
    storage = _resolve(storage_root if storage_root is not None else project / "storage/api")
    if not project.is_dir() or not storage.is_dir():
        raise BackupError("Project and storage directories must already exist")
    if _overlaps(destination, storage) or destination == project or destination in project.parents:
        raise BackupError("Backup destination overlaps the project or live storage")
    for folder in SOURCE_TYPES:
        if _overlaps(destination, project / folder):
            raise BackupError("Backup destination overlaps source files")
    _file(storage, "s0.sqlite3")
    _template_is_private(_file(project, ".env.example"))
    temporary = _stage(destination)
    try:
        # Reuse the API's exact OS lock, without loading settings or creating a Store.
        from app.main import ApiAlreadyRunningError, exclusive_process
        try:
            with exclusive_process(storage):
                database = temporary / DATABASE
                database.parent.mkdir(parents=True)
                with closing(_readonly(storage / "s0.sqlite3")) as source, closing(sqlite3.connect(database)) as snapshot:
                    source.backup(snapshot)
                    snapshot.execute("PRAGMA journal_mode=DELETE")
                assets, summary = _audit_database(database)
                for name in assets:
                    _copy(_file(storage, name.removeprefix("storage/api/")), temporary / name)
                    if _fingerprint(temporary / name) != assets[name]:
                        raise BackupError(f"Registered asset changed or is incomplete: {name}")
                for source in project.iterdir():
                    if source.is_file() and _allowed_source(source.name):
                        _copy(_file(project, source.name), temporary / source.name)
                for folder in SOURCE_TYPES:
                    base = project / folder
                    if not base.is_dir():
                        continue
                    _resolve(base)
                    def unreadable(error):
                        raise BackupError("Cannot read all selected project source files") from error
                    for current, directories, filenames in os.walk(base, followlinks=False, onerror=unreadable):
                        directories[:] = [d for d in directories if not d.startswith(".")
                                          and d not in {"node_modules", "__pycache__", "dist", "build"}]
                        for directory in directories:
                            _resolve(Path(current) / directory)
                        for filename in filenames:
                            source = Path(current) / filename
                            name = source.relative_to(project).as_posix()
                            if _allowed_source(name):
                                _copy(_file(project, name), temporary / name)
        except ApiAlreadyRunningError:
            raise BackupError("Stop the API for this storage before backing up; do not delete its lock file") from None
        files = {p.relative_to(temporary).as_posix(): _fingerprint(p)
                 for p in sorted(temporary.rglob("*")) if p.is_file()}
        manifest = {"format": FORMAT, "created_at": datetime.now(timezone.utc).isoformat(),
                    "source_project": str(project), "source_storage": str(storage),
                    "environment": _environment(project), "files": files, "database_summary": summary,
                    "excluded": [".env and credentials", "OS locks and SQLite sidecars", "unregistered assets",
                                 "storage/samples development originals", "validation reports", "caches and dependencies"],
                    "permissions": "Local operational backup only; no new display or training permission"}
        (temporary / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        verify_backup(temporary)
        _publish(temporary, destination)
        return manifest
    finally:
        _discard(temporary, destination)


def _quarantine(database):
    """A restored copy must not resume even previously consented paid work."""
    timestamp = datetime.now(timezone.utc).isoformat()
    error = json.dumps({"code": "RESTORE_REQUIRES_RESUBMISSION",
                        "message": "Unfinished work was stopped on restore; reconcile costs before explicitly creating a new task"})
    with closing(sqlite3.connect(database)) as db, db:
        jobs = db.execute("SELECT id,result_json FROM local_jobs WHERE state IN ('queued','running')").fetchall()
        calls = [row[0] for row in db.execute("SELECT id FROM provider_calls WHERE state='running'")]
        for identifier, result_json in jobs:
            result = json.loads(result_json)
            for step in result.get("steps", []):
                if step["state"] == "running":
                    step["state"] = "failed"
            db.execute("UPDATE local_jobs SET state='failed',error_json=?,result_json=?,finished_at=?,updated_at=?,"
                       "lease_token=NULL,lease_until=NULL WHERE id=?",
                       (error, json.dumps(result), timestamp, timestamp, identifier))
        db.execute("UPDATE provider_calls SET state='outcome_unknown',updated_at=?,result_json=? WHERE state='running'",
                   (timestamp, json.dumps({"error_code": "RESTORED_INTERRUPTED_CALL", "needs_reconcile": True,
                                           "automatic_retry": False})))
    return {"stopped_job_ids": [row[0] for row in jobs], "unknown_call_ids": calls,
            "paid_requests_sent": 0, "budget_reservations_changed": False}


def restore_backup(backup, destination):
    backup, destination = _resolve(backup), _resolve(destination)
    manifest = verify_backup(backup)
    workspace = Path(__file__).resolve().parents[3]
    protected = [backup, workspace, _resolve(manifest["source_project"]), _resolve(manifest["source_storage"])]
    if any(_overlaps(destination, path) for path in protected):
        raise BackupError("Restore destination must be separate from the backup, source project, and current workspace")
    temporary = _stage(destination)
    try:
        for name, expected in manifest["files"].items():
            target = temporary / name
            _copy(_file(backup, name), target)
            if _fingerprint(target) != expected:
                raise BackupError(f"File changed during restore: {name}")
        report = {"format": FORMAT, "restored_at": datetime.now(timezone.utc).isoformat(),
                  "backup_created_at": manifest["created_at"], "environment": manifest["environment"],
                  "recovery": _quarantine(temporary / DATABASE)}
        _, report["database_summary"] = _audit_database(temporary / DATABASE)
        report["restored_database"] = _fingerprint(temporary / DATABASE)
        report["credentials_restored"] = False
        report["service_started"] = False
        (temporary / "restore-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _publish(temporary, destination)
        return report
    finally:
        _discard(temporary, destination)
