from __future__ import annotations

import os
from pathlib import Path


def database_path() -> Path:
    """Return the configured SQLite location without creating it."""
    return Path(os.environ.get("COURSE_ENGINE_DB", "course-engine.sqlite3")).expanduser()


def mineru_api_url() -> str | None:
    value = os.environ.get("MINERU_BASE_URL", os.environ.get("MINERU_API_URL", "")).strip().rstrip("/")
    return value or None


def admin_token() -> str | None:
    return os.environ.get("COURSE_ENGINE_ADMIN_TOKEN", "").strip() or None
