"""Contracts shared by local processing and the future API (plan V1.2, section 6)."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ProcessingError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class BoundingBox(BaseModel):
    """Half-open rectangle in the current input asset's pixel space."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    left: int = Field(ge=0, strict=True)
    top: int = Field(ge=0, strict=True)
    right: int = Field(gt=0, strict=True)
    bottom: int = Field(gt=0, strict=True)

    @model_validator(mode="after")
    def positive_area(self) -> "BoundingBox":
        if self.right <= self.left or self.bottom <= self.top:
            raise ValueError("Rectangle must have positive area")
        return self

    def within(self, size: tuple[int, int]) -> "BoundingBox":
        if self.right > size[0] or self.bottom > size[1]:
            raise ProcessingError("BBOX_OUT_OF_BOUNDS", "Rectangle exceeds the current input dimensions")
        return self

    def as_tuple(self) -> tuple[int, int, int, int]:
        return self.left, self.top, self.right, self.bottom


class MaskKind(StrEnum):
    FOREGROUND = "foreground_mask"
    DAMAGE = "damage_mask"
    EDIT = "edit_mask"


class VectorOptions(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    mode: Literal["monochrome", "color", "contour"] = "color"
    max_colors: Literal[2, 4, 8, 16] = 8
    detail: Literal["low", "medium", "high"] = "medium"
    length_threshold: float | None = Field(default=None, ge=0.5, le=10, strict=True)
    corner_threshold: int | None = Field(default=None, ge=0, le=180, strict=True)
    splice_threshold: int | None = Field(default=None, ge=0, le=180, strict=True)


@dataclass(frozen=True)
class ResourceLimits:
    """Provisional S0 limits; larger-image calibration remains outstanding."""

    max_upload_bytes: int = 20 * 1024 * 1024
    max_decode_pixels: int = 25_000_000
    max_vector_pixels: int = 1_000_000
    max_color_vector_pixels: int = 250_000
    max_svg_bytes: int = 10 * 1024 * 1024
    max_svg_paths: int = 50_000
    max_tile_pixels: int = 4_000_000


DEFAULT_LIMITS = ResourceLimits()
