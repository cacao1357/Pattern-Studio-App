"""Build the offline Windows x64 CPU release from a pinned standalone CPython archive.

Requires Windows, Python 3.11+, Git LFS checkout, uv, and network for binary wheels.
Pass the install_only_stripped archive from astral-sh/python-build-standalone
release 20261110 for CPython 3.11.18 x86_64-pc-windows-msvc.
"""

import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SHA = "f31751f4a8483f5ac7cd77ad83f8dfb80d9f2a7245bff1585e27516c777fb46f"
APP_PATHS = [
    "README.md", "Start.cmd", ".env.example", "pyproject.toml", "backend/app", "frontend",
    "model/model.pt", "model/inference.json", "model/leftrefill", "scripts/serve_api.py",
    "scripts/seedream_validate.py", "scripts/backup_restore.py", "scripts/validate_local_repair.py",
]


def project_files():
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--", *APP_PATHS], cwd=ROOT)
    for name in tracked.decode("utf-8").split("\0"):
        if not name or name.startswith("frontend/tests/"):
            continue
        if name.startswith("frontend/") and name.endswith(".md"):
            continue
        yield ROOT / name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("python_archive", type=Path)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Build on Windows x64.")
    with args.python_archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != RUNTIME_SHA:
            parser.error("Unexpected standalone CPython archive.")
    with (ROOT / "model/model.pt").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != "e63084fb76094a0f3e9e4623f733e9351450e8c077475f97c81197bd3928cdc6":
            parser.error("Pull the release TGS checkpoint with git lfs pull.")
    spec = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    output = ROOT / "dist" / f"Pattern-Studio-{spec['version']}-windows-x64.zip"
    output.parent.mkdir(exist_ok=True)
    if output.exists():
        parser.error(f"Output already exists: {output}")
    with tempfile.TemporaryDirectory(dir=output.parent) as work:
        stage = Path(work)
        with tarfile.open(args.python_archive) as archive:
            archive.extractall(stage, filter="data")
        runtime = stage / "python"
        python = runtime / "python.exe"
        install = ["uv", "--no-config", "pip", "install", "--python", str(python),
                   "--only-binary", ":all:", "--link-mode", "copy"]
        cpu = ["torch==2.9.1+cpu", "torchvision==0.24.1+cpu"]
        subprocess.run([*install, "--index-url", "https://download.pytorch.org/whl/cpu",
                        "--no-deps", *cpu], check=True)
        subprocess.run([*install, "--index-url", "https://pypi.org/simple", *cpu,
                        "segmentation-models-pytorch==0.5.0", "timm==1.0.31",
                        *spec["dependencies"]], check=True)
        subprocess.run([python, "-I", "-B", "-m", "pip", "check"], check=True)
        temporary = stage / output.name
        with ZipFile(temporary, "x", compression=ZIP_DEFLATED, compresslevel=5) as bundle:
            for path in project_files():
                bundle.write(path, "Pattern-Studio/" + path.relative_to(ROOT).as_posix())
            for path in runtime.rglob("*"):
                rel = path.relative_to(runtime)
                # Console launchers embed the build interpreter's absolute path.
                # Users invoke modules through python.exe. Retain distribution licenses.
                if rel.parts[0] == "Scripts" or "__pycache__" in rel.parts:
                    continue
                if path.is_file() and path.name != "uv_cache.json":
                    bundle.write(path, "Pattern-Studio/python/" + rel.as_posix())
        temporary.rename(output)
    print(output)


if __name__ == "__main__":
    main()
