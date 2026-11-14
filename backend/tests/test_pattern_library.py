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

    def add_job(self, input_id, state="succeeded"):
        job_id, timestamp = str(uuid4()), "2026-01-01T00:00:00Z"
        with self.store.connection() as db:
            db.execute("""INSERT INTO local_jobs
                (id,kind,input_id,parameters,state,created_at,updated_at,finished_at,result_json)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (job_id, "lineart", input_id, "{}", state, timestamp, timestamp,
                 timestamp if state == "succeeded" else None,
                 json.dumps({"assets": [], "steps": []})))
        return job_id

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

    def test_delete_pattern_removes_only_that_group(self):
        target, other = self.images[0], self.images[1]
        untouched = self.images[2]
        derivative = self.add_derivative(target, "lineart")
        job_id = self.add_job(derivative)
        image = self.store.get_image(target)
        original_id = image["original"]["asset_id"]
        original_path = self.store.assets_root / (original_id + ".png")
        derivative_path = self.store.assets_root / (derivative + ".png")
        derivative_path.write_bytes(self.png)
        self.assertTrue(original_path.is_file())
        with self.client() as client:
            category = client.post("/api/v1/pattern-categories", json={"name": "祥云"}).json()
            assigned = client.put(f"/api/v1/patterns/{target}/categories", json={
                "category_ids": [category["category_id"]], "revision": 0,
            })
            self.assertEqual(200, assigned.status_code)

            deleted = client.delete(f"/api/v1/patterns/{target}")
            self.assertEqual(200, deleted.status_code)
            self.assertEqual(target, deleted.json()["image_id"])
            self.assertTrue(deleted.json()["deleted"])
            self.assertGreaterEqual(deleted.json()["assets"], 3)
            self.assertEqual(1, deleted.json()["jobs"])

            remaining = client.get("/api/v1/patterns").json()["items"]
            self.assertEqual({other, untouched}, {item["image_id"] for item in remaining})
            self.assertEqual(404, client.get(f"/api/v1/patterns/{target}").status_code)
            filtered = client.get("/api/v1/patterns", params={"category_id": category["category_id"]}).json()
            self.assertEqual([], filtered["items"])
            self.assertEqual(1, len(client.get("/api/v1/pattern-categories").json()["items"]))

        self.assertFalse(original_path.exists())
        self.assertFalse(derivative_path.exists())
        with self.store.connection() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM images WHERE id=?", (target,)).fetchone())
            self.assertIsNone(db.execute("SELECT 1 FROM assets WHERE id=?", (derivative,)).fetchone())
            self.assertIsNone(db.execute("SELECT 1 FROM local_jobs WHERE id=?", (job_id,)).fetchone())
            self.assertIsNone(db.execute(
                "SELECT 1 FROM pattern_category_members WHERE image_id=?", (target,)).fetchone())
            self.assertEqual(2, db.execute("SELECT count(*) FROM images").fetchone()[0])
        self.assertIsNotNone(self.store.get_asset(self.store.get_image(other)["original"]["asset_id"]))

    def test_delete_pattern_refuses_while_a_task_is_active(self):
        image_id = self.images[0]
        derivative = self.add_derivative(image_id, "lineart")
        self.add_job(derivative, state="queued")
        with self.client() as client:
            refused = client.delete(f"/api/v1/patterns/{image_id}")
            self.assertEqual(409, refused.status_code)
            self.assertEqual("PATTERN_BUSY", refused.json()["error"]["code"])
            self.assertEqual(image_id, client.get(f"/api/v1/patterns/{image_id}").json()["image_id"])

    def test_delete_pattern_refuses_inside_a_running_batch(self):
        image_id = self.images[0]
        with self.store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS processing_batches (
                id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, snapshot TEXT NOT NULL,
                items_json TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("""INSERT INTO processing_batches VALUES (?,?,?,?,?,?,?,?,?,?)""",
                       (str(uuid4()), "preset", "{}",
                        json.dumps([{"item_id": str(uuid4()), "image_id": image_id, "state": "waiting"}]),
                        "running", 1, uuid4().hex, "hash", "now", "now"))
        with self.client() as client:
            refused = client.delete(f"/api/v1/patterns/{image_id}")
            self.assertEqual(409, refused.status_code)
            self.assertEqual("PATTERN_IN_BATCH", refused.json()["error"]["code"])
            self.assertEqual(image_id, client.get(f"/api/v1/patterns/{image_id}").json()["image_id"])

    def test_delete_pattern_removes_workflow_history_and_idempotency_keys(self):
        target, other = self.images[0], self.images[1]
        image = self.store.get_image(target)
        normalized, derivative = image["normalized"]["asset_id"], self.add_derivative(target, "lineart")
        first, second = self.add_job(normalized), self.add_job(derivative)
        flow_id, feedback_id = str(uuid4()), str(uuid4())
        with self.store.connection() as db:
            db.execute("""INSERT INTO ai_flows VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                       (flow_id, normalized, first, second, "continuing", 2,
                        json.dumps({"vector": {}, "workflow": None}), "[]", None, "now", "now"))
            db.execute("INSERT INTO workflow_branches VALUES (?,?,?,?)", (second, flow_id, first, "rerun"))
            db.execute("INSERT INTO workflow_selections VALUES (?,?)", (flow_id, "{}"))
            db.execute("INSERT INTO feedback VALUES (?,?,?,?)", (feedback_id, first, "{}", "now"))
            db.execute("INSERT INTO consents VALUES (?,?,?,?,?,?)",
                       (str(uuid4()), feedback_id, "v1", 0, 0, "now"))
            db.execute("INSERT INTO repair_decisions VALUES (?,?,?)", (first, "{}", "now"))
            db.execute("INSERT INTO local_pipelines VALUES (?,?)", (first, "{}"))
            db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", ("images", uuid4().hex, "h", target))
            db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", ("jobs/lineart", uuid4().hex, "h", first))
            db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", ("images", uuid4().hex, "h", other))
        with self.client() as client:
            deleted = client.delete(f"/api/v1/patterns/{target}")
            self.assertEqual(200, deleted.status_code)
            self.assertEqual(2, deleted.json()["jobs"])
        with self.store.connection() as db:
            for table in ("ai_flows", "workflow_branches", "workflow_selections", "feedback",
                          "repair_decisions", "local_pipelines"):
                self.assertEqual(0, db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], table)
            self.assertEqual(0, db.execute("SELECT count(*) FROM consents").fetchone()[0])
            remaining_keys = {row["target_id"] for row in db.execute("SELECT target_id FROM local_keys")}
            self.assertIn(other, remaining_keys)
            self.assertFalse(remaining_keys & {target, normalized, derivative, first, second, feedback_id})

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
