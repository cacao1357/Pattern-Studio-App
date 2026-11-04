"""Central algorithm and data-contract versions for the P0 data layer.

Every generated asset records one of these identifiers so a later audit can
answer "which revision of the algorithm produced this file?" without guessing
from prose in the metadata.
"""

MANIFEST_SCHEMA_VERSION = "local-s1-v2"
GRADE_VERSION = "p0-v1"
FINGERPRINT_VERSION = "p0-v1"
PATTERN_SCORE_VERSION = "p0-v1"
NORMALIZATION_VERSION = "normalize-image-v1"
PROVENANCE_VERSION = "p0-v1"

ALGORITHM_BY_KIND = {
    "original": "upload-original-v1",
    "normalized_input": NORMALIZATION_VERSION,
    "cropped": "crop-bbox-v1",
    "working_copy": "premultiplied-rgba-lanczos-v1",
    "prepared": "pillow-premultiplied-geometry-v1",
    "enhanced": "pillow-local-enhance-v2",
    "foreground_mask": "local-extraction-v2",
    "transparent_png": "local-extraction-v2",
    "contour_line_art": "opencv-findContours-RETR_LIST-v1",
    "lineart": "lineart-global-local-v2",
    "svg": "vtracer-0.6-rgba-v3",
    "tile_preview": "integer-repeat-v1",
    "edge_candidate": "classic-region-candidate-v1",
    "region_candidate": "classic-region-candidate-v1",
    "composed_candidate": "ordered-source-over-v1",
    "generated_basemap": "seedream-adapter-v1",
    "generated_layer": "seedream-adapter-v1",
    "placed_generated_layer": "seedream-placement-v1",
    "edit_candidate": "seedream-adapter-v1",
    "repair_composite": "premultiplied-rgba-local-composite-v1",
    "accepted_repair": "premultiplied-rgba-local-composite-v1",
    "edit_mask": "rectangle-mask-v1",
    "blend_weight": "rectangle-feather-v1",
    "difference_map": "max-absolute-rgba-difference-v1",
    "foreground": "local-extraction-v2",
    "zip": "zip-export-v2",
}

_UNKNOWN = "unknown-v1"


def algorithm_version(kind: str) -> str:
    """Return the recorded revision for a generated asset kind."""
    return ALGORITHM_BY_KIND.get(kind, _UNKNOWN)


def snapshot() -> dict:
    """A compact, JSON-safe summary for health checks and export manifests."""
    return {
        "manifest": MANIFEST_SCHEMA_VERSION,
        "grade": GRADE_VERSION,
        "fingerprint": FINGERPRINT_VERSION,
        "pattern_score": PATTERN_SCORE_VERSION,
        "normalization": NORMALIZATION_VERSION,
        "provenance": PROVENANCE_VERSION,
        "extraction": ALGORITHM_BY_KIND["transparent_png"],
        "vector": ALGORITHM_BY_KIND["svg"],
    }
