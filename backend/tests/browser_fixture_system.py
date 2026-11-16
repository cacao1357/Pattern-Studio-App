"""Offline browser fixture for visual SVG editing and compare acceptance.

All assets are synthetic or derived from the repository's ignored model QA pack.
The fixture uses temporary API storage, an empty provider key, and no provider
calls. Browser pixels and SVG samples are written only below ignored storage/.
"""

from pathlib import Path
import json
import socket
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from PIL import Image, ImageDraw
from pydantic import SecretStr
import httpx
import uvicorn

from app.config import Settings
from app.main import create_app
from app.schemas.contracts import VectorOptions
from app.services.local_workbench import LocalWorkbench
from app.services.vector import validate_svg, vectorize
from app.storage import png_bytes
from app.workbench_store import WorkbenchStore


ROOT = Path(__file__).resolve().parents[2]
SAMPLE_NAMES = ("silk100_091-gt.png", "new200_B_191-gt.png", "pattern_0366-gt.png")
SVG_NS = "http://www.w3.org/2000/svg"


def publish_svg(store, source, svg, *, job_name, parameters):
    """Register one deterministic SVG output with a real source-asset edge."""
    job = store.submit("vectorize", source["asset_id"], parameters, uuid4().hex)
    claimed, token = store.claim()
    if not claimed or claimed["job_id"] != job["job_id"]:
        raise RuntimeError("Could not claim the isolated fixture publication job")
    width, height = source["width"], source["height"]
    validate_svg(svg, (width, height))
    inherited = {
        key: value for key, value in source.items()
        if key not in {"asset_id", "sha256", "bytes", "created_at", "parents", "parameters", "kind"}
    }
    metadata = {
        **inherited,
        "kind": "svg",
        "source_asset_id": source["asset_id"],
        "generated_by_job_id": job["job_id"],
        "algorithm_version": "system-svg-browser-fixture-v1",
        "ai_inferred": False,
        "geometry_verified": True,
        "parents": [{"asset_id": source["asset_id"], "role": "vector_input"}],
        "parameters": {"fixture": job_name, **parameters},
    }
    output = store.publish(job["job_id"], token, "vectorize", [
        {"data": svg.encode("utf-8"), "suffix": ".svg", "metadata": metadata},
    ])[0]
    store.finish_job(job["job_id"], token)
    return output


def upload(local, image, filename, note, *, license_name="未确认"):
    record, created, _ = local.upload(
        png_bytes(image), filename, note, uuid4().hex,
        provenance_values={
            "license": license_name,
            "source_type": "synthetic" if filename.startswith("synthetic-") else "local_test_fixture",
            "source_name": "Pattern Studio offline browser validation",
        },
    )
    if not created:
        raise RuntimeError("Fixture upload unexpectedly reused an existing image")
    return record


def make_synthetic_fixture(local, store, output_dir):
    width, height = 224, 128
    color = "#163B68"
    image = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 24, 88, 88), fill=color)
    draw.rectangle((42, 42, 70, 70), fill=(255, 255, 255, 255))
    draw.rectangle((132, 36, 184, 92), fill=color)
    record = upload(local, image, "synthetic-svg-edit.png", "synthetic SVG editor and overlay fixture",
                    license_name="CC0-1.0")
    source = record["normalized"]

    # One SVG path contains two disjoint filled regions and a hole. The API must
    # expose the ring and rectangle as separate visual elements while retaining
    # the hole with its ring.
    svg = (
        f'<svg xmlns="{SVG_NS}" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<path d="M24 24H88V88H24Z M42 42H70V70H42Z M132 36H184V92H132Z" '
        f'fill="{color}" fill-rule="evenodd"/></svg>'
    )
    output = publish_svg(
        store, source, svg, job_name="synthetic-compound-path",
        parameters={"mode": "compound-path-fixture", "visual_components": 2, "holes": 1},
    )
    (output_dir / "synthetic-compound-source.png").write_bytes(png_bytes(image))
    (output_dir / "synthetic-compound-source.svg").write_text(svg, encoding="utf-8")
    return {"image_id": record["image_id"], "source_asset_id": source["asset_id"],
            "svg_asset_id": output["asset_id"], "width": width, "height": height}


def make_gt_vectors(local, store, output_dir):
    input_dir = ROOT / "model-package-2026-11-13" / "inputs" / "electronic"
    samples = []
    for name in SAMPLE_NAMES:
        source_path = input_dir / name
        if not source_path.is_file():
            raise FileNotFoundError(f"Expected local model QA sample is absent: {source_path}")
        with Image.open(source_path) as opened:
            rgb = np.asarray(opened.convert("RGB"), dtype=np.uint8)
        # This is only the fixture bridge from a white-paper GT to the existing
        # alpha-mask vectorizer. Darkness becomes coverage; vector quality is not
        # inferred from this synthetic binary/antialiased input conversion.
        alpha = 255 - rgb.min(axis=2)
        rgba = np.zeros((*alpha.shape, 4), dtype=np.uint8)
        rgba[:, :, 3] = alpha
        image = Image.fromarray(rgba, "RGBA")
        stem = Path(name).stem.removesuffix("-gt")
        png_data = png_bytes(image)
        record = upload(local, image, f"{stem}-alpha-fixture.png", f"local GT alpha bridge: {stem}",
                        license_name="未确认")
        source = record["original"]
        result = vectorize(image, VectorOptions(mode="monochrome", detail="high"))
        output = publish_svg(
            store, source, result.svg, job_name=f"gt-alpha-{stem}",
            parameters={"method": "white-paper-to-alpha-then-existing-vectorizer", **result.metadata},
        )
        (output_dir / f"{stem}-gt-alpha.png").write_bytes(png_data)
        (output_dir / f"{stem}-gt-alpha.svg").write_text(result.svg, encoding="utf-8")
        samples.append({"name": stem, "image_id": record["image_id"],
                        "source_asset_id": source["asset_id"], "svg_asset_id": output["asset_id"],
                        "width": image.width, "height": image.height,
                        "foreground_pixels": int(np.count_nonzero(alpha))})
    return samples


def main():
    temp_root = Path(sys.argv[1]).resolve()
    output_dir = ROOT / "storage" / "validation" / "system-improvements-20261116"
    output_dir.mkdir(parents=True, exist_ok=True)
    settings = Settings(
        api_token=SecretStr(""), ark_api_key=SecretStr(""),
        storage_root=temp_root / "storage" / "api",
        paid_calls_enabled=False, pricing_confirmed=False,
    )
    store = WorkbenchStore(settings.storage_root)
    local = LocalWorkbench(store)
    synthetic = make_synthetic_fixture(local, store, output_dir)
    vectors = make_gt_vectors(local, store, output_dir)

    def forbid_provider(request):
        raise AssertionError(f"Offline browser fixture attempted provider traffic: {request.url.host}")

    # Using an ephemeral port avoids occupying or touching the user's running
    # service. The provider transport is configured with no credentials above.
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    info = {"url": url, **synthetic, "raster_roundtrip_samples": vectors,
            "provider_call_count": 0, "fixture": "offline-system-svg-editing"}
    print("FIXTURE " + json.dumps(info), flush=True)
    server = uvicorn.Server(
        uvicorn.Config(create_app(settings, transport=httpx.MockTransport(forbid_provider)),
                       host="127.0.0.1", log_level="error",
                       access_log=False, ws="none"),
    )
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
