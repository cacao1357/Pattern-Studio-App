"""Same-origin loopback workbench and isolated provider validation API."""

from contextlib import asynccontextmanager, contextmanager
import ipaddress
import os
from pathlib import Path
import re
from uuid import UUID

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
import httpx
from starlette.exceptions import HTTPException

from app.config import ConfigurationError, Settings, load_settings, money_cents
from app.providers.seedream import SeedreamClient
from app.schemas.contracts import DEFAULT_LIMITS, ProcessingError
from app.schemas.provider import CostSettlement, ValidationRequest
from app.services.provider_validation import ProviderValidationService
from app.storage import ServiceError, Store
from app.api.workbench import mount_workbench
from app.api.frontend import csp_for, document_policy, mount_frontend
from app.api.assisted import mount_assisted
from app.api.datasets import mount_datasets
from app.api.finishing import mount_finishing
from app.api.svg_edit import mount_svg_edit
from app.services.finishing_workbench import FinishingWorkbench
from app.services.assisted_workbench import AssistedWorkbench
from app.services.local_workbench import LocalWorkbench
from app.workbench_store import WorkbenchStore
from app.worker import LocalWorker
from app.schemas.settings import SettingsUpdate
from app.services.runtime_settings import RuntimeSettings, RuntimeSettingsConflict


class ApiAlreadyRunningError(RuntimeError):
    """Another process holds this workspace's API storage lock."""


