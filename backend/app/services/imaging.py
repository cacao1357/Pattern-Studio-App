"""Local raster operations. Every operation returns a new image."""

from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePath
from typing import Literal
import warnings

import cv2
import numpy as np
from PIL import Image, ImageCms, ImageDraw, ImageOps, UnidentifiedImageError

from app.schemas.contracts import BoundingBox, DEFAULT_LIMITS, ProcessingError, ResourceLimits
from app.services.segmentation import local_threshold, clean_binary_mask


@dataclass
class NormalizedImage:
    image: Image.Image
    metadata: dict


@dataclass
class ExtractionResult:
    foreground_mask: Image.Image
    rgba: Image.Image
    metadata: dict


def normalize_image(
    data: bytes, filename: str | None = None, *, limits: ResourceLimits = DEFAULT_LIMITS
) -> NormalizedImage:
    if not data:
        raise ProcessingError("EMPTY_FILE", "Image file is empty")
    if len(data) > limits.max_upload_bytes:
        raise ProcessingError("UPLOAD_TOO_LARGE", "Image exceeds the upload byte limit")
    formats = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG"}
    suffix = PurePath(filename).suffix.lower() if filename else None
    if suffix is not None and suffix not in formats:
        raise ProcessingError("UNSUPPORTED_FORMAT", "Only PNG and JPEG are accepted")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as probe:
                original_format = probe.format
                original_size = probe.size
                if original_format not in {"PNG", "JPEG"}:
                    raise ProcessingError("UNSUPPORTED_FORMAT", "Decoded content must be PNG or JPEG")
                if suffix and formats[suffix] != original_format:
                    raise ProcessingError("FORMAT_MISMATCH", "Filename and decoded image format disagree")
                if probe.width * probe.height > limits.max_decode_pixels:
                    raise ProcessingError("PIXEL_LIMIT", "Decoded image exceeds the pixel limit")
                if getattr(probe, "n_frames", 1) != 1:
                    raise ProcessingError("ANIMATED_IMAGE", "Only single-frame images are accepted")
                probe.verify()
            with Image.open(BytesIO(data)) as source:
                orientation = int(source.getexif().get(274, 1))
                oriented = ImageOps.exif_transpose(source)
                rgba = oriented.convert("RGBA")
                profile = source.info.get("icc_profile")
                if profile:
                    try:
                        icc_input = oriented if oriented.mode in {"RGB", "CMYK", "LAB"} else oriented.convert("RGB")
                        rgb = ImageCms.profileToProfile(
                            icc_input, ImageCms.ImageCmsProfile(BytesIO(profile)),
                            ImageCms.createProfile("sRGB"), outputMode="RGB",
                        )
                        rgb.putalpha(rgba.getchannel("A"))
                        rgba = rgb
                    except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                        raise ProcessingError("INVALID_COLOR_PROFILE", "Embedded color profile cannot be converted") from exc
                rgba.load()
    except ProcessingError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ProcessingError("PIXEL_LIMIT", "Image exceeds safe decode limits") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ProcessingError("INVALID_IMAGE", "Image is damaged or cannot be decoded") from exc
    return NormalizedImage(rgba, {
        "original_format": original_format,
        "input_size": list(original_size), "output_size": list(rgba.size),
        "transform": {"operation": "exif_transpose", "orientation": orientation},
        "color_conversion": "embedded_icc_to_srgb" if profile else "assumed_srgb",
        "has_transparency": rgba.getchannel("A").getextrema()[0] < 255,
    })


def crop_image(image: Image.Image, bbox: BoundingBox) -> Image.Image:
    return image.crop(bbox.within(image.size).as_tuple())


def validate_binary_mask(mask: Image.Image, size: tuple[int, int]) -> np.ndarray:
    if mask.mode != "L" or mask.size != size:
        raise ProcessingError("MASK_SPACE_MISMATCH", "Binary mask must be L mode and match the source dimensions")
    values = np.asarray(mask)
    if not np.isin(values, (0, 255)).all():
        raise ProcessingError("NON_BINARY_MASK", "Binary mask values must be 0 or 255")
    return values


def foreground_rgba(image: Image.Image, mask: Image.Image) -> Image.Image:
    binary = validate_binary_mask(mask, image.size)
    pixels = np.array(image.convert("RGBA"))
    # Preserve the selected source's RGB, including RGB hidden by transparent pixels.
    pixels[:, :, 3] = np.minimum(pixels[:, :, 3], binary)
    return Image.fromarray(pixels)


