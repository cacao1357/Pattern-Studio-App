"""Grouping and user-defined classifications for existing workbench images."""

from __future__ import annotations

import unicodedata
from uuid import UUID, uuid4

from app.storage import ServiceError, now
from app.workbench_store import page_offset


MAX_CATEGORIES = 200
MAX_CATEGORY_NAME = 60


class PatternLibrary:
    """A view over the existing images/assets tables plus lightweight categories."""

    def __init__(self, store):
        self.store = store
        with store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pattern_categories (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    name_key TEXT NOT NULL UNIQUE,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pattern_category_members (
                    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                    category_id TEXT NOT NULL REFERENCES pattern_categories(id) ON DELETE CASCADE,
                    PRIMARY KEY (image_id, category_id)
                );
                CREATE INDEX IF NOT EXISTS pattern_category_members_category
                    ON pattern_category_members(category_id, image_id);
                CREATE TABLE IF NOT EXISTS pattern_category_revisions (
                    image_id TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL DEFAULT 0
                );
            """)

    @staticmethod
    def _category_name(name):
        if not isinstance(name, str):
            raise ServiceError("INVALID_CATEGORY_NAME", "Category name must be text", 422)
        value = unicodedata.normalize("NFKC", name).strip()
        if not value or len(value) > MAX_CATEGORY_NAME or any(ord(ch) < 32 for ch in value):
            raise ServiceError("INVALID_CATEGORY_NAME", f"Use a category name from 1 to {MAX_CATEGORY_NAME} characters", 422)
        return value, value.casefold()

    @staticmethod
    def _image_id(image_id):
        try:
            return str(UUID(str(image_id)))
        except (TypeError, ValueError, AttributeError):
            raise ServiceError("IMAGE_NOT_FOUND", "Pattern not found", 404) from None

    @staticmethod
    def _category_id(category_id):
        try:
            return str(UUID(str(category_id)))
        except (TypeError, ValueError, AttributeError):
            raise ServiceError("CATEGORY_NOT_FOUND", "Category not found", 404) from None

    @staticmethod
    def _categories(db, image_id=None):
        if image_id is None:
            rows = db.execute("SELECT id,name,revision FROM pattern_categories ORDER BY name_key,id").fetchall()
        else:
            rows = db.execute("""SELECT c.id,c.name,c.revision FROM pattern_categories c
                JOIN pattern_category_members m ON m.category_id=c.id
                WHERE m.image_id=? ORDER BY c.name_key,c.id""", (image_id,)).fetchall()
        return [{"category_id": row["id"], "name": row["name"], "revision": row["revision"]} for row in rows]

    def list_categories(self):
        with self.store.connection() as db:
            return {"items": self._categories(db)}

    def create_category(self, name):
        value, key = self._category_name(name)
        category_id, timestamp = str(uuid4()), now()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT count(*) FROM pattern_categories").fetchone()[0] >= MAX_CATEGORIES:
                raise ServiceError("CATEGORY_LIMIT", f"Keep no more than {MAX_CATEGORIES} categories", 409)
            if db.execute("SELECT 1 FROM pattern_categories WHERE name_key=?", (key,)).fetchone():
                raise ServiceError("CATEGORY_EXISTS", "A category with that name already exists", 409)
            db.execute("INSERT INTO pattern_categories VALUES (?,?,?,1,?,?)", (category_id, value, key, timestamp, timestamp))
            db.commit()
        return {"category_id": category_id, "name": value, "revision": 1}

    def rename_category(self, category_id, name, revision):
        category_id = self._category_id(category_id)
        value, key = self._category_name(name)
        if type(revision) is not int or revision < 1:
            raise ServiceError("INVALID_REVISION", "Revision must be a positive integer", 422)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT revision FROM pattern_categories WHERE id=?", (category_id,)).fetchone()
            if current is None:
                raise ServiceError("CATEGORY_NOT_FOUND", "Category not found", 404)
            if current["revision"] != revision:
                raise ServiceError("STALE_REVISION", "Reload categories before renaming", 409)
            duplicate = db.execute("SELECT id FROM pattern_categories WHERE name_key=?", (key,)).fetchone()
            if duplicate and duplicate["id"] != category_id:
                raise ServiceError("CATEGORY_EXISTS", "A category with that name already exists", 409)
            next_revision = revision + 1
            db.execute("UPDATE pattern_categories SET name=?,name_key=?,revision=?,updated_at=? WHERE id=?",
                       (value, key, next_revision, now(), category_id))
            db.commit()
        return {"category_id": category_id, "name": value, "revision": next_revision}

    def delete_category(self, category_id, revision):
        category_id = self._category_id(category_id)
        if type(revision) is not int or revision < 1:
            raise ServiceError("INVALID_REVISION", "Revision must be a positive integer", 422)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT revision FROM pattern_categories WHERE id=?", (category_id,)).fetchone()
            if current is None:
                raise ServiceError("CATEGORY_NOT_FOUND", "Category not found", 404)
            if current["revision"] != revision:
                raise ServiceError("STALE_REVISION", "Reload categories before deleting", 409)
            affected_images = db.execute(
                "SELECT image_id FROM pattern_category_members WHERE category_id=?", (category_id,)
            ).fetchall()
            for row in affected_images:
                db.execute("""INSERT INTO pattern_category_revisions(image_id,revision) VALUES (?,1)
                    ON CONFLICT(image_id) DO UPDATE SET revision=revision+1""", (row["image_id"],))
            db.execute("DELETE FROM pattern_categories WHERE id=?", (category_id,))
            db.commit()
        return {"category_id": category_id, "deleted": True}

    def set_categories(self, image_id, category_ids, revision):
        image_id = self._image_id(image_id)
        if not isinstance(category_ids, list) or len(category_ids) > MAX_CATEGORIES:
            raise ServiceError("INVALID_CATEGORIES", "Choose a valid list of categories", 422)
        try:
            normalized = [str(UUID(str(value))) for value in category_ids]
        except (TypeError, ValueError, AttributeError):
            raise ServiceError("CATEGORY_NOT_FOUND", "One or more categories do not exist", 404) from None
        if len(set(normalized)) != len(normalized):
            raise ServiceError("DUPLICATE_CATEGORY", "Choose each category once", 422)
        if type(revision) is not int or revision < 0:
            raise ServiceError("INVALID_REVISION", "Revision must be a nonnegative integer", 422)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM images WHERE id=?", (image_id,)).fetchone() is None:
                raise ServiceError("IMAGE_NOT_FOUND", "Pattern not found", 404)
            revision_row = db.execute("SELECT revision FROM pattern_category_revisions WHERE image_id=?", (image_id,)).fetchone()
            current_revision = revision_row[0] if revision_row else 0
            if current_revision != revision:
                raise ServiceError("STALE_REVISION", "Reload pattern categories before saving", 409)
            if normalized:
                placeholders = ",".join("?" for _ in normalized)
                found = db.execute(f"SELECT count(*) FROM pattern_categories WHERE id IN ({placeholders})", tuple(normalized)).fetchone()[0]
                if found != len(normalized):
                    raise ServiceError("CATEGORY_NOT_FOUND", "One or more categories do not exist", 404)
            next_revision = current_revision + 1
            db.execute("DELETE FROM pattern_category_members WHERE image_id=?", (image_id,))
            db.executemany("INSERT INTO pattern_category_members VALUES (?,?)", [(image_id, item) for item in normalized])
            db.execute("""INSERT INTO pattern_category_revisions(image_id,revision) VALUES (?,?)
                ON CONFLICT(image_id) DO UPDATE SET revision=excluded.revision""", (image_id, next_revision))
            db.commit()
        return {"image_id": image_id, "category_ids": normalized, "revision": next_revision}

    def _assets_for_image(self, image_id):
        assets, cursor = [], None
        while True:
            page = self.store.page_image_history(image_id, "assets", 50, cursor)
            assets.extend(page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                return assets

    def _pattern(self, image_id, *, supplied_assets=None, image_record=None):
        image_id = self._image_id(image_id)
        record = image_record if image_record is not None else self.store.get_image(image_id)
        assets = supplied_assets if supplied_assets is not None else self._assets_for_image(image_id)
        by_id = {asset["asset_id"]: asset for asset in assets}
        original = by_id.get(record["original"]["asset_id"], record["original"])
        normalized = by_id.get(record["normalized"]["asset_id"], record["normalized"])
        filename = original.get("filename") or original.get("source_name") or record.get("source_note") or "未命名纹样"
        with self.store.connection() as db:
            category_rows = self._categories(db, image_id)
            revision_row = db.execute("SELECT revision FROM pattern_category_revisions WHERE image_id=?", (image_id,)).fetchone()
        return {"image_id": image_id, "original_asset_id": original["asset_id"],
                "normalized_asset_id": normalized["asset_id"], "name": filename,
                "created_at": record["created_at"], "assets": sorted(assets, key=lambda item: item.get("created_at", ""), reverse=True),
                "categories": category_rows, "category_ids": [item["category_id"] for item in category_rows],
                "revision": revision_row[0] if revision_row else 0}

    def get_pattern(self, image_id):
        return self._pattern(image_id)

    def list_patterns(self, limit=20, cursor=None, query="", kind=None, category_id=None):
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ServiceError("INVALID_LIMIT", "Limit must be from 1 to 50", 422)
        offset = page_offset(cursor)
        query = (query or "").strip().casefold()
        kind = (kind or "").strip().casefold()
        category_id = self._category_id(category_id) if category_id else None
        with self.store.connection() as db:
            if category_id and db.execute("SELECT 1 FROM pattern_categories WHERE id=?", (category_id,)).fetchone() is None:
                raise ServiceError("CATEGORY_NOT_FOUND", "Category not found", 404)
        selected, next_cursor = [], None
        scan_cursor = offset
        exhausted = False
        while not exhausted and next_cursor is None:
            with self.store.connection() as db:
                rows = db.execute("""SELECT id,original_id,normalized_id,source_note,created_at,rowid AS sequence FROM images
                    WHERE rowid<? ORDER BY rowid DESC LIMIT 100""", (scan_cursor,)).fetchall()
            if not rows:
                break
            for row in rows:
                image_id = row["id"]
                assets = self._assets_for_image(image_id)
                original = next((a for a in assets if a["asset_id"] == row["original_id"]),
                                {"asset_id": row["original_id"]})
                names = " ".join(str(asset.get(field, "")) for asset in assets
                                 for field in ("filename", "source_name", "kind", "asset_id"))
                names = (names + " " + str(row["source_note"] or "")).casefold()
                if query and query not in names:
                    continue
                if kind and not any(str(asset.get("kind", "")).casefold() == kind for asset in assets):
                    continue
                if category_id:
                    with self.store.connection() as db:
                        if db.execute("SELECT 1 FROM pattern_category_members WHERE image_id=? AND category_id=?",
                                      (image_id, category_id)).fetchone() is None:
                            continue
                if len(selected) == limit:
                    # This matching lookahead confirms another page exists. The
                    # cursor points to the last item actually returned.
                    next_cursor = str(selected[-1]["_sequence"])
                    break
                pattern = self._pattern(image_id, supplied_assets=assets, image_record={
                    "image_id": image_id,
                    "original": {"asset_id": row["original_id"]},
                    "normalized": {"asset_id": row["normalized_id"]},
                    "source_note": row["source_note"],
                    "created_at": row["created_at"],
                })
                pattern["name"] = original.get("filename") or original.get("source_name") or row["source_note"] or "未命名纹样"
                pattern["_sequence"] = row["sequence"]
                selected.append(pattern)
            if next_cursor is None:
                scan_cursor = rows[-1]["sequence"]
                exhausted = len(rows) < 100
        for item in selected:
            item.pop("_sequence", None)
        return {"items": selected, "next_cursor": next_cursor}

