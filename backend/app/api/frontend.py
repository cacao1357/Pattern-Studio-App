"""Serve the integrated workbench shell and the preserved legacy shell.

The new shell lives in ``frontend/next-v2`` and owns ``/``.  The previous
frontend files stay untouched in ``frontend/`` and remain reachable read-only
under ``/legacy/`` for comparison and rollback.  Nothing here reads request
bodies or touches project data.
"""

from pathlib import Path
import re

from fastapi import Request
from fastapi.responses import RedirectResponse, Response

from app.storage import ServiceError


ROOT = Path(__file__).resolve().parents[3]
FRONTEND_ROOT = ROOT / "frontend"
STUDIO_ROOT = FRONTEND_ROOT / "next-v2"

# The integrated shell renders trusted local templates that use inline style
# attributes for geometry (crop rectangles, brush coordinates, markers).  Script
# sources stay same-origin only; data: is required for the paper-grain SVG
# backgrounds and blob: for local previews before an upload completes.
STUDIO_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; "
    "form-action 'self'; frame-ancestors 'none'"
)
# The legacy shell never needed inline styles; keep its stricter policy.
LEGACY_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; "
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)
BASE_CSP = "default-src 'none'; frame-ancestors 'none'"

LEGACY_ROOT_FILES = frozenset({
    "index.html",
    "styles.css",
    "theme-saas.css",
    "theme-glass.css",
    "theme-glass.js",
    "workbench.js",
    "settings.js",
    "params.js",
    "guidance.js",
    "preview-session.js",
    "job-cancel.js",
    "brush-history.js",
    "edit-history.js",
    "favicon.svg",
})
LEGACY_ASSETS = frozenset({
    "bg-home.svg",
    "bg-workspace.svg",
    "motif-01-meander.svg",
    "motif-04-cloud.svg",
    "lotus-mark.svg",
    "crane-line-blue.png",
})

MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
}
IMAGE_SUFFIXES = frozenset({".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"})
STUDIO_CSS_NAME = re.compile(r"[a-z0-9][a-z0-9-]*\.css\Z")
STUDIO_JS_PATH = re.compile(r"(?:[a-z0-9][a-z0-9-]*/)*[a-z0-9][a-z0-9-]*\.js\Z")
STUDIO_ASSET_PATH = re.compile(r"(?:[a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*\.(?:svg|png|jpe?g|webp|gif|ico)\Z")


def document_policy(path: str) -> str | None:
    """Return the CSP policy family for browser document responses."""
    if path == "/":
        return "studio"
    if path in {"/legacy/", "/legacy/index.html"}:
        return "legacy"
    return None


def csp_for(policy: str | None) -> str:
    if policy == "studio":
        return STUDIO_CSP
    if policy == "legacy":
        return LEGACY_CSP
    return BASE_CSP


def _read(root: Path, relative: str, *, suffixes: frozenset[str]) -> Response:
    """Read one file below ``root`` without allowing path escapes."""

    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404) from None
    if not path.is_file() or path.suffix.lower() not in suffixes:
        raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
    return Response(
        path.read_bytes(),
        media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
    )


def mount_frontend(app):
    """Mount the integrated shell at / and the legacy shell under /legacy/."""

    def shell(root: Path, relative: str, request: Request, *, suffixes=None) -> Response:
        response = _read(root, relative, suffixes=suffixes or frozenset({".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"}))
        if request.method == "HEAD":
            return Response(status_code=200, headers=dict(response.headers))
        return response

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def studio_index(request: Request):
        return shell(STUDIO_ROOT, "index.html", request)

    @app.api_route("/css/{name}", methods=["GET", "HEAD"], include_in_schema=False)
    def studio_css(name: str, request: Request):
        if not STUDIO_CSS_NAME.match(name):
            raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
        return shell(STUDIO_ROOT / "css", name, request, suffixes=frozenset({".css"}))

    @app.api_route("/js/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def studio_js(path: str, request: Request):
        if not STUDIO_JS_PATH.match(path):
            raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
        return shell(STUDIO_ROOT / "js", path, request, suffixes=frozenset({".js"}))

    @app.api_route("/assets/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def studio_asset(path: str, request: Request):
        if not STUDIO_ASSET_PATH.match(path):
            raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
        return shell(STUDIO_ROOT / "assets", path, request, suffixes=IMAGE_SUFFIXES)

    @app.api_route("/legacy", methods=["GET", "HEAD"], include_in_schema=False)
    def legacy_root():
        # Relative links in the legacy shell resolve against the trailing slash.
        return RedirectResponse("/legacy/", status_code=307)

    @app.api_route("/legacy/", methods=["GET", "HEAD"], include_in_schema=False)
    @app.api_route("/legacy/index.html", methods=["GET", "HEAD"], include_in_schema=False)
    def legacy_index(request: Request):
        return shell(FRONTEND_ROOT, "index.html", request, suffixes=frozenset({".html"}))

    @app.api_route("/legacy/{filename}", methods=["GET", "HEAD"], include_in_schema=False)
    def legacy_file(filename: str, request: Request):
        if filename not in LEGACY_ROOT_FILES:
            raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
        return shell(FRONTEND_ROOT, filename, request)

    @app.api_route("/legacy/assets/pattern-studio/{filename}", methods=["GET", "HEAD"], include_in_schema=False)
    def legacy_asset(filename: str, request: Request):
        if filename not in LEGACY_ASSETS:
            raise ServiceError("SHELL_NOT_FOUND", "The requested workbench file is unavailable", 404)
        return shell(FRONTEND_ROOT / "assets" / "pattern-studio", filename, request, suffixes=IMAGE_SUFFIXES)
