"""Bounded AI-confirmation and foreground-only correction requests."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.contracts import VectorOptions
from app.schemas.workbench import StrictModel, ExtractOptions


class AiPipelineRequest(StrictModel):
    input_asset_id: UUID
    provider_call_id: UUID | None = None
    consent_to_upload: bool = Field(default=False, strict=True)
    consent_to_charge: bool = Field(default=False, strict=True)
    size: Literal["1K", "1.5K", "2K", "auto"] = "1K"
    vector: VectorOptions = Field(default_factory=lambda: VectorOptions(max_colors=4, detail="low"))

    @model_validator(mode="after")
    def explicit_consents(self):
        if self.provider_call_id is None and not (self.consent_to_upload and self.consent_to_charge):
            raise ValueError("New decomposition requires both per-request consents")
        return self


class ComposeLayersRequest(StrictModel):
    decomposition_job_id: UUID
    layer_ids: list[UUID] = Field(min_length=1, max_length=16)
    vector: VectorOptions | None = None

    @model_validator(mode="after")
    def unique_layers(self):
        if len(self.layer_ids) != len(set(self.layer_ids)):
            raise ValueError("Select each layer once")
        return self


class ContinueRequest(StrictModel):
    revision: int = Field(ge=1, strict=True)
    action: Literal["select_layers", "use_local", "reject"]
    layer_ids: list[UUID] = Field(default_factory=list, max_length=16)
    extract: ExtractOptions = Field(default_factory=ExtractOptions)
    vector: VectorOptions | None = None

    @model_validator(mode="after")
    def action_fields(self):
        if self.action == "select_layers" and not self.layer_ids:
            raise ValueError("Select at least one candidate layer")
        if self.action != "select_layers" and self.layer_ids:
            raise ValueError("Only layer selection accepts layer IDs")
        if len(self.layer_ids) != len(set(self.layer_ids)):
            raise ValueError("Select each layer once")
        return self


class BrushPoint(StrictModel):
    x: float = Field(ge=0, strict=True)
    y: float = Field(ge=0, strict=True)


class BrushStroke(StrictModel):
    mode: Literal["add", "erase"]
    radius: int = Field(ge=1, le=128, strict=True)
    points: list[BrushPoint] = Field(min_length=1, max_length=2048)


class RefineMaskRequest(StrictModel):
    source_rgb_asset_id: UUID
    base_mask_asset_id: UUID
    algorithm: Literal["brush", "grabcut"] = "brush"
    iterations: int = Field(default=5, ge=1, le=10, strict=True)
    invert: bool = Field(default=False, strict=True)
    denoise: Literal[0, 1, 2] = 0
    strokes: list[BrushStroke] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def bounded_changes(self):
        if sum(len(stroke.points) for stroke in self.strokes) > 2048:
            raise ValueError("Use at most 2048 brush points")
        if not (self.invert or self.denoise or self.strokes or self.algorithm == "grabcut"):
            raise ValueError("Make a mask change before saving")
        return self
