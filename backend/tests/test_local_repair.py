"""Offline integration for local repair; generation is replaced, no cloud or GPU calls."""

import builtins
from io import BytesIO
import json
from uuid import uuid4
from unittest.mock import patch

import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
from pydantic import SecretStr
import pytest

from app.config import Settings
from app.main import create_app
from app.services import local_repair
from app.services.local_workbench import execute_local
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore
from app.worker import LocalWorker, calls_provider


@pytest.fixture
def studio(tmp_path, monkeypatch):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""),
                        storage_root=tmp_path / "api", paid_calls_enabled=False)
    monkeypatch.setattr(local_repair, "require_model", lambda: None)
    with patch.object(LocalWorker, "start"), patch.object(LocalWorker, "stop"):
        with TestClient(create_app(settings), base_url="http://127.0.0.1:8765",
                        client=("127.0.0.1", 12345)) as client:
            def post(path, **kwargs):
                headers = {"X-Pattern-Studio": "local", "Idempotency-Key": uuid4().hex, **kwargs.pop("headers", {})}
                return client.post("/api/v1" + path, headers=headers, **kwargs)
            def upload(size=(512, 512), color="white"):
                response = post("/images", files={"file": ("pattern.png", png_bytes(Image.new("RGB", size, color)), "image/png")})
                assert response.status_code == 201, response.text
                return response.json()["normalized"]["asset_id"]
            target, reference = upload(), upload((128, 128), "blue")
            payload = {"method": "leftrefill", "input_asset_id": target, "reference_asset_id": reference,
                       "bbox": {"left": 100, "top": 100, "right": 200, "bottom": 200}}
            yield WorkbenchStore(settings.storage_root), client, post, upload, payload


def test_local_job_is_idempotent_cancelable_and_never_provider_task(studio):
    store, client, post, _, payload = studio
    key = uuid4().hex
    response = post("/jobs/repair", json=payload, headers={"Idempotency-Key": key})
    assert response.status_code == 202, response.text
    job = response.json()
    assert not calls_provider(job)
    assert calls_provider({"kind": "repair", "parameters": {}})  # old cloud records remain cloud
    assert post("/jobs/repair", json=payload, headers={"Idempotency-Key": key}).json()["job_id"] == job["job_id"]
    assert post(f"/jobs/{job['job_id']}/cancel").json()["state"] == "cancelled"
    assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0


@pytest.mark.parametrize("change", [
    {"reference_asset_id": None}, {"consent_to_charge": True}, {"consent_to_upload": True},
    {"provider_call_id": str(uuid4())}, {"seed": True}, {"seed": -1},
])
def test_local_request_rejects_invalid_or_cloud_fields(studio, change):
    _, _, post, _, payload = studio
    assert post("/jobs/repair", json={**payload, **change}).status_code == 422


def test_cloud_default_still_requires_explicit_consents(studio):
    _, _, post, _, payload = studio
    payload.pop("method")
    payload.pop("reference_asset_id")
    assert post("/jobs/repair", json=payload).status_code == 422


def test_size_and_reference_admission_precede_model_execution(studio):
    _, _, post, upload, payload = studio
    response = post("/jobs/repair", json={**payload, "input_asset_id": upload((600, 600))})
    assert response.status_code == 422 and response.json()["error"]["code"] == "LEFTREFILL_INPUT_SIZE"
    response = post("/jobs/repair", json={**payload, "reference_asset_id": upload((1200, 1200))})
    assert response.status_code == 422 and response.json()["error"]["code"] == "LEFTREFILL_REFERENCE_INVALID"


def test_missing_prerequisites_fail_without_cloud_fallback(studio, monkeypatch):
    _, client, post, _, payload = studio
    def unavailable():
        raise ServiceError("LEFTREFILL_MODEL_UNAVAILABLE", "Missing offline base", 503)
    monkeypatch.setattr(local_repair, "require_model", unavailable)
    response = post("/jobs/repair", json=payload)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "LEFTREFILL_MODEL_UNAVAILABLE"
    assert client.get("/api/v1/jobs").json()["items"] == []
    assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0


