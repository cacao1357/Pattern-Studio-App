"""Preset workflow coordination, with no cloud retry or selection heuristic."""

import json

from app.storage import ServiceError, canonical_json

WORKFLOW_ID = "pattern-extraction"
WORKFLOW_VERSION = "1"


def select_candidate_layers(layers: dict) -> dict:
    """B's extension point. Only validated selection rules should return layer_ids.

    Return {layer_ids: [...], policy_version: str, reason: str}. An empty list
    deliberately pauses for confirmation. Never add a cloud call here.
    """
    return {"layer_ids": [], "policy_version": "confirmation-v1", "reason": "NO_VALIDATED_SELECTOR"}


class WorkflowCoordinator:
    def __init__(self, store):
        self.store = store

    def advance(self):
        """Called by the single worker coordinator, also after process recovery."""
        from app.services.assisted_workbench import AssistedWorkbench
        from app.schemas.assisted import ContinueRequest

        with self.store.connection() as db:
            rows = db.execute("""SELECT f.id FROM ai_flows f JOIN local_jobs j ON f.decomposition_job_id=j.id
                LEFT JOIN workflow_selections s ON f.id=s.flow_id
                WHERE f.state='decomposing' AND f.decision_json IS NULL AND j.state='succeeded' AND s.flow_id IS NULL""").fetchall()
        helper = AssistedWorkbench(self.store)
        for row in rows:
            flow = self.store.get_ai_flow(row["id"])
            with self.store.connection() as db:
                config = json.loads(db.execute("SELECT configuration FROM ai_flows WHERE id=?", (row["id"],)).fetchone()[0])
            assessment = {"layer_ids": [], "policy_version": "confirmation-v1", "reason": "MANUAL_POLICY"}
            if config.get("selection_policy") == "auto_or_confirm":
                try:
                    proposed = select_candidate_layers(helper.layers(flow["decomposition_job_id"]))
                    # Treat strategy output as data: validate IDs and bounded audit text.
                    request = ContinueRequest(revision=flow["revision"], action="select_layers", layer_ids=proposed["layer_ids"])
                    helper.validate_selection(flow["decomposition_job_id"], request.layer_ids)
                    if (not isinstance(proposed.get("policy_version"), str) or not 1 <= len(proposed["policy_version"]) <= 80 or
                            not isinstance(proposed.get("reason"), str) or not 1 <= len(proposed["reason"]) <= 200):
                        raise ValueError("Invalid selection assessment")
                    assessment = {"layer_ids": [str(v) for v in request.layer_ids], "policy_version": proposed["policy_version"], "reason": proposed["reason"]}
                except Exception:
                    assessment = {"layer_ids": [], "policy_version": "confirmation-v1", "reason": "SELECTION_REQUIRES_CONFIRMATION"}
                if assessment["layer_ids"]:
                    try:
                        helper.continue_pipeline(flow["pipeline_id"], ContinueRequest(revision=flow["revision"], action="select_layers",
                                                  layer_ids=assessment["layer_ids"]), "auto-" + flow["pipeline_id"], actor="automatic")
                    except ServiceError as error:
                        if error.code in {"QUEUE_FULL", "STALE_REVISION", "DECISION_NOT_AVAILABLE"}:
                            # Retry queue admission, never image generation.
                            continue
                        raise
            with self.store.connection() as db:
                db.execute("INSERT OR IGNORE INTO workflow_selections VALUES (?,?)", (flow["pipeline_id"], canonical_json(assessment)))
