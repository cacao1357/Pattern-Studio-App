"""Real local worker smoke across the batch, library and export HTTP boundaries."""

from io import BytesIO
import json
import time
from uuid import uuid4
import zipfile

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app
from app.storage import png_bytes


def test_batch_rejects_unaccepted_repair_candidate(tmp_path):
    import pytest
    from app.schemas.batch_workbench import BatchCreate, PresetCreate
    from app.services.batch_workbench import BatchWorkbench
    from app.services.local_workbench import LocalWorkbench
    from app.storage import ServiceError
    from app.workbench_store import WorkbenchStore

    store = WorkbenchStore(tmp_path)
    local = LocalWorkbench(store)
    record, _, _ = local.upload(png_bytes(Image.new("RGBA", (32, 32), "white")), "pattern.png", "", uuid4().hex)
    staged = store._stage([{"data": png_bytes(Image.new("RGBA", (32, 32), "white")), "suffix": ".png",
                           "metadata": {"kind": "edit_candidate", "image_id": record["image_id"],
                                        "width": 32, "height": 32, "parents": [{
                                            "asset_id": record["normalized"]["asset_id"], "role": "repair_input"}]}}])
    with store.connection() as db:
        store._register(db, staged)
    batches = BatchWorkbench(store, local)
    preset = batches.create_preset(PresetCreate(name="test", options={"recipe": "color"}))
    with pytest.raises(ServiceError) as error:
        batches.create_batch(BatchCreate(preset_id=preset["preset_id"],
                                         input_asset_ids=[staged[0][0]["asset_id"]]), uuid4().hex)
    assert error.value.code == "BATCH_INPUT_KIND"


def test_batch_local_worker_groups_and_exports_without_cloud(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""),
                        storage_root=tmp_path / "api", paid_calls_enabled=False)
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                    client=("127.0.0.1", 12345)) as client:
        def post(path, **kwargs):
            return client.post("/api/v1" + path, headers={"X-Pattern-Studio": "local",
                               "Idempotency-Key": uuid4().hex}, **kwargs)

        def wait_job(job_id):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                job = client.get(f"/api/v1/jobs/{job_id}").json()
                if job["state"] in {"succeeded", "failed", "cancelled"}:
                    assert job["state"] == "succeeded", job
                    return job
                time.sleep(0.1)
            raise AssertionError("Local worker did not complete its small smoke job")

        uploaded = []
        for index in range(2):
            image = Image.new("RGB", (64, 64), "white")
            ImageDraw.Draw(image).ellipse((8 + index, 8, 55, 55), outline="black", width=4)
            response = post("/images", files={"file": (f"pattern-{index}.png", png_bytes(image), "image/png")})
            assert response.status_code == 201, response.text
            uploaded.append(response.json())
        preset = post("/workflow-presets", json={"name": "离线验收", "options": {
            "recipe": "color", "vector": {"mode": "monochrome"}, "tile": True}})
        assert preset.status_code == 201, preset.text
        batch = post("/processing-batches", json={"preset_id": preset.json()["preset_id"],
                     "input_asset_ids": [item["normalized"]["asset_id"] for item in uploaded]})
        assert batch.status_code == 202, batch.text
        batch_id = batch.json()["batch_id"]
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = client.get(f"/api/v1/processing-batches/{batch_id}").json()
            if result["state"] != "running":
                break
            time.sleep(0.1)
        assert result["state"] == "succeeded", result
        assert result["progress"]["completed"] == 2
        patterns = client.get("/api/v1/patterns").json()["items"]
        assert len(patterns) == 2
        for group in patterns:
            assert {"original", "normalized_input", "transparent_png", "svg", "tile_preview"} <= {
                asset["kind"] for asset in group["assets"]}
        category = post("/pattern-categories", json={"name": "验收纹样"}).json()
        for group in patterns:
            response = client.put(f"/api/v1/patterns/{group['image_id']}/categories",
                                  headers={"X-Pattern-Studio": "local"}, json={
                                      "category_ids": [category["category_id"]], "revision": group["revision"]})
            assert response.status_code == 200, response.text
        selected = [asset["asset_id"] for group in patterns for asset in group["assets"]
                    if asset["kind"] in {"original", "svg"}]
        export = post("/exports", json={"asset_ids": selected, "layout": "by_image", "license_acknowledged": True})
        assert export.status_code == 202, export.text
        job = wait_job(export.json()["job_id"])
        archive_id = job["result"]["assets"][0]["asset_id"]
        response = client.get(f"/api/v1/assets/{archive_id}/download")
        assert response.status_code == 200
        with zipfile.ZipFile(BytesIO(response.content)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            assert len(manifest["selected_assets"]) == 4
            assert {name.split("/")[1] for name in archive.namelist() if name.startswith("images/")} == {
                item["image_id"] for item in uploaded}
        assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0
