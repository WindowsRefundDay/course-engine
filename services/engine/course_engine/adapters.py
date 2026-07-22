from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile


@dataclass(frozen=True)
class CourseManifest:
    title: str
    source: str
    source_kind: str
    file_count: int
    has_content_map: bool
    code: str | None = None
    term: str | None = None
    level: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class CourseSourceAdapter(Protocol):
    name: str

    def can_handle(self, source: str) -> bool: ...

    def inventory(self, source: str) -> CourseManifest: ...


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "course"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def _extract_ocw_metadata(path: Path) -> dict[str, Any]:
    data = _read_json(path / "data.json")
    return {
        "title": data.get("course_title") or data.get("title"),
        "code": data.get("primary_course_number") or data.get("course_number") or data.get("code"),
        "term": " ".join(str(v) for v in [data.get("term"), data.get("year")] if v),
        "level": data.get("level"),
    }


def _extract_zip_metadata(path: Path) -> dict[str, Any]:
    try:
        with ZipFile(path) as archive:
            for name in archive.namelist():
                if name.endswith("data.json") and "pages" not in name:
                    try:
                        data = json.loads(archive.read(name).decode("utf-8"))
                        if isinstance(data, dict):
                            return {
                                "title": data.get("course_title") or data.get("title"),
                                "code": data.get("primary_course_number") or data.get("course_number") or data.get("code"),
                                "term": " ".join(str(v) for v in [data.get("term"), data.get("year")] if v),
                                "level": data.get("level"),
                            }
                    except (OSError, ValueError, TypeError, json.JSONDecodeError):
                        continue
    except BadZipFile:
        pass
    return {}


class MitOcwArchiveAdapter:
    name = "mit-ocw-archive"

    def can_handle(self, source: str) -> bool:
        path = Path(source)
        return path.is_dir() and (path / "content_map.json").is_file() and (path / "pages").is_dir()

    def inventory(self, source: str) -> CourseManifest:
        path = Path(source).resolve()
        meta = _extract_ocw_metadata(path)
        title = meta.get("title") or path.name.replace("-", " ").title()
        return CourseManifest(
            title=title,
            source=str(path),
            source_kind="directory",
            file_count=sum(1 for p in path.rglob("*") if p.is_file()),
            has_content_map=True,
            code=meta.get("code"),
            term=meta.get("term"),
            level=meta.get("level"),
        )


class DirectoryArchiveAdapter:
    name = "directory-archive"

    def can_handle(self, source: str) -> bool:
        parsed = urlparse(source)
        return not parsed.scheme and Path(source).is_dir()

    def inventory(self, source: str) -> CourseManifest:
        path = Path(source).resolve()
        meta = _extract_ocw_metadata(path)
        title = meta.get("title") or path.name.replace("-", " ").title()
        return CourseManifest(
            title=title,
            source=str(path),
            source_kind="directory",
            file_count=sum(1 for p in path.rglob("*") if p.is_file()),
            has_content_map=(path / "content_map.json").is_file(),
            code=meta.get("code"),
            term=meta.get("term"),
            level=meta.get("level"),
        )


class ZipArchiveAdapter:
    name = "zip-archive"

    def can_handle(self, source: str) -> bool:
        path = Path(source)
        return path.is_file() and path.suffix.lower() == ".zip"

    def inventory(self, source: str) -> CourseManifest:
        path = Path(source).resolve()
        try:
            with ZipFile(path) as archive:
                names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        except BadZipFile as error:
            raise ValueError(f"Invalid ZIP archive: {path.name}") from error
        meta = _extract_zip_metadata(path)
        title = meta.get("title") or path.stem.replace("-", " ").title()
        return CourseManifest(
            title=title,
            source=str(path),
            source_kind="zip",
            file_count=len(names),
            has_content_map=any(name.endswith("content_map.json") for name in names),
            code=meta.get("code"),
            term=meta.get("term"),
            level=meta.get("level"),
        )


class PdfSourceAdapter:
    name = "pdf-document"

    def can_handle(self, source: str) -> bool:
        path = Path(source)
        return path.is_file() and path.suffix.lower() == ".pdf"

    def inventory(self, source: str) -> CourseManifest:
        path = Path(source).resolve()
        return CourseManifest(path.stem.replace("-", " ").title(), str(path), "pdf", 1, False)


class WebCourseAdapter:
    name = "website"

    def can_handle(self, source: str) -> bool:
        parsed = urlparse(source)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

    def inventory(self, source: str) -> CourseManifest:
        parsed = urlparse(source)
        title = (parsed.netloc + parsed.path).strip("/").replace("-", " ") or parsed.netloc
        return CourseManifest(title.title(), source, "website", 0, False)


def adapter_for(source: str) -> CourseSourceAdapter:
    for adapter in (MitOcwArchiveAdapter(), ZipArchiveAdapter(), PdfSourceAdapter(), WebCourseAdapter(), DirectoryArchiveAdapter()):
        if adapter.can_handle(source):
            return adapter
    raise ValueError("Supported sources are course directories, ZIP archives, PDFs, and public HTTP(S) URLs")
