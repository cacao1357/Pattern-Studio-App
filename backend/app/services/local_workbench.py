"""Admission and deterministic local processing; deliberately no provider client."""

from io import BytesIO
import json
import math
from uuid import uuid4
import zipfile

from PIL import Image, ImageEnhance, ImageFilter

from app.schemas.contracts import BoundingBox, DEFAULT_LIMITS, VectorOptions
from app.schemas.workbench import (CropRequest, PrepareRequest, WorkingCopyRequest, EnhanceRequest,
    ExtractRequest, VectorRequest, PipelineRequest, ExportRequest)
from app.services.imaging import normalize_image, crop_image, extract_foreground, contour_line_art
from app.services.preparation import prepare_image, prepared_output_size
from app.services.vector import vectorize
from app.storage import ServiceError, canonical_json, digest, png_bytes
from app.workbench_store import WorkbenchStore, validate_key


RGB_KINDS = {"normalized_input", "cropped", "working_copy", "prepared", "enhanced", "transparent_png",
             "edit_candidate", "placed_generated_layer", "generated_basemap", "generated_layer", "composed_candidate", "accepted_repair"}
REQUESTS = {"crop": CropRequest, "prepare": PrepareRequest, "working-copy": WorkingCopyRequest, "enhance": EnhanceRequest,
            "extract": ExtractRequest, "vectorize": VectorRequest, "pipeline": PipelineRequest,
            "export": ExportRequest}
MAX_EXPORT_BYTES = 128 * 1024 * 1024


