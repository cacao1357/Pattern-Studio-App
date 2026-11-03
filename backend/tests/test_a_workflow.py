"""Offline HTTP/storage integration tests; all provider traffic uses MockTransport."""

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.config import DEFAULT_MODEL, Settings
from app.main import create_app
from app.schemas.contracts import ProcessingError
from app.services.assisted_workbench import execute_decomposition
from app.services.assisted_workbench import AssistedWorkbench
from app.schemas.assisted import RerunRequest
from app.services.local_workbench import execute_local
from app.services.workflow import WorkflowCoordinator
from app.storage import ServiceError, png_bytes
from app.workbench_store import WorkbenchStore
from app.worker import LocalWorker


class AWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = Settings(api_token=SecretStr("test-local-token"), ark_api_key=SecretStr("test-ark-key"),
                                 storage_root=self.root / "storage" / "api", paid_calls_enabled=True,
                                 pricing_confirmed=True, budget_cents=2000, reservation_cents=100, max_calls=20)
        self.calls = []
        self.fail_network = False

        def provider(request):
            self.calls.append((json.loads(request.content), request.headers["authorization"]))
            if self.fail_network:
                raise httpx.ReadTimeout("simulated", request=request)
            base = Image.new("RGBA", (512, 512), "white")
            layer = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
            ImageDraw.Draw(layer).rectangle((10, 10, 70, 70), fill=(200, 30, 40, 255))
            data = [{"b64_json": base64.b64encode(png_bytes(image)).decode(), "size": f"{image.width}x{image.height}",
                     "output_format": "png", "z_index": index,
                     **({"bounding_box": {"absolute": [100, 100, 180, 180]}} if index else {})}
                    for index, image in enumerate((base, layer))]
            return httpx.Response(200, json={"data": data, "model": DEFAULT_MODEL, "usage": {"generated_images": 2}},
                                  headers={"x-request-id": "test-request-id"})

        self.transport = httpx.MockTransport(provider)
        # Tests explicitly drive queued work; never launch a cloud subprocess.
        self.start = patch.object(LocalWorker, "start").start()
        self.stop = patch.object(LocalWorker, "stop").start()
        self.client = TestClient(create_app(self.settings, transport=self.transport),
                                 base_url="http://127.0.0.1:8765", client=("127.0.0.1", 12345))
        self.client.__enter__()
        self.store = WorkbenchStore(self.settings.storage_root)
        image = png_bytes(Image.new("RGBA", (512, 512), "white"))
        result = self.post("/images", files={"file": ("input.png", image, "image/png")})
        self.assertEqual(result.status_code, 201, result.text)
        self.input_id = result.json()["normalized"]["asset_id"]

    def tearDown(self):
        self.client.__exit__(None, None, None)
        patch.stopall()
        self.temp.cleanup()

    def post(self, path, **kwargs):
        headers = kwargs.pop("headers", {})
        return self.client.post("/api/v1" + path, headers={"X-Pattern-Studio": "local", "Idempotency-Key": uuid4().hex, **headers}, **kwargs)

    def flow(self, **changes):
        result = self.post("/pipelines/ai", json={"input_asset_id": self.input_id, "consent_to_upload": True,
                           "consent_to_charge": True, **changes})
        self.assertEqual(result.status_code, 202, result.text)
        return result.json()

    def run_next(self, settings=None):
        job, token = self.store.claim()
        try:
            if job["kind"] == "decompose-layers":
                execute_decomposition(self.store, job, token, settings or self.settings, transport=self.transport)
            else:
                execute_local(self.store, job["job_id"], token)
        except (ServiceError, ProcessingError) as error:
            self.store.finish_job(job["job_id"], token, {"code": error.code, "message": str(error)})
        else:
            self.store.finish_job(job["job_id"], token)
        return self.store.get_job(job["job_id"])

    def select(self, flow):
        self.run_next()
        WorkflowCoordinator(self.store).advance()
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        layers = self.client.get("/api/v1/jobs/" + flow["decomposition_job_id"] + "/layers").json()
        result = self.post("/pipelines/" + flow["pipeline_id"] + "/continue", json={
            "revision": flow["revision"], "action": "select_layers", "layer_ids": [layers["layers"][0]["layer_id"]]})
        self.assertEqual(result.status_code, 202, result.text)
        return result.json()

    def test_settings_routes_boundary_rotation_and_no_cloud_test(self):
        state = self.client.get("/api/v1/settings").json()
        self.assertNotIn("test-ark-key", json.dumps(state))
        denied = self.client.put("/api/v1/settings", json={"revision": 1, "api_key_action": "clear"})
        self.assertEqual(denied.status_code, 403)
        headers = {"X-Pattern-Studio": "local"}
        rejected = self.client.put("/api/v1/settings", headers=headers,
                                   json={"revision": 1, "api_key_action": "replace", "api_key": "pasted secret"})
        self.assertEqual(rejected.status_code, 422)
        self.assertNotIn("pasted secret", rejected.text)
        result = self.client.put("/api/v1/settings", headers=headers, json={"revision": 1,
            "api_key_action": "replace", "api_key": "replacement-ark-key", "model": "ep-test-endpoint"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertNotIn("replacement-ark-key", result.text)
        self.assertEqual(self.client.get("/api/v1/seedream/status").json()["model"], "ep-test-endpoint")
        self.assertEqual(self.client.put("/api/v1/settings", headers=headers, json={"revision": 1}).status_code, 409)
        for secret in ("test-ark-key", "replacement-ark-key"):
            response = self.post("/images", files={"file": (secret + ".png", png_bytes(Image.new("RGB", (8, 8))), "image/png")})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn(secret, response.text)
        self.assertEqual(self.calls, [])

    def test_snapshot_frozen_but_new_key_used_for_next_provider_job(self):
        flow = self.flow()
        latest = replace(self.settings, model="ep-later-model", ark_api_key=SecretStr("rotated-key"))
        with patch.dict("app.providers.prompts.DECOMPOSITION_PROMPTS", {"s0-seedream-v1": "changed after admission"}):
            self.run_next(latest)
        payload, authorization = self.calls[0]
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(authorization, "Bearer rotated-key")
        call = self.store.get_call(self.store.get_job(flow["decomposition_job_id"])["result"]["provider_call_id"])
        self.assertEqual(call["request"]["prompt_text"], payload["prompt"])
        self.assertEqual(payload["prompt"], flow["workflow"]["snapshot"]["prompt_text"])
        self.assertNotIn("rotated-key", json.dumps(call))
        self.assertEqual(flow["workflow"]["version"], "1")

    def test_failed_vector_keeps_png_and_reruns_without_new_cloud_call(self):
        flow = self.select(self.flow())
        with patch("app.services.assisted_workbench.vectorize", side_effect=ProcessingError("VECTOR_TEST_FAILURE", "simulated")):
            job = self.run_next()
        self.assertEqual(job["state"], "failed")
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        png_id = flow["recovery"]["vector_input_asset_ids"][0]
        path = "/pipelines/" + flow["pipeline_id"] + "/rerun"
        body = {"revision": flow["revision"], "action": "vectorize", "input_asset_id": png_id, "vector": flow["vector"]}
        key = uuid4().hex
        first = self.post(path, json=body, headers={"Idempotency-Key": key})
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(first.json()["ai_pipeline_id"], flow["pipeline_id"])
        self.assertEqual(first.json()["job_id"], self.post(path, json=body, headers={"Idempotency-Key": key}).json()["job_id"])
        self.assertEqual(self.post(path, json=body).status_code, 409)
        completed = self.run_next()
        self.assertEqual(completed["state"], "succeeded", completed)
        svg = next(a for a in completed["result"]["assets"] if a["kind"] == "svg")
        from app.versions import VECTOR_VERSION
        self.assertEqual(svg["algorithm_version"], VECTOR_VERSION)
        self.assertIn(b"<path", self.store.read_asset(svg["asset_id"])[1])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.store.get_ai_flow(flow["pipeline_id"])["branches"][0]["parent_job_id"], job["job_id"])
        restored = self.client.get("/api/v1/jobs/" + first.json()["job_id"]).json()
        self.assertEqual(restored["ai_pipeline_id"], flow["pipeline_id"])
        self.assertEqual(restored["parent_job_id"], job["job_id"])

    def test_local_composition_branch_is_idempotent_and_preserves_old_assets(self):
        flow = self.select(self.flow())
        original = self.run_next()
        from app.versions import VECTOR_VERSION
        original_svg = next(a for a in original["result"]["assets"] if a["kind"] == "svg")
        self.assertEqual(original_svg["algorithm_version"], VECTOR_VERSION)
        parent = self.store.read_asset(original_svg["source_asset_id"])[0]
        for field in ("image_id", "content_id", "license"):
            self.assertEqual(original_svg[field], parent[field])
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        result = self.post("/pipelines/" + flow["pipeline_id"] + "/rerun", json={"revision": flow["revision"],
                           "action": "compose", "layer_ids": flow["selected_layer_ids"], "vector": None})
        self.assertEqual(result.status_code, 202, result.text)
        branch = self.run_next()
        self.assertEqual(branch["state"], "succeeded")
        self.assertEqual(self.store.get_job(original["job_id"])["result"], original["result"])
        self.assertEqual(len(self.calls), 1)

    def test_concurrent_branch_requests_accept_one_revision(self):
        flow = self.select(self.flow())
        self.run_next()
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        payload = RerunRequest(revision=flow["revision"], action="compose", layer_ids=flow["selected_layer_ids"])
        from app.services.local_workbench import LocalWorkbench
        def submit(_):
            try:
                return AssistedWorkbench(self.store, self.settings, LocalWorkbench(self.store)).rerun(flow["pipeline_id"], payload, uuid4().hex)["state"]
            except ServiceError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(submit, range(2)))
        self.assertEqual(results.count("queued"), 1)
        self.assertEqual(results.count("STALE_REVISION"), 1)
        self.assertEqual(len(self.store.get_ai_flow(flow["pipeline_id"])["branches"]), 1)

    def test_rerun_rejects_unrelated_png(self):
        flow = self.select(self.flow())
        self.run_next()
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        response = self.post("/pipelines/" + flow["pipeline_id"] + "/rerun", json={"revision": flow["revision"],
            "action": "vectorize", "input_asset_id": self.input_id, "vector": flow["vector"]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "WORKFLOW_INPUT_MISMATCH")

    def test_unknown_provider_outcome_never_auto_retries(self):
        self.fail_network = True
        flow = self.flow()
        self.run_next()
        WorkflowCoordinator(self.store).advance()
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        self.assertTrue(flow["recovery"]["needs_reconcile"])
        self.assertFalse(flow["recovery"]["can_compose"])
        response = self.post("/jobs/" + flow["decomposition_job_id"] + "/retry")
        self.assertEqual(response.status_code, 409)
        # Even an explicitly created second flow is blocked by the existing unknown call.
        self.flow()
        self.run_next()
        self.assertEqual(len(self.calls), 1)

    def test_worker_honors_paid_switch_changed_while_queued(self):
        flow = self.flow()
        job, token = self.store.claim()
        with patch("app.worker.subprocess.Popen") as popen:
            LocalWorker(self.store, provider_settings=lambda: replace(self.settings, paid_calls_enabled=False))._run(job, token)
        popen.assert_not_called()
        failed = self.store.get_job(job["job_id"])
        self.assertEqual(failed["error"]["code"], "PROVIDER_DISABLED")
        self.assertEqual(self.calls, [])

    def test_validated_selection_hook_auto_continues_exactly_once(self):
        flow = self.flow()
        self.run_next()
        def selector(layers):
            return {"layer_ids": [layers["layers"][0]["layer_id"]], "policy_version": "test-policy-v1", "reason": "TEST_ONLY"}
        with patch("app.services.workflow.select_candidate_layers", side_effect=selector):
            WorkflowCoordinator(self.store).advance()
            WorkflowCoordinator(self.store).advance()
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        self.assertEqual(flow["state"], "queued")
        self.assertEqual(flow["selection"]["policy_version"], "test-policy-v1")
        completed = self.run_next()
        self.assertEqual(completed["state"], "succeeded")
        candidate = next(a for a in completed["result"]["assets"] if a["kind"] == "composed_candidate")
        self.assertEqual(candidate["selection_origin"], "automatic")
        self.assertIsNone(candidate["human_decision"])
        self.assertIsNone(self.store.claim())
        self.assertEqual(len(self.calls), 1)

    def test_real_worker_runs_local_branch_in_bounded_subprocess(self):
        flow = self.select(self.flow())
        job, token = self.store.claim()
        LocalWorker(self.store, provider_settings=lambda: self.settings)._run(job, token)
        completed = self.store.get_job(job["job_id"])
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertTrue(any(a["kind"] == "svg" for a in completed["result"]["assets"]))
        self.assertEqual(len(self.calls), 1)

    def test_refined_png_descendant_can_feed_vector_branch(self):
        flow = self.select(self.flow())
        composed = self.run_next()
        rgb = next(a for a in composed["result"]["assets"] if a["kind"] == "composed_candidate")
        mask = next(a for a in composed["result"]["assets"] if a["kind"] == "foreground_mask")
        result = self.post("/jobs/refine-mask", json={"source_rgb_asset_id": rgb["asset_id"], "base_mask_asset_id": mask["asset_id"],
            "strokes": [{"mode": "erase", "radius": 2, "points": [{"x": 120, "y": 120}]}]})
        self.assertEqual(result.status_code, 202, result.text)
        corrected = self.run_next()
        png = next(a for a in corrected["result"]["assets"] if a["kind"] == "transparent_png")
        flow = self.store.get_ai_flow(flow["pipeline_id"])
        self.assertIn(png["asset_id"], flow["recovery"]["vector_input_asset_ids"])
        response = self.post("/pipelines/" + flow["pipeline_id"] + "/rerun", json={"action": "vectorize",
            "revision": flow["revision"], "input_asset_id": png["asset_id"], "vector": flow["vector"]})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(self.run_next()["state"], "succeeded")
        self.assertEqual(len(self.calls), 1)

    def test_restart_preserves_partial_outputs_and_marks_running_call_unknown(self):
        flow = self.flow()
        job, token = self.store.claim()
        snapshot = {"input_asset_id": self.input_id, "operation": "decompose"}
        call, _ = self.store.reserve("ai-" + job["job_id"], snapshot, "test-input-hash", reservation=100, budget=2000, max_calls=20)
        self.store.step(job["job_id"], token, "decompose-layers", "running")
        reopened = WorkbenchStore(self.settings.storage_root)
        reopened.recover_interrupted_calls()
        reopened.recover_jobs()
        current = reopened.get_ai_flow(flow["pipeline_id"])
        self.assertEqual(current["state"], "failed")
        self.assertTrue(current["recovery"]["needs_reconcile"])
        self.assertEqual(current["recovery"]["provider_call_id"], call["call_id"])
        self.assertEqual(current["workflow"], flow["workflow"])


if __name__ == "__main__":
    unittest.main()
