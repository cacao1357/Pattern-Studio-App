"""VTracer 0.6.x adapter with explicit foreground quantization and SVG validation."""

from dataclasses import dataclass
import re
import xml.etree.ElementTree as ET

import numpy as np
import cv2
from PIL import Image
import vtracer

from app.schemas.contracts import DEFAULT_LIMITS, ProcessingError, ResourceLimits, VectorOptions
from app.versions import VECTOR_VERSION


SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
DETAILS = {
    "low": {"corner_threshold": 90, "length_threshold": 8.0, "splice_threshold": 90, "path_precision": 2},
    "medium": {"corner_threshold": 60, "length_threshold": 4.0, "splice_threshold": 60, "path_precision": 3},
    "high": {"corner_threshold": 45, "length_threshold": 1.0, "splice_threshold": 45, "path_precision": 4},
}


@dataclass
class VectorResult:
    svg: str
    metadata: dict


def _pixel_rectangles(mask: np.ndarray) -> str:
    """Exact pixel union, coalescing identical horizontal runs vertically.

    Used only for topology-sensitive components; ordinary contours stay splines.
    Adjacent rectangles share boundaries and introduce no background or opacity.
    """
    active, rectangles = {}, []
    for y, row in enumerate(mask):
        edges = np.flatnonzero(np.diff(np.pad(row.astype(np.int8), (1, 1))))
        runs = set(zip(edges[::2].tolist(), edges[1::2].tolist()))
        for run in list(active):
            if run not in runs:
                rectangles.append((*run, active.pop(run), y))
        for run in runs:
            active.setdefault(run, y)
    rectangles.extend((*run, top, len(mask)) for run, top in active.items())
    return " ".join(f"M{x} {top}h{end-x}v{bottom-top}h{x-end}Z"
                    for x, end, top, bottom in sorted(rectangles))


def validate_svg(svg: str, size: tuple[int, int], *, limits: ResourceLimits = DEFAULT_LIMITS) -> dict:
    if len(svg.encode("utf-8")) > limits.max_svg_bytes:
        raise ProcessingError("SVG_SIZE_LIMIT", "SVG exceeds the byte limit")
    if "<!DOCTYPE" in svg.upper() or "<!ENTITY" in svg.upper():
        raise ProcessingError("UNSAFE_SVG", "SVG document declarations are not accepted")
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise ProcessingError("INVALID_SVG", "SVG is not valid XML") from exc
    if root.tag != f"{{{SVG_NS}}}svg":
        raise ProcessingError("INVALID_SVG", "SVG root namespace is invalid")
    if root.get("width") != str(size[0]) or root.get("height") != str(size[1]) or root.get("viewBox") != f"0 0 {size[0]} {size[1]}":
        raise ProcessingError("SVG_SPACE_MISMATCH", "SVG dimensions do not match the selected input")
    allowed = {
        "svg": {"version", "width", "height", "viewBox"},
        "g": {"transform", "fill", "fill-rule"},
        "path": {"d", "fill", "transform", "fill-rule"},
    }
    paths = []
    for element in root.iter():
        tag = element.tag.removeprefix(f"{{{SVG_NS}}}")
        if element.tag != f"{{{SVG_NS}}}{tag}" or tag not in allowed or set(element.attrib) - allowed[tag]:
            raise ProcessingError("UNSAFE_SVG", "SVG contains an unexpected element or attribute")
        fill = element.get("fill")
        if fill and not re.fullmatch(r"#[0-9A-Fa-f]{6}|none", fill):
            raise ProcessingError("UNSAFE_SVG", "SVG fills must be local solid colors")
        transform = element.get("transform")
        if transform and not re.fullmatch(r"translate\([\d.eE+,\s-]+\)", transform):
            raise ProcessingError("UNSAFE_SVG", "SVG transform is outside the generated subset")
        if tag == "path":
            d = element.get("d", "")
            if not re.fullmatch(r"[MmZzLlHhVvCcSsQqTtAa0-9.eE+,\s-]+", d) or not re.search(r"[LlHhVvCcSsQqTtAa]", d):
                raise ProcessingError("EMPTY_SVG", "SVG contains an empty or invalid path")
            paths.append(element)
    if not paths:
        raise ProcessingError("EMPTY_SVG", "SVG must contain drawn paths")
    if len(paths) > limits.max_svg_paths:
        raise ProcessingError("SVG_PATH_LIMIT", "SVG exceeds the path limit; reduce detail or work size")
    return {"path_count": len(paths), "svg_bytes": len(svg.encode("utf-8")),
            "svg_fill_colors": sorted({p.get("fill") for p in paths if p.get("fill") not in {None, "none"}})}


