"""Bounded, human-declared provenance fields for uploads and exports.

Nothing here verifies a license: these are declarations written into the local
record and the export manifest.  A missing declaration stays "未确认" and can
only block/annotate an explicit export, never local editing.
"""

from __future__ import annotations

import re
from datetime import date

from app.storage import ServiceError

LICENSE_UNCONFIRMED = "未确认"
SOURCE_UNCONFIRMED = "未确认"
PROVENANCE_VERSION = "p0-v1"

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BATCH = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_URL = re.compile(r"^https?://[^\s<>\"']+$")


def _text(value: object, name: str, limit: int) -> str:
    text = "" if value is None else str(value).strip()
    if any(ord(character) < 32 for character in text):
        raise ServiceError("INVALID_PROVENANCE", f"{name} contains a control character", 422)
    if len(text) > limit:
        raise ServiceError("INVALID_PROVENANCE", f"{name} exceeds {limit} characters", 422)
    return text


def normalize_provenance(values: dict | None) -> dict:
    """Validate and normalize optional upload provenance fields."""
    values = values or {}
    source_type = _text(values.get("source_type"), "source_type", 32) or SOURCE_UNCONFIRMED
    source_name = _text(values.get("source_name"), "source_name", 200)
    source_url = _text(values.get("source_url"), "source_url", 500)
    license_name = _text(values.get("license"), "license", 100) or LICENSE_UNCONFIRMED
    collected_at = _text(values.get("collected_at"), "collected_at", 10)
    batch_id = _text(values.get("batch_id"), "batch_id", 64)

    if source_url and not _URL.fullmatch(source_url):
        raise ServiceError("INVALID_PROVENANCE", "source_url must be an http(s) URL without spaces", 422)
    if collected_at:
        if not _DATE.fullmatch(collected_at):
            raise ServiceError("INVALID_PROVENANCE", "collected_at must be YYYY-MM-DD", 422)
        try:
            date.fromisoformat(collected_at)
        except ValueError:
            raise ServiceError("INVALID_PROVENANCE", "collected_at is not a valid date", 422) from None
    if batch_id and not _BATCH.fullmatch(batch_id):
        raise ServiceError("INVALID_PROVENANCE", "batch_id may contain letters, digits, _ and - only", 422)

    declared = bool(
        source_type != SOURCE_UNCONFIRMED
        or source_name
        or source_url
        or license_name != LICENSE_UNCONFIRMED
        or collected_at
    )
    return {
        "source_type": source_type,
        "source_name": source_name,
        "source_url": source_url,
        "license": license_name,
        "collected_at": collected_at,
        "batch_id": batch_id,
        "provenance_status": "declared" if declared else "unverified",
        "provenance_version": PROVENANCE_VERSION,
    }


def is_license_confirmed(metadata: dict | None) -> bool:
    """A license is considered declared when it is present and not the sentinel."""
    if not metadata:
        return False
    license_name = str(metadata.get("license") or "").strip()
    return bool(license_name) and license_name != LICENSE_UNCONFIRMED


def license_label(metadata: dict | None) -> str:
    if not metadata:
        return LICENSE_UNCONFIRMED
    return str(metadata.get("license") or LICENSE_UNCONFIRMED).strip() or LICENSE_UNCONFIRMED
