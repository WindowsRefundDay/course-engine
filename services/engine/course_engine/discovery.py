from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile


COURSE_SIGNATURES = {
    "mit_ocw": {
        "required": {"data.json", "pages"},
        "scored": {"content_map.json", "resources", "index.html"},
        "title_fields": ["course_title", "title"],
        "code_fields": ["primary_course_number", "course_number", "code"],
        "term_fields": ["term", "year", "semester"],
        "level_fields": ["level", "audience", "intended_level"],
    },
    "generic_directory": {
        "required": set(),
        "scored": {"syllabus", "index.html", "README", "data.json", "course.json", "lectures", "pages", "videos"},
    },
}


@dataclass(frozen=True)
class SourceEvidence:
    kind: str
    detail: str


@dataclass(frozen=True)
class DiscoveryCandidate:
    path: str
    source_type: str
    confidence: str  # "high" | "medium" | "low"
    evidence: list[SourceEvidence]
    inferred_title: str
    inferred_slug: str
    inferred_code: str | None = None
    inferred_term: str | None = None
    inferred_level: str | None = None
    uncertainties: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DiscoveryResult:
    candidates: list[DiscoveryCandidate]
    selected: DiscoveryCandidate | None = None
    ambiguity: list[DiscoveryCandidate] = field(default_factory=list)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "course"


def _is_excluded(path: Path, project_root: Path) -> bool:
    name = path.name.lower()
    excluded_names = {
        "node_modules", ".git", ".next", "dist", ".venv", "__pycache__", ".wrangler",
        ".omx", ".openai", ".claude", ".agents", ".cursor", ".vscode", ".idea",
        "coverage", ".pytest_cache", ".mypy_cache", "build", "out",
    }
    if name in excluded_names:
        return True
    try:
        resolved = path.resolve()
        if resolved == project_root.resolve():
            return True
    except (OSError, RuntimeError):
        pass
    return False


def _is_readable_dir(path: Path) -> bool:
    try:
        return path.is_dir() and os.access(path, os.R_OK | os.X_OK)
    except (OSError, PermissionError):
        return False


def _scan_bounded_roots(project_root: Path, explicit_path: str | None = None) -> list[Path]:
    roots: list[Path] = []
    if explicit_path:
        parsed = urlparse(explicit_path)
        if parsed.scheme in {"http", "https"}:
            return [Path(explicit_path)]
        path = Path(explicit_path).expanduser().resolve()
        if _is_readable_dir(path):
            roots.append(path)
        elif path.is_file():
            roots.append(path)
        return roots
    parent = project_root.parent
    if _is_readable_dir(parent):
        roots.append(parent)
    # Add a few plausible sibling-level locations without crawling home.
    for candidate in (project_root.parent.parent, project_root.parent.parent.parent):
        if candidate != project_root and candidate != Path.home() and candidate not in roots and _is_readable_dir(candidate):
            roots.append(candidate)
    return roots


def _safe_iterdir(path: Path) -> list[Path]:
    try:
        return [p for p in path.iterdir() if p.name not in {".", ".."}]
    except (OSError, PermissionError):
        return []


