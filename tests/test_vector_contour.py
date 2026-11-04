import pytest
from PIL import Image, ImageDraw

from app.schemas.contracts import ProcessingError, VectorOptions
from app.services.vector import vectorize


def ring_image():
    image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse([20, 20, 180, 180], fill=(20, 30, 40, 255))
    draw.ellipse([70, 70, 130, 130], fill=(0, 0, 0, 0))
    return image


def test_contour_vectorize_preserves_holes_and_validates_svg():
    result = vectorize(ring_image(), VectorOptions(mode="contour", detail="medium"))
    assert result.metadata["mode"] == "contour"
    assert result.metadata["contours"] == 1
    assert result.metadata["holes"] == 1
    assert result.metadata["path_count"] == 1
    assert 'fill-rule="evenodd"' in result.svg
    assert 'fill="#1B2B54"' in result.svg
    assert result.metadata["fill_policy"] == "solid_ink"


def test_contour_vectorize_rejects_empty_alpha():
    with pytest.raises(ProcessingError) as error:
        vectorize(Image.new("RGBA", (64, 64), (0, 0, 0, 0)), VectorOptions(mode="contour"))
    assert error.value.code == "EMPTY_MASK"


def test_contour_detail_changes_simplification():
    low = vectorize(ring_image(), VectorOptions(mode="contour", detail="low"))
    high = vectorize(ring_image(), VectorOptions(mode="contour", detail="high"))
    assert low.metadata["epsilon"] > high.metadata["epsilon"]
    assert len(low.svg) <= len(high.svg)
