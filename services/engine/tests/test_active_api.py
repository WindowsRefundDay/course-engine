from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from course_engine.api import app, _set_db
from course_engine.db import Database


def _artifact() -> dict:
    return {
        "schemaVersion": 2,
        "title": "Active Course",
        "code": "ACTIVE-101",
        "term": "Fall 2024",
        "description": "Test",
        "units": [
            {
                "id": "u1",
                "title": "Unit 1",
                "lessons": [
                    {
                        "id": "l1",
                        "title": "Lesson 1",
                        "unitTitle": "Unit 1",
                        "sections": [
                            {
                                "id": "s1",
                                "title": "Overview",
                                "kind": "overview",
                                "slides": [
                                    {
                                        "id": "slide-1",
                                        "title": "Welcome",
                                        "type": "article",
                                        "blocks": [{"type": "paragraph", "text": "Hello"}],
                                        "sourceRefs": [],
                                        "required": True,
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    }


def _activate(db: Database, title: str = "Active Course") -> dict:
    course = db.create_course(title=title, source="/tmp/source", adapter_name="directory-archive", manifest={"schemaVersion": 2})
    job = db.create_import(course_id=course["id"], source="/tmp/source", adapter_name="directory-archive")
    artifact = _artifact()
    artifact["title"] = title
    db.record_stage(job["id"], stage="inventory", progress=15, output={})
    db.record_stage(job["id"], stage="extract", progress=30, output={})
    db.record_stage(job["id"], stage="normalize", progress=50, output={})
    db.record_stage(job["id"], stage="enrich", progress=65, output={})
    validation = {"valid": True, "blocking_issues": [], "warnings": [], "checks": []}
    db.record_stage(job["id"], stage="validate", progress=80, output=validation)
    draft = db.create_compilation_draft(job["id"], artifact=artifact, validation=validation)
    return db.activate_compilation_draft(draft["id"], reviewed_hash=draft["artifact_hash"])


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    db = Database(tmp_path / "test.sqlite3")
    db.migrate()
    _set_db(db)
    active = _activate(db)
    TestClient.course_id = active["course_id"]  # type: ignore[attr-defined]
    return TestClient(app)


def test_active_endpoint_returns_activated_artifact(client: TestClient) -> None:
    active = client.get("/active")
    assert active.status_code == 200
    data = active.json()
    assert data["artifact"]["title"] == "Active Course"
    assert data["artifact"]["schemaVersion"] == 2


def test_courses_active_endpoint_returns_specific_active_artifact(client: TestClient) -> None:
    course_id = TestClient.course_id  # type: ignore[attr-defined]
    active = client.get(f"/courses/{course_id}/active")
    assert active.status_code == 200
    data = active.json()
    assert data["artifact"]["title"] == "Active Course"


def test_bootstrap_status_reflects_active_course(client: TestClient) -> None:
    status = client.get("/bootstrap/status")
    assert status.status_code == 200
    data = status.json()
    assert data["ready"] is True
    assert data["title"] == "Active Course"


def test_active_endpoint_returns_404_when_no_active_course(tmp_path: Path) -> None:
    db = Database(tmp_path / "empty.sqlite3")
    db.migrate()
    _set_db(db)
    with TestClient(app) as client:
        response = client.get("/active")
        assert response.status_code == 404


def test_activation_promotes_exact_reviewed_artifact(tmp_path: Path) -> None:
    db = Database(tmp_path / "test.sqlite3")
    db.migrate()
    active = _activate(db)
    assert active["artifact"]["title"] == "Active Course"
    initial_version = active["version"]
    assert initial_version >= 1

    # Activating a different version should advance the live pointer.
    course = db.get_course(active["course_id"])
    assert course
    job2 = db.create_import(course_id=course["id"], source="/tmp/source", adapter_name="directory-archive")
    artifact2 = _artifact()
    artifact2["title"] = "Active Course Updated"
    db.record_stage(job2["id"], stage="inventory", progress=15, output={})
    db.record_stage(job2["id"], stage="extract", progress=30, output={})
    db.record_stage(job2["id"], stage="normalize", progress=50, output={})
    db.record_stage(job2["id"], stage="enrich", progress=65, output={})
    validation = {"valid": True, "blocking_issues": [], "warnings": [], "checks": []}
    db.record_stage(job2["id"], stage="validate", progress=80, output=validation)
    draft2 = db.create_compilation_draft(job2["id"], artifact=artifact2, validation=validation)
    active2 = db.activate_compilation_draft(draft2["id"], reviewed_hash=draft2["artifact_hash"])
    assert active2["version"] > initial_version
    assert active2["artifact"]["title"] == "Active Course Updated"