def extract_foreground(
    image: Image.Image, *, mode: str = "otsu",
    polarity: Literal["dark", "light"] = "dark", threshold: int = 127,
    bbox: BoundingBox | None = None, iterations: int = 5,
    window_size: int = 31, offset: float = 10.0, clahe: bool = False,
    min_component_area: int = 0, max_hole_area: int = 0,
) -> ExtractionResult:
    if mode not in {"otsu", "manual", "grabcut", "alpha", "adaptive_mean", "adaptive_gaussian", "sauvola"} or polarity not in {"dark", "light"}:
        raise ProcessingError("INVALID_EXTRACTION_MODE", "Unknown extraction mode or polarity")
    if type(threshold) is not int or not 0 <= threshold <= 255:
        raise ProcessingError("INVALID_THRESHOLD", "Threshold must be an integer in 0..255")
    if type(window_size) is not int or not 3 <= window_size <= 255 or window_size % 2 == 0:
        raise ProcessingError("INVALID_WINDOW_SIZE", "Local threshold window must be odd in 3..255")
    if not isinstance(offset, (int, float)) or isinstance(offset, bool) or not np.isfinite(offset) or not -50 <= offset <= 50:
        raise ProcessingError("INVALID_OFFSET", "Local threshold offset must be in -50..50")
    if type(clahe) is not bool:
        raise ProcessingError("INVALID_CLAHE", "CLAHE must be a boolean")
    if mode == "alpha" and (min_component_area or max_hole_area or clahe):
        raise ProcessingError("ALPHA_PRESERVATION", "Existing-alpha mode preserves the source; choose another mode for cleanup")
    rgba = image.convert("RGBA")
    pixels = np.asarray(rgba)
    alpha = pixels[:, :, 3]
    visible = alpha > 0
    if not visible.any():
        raise ProcessingError("EMPTY_MASK", "Input contains no visible pixels")
    actual_threshold: float | int = threshold
    if mode == "alpha":
        binary = np.where(alpha > threshold, 255, 0).astype(np.uint8)
    elif mode == "grabcut":
        if bbox is None:
            raise ProcessingError("BBOX_REQUIRED", "GrabCut requires a rectangle")
        bbox.within(rgba.size)
        if bbox.as_tuple() == (0, 0, rgba.width, rgba.height):
            raise ProcessingError("GRABCUT_NEEDS_BACKGROUND", "Leave some background outside the GrabCut rectangle")
        if type(iterations) is not int or not 1 <= iterations <= 10:
            raise ProcessingError("INVALID_ITERATIONS", "GrabCut iterations must be in 1..10")
        # Invisible RGB is not evidence for foreground/background estimation.
        rgb = np.array(pixels[:, :, :3])
        rgb[~visible] = 255
        if clahe:
            lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
            lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
            rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
        labels = np.zeros(alpha.shape, np.uint8)
        cv2.setRNGSeed(0)
        try:
            cv2.grabCut(
                cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), labels,
                (bbox.left, bbox.top, bbox.right - bbox.left, bbox.bottom - bbox.top),
                np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                iterations, cv2.GC_INIT_WITH_RECT,
            )
        except cv2.error as exc:
            raise ProcessingError("GRABCUT_FAILED", "GrabCut could not separate this rectangle; adjust it or use a threshold") from exc
        binary = np.where(((labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)) & visible, 255, 0).astype(np.uint8)
    else:
        gray = cv2.cvtColor(pixels[:, :, :3], cv2.COLOR_RGB2GRAY)
        # Hidden RGB must not contaminate neighborhood statistics or CLAHE.
        gray = np.array(gray)
        gray[~visible] = 255 if polarity == "dark" else 0
        if clahe:
            gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        if mode in {"adaptive_mean", "adaptive_gaussian", "sauvola"}:
            actual_threshold = local_threshold(gray if polarity == "dark" else 255 - gray, mode, window_size, offset)
        if mode == "otsu":
            actual_threshold, _ = cv2.threshold(gray[visible].reshape(-1, 1), 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        if mode in {"adaptive_mean", "adaptive_gaussian", "sauvola"}:
            selected = (gray if polarity == "dark" else 255 - gray) <= actual_threshold
        else:
            selected = gray <= actual_threshold if polarity == "dark" else gray > actual_threshold
        binary = np.where(selected & visible, 255, 0).astype(np.uint8)
    binary = clean_binary_mask(binary, min_component_area, max_hole_area)
    binary[~visible] = 0
    if not binary.any():
        raise ProcessingError("EMPTY_MASK", "No foreground selected; adjust the mode, polarity or threshold")
    mask = Image.fromarray(binary)
    # Existing-alpha mode preserves soft alpha rather than replacing it with a binary mask.
    output = rgba.copy() if mode == "alpha" else foreground_rgba(rgba, mask)
    return ExtractionResult(mask, output, {
        "algorithm": "local-extraction-v2",
        "mode": mode, "polarity": polarity,
        "threshold": float(actual_threshold) if np.isscalar(actual_threshold) else None,
        "window_size": window_size, "offset": offset, "clahe": clahe,
        "min_component_area": min_component_area, "max_hole_area": max_hole_area,
        "bbox": bbox.model_dump() if bbox and mode == "grabcut" else None,
        "iterations": iterations if mode == "grabcut" else None,
        "alpha_policy": "preserve_existing" if mode == "alpha" else "intersection_with_binary_mask",
        "foreground_fraction": float(np.count_nonzero(binary) / binary.size),
        "warnings": (["ALL_FOREGROUND_CHECK_PARAMETERS"] if binary.all() else []) +
                    (["LOCAL_THRESHOLD_CAN_HOLLOW_SOLID_REGIONS"] if mode.startswith("adaptive_") or mode == "sauvola" else []),
    })


def contour_line_art(mask: Image.Image) -> tuple[Image.Image, dict]:
    binary = validate_binary_mask(mask, mask.size)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    canvas = np.full(binary.shape, 255, np.uint8)
    cv2.drawContours(canvas, contours, -1, 0, thickness=1, lineType=cv2.LINE_8)
    return Image.fromarray(canvas), {"algorithm": "opencv-findContours-RETR_LIST-v1", "line_width": 1}


def rectangle_mask(size: tuple[int, int], bbox: BoundingBox) -> Image.Image:
    bbox.within(size)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rectangle((bbox.left, bbox.top, bbox.right - 1, bbox.bottom - 1), fill=255)
    return mask
