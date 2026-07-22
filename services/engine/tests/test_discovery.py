from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path

import pytest

from course_engine.discovery import discover_sources


def _make_ocw_dir(path: Path, title: str = "Test Course", code: str = "TEST-101") -> Path:
    path.mkdir(parents=True)
    (path / "data.json").write_text(json.dumps({
        "course_title": title,
        "primary_course_number": code,
        "term": "Fall",
        "year": "2024",
        "level": "undergraduate",
    }))
    (path / "content_map.json").write_text("{}")
    (path / "pages").mkdir()
    return path


def test_discovery_selects_single_course_zip_without_question(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    zip_path = tmp_path / "18.01sc-fall-2010.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("data.json", json.dumps({
            "course_title": "Single Variable Calculus",
            "primary_course_number": "18.01SC",
            "term": "Fall",
            "year": "2010",
        }))
        archive.writestr("content_map.json", "{}")
        archive.writestr("pages/unit-1/data.json", "{}")

    result = discover_sources(course_dir)
    assert result.selected is not None
    assert result.selected.path == str(zip_path.resolve())
    assert result.selected.inferred_title == "Single Variable Calculus"
    assert result.selected.inferred_code == "18.01SC"
    assert result.ambiguity == []


def test_discovery_flags_two_similarly_plausible_courses(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    first = _make_ocw_dir(tmp_path / "18.01sc", title="Single Variable Calculus", code="18.01SC")
    second = _make_ocw_dir(tmp_path / "18.02sc", title="Multivariable Calculus", code="18.02SC")

    result = discover_sources(course_dir)
    assert result.selected is None
    assert len(result.ambiguity) == 2
    paths = {c.path for c in result.ambiguity}
    assert str(first.resolve()) in paths
    assert str(second.resolve()) in paths


def test_discovery_infers_title_slug_code_term_level(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    source = _make_ocw_dir(tmp_path / "cs-101", title="Intro to CS", code="CS-101")

    result = discover_sources(course_dir)
    assert result.selected is not None
    assert result.selected.inferred_title == "Intro to CS"
    assert result.selected.inferred_slug == "cs-101-intro-to-cs"
    assert result.selected.inferred_code == "CS-101"
    assert result.selected.inferred_term == "Fall 2024"
    assert result.selected.inferred_level == "undergraduate"


def test_discovery_honest_neutral_metadata_when_weak(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    vague = tmp_path / "some-folder"
    vague.mkdir()
    for i in range(3):
        (vague / f"doc{i}.pdf").write_text("pdf")

    result = discover_sources(course_dir)
    assert result.selected is not None
    assert result.selected.inferred_title == "Some Folder"
    assert result.selected.inferred_level is None
    assert any("Learner level not detected" in u for u in result.selected.uncertainties)


def test_discovery_excludes_repo_and_build_outputs(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    node_modules = tmp_path / "node_modules"
    node_modules.mkdir()
    (node_modules / "package.json").write_text("{}")

    result = discover_sources(course_dir)
    assert all(c.path != str(node_modules.resolve()) for c in result.candidates)


def test_discovery_with_explicit_path_uses_it(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    source = _make_ocw_dir(tmp_path / "explicit", title="Explicit Course", code="EXP-1")

    result = discover_sources(course_dir, explicit_path=str(source))
    assert result.selected is not None
    assert result.selected.path == str(source.resolve())


def test_discovery_no_candidate_returns_empty(tmp_path: Path) -> None:
    course_dir = tmp_path / "course-engine"
    course_dir.mkdir()
    result = discover_sources(course_dir)
    assert result.selected is None
    assert result.ambiguity == []
    assert result.candidates == []
