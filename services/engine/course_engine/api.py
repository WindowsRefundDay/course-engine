from __future__ import annotations

import hmac
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .adapters import adapter_for
from .config import admin_token, database_path, mineru_api_url
from .db import Database
from .mineru import MinerUClient


db = Database(database_path())


def _set_db(instance: Database) -> None:
    """Test-only hook to replace the global database instance."""
    global db
    db = instance


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.migrate()
    yield


app = FastAPI(title="Course Engine", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3003", "http://127.0.0.1:3003"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "authorization"],
)


class ImportRequest(BaseModel):
    course_id: str
    source: str = Field(min_length=1)


class PublishRequest(BaseModel):
    reviewed_hash: str = Field(min_length=64, max_length=64)


class RollbackRequest(BaseModel):
    version: int = Field(ge=1)


def require_admin(authorization: str | None = Header(default=None)) -> None:
    """Require a bearer token when the engine is configured beyond local trust."""
    expected = admin_token()
    if expected is None:
        return
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, "Admin authorization required")


@app.get("/health")
def health() -> dict[str, object]:
    db.migrate()
    mineru = MinerUClient(mineru_api_url()).health()
    return {"status": "ok", "database": str(db.path), "mineru": mineru.__dict__}


@app.get("/imports")
def list_imports(course_id: str | None = Query(default=None)) -> list[dict[str, object]]:
    db.migrate()
    return db.list_imports(course_id)  # type: ignore[return-value]


@app.get("/imports/{job_id}")
def get_import(job_id: str) -> dict[str, object]:
    db.migrate()
    job = db.get_import(job_id)
    if not job:
        raise HTTPException(404, "Import job not found")
    return job


@app.post("/imports", status_code=201)
def queue_import(request: ImportRequest) -> dict[str, object]:
    db.migrate()
    course = db.get_course(request.course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    try:
        adapter = adapter_for(request.source)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return db.create_import(course_id=request.course_id, source=request.source, adapter_name=adapter.name)


@app.get("/courses/{course_id}/drafts")
def list_drafts(course_id: str) -> list[dict[str, object]]:
    db.migrate()
    if not db.get_course(course_id):
        raise HTTPException(404, "Course not found")
    return db.list_compilation_drafts(course_id)  # type: ignore[return-value]


@app.get("/drafts/{draft_id}")
def get_draft(draft_id: str) -> dict[str, object]:
    db.migrate()
    draft = db.get_compilation_draft(draft_id)
    if not draft:
        raise HTTPException(404, "Compilation draft not found")
    return draft


@app.post("/drafts/{draft_id}/publish", dependencies=[Depends(require_admin)])
def publish_draft(draft_id: str, request: PublishRequest) -> dict[str, object]:
    db.migrate()
    try:
        return db.publish_compilation_draft(draft_id, reviewed_hash=request.reviewed_hash)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.post("/drafts/{draft_id}/activate")
def activate_draft(draft_id: str, request: PublishRequest) -> dict[str, object]:
    """Learner-facing activation of a validated, reviewed draft."""
    db.migrate()
    try:
        return db.activate_compilation_draft(draft_id, reviewed_hash=request.reviewed_hash)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.get("/courses/{course_id}/published")
def get_published(course_id: str) -> dict[str, object]:
    db.migrate()
    published = db.get_published_course(course_id)
    if not published:
        raise HTTPException(404, "Published course not found")
    return published


@app.get("/courses/{course_id}/active")
def get_active(course_id: str) -> dict[str, object]:
    """Return the activated course artifact for the learner app."""
    db.migrate()
    active = db.get_active_course(course_id)
    if not active:
        raise HTTPException(404, "No active course")
    return active


@app.get("/published/latest")
def get_latest_published() -> dict[str, object]:
    db.migrate()
    published = db.get_latest_published_course()
    if not published:
        raise HTTPException(404, "Published course not found")
    return published


@app.get("/active")
def get_latest_active() -> dict[str, object]:
    """Return the most recently activated course and its artifact."""
    db.migrate()
    active = db.get_latest_active_course()
    if not active:
        raise HTTPException(404, "No active course")
    return active


@app.get("/courses/active")
def list_active_courses() -> list[dict[str, object]]:
    """List all activated courses for local learner selection."""
    db.migrate()
    return db.list_active_courses()


@app.get("/courses/{course_id}/versions")
def list_versions(course_id: str) -> list[dict[str, object]]:
    db.migrate()
    if not db.get_course(course_id):
        raise HTTPException(404, "Course not found")
    return db.list_course_versions(course_id)  # type: ignore[return-value]


@app.post("/courses/{course_id}/rollback", dependencies=[Depends(require_admin)])
def rollback_course(course_id: str, request: RollbackRequest) -> dict[str, object]:
    db.migrate()
    try:
        return db.rollback_course(course_id, version=request.version)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.get("/bootstrap/status")
def bootstrap_status() -> dict[str, object]:
    """Expose the current one-command bootstrap state to the learner shell."""
    db.migrate()
    active = db.get_latest_active_course()
    artifact = active.get("artifact") if active else None
    return {
        "ready": active is not None,
        "course_id": active.get("course_id") if active else None,
        "version": active.get("version") if active else None,
        "title": artifact.get("title") if isinstance(artifact, dict) else None,
    }
