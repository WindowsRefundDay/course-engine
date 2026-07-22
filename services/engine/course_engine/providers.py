from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


SECRET_MARKERS = ("api_key", "token", "secret", "password", "authorization")
SECRET_TEXT = re.compile(
    r"(?i)(bearer\s+)[^\s]+|((?:api[_-]?key|token|secret|password)=)[^&\s]+|\bsk-[A-Za-z0-9_-]{8,}\b"
)


def redact_url(value: str | None) -> str | None:
    if not value:
        return value
    parsed = urlsplit(value)
    hostname = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port else ""
    return urlunsplit((parsed.scheme, f"{hostname}{port}", parsed.path, "", ""))


def redact(value: Any, *, key: str = "") -> Any:
    """Return a logging-safe copy of nested provider data."""
    if any(marker in key.lower() for marker in SECRET_MARKERS):
        return "[REDACTED]" if value else value
    if isinstance(value, Mapping):
        return {str(child_key): redact(child, key=str(child_key)) for child_key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(child, key=key) for child in value]
    return value


def redact_text(value: str) -> str:
    """Remove common credential forms before an error reaches persistence."""
    return SECRET_TEXT.sub(lambda match: f"{match.group(1) or match.group(2) or ''}[REDACTED]", value)


@dataclass(frozen=True)
class ProviderEnvironment:
    namespace: str
    base_url: str | None
    model: str | None
    api_key_present: bool
    api_key_env: str

    @classmethod
    def load(cls, namespace: str) -> "ProviderEnvironment":
        prefix = namespace.rstrip("_")
        key_name = f"{prefix}_API_KEY"
        return cls(
            namespace=prefix,
            base_url=os.environ.get(f"{prefix}_BASE_URL", "").strip().rstrip("/") or None,
            model=os.environ.get(f"{prefix}_MODEL", "").strip() or None,
            api_key_present=bool(os.environ.get(key_name, "").strip()),
            api_key_env=key_name,
        )

    def diagnostic(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["base_url"] = redact_url(self.base_url)
        return payload


def compiler_ai_environment() -> ProviderEnvironment:
    return ProviderEnvironment.load("COMPILER_AI")


def study_ai_environment() -> ProviderEnvironment:
    return ProviderEnvironment.load("STUDY_AI")


def mineru_environment() -> ProviderEnvironment:
    return ProviderEnvironment.load("MINERU")


@dataclass(frozen=True)
class ProviderBudget:
    max_calls: int = 0
    max_cost_usd: float = 0.0

    def permits(self, *, calls_used: int, cost_used_usd: float) -> bool:
        calls_ok = self.max_calls <= 0 or calls_used < self.max_calls
        cost_ok = self.max_cost_usd <= 0 or cost_used_usd < self.max_cost_usd
        return calls_ok and cost_ok


@dataclass(frozen=True)
class ProviderExecutionPolicy:
    """Hard gate checked before any optional provider request is dispatched."""

    allow_cloud: bool
    budget: ProviderBudget = ProviderBudget()

    def authorize(
        self,
        *,
        remote: bool,
        calls_used: int = 0,
        cost_used_usd: float = 0.0,
    ) -> None:
        if remote and not self.allow_cloud:
            raise PermissionError("Cloud provider access is disabled for this course")
        if not self.budget.permits(calls_used=calls_used, cost_used_usd=cost_used_usd):
            raise PermissionError("Provider budget is exhausted")


@dataclass(frozen=True)
class CompilerToolRequest:
    """Declarative request from an optional AI provider to the deterministic compiler."""

    tool: str
    arguments: Mapping[str, Any]
    reason: str
    confidence: float
    source_node_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CompilerToolAudit:
    tool: str
    reason: str
    confidence: float
    source_node_ids: tuple[str, ...]
    arguments: Mapping[str, Any] = field(repr=False)

    @classmethod
    def from_request(cls, request: CompilerToolRequest) -> "CompilerToolAudit":
        return cls(
            tool=request.tool,
            reason=request.reason,
            confidence=request.confidence,
            source_node_ids=request.source_node_ids,
            arguments=redact(request.arguments),
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


class CompilerAIProvider(Protocol):
    """Optional optimizer. The coding agent remains the compilation orchestrator."""

    name: str

    def propose(self, source_graph: Mapping[str, Any], compiled_draft: Mapping[str, Any]) -> list[CompilerToolRequest]:
        """Return auditable proposals; never publish or mutate the live course."""


class DocumentParserProvider(Protocol):
    """Parser boundary shared by built-in extraction, MinerU, and future parsers."""

    name: str

    def health(self) -> Mapping[str, Any]:
        """Return redaction-safe readiness information."""

    def parse(self, document_path: str) -> Mapping[str, Any]:
        """Extract document structure without making curriculum decisions."""


class DeterministicCompilerAI:
    """No-op provider used when AI optimization is disabled."""

    name = "disabled"

    def propose(self, source_graph: Mapping[str, Any], compiled_draft: Mapping[str, Any]) -> list[CompilerToolRequest]:
        return []


ALLOWED_COMPILER_TOOLS = frozenset(
    {
        "rename-slide",
        "exclude-slide",
        "reorder-slides",
        "attach-source",
        "pair-example",
        "set-clip-range",
    }
)


class OpenAICompatibleCompilerAI:
    """Auditable proposal-only client; it cannot mutate or publish a course."""

    name = "openai-compatible"

    def __init__(self, environment: ProviderEnvironment, policy: ProviderExecutionPolicy):
        if not environment.base_url or not environment.model:
            raise ValueError("Compiler AI base URL and model are required")
        self.environment = environment
        self.policy = policy

    def _remote(self) -> bool:
        return (urlsplit(self.environment.base_url or "").hostname or "").lower() not in {
            "127.0.0.1", "localhost", "::1"
        }

    def health(self) -> Mapping[str, Any]:
        self.policy.authorize(remote=self._remote())
        request = Request(f"{self.environment.base_url}/models", headers=self._headers(), method="GET")
        try:
            with urlopen(request, timeout=5) as response:
                return {"reachable": 200 <= response.status < 500, "status": response.status}
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            return {"reachable": False, "error": error.__class__.__name__}

    def propose(self, source_graph: Mapping[str, Any], compiled_draft: Mapping[str, Any]) -> list[CompilerToolRequest]:
        self.policy.authorize(remote=self._remote())
        prompt = {
            "instruction": "Suggest declarative compiler tool requests only. Do not invent topics or publish.",
            "allowed_tools": sorted(ALLOWED_COMPILER_TOOLS),
            "source_graph": source_graph,
            "compiled_draft": compiled_draft,
            "response_schema": {"requests": [{"tool": "string", "arguments": {}, "reason": "string", "confidence": 0.0, "source_node_ids": ["string"]}]},
        }
        body = json.dumps(
            {
                "model": self.environment.model,
                "messages": [
                    {"role": "system", "content": "You optimize a source-faithful course draft through typed declarative tools."},
                    {"role": "user", "content": json.dumps(prompt, separators=(",", ":"))},
                ],
                "temperature": 0,
            }
        ).encode()
        request = Request(
            f"{self.environment.base_url}/chat/completions",
            data=body,
            headers={**self._headers(), "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=120) as response:
            payload = json.loads(response.read())
        content = payload["choices"][0]["message"]["content"]
        decoded = json.loads(content)
        proposals: list[CompilerToolRequest] = []
        for item in decoded.get("requests", []):
            tool = str(item.get("tool", ""))
            confidence = float(item.get("confidence", 0))
            if tool not in ALLOWED_COMPILER_TOOLS:
                raise ValueError(f"Compiler AI requested an unregistered tool: {tool}")
            if not 0 <= confidence <= 1 or not str(item.get("reason", "")).strip():
                raise ValueError("Compiler AI proposal has invalid confidence or reason")
            proposals.append(
                CompilerToolRequest(
                    tool=tool,
                    arguments=item.get("arguments", {}),
                    reason=str(item["reason"]),
                    confidence=confidence,
                    source_node_ids=tuple(str(value) for value in item.get("source_node_ids", [])),
                )
            )
        return proposals

    def _headers(self) -> dict[str, str]:
        key = os.environ.get(self.environment.api_key_env, "").strip()
        return {"Authorization": f"Bearer {key}"} if key else {}
