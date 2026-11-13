from io import BytesIO
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app
from app.providers.seedream import MAX_OUTPUT_PIXELS, MIN_OUTPUT_PIXELS, edit_output_size


def checkerboard(width=700, height=500, block=32) -> bytes:
    image = Image.new("RGB", (width, height), "#f4f0e6")
    draw = ImageDraw.Draw(image)
    for y in range(0, height, block):
        for x in range(0, width, block):
            if (x // block + y // block) % 2 == 0:
                draw.rectangle([x, y, x + block - 1, y + block - 1], fill="#182632")
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def client_for(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""),
                        storage_root=tmp_path / "api")
    return TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                      client=("127.0.0.1", 50000))


def headers(key):
    return {"X-Pattern-Studio": "local", "Idempotency-Key": key}


def upload(client, key, data=None, fields=None):
    payload = {"source_note": "pytest upload"}
    payload.update(fields or {})
    return client.post("/api/v1/images", files={"file": ("sample.png", data or checkerboard(), "image/png")},
                       data=payload, headers=headers(key))


def test_health_reports_versions(tmp_path):
    with client_for(tmp_path) as client:
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        body = response.json()
        assert body["versions"]["manifest"] == "local-s1-v2"
        assert body["versions"]["grade"] == "p0-v1"


def test_upload_returns_meta_and_provenance(tmp_path):
    with client_for(tmp_path) as client:
        response = upload(client, "p0_" + "a" * 16, fields={
            "source_type": "museum_photo", "source_name": "馆藏 1",
            "source_url": "https://example.org/1", "license": "CC-BY-4.0",
            "collected_at": "2026-10-24", "batch_id": "batch-1",
        })
        assert response.status_code == 201, response.text
        body = response.json()
        meta = body["meta"]
        assert len(meta["content_id"]) == 16
        assert meta["grade"] in {"A", "B", "C"}
        assert meta["split"] in {"train", "val", "test"}
        assert meta["license"] == "CC-BY-4.0"
        assert meta["provenance_status"] == "declared"
        assert body["duplicates"] == []
        assert body["original"]["grade"] == meta["grade"]
        assert body["normalized"]["content_id"] == meta["content_id"]
        assert body["normalized"]["algorithm_version"] == "normalize-image-v1"

        fetched = client.get("/api/v1/images/" + body["image_id"])
        assert fetched.status_code == 200
        assert fetched.json()["meta"]["content_id"] == meta["content_id"]


def test_exact_duplicate_is_reported_but_not_merged(tmp_path):
    with client_for(tmp_path) as client:
        first = upload(client, "p0_" + "b" * 16)
        second = upload(client, "p0_" + "c" * 16)
        assert first.status_code == 201
        assert second.status_code == 201
        body = second.json()
        assert body["image_id"] != first.json()["image_id"]
        duplicates = body["duplicates"]
        assert duplicates
        assert duplicates[0]["image_id"] == first.json()["image_id"]
        assert duplicates[0]["status"] == "confirmed"
        assert duplicates[0]["ncc"] > 0.98


def test_export_requires_license_acknowledgement(tmp_path):
    with client_for(tmp_path) as client:
        body = upload(client, "p0_" + "d" * 16).json()
        asset_id = body["normalized"]["asset_id"]
        denied = client.post("/api/v1/exports", json={"asset_ids": [asset_id]},
                            headers=headers("p0_" + "e" * 16))
        assert denied.status_code == 409
        assert denied.json()["error"]["code"] == "LICENSE_REVIEW_REQUIRED"

        allowed = client.post("/api/v1/exports",
                             json={"asset_ids": [asset_id], "license_acknowledged": True},
                             headers=headers("p0_" + "f" * 16))
        assert allowed.status_code == 202, allowed.text
        job_id = allowed.json()["job_id"]
        for _ in range(50):
            job = client.get("/api/v1/jobs/" + job_id).json()
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.1)
        assert job["state"] == "succeeded", job
        zip_asset = next(asset for asset in job["result"]["assets"] if asset["kind"] == "zip")
        assert zip_asset["manifest_schema_version"] == "local-s1-v2"
        assert zip_asset["license_acknowledged"] is True


def test_invalid_provenance_is_rejected_without_echo(tmp_path):
    with client_for(tmp_path) as client:
        response = upload(client, "p0_" + "g" * 16, fields={"source_url": "javascript:alert(1)"})
        assert response.status_code == 422
        text = response.text
        assert response.json()["error"]["code"] == "INVALID_PROVENANCE"
        assert "javascript" not in text


def test_edit_output_size_matches_input_when_provider_allows():
    assert edit_output_size((1024, 1024)) == "1024x1024"
    assert edit_output_size((1600, 1200)) == "1600x1200"


def test_edit_output_size_stays_inside_provider_bounds():
    for input_size in [(973, 730), (512, 512), (128, 128), (1439, 2460)]:
        width, height = map(int, edit_output_size(input_size).split("x"))
        assert MIN_OUTPUT_PIXELS <= width * height <= MAX_OUTPUT_PIXELS
        assert abs(width / height - input_size[0] / input_size[1]) / (input_size[0] / input_size[1]) < 0.01


def test_upload_without_new_fields_stays_compatible(tmp_path):
    with client_for(tmp_path) as client:
        response = client.post("/api/v1/images",
                               files={"file": ("sample.png", checkerboard(), "image/png")},
                               data={"source_note": "legacy client"},
                               headers=headers("p0_" + "h" * 16))
        assert response.status_code == 201
        meta = response.json()["meta"]
        assert meta["source_type"] == "未确认"
        assert meta["license"] == "未确认"
        assert meta["provenance_status"] == "unverified"
