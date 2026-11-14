"""S3 repair consent/decision and bounded integer-repeat requests."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.contracts import BoundingBox
from app.schemas.workbench import StrictModel


class RepairRequest(StrictModel):
    input_asset_id: UUID
    method: Literal["cloud", "leftrefill"] = "cloud"
    reference_asset_id: UUID | None = None
    seed: int = Field(default=23407, ge=0, le=2147483647, strict=True)
    bbox: BoundingBox
    intent: Literal["restore_small_gap", "reconnect_lines"] = "restore_small_gap"
    feather_px: int = Field(default=0, ge=0, le=64, strict=True)
    size: Literal["1K", "1.5K", "2K"] = "1K"
    provider_call_id: UUID | None = None
    damage_mask_asset_id: UUID | None = None
    consent_to_upload: bool = Field(default=False, strict=True)
    consent_to_charge: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def explicit_consents(self):
        if self.method == "leftrefill":
            if self.reference_asset_id is None:
                raise ValueError("Local LeftRefill repair requires an explicit reference asset")
            if self.provider_call_id is not None or self.consent_to_upload or self.consent_to_charge:
                raise ValueError("Local repair cannot carry a provider call or cloud consents")
            return self
        if self.reference_asset_id is not None or self.seed != 23407:
            raise ValueError("Reference and seed apply only to local LeftRefill repair")
        if self.provider_call_id is None and not (self.consent_to_upload and self.consent_to_charge):
            raise ValueError("A new repair candidate requires both per-request consents")
        return self


class RepairDecision(StrictModel):
    revision: int = Field(ge=1, strict=True)
    action: Literal["accept", "reject"]
    selected_asset_id: UUID | None = None
    accept_full_image_changes: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def selected_version(self):
        if self.action == "accept" and self.selected_asset_id is None:
            raise ValueError("Accept an explicit repair version")
        if self.action == "reject" and (self.selected_asset_id is not None or self.accept_full_image_changes):
            raise ValueError("Rejection cannot accept a candidate")
        return self


class TileRequest(StrictModel):
    unit_asset_id: UUID
    rows: Literal[2, 3] = 2
    cols: Literal[2, 3] = 2
    seam_observation: Literal["not_reviewed", "visible", "not_obvious"] = "not_reviewed"

    @model_validator(mode="after")
    def square_preset(self):
        if type(self.rows) is not int or type(self.cols) is not int or self.rows != self.cols:
            raise ValueError("Choose the 2x2 or 3x3 preset")
        return self


class TileSeamObservation(StrictModel):
    seam_observation: Literal["not_reviewed", "visible", "not_obvious"]
    revision: int = Field(ge=0, strict=True)
