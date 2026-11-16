"""Opt-in GPU smoke check: synthetic input, isolated storage, no cloud calls."""

import argparse
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app
from app.services.local_repair import model_capability
from app.storage import png_bytes
from app.workbench_store import WorkbenchStore
from app.worker import LocalWorker, calls_provider


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    capability = model_capability()
    assert capability["available"], capability
    reference = Image.new("RGB", (512, 512), "ivory")
    draw = ImageDraw.Draw(reference)
    for x in range(32, 512, 64):
        for y in range(32, 512, 64):
            draw.ellipse((x - 22, y - 22, x + 22, y + 22), outline="darkred", width=5)
            draw.line((x - 15, y, x + 15, y), fill="darkred", width=3)
    target = reference.copy()
    box = {"left": 224, "top": 224, "right": 288, "bottom": 288}
    ImageDraw.Draw(target).rectangle((224, 224, 287, 287), fill="ivory")
    target.save(args.output / "target.png")
    reference.save(args.output / "reference.png")
    started = time.monotonic()
    report = {"capability": capability, "sample": "synthetic tiled circles, not a quality benchmark",
              "model_or_algorithm_changed": False}
    with TemporaryDirectory(prefix="pattern-studio-repair-smoke-") as temporary:
        settings = Settings(storage_root=Path(temporary), api_token=SecretStr(""),
                            ark_api_key=SecretStr(""), paid_calls_enabled=False)
        # Only disable the background coordinator; execute the genuine bounded worker below.
        with patch.object(LocalWorker, "start"), patch.object(LocalWorker, "stop"):
            with TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                            client=("127.0.0.1", 12345)) as client:
                store = WorkbenchStore(settings.storage_root)

                def post(path, **kwargs):
                    response = client.post("/api/v1" + path, headers={
                        "X-Pattern-Studio": "local", "Idempotency-Key": uuid4().hex}, **kwargs)
                    assert response.is_success, response.text
                    return response.json()

                def upload(image):
                    return post("/images", files={"file": ("synthetic.png", png_bytes(image),
                                                            "image/png")})["normalized"]["asset_id"]

                target_id, reference_id = upload(target), upload(reference)
                job = post("/jobs/repair", json={"method": "leftrefill", "input_asset_id": target_id,
                           "reference_asset_id": reference_id, "bbox": box, "seed": 23407})
                assert not calls_provider(job)
                claimed, token = store.claim()
                print("Running genuine bounded LeftRefill worker (180s limit)", flush=True)
                LocalWorker(store, provider_settings=None)._run(claimed, token)
                completed = store.get_job(job["job_id"])
                report.update(elapsed_seconds=round(time.monotonic() - started, 2),
                              job_state=completed["state"], error=completed.get("error"))
                (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
                assert completed["state"] == "succeeded", report
                repair = client.get(f"/api/v1/repairs/{job['job_id']}").json()
                assert repair["state"] == "waiting_user", repair
                outside = np.ones((512, 512), dtype=bool)
                outside[224:288, 224:288] = False
                original = np.asarray(target.convert("RGBA"))
                for key in ("candidate_asset", "composited_asset"):
                    metadata = repair[key]
                    _, data = store.read_asset(metadata["asset_id"])
                    pixels = np.asarray(Image.open(BytesIO(data)).convert("RGBA"))
                    np.testing.assert_array_equal(pixels[outside], original[outside])
                    assert metadata["ai_inferred"] and not metadata["geometry_verified"]
                    assert metadata["reference_asset_id"] == reference_id
                    (args.output / f"{key}.png").write_bytes(data)
                inside_changed = int(np.count_nonzero(np.any(pixels[~outside] != original[~outside], axis=1)))
                assert inside_changed > 0, "The repair did not change any masked pixels"
                accepted = post(f"/repairs/{job['job_id']}/decision", json={"revision": 1,
                    "action": "accept", "selected_asset_id": repair["composited_asset"]["asset_id"]})
                assert accepted["state"] == "accepted"
                budget = client.get("/api/v1/seedream/status").json()["budget"]
                assert budget["call_count"] == 0, budget
                report.update(review_before_accept="waiting_user", decision="accepted",
                              outside_changed_pixels=0, inside_changed_pixels=inside_changed,
                              cloud_call_count=0, metrics=repair["metrics"])
    (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
