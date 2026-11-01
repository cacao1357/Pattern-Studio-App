"""Safe SVG palette replacement; unchanged geometry and immutable provenance."""
import xml.etree.ElementTree as ET
from app.services.vector import validate_svg
from app.storage import ServiceError


def recolor_svg(svg, size, mapping):
    validate_svg(svg, size)
    root = ET.fromstring(svg)
    mapping = {key.lower(): value.lower() for key, value in mapping.items()}
    available = {node.get("fill").lower() for node in root.iter() if node.get("fill") not in (None, "none")}
    if not set(mapping) <= available:
        raise ServiceError("SVG_COLOR_NOT_FOUND", "Choose colors present in the selected SVG", 422)
    for node in root.iter():
        fill = node.get("fill")
        if fill and fill.lower() in mapping:
            node.set("fill", mapping[fill.lower()])
    result = ET.tostring(root, encoding="unicode")
    return result, validate_svg(result, size)


def submit_recolor(store, payload, key, *, retry_of=None):
    source, data = store.read_asset(str(payload.input_asset_id))
    if source["kind"] != "svg":
        raise ServiceError("SVG_INPUT_REQUIRED", "Choose an editable SVG version", 422)
    recolor_svg(data.decode("utf-8"), (source["width"], source["height"]), payload.mapping)
    return store.submit("recolor-svg", source["asset_id"], {"mapping": payload.mapping}, key, retry_of=retry_of)


def execute_recolor(store, job, token):
    store.step(job["job_id"], token, "recolor-svg", "running")
    source, data = store.read_asset(job["input_asset_id"])
    svg, metadata = recolor_svg(data.decode("utf-8"), (source["width"], source["height"]), job["parameters"]["mapping"])
    # Preserve dimensions, coordinate space, original and generated-source attribution.
    inherited = {key: value for key, value in source.items()
                 if key not in {"asset_id", "sha256", "bytes", "created_at", "parents", "parameters"}}
    store.publish(job["job_id"], token, "recolor-svg", [{"data": svg.encode("utf-8"), "suffix": ".svg",
        "metadata": {**inherited, "kind": "svg", "source_asset_id": source["asset_id"],
            "generated_by_job_id": job["job_id"], "parents": [{"asset_id": source["asset_id"], "role": "palette_source"}],
            "parameters": {"algorithm": "safe-svg-palette-v1", "mapping": job["parameters"]["mapping"], **metadata}}}])
