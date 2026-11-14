"""Persistent preset and per-image batch coordination over existing jobs/assets."""

import json
import threading
from uuid import UUID, uuid4, uuid5

from pydantic import ValidationError

from app.schemas.batch_workbench import BatchCreate, PresetCreate, PresetOptions, PresetUpdate
from app.schemas.contracts import ProcessingError
from app.schemas.finishing import TileRequest
from app.schemas.contracts import DEFAULT_LIMITS
from app.schemas.provider import CloudLineartRequest
from app.schemas.workbench import ExtractRequest, LineartRequest, VectorRequest, WorkingCopyRequest
from app.services.cloud_lineart import submit_cloud_lineart
from app.services.finishing_workbench import FinishingWorkbench
from app.services.local_workbench import RGB_KINDS
from app.storage import ServiceError, canonical_json, digest, now
from app.workbench_store import TERMINAL, validate_key


BUILTINS = (
    ("本地线稿转 SVG", {"recipe": "model_lineart", "vector": {"mode": "monochrome"}}),
    ("云端线稿转 SVG", {"recipe": "cloud_lineart", "vector": {"mode": "monochrome"}}),
    ("颜色提取转 SVG", {"recipe": "color", "vector": {"mode": "color"}}),
)
MANUAL_STEPS = {
    "crop": ("裁切", {"cropped"}),
    "repair": ("修复", {"accepted_repair"}),
    "candidates": ("候选合成", {"composed_candidate"}),
    "mask": ("蒙版修正", {"transparent_png"}),
}
PROCESS_KINDS = {
    "model_lineart": {"normalized_input", "cropped", "working_copy", "prepared", "enhanced", "accepted_repair", "composed_candidate"},
    "cloud_lineart": {"normalized_input", "cropped", "working_copy", "prepared", "enhanced", "accepted_repair", "composed_candidate", "transparent_png"},
    "color": RGB_KINDS - {"edit_candidate", "placed_generated_layer", "generated_basemap", "generated_layer"},
}


