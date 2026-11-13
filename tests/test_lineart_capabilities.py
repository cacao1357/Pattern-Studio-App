"""Lightweight model discovery must not start inference or disable local tools."""

import builtins
import json

import pytest

from app.services import model_lineart
from test_api_p0 import client_for


@pytest.fixture
def installed_model(tmp_path, monkeypatch):
    monkeypatch.setattr(model_lineart, "MODEL_DIR", tmp_path)
    (tmp_path / "model.pt").write_bytes(b"test checkpoint" * 100)
    (tmp_path / "inference.json").write_text(json.dumps(model_lineart.INFERENCE_SPEC), encoding="utf-8")
    monkeypatch.setattr(model_lineart.importlib.util, "find_spec", lambda name: object())
    return tmp_path


def test_available_is_prerequisites_only_without_importing_ml(installed_model, monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name.split(".")[0] in {"torch", "segmentation_models_pytorch"}:
            pytest.fail("Capability discovery imported an ML runtime")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    assert model_lineart.model_capability() == {
        "available": True, "reason": None, "checked": "prerequisites_only",
    }


@pytest.mark.parametrize("missing", ["torch", "segmentation_models_pytorch"])
def test_missing_dependency_is_reported_without_import(installed_model, monkeypatch, missing):
    monkeypatch.setattr(model_lineart.importlib.util, "find_spec", lambda name: None if name == missing else object())
    result = model_lineart.model_capability()
    assert result["available"] is False
    assert result["reason"] == "dependencies_missing"


@pytest.mark.parametrize("artifact", ["model.pt", "inference.json"])
def test_missing_artifact_is_reported(installed_model, artifact):
    (installed_model / artifact).unlink()
    assert model_lineart.model_capability()["reason"] == "model_files_missing"


def test_lfs_pointer_is_not_an_installed_model(installed_model):
    (installed_model / "model.pt").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:placeholder\n")
    assert model_lineart.model_capability()["reason"] == "model_files_missing"


@pytest.mark.parametrize("contents", ["{", "[]", '{"architecture": "wrong"}'])
def test_invalid_model_config_is_reported(installed_model, contents):
    (installed_model / "inference.json").write_text(contents, encoding="utf-8")
    assert model_lineart.model_capability()["reason"] == "model_config_invalid"


def test_discovery_error_is_non_sensitive(installed_model, monkeypatch):
    def broken_spec(name):
        raise ImportError("private diagnostic")

    monkeypatch.setattr(model_lineart.importlib.util, "find_spec", broken_spec)
    assert model_lineart.model_capability() == {
        "available": False, "reason": "model_check_failed", "checked": "prerequisites_only",
    }


def test_unavailable_model_does_not_degrade_healthy_local_service(tmp_path, monkeypatch):
    capability = {"available": False, "reason": "dependencies_missing", "checked": "prerequisites_only"}
    monkeypatch.setattr("app.api.workbench.model_capability", lambda: capability)
    with client_for(tmp_path) as client:
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["capabilities"]["lineart_model"] == capability
