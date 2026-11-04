"""Validated, local-only S1 requests; no prompts or provider options."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

from app.schemas.contracts import BoundingBox, VectorOptions


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class InputRequest(StrictModel):
    input_asset_id: UUID


class CropRequest(InputRequest):
    bbox: BoundingBox


class PrepareRequest(InputRequest):
    rotation: Literal[0, 90, 180, 270] = 0
    straighten: float = Field(default=0.0, ge=-15.0, le=15.0, strict=True)

    @field_validator("rotation", mode="before")
    @classmethod
    def integer_rotation(cls, value):
        if type(value) is not int:
            raise ValueError("Rotation must be an integer angle")
        return value


class WorkingCopyRequest(InputRequest):
    max_pixels: int = Field(ge=10_000, le=1_000_000, strict=True)


class EnhanceOptions(StrictModel):
    brightness: float = Field(default=1.0, ge=0.2, le=3.0, strict=True)
    contrast: float = Field(default=1.0, ge=0.2, le=3.0, strict=True)
    denoise: Literal[0, 1, 2] = 0
    sharpen: float = Field(default=0.0, ge=0, le=1, strict=True)


class EnhanceRequest(InputRequest, EnhanceOptions):
    pass


class ExtractOptions(StrictModel):
    mode: Literal["alpha", "otsu", "manual", "grabcut", "adaptive_mean", "adaptive_gaussian", "sauvola"] = "otsu"
    polarity: Literal["dark", "light"] = "dark"
    threshold: int = Field(default=127, ge=0, le=255, strict=True)
    iterations: int = Field(default=5, ge=1, le=10, strict=True)
    bbox: BoundingBox | None = None

    window_size: int = Field(default=31, ge=3, le=255, strict=True)
    offset: float = Field(default=10.0, ge=-50, le=50, strict=True)
    clahe: bool = Field(default=False, strict=True)
    min_component_area: int = Field(default=0, ge=0, le=10000, strict=True)
    max_hole_area: int = Field(default=0, ge=0, le=10000, strict=True)

    @model_validator(mode="after")
    def require_rectangle(self):
        if self.window_size % 2 == 0:
            raise ValueError("Local threshold window must be odd")
        if self.mode == "alpha" and (self.min_component_area or self.max_hole_area or self.clahe):
            raise ValueError("Existing-alpha mode preserves the source; choose another mode for cleanup")
        if self.mode == "grabcut" and self.bbox is None:
            raise ValueError("GrabCut requires a rectangle")
        return self


class ExtractRequest(InputRequest, ExtractOptions):
    pass


class VectorRequest(InputRequest, VectorOptions):
    pass


class LineartOptions(StrictModel):
    local: bool = Field(default=True, strict=True)
    med: int | None = Field(default=None, ge=0, le=15, strict=True)
    min_area: int | None = Field(default=None, ge=0, le=10000, strict=True)
    hi_pct: float = Field(default=88.0, ge=50, le=99.5)
    tile_pct: float = Field(default=92.0, ge=50, le=99.5)
    sd_thr: float = Field(default=12.0, ge=0, le=64)

    @model_validator(mode="after")
    def odd_median(self):
        if self.med not in (None, 0, 3, 5, 7, 9, 11, 13, 15):
            raise ValueError("med must be 0 or an odd kernel from 3 to 15")
        return self


class LineartRequest(InputRequest, LineartOptions):
    pass


class PipelineRequest(InputRequest):
    extract: ExtractOptions = Field(default_factory=ExtractOptions)
    vector: VectorOptions = Field(default_factory=VectorOptions)
    enhance: EnhanceOptions | None = None
    working_max_pixels: int | None = Field(default=None, ge=10_000, le=1_000_000, strict=True)


class ExportRequest(StrictModel):
    asset_ids: list[UUID] = Field(min_length=1, max_length=24)
    license_acknowledged: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def unique_versions(self):
        if len(set(self.asset_ids)) != len(self.asset_ids):
            raise ValueError("Choose each asset version once")
        return self


class FeedbackRequest(StrictModel):
    job_id: UUID
    rating: int = Field(ge=1, le=5, strict=True)
    issues: list[str] = Field(default_factory=list, max_length=10)
    comment: str = Field(default="", max_length=2000)
    allow_training: bool = Field(default=False, strict=True)
    allow_display: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def bounded_issues(self):
        if any(not issue.strip() or len(issue) > 100 for issue in self.issues):
            raise ValueError("Issue descriptions must be short and nonempty")
        return self
