"""Additive workbench/confirmation tables and atomic immutable publication."""

import json
import os
import re
import time
from collections import Counter
from uuid import uuid4

from app.storage import Store, ServiceError, canonical_json, digest, now


TERMINAL = {"succeeded", "failed", "cancelled"}
EXTERNAL_CALL_JOBS = {"decompose-layers"}

# Image-level facts copied onto every derived asset so a manifest can be read
# without walking the whole parent graph.
ASSET_META_KEYS = (
    "image_id", "content_id", "grade", "grade_version", "split",
    "license", "source_type", "source_name", "source_url", "collected_at",
    "batch_id", "provenance_status", "normalization_version",
)


def validate_key(key: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", key):
        raise ServiceError("IDEMPOTENCY_KEY_REQUIRED", "Supply a random Idempotency-Key of 16..128 ASCII letters, digits, underscores or hyphens", 422)
    return key


def page_offset(cursor):
    if cursor is not None and not re.fullmatch(r"[1-9][0-9]{0,17}", cursor):
        raise ServiceError("INVALID_CURSOR", "Use the next_cursor returned by the listing", 422)
    return int(cursor) if cursor else 9223372036854775807


class WorkbenchStore(Store):
    def __init__(self, root):
        super().__init__(root)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS images (
                    id TEXT PRIMARY KEY, original_id TEXT NOT NULL REFERENCES assets(id),
                    normalized_id TEXT NOT NULL REFERENCES assets(id),
                    source_note TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS image_meta (
                    image_id TEXT PRIMARY KEY REFERENCES images(id),
                    content_id TEXT NOT NULL,
                    grade TEXT NOT NULL,
                    grade_version TEXT NOT NULL,
                    short_side INTEGER,
                    sharpness REAL,
                    contrast REAL,
                    ref_size INTEGER NOT NULL,
                    ref_fit TEXT NOT NULL,
                    ahash TEXT NOT NULL,
                    fingerprint_version TEXT NOT NULL,
                    split TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    license TEXT NOT NULL,
                    collected_at TEXT NOT NULL,
                    batch_id TEXT NOT NULL,
                    provenance_status TEXT NOT NULL,
                    normalization_version TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS image_meta_content ON image_meta(content_id);
                CREATE TABLE IF NOT EXISTS local_jobs (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, input_id TEXT REFERENCES assets(id),
                    parameters TEXT NOT NULL, state TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    started_at TEXT, finished_at TEXT, retry_of TEXT REFERENCES local_jobs(id),
                    lease_token TEXT, lease_until REAL, attempt INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT NOT NULL, error_json TEXT
                );
                CREATE INDEX IF NOT EXISTS local_jobs_queue ON local_jobs(state, created_at);
                CREATE TABLE IF NOT EXISTS local_keys (
                    scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
                    target_id TEXT NOT NULL, PRIMARY KEY(scope,key)
                );
                CREATE TABLE IF NOT EXISTS asset_relations (
                    child_id TEXT NOT NULL REFERENCES assets(id),
                    parent_id TEXT NOT NULL REFERENCES assets(id), role TEXT NOT NULL,
                    PRIMARY KEY(child_id,parent_id,role)
                );
                CREATE TABLE IF NOT EXISTS local_pipelines (
                    id TEXT PRIMARY KEY REFERENCES local_jobs(id), configuration TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS feedback (
                    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES local_jobs(id),
                    data TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS consents (
                    id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback(id),
                    version TEXT NOT NULL, training INTEGER NOT NULL, display INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ai_flows (
                    id TEXT PRIMARY KEY, input_id TEXT NOT NULL REFERENCES assets(id),
                    decomposition_job_id TEXT NOT NULL REFERENCES local_jobs(id),
                    continuation_job_id TEXT REFERENCES local_jobs(id), state TEXT NOT NULL,
                    revision INTEGER NOT NULL, configuration TEXT NOT NULL,
                    selected_layers TEXT NOT NULL, decision_json TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS repair_decisions (
                    job_id TEXT PRIMARY KEY REFERENCES local_jobs(id),
                    decision_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_branches (
                    job_id TEXT PRIMARY KEY REFERENCES local_jobs(id),
                    flow_id TEXT NOT NULL REFERENCES ai_flows(id),
                    parent_job_id TEXT REFERENCES local_jobs(id), action TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_selections (
                    flow_id TEXT PRIMARY KEY REFERENCES ai_flows(id), assessment TEXT NOT NULL
                );
            """)

    @staticmethod
    def _existing(db, scope, key, request_hash):
        row = db.execute("SELECT * FROM local_keys WHERE scope=? AND key=?", (scope, validate_key(key))).fetchone()
        if row and row["request_hash"] != request_hash:
            raise ServiceError("IDEMPOTENCY_CONFLICT", "This key already identifies different input or parameters", 409)
        return row["target_id"] if row else None

    def existing(self, scope, key, request_hash):
        with self.connection() as db:
            return self._existing(db, scope, key, request_hash)

    def _stage(self, outputs):
        staged = []
        try:
            for output in outputs:
                data, suffix = output["data"], output["suffix"]
                if suffix not in {".png", ".jpg", ".svg", ".zip"}:
                    raise ServiceError("ASSET_TYPE_INVALID", "Unsupported local asset type")
                record = dict(output["metadata"])
                asset_id = record.pop("asset_id", str(uuid4()))
                # All output identifiers are generated by this service, never filenames.
                from uuid import UUID
                asset_id = str(UUID(asset_id))
                target = (self.assets_root / (asset_id + suffix)).resolve()
                if target.parent != self.assets_root.resolve() or target.exists():
                    raise ServiceError("STORAGE_UNSAFE", "New asset target is unavailable", 409)
                temporary = target.with_suffix(suffix + ".tmp")
                staged.append((record, target, temporary, suffix))
                with temporary.open("xb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary.replace(target)
                record.update(asset_id=asset_id, sha256=digest(data), bytes=len(data), created_at=now())
            return staged
        except BaseException:
            self._discard(staged)
            raise

    @staticmethod
    def _discard(staged):
        # Only exact, newly generated targets from this operation are removed.
        for _, target, temporary, _ in staged:
            temporary.unlink(missing_ok=True)
            target.unlink(missing_ok=True)

    @staticmethod
    def _register(db, staged):
        for record, _, _, suffix in staged:
            db.execute("INSERT INTO assets VALUES (?,?,?)", (record["asset_id"], suffix, canonical_json(record)))
            for parent in record.get("parents", []):
                db.execute("INSERT INTO asset_relations VALUES (?,?,?)", (record["asset_id"], parent["asset_id"], parent["role"]))

    def add_image(self, outputs, source_note, key, request_hash, *, meta=None):
        existing = self.existing("images", key, request_hash)
        if existing:
            return self.get_image(existing), False, []
        staged = self._stage(outputs)
        image_id, created = str(uuid4()), now()
        if meta:
            for record, _, _, _ in staged:
                record["image_id"] = image_id
                for field in ASSET_META_KEYS:
                    if field == "image_id":
                        continue
                    value = meta.get(field)
                    if value not in (None, ""):
                        record[field] = value
        try:
            with self.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = self._existing(db, "images", key, request_hash)
                if existing:
                    db.rollback()
                else:
                    self._register(db, staged)
                    db.execute("INSERT INTO images VALUES (?,?,?,?,?)", (image_id, staged[0][0]["asset_id"], staged[1][0]["asset_id"], source_note, created))
                    if meta:
                        db.execute("""INSERT INTO image_meta
                            (image_id,content_id,grade,grade_version,short_side,sharpness,contrast,
                             ref_size,ref_fit,ahash,fingerprint_version,split,source_type,source_name,
                             source_url,license,collected_at,batch_id,provenance_status,
                             normalization_version,created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (image_id, meta.get("content_id", ""), meta.get("grade", "U"),
                             meta.get("grade_version", ""), meta.get("short_side"), meta.get("sharpness"),
                             meta.get("contrast"), meta.get("ref_size", 512), meta.get("ref_fit", ""),
                             meta.get("ahash", ""), meta.get("fingerprint_version", ""), meta.get("split", ""),
                             meta.get("source_type", "未确认"), meta.get("source_name", ""),
                             meta.get("source_url", ""), meta.get("license", "未确认"),
                             meta.get("collected_at", ""), meta.get("batch_id", ""),
                             meta.get("provenance_status", "unverified"),
                             meta.get("normalization_version", ""), created))
                    db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", ("images", key, request_hash, image_id))
                    db.commit()
        except BaseException:
            self._discard(staged)
            raise
        if existing:
            self._discard(staged)
        candidates = []
        if meta and meta.get("ahash"):
            with self.connection() as db:
                candidates = self._similar(db, meta["ahash"], image_id)
        return self.get_image(existing or image_id), not bool(existing), candidates

    @staticmethod
    def _meta(row):
        if row is None:
            return None
        return {key: row[key] for key in row.keys()}

    @staticmethod
    def _similar(db, ahash_value, exclude_image_id, threshold=4):
        """Coarse duplicate candidates; NCC confirmation happens in the caller."""
        try:
            target = int(ahash_value)
        except (TypeError, ValueError):
            return []
        rows = db.execute("""SELECT m.image_id,m.ahash,m.grade,m.split,i.original_id,i.normalized_id
                             FROM image_meta m JOIN images i ON i.id=m.image_id
                             WHERE m.image_id<>? AND m.ahash<>''""", (exclude_image_id,)).fetchall()
        output = []
        for row in rows:
            try:
                distance = int((target ^ int(row["ahash"])).bit_count())
            except (TypeError, ValueError):
                continue
            if distance <= threshold:
                output.append({
                    "image_id": row["image_id"], "distance": distance,
                    "grade": row["grade"], "split": row["split"],
                    "original_id": row["original_id"], "normalized_id": row["normalized_id"],
                })
        output.sort(key=lambda item: item["distance"])
        return output[:8]

    def image_meta(self, image_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM image_meta WHERE image_id=?", (image_id,)).fetchone()
        return self._meta(row)

    def images_without_meta(self):
        """Old images are readable but have no P0 measurements yet."""
        with self.connection() as db:
            return db.execute("""SELECT i.id,i.original_id,i.normalized_id
                                 FROM images i LEFT JOIN image_meta m ON m.image_id=i.id
                                 WHERE m.image_id IS NULL ORDER BY i.rowid""").fetchall()

    def dataset_rows(self):
        """One row per registered image, joined with P0 metadata and the original asset."""
        with self.connection() as db:
            rows = db.execute("""SELECT i.id AS image_id,i.original_id,i.normalized_id,
                                        i.source_note,i.created_at,i.rowid AS position,
                                        m.content_id,m.grade,m.grade_version,m.split,m.license,
                                        m.provenance_status,m.source_type,m.source_name,m.source_url,
                                        m.collected_at,m.batch_id,a.metadata AS original_metadata
                                 FROM images i
                                 LEFT JOIN image_meta m ON m.image_id=i.id
                                 JOIN assets a ON a.id=i.original_id
                                 ORDER BY i.rowid""").fetchall()
        output = []
        for row in rows:
            try:
                original = json.loads(row["original_metadata"])
            except (TypeError, ValueError):
                original = {}
            missing = row["content_id"] is None
            output.append({
                "image_id": row["image_id"],
                "content_id": row["content_id"] or "",
                "grade": row["grade"] or "",
                "grade_version": row["grade_version"] or "",
                "split": row["split"] or "",
                "license": row["license"] or "未确认",
                "provenance_status": row["provenance_status"] or "unverified",
                "source_type": row["source_type"] or "",
                "source_name": row["source_name"] or "",
                "source_url": row["source_url"] or "",
                "collected_at": row["collected_at"] or "",
                "batch_id": row["batch_id"] or "",
                "width": original.get("width", ""),
                "height": original.get("height", ""),
                "sha256": original.get("sha256", ""),
                "original_asset_id": row["original_id"],
                "normalized_asset_id": row["normalized_id"],
                "source_note": row["source_note"],
                "created_at": row["created_at"],
                "label_status": "not_reviewed",
                "missing_meta": missing,
            })
        return output

    def dataset_audit(self):
        """Aggregate the same rows used by the CSV manifest; no pixel work here."""
        rows = self.dataset_rows()
        total = len(rows)
        grades = Counter(row["grade"].upper() if row["grade"] else "missing" for row in rows)
        splits = Counter(row["split"] or "unassigned" for row in rows)
        licenses = [row["license"] for row in rows]
        confirmed = sum(1 for value in licenses if value not in ("", "未确认"))
        provenance = Counter(row["provenance_status"] for row in rows)
        content_counts = Counter(row["content_id"] for row in rows if row["content_id"])
        duplicate_content = {key: count for key, count in content_counts.items() if count > 1}
        return {
            "total_images": total,
            "images_with_meta": sum(1 for row in rows if not row["missing_meta"]),
            "missing_meta": sum(1 for row in rows if row["missing_meta"]),
            "usable_ab": sum(1 for row in rows if row["grade"] in {"A", "B"}),
            "grades": {key: grades.get(key, 0) for key in ("A", "B", "C", "U", "missing")},
            "splits": {key: splits.get(key, 0) for key in ("train", "val", "test", "unassigned")},
            "license_confirmed": confirmed,
            "license_unconfirmed": total - confirmed,
            "license_coverage": round(confirmed / total, 4) if total else 0.0,
            "provenance_declared": provenance.get("declared", 0),
            "provenance_unverified": provenance.get("unverified", 0),
            "source_types": dict(Counter(row["source_type"] or "未确认" for row in rows)),
            "batches": sorted({row["batch_id"] for row in rows if row["batch_id"]}),
            "content_ids": len(content_counts),
            "duplicate_content_ids": len(duplicate_content),
            "duplicate_images": sum(duplicate_content.values()),
            "label_status": {"not_reviewed": total},
        }

    def get_image(self, image_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            meta_row = db.execute("SELECT * FROM image_meta WHERE image_id=?", (image_id,)).fetchone() if row else None
        if not row:
            raise ServiceError("IMAGE_NOT_FOUND", "Image history entry not found", 404)
        return {"image_id": row["id"], "original": self.get_asset(row["original_id"])[0],
                "normalized": self.get_asset(row["normalized_id"])[0],
                "source_note": row["source_note"], "created_at": row["created_at"],
                "meta": self._meta(meta_row)}

    @staticmethod
    def _job(row):
        record = {"job_id": row["id"], "kind": row["kind"], "state": row["state"],
                  "input_asset_id": row["input_id"], "parameters": json.loads(row["parameters"]),
                  "retry_of": row["retry_of"], "result": json.loads(row["result_json"]),
                  "error": json.loads(row["error_json"]) if row["error_json"] else None}
        for field in ("created_at", "updated_at", "started_at", "finished_at", "attempt"):
            record[field] = row[field]
        if row["kind"] == "pipeline":
            record["pipeline_id"] = row["id"]
        if record["parameters"].get("ai_pipeline_id"):
            record["ai_pipeline_id"] = record["parameters"]["ai_pipeline_id"]
        if "branch_flow_id" in row.keys() and row["branch_flow_id"]:
            record.update(ai_pipeline_id=row["branch_flow_id"], parent_job_id=row["branch_parent_job_id"],
                          workflow_action=row["branch_action"])
        return record

    @staticmethod
    def _enqueue(db, kind, input_id, parameters, *, job_id=None, state="queued", result=None):
        if state == "queued" and db.execute("SELECT count(*) FROM local_jobs WHERE state IN ('queued','running')").fetchone()[0] >= 20:
            raise ServiceError("QUEUE_FULL", "Wait for a task to finish before adding more", 429)
        job_id, timestamp = job_id or str(uuid4()), now()
        db.execute("""INSERT INTO local_jobs
            (id,kind,input_id,parameters,state,created_at,updated_at,finished_at,result_json)
            VALUES (?,?,?,?,?,?,?,?,?)""", (job_id, kind, input_id, canonical_json(parameters), state,
                timestamp, timestamp, timestamp if state == "succeeded" else None,
                canonical_json(result or {"assets": [], "steps": []})))
        if kind == "pipeline":
            db.execute("INSERT INTO local_pipelines VALUES (?,?)", (job_id, canonical_json(parameters)))
        return job_id

    def create_ai_flow(self, input_id, parameters, key, *, archived_result=None, snapshot=None):
        scope = "pipelines/ai"
        request_hash = digest(canonical_json({"input": input_id, "parameters": parameters}).encode())
        flow_id, timestamp = str(uuid4()), now()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._existing(db, scope, key, request_hash)
            if not existing:
                job_id = self._enqueue(db, "decompose-layers", input_id,
                    {**parameters, "ai_pipeline_id": flow_id, "execution_snapshot": snapshot["snapshot"] if snapshot else None},
                    state="succeeded" if archived_result else "queued", result=archived_result)
                db.execute("INSERT INTO ai_flows VALUES (?,?,?,NULL,'decomposing',1,?,'[]',NULL,?,?)",
                    (flow_id, input_id, job_id, canonical_json({**parameters, "workflow": snapshot}), timestamp, timestamp))
                db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", (scope, key, request_hash, flow_id))
            db.commit()
        return self.get_ai_flow(existing or flow_id)

    def get_ai_flow(self, flow_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM ai_flows WHERE id=?", (flow_id,)).fetchone()
        if row is None:
            raise ServiceError("AI_PIPELINE_NOT_FOUND", "AI confirmation workflow not found", 404)
        decomposition = self.get_job(row["decomposition_job_id"])
        continuation = self.get_job(row["continuation_job_id"]) if row["continuation_job_id"] else None
        decision = json.loads(row["decision_json"]) if row["decision_json"] else None
        if row["state"] == "rejected":
            state, active = "rejected", decomposition
        elif continuation:
            state, active = continuation["state"], continuation
        else:
            state, active = decomposition["state"], decomposition
            if state == "succeeded":
                state = "waiting_user"
        steps = [{"name": "decompose-layers", "state": decomposition["state"]},
                 {"name": "select_layers", "state": "skipped" if decision and decision["action"] in {"use_local", "reject"} else
                  "succeeded" if decision else "waiting_user" if state == "waiting_user" else "blocked" if state == "failed" else "pending"}]
        if continuation:
            steps.extend(continuation["result"]["steps"])
        configuration = json.loads(row["configuration"])
        with self.connection() as db:
            branch_rows = db.execute("SELECT * FROM workflow_branches WHERE flow_id=? ORDER BY rowid", (flow_id,)).fetchall()
            assessment = db.execute("SELECT assessment FROM workflow_selections WHERE flow_id=?", (flow_id,)).fetchone()
        branches = [{**self.get_job(b["job_id"]), "parent_job_id": b["parent_job_id"], "action": b["action"]} for b in branch_rows]
        call_id = decomposition["result"].get("provider_call_id")
        call = self.get_call(call_id) if call_id else None
        candidates = [a for job in ([continuation] if continuation else []) + branches
                      for a in job["result"]["assets"] if a["kind"] in {"composed_candidate", "transparent_png"}]
        candidate_ids = {a["asset_id"] for a in candidates}
        if candidate_ids:
            with self.connection() as db:
                placeholders = ",".join("?" for _ in candidate_ids)
                descendants = db.execute(f"""WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM assets WHERE id IN ({placeholders})
                    UNION SELECT r.child_id FROM asset_relations r JOIN descendants d ON r.parent_id=d.id
                ) SELECT a.metadata FROM assets a JOIN descendants d ON a.id=d.id""", tuple(candidate_ids)).fetchall()
            candidate_ids.update(a["asset_id"] for a in (json.loads(r[0]) for r in descendants)
                                 if a["kind"] in {"transparent_png", "composed_candidate", "working_copy", "cropped", "prepared", "enhanced"})
        return {"pipeline_id": row["id"], "kind": "ai_pipeline", "input_asset_id": row["input_id"],
            "state": state, "revision": row["revision"], "decomposition_job_id": decomposition["job_id"],
            "continuation_job_id": row["continuation_job_id"], "selected_layer_ids": json.loads(row["selected_layers"]),
            "decision": decision, "vector": configuration["vector"],
            "workflow": configuration.get("workflow"),
            "selection": json.loads(assessment[0]) if assessment else None,
            "branches": branches,
            "recovery": {"can_compose": decomposition["state"] == "succeeded",
                         "vector_input_asset_ids": sorted(candidate_ids),
                         "needs_reconcile": bool(call and call["state"] in {"running", "outcome_unknown", "output_invalid"}),
                         "provider_call_id": call_id, "automatic_provider_retry": False},
            "result": {"assets": continuation["result"]["assets"] if continuation else [], "steps": steps},
            "error": active["error"], "created_at": row["created_at"], "updated_at": max(row["updated_at"], active["updated_at"])}

    def submit_workflow_branch(self, flow_id, values, key, kind, input_id, parameters):
        """CAS and idempotency cover both the queued job and its lineage."""
        scope = "rerun/" + flow_id
        request_hash = digest(canonical_json(values).encode())
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._existing(db, scope, key, request_hash)
            if not existing:
                row = db.execute("SELECT * FROM ai_flows WHERE id=?", (flow_id,)).fetchone()
                if row is None or row["revision"] != values["revision"]:
                    raise ServiceError("STALE_REVISION", "Reload the workflow before creating a local branch", 409)
                parent = row["continuation_job_id"] or row["decomposition_job_id"]
                if values["action"] == "vectorize":
                    asset = db.execute("SELECT metadata FROM assets WHERE id=?", (input_id,)).fetchone()
                    if asset:
                        parent = json.loads(asset[0]).get("generated_by_job_id") or parent
                job_id = self._enqueue(db, kind, input_id, parameters)
                db.execute("INSERT INTO workflow_branches VALUES (?,?,?,?)", (job_id, flow_id, parent, values["action"]))
                db.execute("UPDATE ai_flows SET revision=revision+1,updated_at=? WHERE id=?", (now(), flow_id))
                db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", (scope, key, request_hash, job_id))
            db.commit()
        return self.get_job(existing or job_id)

    def continue_ai_flow(self, flow_id, values, key, *, kind=None, parameters=None, actor="human"):
        scope = "continue/" + flow_id
        request_hash = digest(canonical_json(values).encode())
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._existing(db, scope, key, request_hash)
            if not existing:
                row = db.execute("SELECT * FROM ai_flows WHERE id=?", (flow_id,)).fetchone()
                if row is None:
                    raise ServiceError("AI_PIPELINE_NOT_FOUND", "AI confirmation workflow not found", 404)
                if row["revision"] != values["revision"] or row["state"] != "decomposing":
                    raise ServiceError("STALE_REVISION", "This workflow already has a decision; reload its current version", 409)
                job_id = self._enqueue(db, kind, row["input_id"], {**parameters, "ai_pipeline_id": flow_id}) if kind else None
                decision = {"action": values["action"], "revision": values["revision"], "actor": actor,
                            "layer_ids": values["layer_ids"], "decided_at": now()}
                db.execute("""UPDATE ai_flows SET revision=revision+1,continuation_job_id=?,state=?,
                    selected_layers=?,decision_json=?,updated_at=? WHERE id=?""",
                    (job_id, "continuing" if kind else "rejected", canonical_json(values["layer_ids"]),
                     canonical_json(decision), now(), flow_id))
                db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", (scope, key, request_hash, flow_id))
            db.commit()
        return self.get_ai_flow(flow_id)

    def record_provider_result(self, job_id, token, call, *, step_name=None):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            job = self._leased(db, job_id, token)
            name = step_name or ("repair-candidate" if job["kind"] == "repair" else "decompose-layers")
            assets = []
            for layer in call.get("result", {}).get("outputs", []):
                assets.append(layer["asset"])
                if layer.get("placed_asset"):
                    assets.append(layer["placed_asset"])
            result = {"assets": assets, "steps": [{"name": name, "state": "succeeded" if call["state"] == "succeeded" else "failed"}],
                      "provider_call_id": call["call_id"]}
            db.execute("UPDATE local_jobs SET result_json=?,updated_at=? WHERE id=?", (canonical_json(result), now(), job_id))
            db.commit()

    def get_repair_decision(self, job_id):
        with self.connection() as db:
            row = db.execute("SELECT decision_json FROM repair_decisions WHERE job_id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def decide_repair(self, job_id, values, key, accepted_output=None):
        """One immutable accepted branch and one decision, even under concurrent clicks."""
        scope = "repair-decision/" + job_id
        request_hash = digest(canonical_json(values).encode())
        existing = self.existing(scope, key, request_hash)
        if existing:
            return self.get_repair_decision(job_id)
        decision = {**values, "repair_job_id": job_id, "revision": 2, "decided_at": now(),
                    "accepted_asset_id": None}
        if accepted_output:
            decision["accepted_asset_id"] = accepted_output["metadata"]["asset_id"]
            accepted_output["metadata"]["repair_decision"] = dict(decision)
        staged = self._stage([accepted_output]) if accepted_output else []
        try:
            with self.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = self._existing(db, scope, key, request_hash)
                if not existing:
                    job = db.execute("SELECT kind,state FROM local_jobs WHERE id=?", (job_id,)).fetchone()
                    if not job or job["kind"] != "repair" or job["state"] != "succeeded":
                        raise ServiceError("REPAIR_NOT_READY", "Wait for a completed repair before deciding", 409)
                    if values["revision"] != 1 or db.execute("SELECT 1 FROM repair_decisions WHERE job_id=?", (job_id,)).fetchone():
                        raise ServiceError("STALE_REVISION", "This repair already has a decision; reload it", 409)
                    self._register(db, staged)
                    db.execute("INSERT INTO repair_decisions VALUES (?,?,?)", (job_id, canonical_json(decision), decision["decided_at"]))
                    db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", (scope, key, request_hash, job_id))
                db.commit()
        except BaseException:
            self._discard(staged)
            raise
        if existing:
            self._discard(staged)
        return self.get_repair_decision(job_id)

    def get_job(self, job_id):
        with self.connection() as db:
            row = db.execute("""SELECT j.*, b.flow_id AS branch_flow_id, b.parent_job_id AS branch_parent_job_id,
                b.action AS branch_action FROM local_jobs j LEFT JOIN workflow_branches b ON j.id=b.job_id WHERE j.id=?""", (job_id,)).fetchone()
        if row is None:
            raise ServiceError("JOB_NOT_FOUND", "Local job not found", 404)
        return self._job(row)

    def cancel_job(self, job_id):
        """Atomically stop a queued/running local task before any later publication."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM local_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise ServiceError("JOB_NOT_FOUND", "Local job not found", 404)
            if row["state"] in TERMINAL:
                db.commit()
                return self._job(row)
            parameters = json.loads(row["parameters"])
            can_call_provider = row["kind"] in EXTERNAL_CALL_JOBS or (
                row["kind"] == "repair" and not parameters.get("provider_call_id")
            )
            if can_call_provider:
                raise ServiceError("CANCEL_REQUIRES_RECONCILIATION",
                    "This task may have an external call in progress. Reconcile its provider status; cancellation is unavailable.", 409)
            result = json.loads(row["result_json"])
            for step in result["steps"]:
                if step["state"] == "running":
                    step["state"] = "cancelled"
            error = {"code": "JOB_CANCELLED", "message": "Task cancelled; completed earlier steps and their versions are retained."}
            timestamp = now()
            db.execute("""UPDATE local_jobs SET state='cancelled',error_json=?,result_json=?,finished_at=?,updated_at=?,
                lease_token=NULL,lease_until=NULL WHERE id=? AND state IN ('queued','running')""",
                (canonical_json(error), canonical_json(result), timestamp, timestamp, job_id))
            db.commit()
        return self.get_job(job_id)

    def page(self, table, limit, cursor):
        if table not in {"images", "local_jobs"}:
            raise ValueError("Unsupported history table")
        with self.connection() as db:
            rows = db.execute(f"SELECT rowid AS sequence,* FROM {table} WHERE rowid<? ORDER BY rowid DESC LIMIT ?",
                              (page_offset(cursor), limit + 1)).fetchall()
        selected = rows[:limit]
        return {"items": [self.get_image(r["id"]) if table == "images" else self.get_job(r["id"]) for r in selected],
                "next_cursor": str(selected[-1]["sequence"]) if len(rows) > limit else None}

    def page_assets(self, limit, cursor, query, kinds):
        offset = page_offset(cursor)
        search = ""
        values = [offset]
        if query or kinds:
            conditions = []
            if query:
                conditions.append("""instr(lower(id || ' ' || coalesce(metadata->>'kind', '') || ' ' ||
                    coalesce(metadata->>'filename', '') || ' ' || coalesce(metadata->>'source_name', '') || ' ' ||
                    coalesce(metadata->>'grade', '')), lower(?)) > 0""")
                values.append(query)
            if kinds:
                placeholders = ",".join("?" for _ in kinds)
                conditions.append(f"metadata->>'kind' IN ({placeholders})")
                values.extend(kinds)
            search = " AND (" + " OR ".join(conditions) + ")"
        with self.connection() as db:
            rows = db.execute(f"SELECT rowid,metadata FROM assets WHERE rowid<?{search} ORDER BY rowid DESC LIMIT ?",
                              (*values, limit + 1)).fetchall()
        return {"items": [json.loads(row["metadata"]) for row in rows[:limit]],
                "next_cursor": str(rows[limit - 1]["rowid"]) if len(rows) > limit else None}

    def set_tile_observation(self, asset_id, observation, revision):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT metadata FROM assets WHERE id=?", (asset_id,)).fetchone()
            if row is None:
                raise ServiceError("ASSET_NOT_FOUND", "Registered asset not found", 404)
            asset = json.loads(row["metadata"])
            if asset["kind"] != "tile_preview":
                raise ServiceError("TILE_PREVIEW_REQUIRED", "Select a saved tile preview", 422)
            current_revision = asset.get("seam_observation_revision", 0)
            if asset.get("seam_observation") == observation:
                return asset
            if revision != current_revision:
                raise ServiceError("STALE_SEAM_OBSERVATION", "Reload the tile preview before updating its seam observation", 409)
            job_id = asset.get("generated_by_job_id")
            job = db.execute("SELECT state,result_json FROM local_jobs WHERE id=? AND kind='tile-preview'", (job_id,)).fetchone()
            if job is None or job["state"] != "succeeded":
                raise ServiceError("TILE_PREVIEW_NOT_READY", "Wait for the saved tile preview before recording an observation", 409)
            result = json.loads(job["result_json"])
            asset.update(seam_observation=observation, seam_observation_revision=current_revision + 1,
                         seam_observation_source="not_reviewed" if observation == "not_reviewed" else "human")
            result["assets"] = [asset if item["asset_id"] == asset_id else item for item in result["assets"]]
            db.execute("UPDATE assets SET metadata=? WHERE id=?", (canonical_json(asset), asset_id))
            db.execute("UPDATE local_jobs SET result_json=?,updated_at=? WHERE id=?", (canonical_json(result), now(), job_id))
            db.commit()
        return asset

    def submit(self, kind, input_id, parameters, key, *, retry_of=None):
        scope = "jobs/" + kind if retry_of is None else "retry/" + retry_of
        request_hash = digest(canonical_json({"input": input_id, "parameters": parameters, "retry_of": retry_of}).encode())
        job_id, timestamp = str(uuid4()), now()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._existing(db, scope, key, request_hash)
            if not existing:
                if db.execute("SELECT count(*) FROM local_jobs WHERE state IN ('queued','running')").fetchone()[0] >= 20:
                    raise ServiceError("QUEUE_FULL", "Wait for a local task to finish before adding more", 429)
                db.execute("""INSERT INTO local_jobs
                    (id,kind,input_id,parameters,state,created_at,updated_at,retry_of,result_json)
                    VALUES (?,?,?,?,'queued',?,?,?,?)""",
                    (job_id, kind, input_id, canonical_json(parameters), timestamp, timestamp, retry_of,
                     canonical_json({"assets": [], "steps": []})))
                if kind == "pipeline":
                    db.execute("INSERT INTO local_pipelines VALUES (?,?)", (job_id, canonical_json(parameters)))
                if retry_of:
                    owner = db.execute("""SELECT flow_id FROM workflow_branches WHERE job_id=?
                        UNION SELECT id FROM ai_flows WHERE continuation_job_id=? LIMIT 1""", (retry_of, retry_of)).fetchone()
                    if owner:
                        db.execute("INSERT INTO workflow_branches VALUES (?,?,?,'retry')", (job_id, owner[0], retry_of))
                        db.execute("UPDATE ai_flows SET revision=revision+1,updated_at=? WHERE id=?", (now(), owner[0]))
                db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", (scope, key, request_hash, job_id))
            db.commit()
        return self.get_job(existing or job_id)

    def recover_jobs(self):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id,result_json FROM local_jobs WHERE state='running'").fetchall()
            for row in rows:
                result = json.loads(row["result_json"])
                call = db.execute("SELECT id FROM provider_calls WHERE idempotency_key=?", ("ai-" + row["id"],)).fetchone()
                if call:
                    result["provider_call_id"] = call["id"]
                for step in result["steps"]:
                    if step["state"] == "running":
                        step["state"] = "failed"
                db.execute("""UPDATE local_jobs SET state='failed',error_json=?,result_json=?,updated_at=?,finished_at=?,
                    lease_token=NULL,lease_until=NULL WHERE id=? AND state='running'""",
                    (canonical_json({"code": "PROCESS_INTERRUPTED", "message": "Local processing was interrupted; retry explicitly to create a new version"}),
                     canonical_json(result), now(), now(), row["id"]))
            db.commit()
            return len(rows)

    def interrupt_provider_job(self, job_id, token):
        """Reconcile only this child's call after its process has been stopped."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._leased(db, job_id, token)
            db.execute("UPDATE provider_calls SET state='outcome_unknown',result_json=?,updated_at=? WHERE idempotency_key=? AND state='running'",
                (canonical_json({"error_code": "PROCESS_INTERRUPTED", "needs_reconcile": True, "automatic_retry": False}), now(), "ai-" + job_id))
            call = db.execute("SELECT * FROM provider_calls WHERE idempotency_key=?", ("ai-" + job_id,)).fetchone()
            db.commit()
        if call:
            self.record_provider_result(job_id, token, self.public_call(call))

    def claim(self):
        token = str(uuid4())
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM local_jobs WHERE state='queued' ORDER BY rowid LIMIT 1").fetchone()
            if row is None:
                db.rollback()
                return None
            db.execute("""UPDATE local_jobs SET state='running',lease_token=?,lease_until=?,attempt=attempt+1,
                          started_at=?,updated_at=? WHERE id=? AND state='queued'""",
                       (token, time.time() + 15, now(), now(), row["id"]))
            db.commit()
        return self.get_job(row["id"]), token

    def heartbeat(self, job_id, token):
        with self.connection() as db:
            return db.execute("UPDATE local_jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?",
                              (time.time() + 15, now(), job_id, token)).rowcount == 1

    @staticmethod
    def _leased(db, job_id, token):
        row = db.execute("SELECT * FROM local_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
                         (job_id, token, time.time())).fetchone()
        if row is None:
            raise ServiceError("STALE_WORKER", "This worker no longer owns the local task", 409)
        return row

    def step(self, job_id, token, name, state):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._leased(db, job_id, token)
            result = json.loads(row["result_json"])
            result["steps"] = [s for s in result["steps"] if s["name"] != name] + [{"name": name, "state": state}]
            db.execute("UPDATE local_jobs SET result_json=?,updated_at=? WHERE id=?", (canonical_json(result), now(), job_id))
            db.commit()

    def publish(self, job_id, token, name, outputs):
        staged = self._stage(outputs)
        try:
            with self.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self._leased(db, job_id, token)
                result = json.loads(row["result_json"])
                self._register(db, staged)
                result["assets"].extend(record for record, _, _, _ in staged)
                result["steps"] = [s for s in result["steps"] if s["name"] != name] + [{"name": name, "state": "succeeded"}]
                db.execute("UPDATE local_jobs SET result_json=?,updated_at=? WHERE id=?", (canonical_json(result), now(), job_id))
                db.commit()
        except BaseException:
            self._discard(staged)
            raise
        return [record for record, _, _, _ in staged]

    def finish_job(self, job_id, token, error=None):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._leased(db, job_id, token)
            result = json.loads(row["result_json"])
            if error:
                for step in result["steps"]:
                    if step["state"] == "running":
                        step["state"] = "failed"
            db.execute("""UPDATE local_jobs SET state=?,error_json=?,result_json=?,finished_at=?,updated_at=?,
                lease_token=NULL,lease_until=NULL WHERE id=?""",
                ("failed" if error else "succeeded", canonical_json(error) if error else None,
                 canonical_json(result), now(), now(), job_id))
            db.commit()

    def add_feedback(self, payload, key):
        job = self.get_job(payload["job_id"])
        if job["state"] not in TERMINAL:
            raise ServiceError("JOB_NOT_FINISHED", "Wait for the local job before reviewing it", 409)
        request_hash = digest(canonical_json(payload).encode())
        identifier, timestamp = str(uuid4()), now()
        data = {**payload, "feedback_id": identifier, "consent_version": "local-s1-v1", "created_at": timestamp}
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._existing(db, "feedback", key, request_hash)
            if existing:
                data = json.loads(db.execute("SELECT data FROM feedback WHERE id=?", (existing,)).fetchone()[0])
            else:
                db.execute("INSERT INTO feedback VALUES (?,?,?,?)", (identifier, payload["job_id"], canonical_json(data), timestamp))
                db.execute("INSERT INTO consents VALUES (?,?,?,?,?,?)", (str(uuid4()), identifier, "local-s1-v1", int(payload["allow_training"]), int(payload["allow_display"]), timestamp))
                db.execute("INSERT INTO local_keys VALUES (?,?,?,?)", ("feedback", key, request_hash, identifier))
            db.commit()
        return data
