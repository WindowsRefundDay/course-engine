import pytest
from fastapi import HTTPException

from course_engine.api import require_admin


def test_admin_token_is_enforced_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COURSE_ENGINE_ADMIN_TOKEN", "local-review-token")
    with pytest.raises(HTTPException) as rejected:
        require_admin(None)
    assert rejected.value.status_code == 401
    require_admin("Bearer local-review-token")


def test_local_development_can_leave_admin_token_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("COURSE_ENGINE_ADMIN_TOKEN", raising=False)
    require_admin(None)
