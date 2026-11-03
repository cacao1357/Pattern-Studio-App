from io import BytesIO

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import quality


def png_bytes(image: Image.Image) -> bytes:
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def checkerboard(width=1200, height=800, block=40) -> Image.Image:
    image = Image.new("RGB", (width, height), "#f4f0e6")
    draw = ImageDraw.Draw(image)
    for y in range(0, height, block):
        for x in range(0, width, block):
            if (x // block + y // block) % 2 == 0:
                draw.rectangle([x, y, x + block - 1, y + block - 1], fill="#182632")
    return image


def test_grade_boundaries():
    assert quality.grade(600, 500, 40) == "A"
    assert quality.grade(600, 50, 40) == "C"
    assert quality.grade(400, 500, 40) == "B"
    assert quality.grade(200, 500, 40) == "C"
    assert quality.grade(600, 120, 40) == "B"
    assert quality.grade(600, 500, 10) == "C"


def test_analyze_sharp_and_flat_images():
    sharp = quality.analyze(checkerboard())
    assert sharp["grade"] == "A"
    assert sharp["short_side"] == 800
    assert sharp["ref_size"] == 512
    assert sharp["ref_fit"] == quality.REF_FIT
    assert len(sharp["ahash"]) > 0

    flat = quality.analyze(Image.new("RGB", (800, 800), "#d8d8d0"))
    assert flat["grade"] == "C"
    assert flat["contrast"] < quality.THR_C["contrast"]


def test_content_id_and_split_are_deterministic():
    first = quality.content_id_of(b"pattern-studio")
    second = quality.content_id_of(b"pattern-studio")
    assert first == second
    assert len(first) == 16
    assert first != quality.content_id_of(b"pattern-studio-2")
    split = quality.assign_split(first)
    assert split in {"train", "val", "test"}
    assert split == quality.assign_split(first)


def test_ahash_and_hamming():
    gray = quality.reference_gray(checkerboard(600, 600, 30))
    value = quality.ahash(gray)
    assert quality.hamming(value, value) == 0
    assert 0 <= value < 2**64
    other = quality.ahash(quality.reference_gray(Image.new("RGB", (600, 600), "#ffffff")))
    assert quality.hamming(value, other) >= 0


def test_ncc_signatures():
    image = checkerboard(600, 600, 40)
    signature = quality.normalize_signature(image)
    assert signature is not None
    assert quality.ncc(signature, signature) == pytest.approx(1.0, abs=1e-6)
    assert quality.signature_from_bytes(png_bytes(image)) is not None


def test_pattern_metrics_rejects_background_and_tiny_fragments():
    full = Image.new("L", (200, 200), 255)
    result = quality.pattern_metrics(full)
    assert result["pattern_score"] is None
    assert result["rejected"] == "AREA_RATIO_OUT_OF_RANGE"
    assert "CANDIDATE_MAY_BE_BACKGROUND" in result["warnings"]

    tiny = Image.new("L", (200, 200), 0)
    tiny.putpixel((10, 10), 255)
    result = quality.pattern_metrics(tiny)
    assert result["rejected"] == "TOO_SMALL"


def test_pattern_metrics_scores_a_ring():
    mask = Image.new("L", (300, 300), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse([40, 40, 260, 260], outline=255, width=16)
    result = quality.pattern_metrics(mask)
    assert result["rejected"] is None
    assert 0.0 < result["pattern_score"] <= 1.0
    assert result["area_ratio"] < 0.45

    rgba = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rgba)
    draw.rectangle([50, 80, 250, 180], fill=(20, 30, 40, 255))
    result = quality.pattern_metrics(rgba)
    assert result["pattern_score"] is None
    assert result["rejected"] == "SOLID_REGION"