def working_limit(options):
    """An explicitly selected copy must fit every enabled automatic stage."""
    limits = DEFAULT_LIMITS
    cap = limits.max_model_lineart_pixels if options["recipe"] == "model_lineart" else limits.max_vector_pixels
    if options["recipe"] == "cloud_lineart":
        cap = limits.max_decode_pixels
    if options["recipe"] == "color" and options["extract"]["mode"] == "otsu":
        cap = limits.max_threshold_pixels
    if options.get("mask"):
        cap = min(cap, limits.max_vector_pixels)
    if options.get("vectorize"):
        cap = min(cap, limits.max_color_vector_pixels if options["vector"]["mode"] == "color" else limits.max_vector_pixels)
    if options.get("tile"):
        cap = min(cap, limits.max_tile_pixels // 4)
    return cap


def _decoded(row):
    result = dict(row)
    result["preset_id"] = result.pop("id")
    result["options"] = json.loads(result.pop("configuration"))
    return result


class BatchWorkbench:
    """Small persistent coordinator; a job is still executed by the existing worker."""

    def __init__(self, store, local, assisted=None, finishing=None):
        self.store, self.local, self.assisted = store, local, assisted
        self.finishing = finishing or FinishingWorkbench(store, local=local)
        self._lock = threading.RLock()
        with store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS workflow_presets (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, configuration TEXT NOT NULL,
                    revision INTEGER NOT NULL, builtin INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS processing_batches (
                    id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, snapshot TEXT NOT NULL,
                    items_json TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
                    idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
            """)
            timestamp = now()
            for name, options in BUILTINS:
                db.execute("""INSERT OR IGNORE INTO workflow_presets
                    (id,name,configuration,revision,builtin,created_at,updated_at) VALUES (?,?,?,1,1,?,?)""",
                    (str(uuid5(UUID("f4a92c01-9ce7-4899-a2f0-8c6daab3a1c0"), name)), name,
                     canonical_json(PresetOptions.model_validate(options).model_dump(mode="json")), timestamp, timestamp))

    def presets(self):
        with self.store.connection() as db:
            rows = db.execute("SELECT * FROM workflow_presets ORDER BY builtin DESC,name COLLATE NOCASE,id").fetchall()
        return {"items": [_decoded(row) for row in rows]}

    def create_preset(self, payload: PresetCreate):
        name = payload.name.strip()
        if not name:
            raise ServiceError("INVALID_PRESET_NAME", "Enter a preset name")
        self.local.safe_text(name + canonical_json(payload.options.model_dump(mode="json")))
        preset_id, timestamp = str(uuid4()), now()
        with self.store.connection() as db:
            db.execute("INSERT INTO workflow_presets VALUES (?,?,?,1,0,?,?)",
                       (preset_id, name, canonical_json(payload.options.model_dump(mode="json")), timestamp, timestamp))
            db.commit()
        return self.get_preset(preset_id)

    def get_preset(self, preset_id):
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM workflow_presets WHERE id=?", (preset_id,)).fetchone()
        if row is None:
            raise ServiceError("PRESET_NOT_FOUND", "Workflow preset not found", 404)
        return _decoded(row)

    def update_preset(self, preset_id, payload: PresetUpdate):
        name = payload.name.strip()
        if not name:
            raise ServiceError("INVALID_PRESET_NAME", "Enter a preset name")
        self.local.safe_text(name + canonical_json(payload.options.model_dump(mode="json")))
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM workflow_presets WHERE id=?", (preset_id,)).fetchone()
            if row is None:
                db.rollback()
                raise ServiceError("PRESET_NOT_FOUND", "Workflow preset not found", 404)
            if row["revision"] != payload.revision:
                db.rollback()
                raise ServiceError("STALE_REVISION", "Reload the preset before saving", 409)
            db.execute("UPDATE workflow_presets SET name=?,configuration=?,revision=revision+1,updated_at=? WHERE id=?",
                       (name, canonical_json(payload.options.model_dump(mode="json")), now(), preset_id))
            db.commit()
        return self.get_preset(preset_id)

    def delete_preset(self, preset_id, revision):
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM workflow_presets WHERE id=?", (preset_id,)).fetchone()
            if row is None:
                db.rollback()
                raise ServiceError("PRESET_NOT_FOUND", "Workflow preset not found", 404)
            if row["builtin"]:
                db.rollback()
                raise ServiceError("BUILTIN_PRESET", "Built-in presets cannot be deleted", 409)
            if row["revision"] != revision:
                db.rollback()
                raise ServiceError("STALE_REVISION", "Reload the preset before deleting", 409)
            db.execute("DELETE FROM workflow_presets WHERE id=?", (preset_id,))
            db.commit()
        return {"deleted": True, "preset_id": preset_id}

    def create_batch(self, payload: BatchCreate, key):
        validate_key(key)
        self.local.safe_text(key + canonical_json(payload.model_dump(mode="json")))
        request_hash = digest(canonical_json(payload.model_dump(mode="json")).encode())
        with self._lock:
            with self.store.connection() as db:
                old = db.execute("SELECT id,request_hash FROM processing_batches WHERE idempotency_key=?", (key,)).fetchone()
            if old:
                if old["request_hash"] != request_hash:
                    raise ServiceError("IDEMPOTENCY_CONFLICT", "This key already identifies another batch", 409)
                return self.get_batch(old["id"])
            preset = self.get_preset(str(payload.preset_id))
            options = PresetOptions.model_validate(preset["options"])
            if options.recipe == "cloud_lineart" and not (payload.consent_to_upload and payload.consent_to_charge):
                raise ServiceError("BATCH_CLOUD_CONSENT_REQUIRED", "Confirm image upload and possible provider charges before starting this batch", 422)
            with self.store.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                # Recheck after acquiring the write lock for another coordinator instance.
                old = db.execute("SELECT id,request_hash FROM processing_batches WHERE idempotency_key=?", (key,)).fetchone()
                if old:
                    db.rollback()
                    if old["request_hash"] != request_hash:
                        raise ServiceError("IDEMPOTENCY_CONFLICT", "This key already identifies another batch", 409)
                    return self.get_batch(old["id"])
                inputs = []
                for asset_id in payload.input_asset_ids:
                    metadata, _ = self.store.get_asset(str(asset_id))
                    image_id = metadata.get("image_id")
                    if not image_id:
                        db.rollback()
                        raise ServiceError("BATCH_IMAGE_REQUIRED", "Choose an asset that belongs to a saved source image", 422)
                    if metadata.get("kind") not in PROCESS_KINDS[options.recipe]:
                        db.rollback()
                        raise ServiceError("BATCH_INPUT_KIND", "The selected preset cannot process this asset type", 422)
                    inputs.append({"input_asset_id": str(asset_id), "image_id": image_id, "kind": metadata["kind"]})
                batch_id, timestamp = str(uuid4()), now()
                step_names = [name for name in ("crop", "repair", "candidates") if getattr(options, name)]
                if options.working_max_pixels is not None:
                    step_names.append("working_copy")
                step_names.append(options.recipe)
                if options.mask:
                    if options.recipe != "color":
                        step_names.append("prepare_mask")
                    step_names.append("mask")
                if options.vectorize:
                    step_names.append("vectorize")
                if options.tile:
                    step_names.append("tile")
                items = [{"item_id": str(uuid4()), **source, "current_asset_id": source["input_asset_id"],
                          "steps": [{"name": step, "state": "queued"} for step in step_names],
                          "cursor": 0, "state": "queued", "job_id": None, "results": [],
                          "waiting_for": None, "error": None} for source in inputs]
                snapshot = {"preset_id": preset["preset_id"], "preset_revision": preset["revision"],
                            "name": preset["name"], "options": options.model_dump(mode="json"),
                            "consent_to_upload": payload.consent_to_upload,
                            "consent_to_charge": payload.consent_to_charge,
                            "planned_provider_calls": len(inputs) if options.recipe == "cloud_lineart" else 0,
                            "images_uploaded_to_provider": len(inputs) if options.recipe == "cloud_lineart" else 0}
                db.execute("""INSERT INTO processing_batches
                    (id,preset_id,snapshot,items_json,state,revision,idempotency_key,request_hash,created_at,updated_at)
                    VALUES (?,?,?,?,'running',1,?,?,?,?)""",
                    (batch_id, str(payload.preset_id), canonical_json(snapshot), canonical_json(items), key, request_hash, timestamp, timestamp))
                db.commit()
        self.advance()
        return self.get_batch(batch_id)

    def batches(self, limit=20, cursor=None):
        from app.workbench_store import page_offset
        offset = page_offset(cursor)
        with self.store.connection() as db:
            rows = db.execute("SELECT rowid AS sequence,* FROM processing_batches WHERE rowid<? ORDER BY rowid DESC LIMIT ?",
                              (offset, limit + 1)).fetchall()
        selected = rows[:limit]
        return {"items": [self.get_batch(row["id"]) for row in selected],
                "next_cursor": str(selected[-1]["sequence"]) if len(rows) > limit else None}

    def get_batch(self, batch_id):
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM processing_batches WHERE id=?", (batch_id,)).fetchone()
        if row is None:
            raise ServiceError("BATCH_NOT_FOUND", "Processing batch not found", 404)
        items = json.loads(row["items_json"])
        counts = {state: sum(item["state"] == state for item in items)
                  for state in ("queued", "running", "waiting", "cancelling", "failed", "succeeded", "cancelled")}
        result = dict(row)
        result["batch_id"] = result.pop("id")
        result.pop("items_json")
        result.pop("idempotency_key", None)
        result.pop("request_hash", None)
        result["snapshot"] = json.loads(result["snapshot"])
        result["items"] = items
        result["progress"] = {"total": len(items), "counts": counts,
                               "completed": counts["succeeded"] + counts["failed"] + counts["cancelled"]}
        return result

    def _save(self, batch_id, revision, items, state=None):
        state = state or _batch_state(items)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision FROM processing_batches WHERE id=?", (batch_id,)).fetchone()
            if row is None:
                db.rollback()
                raise ServiceError("BATCH_NOT_FOUND", "Processing batch not found", 404)
            if row["revision"] != revision:
                db.rollback()
                raise ServiceError("STALE_REVISION", "Reload this batch before changing it", 409)
            db.execute("UPDATE processing_batches SET items_json=?,state=?,revision=revision+1,updated_at=? WHERE id=?",
                       (canonical_json(items), state, now(), batch_id))
            db.commit()

    def resume(self, batch_id, item_id, revision, input_asset_id):
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["revision"] != revision:
                raise ServiceError("STALE_REVISION", "Reload this batch before resuming", 409)
            items = batch["items"]
            item = next((entry for entry in items if entry["item_id"] == item_id), None)
            if item is None:
                raise ServiceError("BATCH_ITEM_NOT_FOUND", "Processing item not found", 404)
            if item["state"] != "waiting" or not item["waiting_for"]:
                raise ServiceError("BATCH_ITEM_NOT_WAITING", "This image has no pending confirmation step", 409)
            step_name = item["waiting_for"]
            metadata, _ = self.store.get_asset(str(input_asset_id))
            expected = MANUAL_STEPS[step_name][1]
            if metadata.get("image_id") != item["image_id"] or metadata.get("kind") not in expected:
                raise ServiceError("BATCH_RESUME_ASSET_MISMATCH", "Choose a saved result of the required type from this same source image", 422)
            if not self._descends_from(str(input_asset_id), item["current_asset_id"]):
                raise ServiceError("BATCH_RESUME_ASSET_MISMATCH", "Choose a result derived from the current image version", 422)
            step = item["steps"][item["cursor"]]
            step.update(state="succeeded", output_asset_id=str(input_asset_id), confirmed=True)
            item.update(current_asset_id=str(input_asset_id), cursor=item["cursor"] + 1,
                        state="running", waiting_for=None, job_id=None)
            if metadata.get("kind") in {"cropped", "transparent_png", "lineart", "accepted_repair"}:
                item["tile_source_asset_id"] = str(input_asset_id)
            self._save(batch_id, revision, items)
        self.advance()
        return self.get_batch(batch_id)

    def cancel(self, batch_id, revision):
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["revision"] != revision:
                raise ServiceError("STALE_REVISION", "Reload this batch before cancelling", 409)
            items = batch["items"]
            for item in items:
                if item["state"] in TERMINAL:
                    continue
                if item["state"] == "waiting":
                    item["state"] = "cancelled"
                    item["steps"][item["cursor"]]["state"] = "cancelled"
                    continue
                if item["state"] == "cancelling":
                    continue
                job_id = item.get("job_id")
                if job_id:
                    job = self.store.get_job(job_id)
                    from app.worker import calls_provider
                    if calls_provider(job) and job["state"] == "queued":
                        try:
                            self.store.cancel_job(job_id, allow_queued_provider=True)
                        except ServiceError as exc:
                            if exc.code != "CANCEL_REQUIRES_RECONCILIATION":
                                raise
                            item["state"] = "cancelling"
                            item["cancel_requested"] = True
                            continue
                    elif calls_provider(job) and job["state"] == "running":
                        item["state"] = "cancelling"
                        item["cancel_requested"] = True
                        continue
                    else:
                        self.store.cancel_job(job_id)
                item.update(state="cancelled", waiting_for=None)
                if item["cursor"] < len(item["steps"]):
                    item["steps"][item["cursor"]]["state"] = "cancelled"
            self._save(batch_id, revision, items)
        return self.get_batch(batch_id)

    def advance(self):
        """Poll linked jobs and submit the next step with stable idempotency keys."""
        with self._lock:
            with self.store.connection() as db:
                active_ids = [row["id"] for row in db.execute(
                    "SELECT id FROM processing_batches WHERE state IN ('running','cancelling') ORDER BY rowid")]
            active = [self.get_batch(batch_id) for batch_id in active_ids]
            for batch in active:
                if batch["state"] not in {"running", "cancelling"}:
                    continue
                items, revision = batch["items"], batch["revision"]
                options = batch["snapshot"]["options"]
                changed = False
                queue_full = False
                for item in items:
                    if item["state"] == "cancelling":
                        job_id = item.get("job_id")
                        if not job_id:
                            item["state"] = "cancelled"
                            changed = True
                            continue
                        job = self.store.get_job(job_id)
                        if job["state"] not in TERMINAL:
                            continue
                        if job["state"] == "succeeded":
                            try:
                                self._step_output(item["steps"][item["cursor"]]["name"], job)
                                item["results"].extend(asset["asset_id"] for asset in job["result"].get("assets", []))
                            except ServiceError as exc:
                                item["error"] = {"code": exc.code}
                        elif job.get("error"):
                            item["error"] = {"code": job["error"].get("code", "PROVIDER_OUTCOME_UNKNOWN")}
                            item["provider_job_state"] = job["state"]
                        item["steps"][item["cursor"]]["state"] = "cancelled"
                        item.update(state="cancelled", job_id=None)
                        changed = True
                        continue
                    if item["state"] not in {"queued", "running"}:
                        continue
                    item["state"] = "running"
                    while item["cursor"] < len(item["steps"]):
                        step = item["steps"][item["cursor"]]
                        name = step["name"]
                        if name in MANUAL_STEPS:
                            step["state"] = "waiting"
                            item.update(state="waiting", waiting_for=name, job_id=None)
                            changed = True
                            break
                        try:
                            if name == "working_copy":
                                requested_max = options.get("working_max_pixels")
                                mode_limit = working_limit(options)
                                effective_max = min(requested_max, mode_limit)
                                source, _ = self.store.get_asset(item["current_asset_id"])
                                if source["width"] * source["height"] <= effective_max:
                                    step.update(state="succeeded", skipped=True, effective_max_pixels=effective_max)
                                    item["cursor"] += 1
                                    changed = True
                                    continue
                            job_id = item.get("job_id")
                            if job_id:
                                job = self.store.get_job(job_id)
                                if job["state"] in {"queued", "running"}:
                                    break
                                if job["state"] == "cancelled":
                                    step.update(state="cancelled", job_id=job_id)
                                    item.update(state="cancelled", waiting_for=None, job_id=None)
                                    changed = True
                                    break
                                if job["state"] != "succeeded":
                                    error = job.get("error") or {}
                                    step.update(state="failed", error=error.get("code", "JOB_FAILED"))
                                    item.update(state="failed", error={"code": error.get("code", "JOB_FAILED")}, job_id=None)
                                    changed = True
                                    break
                                output = self._step_output(name, job)
                                if output:
                                    item["current_asset_id"] = output
                                    output_metadata, _ = self.store.get_asset(output)
                                    if output_metadata.get("kind") in {"cropped", "transparent_png", "lineart", "accepted_repair"}:
                                        item["tile_source_asset_id"] = output
                                    item["results"].extend(asset["asset_id"] for asset in job["result"].get("assets", []))
                                step.update(state="succeeded", job_id=job_id, output_asset_id=output)
                                item["job_id"] = None
                                item["cursor"] += 1
                                changed = True
                                continue
                            child = self._submit_step(batch, item, name)
                            item["job_id"] = child["job_id"]
                            step.pop("queue_blocked", None)
                            step.update(state="running", job_id=child["job_id"])
                            changed = True
                            break
                        except ServiceError as exc:
                            if exc.code == "QUEUE_FULL":
                                # Preserve the step and let a later coordinator tick
                                # retry once an existing job frees a queue slot.
                                step.update(state="queued", queue_blocked=True)
                                item.update(state="queued", job_id=None)
                                queue_full = True
                                changed = True
                                break
                            step.update(state="failed", error=exc.code)
                            item.update(state="failed", error={"code": exc.code}, job_id=None)
                            changed = True
                            break
                        except ProcessingError as exc:
                            step.update(state="failed", error=exc.code)
                            item.update(state="failed", error={"code": exc.code}, job_id=None)
                            changed = True
                            break
                        except ValidationError:
                            step.update(state="failed", error="BATCH_PRESET_INVALID")
                            item.update(state="failed", error={"code": "BATCH_PRESET_INVALID"}, job_id=None)
                            changed = True
                            break
                        except Exception:
                            step.update(state="failed", error="BATCH_STEP_FAILED")
                            item.update(state="failed", error={"code": "BATCH_STEP_FAILED"}, job_id=None)
                            changed = True
                            break
                    if item["cursor"] >= len(item["steps"]) and item["state"] not in {"failed", "cancelled", "waiting"}:
                        item["state"] = "succeeded"
                        changed = True
                    if queue_full:
                        break
                if changed:
                    try:
                        self._save(batch["batch_id"], revision, items)
                    except ServiceError as exc:
                        if exc.code != "STALE_REVISION":
                            raise
                if queue_full:
                    break

    def _submit_step(self, batch, item, name):
        options = batch["snapshot"]["options"]
        source_id = item["current_asset_id"]
        key = f"batch-{item['item_id'][:24]}-{item['cursor']:02d}-{digest(name.encode())[:8]}"
        if name == "model_lineart":
            if options["recipe"] == "model_lineart":
                request = LineartRequest.model_validate({"input_asset_id": source_id, "method": "model"})
            else:
                raise ServiceError("BATCH_RECIPE_INVALID", "This preset has an unsupported line-art recipe")
            return self.local.submit("lineart", request, key)
        if name == "cloud_lineart":
            assisted = self.assisted() if callable(self.assisted) else self.assisted
            if assisted is None:
                raise ServiceError("PROVIDER_DISABLED", "Cloud processing is unavailable")
            request = CloudLineartRequest(input_asset_id=source_id,
                consent_to_upload=batch["snapshot"]["consent_to_upload"],
                consent_to_charge=batch["snapshot"]["consent_to_charge"])
            return submit_cloud_lineart(assisted, request, key)
        if name == "color":
            request = ExtractRequest.model_validate({"input_asset_id": source_id, **options["extract"]})
            return self.local.submit("extract", request, key)
        if name == "prepare_mask":
            # Line-art generators preserve alpha but the mask editor consumes a
            # foreground_mask paired with transparent_png. Extracting the existing
            # alpha produces that pair without thresholding or changing pixels.
            request = ExtractRequest.model_validate({"input_asset_id": source_id, "mode": "alpha"})
            return self.local.submit("extract", request, key)
        if name == "working_copy":
            requested_max = options["working_max_pixels"]
            mode_limit = working_limit(options)
            effective_max = min(requested_max, mode_limit)
            request = WorkingCopyRequest(input_asset_id=source_id, max_pixels=effective_max)
            return self.local.submit("working-copy", request, key)
        if name == "vectorize":
            request = VectorRequest.model_validate({"input_asset_id": source_id, **options["vector"]})
            return self.local.submit("vectorize", request, key)
        if name == "tile":
            tile_source_id = item.get("tile_source_asset_id", source_id)
            request = TileRequest(unit_asset_id=tile_source_id)
            return self.finishing.tile(request, key)
        raise ServiceError("BATCH_STEP_UNSUPPORTED", "This preset step is not available yet")

    def _descends_from(self, asset_id, ancestor_id):
        if asset_id == ancestor_id:
            return True
        with self.store.connection() as db:
            row = db.execute("""WITH RECURSIVE lineage(id) AS (
                SELECT ?
                UNION SELECT r.parent_id FROM asset_relations r JOIN lineage l ON r.child_id=l.id
                UNION SELECT json_extract(a.metadata,'$.source_asset_id') FROM assets a JOIN lineage l ON a.id=l.id
                    WHERE json_extract(a.metadata,'$.source_asset_id') IS NOT NULL
                ) SELECT 1 FROM lineage WHERE id=? LIMIT 1""", (asset_id, ancestor_id)).fetchone()
        return row is not None

    @staticmethod
    def _step_output(name, job):
        expected = "transparent_png" if name in {"color", "prepare_mask"} else "lineart" if name in {"model_lineart", "cloud_lineart"} else "svg" if name == "vectorize" else "tile_preview" if name == "tile" else "working_copy"
        assets = job.get("result", {}).get("assets", [])
        matches = [asset["asset_id"] for asset in assets if asset.get("kind") == expected]
        if not matches:
            raise ServiceError("BATCH_OUTPUT_MISSING", "The completed task did not publish the expected image version")
        return matches[-1]


def _batch_state(items):
    states = {item["state"] for item in items}
    if "cancelling" in states:
        return "cancelling"
    if states <= {"succeeded", "failed", "cancelled"}:
        return "succeeded" if states == {"succeeded"} else "completed"
    return "running"
