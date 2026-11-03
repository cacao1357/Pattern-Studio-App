import pytest

from app.services.provenance import (
    LICENSE_UNCONFIRMED,
    is_license_confirmed,
    license_label,
    normalize_provenance,
)
from app.storage import ServiceError


def test_defaults_are_unconfirmed():
    result = normalize_provenance(None)
    assert result["source_type"] == "未确认"
    assert result["license"] == LICENSE_UNCONFIRMED
    assert result["provenance_status"] == "unverified"
    assert not is_license_confirmed(result)
    assert license_label(result) == LICENSE_UNCONFIRMED


def test_declared_provenance():
    result = normalize_provenance({
        "source_type": "museum_photo",
        "source_name": "馆藏编号 123",
        "source_url": "https://example.org/item/123",
        "license": "CC-BY-4.0",
        "collected_at": "2026-10-24",
        "batch_id": "batch-20261024",
    })
    assert result["provenance_status"] == "declared"
    assert is_license_confirmed(result)
    assert license_label(result) == "CC-BY-4.0"


@pytest.mark.parametrize("payload", [
    {"source_url": "javascript:alert(1)"},
    {"source_url": "https://example.org/a b"},
    {"collected_at": "2026/10/24"},
    {"collected_at": "2026-02-31"},
    {"batch_id": "批次 1"},
    {"source_name": "x" * 201},
])
def test_invalid_provenance_rejected(payload):
    with pytest.raises(ServiceError) as error:
        normalize_provenance(payload)
    assert error.value.code == "INVALID_PROVENANCE"
    assert error.value.status == 422
    assert "javascript" not in str(error.value)
    assert "2026/10/24" not in str(error.value)


def test_control_characters_rejected():
    with pytest.raises(ServiceError):
        normalize_provenance({"source_name": "bad\x00name"})
