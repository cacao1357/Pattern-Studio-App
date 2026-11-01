"""Single-attempt Ark adapter. No SDK retries, URL fetching or raw-body logging."""

import base64
from dataclasses import dataclass
from io import BytesIO
import json
import logging
import math
import re
import time

import httpx
from PIL import Image

from app.config import Settings
from app.schemas.contracts import BoundingBox, DEFAULT_LIMITS, ProcessingError
from app.schemas.provider import ValidationRequest
from app.services.imaging import normalize_image
from app.storage import ServiceError
from app.providers.prompts import DEFAULT_PROMPT_VERSION, decomposition_prompt


PROMPT_VERSION = DEFAULT_PROMPT_VERSION


class ProviderFailure(ValueError):
    def __init__(self, code: str, state: str, request_id: str | None = None, *, http_status: int | None = None,
                 provider_code: str | None = None):
        super().__init__(code)
        self.code, self.state, self.request_id = code, state, request_id
        self.http_status = http_status
        self.provider_code = provider_code


@dataclass
class ProviderOutput:
    image: Image.Image
    z_index: int
    bbox: BoundingBox | None
    bbox_source: str | None


@dataclass
class ProviderResult:
    outputs: list[ProviderOutput]
    request_id: str | None
    usage: dict
    actual_model: str | None
    elapsed_ms: float


