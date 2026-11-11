"""Image-scoped history recovery uses isolated storage and mocked provider traffic."""
import json
from uuid import uuid4
from unittest.mock import patch

import pytest

import test_a_workflow as workflow
from app.schemas.contracts import ProcessingError
from app.services.workflow import WorkflowCoordinator


@pytest.fixture
def context():
    case = workflow.AWorkflowTests()
    case.setUp()
    try:
        yield case
    finally:
        case.tearDown()


def history(case, image_id, collection, limit=50):
    items, cursor = [], None
    while True:
        params = {"collection": collection, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        response = case.client.get(f"/api/v1/images/{image_id}/history", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        items.extend(page["items"])
        if not page["next_cursor"]:
            return items
        assert page["next_cursor"] != cursor
        cursor = page["next_cursor"]


def image_id(case):
    return case.store.get_asset(case.input_id)[0]["image_id"]


def test_history_recovers_failed_partial_outputs_and_local_branches(context):
    case = context
    flow = case.select(case.flow())
    with patch("app.services.assisted_workbench.vectorize", side_effect=ProcessingError("TEST_FAILURE", "simulated")):
        partial = case.run_next()
    assert partial["state"] == "failed" and partial["result"]["assets"]
    flow = case.store.get_ai_flow(flow["pipeline_id"])
    response = case.post(f"/pipelines/{flow['pipeline_id']}/rerun", json={
        "revision": flow["revision"], "action": "compose", "layer_ids": flow["selected_layer_ids"]})
    assert response.status_code == 202, response.text
    branch = case.run_next()
    assert branch["state"] == "succeeded"
    # Recovery may read state, never advance a flow or add jobs/provider calls.
    before = (case.store.page("local_jobs", 50, None), list(case.calls))
    jobs = history(case, image_id(case), "jobs", 1)
    assets = history(case, image_id(case), "assets", 2)
    flows = history(case, image_id(case), "flows", 1)
    assert {j["job_id"] for j in jobs} == {flow["decomposition_job_id"], partial["job_id"], branch["job_id"]}
    restored = next(j for j in jobs if j["job_id"] == branch["job_id"])
    assert restored["ai_pipeline_id"] == flow["pipeline_id"]
    assert restored["parent_job_id"] and restored["workflow_action"] == "compose"
    assert {a["asset_id"] for a in partial["result"]["assets"]} <= {a["asset_id"] for a in assets}
    assert flows[0]["branches"][0]["job_id"] == branch["job_id"]
    assert flows[0]["state"] == "failed"
    assert before == (case.store.page("local_jobs", 50, None), case.calls)
    assert "test-ark-key" not in json.dumps([assets, jobs, flows])


def test_history_isolates_duplicate_uploads_and_recovers_legacy_lineage(context):
    case = context
    first_id = image_id(case)
    other = case.post("/images", files={"file": ("duplicate.png", workflow.png_bytes(workflow.Image.new("RGBA", (512, 512), "white")), "image/png")}).json()
    # Identical content must not merge distinct image histories.
    flow = case.flow()
    case.run_next()
    WorkflowCoordinator(case.store).advance()
    layer = case.store.get_job(flow["decomposition_job_id"])["result"]["assets"][-1]
    # Exercise the parent graph fallback for older metadata without image_id.
    with case.store.connection() as db:
        meta = json.loads(db.execute("SELECT metadata FROM assets WHERE id=?", (layer["asset_id"],)).fetchone()[0])
        meta.pop("image_id", None)
        db.execute("UPDATE assets SET metadata=? WHERE id=?", (json.dumps(meta), layer["asset_id"]))
        db.commit()
    assert layer["asset_id"] in {a["asset_id"] for a in history(case, first_id, "assets", 1)}
    assert len(history(case, other["image_id"], "assets", 1)) == 2
    assert history(case, other["image_id"], "jobs") == []
    assert history(case, other["image_id"], "flows") == []


def test_history_includes_multiple_waiting_flows_and_queued_jobs(context):
    case = context
    one, two = case.flow(), case.flow()
    flows = history(case, image_id(case), "flows", 1)
    assert {f["pipeline_id"] for f in flows} == {one["pipeline_id"], two["pipeline_id"]}
    assert all(f["state"] == "queued" for f in flows)
    assert len(history(case, image_id(case), "jobs", 1)) == 2
    assert case.calls == []


def test_history_validation_and_missing_image(context):
    case = context
    url = f"/api/v1/images/{image_id(case)}/history"
    for params in ({"collection": "anything"}, {"limit": 0}, {"limit": 51}, {"cursor": "bad"}):
        assert case.client.get(url, params=params).status_code == 422
    assert case.client.get(f"/api/v1/images/{uuid4()}/history").status_code == 404
