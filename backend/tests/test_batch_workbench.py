"""Persistent per-image batch orchestration without external calls."""

import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

from PIL import Image

from app.schemas.batch_workbench import BatchCreate, PresetCreate, PresetOptions, PresetUpdate
from app.services.batch_workbench import BatchWorkbench
from app.services.local_workbench import LocalWorkbench
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore


class BatchWorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkbenchStore(Path(self.temp.name))
        self.local = LocalWorkbench(self.store)
        self.batches = BatchWorkbench(self.store, self.local)

    def tearDown(self):
        self.temp.cleanup()

    def upload(self, name, size=(64, 64)):
        image = png_bytes(Image.new("RGBA", size, (20, 90, 150, 255)))
        record, created, _ = self.local.upload(image, name + ".png", "", uuid4().hex)
        self.assertTrue(created)
        return record["normalized"]["asset_id"], record["image_id"]

    def preset(self, name, **options):
        defaults = {"recipe": "model_lineart", **options}
        return self.batches.create_preset(PresetCreate(name=name, options=PresetOptions.model_validate(defaults)))

    def make_batch(self, preset, assets, key=None, **consents):
        return self.batches.create_batch(BatchCreate(preset_id=preset["preset_id"], input_asset_ids=assets, **consents), key or uuid4().hex)

    def derived(self, image_id, kind, source):
        metadata = {"kind": kind, "image_id": image_id, "width": 64, "height": 64,
                    "parents": [{"asset_id": source, "role": "test-source"}], "ai_inferred": False}
        staged = self.store._stage([{"data": png_bytes(Image.new("RGBA", (64, 64), "white")),
                                     "suffix": ".png", "metadata": metadata}])
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self.store._register(db, staged)
            db.commit()
        return staged[0][0]["asset_id"]

    def test_builtin_presets_are_seeded_once_and_custom_edits_are_revision_guarded(self):
        self.assertEqual(len(self.batches.presets()["items"]), 3)
        preset = self.preset("本地测试")
        edited = self.batches.update_preset(preset["preset_id"], PresetUpdate(
            name="本地测试2", revision=1, options={"recipe": "color", "vectorize": False, "tile": True}))
        self.assertEqual(edited["revision"], 2)
        with self.assertRaises(ServiceError) as error:
            self.batches.update_preset(preset["preset_id"], PresetUpdate(
                name="旧版本", revision=1, options={"recipe": "color", "vectorize": False, "tile": True}))
        self.assertEqual(error.exception.code, "STALE_REVISION")
        restarted = BatchWorkbench(self.store, self.local)
        self.assertEqual(len(restarted.presets()["items"]), 4)

    def test_manual_gate_only_accepts_expected_asset_from_same_image_then_resumes(self):
        source, image_id = self.upload("flowers")
        preset = self.preset("需要裁切", crop=True)
        batch = self.make_batch(preset, [source])
        item = batch["items"][0]
        self.assertEqual((item["state"], item["waiting_for"]), ("waiting", "crop"))
        wrong_kind = self.derived(image_id, "prepared", source)
        with self.assertRaises(ServiceError) as error:
            self.batches.resume(batch["batch_id"], item["item_id"], batch["revision"], wrong_kind)
        self.assertEqual(error.exception.code, "BATCH_RESUME_ASSET_MISMATCH")
        other, other_image = self.upload("birds")
        other_crop = self.derived(other_image, "cropped", other)
        with self.assertRaises(ServiceError) as error:
            self.batches.resume(batch["batch_id"], item["item_id"], batch["revision"], other_crop)
        self.assertEqual(error.exception.code, "BATCH_RESUME_ASSET_MISMATCH")
        cropped = self.derived(image_id, "cropped", source)
        resumed = self.batches.resume(batch["batch_id"], item["item_id"], batch["revision"], cropped)
        self.assertEqual(resumed["items"][0]["state"], "running")
        self.assertEqual(resumed["items"][0]["steps"][0]["state"], "succeeded")
        self.assertEqual(resumed["items"][0]["steps"][1]["name"], "model_lineart")
        self.assertTrue(resumed["items"][0]["job_id"])

    def test_failure_on_one_image_does_not_stop_other_items(self):
        first, _ = self.upload("one")
        second, _ = self.upload("two")
        batch = self.make_batch(self.preset("two images"), [first, second])
        jobs = [item["job_id"] for item in batch["items"]]
        self.assertTrue(all(jobs))
        with self.store.connection() as db:
            db.execute("UPDATE local_jobs SET state='failed',error_json=? WHERE id=?",
                       (json.dumps({"code": "MODEL_UNAVAILABLE"}), jobs[0]))
            db.commit()
        self.batches.advance()
        current = self.batches.get_batch(batch["batch_id"])
        self.assertEqual([item["state"] for item in current["items"]], ["failed", "running"])
        self.assertEqual(current["items"][1]["job_id"], jobs[1])

    def test_restart_and_same_idempotency_key_reuse_batch_and_child(self):
        source, _ = self.upload("reuse")
        preset = self.preset("restart")
        key = uuid4().hex
        first = self.make_batch(preset, [source], key)
        child = first["items"][0]["job_id"]
        restarted = BatchWorkbench(self.store, self.local)
        again = restarted.create_batch(BatchCreate(preset_id=preset["preset_id"], input_asset_ids=[source]), key)
        self.assertEqual(again["batch_id"], first["batch_id"])
        self.assertEqual(again["items"][0]["job_id"], child)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM local_jobs WHERE id=?", (child,)).fetchone()[0], 1)

    def test_cloud_requires_explicit_consent_and_unknown_job_is_never_resubmitted(self):
        source, _ = self.upload("cloud")
        preset = next(item for item in self.batches.presets()["items"] if item["options"]["recipe"] == "cloud_lineart")
        with self.assertRaises(ServiceError) as error:
            self.make_batch(preset, [source])
        self.assertEqual(error.exception.code, "BATCH_CLOUD_CONSENT_REQUIRED")
        submitted = []

        def submit(service, request, key):
            submitted.append(key)
            return service.store.submit("cloud-lineart", str(request.input_asset_id),
                {"consent_to_upload": True, "consent_to_charge": True}, key)

        self.batches.assisted = type("Cloud", (), {"store": self.store, "local": self.local})()
        with patch("app.services.batch_workbench.submit_cloud_lineart", side_effect=submit):
            batch = self.make_batch(preset, [source], consent_to_upload=True, consent_to_charge=True)
            self.assertEqual(batch["snapshot"]["planned_provider_calls"], 1)
            job_id = batch["items"][0]["job_id"]
            with self.store.connection() as db:
                db.execute("UPDATE local_jobs SET state='failed',error_json=? WHERE id=?",
                           (json.dumps({"code": "OUTCOME_UNKNOWN"}), job_id))
                db.commit()
            self.batches.advance()
            self.batches.advance()
        self.assertEqual(len(submitted), 1)
        current = self.batches.get_batch(batch["batch_id"])
        self.assertEqual(current["items"][0]["state"], "failed")
        self.assertEqual(current["items"][0]["error"]["code"], "OUTCOME_UNKNOWN")

    def test_queued_cloud_batch_cancellation_prevents_upload_and_running_result_is_preserved(self):
        source, _ = self.upload("cancel-cloud")
        preset = next(item for item in self.batches.presets()["items"] if item["options"]["recipe"] == "cloud_lineart")
        self.batches.assisted = type("Cloud", (), {"store": self.store, "local": self.local})()

        def queue_cloud(service, request, key):
            return service.store.submit("cloud-lineart", str(request.input_asset_id),
                {"consent_to_upload": True, "consent_to_charge": True}, key)

        with patch("app.services.batch_workbench.submit_cloud_lineart", side_effect=queue_cloud):
            queued = self.make_batch(preset, [source], consent_to_upload=True, consent_to_charge=True)
            cancelled = self.batches.cancel(queued["batch_id"], queued["revision"])
            queued_job = self.store.get_job(queued["items"][0]["job_id"])
            self.assertEqual((cancelled["items"][0]["state"], queued_job["state"]), ("cancelled", "cancelled"))

            running = self.make_batch(preset, [source], consent_to_upload=True, consent_to_charge=True)
            running_job_id = running["items"][0]["job_id"]
            with self.store.connection() as db:
                db.execute("UPDATE local_jobs SET state='running' WHERE id=?", (running_job_id,))
                db.commit()
            stopping = self.batches.cancel(running["batch_id"], running["revision"])
            self.assertEqual(stopping["items"][0]["state"], "cancelling")
            with self.store.connection() as db:
                db.execute("UPDATE local_jobs SET state='failed',error_json=? WHERE id=?",
                           (json.dumps({"code": "PROVIDER_OUTCOME_UNKNOWN"}), running_job_id))
                db.commit()
            self.batches.advance()
            stopped = self.batches.get_batch(running["batch_id"])
        self.assertEqual(stopped["items"][0]["state"], "cancelled")
        self.assertEqual(stopped["items"][0]["error"]["code"], "PROVIDER_OUTCOME_UNKNOWN")
        self.assertEqual(stopped["items"][0]["provider_job_state"], "failed")

    def test_stale_resume_and_cancel_revisions_are_rejected(self):
        source, _ = self.upload("revision")
        batch = self.make_batch(self.preset("revision", crop=True), [source])
        item = batch["items"][0]
        with self.assertRaises(ServiceError) as error:
            self.batches.cancel(batch["batch_id"], batch["revision"] - 1)
        self.assertEqual(error.exception.code, "STALE_REVISION")
        self.assertEqual(self.batches.cancel(batch["batch_id"], batch["revision"])["items"][0]["state"], "cancelled")

    def test_invalid_preset_step_fails_only_its_image(self):
        first, _ = self.upload("small")
        second, _ = self.upload("other")
        preset = self.preset("out of bounds", recipe="color", extract={"mode": "manual", "bbox": {
            "left": 0, "top": 0, "right": 65, "bottom": 64}}, vectorize=False, tile=True)
        batch = self.make_batch(preset, [first, second])
        self.assertEqual([item["state"] for item in batch["items"]], ["failed", "failed"])
        self.assertEqual([item["error"]["code"] for item in batch["items"]], ["BBOX_OUT_OF_BOUNDS"] * 2)

    def test_explicit_large_image_working_copy_is_a_recorded_queued_job(self):
        source, _ = self.upload("large", size=(1100, 1000))
        preset = self.preset("bounded color", recipe="color", vector={"mode": "color"},
                             working_max_pixels=250_000, vectorize=False, tile=True)
        batch = self.make_batch(preset, [source])
        item = batch["items"][0]
        self.assertEqual(item["steps"][0]["name"], "working_copy")
        job = self.store.get_job(item["job_id"])
        self.assertEqual((job["kind"], job["parameters"]["max_pixels"]), ("working-copy", 250_000))

    def test_batch_over_20_images_waits_for_queue_capacity_and_resumes_after_restart(self):
        source, image_id = self.upload("queue")
        assets = [source] + [self.derived(image_id, "cropped", source) for _ in range(20)]
        batch = self.make_batch(self.preset("queue stress"), assets)
        self.assertEqual(len(batch["items"]), 21)
        self.assertEqual([item["state"] for item in batch["items"]].count("running"), 20)
        self.assertEqual(batch["items"][-1]["state"], "queued")
        self.assertIsNone(batch["items"][-1]["error"])
        first_job = batch["items"][0]["job_id"]
        self.store.cancel_job(first_job)
        resumed = BatchWorkbench(self.store, self.local)
        resumed.advance()
        current = resumed.get_batch(batch["batch_id"])
        self.assertEqual(current["items"][0]["state"], "cancelled")
        self.assertEqual(current["items"][-1]["state"], "running")
        active_ids = [item["job_id"] for item in current["items"] if item["job_id"]]
        self.assertEqual(len(active_ids), 20)
        self.assertEqual(len(active_ids), len(set(active_ids)))

    def test_lineart_mask_preset_adds_alpha_prepare_step_for_existing_mask_editor(self):
        source, image_id = self.upload("alpha-mask")
        preset = self.preset("lineart mask", recipe="model_lineart", mask=True)
        batch = self.make_batch(preset, [source])
        item = batch["items"][0]
        self.assertEqual([step["name"] for step in item["steps"]],
                         ["model_lineart", "prepare_mask", "mask", "vectorize"])
        lineart = self.derived(image_id, "lineart", source)
        fake_batch = {"snapshot": {"options": preset["options"]}}
        fake_item = {"item_id": item["item_id"], "cursor": 1, "current_asset_id": lineart}
        prepared = self.batches._submit_step(fake_batch, fake_item, "prepare_mask")
        job = self.store.get_job(prepared["job_id"])
        self.assertEqual((job["kind"], job["parameters"]["mode"]), ("extract", "alpha"))

    def test_cancelled_child_job_stays_cancelled_after_coordinator_restart(self):
        source, _ = self.upload("cancel-child")
        batch = self.make_batch(self.preset("cancel child"), [source])
        job_id = batch["items"][0]["job_id"]
        self.store.cancel_job(job_id)
        restarted = BatchWorkbench(self.store, self.local)
        restarted.advance()
        item = restarted.get_batch(batch["batch_id"])["items"][0]
        self.assertEqual(item["state"], "cancelled")
        self.assertEqual(item["steps"][0]["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
