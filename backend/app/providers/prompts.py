"""Immutable prompt versions. B may add tested candidates without editing orchestration."""

from app.storage import ServiceError

DEFAULT_PROMPT_VERSION = "s0-seedream-v1"
DECOMPOSITION_PROMPTS = {
    DEFAULT_PROMPT_VERSION: "将图片中的纹样主体与背景拆分为独立图层，保留纹样结构与颜色，避免将整个底图当作纹样主体。",
}


def decomposition_prompt(version: str = DEFAULT_PROMPT_VERSION) -> str:
    if version not in DECOMPOSITION_PROMPTS:
        raise ServiceError("PROMPT_VERSION_UNAVAILABLE", "Choose a registered decomposition prompt version", 422)
    return DECOMPOSITION_PROMPTS[version]
