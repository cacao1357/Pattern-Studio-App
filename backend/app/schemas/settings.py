"""Strict local settings requests; credentials are accepted only for replacement."""

from typing import Literal

from pydantic import Field, SecretStr, model_validator

from app.schemas.workbench import StrictModel


class SettingsUpdate(StrictModel):
    revision: int = Field(ge=1, strict=True)
    api_key_action: Literal["keep", "replace", "clear"] = "keep"
    api_key: SecretStr | None = Field(default=None, max_length=1024)
    model: str | None = Field(default=None, min_length=1, max_length=128, strict=True)
    base_url: str | None = Field(default=None, min_length=1, max_length=256, strict=True)
    paid_calls_enabled: bool | None = Field(default=None, strict=True)
    pricing_confirmed: bool | None = Field(default=None, strict=True)
    budget_cents: int | None = Field(default=None, ge=0, le=100_000_000, strict=True)
    reservation_cents: int | None = Field(default=None, ge=0, le=100_000_000, strict=True)
    max_calls: int | None = Field(default=None, ge=1, le=100, strict=True)

    @model_validator(mode="after")
    def validate_key_action(self):
        if self.api_key_action == "replace":
            if self.api_key is None or not self.api_key.get_secret_value():
                raise ValueError("API key is required when replacing it")
            value = self.api_key.get_secret_value()
            if not value.isascii() or any(char.isspace() for char in value):
                raise ValueError("API key contains invalid characters")
        elif "api_key" in self.model_fields_set:
            raise ValueError("API key is accepted only with the replace action")
        return self