@pytest.mark.parametrize("selected_kind", ["composited_asset", "candidate_asset"])
def test_generation_protects_pixels_tracks_reference_and_requires_review(studio, monkeypatch, selected_kind):
    store, client, post, _, payload = studio
    draws = []
    def generate(target, mask, reference, seed):
        draws.append((target.size, reference.size, seed, np.count_nonzero(np.asarray(mask))))
        return Image.new("RGB", (512, 512), "red")  # deliberate changes outside mask must be removed
    monkeypatch.setattr(local_repair, "generate", generate)
    job = post("/jobs/repair", json={**payload, "seed": 42}).json()
    claimed, token = store.claim()
    execute_local(store, claimed["job_id"], token)
    store.finish_job(claimed["job_id"], token)
    repair = client.get(f"/api/v1/repairs/{job['job_id']}").json()
    assert repair["state"] == "waiting_user"
    assert draws == [((512, 512), (128, 128), 42, 10000)]
    composite = repair["composited_asset"]
    assert composite["method"] == "leftrefill" and composite["needs_user_review"]
    assert composite["reference_asset_id"] == payload["reference_asset_id"]
    assert composite["metrics"]["outside_changed_pixels"] == 0
    _, original_bytes = store.read_asset(payload["input_asset_id"])
    original = np.asarray(Image.open(BytesIO(original_bytes)).convert("RGBA"))
    outside = np.ones((512, 512), bool)
    outside[100:200, 100:200] = False
    for asset in (repair["candidate_asset"], composite):
        _, data = store.read_asset(asset["asset_id"])
        pixels = np.asarray(Image.open(BytesIO(data)).convert("RGBA"))
        np.testing.assert_array_equal(pixels[outside], original[outside])
        assert tuple(pixels[150, 150]) == (255, 0, 0, 255)
    accepted = post(f"/repairs/{job['job_id']}/decision", json={"revision": 1, "action": "accept", "selected_asset_id": repair[selected_kind]["asset_id"]})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["state"] == "accepted"
    accepted_id = accepted.json()["decision"]["accepted_asset_id"]
    saved, _ = store.get_asset(accepted_id)
    assert saved["kind"] == "accepted_repair" and not saved["needs_user_review"]
    history = client.get(f"/api/v1/images/{saved['image_id']}/history?collection=assets").json()
    assert any(asset["asset_id"] == accepted_id for asset in history["items"])
    vector = post("/jobs/vectorize", json={"input_asset_id": accepted_id, "mode": "monochrome"})
    assert vector.status_code == 202, vector.text
    vector_job, token = store.claim()
    execute_local(store, vector_job["job_id"], token)
    store.finish_job(vector_job["job_id"], token)
    svg = next(asset for asset in store.get_job(vector_job["job_id"])["result"]["assets"] if asset["kind"] == "svg")
    assert svg["source_asset_id"] == accepted_id
    exported = post("/exports", json={"asset_ids": [accepted_id, svg["asset_id"]], "license_acknowledged": True})
    assert exported.status_code == 202, exported.text
    export_job, token = store.claim()
    execute_local(store, export_job["job_id"], token)
    store.finish_job(export_job["job_id"], token)
    assert store.get_job(export_job["job_id"])["result"]["assets"][0]["kind"] == "zip"
    assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0


def test_failed_local_repair_retries_locally_and_preserves_seed(studio):
    store, _, post, _, payload = studio
    job = post("/jobs/repair", json={**payload, "seed": 77}).json()
    claimed, token = store.claim()
    store.finish_job(claimed["job_id"], token, {"code": "LEFTREFILL_GPU_OOM", "message": "OOM"})
    response = post(f"/jobs/{job['job_id']}/retry")
    assert response.status_code == 202, response.text
    retry = response.json()
    assert retry["retry_of"] == job["job_id"]
    assert retry["parameters"]["seed"] == 77 and not calls_provider(retry)


