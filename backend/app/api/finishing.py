"""Repair jobs use the same durable worker and immutable version downloads."""

from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse

from app.schemas.finishing import RepairRequest, RepairDecision, TileRequest, TileSeamObservation


def mount_finishing(app, current_service):
    def key(request):
        value = request.headers.get("idempotency-key", "")
        current_service().local.safe_text(value)
        return value

    @app.post("/api/v1/jobs/repair", status_code=202)
    def repair(payload: RepairRequest, request: Request):
        return JSONResponse(current_service().repair(payload, key(request)), status_code=202)

    @app.get("/api/v1/repairs/{job_id}")
    def repair_info(job_id: UUID):
        return current_service().get_repair(str(job_id))

    @app.post("/api/v1/repairs/{job_id}/decision")
    def decision(job_id: UUID, payload: RepairDecision, request: Request):
        return current_service().decide(str(job_id), payload, key(request))

    @app.post("/api/v1/jobs/tile-preview", status_code=202)
    def tile(payload: TileRequest, request: Request):
        return JSONResponse(current_service().tile(payload, key(request)), status_code=202)

    @app.put("/api/v1/assets/{asset_id}/seam-observation")
    def tile_observation(asset_id: UUID, payload: TileSeamObservation):
        return current_service().store.set_tile_observation(str(asset_id), payload.seam_observation, payload.revision)
