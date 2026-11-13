"""S0 inputs, one actual provider attempt, immutable outputs and provenance."""

from io import BytesIO
import re
from uuid import uuid4

from PIL import Image

from app.config import Settings
from app.providers.base import ImageProvider
from app import versions
from app.providers.seedream import PROMPT_VERSION, ProviderFailure, SeedreamClient, prepare_payload
from app.schemas.contracts import DEFAULT_LIMITS
from app.schemas.provider import ValidationRequest
from app.services import quality
from app.services.imaging import normalize_image
from app.storage import ServiceError, Store, png_bytes

INHERITED_META_KEYS = ("image_id", "content_id", "grade", "grade_version", "split", "license",
                       "source_type", "source_name", "source_url", "collected_at", "batch_id",
                       "provenance_status", "normalization_version")

PROVIDER_INPUT_KINDS = {"normalized_input", "cropped", "working_copy", "prepared", "enhanced",
                        "accepted_repair", "composed_candidate", "transparent_png"}


def validate_provider_input(metadata):
    if metadata.get("kind") not in PROVIDER_INPUT_KINDS:
        raise ServiceError("PROVIDER_INPUT_KIND", "Choose a saved input, crop, working copy or accepted result", 422)
    width, height = metadata["width"], metadata["height"]
    if not 262_144 <= width * height <= 25_000_000 or not 1 / 16 <= width / height <= 16:
        raise ServiceError("PROVIDER_INPUT_DIMENSIONS", "Provider input requires 262144..25000000 pixels and an aspect ratio in 1/16..16", 422)
    if metadata["bytes"] > DEFAULT_LIMITS.max_upload_bytes:
        raise ServiceError("NORMALIZED_TOO_LARGE", "Create an explicit smaller input before sending this image", 413)


