"""Offline LeftRefill adapter using the existing immutable repair review flow."""

import importlib.util
import json
import os
from pathlib import Path
from uuid import uuid4

import numpy as np
from PIL import Image

from app.config import PROJECT_ROOT
from app.schemas.contracts import BoundingBox
from app.services.imaging import rectangle_mask
from app.storage import ServiceError


MODEL_DIR = PROJECT_ROOT / "model" / "leftrefill"
MODEL_VERSION = "leftrefill-textile-1108-ddim20-v1"
BASE_MODEL_ENV = "PATTERN_STUDIO_LEFTREFILL_BASE_MODEL"
BASE_FILES = (
    "scheduler/scheduler_config.json", "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
    "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
    "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors",
)


def base_model_path():
    value = os.environ.get(BASE_MODEL_ENV, "").strip()
    return Path(value).expanduser().resolve() if value else MODEL_DIR / "base"


def model_capability():
    """Only inspect small configs/file presence; never import Torch or hash weights."""
    result = {"available": False, "reason": None, "checked": "prerequisites_only"}
    try:
        for name in ("inference.py", "inference.json", "prompt.safetensors"):
            path = MODEL_DIR / name
            if not path.is_file() or path.stat().st_size == 0:
                return {**result, "reason": "model_files_missing"}
        prompt = MODEL_DIR / "prompt.safetensors"
        if prompt.stat().st_size < 1024:
            return {**result, "reason": "model_files_missing"}
        spec = json.loads((MODEL_DIR / "inference.json").read_text(encoding="utf-8"))
        if (spec.get("prompt", {}).get("file") != "prompt.safetensors" or
                spec.get("prompt", {}).get("shape") != [50, 1024] or
                set(spec.get("base_model", {}).get("files", {})) != set(BASE_FILES)):
            return {**result, "reason": "model_config_invalid"}
        base = base_model_path()
        for name in BASE_FILES:
            path = base / name
            if not path.is_file() or path.stat().st_size == 0:
                return {**result, "reason": "base_model_missing"}
            if path.suffix == ".safetensors" and path.stat().st_size < 1024:
                return {**result, "reason": "base_model_missing"}
        if any(importlib.util.find_spec(name) is None for name in
               ("torch", "diffusers", "transformers", "safetensors", "accelerate")):
            return {**result, "reason": "dependencies_missing"}
        return {**result, "available": True}
    except (ValueError, TypeError, AttributeError):
        return {**result, "reason": "model_config_invalid"}
    except (OSError, ImportError, RuntimeError):
        return {**result, "reason": "model_check_failed"}


def require_model():
    if not model_capability()["available"]:
        raise ServiceError("LEFTREFILL_MODEL_UNAVAILABLE",
                           "Install the offline LeftRefill base model and dependencies in the service Python environment", 503)


