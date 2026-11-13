"""Repair review and integer tiling on the existing immutable asset/job store."""

from io import BytesIO
from uuid import uuid4

import numpy as np
from PIL import Image

from app.schemas.contracts import BoundingBox, DEFAULT_LIMITS, ProcessingError
from app.schemas.provider import ValidationRequest
from app.services.imaging import rectangle_mask
from app.services.local_workbench import _output, _read_image
from app.services.repair import composite_region
from app.storage import ServiceError, canonical_json, digest
from app.workbench_store import validate_key
from app.services.provider_validation import PROVIDER_INPUT_KINDS


MAX_REPAIR_PIXELS = 1_048_576
TILE_UNIT_KINDS = {"cropped", "transparent_png", "lineart", "accepted_repair"}


def archived_edit(store, call, values):
    request = call["request"]
    expected = {"input_asset_id": values["input_asset_id"], "bbox": values["bbox"],
                "intent": values["intent"], "size": values["size"]}
    if (call["state"] != "succeeded" or request.get("operation") != "edit" or
            any(request.get(k) != v for k, v in expected.items())):
        raise ServiceError("REPAIR_ARCHIVE_MISMATCH", "Choose a successful single edit for this exact input, rectangle, intent and size", 422)
    outputs = call["result"].get("outputs", [])
    if len(outputs) != 1:
        raise ServiceError("REPAIR_CANDIDATE_COUNT", "A repair must have exactly one archived candidate", 422)
    candidate, _ = store.get_asset(outputs[0]["asset"]["asset_id"])
    if (candidate["kind"] != "edit_candidate" or candidate.get("provider_call_id") != call["call_id"] or
            candidate.get("source_asset_id") != values["input_asset_id"]):
        raise ServiceError("REPAIR_ARCHIVE_MISMATCH", "The archived candidate does not belong to this repair input", 422)
    return candidate


