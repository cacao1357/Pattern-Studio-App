"""Small image-provider contract; callers own budgets, consent and persistence."""

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.providers.seedream import ProviderResult


class ImageProvider(Protocol):
    def generate(self, payload: dict, operation: str) -> "ProviderResult": ...
