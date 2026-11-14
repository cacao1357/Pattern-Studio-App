"""Saved processing recipes and resumable batch requests."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.contracts import DEFAULT_LIMITS, VectorOptions
from app.schemas.workbench import ExtractOptions, StrictModel


class PresetOptions(StrictModel):
    recipe: Literal["model_lineart", "cloud_lineart", "color"] = "color"
    extract: ExtractOptions = Field(default_factory=ExtractOptions)
    vector: VectorOptions = Field(default_factory=VectorOptions)
    working_max_pixels: int | None = Field(default=None, ge=10_000, le=DEFAULT_LIMITS.max_model_lineart_pixels, strict=True)
    crop: bool = Field(default=False, strict=True)
    repair: bool = Field(default=False, strict=True)
    candidates: bool = Field(default=False, strict=True)
    mask: bool = Field(default=False, strict=True)
    vectorize: bool = Field(default=True, strict=True)
    tile: bool = Field(default=False, strict=True)

class PresetCreate(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    options: PresetOptions


class PresetUpdate(PresetCreate):
    revision: int = Field(ge=1, strict=True)


class BatchCreate(StrictModel):
    preset_id: UUID
    input_asset_ids: list[UUID] = Field(min_length=1, max_length=100)
    consent_to_upload: bool = Field(default=False, strict=True)
    consent_to_charge: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def unique_inputs(self):
        if len(set(self.input_asset_ids)) != len(self.input_asset_ids):
            raise ValueError("Choose each input asset once")
        return self


class BatchResume(StrictModel):
    revision: int = Field(ge=1, strict=True)
    input_asset_id: UUID


class BatchCancel(StrictModel):
    revision: int = Field(ge=1, strict=True)
