"""Launch the same-origin local workbench and bounded worker in the active env."""

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import uvicorn

from app.config import ConfigurationError, load_settings
from app.main import ApiAlreadyRunningError, create_app, exclusive_process


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="Local HTTP port (default: 8765)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        settings = load_settings(ROOT)
    except ConfigurationError as error:
        print(f"Configuration incomplete: {error}.")
        if (ROOT / ".env").is_file():
            print("Edit the existing project .env or overriding environment variables; init-config does not overwrite it.")
        else:
            print("Create private config with: python -B scripts/seedream_validate.py init-config")
        return 2
    # Give a clear message before Uvicorn's lifespan traceback. The lifespan
    # still acquires its own lock to protect against concurrent startup races.
    if settings.storage_root.is_dir():
        try:
            with exclusive_process(settings.storage_root):
                pass
        except ApiAlreadyRunningError:
            print("Pattern Studio API is already running for this project. Use the existing service, or stop it before starting another instance.")
            print("After changing .env, stop the old service and start it again. Do not delete api-process.lock to bypass the OS lock.")
            return 2
    print(f"Starting Pattern Studio: http://127.0.0.1:{args.port} (local workbench; no password required).")
    print("Open this address in a browser to start. ARK_API_KEY stays in the server configuration.")
    print("Seedream enabled: " + str(not settings.blockers()).lower() + "; startup creates no new AI request. Previously submitted queued tasks may resume.")
    if settings.blockers():
        print("Seedream blockers: " + ", ".join(settings.blockers()) + ". Key validity is not checked on startup.")
    uvicorn.run(create_app(settings), host="127.0.0.1", port=args.port, workers=1, http="h11", ws="none",
                proxy_headers=False, access_log=False, log_level="warning", limit_concurrency=32,
                h11_max_incomplete_event_size=16 * 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
