from __future__ import annotations

import getpass
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .discovery import DiscoveryCandidate, DiscoveryResult, discover_sources


SETUP_SCHEMA_VERSION = "course-engine-setup/2"
Prompt = Callable[[str], str]
SecretPrompt = Callable[[str], str]


@dataclass(frozen=True)
class SetupQuestion:
    key: str
    prompt: str
    default: str | None = None
    choices: tuple[str, ...] = ()
    secret: bool = False


def _get(data: Mapping[str, Any], dotted_key: str) -> Any:
    value: Any = data
    for part in dotted_key.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def _set(data: dict[str, Any], dotted_key: str, value: Any) -> None:
    target = data
    parts = dotted_key.split(".")
    for part in parts[:-1]:
        child = target.get(part)
        if not isinstance(child, dict):
            child = {}
            target[part] = child
        target = child
    target[parts[-1]] = value


def _delete(data: dict[str, Any], dotted_key: str) -> None:
    target = data
    parts = dotted_key.split(".")
    for part in parts[:-1]:
        child = target.get(part)
        if not isinstance(child, dict):
            return
        target = child
    target.pop(parts[-1], None)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "course"


def _coerce(key: str, value: str) -> Any:
    if key in {"privacy.allow_cloud", "compilation.allow_ai_scaffolding", "compiler_ai.enabled"}:
        return value == "yes"
    if key in {"course.prerequisites", "course.learning_goals"}:
        return [item.strip() for item in value.split(",") if item.strip()]
    if key == "compiler_ai.max_calls":
        return int(value)
    if key == "compiler_ai.max_cost_usd":
        return float(value)
    return value


def _migrate_legacy_setup(state: dict[str, Any]) -> dict[str, Any]:
    """Convert legacy setup decisions to the source-faithful invariant."""
    migrated: list[str] = []
    structure = _get(state, "compilation.structure")
    if structure is not None and structure != "source-faithful":
        _set(state, "compilation.structure", "source-faithful")
        migrated.append(f"compilation.structure: {structure} -> source-faithful")
        _set(state, "compilation.structure_migrated_from", structure)

    mode = _get(state, "compilation.mode")
    if mode == "ai-assisted":
        _set(state, "compiler_ai.enabled", True)
        migrated.append("compilation.mode: ai-assisted -> compiler_ai.enabled=true")
    elif mode == "deterministic":
        _set(state, "compiler_ai.enabled", False)
        migrated.append("compilation.mode: deterministic -> compiler_ai.enabled=false")
    _delete(state, "compilation.mode")

    # Move old publishing.review_before_publish into verification.review_required.
    review = _get(state, "publishing.review_before_publish")
    if review is not None:
        _set(state, "verification.review_required", bool(review))
        _delete(state, "publishing.review_before_publish")
        migrated.append("publishing.review_before_publish -> verification.review_required")

    # Consolidate visual_qa under verification.
    legacy_visual = _get(state, "validation.visual_qa")
    if legacy_visual is not None:
        if _get(state, "verification.visual_qa") is None:
            _set(state, "verification.visual_qa", legacy_visual)
        _delete(state, "validation.visual_qa")
        migrated.append("validation.visual_qa -> verification.visual_qa")

    if migrated:
        state.setdefault("migration", {}).setdefault("setup_v1_to_v2", migrated)
    return state


def _apply_inferred_metadata(state: dict[str, Any]) -> None:
    """Infer title/slug from the configured source when not explicitly supplied."""
    source = _get(state, "source.location")
    if not source:
        return
    if not _get(state, "course.title") or not _get(state, "course.slug"):
        path = Path(source).expanduser().resolve()
        title = path.name.replace("-", " ").title() if path.exists() else str(source)
        if not _get(state, "course.title"):
            _set(state, "course.title", title)
        if not _get(state, "course.slug"):
            _set(state, "course.slug", _slug(title))


def _apply_discovery(state: dict[str, Any], project_root: Path, explicit_path: str | None = None) -> DiscoveryResult:
    if _get(state, "source.location"):
        _apply_inferred_metadata(state)
        return DiscoveryResult(candidates=[])
    result = discover_sources(project_root, explicit_path)
    if result.selected:
        _set(state, "source.location", result.selected.path)
        _set(state, "source.type", result.selected.source_type)
        _set(state, "course.title", result.selected.inferred_title)
        _set(state, "course.slug", result.selected.inferred_slug)
        if result.selected.inferred_code:
            _set(state, "course.code", result.selected.inferred_code)
        if result.selected.inferred_term:
            _set(state, "course.term", result.selected.inferred_term)
        if result.selected.inferred_level:
            _set(state, "course.learner_level", result.selected.inferred_level)
        _set(state, "discovery", {
            "confidence": result.selected.confidence,
            "evidence": [{"kind": e.kind, "detail": e.detail} for e in result.selected.evidence],
            "uncertainties": result.selected.uncertainties,
        })
    return result


