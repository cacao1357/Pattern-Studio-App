"""Restore reviewed local patches to their immutable source canvas."""

from app.schemas.contracts import BoundingBox
from app.storage import ServiceError, png_bytes


def restoration_plan(store, source):
    """Resolve native crops and coordinate-preserving steps without guessing geometry."""
    current, seen, crops = source, set(), []
    left = top = 0
    unsupported = False
    while current["kind"] not in {"normalized_input", "original", "accepted_repair"}:
        if current["asset_id"] in seen or len(seen) >= 128:
            raise ServiceError("REPAIR_RESTORE_INVALID", "Repair source history is cyclic or too deep", 422)
        seen.add(current["asset_id"])
        parent_id = current.get("source_asset_id")
        if not parent_id:
            raise ServiceError("REPAIR_RESTORE_INVALID", "Repair source history is missing its parent", 422)
        parent, _ = store.get_asset(parent_id)
        if current["kind"] == "cropped":
            transform = current.get("transform", {})
            if not isinstance(transform, dict):
                raise ServiceError("REPAIR_RESTORE_INVALID", "Crop transform metadata is invalid", 422)
            try:
                box = BoundingBox.model_validate(transform.get("bbox", {}))
                box.within((parent["width"], parent["height"]))
                valid = (transform.get("operation") == "crop" and
                         transform.get("input_size") == [parent["width"], parent["height"]] and
                         transform.get("output_size") == [current["width"], current["height"]] and
                         (box.right - box.left, box.bottom - box.top) == (current["width"], current["height"]))
            except ValueError:
                valid = False
            if not valid:
                raise ServiceError("REPAIR_RESTORE_INVALID", "Crop coordinates cannot be verified against the source canvas", 422)
            left += box.left
            top += box.top
            crops.append(current["asset_id"])
        elif (current["kind"] != "enhanced" or
              any(current.get(key) != parent.get(key) for key in ("width", "height", "coordinate_space_id"))):
            unsupported = True
        current = parent
    # A complete native-size canvas needs no backfill, even when it is a
    # transparent, composed or rotated derivative. A reduced working copy does.
    if not crops and (source["width"], source["height"]) == (current["width"], current["height"]):
        return None
    if unsupported:
        raise ServiceError("REPAIR_RESTORE_UNSUPPORTED",
                           "Repair backfill requires native crops without rotation or resizing; crop the full canvas again", 422)
    return {"algorithm": "native-crop-repair-backfill-v1", "canvas_asset_id": current["asset_id"],
            "patch_input_asset_id": source["asset_id"], "crop_asset_ids": crops,
            "offset": {"left": left, "top": top},
            "input_size": [source["width"], source["height"]],
            "output_size": [current["width"], current["height"]]}


def restore_accepted_patch(store, source, selected, edit_mask):
    from app.services.local_workbench import _read_image
    from app.services.imaging import validate_binary_mask

    plan = restoration_plan(store, source)
    if plan is None:
        return None
    if edit_mask is None:
        raise ServiceError("REPAIR_RESTORE_INVALID", "The reviewed repair is missing its edit mask", 422)
    canvas, image = _read_image(store, plan["canvas_asset_id"])
    _, patch = _read_image(store, selected["asset_id"])
    mask_meta, mask_rgba = _read_image(store, edit_mask["asset_id"])
    if (patch.size != (source["width"], source["height"]) or
            mask_meta.get("coordinate_space_id") != source["coordinate_space_id"]):
        raise ServiceError("REPAIR_RESTORE_INVALID", "Repair patch and mask must match the crop coordinates", 422)
    mask = mask_rgba.convert("L")
    validate_binary_mask(mask, patch.size)
    # Paste with the binary edit mask, not alpha compositing: preserve RGBA exactly
    # and do not apply feathering a second time to the already blended patch.
    offset = plan["offset"]
    image.paste(patch, (offset["left"], offset["top"]), mask)
    return canvas, png_bytes(image), plan
