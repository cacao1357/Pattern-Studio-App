"""Local CLI. Ark keys are never CLI arguments or included in local API requests."""

import argparse
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import httpx

from app.config import ConfigurationError, load_settings
from app.schemas.contracts import DEFAULT_LIMITS


BASE = "http://127.0.0.1:8765/api/v1"


def init_config(root: Path = ROOT) -> Path:
    """Create once, with no provider key and all payment gates closed."""
    template = (root / ".env.example").read_text(encoding="utf-8")
    text = template
    target = root / ".env"
    # Exclusive creation protects any existing user config, including symlinks.
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            # On Windows, 0600 does not control the DACL. Keep the file empty
            # until inherited access is removed, then write the blank-key config.
            if os.name == "nt":
                options = {"capture_output": True, "text": True, "creationflags": subprocess.CREATE_NO_WINDOW}
                identity = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], check=True, **options)
                sid = next(csv.reader(io.StringIO(identity.stdout.strip())))[1]
                if not sid.startswith("S-1-") or not all(c.isdigit() or c in "S-" for c in sid):
                    raise ConfigurationError("Could not identify the current Windows user for private config permissions")
                subprocess.run(["icacls", str(target), "/inheritance:r", "/grant:r", f"*{sid}:(F)"], check=True, **options)
            else:
                target.chmod(0o600)
            handle.write(text)
    except Exception:
        # This file was just created by us, contains no Ark key, and is unsafe to keep.
        target.unlink(missing_ok=True)
        raise ConfigurationError("Could not create private local config; no .env was kept") from None
    return target


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("init-config", help="Create private .env without overwriting existing config")
    commands.add_parser("status", help="Read readiness without contacting Ark")
    upload = commands.add_parser("upload", help="Upload a local file to the local API only")
    upload.add_argument("file", type=Path)
    upload.add_argument("--filename", help="Explicit content-appropriate upload filename, if a working copy needs one")
    run = commands.add_parser("run", help="One explicitly authorized, potentially billable validation")
    run.add_argument("asset_id", type=UUID)
    run.add_argument("--operation", choices=["decompose", "edit"], required=True)
    run.add_argument("--intent", choices=["separate_pattern", "restore_small_gap", "reconnect_lines"])
    run.add_argument("--size", choices=["1K", "1.5K", "2K", "auto"], default="1K")
    run.add_argument("--bbox", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    run.add_argument("--idempotency-key", required=True, help="Reuse this same independent key after an uncertain local response")
    run.add_argument("--confirm-upload", action="store_true", required=True)
    run.add_argument("--confirm-charge", action="store_true", required=True)
    get = commands.add_parser("get", help="Read a saved call; never triggers another generation")
    get.add_argument("call_id", type=UUID)
    settle = commands.add_parser("settle", help="Record cost only after checking account-side billing")
    settle.add_argument("call_id", type=UUID)
    settle.add_argument("--actual-cost-cny", required=True)
    settle.add_argument("--billing-reference", required=True)
    download = commands.add_parser("download", help="Download one registered asset without overwriting files")
    download.add_argument("asset_id", type=UUID)
    download.add_argument("destination", type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init-config":
            target = init_config()
            print(f"Private config created: {target}; Ark key is blank and paid calls remain disabled.")
            return 0
        settings = load_settings(ROOT)
        with httpx.Client(base_url=BASE, trust_env=False, follow_redirects=False, timeout=240,
                          headers={"X-Pattern-Studio": "local"}) as client:
            if args.command == "status":
                response = client.get(BASE + "/seedream/status")
            elif args.command == "upload":
                if args.file.stat().st_size > DEFAULT_LIMITS.max_upload_bytes:
                    raise ConfigurationError("Input exceeds the upload byte limit")
                response = client.post(BASE + "/seedream/inputs", params={"filename": args.filename or args.file.name},
                                       content=args.file.read_bytes(), headers={"Content-Type": "application/octet-stream"})
            elif args.command == "run":
                payload = {"input_asset_id": str(args.asset_id), "operation": args.operation,
                           "intent": args.intent or ("separate_pattern" if args.operation == "decompose" else "restore_small_gap"),
                           "size": args.size, "consent_to_upload": args.confirm_upload, "consent_to_charge": args.confirm_charge}
                if args.bbox:
                    payload["bbox"] = dict(zip(("left", "top", "right", "bottom"), args.bbox))
                response = client.post(BASE + "/seedream/validations", json=payload,
                                       headers={"Idempotency-Key": args.idempotency_key})
            elif args.command == "get":
                response = client.get(BASE + f"/seedream/validations/{args.call_id}")
            elif args.command == "settle":
                response = client.post(BASE + f"/seedream/validations/{args.call_id}/settlement",
                                       json={"actual_cost_cny": args.actual_cost_cny, "billing_reference": args.billing_reference})
            else:
                # Only registered local assets; destination is explicitly chosen by the CLI user.
                response = client.get(BASE + f"/assets/{args.asset_id}/download")
                if response.is_success:
                    with args.destination.open("xb") as handle:
                        handle.write(response.content)
                    print("Registered asset downloaded; existing files were not overwritten.")
                    return 0
            print(json.dumps(response.json(), ensure_ascii=True, indent=2))
            if not response.is_success:
                return 1
            data = response.json()
            return 1 if args.command == "run" and data.get("state") != "succeeded" else 0
    except FileExistsError:
        print("Existing file preserved; choose a new destination or edit the existing local config yourself.")
    except ConfigurationError as error:
        print(f"Local configuration error: {error}")
    except (httpx.HTTPError, OSError, ValueError):
        print("Local API request did not complete. No request was retried. For a generation, query its saved call or reuse exactly the same idempotency key; do not create a new key to retry an unknown outcome.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
