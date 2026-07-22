from __future__ import annotations

from pathlib import Path

from course_engine.setup import _migrate_legacy_setup, configure, load_setup


def test_legacy_pedagogically_optimized_setup_is_migrated_to_source_faithful(tmp_path: Path) -> None:
    course_dir = tmp_path / "course"
    course_dir.mkdir()
    legacy = {
        "schema_version": "course-engine-setup/1",
        "source": {"type": "directory", "location": str(tmp_path / "source")},
        "course": {"title": "Test Course", "slug": "test-course"},
        "compilation": {"mode": "deterministic", "structure": "pedagogically-optimized"},
        "privacy": {"allow_cloud": False},
    }
    (course_dir / "course.setup.json").write_text(__import__("json").dumps(legacy))

    state = configure(course_dir, non_interactive=True)

    assert state["compilation"]["structure"] == "source-faithful"
    assert state["compilation"]["structure_migrated_from"] == "pedagogically-optimized"
    assert "migration" in state
    assert any("pedagogically-optimized" in entry for entry in state["migration"]["setup_v1_to_v2"])


def test_legacy_ai_assisted_mode_becomes_compiler_ai_enabled(tmp_path: Path) -> None:
    course_dir = tmp_path / "course"
    course_dir.mkdir()
    legacy = {
        "schema_version": "course-engine-setup/1",
        "source": {"type": "directory", "location": str(tmp_path / "source")},
        "course": {"title": "Test Course", "slug": "test-course"},
        "compilation": {"mode": "ai-assisted"},
        "compiler_ai": {"provider": "openai-compatible", "model": "x"},
    }
    (course_dir / "course.setup.json").write_text(__import__("json").dumps(legacy))

    state = configure(course_dir, non_interactive=True)

    assert state["compiler_ai"]["enabled"] is True
    assert "compilation.mode" not in state


def test_migrate_legacy_setup_preserves_source_faithful() -> None:
    state = {
        "compilation": {"structure": "source-faithful"},
    }
    migrated = _migrate_legacy_setup(state)
    assert migrated["compilation"]["structure"] == "source-faithful"
    assert "structure_migrated_from" not in migrated["compilation"]


def test_visual_qa_defaults_to_auto() -> None:
    course_dir = Path(__import__("tempfile").mkdtemp()) / "course"
    course_dir.mkdir()
    state = configure(
        course_dir,
        non_interactive=True,
        supplied={
            "source.location": str(Path(__import__("tempfile").mkdtemp()) / "source"),
            "course.title": "T",
            "course.slug": "t",
        },
    )
    assert state["verification"]["visual_qa"] == "auto"


def test_legacy_validation_visual_qa_is_consolidated_under_verification(tmp_path: Path) -> None:
    course_dir = tmp_path / "course"
    course_dir.mkdir()
    legacy = {
        "schema_version": "course-engine-setup/1",
        "source": {"type": "directory", "location": str(tmp_path / "source")},
        "course": {"title": "Test Course", "slug": "test-course"},
        "validation": {"strictness": "strict", "visual_qa": "disabled"},
    }
    (course_dir / "course.setup.json").write_text(__import__("json").dumps(legacy))

    state = configure(course_dir, non_interactive=True)

    assert state["verification"]["visual_qa"] == "disabled"
    assert "visual_qa" not in state.get("validation", {})
    assert any("validation.visual_qa -> verification.visual_qa" in entry for entry in state["migration"]["setup_v1_to_v2"])
