"""Additive local SVG-editing endpoints."""
from fastapi import Request
from fastapi.responses import JSONResponse
from uuid import UUID
from app.schemas.svg_edit import RecolorRequest, EditSvgRequest
from app.services.svg_edit import submit_recolor, submit_edit
from app.services.svg_elements import read_elements


def mount_svg_edit(app, current_store):
    @app.get("/api/v1/assets/{asset_id}/svg-elements")
    def elements(asset_id: UUID):
        return read_elements(current_store(), asset_id)

    @app.post("/api/v1/jobs/edit-svg", status_code=202)
    def edit_svg(payload: EditSvgRequest, request: Request):
        return JSONResponse(submit_edit(current_store(), payload, request.headers.get("idempotency-key", "")), status_code=202)

    @app.post("/api/v1/jobs/recolor-svg", status_code=202)
    def recolor(payload: RecolorRequest, request: Request):
        return JSONResponse(submit_recolor(current_store(), payload, request.headers.get("idempotency-key", "")), status_code=202)