class FinishingWorkbench:
    def __init__(self, store, settings=None, local=None):
        self.store, self.settings, self.local = store, settings, local

    def repair(self, payload, key, *, retry_of=None):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.local.safe_text(key + canonical_json(values))
        input_id = values.pop("input_asset_id")
        request_hash = digest(canonical_json({"input": input_id, "parameters": values, "retry_of": retry_of}).encode())
        existing = self.store.existing("jobs/repair" if retry_of is None else "retry/" + retry_of, key, request_hash)
        if existing:
            return self.store.get_job(existing)
        source, _ = self.store.get_asset(input_id)
        if source["kind"] not in PROVIDER_INPUT_KINDS:
            raise ServiceError("PROVIDER_INPUT_KIND", "Choose a saved input, crop, working copy or accepted result for repair", 422)
        payload.bbox.within((source["width"], source["height"]))
        if source["width"] * source["height"] > MAX_REPAIR_PIXELS:
            raise ServiceError("REPAIR_SIZE_LIMIT", "Repair currently supports at most 1024x1024 pixels in total; explicitly prepare a smaller normalized input", 413)
        _, damage_image, damage_source = self._damage(values.get("damage_mask_asset_id"), source)
        if damage_source == "synthetic":
            editing = np.asarray(rectangle_mask((source["width"], source["height"]), payload.bbox)) > 0
            if np.any((np.asarray(damage_image) > 0) & ~editing):
                raise ServiceError("DAMAGE_OUTSIDE_EDIT", "Synthetic damage must be contained by the edit rectangle", 422)
        if values["provider_call_id"]:
            archived_edit(self.store, self.store.get_call(values["provider_call_id"]), {"input_asset_id": input_id, **values})
        elif self.settings is None or self.settings.blockers():
            raise ServiceError("PROVIDER_DISABLED", "New AI repair is disabled; reuse an archived edit or continue local processing", 503)
        elif (not 262_144 <= source["width"] * source["height"] <= 25_000_000 or
              not 1 / 16 <= source["width"] / source["height"] <= 16 or source["bytes"] > DEFAULT_LIMITS.max_upload_bytes):
            raise ServiceError("PROVIDER_INPUT_DIMENSIONS", "Prepare a normalized input within the existing provider limits", 422)
        return self.store.submit("repair", input_id, values, key, retry_of=retry_of)

    def _damage(self, asset_id, source):
        if not asset_id:
            return None, None, None
        metadata, data = self.store.read_asset(asset_id)
        if (metadata.get("kind") != "damage_mask" or metadata.get("source_asset_id") != source["asset_id"] or
                (metadata.get("width"), metadata.get("height"), metadata.get("coordinate_space_id")) !=
                (source["width"], source["height"], source["coordinate_space_id"]) or
                metadata.get("damage_source") not in {"synthetic", "annotated"}):
            raise ServiceError("DAMAGE_MASK_SOURCE_MISMATCH", "Choose a binary damage mask registered to this exact input and annotation source", 422)
        with Image.open(BytesIO(data)) as loaded:
            loaded.load()
            image = loaded.copy()
        from app.services.imaging import validate_binary_mask
        validate_binary_mask(image, (source["width"], source["height"]))
        return metadata, image, metadata["damage_source"]

    def get_repair(self, job_id):
        job = self.store.get_job(job_id)
        if job["kind"] != "repair":
            raise ServiceError("REPAIR_NOT_FOUND", "Choose a repair job", 404)
        assets = job["result"]["assets"]
        def find(kind):
            return next((a for a in assets if a["kind"] == kind), None)
        candidate, composite, edit = find("edit_candidate"), find("repair_composite"), find("edit_mask")
        decision = self.store.get_repair_decision(job_id)
        state = ("accepted" if decision["action"] == "accept" else "rejected") if decision else "waiting_user" if job["state"] == "succeeded" else job["state"]
        return {"repair_job_id": job_id, "input_asset_id": job["input_asset_id"], "state": state,
                "revision": 2 if decision else 1, "candidate_asset": candidate, "composited_asset": composite,
                "edit_mask": edit, "blend_weight": find("blend_weight"), "difference_map": find("difference_map"),
                "damage_mask_asset_id": job["parameters"].get("damage_mask_asset_id"),
                "metrics": (composite or edit or {}).get("metrics", {}),
                "warnings": (composite or edit or {}).get("warnings", []), "decision": decision,
                "error": job["error"], "parameters": job["parameters"]}

    def decide(self, job_id, payload, key):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.local.safe_text(key + canonical_json(values))
        scope = "repair-decision/" + job_id
        if self.store.existing(scope, key, digest(canonical_json(values).encode())):
            return self.get_repair(job_id)
        repair = self.get_repair(job_id)
        if repair["revision"] != values["revision"] or repair["state"] != "waiting_user":
            raise ServiceError("STALE_REVISION", "Reload this completed, undecided repair before deciding", 409)
        accepted = None
        if values["action"] == "accept":
            selected_id = values["selected_asset_id"]
            allowed = [a for a in (repair["candidate_asset"], repair["composited_asset"]) if a]
            selected = next((a for a in allowed if a["asset_id"] == selected_id), None)
            if selected is None:
                raise ServiceError("INVALID_REPAIR_SELECTION", "Choose the local composite or full candidate belonging to this repair", 422)
            full = selected["kind"] == "edit_candidate"
            if full and not values["accept_full_image_changes"]:
                raise ServiceError("FULL_IMAGE_CONSENT_REQUIRED", "Explicitly acknowledge that the full AI candidate may change the entire image", 422)
            source, _ = self.store.get_asset(repair["input_asset_id"])
            _, data = self.store.read_asset(selected_id)
            references = [{"asset_id": selected_id, "role": "accepted_repair_version"},
                          {"asset_id": source["asset_id"], "role": "original_input_reference"}]
            for field in ("candidate_asset", "edit_mask", "blend_weight"):
                if repair[field] and repair[field]["asset_id"] != selected_id:
                    references.append({"asset_id": repair[field]["asset_id"], "role": field})
            accepted = {"data": data, "suffix": ".png", "metadata": {
                **{k: v for k, v in selected.items() if k not in {"asset_id", "sha256", "bytes", "created_at", "parents", "generated_by_job_id"}},
                "asset_id": str(uuid4()), "kind": "accepted_repair", "repair_job_id": job_id,
                "source_asset_id": selected_id, "source_input_asset_id": source["asset_id"],
                "original_width": source.get("original_width", source["width"]),
                "original_height": source.get("original_height", source["height"]),
                "original_asset_id": source.get("original_asset_id"),
                "source_note": source.get("source_note", ""), "source_evidence_status": source.get("source_evidence_status", "not_reviewed"),
                "ai_inferred": True, "geometry_verified": False, "parents": references, "needs_user_review": False,
                "repair_choice": "full_candidate" if full else "local_composite", "entire_image_may_change": full}}
        self.store.decide_repair(job_id, values, key, accepted)
        return self.get_repair(job_id)

    def tile(self, payload, key, *, retry_of=None):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.local.safe_text(key + canonical_json(values))
        unit_id = values.pop("unit_asset_id")
        request_hash = digest(canonical_json({"input": unit_id, "parameters": values, "retry_of": retry_of}).encode())
        existing = self.store.existing("jobs/tile-preview" if retry_of is None else "retry/" + retry_of, key, request_hash)
        if existing:
            return self.store.get_job(existing)
        source, _ = self.store.get_asset(unit_id)
        if source["kind"] not in TILE_UNIT_KINDS:
            raise ServiceError("TILE_UNIT_REQUIRED", "Select a saved crop, transparent PNG, line-art PNG or accepted repair", 422)
        if source["width"] * source["height"] * payload.rows * payload.cols > DEFAULT_LIMITS.max_tile_pixels:
            raise ServiceError("TILE_PIXEL_LIMIT", "The tiled result exceeds 4 MP; choose a smaller unit without resizing the saved original", 413)
        return self.store.submit("tile-preview", unit_id, values, key, retry_of=retry_of)