def _directory_score(path: Path) -> tuple[int, list[SourceEvidence]]:
    evidence: list[SourceEvidence] = []
    score = 0
    has_mit_signature = False
    entries = _safe_iterdir(path)
    files: set[str] = set()
    dirs: set[str] = set()
    for entry in entries:
        try:
            if entry.is_file():
                files.add(entry.name)
            elif entry.is_dir():
                dirs.add(entry.name)
        except (OSError, PermissionError):
            continue

    mit = COURSE_SIGNATURES["mit_ocw"]
    if mit["required"] <= (files | dirs):
        score += 50
        has_mit_signature = True
        evidence.append(SourceEvidence("mit-ocw-signature", "MIT OCW archive structure (data.json + pages)"))
    for name in mit["scored"] & (files | dirs):
        score += 10
        evidence.append(SourceEvidence("ocw-asset", f"Contains {name}"))

    generic = COURSE_SIGNATURES["generic_directory"]
    for name in generic["scored"] & (files | dirs):
        score += 5
        evidence.append(SourceEvidence("course-asset", f"Contains {name}"))

    pdf_count = len(list(path.glob("*.pdf")))
    html_count = len(list(path.glob("*.html")))
    media_count = len(list(path.glob("*.mp4"))) + len(list(path.glob("*.webm")))
    if pdf_count >= 3:
        score += min(pdf_count * 3, 15)
        evidence.append(SourceEvidence("pdf-collection", f"{pdf_count} PDFs"))
    if html_count >= 3:
        score += min(html_count * 2, 10)
        evidence.append(SourceEvidence("html-collection", f"{html_count} HTML pages"))
    if media_count >= 1:
        score += min(media_count * 3, 12)
        evidence.append(SourceEvidence("media", f"{media_count} video files"))

    title, code, term, level = _infer_directory_metadata(path)
    if title:
        score += 10
        evidence.append(SourceEvidence("inferred-title", f"Title from source metadata: {title}"))
    if code:
        score += 5
        evidence.append(SourceEvidence("inferred-code", f"Course code: {code}"))
    if term:
        score += 3
        evidence.append(SourceEvidence("inferred-term", f"Term: {term}"))
    if level:
        score += 2
        evidence.append(SourceEvidence("inferred-level", f"Level: {level}"))

    # Distinguish a coherent course from an incidental folder of files.
    if score > 0 and (has_mit_signature or pdf_count + html_count + media_count >= 3):
        score += 10
        evidence.append(SourceEvidence("coherent-collection", "Multiple course-like files together"))

    return score, evidence


def _read_course_json(path: Path) -> dict[str, Any]:
    for name in ("data.json", "course.json", "metadata.json"):
        candidate = path / name
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                return {}
    return {}


def _extract_json_field(data: dict[str, Any], fields: list[str]) -> str | None:
    for field in fields:
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _infer_directory_metadata(path: Path) -> tuple[str | None, str | None, str | None, str | None]:
    data = _read_course_json(path)
    mit = COURSE_SIGNATURES["mit_ocw"]
    title = _extract_json_field(data, mit["title_fields"])
    code = _extract_json_field(data, mit["code_fields"])
    term_parts = [str(data.get(field)) for field in mit["term_fields"] if data.get(field)]
    term = " ".join(term_parts) if term_parts else None
    level = _extract_json_field(data, mit["level_fields"])
    if not title:
        title = _title_from_html(path / "index.html")
    if not title:
        title = _title_from_html(path)
    return title, code, term, level


def _title_from_html(source: Path) -> str | None:
    try:
        if source.is_file():
            html = source.read_text(encoding="utf-8", errors="ignore")
        elif source.is_dir():
            html = (source / "index.html").read_text(encoding="utf-8", errors="ignore")
        else:
            return None
        match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
        if match:
            text = match.group(1).strip().replace("\n", " ")
            # De-prioritize generic titles.
            if text.lower() in {"index", "home", "course"}:
                return None
            return text
    except (OSError, ValueError, TypeError):
        return None
    return None