def test_old_cloud_full_candidate_still_requires_full_image_acknowledgement(studio):
    from app.services.local_workbench import _output
    store, _, post, _, payload = studio
    source, _ = store.get_asset(payload["input_asset_id"])
    # Reproduce an archived pre-method cloud record; deciding it never regenerates.
    job = store.submit("repair", source["asset_id"], {"bbox": payload["bbox"]}, uuid4().hex)
    claimed, token = store.claim()
    candidate = store.publish(job["job_id"], token, "repair-candidate", [
        _output(Image.new("RGB", (512, 512), "red"), "edit_candidate", source, job["job_id"])])[0]
    store.finish_job(job["job_id"], token)
    decision = {"revision": 1, "action": "accept", "selected_asset_id": candidate["asset_id"]}
    response = post(f"/repairs/{job['job_id']}/decision", json=decision)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "FULL_IMAGE_CONSENT_REQUIRED"
    assert post(f"/repairs/{job['job_id']}/decision", json={**decision, "accept_full_image_changes": True}).json()["state"] == "accepted"


@pytest.mark.parametrize("outside", [False, True])
def test_annotated_damage_mask_preserves_holes_and_rejects_outside_damage(studio, monkeypatch, outside):
    store, client, post, _, payload = studio
    source, _ = store.get_asset(payload["input_asset_id"])
    pixels = np.zeros((512, 512), np.uint8)
    pixels[120:125, 120:125] = 255
    if outside:
        pixels[10, 10] = 255
    damage = store.put_asset(png_bytes(Image.fromarray(pixels)), ".png", {
        "kind": "damage_mask", "width": 512, "height": 512,
        "source_asset_id": source["asset_id"], "coordinate_space_id": source["coordinate_space_id"],
        "damage_source": "annotated"})
    payload["damage_mask_asset_id"] = damage["asset_id"]
    monkeypatch.setattr(local_repair, "generate", lambda *args: Image.new("RGB", (512, 512), "red"))
    response = post("/jobs/repair", json=payload)
    if outside:
        assert response.status_code == 422 and response.json()["error"]["code"] == "DAMAGE_OUTSIDE_EDIT"
        return
    assert response.status_code == 202, response.text
    job, token = store.claim()
    execute_local(store, job["job_id"], token)
    store.finish_job(job["job_id"], token)
    repair = client.get(f"/api/v1/repairs/{job['job_id']}").json()
    assert repair["metrics"]["mask_pixels"] == 25
    assert repair["metrics"]["damage_source"] == "annotated"
    _, data = store.read_asset(repair["composited_asset"]["asset_id"])
    actual = np.asarray(Image.open(BytesIO(data)).convert("RGB"))
    assert tuple(actual[122, 122]) == (255, 0, 0)
    assert tuple(actual[150, 150]) == (255, 255, 255)


def test_actual_bounded_worker_fails_locally_without_provider_settings(studio, monkeypatch):
    store, client, post, _, payload = studio
    # Admission uses fixture prerequisites, subprocess independently rechecks its assets.
    monkeypatch.setenv(local_repair.BASE_MODEL_ENV, str(store.root / "missing-base"))
    job = post("/jobs/repair", json=payload).json()
    claimed, token = store.claim()
    LocalWorker(store, timeout_seconds=20, provider_settings=None)._run(claimed, token)
    failed = store.get_job(job["job_id"])
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "LEFTREFILL_MODEL_UNAVAILABLE"
    assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0


def test_capability_reports_missing_base_and_keeps_paths_private(tmp_path, monkeypatch):
    monkeypatch.setenv(local_repair.BASE_MODEL_ENV, str(tmp_path / "private-model-location"))
    result = local_repair.model_capability()
    assert result == {"available": False, "reason": "base_model_missing", "checked": "prerequisites_only"}
    assert "private-model-location" not in json.dumps(result)


def test_capability_does_not_import_ml_or_hash_weights(tmp_path, monkeypatch):
    for name in local_repair.BASE_FILES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * 2048)
    monkeypatch.setenv(local_repair.BASE_MODEL_ENV, str(tmp_path))
    monkeypatch.setattr(local_repair.importlib.util, "find_spec", lambda _: object())
    original_import = builtins.__import__
    def guard(name, *args, **kwargs):
        assert name.split(".")[0] not in {"torch", "diffusers", "transformers", "safetensors", "accelerate"}
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guard)
    assert local_repair.model_capability() == {"available": True, "reason": None, "checked": "prerequisites_only"}