def vectorize(
    image: Image.Image, options: VectorOptions | None = None, *, limits: ResourceLimits = DEFAULT_LIMITS
) -> VectorResult:
    options = options or VectorOptions()
    if image.width * image.height > limits.max_vector_pixels:
        raise ProcessingError("VECTOR_PIXEL_LIMIT", "Use an explicitly resized working asset before vectorization")
    pixels = np.asarray(image.convert("RGBA"))
    visible = pixels[:, :, 3] >= 128
    if not visible.any():
        raise ProcessingError("EMPTY_MASK", "No foreground reaches the vector alpha threshold")
    prepared = np.zeros(pixels.shape, np.uint8)
    if options.mode == "monochrome":
        prepared[visible] = (0, 0, 0, 255)
    else:
        foreground = Image.fromarray(pixels[:, :, :3][visible][None, :, :])
        quantized = foreground.quantize(colors=options.max_colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
        prepared[visible, :3] = np.asarray(quantized)[0]
        prepared[visible, 3] = 255
    palette = np.unique(prepared[visible, :3], axis=0).astype(np.int32)
    actual_colors = len(palette)
    # VTracer's spline fitter drops singleton clusters. Preserve small independent
    # color components exactly as pixel-union subpaths, rather than speckle-filtering
    # them. Remove them from the tracer input to avoid drawing them twice.
    # This is color-local: a tiny contrasting mark inside a large shape matters too.
    trace_pixels = prepared.copy()
    small_paths = []
    preserved_pixels = 0
    preserved_holes = 0
    exact_pixels = 0
    for color in palette:
        mask = (visible & np.all(prepared[:, :, :3] == color, axis=2)).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        small_labels = np.flatnonzero((stats[:, cv2.CC_STAT_AREA] <= 4) & (np.arange(count) != 0))
        # A one-pixel enclosed hole is also omitted by the spline fitter. For
        # its surrounding color component use an exact pixel union, keeping the
        # hole open without trying to guess which generated spline contains it.
        hole_count, _, hole_stats, _ = cv2.connectedComponentsWithStats(1-mask, connectivity=4)
        hole_ids = np.flatnonzero((hole_stats[:, cv2.CC_STAT_AREA] == 1) & (np.arange(hole_count) != 0))
        enclosing = set()
        for hole_id in hole_ids:
            x, y = hole_stats[hole_id, :2]
            if 0 < x < image.width-1 and 0 < y < image.height-1:
                enclosing.update(int(labels[yy, xx]) for yy, xx in ((y-1,x),(y+1,x),(y,x-1),(y,x+1)))
                preserved_holes += 1
        enclosing.discard(0)
        selected = np.union1d(small_labels, list(enclosing))
        if not len(selected):
            continue
        exact_mask = np.isin(labels, selected)
        ys, xs = np.nonzero(exact_mask)
        d = _pixel_rectangles(exact_mask)
        small_paths.append((d, "#" + "".join(f"{int(c):02X}" for c in color)))
        preserved_pixels += int(stats[small_labels, cv2.CC_STAT_AREA].sum())
        exact_pixels += len(xs)
        trace_pixels[ys, xs] = 0
    kwargs = {"colormode": "color", "hierarchical": "cutout", "mode": "spline",
              "filter_speckle": 0, "color_precision": 8, "layer_difference": 1,
              "max_iterations": 10, **DETAILS[options.detail]}
    for name in ("length_threshold", "corner_threshold", "splice_threshold"):
        if getattr(options, name) is not None:
            kwargs[name] = getattr(options, name)
    # 0.6.x binary tracing ignores alpha. Both business modes use the RGBA color tracer.
    raw_svg = vtracer.convert_pixels_to_svg(
        [tuple(int(c) for c in p) for p in trace_pixels.reshape(-1, 4)], image.size, **kwargs
    )
    if len(raw_svg.encode("utf-8")) > limits.max_svg_bytes:
        raise ProcessingError("SVG_SIZE_LIMIT", "SVG exceeds the byte limit; reduce detail or work size")
    root = ET.fromstring(raw_svg)
    # VTracer emits empty placeholder paths for some tiny components. They draw
    # nothing; drop only those generated placeholders, keeping strict validation.
    empty_path_count = 0
    for parent in root.iter():
        for child in list(parent):
            if child.tag == f"{{{SVG_NS}}}path" and not child.get("d", "").strip():
                parent.remove(child)
                empty_path_count += 1
    # Cluster averaging in VTracer 0.6.x can invent dozens of fill colors even
    # from an already quantized image. Constrain fills to the selected palette.
    remapped_colors = set()
    for element in root.iter():
        fill = element.get("fill", "")
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", fill):
            color = np.array([int(fill[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.int32)
            nearest = palette[np.argmin(np.sum((palette - color) ** 2, axis=1))]
            replacement = "#" + "".join(f"{int(c):02X}" for c in nearest)
            if fill.upper() != replacement:
                remapped_colors.add(fill.upper())
            element.set("fill", replacement)
    for d, fill in small_paths:
        ET.SubElement(root, f"{{{SVG_NS}}}path", {"d": d, "fill": fill})
    root.set("viewBox", f"0 0 {image.width} {image.height}")
    svg = ET.tostring(root, encoding="unicode")
    metadata = validate_svg(svg, image.size, limits=limits)
    if len(metadata["svg_fill_colors"]) > options.max_colors:
        raise ProcessingError("VECTOR_PALETTE_LIMIT", "Tracer exceeded the requested foreground palette limit")
    metadata.update({"options": options.model_dump(), "actual_input_colors": actual_colors,
                     "alpha_threshold": 128, "alpha_policy": "binary_threshold_for_vector_only",
                     "adapter_version": VECTOR_VERSION, "tracer_parameters": kwargs,
                     "selected_palette": ["#" + "".join(f"{int(c):02X}" for c in color) for color in palette],
                     "small_component_policy": "exact_pixel_subpaths_area_le_4_connectivity_4",
                     "small_component_pixels_preserved": preserved_pixels,
                     "singleton_holes_preserved": preserved_holes,
                     "exact_component_pixels": exact_pixels,
                     "singleton_hole_policy": "exact_surrounding_color_component_pixel_union",
                     "empty_generated_paths_removed": empty_path_count,
                     "tracer_fill_colors_remapped": len(remapped_colors),
                     "fill_policy": "nearest_selected_foreground_palette"})
    return VectorResult(svg, metadata)
