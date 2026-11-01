"""Server-only configuration. Never serialize this object into an API response."""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import os
from pathlib import Path
import re
from typing import Mapping

from dotenv import dotenv_values
from pydantic import SecretStr


ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seedream-5-0-pro-260628"
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ConfigurationError(ValueError):
    """Messages contain configuration names, never supplied values."""


def money_cents(value: str, name: str) -> int:
    try:
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0 or amount > 1_000_000:
            raise ValueError
        cents = amount * 100
        if cents != cents.to_integral_value():
            raise ValueError
        return int(cents)
    except (InvalidOperation, ValueError, TypeError):
        raise ConfigurationError(f"{name} must be a nonnegative CNY amount with at most two decimals") from None


def boolean(value: str, name: str) -> bool:
    if value.lower() not in {"true", "false"}:
        raise ConfigurationError(f"{name} must be true or false")
    return value.lower() == "true"


@dataclass(frozen=True, repr=False)
class Settings:
    api_token: SecretStr
    ark_api_key: SecretStr
    storage_root: Path
    model: str = DEFAULT_MODEL
    base_url: str = ARK_BASE_URL
    paid_calls_enabled: bool = False
    pricing_confirmed: bool = False
    budget_cents: int = 0
    reservation_cents: int = 0
    max_calls: int = 5
    response_limit_bytes: int = 64 * 1024 * 1024
    output_pixel_limit: int = 40_000_000

    def __post_init__(self) -> None:
        token = self.api_token.get_secret_value()
        key = self.ark_api_key.get_secret_value()
        # Kept only to redact historical tokens from stored input; never required
        # for local access. New configurations may omit this legacy value.
        if key and (len(key) > 1024 or not key.isascii() or any(c.isspace() for c in key)):
            raise ConfigurationError("ARK_API_KEY contains invalid characters")
        if key and token and token == key:
            raise ConfigurationError("The local API token must differ from ARK_API_KEY")
        # Accept the official API root or the complete image endpoint copied from
        # Ark's docs. Normalize only these exact destinations, never arbitrary URLs.
        base_url = self.base_url.strip().removesuffix("/") if isinstance(self.base_url, str) else None
        if base_url not in {ARK_BASE_URL, ARK_BASE_URL + "/images/generations"}:
            raise ConfigurationError("ARK_BASE_URL must be the official Beijing Ark /api/v3 base URL or /api/v3/images/generations endpoint")
        object.__setattr__(self, "base_url", ARK_BASE_URL)
        if not re.fullmatch(r"(?:doubao-seedream-5-0-(?:pro|flash)-\d{6}|ep-[a-zA-Z0-9-]{4,100})", self.model):
            raise ConfigurationError("SEEDREAM_MODEL must identify a Seedream 5.0 pro/flash model or an Ark endpoint")
        if key and key in self.model or token and token in self.model:
            raise ConfigurationError("SEEDREAM_MODEL must not contain a credential")
        if not 1 <= self.max_calls <= 100 or min(self.budget_cents, self.reservation_cents) < 0:
            raise ConfigurationError("Invalid Seedream budget or maximum call count")

    def blockers(self) -> list[str]:
        issues = []
        if not self.ark_api_key.get_secret_value():
            issues.append("API_KEY_MISSING")
        if not self.paid_calls_enabled:
            issues.append("PAID_CALLS_DISABLED")
        if not self.pricing_confirmed:
            issues.append("PRICING_NOT_CONFIRMED")
        if not self.budget_cents or not self.reservation_cents:
            issues.append("BUDGET_NOT_CONFIGURED")
        return issues


def load_settings(root: Path = PROJECT_ROOT, environ: Mapping[str, str] | None = None) -> Settings:
    """Load only this project's .env; disable interpolation and prefer process env."""
    env_file = root / ".env"
    values: dict[str, str] = {}
    if env_file.is_file():
        if env_file.stat().st_size > 16 * 1024:
            raise ConfigurationError("Project .env exceeds the configuration size limit")
        # UTF-8 BOM is accepted from Windows editors; no shell substitution is performed.
        values.update({k: v or "" for k, v in dotenv_values(env_file, encoding="utf-8-sig", interpolate=False).items()})
    values.update(os.environ if environ is None else environ)
    try:
        max_calls = int(values.get("PATTERN_STUDIO_SEEDREAM_MAX_CALLS", "5"))
    except ValueError:
        raise ConfigurationError("PATTERN_STUDIO_SEEDREAM_MAX_CALLS must be an integer") from None
    return Settings(
        api_token=SecretStr(values.get("PATTERN_STUDIO_API_TOKEN", "")),
        ark_api_key=SecretStr(values.get("ARK_API_KEY", "")),
        storage_root=(root / "storage" / "api").resolve(),
        model=values.get("SEEDREAM_MODEL", DEFAULT_MODEL),
        base_url=values.get("ARK_BASE_URL", ARK_BASE_URL),
        paid_calls_enabled=boolean(values.get("PATTERN_STUDIO_PAID_CALLS_ENABLED", "false"), "PATTERN_STUDIO_PAID_CALLS_ENABLED"),
        pricing_confirmed=boolean(values.get("PATTERN_STUDIO_PRICING_CONFIRMED", "false"), "PATTERN_STUDIO_PRICING_CONFIRMED"),
        budget_cents=money_cents(values.get("PATTERN_STUDIO_SEEDREAM_BUDGET_CNY", "0"), "PATTERN_STUDIO_SEEDREAM_BUDGET_CNY"),
        reservation_cents=money_cents(values.get("PATTERN_STUDIO_SEEDREAM_RESERVATION_CNY", "0"), "PATTERN_STUDIO_SEEDREAM_RESERVATION_CNY"),
        max_calls=max_calls,
    )