@pytest.mark.parametrize("selected_kind", ["candidate_asset", "composited_asset"])
@pytest.mark.parametrize("nested", [False, True])
def test_accept_crop_restores_full_canvas_and_exports_exact_rgba(studio, monkeypatch, selected_kind, nested):
    from zipfile import ZipFile
    store, client, post, _, payload = studio
    # Nonuniform RGBA (including invisible RGB) detects misplaced patches and alpha blending.
    y, x = np.indices((720, 900))
    pixels = np.stack((x % 256, y % 256, (x + y) % 256, (x * 3 + y) % 256), axis=2).astype(np.uint8)
    upload = post("/images", files={"file": ("canvas.png", png_bytes(Image.fromarray(pixels)), "image/png")})
    root_id = upload.json()["normalized"]["asset_id"]
    root_meta, root_data = store.read_asset(root_id)
    original = np.asarray(Image.open(BytesIO(root_data)).convert("RGBA"))

    def run(path, values):
        submitted = post(path, json=values)
        assert submitted.status_code == 202, submitted.text
        job, token = store.claim()
        assert job["job_id"] == submitted.json()["job_id"]
        execute_local(store, job["job_id"], token)
        store.finish_job(job["job_id"], token)
        return store.get_job(job["job_id"])

    parent_id = root_id
    if nested:
        parent_id = run("/jobs/crop", {"input_asset_id": root_id,
            "bbox": {"left": 40, "top": 30, "right": 840, "bottom": 690}})["result"]["assets"][0]["asset_id"]
    crop = run("/jobs/crop", {"input_asset_id": parent_id,
        "bbox": {"left": 80, "top": 70, "right": 592, "bottom": 582}})["result"]["assets"][0]
    mask = np.zeros((512, 512), np.uint8)
    mask[120:135, 125:140] = 255
    mask[125:130, 130:135] = 0  # preserve a hole within the repair box
    damage = store.put_asset(png_bytes(Image.fromarray(mask)), ".png", {
        "kind": "damage_mask", "width": 512, "height": 512,
        "source_asset_id": crop["asset_id"], "coordinate_space_id": crop["coordinate_space_id"],
        "damage_source": "annotated"})
    monkeypatch.setattr(local_repair, "generate", lambda *args: Image.new("RGB", (512, 512), "red"))
    job = run("/jobs/repair", {**payload, "input_asset_id": crop["asset_id"],
                              "damage_mask_asset_id": damage["asset_id"], "feather_px": 8})
    repair = client.get(f"/api/v1/repairs/{job['job_id']}").json()
    selected_id = repair[selected_kind]["asset_id"]
    _, patch_data = store.read_asset(selected_id)
    patch = np.asarray(Image.open(BytesIO(patch_data)).convert("RGBA"))
    values = {"revision": 1, "action": "accept", "selected_asset_id": selected_id}
    key = uuid4().hex
    decision = post(f"/repairs/{job['job_id']}/decision", json=values, headers={"Idempotency-Key": key})
    assert decision.status_code == 200, decision.text
    accepted_id = decision.json()["decision"]["accepted_asset_id"]
    assert post(f"/repairs/{job['job_id']}/decision", json=values,
                headers={"Idempotency-Key": key}).json()["decision"]["accepted_asset_id"] == accepted_id
    saved, data = store.read_asset(accepted_id)
    assert (saved["width"], saved["height"], saved["coordinate_space_id"]) == (900, 720, root_meta["coordinate_space_id"])
    left, top = (120, 100) if nested else (80, 70)
    assert saved["restoration"]["offset"] == {"left": left, "top": top}
    assert saved["restoration"]["canvas_asset_id"] == root_id
    expected = original.copy()
    area = expected[top:top + 512, left:left + 512]
    area[mask > 0] = patch[mask > 0]
    np.testing.assert_array_equal(np.asarray(Image.open(BytesIO(data)).convert("RGBA")), expected)
    assert store.read_asset(root_id)[1] == root_data
    history = client.get(f"/api/v1/images/{saved['image_id']}/history?collection=assets").json()
    assert any(asset["asset_id"] == accepted_id for asset in history["items"])
    exported = run("/exports", {"asset_ids": [accepted_id], "license_acknowledged": True})
    _, zipped = store.read_asset(exported["result"]["assets"][0]["asset_id"])
    with ZipFile(BytesIO(zipped)) as archive:
        png = next(name for name in archive.namelist() if name.endswith(".png"))
        np.testing.assert_array_equal(np.asarray(Image.open(BytesIO(archive.read(png))).convert("RGBA")), expected)
    assert client.get("/api/v1/seedream/status").json()["budget"]["call_count"] == 0


