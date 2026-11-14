"""Focused tests for pattern grouping, filtered pagination and category CAS."""

import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore
from app.api.pattern_library import mount_pattern_library


class PatternLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkbenchStore(Path(self.temp.name))
        self.png = png_bytes(Image.new("RGBA", (24, 24), (220, 30, 40, 255)))
        self.images = [self.add_image(name) for name in ("old.png", "middle.png", "new.png")]

    def tearDown(self):
        self.temp.cleanup()

    def add_image(self, name):
        outputs = [{"data": self.png, "suffix": ".png", "metadata": {
            "kind": kind, "filename": name, "width": 24, "height": 24,
        }} for kind in ("original", "normalized_input")]
        result, created, _ = self.store.add_image(outputs, name, uuid4().hex, "hash-" + uuid4().hex)
        self.assertTrue(created)
        return result["image_id"]

    def add_derivative(self, image_id, kind):
        asset_id = str(uuid4())
        record = {"asset_id": asset_id, "kind": kind, "filename": f"{kind}.png", "width": 24,
                  "height": 24, "image_id": image_id, "created_at": "2026-01-01T00:00:00Z"}
        with self.store.connection() as db:
            db.execute("INSERT INTO assets VALUES (?,?,?)", (asset_id, ".png", json.dumps(record)))
            image = db.execute("SELECT original_id FROM images WHERE id=?", (image_id,)).fetchone()
            db.execute("INSERT INTO asset_relations VALUES (?,?,?)", (asset_id, image[0], "derived_from"))
        return asset_id

    def client(self):
        app = FastAPI()
        from fastapi.responses import JSONResponse
        app.add_exception_handler(ServiceError, lambda _request, error: JSONResponse(
            {"error": {"code": error.code, "message": str(error)}}, status_code=error.status))
        mount_pattern_library(app, lambda: self.store)
        return TestClient(app)

    def test_groups_derivatives_and_filtered_pagination_across_all_images(self):
        first, second, third = self.images
        first_derivative = self.add_derivative(first, "svg")
        self.add_derivative(second, "lineart")
        self.add_derivative(third, "lineart")
        with self.client() as client:
            page_one = client.get("/api/v1/patterns", params={"kind": "lineart", "limit": 1}).json()
            self.assertEqual([third], [item["image_id"] for item in page_one["items"]])
            self.assertTrue(page_one["next_cursor"])
            page_two = client.get("/api/v1/patterns", params={"kind": "lineart", "limit": 1,
                                                               "cursor": page_one["next_cursor"]}).json()
            self.assertEqual([second], [item["image_id"] for item in page_two["items"]])
            self.assertIsNone(page_two["next_cursor"])
            grouped = client.get(f"/api/v1/patterns/{first}").json()
            self.assertIn(first_derivative, [asset["asset_id"] for asset in grouped["assets"]])
            self.assertEqual(first, grouped["image_id"])

    def test_category_membership_is_many_to_many_and_revision_checked(self):
        image_id = self.images[0]
        with self.client() as client:
            a = client.post("/api/v1/pattern-categories", json={"name": " 祥云 "})
            b = client.post("/api/v1/pattern-categories", json={"name": "花卉"})
            self.assertEqual(201, a.status_code)
            self.assertEqual(201, b.status_code)
            assigned = client.put(f"/api/v1/patterns/{image_id}/categories", json={
                "category_ids": [a.json()["category_id"], b.json()["category_id"]], "revision": 0,
            })
            self.assertEqual(1, assigned.json()["revision"])
            stale = client.put(f"/api/v1/patterns/{image_id}/categories", json={
                "category_ids": [], "revision": 0,
            })
            self.assertEqual(409, stale.status_code)
            category_page = client.get("/api/v1/patterns", params={"category_id": a.json()["category_id"]}).json()
            self.assertEqual([image_id], [item["image_id"] for item in category_page["items"]])
            renamed = client.put(f"/api/v1/pattern-categories/{a.json()['category_id']}", json={
                "name": "传统祥云", "revision": 1,
            })
            self.assertEqual(2, renamed.json()["revision"])
            duplicate = client.post("/api/v1/pattern-categories", json={"name": "传统祥云"})
            self.assertEqual(409, duplicate.status_code)
            deleted = client.delete(f"/api/v1/pattern-categories/{a.json()['category_id']}", params={"revision": 2})
            self.assertTrue(deleted.json()["deleted"])
            still_there = client.get(f"/api/v1/patterns/{image_id}").json()
            self.assertEqual([b.json()["category_id"]], still_there["category_ids"])
            self.assertEqual(2, still_there["revision"])
            stale_after_delete = client.put(f"/api/v1/patterns/{image_id}/categories", json={
                "category_ids": [b.json()["category_id"]], "revision": 1,
            })
            self.assertEqual(409, stale_after_delete.status_code)
            self.assertEqual(image_id, self.store.get_image(image_id)["image_id"])

    def test_rejects_duplicate_category_ids_and_invalid_names(self):
        with self.client() as client:
            bad = client.post("/api/v1/pattern-categories", json={"name": "   "})
            self.assertEqual(422, bad.status_code)
            category = client.post("/api/v1/pattern-categories", json={"name": "几何"}).json()
            image_id = self.images[0]
            duplicate = client.put(f"/api/v1/patterns/{image_id}/categories", json={
                "category_ids": [category["category_id"], category["category_id"]], "revision": 0,
            })
            self.assertEqual(422, duplicate.status_code)
            malformed_cursor = client.get("/api/v1/patterns", params={"cursor": "-1"})
            self.assertEqual(422, malformed_cursor.status_code)


if __name__ == "__main__":
    unittest.main()
