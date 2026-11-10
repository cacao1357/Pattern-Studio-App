"""The integrated shell serves / while the preserved frontend stays under /legacy/."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app


ROOT = Path(__file__).resolve().parents[1]
STUDIO = ROOT / "frontend" / "next-v2" / "index.html"

pytestmark = pytest.mark.skipif(not STUDIO.is_file(), reason="the integrated shell is not present in this checkout")


def client_for(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""), storage_root=tmp_path / "api")
    return TestClient(create_app(settings), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))


def test_integrated_shell_is_served_at_root(tmp_path):
    with client_for(tmp_path) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert "纹样工作台" in index.text
        csp = index.headers["content-security-policy"]
        # Inline style attributes are still needed for real geometry overlays.
        assert "style-src 'self' 'unsafe-inline'" in csp
        assert "img-src 'self' data: blob:" in csp
        assert "script-src 'self'" in csp

        assert client.get("/css/tokens.css").status_code == 200
        assert client.get("/js/views/home.js").status_code == 200
        assert client.get("/assets/favicon.svg").status_code == 200
        assert client.head("/").status_code == 200


def test_legacy_shell_stays_isolated_under_legacy(tmp_path):
    with client_for(tmp_path) as client:
        redirect = client.get("/legacy", follow_redirects=False)
        assert redirect.status_code == 307
        assert redirect.headers["location"] == "/legacy/"

        legacy = client.get("/legacy/")
        assert legacy.status_code == 200
        assert "Pattern Studio" in legacy.text
        # The legacy shell keeps its stricter policy (no inline styles, no data: images).
        csp = legacy.headers["content-security-policy"]
        assert "style-src 'self';" in csp
        assert "data:" not in csp

        for path in ("/legacy/workbench.js", "/legacy/styles.css", "/legacy/assets/pattern-studio/lotus-mark.svg"):
            assert client.get(path).status_code == 200, path

        # Test modules and anything outside the shell are not exposed.
        assert client.get("/legacy/tests/settings.test.mjs").status_code == 404
        assert client.get("/js/../backend/app/main.py").status_code == 404
        assert client.get("/legacy/%2e%2e/backend/app/main.py").status_code == 404
