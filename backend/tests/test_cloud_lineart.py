"""Offline cloud-lineart admission, provenance and no-retry contracts."""

import base64
from dataclasses import replace
import json
from io import BytesIO
from uuid import uuid4
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr
import pytest

from app.config import Settings
from app.main import create_app
from app.providers.prompts import LINEART_PROMPT_VERSION
from app.services.cloud_lineart import execute_cloud_lineart
from app.services.finishing_workbench import execute_repair
from app.services.local_workbench import execute_local
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore
from app.worker import LocalWorker


@pytest.fixture
def studio(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr("fixture-cloud-key"),
                        storage_root=tmp_path / "storage" / "api", paid_calls_enabled=True, pricing_confirmed=True)
    calls = []
    def provider(request):
        payload = json.loads(request.content)
        calls.append(payload)
        image = Image.new("RGB", (960, 960), "white")
        ImageDraw.Draw(image).ellipse((150, 150, 800, 800), outline="black", width=8)
        ImageDraw.Draw(image).rectangle((440, 440, 480, 480), fill="black")
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png_bytes(image)).decode(),
                                                 "size": "960x960", "output_format": "png"}]})
    transport = httpx.MockTransport(provider)
    with patch.object(LocalWorker, "start"), patch.object(LocalWorker, "stop"):
        with TestClient(create_app(settings), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 12345)) as client:
            def post(path, **kwargs):
                headers = {"X-Pattern-Studio": "local", "Idempotency-Key": uuid4().hex, **kwargs.pop("headers", {})}
                return client.post("/api/v1" + path, headers=headers, **kwargs)
            uploaded = post("/images", files={"file": ("pattern.png", png_bytes(Image.new("RGB", (600, 600), "white")), "image/png")})
            assert uploaded.status_code == 201
            yield settings, WorkbenchStore(settings.storage_root), client, post, uploaded.json(), calls, transport


def test_cloud_lineart_snapshot_idempotency_and_vectorization(studio):
    settings, store, client, post, image, calls, transport = studio
    input_id = image["normalized"]["asset_id"]
    key = uuid4().hex
    payload = dict(input_asset_id=input_id, consent_to_upload=True, consent_to_charge=True)
    submitted = post("/jobs/cloud-lineart", json=payload, headers={"Idempotency-Key": key})
    assert submitted.status_code == 202, submitted.text
    job = submitted.json()
    assert not calls  # admission never makes a provider request
    assert "fixture-cloud-key" not in submitted.text
    assert post("/jobs/cloud-lineart", json=payload, headers={"Idempotency-Key": key}).json()["job_id"] == job["job_id"]
    assert post("/jobs/" + job["job_id"] + "/cancel").status_code == 409
    claimed, token = store.claim()
    # Queued work retains the selected model even after subsequent settings changes.
    execute_cloud_lineart(store, claimed, token, replace(settings, model="ep-new-model"), transport=transport)
    store.finish_job(job["job_id"], token)
    done = store.get_job(job["job_id"])
    assert done["state"] == "succeeded"
    assert len(calls) == 1
    assert calls[0]["model"] == settings.model
    assert calls[0]["layer_decomposition"] is False
    assert calls[0]["size"] == "960x960"
    asset = done["result"]["assets"][0]
    assert asset["kind"] == "lineart" and asset["method"] == "cloud"
    assert asset["source_asset_id"] == input_id
    assert asset["prompt_version"] == LINEART_PROMPT_VERSION
    assert asset["ai_inferred"] and asset["needs_user_review"] and not asset["geometry_verified"]
    assert asset["geometry_transform"]["to"] == [600, 600]
    assert done["result"]["provider_call_id"] == asset["provider_call_id"]
    _, pixels = store.read_asset(asset["asset_id"])
    with Image.open(BytesIO(pixels)) as ink:
        assert ink.getpixel((0, 0))[3] == 0
        assert ink.getchannel("A").getextrema() == (0, 255)
    assert asset["parameters"]["background"] == "transparent"
    assert post("/jobs/cloud-lineart", json=payload, headers={"Idempotency-Key": key}).json()["job_id"] == job["job_id"]
    vector = post("/jobs/vectorize", json={"input_asset_id": asset["asset_id"], "mode": "monochrome", "detail": "low"})
    assert vector.status_code == 202, vector.text
    local_job, local_token = store.claim()
    execute_local(store, local_job["job_id"], local_token)
    store.finish_job(local_job["job_id"], local_token)
    svg = store.get_job(local_job["job_id"])["result"]["assets"][0]
    assert svg["kind"] == "svg" and svg["source_asset_id"] == asset["asset_id"]
    # The ring and its disconnected interior detail must not collapse to one
    # full-canvas black rectangle.
    assert svg["parameters"]["path_count"] > 1
    assert len(calls) == 1


