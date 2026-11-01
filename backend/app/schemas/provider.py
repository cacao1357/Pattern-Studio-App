"""The bounded S0 provider-validation API; not the complete S1 jobs API."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.contracts import BoundingBox
from app.providers.prompts import DEFAULT_PROMPT_VERSION


class ValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    input_asset_id: UUID
    operation: Literal["decompose", "edit"]
    intent: Literal["separate_pattern", "restore_small_gap", "reconnect_lines"]
    size: Literal["1K", "1.5K", "2K", "auto"] = "1K"
    prompt_version: str = Field(default=DEFAULT_PROMPT_VERSION, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    bbox: BoundingBox | None = None
    # Neither knowing the local API token nor uploading an image authorizes a charge.
    consent_to_upload: bool = Field(strict=True, description="Must explicitly be true for this request")
    consent_to_charge: bool = Field(strict=True, description="Must explicitly be true for this request")

    @model_validator(mode="after")
    def operation_contract(self) -> "ValidationRequest":
        if not self.consent_to_upload or not self.consent_to_charge:
            raise ValueError("Both per-request consents must explicitly be true")
        if self.operation == "decompose":
            if self.intent != "separate_pattern" or self.bbox is not None:
                raise ValueError("Decomposition requires separate_pattern and no edit rectangle")
        elif self.intent == "separate_pattern" or self.bbox is None or self.size == "auto":
            raise ValueError("Editing requires a repair intent, rectangle and explicit resolution tier")
        elif self.prompt_version != DEFAULT_PROMPT_VERSION:
            raise ValueError("Editing uses the fixed repair prompt version")
        return self


class CostSettlement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    actual_cost_cny: str = Field(pattern=r"^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$", max_length=10)
    # An account-side billing reference, not an arbitrary URL or a pasted response.
    billing_reference: str = Field(pattern=r"^[A-Za-z0-9_.:-]{8,100}$")
