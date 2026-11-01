"""Additive local SVG-editing endpoints."""
from fastapi import Request
from fastapi.responses import JSONResponse
from app.schemas.svg_edit import RecolorRequest
from app.services.svg_edit import submit_recolor


def mount_svg_edit(app, current_store):
    @app.post("/api/v1/jobs/recolor-svg", status_code=202)
    def recolor(payload: RecolorRequest, request: Request):
        return JSONResponse(submit_recolor(current_store(), payload, request.headers.get("idempotency-key", "")), status_code=202)
