"""S2 candidate decisions and deterministic foreground-mask correction."""

from io import BytesIO
import math
from uuid import uuid4

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from app import versions
from app.schemas.assisted import ComposeLayersRequest, RefineMaskRequest
from app.schemas.contracts import DEFAULT_LIMITS, VectorOptions, ProcessingError
from app.schemas.provider import ValidationRequest
from app.schemas.workbench import PipelineRequest
from app.services.imaging import contour_line_art
from app.services.segmentation import refine_grabcut
from app.services.local_workbench import RGB_KINDS, _output, _read_image
from app.services.vector import vectorize
from app.storage import ServiceError, canonical_json
from app.workbench_store import validate_key
from app.providers.prompts import decomposition_prompt
from app.services.workflow import WORKFLOW_ID, WORKFLOW_VERSION


def archived_layers(store, call, input_id):
    if call["request"].get("operation") != "decompose" or call["request"].get("input_asset_id") != input_id:
        raise ServiceError("DECOMPOSITION_INPUT_MISMATCH", "Choose a decomposition archived for this exact input", 422)
    if call["state"] != "succeeded":
        raise ServiceError("DECOMPOSITION_NOT_READY", "This decomposition has no complete archived candidates", 409)
    outputs = call["result"].get("outputs", [])
    bases = [o for o in outputs if o.get("z_index") == 0]
    if len(bases) != 1 or not 2 <= len(outputs) <= 17:
        raise ServiceError("DECOMPOSITION_ARCHIVE_INVALID", "The archive requires a basemap and bounded candidate layers", 409)
    basemap, _ = store.get_asset(bases[0]["asset"]["asset_id"])
    if basemap["kind"] != "generated_basemap" or basemap.get("provider_call_id") != call["call_id"]:
        raise ServiceError("DECOMPOSITION_ARCHIVE_INVALID", "The basemap does not belong to this provider call", 409)
    layers, seen = [], set()
    for item in sorted(outputs, key=lambda o: o["z_index"]):
        if item["z_index"] == 0:
            continue
        if item["z_index"] <= 0 or item["z_index"] in seen or not item.get("placed_asset"):
            raise ServiceError("DECOMPOSITION_ARCHIVE_INVALID", "Each candidate requires unique ordering and archived placement", 409)
        seen.add(item["z_index"])
        asset, _ = store.get_asset(item["asset"]["asset_id"])
        placed, _ = store.get_asset(item["placed_asset"]["asset_id"])
        if (asset["kind"] != "generated_layer" or placed["kind"] != "placed_generated_layer" or
            placed.get("provider_call_id") != call["call_id"] or asset.get("provider_call_id") != call["call_id"] or
            placed.get("basemap_asset_id") != basemap["asset_id"] or
            (placed["width"], placed["height"], placed["coordinate_space_id"]) !=
            (basemap["width"], basemap["height"], basemap["coordinate_space_id"])):
            raise ServiceError("DECOMPOSITION_ARCHIVE_INVALID", "Candidate placement, ownership or coordinates are invalid", 409)
        layers.append({"layer_id": placed["asset_id"], "z_index": item["z_index"], "bbox": item.get("bbox"),
                       "asset": asset, "placed_asset": placed})
    return {"provider_call_id": call["call_id"], "basemap": basemap, "layers": layers,
            "ai_inferred": True, "geometry_verified": False}


