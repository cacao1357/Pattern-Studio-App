"""Conservative segmentation primitives; no storage, jobs or UI dependencies.

Local statistics use replicated borders. Sauvola uses k=0.2 and R=128;
offset is an additional user bias in luminance units, not Sauvola's k.
"""
import cv2
import numpy as np
from app.schemas.contracts import ProcessingError


def local_threshold(gray, mode, window_size, offset):
    values = gray.astype(np.float32)
    if mode == "adaptive_gaussian":
        mean = cv2.GaussianBlur(values, (window_size, window_size), 0, borderType=cv2.BORDER_REPLICATE)
    else:
        mean = cv2.boxFilter(values, -1, (window_size, window_size), borderType=cv2.BORDER_REPLICATE)
    if mode == "sauvola":
        square_mean = cv2.boxFilter(values * values, -1, (window_size, window_size), borderType=cv2.BORDER_REPLICATE)
        deviation = np.sqrt(np.maximum(square_mean - mean * mean, 0))
        return mean * (1 + 0.2 * (deviation / 128 - 1)) - offset
    return mean - offset


def clean_binary_mask(binary, min_component_area=0, max_hole_area=0):
    for value in (min_component_area, max_hole_area):
        if type(value) is not int or not 0 <= value <= 10000:
            raise ProcessingError("INVALID_CLEANUP_AREA", "Cleanup area must be an integer in 0..10000")
    result = binary.copy()
    if min_component_area:
        _, labels, stats, _ = cv2.connectedComponentsWithStats(result, connectivity=8)
        keep = stats[:, cv2.CC_STAT_AREA] >= min_component_area
        keep[0] = False
        result = np.where(keep[labels], 255, 0).astype(np.uint8)
    if max_hole_area:
        _, labels, stats, _ = cv2.connectedComponentsWithStats(255 - result, connectivity=4)
        fill = stats[:, cv2.CC_STAT_AREA] <= max_hole_area
        fill[0] = False
        # Background touching the frame is not a hole.
        fill[np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))] = False
        result[fill[labels]] = 255
    return result


def refine_grabcut(image, base_mask, strokes, iterations=5):
    """Use the old binary selection as probable labels, strokes as hard labels."""
    from PIL import Image, ImageDraw
    pixels = np.array(image.convert("RGBA"))
    visible = pixels[:, :, 3] > 0
    labels = np.where(np.asarray(base_mask) > 0, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
    canvas = Image.fromarray(labels)
    draw = ImageDraw.Draw(canvas)
    for stroke in strokes:
        points = [(int(point.x), int(point.y)) for point in stroke.points]
        value = cv2.GC_FGD if stroke.mode == "add" else cv2.GC_BGD
        radius = stroke.radius
        if len(points) > 1:
            draw.line(points, fill=value, width=radius * 2 + 1, joint="curve")
        for x, y in points:
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=value)
    labels = np.array(canvas)
    labels[~visible] = cv2.GC_BGD
    fg = (labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)
    if not fg.any() or fg.all():
        raise ProcessingError("GRABCUT_NEEDS_SEEDS", "Mark both foreground and background before refining")
    rgb = pixels[:, :, :3].copy()
    rgb[~visible] = 255
    cv2.setRNGSeed(0)
    try:
        cv2.grabCut(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), labels, None,
                    np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                    iterations, cv2.GC_INIT_WITH_MASK)
    except cv2.error as exc:
        raise ProcessingError("GRABCUT_FAILED", "Adjust foreground/background strokes or use direct brush correction") from exc
    binary = np.where(((labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)) & visible, 255, 0).astype(np.uint8)
    if not binary.any():
        raise ProcessingError("EMPTY_MASK", "No foreground after refinement; adjust the strokes")
    return Image.fromarray(binary)
