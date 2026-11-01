"""Create/check offline snapshots or restore a new isolated project directory."""

import argparse
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.backup import BackupError, create_backup, restore_backup, verify_backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    backup = actions.add_parser("backup", help="Stop the API first; .env is excluded")
    backup.add_argument("--output", required=True, type=Path)
    verify = actions.add_parser("verify", help="Read-only file, SQLite and lineage checks")
    verify.add_argument("--backup", required=True, type=Path)
    restore = actions.add_parser("restore", help="Create a new isolated project; never overwrite or start it")
    restore.add_argument("--backup", required=True, type=Path)
    restore.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.action == "backup":
            result = create_backup(ROOT, args.output)
            output = args.output.resolve()
        elif args.action == "verify":
            result = verify_backup(args.backup)
            output = args.backup.resolve()
        else:
            result = restore_backup(args.backup, args.target)
            output = args.target.resolve()
        print(json.dumps({"action": args.action, "directory": str(output), "passed": True,
                          "database_summary": result["database_summary"],
                          **({"recovery": result["recovery"]} if "recovery" in result else {})}, ensure_ascii=True))
        return 0
    except (BackupError, OSError, sqlite3.Error, ValueError, KeyError, TypeError) as error:
        # Do not print arbitrary file/JSON/SQLite exception text, which can contain source data.
        message = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(json.dumps({"action": args.action, "passed": False, "error": message}, ensure_ascii=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