class AssistedWorkbench:
    def __init__(self, store, settings=None, local=None):
        self.store, self.settings, self.local = store, settings, local

    def layers(self, job_id):
        job = self.store.get_job(job_id)
        if job["kind"] != "decompose-layers" or job["state"] != "succeeded":
            raise ServiceError("LAYERS_NOT_READY", "Wait for a successful decomposition before choosing layers", 409)
        call_id = job["result"].get("provider_call_id")
        result = archived_layers(self.store, self.store.get_call(call_id), job["input_asset_id"])
        return {"decomposition_job_id": job_id, **result}

    def create_pipeline(self, payload, key):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.local.safe_text(key + canonical_json(values))
        input_id = values.pop("input_asset_id")
        from app.storage import digest
        request_hash = digest(canonical_json({"input": input_id, "parameters": values}).encode())
        existing = self.store.existing("pipelines/ai", key, request_hash)
        if existing:
            return self.store.get_ai_flow(existing)
        source, _ = self.store.get_asset(input_id)
        if source["kind"] != "normalized_input":
            raise ServiceError("PROVIDER_INPUT_KIND", "Choose the normalized original input for AI decomposition", 422)
        archived = None
        if values["provider_call_id"]:
            layers = archived_layers(self.store, self.store.get_call(values["provider_call_id"]), input_id)
            archived = {"assets": [layers["basemap"]] + [a for layer in layers["layers"] for a in (layer["asset"], layer["placed_asset"])],
                        "steps": [{"name": "decompose-layers", "state": "succeeded"}], "provider_call_id": values["provider_call_id"]}
        elif self.settings is None or self.settings.blockers():
            raise ServiceError("PROVIDER_DISABLED", "AI generation is unavailable; continue local processing or reuse an archived decomposition", 503)
        else:
            width, height = source["width"], source["height"]
            if not 262_144 <= width * height <= 25_000_000 or not 1 / 16 <= width / height <= 16:
                raise ServiceError("PROVIDER_INPUT_DIMENSIONS", "AI decomposition requires 262144..25000000 pixels and an aspect ratio in 1/16..16", 422)
            if source["bytes"] > DEFAULT_LIMITS.max_upload_bytes:
                raise ServiceError("NORMALIZED_TOO_LARGE", "Create an explicit smaller input before sending this image", 413)
        prompt_text = decomposition_prompt(values["prompt_version"])
        snapshot = {"id": WORKFLOW_ID, "version": WORKFLOW_VERSION, "snapshot": {
            "model": self.settings.model if self.settings else None,
            "base_url": self.settings.base_url if self.settings else None,
            "prompt_version": values["prompt_version"], "prompt_text": prompt_text,
            "input_asset_id": input_id, "size": values["size"], "vector": values["vector"],
            "selection_policy": values["selection_policy"], "provider_call_id": values["provider_call_id"]}}
        if archived:
            call = self.store.get_call(values["provider_call_id"])
            snapshot["snapshot"].update({k: call["request"].get(k) for k in ("model", "base_url", "prompt_version", "prompt_text", "size")})
        return self.store.create_ai_flow(input_id, values, key, archived_result=archived, snapshot=snapshot)

    def rerun(self, flow_id, payload, key):
        """Create an explicit local branch from immutable, workflow-owned assets."""
        from app.storage import digest
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.local.safe_text(key + canonical_json(values))
        existing = self.store.existing("rerun/" + flow_id, key, digest(canonical_json(values).encode()))
        if existing:
            return self.store.get_job(existing)
        flow = self.store.get_ai_flow(flow_id)
        if flow["revision"] != payload.revision:
            raise ServiceError("STALE_REVISION", "Reload the workflow before creating a local branch", 409)
        if payload.action == "compose":
            self.validate_selection(flow["decomposition_job_id"], values["layer_ids"])
            kind, input_id = "compose-layers", flow["input_asset_id"]
            params = {"decomposition_job_id": flow["decomposition_job_id"], "layer_ids": values["layer_ids"],
                      "vector": values["vector"] if "vector" in payload.model_fields_set else flow["vector"]}
        else:
            input_id = values["input_asset_id"]
            if input_id not in flow["recovery"]["vector_input_asset_ids"]:
                raise ServiceError("WORKFLOW_INPUT_MISMATCH", "Choose a PNG produced by this workflow or its local correction", 422)
            metadata, _ = self.store.get_asset(input_id)
            if metadata["width"] * metadata["height"] > DEFAULT_LIMITS.max_vector_pixels:
                raise ServiceError("WORKING_COPY_REQUIRED", "Create a working copy before vectorization", 413)
            kind, params = "vectorize", values["vector"]
        return self.store.submit_workflow_branch(flow_id, values, key, kind, input_id, params)

    def validate_selection(self, decomposition_id, layer_ids):
        layers = self.layers(decomposition_id)
        selected = set(str(layer_id) for layer_id in layer_ids)
        allowed = {layer["layer_id"] for layer in layers["layers"]}
        if not selected or len(selected) != len(layer_ids) or not selected <= allowed:
            raise ServiceError("INVALID_LAYER_SELECTION", "Choose unique candidate layers from this decomposition; the basemap is reference only", 422)
        return layers

    def compose(self, payload, key):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.validate_selection(values["decomposition_job_id"], values["layer_ids"])
        decomposition = self.store.get_job(values["decomposition_job_id"])
        return self.store.submit("compose-layers", decomposition["input_asset_id"], values, key)

    def refine(self, payload, key):
        validate_key(key)
        values = payload.model_dump(mode="json")
        source, _ = self.store.get_asset(values["source_rgb_asset_id"])
        mask, _ = self.store.get_asset(values["base_mask_asset_id"])
        if source["kind"] not in RGB_KINDS or mask["kind"] != "foreground_mask":
            raise ServiceError("FOREGROUND_MASK_REQUIRED", "Choose a foreground mask and its registered source RGB", 422)
        if ((mask["width"], mask["height"], mask["coordinate_space_id"]) !=
            (source["width"], source["height"], source["coordinate_space_id"]) or
            mask.get("source_rgb_asset_id", mask.get("source_asset_id")) != source["asset_id"]):
            raise ServiceError("MASK_SOURCE_MISMATCH", "Mask dimensions, coordinate space and exact source RGB must match", 422)
        if source["width"] * source["height"] > DEFAULT_LIMITS.max_vector_pixels:
            raise ServiceError("WORKING_COPY_REQUIRED", "Use an explicitly sized working copy before foreground correction", 413)
        if any(p.x >= source["width"] or p.y >= source["height"] for s in payload.strokes for p in s.points):
            raise ServiceError("BRUSH_OUT_OF_BOUNDS", "Brush points must be inside the current image", 422)
        return self.store.submit("refine-mask", source["asset_id"], values, key)

    def continue_pipeline(self, flow_id, payload, key, *, actor="human"):
        validate_key(key)
        values = payload.model_dump(mode="json")
        scope = "continue/" + flow_id
        from app.storage import digest
        if self.store.existing(scope, key, digest(canonical_json(values).encode())):
            return self.store.get_ai_flow(flow_id)
        flow = self.store.get_ai_flow(flow_id)
        if flow["revision"] != payload.revision:
            raise ServiceError("STALE_REVISION", "Reload the workflow before making another decision", 409)
        if flow["decision"] is not None or flow["state"] not in {"waiting_user", "failed"}:
            raise ServiceError("DECISION_NOT_AVAILABLE", "Wait for candidate archival or a failed AI attempt", 409)
        kind, parameters = None, None
        vector = values["vector"] if "vector" in payload.model_fields_set else flow["vector"]
        if payload.action == "select_layers":
            self.validate_selection(flow["decomposition_job_id"], values["layer_ids"])
            kind, parameters = "compose-layers", {"decomposition_job_id": flow["decomposition_job_id"],
                                                 "layer_ids": values["layer_ids"], "vector": vector}
        elif payload.action == "use_local":
            request = PipelineRequest.model_validate({"input_asset_id": flow["input_asset_id"], "extract": values["extract"],
                                                       "vector": vector or flow["vector"]})
            # Reuse admission without submitting a second job outside the decision transaction.
            metadata, _ = self.store.get_asset(flow["input_asset_id"])
            if metadata["width"] * metadata["height"] > DEFAULT_LIMITS.max_vector_pixels:
                raise ServiceError("WORKING_COPY_REQUIRED", "Create a working copy and use the local workbench for this large input", 413)
            if request.extract.bbox:
                request.extract.bbox.within((metadata["width"], metadata["height"]))
                if request.extract.mode == "grabcut" and request.extract.bbox.as_tuple() == (0, 0, metadata["width"], metadata["height"]):
                    raise ServiceError("GRABCUT_NEEDS_BACKGROUND", "Leave background outside the GrabCut rectangle", 422)
            kind, parameters = "pipeline", request.model_dump(mode="json", exclude={"input_asset_id"})
        return self.store.continue_ai_flow(flow_id, values, key, kind=kind, parameters=parameters, actor=actor)


