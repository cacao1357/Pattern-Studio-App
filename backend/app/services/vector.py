"""VTracer 0.6.x adapter with explicit foreground quantization and SVG validation."""

from dataclasses import dataclass
import re
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image
import vtracer

from app.schemas.contracts import DEFAULT_LIMITS, ProcessingError, ResourceLimits, VectorOptions


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


def _contour_vectorize(pixels: np.ndarray, options: VectorOptions, limits: ResourceLimits) -> VectorResult:
    """Trace alpha boundaries as simplified, even-odd filled paths.

    This is the mask -> contour -> simplified closed curve route recommended by
    the CV experiments. It keeps holes instead of relying on RETR_EXTERNAL.
    """
    mask = (pixels[:, :, 3] >= 128).astype(np.uint8) * 255
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not contours or hierarchy is None:
        raise ProcessingError("EMPTY_SVG", "No visible contour reaches the alpha threshold")
    hierarchy = hierarchy[0]
    base_epsilon = {"low": 2.0, "medium": 1.0, "high": 0.5}[options.detail]
    epsilon = base_epsilon * max(1.0, min(mask.shape) / 512.0)
    min_area = max(2.0, mask.shape[0] * mask.shape[1] * 0.00002)
    paths = []
    holes = 0
    outer_count = 0
    for index, contour in enumerate(contours):
        if hierarchy[index][3] != -1:
            continue
        if cv2.contourArea(contour) < min_area:
            continue
        outer_count += 1
        rings = [contour]
        child = hierarchy[index][2]
        while child != -1:
            if cv2.contourArea(contours[child]) >= min_area:
                rings.append(contours[child])
                holes += 1
            child = hierarchy[child][0]
        data = []
        for ring in rings:
            approx = cv2.approxPolyDP(ring, epsilon, True).reshape(-1, 2)
            if len(approx) < 3:
                continue
            data.append("M " + f"{int(approx[0][0])},{int(approx[0][1])} " +
                        " ".join(f"L {int(x)},{int(y)}" for x, y in approx[1:]) + " Z")
        if data:
            paths.append({"d": "".join(data), "fill": "#1B2B54"})
    if not paths:
        raise ProcessingError("EMPTY_SVG", "No contour survived area or simplification thresholds")
    if len(paths) > limits.max_svg_paths:
        raise ProcessingError("SVG_PATH_LIMIT", "Contour tracing exceeds the path limit; reduce detail")
    root = ET.Element(f"{{{SVG_NS}}}svg", {
        "width": str(mask.shape[1]), "height": str(mask.shape[0]),
        "viewBox": f"0 0 {mask.shape[1]} {mask.shape[0]}",
    })
    group = ET.SubElement(root, f"{{{SVG_NS}}}g", {"fill": "#1B2B54", "fill-rule": "evenodd"})
    for path in paths:
        ET.SubElement(group, f"{{{SVG_NS}}}path", {"d": path["d"]})
    svg = ET.tostring(root, encoding="unicode")
    metadata = validate_svg(svg, (mask.shape[1], mask.shape[0]), limits=limits)
    metadata.update({
        "options": options.model_dump(), "mode": "contour", "contours": outer_count,
        "holes": holes, "epsilon": round(epsilon, 3), "min_area": round(min_area, 2),
        "alpha_threshold": 128, "alpha_policy": "binary_threshold_for_vector_only",
        "adapter_version": "contour-evenodd-v1", "fill_policy": "solid_ink",
    })
    return VectorResult(svg, metadata)


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
    if options.mode == "contour":
        return _contour_vectorize(pixels, options, limits)
    prepared = np.zeros(pixels.shape, np.uint8)
    if options.mode == "monochrome":
        prepared[visible] = (0, 0, 0, 255)
    else:
        foreground = Image.fromarray(pixels[:, :, :3][visible][None, :, :])
        quantized = foreground.quantize(colors=options.max_colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
        prepared[visible, :3] = np.asarray(quantized)[0]
        prepared[visible, 3] = 255
    actual_colors = len(np.unique(prepared[visible, :3], axis=0))
    kwargs = {"colormode": "color", "hierarchical": "cutout", "mode": "spline",
              "filter_speckle": 0, "color_precision": 8, "layer_difference": 1,
              "max_iterations": 10, **DETAILS[options.detail]}
    for name in ("length_threshold", "corner_threshold", "splice_threshold"):
        if getattr(options, name) is not None:
            kwargs[name] = getattr(options, name)
    # 0.6.x binary tracing ignores alpha. Both business modes use the RGBA color tracer.
    raw_svg = vtracer.convert_pixels_to_svg(
        [tuple(int(c) for c in p) for p in prepared.reshape(-1, 4)], image.size, **kwargs
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
    palette = np.unique(prepared[visible, :3], axis=0).astype(np.int32)
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
    root.set("viewBox", f"0 0 {image.width} {image.height}")
    svg = ET.tostring(root, encoding="unicode")
    metadata = validate_svg(svg, image.size, limits=limits)
    if len(metadata["svg_fill_colors"]) > options.max_colors:
        raise ProcessingError("VECTOR_PALETTE_LIMIT", "Tracer exceeded the requested foreground palette limit")
    metadata.update({"options": options.model_dump(), "actual_input_colors": actual_colors,
                     "alpha_threshold": 128, "alpha_policy": "binary_threshold_for_vector_only",
                     "adapter_version": "vtracer-0.6-rgba-v3", "tracer_parameters": kwargs,
                     "empty_generated_paths_removed": empty_path_count,
                     "tracer_fill_colors_remapped": len(remapped_colors),
                     "fill_policy": "nearest_selected_foreground_palette"})
    return VectorResult(svg, metadata)
