"""Admission remains specific to the measured processing route."""
import time
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr, ValidationError
import pytest

from app.config import Settings
from app.main import create_app
from app.schemas.batch_workbench import BatchCreate, PresetCreate
from app.schemas.workbench import ExtractRequest, LineartRequest, WorkingCopyRequest
from app.services.batch_workbench import BatchWorkbench
from app.services.local_workbench import LocalWorkbench
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore


def pattern():
    image = Image.new("RGBA", (2000, 2000), "white")
    draw = ImageDraw.Draw(image)
    for offset in range(100, 1900, 100):
        draw.ellipse((offset, 100, offset + 45, 1800), outline="black", width=8)
    return png_bytes(image)


def test_larger_model_and_otsu_inputs_do_not_lift_other_algorithms(tmp_path):
    local = LocalWorkbench(WorkbenchStore(tmp_path))
    record, _, _ = local.upload(pattern(), "four-mp.png", "", uuid4().hex)
    source = record["normalized"]["asset_id"]
    model = local.submit("lineart", LineartRequest(input_asset_id=source, method="model"), uuid4().hex)
    assert model["state"] == "queued"
    otsu = local.submit("extract", ExtractRequest(input_asset_id=source, mode="otsu"), uuid4().hex)
    assert otsu["state"] == "queued"
    with pytest.raises(ServiceError) as error:
        local.submit("lineart", LineartRequest(input_asset_id=source, method="opencv"), uuid4().hex)
    assert error.value.code == "WORKING_COPY_REQUIRED"
    with pytest.raises(ServiceError):
        local.submit("extract", ExtractRequest(input_asset_id=source, mode="manual"), uuid4().hex)
    WorkingCopyRequest(input_asset_id=source, max_pixels=25_000_000)
    with pytest.raises(ValidationError):
        WorkingCopyRequest(input_asset_id=source, max_pixels=25_000_001)


def test_png_only_batch_keeps_large_model_input_and_records_explicit_copy_limit(tmp_path):
    local = LocalWorkbench(WorkbenchStore(tmp_path))
    record, _, _ = local.upload(pattern(), "four-mp.png", "", uuid4().hex)
    batches = BatchWorkbench(local.store, local)
    preset = batches.create_preset(PresetCreate(name="仅线稿 PNG", options={"recipe": "model_lineart",
                                   "vectorize": False, "tile": False, "working_max_pixels": 10_000_000}))
    result = batches.create_batch(BatchCreate(preset_id=preset["preset_id"],
                                  input_asset_ids=[record["normalized"]["asset_id"]]), uuid4().hex)
    item = result["items"][0]
    assert item["steps"][0]["skipped"] is True
    assert item["steps"][0]["effective_max_pixels"] == 10_000_000
    job = local.store.get_job(item["job_id"])
    assert job["input_asset_id"] == record["normalized"]["asset_id"]
    assert job["parameters"] == {"method": "model"}


def test_real_worker_publishes_four_mp_otsu_outputs(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""),
                        storage_root=tmp_path / "api", paid_calls_enabled=False)
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                    client=("127.0.0.1", 12345)) as client:
        def post(path, **kwargs):
            return client.post("/api/v1" + path, headers={"X-Pattern-Studio": "local",
                               "Idempotency-Key": uuid4().hex}, **kwargs)
        uploaded = post("/images", files={"file": ("four-mp.png", pattern(), "image/png")})
        assert uploaded.status_code == 201, uploaded.text
        response = post("/jobs/extract", json={"input_asset_id": uploaded.json()["normalized"]["asset_id"], "mode": "otsu"})
        assert response.status_code == 202, response.text
        job_id = response.json()["job_id"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = client.get(f"/api/v1/jobs/{job_id}").json()
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.1)
        assert job["state"] == "succeeded", job
        output = next(asset for asset in job["result"]["assets"] if asset["kind"] == "transparent_png")
        assert (output["width"], output["height"]) == (2000, 2000)
        health = client.get("/api/v1/health").json()
        assert health["limits"]["model_lineart_pixels"] == 25_000_000
        assert health["limits"]["threshold_pixels"] == 4_000_000
        assert health["limits"]["working_pixels"] == 1_000_000