def test_cloud_lineart_consent_inputs_and_disabled_gate(studio):
    settings, store, client, post, image, calls, transport = studio
    input_id = image["normalized"]["asset_id"]
    for changes in ({"consent_to_charge": False}, {"consent_to_upload": False}, {"consent_to_charge": "true"}):
        result = post("/jobs/cloud-lineart", json=dict(input_asset_id=input_id, consent_to_upload=True, consent_to_charge=True) | changes)
        assert result.status_code == 422
    invalid = post("/jobs/cloud-lineart", json=dict(input_asset_id=image["original"]["asset_id"], consent_to_upload=True, consent_to_charge=True))
    assert invalid.status_code == 422
    public = client.get("/api/v1/settings").json()
    saved = client.put("/api/v1/settings", headers={"X-Pattern-Studio": "local"}, json={"revision": public["revision"], "paid_calls_enabled": False})
    assert saved.status_code == 200
    result = post("/jobs/cloud-lineart", json=dict(input_asset_id=input_id, consent_to_upload=True, consent_to_charge=True))
    assert result.status_code == 503
    assert not calls
    # Local lineart still works without an enabled cloud provider.
    assert post("/jobs/lineart", json={"input_asset_id": input_id, "method": "opencv"}).status_code == 202


def test_cloud_lineart_unknown_result_never_retries(studio):
    settings, store, client, post, image, calls, transport = studio
    submitted = post("/jobs/cloud-lineart", json=dict(input_asset_id=image["normalized"]["asset_id"], consent_to_upload=True, consent_to_charge=True))
    job, token = store.claim()
    def timeout(request):
        calls.append("timeout")
        raise httpx.ReadTimeout("fixture", request=request)
    with pytest.raises(ServiceError) as error:
        execute_cloud_lineart(store, job, token, settings, transport=httpx.MockTransport(timeout))
    store.finish_job(job["job_id"], token, {"code": error.value.code, "message": str(error.value)})
    assert len(calls) == 1
    call = store.get_call(store.get_job(job["job_id"])["result"]["provider_call_id"])
    assert call["state"] == "outcome_unknown" and call["result"]["automatic_retry"] is False
    retry = post("/jobs/" + job["job_id"] + "/retry")
    assert retry.status_code == 409 and retry.json()["error"]["code"] == "PAID_RETRY_REQUIRES_NEW_CONSENT"
    assert len(calls) == 1


def test_crop_can_be_repaired_then_used_for_cloud_lineart(studio):
    settings, store, client, post, image, calls, transport = studio
    crop = post("/jobs/crop", json={"input_asset_id": image["normalized"]["asset_id"], "bbox": {"left": 0, "top": 0, "right": 512, "bottom": 512}})
    assert crop.status_code == 202
    job, token = store.claim()
    execute_local(store, job["job_id"], token)
    store.finish_job(job["job_id"], token)
    asset = store.get_job(job["job_id"])["result"]["assets"][0]
    repair = post("/jobs/repair", json=dict(input_asset_id=asset["asset_id"], bbox={"left": 100, "top": 100, "right": 160, "bottom": 160}, consent_to_upload=True, consent_to_charge=True))
    assert repair.status_code == 202, repair.text
    job, token = store.claim()
    execute_repair(store, job, token, settings, transport=transport)
    store.finish_job(job["job_id"], token)
    info = client.get("/api/v1/repairs/" + job["job_id"]).json()
    accepted = post("/repairs/" + job["job_id"] + "/decision", json={"revision": 1, "action": "accept", "selected_asset_id": info["composited_asset"]["asset_id"]})
    assert accepted.status_code == 200, accepted.text
    accepted_id = accepted.json()["decision"]["accepted_asset_id"]
    submitted = post("/jobs/cloud-lineart", json=dict(input_asset_id=accepted_id, consent_to_upload=True, consent_to_charge=True))
    assert submitted.status_code == 202, submitted.text
    cloud, cloud_token = store.claim()
    execute_cloud_lineart(store, cloud, cloud_token, settings, transport=transport)
    store.finish_job(cloud["job_id"], cloud_token)
    output = store.get_job(cloud["job_id"])["result"]["assets"][0]
    assert output["source_asset_id"] == accepted_id
    assert len(calls) == 2


def test_cloud_lineart_alpha_preserves_antialiasing_and_existing_transparency():
    from app.services.lineart import normalize_cloud_lineart
    image = Image.new("RGBA", (4, 1))
    image.putdata([(255, 255, 255, 255), (0, 0, 0, 255), (128, 128, 128, 255), (0, 0, 0, 0)])
    result = normalize_cloud_lineart(image)
    assert [result.image.getpixel((x, 0))[3] for x in range(4)] == [0, 255, 127, 0]