def edit_prompt_bbox(bbox: BoundingBox, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Editing uses round(px / dimension * 1000), clamped to 0..999."""
    bbox.within(size)
    values = [min(999, math.floor(value / dimension * 1000 + 0.5))
              for value, dimension in zip(bbox.as_tuple(), (size[0], size[1], size[0], size[1]))]
    if values[0] >= values[2] or values[1] >= values[3]:
        raise ServiceError("EDIT_BOX_TOO_SMALL", "The edit rectangle collapses at provider coordinate precision")
    return tuple(values)


def decomposition_bbox(value: object, size: tuple[int, int]) -> tuple[BoundingBox, str]:
    """Layer coordinates belong to the output basemap, not the uploaded input."""
    if not isinstance(value, dict):
        raise ValueError("Invalid layer box")
    field = "absolute" if "absolute" in value else "normalized"
    coordinates = value.get(field)
    if not isinstance(coordinates, list) or len(coordinates) != 4 or any(type(x) is not int for x in coordinates):
        raise ValueError("Invalid layer box")
    if field == "normalized":
        if any(not 0 <= x <= 1000 for x in coordinates):
            raise ValueError("Invalid normalized layer box")
        l, t, r, b = coordinates
        if l >= r or t >= b:
            raise ValueError("Empty normalized layer box")
        coordinates = [l * size[0] // 1000, t * size[1] // 1000,
                       (r * size[0] + 999) // 1000, (b * size[1] + 999) // 1000]
    box = BoundingBox(left=coordinates[0], top=coordinates[1], right=coordinates[2], bottom=coordinates[3]).within(size)
    return box, field


def prepare_payload(request: ValidationRequest, source_png: bytes, settings: Settings) -> dict:
    with Image.open(BytesIO(source_png)) as im:
        size = im.size
        transparent = im.convert("RGBA").getchannel("A").getextrema()[0] < 255
    pixels = size[0] * size[1]
    if not 262_144 <= pixels <= 25_000_000 or not 1 / 16 <= size[0] / size[1] <= 16:
        raise ServiceError("PROVIDER_INPUT_DIMENSIONS", "Seedream input requires 262144..25000000 pixels and an aspect ratio in 1/16..16; create an explicit working copy if needed")
    if request.operation == "decompose":
        prompt = decomposition_prompt(request.prompt_version)
    else:
        coordinates = edit_prompt_bbox(request.bbox, size)
        instruction = {"restore_small_gap": "补全小面积缺口，延续邻近纹样线条、颜色和粗细，不新增主体或改变整体结构",
                       "reconnect_lines": "连接缺口两端原有线条，保持原有粗细与颜色，不添加新的纹样元素"}[request.intent]
        prompt = f"仅编辑图1 <bbox>{' '.join(map(str, coordinates))}</bbox> 区域：{instruction}。保持其他区域布局、图像比例和尺寸。"
    payload = {"model": settings.model, "prompt": prompt,
               "image": "data:image/png;base64," + base64.b64encode(source_png).decode("ascii"),
               "layer_decomposition": request.operation == "decompose", "size": request.size,
               "output_format": "png", "response_format": "b64_json", "watermark": True}
    if request.operation == "edit" and transparent:
        payload["background"] = "transparent"
    return payload


class SeedreamClient:
    def __init__(self, settings: Settings, *, transport: httpx.BaseTransport | None = None):
        self.settings, self.transport = settings, transport

    def safe_identifier(self, value: object) -> str | None:
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value):
            return None
        secrets = (self.settings.ark_api_key.get_secret_value(), self.settings.api_token.get_secret_value())
        return None if any(secret and secret in value for secret in secrets) else value

    def generate(self, payload: dict, operation: str) -> ProviderResult:
        if self.settings.blockers():
            raise ServiceError("PROVIDER_DISABLED", "Seedream credentials, pricing and budget must be configured locally before calling", 503)
        # httpcore DEBUG logs include headers. This dedicated local service disables those logs.
        for name in ("httpx", "httpcore", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks"):
            logging.getLogger(name).setLevel(logging.WARNING)
        started, request_id = time.monotonic(), None
        try:
            transport = self.transport if self.transport is not None else httpx.HTTPTransport(retries=0, trust_env=False)
            with httpx.Client(transport=transport, trust_env=False, follow_redirects=False,
                              timeout=httpx.Timeout(120, connect=10, write=30, pool=5)) as client:
                with client.stream("POST", self.settings.base_url + "/images/generations", json=payload,
                                   headers={"Authorization": "Bearer " + self.settings.ark_api_key.get_secret_value(),
                                            "Accept": "application/json", "Accept-Encoding": "identity"}) as response:
                    request_id = self.safe_identifier(response.headers.get("x-request-id"))
                    if response.status_code in {400, 401, 403, 404, 422, 429}:
                        code = {401: "PROVIDER_AUTH_FAILED", 403: "PROVIDER_PERMISSION_DENIED", 429: "PROVIDER_RATE_LIMITED"}.get(response.status_code, "PROVIDER_REQUEST_REJECTED")
                        raise ProviderFailure(code, "failed", request_id, http_status=response.status_code,
                                              provider_code=self.read_error_code(response))
                    if response.status_code != 200:
                        # A redirect is never followed; a 5xx does not prove a request was not billed.
                        raise ProviderFailure("PROVIDER_HTTP_OUTCOME_UNKNOWN", "outcome_unknown", request_id,
                                              http_status=response.status_code, provider_code=self.read_error_code(response))
                    if response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                        raise ProviderFailure("PROVIDER_INVALID_RESPONSE", "output_invalid", request_id)
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise ProviderFailure("PROVIDER_COMPRESSED_RESPONSE_REJECTED", "output_invalid", request_id)
                    body = bytearray()
                    for chunk in response.iter_bytes(64 * 1024):
                        if len(body) + len(chunk) > self.settings.response_limit_bytes:
                            raise ProviderFailure("PROVIDER_RESPONSE_TOO_LARGE", "output_invalid", request_id)
                        if time.monotonic() - started > 180:
                            raise ProviderFailure("PROVIDER_DEADLINE", "outcome_unknown", request_id)
                        body.extend(chunk)
            parsed = self.parse_response(bytes(body), operation, request_id)
            parsed.elapsed_ms = round((time.monotonic() - started) * 1000, 3)
            return parsed
        except ProviderFailure:
            raise
        except httpx.HTTPError:
            # Never include the HTTP exception: it can contain URLs or headers.
            raise ProviderFailure("PROVIDER_TRANSPORT_OUTCOME_UNKNOWN", "outcome_unknown", request_id) from None

    def read_error_code(self, response: httpx.Response) -> str | None:
        """Retain only a bounded credential-filtered identifier, never error text."""
        if response.headers.get("content-encoding", "identity").lower() != "identity":
            return None
        if response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return None
        try:
            body = bytearray()
            for chunk in response.iter_bytes(4096):
                if len(body) + len(chunk) > 16 * 1024:
                    return None
                body.extend(chunk)
            parsed = json.loads(body)
            error = parsed.get("error") if isinstance(parsed, dict) else None
            return self.safe_identifier(error.get("code")) if isinstance(error, dict) else None
        except (ValueError, RecursionError, httpx.HTTPError):
            return None

    def parse_response(self, body: bytes, operation: str, request_id: str | None = None) -> ProviderResult:
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or data.get("error"):
                raise ValueError
            items = data.get("data")
            if not isinstance(items, list) or not (2 <= len(items) <= 17 if operation == "decompose" else len(items) == 1):
                raise ValueError
            outputs, total_pixels = [], 0
            for item in items:
                # A URL-only result is deliberately unsupported; no downstream HTTP request exists.
                if not isinstance(item, dict) or item.get("error") or not isinstance(item.get("b64_json"), str):
                    raise ValueError
                encoded = item["b64_json"]
                if len(encoded) > 4 * ((DEFAULT_LIMITS.max_upload_bytes + 2) // 3):
                    raise ValueError
                raw = base64.b64decode(encoded, validate=True)
                normalized = normalize_image(raw, "provider.png")
                image = normalized.image
                if item.get("size") != f"{image.width}x{image.height}" or normalized.metadata["transform"]["orientation"] != 1:
                    raise ValueError
                if item.get("output_format") not in {None, "png"}:
                    raise ValueError
                total_pixels += image.width * image.height
                if total_pixels > self.settings.output_pixel_limit:
                    raise ValueError
                index = item.get("z_index") if operation == "decompose" else 0
                if type(index) is not int or not 0 <= index <= 16:
                    raise ValueError
                outputs.append(ProviderOutput(image, index, None, None))
            outputs.sort(key=lambda x: x.z_index)
            if [x.z_index for x in outputs] != list(range(len(outputs))):
                raise ValueError
            if operation == "decompose":
                by_index = {x["z_index"]: x for x in items}
                for output in outputs[1:]:
                    output.bbox, output.bbox_source = decomposition_bbox(by_index[output.z_index].get("bounding_box"), outputs[0].image.size)
            usage = {}
            if isinstance(data.get("usage"), dict):
                for field in ("generated_images", "input_images", "output_tokens", "total_tokens"):
                    value = data["usage"].get(field)
                    if type(value) is int and 0 <= value <= 10**12:
                        usage[field] = value
            return ProviderResult(outputs, request_id, usage, self.safe_identifier(data.get("model")), 0)
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError, ProcessingError):
            raise ProviderFailure("PROVIDER_INVALID_OUTPUT", "output_invalid", request_id) from None
