"""Backfill P0 image_meta for images registered before the data-quality release.

This script only inserts image-level measurements. It never rewrites assets,
jobs or the source image, and it is safe to run repeatedly (existing rows are
left untouched). Run it with the API stopped, using the project environment:

    .\\.venv\\Scripts\\python.exe -B scripts/backfill_metrics.py --dry-run
    .\\.venv\\Scripts\\python.exe -B scripts/backfill_metrics.py
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image

from app import versions
from app.services import quality
from app.services.provenance import normalize_provenance
from app.storage import now
from app.workbench_store import WorkbenchStore


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage", default=str(ROOT / "storage" / "api"))
    parser.add_argument("--dry-run", action="store_true", help="只报告缺指标的旧图片，不写入")
    args = parser.parse_args(argv)

    store = WorkbenchStore(Path(args.storage))
    pending = store.images_without_meta()
    print(f"旧图片缺少指标: {len(pending)}")
    if not pending or args.dry_run:
        return 0

    provenance = normalize_provenance({})
    written = failed = 0
    for row in pending:
        try:
            _, data = store.read_asset(row["original_id"])
            with Image.open(BytesIO(data)) as loaded:
                loaded.load()
                image = loaded.copy()
            measured = quality.analyze(image)
            content_id = quality.content_id_of(data)
            meta = {
                **provenance,
                "content_id": content_id,
                "grade": measured["grade"],
                "grade_version": measured["grade_version"],
                "short_side": measured["short_side"],
                "sharpness": measured["sharpness"],
                "contrast": measured["contrast"],
                "ref_size": measured["ref_size"],
                "ref_fit": measured["ref_fit"],
                "ahash": measured["ahash"],
                "fingerprint_version": measured["fingerprint_version"],
                "split": quality.assign_split(content_id),
                "normalization_version": versions.NORMALIZATION_VERSION,
            }
            with store.connection() as db:
                db.execute("""INSERT OR IGNORE INTO image_meta
                    (image_id,content_id,grade,grade_version,short_side,sharpness,contrast,
                     ref_size,ref_fit,ahash,fingerprint_version,split,source_type,source_name,
                     source_url,license,collected_at,batch_id,provenance_status,
                     normalization_version,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (row["id"], meta["content_id"], meta["grade"], meta["grade_version"],
                     meta["short_side"], meta["sharpness"], meta["contrast"], meta["ref_size"],
                     meta["ref_fit"], meta["ahash"], meta["fingerprint_version"], meta["split"],
                     meta["source_type"], meta["source_name"], meta["source_url"], meta["license"],
                     meta["collected_at"], meta["batch_id"], meta["provenance_status"],
                     meta["normalization_version"], now()))
            written += 1
        except Exception as error:  # noqa: BLE001 - report one broken image and keep going
            failed += 1
            print(f"跳过 {row['id']}: {type(error).__name__}")
    print(f"补写完成: {written} 张，失败 {failed} 张")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