def execute_repair(store, job, token, settings=None, *, transport=None):
    params, job_id = job["parameters"], job["job_id"]
    source, image = _read_image(store, job["input_asset_id"])
    service = FinishingWorkbench(store)
    damage, damage_image, damage_source = service._damage(params.get("damage_mask_asset_id"), source)
    store.step(job_id, token, "repair-candidate", "running")
    if params.get("provider_call_id"):
        call = store.get_call(params["provider_call_id"])
    else:
        from app.providers.seedream import SeedreamClient
        from app.services.provider_validation import ProviderValidationService
        if settings is None:
            raise ServiceError("PROVIDER_DISABLED", "New repair requires the configured provider worker", 503)
        request = ValidationRequest(input_asset_id=job["input_asset_id"], operation="edit", intent=params["intent"],
            bbox=BoundingBox.model_validate(params["bbox"]), size=params["size"],
            consent_to_upload=params["consent_to_upload"], consent_to_charge=params["consent_to_charge"])
        call, _ = ProviderValidationService(settings, store, SeedreamClient(settings, transport=transport)).submit(request, "ai-" + job_id)
    store.record_provider_result(job_id, token, call, step_name="repair-candidate")
    if call["state"] != "succeeded":
        raise ServiceError(call["result"].get("error_code", "REPAIR_CANDIDATE_FAILED"),
                           "The AI repair candidate is unavailable; reconcile the existing call before generating again")
    candidate = archived_edit(store, call, {"input_asset_id": job["input_asset_id"], **params})
    _, generated = _read_image(store, candidate["asset_id"])
    store.step(job_id, token, "protect-region", "running")
    box = BoundingBox.model_validate(params["bbox"])
    edit_id, weight_id, composite_id = str(uuid4()), str(uuid4()), str(uuid4())
    common = {"repair_job_id": job_id, "provider_call_id": call["call_id"], "bbox": params["bbox"],
              "source_input_asset_id": source["asset_id"], "candidate_asset_id": candidate["asset_id"],
              "damage_mask_asset_id": params.get("damage_mask_asset_id")}
    mask_parents = [{"asset_id": source["asset_id"], "role": "source_rgb"}]
    if damage:
        mask_parents.append({"asset_id": damage["asset_id"], "role": "damage_mask"})
    try:
        result = composite_region(image, generated, box, feather_px=params["feather_px"], damage_mask=damage_image, damage_source=damage_source)
    except ProcessingError as error:
        if error.code != "CANDIDATE_SPACE_MISMATCH":
            raise
        store.publish(job_id, token, "protect-region", [_output(rectangle_mask(image.size, box), "edit_mask", source, job_id,
            asset_id=edit_id, parents=mask_parents, extra={**common, "mask_kind": "edit_mask", "values": [0, 255],
            "annotation_source": "user_rectangle", "metrics": {}, "warnings": [error.code]})])
        return
    if result.metrics["outside_changed_pixels"] or result.metrics["outside_max_error"]:
        raise ServiceError("OUTSIDE_REGION_CHANGED", "Region protection failed; the candidate remains preview only", 409)
    metrics = result.metrics
    edit = _output(result.edit_mask, "edit_mask", source, job_id, asset_id=edit_id, parents=mask_parents,
        extra={**common, "mask_kind": "edit_mask", "values": [0, 255], "annotation_source": "user_rectangle", "metrics": metrics, "warnings": metrics["warnings"]})
    weight = _output(result.blend_weight, "blend_weight", source, job_id, asset_id=weight_id,
        parents=[{"asset_id": edit_id, "role": "edit_mask"}], extra={**common, "value_range": [0, 255], "feather_px": params["feather_px"]})
    parents = mask_parents + [{"asset_id": candidate["asset_id"], "role": "full_ai_candidate"},
                              {"asset_id": edit_id, "role": "edit_mask"}, {"asset_id": weight_id, "role": "blend_weight"}]
    composite = _output(result.image, "repair_composite", source, job_id, asset_id=composite_id, parents=parents,
        extra={**common, "ai_inferred": True, "geometry_verified": False, "metrics": metrics, "warnings": metrics["warnings"],
               "algorithm": metrics["algorithm"], "needs_user_review": True})
    difference = np.max(np.abs(np.asarray(result.image).astype(np.int16) - np.asarray(image).astype(np.int16)), axis=2).astype(np.uint8)
    diff = _output(Image.fromarray(difference), "difference_map", source, job_id,
        parents=[{"asset_id": source["asset_id"], "role": "original_input_reference"}, {"asset_id": composite_id, "role": "local_composite"}],
        extra={**common, "visualization_only": True, "algorithm": "max-absolute-rgba-difference-v1", "ai_inferred": True, "geometry_verified": False})
    store.publish(job_id, token, "protect-region", [edit, weight, composite, diff])