def _zip_score(path: Path) -> tuple[int, list[SourceEvidence], dict[str, Any] | None]:
    evidence: list[SourceEvidence] = []
    score = 0
    metadata: dict[str, Any] | None = None
    try:
        with ZipFile(path) as archive:
            names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
            roots = {name.split("/", 1)[0] for name in names if "/" in name}
    except BadZipFile:
        return 0, [SourceEvidence("invalid-zip", "Archive is not a valid ZIP")], None

    score += 10  # Being a valid archive.
    evidence.append(SourceEvidence("zip-archive", f"{len(names)} files"))

    if any(name.endswith("data.json") and "/pages/" in name for name in names):
        score += 40
        evidence.append(SourceEvidence("mit-ocw-zip", "MIT OCW archive structure inside ZIP"))

    if any(name.endswith("content_map.json") for name in names):
        score += 10
        evidence.append(SourceEvidence("content-map", "Contains content_map.json"))

    pdf_count = sum(1 for name in names if name.lower().endswith(".pdf"))
    html_count = sum(1 for name in names if name.lower().endswith(".html"))
    if pdf_count >= 3:
        score += min(pdf_count // 2, 10)
        evidence.append(SourceEvidence("pdf-collection", f"{pdf_count} PDFs"))
    if html_count >= 3:
        score += min(html_count // 2, 5)
        evidence.append(SourceEvidence("html-collection", f"{html_count} HTML pages"))

    # Try to read data.json for metadata.
    for name in names:
        if name.endswith("data.json") and "pages" not in name:
            try:
                with ZipFile(path) as archive:
                    data = json.loads(archive.read(name).decode("utf-8"))
                    if isinstance(data, dict):
                        metadata = data
                        break
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue

    if metadata:
        mit = COURSE_SIGNATURES["mit_ocw"]
        title = _extract_json_field(metadata, mit["title_fields"])
        code = _extract_json_field(metadata, mit["code_fields"])
        term_parts = [str(metadata.get(field)) for field in mit["term_fields"] if metadata.get(field)]
        term = " ".join(term_parts) if term_parts else None
        level = _extract_json_field(metadata, mit["level_fields"])
        if title:
            score += 10
            evidence.append(SourceEvidence("inferred-title", f"Title from source metadata: {title}"))
        if code:
            score += 5
            evidence.append(SourceEvidence("inferred-code", f"Course code: {code}"))
        if term:
            score += 3
            evidence.append(SourceEvidence("inferred-term", f"Term: {term}"))
        if level:
            score += 2
            evidence.append(SourceEvidence("inferred-level", f"Level: {level}"))

    if len(roots) == 1:
        score += 5
        evidence.append(SourceEvidence("single-root", f"Single root directory: {next(iter(roots))}"))

    return score, evidence, metadata


def _pdf_score(path: Path) -> tuple[int, list[SourceEvidence]]:
    evidence = [SourceEvidence("pdf-document", "Single PDF file")]
    return 5, evidence


def _web_score(url: str) -> tuple[int, list[SourceEvidence]]:
    evidence = [SourceEvidence("website", f"URL provided: {url}")]
    return 20, evidence


def _confidence_from_score(score: int) -> str:
    if score >= 50:
        return "high"
    if score >= 18:
        return "medium"
    return "low"


def _build_candidate(path: Path, source_type: str, score: int, evidence: list[SourceEvidence], metadata: dict[str, Any] | None = None) -> DiscoveryCandidate:
    title: str | None = None
    code: str | None = None
    term: str | None = None
    level: str | None = None
    uncertainties: list[str] = []

    if metadata:
        mit = COURSE_SIGNATURES["mit_ocw"]
        title = _extract_json_field(metadata, mit["title_fields"])
        code = _extract_json_field(metadata, mit["code_fields"])
        term = _extract_json_field(metadata, mit["term_fields"])
        level = _extract_json_field(metadata, mit["level_fields"])
    elif source_type == "directory":
        title, code, term, level = _infer_directory_metadata(path)

    if not title:
        if source_type == "zip":
            title = path.stem.replace("-", " ").title()
        elif source_type == "pdf":
            title = path.stem.replace("-", " ").title()
        elif source_type == "website":
            parsed = urlparse(str(path))
            title = parsed.netloc or str(path)
        else:
            title = path.name.replace("-", " ").title()
        uncertainties.append("Title inferred from filename; verify in settings.")

    if not code:
        uncertainties.append("Course code not detected.")
    if not term:
        uncertainties.append("Term not detected.")
    if not level:
        uncertainties.append("Learner level not detected.")

    inferred_slug = _slug(title)
    if code:
        inferred_slug = _slug(f"{code}-{title}")

    return DiscoveryCandidate(
        path=str(path),
        source_type=source_type,
        confidence=_confidence_from_score(score),
        evidence=evidence,
        inferred_title=title,
        inferred_slug=inferred_slug,
        inferred_code=code,
        inferred_term=term,
        inferred_level=level,
        uncertainties=uncertainties,
    )


def discover_sources(project_root: Path, explicit_path: str | None = None) -> DiscoveryResult:
    """Find and score likely course sources near the project root."""
    candidates: list[tuple[DiscoveryCandidate, int]] = []
    roots = _scan_bounded_roots(project_root, explicit_path)

    for root in roots:
        if str(root).startswith(("http://", "https://")):
            score, evidence = _web_score(str(root))
            candidate = _build_candidate(Path(str(root)), "website", score, evidence)
            candidates.append((candidate, score))
            continue

        if not root.exists():
            continue

        if root.is_file():
            if root.suffix.lower() == ".zip":
                score, evidence, metadata = _zip_score(root)
                if score > 0:
                    candidate = _build_candidate(root, "zip", score, evidence, metadata)
                    candidates.append((candidate, score))
            elif root.suffix.lower() == ".pdf":
                score, evidence = _pdf_score(root)
                candidate = _build_candidate(root, "pdf", score, evidence)
                candidates.append((candidate, score))
            continue

        # Directory: score the directory itself, then look one level deeper for archives.
        score, evidence = _directory_score(root)
        if score > 0 and not _is_excluded(root, project_root):
            candidate = _build_candidate(root, "directory", score, evidence)
            candidates.append((candidate, score))

        for child in sorted(_safe_iterdir(root)):
            if not _is_readable_dir(child) and not child.is_file():
                continue
            if _is_excluded(child, project_root):
                continue
            if _is_readable_dir(child):
                child_score, child_evidence = _directory_score(child)
                if child_score > 0:
                    child_candidate = _build_candidate(child, "directory", child_score, child_evidence)
                    candidates.append((child_candidate, child_score))
            elif child.suffix.lower() == ".zip":
                child_score, child_evidence, child_metadata = _zip_score(child)
                if child_score > 0:
                    child_candidate = _build_candidate(child, "zip", child_score, child_evidence, child_metadata)
                    candidates.append((child_candidate, child_score))
            elif child.suffix.lower() == ".pdf":
                child_score, child_evidence = _pdf_score(child)
                child_candidate = _build_candidate(child, "pdf", child_score, child_evidence)
                candidates.append((child_candidate, child_score))

    # Sort by score descending, then by path for stability.
    candidates.sort(key=lambda item: (-item[1], item[0].path))

    # Deduplicate by resolved path.
    seen: set[str] = set()
    deduplicated: list[DiscoveryCandidate] = []
    for candidate, _ in candidates:
        try:
            key = str(Path(candidate.path).resolve())
        except (OSError, RuntimeError):
            key = candidate.path
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(candidate)

    if not deduplicated:
        return DiscoveryResult(candidates=[])

    # If one candidate is distinctly higher, select it. Otherwise flag ambiguity.
    top = deduplicated[0]
    second = deduplicated[1] if len(deduplicated) > 1 else None
    if top.confidence == "high" and (not second or _confidence_from_score(_candidate_score(top)) != _confidence_from_score(_candidate_score(second))):
        return DiscoveryResult(candidates=deduplicated, selected=top)

    # Multiple similarly plausible candidates.
    plausible = [c for c in deduplicated if c.confidence in {"high", "medium"}]
    if len(plausible) >= 2:
        return DiscoveryResult(candidates=deduplicated, ambiguity=plausible[:5])
    if top.confidence == "medium" and (not second or second.confidence != "medium"):
        return DiscoveryResult(candidates=deduplicated, selected=top)
    return DiscoveryResult(candidates=deduplicated, ambiguity=deduplicated[:5])


def _candidate_score(candidate: DiscoveryCandidate) -> int:
    mapping = {"high": 100, "medium": 50, "low": 10}
    return mapping.get(candidate.confidence, 0)


def format_candidate_choice(candidate: DiscoveryCandidate) -> str:
    parts = [candidate.inferred_title]
    if candidate.inferred_code:
        parts.append(candidate.inferred_code)
    if candidate.inferred_term:
        parts.append(candidate.inferred_term)
    return f"{candidate.path} ({', '.join(parts)})"
