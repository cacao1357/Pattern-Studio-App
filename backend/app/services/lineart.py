"""Line-art extraction v0.2: global strong edges union local low-contrast detail.

Ported from the CV data-layer experiments. The default is the union of a global
quantile path and a local contrast-normalized tile path; skeletonization is
deliberately not exposed because the experiments showed it produces unusable
"broken glass" output on this material.
"""

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageOps


@dataclass
class LineartResult:
    image: Image.Image
    metadata: dict


def normalize_cloud_lineart(image: Image.Image) -> LineartResult:
    """Map white-background cloud ink to the same alpha contract as local ink.

    Monochrome vectorization traces alpha, not luminance. Preserve antialiasing
    and existing transparency; this does not re-detect edges or draw new lines.
    """
    rgba = image.convert("RGBA")
    alpha = ImageChops.multiply(ImageOps.invert(rgba.convert("L")), rgba.getchannel("A"))
    result = Image.new("RGBA", image.size)
    result.putalpha(alpha)
    return LineartResult(result, {
        "algorithm": "cloud-lineart-luminance-alpha-v1", "background": "transparent",
        "alpha_policy": "inverted_luminance_times_source_alpha",
        "ink_ratio": round(float((np.asarray(alpha) >= 128).mean()), 4),
    })


def _flatten_rgb(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA", "P"}:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def _drop_small(edge: np.ndarray, min_area: int) -> np.ndarray:
    if min_area <= 0 or not edge.any():
        return edge
    count, labels, stats, _ = cv2.connectedComponentsWithStats((edge > 0).astype(np.uint8), 8)
    if count <= 1:
        return np.zeros_like(edge)
    keep = stats[:, cv2.CC_STAT_AREA] >= min_area
    keep[0] = False
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def _global_path(gray: np.ndarray, med: int, hi_pct: float, lo_ratio: float, min_area: int) -> np.ndarray:
    source = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    if med >= 3 and med % 2 == 1:
        source = cv2.medianBlur(source, med)
    source = cv2.bilateralFilter(source, 7, 40, 5)
    gx = cv2.Sobel(source, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(source, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    high = float(np.percentile(magnitude, hi_pct))
    low = lo_ratio * high
    edge = cv2.Canny(source, max(low, 1.0), max(high, 2.0), L2gradient=True)
    return _drop_small(edge, min_area)


def _local_path(gray: np.ndarray, med: int, tile_pct: float, min_area: int,
                sd_thr: float, tiles: int = 8, window: int = 63, gain: float = 40.0) -> np.ndarray:
    source = gray.astype(np.float32)
    mean = cv2.blur(source, (window, window))
    mean_square = cv2.blur(source * source, (window, window))
    deviation = np.sqrt(np.maximum(mean_square - mean * mean, 0))
    normalized = np.clip((source - mean) / (deviation + 4.0) * gain + 128, 0, 255).astype(np.uint8)
    if med >= 3 and med % 2 == 1:
        normalized = cv2.medianBlur(normalized, med)
    gx = cv2.Sobel(normalized, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(normalized, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    height, width = magnitude.shape
    tile_height, tile_width = height // tiles, width // tiles
    ink = np.zeros((height, width), np.uint8)
    if tile_height < 1 or tile_width < 1:
        return ink
    for row in range(tiles):
        for column in range(tiles):
            y0, y1 = row * tile_height, (row + 1) * tile_height
            x0, x1 = column * tile_width, (column + 1) * tile_width
            if deviation[y0:y1, x0:x1].mean() < sd_thr:
                continue
            block = magnitude[y0:y1, x0:x1]
            threshold = float(np.percentile(block, tile_pct))
            ink[y0:y1, x0:x1] = (block > max(threshold, 1.0)).astype(np.uint8) * 255
    return _drop_small(ink, min_area)


def extract_lineart(image: Image.Image, *, local: bool = True, med: int | None = None,
                    min_area: int | None = None, hi_pct: float = 88.0,
                    lo_ratio: float = 0.45, tile_pct: float = 92.0,
                    sd_thr: float = 12.0) -> LineartResult:
    rgb = _flatten_rgb(image)
    gray = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2GRAY)
    height, width = gray.shape[:2]
    long_side = max(height, width)
    if med is None:
        med = 3 if long_side <= 768 else 9
    if med and (med < 3 or med % 2 == 0):
        med = max(3, int(med) | 1)
    if min_area is None:
        min_area = int(round(30 * (long_side / 512.0) ** 2))
    min_area = max(0, int(min_area))

    global_edges = _global_path(gray, med, hi_pct, lo_ratio, min_area)
    local_edges = _local_path(gray, med, tile_pct, min_area, sd_thr) if local else np.zeros_like(global_edges)
    edge = cv2.bitwise_or(global_edges, local_edges)
    ink = edge > 0
    bright = gray >= 200
    count, _, stats, _ = cv2.connectedComponentsWithStats(edge, 8)
    areas = stats[1:, cv2.CC_STAT_AREA] if count > 1 else np.zeros(1, np.int32)

    metadata = {
        "algorithm": "lineart-global-local-v2",
        "ink_ratio": round(float(ink.mean()), 4),
        "ink_bright": round(float(ink[bright].mean()) if bright.any() else 0.0, 4),
        "local_gain": round(float((local_edges > 0).mean()), 4),
        "edges_px": int(ink.sum()),
        "components": int(max(count - 1, 0)),
        "small_components": int((areas < 12).sum()),
        "med": int(med),
        "min_area": int(min_area),
        "hi_pct": float(hi_pct),
        "tile_pct": float(tile_pct),
        "sd_thr": float(sd_thr),
        "local_path": bool(local),
        "skeleton": False,
        "background": "transparent",
        "note": "advisory line-art draft; human review remains required",
    }
    rgba = np.zeros((edge.shape[0], edge.shape[1], 4), np.uint8)
    rgba[:, :, 3] = edge
    return LineartResult(Image.fromarray(rgba), metadata)