@contextmanager
def exclusive_process(root: Path):
    """An OS lock is released on crash; a second process cannot recover a live call."""
    lock_path = root / "api-process.lock"
    with lock_path.open("a+b") as handle:
        handle.seek(0, 2)
        if not handle.tell():
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ApiAlreadyRunningError("Another Pattern Studio API process owns this storage directory") from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class LocalApiBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if sum(len(k) + len(v) + 4 for k, v in scope.get("headers", [])) > 16 * 1024:
            return await JSONResponse({"error": {"code": "HEADERS_TOO_LARGE", "message": "Request headers exceed 16 KiB"}}, 431)(scope, receive, send)
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1")
        client = scope.get("client")
        try:
            local = client is not None and ipaddress.ip_address(client[0]).is_loopback
        except ValueError:
            local = False
        origin = headers.get(b"origin")
        allowed = local and re.fullmatch(r"(?:127\.0\.0\.1|localhost)(?::\d{1,5})?", host)
        if not allowed or origin is not None and origin != ("http://" + host).encode("ascii"):
            return await JSONResponse({"error": {"code": "LOCAL_ACCESS_ONLY", "message": "Use the same-origin loopback workbench"}}, 403)(scope, receive, send)
        if headers.get(b"sec-fetch-site") not in (None, b"same-origin", b"none"):
            return await JSONResponse({"error": {"code": "LOCAL_ACCESS_ONLY", "message": "Cross-site workbench requests are unavailable"}}, 403)(scope, receive, send)
        # Only browser document responses need a rendering policy; scripts,
        # styles and images use their own media types and are same-origin.
        policy = document_policy(scope.get("path") or "") if scope.get("method") in {"GET", "HEAD"} else None
        csp = csp_for(policy)
        if scope.get("method") not in {"GET", "HEAD", "OPTIONS"} and headers.get(b"x-pattern-studio") != b"local":
            return await JSONResponse({"error": {"code": "LOCAL_REQUEST_HEADER_REQUIRED", "message": "Use the workbench or supply X-Pattern-Studio: local"}}, 403)(scope, receive, send)
        path = scope.get("path")
        limit = DEFAULT_LIMITS.max_upload_bytes if path == "/api/v1/seedream/inputs" else DEFAULT_LIMITS.max_upload_bytes + 64 * 1024 if path == "/api/v1/images" else 128 * 1024 if path == "/api/v1/jobs/refine-mask" else 16 * 1024
        length = headers.get(b"content-length")
        if length is not None and (len(length) > 10 or not length.isdigit() or int(length) > limit):
            return await JSONResponse({"error": {"code": "BODY_TOO_LARGE", "message": "Request body exceeds the endpoint limit"}}, 413)(scope, receive, send)
        body = bytearray()
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            chunk = event.get("body", b"")
            if len(body) + len(chunk) > limit:
                return await JSONResponse({"error": {"code": "BODY_TOO_LARGE", "message": "Request body exceeds the endpoint limit"}}, 413)(scope, receive, send)
            body.extend(chunk)
            if not event.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        async def secure_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [
                    (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff"),
                    (b"content-security-policy", csp.encode("ascii")),
                    (b"referrer-policy", b"no-referrer"),
                ]
            await send(message)

        response_started = False
        original_send = secure_send

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await original_send(message)

        try:
            return await self.app(scope, replay, tracked_send)
        except Exception:
            # Do not let Uvicorn log unexpected exception text containing input.
            if not response_started:
                return await JSONResponse({"error": {"code": "INTERNAL_ERROR", "message": "Local processing failed; no automatic provider retry was started"}}, 500)(scope, replay, secure_send)


def create_app(settings: Settings | None = None, *, transport: httpx.BaseTransport | None = None) -> FastAPI:
    settings = settings or load_settings()
    runtime_settings = RuntimeSettings(settings)
    store = None
    service = None
    local_service = None
    assisted_service = None
    worker = None

    def current_store() -> Store:
        if store is None:
            raise ServiceError("API_NOT_STARTED", "Start the API with its single-process lifecycle enabled", 503)
        return store

    def current_service() -> ProviderValidationService:
        if service is None:
            raise ServiceError("API_NOT_STARTED", "Start the API with its single-process lifecycle enabled", 503)
        current = runtime_settings.current()
        return ProviderValidationService(current, current_store(), SeedreamClient(current, transport=transport))

    def current_local_service():
        if local_service is None:
            raise ServiceError("API_NOT_STARTED", "The local workbench has not started", 503)
        return local_service

    def current_worker():
        if worker is None:
            raise ServiceError("API_NOT_STARTED", "The local worker has not started", 503)
        return worker

    def current_assisted_service():
        if assisted_service is None:
            raise ServiceError("API_NOT_STARTED", "The assisted workbench has not started", 503)
        return AssistedWorkbench(current_store(), runtime_settings.current(), current_local_service())

    @asynccontextmanager
    async def lifespan(app):
        nonlocal store, service, local_service, assisted_service, worker
        settings.storage_root.mkdir(parents=True, exist_ok=True)
        with exclusive_process(settings.storage_root):
            store = WorkbenchStore(settings.storage_root)
            service = ProviderValidationService(settings, store, SeedreamClient(settings, transport=transport))
            local_service = LocalWorkbench(store, runtime_settings.secrets)
            assisted_service = AssistedWorkbench(store, settings, local_service)
            store.recover_interrupted_calls()
            store.recover_jobs()
            worker = LocalWorker(store, provider_settings=runtime_settings.current)
            worker.start()
            try:
                yield
            finally:
                worker.stop()
                worker = None
                local_service = None
                assisted_service = None
                service = None
                store = None

    app = FastAPI(title="Pattern Studio local workbench API", version="0.2.0", debug=False,
                  docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(LocalApiBoundary)

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, error.status)

    @app.exception_handler(ProcessingError)
    async def processing_error(request, error):
        status = 413 if error.code in {"UPLOAD_TOO_LARGE", "PIXEL_LIMIT"} else 415 if error.code in {"FORMAT_MISMATCH", "UNSUPPORTED_FORMAT"} else 400
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # FastAPI's default includes rejected input, which could contain a pasted secret.
        return JSONResponse({"error": {"code": "INVALID_REQUEST", "message": "Check the documented fields, types and operation constraints"}}, 422)

    @app.exception_handler(ConfigurationError)
    async def configuration_error(request, error):
        return JSONResponse({"error": {"code": "INVALID_SETTINGS", "message": str(error)}}, 422)

    @app.exception_handler(RuntimeSettingsConflict)
    async def settings_conflict(request, error):
        return JSONResponse({"error": {"code": "STALE_SETTINGS", "message": str(error)}}, 409)

    @app.get("/api/v1/settings")
    def get_settings():
        current_store()
        return runtime_settings.public()

    @app.put("/api/v1/settings")
    def update_settings(payload: SettingsUpdate):
        current_store()
        return runtime_settings.update(payload)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": {"code": "HTTP_ERROR", "message": "This method or resource is unavailable"}}, error.status_code)

    mount_workbench(app, current_store, current_local_service, current_worker)
    mount_frontend(app)
    mount_svg_edit(app, current_store)
    mount_datasets(app, current_store)
    mount_assisted(app, current_assisted_service)
    mount_finishing(app, lambda: FinishingWorkbench(current_store(), runtime_settings.current(), current_local_service()))

    @app.get("/api/v1/seedream/status")
    def provider_status():
        current = runtime_settings.current()
        blockers = current.blockers()
        return {"configured": bool(current.ark_api_key.get_secret_value()), "enabled": not blockers,
                "blockers": blockers, "model": current.model, "automatic_retries": False,
                "budget": current_store().budget(current.budget_cents, current.max_calls),
                "limits": {"upload_bytes": DEFAULT_LIMITS.max_upload_bytes, "response_bytes": current.response_limit_bytes,
                           "aggregate_output_pixels": current.output_pixel_limit, "single_concurrent_call": True}}

    @app.post("/api/v1/seedream/inputs", status_code=201)
    async def upload_input(request: Request, filename: str = Query(min_length=1, max_length=200)):
        return current_service().upload(await request.body(), filename)

    @app.get("/api/v1/assets/{asset_id}/download")
    def download(asset_id: UUID):
        metadata, data = current_store().read_asset(str(asset_id))
        _, path = current_store().get_asset(str(asset_id))
        suffix = path.suffix
        return Response(data, media_type={".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".zip": "application/zip"}[suffix],
                        headers={"Content-Disposition": f'attachment; filename="{asset_id}{suffix}"'})

    @app.post("/api/v1/seedream/validations")
    def submit_validation(payload: ValidationRequest, request: Request):
        record, created = current_service().submit(payload, request.headers.get("idempotency-key", ""))
        return JSONResponse(record, status_code=201 if created else 200)

    @app.get("/api/v1/seedream/validations/{call_id}")
    def validation_status(call_id: UUID):
        return current_store().get_call(str(call_id))

    @app.post("/api/v1/seedream/validations/{call_id}/settlement")
    def settlement(call_id: UUID, payload: CostSettlement):
        if any(secret in payload.billing_reference for secret in runtime_settings.secrets()):
            raise ServiceError("INVALID_BILLING_REFERENCE", "Use an independent account billing reference")
        try:
            cents = money_cents(payload.actual_cost_cny, "actual_cost_cny")
        except ConfigurationError:
            raise ServiceError("INVALID_COST", "The CNY amount exceeds the supported limit") from None
        return current_store().settle(str(call_id), cents, payload.billing_reference)

    @app.get("/api/v1/openapi.json", include_in_schema=False)
    def openapi_document():
        schema = app.openapi()
        schema.setdefault("components", {}).setdefault("parameters", {})["LocalRequest"] = {
            "name": "X-Pattern-Studio", "in": "header", "required": True,
            "schema": {"type": "string", "const": "local"},
            "description": "Same-origin write marker; no local password is required.",
        }
        schema["components"].setdefault("parameters", {})["IdempotencyKey"] = {
            "name": "Idempotency-Key", "in": "header", "required": True,
            "schema": {"type": "string", "minLength": 16, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"},
            "description": "Reuse the same key only for identical input and parameters; a conflict returns 409.",
        }
        keyed_paths = {"/api/v1/images", "/api/v1/pipelines", "/api/v1/exports", "/api/v1/feedback", "/api/v1/seedream/validations", "/api/v1/pipelines/ai"}
        for path, methods in schema["paths"].items():
            if "post" in methods and (path in keyed_paths or path.startswith("/api/v1/jobs/") or path.endswith(("/continue", "/decision", "/rerun"))):
                parameter = {"$ref": "#/components/parameters/IdempotencyKey"}
                parameters = methods["post"].setdefault("parameters", [])
                if parameter not in parameters:
                    parameters.append(parameter)
            for method, operation in methods.items():
                if method in {"post", "put", "patch", "delete"}:
                    parameter = {"$ref": "#/components/parameters/LocalRequest"}
                    if parameter not in operation.setdefault("parameters", []):
                        operation["parameters"].append(parameter)
        return schema

    return app
