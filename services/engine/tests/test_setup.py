from __future__ import annotations

import json
from pathlib import Path

import pytest

from course_engine.providers import (
    CompilerToolAudit,
    CompilerToolRequest,
    ProviderBudget,
    ProviderExecutionPolicy,
    OpenAICompatibleCompilerAI,
    compiler_ai_environment,
    redact,
    redact_text,
    redact_url,
    study_ai_environment,
)
from course_engine.mineru import MinerUClient
from course_engine.setup import answer_question, configure, load_setup, question_plan, validate_setup


def deterministic_answers(source: Path) -> dict[str, str]:
    return {
        "source.location": str(source),
        "course.title": "Test Calculus",
        "course.slug": "test-calculus",
        "course.learner_level": "undergraduate",
        "course.prerequisites": "Algebra",
        "course.learning_goals": "Differentiate functions,Integrate functions",
        "privacy.allow_cloud": "no",
        "compiler_ai.enabled": "no",
        "parser.provider": "builtin",
        "validation.strictness": "strict",
        "presentation.theme": "academic",
        "presentation.renderer": "default",
        "verification.visual_qa": "auto",
    }


def test_deterministic_questionnaire_skips_ai_and_mineru_questions(tmp_path: Path) -> None:
    state = configure(
        tmp_path / "courses" / "calculus",
        non_interactive=True,
        supplied=deterministic_answers(tmp_path / "source"),
    )

    assert state["compiler_ai"]["enabled"] is False
    assert state["parser"] == {"provider": "builtin"}
    assert validate_setup(state) == []

    persisted = json.loads((tmp_path / "courses" / "calculus" / "course.setup.json").read_text())
    assert "api_key" not in json.dumps(persisted).lower()


def test_ai_and_mineru_questions_are_conditional() -> None:
    state: dict[str, object] = {
        "compiler_ai": {"enabled": True, "credentials_available": True},
        "parser": {"provider": "mineru", "credentials_available": True},
    }
    keys = {question.key for question in question_plan(state)}

    assert "compiler_ai.provider" in keys
    assert "compiler_ai.api_key_env" in keys
    assert "compiler_ai.max_cost_usd" in keys
    assert "parser.base_url_env" in keys
    assert "parser.api_key_env" in keys


def test_missing_provider_accounts_are_recorded_without_requesting_secret_references() -> None:
    state: dict[str, object] = {
        "compiler_ai": {"enabled": True, "credentials_available": False},
        "parser": {"provider": "mineru", "credentials_available": False},
    }
    keys = {question.key for question in question_plan(state)}
    assert "compiler_ai.api_key_env" not in keys
    assert "parser.api_key_env" not in keys


def test_ai_assisted_setup_persists_policy_and_references_but_not_secrets(tmp_path: Path) -> None:
    answers = deterministic_answers(tmp_path / "source")
    answers.update(
        {
            "compiler_ai.enabled": "yes",
            "privacy.allow_cloud": "yes",
            "compilation.allow_ai_scaffolding": "yes",
            "compiler_ai.provider": "openai-compatible",
            "compiler_ai.model": "course-optimizer",
            "compiler_ai.credentials_available": "yes",
            "compiler_ai.base_url_env": "COMPILER_AI_BASE_URL",
            "compiler_ai.api_key_env": "COMPILER_AI_API_KEY",
            "compiler_ai.max_calls": "25",
            "compiler_ai.max_cost_usd": "3.50",
            "compiler_ai.quality": "high",
            "parser.provider": "mineru",
            "parser.credentials_available": "yes",
            "parser.base_url_env": "MINERU_BASE_URL",
            "parser.api_key_env": "MINERU_API_KEY",
        }
    )

    state = configure(tmp_path / "course", non_interactive=True, supplied=answers)

    assert state["compiler_ai"]["max_calls"] == 25
    assert state["compiler_ai"]["max_cost_usd"] == 3.5
    assert state["compiler_ai"]["api_key_env"] == "COMPILER_AI_API_KEY"
    assert state["parser"]["api_key_env"] == "MINERU_API_KEY"
    serialized = (tmp_path / "course" / "course.setup.json").read_text()
    assert "sk-" not in serialized


def test_non_interactive_setup_reports_missing_fields(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="source.location"):
        configure(tmp_path / "course", non_interactive=True)


