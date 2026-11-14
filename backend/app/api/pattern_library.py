"""Local endpoints for grouped patterns and user-managed categories."""

from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, Query
from pydantic import Field

from app.schemas.workbench import StrictModel
from app.services.pattern_library import PatternLibrary


class CategoryCreate(StrictModel):
    name: str = Field(min_length=1, max_length=200)


class CategoryUpdate(CategoryCreate):
    revision: int = Field(ge=1, strict=True)


class PatternCategoriesUpdate(StrictModel):
    category_ids: list[UUID] = Field(max_length=200)
    revision: int = Field(ge=0, strict=True)


def mount_pattern_library(app: FastAPI, current_store):
    """Mount routes using the workbench's lifespan-owned store getter."""
    instance = {"store": None, "service": None}

    def library():
        store = current_store()
        if instance["store"] is not store:
            instance["store"] = store
            instance["service"] = PatternLibrary(store)
        return instance["service"]

    @app.get("/api/v1/pattern-categories")
    def categories():
        return library().list_categories()

    @app.post("/api/v1/pattern-categories", status_code=201)
    def create_category(payload: CategoryCreate):
        return library().create_category(payload.name)

    @app.put("/api/v1/pattern-categories/{category_id}")
    def rename_category(category_id: UUID, payload: CategoryUpdate):
        return library().rename_category(str(category_id), payload.name, payload.revision)

    @app.delete("/api/v1/pattern-categories/{category_id}")
    def delete_category(category_id: UUID, revision: Annotated[int, Query(ge=1)]):
        return library().delete_category(str(category_id), revision)

    @app.get("/api/v1/patterns")
    def patterns(limit: int = Query(default=20, ge=1, le=50),
                 cursor: str | None = Query(default=None, max_length=18),
                 q: str = Query(default="", max_length=200),
                 kind: str | None = Query(default=None, max_length=64),
                 category_id: UUID | None = Query(default=None)):
        return library().list_patterns(limit, cursor, q, kind, str(category_id) if category_id else None)

    @app.get("/api/v1/patterns/{image_id}")
    def pattern(image_id: UUID):
        return library().get_pattern(str(image_id))

    @app.delete("/api/v1/patterns/{image_id}")
    def delete_pattern(image_id: UUID):
        return library().delete_pattern(str(image_id))

    @app.put("/api/v1/patterns/{image_id}/categories")
    def set_pattern_categories(image_id: UUID, payload: PatternCategoriesUpdate):
        return library().set_categories(str(image_id), [str(value) for value in payload.category_ids], payload.revision)