@pytest.mark.parametrize("invalid", ["coordinates", "resize", "resize_without_crop", "cycle"])
def test_invalid_crop_lineage_fails_before_model_execution(studio, invalid):
    from app.services.local_workbench import _output
    store, client, post, upload, payload = studio
    root_id = upload((700, 700))
    source, _ = store.get_asset(root_id)
    crop_id = str(uuid4())
    output = _output(Image.new("RGBA", (512, 512)), "cropped", source, "test", asset_id=crop_id,
                     space=str(uuid4()), extra={"transform": {"operation": "crop",
                     "bbox": {"left": 50, "top": 60, "right": 562, "bottom": 572},
                     "input_size": [700, 700], "output_size": [512, 512]}})
    if invalid == "coordinates":
        output["metadata"]["transform"]["bbox"]["right"] = 561
    if invalid == "cycle":
        output["metadata"]["source_asset_id"] = crop_id
    # Register malformed historical assets to exercise validation, without touching real storage.
    staged = store._stage([output])
    with store.connection() as db:
        store._register(db, staged)
    input_id = crop_id
    if invalid in {"resize", "resize_without_crop"}:
        crop, _ = store.get_asset(crop_id if invalid == "resize" else root_id)
        working = store.put_asset(png_bytes(Image.new("RGBA", (512, 512))), ".png", {
            **crop, "width": 512, "height": 512, "kind": "working_copy",
            "source_asset_id": crop["asset_id"], "coordinate_space_id": str(uuid4())})
        input_id = working["asset_id"]
    response = post("/jobs/repair", json={**payload, "input_asset_id": input_id})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == ("REPAIR_RESTORE_UNSUPPORTED" if invalid.startswith("resize") else "REPAIR_RESTORE_INVALID")
    assert client.get("/api/v1/jobs").json()["items"] == []


@pytest.mark.parametrize("kind", ["transparent_png", "composed_candidate", "prepared", "working_copy"])
def test_full_native_canvas_derivatives_remain_valid_repair_inputs(studio, monkeypatch, kind):
    store, client, post, _, payload = studio
    source, _ = store.get_asset(payload["input_asset_id"])
    derived = store.put_asset(png_bytes(Image.new("RGBA", (512, 512), "blue")), ".png", {
        **source, "kind": kind, "source_asset_id": source["asset_id"],
        "coordinate_space_id": str(uuid4()) if kind in {"prepared", "working_copy"} else source["coordinate_space_id"]})
    monkeypatch.setattr(local_repair, "generate", lambda *args: Image.new("RGB", (512, 512), "red"))
    response = post("/jobs/repair", json={**payload, "input_asset_id": derived["asset_id"]})
    assert response.status_code == 202, response.text
    job, token = store.claim()
    execute_local(store, job["job_id"], token)
    store.finish_job(job["job_id"], token)
    repair = client.get(f"/api/v1/repairs/{job['job_id']}").json()
    accepted = post(f"/repairs/{job['job_id']}/decision", json={"revision": 1,
        "action": "accept", "selected_asset_id": repair["composited_asset"]["asset_id"]})
    assert accepted.status_code == 200, accepted.text
    saved, _ = store.get_asset(accepted.json()["decision"]["accepted_asset_id"])
    assert (saved["width"], saved["height"], saved["coordinate_space_id"]) == (512, 512, derived["coordinate_space_id"])
    assert "restoration" not in saved