class LocalWorkbench:
    def __init__(self, store, secrets=()):
        self.store, self.secrets = store, secrets if callable(secrets) else tuple(s for s in secrets if s)

    def safe_text(self, value):
        if any(secret in value for secret in (self.secrets() if callable(self.secrets) else self.secrets)):
            raise ServiceError("CREDENTIAL_IN_INPUT", "Do not put credentials in filenames, notes, feedback or idempotency keys", 422)

    def upload(self, data, filename, source_note, key):
        validate_key(key)
        if len(source_note) > 1000 or not 1 <= len(filename) <= 200:
            raise ServiceError("INVALID_IMAGE_NOTE", "Use a filename up to 200 characters and a source note up to 1000 characters", 422)
        self.safe_text(filename + source_note + key)
        request_hash = digest(data + canonical_json([filename, source_note]).encode())
        existing = self.store.existing("images", key, request_hash)
        if existing:
            return self.store.get_image(existing), False
        normalized = normalize_image(data, filename)
        original_id, space = str(uuid4()), str(uuid4())
        original_size = normalized.metadata["input_size"]
        common = {"ai_inferred": False, "geometry_verified": True}
        original = {**common, "asset_id": original_id, "kind": "original", "width": original_size[0], "height": original_size[1],
                    "source_note": source_note, "source_evidence_status": "not_reviewed",
                    "coordinate_space_id": str(uuid4()), "original_format": normalized.metadata["original_format"]}
        canonical = {**common, "kind": "normalized_input", "width": normalized.image.width, "height": normalized.image.height,
                     "source_note": source_note, "source_evidence_status": "not_reviewed",
                     "original_width": original_size[0], "original_height": original_size[1], "original_asset_id": original_id,
                     "coordinate_space_id": space, "source_asset_id": original_id, "normalization": normalized.metadata,
                     "parents": [{"asset_id": original_id, "role": "original"}]}
        outputs = [{"data": data, "suffix": ".png" if normalized.metadata["original_format"] == "PNG" else ".jpg", "metadata": original},
                   {"data": png_bytes(normalized.image), "suffix": ".png", "metadata": canonical}]
        return self.store.add_image(outputs, source_note, key, request_hash)

    def submit(self, kind, payload, key, *, retry_of=None):
        validate_key(key)
        values = payload.model_dump(mode="json")
        self.safe_text(key + canonical_json(values))
        input_id = values.pop("input_asset_id", None)
        if kind == "export":
            total = 0
            for asset_id in values["asset_ids"]:
                metadata, path = self.store.get_asset(asset_id)
                if path.suffix == ".zip":
                    raise ServiceError("NESTED_EXPORT", "Select image or SVG versions instead of an existing ZIP", 422)
                total += metadata["bytes"]
            if total > MAX_EXPORT_BYTES:
                raise ServiceError("EXPORT_SIZE_LIMIT", "Selected files exceed the 128 MiB export limit", 413)
        else:
            metadata, _ = self.store.get_asset(input_id)
            if metadata["kind"] not in RGB_KINDS:
                raise ServiceError("RGB_INPUT_REQUIRED", "Choose a normalized or processed RGB/RGBA image version", 422)
            size = metadata["width"], metadata["height"]
            if kind == "crop":
                payload.bbox.within(size)
            if kind == "prepare":
                output_size = prepared_output_size(size, payload.rotation, payload.straighten)
                if output_size[0] * output_size[1] > DEFAULT_LIMITS.max_vector_pixels:
                    raise ServiceError("PREPARED_IMAGE_PIXEL_LIMIT", "Rotating and straightening would exceed the 1 megapixel local processing limit; choose a smaller working copy", 413)
            if kind == "extract" or kind == "pipeline":
                options = payload.extract if kind == "pipeline" else payload
                if options.bbox:
                    options.bbox.within(size)
                    if options.mode == "grabcut" and options.bbox.as_tuple() == (0, 0, *size):
                        raise ServiceError("GRABCUT_NEEDS_BACKGROUND", "Leave background outside the GrabCut rectangle", 422)
            working = kind == "pipeline" and payload.working_max_pixels is not None
            if kind not in {"crop", "working-copy"} and size[0] * size[1] > DEFAULT_LIMITS.max_vector_pixels and not working:
                raise ServiceError("WORKING_COPY_REQUIRED", "Create an explicit working copy of at most 1,000,000 pixels before local processing", 413)
        return self.store.submit(kind, input_id, values, key, retry_of=retry_of)

    def retry(self, job_id, key):
        old = self.store.get_job(job_id)
        if old["state"] != "failed":
            raise ServiceError("RETRY_NOT_ALLOWED", "Only a failed local job can be retried as a new version", 409)
        if old["kind"] == "recolor-svg":
            from app.schemas.svg_edit import RecolorRequest
            from app.services.svg_edit import submit_recolor
            request = RecolorRequest.model_validate({"input_asset_id": old["input_asset_id"], **old["parameters"]})
            self.safe_text(key + canonical_json(request.model_dump(mode="json")))
            return submit_recolor(self.store, request, key, retry_of=job_id)
        if old["kind"] in {"repair", "tile-preview"}:
            from app.schemas.finishing import RepairRequest, TileRequest
            from app.services.finishing_workbench import FinishingWorkbench
            helper = FinishingWorkbench(self.store, local=self)
            if old["kind"] == "repair":
                if not old["parameters"].get("provider_call_id"):
                    raise ServiceError("PAID_RETRY_REQUIRES_NEW_CONSENT", "Reconcile the previous repair call and explicitly reuse its archive; retry never generates another candidate", 409)
                return helper.repair(RepairRequest.model_validate({"input_asset_id": old["input_asset_id"], **old["parameters"]}), key, retry_of=job_id)
            return helper.tile(TileRequest.model_validate({"unit_asset_id": old["input_asset_id"], **old["parameters"]}), key, retry_of=job_id)
        if old["kind"] == "decompose-layers":
            raise ServiceError("PAID_RETRY_REQUIRES_NEW_CONSENT", "Use a new AI workflow with explicit consents, or continue locally; a paid attempt is never retried automatically", 409)
        if old["kind"] in {"compose-layers", "refine-mask"}:
            from app.schemas.assisted import ComposeLayersRequest, RefineMaskRequest
            from app.services.assisted_workbench import AssistedWorkbench
            values = {k: v for k, v in old["parameters"].items() if k != "ai_pipeline_id"}
            helper = AssistedWorkbench(self.store)
            # Validate the same immutable sources before enqueuing a linked retry.
            if old["kind"] == "compose-layers":
                request = ComposeLayersRequest.model_validate(values)
                helper.validate_selection(str(request.decomposition_job_id), request.layer_ids)
            else:
                request = RefineMaskRequest.model_validate(values)
            self.safe_text(key)
            return self.store.submit(old["kind"], old["input_asset_id"], values, key, retry_of=job_id)
        values = {k: v for k, v in old["parameters"].items() if k != "ai_pipeline_id"}
        if old["input_asset_id"]:
            values["input_asset_id"] = old["input_asset_id"]
        return self.submit(old["kind"], REQUESTS[old["kind"]].model_validate(values), key, retry_of=job_id)

    def feedback(self, payload, key):
        values = payload.model_dump(mode="json")
        self.safe_text(key + canonical_json(values))
        return self.store.add_feedback(values, key)


def _read_image(store, asset_id):
    metadata, data = store.read_asset(asset_id)
    with Image.open(BytesIO(data)) as image:
        image.load()
        return metadata, image.convert("RGBA")


