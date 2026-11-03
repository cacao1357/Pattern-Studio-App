"""Same-origin local S1 endpoints; processing writes require idempotency."""

from pathlib import Path
import sqlite3
import tempfile
from uuid import UUID

from fastapi import File, Form, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from app.schemas.contracts import DEFAULT_LIMITS
from app import versions
from app.schemas.workbench import (CropRequest, PrepareRequest, WorkingCopyRequest, EnhanceRequest, ExtractRequest,
    VectorRequest, PipelineRequest, ExportRequest, FeedbackRequest)
from app.storage import ServiceError


FRONTEND_MODULES = (
    "brush-history.js", "edit-history.js", "guidance.js",
    "job-cancel.js", "params.js", "preview-session.js", "settings.js",
)


def mount_workbench(app, current_store, current_service, current_worker):
    @app.get("/api/v1/health", responses={503: {"description": "Database, storage or worker is unavailable"}})
    def health():
        store = current_store()
        database, storage = False, False
        try:
            with store.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("SELECT count(*) FROM local_jobs").fetchone()
                db.rollback()
                database = True
            with tempfile.TemporaryFile(dir=store.root) as probe:
                probe.write(b"1")
                probe.flush()
                storage = True
        except (OSError, sqlite3.Error):
            pass
        worker = current_worker().status()
        ready = database and storage and worker["alive"] and not worker["error"]
        return JSONResponse({"status": "ok" if ready else "degraded", "scope": "s1_local_workbench",
            "database": database, "storage": storage, "worker": worker, "versions": versions.snapshot(),
            "limits": {"upload_bytes": DEFAULT_LIMITS.max_upload_bytes, "decode_pixels": DEFAULT_LIMITS.max_decode_pixels,
                       "working_pixels": DEFAULT_LIMITS.max_vector_pixels, "tile_pixels": DEFAULT_LIMITS.max_tile_pixels,
                       "provisional": True}}, status_code=200 if ready else 503)

    @app.post("/api/v1/images", status_code=201, responses={200: {"description": "Identical idempotent upload reused"}})
    def upload_image(
        request: Request,
        file: UploadFile = File(...),
        source_note: str = Form(default="", max_length=1000),
        source_type: str = Form(default="", max_length=32),
        source_name: str = Form(default="", max_length=200),
        source_url: str = Form(default="", max_length=500),
        license: str = Form(default="", max_length=100),
        collected_at: str = Form(default="", max_length=10),
        batch_id: str = Form(default="", max_length=64),
    ):
        data = file.file.read(DEFAULT_LIMITS.max_upload_bytes + 1)
        result, created, duplicates = current_service().upload(
            data, file.filename or "", source_note, request.headers.get("idempotency-key", ""),
            provenance_values={
                "source_type": source_type, "source_name": source_name, "source_url": source_url,
                "license": license, "collected_at": collected_at, "batch_id": batch_id,
            },
        )
        return JSONResponse({**result, "duplicates": duplicates}, status_code=201 if created else 200)

    @app.get("/api/v1/images/{image_id}")
    def image_record(image_id: UUID):
        return current_store().get_image(str(image_id))

    @app.get("/api/v1/images")
    def images(limit: int = Query(default=20, ge=1, le=50), cursor: str | None = Query(default=None, max_length=18)):
        return current_store().page("images", limit, cursor)

    @app.get("/api/v1/assets/{asset_id}")
    def asset_info(asset_id: UUID):
        return current_store().get_asset(str(asset_id))[0]

    @app.get("/api/v1/assets/{asset_id}/preview")
    def asset_preview(asset_id: UUID):
        _, data = current_store().read_asset(str(asset_id))
        _, path = current_store().get_asset(str(asset_id))
        media = {".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml"}.get(path.suffix)
        if media is None:
            raise ServiceError("PREVIEW_NOT_AVAILABLE", "Download this archive instead of previewing it", 415)
        return Response(data, media_type=media)

    def submit(kind, payload, request):
        return JSONResponse(current_service().submit(kind, payload, request.headers.get("idempotency-key", "")), status_code=202)

    @app.post("/api/v1/jobs/crop", status_code=202)
    def crop(payload: CropRequest, request: Request):
        return submit("crop", payload, request)

    @app.post("/api/v1/jobs/prepare", status_code=202)
    def prepare(payload: PrepareRequest, request: Request):
        return submit("prepare", payload, request)

    @app.post("/api/v1/jobs/working-copy", status_code=202)
    def working_copy(payload: WorkingCopyRequest, request: Request):
        return submit("working-copy", payload, request)

    @app.post("/api/v1/jobs/enhance", status_code=202)
    def enhance(payload: EnhanceRequest, request: Request):
        return submit("enhance", payload, request)

    @app.post("/api/v1/jobs/extract", status_code=202)
    def extract(payload: ExtractRequest, request: Request):
        return submit("extract", payload, request)

    @app.post("/api/v1/jobs/vectorize", status_code=202)
    def vector(payload: VectorRequest, request: Request):
        return submit("vectorize", payload, request)

    @app.post("/api/v1/pipelines", status_code=202)
    def pipeline(payload: PipelineRequest, request: Request):
        return submit("pipeline", payload, request)

    @app.post("/api/v1/exports", status_code=202)
    def export(payload: ExportRequest, request: Request):
        return submit("export", payload, request)

    @app.get("/api/v1/jobs")
    def jobs(limit: int = Query(default=20, ge=1, le=50), cursor: str | None = Query(default=None, max_length=18)):
        return current_store().page("local_jobs", limit, cursor)

    @app.get("/api/v1/jobs/{job_id}")
    def job(job_id: UUID):
        return current_store().get_job(str(job_id))

    @app.post("/api/v1/jobs/{job_id}/cancel")
    def cancel_job(job_id: UUID):
        """Cancel queued/running local work; external-call tasks require reconciliation."""
        return current_store().cancel_job(str(job_id))

    @app.get("/api/v1/pipelines/{pipeline_id}")
    def get_pipeline(pipeline_id: UUID):
        try:
            return current_store().get_ai_flow(str(pipeline_id))
        except ServiceError as error:
            if error.code != "AI_PIPELINE_NOT_FOUND":
                raise
        result = current_store().get_job(str(pipeline_id))
        if result["kind"] != "pipeline":
            raise ServiceError("PIPELINE_NOT_FOUND", "Local pipeline not found", 404)
        return result

    @app.post("/api/v1/jobs/{job_id}/retry", status_code=202)
    def retry(job_id: UUID, request: Request):
        return JSONResponse(current_service().retry(str(job_id), request.headers.get("idempotency-key", "")), status_code=202)

    @app.post("/api/v1/feedback", status_code=201)
    def feedback(payload: FeedbackRequest, request: Request):
        return current_service().feedback(payload, request.headers.get("idempotency-key", ""))

    frontend = Path(__file__).resolve().parents[3] / "frontend"

    def static_response(filename, media_type):
        path = frontend / filename
        if not path.is_file():
            raise ServiceError("WORKBENCH_UNAVAILABLE", "The local workbench files are unavailable", 503)
        return Response(path.read_bytes(), media_type=media_type)

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def index():
        return static_response("index.html", "text/html")

    @app.api_route("/workbench.js", methods=["GET", "HEAD"], include_in_schema=False)
    def javascript():
        return static_response("workbench.js", "text/javascript")

    def module_endpoint(filename):
        def endpoint():
            return static_response(filename, "text/javascript")
        return endpoint

    for module_name in FRONTEND_MODULES:
        app.add_api_route(f"/{module_name}",
            module_endpoint(module_name),
            methods=["GET", "HEAD"], include_in_schema=False)

    @app.api_route("/styles.css", methods=["GET", "HEAD"], include_in_schema=False)
    def styles():
        return static_response("styles.css", "text/css")

    @app.api_route("/favicon.svg", methods=["GET", "HEAD"], include_in_schema=False)
    def favicon():
        return static_response("favicon.svg", "image/svg+xml")
