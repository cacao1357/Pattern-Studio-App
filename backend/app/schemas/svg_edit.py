"""Bounded palette substitutions on registered safe SVG assets."""
import re
from pydantic import Field, model_validator
from app.schemas.workbench import InputRequest
from app.schemas.workbench import StrictModel


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


class ElementEdit(StrictModel):
    element_id: str = Field(pattern=r"^p[0-9]+c[0-9]+$", max_length=40)
    dx: float = Field(default=0.0, ge=-25000, le=25000, strict=True)
    dy: float = Field(default=0.0, ge=-25000, le=25000, strict=True)
    deleted: bool = Field(default=False, strict=True)


class EditSvgRequest(InputRequest):
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    edits: list[ElementEdit] = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def unique_elements(self):
        if len({edit.element_id for edit in self.edits}) != len(self.edits):
            raise ValueError("Each element may be edited once per saved version")
        return self