def _output(image, kind, source, job_id, *, space=None, extra=None, asset_id=None, parents=None):
    return {"data": png_bytes(image), "suffix": ".png", "metadata": {
        "asset_id": asset_id or str(uuid4()), "kind": kind, "width": image.width, "height": image.height,
        "coordinate_space_id": space or source["coordinate_space_id"],
        "source_asset_id": source["asset_id"], "generated_by_job_id": job_id,
        "original_width": source.get("original_width", source["width"]),
        "original_height": source.get("original_height", source["height"]),
        "original_asset_id": source.get("original_asset_id"),
        "source_note": source.get("source_note", ""), "source_evidence_status": source.get("source_evidence_status", "not_reviewed"),
        "ai_inferred": source.get("ai_inferred", False), "geometry_verified": source.get("geometry_verified", False),
        "parents": parents or [{"asset_id": source["asset_id"], "role": "source_rgb"}], **(extra or {})}}


def execute_local(store: WorkbenchStore, job_id, token):
    """Called only by a bounded child. Each step publishes files and state together."""
    job = store.get_job(job_id)
    kind, params = job["kind"], job["parameters"]
    if kind in {"repair", "tile-preview"}:
        from app.services.finishing_workbench import execute_repair, execute_tile
        if kind == "repair":
            return execute_repair(store, job, token)
        return execute_tile(store, job, token)
    if kind in {"compose-layers", "refine-mask"}:
        from app.services.assisted_workbench import execute_assisted
        return execute_assisted(store, job, token)
    if kind == "recolor-svg":
        from app.services.svg_edit import execute_recolor
        return execute_recolor(store, job, token)
    if kind == "export":
        store.step(job_id, token, "export", "running")
        selected, content = [], []
        total = 0
        for asset_id in params["asset_ids"]:
            metadata, data = store.read_asset(asset_id)
            _, path = store.get_asset(asset_id)
            if path.suffix == ".zip":
                raise ServiceError("NESTED_EXPORT", "Nested ZIP exports are not supported")
            total += len(data)
            if total > MAX_EXPORT_BYTES:
                raise ServiceError("EXPORT_SIZE_LIMIT", "Selected versions exceed the export limit")
            selected.append({**metadata, "archive_name": asset_id + path.suffix})
            content.append((asset_id + path.suffix, data))
        # Reference complete lineage without silently adding other files to the ZIP.
        ancestors, pending = {}, [p["asset_id"] for a in selected for p in a.get("parents", [])]
        while pending:
            parent = pending.pop()
            if parent in ancestors or parent in params["asset_ids"]:
                continue
            if len(ancestors) >= 100:
                raise ServiceError("EXPORT_LINEAGE_LIMIT", "Export a shorter lineage of explicit versions")
            metadata, _ = store.get_asset(parent)
            ancestors[parent] = metadata
            pending.extend(p["asset_id"] for p in metadata.get("parents", []))
        manifest = {"schema_version": "local-s1-v1", "export_job_id": job_id, "selected_assets": selected,
                    "referenced_ancestors": list(ancestors.values()), "files_are_selected_versions_only": True,
                    "quality_review": "not_implied", "source_permission": "must_be_reviewed_separately"}
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for name, data in content:
                archive.writestr(name, data)
        store.publish(job_id, token, "export", [{"data": buffer.getvalue(), "suffix": ".zip", "metadata": {
            "kind": "zip", "generated_by_job_id": job_id, "ai_inferred": any(a.get("ai_inferred") for a in selected),
            "geometry_verified": all(a.get("geometry_verified", False) for a in selected),
            "selected_asset_ids": params["asset_ids"], "parents": [{"asset_id": a, "role": "selected_version"} for a in params["asset_ids"]]}}])
        return

    source, image = _read_image(store, job["input_asset_id"])
    extraction = dict(params["extract"]) if kind == "pipeline" else dict(params) if kind == "extract" else None

    def publish(name, outputs):
        return store.publish(job_id, token, name, outputs)

    if kind == "crop":
        store.step(job_id, token, "crop", "running")
        box = BoundingBox.model_validate(params["bbox"])
        cropped = crop_image(image, box)
        publish("crop", [_output(cropped, "cropped", source, job_id, space=str(uuid4()), extra={
            "transform": {"operation": "crop", "bbox": box.model_dump(), "input_size": list(image.size), "output_size": list(cropped.size)}})])
        return

    if kind == "prepare":
        store.step(job_id, token, "prepare", "running")
        prepared, transform = prepare_image(image, rotation=params["rotation"], straighten=params["straighten"])
        prepared_source = publish("prepare", [_output(prepared, "prepared", source, job_id, space=str(uuid4()),
            extra={"algorithm": "pillow-premultiplied-geometry-v1", "transform": transform})])[0]
        return prepared_source

    max_pixels = params.get("max_pixels") if kind == "working-copy" else params.get("working_max_pixels")
    if max_pixels is not None:
        store.step(job_id, token, "working-copy", "running")
        scale = min(1.0, math.sqrt(max_pixels / (image.width * image.height)))
        size = max(1, int(image.width * scale)), max(1, int(image.height * scale))
        original_size = image.size
        resized = image.copy() if size == image.size else image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")
        source = publish("working-copy", [_output(resized, "working_copy", source, job_id, space=str(uuid4()), extra={
            "transform": {"operation": "explicit_working_copy", "input_size": list(original_size), "output_size": list(size),
                          "scale_x": size[0] / original_size[0], "scale_y": size[1] / original_size[1], "resampling": "premultiplied_rgba_lanczos"}})])[0]
        image = resized
        if extraction and extraction.get("bbox"):
            box = extraction["bbox"]
            extraction["bbox"] = {"left": math.floor(box["left"] * size[0] / original_size[0]),
                                  "top": math.floor(box["top"] * size[1] / original_size[1]),
                                  "right": min(size[0], math.ceil(box["right"] * size[0] / original_size[0])),
                                  "bottom": min(size[1], math.ceil(box["bottom"] * size[1] / original_size[1]))}
        if kind == "working-copy":
            return

    enhancement = params.get("enhance") if kind == "pipeline" else params if kind == "enhance" else None
    if enhancement is not None:
        store.step(job_id, token, "enhance", "running")
        rgb = image.convert("RGB")
        if enhancement["denoise"]:
            rgb = rgb.filter(ImageFilter.MedianFilter(3 if enhancement["denoise"] == 1 else 5))
        rgb = ImageEnhance.Brightness(rgb).enhance(enhancement["brightness"])
        rgb = ImageEnhance.Contrast(rgb).enhance(enhancement.get("contrast", 1.0))
        if enhancement["sharpen"]:
            rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1, percent=round(100 * enhancement["sharpen"]), threshold=3))
        rgb.putalpha(image.getchannel("A"))
        source = publish("enhance", [_output(rgb, "enhanced", source, job_id, extra={"algorithm": "pillow-local-enhance-v2", "parameters": enhancement})])[0]
        image = rgb
        if kind == "enhance":
            return

    if extraction is not None:
        store.step(job_id, token, "extract", "running")
        options = dict(extraction)
        if options.get("bbox"):
            options["bbox"] = BoundingBox.model_validate(options["bbox"])
        separated = extract_foreground(image, **options)
        mask_id = str(uuid4())
        contour, contour_meta = contour_line_art(separated.foreground_mask)
        assets = publish("extract", [
            _output(separated.foreground_mask, "foreground_mask", source, job_id, asset_id=mask_id, extra={
                "mask_kind": "foreground_mask", "values": [0, 255], "source_rgb_asset_id": source["asset_id"], "parameters": separated.metadata}),
            _output(separated.rgba, "transparent_png", source, job_id, extra={
                "source_rgb_asset_id": source["asset_id"], "source_mask_asset_id": mask_id, "parameters": separated.metadata},
                parents=[{"asset_id": source["asset_id"], "role": "source_rgb"}, {"asset_id": mask_id, "role": "foreground_mask"}]),
            _output(contour, "contour_line_art", source, job_id, extra={"source_mask_asset_id": mask_id, **contour_meta},
                parents=[{"asset_id": mask_id, "role": "foreground_mask"}])])
        source, image = assets[1], separated.rgba
        if kind == "extract":
            return

    if kind in {"pipeline", "vectorize"}:
        store.step(job_id, token, "vectorize", "running")
        options = VectorOptions.model_validate(params["vector"] if kind == "pipeline" else params)
        result = vectorize(image, options)
        publish("vectorize", [{"data": result.svg.encode("utf-8"), "suffix": ".svg", "metadata": {
            "kind": "svg", "width": image.width, "height": image.height,
            "coordinate_space_id": source["coordinate_space_id"], "source_asset_id": source["asset_id"],
            "original_width": source.get("original_width", source["width"]),
            "original_height": source.get("original_height", source["height"]),
            "original_asset_id": source.get("original_asset_id"),
            "ai_inferred": source.get("ai_inferred", False), "geometry_verified": source.get("geometry_verified", False),
            "generated_by_job_id": job_id, "parents": [{"asset_id": source["asset_id"], "role": "vector_input"}],
            "parameters": result.metadata}}])
