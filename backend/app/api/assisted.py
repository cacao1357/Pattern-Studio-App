"""S2 candidate confirmation and foreground correction endpoints."""

from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse

from app.schemas.assisted import AiPipelineRequest, ComposeLayersRequest, ContinueRequest, RefineMaskRequest, RerunRequest


def mount_assisted(app, current_service):
    def key(request):
        value = request.headers.get("idempotency-key", "")
        current_service().local.safe_text(value)
        return value

    @app.post("/api/v1/pipelines/ai", status_code=202)
    def ai_pipeline(payload: AiPipelineRequest, request: Request):
        return JSONResponse(current_service().create_pipeline(payload, key(request)), status_code=202)

    @app.get("/api/v1/jobs/{job_id}/layers")
    def layers(job_id: UUID):
        return current_service().layers(str(job_id))

    @app.post("/api/v1/jobs/compose-layers", status_code=202)
    def compose(payload: ComposeLayersRequest, request: Request):
        return JSONResponse(current_service().compose(payload, key(request)), status_code=202)

    @app.post("/api/v1/jobs/refine-mask", status_code=202)
    def refine(payload: RefineMaskRequest, request: Request):
        return JSONResponse(current_service().refine(payload, key(request)), status_code=202)

    @app.post("/api/v1/pipelines/{pipeline_id}/continue", status_code=202,
              responses={200: {"description": "User rejected the candidates"}})
    def continue_pipeline(pipeline_id: UUID, payload: ContinueRequest, request: Request):
        result = current_service().continue_pipeline(str(pipeline_id), payload, key(request))
        return JSONResponse(result, status_code=200 if payload.action == "reject" else 202)

    @app.post("/api/v1/pipelines/{pipeline_id}/rerun", status_code=202)
    def rerun(pipeline_id: UUID, payload: RerunRequest, request: Request):
        return JSONResponse(current_service().rerun(str(pipeline_id), payload, key(request)), status_code=202)