def test_existing_setup_is_reused_and_reconfigure_restarts(tmp_path: Path) -> None:
    course_dir = tmp_path / "course"
    configure(course_dir, non_interactive=True, supplied=deterministic_answers(tmp_path / "source"))
    assert configure(course_dir, non_interactive=True)["course"]["slug"] == "test-calculus"

    with pytest.raises(ValueError, match="source.location"):
        configure(course_dir, reconfigure=True, non_interactive=True)

    assert load_setup(course_dir)["course"]["slug"] == "test-calculus"


def test_secret_references_enforce_provider_namespace() -> None:
    compiler_question = next(
        question
        for question in question_plan({"compiler_ai": {"enabled": True, "credentials_available": True}})
        if question.key == "compiler_ai.api_key_env"
    )
    with pytest.raises(ValueError, match="COMPILER_AI"):
        answer_question({}, compiler_question, "STUDY_AI_API_KEY")


def test_provider_namespaces_are_isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPILER_AI_API_KEY", "compiler-secret")
    monkeypatch.setenv("COMPILER_AI_MODEL", "compiler-model")
    monkeypatch.setenv("STUDY_AI_API_KEY", "study-secret")
    monkeypatch.setenv("STUDY_AI_MODEL", "study-model")

    compiler = compiler_ai_environment()
    study = study_ai_environment()

    assert compiler.api_key_present is True
    assert study.api_key_present is True
    assert compiler.api_key_env == "COMPILER_AI_API_KEY"
    assert study.api_key_env == "STUDY_AI_API_KEY"
    assert compiler.model == "compiler-model"
    assert study.model == "study-model"
    assert "compiler-secret" not in json.dumps(compiler.diagnostic())
    assert "study-secret" not in json.dumps(study.diagnostic())


def test_diagnostics_and_tool_audits_redact_secret_values() -> None:
    payload = {
        "api_key": "sk-private",
        "nested": {"authorization": "Bearer private", "safe": "course-node-1"},
    }
    assert redact(payload) == {
        "api_key": "[REDACTED]",
        "nested": {"authorization": "[REDACTED]", "safe": "course-node-1"},
    }

    audit = CompilerToolAudit.from_request(
        CompilerToolRequest(
            tool="match_diagram",
            arguments=payload,
            reason="The figure caption cites this example",
            confidence=0.93,
            source_node_ids=("course-node-1",),
        )
    )
    serialized = audit.to_json()
    assert "sk-private" not in serialized
    assert "Bearer private" not in serialized
    assert "course-node-1" in serialized
    assert redact_url("https://user:secret@example.test/v1?api_key=private") == "https://example.test/v1"
    health = MinerUClient("https://user:secret@example.test/v1?api_key=private").health()
    assert health.url == "https://example.test/v1"
    assert "secret" not in health.message
    assert "private-value" not in redact_text("Bearer private-value")
    assert "abc123secret" not in redact_text("https://example.test?api_key=abc123secret")


def test_provider_policy_blocks_cloud_and_exhausted_budgets() -> None:
    local_only = ProviderExecutionPolicy(allow_cloud=False)
    local_only.authorize(remote=False)
    with pytest.raises(PermissionError, match="Cloud"):
        local_only.authorize(remote=True)

    limited = ProviderExecutionPolicy(
        allow_cloud=True,
        budget=ProviderBudget(max_calls=2, max_cost_usd=1.0),
    )
    limited.authorize(remote=True, calls_used=1, cost_used_usd=0.5)
    with pytest.raises(PermissionError, match="budget"):
        limited.authorize(remote=True, calls_used=2, cost_used_usd=0.5)


def test_mineru_parse_enforces_cloud_policy_before_upload(tmp_path: Path) -> None:
    document = tmp_path / "notes.pdf"
    document.write_bytes(b"%PDF-1.7\n")
    client = MinerUClient("https://mineru.net/api")
    with pytest.raises(PermissionError, match="Cloud"):
        client.parse(str(document), policy=ProviderExecutionPolicy(allow_cloud=False))


def test_compiler_ai_client_enforces_cloud_policy_before_connecting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPILER_AI_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("COMPILER_AI_MODEL", "optimizer")
    client = OpenAICompatibleCompilerAI(
        compiler_ai_environment(),
        ProviderExecutionPolicy(allow_cloud=False),
    )
    with pytest.raises(PermissionError, match="Cloud"):
        client.propose({}, {})
