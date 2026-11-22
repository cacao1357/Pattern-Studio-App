"""Scoped local preview server for the studio template.

Only three prefixes are readable:
  /design/studio-template/       the template itself
  /design/frontend-redesign/styles.css  the original prototype stylesheet
  /frontend/next-v2/assets/      demo imagery and favicon

Everything else in the repository (storage, settings, .env, source) returns 404.
The template itself makes no network requests; this server only exists so the
same relative URLs work over http:// as they do over file://.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
DIRECTORIES = (ROOT / "design/studio-template", ROOT / "frontend/next-v2/assets")
STYLESHEET = ROOT / "design/frontend-redesign/styles.css"
MISSING = ROOT / "__preview_only_allowlisted_paths__"


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        target = Path(super().translate_path(path)).resolve()
        for directory in DIRECTORIES:
            if target.is_relative_to(directory):
                return str(target)
        return str(STYLESHEET if target == STYLESHEET else MISSING)

    def do_GET(self):
        raw_path = urlsplit(self.path).path
        if raw_path in {"", "/"}:
            self.send_response(302)
            self.send_header("Location", "/design/studio-template/")
            self.end_headers()
            return
        if raw_path == "/design/studio-template":
            self.send_response(302)
            self.send_header("Location", "/design/studio-template/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    address = ("127.0.0.1", 8790)
    print(f"Studio template preview: http://{address[0]}:{address[1]}/design/studio-template/", flush=True)
    ThreadingHTTPServer(address, PreviewHandler).serve_forever()
