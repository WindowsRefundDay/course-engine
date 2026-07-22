import json
import sys
from pathlib import Path
from zipfile import ZipFile

from course_engine import cli
from course_engine.db import Database
from course_engine.pipeline import IMPORT_STAGES, ImportPipeline


def create_course(db: Database, source: Path) -> dict[str, object]:
    return db.create_course(
        title="Test Calculus",
        source=str(source),
        adapter_name="zip-archive" if source.suffix == ".zip" else "directory-archive",
        manifest={"source": str(source)},
    )


def test_unsupported_zip_cannot_create_an_empty_publishable_draft(tmp_path: Path) -> None:
    archive = tmp_path / "test-calculus.zip"
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("test-calculus/content_map.json", "{}")
        bundle.writestr("test-calculus/pages/index.html", "<main>Course</main>")

    db = Database(tmp_path / "engine.sqlite3")
    db.migrate()
    course = create_course(db, archive)
    queued = db.create_import(course_id=course["id"], source=str(archive), adapter_name="zip-archive")

    completed = ImportPipeline(db).run_next()

    assert completed is not None
    assert completed["id"] == queued["id"]
    assert completed["status"] == "failed"
    assert completed["stage"] == "validate"
    assert completed["progress"] == 65
    assert set(completed["detail"]["stages"]) == set(IMPORT_STAGES) - {"preview"}
    assert completed["detail"]["stages"]["extract"]["output"]["mode"] == "archive-index"
    assert completed["detail"]["stages"]["enrich"]["output"]["performed"] is False

    assert [version["version"] for version in db.list_course_versions(course["id"])] == [1]
    assert db.list_compilation_drafts(course["id"]) == []


def test_failed_job_retains_stage_and_error(tmp_path: Path) -> None:
    missing_source = tmp_path / "missing-course"
    db = Database(tmp_path / "engine.sqlite3")
    db.migrate()
    course = create_course(db, missing_source)
    queued = db.create_import(course_id=course["id"], source=str(missing_source), adapter_name="directory-archive")

    failed = ImportPipeline(db).run_job(queued["id"])

    assert failed["status"] == "failed"
    assert failed["stage"] == "inventory"
    assert failed["detail"]["stages"]["inventory"]["status"] == "failed"
    assert failed["error"]
    assert len(db.list_course_versions(course["id"])) == 1


def test_specific_job_is_only_claimed_once(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "course"
    source.mkdir()
    (source / "content_map.json").write_text("{}")
    (source / "pages").mkdir()

    db = Database(tmp_path / "engine.sqlite3")
    db.migrate()
    course = create_course(db, source)
    queued = db.create_import(course_id=course["id"], source=str(source), adapter_name="mit-ocw-archive")
    pipeline = ImportPipeline(db)
    monkeypatch.setattr(
        ImportPipeline,
        "_compile",
        staticmethod(lambda source, normalized: {
            "schemaVersion": 2,
            "title": "Course",
            "code": "COURSE",
            "term": "",
            "description": "Test artifact",
            "units": [{"id": "unit-1", "title": "Unit", "lessons": []}],
        }),
    )

    first = pipeline.run_job(queued["id"])
    second = pipeline.run_job(queued["id"])

    assert first["status"] == "completed"
    assert second["status"] == "completed"
    assert len(db.list_course_versions(course["id"])) == 1
    assert len(db.list_compilation_drafts(course["id"])) == 1


def test_worker_and_waiting_ingest_commands_use_the_same_pipeline(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    source = tmp_path / "course"
    source.mkdir()
    (source / "content_map.json").write_text("{}")
    (source / "pages").mkdir()
    db_path = tmp_path / "engine.sqlite3"
    monkeypatch.setenv("COURSE_ENGINE_DB", str(db_path))

    db = Database(db_path)
    db.migrate()
    monkeypatch.setattr(
        ImportPipeline,
        "_compile",
        staticmethod(lambda source, normalized: {
            "schemaVersion": 2,
            "title": "Course",
            "code": "COURSE",
            "term": "",
            "description": "Test artifact",
            "units": [{"id": "unit-1", "title": "Unit", "lessons": []}],
        }),
    )
    course = create_course(db, source)
    queued = db.create_import(course_id=course["id"], source=str(source), adapter_name="mit-ocw-archive")

    monkeypatch.setattr(sys, "argv", ["course-engine", "worker", "--job-id", queued["id"]])
    assert cli.main() == 0
    worker_output = json.loads(capsys.readouterr().out)
    assert worker_output["status"] == "completed"

    monkeypatch.setattr(sys, "argv", ["course-engine", "ingest", course["id"], "--wait"])
    assert cli.main() == 0
    waiting_output = json.loads(capsys.readouterr().out)
    assert waiting_output["status"] == "completed"