class ProviderValidationService:
    def __init__(self, settings: Settings, store: Store, client: ImageProvider):
        self.settings, self.store, self.client = settings, store, client

    def upload(self, data: bytes, filename: str) -> dict:
        normalized = normalize_image(data, filename)
        normalized_png = png_bytes(normalized.image)
        if len(normalized_png) > DEFAULT_LIMITS.max_upload_bytes:
            raise ServiceError("NORMALIZED_TOO_LARGE", "The normalized PNG exceeds the input byte limit; create an explicit smaller working copy", 413)
        space = str(uuid4())
        original = self.store.put_asset(data, ".png" if normalized.metadata["original_format"] == "PNG" else ".jpg",
                                       {"kind": "original", "ai_inferred": False, "original_format": normalized.metadata["original_format"],
                                        "algorithm_version": versions.algorithm_version("original")})
        asset = self.store.put_asset(normalized_png, ".png", {
            "kind": "normalized_input", "width": normalized.image.width, "height": normalized.image.height,
            "coordinate_space_id": space, "ai_inferred": False, "geometry_verified": True,
            "algorithm_version": versions.algorithm_version("normalized_input"),
            "source_asset_id": original["asset_id"], "normalization": normalized.metadata,
        })
        return {"original": original, "normalized": asset}

    def submit(self, request: ValidationRequest, key: str, *, prompt_text: str | None = None) -> tuple[dict, bool]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", key):
            raise ServiceError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key requires 16..128 ASCII letters, digits, underscores or hyphens")
        if any(secret and secret in key for secret in (self.settings.api_token.get_secret_value(), self.settings.ark_api_key.get_secret_value())):
            raise ServiceError("IDEMPOTENCY_KEY_INVALID", "Use an independent random idempotency key")
        if self.settings.blockers():
            raise ServiceError("PROVIDER_DISABLED", "Configure the server-side key before calling Seedream", 503)
        metadata, source_png = self.store.read_asset(str(request.input_asset_id))
        validate_provider_input(metadata)
        inherited = {key: metadata.get(key) for key in INHERITED_META_KEYS if metadata.get(key) not in (None, "")}
        payload = prepare_payload(request, source_png, self.settings)
        if prompt_text is not None:
            if request.operation not in {"decompose", "lineart"} or not isinstance(prompt_text, str) or not 1 <= len(prompt_text) <= 2000:
                raise ServiceError("PROMPT_SNAPSHOT_INVALID", "The stored decomposition prompt is unavailable", 409)
            payload["prompt"] = prompt_text
        snapshot = {**request.model_dump(mode="json"), "model": self.settings.model,
                    "prompt_version": request.prompt_version if request.operation in {"decompose", "lineart"} else PROMPT_VERSION,
                    "prompt_text": payload["prompt"], "base_url": self.settings.base_url,
                    "coordinate_space_id": metadata["coordinate_space_id"],
                    "input_size": [metadata["width"], metadata["height"]], "watermark": False,
                    "requested_size": payload.get("size")}
        call, created = self.store.reserve(key, snapshot, metadata["sha256"],
                                          reservation=0, budget=0, max_calls=1)
        if not created:
            return call, False
        call_id = call["call_id"]
        try:
            generated = self.client.generate(payload, request.operation)
            basemap_space = str(uuid4())
            outputs = []
            basemap = None
            target = (metadata["width"], metadata["height"]) if request.operation in {"edit", "lineart"} else None
            for output in generated.outputs:
                layer_space = basemap_space if output.z_index == 0 else str(uuid4())
                kind = "generated_basemap" if request.operation == "decompose" and output.z_index == 0 else "generated_layer" if request.operation == "decompose" else "lineart" if request.operation == "lineart" else "edit_candidate"
                image = output.image
                transform = None
                if target is not None and image.size != target:
                    provider_ratio = image.width / image.height
                    input_ratio = target[0] / target[1]
                    if abs(provider_ratio - input_ratio) / input_ratio <= 0.02:
                        image = image.convert("RGBa").resize(target, Image.Resampling.LANCZOS).convert("RGBA")
                        transform = {"from": [output.image.width, output.image.height], "to": list(target),
                                     "resampling": "premultiplied_rgba_lanczos",
                                     "reason": "provider_output_geometry"}
                lineart_metadata = None
                if request.operation == "lineart":
                    from app.services.lineart import normalize_cloud_lineart
                    lineart = normalize_cloud_lineart(image)
                    image, lineart_metadata = lineart.image, lineart.metadata
                asset_meta = {
                    **inherited, "kind": kind, "width": image.width, "height": image.height,
                    "coordinate_space_id": layer_space, "ai_inferred": True, "geometry_verified": False,
                    "source_asset_id": str(request.input_asset_id), "provider_call_id": call_id,
                    "algorithm_version": versions.algorithm_version(kind),
                }
                if request.operation == "lineart":
                    asset_meta.update(method="cloud", prompt_version=request.prompt_version,
                                      algorithm_version="seedream-lineart-v2-transparent", needs_user_review=True,
                                      parameters=lineart_metadata,
                                      model=generated.actual_model or self.settings.model)
                if payload.get("size"):
                    asset_meta["requested_size"] = payload["size"]
                if transform:
                    asset_meta["geometry_transform"] = transform
                if kind == "generated_layer":
                    asset_meta["quality_metrics"] = quality.pattern_metrics(image)
                asset = self.store.put_asset(png_bytes(image), ".png", asset_meta)
                item = {"asset": asset, "z_index": output.z_index, "bbox": output.bbox.model_dump() if output.bbox else None,
                        "bbox_source": output.bbox_source, "basemap_coordinate_space_id": basemap_space}
                if output.z_index == 0:
                    basemap = asset
                else:
                    box = output.bbox
                    # This is provider-defined placement on its output basemap, not input alignment.
                    resized = output.image.convert("RGBa").resize((box.right - box.left, box.bottom - box.top), Image.Resampling.LANCZOS).convert("RGBA")
                    canvas = Image.new("RGBA", generated.outputs[0].image.size, (0, 0, 0, 0))
                    canvas.paste(resized, (box.left, box.top))
                    item["placed_asset"] = self.store.put_asset(png_bytes(canvas), ".png", {
                        **inherited,
                        "kind": "placed_generated_layer", "width": canvas.width, "height": canvas.height,
                        "coordinate_space_id": basemap_space, "ai_inferred": True, "geometry_verified": False,
                        "source_asset_id": asset["asset_id"], "provider_call_id": call_id,
                        "basemap_asset_id": basemap["asset_id"], "placement": box.model_dump(),
                        "algorithm_version": versions.algorithm_version("placed_generated_layer"),
                        "resampling": "premultiplied_rgba_lanczos",
                    })
                outputs.append(item)
            result = {"outputs": outputs, "request_id": generated.request_id, "actual_model": generated.actual_model,
                      "usage": generated.usage, "elapsed_ms": generated.elapsed_ms,
                      "needs_reconcile": False, "needs_user_review": True, "geometry_verified": False,
                      "note": "Candidates are unreviewed model outputs; no layer was automatically selected and no repair was accepted."}
            return self.store.finish(call_id, "succeeded", result), True
        except ProviderFailure as error:
            return self.store.finish(call_id, error.state, {"error_code": error.code, "request_id": error.request_id,
                                    "provider_http_status": error.http_status,
                                    "provider_error_code": error.provider_code,
                                    "needs_reconcile": error.state == "outcome_unknown", "automatic_retry": False}), True
        except Exception:
            # Archive/decoder failures after admission must never cause another generation.
            return self.store.finish(call_id, "outcome_unknown", {"error_code": "LOCAL_ARCHIVE_OR_EXECUTION_FAILED",
                                    "needs_reconcile": True, "automatic_retry": False}), True
