import csv
import io
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app


def checkerboard(width=700, height=500, block=32):
    image = Image.new("RGB", (width, height), "#f4f0e6")
    draw = ImageDraw.Draw(image)
    for y in range(0, height, block):
        for x in range(0, width, block):
            if (x // block + y // block) % 2 == 0:
                draw.rectangle([x, y, x + block - 1, y + block - 1], fill="#182632")
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def client_for(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""),
                        storage_root=tmp_path / "api")
    return TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                      client=("127.0.0.1", 50000))


def upload(client, key, fields=None):
    payload = {"source_note": "p1 dataset test"}
    payload.update(fields or {})
    return client.post("/api/v1/images",
                       files={"file": ("sample.png", checkerboard(), "image/png")},
                       data=payload,
                       headers={"X-Pattern-Studio": "local", "Idempotency-Key": key})


def test_dataset_manifest_and_audit(tmp_path):
    with client_for(tmp_path) as client:
        first = upload(client, "p1_" + "a" * 16, {
            "source_type": "museum_photo", "license": "CC-BY-4.0", "batch_id": "batch-p1",
        })
        second = upload(client, "p1_" + "b" * 16, {"source_note": "unconfirmed"})
        assert first.status_code == 201
        assert second.status_code == 201

        manifest = client.get("/api/v1/datasets/manifest.csv")
        assert manifest.status_code == 200
        assert manifest.text.startswith("\ufeff")
        rows = list(csv.DictReader(io.StringIO(manifest.text.lstrip("\ufeff"))))
        assert len(rows) == 2
        assert set(rows[0]) >= {"image_id", "content_id", "grade", "split", "license", "width", "height", "label_status"}
        assert rows[0]["label_status"] == "not_reviewed"
        assert {row["license"] for row in rows} == {"CC-BY-4.0", "未确认"}

        audit = client.get("/api/v1/datasets/audit")
        assert audit.status_code == 200
        body = audit.json()
        assert body["total_images"] == 2
        assert body["license_confirmed"] == 1
        assert body["license_unconfirmed"] == 1
        assert body["missing_meta"] == 0
        assert body["versions"]["manifest"] == "local-s1-v2"
        assert body["label_status"] == {"not_reviewed": 2}
        assert body["batches"] == ["batch-p1"]


def test_lineart_job_publishes_a_lineart_asset(tmp_path):
    with client_for(tmp_path) as client:
        uploaded = upload(client, "p1_" + "c" * 16).json()
        asset_id = uploaded["normalized"]["asset_id"]
        response = client.post("/api/v1/jobs/lineart",
                               json={"input_asset_id": asset_id, "local": True},
                               headers={"X-Pattern-Studio": "local", "Idempotency-Key": "p1_" + "d" * 16})
        assert response.status_code == 202, response.text
        job_id = response.json()["job_id"]
        replay = client.post("/api/v1/jobs/lineart",
                             json={"input_asset_id": asset_id, "local": True, "method": "opencv"},
                             headers={"X-Pattern-Studio": "local", "Idempotency-Key": "p1_" + "d" * 16})
        assert replay.status_code == 202, replay.text
        assert replay.json()["job_id"] == job_id
        job = None
        for _ in range(80):
            job = client.get("/api/v1/jobs/" + job_id).json()
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.1)
        assert job["state"] == "succeeded", job
        lineart = next(asset for asset in job["result"]["assets"] if asset["kind"] == "lineart")
        assert lineart["algorithm_version"] == "lineart-global-local-v2"
        assert lineart["parameters"]["algorithm"] == "lineart-global-local-v2"
        assert lineart["width"] == 700 and lineart["height"] == 500
        assert lineart["content_id"] == uploaded["meta"]["content_id"]
