"""Dataset-quality primitives shared with the CV data-layer pipeline.

The thresholds and the two-level duplicate check are calibrated on a 512 px
letterbox reference canvas, exactly like CV-Datatext-Pipeline's
``quality_metrics``/``grade``/``ahash``/``verify_ncc`` helpers.  The reference
canvas is only used for measurement: it is never stored, never replaces the
working image, and never changes the coordinate space of an asset.
"""

from __future__ import annotations

import hashlib
from io import BytesIO

import cv2
import numpy as np
from PIL import Image

REF_SIZE = 512
REF_FIT = "letterbox_reflect"
GRADE_VERSION = "p0-v1"
FINGERPRINT_VERSION = "p0-v1"
PATTERN_SCORE_VERSION = "p0-v1"

THR_A = {"short_side": 512, "sharpness": 300.0, "contrast": 35.0}
THR_C = {"short_side": 300, "sharpness": 100.0, "contrast": 22.0}

NCC_CONFIRM = 0.98
NCC_SUSPECT = 0.90


def content_id_of(data: bytes) -> str:
    """Stable public content id: sha256(file bytes)[:16], aligned with CV's image_id."""
    return hashlib.sha256(data).hexdigest()[:16]


def _flatten_rgb(image: Image.Image) -> Image.Image:
    """Composite transparency onto white so transparent pixels are not read as ink."""
    if image.mode in {"RGBA", "LA", "P"}:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def reference_gray(image: Image.Image, size: int = REF_SIZE) -> np.ndarray:
    """Return the 512 px letterbox grayscale canvas used for all measurements."""
    rgb = _flatten_rgb(image)
    array = np.asarray(rgb)
    height, width = array.shape[:2]
    if height < 1 or width < 1:
        raise ValueError("Image has no pixels")
    scale = size / max(height, width)
    new_width = max(1, int(round(width * scale)))
    new_height = max(1, int(round(height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    resized = cv2.resize(array, (new_width, new_height), interpolation=interpolation)
    pad_x = (size - new_width) // 2
    pad_y = (size - new_height) // 2
    if new_width == size and new_height == size:
        canvas = resized
    else:
        border = cv2.BORDER_REFLECT_101 if min(new_width, new_height) > 1 else cv2.BORDER_REPLICATE
        canvas = cv2.copyMakeBorder(
            resized,
            pad_y,
            size - new_height - pad_y,
            pad_x,
            size - new_width - pad_x,
            border,
        )
    return cv2.cvtColor(canvas, cv2.COLOR_RGB2GRAY)


def ahash(gray: np.ndarray, size: int = 8) -> int:
    """64-bit average hash. Stored as a decimal string, matching the CV pipeline."""
    small = cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    bits = (small > small.mean()).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def hamming(left: int, right: int) -> int:
    return int((left ^ right).bit_count())


def normalize_signature(image: Image.Image, size: int = 32) -> np.ndarray | None:
    """32x32 zero-mean unit-length grayscale signature for NCC duplicate checks."""
    gray = cv2.cvtColor(np.asarray(_flatten_rgb(image)), cv2.COLOR_RGB2GRAY)
    thumb = cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    thumb -= thumb.mean()
    norm = float(np.linalg.norm(thumb))
    return thumb / norm if norm > 0 else None


def signature_from_bytes(data: bytes) -> np.ndarray | None:
    with Image.open(BytesIO(data)) as loaded:
        loaded.load()
        return normalize_signature(loaded)


def ncc(first: np.ndarray | None, second: np.ndarray | None) -> float:
    if first is None or second is None:
        return 0.0
    return float((first * second).sum())


def grade(short_side: int, sharpness: float, contrast: float) -> str:
    """A usable / B limited / C replace. Mirrors the calibrated CV v0.1 rules."""
    if (
        short_side < THR_C["short_side"]
        or sharpness < THR_C["sharpness"]
        or contrast < THR_C["contrast"]
    ):
        return "C"
    if (
        short_side >= THR_A["short_side"]
        and sharpness >= THR_A["sharpness"]
        and contrast >= THR_A["contrast"]
    ):
        return "A"
    return "B"


def analyze(image: Image.Image) -> dict:
    """Measure one normalized image on the reference canvas.

    Returns a JSON-safe dict with the short side of the *actual* image, the two
    measured metrics, the averaged hash and the resulting grade.  The caller
    adds content_id / split / provenance.
    """
    gray = reference_gray(image)
    metrics = {
        "short_side": int(min(image.size)),
        "sharpness": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 2),
        "contrast": round(float(np.asarray(gray, dtype=np.float32).std()), 2),
        "ahash": str(ahash(gray)),
        "ref_size": REF_SIZE,
        "ref_fit": REF_FIT,
        "grade_version": GRADE_VERSION,
        "fingerprint_version": FINGERPRINT_VERSION,
    }
    metrics["grade"] = grade(metrics["short_side"], metrics["sharpness"], metrics["contrast"])
    return metrics


def assign_split(content_id: str, train: int = 80, val: int = 10) -> str:
    """Deterministic, content-derived split so re-runs never reshuffle samples."""
    if not content_id:
        return ""
    value = int(content_id[:8], 16) % 100
    return "train" if value < train else "val" if value < train + val else "test"


def pattern_metrics(image: Image.Image, *, alpha_threshold: int = 128) -> dict:
    """Heuristic "does this look like a pattern region?" score.

    The four rules come from CV's ``pattern_score`` and are deliberately kept
    advisory: a rejected score is a hint to review, never an automatic label.
    """
    if image.mode in {"L", "1"}:
        foreground = np.asarray(image.convert("L")) > 0
    else:
        rgba = np.asarray(image.convert("RGBA"))
        foreground = rgba[:, :, 3] >= alpha_threshold

    height, width = foreground.shape[:2]
    result = {
        "pattern_score": None,
        "area_ratio": round(float(foreground.mean()), 4) if foreground.size else 0.0,
        "edge_ratio": None,
        "bbox_fill": None,
        "aspect": None,
        "warnings": [],
        "rejected": None,
        "version": PATTERN_SCORE_VERSION,
    }
    if not foreground.any():
        result["rejected"] = "EMPTY_MASK"
        return result

    result["edge_ratio"] = round(
        float(
            foreground[0, :].mean()
            + foreground[-1, :].mean()
            + foreground[:, 0].mean()
            + foreground[:, -1].mean()
        ),
        4,
    )
    ys, xs = np.nonzero(foreground)
    if len(ys) < 10:
        result["rejected"] = "TOO_SMALL"
        return result

    bbox_width = int(xs.max() - xs.min() + 1)
    bbox_height = int(ys.max() - ys.min() + 1)
    result["bbox_fill"] = round(len(ys) / float(bbox_width * bbox_height), 4)
    result["aspect"] = round(max(bbox_width / bbox_height, bbox_height / bbox_width), 4)

    area = result["area_ratio"]
    if area < 0.005 or area > 0.45:
        result["rejected"] = "AREA_RATIO_OUT_OF_RANGE"
        result["warnings"].append("CANDIDATE_MAY_BE_BACKGROUND" if area > 0.45 else "CANDIDATE_TOO_SMALL")
        return result
    if result["edge_ratio"] > 1.2:
        result["rejected"] = "TOUCHES_BORDER"
        result["warnings"].append("CANDIDATE_TOUCHES_BORDER")
        return result
    if result["bbox_fill"] > 0.85:
        result["rejected"] = "SOLID_REGION"
        result["warnings"].append("CANDIDATE_IS_SOLID_REGION")
        return result
    if result["aspect"] > 5:
        result["rejected"] = "TOO_ELONGATED"
        result["warnings"].append("CANDIDATE_TOO_ELONGATED")
        return result

    result["pattern_score"] = round(1.0 - result["bbox_fill"], 4)
    return result
