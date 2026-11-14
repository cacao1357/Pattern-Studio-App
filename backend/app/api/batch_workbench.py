"""Saved presets and progress endpoints for persistent local batches."""

from uuid import UUID

from fastapi import Query, Request
from fastapi.responses import JSONResponse

from app.schemas.batch_workbench import BatchCancel, BatchCreate, BatchResume, PresetCreate, PresetUpdate


def mount_batch_workbench(app, current_service):
    def service(request=None):
        return current_service()

    def key(request: Request):
        value = request.headers.get("idempotency-key", "")
        service(request).local.safe_text(value)
        return value

    @app.get("/api/v1/workflow-presets")
    def presets():
        return service().presets()

    @app.post("/api/v1/workflow-presets", status_code=201)
    def create_preset(payload: PresetCreate):
        return service().create_preset(payload)

    @app.put("/api/v1/workflow-presets/{preset_id}")
    def update_preset(preset_id: UUID, payload: PresetUpdate):
        return service().update_preset(str(preset_id), payload)

    @app.delete("/api/v1/workflow-presets/{preset_id}")
    def delete_preset(preset_id: UUID, revision: int = Query(ge=1)):
        return service().delete_preset(str(preset_id), revision)

    @app.post("/api/v1/processing-batches", status_code=202)
    def create_batch(payload: BatchCreate, request: Request):
        return JSONResponse(service().create_batch(payload, key(request)), status_code=202)

    @app.get("/api/v1/processing-batches")
    def batches(limit: int = Query(default=20, ge=1, le=100), cursor: str | None = Query(default=None, max_length=18)):
        return service().batches(limit, cursor)

    @app.get("/api/v1/processing-batches/{batch_id}")
    def batch(batch_id: UUID):
        return service().get_batch(str(batch_id))

    @app.post("/api/v1/processing-batches/{batch_id}/items/{item_id}/resume")
    def resume(batch_id: UUID, item_id: UUID, payload: BatchResume):
        return service().resume(str(batch_id), str(item_id), payload.revision, str(payload.input_asset_id))

    @app.post("/api/v1/processing-batches/{batch_id}/cancel")
    def cancel(batch_id: UUID, payload: BatchCancel):
        return service().cancel(str(batch_id), payload.revision)
