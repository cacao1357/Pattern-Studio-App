import pytest
from PIL import Image, ImageDraw

from app.schemas.workbench import LineartRequest
from app.services.lineart import extract_lineart


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
