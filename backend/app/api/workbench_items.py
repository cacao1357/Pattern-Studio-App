"""Local endpoints for the user-curated workbench pattern rail."""

from uuid import UUID

from fastapi import FastAPI, Query
from pydantic import Field

from app.schemas.workbench import StrictModel
from app.services.pattern_library import PatternLibrary
from app.services.workbench_board import WorkbenchBoard


class WorkbenchItemsPayload(StrictModel):
    image_ids: list[UUID] = Field(min_length=1, max_length=200)


def mount_workbench_items(app: FastAPI, current_store):
    instance = {"store": None, "board": None}

    def board():
        store = current_store()
        if instance["store"] is not store:
            instance["store"] = store
            instance["board"] = WorkbenchBoard(store, PatternLibrary(store))
        return instance["board"]

    @app.get("/api/v1/workbench/items")
    def items(limit: int = Query(default=20, ge=1, le=50),
              cursor: str | None = Query(default=None, max_length=18)):
        return board().list_items(limit, cursor)

    @app.post("/api/v1/workbench/items")
    def add_items(payload: WorkbenchItemsPayload):
        return board().add_items([str(value) for value in payload.image_ids])

    @app.delete("/api/v1/workbench/items")
    def remove_items(payload: WorkbenchItemsPayload):
        return board().remove_items([str(value) for value in payload.image_ids])
