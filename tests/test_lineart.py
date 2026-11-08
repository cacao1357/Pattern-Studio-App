from io import BytesIO

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.schemas.contracts import ProcessingError
from app.schemas.workbench import LineartRequest
from app.services import model_lineart
from app.services.lineart import extract_lineart
from app.services.local_workbench import LocalWorkbench, execute_local
from app.workbench_store import WorkbenchStore


def test_extract_lineart_returns_white_background_black_ink():
    image = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse([40, 40, 216, 216], outline="black", width=6)
    result = extract_lineart(image)
    assert result.image.size == (256, 256)
    assert result.image.mode == "RGBA"
    assert result.metadata["edges_px"] > 0
    assert 0 < result.metadata["ink_ratio"] < 1
    assert result.metadata["algorithm"] == "lineart-global-local-v2"
    assert result.metadata["background"] == "transparent"
    assert result.image.getpixel((0, 0)) == (0, 0, 0, 0)
    assert result.image.getchannel("A").getextrema()[1] > 0


def test_extract_lineart_handles_flat_and_small_images():
    flat = extract_lineart(Image.new("RGB", (64, 64), "white"))
    assert flat.metadata["edges_px"] == 0
    assert flat.metadata["ink_ratio"] == 0

    small = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    ImageDraw.Draw(small).rectangle([4, 4, 28, 28], fill=(0, 0, 0, 255))
    result = extract_lineart(small, local=False)
    assert result.image.size == (32, 32)


def test_lineart_request_rejects_even_or_too_large_median():
    with pytest.raises(ValueError):
        LineartRequest(input_asset_id="00000000-0000-0000-0000-000000000000", med=4)
    with pytest.raises(ValueError):
        LineartRequest(input_asset_id="00000000-0000-0000-0000-000000000000", med=17)
    request = LineartRequest(input_asset_id="00000000-0000-0000-0000-000000000000", med=9, local=False)
    assert request.med == 9
    assert request.local is False


def test_model_request_rejects_opencv_options():
    with pytest.raises(ValueError, match="OpenCV options"):
        LineartRequest(input_asset_id="00000000-0000-0000-0000-000000000000", method="model", local=True)


def test_model_lineart_job_preserves_coordinates_and_exports_ink_as_alpha(tmp_path, monkeypatch):
    probability = np.tile(np.linspace(0, 1, 512, dtype=np.float32), (512, 1))
    monkeypatch.setattr(model_lineart, "_predict", lambda image: (probability, "cuda"))
    store = WorkbenchStore(tmp_path)
    service = LocalWorkbench(store)
    image = Image.new("RGB", (80, 40), "white")
    data = BytesIO()
    image.save(data, format="PNG")
    uploaded, _, _ = service.upload(data.getvalue(), "pattern.png", "test", "upload-lineart-model")
    source = uploaded["normalized"]
    input_id = source["asset_id"]
    request = LineartRequest(input_asset_id=input_id, method="model")
    submitted = service.submit("lineart", request, "test-lineart-model")
    assert submitted["parameters"] == {"method": "model"}

    job, token = store.claim()
    execute_local(store, job["job_id"], token)
    store.finish_job(job["job_id"], token)
    [asset] = store.get_job(job["job_id"])["result"]["assets"]
    assert asset["kind"] == "lineart"
    assert asset["coordinate_space_id"] == source["coordinate_space_id"]
    assert asset["parents"] == [{"asset_id": input_id, "role": "lineart_rgb"}]
    assert asset["algorithm_version"] == model_lineart.MODEL_VERSION
    assert asset["parameters"]["inference_device"] == "cuda"
    assert asset["ai_inferred"] is True
    assert asset["geometry_verified"] is False

    _, png = store.read_asset(asset["asset_id"])
    with Image.open(BytesIO(png)) as result:
        assert result.size == image.size
        assert result.mode == "RGBA"
        assert result.getpixel((0, 0)) == (0, 0, 0, 0)
        assert result.getpixel((79, 39)) == (0, 0, 0, 255)


def test_missing_model_files_report_installation_error(tmp_path, monkeypatch):
    monkeypatch.setattr(model_lineart, "MODEL_DIR", tmp_path)
    with pytest.raises(ProcessingError) as exc:
        model_lineart.extract_model_lineart(Image.new("RGB", (8, 8), "white"))
    assert exc.value.code == "LINEART_MODEL_UNAVAILABLE"