def question_plan(state: Mapping[str, Any], discovery: DiscoveryResult | None = None) -> list[SetupQuestion]:
    """Return only genuine blocker or optional-capability questions."""
    questions: list[SetupQuestion] = []

    # Source ambiguity: only when discovery cannot decide.
    if not _get(state, "source.location"):
        if discovery and discovery.ambiguity:
            choices = tuple(str(index) for index in range(len(discovery.ambiguity)))
            labels = "\n".join(f"  {index}: {candidate.inferred_title} ({candidate.path})" for index, candidate in enumerate(discovery.ambiguity))
            questions.append(SetupQuestion("source.choice", f"Multiple course sources found:\n{labels}\nChoose source number", choices=choices))
        else:
            questions.append(SetupQuestion("source.location", "Course source path or URL"))

    # Optional capabilities are asked only when explicitly enabled or missing.
    ai_enabled = _get(state, "compiler_ai.enabled")
    if ai_enabled is None:
        questions.append(SetupQuestion("compiler_ai.enabled", "Enable optional compiler AI for evidence-bound suggestions?", "no", ("yes", "no")))
    elif ai_enabled is True:
        if _get(state, "compiler_ai.provider") is None:
            questions.append(SetupQuestion("compiler_ai.provider", "Compiler AI provider", "openai-compatible"))
        if _get(state, "compiler_ai.model") is None:
            questions.append(SetupQuestion("compiler_ai.model", "Compiler AI model"))
        if _get(state, "compiler_ai.credentials_available") is None:
            questions.append(SetupQuestion("compiler_ai.credentials_available", "Do you have a compiler AI API key reference ready?", "no", ("yes", "no")))
        if _get(state, "compiler_ai.credentials_available"):
            if _get(state, "compiler_ai.base_url_env") is None:
                questions.append(SetupQuestion("compiler_ai.base_url_env", "Environment variable for compiler AI base URL", "COMPILER_AI_BASE_URL"))
            if _get(state, "compiler_ai.api_key_env") is None:
                questions.append(SetupQuestion("compiler_ai.api_key_env", "Environment variable for compiler AI key", "COMPILER_AI_API_KEY"))
        if _get(state, "compiler_ai.max_calls") is None:
            questions.append(SetupQuestion("compiler_ai.max_calls", "Maximum AI calls per compilation (0 = unlimited)", "0"))
        if _get(state, "compiler_ai.max_cost_usd") is None:
            questions.append(SetupQuestion("compiler_ai.max_cost_usd", "Maximum AI cost in USD (0 = unlimited)", "0"))

    parser = _get(state, "parser.provider")
    if parser is None:
        _set(state, "parser.provider", "builtin")
    elif parser == "mineru":
        if _get(state, "parser.credentials_available") is None:
            questions.append(SetupQuestion("parser.credentials_available", "MinerU parser credentials available?", "no", ("yes", "no")))
        if _get(state, "parser.credentials_available"):
            if _get(state, "parser.base_url_env") is None:
                questions.append(SetupQuestion("parser.base_url_env", "Environment variable for MinerU URL", "MINERU_BASE_URL"))
            if _get(state, "parser.api_key_env") is None:
                questions.append(SetupQuestion("parser.api_key_env", "Environment variable for MinerU key", "MINERU_API_KEY"))

    if _get(state, "verification.visual_qa") is None:
        questions.append(SetupQuestion("verification.visual_qa", "Visual browser QA mode", "auto", ("auto", "enabled", "disabled")))

    return [question for question in questions if _get(state, question.key) is None]


def answer_question(state: dict[str, Any], question: SetupQuestion, raw_value: str, discovery: DiscoveryResult | None = None) -> None:
    value = raw_value.strip()
    if not value and question.default is not None:
        value = question.default
    if not value and question.default is None:
        raise ValueError(f"{question.key} is required")
    if question.choices and value not in question.choices:
        raise ValueError(f"{question.key} must be one of: {', '.join(question.choices)}")

    if question.key == "source.choice" and discovery and discovery.ambiguity:
        index = int(value)
        selected = discovery.ambiguity[index]
        _set(state, "source.location", selected.path)
        _set(state, "source.type", selected.source_type)
        _set(state, "course.title", selected.inferred_title)
        _set(state, "course.slug", selected.inferred_slug)
        if selected.inferred_code:
            _set(state, "course.code", selected.inferred_code)
        if selected.inferred_term:
            _set(state, "course.term", selected.inferred_term)
        if selected.inferred_level:
            _set(state, "course.learner_level", selected.inferred_level)
        return

    if question.key.endswith(("api_key_env", "base_url_env")):
        if question.key.startswith("compiler_ai."):
            expected = "COMPILER_AI_"
        elif _get(state, "parser.provider") == "mineru":
            expected = "MINERU_"
        else:
            expected = "DOCUMENT_PARSER_"
        if not value.startswith(expected):
            raise ValueError(f"{question.key} must reference the {expected}* namespace")

    _set(state, question.key, _coerce(question.key, value))


