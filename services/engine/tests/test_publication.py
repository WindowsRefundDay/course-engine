from pathlib import Path
from zipfile import ZipFile

import pytest

from course_engine.db import Database


def _draft(tmp_path: Path) -> tuple[Database, dict[str, object], dict[str, object]]:
    archive = tmp_path / "course.zip"
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("course/content_map.json", "{}")
    db = Database(tmp_path / "engine.sqlite3")
    db.migrate()
    course = db.create_course(title="Course", source=str(archive), adapter_name="zip-archive", manifest={"source": str(archive)})
    job = db.create_import(course_id=course["id"], source=str(archive), adapter_name="zip-archive")
    claimed = db.claim_import(job["id"])
    assert claimed is not None
    artifact = {
        "schemaVersion": 2,
        "title": "Course",
        "code": "COURSE",
        "term": "",
        "description": "Test artifact",
        "units": [{"id": "unit-1", "title": "Unit", "lessons": []}],
    }
    draft = db.create_compilation_draft(job["id"], artifact=artifact, validation={"valid": True, "blocking_issues": []})
    return db, course, draft


def test_reviewed_hash_is_required_for_atomic_publish(tmp_path: Path) -> None:
    db, course, draft = _draft(tmp_path)

    with pytest.raises(ValueError, match="hash"):
        db.publish_compilation_draft(draft["id"], reviewed_hash="0" * 64)

    assert db.get_published_course(course["id"]) is None
    published = db.publish_compilation_draft(draft["id"], reviewed_hash=draft["artifact_hash"])
    assert published["version"] == 2
    assert db.get_compilation_draft(draft["id"])["status"] == "published"


def test_rollback_changes_pointer_without_deleting_history(tmp_path: Path) -> None:
    db, course, draft = _draft(tmp_path)
    first = db.publish_compilation_draft(draft["id"], reviewed_hash=draft["artifact_hash"])
    job = db.create_import(course_id=course["id"], source=course["source"], adapter_name=course["adapter_name"])
    assert db.claim_import(job["id"])
    second_draft = db.create_compilation_draft(
        job["id"],
        artifact={**draft["artifact"], "description": "Second reviewed revision"},
        validation={"valid": True, "blocking_issues": []},
    )
    db.publish_compilation_draft(second_draft["id"], reviewed_hash=second_draft["artifact_hash"])

    rolled_back = db.rollback_course(course["id"], version=first["version"])

    assert rolled_back["version"] == 2
    assert [version["version"] for version in db.list_course_versions(course["id"])] == [1, 2, 3]


def test_migration_backfills_a_publication_pointer_for_legacy_courses(tmp_path: Path) -> None:
    db = Database(tmp_path / "legacy.sqlite3")
    db.migrate()
    course = db.create_course(
        title="Legacy Course",
        source=str(tmp_path),
        adapter_name="directory",
        manifest={"schemaVersion": 1},
    )
    job = db.create_import(course_id=course["id"], source=course["source"], adapter_name=course["adapter_name"])
    assert db.claim_import(job["id"])
    draft = db.create_compilation_draft(
        job["id"],
        artifact={"schemaVersion": 2, "title": "Legacy Course", "units": []},
        validation={"valid": True, "blocking_issues": []},
    )
    db.publish_compilation_draft(draft["id"], reviewed_hash=draft["artifact_hash"])
    with db.connect() as conn:
        conn.execute("DELETE FROM course_publications WHERE course_id = ?", (course["id"],))

    assert db.get_published_course(course["id"]) is None
    db.migrate()
    assert db.get_published_course(course["id"])["version"] == 2
