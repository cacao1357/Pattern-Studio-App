"""Dataset-level manifest and audit derived from the existing image/job store."""

import csv
from datetime import datetime, timezone
from io import StringIO

from fastapi import Response

from app import versions

FIELDS = (
    "image_id", "content_id", "grade", "grade_version", "split", "license",
    "provenance_status", "source_type", "source_name", "source_url",
    "collected_at", "batch_id", "width", "height", "sha256",
    "original_asset_id", "normalized_asset_id", "source_note", "created_at",
    "label_status", "missing_meta",
)


def mount_datasets(app, current_store):
    @app.get("/api/v1/datasets/manifest.csv")
    def manifest():
        rows = current_store().dataset_rows()
        buffer = StringIO()
        writer = csv.DictWriter(buffer, fieldnames=FIELDS, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in FIELDS})
        return Response(
            "\ufeff" + buffer.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="pattern-studio-dataset-manifest.csv"',
                "Cache-Control": "no-store",
            },
        )

    @app.get("/api/v1/datasets/audit")
    def audit():
        data = current_store().dataset_audit()
        return {
            **data,
            "versions": versions.snapshot(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
