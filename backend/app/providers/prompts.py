"""Immutable prompt versions. B may add tested candidates without editing orchestration."""

from app.storage import ServiceError

DEFAULT_PROMPT_VERSION = "s0-seedream-v1"
LINEART_PROMPT_VERSION = "lineart-seedream-v1"
LINEART_PROMPT = (
    "将图1中的纹样转换成白底黑色线稿。忠实保留原有主体、内部线条、相对位置、比例和边界，"
    "保留细节与原有线条粗细关系，去除底色、阴影、材质纹理和拍摄噪点。"
    "不要补画缺损、增删纹样元素、重新排版或裁切，不要文字、水印或边框。输出与输入相同比例。"
)
DECOMPOSITION_PROMPTS = {
    DEFAULT_PROMPT_VERSION: "将图片中的纹样主体与背景拆分为独立图层，保留纹样结构与颜色，避免将整个底图当作纹样主体。",
}


def decomposition_prompt(version: str = DEFAULT_PROMPT_VERSION) -> str:
    if version not in DECOMPOSITION_PROMPTS:
        raise ServiceError("PROMPT_VERSION_UNAVAILABLE", "Choose a registered decomposition prompt version", 422)
    return DECOMPOSITION_PROMPTS[version]
