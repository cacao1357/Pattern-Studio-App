"""Isolated UI fixture with a synthetic archived decomposition; never sends HTTP to Ark."""

from dataclasses import replace
from pathlib import Path
import json
import socket
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw
from pydantic import SecretStr
import uvicorn

from app.config import Settings
from app.main import create_app
from app.providers.seedream import ProviderOutput, ProviderResult
from app.schemas.assisted import AiPipelineRequest
from app.schemas.contracts import BoundingBox
from app.schemas.provider import ValidationRequest
from app.services.assisted_workbench import AssistedWorkbench
from app.services.local_workbench import LocalWorkbench
from app.services.provider_validation import ProviderValidationService
from app.storage import png_bytes
from app.workbench_store import WorkbenchStore


def main():
    root = Path(sys.argv[1]).resolve()
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr("synthetic-fixture-key"), storage_root=root / "storage" / "api",
                        paid_calls_enabled=True, pricing_confirmed=True, budget_cents=500, reservation_cents=100)
    store = WorkbenchStore(settings.storage_root)
    local = LocalWorkbench(store)
    image = Image.new("RGBA", (512, 512), "white")
    ImageDraw.Draw(image).rectangle((120, 120, 380, 380), fill="#c02030")
    record, _, _ = local.upload(png_bytes(image), "synthetic-pattern.png", "offline browser fixture", uuid4().hex)
    input_id = record["normalized"]["asset_id"]

    class FixtureProvider:
        def generate(self, payload, operation):
            layer = Image.new("RGBA", (512, 512))
            ImageDraw.Draw(layer).rectangle((120, 120, 380, 380), fill="#c02030")
            return ProviderResult([ProviderOutput(image, 0, None, None),
                                   ProviderOutput(layer, 1, BoundingBox(left=0, top=0, right=512, bottom=512), "absolute")],
                                  "synthetic-archive", {}, settings.model, 0)

    call, _ = ProviderValidationService(settings, store, FixtureProvider()).submit(ValidationRequest(
        input_asset_id=input_id, operation="decompose", intent="separate_pattern", consent_to_upload=True, consent_to_charge=True), uuid4().hex)
    flow = AssistedWorkbench(store, settings, local).create_pipeline(AiPipelineRequest(input_asset_id=input_id, provider_call_id=call["call_id"]), uuid4().hex)
    # The running fixture cannot send a cloud request, including through the worker.
    settings = replace(settings, ark_api_key=SecretStr(""), paid_calls_enabled=False, pricing_confirmed=False)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    print("FIXTURE " + json.dumps({"url": url, "pipeline_id": flow["pipeline_id"], "input_asset_id": input_id}), flush=True)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", log_level="error", access_log=False, ws="none"))
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
