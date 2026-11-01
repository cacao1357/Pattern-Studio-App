"""Registered immutable assets and a small durable S0 call/budget ledger."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sqlite3
from uuid import UUID, uuid4

from PIL import Image


class ServiceError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png_bytes(image: Image.Image) -> bytes:
    image = image.copy()
    image.info.clear()
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.assets_root = self.root / "assets"
        self.assets_root.mkdir(exist_ok=True)
        self.db_path = self.root / "s0.sqlite3"
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY, suffix TEXT NOT NULL, metadata TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_calls (
                    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
                    request_hash TEXT NOT NULL, input_asset_id TEXT NOT NULL,
                    input_hash TEXT NOT NULL, operation TEXT NOT NULL,
                    state TEXT NOT NULL, reservation_cents INTEGER NOT NULL,
                    actual_cost_cents INTEGER, billing_reference TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    request_json TEXT NOT NULL, result_json TEXT NOT NULL
                );
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        try:
            yield db
        finally:
            db.close()

    def put_asset(self, data: bytes, suffix: str, metadata: dict) -> dict:
        if suffix not in {".png", ".jpg"}:
            raise ServiceError("ASSET_TYPE_INVALID", "Only registered PNG/JPEG assets are supported")
        asset_id = str(uuid4())
        target = (self.assets_root / (asset_id + suffix)).resolve()
        if target.parent != self.assets_root.resolve():
            raise ServiceError("STORAGE_UNSAFE", "Asset storage path is invalid", 500)
        temporary = target.with_suffix(suffix + ".tmp")
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(target)
        record = {**metadata, "asset_id": asset_id, "sha256": digest(data), "bytes": len(data)}
        with self.connection() as db:
            db.execute("INSERT INTO assets VALUES (?, ?, ?)", (asset_id, suffix, canonical_json(record)))
        return record

    def get_asset(self, asset_id: str) -> tuple[dict, Path]:
        try:
            asset_id = str(UUID(asset_id))
        except (ValueError, TypeError, AttributeError):
            raise ServiceError("ASSET_NOT_FOUND", "Registered asset not found", 404) from None
        with self.connection() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise ServiceError("ASSET_NOT_FOUND", "Registered asset not found", 404)
        path = (self.assets_root / (asset_id + row["suffix"])).resolve()
        if path.parent != self.assets_root.resolve() or not path.is_file():
            raise ServiceError("ASSET_UNAVAILABLE", "Registered asset file is unavailable", 404)
        return json.loads(row["metadata"]), path

    def read_asset(self, asset_id: str) -> tuple[dict, bytes]:
        metadata, path = self.get_asset(asset_id)
        if path.stat().st_size != metadata["bytes"]:
            raise ServiceError("ASSET_CHANGED", "Registered immutable asset has changed", 409)
        data = path.read_bytes()
        if len(data) != metadata["bytes"] or digest(data) != metadata["sha256"]:
            raise ServiceError("ASSET_CHANGED", "Registered immutable asset has changed", 409)
        return metadata, data

    @staticmethod
    def public_call(row: sqlite3.Row) -> dict:
        return {
            "call_id": row["id"], "state": row["state"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "request": json.loads(row["request_json"]),
            "result": json.loads(row["result_json"]),
            "billing": {"reservation_cny": f'{row["reservation_cents"] / 100:.2f}',
                        "actual_cost_cny": None if row["actual_cost_cents"] is None else f'{row["actual_cost_cents"] / 100:.2f}',
                        "status": "needs_account_reconciliation" if row["actual_cost_cents"] is None else "manually_settled"},
        }

    def get_call(self, call_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM provider_calls WHERE id=?", (call_id,)).fetchone()
        if row is None:
            raise ServiceError("CALL_NOT_FOUND", "Provider validation not found", 404)
        return self.public_call(row)

    def budget(self, budget_cents: int, max_calls: int) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT count(*) AS count, coalesce(sum(coalesce(actual_cost_cents, reservation_cents)),0) AS used FROM provider_calls").fetchone()
        return {"limit_cny": f"{budget_cents / 100:.2f}", "committed_cny": f'{row["used"] / 100:.2f}',
                "remaining_cny": f'{(budget_cents - row["used"]) / 100:.2f}',
                "call_count": row["count"], "max_calls": max_calls}

    def reserve(self, key: str, request: dict, input_hash: str, *, reservation: int, budget: int, max_calls: int) -> tuple[dict, bool]:
        request_json = canonical_json(request)
        request_hash = digest(request_json.encode())
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM provider_calls WHERE idempotency_key=?", (key,)).fetchone()
            if existing is not None:
                if existing["request_hash"] != request_hash:
                    raise ServiceError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to different parameters", 409)
                db.commit()
                return self.public_call(existing), False
            if db.execute("SELECT 1 FROM provider_calls WHERE state='running'").fetchone():
                raise ServiceError("PROVIDER_BUSY", "One provider validation is already running", 409)
            if db.execute("SELECT 1 FROM provider_calls WHERE input_hash=? AND operation=? AND state IN ('outcome_unknown','output_invalid')", (input_hash, request["operation"])).fetchone():
                raise ServiceError("NEEDS_RECONCILIATION", "An earlier call for this input has unknown or unarchived output; reconcile it before generating again", 409)
            row = db.execute("SELECT count(*) AS count, coalesce(sum(coalesce(actual_cost_cents,reservation_cents)),0) AS used FROM provider_calls").fetchone()
            if row["count"] >= max_calls or row["used"] + reservation > budget:
                raise ServiceError("PROVIDER_BUDGET_EXHAUSTED", "The configured call or CNY reservation limit is exhausted", 429)
            call_id, timestamp = str(uuid4()), now()
            db.execute("""INSERT INTO provider_calls
                (id,idempotency_key,request_hash,input_asset_id,input_hash,operation,state,reservation_cents,
                 created_at,updated_at,request_json,result_json) VALUES (?,?,?,?,?,?,'running',?,?,?,?,?)""",
                (call_id, key, request_hash, request["input_asset_id"], input_hash, request["operation"],
                 reservation, timestamp, timestamp, request_json, "{}"))
            db.commit()
        return self.get_call(call_id), True

    def finish(self, call_id: str, state: str, result: dict) -> dict:
        with self.connection() as db:
            changed = db.execute("UPDATE provider_calls SET state=?,result_json=?,updated_at=? WHERE id=? AND state='running'",
                                 (state, canonical_json(result), now(), call_id)).rowcount
        if changed != 1:
            raise ServiceError("CALL_STATE_CONFLICT", "Provider validation state changed", 409)
        return self.get_call(call_id)

    def recover_interrupted_calls(self) -> int:
        """Only on startup of the single, exclusively locked API process."""
        with self.connection() as db:
            return db.execute("UPDATE provider_calls SET state='outcome_unknown',result_json=?,updated_at=? WHERE state='running'",
                              (canonical_json({"error_code": "PROCESS_INTERRUPTED", "needs_reconcile": True}), now())).rowcount

    def settle(self, call_id: str, cents: int, reference: str) -> dict:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM provider_calls WHERE id=?", (call_id,)).fetchone()
            if row is None:
                raise ServiceError("CALL_NOT_FOUND", "Provider validation not found", 404)
            if row["state"] == "running":
                raise ServiceError("CALL_RUNNING", "Wait for this call before reconciling its cost", 409)
            if row["actual_cost_cents"] is not None:
                if row["actual_cost_cents"] != cents or row["billing_reference"] != reference:
                    raise ServiceError("SETTLEMENT_CONFLICT", "An account reconciliation is already recorded", 409)
            else:
                db.execute("UPDATE provider_calls SET actual_cost_cents=?,billing_reference=?,updated_at=? WHERE id=?", (cents, reference, now(), call_id))
            db.commit()
        return self.get_call(call_id)
