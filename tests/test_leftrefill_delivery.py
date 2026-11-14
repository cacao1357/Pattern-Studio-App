"""Portable delivery checks, without importing Torch or starting GPU inference."""

import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys

import numpy as np
from PIL import Image
import pytest


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "model" / "leftrefill"
module_spec = importlib.util.spec_from_file_location("leftrefill_inference", MODEL_DIR / "inference.py")
inference = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(inference)


def test_prompt_integrity_and_safe_tensor_layout():
    spec = json.loads((MODEL_DIR / "inference.json").read_text(encoding="utf-8"))
    path = MODEL_DIR / spec["prompt"]["file"]
    assert inference.sha256(path) == spec["prompt"]["sha256"]
    content = path.read_bytes()
    header_size = struct.unpack("<Q", content[:8])[0]
    header = json.loads(content[8:8 + header_size])
    assert set(header) == {"__metadata__", inference.PROMPT_KEY}
    assert header["__metadata__"]["global_step"] == "1108"
    assert header["__metadata__"]["source_sha256"] == spec["prompt"]["source_checkpoint_sha256"]
    assert header[inference.PROMPT_KEY] == {"dtype": "F32", "shape": [50, 1024], "data_offsets": [0, 204800]}
    values = np.frombuffer(content[8 + header_size:], dtype="<f4")
    assert values.size == 51200 and np.isfinite(values).all()


def test_reference_left_mask_right_and_float32_normalization():
    target = Image.new("RGB", (512, 512), (12, 34, 56))
    reference = Image.new("RGB", (128, 128), (78, 90, 123))
    mask = Image.new("L", (512, 512))
    mask.putpixel((7, 9), 255)
    preserved, missing, rgb, canvas_mask = inference.prepare_inputs(target, mask, reference)
    assert preserved.tobytes() == target.tobytes()
    assert missing.tobytes() == mask.tobytes()
    assert rgb.shape == (3, 512, 1024) and rgb.dtype == np.float32
    np.testing.assert_allclose(rgb[:, 0, 0], np.array([78, 90, 123], dtype=np.float32) / 127.5 - 1)
    np.testing.assert_allclose(rgb[:, 0, 512], np.array([12, 34, 56], dtype=np.float32) / 127.5 - 1)
    assert canvas_mask.shape == (1, 512, 1024)
    assert canvas_mask.sum() == 1 and canvas_mask[0, 9, 519] == 1


@pytest.mark.parametrize("size,value", [((256, 256), 255), ((512, 512), 0), ((512, 512), 128)])
def test_invalid_masks_fail_before_model_loading(size, value):
    with pytest.raises(ValueError):
        inference.prepare_inputs(Image.new("RGB", (512, 512)), Image.new("L", size, value), Image.new("RGB", (32, 32)))


@pytest.mark.parametrize("damaged", ["prompt", "base"])
def test_asset_checksum_rejects_corruption(tmp_path, monkeypatch, damaged):
    prompt = tmp_path / "prompt.safetensors"
    prompt.write_bytes(b"prompt")
    base = tmp_path / "base"
    base.mkdir()
    weights = base / "weights"
    weights.write_bytes(b"base")
    spec = {"prompt": {"file": prompt.name, "sha256": inference.sha256(prompt)},
            "base_model": {"files": {"weights": inference.sha256(weights)}}}
    (tmp_path / "inference.json").write_text(json.dumps(spec), encoding="utf-8")
    monkeypatch.setattr(inference, "MODEL_DIR", tmp_path)
    assert inference.verify_assets(base) == spec
    (prompt if damaged == "prompt" else weights).write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        inference.verify_assets(base)


def test_missing_base_fails_with_asset_path(tmp_path, monkeypatch):
    monkeypatch.setattr(inference, "MODEL_DIR", MODEL_DIR)
    with pytest.raises(FileNotFoundError, match="scheduler_config.json"):
        inference.verify_assets(tmp_path)


def test_selection_matches_metric_and_records_mae_tradeoff():
    evaluation = json.loads((MODEL_DIR / "evaluation.json").read_text(encoding="utf-8"))
    best = max(evaluation["comparable_candidates"], key=lambda row: row["mean_hole_psnr_db"])
    assert best["global_step"] == evaluation["selected_global_step"] == 1108
    assert evaluation["overall"]["n"] == sum(c["n"] for c in evaluation["by_category"].values()) == 63
    assert evaluation["overall"]["after_mae_255"] > evaluation["overall"]["before_mae_255"]
    assert evaluation["overall"]["paired_bootstrap_95"][0] < 0
    assert best["mean_hole_psnr_db"] == pytest.approx(evaluation["overall"]["after_psnr"])


def test_cli_help_without_optional_ml_dependencies():
    result = subprocess.run([sys.executable, str(MODEL_DIR / "inference.py"), "--help"], capture_output=True, text=True)
    assert result.returncode == 0
    assert "--reference" in result.stdout and "--sequential-guidance" in result.stdout
