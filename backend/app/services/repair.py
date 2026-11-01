"""Deterministic region protection; this module does not generate repair candidates."""

from dataclasses import dataclass
from typing import Literal

import numpy as np
from PIL import Image

from app.schemas.contracts import BoundingBox, ProcessingError
from app.services.imaging import rectangle_mask, validate_binary_mask


@dataclass
class CompositeResult:
    image: Image.Image
    edit_mask: Image.Image
    blend_weight: Image.Image
    metrics: dict


def composite_region(
    source: Image.Image, candidate: Image.Image, bbox: BoundingBox, *, feather_px: int = 0,
    damage_mask: Image.Image | None = None,
    damage_source: Literal["synthetic", "annotated"] | None = None,
) -> CompositeResult:
    if candidate.size != source.size:
        raise ProcessingError("CANDIDATE_SPACE_MISMATCH", "Candidate must match the current input dimensions; do not force-resize it")
    bbox.within(source.size)
    if type(feather_px) is not int or not 0 <= feather_px <= 64:
        raise ProcessingError("INVALID_FEATHER", "Feather width must be an integer in 0..64")
    edit_mask = rectangle_mask(source.size, bbox)
    editing = np.asarray(edit_mask) > 0
    damage_metadata = {"damage_source": None, "damage_coverage": None, "warnings": []}
    if damage_mask is not None:
        if damage_source not in {"synthetic", "annotated"}:
            raise ProcessingError("DAMAGE_SOURCE_REQUIRED", "Identify whether the damage mask is synthetic or annotated")
        damage = validate_binary_mask(damage_mask, source.size) > 0
        outside_damage = int(np.count_nonzero(damage & ~editing))
        if damage_source == "synthetic" and outside_damage:
            raise ProcessingError("DAMAGE_OUTSIDE_EDIT", "Synthetic damage must be contained by the edit region")
        damage_count = int(np.count_nonzero(damage))
        covered_count = int(np.count_nonzero(damage & editing))
        damage_metadata = {"damage_source": damage_source, "damage_pixels": damage_count,
                           "damage_pixels_in_edit": covered_count, "damage_pixels_outside_edit": outside_damage,
                           "damage_coverage": covered_count / damage_count if damage_count else None,
                           "warnings": ["PARTIAL_DAMAGE_COVERAGE"] if outside_damage else []}
    elif damage_source is not None:
        raise ProcessingError("DAMAGE_MASK_REQUIRED", "Damage provenance requires a damage mask")
    weights = np.zeros((source.height, source.width), np.uint8)
    h, w = bbox.bottom - bbox.top, bbox.right - bbox.left
    if feather_px:
        y, x = np.indices((h, w))
        distance = np.minimum(np.minimum(x + 1, w - x), np.minimum(y + 1, h - y))
        weights[bbox.top:bbox.bottom, bbox.left:bbox.right] = np.rint(np.minimum(distance / (feather_px + 1), 1) * 255).astype(np.uint8)
    else:
        weights[editing] = 255
    original = np.asarray(source.convert("RGBA"))
    generated = np.asarray(candidate.convert("RGBA"))
    output = original.copy()
    blend = weights[editing, None].astype(np.float64) / 255
    first, second = original[editing].astype(np.float64), generated[editing].astype(np.float64)
    first_alpha, second_alpha = first[:, 3:4] / 255, second[:, 3:4] / 255
    alpha = (1 - blend) * first_alpha + blend * second_alpha
    premultiplied = (1 - blend) * first[:, :3] * first_alpha + blend * second[:, :3] * second_alpha
    rgb = np.divide(premultiplied, alpha, out=np.zeros_like(premultiplied), where=alpha > 0)
    output[editing] = np.clip(np.rint(np.concatenate((rgb, alpha * 255), axis=1)), 0, 255).astype(np.uint8)
    diff = np.abs(output.astype(np.int16) - original.astype(np.int16))
    outside = diff[~editing]
    metrics = {"outside_changed_pixels": int(np.count_nonzero(np.any(outside != 0, axis=1))),
               "outside_max_error": int(outside.max()) if outside.size else 0,
               "feather_px": feather_px, "candidate_alignment": "same-size-required-not-geometry-verified",
               "algorithm": "premultiplied-rgba-local-composite-v1", **damage_metadata}
    return CompositeResult(Image.fromarray(output), edit_mask, Image.fromarray(weights), metrics)