def _publish_mask_products(store, job, token, source, image, mask, *, params, extra=None):
    if mask.mode != "L" or not set(np.unique(np.asarray(mask))) <= {0, 255}:
        raise ServiceError("INVALID_FOREGROUND_MASK", "Foreground correction requires a binary L mask")
    if mask.getbbox() is None:
        raise ProcessingError("EMPTY_MASK", "The foreground is empty; keep some foreground before saving")
    mask_id = str(uuid4())
    rgba = image.copy()
    rgba.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    contour, contour_meta = contour_line_art(mask)
    mask_parents = [{"asset_id": source["asset_id"], "role": "source_rgb"}]
    if params.get("base_mask_asset_id"):
        mask_parents.append({"asset_id": params["base_mask_asset_id"], "role": "previous_foreground_mask"})
    outputs = [_output(mask, "foreground_mask", source, job["job_id"], asset_id=mask_id, parents=mask_parents, extra={
        "mask_kind": "foreground_mask", "values": [0, 255], "source_rgb_asset_id": source["asset_id"],
        "parameters": params, **(extra or {})}),
        _output(rgba, "transparent_png", source, job["job_id"], extra={
            "source_rgb_asset_id": source["asset_id"], "source_mask_asset_id": mask_id, "parameters": params, **(extra or {})},
            parents=[{"asset_id": source["asset_id"], "role": "source_rgb"}, {"asset_id": mask_id, "role": "foreground_mask"}]),
        _output(contour, "contour_line_art", source, job["job_id"], extra={"source_mask_asset_id": mask_id, **contour_meta},
            parents=[{"asset_id": mask_id, "role": "foreground_mask"}])]
    return store.publish(job["job_id"], token, "refine-mask", outputs)


