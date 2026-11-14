"""Focused tests for the user-curated workbench rail."""

import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image

from app.api.pattern_library import mount_pattern_library
from app.api.workbench_items import mount_workbench_items
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore


class WorkbenchItemsTests(unittest.TestCase):
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

    def client(self):
        app = FastAPI()
        app.add_exception_handler(ServiceError, lambda _request, error: JSONResponse(
            {"error": {"code": error.code, "message": str(error)}}, status_code=error.status))
        mount_pattern_library(app, lambda: self.store)
        mount_workbench_items(app, lambda: self.store)
        return TestClient(app)

    def add_derivative(self, image_id, kind):
        asset_id = str(uuid4())
        record = {"asset_id": asset_id, "kind": kind, "filename": f"{kind}.png", "width": 24,
                  "height": 24, "image_id": image_id, "created_at": "2026-01-01T00:00:00Z"}
        with self.store.connection() as db:
            db.execute("INSERT INTO assets VALUES (?,?,?)", (asset_id, ".png", json.dumps(record)))
            image = db.execute("SELECT original_id FROM images WHERE id=?", (image_id,)).fetchone()
            db.execute("INSERT INTO asset_relations VALUES (?,?,?)", (asset_id, image[0], "derived_from"))
        return asset_id

    def test_added_items_are_listed_newest_first_and_survive_reload(self):
        first, second, third = self.images
        with self.client() as client:
            self.assertEqual({"items": [], "next_cursor": None},
                             client.get("/api/v1/workbench/items").json())
            added = client.post("/api/v1/workbench/items",
                                json={"image_ids": [first, second]}).json()
            self.assertEqual([first, second], added["added"])
            # Same ids again are idempotent and do not reorder the rail.
            again = client.post("/api/v1/workbench/items",
                                json={"image_ids": [first]}).json()
            self.assertEqual([], again["added"])
            self.assertEqual(1, again["existing_count"])
            client.post("/api/v1/workbench/items", json={"image_ids": [third]})
            page = client.get("/api/v1/workbench/items", params={"limit": 2}).json()
            self.assertEqual([third, second], [item["image_id"] for item in page["items"]])
            self.assertTrue(page["next_cursor"])
            self.assertEqual(2, len(page["items"][0]["assets"]))
            rest = client.get("/api/v1/workbench/items",
                              params={"limit": 2, "cursor": page["next_cursor"]}).json()
            self.assertEqual([first], [item["image_id"] for item in rest["items"]])
            self.assertIsNone(rest["next_cursor"])

    def test_remove_only_drops_membership_and_unknown_ids_are_reported(self):
        first, second, _ = self.images
        with self.client() as client:
            client.post("/api/v1/workbench/items", json={"image_ids": [first, second]})
            missing = str(uuid4())
            added = client.post("/api/v1/workbench/items",
                                json={"image_ids": [first, missing]}).json()
            self.assertEqual([missing], added["missing"])
            removed = client.request("DELETE", "/api/v1/workbench/items",
                                     json={"image_ids": [first]}).json()
            self.assertEqual(1, removed["removed"])
            self.assertEqual([second], [item["image_id"]
                                        for item in client.get("/api/v1/workbench/items").json()["items"]])
            # Removing from the rail never removes the image or its versions.
            self.assertEqual(first, client.get(f"/api/v1/patterns/{first}").json()["image_id"])

    def test_deleting_a_pattern_also_removes_its_workbench_membership(self):
        first, second, third = self.images
        self.add_derivative(first, "lineart")
        with self.client() as client:
            client.post("/api/v1/workbench/items", json={"image_ids": [first, second]})
            deleted = client.delete(f"/api/v1/patterns/{first}")
            self.assertEqual(200, deleted.status_code)
            self.assertEqual([second], [item["image_id"]
                                        for item in client.get("/api/v1/workbench/items").json()["items"]])
            with self.store.connection() as db:
                self.assertIsNone(db.execute("SELECT 1 FROM images WHERE id=?", (first,)).fetchone())
                self.assertIsNone(db.execute("SELECT 1 FROM workbench_items WHERE image_id=?",
                                             (first,)).fetchone())
            self.assertEqual([third, second], [item["image_id"]
                                               for item in client.get("/api/v1/patterns").json()["items"]])

    def test_payload_validation_and_duplicate_selection(self):
        first = self.images[0]
        with self.client() as client:
            empty = client.post("/api/v1/workbench/items", json={"image_ids": []})
            self.assertEqual(422, empty.status_code)
            too_many = client.post("/api/v1/workbench/items",
                                   json={"image_ids": [str(uuid4()) for _ in range(201)]})
            self.assertEqual(422, too_many.status_code)
            duplicate = client.post("/api/v1/workbench/items",
                                    json={"image_ids": [first, first]}).json()
            self.assertEqual([first], duplicate["added"])
            with self.store.connection() as db:
                self.assertEqual(1, db.execute("SELECT count(*) FROM workbench_items").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
