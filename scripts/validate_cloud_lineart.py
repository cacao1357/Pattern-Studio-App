"""Explicit live acceptance: at most one repair and one cloud-lineart attempt.

Requires --allow-paid-call. Uses existing server credentials privately, an isolated
new output directory, and never retries a provider call or changes live settings.
"""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.config import load_settings
from app.schemas.finishing import RepairRequest, RepairDecision
from app.schemas.provider import CloudLineartRequest
from app.schemas.workbench import VectorRequest
from app.services.assisted_workbench import AssistedWorkbench
from app.services.cloud_lineart import submit_cloud_lineart, execute_cloud_lineart
from app.services.finishing_workbench import FinishingWorkbench, execute_repair
from app.services.local_workbench import LocalWorkbench, execute_local
from app.storage import ServiceError
from app.workbench_store import WorkbenchStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repair-box", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--allow-paid-call", action="store_true")
    parser.add_argument("--resume-reviewed-repair", action="store_true",
                        help="Accept the saved protected composite after visual review, then run lineart once")
    args = parser.parse_args()
    if not args.allow_paid_call:
        parser.error("Explicit --allow-paid-call is required")
    source = args.source.resolve()
    output = args.output.resolve()
    live = load_settings()
    if live.blockers():
        raise SystemExit("Cloud configuration is not ready: " + ",".join(live.blockers()))
    # Creating a fresh directory prevents accidental replay against prior acceptance.
    if not args.resume_reviewed_repair:
        output.mkdir(parents=True, exist_ok=False)
    elif not output.is_dir():
        parser.error("The reviewed isolated output directory must already exist")
    settings = replace(live, storage_root=output / "api")
    store = WorkbenchStore(settings.storage_root)
    local = LocalWorkbench(store, secrets=(live.ark_api_key.get_secret_value(),))
    if args.resume_reviewed_repair:
        report = json.loads((output / "report.json").read_text(encoding="utf-8"))
        if report.get("pending_visual_review") is not True or any(step["kind"] == "cloud-lineart" for step in report["steps"]):
            parser.error("This acceptance is not waiting for repair review; do not replay cloud calls")
        finishing = FinishingWorkbench(store, settings, local)
        info = finishing.get_repair(report["repair_job_id"])
        accepted = finishing.decide(info["repair_job_id"], RepairDecision(
            revision=info["revision"], action="accept", selected_asset_id=info["composited_asset"]["asset_id"]), uuid4().hex)
        input_id = accepted["decision"]["accepted_asset_id"]
        report["pending_visual_review"] = False
        report["accepted_repair_asset_id"] = input_id
    else:
        record, _, _ = local.upload(source.read_bytes(), source.name, "Explicit live acceptance sample", uuid4().hex)
        input_id = record["normalized"]["asset_id"]
        report = {"source_asset": source.stem, "model": live.model, "steps": [], "automatic_retry": False}

    def save_report():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    def save_asset(asset_id, name):
        meta, data = store.read_asset(asset_id)
        (output / name).write_bytes(data)
        return {key: meta.get(key) for key in ("asset_id", "kind", "width", "height", "source_asset_id", "provider_call_id", "method", "prompt_version", "geometry_transform")}

    def execute(job, executor):
        claimed, token = store.claim()
        if claimed["job_id"] != job["job_id"]:
            raise RuntimeError("Unexpected isolated queue ownership")
        report["steps"].append({"job_id": job["job_id"], "kind": job["kind"], "state": "running"})
        save_report()
        try:
            executor(claimed, token)
        except ServiceError as error:
            store.finish_job(job["job_id"], token, {"code": error.code, "message": str(error)})
            report["steps"][-1].update(state="failed", error_code=error.code)
            save_report()
            raise SystemExit("Acceptance stopped: " + error.code + "; inspect the archived call; no retry was sent")
        store.finish_job(job["job_id"], token)
        result = store.get_job(job["job_id"])
        report["steps"][-1].update(state=result["state"], provider_call_id=result["result"].get("provider_call_id"))
        save_report()
        print(json.dumps(report["steps"][-1]), flush=True)
        return result

    save_asset(input_id, "accepted-repair.png" if args.resume_reviewed_repair else "input.png")
    save_report()
    if args.repair_box and not args.resume_reviewed_repair:
        left, top, right, bottom = args.repair_box
        finishing = FinishingWorkbench(store, settings, local)
        request = RepairRequest(input_asset_id=input_id, bbox=dict(left=left, top=top, right=right, bottom=bottom),
                                consent_to_upload=True, consent_to_charge=True)
        job = finishing.repair(request, uuid4().hex)
        execute(job, lambda claimed, token: execute_repair(store, claimed, token, settings))
        info = finishing.get_repair(job["job_id"])
        if not info["composited_asset"] or info["metrics"].get("outside_changed_pixels") != 0:
            raise SystemExit("Repair has no protected composite; inspect it before proceeding")
        # Save for visual review; stop here rather than accepting an unchecked candidate.
        report["repair_preview"] = save_asset(info["composited_asset"]["asset_id"], "repair-preview.png")
        report["repair_job_id"] = job["job_id"]
        report["pending_visual_review"] = True
        save_report()
        print("Repair preview ready. Review repair-preview.png, then explicitly continue using the archived isolated job.", flush=True)
        return
    job = submit_cloud_lineart(AssistedWorkbench(store, settings, local), CloudLineartRequest(
        input_asset_id=input_id, consent_to_upload=True, consent_to_charge=True), uuid4().hex)
    result = execute(job, lambda claimed, token: execute_cloud_lineart(store, claimed, token, settings))
    lineart = next(asset for asset in result["result"]["assets"] if asset["kind"] == "lineart")
    report["lineart"] = save_asset(lineart["asset_id"], "lineart.png")
    vector = local.submit("vectorize", VectorRequest(input_asset_id=lineart["asset_id"], mode="monochrome", detail="low"), uuid4().hex)
    result = execute(vector, lambda claimed, token: execute_local(store, claimed["job_id"], token))
    svg = next(asset for asset in result["result"]["assets"] if asset["kind"] == "svg")
    report["svg"] = save_asset(svg["asset_id"], "lineart.svg")
    save_report()


if __name__ == "__main__":
    main()
