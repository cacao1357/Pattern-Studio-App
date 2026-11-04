from io import BytesIO
from uuid import uuid4

from PIL import Image

from app.storage import png_bytes
from app.workbench_store import WorkbenchStore


def asset(kind, asset_id, width=64, height=64):
    image = Image.new("RGBA", (width, height), (20, 40, 60, 255))
    return {
        "data": png_bytes(image),
        "suffix": ".png",
        "metadata": {
            "asset_id": asset_id,
            "kind": kind,
            "width": width,
            "height": height,
            "coordinate_space_id": "space-1",
            "source_asset_id": asset_id if kind == "original" else "source",
        },
    }


def meta(content_id, ahash, grade="A"):
    return {
        "content_id": content_id,
        "grade": grade,
        "grade_version": "p0-v1",
        "short_side": 64,
        "sharpness": 500.0,
        "contrast": 40.0,
        "ref_size": 512,
        "ref_fit": "letterbox_reflect",
        "ahash": str(ahash),
        "fingerprint_version": "p0-v1",
        "split": "train",
        "source_type": "museum_photo",
        "source_name": "test",
        "source_url": "",
        "license": "内部使用",
        "collected_at": "2026-10-24",
        "batch_id": "batch-1",
        "provenance_status": "declared",
        "normalization_version": "normalize-image-v1",
    }


def add(store, key, content_id, ahash):
    original_id, normalized_id = str(uuid4()), str(uuid4())
    outputs = [asset("original", original_id), asset("normalized_input", normalized_id)]
    return store.add_image(outputs, "note", key, "hash-" + key, meta=meta(content_id, ahash))


def test_image_meta_is_returned(tmp_path):
    store = WorkbenchStore(tmp_path)
    record, created, candidates = add(store, "k" * 16, "0123456789abcdef", 12345)
    assert created is True
    assert candidates == []
    assert record["meta"]["content_id"] == "0123456789abcdef"
    assert record["meta"]["grade"] == "A"
    assert record["meta"]["license"] == "内部使用"
    assert record["original"]["image_id"] == record["image_id"]
    assert record["normalized"]["grade"] == "A"
    assert record["normalized"]["content_id"] == "0123456789abcdef"


def test_duplicate_candidates_are_returned(tmp_path):
    store = WorkbenchStore(tmp_path)
    first, _, _ = add(store, "a" * 16, "1111111111111111", 999)
    second, created, candidates = add(store, "b" * 16, "2222222222222222", 999)
    assert created is True
    assert second["image_id"] != first["image_id"]
    assert candidates
    assert candidates[0]["image_id"] == first["image_id"]
    assert candidates[0]["distance"] == 0
    assert candidates[0]["original_id"] == first["original"]["asset_id"]


def test_old_image_without_meta_is_readable(tmp_path):
    store = WorkbenchStore(tmp_path)
    record, _, _ = add(store, "c" * 16, "3333333333333333", 111)
    with store.connection() as db:
        db.execute("DELETE FROM image_meta WHERE image_id=?", (record["image_id"],))
    old = store.get_image(record["image_id"])
    assert old["meta"] is None
    assert old["original"]["asset_id"] == record["original"]["asset_id"]
    missing = store.images_without_meta()
    assert any(row["id"] == record["image_id"] for row in missing)
    audit = store.dataset_audit()
    assert audit["total_images"] == audit["missing_meta"] == 1
    assert audit["grades"]["missing"] == 1
    assert sum(audit["grades"].values()) == audit["total_images"]


def test_idempotent_upload_returns_same_image(tmp_path):
    store = WorkbenchStore(tmp_path)
    first, _, _ = add(store, "d" * 16, "4444444444444444", 222)
    again, created, candidates = add(store, "d" * 16, "4444444444444444", 222)
    assert created is False
    assert again["image_id"] == first["image_id"]
    assert candidates == []
