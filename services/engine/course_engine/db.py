from __future__ import annotations

import json
import hashlib
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS course_versions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(course_id, version)
);
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  source TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  detail_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS import_jobs_course_created ON import_jobs(course_id, created_at DESC);
CREATE TABLE IF NOT EXISTS compilation_drafts (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  import_job_id TEXT REFERENCES import_jobs(id),
  artifact_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','rejected')),
  published_version_id TEXT REFERENCES course_versions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compilation_drafts_course_created ON compilation_drafts(course_id, created_at DESC);
CREATE TABLE IF NOT EXISTS course_publications (
  course_id TEXT PRIMARY KEY REFERENCES courses(id),
  course_version_id TEXT NOT NULL REFERENCES course_versions(id),
  updated_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def migrate(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            # Databases created before publication pointers existed still need
            # a live revision. Backfill each one to its latest stored version.
            conn.execute(
                """
                INSERT INTO course_publications (course_id, course_version_id, updated_at)
                SELECT c.id, v.id, v.created_at
                FROM courses c
                JOIN course_versions v ON v.course_id = c.id
                WHERE v.version = (
                  SELECT MAX(latest.version) FROM course_versions latest
                  WHERE latest.course_id = c.id
                )
                AND json_extract(v.manifest_json, '$.schemaVersion') = 2
                AND NOT EXISTS (
                  SELECT 1 FROM course_publications p WHERE p.course_id = c.id
                )
                """
            )

    def create_course(self, *, title: str, source: str, adapter_name: str, manifest: dict[str, Any]) -> dict[str, Any]:
        course_id = str(uuid.uuid4())
        version_id = str(uuid.uuid4())
        created_at = now()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO courses VALUES (?, ?, ?, ?, ?)",
                (course_id, title, source, adapter_name, created_at),
            )
            conn.execute(
                "INSERT INTO course_versions VALUES (?, ?, 1, ?, ?)",
                (version_id, course_id, json.dumps(manifest, sort_keys=True), created_at),
            )
        return {"id": course_id, "title": title, "source": source, "adapter_name": adapter_name}

    def get_course(self, course_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
        return dict(row) if row else None

    def create_import(self, *, course_id: str, source: str, adapter_name: str) -> dict[str, Any]:
        job_id, created_at = str(uuid.uuid4()), now()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO import_jobs (id, course_id, source, adapter_name, status, stage, progress, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'inventory', 0, ?, ?)",
                (job_id, course_id, source, adapter_name, created_at, created_at),
            )
        return self.get_import(job_id)  # type: ignore[return-value]

    def claim_import(self, job_id: str) -> dict[str, Any] | None:
        """Atomically move a queued job into the running state.

        Returning ``None`` means another worker already owns the job or it is
        no longer queued.  SQLite's write lock makes this safe for multiple
        local worker processes.
        """
        updated_at = now()
        with self.connect() as conn:
            result = conn.execute(
                """
                UPDATE import_jobs
                SET status = 'running', stage = 'inventory', progress = 0,
                    error = NULL, updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (updated_at, job_id),
            )
        if result.rowcount != 1:
            return None
        return self.get_import(job_id)

    def claim_next_import(self) -> dict[str, Any] | None:
        """Claim the oldest queued import, if one exists."""
        updated_at = now()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id FROM import_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            if not row:
                return None
            result = conn.execute(
                """
                UPDATE import_jobs
                SET status = 'running', stage = 'inventory', progress = 0,
                    error = NULL, updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (updated_at, row["id"]),
            )
            if result.rowcount != 1:
                return None
        return self.get_import(row["id"])

    def record_stage(
        self,
        job_id: str,
        *,
        stage: str,
        progress: int,
        output: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist a completed stage and its JSON-safe output in one update."""
        with self.connect() as conn:
            row = conn.execute("SELECT detail_json FROM import_jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise KeyError(f"Import job not found: {job_id}")
            detail = json.loads(row["detail_json"])
            stages = detail.setdefault("stages", {})
            stages[stage] = {"status": "completed", "output": output or {}}
            conn.execute(
                """
                UPDATE import_jobs
                SET status = 'running', stage = ?, progress = ?,
                    detail_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (stage, progress, json.dumps(detail, sort_keys=True), now(), job_id),
            )
        return self.get_import(job_id)  # type: ignore[return-value]

    def fail_import(self, job_id: str, *, stage: str, error: str) -> dict[str, Any]:
        """Record a terminal failure while retaining prior stage evidence."""
        with self.connect() as conn:
            row = conn.execute("SELECT detail_json FROM import_jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise KeyError(f"Import job not found: {job_id}")
            detail = json.loads(row["detail_json"])
            stages = detail.setdefault("stages", {})
            stages[stage] = {"status": "failed", "error": error}
            conn.execute(
                """
                UPDATE import_jobs
                SET status = 'failed', stage = ?, error = ?, detail_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (stage, error, json.dumps(detail, sort_keys=True), now(), job_id),
            )
        return self.get_import(job_id)  # type: ignore[return-value]

    def publish_import(self, job_id: str, *, manifest: dict[str, Any]) -> dict[str, Any]:
        """Removed publication bypass retained only to fail old callers safely."""
        del job_id, manifest
        raise ValueError("Direct import publication is disabled; create and review a compilation draft")

    def get_import(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM import_jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def list_imports(self, course_id: str | None = None) -> list[dict[str, Any]]:
        query, params = "SELECT * FROM import_jobs", []
        if course_id:
            query += " WHERE course_id = ?"
            params.append(course_id)
        query += " ORDER BY created_at DESC"
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._job(row) for row in rows]

    def list_course_versions(self, course_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM course_versions WHERE course_id = ? ORDER BY version ASC", (course_id,)
            ).fetchall()
        versions = []
        for row in rows:
            data = dict(row)
            data["manifest"] = json.loads(data.pop("manifest_json"))
            versions.append(data)
        return versions

    def create_compilation_draft(
        self,
        job_id: str,
        *,
        artifact: dict[str, Any],
        validation: dict[str, Any],
    ) -> dict[str, Any]:
        """Finish a compilation job as a reviewable draft without publishing."""
        encoded = json.dumps(artifact, sort_keys=True, separators=(",", ":"))
        reviewed_bundle = json.dumps(
            {"artifact": artifact, "validation": validation},
            sort_keys=True,
            separators=(",", ":"),
        )
        artifact_hash = hashlib.sha256(reviewed_bundle.encode("utf-8")).hexdigest()
        draft_id, created_at = str(uuid.uuid4()), now()
        with self.connect() as conn:
            job = conn.execute("SELECT * FROM import_jobs WHERE id = ?", (job_id,)).fetchone()
            if not job:
                raise KeyError(f"Import job not found: {job_id}")
            if job["status"] != "running":
                raise ValueError(f"Only running jobs can create drafts (current status: {job['status']})")
            if not validation.get("valid", False):
                raise ValueError("Invalid compilation cannot become a draft")
            conn.execute(
                "UPDATE compilation_drafts SET status = 'rejected', updated_at = ? WHERE course_id = ? AND status = 'draft'",
                (created_at, job["course_id"]),
            )
            conn.execute(
                """
                INSERT INTO compilation_drafts
                  (id, course_id, import_job_id, artifact_json, artifact_hash, validation_json,
                   status, published_version_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
                """,
                (draft_id, job["course_id"], job_id, encoded, artifact_hash, json.dumps(validation, sort_keys=True), created_at, created_at),
            )
            detail = json.loads(job["detail_json"])
            detail.setdefault("stages", {})["preview"] = {
                "status": "completed",
                "output": {"draft_id": draft_id, "artifact_hash": artifact_hash},
            }
            conn.execute(
                """
                UPDATE import_jobs SET status = 'completed', stage = 'preview', progress = 100,
                  detail_json = ?, error = NULL, updated_at = ? WHERE id = ?
                """,
                (json.dumps(detail, sort_keys=True), created_at, job_id),
            )
        return self.get_compilation_draft(draft_id)  # type: ignore[return-value]

    def get_compilation_draft(self, draft_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM compilation_drafts WHERE id = ?", (draft_id,)).fetchone()
        return self._draft(row) if row else None

    def list_compilation_drafts(self, course_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM compilation_drafts WHERE course_id = ? ORDER BY created_at DESC",
                (course_id,),
            ).fetchall()
        return [self._draft(row) for row in rows]

    def publish_compilation_draft(self, draft_id: str, *, reviewed_hash: str) -> dict[str, Any]:
        """Atomically promote exactly the artifact the caller reviewed."""
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            draft = conn.execute("SELECT * FROM compilation_drafts WHERE id = ?", (draft_id,)).fetchone()
            if not draft:
                raise KeyError(f"Compilation draft not found: {draft_id}")
            if draft["status"] != "draft":
                raise ValueError(f"Only draft compilations can publish (current status: {draft['status']})")
            if draft["artifact_hash"] != reviewed_hash:
                raise ValueError("Reviewed artifact hash does not match the draft")
            validation = json.loads(draft["validation_json"])
            if not validation.get("valid", False):
                raise ValueError("Draft validation is not passing")
            version = conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM course_versions WHERE course_id = ?",
                (draft["course_id"],),
            ).fetchone()["next_version"]
            version_id, published_at = str(uuid.uuid4()), now()
            conn.execute(
                "INSERT INTO course_versions VALUES (?, ?, ?, ?, ?)",
                (version_id, draft["course_id"], version, draft["artifact_json"], published_at),
            )
            conn.execute(
                """
                INSERT INTO course_publications VALUES (?, ?, ?)
                ON CONFLICT(course_id) DO UPDATE SET course_version_id = excluded.course_version_id, updated_at = excluded.updated_at
                """,
                (draft["course_id"], version_id, published_at),
            )
            conn.execute(
                "UPDATE compilation_drafts SET status = 'published', published_version_id = ?, updated_at = ? WHERE id = ?",
                (version_id, published_at, draft_id),
            )
        return self.get_published_course(draft["course_id"])  # type: ignore[return-value]

    def get_published_course(self, course_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT v.* FROM course_publications p
                JOIN course_versions v ON v.id = p.course_version_id
                WHERE p.course_id = ?
                """,
                (course_id,),
            ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["artifact"] = json.loads(data.pop("manifest_json"))
        return data

    def get_active_course(self, course_id: str) -> dict[str, Any] | None:
        """Learner-facing alias for the currently published course version."""
        return self.get_published_course(course_id)

    def get_latest_published_course(self) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT v.* FROM course_publications p
                JOIN course_versions v ON v.id = p.course_version_id
                ORDER BY p.updated_at DESC LIMIT 1
                """
            ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["artifact"] = json.loads(data.pop("manifest_json"))
        return data

    def get_latest_active_course(self) -> dict[str, Any] | None:
        """Learner-facing alias for the most recently activated course."""
        return self.get_latest_published_course()

    def activate_compilation_draft(self, draft_id: str, *, reviewed_hash: str) -> dict[str, Any]:
        """Atomically activate exactly the reviewed artifact for local study."""
        return self.publish_compilation_draft(draft_id, reviewed_hash=reviewed_hash)

    def list_active_courses(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT c.id, c.title, c.source, c.adapter_name, v.id AS version_id, v.version, v.created_at
                FROM course_publications p
                JOIN courses c ON c.id = p.course_id
                JOIN course_versions v ON v.id = p.course_version_id
                ORDER BY p.updated_at DESC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def rollback_course(self, course_id: str, *, version: int) -> dict[str, Any]:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            target = conn.execute(
                "SELECT id, manifest_json FROM course_versions WHERE course_id = ? AND version = ?",
                (course_id, version),
            ).fetchone()
            if not target:
                raise KeyError(f"Course version not found: {version}")
            target_artifact = json.loads(target["manifest_json"])
            if target_artifact.get("schemaVersion") != 2:
                raise ValueError("Only reviewed schema-v2 course artifacts can become live")
            conn.execute(
                """
                INSERT INTO course_publications VALUES (?, ?, ?)
                ON CONFLICT(course_id) DO UPDATE SET course_version_id = excluded.course_version_id, updated_at = excluded.updated_at
                """,
                (course_id, target["id"], now()),
            )
        return self.get_published_course(course_id)  # type: ignore[return-value]

    @staticmethod
    def _draft(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["artifact"] = json.loads(data.pop("artifact_json"))
        data["validation"] = json.loads(data.pop("validation_json"))
        return data

    @staticmethod
    def _job(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["detail"] = json.loads(data.pop("detail_json"))
        return data