def execute_assisted(store, job, token):
    params, job_id = job["parameters"], job["job_id"]
    service = AssistedWorkbench(store)
    if job["kind"] == "refine-mask":
        request = RefineMaskRequest.model_validate({k: v for k, v in params.items() if k != "ai_pipeline_id"})
        source, image = _read_image(store, params["source_rgb_asset_id"])
        _, data = store.read_asset(params["base_mask_asset_id"])
        with Image.open(BytesIO(data)) as loaded:
            loaded.load()
            mask = loaded.copy()
        if mask.mode != "L" or mask.size != image.size or not set(np.unique(np.asarray(mask))) <= {0, 255}:
            raise ServiceError("INVALID_FOREGROUND_MASK", "The registered foreground mask is not binary or aligned")
        store.step(job_id, token, "refine-mask", "running")
        if request.invert:
            mask = ImageOps.invert(mask)
        if request.denoise:
            mask = mask.filter(ImageFilter.MedianFilter(3 if request.denoise == 1 else 5))
        if request.algorithm == "grabcut":
            mask = refine_grabcut(image, mask, request.strokes, request.iterations)
        draw = ImageDraw.Draw(mask)
        for stroke in request.strokes if request.algorithm == "brush" else []:
            points = [(math.floor(p.x), math.floor(p.y)) for p in stroke.points]
            value, radius = (255 if stroke.mode == "add" else 0), stroke.radius
            if len(points) > 1:
                draw.line(points, fill=value, width=radius * 2 + 1, joint="curve")
            for x, y in points:
                draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=value)
        _publish_mask_products(store, job, token, source, image, mask, params=request.model_dump(mode="json"),
            extra={"base_mask_asset_id": params["base_mask_asset_id"], "annotation_source": "human_foreground_correction",
                   "algorithm": "seeded-grabcut-v1" if request.algorithm == "grabcut" else "binary-foreground-brush-v1"})
        return

    layers = service.validate_selection(params["decomposition_job_id"], params["layer_ids"])
    store.step(job_id, token, "compose-layers", "running")
    base = layers["basemap"]
    source_input, _ = store.get_asset(job["input_asset_id"])
    canvas = Image.new("RGBA", (base["width"], base["height"]), (0, 0, 0, 0))
    selected = set(params["layer_ids"])
    ordered = [layer for layer in layers["layers"] if layer["layer_id"] in selected]
    for layer in ordered:
        _, image = _read_image(store, layer["layer_id"])
        canvas.alpha_composite(image)
    alpha = canvas.getchannel("A")
    mask = alpha.point(lambda value: 255 if value >= 128 else 0)
    if mask.getbbox() is None:
        raise ProcessingError("EMPTY_MASK", "Selected layers have no foreground at the recorded alpha threshold")
    candidate_id, mask_id = str(uuid4()), str(uuid4())
    source = {**source_input, **base, "original_width": source_input.get("original_width", source_input["width"]),
              "original_height": source_input.get("original_height", source_input["height"]),
              "source_note": source_input.get("source_note", ""), "ai_inferred": True, "geometry_verified": False}
    parents = [{"asset_id": layer["layer_id"], "role": "selected_candidate_layer"} for layer in ordered]
    parents.extend({"asset_id": layer["asset"]["asset_id"], "role": "generated_layer_source"} for layer in ordered)
    parents.append({"asset_id": base["asset_id"], "role": "basemap_coordinate_reference"})
    origin = "human"
    if params.get("ai_pipeline_id"):
        origin = (store.get_ai_flow(params["ai_pipeline_id"]).get("decision") or {}).get("actor", "human")
    extra = {"provider_call_id": layers["provider_call_id"], "decomposition_job_id": params["decomposition_job_id"],
             "selected_layer_ids": [layer["layer_id"] for layer in ordered], "alpha_threshold": 128,
             "source_rgb_asset_id": candidate_id, "source_input_asset_id": job["input_asset_id"],
             "composition": "ordered_source_over", "selection_origin": origin,
             "human_decision": "selected_candidate_layers" if origin == "human" else None}
    contour, contour_meta = contour_line_art(mask)
    outputs = [_output(mask, "foreground_mask", source, job_id, asset_id=mask_id, parents=parents,
                        extra={**extra, "mask_kind": "foreground_mask", "values": [0, 255]}),
               _output(canvas, "composed_candidate", source, job_id, asset_id=candidate_id,
                       parents=parents + [{"asset_id": mask_id, "role": "foreground_mask"}, {"asset_id": job["input_asset_id"], "role": "original_input_reference"}],
                       extra={**extra, "source_mask_asset_id": mask_id}),
               _output(contour, "contour_line_art", source, job_id, parents=[{"asset_id": mask_id, "role": "foreground_mask"}],
                       extra={**contour_meta, "source_mask_asset_id": mask_id})]
    published = store.publish(job_id, token, "compose-layers", outputs)
    if params.get("vector"):
        store.step(job_id, token, "vectorize", "running")
        result = vectorize(canvas, VectorOptions.model_validate(params["vector"]))
        candidate = published[1]
        store.publish(job_id, token, "vectorize", [{"data": result.svg.encode(), "suffix": ".svg", "metadata": {
            **{key: value for key, value in candidate.items() if key not in {"asset_id", "sha256", "bytes", "created_at", "parents", "kind"}},
            "kind": "svg", "source_asset_id": candidate_id, "parents": [{"asset_id": candidate_id, "role": "vector_input"}],
            "algorithm_version": versions.algorithm_version("svg"),
            "parameters": result.metadata}}])