def validate_setup(state: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if not _get(state, "source.location"):
        errors.append("source.location is required")
    if not _get(state, "course.title"):
        errors.append("course.title is required")
    if not _get(state, "course.slug"):
        errors.append("course.slug is required")
    if _get(state, "compilation.structure") not in (None, "source-faithful"):
        errors.append("compilation.structure must be source-faithful")
    if _get(state, "compiler_ai.enabled") is True:
        if not _get(state, "compiler_ai.provider"):
            errors.append("compiler_ai.provider is required when AI is enabled")
        if not _get(state, "compiler_ai.model"):
            errors.append("compiler_ai.model is required when AI is enabled")
    max_calls = _get(state, "compiler_ai.max_calls")
    max_cost = _get(state, "compiler_ai.max_cost_usd")
    if isinstance(max_calls, int) and max_calls < 0:
        errors.append("compiler_ai.max_calls cannot be negative")
    if isinstance(max_cost, (int, float)) and max_cost < 0:
        errors.append("compiler_ai.max_cost_usd cannot be negative")
    visual_qa = _get(state, "verification.visual_qa")
    if visual_qa is not None and visual_qa not in {"auto", "enabled", "disabled"}:
        errors.append("verification.visual_qa must be auto, enabled, or disabled")
    return errors


def load_setup(course_dir: Path) -> dict[str, Any]:
    path = course_dir / "course.setup.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_setup(course_dir: Path, state: Mapping[str, Any]) -> Path:
    errors = validate_setup(state)
    if errors:
        raise ValueError("; ".join(errors))
    course_dir.mkdir(parents=True, exist_ok=True)
    path = course_dir / "course.setup.json"
    payload = dict(state)
    payload["schema_version"] = SETUP_SCHEMA_VERSION
    serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=course_dir, delete=False) as handle:
        handle.write(serialized)
        temporary = Path(handle.name)
    os.replace(temporary, path)
    return path


def configure(
    course_dir: Path,
    *,
    project_root: Path | None = None,
    explicit_source: str | None = None,
    reconfigure: bool = False,
    non_interactive: bool = False,
    supplied: Mapping[str, str] | None = None,
    prompt: Prompt = input,
    secret_prompt: SecretPrompt = getpass.getpass,
) -> dict[str, Any]:
    """Infer setup from nearby sources and ask only genuine blockers."""
    del secret_prompt  # Reserved for future connectivity checks; secret values never enter setup state.
    state = {} if reconfigure else load_setup(course_dir)
    state = _migrate_legacy_setup(state)
    supplied = supplied or {}

    project_root = project_root or course_dir.resolve().parents[1]
    discovery = _apply_discovery(state, project_root, explicit_source)

    # Apply any explicit overrides for discoverable metadata.
    for key in ("course.title", "course.slug", "course.code", "course.term", "course.learner_level"):
        if key in supplied and _get(state, key) is None:
            _set(state, key, _coerce(key, supplied[key]))

    # Pre-apply other supplied configuration so question_plan can see it.
    for key, value in supplied.items():
        if key == "source.choice" or _get(state, key) is not None:
            continue
        if "." in key:
            _set(state, key, _coerce(key, value))

    # Apply invariant defaults so non-interactive mode never blocks on optional policy.
    if _get(state, "compiler_ai.enabled") is None:
        _set(state, "compiler_ai.enabled", False)
    if _get(state, "parser.provider") is None:
        _set(state, "parser.provider", "builtin")
    if _get(state, "privacy.allow_cloud") is None:
        _set(state, "privacy.allow_cloud", False)
    if _get(state, "verification.visual_qa") is None:
        _set(state, "verification.visual_qa", "auto")
    if _get(state, "compiler_ai.enabled") is True:
        if _get(state, "compiler_ai.credentials_available") is None:
            _set(state, "compiler_ai.credentials_available", False)
        if _get(state, "compiler_ai.max_calls") is None:
            _set(state, "compiler_ai.max_calls", 0)
        if _get(state, "compiler_ai.max_cost_usd") is None:
            _set(state, "compiler_ai.max_cost_usd", 0)

    while True:
        questions = question_plan(state, discovery)
        if not questions:
            break
        question = questions[0]
        if question.key in supplied:
            answer_question(state, question, supplied[question.key], discovery)
            continue
        if non_interactive:
            missing = ", ".join(item.key for item in questions)
            raise ValueError(f"Setup blocked; provide or resolve: {missing}")
        choices = f" ({'/'.join(question.choices)})" if question.choices else ""
        default = f" [{question.default}]" if question.default is not None else ""
        while True:
            try:
                answer_question(state, question, prompt(f"{question.prompt}{choices}{default}: "), discovery)
                break
            except ValueError as error:
                print(error)

    save_setup(course_dir, state)
    return state


def parse_supplied(values: Iterable[str]) -> dict[str, str]:
    supplied: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"Expected KEY=VALUE, received: {value}")
        key, raw = value.split("=", 1)
        supplied[key.strip()] = raw
    return supplied
