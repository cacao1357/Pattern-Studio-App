"""Batch export keeps selected versions grouped by their registered source image."""

from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
import zipfile

from PIL import Image
from pydantic import ValidationError

from app.schemas.workbench import ExportRequest
from app.services.local_workbench import LocalWorkbench, _export_archive_name, execute_local
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore


class BatchExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkbenchStore(Path(self.temp.name) / "storage")
        self.service = LocalWorkbench(self.store)
        self.images = [self._upload(f"sample-{index}.png") for index in range(2)]

    def tearDown(self):
        self.temp.cleanup()

    def _upload(self, filename):
        data = png_bytes(Image.new("RGBA", (16, 16), (230, 120, 30, 255)))
        record, _, _ = self.service.upload(
            data,
            filename,
            "",
            uuid4().hex,
            provenance_values={"license": "user-confirmed-test-license"},
        )
        return record

    def _export(self, asset_ids, *, layout="by_image", key=None):
        request = ExportRequest(asset_ids=asset_ids, layout=layout, license_acknowledged=True)
        queued = self.service.submit("export", request, key or uuid4().hex)
        job, token = self.store.claim()
        self.assertEqual(job["job_id"], queued["job_id"])
        execute_local(self.store, job["job_id"], token)
        self.store.finish_job(job["job_id"], token)
        return self.store.get_job(job["job_id"])

    def test_by_image_layout_separates_sources_and_manifest_matches_archive_paths(self):
        first, second = self.images
        selected = [first["original"]["asset_id"], first["normalized"]["asset_id"], second["normalized"]["asset_id"]]
        job = self._export(selected)
        self.assertEqual(job["state"], "succeeded")
        result = next(asset for asset in job["result"]["assets"] if asset["kind"] == "zip")
        _, archive_bytes = self.store.read_asset(result["asset_id"])
        with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
            names = set(archive.namelist())
            self.assertIn(f"images/{first['image_id']}/original-{first['original']['asset_id']}.png", names)
            self.assertIn(f"images/{first['image_id']}/normalized_input-{first['normalized']['asset_id']}.png", names)
            self.assertIn(f"images/{second['image_id']}/normalized_input-{second['normalized']['asset_id']}.png", names)
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(
            {asset["archive_name"] for asset in manifest["selected_assets"]},
            names - {"manifest.json"},
        )

    def test_flat_layout_remains_default_and_idempotency_compatible(self):
        asset_id = self.images[0]["normalized"]["asset_id"]
        key = uuid4().hex
        implicit = self.service.submit("export", ExportRequest(asset_ids=[asset_id]), key)
        explicit = self.service.submit("export", ExportRequest(asset_ids=[asset_id], layout="flat"), key)
        self.assertEqual(implicit["job_id"], explicit["job_id"])
        self.assertNotIn("layout", implicit["parameters"])
        job, token = self.store.claim()
        execute_local(self.store, job["job_id"], token)
        self.store.finish_job(job["job_id"], token)
        export = self.store.get_job(job["job_id"])
        zip_asset = next(asset for asset in export["result"]["assets"] if asset["kind"] == "zip")
        _, archive_bytes = self.store.read_asset(zip_asset["asset_id"])
        with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
            self.assertIn(asset_id + ".png", archive.namelist())
        self.assertEqual(
            _export_archive_name(self.images[0]["normalized"], asset_id, ".png", "flat"),
            asset_id + ".png",
        )

    def test_by_image_paths_cannot_use_metadata_or_kind_as_a_path(self):
        asset_id = str(uuid4())
        path = _export_archive_name({"image_id": "../../outside", "kind": "../escape"}, asset_id, ".svg", "by_image")
        self.assertEqual(path, f"images/unlinked-{asset_id}/___escape-{asset_id}.svg")
        self.assertFalse(path.startswith("../"))
        self.assertNotIn("/../", path)

    def test_request_bounds_and_duplicate_ids_are_rejected(self):
        with self.assertRaises(ValidationError):
            ExportRequest(asset_ids=[str(uuid4())] * 2)
        with self.assertRaises(ValidationError):
            ExportRequest(asset_ids=[str(uuid4()) for _ in range(501)])
        request = ExportRequest(asset_ids=[str(uuid4()) for _ in range(500)])
        self.assertEqual(len(request.asset_ids), 500)

    def test_export_still_requires_explicit_license_acknowledgement(self):
        data = png_bytes(Image.new("RGB", (8, 8), "white"))
        record, _, _ = self.service.upload(data, "unlicensed.png", "", uuid4().hex)
        with self.assertRaises(ServiceError) as raised:
            self.service.submit("export", ExportRequest(asset_ids=[record["original"]["asset_id"]]), uuid4().hex)
        self.assertEqual(raised.exception.code, "LICENSE_REVIEW_REQUIRED")


if __name__ == "__main__":
    unittest.main()
