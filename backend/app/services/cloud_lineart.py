"""One explicit cloud lineart job; no automatic vectorization or retry."""

from dataclasses import replace

from app.providers.prompts import LINEART_PROMPT, LINEART_PROMPT_VERSION
from app.providers.seedream import SeedreamClient
from app.schemas.provider import ValidationRequest
from app.services.provider_validation import ProviderValidationService, validate_provider_input
from app.storage import ServiceError, canonical_json, digest
from app.workbench_store import validate_key


def submit_cloud_lineart(service, payload, key):
    validate_key(key)
    values = payload.model_dump(mode="json")
    service.local.safe_text(key + canonical_json(values))
    input_id = values.pop("input_asset_id")
    request_hash = digest(canonical_json({"input": input_id, "parameters": values, "retry_of": None}).encode())
    existing = service.store.existing("jobs/cloud-lineart", key, request_hash)
    if existing:
        return service.store.get_job(existing)
    source, _ = service.store.get_asset(input_id)
    validate_provider_input(source)
    if service.settings is None or service.settings.blockers():
        raise ServiceError("PROVIDER_DISABLED", "Configure and enable the provider before cloud lineart", 503)
    # The idempotency hash excludes server-derived defaults, as in AI workflows.
    # Store.submit hashes parameters, so retain the original hash for its lookup.
    values["execution_snapshot"] = {"model": service.settings.model, "base_url": service.settings.base_url,
                                    "prompt_version": LINEART_PROMPT_VERSION, "prompt_text": LINEART_PROMPT}
    return service.store.submit("cloud-lineart", input_id, values, key, request_hash=request_hash)


def execute_cloud_lineart(store, job, token, settings, *, transport=None):
    snapshot = job["parameters"]["execution_snapshot"]
    settings = replace(settings, model=snapshot["model"], base_url=snapshot["base_url"])
    request = ValidationRequest(input_asset_id=job["input_asset_id"], operation="lineart", intent="extract_lineart",
                                prompt_version=snapshot["prompt_version"],
                                consent_to_upload=job["parameters"]["consent_to_upload"],
                                consent_to_charge=job["parameters"]["consent_to_charge"])
    store.step(job["job_id"], token, "cloud-lineart", "running")
    call, _ = ProviderValidationService(settings, store, SeedreamClient(settings, transport=transport)).submit(
        request, "ai-" + job["job_id"], prompt_text=snapshot["prompt_text"])
    store.record_provider_result(job["job_id"], token, call, step_name="cloud-lineart")
    if call["state"] != "succeeded":
        raise ServiceError(call["result"].get("error_code", "CLOUD_LINEART_FAILED"),
                           "Cloud lineart is unavailable; reconcile this call before any explicit new generation")
