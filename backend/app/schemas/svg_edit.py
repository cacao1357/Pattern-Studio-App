"""Bounded palette substitutions on registered safe SVG assets."""
import re
from pydantic import Field, model_validator
from app.schemas.workbench import InputRequest


class RecolorRequest(InputRequest):
    mapping: dict[str, str] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def solid_colors(self):
        colors = [*self.mapping, *self.mapping.values()]
        if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in colors):
            raise ValueError("Use six-digit hexadecimal solid colors")
        if len({key.lower() for key in self.mapping}) != len(self.mapping):
            raise ValueError("Each source color may be replaced once")
        return self
