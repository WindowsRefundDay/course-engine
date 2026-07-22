from __future__ import annotations

"""Deterministic local compilation into a reviewable, unpublished draft."""

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from zipfile import BadZipFile, ZipFile

from .adapters import CourseManifest, adapter_for
from .config import mineru_api_url
from .db import Database
from .mineru import MinerUClient
from .providers import ProviderExecutionPolicy, redact_text

IMPORT_STAGES = ("inventory", "extract", "normalize", "enrich", "validate", "preview")
STAGE_PROGRESS = {
    "inventory": 15,
    "extract": 30,
    "normalize": 50,
    "enrich": 65,
    "validate": 80,
}


class ImportPipeline:
    """Run queued jobs using only deterministic local operations."""

    def __init__(self, database: Database):
        self.db = database

    def run_next(self) -> dict[str, Any] | None:
        job = self.db.claim_next_import()
        return self._run_claimed(job) if job else None

    def run_job(self, job_id: str) -> dict[str, Any]:
        job = self.db.claim_import(job_id)
        if job:
            return self._run_claimed(job)
        existing = self.db.get_import(job_id)
        if not existing:
            raise KeyError(f"Import job not found: {job_id}")
        return existing

    def _run_claimed(self, job: dict[str, Any]) -> dict[str, Any]:
        current_stage = "inventory"
        try:
            adapter = adapter_for(job["source"])
            manifest = adapter.inventory(job["source"])
            self.db.record_stage(
                job["id"], stage="inventory", progress=STAGE_PROGRESS["inventory"], output=manifest.to_dict()
            )

            current_stage = "extract"
            extraction = self._extract(job["source"], manifest)
            self.db.record_stage(
                job["id"], stage=current_stage, progress=STAGE_PROGRESS[current_stage], output=extraction
            )

            current_stage = "normalize"
            normalized = self._normalize(job, manifest, extraction)
            self.db.record_stage(
                job["id"], stage=current_stage, progress=STAGE_PROGRESS[current_stage], output=normalized
            )

            current_stage = "enrich"
            enrichment = self._enrich(job["source"])
            self.db.record_stage(
                job["id"], stage=current_stage, progress=STAGE_PROGRESS[current_stage], output=enrichment
            )

            current_stage = "validate"
            artifact = self._compile(job["source"], normalized)
            validation = self._validate(manifest, normalized, artifact)
            self.db.record_stage(
                job["id"], stage=current_stage, progress=STAGE_PROGRESS[current_stage], output=validation
            )

            current_stage = "preview"
            self.db.create_compilation_draft(job["id"], artifact=artifact, validation=validation)
            return self.db.get_import(job["id"])  # type: ignore[return-value]
        except Exception as error:
            return self.db.fail_import(job["id"], stage=current_stage, error=redact_text(str(error)))

    @staticmethod
    def _extract(source: str, manifest: CourseManifest) -> dict[str, Any]:
        """Inspect source layout without extracting or mutating source files."""
        if manifest.source_kind == "directory":
            path = Path(source).expanduser().resolve()
            return {"mode": "in-place", "root": str(path), "files": manifest.file_count}
        if manifest.source_kind == "zip":
            path = Path(source).expanduser().resolve()
            try:
                with ZipFile(path) as archive:
                    entries = [entry for entry in archive.infolist() if not entry.is_dir()]
                    ImportPipeline._validate_zip_budget(entries)
                    file_names = [entry.filename for entry in entries]
            except BadZipFile as error:
                raise ValueError(f"Invalid ZIP archive: {path.name}") from error
            roots = sorted({name.split("/", 1)[0] for name in file_names if "/" in name})
            return {
                "mode": "archive-index",
                "archive": str(path),
                "files": len(file_names),
                "root_directories": roots,
                "extracted": False,
            }
        return {
            "mode": "remote-deferred",
            "source": source,
            "downloaded": False,
            "reason": "Remote fetching is outside the deterministic local import worker",
        }

    @staticmethod
    def _enrich(source: str) -> dict[str, Any]:
        project_root = Path(__file__).resolve().parents[3]
        setup = ImportPipeline._course_local_setup(project_root, source)
        parser = setup.get("parser", {}).get("provider") if setup else "builtin"
        if parser != "mineru":
            return {
                "performed": False,
                "reason": "Built-in deterministic extraction selected",
                "parser": parser or "builtin",
                "ai": "optional and not invoked by the deterministic worker",
            }
        documents_path = Path(source).expanduser()
        documents = [documents_path] if documents_path.is_file() and documents_path.suffix.lower() == ".pdf" else (
            sorted(documents_path.rglob("*.pdf")) if documents_path.is_dir() else []
        )
        if not documents:
            return {"performed": False, "reason": "MinerU selected but this source contains no PDFs", "parser": "mineru"}
        client = MinerUClient(mineru_api_url())
        health = client.health()
        if not health.reachable:
            raise ValueError(f"Required MinerU parser is unavailable: {health.message}")
        policy = ProviderExecutionPolicy(allow_cloud=bool(setup.get("privacy", {}).get("allow_cloud", False)))
        parsed = []
        for document in documents:
            result = client.parse(str(document), policy=policy)
            parsed.append({"file": document.name, "result_keys": sorted(str(key) for key in result.keys())})
        return {"performed": True, "parser": "mineru", "documents": parsed, "count": len(parsed)}

    @staticmethod
    def _normalize(job: dict[str, Any], manifest: CourseManifest, extraction: dict[str, Any]) -> dict[str, Any]:
        return {
            "course": {
                "id": job["course_id"],
                "title": manifest.title,
                "source_kind": manifest.source_kind,
                "has_content_map": manifest.has_content_map,
            },
            "content": {"kind": "metadata-only", "sections": [], "resources": []},
            "extraction_mode": extraction["mode"],
        }

    @staticmethod
    def _compile(source: str, normalized: dict[str, Any]) -> dict[str, Any]:
        """Use the real deterministic OCW compiler when the source supports it."""
        path = Path(source).expanduser().resolve()
        project_root = Path(__file__).resolve().parents[3]
        compiler = project_root / "scripts" / "compile-ocw.ts"
        if path.is_dir():
            return ImportPipeline._compile_ocw_directory(path, compiler, decision_source=path)
        if path.is_file() and path.suffix.lower() == ".zip":
            with tempfile.TemporaryDirectory(prefix="course-engine-") as temporary:
                extraction_root = Path(temporary).resolve()
                with ZipFile(path) as archive:
                    members = [member for member in archive.infolist() if not member.is_dir()]
                    ImportPipeline._validate_zip_budget(members)
                    for member in members:
                        target = (extraction_root / member.filename).resolve()
                        if target != extraction_root and extraction_root not in target.parents:
                            raise ValueError(f"Unsafe ZIP member: {member.filename}")
                    archive.extractall(extraction_root)
                candidates = [extraction_root, *(item for item in extraction_root.rglob("*") if item.is_dir())]
                course_root = next(
                    (candidate for candidate in candidates if (candidate / "data.json").is_file() and (candidate / "pages").is_dir()),
                    None,
                )
                if course_root:
                    return ImportPipeline._compile_ocw_directory(course_root, compiler, decision_source=path)
        return {
            "schemaVersion": 2,
            "title": normalized["course"]["title"],
            "code": "Course",
            "term": "",
            "description": "Source inventory awaiting a course-specific compiler adapter.",
            "units": [],
            "source": {"adapter": normalized["course"]["source_kind"]},
        }

    @staticmethod
    def _compile_ocw_directory(path: Path, compiler: Path, *, decision_source: Path) -> dict[str, Any]:
        if (path / "data.json").is_file() and (path / "pages").is_dir() and compiler.is_file():
            project_root = compiler.parents[1]
            compilation_path = ImportPipeline._course_local_compilation(project_root, decision_source)
            arguments = ["node", "--experimental-strip-types", str(compiler), str(path)]
            with tempfile.NamedTemporaryFile(suffix=".json") as output:
                arguments.append(output.name)
                if compilation_path:
                    arguments.append(str(compilation_path))
                result = subprocess.run(
                    arguments,
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=False,
                )
                if result.returncode != 0:
                    raise ValueError(f"Course compiler failed: {result.stderr.strip()}")
                artifact = json.loads(Path(output.name).read_text(encoding="utf-8"))
                artifact.setdefault("source", {})["root"] = str(decision_source.resolve())
                return artifact
        raise ValueError(f"No registered course compiler can compile source directory: {path.name}")

    @staticmethod
    def _validate_zip_budget(members: list[Any]) -> None:
        if len(members) > 50_000:
            raise ValueError("ZIP archive contains too many files")
        total = sum(member.file_size for member in members)
        if total > 2 * 1024 * 1024 * 1024:
            raise ValueError("ZIP archive expands beyond the 2 GiB safety limit")
        for member in members:
            if member.file_size > 512 * 1024 * 1024:
                raise ValueError(f"ZIP member exceeds the 512 MiB safety limit: {member.filename}")
            if member.compress_size and member.file_size / member.compress_size > 1_000:
                raise ValueError(f"ZIP member has an unsafe compression ratio: {member.filename}")

    @staticmethod
    def _course_local_compilation(project_root: Path, source_root: Path) -> Path | None:
        """Resolve saved decisions by the source location recorded in setup."""
        setup_path = ImportPipeline._course_local_setup_path(project_root, str(source_root))
        if setup_path:
            compilation = setup_path.parent / "compilation.json"
            return compilation if compilation.is_file() else None
        return None

    @staticmethod
    def _course_local_setup(project_root: Path, source: str) -> dict[str, Any]:
        setup_path = ImportPipeline._course_local_setup_path(project_root, source)
        if not setup_path:
            return {}
        try:
            return json.loads(setup_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return {}

    @staticmethod
    def _course_local_setup_path(project_root: Path, source: str) -> Path | None:
        source_is_url = source.startswith(("http://", "https://"))
        for setup_path in sorted((project_root / "courses").glob("*/course.setup.json")):
            try:
                setup = json.loads(setup_path.read_text(encoding="utf-8"))
                configured_value = str(setup["source"]["location"])
                if source_is_url:
                    if configured_value.rstrip("/") == source.rstrip("/"):
                        return setup_path
                else:
                    configured = Path(configured_value).expanduser()
                    if not configured.is_absolute():
                        configured = (setup_path.parent / configured).resolve()
                    if configured == Path(source).expanduser().resolve():
                        return setup_path
            except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
        return None

    @staticmethod
    def _validate(manifest: CourseManifest, normalized: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        if not manifest.title.strip():
            errors.append("Course title is empty")
        if not manifest.source.strip():
            errors.append("Course source is empty")
        if manifest.source_kind not in {"directory", "zip", "website", "pdf"}:
            errors.append(f"Unsupported source kind: {manifest.source_kind}")
        if manifest.file_count < 0:
            errors.append("File count cannot be negative")
        if normalized.get("content", {}).get("kind") != "metadata-only":
            errors.append("Normalized content kind is invalid")
        if artifact.get("schemaVersion") != 2:
            errors.append("Compiled artifact must use schemaVersion 2")
        if not isinstance(artifact.get("units"), list):
            errors.append("Compiled artifact units must be a list")
        elif not artifact["units"]:
            errors.append("Compiled artifact has no learner units")
        compiler_audit = artifact.get("compiler", {}).get("validation")
        if compiler_audit is not None and not compiler_audit.get("valid", False):
            errors.extend(str(message) for message in compiler_audit.get("errors", ["Compiler relationship validation failed"]))
        if errors:
            raise ValueError("; ".join(errors))
        return {
            "valid": True,
            "blocking_issues": [],
            "warnings": [] if artifact.get("units") else ["No course-specific curriculum adapter produced learner units"],
            "checks": ["manifest", "normalization", "schema-v2", "review-before-publish"],
        }
