"""User-curated originals shown in the workbench pattern rail.

The pattern library is the complete index; the workbench rail is only the
subset the user explicitly added. Membership lives in its own table so the
rail survives reloads and stays consistent across windows. Removing an item
here never deletes an image or an asset.
"""

from __future__ import annotations

from uuid import UUID

from app.storage import ServiceError, now
from app.workbench_store import page_offset


MAX_ITEMS = 500
MAX_BATCH = 200


class WorkbenchBoard:
    """Membership table plus grouped reads for the workbench rail."""

    def __init__(self, store, patterns):
        self.store = store
        self.patterns = patterns
        with store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS workbench_items (
                    image_id TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    added_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS workbench_items_position
                    ON workbench_items(position DESC, image_id);
            """)

    @staticmethod
    def _image_ids(image_ids):
        if not isinstance(image_ids, list) or not 1 <= len(image_ids) <= MAX_BATCH:
            raise ServiceError(
                "INVALID_WORKBENCH_SELECTION",
                f"Choose from 1 to {MAX_BATCH} patterns",
                422,
            )
        normalized = []
        for value in image_ids:
            try:
                image_id = str(UUID(str(value)))
            except (TypeError, ValueError, AttributeError):
                raise ServiceError("IMAGE_NOT_FOUND", "Pattern not found", 404) from None
            if image_id not in normalized:
                normalized.append(image_id)
        return normalized

    def list_items(self, limit=20, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ServiceError("INVALID_LIMIT", "Limit must be from 1 to 50", 422)
        position = page_offset(cursor)
        with self.store.connection() as db:
            rows = db.execute("""SELECT image_id,position,added_at FROM workbench_items
                WHERE position<? ORDER BY position DESC LIMIT ?""", (position, limit + 1)).fetchall()
        visible = rows[:limit]
        next_cursor = str(visible[-1]["position"]) if len(rows) > limit else None
        items = []
        for row in visible:
            try:
                pattern = self.patterns.get_pattern(row["image_id"])
            except ServiceError:
                # A membership row can only go stale if the image vanished
                # without the FK cascade; skip it instead of failing the rail.
                continue
            pattern["added_at"] = row["added_at"]
            items.append(pattern)
        return {"items": items, "next_cursor": next_cursor}

    def add_items(self, image_ids):
        image_ids = self._image_ids(image_ids)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            marks = ",".join("?" for _ in image_ids)
            found = {row["id"] for row in db.execute(
                f"SELECT id FROM images WHERE id IN ({marks})", tuple(image_ids)
            )}
            missing = [image_id for image_id in image_ids if image_id not in found]
            existing = {row["image_id"] for row in db.execute(
                "SELECT image_id FROM workbench_items")}
            wanted = [image_id for image_id in image_ids
                      if image_id in found and image_id not in existing]
            free = MAX_ITEMS - len(existing)
            if len(wanted) > free:
                raise ServiceError("WORKBENCH_LIMIT",
                    f"Keep no more than {MAX_ITEMS} patterns in the workbench", 409)
            position = db.execute("SELECT max(position) FROM workbench_items").fetchone()[0] or 0
            added = []
            for image_id in wanted:
                position += 1
                db.execute("INSERT INTO workbench_items VALUES (?,?,?)",
                           (image_id, position, now()))
                added.append(image_id)
            db.commit()
        return {
            "added": added,
            "added_count": len(added),
            "existing_count": len(image_ids) - len(added) - len(missing),
            "missing": missing,
        }

    def remove_items(self, image_ids):
        image_ids = self._image_ids(image_ids)
        marks = ",".join("?" for _ in image_ids)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            before = db.execute("SELECT count(*) FROM workbench_items").fetchone()[0]
            db.execute(f"DELETE FROM workbench_items WHERE image_id IN ({marks})", tuple(image_ids))
            after = db.execute("SELECT count(*) FROM workbench_items").fetchone()[0]
            db.commit()
        return {"removed": before - after, "image_ids": image_ids}
