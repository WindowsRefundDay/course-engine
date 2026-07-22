from __future__ import annotations

import json
import mimetypes
import os
import uuid
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from typing import Any, Mapping
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .providers import ProviderExecutionPolicy, redact_url


@dataclass(frozen=True)
class MinerUHealth:
    configured: bool
    reachable: bool
    url: str | None
    message: str


class MinerUClient:
    """Small boundary around the optional local MinerU service."""

    def __init__(self, base_url: str | None):
        self.base_url = base_url

    def health(self) -> MinerUHealth:
        if not self.base_url:
            return MinerUHealth(False, False, None, "MINERU_BASE_URL is not configured")
        try:
            request = Request(f"{self.base_url}/health", method="GET")
            with urlopen(request, timeout=2) as response:
                return MinerUHealth(True, 200 <= response.status < 500, redact_url(self.base_url), f"HTTP {response.status}")
        except (URLError, TimeoutError, OSError, ValueError, HTTPException) as error:
            return MinerUHealth(True, False, redact_url(self.base_url), error.__class__.__name__)

    def parse(
        self,
        document_path: str,
        *,
        policy: ProviderExecutionPolicy,
        timeout: float = 300,
    ) -> Mapping[str, Any]:
        """Call MinerU's official synchronous `/file_parse` interface."""
        if not self.base_url:
            raise ValueError("MINERU_BASE_URL is not configured")
        document = Path(document_path).expanduser().resolve()
        if not document.is_file():
            raise FileNotFoundError(document)
        remote = (urlsplit(self.base_url).hostname or "").lower() not in {"127.0.0.1", "localhost", "::1"}
        policy.authorize(remote=remote)
        boundary = f"course-engine-{uuid.uuid4().hex}"
        content_type = mimetypes.guess_type(document.name)[0] or "application/octet-stream"
        safe_name = document.name.replace('"', "_").replace("\r", "_").replace("\n", "_")
        body = b"".join(
            [
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{safe_name}\"\r\nContent-Type: {content_type}\r\n\r\n".encode(),
                document.read_bytes(),
                f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"return_md\"\r\n\r\ntrue".encode(),
                f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"response_format_zip\"\r\n\r\nfalse".encode(),
                f"\r\n--{boundary}--\r\n".encode(),
            ]
        )
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        api_key = os.environ.get("MINERU_API_KEY", "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = Request(f"{self.base_url}/file_parse", data=body, headers=headers, method="POST")
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
            if "json" not in (response.headers.get("content-type") or ""):
                raise ValueError("MinerU returned an unsupported non-JSON response")
            value = json.loads(payload)
            if not isinstance(value, Mapping):
                raise ValueError("MinerU response must be a JSON object")
            return value
