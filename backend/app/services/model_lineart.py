"""CUDA-first inference for the local 512 px line-art checkpoint."""

from hashlib import file_digest
import importlib.util
import json

import numpy as np
from PIL import Image

from app.config import PROJECT_ROOT
from app.schemas.contracts import ProcessingError
from app.services.lineart import LineartResult, _flatten_rgb


MODEL_DIR = PROJECT_ROOT / "model"
MODEL_VERSION = "lineart-stage-d-unetpp-resnet34-v1"
MODEL_SHA256 = "b264a1f33b4d126f1f87b15b717a2091da6a59a7d41fb3790973dd247d86a369"
INFERENCE_SPEC = {
    "architecture": "unetpp-resnet34",
    "input_size": 512,
    "input_channels": 3,
    "output_channels": 1,
    "normalization_mean": [0.485, 0.456, 0.406],
    "normalization_std": [0.229, 0.224, 0.225],
    "threshold": 0.5,
    "output": "white_background_black_lines",
}


def model_capability() -> dict:
    """Check prerequisites without importing ML runtimes or loading the checkpoint.

    This is not an inference or CUDA readiness test. The worker still validates
    checkpoint integrity and reports runtime failures when a task is executed.
    """
    result = {"available": False, "reason": None, "checked": "prerequisites_only"}
    try:
        weights = MODEL_DIR / "model.pt"
        config_path = MODEL_DIR / "inference.json"
        if not weights.is_file() or not config_path.is_file() or weights.stat().st_size == 0:
            return {**result, "reason": "model_files_missing"}
        # A Git LFS pointer is not an installed checkpoint. Read only a small
        # header when the file is small, never hash/load the weights in /health.
        if weights.stat().st_size < 1024 and weights.read_bytes().startswith(b"version https://git-lfs.github.com/spec/v1"):
            return {**result, "reason": "model_files_missing"}
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            return {**result, "reason": "model_config_invalid"}
        if not isinstance(config, dict) or any(config.get(key) != value for key, value in INFERENCE_SPEC.items()):
            return {**result, "reason": "model_config_invalid"}
        if any(importlib.util.find_spec(name) is None for name in ("torch", "segmentation_models_pytorch")):
            return {**result, "reason": "dependencies_missing"}
        return {**result, "available": True}
    except (OSError, ImportError, ValueError, RuntimeError):
        return {**result, "reason": "model_check_failed"}


def _infer(torch, model, tensor) -> tuple[np.ndarray, str]:
    if torch.cuda.is_available():
        try:
            model.to("cuda")
            return model(tensor.to("cuda")).sigmoid()[0, 0].cpu().numpy(), "cuda"
        except torch.cuda.OutOfMemoryError:
            pass
        # Release the failed forward pass before retrying with the same weights on CPU.
        model.cpu()
        torch.cuda.empty_cache()

    return model(tensor).sigmoid()[0, 0].numpy(), "cpu"


def _predict(image: Image.Image) -> tuple[np.ndarray, str]:
    try:
        config = json.loads((MODEL_DIR / "inference.json").read_text(encoding="utf-8"))
        if not isinstance(config, dict) or any(config.get(key) != value for key, value in INFERENCE_SPEC.items()):
            raise ValueError
        weights = MODEL_DIR / "model.pt"
        if not weights.is_file():
            raise FileNotFoundError
    except (OSError, ValueError):
        raise ProcessingError("LINEART_MODEL_UNAVAILABLE", "Place the supplied model.pt and inference.json in model/.") from None

    try:
        import torch
        from segmentation_models_pytorch import UnetPlusPlus
    except (ImportError, OSError, RuntimeError):
        raise ProcessingError(
            "LINEART_MODEL_UNAVAILABLE",
            "Check the line-art dependencies in the Pattern Studio Python environment. See the README.",
        ) from None

    torch.set_num_threads(1)
    model = UnetPlusPlus(encoder_name="resnet34", encoder_weights=None, in_channels=3, classes=1)
    try:
        with weights.open("rb") as stream:
            if file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
                raise ValueError
            stream.seek(0)
            model.load_state_dict(torch.load(stream, map_location="cpu", weights_only=True))
    except (OSError, ValueError):
        raise ProcessingError(
            "LINEART_MODEL_UNAVAILABLE", "model/model.pt does not match the supplied Stage D checkpoint.",
        ) from None

    size = config["input_size"]
    pixels = np.asarray(_flatten_rgb(image).resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32) / 255
    mean = np.asarray(config["normalization_mean"], dtype=np.float32)
    std = np.asarray(config["normalization_std"], dtype=np.float32)
    tensor = torch.from_numpy(((pixels - mean) / std).transpose(2, 0, 1).copy())[None]
    model.eval()
    with torch.inference_mode():
        return _infer(torch, model, tensor)


def extract_model_lineart(image: Image.Image) -> LineartResult:
    prediction, device = _predict(image)
    probability = Image.fromarray(prediction).resize(image.size, Image.Resampling.BILINEAR)
    threshold = INFERENCE_SPEC["threshold"]
    ink = np.asarray(probability) >= threshold
    alpha = Image.fromarray(ink.astype(np.uint8) * 255)
    result = Image.new("RGBA", image.size)
    result.putalpha(alpha)
    return LineartResult(result, {
        "algorithm": MODEL_VERSION,
        "model_sha256": MODEL_SHA256,
        "inference_device": device,
        "input_size": INFERENCE_SPEC["input_size"],
        "resize": "whole-image-bilinear",
        "threshold": threshold,
        "background": "transparent",
        "ink_ratio": round(float(ink.mean()), 4),
    })