def generate(target, mask, reference, seed):
    """Load only in the bounded worker; errors never trigger a paid fallback."""
    require_model()
    try:
        import torch
        if not torch.cuda.is_available():
            raise ServiceError("LEFTREFILL_GPU_REQUIRED", "Local LeftRefill repair requires a CUDA GPU", 503)
        torch.set_num_threads(1)
        spec = importlib.util.spec_from_file_location("pattern_studio_leftrefill", MODEL_DIR / "inference.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pipeline = module.LeftRefill(base_model_path(), sequential_guidance=True)
        return pipeline.restore(target, mask, reference, seed=seed)
    except ServiceError:
        raise
    except (ImportError, OSError, ValueError):
        raise ServiceError("LEFTREFILL_MODEL_UNAVAILABLE", "Offline model assets or dependencies could not be loaded", 503) from None
    except RuntimeError as error:
        code = "LEFTREFILL_GPU_OOM" if "out of memory" in str(error).lower() else "LEFTREFILL_INFERENCE_FAILED"
        raise ServiceError(code, "Local repair failed; release competing GPU work or verify the offline model", 503) from None


def execute_repair(store, job, token):
    from app.services.finishing_workbench import FinishingWorkbench
    from app.services.local_workbench import _output, _read_image
    from app.services.repair import composite_region

    params, job_id = job["parameters"], job["job_id"]
    source, original = _read_image(store, job["input_asset_id"])
    reference, reference_image = _read_image(store, params["reference_asset_id"])
    box = BoundingBox(**params["bbox"])
    if original.size != (512, 512):
        raise ServiceError("LEFTREFILL_INPUT_SIZE", "Create an explicit 512x512 crop before local repair", 422)
    box.within(original.size)
    damage, mask, damage_source = FinishingWorkbench(store)._damage(params.get("damage_mask_asset_id"), source)
    editing = rectangle_mask(original.size, box)
    if mask is None:
        mask = editing
    elif np.any((np.asarray(mask) > 0) & (np.asarray(editing) == 0)):
        raise ServiceError("DAMAGE_OUTSIDE_EDIT", "The local damage mask must be contained by the edit rectangle", 422)
    if not np.any(np.asarray(mask)):
        raise ServiceError("LEFTREFILL_EMPTY_MASK", "Choose a nonempty damaged region", 422)
    store.step(job_id, token, "repair-candidate", "running")
    # Flatten only the model's RGB working inputs. Original RGBA is retained for protection.
    def rgb(image):
        canvas = Image.new("RGBA", image.size, "white")
        return Image.alpha_composite(canvas, image.convert("RGBA")).convert("RGB")
    generated = generate(rgb(original), mask, rgb(reference_image), params["seed"])
    if generated.size != original.size:
        raise ServiceError("CANDIDATE_SPACE_MISMATCH", "Local model returned an unexpected canvas", 422)
    # Never retain model changes outside the exact mask, even for full-candidate review.
    protected = Image.composite(generated.convert("RGBA"), original, mask)
    common = {"repair_job_id": job_id, "method": "leftrefill", "model_version": MODEL_VERSION,
              "seed": params["seed"], "device": "cuda", "sequential_guidance": True,
              "reference_asset_id": reference["asset_id"], "bbox": params["bbox"],
              "reference_transform": {"input_size": list(reference_image.size), "output_size": [512, 512], "resampling": "bicubic"},
              "damage_mask_asset_id": params.get("damage_mask_asset_id"),
              "ai_inferred": True, "geometry_verified": False, "needs_user_review": True}
    parents = [{"asset_id": source["asset_id"], "role": "original_input_reference"},
               {"asset_id": reference["asset_id"], "role": "repair_reference"}]
    if damage:
        parents.append({"asset_id": damage["asset_id"], "role": "damage_mask"})
    candidate = store.publish(job_id, token, "repair-candidate", [
        _output(protected, "edit_candidate", source, job_id, parents=parents, extra=common)])[0]
    result = composite_region(original, protected, box, feather_px=params["feather_px"])
    result.image = Image.composite(result.image, original, mask)
    metrics = {**result.metrics, "mask_pixels": int(np.count_nonzero(np.asarray(mask))),
               "damage_source": damage_source if damage else "user_rectangle"}
    if metrics["outside_changed_pixels"] or metrics["outside_max_error"]:
        raise ServiceError("OUTSIDE_REGION_CHANGED", "Local repair did not preserve protected pixels", 409)
    store.step(job_id, token, "protect-region", "running")
    edit_id, composite_id = str(uuid4()), str(uuid4())
    edit = _output(mask, "edit_mask", source, job_id, asset_id=edit_id, parents=parents,
                   extra={**common, "mask_kind": "edit_mask", "values": [0, 255], "metrics": metrics})
    weight = Image.fromarray(np.minimum(np.asarray(result.blend_weight), np.asarray(mask)))
    blend = _output(weight, "blend_weight", source, job_id, parents=[{"asset_id": edit_id, "role": "edit_mask"}], extra=common)
    composite = _output(result.image, "repair_composite", source, job_id, asset_id=composite_id,
                        parents=parents + [{"asset_id": candidate["asset_id"], "role": "full_ai_candidate"},
                                           {"asset_id": edit_id, "role": "edit_mask"}],
                        extra={**common, "metrics": metrics, "warnings": [], "algorithm": metrics["algorithm"]})
    delta = np.max(np.abs(np.asarray(result.image).astype(np.int16) - np.asarray(original).astype(np.int16)), axis=2).astype(np.uint8)
    difference = _output(Image.fromarray(delta), "difference_map", source, job_id,
                         parents=[{"asset_id": composite_id, "role": "local_composite"}],
                         extra={**common, "visualization_only": True})
    store.publish(job_id, token, "protect-region", [edit, blend, composite, difference])