def execute_tile(store, job, token):
    params, job_id = job["parameters"], job["job_id"]
    source, image = _read_image(store, job["input_asset_id"])
    if source["kind"] not in TILE_UNIT_KINDS or image.width * image.height * params["rows"] * params["cols"] > DEFAULT_LIMITS.max_tile_pixels:
        raise ServiceError("TILE_PIXEL_LIMIT", "Choose an explicit cropped unit within the 4 MP output limit", 413)
    store.step(job_id, token, "tile-preview", "running")
    tiled = Image.new("RGBA", (image.width * params["cols"], image.height * params["rows"]))
    for row in range(params["rows"]):
        for col in range(params["cols"]):
            tiled.paste(image, (col * image.width, row * image.height))
    store.publish(job_id, token, "tile-preview", [_output(tiled, "tile_preview", source, job_id, space=str(uuid4()),
        extra={"unit_asset_id": source["asset_id"], "rows": params["rows"], "cols": params["cols"],
               "seam_observation": params["seam_observation"], "seam_observation_source": "human" if params["seam_observation"] != "not_reviewed" else "not_reviewed",
               "seamless_claim": False, "transform": {"operation": "integer_repeat", "unit_size": list(image.size),
               "output_size": list(tiled.size), "placements": [[col * image.width, row * image.height] for row in range(params["rows"]) for col in range(params["cols"])],
               "resampling": "none"}})])