def execute_decomposition(store, job, token, settings, *, transport=None):
    """One budgeted provider attempt, never an implicit provider retry."""
    from app.providers.seedream import SeedreamClient
    from app.services.provider_validation import ProviderValidationService
    from dataclasses import replace
    snapshot = job["parameters"].get("execution_snapshot")
    if snapshot:
        settings = replace(settings, model=snapshot["model"], base_url=snapshot["base_url"])
    request = ValidationRequest(input_asset_id=job["input_asset_id"], operation="decompose", intent="separate_pattern",
                                prompt_version=job["parameters"].get("prompt_version", "s0-seedream-v1"),
                                size=job["parameters"]["size"], consent_to_upload=job["parameters"]["consent_to_upload"],
                                consent_to_charge=job["parameters"]["consent_to_charge"])
    store.step(job["job_id"], token, "decompose-layers", "running")
    call, _ = ProviderValidationService(settings, store, SeedreamClient(settings, transport=transport)).submit(
        request, "ai-" + job["job_id"], prompt_text=snapshot.get("prompt_text") if snapshot else None)
    store.record_provider_result(job["job_id"], token, call)
    if call["state"] != "succeeded":
        raise ServiceError(call["result"].get("error_code", "DECOMPOSITION_FAILED"),
                           "AI candidates are unavailable; keep the input and continue locally. No automatic generation was started.")
    archived_layers(store, call, job["input_asset_id"])
